#!/usr/bin/env bash
#
# Send three of the example's runs to the observability profile and say where
# terragucci's dashboards show them.
#
#   stack/see-runs.sh          (just see-runs)
#
# Brings the observability profile up (a collector, Prometheus, Tempo and
# Grafana with the dashboards `dashboards: true` writes), then runs three
# stages on a copy of the example in its CI image, each sending its traces and
# metrics to the collector as a pipeline job does once OTEL_EXPORTER_OTLP_ENDPOINT
# is set: a plan of the module-bump change for pull request 1, a drift run
# after staging orders' jobs queue is deleted from floci (the Drift page's
# change, example/changes/drift.sh; `just example reset` brings it back),
# and the apply's waves in order with the gate set to always, up to the first
# one with changes, which waits for an approval (wave 1, the dev platform,
# has nothing the bump changes; wave 2, the dev services, waits). The waves'
# ledger goes to a scratch repo, so the example on Forgejo is left as it is.
# Then it waits until Grafana shows the runs on the panels the tutorial's
# screenshots take, over the last hour. Needs the example booted
# (`just example up`).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXAMPLE="$ROOT/example"
JOB_CACHE_VOLUME=terragucci-job-cache
# shellcheck source=mounted.sh
. "$HERE/mounted.sh"
log() { echo "$*"; }
fail() { echo "see-runs: $*" >&2; exit 1; }
# shellcheck source=lib.sh
. "$HERE/lib.sh"

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so nothing can run."; exit 0; }

"$HERE/bootstrap.sh" observability >/dev/null 2>&1 || fail "the observability profile did not start; run 'just stack-up observability' to see why"
GRAFANA="http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}"

