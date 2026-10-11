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
# records as text what the pages the step points at show: a plan note or a
# reply as its Markdown and Forgejo's rendering of it, a job's log, a diff, a
# report page's HTML, or a list Forgejo shows as a table. It writes:
#
#   docs-site/src/data/tutorial/<step>.json      commands, output, exit codes,
#                                                the example's hash, and the
#                                                step's views
#   docs-site/src/data/tutorial/manifest.json    date, commit and versions
#
# A step whose output and views are what is committed keeps its file; any
# other difference rewrites it. Only the steps that ran are written, so one
# step's capture never touches another step's file.
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
#
# It runs on the capture stack (TG_STACK=capture, stack/instance.sh): its own
# Forgejo, runner and floci, on host ports 100 up, with a stack lock of its
# own, so a capture never makes the smoke claims wait. TG_STACK=shared
# captures on the shared stack instead, holding its lock as before. Output
# naming the capture stack's host ports is written with the shared stack's
# (localhost:3400 as localhost:3300), the ones the tutorial tells a reader.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A person starts a capture (stack/human-gate.sh); --list reads the steps only.
[ "${1:-}" = --list ] || { . "$HERE/human-gate.sh"; human_gate "the tutorial captures on the capture stack, for half an hour or more" capture; }
export TG_STACK="${TG_STACK:-capture}"
# shellcheck source=instance.sh
. "$HERE/instance.sh"
ROOT="$(cd "$HERE/.." && pwd)"
EXAMPLE="$ROOT/example"
DATA="$ROOT/docs-site/src/data/tutorial"
SMOKE="$ROOT/docs-site/src/data/smoke.json"

