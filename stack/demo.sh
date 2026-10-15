#!/usr/bin/env bash
#
# The looping demo behold shows: one change across several Terraform states,
# run through the real pipeline on the stack's Forgejo and floci.
#
# Each scenario belongs to a tool, and each tool has its own forge repo pushed
# from its own example tree: terraform's scenarios run on <admin>/demo, from
# example-demo/ (roots network, app, edge and other); terragrunt's on
# <admin>/demo-terragrunt, from example-demo-terragrunt/. A loop walks its
# scenarios and switches repos between them. The roots and their state keys
# come from each tree: a Terraform root's backend key, and a Terragrunt unit's
# key from root.hcl's remote_state.
#
#   stack/demo.sh up                  boot the forgejo profile, and for each
#                                     tool whose tree is in the checkout push
#                                     the tree to its repo, apply its roots, and
#                                     keep the base commit and each root's state
#                                     as that repo's base snapshot. Run once.
#   stack/demo.sh loop [--once] [scenario...]
#                                     run the scenarios one after another and
#                                     reset to the base after each, forever (one
#                                     pass with --once). With no scenario named,
#                                     the ones in DEMO_SCENARIOS (space-separated),
#                                     or else the default two: b-waves, then
#                                     failure. Any of ALL_SCENARIOS can be named,
#                                     tg-planned-outputs (Terragrunt) among them.
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
#     "tool": "terraform", "repo": "<admin>/demo",
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
# card, read from <tool's tree>/scenarios/<scenario>/about.json at the start of
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
# tool is the tool the scenario shows (terraform, terragrunt) and repo the forge
# repo its cycle runs on (<admin>/demo, <admin>/demo-terragrunt): the repo whose
# commit, pull request and runs the step names. Every write has both.
#
# Every write is also appended, with an at time, to the cycle's timeline. When
# a cycle ends with reset, the driver publishes it as its tool's latest:
#
#   <prefix>/cycles/<tool>/latest.json and <prefix>/cycles/<tool>/<cycle>.json
#   { "schema": "demo.cycle/v1", "tool": "terragrunt", "repo": "<admin>/demo-terragrunt",
#     "scenario": "tg-planned-outputs", "cycle": 14,
#     "started": "2026-10-20T10:00:00Z", "ended": "2026-10-20T10:02:10Z",
#     "steps": [ { <demo.json as written>, "at": "2026-10-20T10:00:01Z" }, ... ],
#     "runs": [ <the ids of the runs the cycle started, oldest first> ] }
#
# started is the cycle's started_at and ended the reset's at. runs are the ids
# in <prefix>/runs/ that the driver marked (or placed) in the cycle, so a page
# can show the same runs. Each tool keeps its newest 5 <cycle>.json; a publish
# deletes older ones. A cycle that stalled at any step is never published, so
# latest.json is always a cycle that ran to its reset (scripts/demo-cycles.ts).
#
# Beside it, <prefix>/runs/index.json and <prefix>/runs/<id>.json hold the last
# 30 pipeline runs of the repos the loop uses, with their jobs, steps and logs,
# each run with its repo and tool, copied while they run and when they end
# (runs_export, scripts/demo-runs.ts), so behold's kiosk shows them without
# reaching Forgejo. Each reset deletes each of those repos' runs in Forgejo past
# the newest DEMO_FORGE_RUNS (100) that have ended, so its database stays the
# same size however long the loop runs.
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
ALL_SCENARIOS=(a-known a-output b-waves failure stale-plan b-composed tg-planned-outputs)
# tg-planned-outputs runs by name or DEMO_SCENARIOS, and joins the default list
# once behold can draw a Terragrunt repo.
SCENARIOS=(b-waves failure)

