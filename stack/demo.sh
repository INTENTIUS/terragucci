#!/usr/bin/env bash
#
# The looping demo behold shows: one change across several Terraform states,
# run through the real pipeline on the stack's Forgejo and floci.
#
#   stack/demo.sh up                  boot the forgejo profile, push example-demo/
#                                     to <admin>/demo, apply its four roots, and
#                                     keep the base commit and each root's state
#                                     as the base snapshot. Run once.
#   stack/demo.sh loop [--once] [scenario...]
#                                     run the scenarios one after another and
#                                     reset to the base after each, forever (one
#                                     pass with --once). With no scenario named,
#                                     the ones in DEMO_SCENARIOS (space-separated),
#                                     or else the default two: b-waves, then
#                                     failure. Any of ALL_SCENARIOS can be named.
#   stack/demo.sh down                remove the stack
#
# The roots are network, app (reads network), edge (reads app) and other (reads
# nothing), each terraform_data with its own state. terragucci applies them as
# it applies any repo: one run per root, in waves in dependency order. Nothing
# here makes the waves one transaction; a wave that applied stays applied when
# a later one fails. Scenario 6 (b-composed) turns on waves.compose in its own
# pull request: the roots it reaches plan as one plan and apply as one apply,
# each keeping its own state, and that is not one transaction either.
#
# demo.json is written to <reports bucket>/<prefix>/demo.json in floci at every
# step:
#
#   { "intro": "Big Terraform setups are split into separate states, ...",
#     "cycle": 12, "scenario": "b-waves", "name": "a new subnet", "title": "...",
#     "index": 1, "scenarios": 2,
#     "step": "waiting", "label": "Wave 2 stops and waits for a person to approve it. ...",
#     "started_at": "2026-10-20T10:00:00Z",
#     "next": { "action": "approve wave-2", "at": "2026-10-20T10:04:20Z" },
#     "pull": 41, "commit": "<sha>",
#     "about": { "changes": "...", "watch": "...", "shows": "..." } }
#
# step is one of pull-request, planned, merged, applying, waiting, approved,
# failed, resumed, applied, reset and stalled. next is null at stalled; next.at
# is null while the driver waits on the pipeline rather than on its own clock.
# pull and commit are null until the cycle has them. about is the scenario's
# card, read from example-demo/scenarios/<scenario>/about.json at the start of
# its cycle: what the change is, what to watch for, and what it shows. It is
# null when the scenario has none (the base). just lint-docs lints its text.
#
# intro is the problem the whole demo is about, the same in every write: the
# problem field of example-demo/scenarios/intro.json, which just lint-docs lints
# too. name is the scenario's short label ("a new subnet"); title is its
# headline. index is the scenario's 1-based place in this loop's list and
# scenarios is how many that list holds, so "1 of 2". index is null for the
# base, and scenarios is 0 when up writes it, before any loop.
#
# Beside it, <prefix>/runs/index.json and <prefix>/runs/<id>.json hold the demo
# repo's last 30 pipeline runs with their jobs, steps and logs, copied while
# they run and when they end (runs_export, scripts/demo-runs.ts), so behold's
# kiosk shows them without reaching Forgejo. Each reset deletes the demo repo's
# runs in Forgejo past the newest DEMO_FORGE_RUNS (100) that have ended, so its
# database stays the same size however long the loop runs.
#
# A step past its time limit (DEMO_LIMIT_*) writes "stalled", resets and goes
# on with the next cycle. The host's watchdog restarts the driver itself if it
# dies; the driver's pid is in <state>/demo/driver.pid while it loops.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO="$(cd "$HERE/../example-demo" && pwd)"
CMD="${1:-}"; shift || true

log()  { echo "[demo] $*" >&2; }
fail() { log "FAIL: $*"; [ -z "${DEMO_STATE:-}" ] || printf '%s\n' "$*" > "$DEMO_STATE/reason" 2>/dev/null || true; exit 1; }

# shellcheck disable=SC2015
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so the demo cannot run."; exit 0; }

case "$CMD" in
  down) exec "$HERE/down.sh" ;;
  up|loop) ;;
  *) sed -n '3,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

# Every scenario the driver knows, and the ones a loop runs by default, in order.
ALL_SCENARIOS=(a-known a-output b-waves failure stale-plan b-composed)
SCENARIOS=(b-waves failure)

ROOTS=(network app edge other)
STATE_BUCKET=demo-terraform-state
REPORT_BUCKET=demo-reports
REPORT_PREFIX=demo
CONTROL_BUCKET=demo-control
FAIL_MARKER=app-migration-fails

# How long the driver holds a step so a viewer sees it, and each step's limit.
HOLD="${DEMO_HOLD:-20}"
LIMIT_PLAN="${DEMO_LIMIT_PLAN:-600}"    # a pull request's plan run and its note
LIMIT_RUN="${DEMO_LIMIT_RUN:-900}"      # one apply run, from the push or comment that starts it
LIMIT_START="${DEMO_LIMIT_START:-180}"  # for Forgejo to start a run after a push, merge or comment
LIMIT_QUIET="${DEMO_LIMIT_QUIET:-900}"  # for no run to be in progress before a push
RESUMES_MAX="${DEMO_RESUMES_MAX:-3}"    # approvals and re-runs one cycle may take
FORGE_RUNS="${DEMO_FORGE_RUNS:-100}"    # the runs Forgejo keeps of the demo repo; each reset deletes older ones that ended
POLL="${DEMO_POLL:-1}"                  # seconds between two looks at Forgejo while the driver waits on it

if [ "$CMD" = up ]; then
  # The pipeline runs in terragucci's CI image. Before an image is published,
  # build it into the local daemon, where the runner finds it without pulling.
  # The tag names the version, not the commit, so a checkout that moved within
  # one version would keep running the images of an older commit: they are
  # built again whenever the checkout's commit differs from the one they came from.
  ref="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  built_from="$HERE/.state/ci-images.commit"
  head="$(git -C "$HERE/.." rev-parse HEAD)"
  if ! docker image inspect "$ref" >/dev/null 2>&1 || [ "$(cat "$built_from" 2>/dev/null || true)" != "$head" ]; then
    log "building the CI images at ${head:0:8} (a few minutes the first time)…"
    (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || fail "the CI images did not build; run 'just images' to see why"
    mkdir -p "$HERE/.state"
    echo "$head" > "$built_from"
  fi
  log "starting Forgejo, its runner and floci (a minute or two the first time)…"
  boot_log="$(mktemp)"
  if ! "$HERE/bootstrap.sh" forgejo >"$boot_log" 2>&1; then
    cat "$boot_log" >&2; rm -f "$boot_log"; fail "the stack did not start"
  fi
  rm -f "$boot_log"
fi

# shellcheck source=lib.sh
. "$HERE/lib.sh"
REPO="$USER/demo"
REMOTE="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git"
DEMO_STATE="$TG_STATE/demo"
mkdir -p "$DEMO_STATE"

# The driver plays two people, as a real team would split the work, because an
# approval counts only from someone who had no hand in the change (the
# involvement rule, packages/terragucci/src/involved.ts). The author
# (demo-author) commits and pushes each scenario's change, opens its pull
# request, merges it and comments /terragucci apply. The reviewer
# (demo-reviewer) only approves waves, sealed with its own ssh key, whose public
# half is the one line in .chant/allowed_signers on main from the base on, under
# the principal demo-reviewer. A sealed approval is judged by that principal,
# which is none of the author, the committers, the pipeline token's user or
# agent.login. The admin ($USER) keeps the out-of-band work: the base, the
# reset's force-push, the repo and the runs. stack/bootstrap.sh forgejo makes
# both users, their tokens and the reviewer's key.
person_var() { # name -> its value, from the environment or else stack/.state/forgejo.env
  local v="${!1:-}"
  [ -n "$v" ] || v="$(sed -n "s/^export $1=//p" "$TG_STATE/forgejo.env" 2>/dev/null || true)"
  [ -n "$v" ] || fail "$1 is not in $TG_STATE/forgejo.env; run 'just demo up' again, whose bootstrap makes the demo's author and reviewer"
  echo "$v"
}
AUTHOR="$(person_var TERRAGUCCI_FORGEJO_AUTHOR)"
AUTHOR_TOKEN="$(person_var TERRAGUCCI_FORGEJO_AUTHOR_TOKEN)"
REVIEWER="$(person_var TERRAGUCCI_FORGEJO_REVIEWER)"
REVIEWER_TOKEN="$(person_var TERRAGUCCI_FORGEJO_REVIEWER_TOKEN)"
REVIEWER_KEY="$(person_var TERRAGUCCI_FORGEJO_REVIEWER_KEY)"
[ -f "$REVIEWER_KEY" ] || fail "the reviewer's key $REVIEWER_KEY is missing; run 'just demo up' again"
REVIEWER_REMOTE="${URL/#http:\/\//http://${REVIEWER}:${REVIEWER_TOKEN}@}/$REPO.git"
as_author() { curl -fsS -H "Authorization: token $AUTHOR_TOKEN" "$@"; }

# Both people may write to the demo repo: the author pushes, merges and asks for
# an apply (which needs write access), and the reviewer's approval is a commit
# chant pushes to the ledger branch. Adding a collaborator again changes nothing.
people_join() {
  local who
  for who in "$AUTHOR" "$REVIEWER"; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"write"}' \
      "$URL/api/v1/repos/$REPO/collaborators/$who" || fail "could not give $who write access to $REPO"
  done
}