log()  { echo "[capture] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# step|needs|claims|views|what a reader sees
STEPS='boot|fresh|boot|repo run|just example up; the repo in Forgejo and the first run'"'"'s jobs
first-pr|chain|check|note files|just example change one-root; the pull request'"'"'s plan note, and its one-line diff
check|chain|check|pull log|just example change unformatted and just example logs; the failed check job'"'"'s log, found from the branch'"'"'s head
one-note|chain|affected grouped highlight|note|just example change module-bump; the plan note for 12 roots, 11 in one group and prod payments apart (the pull request is closed afterwards)
wave-waiting|chain|waves sealed|note log|just example change destroy and merge destroy; the destroy pull request'"'"'s note, and wave 4'"'"'s job log with exit 3 and the approve command
wave-refused|chain|waves sealed refuse|log|just example approve, change module-bump, merge module-bump; wave 4'"'"'s job log with both digests and the roots that moved
approved|chain|sealed comment-apply wave-report|record reply log|just example approve of the plans wave 4 refused, then /terragucci apply on the merged module bump; the approval'"'"'s commit on chant/lifecycle, the reply linking the run, and wave 4'"'"'s job log applying
pin|chain|publish rollout|pull files|just example change pin; the rollout'"'"'s wave 1 pull request and its ref bumps
report|booted|report highlight|top root plan index|four tf-plan runs of the example with reports.bucket on floci; the report.html of the module bump with a destroy beside it, from its destroys through its groups, one root'"'"'s row, that root'"'"'s plan.txt, and the project'"'"'s report index
drift|booted|drift|issue|just example change drift, then the drift job dispatched; the drift issue (the example is reset afterwards)
see-runs|booted|dash-pipeline dash-changes dash-waves dash-drift dash-estate dash-runs dash-slos||just see-runs; three runs of the example sent to the observability profile, which fill the dashboards the page describes
trace|booted|traces||a tf-plan of the one-root change with telemetry on, sent to the observability profile; the trace id its report names, and Tempo holding that trace'"'"'s spans
responses|booted|respond-drift respond-fmt|drift drift-files fmt|the respond-drift and respond-fmt claims; the drift pull request with the live value and an import, its files, and the fmt commit on a pull request'"'"'s branch
tips|booted|tips respond-tips|note report fix|just example change float, a tf-plan of it with reports.bucket on floci, and the respond-tips claim; the plan note'"'"'s tip line, the report'"'"'s Tips section, and the files of the pull request one tip opens (the pull request is closed afterwards)
policy|booted|policy check-diagnostics|note log|a pull request on the example that adds a policy denying dev orders'"'"' change, and the check-diagnostics claim; the plan note naming the denial, and the check job'"'"'s log naming the failing policy test (the pull request is closed afterwards)
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
    printf '%s\n  needs     %s\n  claims    %s\n  writes    data/tutorial/%s.json\n' "$step" "$needs" "$claims" "$step"
    [ -z "$views" ] || printf '  views     %s\n' "$views"
    printf '  shows     %s\n' "$what"
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

mkdir -p "$DATA"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-capture.XXXXXX")"
# shellcheck source=mounted.sh
. "$HERE/mounted.sh"
# The step running now: a capture that stops early says which step stopped it.
STEP=""
# shellcheck source=locks.sh
. "$HERE/locks.sh"
trap 'rc=$?; release_mine; [ "$rc" = 0 ] || [ -z "$STEP" ] || log "FAIL: the $STEP step stopped the capture (exit $rc)"; drop_work "$STAGE"' EXIT
# The capture boots, resets and drives the stack's example, so it holds the
# whole stack alone, as stack/smoke.sh's claims hold their parts: on the
# capture stack that waits only for another capture; on the shared stack it
# waits for the claims running from any worktree, and claims started after it
# wait for it. The claims it runs itself (claim_run) take their locks in a
# directory of their own, under its hold.
log "waiting for the $TG_STACK stack to itself (the stack lock in $SMOKE_LOCKS)"
hold_locks "$$.capture" "stack!"
export SMOKE_LOCK_DIR="$STAGE/locks"

# The example's pipeline runs terragucci from the published CI image its pins
# name, not from this tree. A pipeline that calls a command the image does
# not have yet (plan-note, before 0.4.4) fails that job on every pull request,
# and every recorded plan note would be missing from its pull request. So
# the capture checks the image first.
pipeline_commands_known() {
  local wf="$EXAMPLE/.forgejo/workflows/terragucci.yml" image tree have missing="" c
  image="$(grep -oE 'ghcr.io/intentius/terragucci-tofu:[^ "'"'"',]*@sha256:[0-9a-f]+' "$wf" | head -1)"
  [ -n "$image" ] || return 0
  (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
  tree="$(node "$ROOT/packages/terragucci/dist/terragucci.mjs" --help 2>&1 | awk '/^  terragucci [a-z]/ { print $2 }' | sort -u)"
  have="$(docker run --rm --entrypoint terragucci "$image" --help 2>&1 | awk '/^  terragucci [a-z]/ { print $2 }' | sort -u)"
  for c in $(grep -oE '(^|[^a-z/-])terragucci [a-z][a-z-]+' "$wf" | awk '{ print $2 }' | sort -u); do
    grep -qx "$c" <<<"$tree" || continue
    grep -qx "$c" <<<"$have" || missing="$missing $c"
  done
  [ -z "$missing" ] || fail "the example's pipeline runs terragucci$missing, which its image $image does not have: publish a release with them, or pin images that have them, before capturing"
  log "the pipeline's image $image has every command the pipeline runs"
}
pipeline_commands_known

# The example's hash: every file under example/, path and content, with the
# pipeline's image references left out (a release moves them, and no capture
# shows them). A capture older than the example it came from fails
# `just tutorial-check`, which computes it (`--hash`).
SOURCE_HASH="$(cd "$ROOT" && node scripts/tutorial-check.mjs --hash)"

claims_pass() { # claim...
  local c
  for c in "$@"; do
    [ "$(jq -r --arg c "$c" '.claims[] | select(.claim == $c and (.forge // "forgejo") == "forgejo" and (.binary // "tofu") == "tofu") | .verdict' "$SMOKE")" = pass ] || return 1
  done
}

# The capture stack's host ports, written as the shared stack's: a reader's
# stack listens where the tutorial says.
PORT_SED=()
for pair in FORGEJO:3300 FLOCI:4580 GRAFANA:3310 PROMETHEUS:9190 TEMPO:3210 OTLP:4328 FOUNTAIN:4010 REGISTRY:5050; do
  var="TERRAGUCCI_${pair%%:*}_PORT"; want="${pair#*:}"
  [ "${!var:-$want}" = "$want" ] || PORT_SED+=(-e "s/localhost:${!var}([^0-9]|\$)/localhost:$want\1/g")
done

# Output a reader would see, with what changes run to run made stable.
normalize() {
  sed -E ${PORT_SED[@]+"${PORT_SED[@]}"} \
    -e 's/ready in [0-9]+s/ready in 90s/' \
    -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
    -e 's/\x1b\[[0-9;]*m//g' \
    -e '/wiping floci and the example repo/d'
}

# A replayed step runs its commands to put the example where the next step
# expects it, but records no view and writes nothing.
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

# A step's views are staged in $STAGE/<step>.views, one JSON object keyed by
# view, in the shapes docs-site reads (kind markdown, log, diff, html or
# table). A recorder that cannot fetch what its view shows, or finds the
# page without the line or element the view is about, logs why and records
# nothing: commit_step then finds the view missing, and the step is not
# written. Under $REPLAY a recorder does nothing.
record() { # step, view; the view's JSON on stdin
  local views="$STAGE/$1.views"
  cat > "$STAGE/view.json"
  [ -f "$views" ] || printf '{}\n' > "$views"
  jq --arg v "$2" --slurpfile j "$STAGE/view.json" '. + {($v): $j[0]}' "$views" > "$views.new"
  mv "$views.new" "$views"
  log "recorded $1-$2"
}
unrecorded() { log "FAIL: $1-$2: $3"; }

# Text with what changes run to run made stable, as one JSON string without
# its last newline.
json_text() { normalize | jq -Rs 'sub("\n+$"; "")'; }

# Markdown as Forgejo renders it on a page of the repo: the body as written,
# and the HTML of Forgejo's POST /api/v1/markdown in gfm mode, with links
# Forgejo builds from its in-network address made the ones a reader opens.
markdown_view() { # step, view, repo; the Markdown on stdin
  local step="$1" view="$2" repo="$3"
  cat > "$STAGE/md.src"
  [ -s "$STAGE/md.src" ] || { unrecorded "$step" "$view" "the Markdown is empty"; return 0; }
  jq -n --rawfile t "$STAGE/md.src" --arg c "$repo" '{Text: $t, Mode: "gfm", Context: $c}' > "$STAGE/md.req"
  api -H 'content-type: application/json' -X POST --data-binary @"$STAGE/md.req" -o "$STAGE/md.html" "$URL/api/v1/markdown" \
    || { unrecorded "$step" "$view" "Forgejo did not render its Markdown"; return 0; }
  jq -n --argjson s "$(json_text < "$STAGE/md.src")" \
    --argjson h "$(sed "s#http://forgejo:3000#$URL#g" "$STAGE/md.html" | json_text)" \
    '{kind: "markdown", source: $s, html: $h}' | record "$step" "$view"
}

# The description of a pull request or an issue: its first comment.
body_view() { # step, view, repo, pull request or issue number
  local step="$1" view="$2" repo="$3" body
  [ -z "$REPLAY" ] || return 0
  body="$(api "$URL/api/v1/repos/$repo/issues/$4" | jq -r '.body // empty')" || true
  [ -n "$body" ] || { unrecorded "$step" "$view" "$repo#$4 has no description"; return 0; }
  printf '%s\n' "$body" | markdown_view "$step" "$view" "$repo"
}

# A pull request's or a commit's files as a unified diff, from Forgejo's API
# (pulls/<n>.diff, git/commits/<sha>.diff), which takes the token on a
# private repo as the web routes do not.
diff_view() { # step, view, repo, pulls/<n> or git/commits/<sha>
  local step="$1" view="$2" diff
  [ -z "$REPLAY" ] || return 0
  diff="$(api "$URL/api/v1/repos/$3/$4.diff")" || true
  [ -n "$diff" ] || { unrecorded "$step" "$view" "$3 $4 has no diff"; return 0; }
  printf '%s\n' "$diff" | json_text | jq '{kind: "diff", text: .}' | record "$step" "$view"
}

# A list Forgejo shows as a widget, as a table: the columns, and the rows as
# a JSON array of arrays (empty when the list could not be read).
table_view() { # step, view, columns (JSON array), rows (JSON array)
  local step="$1" view="$2" rows
  [ -z "$REPLAY" ] || return 0
  rows="$(normalize <<<"${4:-}" | jq -c 'if type == "array" then . else [] end' 2>/dev/null)" || true
  [ "$(jq length <<<"${rows:-[]}")" -gt 0 ] || { unrecorded "$step" "$view" "the list is empty"; return 0; }
  jq -n --argjson c "$3" --argjson r "$rows" '{kind: "table", columns: $c, rows: $r}' | record "$step" "$view"
}

# A page floci serves (a report, an index), as served. The site shows it in
# a sandboxed frame, opened at the anchor when one is given, which the page
# must have.
html_view() { # step, view, url, [anchor (an element id)]
  local step="$1" view="$2" url="$3" anchor="${4:-}" page
  [ -z "$REPLAY" ] || return 0
  page="$(fetch "$url")" || true
  [ -n "$page" ] || { unrecorded "$step" "$view" "no page at $url"; return 0; }
  if [ -n "$anchor" ] && ! grep -qF "id=\"$anchor\"" <<<"$page"; then
    unrecorded "$step" "$view" "$url has no element #$anchor"; return 0
  fi
  printf '%s\n' "$page" | json_text | jq --arg a "$anchor" '{kind: "html", html: .} + (if $a != "" then {anchor: $a} else {} end)' \
    | record "$step" "$view"
}

# A text file floci serves (a root's plan.txt), as a log.
text_view() { # step, view, url
  local step="$1" view="$2" text
  [ -z "$REPLAY" ] || return 0
  text="$(fetch "$3")" || true
  [ -n "$text" ] || { unrecorded "$step" "$view" "nothing at $3"; return 0; }
  printf '%s\n' "$text" | json_text | jq '{kind: "log", text: .}' | record "$step" "$view"
}

# The part of a job's log a reader is shown: from the first line matching
# the start (or the focus line, without one) through the first line after it
# matching the last line, or without one through the line act ends a failed
# step with ("exitcode"), or the log's end. The focus line must be in the
# log. The runner's own lines are left out and Forgejo's group markers
# stripped, as stack/example.sh logs does. Forgejo's raw log carries no step
# boundaries, so the step to open names the step in a message only.
log_section() { # focus, last, start (regexes; last and start may be empty)
  awk -v focus="$1" -v last="$2" -v from="$3" '
    /^(::endgroup::|##\[endgroup\])/ { next }
    { sub(/^(::group::|##\[group\])/, "") }
    /exitcode/ { line[++n] = $0; next }
    /^(⚙|⭐|🐳|🏁|☁|  ✅|  ❌)/ { next }
    { line[++n] = $0 }
    END {
      for (i = 1; i <= n; i++) if (line[i] ~ focus) { seen = 1; break }
      if (!seen) exit 1
      for (i = 1; i <= n; i++) if (line[i] ~ (from != "" ? from : focus)) { start = i; break }
      if (!start) exit 1
      for (i = start; i <= n; i++) if (last != "" ? line[i] ~ last : line[i] ~ /exitcode/) { end = i; break }
      if (!end) { if (last != "") exit 1; end = n }
      for (i = start; i <= end; i++) print line[i]
    }'
}

# A job's log, from its raw log (job_logs gives the URL), cut to the lines
# the page shows.
job_log() { # step, view, job's raw log URL, job step it is about, a log line in it (regex), [last line (regex)], [first line (regex)]
  local step="$1" view="$2" url="$3" open="$4" focus="$5" last="${6:-}" from="${7:-}" raw text
  [ -z "$REPLAY" ] || return 0
  raw="$(api "$url")" || true
  [ -n "$raw" ] || { unrecorded "$step" "$view" "no log at $url"; return 0; }
  text="$(normalize <<<"$raw" | log_section "$focus" "$last" "$from")" \
    || { unrecorded "$step" "$view" "the log at $url has no line of the $open step matching '$focus', or none after it matching '${last:-exitcode}'"; return 0; }
  printf '%s\n' "$text" | json_text | jq '{kind: "log", text: .}' | record "$step" "$view"
}

# A step's precondition failed: the step writes nothing, and the capture fails.
refuse() { # step, why
  log "FAIL: $1: $2; its views would not show what the page says, so it is not written"
  REFUSED="$REFUSED $1"
}
REFUSED=""

# Write a step's file when its output or any of its views differs from what
# is committed.
#
# A step that did not record every view it should have (a view in the STEPS
# table that a recorder could not fetch, because a page was not found)
# writes nothing: its JSON would claim a capture its views do not back. The
# step is listed and the capture fails at the end.
INCOMPLETE=""
commit_step() { # step
  local step="$1"
  local new="$STAGE/$step.json" old="$DATA/$step.json" views="$STAGE/$step.views" v missing=""
  case " $REFUSED " in *" $step "*) INCOMPLETE="$INCOMPLETE $step"; return ;; esac
  [ -f "$views" ] || printf '{}\n' > "$views"
  for v in $(field "$step" 4); do
    jq -e --arg v "$v" 'has($v)' "$views" >/dev/null || missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    log "$step: not written, it recorded no view for:$missing"
    INCOMPLETE="$INCOMPLETE $step"
    return
  fi
  touch "$STAGE/$step.cmds"
  jq -s --arg s "$step" --arg h "$SOURCE_HASH" --slurpfile views "$views" \
    '{step: $s, source_hash: $h, commands: .} + (if ($views[0] | length) > 0 then {views: $views[0]} else {} end)' \
    "$STAGE/$step.cmds" > "$new"
  if [ -f "$old" ] && [ "$(jq -S . "$old")" = "$(jq -S . "$new")" ]; then
    log "$step: unchanged, file kept"
    return
  fi
  cp "$new" "$old"
  CHANGED=1
  log "$step: written"
}

CHANGED=0

# The stack's Forgejo: URL, TOKEN, USER, api and REPO.
forge() {
  # shellcheck disable=SC1091
  . "${TG_STATE:-$HERE/.state}/forgejo.env"
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  # lib.sh's api, made to say which step's request failed and its URL.
  eval "lib_api() $(declare -f api | tail -n +2)"
  api() { lib_api "$@" || { local rc=$?; log "${STEP:-capture}: ${*: -1} failed (curl exit $rc)"; return "$rc"; }; }
  REPO="$USER/example"
}

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

# The raw log of the first job in a run that matches a jq condition, as a
# URL. Forgejo 16.0.5 (stack/docker-compose.yml) serves a job's plain log at
# the API's /repos/<repo>/actions/jobs/<job id>/logs, the route stack/lib.sh
# and stack/example.sh read: it takes the token, so a private repo's log is
# read as a public one's, and it names the job by id. The web route
# <repo>/actions/runs/<run>/jobs/<job>/attempt/<n>/logs serves the same file
# but needs a signed-in session on a private repo.
job_logs() { # run json, jq condition on a job
  local run="$1" cond="$2" id
  [ -n "$run" ] || return 0
  id="$(api "$URL/api/v1/repos/$REPO/actions/runs/$(jq -r .id <<<"$run")/jobs" \
    | jq -r "sort_by(.id) | map(select($cond)) | .[0].id // empty")"
  if [ -n "$id" ]; then echo "$URL/api/v1/repos/$REPO/actions/jobs/$id/logs"; fi
}

# A pull request's plan note, its Markdown; nothing when it has none.
note_body() { # pull request number, [repo]
  api "$URL/api/v1/repos/${2:-$REPO}/issues/$1/comments" \
    | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty'
}

# Is a pull request's note there to be recorded? Its head's pull_request run has
# finished, its plan-note job passed (it posts the note and terragucci/plan),
# and the note is on the pull request. Says why not, and returns 1.
note_ready() { # pull request number, [repo]
  local repo="${2:-$REPO}" sha run jobs
  sha="$(api "$URL/api/v1/repos/$repo/pulls/$1" | jq -r '.head.sha // empty')"
  [ -n "$sha" ] || { log "pull request $1 on $repo has no head"; return 1; }
  wait_run "$repo" "$sha" pull_request || return 1
  # A failed plan marks the run failed before plan-note, which runs after it
  # either way, has finished: wait for plan-note itself.
  local deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} ))
  while :; do
    jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -c '[.[] | {name, status}]')"
    case "$(jq -r '.[] | select(.name == "plan-note") | .status' <<<"$jobs")" in
      success|failure|cancelled|skipped|"") break ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 3
  done
  if [ "$(jq -r '.[] | select(.name == "plan-note") | .status' <<<"$jobs")" != success ]; then
    log "pull request $1's run $RUN_INDEX: plan-note did not pass ($jobs); open $RUN_URL"
    return 1
  fi
  [ -n "$(note_body "$1" "$repo")" ] || { log "pull request $1 on $repo has no plan note"; return 1; }
}