# Each scenario runs on its tool's repo: one forge repo per tool, pushed from
# that tool's example tree. A tool whose tree is not in the checkout has no
# repo; up skips it.
TOOLS=(terraform terragrunt)
scenario_tool() { # scenario -> its tool
  case "$1" in
    a-known|a-output|b-waves|failure|stale-plan|b-composed|base) echo terraform ;;
    tg-planned-outputs) echo terragrunt ;;
    *) return 1 ;;
  esac
}
tool_repo() { # tool -> the repo's name under the admin
  case "$1" in
    terraform) echo demo ;;
    terragrunt) echo demo-terragrunt ;;
    *) return 1 ;;
  esac
}
tool_tree() { # tool -> its example tree, from the checkout's root
  case "$1" in
    terraform) echo example-demo ;;
    terragrunt) echo example-demo-terragrunt ;;
    *) return 1 ;;
  esac
}
tool_present() { [ -d "$HERE/../$(tool_tree "$1")" ]; }

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
  # Each tool's repo runs in its own image: tofu's, and terragrunt's when that tree is here.
  refs="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" || $1 == "terragrunt" { print $1, $2 }')"
  built_from="$HERE/.state/ci-images.commit"
  head="$(git -C "$HERE/.." rev-parse HEAD)"
  missing=""
  while read -r name ref; do
    [ "$name" = tofu ] || tool_present terragrunt || continue
    docker image inspect "$ref" >/dev/null 2>&1 || missing=1
  done <<<"$refs"
  if [ -n "$missing" ] || [ "$(cat "$built_from" 2>/dev/null || true)" != "$head" ]; then
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

# ── the repos, one per tool ──────────────────────────────────────────────────

# "<root> <state key>" for each root of a tree: a Terraform root's backend key,
# or a Terragrunt unit's key from the remote_state in root.hcl (the tree's own,
# or the one given, for a scenario's files). A root is a directory one level
# down with a .tf file whose backend names a key, or any directory below with a
# terragrunt.hcl.
tree_keys() { # dir, tool, [root.hcl]
  local dir="$1" f root key template
  case "$2" in
    terraform)
      for f in "$dir"/*/*.tf; do
        [ -f "$f" ] || continue
        key="$(awk '/backend "s3"/ { b = 1 } b && /^[[:space:]]*key[[:space:]]*=/ { sub(/^[^"]*"/, ""); sub(/".*/, ""); print; exit }' "$f")"
        [ -z "$key" ] || { root="${f#"$dir"/}"; echo "${root%/*} $key"; }
      done | sort -u ;;
    terragrunt)
      template="$(sed -n 's/^[[:space:]]*key[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "${3:-$dir/root.hcl}" 2>/dev/null | head -1)"
      [ -n "$template" ] || return 0
      (cd "$dir" && find . -name terragrunt.hcl -not -path '*/.terragrunt-cache/*' -not -path './scenarios/*' | sed 's#^\./##; s#/terragrunt.hcl$##' | sort) \
        | while read -r root; do echo "$root ${template//\$\{path_relative_to_include()\}/$root}"; done ;;
  esac
}

# The state bucket a tree's roots name: the first bucket in a backend or remote_state.
tree_bucket() { # dir
  local f
  for f in "$1"/root.hcl "$1"/*/*.tf; do
    [ -f "$f" ] || continue
    awk '/backend "s3"|remote_state/ { b = 1 } b && /^[[:space:]]*bucket[[:space:]]*=/ { sub(/^[^"]*"/, ""); sub(/".*/, ""); print; exit }' "$f"
  done | head -1
}