CHANT="$HERE/../node_modules/.bin/chant"
TERRAGUCCI="$HERE/../node_modules/.bin/terragucci"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-demo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

now() { date +%s; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# ── demo.json ────────────────────────────────────────────────────────────────

CYCLE=0 SCENARIO="" TITLE="" STARTED="" PULL="" COMMIT="" INDEX="" COUNT=0
RUN_ID="" RUN_STATUS="" RUN_URL="" OUTCOME="" WAVE="" CYCLE_DONE="" ATTEMPT=0

demo_put() { # the local demo.json to <reports bucket>/<prefix>/demo.json
  curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @"$DEMO_STATE/demo.json" \
    "$FLOCI/$REPORT_BUCKET/$REPORT_PREFIX/demo.json" || log "could not write demo.json to floci"
}

demo_write() { # step, label, [next action], [next at, epoch seconds]
  local step="$1" label="$2" action="${3:-}" at="${4:-}" at_iso="" next=null
  [ -z "$at" ] || at_iso="$(iso "$at")"
  [ -z "$action" ] || next="$(jq -cn --arg a "$action" --arg t "$at_iso" '{action: $a, at: (if $t == "" then null else $t end)}')"
  jq -n --argjson cycle "$CYCLE" --arg scenario "$SCENARIO" --arg title "$TITLE" --arg step "$step" --arg text "$label" \
    --arg started "$(iso "${STARTED:-$(now)}")" --argjson next "$next" --arg pull "$PULL" --arg commit "$COMMIT" \
    --argjson about "${ABOUT:-null}" --argjson where "$(demo_where)" \
    '$where + {cycle: $cycle, scenario: $scenario, title: $title, step: $step, label: $text, started_at: $started, next: $next,
      pull: (if $pull == "" then null else ($pull | tonumber) end), commit: (if $commit == "" then null else $commit end),
      about: $about}' \
    > "$DEMO_STATE/demo.json.new"
  mv "$DEMO_STATE/demo.json.new" "$DEMO_STATE/demo.json"
  log "cycle $CYCLE $SCENARIO: $step: $label"
  demo_put
}

# The fields of demo.json that say where the viewer is: the demo's intro, the
# scenario's short name, and its place in this loop's list.
demo_where() {
  jq -cn --arg intro "$INTRO" --arg name "$(scenario_name "$SCENARIO")" --arg index "$INDEX" --argjson count "$COUNT" \
    '{intro: (if $intro == "" then null else $intro end), name: $name,
      index: (if $index == "" then null else ($index | tonumber) end), scenarios: $count}'
}

# The problem the demo is about, from example-demo/scenarios/intro.json; empty when it can't be read.
INTRO="$(jq -r '.problem // empty' "$DEMO/scenarios/intro.json" 2>/dev/null || true)"

# The scenario's card from its about.json, compact; null when it has none.
scenario_about() { # scenario
  local f="$DEMO/scenarios/$1/about.json"
  [ -f "$f" ] && jq -ce '{changes, watch, shows}' "$f" 2>/dev/null || echo null
}

# Write a step whose next action is the driver's own, HOLD seconds on, and wait them out.
demo_hold() { # step, label, next action
  local at=$(( $(now) + HOLD ))
  demo_write "$1" "$2" "$3" "$at"
  sleep "$HOLD"
}

# A cycle that died or ran past a limit: the last demo.json, as stalled.
demo_stalled() {
  local reason="" last="{}" was
  [ ! -f "$DEMO_STATE/reason" ] || reason="$(head -1 "$DEMO_STATE/reason")"
  [ -n "$reason" ] || reason="the cycle stopped"
  # The cycle's own last step, pull request and commit; none when it stopped before writing one.
  last="$(jq -c --argjson cycle "$CYCLE" 'if .cycle == $cycle then . else {} end' "$DEMO_STATE/demo.json" 2>/dev/null || echo '{}')"
  was="$(jq -r '.step // "the start"' <<<"$last")"
  jq -n --argjson last "$last" --argjson cycle "$CYCLE" --arg scenario "$SCENARIO" --arg title "$TITLE" \
    --arg started "$(iso "${STARTED:-$(now)}")" --arg text "Stalled after $was: $reason. The driver resets and goes on with the next cycle." \
    --argjson about "${ABOUT:-null}" --argjson where "$(demo_where)" \
    '$where + {cycle: $cycle, scenario: $scenario, title: $title, step: "stalled", label: $text, started_at: $started, next: null,
      pull: ($last.pull // null), commit: ($last.commit // null), about: $about}' > "$DEMO_STATE/demo.json.new"
  mv "$DEMO_STATE/demo.json.new" "$DEMO_STATE/demo.json"
  log "cycle $CYCLE $SCENARIO: stalled: $reason"
  demo_put
}

# ── the runs, for the kiosk ──────────────────────────────────────────────────

# The demo repo's pipeline runs, copied from Forgejo into <reports
# bucket>/<prefix>/runs/ by scripts/demo-runs.ts: index.json, and one <id>.json
# per run with its jobs, steps and the tail of each step's log. It keeps the
# newest 30 runs and deletes the objects of older ones. behold's kiosk reads
# these and never talks to Forgejo. Each poll of a wait calls runs_export, which
# copies at most every 5 s, in the background so the poll goes on; a run the
# driver marks or sees end is copied at once, after any copy in the background
# has finished. One copy runs at a time: its pid is in <runs state>/export.pid.
# An export that fails is logged, and the cycle goes on.
RUNS_STATE="$DEMO_STATE/runs"
RUNS_PID="$RUNS_STATE/export.pid"
RUNS_AT=0
runs_copy() { # [keep: delete the runs Forgejo holds past the newest this many that ended]
  (cd "$HERE/.." && DEMO_RUNS_FORGE_URL="$URL" DEMO_RUNS_TOKEN="$TOKEN" DEMO_RUNS_REPO="$REPO" \
    DEMO_RUNS_BUCKET_URL="$FLOCI/$REPORT_BUCKET" DEMO_RUNS_PREFIX="$REPORT_PREFIX" DEMO_RUNS_STATE="$RUNS_STATE" \
    DEMO_RUNS_CYCLE="$CYCLE" DEMO_RUNS_SCENARIO="$SCENARIO" DEMO_RUNS_CYCLE_STARTED="${STARTED:-}" DEMO_RUNS_DROP="$REVIEWER_KEY"$'\n'"$AUTHOR_TOKEN"$'\n'"$REVIEWER_TOKEN" \
    DEMO_RUNS_PRUNE_KEEP="${1:-}" node_modules/.bin/tsx scripts/demo-runs.ts) || log "runs: the runs were not all copied to floci; the cycle goes on"
  return 0
}

# Wait for a copy in the background to finish, from this shell or an earlier
# cycle's. A copy rewrites marks.jsonl from what it read when it started, so a
# mark is appended only once none runs. A copy stops itself after 60 s, so a
# pid that lives longer is not one.
runs_wait() {
  local pid deadline=$(( $(now) + 70 ))
  read -r pid 2>/dev/null <"$RUNS_PID" || return 0
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  while kill -0 "$pid" 2>/dev/null && [ "$(now)" -lt "$deadline" ]; do sleep 0.2; done
  return 0
}

runs_export() { # [force], [keep: as runs_copy]
  if [ -z "${1:-}" ]; then
    [ $(( $(now) - RUNS_AT )) -ge 5 ] || return 0
    local pid=""
    read -r pid 2>/dev/null <"$RUNS_PID" || true
    case "$pid" in ''|*[!0-9]*) ;; *) ! kill -0 "$pid" 2>/dev/null || return 0 ;; esac
    RUNS_AT="$(now)"
    mkdir -p "$RUNS_STATE" 2>/dev/null || true
    runs_copy &
    echo "$!" > "$RUNS_PID" 2>/dev/null || true
    return 0
  fi
  runs_wait
  RUNS_AT="$(now)"
  runs_copy "${2:-}"
}