# The run a scenario printed, as example.sh prints it: "run N for <sha>
# (<event>): <status> (<url>)". Its status, so a step checks that the run it
# shows ended as the page says.
run_status() { # event
  sed -n "s/^\[example\] run [0-9]* for [0-9a-f]* ($1): \([a-z]*\) .*/\1/p" "$STAGE/last.out" | tail -1
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

# One reply of terragucci's on a pull request, the first comment whose text
# matches; with a last regex, the comments from that one through the last
# later comment matching it, a horizontal rule between each two.
reply_view() { # step, view, repo, pull request number, regex, [last (regex)]
  local step="$1" view="$2" repo="$3" text
  [ -z "$REPLAY" ] || return 0
  text="$(api "$URL/api/v1/repos/$repo/issues/$4/comments" | jq -r --arg m "$5" --arg t "${6:-}" '
    [.[].body // ""] as $b
    | ([range($b | length) | select($b[.] | test($m))] | first) as $i
    | if $i == null then empty
      elif $t == "" then $b[$i]
      else ([range($i; $b | length) | select($b[.] | test($t))] | last // $i) as $j | $b[$i:$j + 1] | join("\n\n---\n\n")
      end')" || true
  [ -n "$text" ] || { unrecorded "$step" "$view" "no comment on $repo#$4 matches '$5'"; return 0; }
  printf '%s\n' "$text" | markdown_view "$step" "$view" "$repo"
}

# ── the steps ──────────────────────────────────────────────────────────────

step_boot() {
  # A reader's first boot starts from nothing, so the example does too: its
  # repo is made afresh and floci wiped, as the smoke claims' settle does. The
  # stack itself stays up: other worktrees drive the same Forgejo with tokens
  # of their own, so tearing it down (stack/down.sh) would break every one of
  # them after this capture lets go of the stack lock.
  run_cmd boot "just example up" "$HERE/example.sh" up --fresh
  forge
  [ -z "$REPLAY" ] || return 0
  local rows run
  # The repo's top-level files, as its page lists them.
  rows="$(api "$URL/api/v1/repos/$REPO/contents" | jq -c 'map([.name, .type])')" || true
  table_view boot repo '["Name", "Type"]' "$rows"
  # The first run's jobs, in the order Forgejo created them (check first).
  run="$(api "$URL/api/v1/repos/$REPO/actions/runs?limit=50" | jq -r '[.workflow_runs[] | select(.index_in_repo == 1)][0].id // empty')" || true
  rows=""
  [ -z "$run" ] || rows="$(api "$URL/api/v1/repos/$REPO/actions/runs/$run/jobs" | jq -c 'sort_by(.id) | map([.name, .status])')" || true
  table_view boot run '["Job", "Status"]' "$rows"
}

step_first_pr() {
  run_cmd first-pr "just example change one-root" "$HERE/example.sh" change one-root
  local pr; pr="$(pr_in_output)"
  [ -n "$pr" ] || { log "first-pr: the output named no pull request"; return; }
  [ "$(run_status pull_request)" = success ] || { refuse first-pr "the pull request's plan run ended '$(run_status pull_request)'"; return 0; }
  note_view first-pr note "$pr"
  diff_view first-pr files "$REPO" "pulls/$pr"
}

step_check() {
  run_cmd check "just example change unformatted" "$HERE/example.sh" change unformatted
  local pr sha logs rows; pr="$(pr_in_output)"
  sha="$(sed -n 's#.*pushed change/unformatted at \([0-9a-f]*\).*#\1#p' "$STAGE/last.out" | head -1)"
  run_cmd check "just example logs" "$HERE/example.sh" logs
  # The fmt job's commit on the branch, after the reader's, in the pull
  # request's commit list: wait until the fmt job has pushed it.
  if [ -n "$pr" ] && [ -z "$REPLAY" ]; then
    local deadline=$(( $(date +%s) + ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} ))
    until [ -z "$sha" ] || [ "$(remote_head "$REPO" change/unformatted)" != "$(api "$URL/api/v1/repos/$REPO/git/commits/$sha" | jq -r '.sha // empty')" ] \
      || [ "$(date +%s)" -ge "$deadline" ]; do sleep 3; done
    # The commits from the reader's through the fmt job's, as the pull
    # request's commit list shows them.
    rows="$(api "$URL/api/v1/repos/$REPO/pulls/$pr/commits" | jq -c '
      map([.commit.author.name, .sha[0:10], (.commit.message | split("\n")[0])]) as $c
      | ([range($c | length) | select($c[.][2] | test("without running"))] | first) as $i
      | ([range($c | length) | select($c[.][2] | test("style: tofu fmt"))] | last) as $j
      | if $i == null or $j == null or $j < $i then [] else $c[$i:$j + 1] end')" || true
    table_view check pull '["Author", "SHA", "Message"]' "$rows"
  fi
  # The check job fails on the commit the scenario pushed, and its "Commit the
  # formatting" step then pushes tofu fmt's fix to the branch. So the branch's
  # head is that later commit, whose check passes: look up the push run on the
  # commit the scenario pushed, and read its failed job's log at the format step.
  logs="$(job_logs "$(push_run "$sha")" '.status == "failure"')"
  if [ -n "$logs" ]; then
    job_log check log "$logs" "Format check" '[.]tf$'
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
    note_view one-note note "$pr"
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$pr" || true
  else
    log "one-note: the output named no pull request"
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO/branches/change%2Fmodule-bump" || true
}

# The example's gate is on-destructive, so only a change that destroys makes a wave
# wait. Merge the destroy scenario as the reader would, and read what waits.
step_wave_waiting() {
  run_cmd wave-waiting "just example change destroy" "$HERE/example.sh" change destroy
  local pr logs; pr="$(pr_in_output)"
  # The note's destroys come first, then the waves table with wave 4 waiting.
  if [ -n "$pr" ]; then note_view wave-waiting note "$pr" 'waits for an approval'; fi
  run_cmd wave-waiting "just example merge destroy" "$HERE/example.sh" merge destroy
  # The run on main's new head: wave 4's job stopped with exit 3.
  logs="$(job_logs "$(run_on main)" '.status == "failure"')"
  if [ -n "$logs" ]; then job_log wave-waiting log "$logs" "Apply wave" "waits for an approval of digest" "terragucci approve wave-"; else log "wave-waiting: no stopped job on main's head"; fi
}

# Approve that wave, then merge a change that moves its plans: it refuses.
step_wave_refused() {
  run_cmd wave-refused "just example approve" "$HERE/example.sh" approve
  run_cmd wave-refused "just example change module-bump" "$HERE/example.sh" change module-bump
  run_cmd wave-refused "just example merge module-bump" "$HERE/example.sh" merge module-bump
  local logs
  logs="$(job_logs "$(run_on main)" '.status == "failure"')"
  if [ -n "$logs" ]; then job_log wave-refused log "$logs" "Apply wave" "changed after it was approved" "planned differently since"; else log "wave-refused: no refused job on main's head"; fi
}

# A reader who read the moved plans approves them, and asks for the apply
# again on the merged pull request. The approval is a commit on
# chant/lifecycle; the comment's apply-comment job resumes at wave 4.
step_approved() {
  run_cmd approved "just example approve" "$HERE/example.sh" approve
  local sha pr run logs
  sha="$(remote_head "$REPO" chant/lifecycle)"
  if [ -n "$sha" ]; then diff_view approved record "$REPO" "git/commits/$sha"; else log "approved: no chant/lifecycle branch"; fi
  pr="$(api "$URL/api/v1/repos/$REPO/pulls?state=closed&limit=50" | jq -r '[.[] | select(.head.ref == "change/module-bump" and .merged)] | max_by(.number) | .number // empty')"
  [ -n "$pr" ] || { log "approved: no merged module-bump pull request"; return 0; }
  run="$(say "$REPO" "$pr" "/terragucci apply")"
  reply_view approved reply "$REPO" "$pr" 'terragucci: applied wave'
  logs="$(job_logs "$run" '.name == "apply-comment"')"
  if [ -n "$logs" ]; then job_log approved log "$logs" "Apply a merged pull request" "approved by" "wave 4 of 4 applied" "wave 4 of 4: set digest"; else log "approved: the comment's run has no apply-comment job"; fi
}

# Publish modules/service and open the first rollout wave. The scenario pins
# the roots first, so it leaves main changed: reset afterwards so the steps
# after this one start from the example as committed.
step_pin() {
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
  run_cmd pin "just example change pin" "$HERE/example.sh" change pin
  local pr; pr="$(pr_in_output)"
  if [ -n "$pr" ]; then
    # The rollout's own run on the pull request first, so its conversation is settled.
    wait_run "$REPO" "$(api "$URL/api/v1/repos/$REPO/pulls/$pr" | jq -r '.head.sha')" pull_request || { refuse pin "the rollout pull request's run did not finish"; return 0; }
    body_view pin pull "$REPO" "$pr"
    diff_view pin files "$REPO" "pulls/$pr"
  else
    log "pin: the output named no pull request"
  fi
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
}

# The report and the bucket's index. Three plans of the example, each run as
# the pipeline's plan job runs it (the tofu CI image, the example's state in
# floci, the change against its base), with reports.bucket naming a floci
# bucket. The pages are served by floci's S3 endpoint, as a bucket served as
# a static site serves them. The module bump with a destroy beside it runs
# last, so it heads the index: its report shows grouping and a destroy named
# on its own (concepts/why-plans-are-grouped).
REPORT_BUCKET=terragucci-reports

# The tofu CI image, in CI_IMAGE, and the CLI bundle it runs, built from this tree.
CI_IMAGE=""
ci_ready() { # step
  CI_IMAGE="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$CI_IMAGE" >/dev/null 2>&1 || fail "$1: no CI image $CI_IMAGE; run 'just images'"
  (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
}

# One tf-plan of a copy of the example with a scenario (or several joined by
# "+", applied in turn), run as the
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
  local patch
  for patch in ${scenario//+/ }; do git -C "$work" apply "$EXAMPLE/changes/$patch.patch"; done
  git -C "$work" add -A
  GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -C "$work" -c user.name=terragucci -c user.email=example@terragucci.local -c commit.gpgsign=false commit -qm "$scenario"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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
  for scenario in one-root destroy module-bump module-bump+destroy; do
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
  [ "$(fetch "$at/report.json" | jq '[.named[]? | select(.action == "delete" or .action == "replace")] | length')" -gt 0 ] \
    || { refuse report "the report at $at names no destroy"; return 0; }
  # The page opens at the destroys, ahead of the groups: what is named, and
  # what is folded.
  html_view report top "$at/report.html" pinned
  html_view report root "$at/report.html" "root-$root"
  if [ -n "$plan" ]; then text_view report plan "$at/$plan"; else refuse report "report.json names no plan for $root"; fi
  html_view report index "$top/$project/index.html"
}

# Drift: delete a queue outside Terraform, start the pipeline's drift job as a
# reader does from the Actions tab, and record the issue it keeps. Reset
# afterwards: the queue comes back and the drift job's pull request closes.
step_drift() {
  run_cmd drift "just example change drift" "$HERE/example.sh" change drift
  local before deadline run status issue
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
    issue="$(api "$URL/api/v1/repos/$REPO/issues?state=open&type=issues&limit=50" \
      | jq -r '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))][0].number // empty')"
    [ "$status" = success ] || refuse drift "the drift run ended '${status:-unknown}'"
    if [ -n "$issue" ]; then body_view drift issue "$REPO" "$issue"; else log "drift: no drift issue is open"; fi
  else
    log "drift: Forgejo did not start the drift job"
  fi
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "drift: reset failed"
}

# The dashboards (the see-your-runs page): three runs of the example sent to
# the observability profile, which fill the dashboards the page describes.
# Their panels have no text form, so the step records the command only.
step_see_runs() {
  run_cmd see-runs "just see-runs" "$HERE/see-runs.sh"
  [ "$(jq -s '.[-1].exit' "$STAGE/see-runs.cmds")" = 0 ] || fail "see-runs: just see-runs failed, so the dashboards would be empty: $(tail -3 "$STAGE/last.out")"
}

# ── the reference pages' steps ─────────────────────────────────────────────
# Several of these run a smoke claim as it is recorded and record what it
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

# A pull request's plan note, the whole note. The step is refused when the
# note is not there (note_ready). The page names a line of the note it
# shows, which the note must have.
note_view() { # step, view, pull request number, [a line the note must have (regex)]
  local step="$1" view="$2" pr="$3" line="${4:-}" body
  [ -z "$REPLAY" ] || return 0
  note_ready "$pr" || { refuse "$step" "pull request $pr has no plan note to show"; return 0; }
  body="$(note_body "$pr")"
  if [ -n "$line" ] && ! grep -qE "$line" <<<"$body"; then
    unrecorded "$step" "$view" "pull request $pr's note has no line matching '$line'"; return 0
  fi
  printf '%s\n' "$body" | markdown_view "$step" "$view" "$REPO"
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
# (run.trace_id), and Tempo holds the binary's spans as well as terragucci's.
# Grafana's view of the trace has no text form, so the step records no view;
# a report with no trace id refuses it.
step_trace() {
  "$HERE/bootstrap.sh" observability >/dev/null 2>&1 || fail "trace: the observability profile did not start; run 'just stack-up observability' to see why"
  forge
  ci_ready trace
  local work="$STAGE/trace" trace i services=0
  local tempo="http://localhost:${TERRAGUCCI_TEMPO_PORT:-3210}"
  plan_example trace "$work" one-root "" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_REPOSITORY="$REPO"
  trace="$(jq -r '.run.trace_id // empty' "$work/terragucci-report/report.json" 2>/dev/null || true)"
  [ -n "$trace" ] || { refuse trace "the plan's report records no trace id"; return 0; }
  for i in $(seq 1 30); do   # up to a minute for the collector to flush
    services="$(curl -fsS "$tempo/api/traces/$trace" 2>/dev/null \
      | jq '[(.batches // .trace.resourceSpans // .resourceSpans // [])[] | .resource.attributes[]? | select(.key == "service.name") | .value.stringValue] | unique | length' 2>/dev/null || echo 0)"
    [ "${services:-0}" -ge 2 ] && break
    sleep 2
  done
  [ "${services:-0}" -ge 2 ] || log "trace: Tempo holds trace $trace without the binary's spans"
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
      body_view responses drift "$repo" "$pr"
      diff_view responses drift-files "$repo" "pulls/$pr"
    else
      log "responses: no drift pull request on $repo"
    fi
  fi
  if claim_run responses respond-fmt; then
    repo="$USER/respond-fmt"
    sha="$(remote_head "$repo" smoke-fmt)"
    if [ -n "$sha" ]; then diff_view responses fmt "$repo" "git/commits/$sha"; else log "responses: $repo has no smoke-fmt branch"; fi
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
  if [ -n "$pr" ]; then note_view tips note "$pr" 'tips? on how the roots'; else log "tips: the output named no pull request"; fi
  close_change "$pr" change/float
  ci_ready tips
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  plan_example tips "$STAGE/tips" float "$(printf 'reports:\n  bucket: s3://%s\n  prefix: tips\n' "$REPORT_BUCKET")" \
    -e GITHUB_SERVER_URL="$URL" -e GITHUB_REPOSITORY="$REPO"
  top="$FLOCI/$REPORT_BUCKET/tips"
  index="$(fetch "$top/index.json" || true)"
  path="$(jq -r '.reports[0].path // empty' <<<"${index:-null}" 2>/dev/null || true)"
  if [ -n "$path" ]; then html_view tips report "$top/$path/report.html" tips; else log "tips: the index at $top lists no run"; fi
  if claim_run tips respond-tips; then
    repo="$USER/respond-tips"
    pr="$(open_pull "$repo" terragucci/tip/pin-hashicorp-aws)"
    if [ -n "$pr" ]; then diff_view tips fix "$repo" "pulls/$pr"; else log "tips: no pin-hashicorp-aws pull request on $repo"; fi
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
  local work="$STAGE/policy" branch=change/policy title="Keep dev orders' jobs for seven days, under a retention policy" sha pr run logs repo
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
    note_view policy note "$pr" 'refused to plan|keeps messages longer'
  else
    log "policy: no pull request for $branch"
  fi
  close_change "$pr" "$branch"
  if claim_run policy check-diagnostics; then
    repo="$USER/checkdiag"
    sha="$(remote_head "$repo" diag-policy)"
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" | jq -c '.workflow_runs[0] // empty')"
    logs="$(REPO="$repo"; job_logs "$run" '.name == "check"')"
    if [ -n "$logs" ]; then job_log policy log "$logs" "Format check and validate" "FAILED policy tests"; else log "policy: no check job on $repo's diag-policy"; fi
  fi
}

# Commit statuses and the apply comment (reference/pipeline). The one-root
# change's pull request on the example, once its plan job has posted
# terragucci/plan: the head's statuses, as its merge box lists them, without
# the skipped ones, then the pull request is closed. And the merged pull
# request the comment-apply claim leaves, with the replies to /terragucci
# apply.
step_statuses() {
  forge
  local repo="$USER/comment-apply" pr merged sha rows
  run_cmd statuses "just example change one-root" "$HERE/example.sh" change one-root
  pr="$(pr_in_output)"
  if [ -n "$pr" ]; then
    # terragucci/plan settles once plan-note has posted it.
    if note_ready "$pr"; then
      sha="$(api "$URL/api/v1/repos/$REPO/pulls/$pr" | jq -r '.head.sha // empty')" || true
      rows=""
      [ -z "$sha" ] || rows="$(api "$URL/api/v1/repos/$REPO/commits/$sha/status" \
        | jq -c '[.statuses[]? | select(.status != "skipped") | [.context, .status, (.description // "")]]')" || true
      table_view statuses checks '["Context", "State", "Description"]' "$rows"
    else
      refuse statuses "the one-root pull request's terragucci/plan did not settle"
    fi
  else
    log "statuses: the output named no pull request"
  fi
  close_change "$pr" change/one-root
  claim_run statuses comment-apply || return 0
  merged="$(api "$URL/api/v1/repos/$repo/pulls?state=closed&limit=50" | jq -r '.[] | select(.head.ref == "change" and .merged) | .number' | head -1)"
  if [ -n "$merged" ]; then
    reply_view statuses reply "$repo" "$merged" 'wave 1 waits' 'applied: wave 1'
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
  note_view replan note "$pr"
  say "$REPO" "$pr" "/terragucci plan envs/prod/payments" >/dev/null
  say "$REPO" "$pr" "/terragucci plan envs/nope" >/dev/null
  reply_view replan replies "$REPO" "$pr" 'terragucci plan envs/prod/payments' 'envs/nope'
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
    if [ -n "$pr" ]; then reply_view pr-apply reply "$repo" "$pr" 'terragucci: applied wave'; else log "pr-apply: no pull request on $repo"; fi
  fi
  if claim_run pr-apply pr-apply-lock; then
    repo="$USER/pr-apply-lock"
    pr="$(open_pull "$repo" change-b)"
    if [ -n "$pr" ]; then reply_view pr-apply lock "$repo" "$pr" 'is locked by pull request'; else log "pr-apply: no change-b pull request on $repo"; fi
    pr="$(open_pull "$repo" change-a)"
    if [ -n "$pr" ]; then reply_view pr-apply unlock "$repo" "$pr" 'released the locks'; else log "pr-apply: no change-a pull request on $repo"; fi
  fi
  if claim_run pr-apply pr-apply-stale; then
    repo="$USER/pr-apply-stale"
    pr="$(open_pull "$repo" change)"
    if [ -n "$pr" ]; then reply_view pr-apply stale "$repo" "$pr" 'is not up to date with main'; else log "pr-apply: no pull request on $repo"; fi
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
  reply_view agent reply "$repo" "$pr" 'terragucci: pushed'
  sha="$(remote_head "$repo" agent-change)"
  if [ -n "$sha" ]; then diff_view agent commit "$repo" "git/commits/$sha"; else log "agent: no agent-change branch on $repo"; fi
  reply_view agent refused "$repo" "$pr" 'terragucci: .*touches'
}

# Drift with attribution (turn-on-drift-checks): the drift-attribute claim's
# issue, with who changed the attribute from the audit log.
step_drift_attribute() {
  forge
  claim_run drift-attribute drift-attribute || return 0
  local repo="$USER/drift-attribute" issue
  issue="$(api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" \
    | jq -r '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))][0].number // empty')"
  if [ -n "$issue" ]; then body_view drift-attribute issue "$repo" "$issue"; else log "drift-attribute: no drift issue on $repo"; fi
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
  local repo pr rows
  if claim_run publish publish; then
    repo="$(api "$URL/api/v1/repos/search?q=publish-&limit=50" | jq -r '[.data[] | select(.name | test("^publish-[0-9]+$"))] | max_by(.id) | .full_name // empty')"
    if [ -n "$repo" ]; then
      rows="$(api "$URL/api/v1/repos/$repo/tags?limit=50" | jq -c 'map([.name, .commit.sha[0:10]])')" || true
      table_view publish tags '["Tag", "Commit"]' "$rows"
    else log "publish: no publish repo"; fi
  fi
  if claim_run publish version-bump-job; then
    repo="$USER/version-bump"
    pr="$(open_pull "$repo" terragucci/release/modules-queue)"
    if [ -n "$pr" ]; then body_view publish release "$repo" "$pr"; else log "publish: no release pull request on $repo"; fi
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
  body_view reconcile pull "$repo" "$pr"
  diff_view reconcile files "$repo" "pulls/$pr"
}

# Terragrunt (tutorial/terragrunt, use-terragrunt): the Terragrunt example
# beside the plain one, booted when it is not running and reset when it is.
# The unformatted scenario pushed to a branch, and its push run's check job
# failing on terragrunt hcl fmt; the module-bump scenario's pull request and
# its plan note; then the tg-gate-wait claim's run, where wave 2 waits for its
# own approval.
step_tg() {
  forge
  local repo="$USER/example-terragrunt" work="$STAGE/tg" sha logs run pr
  if "$HERE/example-terragrunt.sh" verify >/dev/null 2>&1; then
    "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  else
    "$HERE/example-terragrunt.sh" up >/dev/null 2>&1 || fail "tg: 'just example-terragrunt up' failed"
  fi
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work" 2>/dev/null || fail "tg: cannot clone $repo"
  git -C "$work" apply "$ROOT/example-terragrunt/changes/unformatted.patch" || fail "tg: changes/unformatted.patch does not apply to main"
  sha="$(TG_FIXED_DATE=1 push_tree "$work" "$repo" change/unformatted "Name dev orders' owner, without running terragrunt hcl fmt")"
  logs="$(REPO="$repo"; job_logs "$(REPO="$repo"; push_run "$sha")" '.status == "failure"')"
  if [ -n "$logs" ]; then job_log tg check "$logs" "Format check" "needs formatting"; else log "tg: no failed job in the push run on ${sha:-the pushed commit}"; fi
  "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  # change opens the pull request and waits for its plan.
  if "$HERE/example-terragrunt.sh" change module-bump >"$STAGE/tg-change.out" 2>&1; then
    pr="$(api "$URL/api/v1/repos/$repo/pulls?state=open&limit=50" | jq -r '.[] | select(.head.ref == "change/module-bump") | .number' | head -1)"
    if [ -n "$pr" ]; then (REPO="$repo"; note_view tg note "$pr"); else log "tg: no module-bump pull request"; fi
  else
    log "tg: 'just example-terragrunt change module-bump' failed: $(tail -3 "$STAGE/tg-change.out" | tr '\n' ' ')"
  fi
  "$HERE/example-terragrunt.sh" reset >/dev/null 2>&1 || log "tg: reset failed"
  if claim_run tg tg-gate-wait; then
    run="$(api "$URL/api/v1/repos/$USER/tg-gate-wait/actions/runs?event=push&limit=50" | jq -c '.workflow_runs[0] // empty')"
    logs="$(REPO="$USER/tg-gate-wait"; job_logs "$run" '.status == "failure"')"
    if [ -n "$logs" ]; then job_log tg waiting "$logs" "Apply wave" "waits for an approval of digest" "terragucci approve wave-"; else log "tg: no stopped job on tg-gate-wait"; fi
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
  . "${TG_STATE:-$HERE/.state}/forgejo.env"
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
if [ -n "$INCOMPLETE" ]; then fail "not written, a view is missing:$INCOMPLETE"; fi
if [ -z "$ALL" ] && [ -n "$SKIPPED" ]; then fail "not captured, their claims do not pass:$SKIPPED"; fi
log "done"
