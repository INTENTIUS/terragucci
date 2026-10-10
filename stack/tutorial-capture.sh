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
# A step whose output and screenshots are what is committed keeps its files (a
# screenshot differing only by Forgejo's relative times counts as the same); any
# other difference rewrites the step's JSON and its screenshots together. Only the steps that ran are written, so one step's
# capture never touches another step's files.
#
# The steps run in the order below, and each one starts where the one before it
# left the example. What a step needs (the STEPS table):
#   fresh    it starts from nothing itself (boot)
#   chain    it needs the steps before it: run alone, it boots the example
#            fresh and replays them unrecorded, so pull request and run
#            numbers are those of a full capture
#   booted   it needs the example as committed: run alone, it resets a running
#            example, or boots one
#   alone    it needs nothing of the example: it runs the CLI on a copy of
#            example/, or brings up what it needs itself
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
approved|chain|sealed comment-apply wave-report|record reply log|just example approve of the plans wave 4 refused, then /terragucci apply on the merged module bump; the approval'"'"'s commit on chant/lifecycle, the reply linking the run, and wave 4'"'"'s job log applying
pin|chain|publish rollout|pull files|just example change pin; the rollout'"'"'s wave 1 pull request and its ref bumps
report|booted|report highlight|top root plan index|three tf-plan runs of the example with reports.bucket on floci; the module bump'"'"'s report.html, one root'"'"'s row, that root'"'"'s plan.txt, and the project'"'"'s report index
drift|booted|drift|issue|just example change drift, then the drift job dispatched; the drift issue (the example is reset afterwards)
see-runs|booted|dash-pipeline dash-changes dash-waves dash-drift dash-estate dash-runs dash-slos|pipeline waves drift runs changes estate slos|just see-runs; seven of the dashboards
trace|booted|traces|trace|a tf-plan of the one-root change with telemetry on, sent to the observability profile; that run'"'"'s trace in Grafana'"'"'s Explore, found by the trace id in its report
responses|booted|respond-drift respond-fmt|drift drift-files fmt|the respond-drift and respond-fmt claims; the drift pull request with the live value and an import, its files, and the fmt commit on a pull request'"'"'s branch
tips|booted|tips respond-tips|pull report fix|just example change float, a tf-plan of it with reports.bucket on floci, and the respond-tips claim; the plan note'"'"'s tip line, the report'"'"'s Tips section, and the files of the pull request one tip opens (the pull request is closed afterwards)
policy|booted|policy check-diagnostics|pull log|a pull request on the example that adds a policy denying dev orders'"'"' change, and the check-diagnostics claim; the plan note naming the denial, and the check job'"'"'s log naming the failing policy test (the pull request is closed afterwards)
statuses|booted|grouped comment-apply|checks reply|just example change one-root and the comment-apply claim; the pull request'"'"'s commit statuses, terragucci/plan among them (the pull request is closed afterwards), and the replies to /terragucci apply on a merged pull request
replan|booted|comment-plan comment-not-affected|note replies|just example change one-root, then /terragucci plan, one root it does not reach and one that is not a root as comments; the re-planned note, and the replies (the pull request is closed afterwards)
pr-apply|booted|pr-apply pr-apply-lock pr-apply-stale|reply lock unlock stale|the pr-apply, pr-apply-lock and pr-apply-stale claims; the reply that applied an open pull request and merged it, the refusal naming the lock and its holder, the reply to /terragucci unlock, and the refusal of a head behind main
agent|booted|comment-agent|reply commit refused|the comment-agent claim; the reply linking the agent'"'"'s commit, that commit, and the refusal of an ask that touches the pipeline file
drift-attribute|booted|drift-attribute|issue|the drift-attribute claim; the drift issue naming who changed the attribute, from the audit log
config|alone|zero-config sealed-migrate||terragucci config check and init --dry-run on the example, then config check with a key that is not a setting
publish|booted|publish version-bump-job|tags release|the publish and version-bump-job claims; the module tags the publish job pushed, and the release pull request the version-bump job opened
reconcile|booted|reconcile|pull files|the reconcile claim; the pipeline pull request reconcile opened in the project with no pipeline, and its files
tg|alone|tg-check tg-pr-plan tg-gate-wait|check note waiting|the Terragrunt example with its unformatted scenario pushed to a branch, its module-bump scenario as a pull request, and the tg-gate-wait claim; the check job'"'"'s hcl fmt failure, the plan note, and wave 2 waiting for its own approval (the example is reset afterwards)'

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

