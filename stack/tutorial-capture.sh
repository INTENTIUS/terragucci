#!/usr/bin/env bash
#
# Run the tutorial's steps against the example and record what a reader sees.
#
#   stack/tutorial-capture.sh                  every step whose smoke claims pass
#   stack/tutorial-capture.sh <step>...        only these steps
#   stack/tutorial-capture.sh --reuse <step>   one step on the running example, as it stands
#   stack/tutorial-capture.sh --list           every step, what it needs and what it writes
#
# For each step it runs the step's commands, normalizes their output, and
# screenshots the pages the step points at in light and dark. It writes:
#
#   docs-site/src/data/tutorial/<step>.json      commands, output, exit codes,
#                                                the example's hash, and the
#                                                hash of each screenshot
#   docs-site/src/assets/tutorial/<step>-<view>-<theme>.png
#   docs-site/src/data/tutorial/manifest.json    date, commit and versions
#
# A step whose output and screenshots are byte for byte what is committed keeps
# its files; any difference in either rewrites the step's JSON and its
# screenshots together. Only the steps that ran are written, so one step's
# capture never touches another step's files.
#
# The steps run in the order below, and each one starts where the one before it
# left the example. What a step needs (the STEPS table):
#   fresh    it starts from nothing itself (boot, fountain-apply)
#   chain    it needs the steps before it: run alone, it boots the example
#            fresh and replays them unrecorded, so pull request and run
#            numbers are those of a full capture
#   booted   it needs the example as committed: run alone, it resets a running
#            example, or boots one
# --reuse skips all of that and runs the step on the example as it stands.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXAMPLE="$ROOT/example"
DATA="$ROOT/docs-site/src/data/tutorial"
SHOTS="$ROOT/docs-site/src/assets/tutorial"
SMOKE="$ROOT/docs-site/src/data/smoke.json"

log()  { echo "[capture] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# step|needs|claims|views|what a reader sees
STEPS='boot|fresh|boot|repo run|just example up; the repo in Forgejo and the first run'"'"'s jobs
first-pr|chain|check|pull files|just example change one-root; the pull request with its note, and its one-line diff
check|chain|check|pull log|just example change unformatted and just example logs; the failed check job'"'"'s log, found from the branch'"'"'s head
one-note|chain|affected grouped highlight|pull|just example change module-bump; the plan note for 12 roots, 11 in one group and prod payments apart (the pull request is closed afterwards)
wave-waiting|chain|waves sealed|pull log|just example change destroy and merge destroy; the destroy pull request'"'"'s note, and wave 4'"'"'s job log with exit 3 and the approve command
wave-refused|chain|waves sealed refuse|log|just example approve, change module-bump, merge module-bump; wave 4'"'"'s job log with both digests and the roots that moved
pin|chain|publish rollout|pull files|just example change pin; the rollout'"'"'s wave 1 pull request and its ref bumps
report|booted|report highlight|top root plan index|three tf-plan runs of the example with reports.bucket on floci; the module bump'"'"'s report.html, one root'"'"'s row, that root'"'"'s plan.txt, and the project'"'"'s report index
drift|booted|drift|issue|just example change drift, then the drift job dispatched; the drift issue (the example is reset afterwards)
fountain-apply|fresh|steward||just example up --fresh --fountain and just example verify
see-runs|booted|dash-pipeline dash-changes dash-waves dash-drift dash-estate dash-runs dash-slos|pipeline waves drift runs|just see-runs; four of the dashboards'

field() { # step, field number -> that field of the step's row
  awk -F'|' -v s="$1" -v n="$2" '$1 == s { print $n }' <<<"$STEPS"
}

if [ "${1:-}" = --list ]; then
  while IFS='|' read -r step needs claims views what; do
    printf '%s\n  needs     %s\n  claims    %s\n  writes    data/tutorial/%s.json' "$step" "$needs" "$claims" "$step"
    for v in $views; do printf ', assets/tutorial/%s-%s-{light,dark}.png' "$step" "$v"; done
    printf '\n  shows     %s\n' "$what"
  done <<<"$STEPS"
  exit 0
fi

REUSE=""
SELECTED=()
for a in "$@"; do
  case "$a" in
    --reuse) REUSE=1 ;;
    -*) fail "unknown flag '$a' (--list, --reuse)" ;;
    *) [ -n "$(field "$a" 1)" ] || fail "no step '$a'; 'just capture --list' names them"; SELECTED+=("$a") ;;
  esac
