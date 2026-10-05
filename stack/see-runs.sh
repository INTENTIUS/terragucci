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
# is set: a plan of the module-bump change for pull request 1, a drift run,
# and wave 1 of the apply with the gate set to always, which waits for an
# approval. The wave's ledger goes to a scratch repo, so the example on
# Forgejo is left as it is. Needs the example booted (`just example up`).
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
  docker run --rm --network terragucci -v "$work/repo:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_REPOSITORY="$USER/example" -e TG_PR=1 \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage "$@" >"$work/$name.log" 2>&1
}

rc=0
stage plan tf-plan || rc=$?
[ -f "$work/repo/terragucci-report/report.json" ] || fail "the plan wrote no report: $(tail -5 "$work/plan.log")"
log "tf-plan: $(jq -r '"\(.roots | length) roots planned, \(.groups | length) groups"' "$work/repo/terragucci-report/report.json") (pull request 1)"
stage drift tf-drift || true
log "tf-drift: $(jq -r '[.roots[] | select(.status == "planned" and (.changes | length) > 0)] | length' "$work/repo/terragucci-report/report.json") roots drifted"
layers="$(cd "$work/repo" && "$ROOT/node_modules/.bin/terragucci" init --forge forgejo --dry-run --json | jq -r '.results.layers | map(join(",")) | join(";")')"
stage wave tf-apply --wave 1 --layers "$layers" --canary 'envs/dev/*' --binary tofu --gate always || rc=$?
if [ "$rc" = 3 ]; then
  log "tf-apply wave 1: waits for an approval"
else
  fail "wave 1 did not wait for an approval (exit $rc): $(tail -5 "$work/wave.log")"
fi
clean_mounted "$work/repo" "$image"

log ""
log "The dashboards, in Grafana at $GRAFANA (folder terragucci):"
for d in terragucci-pipeline-health terragucci-change-review terragucci-rollouts-waves terragucci-drift terragucci-estate terragucci-runs slo-terragucci-plan-time; do
  log "  $GRAFANA/d/$d"
done