# Point the driver at a tool's repo: REPO, its remotes, its example tree, the
# directory that keeps its base (the terraform repo's is DEMO_STATE itself, as
# before there were several), its state bucket, BASE_KEYS ("<root> <key>" of
# the roots the base applies), EXTRA_KEYS (those only a scenario's files add,
# which a reset deletes) and ROOTS. INIT_PULL is set when a scenario's pull
# request runs terragucci init after its files, as an author adding units does.
use_repo() { # tool
  local d keys=""
  TOOL="$1"
  REPO="$USER/$(tool_repo "$1")" || fail "unknown tool '$1'"
  TREE="$(cd "$HERE/../$(tool_tree "$1")" 2>/dev/null && pwd)" || fail "the $1 demo's tree $(tool_tree "$1")/ is not in this checkout"
  REMOTE="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git"
  REVIEWER_REMOTE="${URL/#http:\/\//http://${REVIEWER}:${REVIEWER_TOKEN}@}/$REPO.git"
  if [ "$1" = terraform ]; then RSTATE="$DEMO_STATE"; else RSTATE="$DEMO_STATE/repos/${REPO#*/}"; fi
  STATE_BUCKET="$(tree_bucket "$TREE")"
  [ -n "$STATE_BUCKET" ] || fail "no state bucket is named in $TREE"
  BASE_KEYS="$(tree_keys "$TREE" "$1")"
  [ -n "$BASE_KEYS" ] || fail "no root with a state key in $TREE"
  for d in "$TREE"/scenarios/*/pull "$TREE"/scenarios/*/push; do
    [ -d "$d" ] && keys="$keys$(tree_keys "$d" "$1" "$TREE/root.hcl")"$'\n'
  done
  EXTRA_KEYS="$(grep -v '^$' <<<"$keys" | sort -u | grep -vxF -f <(printf '%s\n' "$BASE_KEYS") || true)"
  read -r -a ROOTS <<<"$(awk '{ print $1 }' <<<"$BASE_KEYS" | tr '\n' ' ')"
  INIT_PULL=""
  [ "$1" != terragrunt ] || INIT_PULL=1
}

root_key() { # root -> its state key in this repo, a scenario's own roots too
  awk -v r="$1" '$1 == r { print $2; exit }' <<<"$BASE_KEYS"$'\n'"$EXTRA_KEYS"
}

# The file of a root's base state: its name with each / as __.
snapshot() { # root
  echo "$RSTATE/base/${1//\//__}.tfstate"
}

# The repos this driver works on, as "<repo> <tool>" lines, for the runs copy:
# up's, or the loop's scenarios'.
LOOP_TOOLS=()
loop_repos() {
  local t
  for t in ${LOOP_TOOLS[@]+"${LOOP_TOOLS[@]}"}; do echo "$USER/$(tool_repo "$t") $t"; done
}

use_repo terraform
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

demo_put() { # the local demo.json to <reports bucket>/<prefix>/demo.json, and onto the cycle's timeline
  curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @"$DEMO_STATE/demo.json" \
    "$FLOCI/$REPORT_BUCKET/$REPORT_PREFIX/demo.json" || log "could not write demo.json to floci"
  jq -c --arg at "$(iso "$(now)")" '. + {at: $at}' "$DEMO_STATE/demo.json" >> "$DEMO_STATE/timeline.jsonl" 2>/dev/null \
    || log "could not add the step to the cycle's timeline"
}

# The cycle's timeline: every demo.json it wrote, each with the time it was
# written (at), one a line in <state>/timeline.jsonl. It starts empty with each
# cycle, and with each repo's reset when a loop starts.
timeline_start() { : > "$DEMO_STATE/timeline.jsonl"; }

# Publish the cycle that just wrote reset as its tool's latest
# (scripts/demo-cycles.ts): <prefix>/cycles/<tool>/latest.json and
# <prefix>/cycles/<tool>/<cycle>.json, keeping the newest 5 per tool. The
# script publishes nothing for the base or for a cycle whose timeline holds a
# stalled step, so a stalled cycle never replaces latest. A publish that fails
# is logged, and the loop goes on.
cycle_publish() {
  runs_wait
  (cd "$HERE/.." && DEMO_CYCLES_TIMELINE="$DEMO_STATE/timeline.jsonl" DEMO_CYCLES_MARKS="$RUNS_STATE/marks.jsonl" \
    DEMO_CYCLES_BUCKET_URL="$FLOCI/$REPORT_BUCKET" DEMO_CYCLES_PREFIX="$REPORT_PREFIX" \
    DEMO_CYCLES_TOOL="$TOOL" DEMO_CYCLES_REPO="$REPO" DEMO_CYCLES_CYCLE="$CYCLE" DEMO_CYCLES_SCENARIO="$SCENARIO" \
    node_modules/.bin/tsx scripts/demo-cycles.ts) || log "cycles: cycle $CYCLE was not published to floci; the loop goes on"
  return 0
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
    --arg tool "$TOOL" --arg repo "$REPO" \
    '{intro: (if $intro == "" then null else $intro end), name: $name, tool: $tool, repo: $repo,
      index: (if $index == "" then null else ($index | tonumber) end), scenarios: $count}'
}