# What the driver did to start run RUN_ID (plan, merge, resume, reset, base or
# push), in this cycle and scenario, for the run's trigger, cycle and scenario
# in the bucket. Then copy the runs at once.
runs_mark() { # trigger, [pull request], [ref]
  mkdir -p "$RUNS_STATE" 2>/dev/null || true
  runs_wait
  jq -cn --argjson id "${RUN_ID:-null}" --arg t "$1" --argjson c "${CYCLE:-null}" --arg s "$SCENARIO" --arg p "${2:-}" --arg r "${3:-}" \
    '{id: $id, trigger: $t, cycle: $c, scenario: (if $s == "" then null else $s end),
      pull: (if $p == "" then null else ($p | tonumber) end)} + (if $r == "" then {} else {ref: $r} end)' \
    >> "$RUNS_STATE/marks.jsonl" 2>/dev/null || log "runs: could not mark run ${RUN_ID:-?} $1"
  runs_export force
}

# ── floci ────────────────────────────────────────────────────────────────────

# A terraform_data's input in the root's state, as floci holds it now. A
# resource's, not an output's: a root whose apply failed may not have written
# its outputs.
state_input() { # root, resource name
  curl -fsS "$FLOCI/$STATE_BUCKET/$1.tfstate" 2>/dev/null \
    | jq -r --arg n "$2" '[.resources[]? | select(.mode == "managed" and .name == $n) | .instances[]?.attributes.input | if type == "object" then .value else . end][0] // "nothing" | tostring' 2>/dev/null \
    || echo nothing
}

# A terraform_data's id in the root's state: the value terraform_data picks
# when it creates the resource, unknown to any plan before that.
state_id() { # root, resource name
  curl -fsS "$FLOCI/$STATE_BUCKET/$1.tfstate" 2>/dev/null \
    | jq -r --arg n "$2" '[.resources[]? | select(.mode == "managed" and .name == $n) | .instances[]?.attributes.id][0] // "nothing" | tostring' 2>/dev/null \
    || echo nothing
}

applied_values() { # -> "network 9090, app 9080, edge http://app:9080", from the states
  printf 'network %s, app %s, edge %s' \
    "$(state_input network http_proxy_port)" "$(state_input app listener_port)" "$(state_input edge upstream)"
}

marker_set()   { printf 'set by stack/demo.sh\n' | curl -fsS -o /dev/null -X PUT --data-binary @- "$FLOCI/$CONTROL_BUCKET/$FAIL_MARKER"; }
marker_clear() { curl -sS -o /dev/null -X DELETE "$FLOCI/$CONTROL_BUCKET/$FAIL_MARKER" || true; }

# ── Forgejo ──────────────────────────────────────────────────────────────────

runs() { api "$URL/api/v1/repos/$REPO/actions/runs?page=1&limit=50" | jq -c '.workflow_runs // []'; }
last_run_id() { runs | jq -r '[.[].id] | max // 0'; }

# No push while a wave waits or applies: a wave that finds main moved stands
# down (--stand-down), and one waiting would plan again on another commit. Every
# push waits here for no run of the repo to be in progress, and refuses while
# this cycle has a wave waiting (HELD), unless the caller says the push is the
# point (scenario 5's push to main, DEMO_PUSH_WHILE_HELD=1).
HELD=""
quiet() {
  local deadline=$(( $(now) + LIMIT_QUIET )) busy
  if [ -n "$HELD" ] && [ -z "${DEMO_PUSH_WHILE_HELD:-}" ]; then
    fail "a push was asked for while $HELD waits"
  fi
  while :; do
    runner_watch
    runs_export
    busy="$(runs | jq -r '[.[] | select(.status == "running" or .status == "waiting" or .status == "blocked" or .status == "unknown")] | length' || true)"
    [ "$busy" = 0 ] && return 0
    [ "$(now)" -lt "$deadline" ] || fail "a run was still in progress after ${LIMIT_QUIET}s, so nothing was pushed"
    sleep "$POLL"
  done
}

push_quiet() { # dir, branch, message -> prints the pushed sha
  quiet
  push_tree "$@"
}

# A scenario's commit: written, committed and pushed by the author, so the
# commit-author check names the author.
push_as_author() { # dir, repo, branch, message -> prints the pushed sha
  PUSH_NAME="$AUTHOR" PUSH_EMAIL="$AUTHOR@terragucci.local" PUSH_USER="$AUTHOR" PUSH_TOKEN="$AUTHOR_TOKEN" push_quiet "$@"
}

clone_main() { # dir
  git clone -q "$REMOTE" "$1" 2>/dev/null || fail "could not clone $REPO"
}

# The run a push, merge or comment started: the first one newer than BEFORE of
# that event (and on that sha, when given). Sets RUN_ID.
# With RUN_SOFT=1, no run within the limit returns 1 instead of failing.
run_started() { # before id, event, [sha]
  local before="$1" event="$2" sha="${3:-}" deadline=$(( $(now) + LIMIT_START )) id
  while :; do
    runner_watch
    runs_export
    id="$(runs | jq -r --argjson b "$before" --arg e "$event" --arg s "$sha" \
      '[.[] | select(.id > $b and .event == $e and ($s == "" or (.head_sha // .commit_sha) == $s))] | min_by(.id) | .id // empty' || true)"
    if [ -n "$id" ]; then RUN_ID="$id"; return 0; fi
    if [ "$(now)" -ge "$deadline" ]; then
      [ -z "${RUN_SOFT:-}" ] || return 1
      fail "no $event run started within ${LIMIT_START}s"
    fi
    sleep "$POLL"
  done
}