# The example's hash: every file under example/, path and content, with the
# pipeline's image references left out (a release moves them, and no capture
# shows them). A capture older than the example it came from fails
# `just tutorial-check`, which computes it (`--hash`).
SOURCE_HASH="$(cd "$ROOT" && node scripts/tutorial-check.mjs --hash)"

claims_pass() { # claim...
  local c
  for c in "$@"; do
    [ "$(jq -r --arg c "$c" '.claims[] | select(.claim == $c and (.forge // "forgejo") == "forgejo") | .verdict' "$SMOKE")" = pass ] || return 1
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

# A job page can open one of its steps and scroll to a log line in it. Any
# other page can open at one element: the 5th argument is then a CSS selector,
# and the 6th a regex the element's text must match. The picture starts 16px
# above that element, and with the height "fit" it is the element's own
# height. SHOT_STYLE, when set, is CSS added to such a page first.
shot() { # step, view, url, [height | fit], [job step to open | element to start at], [log line | that element's text, a regex]
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
    elif [ -n "$open" ]; then
      hooks=(--scroll "$open")
      [ -z "$focus" ] || hooks+=(--match "$focus")
      [ -z "${SHOT_STYLE:-}" ] || hooks+=(--style "$SHOT_STYLE")
      if [ "$height" = fit ]; then
        hooks+=(--fit 1)
        node "$HERE/shot.mjs" --chrome "$CHROME" --url "$url" --out "$png" \
          --width 1280 --height 860 --scheme "$theme" "${hooks[@]}" || true
      else
        node "$HERE/shot.mjs" --chrome "$CHROME" --url "$url" --out "$png" \
          --width 1280 --height "$height" --scheme "$theme" "${hooks[@]}" || true
      fi
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
#
# A step that did not take every screenshot it should have (a view in the
# STEPS table with no picture, because a page was not found) writes nothing:
# its JSON would claim a capture the screenshots do not back. The step is
# listed and the capture fails at the end.
#
# A screenshot that differs from the committed one only in Forgejo's relative
# times ("2 minutes ago") is the same screenshot: stack/png-same.mjs compares
# the pictures with a tolerance, and the committed file and its hash stay.
INCOMPLETE=""
commit_step() { # step
  local step="$1"
  local new="$STAGE/$step.json" old="$DATA/$step.json" shots='{}' v theme png key missing="" same=1 h
  for v in $(field "$step" 4); do
    for theme in light dark; do
      png="$STAGE/$step-$v-$theme.png"
      if [ ! -f "$png" ]; then missing="$missing $v-$theme"; continue; fi
      key="$v-$theme"
      h="$(png_hash "$png")"
      # The committed picture stands when this one is the same within the tolerance.
      if [ -f "$old" ] && [ -f "$SHOTS/$step-$key.png" ] && [ "$(jq -r --arg k "$key" '.shots[$k] // empty' "$old")" = "$(png_hash "$SHOTS/$step-$key.png")" ] \
        && node "$HERE/png-same.mjs" "$SHOTS/$step-$key.png" "$png"; then
        h="$(png_hash "$SHOTS/$step-$key.png")"
        cp "$SHOTS/$step-$key.png" "$png"
      fi
      shots="$(jq --arg k "$key" --arg h "$h" '. + {($k): $h}' <<<"$shots")"
    done
  done
  if [ -n "$missing" ]; then
    log "$step: not written, it took no screenshot for:$missing"
    INCOMPLETE="$INCOMPLETE $step"
    return
  fi
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
  sha="$(remote_head "$REPO" "$1")"
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

# A comment on a pull request, as the repo's admin, as a reader writes one.
# Prints the run it started (the first issue_comment run newer than the
# comment) once that run has finished, so its replies are posted.
say() { # repo, pull request number, text
  local repo="$1" last run="" deadline
  # Forgejo's runs API filters by push and pull_request events, not by
  # issue_comment, so the comment's runs are picked out here.
  last="$(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[]? | select(.event == "issue_comment") | .id] | max // 0')"
  api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$3" '{body: $b}')" \
    "$URL/api/v1/repos/$repo/issues/$2/comments" || return 0
  deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" \
      | jq -c --argjson l "$last" '[.workflow_runs[]? | select(.event == "issue_comment" and .id > $l)] | min_by(.id) // empty')"
    case "$(jq -r '.status // empty' <<<"${run:-null}")" in
      success|failure|cancelled|skipped) break ;;
    esac
    sleep 3
  done
  log "${STEP:-capture}: '$3' on $repo#$2: its run ended '$(jq -r '.status // "unknown"' <<<"${run:-null}")'"
  echo "$run"
}

# One reply of terragucci's on a pull request, the first whose text matches.
reply_shot() { # step, view, pull request page, regex
  shot "$1" "$2" "$3" fit '.timeline-item.comment' "$4"
}

# ── the steps ──────────────────────────────────────────────────────────────

step_boot() {
  # A reader's first boot starts from nothing, so the capture does too.
  "$HERE/down.sh" >/dev/null 2>&1 || true
  # forge() exported the old stack's token and URLs; the new stack makes its own.
  unset TERRAGUCCI_FORGEJO_URL TERRAGUCCI_FORGEJO_TOKEN TERRAGUCCI_FORGEJO_USER TERRAGUCCI_FORGEJO_REPO TERRAGUCCI_FLOCI_URL
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

# A reader who read the moved plans approves them, and asks for the apply
# again on the merged pull request. The approval is a commit on
# chant/lifecycle; the comment's apply-comment job resumes at wave 4.
step_approved() {
  run_cmd approved "just example approve" "$HERE/example.sh" approve
  local sha pr run page
  sha="$(remote_head "$REPO" chant/lifecycle)"
  if [ -n "$sha" ]; then shot approved record "$FORGEJO/commit/$sha" 1000; else log "approved: no chant/lifecycle branch"; fi
  pr="$(api "$URL/api/v1/repos/$REPO/pulls?state=closed&limit=50" | jq -r '[.[] | select(.head.ref == "change/module-bump" and .merged)] | max_by(.number) | .number // empty')"
  [ -n "$pr" ] || { log "approved: no merged module-bump pull request"; return 0; }
  run="$(say "$REPO" "$pr" "/terragucci apply")"
  reply_shot approved reply "$FORGEJO/pulls/$pr" 'terragucci: applied wave'
  page="$(job_page "$run" '.name == "apply-comment"')"
  if [ -n "$page" ]; then shot approved log "$page" 1000 "Apply a merged pull request" "approved by"; else log "approved: the comment's run has no apply-comment job"; fi
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

# The tofu CI image, in CI_IMAGE, and the CLI bundle it runs, built from this tree.
CI_IMAGE=""
ci_ready() { # step
  CI_IMAGE="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$CI_IMAGE" >/dev/null 2>&1 || fail "$1: no CI image $CI_IMAGE; run 'just images'"
  (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
}

# One tf-plan of a copy of the example with one scenario, run as the
# pipeline's plan job runs it: the tofu CI image, the example's state in floci,
# the change against its base. The commits carry fixed dates, so a scenario
# plans the same commits on every capture. Call ci_ready first. The report is
# left in <work dir>/terragucci-report.
plan_example() { # step, work dir, scenario, lines to add to terragucci.yml, [docker run arguments...]
  local step="$1" work="$2" scenario="$3" config="$4" bundle="$ROOT/packages/terragucci/dist/terragucci.mjs" base
  shift 4
  mkdir -p "$work"
  cp -R "$EXAMPLE/." "$work/"
  [ -z "$config" ] || printf '%s\n' "$config" >> "$work/terragucci.yml"
  git -C "$work" init -q -b main
  git -C "$work" add -A
  GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -C "$work" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "The shop's estate"
  base="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" apply "$EXAMPLE/changes/$scenario.patch"
  git -C "$work" add -A
  GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -C "$work" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "$scenario"
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    -e TG_BASE="$base" "$@" \
    "$CI_IMAGE" terragucci stage tf-plan >/dev/null 2>&1 || log "$step: $scenario's plan exited non-zero"
  clean_mounted "$work" "$CI_IMAGE"
}

step_report() {
  local prefix scenario run_index
  ci_ready report
  # The commits are the same on every capture, so a capture replaces its own
  # rows in the index instead of adding to them.
  prefix=reports
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  # The job links in the report go to the run that applied main.
  run_index="$(run_on main | jq -r '.index_in_repo // empty')"
  for scenario in one-root destroy module-bump; do
    plan_example report "$STAGE/report-$scenario" "$scenario" \
      "$(printf 'reports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix")" \
      -e GITHUB_SERVER_URL="$URL" -e GITHUB_REPOSITORY="$REPO" ${run_index:+-e GITHUB_RUN_ID="$run_index"}
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
  local before deadline run status url
  # Forgejo lists runs newest id first. The run is found by its id, never by
  # a head sha (the branches API can lag a push, so a sha read from it may
  # not match the commit the run is created on) and never by a count.
  dispatched() { api "$URL/api/v1/repos/$REPO/actions/runs?event=workflow_dispatch&limit=50" | jq -c '.workflow_runs // []'; }
  before="$(dispatched | jq '[.[].id] | max // 0')"
  if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
      "$URL/api/v1/repos/$REPO/actions/workflows/terragucci.yml/dispatches")"; then
    # The dispatch answers with the run it created; a Forgejo that answers
    # nothing leaves the first dispatch run newer than $before.
    run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
    deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} ))
    status=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
      status="$(dispatched | jq -r --argjson b "$before" --arg r "${run:-0}" \
        '[.[] | select(if $r != "0" then .id == ($r | tonumber) else .id > $b end)] | (.[0].status // "")')"
      case "$status" in success|failure|cancelled|skipped) break ;; esac
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