image="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
docker image inspect "$image" >/dev/null 2>&1 || fail "no CI image $image; run 'just example up' first"
(cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
bundle="$ROOT/packages/terragucci/dist/terragucci.mjs"

work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-see-runs.XXXXXX")"
trap 'drop_work "$work" "$image"' EXIT
mkdir -p "$work/repo"
cp -R "$EXAMPLE/." "$work/repo/"
rm -rf "$work/repo/.git"
git -C "$work/repo" init -q -b main
git -C "$work/repo" apply "$EXAMPLE/changes/module-bump.patch"
git -C "$work/repo" add -A
git -C "$work/repo" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "module-bump, for the dashboards"
git init -q --bare "$work/origin.git"
git -C "$work/repo" remote add origin /origin.git

# The project the dashboards show the runs under: the example on Forgejo.
stage() { # log name, stage arguments...
  local name="$1"; shift
  run_copied --rm --network terragucci -v "$work/repo:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_REPOSITORY="$USER/example" -e TG_PR=1 \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage "$@" >"$work/$name.log" 2>&1
}

stage plan tf-plan || true
[ -f "$work/repo/terragucci-report/report.json" ] || fail "the plan wrote no report: $(tail -5 "$work/plan.log")"
log "tf-plan: $(jq -r '"\(.roots | length) roots planned, \(.groups | length) groups"' "$work/repo/terragucci-report/report.json") (pull request 1)"
# Drift for the drift run to find, made the way the Drift page makes it.
"$EXAMPLE/changes/drift.sh" >/dev/null || fail "could not delete the queue the drift run is to find; is the example booted?"
stage drift tf-drift || true
log "tf-drift: $(jq -r '[.roots[] | select(.status == "planned" and (.changes | length) > 0)] | length' "$work/repo/terragucci-report/report.json") roots drifted"
layers="$(cd "$work/repo" && "$ROOT/node_modules/.bin/terragucci" init --forge forgejo --dry-run --json | jq -r '.results.layers | map(join(",")) | join(";")')"
# The waves in order, as the pipeline runs them: a wave with nothing to change
# has nothing to approve and passes, and the first with changes waits.
waiting=""
for w in $(seq 1 9); do
  rc=0
  stage "wave-$w" tf-apply --wave "$w" --layers "$layers" --canary 'envs/dev/*' --binary tofu --gate always || rc=$?
  if [ "$rc" = 3 ]; then waiting="$w"; break; fi
  [ "$rc" = 0 ] || fail "wave $w failed (exit $rc): $(tail -5 "$work/wave-$w.log")"
  grep -q "so there is nothing to apply" "$work/wave-$w.log" && break
  log "tf-apply wave $w: nothing to change, so nothing to approve"
done
[ -n "$waiting" ] || fail "no wave waited for an approval: $(tail -5 "$work/wave-$w.log")"
log "tf-apply wave $waiting: waits for an approval"
clean_mounted "$work/repo" "$image"

# How many values a panel of a dashboard shows for the example over the last
# hour, run through Grafana's query API as the panel runs them.
PROJECT="forgejo:3000/$USER/example"
panel_values() { # uid, panel title
  local dash body
  dash="$(curl -fsS "$GRAFANA/api/dashboards/uid/$1")" || { echo 0; return 0; }
  body="$(jq -c --arg t "$2" --arg p "$PROJECT" '
    def fill: gsub("\\$project"; $p) | gsub("\\$stage"; ".+") | gsub("\\$__range"; "1h") | gsub("\\$__rate_interval"; "1m") | gsub("\\$__interval"; "15s");
    [.dashboard.panels[] | (., (.panels // [])[]) | select(.title == $t) | (.datasource // {}) as $ds | (.targets // [])[]
      | . + {datasource: (.datasource // $ds), intervalMs: 15000, maxDataPoints: 600}
      | if .expr then .expr |= fill else . end
      | if .query then .query |= fill else . end]
    | to_entries | map(.value + {refId: "q\(.key)"})
    | {queries: ., from: "now-1h", to: "now"}' <<<"$dash")"
  curl -fsS -H 'content-type: application/json' -X POST -d "$body" "$GRAFANA/api/ds/query" 2>/dev/null \
    | jq '[.results[]?.frames[]?.data.values // [] | .[1:][]? | map(select(. != null)) | length] | add // 0' 2>/dev/null || echo 0
}

# The panels the tutorial's screenshots show, each with the runs in it once
# the collector has flushed the span metrics, Prometheus has scraped them and
# a graph's points (15 seconds apart over an hour) are past the runs: a graph
# waits for three points per line, so it draws a line rather than a lone dot.
SHOWN=(
  "terragucci-pipeline-health|Runs per hour|9" "terragucci-pipeline-health|Errors|9" "terragucci-pipeline-health|Duration p50|9" "terragucci-pipeline-health|Duration p95|9"
  "terragucci-rollouts-waves|Waves waiting|1" "terragucci-rollouts-waves|Waiting for|1" "terragucci-rollouts-waves|Wave runs by result|1" "terragucci-rollouts-waves|Refused and failed waves|6"
  "terragucci-drift|Drifted roots|3" "terragucci-drift|Drift age|1"
  "terragucci-runs|Slowest roots|1" "terragucci-runs|Slowest root applies|1" "terragucci-runs|Slowest resources|1"
)
missing=""
for _ in $(seq 1 24); do   # up to two minutes
  missing=""
  for d in "${SHOWN[@]}"; do
    IFS='|' read -r uid title least <<<"$d"
    [ "$(panel_values "$uid" "$title")" -ge "$least" ] || missing="$missing, $title"
  done
  [ -z "$missing" ] && break
  sleep 5
done
[ -z "$missing" ] || fail "Grafana shows nothing for $PROJECT in ${missing#, }"
log "Grafana shows the runs: $PROJECT"

log ""
log "The dashboards, in Grafana at $GRAFANA (folder terragucci):"
for d in terragucci-pipeline-health terragucci-change-review terragucci-rollouts-waves terragucci-drift terragucci-estate terragucci-runs slo-terragucci-plan-time; do
  log "  $GRAFANA/d/$d"
done