# Wait for run RUN_ID to end. Sets RUN_STATUS and RUN_URL.
run_ended() { # limit
  local deadline=$(( $(now) + $1 )) run status=""
  while :; do
    runner_watch
    runs_export
    run="$(api "$URL/api/v1/repos/$REPO/actions/runs/$RUN_ID" 2>/dev/null || true)"
    status="$(jq -r '.status // empty' <<<"$run" 2>/dev/null || true)"
    case "$status" in success|failure|cancelled|skipped) break ;; esac
    [ "$(now)" -lt "$deadline" ] || fail "run $RUN_ID did not end within ${1}s (last status: ${status:-none})"
    sleep "$POLL"
  done
  runs_export force
  RUN_STATUS="$status"
  RUN_URL="$(jq -r '.html_url // empty' <<<"$run" | sed "s#^http://forgejo:3000#$URL#")"
}

# What run RUN_ID ended in. Sets OUTCOME (applied, waiting, refused, failed or
# cancelled) and WAVE (the wave that waited, refused or failed, when the run says).
run_outcome() {
  local logs line job
  OUTCOME="" WAVE=""
  case "$RUN_STATUS" in
    success) OUTCOME=applied; return 0 ;;
    cancelled|skipped) OUTCOME=cancelled; return 0 ;;
  esac
  logs="$(run_logs "$REPO" "$RUN_ID" 2>/dev/null || true)"
  # A wave whose plans moved after their approval (apply.ts) prints the approve
  # line too, so the refusal is read first.
  if line="$(grep -oE 'wave [0-9]+ changed after it was approved' <<<"$logs" | head -1)" && [ -n "$line" ]; then
    OUTCOME=refused; WAVE="$(grep -oE '[0-9]+' <<<"$line" | head -1)"; return 0
  fi
  if line="$(grep -oE 'terragucci approve wave-[0-9]+' <<<"$logs" | head -1)" && [ -n "$line" ]; then
    OUTCOME=waiting; WAVE="${line##*wave-}"; return 0
  fi
  OUTCOME=failed
  job="$(api "$URL/api/v1/repos/$REPO/actions/runs/$RUN_ID/jobs" 2>/dev/null | jq -r '[.[] | select(.status == "failure") | .name][0] // empty' || true)"
  WAVE="$(grep -oE 'wave-[0-9]+' <<<"$job" | head -1 | sed 's/wave-//' || true)"
}

# The reviewer's approval: chant approve as the reviewer's principal, sealed
# with the reviewer's key, from the reviewer's own clone, so the ledger commit
# chant pushes is the reviewer's too. The reviewer had no hand in the change.
approve_wave() { # wave number
  local clone="$WORK/approve-$CYCLE-$1-$RANDOM" out
  git clone -q "$REVIEWER_REMOTE" "$clone" 2>/dev/null || fail "$REVIEWER could not clone $REPO"
  git -C "$clone" config user.name "$REVIEWER"
  git -C "$clone" config user.email "$REVIEWER@terragucci.local"
  out="$(cd "$clone" && "$CHANT" approve tf-apply "wave-$1" --actor "$REVIEWER" --sign "$REVIEWER_KEY" 2>&1)" \
    || { echo "$out" >&2; fail "chant approve tf-apply wave-$1 failed"; }
}

# Start the merged pull request's waves again, as the author: /terragucci
# apply on it with the author's write token (packages/terragucci/src/resume.ts
# does the same for Forgejo). The rule does not judge the commenter, only who
# opened, wrote and committed the change and the tokens' users, and the author
# is one of those anyway. Sets RUN_ID to the comment's run.
resume_pull() {
  local before
  before="$(last_run_id)"
  as_author -o /dev/null -H 'content-type: application/json' -X POST -d '{"body":"/terragucci apply"}' \
    "$URL/api/v1/repos/$REPO/issues/$PULL/comments" || fail "could not comment /terragucci apply on pull request $PULL"
  run_started "$before" issue_comment
  runs_mark resume "$PULL"
}

# ── one cycle ────────────────────────────────────────────────────────────────

scenario_title() {
  case "$1" in
    a-known)    echo "A port change, known when it plans" ;;
    a-output)   echo "The same change, read through .output" ;;
    failure)    echo "A failure halfway through, and a re-run that finishes it" ;;
    stale-plan) echo "main moves after an approval, and the wave refuses the old plan" ;;
    b-waves)    echo "A new subnet, and a value nobody could review" ;;
    b-composed) echo "A new network, read downstream, in one composed run" ;;
    *) return 1 ;;
  esac
}

# The scenario's short label, beside its place in the loop ("1 of 2 · a new subnet").
scenario_name() {
  case "$1" in
    base)       echo "the base" ;;
    a-known)    echo "a known value" ;;
    a-output)   echo "read through .output" ;;
    failure)    echo "a failure halfway" ;;
    stale-plan) echo "a stale plan" ;;
    b-waves)    echo "a new subnet" ;;
    b-composed) echo "B composed" ;;
    *)          echo "$1" ;;
  esac
}

# The plan note's cost line comes from example-demo/scripts/cost.mjs, a stub;
# every planned label says so.
COST_STUB="Its cost line uses made-up prices from a fixed table"