# The dashboards (the see-your-runs page): three runs of the example sent to
# the observability profile, and four of the dashboards that show them, over
# the last hour: see-runs returns once Grafana shows the runs on every panel
# taken here over that range. Over the dashboards' own week a graph's points
# are a quarter of an hour apart, and runs a minute old are past the last one.
# Grafana follows the browser's light or dark preference.
step_see_runs() {
  run_cmd see-runs "just see-runs" "$HERE/see-runs.sh"
  [ "$(jq -s '.[-1].exit' "$STAGE/see-runs.cmds")" = 0 ] || fail "see-runs: just see-runs failed, so the dashboards would be empty: $(tail -3 "$STAGE/last.out")"
  local grafana="http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}" d
  # The example only: the stack's Prometheus also holds the smoke claims' projects.
  forge
  for d in terragucci-pipeline-health:pipeline terragucci-rollouts-waves:waves terragucci-drift:drift terragucci-runs:runs \
    terragucci-change-review:changes terragucci-estate:estate slo-terragucci-plan-time:slos; do
    shot see-runs "${d#*:}" "$grafana/d/${d%%:*}?orgId=1&kiosk&from=now-1h&to=now&var-project=forgejo:3000/$REPO"
  done
}

# ── the reference pages' steps ─────────────────────────────────────────────
# Several of these run a smoke claim as it is recorded and photograph what it
# leaves on Forgejo: a claim that responds on Forgejo keeps its scratch repo,
# its branches and its pull requests until its next run starts it afresh. The
# claim's own output is not recorded; it carries times and stamps.
claim_run() { # step, claim
  local line
  line="$("$HERE/smoke.sh" "$2" 2>"$STAGE/$2.claim.log" | grep '^SMOKE ' | tail -1)" || true
  case "$line" in
    *verdict=pass*) log "$1: claim $2 passed"; return 0 ;;
  esac
  log "$1: claim $2 did not pass (${line:-no verdict}): $(tail -3 "$STAGE/$2.claim.log" | tr '\n' ' ')"
  return 1
}