# The problem the demo is about, from example-demo/scenarios/intro.json; empty when it can't be read.
INTRO="$(jq -r '.problem // empty' "$DEMO/scenarios/intro.json" 2>/dev/null || true)"

# The scenario's card from its about.json, compact; null when it has none.
scenario_about() { # scenario
  local f
  f="$HERE/../$(tool_tree "$(scenario_tool "$1")")/scenarios/$1/about.json"
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
  (cd "$HERE/.." && DEMO_RUNS_FORGE_URL="$URL" DEMO_RUNS_TOKEN="$TOKEN" DEMO_RUNS_REPOS="$(loop_repos)" \
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
  curl -fsS "$FLOCI/$STATE_BUCKET/$(root_key "$1")" 2>/dev/null \
    | jq -r --arg n "$2" '[.resources[]? | select(.mode == "managed" and .name == $n) | .instances[]?.attributes.input | if type == "object" then .value else . end][0] // "nothing" | tostring' 2>/dev/null \
    || echo nothing
}

# A terraform_data's id in the root's state: the value terraform_data picks
# when it creates the resource, unknown to any plan before that.
state_id() { # root, resource name
  curl -fsS "$FLOCI/$STATE_BUCKET/$(root_key "$1")" 2>/dev/null \
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
    tg-planned-outputs) echo "A new unit planned on real values, not stand-ins" ;;
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
    tg-planned-outputs) echo "a new unit and its reader" ;;
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
    tg-planned-outputs:pull-request) echo "Pull request $PULL is open. It adds two units. Ledger sets up a storage bucket, and billing reads the bucket's name." ;;
    tg-planned-outputs:planned) echo "The plan is posted on the pull request. It names ledger's bucket $(tg_value ledger), and billing will keep its invoices there. The stand-in name, $(tg_mock), was never used. Network and app have no change." ;;
    tg-planned-outputs:applying) echo "Wave 1 builds ledger's bucket. Wave 2 then plans billing again on the name ledger now has." ;;
    tg-planned-outputs:applied)
      if [ "$TG_COMPARED" = matched ]; then
        echo "Done. Wave 2 compared its new plan for billing with the one pull request $PULL showed, and they matched, so it applied. Billing records invoices in $(state_input live/ledger this)."
      else
        echo "Done. Wave 2 compared its new plan for billing with the one pull request $PULL showed, and its log names each difference before the apply: $TG_COMPARED. Billing records invoices in $(state_input live/ledger this)."
      fi ;;
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
  overlay "$TREE/scenarios/$SCENARIO/pull" "$tree"
  # A pull request that adds units writes their pipeline as an author would: terragucci init.
  if [ -n "$INIT_PULL" ]; then
    (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || fail "terragucci init failed on the $SCENARIO pull request"
  fi
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
  overlay "$TREE/scenarios/stale-plan/push" "$tree"
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

# 7: Terragrunt's planned outputs. The pull request adds ledger and billing,
# which reads ledger's output through a dependency block whose mock_outputs
# Terragrunt would hand billing while ledger has no state. The plan job plans
# billing on the outputs ledger's plan makes instead (tg-preview.ts), and a
# plan that would read the mock is refused; the driver checks the plan run
# says billing planned on ledger's planned outputs. On main, wave 1 applies
# ledger, and wave 2 plans billing on what ledger applied and compares that
# plan with the one the pull request's note carries before its gate decides
# (tg-preview-gate.ts). Nothing is destroyed, so no wave waits under gate:
# on-destructive; the comparison is in wave 2's log, and the driver reads it
# into the applied label. A wave 2 that compared nothing stalls the cycle.
TG_READER=live/billing TG_UPSTREAM=live/ledger TG_COMPARED="" MERGE_RUN=""

# A value a unit of the scenario's pull request sets, or the mock billing names, from the files.
tg_value() { # unit name
  sed -n 's/^[[:space:]]*value[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TREE/scenarios/tg-planned-outputs/pull/live/$1/terragrunt.hcl" | tail -1
}
tg_mock() {
  awk '/mock_outputs[[:space:]]*=/ { m = 1 } m && /value[[:space:]]*=/ { sub(/^[^"]*"/, ""); sub(/".*/, ""); print; exit }' \
    "$TREE/scenarios/tg-planned-outputs/pull/live/billing/terragrunt.hcl"
}

tg_planned() {
  run_logs "$REPO" "$RUN_ID" 2>/dev/null | grep -qF "$TG_READER: plans on the planned outputs of $TG_UPSTREAM" \
    || fail "the pull request's plan did not plan $TG_READER on the planned outputs of $TG_UPSTREAM ($RUN_URL)"
}

# What wave 2 of the merge's run said when it compared billing's plan with the
# pull request's preview: matched, or the first difference it named.
tg_compared() {
  local logs
  logs="$(run_logs "$REPO" "$MERGE_RUN" 2>/dev/null || true)"
  if grep -qF "$TG_READER plans as pull request $PULL previewed it" <<<"$logs"; then
    TG_COMPARED=matched
  elif grep -qF "plans differently now:" <<<"$logs"; then
    TG_COMPARED="$(grep -F ":   $TG_READER: " <<<"$logs" | head -1 | sed "s#^.*:   $TG_READER: #$TG_READER: #")"
    [ -n "$TG_COMPARED" ] || TG_COMPARED="$TG_READER plans differently"
  else
    fail "wave 2 did not compare its plan of $TG_READER with pull request $PULL's ($RUN_URL)"
  fi
}

scenario_tg_planned_outputs() {
  open_pull
  tg_planned
  demo_hold planned "$(say planned)" "merge pull request $PULL"
  merge_pull
  MERGE_RUN="$RUN_ID"
  follow
  [ "$OUTCOME" != applied ] || tg_compared
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
    tg-planned-outputs) scenario_tg_planned_outputs ;;
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

# Every root's state back to the base snapshot, and the states of the roots
# only a scenario adds deleted. A composed run (scenario 6) that stopped part
# way may leave its lock on a state, or a state it could not write kept beside
# it, which the next composed run would write before it plans
# (packages/terragucci/src/compose.ts); a Terragrunt unit's lock is the same
# file. No run is in progress here (quiet, or up before its push), so none
# belongs to a live run. With "missing-ok", a root with no snapshot is skipped.
states_back() { # [missing-ok]
  local root key
  for root in "${ROOTS[@]}"; do
    key="$(root_key "$root")"
    if [ -f "$(snapshot "$root")" ]; then
      curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @"$(snapshot "$root")" \
        "$FLOCI/$STATE_BUCKET/$key" || fail "could not write $root's base state back"
    elif [ -z "${1:-}" ]; then
      fail "$root has no base state in $RSTATE/base; run 'just demo up' again"
    fi
  done
  while read -r root key; do
    [ -n "$key" ] || continue
    curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$key" || true
  done <<<"$EXTRA_KEYS"
  while read -r root key; do
    [ -n "$key" ] || continue
    curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$key.tflock" || true
    curl -sS -o /dev/null -X DELETE "$FLOCI/$STATE_BUCKET/$key.terragucci-unwritten" || true
  done <<<"$BASE_KEYS"$'\n'"$EXTRA_KEYS"
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
  local base n before
  base="$(cat "$RSTATE/base.sha")"
  HELD=""
  quiet
  for n in $(api "$URL/api/v1/repos/$REPO/pulls?state=open&limit=50" | jq -r '.[].number'); do
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$n" || true
  done
  states_back
  marker_clear
  if [ "$(remote_head "$REPO" main)" != "$base" ]; then
    before="$(last_run_id)"
    git -C "$RSTATE/base-tree" push -q --force "$REMOTE" "$base:refs/heads/main" 2>/dev/null || fail "could not force main back to ${base:0:8}"
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
  base="$(cat "$RSTATE/base.sha")"
  PULL="" COMMIT="$base"
  demo_write reset "Outside the pipeline, the driver resets every state to how it started. It also moves main back to ${base:0:8} for the next scenario." "start the next cycle"
  cycle_publish
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

# The base of the repo use_repo points at: its tree less its scenarios, the
# pipeline init writes, and the reviewer's key in .chant/allowed_signers. It is
# the commit every reset forces main back to. The admin pushes it, out of band:
# no wave judges it as a change, because each wave's rule is read at the commit
# before the one it applies, and the base is never in the range after it.
up_repo() {
  local sha root
  if ! api -o /dev/null "$URL/api/v1/repos/$REPO" 2>/dev/null; then
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg n "${REPO#*/}" --arg d "$(repo_description)" '{name: $n, description: $d, private: false, auto_init: false, default_branch: "main"}')" \
      "$URL/api/v1/user/repos"
  fi
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$REPO"
  people_join
  rm -rf "$RSTATE/base-tree"
  mkdir -p "$RSTATE/base-tree"
  (cd "$TREE" && tar cf - --exclude ./scenarios .) | (cd "$RSTATE/base-tree" && tar xf -)
  (cd "$RSTATE/base-tree" && "$TERRAGUCCI" init >/dev/null) || fail "terragucci init failed on $(tool_tree "$TOOL")"
  mkdir -p "$RSTATE/base-tree/.chant"
  echo "$REVIEWER $(cut -d' ' -f1,2 "$REVIEWER_KEY.pub")" > "$RSTATE/base-tree/.chant/allowed_signers"
  # floci may still hold the states of a cycle the driver left part way (a
  # restart after the checkout moved): writing the last base snapshot back
  # first, as the reset does, leaves the base's pipeline nothing to destroy,
  # which gate: on-destructive would otherwise hold for an approval.
  if [ -d "$RSTATE/base" ]; then
    states_back missing-ok
    marker_clear
    log "wrote the last base snapshot of $REPO back to floci before pushing the base"
  fi
  sha="$(push_tree "$RSTATE/base-tree" "$REPO" main "The demo's base: $(roots_words)")"
  log "pushed the base to $REPO's main at ${sha:0:8}; the pipeline applies every root…"
  wait_run "$REPO" "$sha"
  if [ "$RUN_STATUS" != success ]; then
    print_logs "$REPO" "$RUN_ID"
    fail "the base's pipeline on $REPO ended '$RUN_STATUS'"
  fi
  mkdir -p "$RSTATE/base"
  for root in "${ROOTS[@]}"; do
    curl -fsS -o "$(snapshot "$root")" "$FLOCI/$STATE_BUCKET/$(root_key "$root")" || fail "$root has no state in floci after the base applied"
  done
  echo "$sha" > "$RSTATE/base.sha"
  COMMIT="$sha"
  runs_mark base
  demo_write reset "$(base_label)" "start the first cycle"
}

repo_description() {
  case "$TOOL" in
    terraform) echo "The terragucci demo: four roots of terraform_data, a change across their states" ;;
    *) echo "The terragucci demo on $TOOL: units of terraform_data, a change across their states" ;;
  esac
}