# The label of a step for this cycle's scenario; the generic one when the
# scenario has none of its own.
say() { # step
  local values
  case "$SCENARIO:$1" in
    a-known:pull-request)   echo "Pull request $PULL: network's http_proxy_port goes 8080 -> 9090, and its output reads .input" ;;
    a-known:planned)        echo "One plan note: network 8080 -> 9090, app's listener 9080 and edge's upstream http://app:9080 planned on the new value; other is not planned. $COST_STUB" ;;
    a-known:applying)       echo "Wave 1 applies network, then wave 2 app and wave 3 edge, each in its own state; nothing is destroyed, so no wave waits" ;;
    a-output:pull-request)  echo "Pull request $PULL: the same 8080 -> 9090, but network's output reads terraform_data.http_proxy_port.output, which is unknown until it applies" ;;
    a-output:planned)       echo "The plan note shows app's listener and edge's upstream as known after apply: the review does not show the values they will get; other is not planned. $COST_STUB" ;;
    a-output:applying)      echo "Wave 1 applies network; app and edge read its output before it was known, so each plans again on what was applied before it and waits for an approval of that plan" ;;
    a-output:approved)      echo "Wave $WAVE approved by the driver with the reviewer's key, not by the pull request's review: no review showed the values it now applies" ;;
    a-output:applied)       echo "Applied: $(applied_values). app's and edge's values applied after the driver's approvals, not the pull request's review: no review showed them" ;;
    b-waves:pull-request)   echo "Pull request $PULL is open (a proposed change, waiting for review). Network adds a subnet, and app adds four resources that use the subnet's id." ;;
    b-waves:planned)        echo "The plan is posted on the pull request. Network will build the subnet. App's four resources say \"known after apply\", because the subnet has no id until it exists, so the reviewer can't see what they will get. Other, the fourth state, has no change." ;;
    b-waves:applying)       echo "Wave 1 builds network's subnet, and now the subnet has an id. App, in wave 2, makes a new plan with that id." ;;
    b-waves:approved)       echo "The driver approves wave 2 with the reviewer's signing key, standing in for a person who had no hand in the change. The pull request's review never covered this plan. App's resources go into subnet $(state_id network subnet)." ;;
    b-waves:applied)        echo "Done. Network has subnet $(state_id network subnet), and app put its four resources in it. They landed only after a person approved them, because no review showed the subnet id they use." ;;
    b-composed:pull-request) echo "Pull request $PULL: scenario 3's change, a subnet in network that app's four new resources read, and terragucci.yml turns on waves.compose for this pull request only, so the roots it reaches plan as one plan and apply as one apply. compose is opt-in beside the waves: every other scenario applies in waves" ;;
    b-composed:planned)     echo "One plan note with one composed plan of $COMPOSED, each a module of the one run and each keeping its own state. app's four new resources plan as known after apply: the subnet's id is unknown until the run creates it, and the same apply computes them. The review does not show the values they will get; other is not planned. $COST_STUB" ;;
    b-composed:applying)    echo "Wave 1 carries the composed run (compose:wave-1): it locks the states of $COMPOSED, pulls them and plans them once. The later waves have nothing of their own to apply" ;;
    b-composed:approved)    echo "Wave 1 approved by the driver with the reviewer's key, for the composed run's digest; the pull request's review approved nothing. The re-run plans $COMPOSED again as one run and applies them in one apply" ;;
    b-composed:applied)     echo "Applied in one apply: network's subnet $(state_id network subnet), and app's $(state_input app instance), computed in the same run after the driver's approval, not the pull request's review. Each state was written with what applied to it. Nothing here is atomic: had the apply failed part way, what applied would stay applied and each state would be written with what applied to it" ;;
    failure:pull-request)   echo "Pull request $PULL is open (a proposed change, waiting for review). Network's port goes from 8080 to 9090, and app gains a database migration. The driver (the script running this demo) has switched on a fault, so the migration will fail." ;;
    failure:planned)        echo "The plan is posted on the pull request. Network and app each get a new port. App also gets the migration, and edge will follow app's port. Other, the fourth state, has no change." ;;
    failure:applying)       echo "Wave 1 changes network's port. App is in wave 2, where its port changes before the migration runs." ;;
    failure:approved)       echo "The driver approves wave $WAVE with the reviewer's signing key, standing in for a person who had no hand in the change, so the re-run can replace the failed migration." ;;
    failure:applied)        echo "Done on the second run. Network's port is now $(state_input network http_proxy_port) and app's is $(state_input app listener_port). Edge points at $(state_input edge upstream)." ;;
    stale-plan:pull-request) echo "Pull request $PULL: network's release marker goes from r0 to r$CYCLE, which replaces it" ;;
    stale-plan:planned)     echo "One plan note: network replaces its release marker, so wave 1 will wait for an approval; other is not planned. $COST_STUB" ;;
    *:merged)               echo "Pull request $PULL is merged into main (the branch the pipeline applies) at ${COMMIT:0:8}, and the pipeline starts." ;;
    *:applying)             echo "The waves apply in order: network, then app, then edge, each in its own state" ;;
    *:applied)
      values="$(applied_values)"
      echo "Applied: $values" ;;
    *:approved)             echo "Wave $WAVE approved, sealed with the reviewer's key" ;;
    *:resumed)              echo "The driver comments /terragucci apply on pull request $PULL, and the pipeline runs the waves again. A wave that already landed has nothing left to do." ;;
    *) echo "$1" ;;
  esac
}

# Open the scenario's pull request from the base: its files under
# example-demo/scenarios/<scenario>/pull/ over main, @CYCLE@ filled in.
open_pull() {
  local tree="$WORK/c$CYCLE/pull" sha before
  clone_main "$tree"
  overlay "$DEMO/scenarios/$SCENARIO/pull" "$tree"
  before="$(last_run_id)"
  sha="$(push_as_author "$tree" "$REPO" "demo-$SCENARIO" "$TITLE (cycle $CYCLE)")"
  PULL="$(pr_open "demo-$SCENARIO" "$TITLE")"
  COMMIT="$sha"
  demo_write pull-request "$(say pull-request)" "wait for the plan note"
  run_started "$before" pull_request "$sha"
  runs_mark plan "$PULL" "demo-$SCENARIO"
  run_ended "$LIMIT_PLAN"
  [ "$RUN_STATUS" = success ] || fail "the plan run of pull request $PULL ended $RUN_STATUS ($RUN_URL)"
  # The plan job's note is a comment on the pull request.
  local deadline=$(( $(now) + 60 ))
  until api "$URL/api/v1/repos/$REPO/issues/$PULL/comments?limit=50" | jq -e '[.[] | select(.body | contains("terragucci tf-plan"))] | length > 0' >/dev/null; do
    [ "$(now)" -lt "$deadline" ] || fail "the plan run passed but no plan note is on pull request $PULL"
    sleep "$POLL"
  done
}

overlay() { # from, to: copy the scenario's files over the tree, with @CYCLE@ filled in
  local f rel
  (cd "$1" && find . -type f) | while read -r f; do
    rel="${f#./}"
    mkdir -p "$2/$(dirname "$rel")"
    sed "s/@CYCLE@/$CYCLE/g" "$1/$rel" > "$2/$rel"
  done
}

pr_open() { # branch, title -> prints the number of the pull request into main, opened by the author
  local n=""
  for _ in $(seq 1 60); do
    api -o /dev/null "$URL/api/v1/repos/$REPO/branches/$1" 2>/dev/null && break
    sleep "$POLL"
  done
  n="$(as_author -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg h "$1" --arg t "$2" --argjson c "$CYCLE" '{head: $h, base: "main", title: $t, body: "Cycle \($c) of the terragucci demo (stack/demo.sh)."}')" \
    "$URL/api/v1/repos/$REPO/pulls" | jq -r '.number // empty')"
  [ -n "$n" ] || fail "no pull request opened from $1"
  echo "$n"
}

merge_pull() { # the author merges -> COMMIT is the merge commit, RUN_ID its push run
  local before merged=""
  quiet
  before="$(last_run_id)"
  for _ in $(seq 1 10); do
    as_author -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$REPO/pulls/$PULL/merge" 2>/dev/null && { merged=1; break; }
    sleep 3
  done
  [ -n "$merged" ] || fail "pull request $PULL did not merge"
  COMMIT=""
  for _ in $(seq 1 60); do
    COMMIT="$(api "$URL/api/v1/repos/$REPO/pulls/$PULL" | jq -r '.merge_commit_sha // empty' || true)"
    [ -z "$COMMIT" ] || break
    sleep "$POLL"
  done
  [ -n "$COMMIT" ] || fail "pull request $PULL merged, but Forgejo names no merge commit"
  demo_write merged "$(say merged)" "follow the waves"
  run_started "$before" push "$COMMIT"
  runs_mark merge "$PULL"
}

# Follow run RUN_ID and every re-run the cycle needs, until its waves applied.
# A waiting wave: hold, approve, resume (on_waiting). A failed one: the
# scenario's on_failed, or a stall. A refused one: the scenario's on_refused,
# or a stall. A hook that ends the cycle itself sets CYCLE_DONE. The step a
# re-run starts on (resumed) stays until that run ends.
follow() {
  local resumes=0
  CYCLE_DONE=""
  demo_write applying "$(say applying)" "follow the waves"
  while :; do
    run_ended "$LIMIT_RUN"
    run_outcome
    case "$OUTCOME" in
      applied) HELD=""; return 0 ;;
      cancelled) fail "run $RUN_ID was cancelled ($RUN_URL)" ;;
      refused) on_refused; return 0 ;;
    esac
    resumes=$((resumes + 1))
    [ "$resumes" -le "$RESUMES_MAX" ] || fail "the waves needed more than $RESUMES_MAX approvals and re-runs"
    case "$OUTCOME" in
      waiting) on_waiting ;;
      failed) on_failed ;;
    esac
    [ -z "$CYCLE_DONE" ] || return 0
  done
}