# The open pull request from a branch of a repo, by its number.
open_pull() { # repo, branch
  api "$URL/api/v1/repos/$1/pulls?state=open&limit=50" | jq -r --arg b "$2" '.[] | select(.head.ref == $b) | .number' | head -1
}

# A pull request's plan note, the picture starting at the note: the page
# without its #issuecomment- fragment, and that comment as the element.
note_shot() { # step, view, pull request number, height
  local url
  url="$(note_page "$3")"
  case "$url" in
    *'#'*) shot "$1" "$2" "${url%%#*}" "$4" "#${url#*#}" ;;
    *) shot "$1" "$2" "$url" "$4" ;;
  esac
}

# Close a scenario's pull request on the example and delete its branch, so
# the steps after it start from the example as committed.
close_change() { # pull request number, branch
  [ -z "$1" ] || api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$1" || true
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO/branches/${2//\//%2F}" || true
}

# The trace (reference/observability): one plan of the one-root change, as the
# plan job runs it with OTEL_EXPORTER_OTLP_ENDPOINT set, sent to the
# observability profile's collector. The report names the run's trace id
# (run.trace_id); Grafana's Explore opens that trace from Tempo, once Tempo
# holds the binary's spans as well as terragucci's.
step_trace() {
  "$HERE/bootstrap.sh" observability >/dev/null 2>&1 || fail "trace: the observability profile did not start; run 'just stack-up observability' to see why"
  forge
  ci_ready trace
  local work="$STAGE/trace" trace i services=0 panes
  local grafana="http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}" tempo="http://localhost:${TERRAGUCCI_TEMPO_PORT:-3210}"
  plan_example trace "$work" one-root "" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_REPOSITORY="$REPO"
  trace="$(jq -r '.run.trace_id // empty' "$work/terragucci-report/report.json" 2>/dev/null || true)"
  [ -n "$trace" ] || { log "trace: the plan's report records no trace id"; return 0; }
  for i in $(seq 1 30); do   # up to a minute for the collector to flush
    services="$(curl -fsS "$tempo/api/traces/$trace" 2>/dev/null \
      | jq '[(.batches // .trace.resourceSpans // .resourceSpans // [])[] | .resource.attributes[]? | select(.key == "service.name") | .value.stringValue] | unique | length' 2>/dev/null || echo 0)"
    [ "${services:-0}" -ge 2 ] && break
    sleep 2
  done
  [ "${services:-0}" -ge 2 ] || log "trace: Tempo holds trace $trace without the binary's spans"
  panes="$(jq -rn --arg t "$trace" '{t: {datasource: "tempo", queries: [{refId: "A", datasource: {type: "tempo", uid: "tempo"}, queryType: "traceql", query: $t}], range: {from: "now-1h", to: "now"}}} | tostring | @uri')"
  shot trace trace "$grafana/explore?schemaVersion=1&orgId=1&kiosk&panes=$panes" 1400
}

# What responses leave on Forgejo (reference/responses): the drift pull
# request respond-drift opens on its scratch repo, and the commit respond-fmt
# pushes to its branch.
step_responses() {
  forge
  local pr sha repo
  if claim_run responses respond-drift; then
    repo="$USER/respond-drift"
    pr="$(open_pull "$repo" terragucci/drift)"
    if [ -n "$pr" ]; then
      shot responses drift "$URL/$repo/pulls/$pr" 1200
      shot responses drift-files "$URL/$repo/pulls/$pr/files" 1600
    else
      log "responses: no drift pull request on $repo"
    fi
  fi
  if claim_run responses respond-fmt; then
    repo="$USER/respond-fmt"
    sha="$(remote_head "$repo" smoke-fmt)"
    if [ -n "$sha" ]; then shot responses fmt "$URL/$repo/commit/$sha" 1000; else log "responses: $repo has no smoke-fmt branch"; fi
  fi
}

# Tips (reference/tips): the float scenario lets dev search's provider float.
# Its pull request's note counts the tip; a plan of the same change copied to
# floci under its own prefix (so the report step's index stays as it is) gives
# the report's Tips section; and respond-tips leaves the pull requests its
# pipeline's tips job opened, one per tip.
step_tips() {
  forge
  run_cmd tips "just example change float" "$HERE/example.sh" change float
  local pr top index path repo
  pr="$(pr_in_output)"
  if [ -n "$pr" ]; then note_shot tips pull "$pr" 1000; else log "tips: the output named no pull request"; fi
  close_change "$pr" change/float
  ci_ready tips
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  plan_example tips "$STAGE/tips" float "$(printf 'reports:\n  bucket: s3://%s\n  prefix: tips\n' "$REPORT_BUCKET")" \
    -e GITHUB_SERVER_URL="$URL" -e GITHUB_REPOSITORY="$REPO"
  top="$FLOCI/$REPORT_BUCKET/tips"
  index="$(fetch "$top/index.json" || true)"
  path="$(jq -r '.reports[0].path // empty' <<<"${index:-null}" 2>/dev/null || true)"
  if [ -n "$path" ]; then shot tips report "$top/$path/report.html" fit "#tips"; else log "tips: the index at $top lists no run"; fi
  if claim_run tips respond-tips; then
    repo="$USER/respond-tips"
    pr="$(open_pull "$repo" terragucci/tip/pin-hashicorp-aws)"
    if [ -n "$pr" ]; then shot tips fix "$URL/$repo/pulls/$pr/files" 1000; else log "tips: no pin-hashicorp-aws pull request on $repo"; fi
  fi
}

# Policy (reference/policy): a pull request on the example that turns policy
# on and changes dev orders' queue to keep its jobs for seven days. main has no
# policy key, so the pull request's own policy applies, and it denies the
# change. Then the check-diagnostics claim's check job, failing on main's
# policy test.
POLICY_RULE='package main

import rego.v1

deny contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_sqs_queue"
  some action in rc.change.actions
  action in {"create", "update"}
  rc.change.after.message_retention_seconds > 345600
  msg := sprintf("%s keeps messages longer than four days", [rc.address])
}'
step_policy() {
  forge
  local work="$STAGE/policy" branch=change/policy title="Keep dev orders' jobs for seven days, under a retention policy" sha pr run page repo
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git" "$work/tree" 2>/dev/null || fail "policy: cannot clone $REPO"
  git -C "$work/tree" apply "$EXAMPLE/changes/one-root.patch" || fail "policy: changes/one-root.patch does not apply to main"
  mkdir -p "$work/tree/policy"
  printf '%s\n' "$POLICY_RULE" > "$work/tree/policy/retention.rego"
  printf '\npolicy:\n  engine: conftest\n  path: policy\n' >> "$work/tree/terragucci.yml"
  sha="$(TG_FIXED_DATE=1 push_tree "$work/tree" "$REPO" "$branch" "$title")"
  pr="$(api -H 'content-type: application/json' -X POST \
    -d "$(jq -n --arg t "$title" --arg h "$branch" '{title: $t, head: $h, base: "main"}')" "$URL/api/v1/repos/$REPO/pulls" | jq -r '.number // empty')"
  if [ -n "$pr" ]; then
    wait_run "$REPO" "$sha" pull_request
    note_shot policy pull "$pr" 1000
  else
    log "policy: no pull request for $branch"
  fi
  close_change "$pr" "$branch"
  if claim_run policy check-diagnostics; then
    repo="$USER/checkdiag"
    sha="$(remote_head "$repo" diag-policy)"
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" | jq -c '.workflow_runs[0] // empty')"
    page="$(REPO="$repo"; FORGEJO="$URL/$repo"; job_page "$run" '.name == "check"')"
    if [ -n "$page" ]; then shot policy log "$page" 1400 "Format check and validate" "FAILED policy tests"; else log "policy: no check job on $repo's diag-policy"; fi
  fi
}