# "network, app, edge and other": the base's roots, by their last path part.
roots_words() {
  local r out=()
  for r in "${ROOTS[@]}"; do out+=("${r##*/}"); done
  printf '%s, ' "${out[@]}" | sed -E 's/, $//; s/, ([^,]*)$/ and \1/'
}

base_label() {
  case "$TOOL" in
    terraform) echo "The base is applied: $(applied_values), and other" ;;
    *) echo "The base is applied. Its units, $(roots_words), each have a state of their own." ;;
  esac
}

# A loop's repo is ready: it has a base, and the base names the reviewer.
loop_ready() {
  [ -f "$RSTATE/base.sha" ] || fail "no base snapshot of $REPO; run 'just demo up' first"
  # A base pushed before the driver played two people names the driver's key
  # in .chant/allowed_signers, so the reviewer's seal would not verify.
  git -C "$RSTATE/base-tree" show "$(cat "$RSTATE/base.sha"):.chant/allowed_signers" 2>/dev/null | grep -q "^$REVIEWER " \
    || fail "the base of $REPO: .chant/allowed_signers does not name $REVIEWER; run 'just demo up' again"
  people_join
}

case "$CMD" in
  up)
    started=$(now)
    for b in "$REPORT_BUCKET" "$CONTROL_BUCKET"; do curl -fsS -o /dev/null -X PUT "$FLOCI/$b" || true; done
    marker_clear
    LOOP_TOOLS=()
    for t in "${TOOLS[@]}"; do if tool_present "$t"; then LOOP_TOOLS+=("$t"); fi; done
    [ -f "$DEMO_STATE/cycle" ] || echo 0 > "$DEMO_STATE/cycle"
    CYCLE="$(cat "$DEMO_STATE/cycle")" SCENARIO=base TITLE="The base" ABOUT=null STARTED="$started"
    timeline_start
    : > "$WORK/ready"
    for t in "${LOOP_TOOLS[@]}"; do
      use_repo "$t"
      curl -fsS -o /dev/null -X PUT "$FLOCI/$STATE_BUCKET" || true
      up_repo
      printf '  %-12s %s/%s\n  %-12s %s\n' "$TOOL" "$URL" "$REPO" "" "$RUN_URL" >> "$WORK/ready"
    done
    log "ready in $(( $(now) - started ))s"
    cat <<OUT

  The demo's bases are applied.