# The default at a waiting wave: hold so the viewer sees it, approve it with
# the reviewer's key, and post /terragucci apply on the merged pull request as
# the author.
default_waiting() {
  HELD="wave-$WAVE"
  demo_hold waiting "$(waiting_label)" "approve wave-$WAVE"
  approve_wave "$WAVE"
  demo_write approved "$(say approved)" "post /terragucci apply on pull request $PULL"
  resume_pull
  demo_write resumed "$(say resumed)" "follow the waves"
}

waiting_label() {
  case "$SCENARIO:$WAVE" in
    b-composed:1) echo "Wave 1 waits for an approval of the composed run: app reads network's subnet id, unknown at plan time and computed in this apply, so no review showed the values app gets. Nothing is destroyed, so gate: on-destructive alone would not hold it; the driver approves the composed run's digest" ;;
    a-output:*)   echo "Wave $WAVE waits for an approval: it read an output that was unknown when the change was reviewed, and nobody reviewed the plan it made once that output applied. Nothing is destroyed, so gate: on-destructive alone would not hold it; the driver approves that plan" ;;
    b-waves:2)    echo "Wave 2 stops and waits for a person to approve it. App's new plan holds the subnet's id, and no review ever saw that plan. Nothing gets destroyed, yet the pipeline still asks. The reviewer (played by the driver, the script running this demo) gives that approval here." ;;
    failure:2)    echo "Wave 2 stops and waits for a person to approve it. The re-run replaces the failed migration, which destroys something, so it asks first. The driver gives that approval here." ;;
    stale-plan:1) echo "Wave 1 waits for an approval: it replaces network's release marker" ;;
    *)            echo "Wave $WAVE waits for an approval" ;;
  esac
}

default_failed()  { fail "wave ${WAVE:-?} failed ($RUN_URL)"; }
default_refused() { fail "wave ${WAVE:-?} refused its plan ($RUN_URL)"; }

# ── the scenarios ────────────────────────────────────────────────────────────

# 1 and 2: open, plan, merge, follow. In 1 no wave waits under gate: on-destructive;
# in 2 app's and edge's waves read an output unknown at review, so each waits
# for the driver's approval (#1012).
scenario_a() {
  open_pull
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  follow
}

# 4: app fails mid-apply. The marker is set before the pull request; wave 2
# fails, wave 1 stays applied. The driver holds, deletes the marker and posts
# /terragucci apply, and the waves finish (the re-run's replace of the tainted
# migration waits at the gate first, and is approved like any waiting wave).
failure_failed() {
  [ "${WAVE:-2}" = 2 ] || fail "wave $WAVE failed, not app's wave 2 ($RUN_URL)"
  demo_hold failed "Wave 2 failed in app's migration. Nothing is undone. Network keeps port $(state_input network http_proxy_port), and app's state keeps port $(state_input app listener_port), which landed before the migration ran. Edge did not run." \
    "clear the fault and run the pipeline again"
  marker_clear
  resume_pull
  demo_write resumed "The driver clears the fault and comments /terragucci apply on pull request $PULL. On this second run network has nothing left to change, and app's migration gets another try." "follow the waves"
}

scenario_failure() {
  marker_set || fail "could not set the failure marker in floci"
  on_failed() { failure_failed; }
  open_pull
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  follow
}

# 5: a stale plan. Wave 1 waits for an approval of the plan it made; the driver
# approves it, then pushes another change to network on main before resuming.
# The push's wave plans again, finds the plans moved since the approval and
# applies nothing (apply.ts: "changed after it was approved"). This push goes
# while wave 1 waits: it is the point of the scenario.
stale_waiting() {
  [ "$WAVE" = 1 ] || fail "wave $WAVE waits, not network's wave 1 ($RUN_URL)"
  HELD="wave-1"
  demo_hold waiting "$(waiting_label)" "approve wave-1"
  approve_wave 1
  demo_write approved "Wave 1 approved for the plan it showed. Before it resumes, the driver pushes another change to network on main" "push to main"
  local tree="$WORK/c$CYCLE/push" before
  clone_main "$tree"
  overlay "$DEMO/scenarios/stale-plan/push" "$tree"
  before="$(last_run_id)"
  COMMIT="$(DEMO_PUSH_WHILE_HELD=1 push_as_author "$tree" "$REPO" main "network: http_proxy_port 8080 -> 9090 (cycle $CYCLE)")"
  run_started "$before" push "$COMMIT"
  runs_mark push
  demo_write applying "main moved to ${COMMIT:0:8}: network's http_proxy_port 8080 -> 9090 on top of the approved change. Wave 1 plans again on the new commit" "follow the waves"
  run_ended "$LIMIT_RUN"
  run_outcome
  [ "$OUTCOME" = refused ] || fail "the push's wave 1 did not refuse the stale plan: it ended $OUTCOME ($RUN_URL)"
  HELD=""
  LAST_STEP=failed
  LAST_LABEL="Wave 1 refused the stale plan: network planned differently from the approved plan, so nothing applied. network still holds $(state_input network http_proxy_port)"
  CYCLE_DONE=1
}

# 3: B on waves (#1012). The pull request plans app on network's planned
# outputs, where the new subnet's id is unknown, so app plans known after
# apply. On main, wave 1 applies network; app's wave plans again on the id it
# applied, and holds for an approval because nobody reviewed that plan
# (apply.ts, byReads: "nobody reviewed the plan it made on those outputs"). The
# driver checks the run says so, then approves it like any waiting wave: the
# value applies after the driver's approval, not the pull request's review.
b_waves_waiting() {
  [ "$WAVE" = 2 ] || fail "wave $WAVE waits, not app's wave 2 ($RUN_URL)"
  run_logs "$REPO" "$RUN_ID" 2>/dev/null | grep -q 'nobody reviewed the plan it made on those outputs' \
    || fail "wave 2 waits, but its run does not say it read an output unknown at review ($RUN_URL)"
  default_waiting
}

scenario_b_waves() {
  on_waiting() { b_waves_waiting; }
  open_pull
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  follow
}

# 6: B composed (#1013). Scenario 3's change, with waves.compose: true added to
# terragucci.yml in the pull request itself. tf-plan reads the config of the
# head it plans, and a merge's wave reads the merge commit's (the apply job is
# given no --base, so waveSettings in apply.ts reads the checkout), so the
# pull request turns compose on for its own plan and apply, and the reset,
# which forces main back to the base, turns it off. network, app and edge (edge
# reads app) plan as one run in wave 1, the earliest wave of the three, as the
# target compose:wave-1. app reads the subnet id unknown at plan time, so the
# wave holds under gate: on-destructive (apply.ts, byReads), and the driver
# approves wave-1, the gate chant knows, like any waiting wave.
COMPOSED="network, app and edge"