# Commit statuses and the apply comment (reference/pipeline). The one-root
# change's pull request on the example, once its plan job has posted
# terragucci/plan: its merge box's list of the head's statuses, opened out
# (Forgejo shows six and scrolls the rest), then the pull request is closed.
# And the merged pull request the comment-apply claim leaves, with the
# replies to /terragucci apply.
COMMIT_STATUS_PANEL='.commit-status-panel'
COMMIT_STATUS_STYLE='.commit-status-list { max-height: none !important; overflow: visible !important; }'
step_statuses() {
  forge
  local repo="$USER/comment-apply" pr merged
  run_cmd statuses "just example change one-root" "$HERE/example.sh" change one-root
  pr="$(pr_in_output)"
  if [ -n "$pr" ]; then
    SHOT_STYLE="$COMMIT_STATUS_STYLE" shot statuses checks "$FORGEJO/pulls/$pr" fit "$COMMIT_STATUS_PANEL"
  else
    log "statuses: the output named no pull request"
  fi
  close_change "$pr" change/one-root
  claim_run statuses comment-apply || return 0
  merged="$(api "$URL/api/v1/repos/$repo/pulls?state=closed&limit=50" | jq -r '.[] | select(.head.ref == "change" and .merged) | .number' | head -1)"
  if [ -n "$merged" ]; then
    shot statuses reply "$URL/$repo/pulls/$merged" 1800 '.timeline-item.comment' 'wave 1 waits'
  else
    log "statuses: no merged pull request on $repo"
  fi
}