done
[ -z "$REUSE" ] || [ ${#SELECTED[@]} = 1 ] || fail "--reuse takes one step"

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so nothing can be captured."; exit 0; }
[ -f "$SMOKE" ] || fail "no $SMOKE; run 'just smoke-record' first"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
[ -n "$CHROME" ] || fail "no Chrome or Chromium found; set CHROME"

mkdir -p "$DATA" "$SHOTS"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-capture.XXXXXX")"
# shellcheck source=mounted.sh
. "$HERE/mounted.sh"
# The step running now: a capture that stops early says which step stopped it.
STEP=""
trap 'rc=$?; [ "$rc" = 0 ] || [ -z "$STEP" ] || log "FAIL: the $STEP step stopped the capture (exit $rc)"; drop_work "$STAGE"' EXIT

# The example's hash: every file under example/, path and content. A capture
# older than the example it came from fails `just tutorial-check`.
SOURCE_HASH="$(cd "$ROOT" && find example -type f ! -path '*/.terraform/*' | LC_ALL=C sort | while read -r f; do
  printf '%s\0' "$f"; cat "$f"; done | shasum -a 256 | cut -c1-16)"

claims_pass() { # claim...
  local c
  for c in "$@"; do
    [ "$(jq -r --arg c "$c" '.claims[] | select(.claim == $c) | .verdict' "$SMOKE")" = pass ] || return 1
  done
}

# Output a reader would see, with what changes run to run made stable.
normalize() {
  sed -E \
    -e 's/ready in [0-9]+s/ready in 90s/' \
    -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
    -e 's/\x1b\[[0-9;]*m//g'
}

# A replayed step runs its commands to put the example where the next step
# expects it, but takes no screenshots and writes nothing.
REPLAY=""

# step name -> appends one command's record to $STAGE/<step>.cmds, and keeps
# the raw output in $STAGE/last.out for the step to read numbers from.
run_cmd() { # step, shown command, real command...
  local step="$1" shown="$2"; shift 2
  local out rc=0
  out="$("$@" 2>&1 </dev/null)" || rc=$?
  printf '%s\n' "$out" > "$STAGE/last.out"
  jq -n --arg cmd "$shown" --arg out "$(normalize <<<"$out")" --argjson rc "$rc" \
    '{cmd: $cmd, output: $out, exit: $rc}' >> "$STAGE/$step.cmds"
  log "$shown -> exit $rc"
}

# Forgejo's yellow "Workflow warnings" box: the permissions fields of the
# example's workflow, which Forgejo ignores. A job page's picture hides it.
FORGEJO_HIDE='.ui.warning.message.pre-execution-error'

shot() { # step, view, url, [height], [job step to open], [log line to scroll to, a regex]
  local step="$1" view="$2" url="$3" height="${4:-860}" open="${5:-}" focus="${6:-}" theme scheme png hooks
  [ -z "$REPLAY" ] || return 0
  for theme in light dark; do
    png="$STAGE/$step-$view-$theme.png"
    if [[ "$url" == */actions/runs/* ]]; then
      # A job page is prepared first (stack/shot.mjs): the warnings hidden,
      # the step that matters opened and scrolled to its key line.
      hooks=(--hide "$FORGEJO_HIDE")
      [ -z "$open" ] || hooks+=(--expand "$open")
      [ -z "$focus" ] || hooks+=(--focus "$focus")
      node "$HERE/shot.mjs" --chrome "$CHROME" --url "$url" --out "$png" \
        --width 1280 --height "$height" --scheme "$theme" "${hooks[@]}" || true
    else
      scheme=1; [ "$theme" = dark ] && scheme=0
      # The virtual time budget lets the page's scripts finish. A URL with a
      # #fragment opens scrolled to that element, the way a reader's link does.
      "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="1280,$height" \
        --blink-settings=preferredColorScheme=$scheme --virtual-time-budget=8000 \
        --screenshot="$png" "$url" >/dev/null 2>&1 || true
    fi
    [ -s "$png" ] || fail "$step: no screenshot of $url"
  done
  log "screenshot $step-$view ($url)"
}

png_hash() { shasum -a 256 "$1" | cut -c1-16; }

# Write a step's files when its output or any of its screenshots differs from
# what is committed. The JSON records each screenshot's hash, so a screenshot
# belongs to the capture that took it and `just tutorial-check` can tell.
commit_step() { # step
  local step="$1"
  local new="$STAGE/$step.json" old="$DATA/$step.json" shots='{}' v theme png
  for v in $(field "$step" 4); do
    for theme in light dark; do
      png="$STAGE/$step-$v-$theme.png"
      [ -f "$png" ] || continue
      shots="$(jq --arg k "$v-$theme" --arg h "$(png_hash "$png")" '. + {($k): $h}' <<<"$shots")"
    done
  done
  touch "$STAGE/$step.cmds"
  jq -s --arg s "$step" --arg h "$SOURCE_HASH" --argjson shots "$shots" \
    '{step: $s, source_hash: $h, commands: .} + (if ($shots | length) > 0 then {shots: $shots} else {} end)' \
    "$STAGE/$step.cmds" > "$new"
  if [ -f "$old" ] && [ "$(jq -S . "$old")" = "$(jq -S . "$new")" ]; then
    log "$step: unchanged, files kept"
    return
  fi
  cp "$new" "$old"
  for v in $(field "$step" 4); do
    for theme in light dark; do
      png="$STAGE/$step-$v-$theme.png"
      [ -f "$png" ] && cp "$png" "$SHOTS/"
    done
  done
  CHANGED=1
  log "$step: written"
}

CHANGED=0
FORGEJO=""

# The stack's Forgejo: URL, TOKEN, USER, api, REPO and FORGEJO (the repo's page).
forge() {
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  # lib.sh's api, made to say which step's request failed and its URL.
  eval "lib_api() $(declare -f api | tail -n +2)"
  api() { lib_api "$@" || { local rc=$?; log "${STEP:-capture}: ${*: -1} failed (curl exit $rc)"; return "$rc"; }; }
  REPO="$USER/example"
  FORGEJO="$URL/$REPO"
}

# Forgejo builds links from its in-network address; a browser opens this one.
browser_url() { sed "s#^http://forgejo:3000#$URL#"; }

# A GET outside Forgejo (floci's S3 endpoint) that names the step and the URL
# when it fails.
fetch() { # url
  curl -fsS "$1" || { local rc=$?; log "${STEP:-capture}: GET $1 failed (curl exit $rc)"; return "$rc"; }
}

# The newest run on a branch's head commit, as the runs API gives it.
run_on() { # branch
  local sha
  sha="$(api "$URL/api/v1/repos/$REPO/branches/${1//\//%2F}" | jq -r '.commit.id')"
  api "$URL/api/v1/repos/$REPO/actions/runs?head_sha=$sha" | jq -c '.workflow_runs[0] // empty'
}

# The push run on a commit (a prefix of its sha will do), once it has
# finished. A pull request's branch has a pull_request run on the same commit;
# only the push run checks the format.
push_run() { # commit
  local deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} )) run
  [ -n "$1" ] || return 0
  while :; do
    run="$(api "$URL/api/v1/repos/$REPO/actions/runs?event=push&limit=50" \
      | jq -c --arg s "$1" '[.workflow_runs[] | select(.event == "push" and (.commit_sha | startswith($s)))][0] // empty')"
    case "$(jq -r '.status // empty' <<<"${run:-null}")" in
      success|failure|cancelled|skipped) echo "$run"; return 0 ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then log "${STEP:-capture}: no finished push run on $1"; return 0; fi
    sleep 3
  done
}

# The page of the first job in a run that matches a jq condition. Forgejo
# numbers a run's jobs from 0 in the order they were created.
job_page() { # run json, jq condition on a job
  local run="$1" cond="$2" pos
  [ -n "$run" ] || return 0
  pos="$(api "$URL/api/v1/repos/$REPO/actions/runs/$(jq -r .id <<<"$run")/jobs" \
    | jq -r "sort_by(.id) | to_entries | map(select(.value | $cond)) | .[0].key // empty")"
  if [ -n "$pos" ]; then echo "$FORGEJO/actions/runs/$(jq -r .index_in_repo <<<"$run")/jobs/$pos/attempt/1"; fi
}

# A pull request's plan note, opened at the note itself; the pull request when
# it has none.
note_page() { # pull request number
  local url
  url="$(api "$URL/api/v1/repos/$REPO/issues/$1/comments" \
    | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .html_url // empty')"
  if [ -n "$url" ]; then browser_url <<<"$url"; else echo "$FORGEJO/pulls/$1"; fi
}

pr_in_output() { grep -o 'pulls/[0-9]*' "$STAGE/last.out" | tail -1 | cut -d/ -f2 || true; }

# ── the steps ──────────────────────────────────────────────────────────────

step_boot() {
  # A reader's first boot starts from nothing, so the capture does too.
  "$HERE/down.sh" >/dev/null 2>&1 || true
  run_cmd boot "just example up" "$HERE/example.sh" up
  forge
  shot boot repo "$FORGEJO"
  # Forgejo redirects a run to its first job at its in-network address, so
  # ask for the job page directly; jobs count from 0, and 0 is check.
  shot boot run "$FORGEJO/actions/runs/1/jobs/0/attempt/1"
}

step_first_pr() {
  run_cmd first-pr "just example change one-root" "$HERE/example.sh" change one-root
  local pr; pr="$(pr_in_output)"
  [ -n "$pr" ] || { log "first-pr: the output named no pull request"; return; }
  shot first-pr pull "$FORGEJO/pulls/$pr" 1800
  shot first-pr files "$FORGEJO/pulls/$pr/files"
}

step_check() {
  run_cmd check "just example change unformatted" "$HERE/example.sh" change unformatted
  local pr sha page; pr="$(pr_in_output)"
  sha="$(sed -n 's#.*pushed change/unformatted at \([0-9a-f]*\).*#\1#p' "$STAGE/last.out" | head -1)"
  run_cmd check "just example logs" "$HERE/example.sh" logs
  if [ -n "$pr" ]; then shot check pull "$FORGEJO/pulls/$pr"; fi
  # The check job fails on the commit the scenario pushed, and its "Commit the
  # formatting" step then pushes tofu fmt's fix to the branch. So the branch's
  # head is that later commit, whose check passes: look up the push run on the
  # commit the scenario pushed, and open its failed job at the format step.
  page="$(job_page "$(push_run "$sha")" '.status == "failure"')"
  if [ -n "$page" ]; then
    shot check log "$page" 1400 "Format check"
  else
    log "check: no failed job in the push run on ${sha:-the pushed commit}"
  fi
}

# The module bump on the example as booted: one note for twelve roots. The
# pull request is closed afterwards, so the destroy and the refusal below
# start from the example as committed; wave-refused opens the bump again.
step_one_note() {
  run_cmd one-note "just example change module-bump" "$HERE/example.sh" change module-bump
  local pr; pr="$(pr_in_output)"
  if [ -n "$pr" ]; then
    shot one-note pull "$(note_page "$pr")" 2400
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$pr" || true
  else
    log "one-note: the output named no pull request"
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO/branches/change%2Fmodule-bump" || true
}

# The example's gate is on-destroy, so only a change that destroys makes a wave
# wait. Merge the destroy scenario as the reader would, and read what waits.
step_wave_waiting() {
  run_cmd wave-waiting "just example change destroy" "$HERE/example.sh" change destroy
  local pr page; pr="$(pr_in_output)"
  if [ -n "$pr" ]; then shot wave-waiting pull "$(note_page "$pr")" 2000; fi
  run_cmd wave-waiting "just example merge destroy" "$HERE/example.sh" merge destroy
  # The run on main's new head: wave 4's job stopped with exit 3.
  page="$(job_page "$(run_on main)" '.status == "failure"')"
  if [ -n "$page" ]; then shot wave-waiting log "$page" 1600 "Apply wave" "waits for an approval of digest"; else log "wave-waiting: no stopped job on main's head"; fi
}

# Approve that wave, then merge a change that moves its plans: it refuses.
step_wave_refused() {
  run_cmd wave-refused "just example approve" "$HERE/example.sh" approve
  run_cmd wave-refused "just example change module-bump" "$HERE/example.sh" change module-bump
  run_cmd wave-refused "just example merge module-bump" "$HERE/example.sh" merge module-bump
  local page
  page="$(job_page "$(run_on main)" '.status == "failure"')"
  if [ -n "$page" ]; then shot wave-refused log "$page" 1600 "Apply wave" "changed after it was approved|planned differently since"; else log "wave-refused: no refused job on main's head"; fi
}

# Publish modules/service and open the first rollout wave. The scenario pins
# the roots first, so it leaves main changed: reset afterwards so the steps
# after this one start from the example as committed.
step_pin() {
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
  run_cmd pin "just example change pin" "$HERE/example.sh" change pin
  local pr; pr="$(pr_in_output)"
  if [ -n "$pr" ]; then
    shot pin pull "$FORGEJO/pulls/$pr" 1400
    shot pin files "$FORGEJO/pulls/$pr/files"
  else
    log "pin: the output named no pull request"
  fi
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
}

# The report and the bucket's index. Three plans of the example, each run as
# the pipeline's plan job runs it (the tofu CI image, the example's state in
# floci, the change against its base), with reports.bucket naming a floci
# bucket. The pages are served by floci's S3 endpoint, as a bucket served as
# a static site serves them. The module bump runs last, so it heads the index.
REPORT_BUCKET=terragucci-reports
step_report() {
  local image bundle="$ROOT/packages/terragucci/dist/terragucci.mjs" prefix work base scenario run_index
  image="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$image" >/dev/null 2>&1 || fail "report: no CI image $image; run 'just images'"
  (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
  # The commits are the same on every capture, so a capture replaces its own
  # rows in the index instead of adding to them.
  prefix=reports
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  # The job links in the report go to the run that applied main.
  run_index="$(run_on main | jq -r '.index_in_repo // empty')"
  for scenario in one-root destroy module-bump; do
    work="$STAGE/report-$scenario"
    mkdir -p "$work"
    cp -R "$EXAMPLE/." "$work/"
    printf 'reports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" >> "$work/terragucci.yml"
    git -C "$work" init -q -b main
    git -C "$work" add -A
    GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
      git -C "$work" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "The shop's estate"
    base="$(git -C "$work" rev-parse HEAD)"
    git -C "$work" apply "$EXAMPLE/changes/$scenario.patch"
    git -C "$work" add -A
    GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
      git -C "$work" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "$scenario"
    docker run --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e GITHUB_SERVER_URL="$URL" -e GITHUB_REPOSITORY="$REPO" ${run_index:+-e GITHUB_RUN_ID="$run_index"} \
      -e TG_BASE="$base" \
      "$image" terragucci stage tf-plan >/dev/null 2>&1 || log "report: $scenario's plan exited non-zero"
    clean_mounted "$work" "$image"
  done
  # The report step records no command: its pages are the capture, and the
  # index's times differ on every run.
  local top index project path at root plan
  top="$FLOCI/$REPORT_BUCKET/$prefix"
  index="$(fetch "$top/index.json" || true)"
  [ -n "$index" ] || index='{}'
  project="$(jq -r '.reports[0].project // empty' <<<"$index")"
  path="$(jq -r '.reports[0].path // empty' <<<"$index")"
  if [ -z "$project" ] || [ -z "$path" ]; then log "report: the index at $top lists no run"; return 0; fi
  # The top index's path starts at the project already
  # (<project>/<yyyy>/<mm>/<commit>/<stage>); the project's own index's does not.
  at="$top/$path"
  root=envs/prod/payments
  plan="$(fetch "$at/report.json" | jq -r --arg r "$root" '.roots[] | select(.path == $r) | .plan.text // empty')"
  shot report top "$at/report.html" 1600
  shot report root "$at/report.html#root-$root" 1200
  if [ -n "$plan" ]; then shot report plan "$at/$plan" 1400; fi
  shot report index "$top/$project/index.html" 900
}

# Drift: delete a queue outside Terraform, start the pipeline's drift job as a
# reader does from the Actions tab, and photograph the issue it keeps. Reset
# afterwards: the queue comes back and the drift job's pull request closes.
step_drift() {
  run_cmd drift "just example change drift" "$HERE/example.sh" change drift
  local sha before deadline n status url
  sha="$(api "$URL/api/v1/repos/$REPO/branches/main" | jq -r '.commit.id')"
  dispatched() { api "$URL/api/v1/repos/$REPO/actions/runs?head_sha=$sha" | jq -c '[.workflow_runs[] | select(.event == "workflow_dispatch")]'; }
  before="$(dispatched | jq length)"
  if api -o /dev/null -H 'content-type: application/json' -X POST -d '{"ref":"main"}' \
      "$URL/api/v1/repos/$REPO/actions/workflows/terragucci.yml/dispatches"; then
    deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} ))
    status=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
      n="$(dispatched | jq length)"
      if [ "$n" -gt "$before" ]; then
        status="$(dispatched | jq -r '.[0].status')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
      fi
      sleep 5
    done
    log "drift: the dispatched run ended '${status:-unknown}'"
    url="$(api "$URL/api/v1/repos/$REPO/issues?state=open&type=issues&limit=50" \
      | jq -r '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))][0].html_url // empty')"
    if [ -n "$url" ]; then shot drift issue "$(browser_url <<<"$url")" 1600; else log "drift: no drift issue is open"; fi
  else
    log "drift: Forgejo did not start the drift job"
  fi
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "drift: reset failed"
}

# tf-apply on a fountain steward (the move-apply-to-fountain guide): boot the
# example fresh with the steward taking the apply, and show the thread's turn.
step_fountain_apply() {
  run_cmd fountain-apply "just example up --fresh --fountain" "$HERE/example.sh" up --fresh --fountain
  forge
  run_cmd fountain-apply "just example verify" "$HERE/example.sh" verify
}

# The dashboards (the see-your-runs page): three runs of the example sent to
# the observability profile, and four of the dashboards that show them.
# Grafana follows the browser's light or dark preference.
step_see_runs() {
  run_cmd see-runs "just see-runs" "$HERE/see-runs.sh"
  local grafana="http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}" d
  for d in pipeline-health:pipeline rollouts-waves:waves drift:drift runs:runs; do
    shot see-runs "${d#*:}" "$grafana/d/terragucci-${d%%:*}?orgId=1&kiosk"
  done
}

# ── which steps run ────────────────────────────────────────────────────────

ALL=""; [ ${#SELECTED[@]} = 0 ] && ALL=1
selected() { [ -n "$ALL" ] && return 0; local s; for s in "${SELECTED[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

# The last selected step that needs the steps before it: everything of the
# fresh/chain kind up to it is replayed when it is not itself selected.
LAST_CHAIN=-1
i=0
while IFS='|' read -r step needs _; do
  if [ -z "$REUSE" ] && selected "$step" && [ "$needs" = chain ]; then LAST_CHAIN=$i; fi
  i=$((i + 1))
done <<<"$STEPS"

READY=""      # the example is up, at the state this step expects
SKIPPED=""
i=0
while IFS='|' read -r -u 3 step needs claims _; do
  fn="step_${step//-/_}"
  if selected "$step" && [ -z "$REUSE" ]; then
    :
  elif selected "$step"; then
    # --reuse: the example as it stands.
    [ "$needs" = fresh ] || forge
    READY=1
  elif [ $i -lt $LAST_CHAIN ] && { [ "$needs" = fresh ] || [ "$needs" = chain ]; } && [ "$step" != fountain-apply ]; then
    log "$step: replayed, unrecorded"
    rm -f "$STAGE/$step.cmds"
    STEP="$step"; REPLAY=1; "$fn"; REPLAY=""; READY=1
    i=$((i + 1)); continue
  else
    i=$((i + 1)); continue
  fi
  # shellcheck disable=SC2086
  if ! claims_pass $claims; then
    log "$step: skipped, its claims ($claims) do not all pass"
    SKIPPED="$SKIPPED $step"
    i=$((i + 1)); continue
  fi
  STEP="$step"
  # A full capture reaches a booted step with the example as committed (pin
  # and drift reset after themselves). Steps named alone reset it first.
  if [ "$needs" = booted ] && [ -z "$REUSE" ] && { [ -z "$READY" ] || [ -z "$ALL" ]; }; then
    if "$HERE/example.sh" verify >/dev/null 2>&1; then
      log "$step: resetting the running example"
      forge; "$HERE/example.sh" reset >/dev/null 2>&1 || fail "$step: 'just example reset' failed"
    else
      log "$step: booting the example"
      REPLAY=1; step_boot; REPLAY=""
    fi
  elif [ -z "$READY" ] && [ "$needs" = chain ]; then
    REPLAY=1; step_boot; REPLAY=""
  fi
  "$fn"
  READY=1
  commit_step "$step"
  i=$((i + 1))
done 3<<<"$STEPS"
STEP=""

if [ "$CHANGED" = 1 ] || [ ! -f "$DATA/manifest.json" ]; then
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
  jq -n \
    --arg at "$(date -u +%Y-%m-%d)" \
    --arg commit "$(git -C "$ROOT" rev-parse --short HEAD)" \
    --arg tofu "$(sed -n 's/^  TOFU_VERSION: "\(.*\)"/\1/p' "$ROOT/example/.forgejo/workflows/terragucci.yml")" \
    --arg provider "$(sed -n 's/^ *version = "\([0-9.]*\)"/\1/p' "$ROOT/example/envs/dev/orders/main.tf" | head -1)" \
    --arg forgejo "$(curl -fsS "$TERRAGUCCI_FORGEJO_URL/api/v1/version" | jq -r .version | cut -d+ -f1)" \
    --arg floci "$(sed -n 's#.*image: ghcr.io/lex00/floci@sha256:\(.\{12\}\).*#\1#p' "$HERE/docker-compose.yml")" \
    '{captured: $at, commit: $commit, tofu: $tofu, aws_provider: $provider, forgejo: $forgejo, floci: $floci}' \
    > "$DATA/manifest.json"
  log "wrote manifest.json"
fi
if [ -z "$ALL" ] && [ -n "$SKIPPED" ]; then fail "not captured, their claims do not pass:$SKIPPED"; fi
log "done"