# The plan run says which roots it composed (report/stage.ts: "plan as one
# composed run in wave"), or why the change applies in waves instead; a change
# that did not compose stalls the cycle rather than show waves as scenario 6.
b_composed_planned() {
  local logs line roots
  logs="$(run_logs "$REPO" "$RUN_ID" 2>/dev/null || true)"
  if ! line="$(grep -oE 'compose: [^ ].* plan as one composed run in wave [0-9]+' <<<"$logs" | head -1)" || [ -z "$line" ]; then
    line="$(grep -oE 'compose: .*, so the change applies in waves' <<<"$logs" | head -1 || true)"
    fail "the pull request's plan did not compose: ${line:-its run does not say} ($RUN_URL)"
  fi
  roots="${line#compose: }"
  roots="${roots% plan as one composed run in wave *}"
  COMPOSED="$(sed -E 's/, ([^,]*)$/ and \1/' <<<"$roots")"
}

b_composed_waiting() {
  local logs
  [ "$WAVE" = 1 ] || fail "wave $WAVE waits, not wave 1, which carries the composed run ($RUN_URL)"
  logs="$(run_logs "$REPO" "$RUN_ID" 2>/dev/null || true)"
  grep -q 'apply as one composed run in wave 1 (compose:wave-1)' <<<"$logs" \
    || fail "wave 1 waits, but its run does not say it carries the composed run ($RUN_URL)"
  grep -q 'nobody reviewed the plan it made on those outputs' <<<"$logs" \
    || fail "wave 1 waits, but its run does not say the composed run read a value unknown at plan time ($RUN_URL)"
  default_waiting
}

scenario_b_composed() {
  on_waiting() { b_composed_waiting; }
  open_pull
  b_composed_planned
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  follow
}

scenario_stale_plan() {
  on_waiting() { stale_waiting; }
  open_pull
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  follow
}

run_cycle() {
  SCENARIO="$1"
  TITLE="$(scenario_title "$1")" || fail "unknown scenario '$1' (${ALL_SCENARIOS[*]})"
  ABOUT="$(scenario_about "$1")"
  PULL="" COMMIT="" HELD="" LAST_STEP="" LAST_LABEL=""
  on_waiting() { default_waiting; }
  on_failed() { default_failed; }
  on_refused() { default_refused; }
  mkdir -p "$WORK/c$CYCLE"
  case "$SCENARIO" in
    a-known|a-output) scenario_a ;;
    b-waves) scenario_b_waves ;;
    b-composed) scenario_b_composed ;;
    failure) scenario_failure ;;
    stale-plan) scenario_stale_plan ;;
  esac
  # A scenario that ends on a refusal names its own last step; the rest end applied.
  if [ "$OUTCOME" = applied ]; then
    LAST_STEP=applied LAST_LABEL="$(say applied)"
  fi
  if [ -n "$LAST_STEP" ]; then
    cycle_end
  else
    audit_trail
  fi
}

# The cycle's last step, held HOLD seconds while the audit and the reset's work
# go on behind it, then reset once both are done. The label is read from the
# states before the reset writes them back, and what behold's kiosk shows does
# not move until reset is written: it narrates demo.json, and draws the reports
# pinned to this cycle's commit (runPin in behold's web/kiosk.js), never the
# live states. The runs pane shows the reset's run as it starts, as it did when
# the run started after the hold. reset is written after the push back's run
# has ended, so the next cycle's first push finds no run in progress.
cycle_end() {
  local at=$(( $(now) + HOLD )) left
  demo_write "$LAST_STEP" "$LAST_LABEL" reset "$at"
  audit_trail
  reset_work
  left=$(( at - $(now) ))
  [ "$left" -le 0 ] || sleep "$left"
  reset_written
}

# The cycle at hand ended with its own reset written (cycle_end).
cycle_reset() {
  jq -e --argjson c "$CYCLE" '.cycle == $c and .step == "reset"' "$DEMO_STATE/demo.json" >/dev/null 2>&1
}

# The history: terragucci audit appends this cycle's approvals (from
# chant/lifecycle on the demo repo) and wave reports (from the reports bucket)
# to <prefix>/audit.jsonl in floci, and writes audit.html and audit.json beside
# it. It runs from the host, in a clone of main whose origin is the demo repo,
# against floci's host address. The project is named as the jobs name it
# (GITHUB_SERVER_URL is Forgejo's ROOT_URL inside the stack), so it reads the
# reports the waves indexed under forgejo:3000/<admin>/demo. An audit that
# fails is logged and never stalls the cycle.
audit_trail() {
  local clone="$WORK/c$CYCLE/audit" out
  git clone -q "$REMOTE" "$clone" 2>/dev/null || { log "audit: could not clone $REPO"; return 0; }
  if out="$(cd "$clone" && AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
      GITHUB_SERVER_URL=http://forgejo:3000 GITHUB_REPOSITORY="$REPO" \
      "$TERRAGUCCI" audit --bucket "s3://$REPORT_BUCKET" --bucket-endpoint "$FLOCI" --bucket-prefix "$REPORT_PREFIX" \
      --out "$WORK/c$CYCLE/audit-out" --link-hours 1 2>&1)"; then
    log "audit: $(head -1 <<<"$out")"
  else
    log "audit: terragucci audit failed; the trail did not grow this cycle"
    printf '%s\n' "$out" >&2
  fi
}

# ── reset, out of band ───────────────────────────────────────────────────────

# After the last wave ended: close the pull requests, write each root's state
# back to the base snapshot, clear the failure marker and force main back to
# the base commit. Never through a gated wave: the push back to base plans
# against the base states, which match it, so its waves have nothing to apply.
# reset_work does it all and waits for the push back's run; reset_written
# writes the step.
reset_base() {
  reset_work
  reset_written
}

reset_work() {
  local base n root before
  base="$(cat "$DEMO_STATE/base.sha")"
  HELD=""
  quiet
  for n in $(api "$URL/api/v1/repos/$REPO/pulls?state=open&limit=50" | jq -r '.[].number'); do
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$n" || true
  done
  for root in "${ROOTS[@]}"; do
    curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @"$DEMO_STATE/base/$root.tfstate" \
      "$FLOCI/$STATE_BUCKET/$root.tfstate" || fail "could not write $root's base state back"
  done
  marker_clear
  # A composed run (scenario 6) that stopped part way may leave its lock on a
  # state, or a state it could not write kept beside it, which the next
  # composed run would write before it plans (packages/terragucci/src/compose.ts).
  # No run is in progress here (quiet), so neither belongs to a live run.
  for root in "${ROOTS[@]}"; do
    curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$root.tfstate.tflock" || true
    curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$root.tfstate.terragucci-unwritten" || true
  done
  if [ "$(remote_head "$REPO" main)" != "$base" ]; then
    before="$(last_run_id)"
    git -C "$DEMO_STATE/base-tree" push -q --force "$REMOTE" "$base:refs/heads/main" 2>/dev/null || fail "could not force main back to ${base:0:8}"
    # The push back starts a run on the base, which has nothing to apply; wait
    # for it, so the next cycle's first push finds no run in progress.
    if RUN_SOFT=1 run_started "$before" push "$base"; then
      runs_mark reset
      # While that run plans: delete the runs Forgejo holds past the newest
      # FORGE_RUNS that have ended. The copy keeps the newest 30 of the newest
      # 50 it lists, so it never reads a run this deletes.
      runs_export force "$FORGE_RUNS"
      run_ended "$LIMIT_RUN"
      return 0
    fi
    log "no run started for the push back to ${base:0:8}"
  fi
  runs_export force "$FORGE_RUNS"
}

reset_written() {
  local base
  base="$(cat "$DEMO_STATE/base.sha")"
  PULL="" COMMIT="$base"
  demo_write reset "Outside the pipeline, the driver resets every state to how it started. It also moves main back to ${base:0:8} for the next scenario." "start the next cycle"
}

# ── commands ─────────────────────────────────────────────────────────────────