# Re-plan from a comment (re-plan-from-a-comment), on the example's one-root
# change: /terragucci plan re-plans it and updates the note; a root the
# change does not reach is answered "not affected"; a path that is not a
# root is refused.
step_replan() {
  forge
  run_cmd replan "just example change one-root" "$HERE/example.sh" change one-root
  local pr; pr="$(pr_in_output)"
  [ -n "$pr" ] || { log "replan: the output named no pull request"; return 0; }
  say "$REPO" "$pr" "/terragucci plan" >/dev/null
  note_shot replan note "$pr" 900
  say "$REPO" "$pr" "/terragucci plan envs/prod/payments" >/dev/null
  say "$REPO" "$pr" "/terragucci plan envs/nope" >/dev/null
  shot replan replies "$FORGEJO/pulls/$pr" 520 '.timeline-item.comment' 'terragucci plan envs/prod/payments'
  close_change "$pr" change/one-root
}

# Apply before merge (apply-before-merge): what the three claims leave on
# their scratch repos, each with apply.when: pull-request.
step_pr_apply() {
  forge
  local repo pr
  if claim_run pr-apply pr-apply; then
    repo="$USER/pr-apply"
    pr="$(api "$URL/api/v1/repos/$repo/pulls?state=closed&limit=50" | jq -r '[.[] | select(.head.ref == "change")][0].number // empty')"
    if [ -n "$pr" ]; then reply_shot pr-apply reply "$URL/$repo/pulls/$pr" 'terragucci: applied wave'; else log "pr-apply: no pull request on $repo"; fi
  fi
  if claim_run pr-apply pr-apply-lock; then
    repo="$USER/pr-apply-lock"
    pr="$(open_pull "$repo" change-b)"
    if [ -n "$pr" ]; then reply_shot pr-apply lock "$URL/$repo/pulls/$pr" 'is locked by pull request'; else log "pr-apply: no change-b pull request on $repo"; fi
    pr="$(open_pull "$repo" change-a)"
    if [ -n "$pr" ]; then reply_shot pr-apply unlock "$URL/$repo/pulls/$pr" 'released the locks'; else log "pr-apply: no change-a pull request on $repo"; fi
  fi
  if claim_run pr-apply pr-apply-stale; then
    repo="$USER/pr-apply-stale"
    pr="$(open_pull "$repo" change)"
    if [ -n "$pr" ]; then reply_shot pr-apply stale "$URL/$repo/pulls/$pr" 'is not up to date with main'; else log "pr-apply: no pull request on $repo"; fi
  fi
}