$(cat "$WORK/ready")

  demo.json    $FLOCI/$REPORT_BUCKET/$REPORT_PREFIX/demo.json

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
    # No scenario named: DEMO_SCENARIOS, checked like the arguments, or the default list.
    if [ "${#list[@]}" -eq 0 ] && [ -n "${DEMO_SCENARIOS:-}" ]; then
      read -r -a named <<<"$DEMO_SCENARIOS"
      for a in ${named[@]+"${named[@]}"}; do
        scenario_title "$a" >/dev/null || fail "unknown scenario '$a' in DEMO_SCENARIOS (${ALL_SCENARIOS[*]})"
        list+=("$a")
      done
    fi
    [ "${#list[@]}" -gt 0 ] || list=("${SCENARIOS[@]}")
    COUNT="${#list[@]}"
    # The tools the list's scenarios run on, each once, in the order they first come.
    LOOP_TOOLS=()
    for a in "${list[@]}"; do
      t="$(scenario_tool "$a")"
      case " ${LOOP_TOOLS[*]-} " in *" $t "*) ;; *) LOOP_TOOLS+=("$t") ;; esac
    done
    for t in "${LOOP_TOOLS[@]}"; do use_repo "$t"; loop_ready; done
    echo "$$" > "$DEMO_STATE/driver.pid"
    # An earlier driver's background copy is not this one's to wait on.
    mkdir -p "$RUNS_STATE" && : > "$RUNS_PID"
    CYCLE="$(cat "$DEMO_STATE/cycle" 2>/dev/null || echo 0)"
    SCENARIO=base TITLE="The base" ABOUT=null STARTED="$(now)" INDEX=""
    # A driver the watchdog restarted may have left a cycle half done, in any of the loop's repos.
    for t in "${LOOP_TOOLS[@]}"; do
      use_repo "$t"
      timeline_start
      attempt reset_base
      [ "$ATTEMPT" = 0 ] || demo_stalled
    done
    while :; do
      INDEX=0
      for s in "${list[@]}"; do
        INDEX=$((INDEX + 1))
        CYCLE=$((CYCLE + 1))
        echo "$CYCLE" > "$DEMO_STATE/cycle"
        : > "$DEMO_STATE/reason"
        use_repo "$(scenario_tool "$s")"
        SCENARIO="$s" TITLE="$(scenario_title "$s")" ABOUT="$(scenario_about "$s")" STARTED="$(now)" PULL="" COMMIT="" OUTCOME=""
        timeline_start
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