# Run "$@" in a subshell with errexit on, and set ATTEMPT to its status. Called
# as a plain command, never in a condition, where bash would ignore errexit
# inside it: a step that fails or passes its limit ends the subshell there.
attempt() {
  set +e
  ( set -e; "$@" )
  ATTEMPT=$?
  set -e
}

case "$CMD" in
  up)
    started=$(now)
    if ! api -o /dev/null "$URL/api/v1/repos/$REPO" 2>/dev/null; then
      api -o /dev/null -H 'content-type: application/json' -X POST \
        -d "{\"name\":\"${REPO#*/}\",\"description\":\"The terragucci demo: four roots of terraform_data, a change across their states\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" \
        "$URL/api/v1/user/repos"
    fi
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$REPO"
    for b in "$STATE_BUCKET" "$REPORT_BUCKET" "$CONTROL_BUCKET"; do curl -fsS -o /dev/null -X PUT "$FLOCI/$b" || true; done
    marker_clear
    people_join
    # The base: example-demo/ less its scenarios, the pipeline init writes, and
    # the reviewer's key in .chant/allowed_signers. It is the commit every reset
    # forces main back to. The admin pushes it, out of band: no wave judges it
    # as a change, because each wave's rule is read at the commit before the one
    # it applies, and the base is never in the range after it.
    rm -rf "$DEMO_STATE/base-tree"
    mkdir -p "$DEMO_STATE/base-tree"
    (cd "$DEMO" && tar cf - --exclude ./scenarios .) | (cd "$DEMO_STATE/base-tree" && tar xf -)
    (cd "$DEMO_STATE/base-tree" && "$TERRAGUCCI" init >/dev/null) || fail "terragucci init failed on example-demo"
    mkdir -p "$DEMO_STATE/base-tree/.chant"
    echo "$REVIEWER $(cut -d' ' -f1,2 "$REVIEWER_KEY.pub")" > "$DEMO_STATE/base-tree/.chant/allowed_signers"
    # floci may still hold the states of a cycle the driver left part way (a
    # restart after the checkout moved): writing the last base snapshot back
    # first, as the reset does, leaves the base's pipeline nothing to destroy,
    # which gate: on-destructive would otherwise hold for an approval.
    if [ -d "$DEMO_STATE/base" ]; then
      for root in "${ROOTS[@]}"; do
        [ -f "$DEMO_STATE/base/$root.tfstate" ] || continue
        curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @"$DEMO_STATE/base/$root.tfstate" \
          "$FLOCI/$STATE_BUCKET/$root.tfstate" || fail "could not write $root's base state back"
        curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$root.tfstate.tflock" || true
        curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$root.tfstate.terragucci-unwritten" || true
      done
      marker_clear
      log "wrote the last base snapshot back to floci before pushing the base"
    fi
    sha="$(push_tree "$DEMO_STATE/base-tree" "$REPO" main "The demo's base: network, app, edge and other")"
    log "pushed the base to main at ${sha:0:8}; the pipeline applies every root…"
    wait_run "$REPO" "$sha"
    if [ "$RUN_STATUS" != success ]; then
      print_logs "$REPO" "$RUN_ID"
      fail "the base's pipeline ended '$RUN_STATUS'"
    fi
    mkdir -p "$DEMO_STATE/base"
    for root in "${ROOTS[@]}"; do
      curl -fsS -o "$DEMO_STATE/base/$root.tfstate" "$FLOCI/$STATE_BUCKET/$root.tfstate" || fail "$root has no state in floci after the base applied"
    done
    echo "$sha" > "$DEMO_STATE/base.sha"
    [ -f "$DEMO_STATE/cycle" ] || echo 0 > "$DEMO_STATE/cycle"
    CYCLE="$(cat "$DEMO_STATE/cycle")" SCENARIO=base TITLE="The base" ABOUT=null STARTED="$started" COMMIT="$sha"
    runs_mark base
    demo_write reset "The base is applied: $(applied_values), and other" "start the first cycle"
    log "ready in $(( $(now) - started ))s"
    cat <<OUT

  The demo's base is applied.

  Forgejo     $URL/$REPO
  Pipeline    $RUN_URL
  demo.json   $FLOCI/$REPORT_BUCKET/$REPORT_PREFIX/demo.json

  Next: just demo loop
OUT
    ;;

  loop)
    ONCE="" list=()
    for a in "$@"; do
      case "$a" in
        --once) ONCE=1 ;;
        -*) fail "unknown flag '$a' (--once)" ;;
        *) scenario_title "$a" >/dev/null || fail "unknown scenario '$a' (${ALL_SCENARIOS[*]})"; list+=("$a") ;;
      esac
    done
    # No scenario named: DEMO_SCENARIOS, checked like the arguments, or the default two.
    if [ "${#list[@]}" -eq 0 ] && [ -n "${DEMO_SCENARIOS:-}" ]; then
      read -r -a named <<<"$DEMO_SCENARIOS"
      for a in ${named[@]+"${named[@]}"}; do
        scenario_title "$a" >/dev/null || fail "unknown scenario '$a' in DEMO_SCENARIOS (${ALL_SCENARIOS[*]})"
        list+=("$a")
      done
    fi
    [ "${#list[@]}" -gt 0 ] || list=("${SCENARIOS[@]}")
    COUNT="${#list[@]}"
    [ -f "$DEMO_STATE/base.sha" ] || fail "no base snapshot; run 'just demo up' first"
    # A base pushed before the driver played two people names the driver's key
    # in .chant/allowed_signers, so the reviewer's seal would not verify.
    git -C "$DEMO_STATE/base-tree" show "$(cat "$DEMO_STATE/base.sha"):.chant/allowed_signers" 2>/dev/null | grep -q "^$REVIEWER " \
      || fail "the base's .chant/allowed_signers does not name $REVIEWER; run 'just demo up' again"
    people_join
    echo "$$" > "$DEMO_STATE/driver.pid"
    # An earlier driver's background copy is not this one's to wait on.
    mkdir -p "$RUNS_STATE" && : > "$RUNS_PID"
    CYCLE="$(cat "$DEMO_STATE/cycle" 2>/dev/null || echo 0)"
    SCENARIO=base TITLE="The base" ABOUT=null STARTED="$(now)" INDEX=""
    # A driver the watchdog restarted may have left a cycle half done.
    attempt reset_base
    [ "$ATTEMPT" = 0 ] || demo_stalled
    while :; do
      INDEX=0
      for s in "${list[@]}"; do
        INDEX=$((INDEX + 1))
        CYCLE=$((CYCLE + 1))
        echo "$CYCLE" > "$DEMO_STATE/cycle"
        : > "$DEMO_STATE/reason"
        SCENARIO="$s" TITLE="$(scenario_title "$s")" ABOUT="$(scenario_about "$s")" STARTED="$(now)" PULL="" COMMIT="" OUTCOME=""
        # A step that fails or passes its limit ends the cycle's subshell; the
        # loop writes stalled and resets.
        attempt run_cycle "$s"
        cycled="$ATTEMPT"
        [ "$cycled" = 0 ] || demo_stalled
        rm -rf "$WORK/c$CYCLE"
        # A cycle that ended on its last step has reset behind it (cycle_end).
        if [ "$cycled" = 0 ] && cycle_reset; then ATTEMPT=0; else attempt reset_base; fi
        while [ "$ATTEMPT" != 0 ]; do
          demo_stalled
          sleep "$HOLD"
          : > "$DEMO_STATE/reason"
          attempt reset_base
        done
      done
      [ -z "$ONCE" ] || break
    done
    ;;
esac