# The agent comment (agent-change-a-pull-request): the comment-agent claim's
# pull request, where a stand-in agent answered two asks.
step_agent() {
  forge
  claim_run agent comment-agent || return 0
  local repo="$USER/comment-agent" pr sha
  pr="$(open_pull "$repo" agent-change)"
  [ -n "$pr" ] || { log "agent: no agent-change pull request on $repo"; return 0; }
  reply_shot agent reply "$URL/$repo/pulls/$pr" 'terragucci: pushed'
  sha="$(remote_head "$repo" agent-change)"
  if [ -n "$sha" ]; then shot agent commit "$URL/$repo/commit/$sha" 540; else log "agent: no agent-change branch on $repo"; fi
  reply_shot agent refused "$URL/$repo/pulls/$pr" 'terragucci: .*touches'
}

# Drift with attribution (turn-on-drift-checks): the drift-attribute claim's
# issue, with who changed the attribute from the audit log.
step_drift_attribute() {
  forge
  claim_run drift-attribute drift-attribute || return 0
  local repo="$USER/drift-attribute" url
  url="$(api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" \
    | jq -r '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))][0].html_url // empty')"
  if [ -n "$url" ]; then shot drift-attribute issue "$(browser_url <<<"$url")" 680; else log "drift-attribute: no drift issue on $repo"; fi
}

# The config check (reference/config): terragucci config check and init
# --dry-run on a copy of the example, as a reader runs them before init, and
# config check again with a key that is not a setting.
step_config() {
  local work="$STAGE/config" cli="$ROOT/packages/terragucci/dist/terragucci.mjs"
  (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
  mkdir -p "$work"
  cp -R "$EXAMPLE/." "$work/"
  run_cmd config "npx terragucci config check" sh -c 'cd "$1" && node "$2" config check' sh "$work" "$cli"
  run_cmd config "npx terragucci init --dry-run" sh -c 'cd "$1" && node "$2" init --dry-run' sh "$work" "$cli"
  printf 'gates: always\n' >> "$work/terragucci.yml"
  run_cmd config "echo 'gates: always' >> terragucci.yml && npx terragucci config check" sh -c 'cd "$1" && node "$2" config check' sh "$work" "$cli"
}

# Module publishing (publish-modules, roll-out-a-module-version): the tags
# the publish claim's pipeline pushed, and the release pull request the
# version-bump job opened.
step_publish() {
  forge
  local repo pr
  if claim_run publish publish; then
    repo="$(api "$URL/api/v1/repos/search?q=publish-&limit=50" | jq -r '[.data[] | select(.name | test("^publish-[0-9]+$"))] | max_by(.id) | .full_name // empty')"
    if [ -n "$repo" ]; then shot publish tags "$URL/$repo/tags" 480; else log "publish: no publish repo"; fi
  fi
  if claim_run publish version-bump-job; then
    repo="$USER/version-bump"
    pr="$(open_pull "$repo" terragucci/release/modules-queue)"
    if [ -n "$pr" ]; then shot publish release "$URL/$repo/pulls/$pr" 880; else log "publish: no release pull request on $repo"; fi
  fi
}

# Many repos (govern-many-repos): the pull request reconcile opened on the
# project with no pipeline, merged by the claim once its check passed.
step_reconcile() {
  forge
  claim_run reconcile reconcile || return 0
  local repo="$USER/two-roots" pr
  pr="$(api "$URL/api/v1/repos/$repo/pulls?state=all&limit=50" | jq -r '[.[] | select(.head.ref == "terragucci/pipeline")][0].number // empty')"
  [ -n "$pr" ] || { log "reconcile: no pipeline pull request on $repo"; return 0; }
  shot reconcile pull "$URL/$repo/pulls/$pr" 1040
  shot reconcile files "$URL/$repo/pulls/$pr/files" 760
}

# Terragrunt (tutorial/terragrunt, use-terragrunt): the Terragrunt example
# beside the plain one, booted when it is not running and reset when it is.
# The unformatted scenario pushed to a branch, and its push run's check job
# failing on terragrunt hcl fmt; the module-bump scenario's pull request and
# its plan note; then the tg-gate-wait claim's run, where wave 2 waits for its
# own approval.
step_tg() {
  forge
  local repo="$USER/example-terragrunt" work="$STAGE/tg" sha page run pr
  if "$HERE/example-terragrunt.sh" verify >/dev/null 2>&1; then
    "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  else
    "$HERE/example-terragrunt.sh" up >/dev/null 2>&1 || fail "tg: 'just example-terragrunt up' failed"
  fi
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work" 2>/dev/null || fail "tg: cannot clone $repo"
  git -C "$work" apply "$ROOT/example-terragrunt/changes/unformatted.patch" || fail "tg: changes/unformatted.patch does not apply to main"
  sha="$(TG_FIXED_DATE=1 push_tree "$work" "$repo" change/unformatted "Name dev orders' owner, without running terragrunt hcl fmt")"
  page="$(REPO="$repo"; FORGEJO="$URL/$repo"; job_page "$(REPO="$repo"; push_run "$sha")" '.status == "failure"')"
  if [ -n "$page" ]; then shot tg check "$page" 900 "Format check" "needs formatting"; else log "tg: no failed job in the push run on ${sha:-the pushed commit}"; fi
  "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  # change opens the pull request and waits for its plan.
  if "$HERE/example-terragrunt.sh" change module-bump >"$STAGE/tg-change.out" 2>&1; then
    pr="$(api "$URL/api/v1/repos/$repo/pulls?state=open&limit=50" | jq -r '.[] | select(.head.ref == "change/module-bump") | .number' | head -1)"
    if [ -n "$pr" ]; then (REPO="$repo"; FORGEJO="$URL/$repo"; note_shot tg note "$pr" 1400); else log "tg: no module-bump pull request"; fi
  else
    log "tg: 'just example-terragrunt change module-bump' failed: $(tail -3 "$STAGE/tg-change.out" | tr '\n' ' ')"
  fi
  "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  if claim_run tg tg-gate-wait; then
    run="$(api "$URL/api/v1/repos/$USER/tg-gate-wait/actions/runs?event=push&limit=50" | jq -c '.workflow_runs[0] // empty')"
    page="$(REPO="$USER/tg-gate-wait"; FORGEJO="$URL/$USER/tg-gate-wait"; job_page "$run" '.status == "failure"')"
    if [ -n "$page" ]; then shot tg waiting "$page" 900 "Apply wave" "waits for an approval of digest"; else log "tg: no stopped job on tg-gate-wait"; fi
  fi
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
  elif [ $i -lt $LAST_CHAIN ] && { [ "$needs" = fresh ] || [ "$needs" = chain ]; }; then
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
if [ -n "$INCOMPLETE" ]; then fail "not written, a screenshot is missing:$INCOMPLETE"; fi
if [ -z "$ALL" ] && [ -n "$SKIPPED" ]; then fail "not captured, their claims do not pass:$SKIPPED"; fi
log "done"
