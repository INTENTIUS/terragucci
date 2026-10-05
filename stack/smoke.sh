#!/usr/bin/env bash
#
# One smoke claim per feature the site claims, run against the example.
#
#   stack/smoke.sh               every claim, several at a time
#   stack/smoke.sh <claim>       one claim
#   BREAK=1 stack/smoke.sh boot  break the property; the claim must print "caught"
#   stack/smoke.sh --record FILE every claim, plain and under BREAK=1, as JSON
#
# Each claim prints one line:
#
#   SMOKE claim=<name> verdict=pass|caught|fail|pending [detail]
#
# pending means the stage the claim needs is not built yet; the line names the
# issue that builds it. Exit codes: 0 when every claim passed, was caught or is
# pending; 1 when any claim failed; 2 for an unknown claim.
#
# Every claim and --record run claims in parallel (see "the runner" at the end):
# each run holds the stack's shared resources its line in CLAIM_GROUPS names,
# so runs that share nothing overlap and runs that would disturb each other
# wait. SMOKE_JOBS=<n> runs at most n at a time (default 6); SMOKE_SERIAL=1 runs
# one at a time in the same order, for comparing verdicts. Each run's output
# goes to its own log, <claim>.<plain|break>.log, under SMOKE_LOG_DIR (default
# stack/.state/smoke-logs/<time>); the SMOKE lines print as runs finish, and
# the record lists claims in CLAIMS order whatever order they finished in.
#
# A new claim: add its line to CLAIMS and its function claim_<name>, and give
# it a line in CLAIM_GROUPS naming what it shares. A claim with no line there
# runs alone, after boot and tg-waves: safe, and slow.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"
JOB_CACHE_VOLUME=terragucci-job-cache
# shellcheck source=mounted.sh
. "$HERE/mounted.sh"

# Every claim's temp work dir is recorded here and removed on every exit path:
# when the claim returns (run_claim), and on exit, interrupt or termination.
# On exit the runner also stops the runs it started and lets go of every lock
# this process holds.
SMOKE_WORKS=()
track_work() { SMOKE_WORKS+=("$1"); }
cleanup_works() {
  local d
  for d in ${SMOKE_WORKS[@]+"${SMOKE_WORKS[@]}"}; do [ -n "$d" ] && drop_work "$d"; done
  SMOKE_WORKS=()
}
SMOKE_RUNNING=""
on_exit() {
  cleanup_works
  local pid run
  while read -r pid run; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done <<<"$SMOKE_RUNNING"
  if declare -F release_mine >/dev/null; then release_mine; fi
  return 0
}
trap on_exit EXIT
trap 'cleanup_works; exit 130' INT
trap 'cleanup_works; exit 143' TERM

# The provider and binary cache the forge's job containers mount at /cache
# (container.options in bootstrap.sh). Every local run that installs providers
# mounts it too, so a provider downloads once per stack pass, not once per
# root per run, and no provider binary sits in a bind-mounted work dir.
# JOB_CACHE_VOLUME is set at the top, next to mounted.sh.

# name|what the site says|issue that builds it (empty: implemented here)
CLAIMS='boot|the example boots and deploys locally|
check|tf-check fails an unformatted root and names the file|
affected|only the roots a change touches are planned|
grouped|one note groups many plans|
report|the report is JSON and HTML, and links every root to its full plan|
highlight|destroys and outliers are open, identical groups are folded|
waves|each wave goes out only once approved|
refuse|a wave whose plans changed after approval applies nothing|
sealed|a wave counts only an approval sealed by a key the signers file lists|
drift|drift is reported by root|
rollout|a module version rolls out one pull request per wave|
publish|changed modules are published at a new version|
tips|tips are on by default and name their rule|
zero-config|with no more than a drift schedule and the canary wave in terragucci.yml, init writes the same pipeline|
apply-serial|two pushes to main apply one after the other, and the commit carries one terragucci/apply status|
reconcile|a control repo opens one pull request per project that changes, and the merged pipeline applies|
traces|each plan run is one trace, with a span per root and the binary spans inside it|
metrics|the metrics of a plan run reach Prometheus with the counts in its report|
tg-zero-config|init finds Terragrunt and its 15 units on its own and writes the pipeline the Terragrunt example commits|
tg-waves|the Terragrunt example boots, applying the canary wave before the rest with one run --all each|
tg-check|tf-check fails an unformatted Terragrunt file and names it|
tg-affected|only the units a change reaches are planned, including a file a module reads that Terragrunt misses|
tg-mock-lint|a dependency whose mock_outputs can stand in for apply is named by a tip|
tg-refuse|a unit whose plan would read mock_outputs is not planned; it waits for its upstream to apply|
tg-mock-trap|a new upstream and its dependent merge together and apply in order, so no mock reaches real state|
tg-drift|drift is reported by unit in a Terragrunt repo, with the same tracking issue|
respond-refused|a refused wave names each root whose plan moved and the attributes that moved|
respond-triage|a failed apply is triaged from the known-error table|
respond-drift|drift on a literal becomes a pull request with the live value, and import blocks for what is unmanaged|
respond-tips|each tip becomes its own small pull request|
respond-fmt|fmt on request commits to the pull request branch and nowhere else|
respond-notes|release notes come from the conventional commits that touched the module|
fresh-plan|on a fresh estate the plan job holds back a root whose upstream is unapplied, names it in the report, and stays green|
forgejo-oidc|a Forgejo job gets an OIDC token Forgejo signed for its repo and ref, and trades it for the plan or apply role|
steward|tf-apply runs as a turn on a fountain steward, started by the forge job, and applies every root|
policy|an opt-in policy denies a plan, fails the root in tf-plan, and names the violation|
comment-plan|a pull request comment re-plans on request and never applies, and a root outside the configured ones is refused|
lock-wait|a plan that waits for a state lock another plan holds shows the wait as a State lock wait span, in its report and its trace|
dash-pipeline|the Pipeline health dashboard init writes shows the runs, errors and results of a plan, a drift run and a gated wave|
dash-changes|the Change review dashboard init writes shows the roots, groups and changes by action of a pull request|
dash-waves|the Rollouts and waves dashboard init writes shows a wave waiting for its approval, how long, and wave runs by result|
dash-drift|the Drift dashboard init writes shows the roots a drift run found drifted and how old the drift is|
dash-estate|the Estate dashboard init writes shows the roots of a project and the binary and terragucci versions it runs|
dash-runs|the Runs dashboard init writes shows the slowest roots, stage durations and the trace of each run from Tempo|
dash-slos|the SLO dashboards init writes are provisioned, and the plan SLO records the plans of a project from the rules init writes|'

say() { echo "SMOKE claim=$1 verdict=$2${3:+ $3}"; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so no claim can run."; exit 0; }

# ── the implemented claims ────────────────────────────────────────────────
# Each returns 0 when the property held and 1 when it did not, and prints its
# evidence on stderr.

claim_boot() {
  # The example from nothing: its repo, its resources and its state are wiped,
  # then `example.sh up` pushes it and the pipeline applies every root. Only
  # the example is wiped (not all of floci, as `up --fresh` does), so claims on
  # other repos and the Terragrunt example keep running meanwhile.
  # BREAK: one root's apply is skipped, so only the resource check notices.
  log() { echo "[smoke boot] $*" >&2; }
  local skip=""
  [ -n "${BREAK:-}" ] && skip="envs/prod/email"
  if (. "$HERE/lib.sh") >/dev/null 2>&1; then
    # shellcheck source=lib.sh
    . "$HERE/lib.sh"
    wipe_example || return 1
  else
    log "no stack yet, so nothing to wipe; example.sh up starts it"
  fi
  TG_SKIP_ROOT="$skip" "$HERE/example.sh" up >&2 || return 1
  "$HERE/example.sh" verify >&2
}

# The plain example's repo, its buckets (and their objects), queues and
# tables, and its state under envs/ in the state bucket. Nothing else on floci
# is touched: the Terragrunt example's names start with shop-tg-.
wipe_example() {
  local mine='^shop-(dev|staging|prod)-' b k u t n left i
  sqs_json() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: $1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/example" 2>/dev/null || true
  for i in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$USER/example")" = 404 ] && break
    sleep 1
  done
  for b in $(curl -fsS "$FLOCI/" | grep -o '<Name>[^<]*</Name>' | sed -E 's#</?Name>##g' | grep -E "$mine" || true); do
    for k in $(curl -fsS "$FLOCI/$b?list-type=2" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true); do
      curl -s -o /dev/null -X DELETE "$FLOCI/$b/$k" || true
    done
    curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true
  done
  for u in $(sqs_json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]?' || true); do
    grep -qE "$mine" <<<"${u##*/}" || continue
    sqs_json AmazonSQS.DeleteQueue "$(jq -cn --arg u "$u" '{QueueUrl: $u}')" >/dev/null || true
  done
  for t in $(sqs_json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?' | grep -E "$mine" || true); do
    sqs_json DynamoDB_20120810.DeleteTable "$(jq -cn --arg t "$t" '{TableName: $t}')" >/dev/null || true
  done
  for k in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=envs/" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$k" || true
  done
  # Anything left would make the apply meet a resource it did not create.
  left="$( { curl -fsS "$FLOCI/" | grep -o '<Name>[^<]*</Name>' | sed -E 's#</?Name>##g' | grep -E "$mine"
    sqs_json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]? | split("/") | last' | grep -E "$mine"
    sqs_json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?' | grep -E "$mine"
    curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=envs/" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
  } 2>/dev/null || true)"
  n="$(grep -c . <<<"$left" || true)"
  [ "$n" = 0 ] || { log "the wipe left $n of the example's objects in floci: $(tr '\n' ' ' <<<"$left")"; return 1; }
  log "wiped the example's repo, resources and state"
}

claim_check() {
  # A clean branch must go green, and the same branch plus an unformatted file
  # must go red with the file named in the log.
  log() { echo "[smoke check] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" work sha logs
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example up' first"; drop_work "$work"; return 1; }
  local unformatted='locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}'
  [ -n "${BREAK:-}" ] && echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: clean $(date +%s)")"
  wait_run "$repo" "$sha"
  if [ "$RUN_STATUS" != success ]; then log "the clean push ended '$RUN_STATUS'"; drop_work "$work"; return 1; fi
  echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: unformatted $(date +%s)")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fcheck" || true
  drop_work "$work"
  [ "$RUN_STATUS" = failure ] || { log "the unformatted push ended '$RUN_STATUS'"; return 1; }
  grep -q "unformatted.tf" <<<"$logs" || { log "the run failed but its log does not name unformatted.tf"; return 1; }
  log "the unformatted push failed at the format check and named envs/dev/orders/unformatted.tf"
}

TERRAGUCCI="$HERE/../node_modules/.bin/terragucci"

claim_zero_config() {
  # The example with its terragucci.yml cut down to the drift schedule, the one
  # thing a repo cannot show: init must write exactly the pipeline the example
  # commits, finding everything else from the repo alone.
  local work rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$work/"
  # The canary wave stays: it is a choice, like the schedule, and it sets the apply jobs.
  printf 'drift: "0 6 * * *"\nwaves:\n  canary: ["envs/dev/*"]\n' > "$work/terragucci.yml"
  # BREAK: a config that leaves out prod, so init finds fewer roots.
  [ -n "${BREAK:-}" ] && printf 'drift: "0 6 * * *"\nwaves:\n  canary: ["envs/dev/*"]\nroots: ["envs/dev/*", "envs/staging/*"]\n' > "$work/terragucci.yml"
  (cd "$work" && "$TERRAGUCCI" init) >&2 || rc=1
  if [ $rc = 0 ] && ! diff -u "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/.forgejo/workflows/terragucci.yml" >&2; then
    echo "[smoke zero-config] init wrote a different pipeline" >&2
    rc=1
  fi
  drop_work "$work"
  return $rc
}

claim_apply_serial() {
  # A scratch repo whose one root writes a mark to floci when its apply starts
  # and another when it ends, with a long pause between. The first push is
  # let run until its apply has started, then a second push lands. The marks
  # must read start end start end: the second apply waited for the first.
  # BREAK: the lock is cut out of the committed pipeline, so the applies overlap.
  # The runner has capacity 8, and under BREAK the smoke runner gives this claim
  # the runner to itself (runner! in CLAIM_GROUPS), so a free slot never forces
  # the order: only the concurrency group and the state lock do.
  log() { echo "[smoke apply-serial] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/serial" sha1 sha2 i listing marks bucket=shop-terraform-state mark
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local n; for n in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d '{"name":"serial","private":false,"auto_init":false,"default_branch":"main"}' "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket"
  # Clear marks and state (with its lock file) from an earlier run.
  for mark in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$mark" || true
  done
  mkdir -p "$work/app"
  cat > "$work/app/main.tf" <<'TF'
terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "serial/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "slow" {
  triggers_replace = file("${path.module}/rev.txt")
  provisioner "local-exec" {
    command = <<-SH
      mark() { node -e "fetch(process.env.AWS_ENDPOINT_URL + '/shop-terraform-state/serial-marks/' + Date.now() + '-$1', { method: 'PUT', body: 'x' })"; }
      mark start
      sleep 20
      mark end
    SH
  }
}
TF
  echo 1 > "$work/app/rev.txt"
  # The second push replaces the resource, which on-destroy would hold for an
  # approval; this claim is about the lock, so no wave waits.
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n' > "$work/terragucci.yml"
  (cd "$work" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml)
  # BREAK=1 cuts all three guards; BREAK=lock,group,job names the ones to cut.
  local wf="$work/.forgejo/workflows/terragucci.yml" cut="${BREAK:-}"
  [ "$cut" = 1 ] && cut=lock,group,job
  case ",$cut," in *,lock,*) sed -i.bak 's#^\( *\)until git push -q origin .*; do#\1until true; do#' "$wf" ;; esac
  case ",$cut," in *,group,*) awk '/^concurrency:/ {skip=1; next} skip && /^ / {next} {skip=0; print}' "$wf" > "$wf.new" && mv "$wf.new" "$wf" ;; esac
  case ",$cut," in *,job,*) awk '/^    concurrency:/ {skip=1; next} skip && /^      / {next} {skip=0; print}' "$wf" > "$wf.new" && mv "$wf.new" "$wf" ;; esac
  rm -f "$wf.bak"
  sha1="$(push_tree "$work" "$repo" main "serial: first")"
  for i in $(seq 1 120); do
    listing="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" || true)"
    case "$listing" in *-start\</Key\>*) break ;; esac
    sleep 2
  done
  echo 2 > "$work/app/rev.txt"
  sha2="$(push_tree "$work" "$repo" main "serial: second")"
  wait_run "$repo" "$sha1"
  wait_run "$repo" "$sha2"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the second run ended $RUN_STATUS"; drop_work "$work"; return 1; }
  marks="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' ')"
  log "marks in key order: $marks"
  drop_work "$work"
  # Keys sort by millisecond timestamp, so the listing is the order they happened in.
  [ "$marks" = "start end start end " ] || { log "the applies overlapped or one did not run"; return 1; }
  local statuses
  statuses="$(api "$URL/api/v1/repos/$repo/commits/$sha2/statuses" | jq -r '[.[] | select(.context == "terragucci/apply")] | sort_by(.id) | last | .status + ":" + .description')"
  log "terragucci/apply on the second commit: $statuses"
  [ "$statuses" = "success:1 roots in 1 groups applied" ] || { log "expected one success status for the stage"; return 1; }
}

# ── gated waves on plain roots ────────────────────────────────────────────
# stack/fixtures/gated-waves: five tofu roots, canary/one in the canary wave
# and fleet/* after it, gate: always. Each claim gets its own Forgejo repo and
# its own state prefix in floci.

CHANT="$HERE/../node_modules/.bin/chant"

gated_repo() { # name -> a fresh repo $USER/<name>, the fixture in $work/tree with its pipeline, no state under <name>/
  local name="$1" key
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local n; for n in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$name" 2>/dev/null || true
  settle "repos/$USER/$name" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  settle "repos/$USER/$name" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$name"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$name/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/gated-waves/." "$work/tree/"
  find "$work/tree" -name main.tf -exec sed -i.bak "s#@PREFIX@#$name#" {} \;
  find "$work/tree" -name '*.bak' -delete
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  # init lists every wave gate under identity.gates, so an approval counts only
  # when its seal verifies against the signers file at base. The approver's key
  # goes in it; an agent's never does.
  ssh-keygen -q -t ed25519 -N "" -C smoke-approver -f "$work/approver" || return 1
  mkdir -p "$work/tree/.chant"
  echo "smoke-approver $(cut -d' ' -f1,2 "$work/approver.pub")" > "$work/tree/.chant/allowed_signers"
}

gated_applied() { # name -> the roots with state under <name>/, space-separated
  curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$1/" | grep -o '<Key>[^<]*\.tfstate</Key>' \
    | sed -E "s#</?Key>##g; s#^$1/##; s#\.tfstate\$##" | sort | tr '\n' ' '
}

# The smoke stands in for the person who approves: it reads nothing and
# approves wave 1's standing plan, as `chant approve` would be run by hand.
gated_approve() { # name, wave
  local clone="$work/approve-$2"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/$1.git" "$clone" || return 1
  git -C "$clone" config user.name smoke-approver
  git -C "$clone" config user.email smoke-approver@terragucci.local
  (cd "$clone" && "$CHANT" approve tf-apply "wave-$2" --approver smoke-approver --sign "$work/approver") >&2 || { log "chant approve tf-apply wave-$2 failed"; return 1; }
}

claim_waves() {
  # Push the fixture. Wave 1 (canary/one) waits for its approval, so the run
  # stops there and wave 2 (fleet/*) never starts: no root has state. Approve
  # wave 1 and push again: canary/one applies, and wave 2 waits for its own
  # approval, so fleet/* still has none.
  # BREAK: the pushed pipeline runs with --gate never, so no wave waits and
  # wave 2 applies with nothing approved.
  log() { echo "[smoke waves] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/waves" sha applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo waves || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak 's#--gate always#--gate never#' "$work/tree/.forgejo/workflows/terragucci.yml"
    rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "waves: first")"
  wait_run "$repo" "$sha"
  applied="$(gated_applied waves)"
  log "after the first push: run $RUN_STATUS, state for: ${applied:-nothing}"
  [ -z "$applied" ] || { log "a root applied before any wave was approved"; rc=1; }
  if [ $rc = 0 ]; then
    print_logs "$repo" "$RUN_ID" | grep "chant approve tf-apply wave-1" >/dev/null || { log "wave 1 did not print its approval command"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    gated_approve waves 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "waves: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied waves)"
    log "after the approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one alone to apply, wave 2 waiting for its own approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 2 stayed out until wave 1 was approved, and then waited at its own gate"
  return $rc
}

# The smoke stands in for a job or an agent that can push to chant/lifecycle
# but holds no key the signers file lists: it writes a resolution line for
# wave 1's standing plan itself, unsealed or sealed with its own key, in the
# approver's name. Neither may let the wave proceed.
gated_forge() { # name, wave, "unsealed" | key file
  local clone="$work/forge-$2-$RANDOM" gate="wave-$2" digest now line payload sig
  git clone -q -b chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/$1.git" "$clone" || return 1
  digest="$(jq -rs --arg g "$gate" '[.[] | select(.kind == "pending" and .gate == $g)] | last | .planDigest' "$clone/_gates/tf-apply.jsonl")"
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  line="$(jq -cn --arg g "$gate" --arg d "$digest" --arg t "$now" '{version: 1, kind: "resolution", op: "tf-apply", gate: $g, resolvedBy: "smoke-approver", timestamp: $t, planDigest: $d}')"
  if [ "$3" != unsealed ]; then
    payload="$(printf 'tf-apply\n%s\n\n%s\nsmoke-approver\n%s' "$gate" "$digest" "$now")"
    sig="$(printf '%s' "$payload" | ssh-keygen -q -Y sign -n chant-gate -f "$3")" || return 1
    line="$(jq -c --arg s "$sig" '. + {seal: {signer: "smoke-approver", key: "SHA256:agent", signature: $s}}' <<<"$line")"
  fi
  printf '%s\n' "$line" >> "$clone/_gates/tf-apply.jsonl"
  git -C "$clone" -c user.name=agent -c user.email=agent@terragucci.local -c commit.gpgsign=false commit -q -am "an approval no person sealed" || return 1
  git -C "$clone" push -q origin chant/lifecycle || return 1
}

claim_sealed() {
  # Push the fixture; wave 1 waits. Write an unsealed approval of its plan, and
  # one sealed with an agent's key the signers file does not list, both in the
  # approver's name, and push again: nothing applies, and the run says the
  # approvals do not count. Then the approver runs chant approve --sign with
  # the listed key, and canary/one applies.
  # BREAK: chant.workspace.json is left out of the pushed tree, so no gate needs
  # a seal and the unsealed approval lets wave 1 apply.
  log() { echo "[smoke sealed] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/sealed" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo sealed || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && rm -f "$work/tree/chant.workspace.json"
  ssh-keygen -q -t ed25519 -N "" -C agent -f "$work/agent" || rc=1
  sha="$(push_tree "$work/tree" "$repo" main "sealed: first")"
  wait_run "$repo" "$sha"
  if [ $rc = 0 ]; then
    gated_forge sealed 1 unsealed || rc=1
    gated_forge sealed 1 "$work/agent" || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "sealed: after an unsealed and an agent-sealed approval")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied sealed)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the unsealed and agent-sealed approvals: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied on an approval no listed key sealed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "an approval does not count: the approval by smoke-approver is not signed" <<<"$logs" || { log "the run did not say the unsealed approval does not count"; rc=1; }
    grep -q "an approval does not count: the seal by smoke-approver does not verify" <<<"$logs" || { log "the run did not say the agent's seal does not verify"; rc=1; }
    grep -q -- "--sign" <<<"$logs" || { log "the approval command the run printed has no --sign"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    gated_approve sealed 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "sealed: after a sealed approval")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied sealed)"
    log "after the sealed approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the sealed approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "unsealed and agent-sealed approvals let nothing apply; the sealed one let wave 1 apply"
  return $rc
}

claim_refuse() {
  # Push the fixture; wave 1 waits. Approve it, then change canary/one and
  # push again. Wave 1 plans a different set digest from the approved one, so
  # it applies nothing, names canary/one, and no root anywhere has state.
  # BREAK: the pushed pipeline runs with --gate never, so the changed wave applies.
  log() { echo "[smoke refuse] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/refuse" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo refuse || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak 's#--gate always#--gate never#' "$work/tree/.forgejo/workflows/terragucci.yml"
    rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "refuse: first")"
  wait_run "$repo" "$sha"
  if [ -z "${BREAK:-}" ]; then
    gated_approve refuse 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    sha="$(push_tree "$work/tree" "$repo" main "refuse: change canary/one after its wave was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied refuse)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the change: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied after its wave's plans changed"; rc=1; }
    [ "$RUN_STATUS" = failure ] || { log "the run ended '$RUN_STATUS', not failure"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "changed after it was approved, so nothing in it was applied" <<<"$logs" || { log "wave 1 did not refuse as changed"; rc=1; }
    grep -q "planned differently since: canary/one" <<<"$logs" || { log "the refusal does not name canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 changed after its approval, applied nothing and named canary/one"
  return $rc
}

claim_reconcile() {
  # A control repo names two projects with the same two roots: in-line already
  # has the pipeline init writes, two-roots has none. Apply must leave in-line
  # alone and open one pull request on two-roots; its check must pass; merged,
  # its pipeline must apply both roots, network before app, since app's bucket
  # name comes from network's state.
  log() { echo "[smoke reconcile] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/two-roots" mode=apply out pr sha
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  local name
  # Forgejo settles a deleted or new repo a moment after answering; wait for it,
  # or the next call can meet the old repo or a 404.
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  for name in two-roots in-line; do
    api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$name" 2>/dev/null || true
    settle "repos/$USER/$name" 404 || return 1
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
    settle "repos/$USER/$name" 200 || return 1
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$name"
  done
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for b in tg-reconcile-network tg-reconcile-network-app; do curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true; done
  mkdir -p "$work/two-roots/network" "$work/two-roots/app"
  local head='terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "KEY"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region            = "us-east-1"
  s3_use_path_style = true
}
'
  { echo "${head/KEY/reconcile/network.tfstate}"
    printf 'resource "aws_s3_bucket" "this" {\n  bucket = "tg-reconcile-network"\n}\n\noutput "bucket" {\n  value = aws_s3_bucket.this.bucket\n}\n'
  } > "$work/two-roots/network/main.tf"
  { echo "${head/KEY/reconcile/app.tfstate}"
    printf 'data "terraform_remote_state" "network" {\n  backend = "s3"\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "reconcile/network.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "aws_s3_bucket" "this" {\n  bucket = "${data.terraform_remote_state.network.outputs.bucket}-app"\n}\n'
  } > "$work/two-roots/app/main.tf"
  # in-line: the same two roots under their own names and state keys, with the
  # pipeline init writes already committed. Its push runs that pipeline; the
  # claim never waits on it, and nothing it applies touches two-roots.
  cp -R "$work/two-roots" "$work/in-line"
  sed -i.bak 's#reconcile/#inline/#; s#tg-reconcile-#tg-inline-#' "$work/in-line/network/main.tf" "$work/in-line/app/main.tf"
  rm -f "$work/in-line/network/main.tf.bak" "$work/in-line/app/main.tf.bak"
  # The same settings as the control repo's defaults, so init writes what reconcile would.
  printf 'forge: forgejo\nbinary: tofu\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' > "$work/in-line/terragucci.yml"
  (cd "$work/in-line" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml)
  push_tree "$work/in-line" "$USER/in-line" main "Two roots, pipeline in line" >/dev/null
  push_tree "$work/two-roots" "$repo" main "Two roots, no pipeline" >/dev/null
  settle "repos/$USER/in-line/branches/main" 200 || return 1
  settle "repos/$repo/branches/main" 200 || return 1
  settle "repos/$repo/pulls?state=open" 200 || return 1

  cat > "$work/terragucci.yml" <<YML
defaults:
  forge: forgejo
  binary: tofu
  token_env: TERRAGUCCI_FORGEJO_TOKEN
projects:
  localhost/$USER/in-line:
    url: $URL/$USER/in-line
  localhost/$repo:
    url: $URL/$repo
YML
  [ -n "${BREAK:-}" ] && mode=dry-run   # BREAK: a dry run opens nothing
  out="$(TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" reconcile --config "$work/terragucci.yml" --mode "$mode" 2>&1)" || { echo "$out" >&2; drop_work "$work"; return 1; }
  echo "$out" >&2
  drop_work "$work"
  grep -q "localhost/$USER/in-line: unchanged" <<<"$out" || { log "in-line was not left alone"; return 1; }
  pr="$(api "$URL/api/v1/repos/$repo/pulls?state=open" | jq -r '.[] | select(.head.ref == "terragucci/pipeline") | .number' | head -1)"
  [ -n "$pr" ] || { log "no pull request on $repo"; return 1; }
  sha="$(api "$URL/api/v1/repos/$repo/branches/terragucci%2Fpipeline" | jq -r .commit.id)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the pull request's check ended $RUN_STATUS"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
  sha="$(api "$URL/api/v1/repos/$repo/branches/main" | jq -r .commit.id)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the merged pipeline ended $RUN_STATUS"; return 1; }
  for b in tg-reconcile-network tg-reconcile-network-app; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -I "$FLOCI/$b")" = 200 ] || { log "$b is not in floci"; return 1; }
  done
  log "one pull request on $repo, check green, merged, both roots applied in order; in-line unchanged"
}

# ── the plan report ───────────────────────────────────────────────────────
# `terragucci stage tf-plan` runs in the tofu CI image on the stack's network,
# against the example's state in floci, with the bundle built from this tree.
# Its report goes to a floci bucket, which stands in for any S3-compatible
# store. Needs the example booted (`just example up`, or the boot claim).

REPORT_BUCKET=terragucci-reports

# work dir, then the patches to apply; leaves the run's report in $1/terragucci-report.
# REPORT_STAGE names another stage (tf-drift); REPORT_EXTRA holds more `docker run` arguments and REPORT_ARGS more stage arguments.
# REPORT_BASE=1 commits the tree before the patches and REPORT_EDIT (shell, run in the tree), and names that commit TG_BASE.
REPORT_EXTRA=()
REPORT_ARGS=()

# A CI image's tag (tofu, terragrunt), as scripts/images.ts names it. The
# runner works both out once and passes them down in SMOKE_<NAME>_IMAGE.
image_tag() { # name
  local cached
  case "$1" in tofu) cached="${SMOKE_TOFU_IMAGE:-}" ;; terragrunt) cached="${SMOKE_TG_IMAGE:-}" ;; *) cached="" ;; esac
  if [ -n "$cached" ]; then echo "$cached"; return 0; fi
  (cd "$HERE/.." && npx tsx scripts/images.ts tags | awk -v n="$1" '$1 == n { print $2 }')
}

# Build the bundle the CI image runs. The runner builds it once before any
# claim starts (SMOKE_CLI_BUILT=1), so no run rewrites it under another.
build_cli() {
  [ -n "${SMOKE_CLI_BUILT:-}" ] && return 0
  # A hand run (smoke.sh <claim>) skips the build when the bundle is newer than
  # everything it is built from, so several hand runs started at once do not
  # each rebuild it. build-cli.mjs renames the finished files into place, so a
  # build that does run never leaves another run a half-written bundle.
  local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  if [ -f "$bundle" ] && [ -z "$(find "$HERE/../packages/terragucci/src" "$HERE/../packages/terragucci/package.json" "$HERE/../scripts/build-cli.mjs" -type f -newer "$bundle" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null)
}

report_run() {
  local work="$1"; shift
  local image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" p rc=0
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  build_cli || return 1
  cp -R "${REPORT_TREE:-$EXAMPLE}/." "$work/"
  rm -rf "$work/.git"
  git -C "$work" init -q -b main
  local base=""
  if [ -n "${REPORT_BASE:-}" ]; then
    git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm base
    base="$(git -C "$work" rev-parse HEAD)"
  fi
  for p in "$@"; do git -C "$work" apply "$EXAMPLE/changes/$p.patch" || return 1; done
  [ -n "${REPORT_EDIT:-}" ] && { (cd "$work" && eval "$REPORT_EDIT") || return 1; }
  [ -n "${REPORT_CONFIG:-}" ] && printf '%s\n' "$REPORT_CONFIG" >> "$work/terragucci.yml"
  git -C "$work" remote add origin "http://forgejo:3000/$USER/example.git"
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost commit -qm "smoke report $(date +%s%N)"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  # REPORT_ENV: extra KEY=VALUE pairs for the stage, space-separated.
  local extra=() kv
  for kv in ${REPORT_ENV:-}; do extra+=(-e "$kv"); done
  [ -n "$base" ] && extra+=(-e "TG_BASE=$base")
  docker run --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    ${extra[@]+"${extra[@]}"} \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${REPORT_EXTRA[@]+"${REPORT_EXTRA[@]}"} \
    "$image" terragucci stage "${REPORT_STAGE:-tf-plan}" ${REPORT_ARGS[@]+"${REPORT_ARGS[@]}"} >&2 || rc=$?
  clean_mounted "$work" "$image"
  return $rc
}

# Apply some of the example's roots as committed, each in the tofu CI image as
# the pipeline's apply job runs it. The reset a claim needs when it changed one
# root's resources, instead of re-applying all 15 through the pipeline.
apply_roots() { # root...
  local work image root
  image="$(image_tag tofu)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$work/"
  for root in "$@"; do
    docker run --rm --network terragucci -v "$work:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color' >&2 || { drop_work "$work"; return 1; }
  done
  drop_work "$work"
}

claim_report() {
  # Two runs on two commits, each copying its report to the bucket. Each run
  # writes report.json and report.html, every planned root links to its full
  # plan text and JSON and those files exist, the HTML carries the JSON
  # inline, and the index lists both runs, the first one still there.
  log() { echo "[smoke report] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir root f n i index path commits=() prefix cfg=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  prefix="smoke-$(date +%s)"   # a fresh index for each claim run
  # BREAK: no bucket named, so nothing reaches the index.
  [ -z "${BREAK:-}" ] && cfg="$(printf 'reports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix")"
  for i in 1 2; do
    mkdir -p "$work/run$i"
    # tf-plan exits 1 when a root refuses to plan; the report is written either way.
    REPORT_CONFIG="$cfg" report_run "$work/run$i" module-bump destroy || true
    dir="$work/run$i/terragucci-report"
    [ -f "$dir/report.json" ] && [ -f "$dir/report.html" ] || { log "run $i wrote no report"; rc=1; break; }
    commits+=("$(git -C "$work/run$i" rev-parse HEAD)")
    n="$(jq '[.roots[] | select(.status == "planned")] | length' "$dir/report.json")"
    [ "$n" -ge 15 ] || { log "run $i planned only $n roots"; rc=1; }
    for root in $(jq -r '.roots[] | select(.status == "planned") | .path' "$dir/report.json"); do
      for f in $(jq -r --arg r "$root" '.roots[] | select(.path == $r) | .plan.text, .plan.json' "$dir/report.json"); do
        [ -s "$dir/$f" ] || { log "$root: $f is missing"; rc=1; }
        grep -q "href=\"$f\"" "$dir/report.html" || { log "$root: the HTML does not link $f"; rc=1; }
      done
      grep -q "id=\"root-$root\"" "$dir/report.html" || { log "$root has no anchor in the HTML"; rc=1; }
    done
    if ! diff <(sed -n '/id="terragucci-report"/,/<\/script>/p' "$dir/report.html" | sed '1d;$d' | jq -S .) <(jq -S . "$dir/report.json") >/dev/null; then
      log "the JSON inlined in report.html is not report.json"; rc=1
    fi
  done
  if [ $rc = 0 ]; then
    if ! index="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json")"; then
      log "no index at $REPORT_BUCKET/$prefix/index.json"; rc=1
    else
      for c in "${commits[@]}"; do
        path="$(jq -r --arg c "$c" '.reports[] | select(.commit == $c) | .path' <<<"$index" | head -1)"
        if [ -z "$path" ]; then log "the index does not list commit $c"; rc=1; continue; fi
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$REPORT_BUCKET/$prefix/$path/report.html")" = 200 ] || { log "$path/report.html is not in the bucket"; rc=1; }
        f="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$path/report.json" | jq -r '.roots[0].plan.text')"
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$REPORT_BUCKET/$prefix/$path/$f")" = 200 ] || { log "$path/$f is not in the bucket"; rc=1; }
      done
    fi
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "two runs, each root linked to its plan, both in $REPORT_BUCKET/$prefix/index.json"
}

claim_affected() {
  # A change to envs/dev/platform, against the commit before it. The plan must
  # cover dev's platform and the four dev services that read its state, and
  # no other root. BREAK: no base, so every root is planned.
  log() { echo "[smoke affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 r got want base=1
  want="envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/platform,envs/dev/search"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] && base=""
  REPORT_BASE="$base" REPORT_EDIT='printf "\n# smoke affected: a change to this root alone\n" >> envs/dev/platform/main.tf' report_run "$work" || true
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; drop_work "$tree"; return 1; }
  got="$(jq -r '[.roots[] | select(.status == "planned") | .path] | sort | join(",")' "$r")"
  [ "$got" = "$want" ] || { log "planned $got, not $want"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "envs/dev/platform changed: it and the four dev services that read its state planned, nothing else"
  return $rc
}

claim_grouped() {
  # A pull request on the example with module-bump, which reaches the twelve
  # service roots. Its plan job must post one plan note whose first line names
  # those twelve roots, and whose groups name every one of them, in fewer
  # groups than roots. BREAK: the pushed pipeline plans dev's roots alone, so
  # the note leaves out the staging and prod services.
  log() { echo "[smoke grouped] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" branch=smoke/grouped work sha pr rc=0 deadline state notes body roots want root groups
  want="$(for e in dev prod staging; do for s in email orders payments search; do echo "envs/$e/$s"; done; done | sort | paste -sd, -)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example up' first"; drop_work "$work"; return 1; }
  # The pipeline this tree renders, so the pull request runs it whatever main carries.
  cp "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/tree/.forgejo/workflows/terragucci.yml"
  git -C "$work/tree" apply "$EXAMPLE/changes/module-bump.patch" || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && sed -i.bak "s#terragucci stage tf-plan --out#terragucci stage tf-plan --root 'envs/dev/*' --out#" "$work/tree/.forgejo/workflows/terragucci.yml" && rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  sha="$(push_tree "$work/tree" "$repo" "$branch" "smoke grouped: module-bump $(date +%s)")"
  pr="$(open_pr "$repo" "$branch")"
  [ -n "$pr" ] || pr="$(api -H 'content-type: application/json' -X POST \
    -d "$(jq -n --arg h "$branch" '{head: $h, base: "main", title: "smoke grouped: module-bump"}')" "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  [ -n "$pr" ] && [ "$pr" != null ] || { log "no pull request"; drop_work "$work"; return 1; }
  # The plan job's status on the head commit says when its note is up.
  deadline=$(( $(date +%s) + TIMEOUT ))
  state=pending
  while [ "$state" = pending ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    state="$(api "$URL/api/v1/repos/$repo/commits/$sha/statuses" | jq -r '[.[] | select(.context == "terragucci/plan")][0].status // "pending"')"
  done
  log "terragucci/plan on ${sha:0:8}: $state"
  notes="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq '[.[] | select(.body | startswith("<!-- terragucci:plan"))]')"
  if [ "$(jq length <<<"$notes")" != 1 ]; then
    log "pull request $pr has $(jq length <<<"$notes") plan notes, not one"; rc=1
  else
    body="$(jq -r '.[0].body' <<<"$notes")"
    roots="$(head -1 <<<"$body" | sed -E 's/.*roots=([^ ]*) -->.*/\1/' | tr , '\n' | sort | paste -sd, -)"
    [ "$roots" = "$want" ] || { log "the note covers $roots, not $want"; rc=1; }
    for root in ${want//,/ }; do
      grep '^Roots: ' <<<"$body" | grep -q "\`$root\`" || { log "no group in the note names $root"; rc=1; }
    done
    groups="$(grep -c '^#### \[Group ' <<<"$body" || true)"
    [ "$groups" -ge 1 ] && [ "$groups" -lt 12 ] || { log "the note has $groups groups for 12 roots"; rc=1; }
  fi
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$repo/pulls/$pr" || true
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fgrouped" || true
  drop_work "$work"
  [ $rc = 0 ] && log "one note on pull request $pr groups the 12 service roots in $groups groups"
  return $rc
}

# ── traces and metrics ────────────────────────────────────────────────────
# A plan run sends OTLP to the observability profile's collector on the
# stack's network. Needs the example booted; the claims start the
# observability profile themselves when it is not up.

OTLP_ENDPOINT=http://otel-collector:4318
PROMETHEUS="http://localhost:${TERRAGUCCI_PROMETHEUS_PORT:-9190}"

collector_up() {
  local health="http://localhost:${TERRAGUCCI_OTEL_HEALTH_PORT:-13143}/" i
  answers() { curl -fsS -o /dev/null -m 3 "$health" && curl -fsS -o /dev/null -m 3 "$PROMETHEUS/-/ready"; }
  answers 2>/dev/null && return 0
  echo "starting the observability profile" >&2
  # up -d leaves running containers alone, so this is safe when half of it is up.
  # The compose lock keeps it from racing another run's compose call.
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name terragucci --profile observability up -d >&2 || return 1
  for i in $(seq 1 30); do
    answers 2>/dev/null && return 0
    sleep 2
  done
  echo "the collector or Prometheus did not answer after 60s" >&2
  return 1
}

claim_traces() {
  # One plan run. Its trace is found by the commit on the stage span; it must
  # hold one root span per root in the report, and OpenTofu's own spans (sent
  # under its own service name) must carry the same trace id, which they do
  # only when TRACEPARENT reached the binary.
  log() { echo "[smoke traces] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  collector_up || return 1
  local work rc=0 commit trace roots spans binary env="OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # BREAK: traces off, for terragucci and the binary alike.
  [ -n "${BREAK:-}" ] && env="$env OTEL_TRACES_EXPORTER=none"
  mkdir -p "$work/run"
  REPORT_ENV="$env" report_run "$work/run" module-bump || true
  commit="$(git -C "$work/run" rev-parse HEAD)"
  roots="$(jq '.roots | length' "$work/run/terragucci-report/report.json" 2>/dev/null || echo 0)"
  sleep 3   # the file exporter writes on its own schedule
  docker cp terragucci-otel-collector:/out/traces.jsonl - 2>/dev/null | tar -xO > "$work/traces.jsonl" || true
  trace="$(jq -rs --arg c "$commit" '[.[].resourceSpans[].scopeSpans[].spans[]
    | select(.name == "terragucci tf-plan" and any(.attributes[]; .key == "vcs.ref.head.revision" and .value.stringValue == $c))][0].traceId // empty' "$work/traces.jsonl" 2>/dev/null)"
  if [ -z "$trace" ]; then
    log "no trace for commit $commit"; rc=1
  else
    spans="$(jq -s --arg t "$trace" '[.[].resourceSpans[].scopeSpans[].spans[] | select(.traceId == $t and (.name | startswith("root ")))] | length' "$work/traces.jsonl")"
    binary="$(jq -s --arg t "$trace" '[.[].resourceSpans[]
      | select(any(.resource.attributes[]?; .key == "service.name" and .value.stringValue == "terragucci") | not)
      | .scopeSpans[].spans[] | select(.traceId == $t)] | length' "$work/traces.jsonl")"
    [ "$spans" = "$roots" ] && [ "$roots" -ge 15 ] || { log "trace $trace has $spans root spans for $roots roots"; rc=1; }
    [ "$binary" -gt 0 ] || { log "no span from the binary carries trace $trace"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "trace $trace: $spans root spans for $roots roots, and $binary spans from the binary inside it"
}

claim_metrics() {
  # One plan run. Prometheus, scraping the collector, must hold the run's
  # metrics (found by the commit, a resource attribute the collector copies
  # onto each series) with the report's root count and change totals.
  log() { echo "[smoke metrics] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  collector_up || return 1
  local work rc=1 commit report i q want got action env="OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # BREAK: metrics off, so nothing reaches Prometheus.
  [ -n "${BREAK:-}" ] && env="$env OTEL_METRICS_EXPORTER=none"
  mkdir -p "$work/run"
  REPORT_ENV="$env" report_run "$work/run" module-bump destroy || true
  commit="$(git -C "$work/run" rev-parse HEAD)"
  report="$work/run/terragucci-report/report.json"
  [ -f "$report" ] || { log "the run wrote no report"; drop_work "$work"; return 1; }
  value() { curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'; }
  for i in $(seq 1 12); do   # Prometheus scrapes every 5s
    rc=0
    want="$(jq '.roots | length' "$report")"
    got="$(value "terragucci_roots_planned{vcs_ref_head_revision=\"$commit\"}")"
    [ "$got" = "$want" ] || { rc=1; q="roots_planned: $got, want $want"; }
    for action in create update replace delete; do
      want="$(jq --arg a "$action" '.totals[$a] // 0' "$report")"
      got="$(value "terragucci_plan_changes{vcs_ref_head_revision=\"$commit\",action=\"$action\"}")"
      [ "$got" = "$want" ] || { rc=1; q="plan_changes $action: $got, want $want"; }
    done
    [ $rc = 0 ] && break
    sleep 5
  done
  drop_work "$work"
  [ $rc = 0 ] || { log "Prometheus does not hold the run's metrics ($q)"; return 1; }
  log "Prometheus holds commit $commit's roots planned and changes by action, equal to the report"
}

claim_highlight() {
  # One run with a module bump (identical change in every root), a destroy and
  # a replacement. The destroy and the replacement are named and their roots
  # open; the bump's big group is folded.
  log() { echo "[smoke highlight] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir patches=(module-bump replace destroy) del rep big
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] && patches=(module-bump replace)   # BREAK: no destroy to name
  report_run "$work" "${patches[@]}" || true
  dir="$work/terragucci-report"
  [ -f "$dir/report.json" ] || { log "no report"; drop_work "$work"; return 1; }
  del="$(jq -r '.named[] | select(.action == "delete" and .root == "envs/staging/email") | .address' "$dir/report.json" | head -1)"
  rep="$(jq -r '.named[] | select(.action == "replace" and .root == "envs/prod/search") | .address' "$dir/report.json" | head -1)"
  [ -n "$del" ] || { log "the destroy in envs/staging/email is not named"; rc=1; }
  [ -n "$rep" ] || { log "the replacement in envs/prod/search is not named"; rc=1; }
  jq -e '.named[] | select(.action == "replace" and .root == "envs/prod/search") | .replace_paths | length > 0' "$dir/report.json" >/dev/null \
    || { log "the replacement does not say which attribute forced it"; rc=1; }
  for root in envs/staging/email envs/prod/search; do
    grep -qE "<details class=\"root\" id=\"root-$root\"[^>]* open>" "$dir/report.html" || { log "$root is not open in the HTML"; rc=1; }
  done
  big="$(jq -r '[.groups[] | select(.units | length >= 5)] | sort_by(-(.units | length)) | .[0].id // empty' "$dir/report.json")"
  if [ -z "$big" ]; then log "no group of five or more identical roots"; rc=1
  else
    jq -e --arg g "$big" '.groups[] | select(.id == $g) | .fold == "folded"' "$dir/report.json" >/dev/null || { log "group $big is not folded"; rc=1; }
    grep -qE "<details class=\"group\" id=\"group-$big\"[^>]* open>" "$dir/report.html" && { log "group $big is open in the HTML"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "named $del (delete) and $rep (replace), both roots open; group $big folded"
}

claim_drift() {
  # Staging orders' jobs queue is deleted from floci, outside Terraform. A
  # drift run, with an unapplied code change waiting on main, must report that
  # root and that queue and nothing else, and keep exactly one open issue that
  # names them. Run again it updates the issue instead of opening a second.
  # Once the example is applied again, a run finds none and closes the issue.
  # floci keeps no tags or object metadata, so a refresh-only plan shows tags
  # (and an S3 object's metadata) drifted on every root, applied or not. That is
  # the emulator, not the reading: the claim holds the deletes exact and every
  # other drifted attribute to that known set. Because tag drift never clears
  # here, the close is shown on a scratch root that has no resources.
  # BREAK: the queue is not deleted, so there is no drift to name.
  log() { echo "[smoke drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir issues n body root="envs/staging/orders" queue="shop-staging-orders-jobs"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  open_issues() { api "$URL/api/v1/repos/$USER/example/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  drift_run() { # dir -> the run's report in $1/terragucci-report; the stage keeps the issue
    mkdir -p "$1"
    local REPORT_STAGE=tf-drift
    local -a REPORT_ARGS=(--forge forgejo --report-url "http://forgejo:3000/$USER/example/actions")
    local -a REPORT_EXTRA=(-e "GITHUB_REPOSITORY=$USER/example" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN")
    if [ -n "${REPORT_TREE:-}" ]; then report_run "$1"; else report_run "$1" one-root; fi
  }
  # Start with no drift issue open, so the claim reads only this run's.
  for n in $(open_issues | jq -r '.[].number'); do
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$USER/example/issues/$n"
  done
  local deleted=""
  if [ -z "${BREAK:-}" ]; then
    TERRAGUCCI_FLOCI_URL="$FLOCI" "$EXAMPLE/changes/drift.sh" >&2 || { drop_work "$work"; return 1; }
    deleted=1
  fi
  drift_checks() {
    drift_run "$work/run1" || { log "the drift run failed"; return 1; }
    dir="$work/run1/terragucci-report"
    [ -f "$dir/report.json" ] || { log "no report"; return 1; }
    jq -e '.run.stage == "tf-drift"' "$dir/report.json" >/dev/null || { log "the report is not a tf-drift report"; rc=1; }
    # Exactly one object is gone, and it is this queue in this root.
    [ "$(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$dir/report.json")" = "$root module.service.aws_sqs_queue.jobs" ] \
      || { log "the deletes are not exactly $root's queue: $(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$dir/report.json")"; rc=1; }
    # Everything else that drifted is a tag or object metadata. Anything more would be a real
    # difference, such as dev orders' retention change that is only on main.
    [ "$(jq -r '[.roots[].changes[] | select(.action != "delete") | .attributes[].path] | unique - ["tags", "tags_all", "metadata"] | join(",")' "$dir/report.json")" = "" ] \
      || { log "attributes other than tags and metadata drifted: $(jq -r '[.roots[].changes[] | select(.action != "delete") | .attributes[].path] | unique - ["tags", "tags_all", "metadata"] | join(",")' "$dir/report.json")"; rc=1; }
    issues="$(open_issues)"
    [ "$(jq length <<<"$issues")" = 1 ] || { log "expected one open drift issue, found $(jq length <<<"$issues")"; rc=1; }
    body="$(jq -r '.[0].body // ""' <<<"$issues")"
    grep -q "$root" <<<"$body" && grep -q "$queue" <<<"$body" || { log "the issue does not name $root and $queue"; rc=1; }
    [ $rc = 0 ] || return 1

    # A second run on the same drift updates the one issue.
    drift_run "$work/run2" || { log "the second drift run failed"; return 1; }
    [ "$(open_issues | jq length)" = 1 ] || { log "a second run left $(open_issues | jq length) open issues"; return 1; }

    # The example applied again recreates the queue, so no delete is left. Only
    # staging orders changed, so only that root is applied, not all 15.
    apply_roots "$root" || { log "could not apply $root again"; return 1; }
    deleted=""
    drift_run "$work/run3" || { log "the third drift run failed"; return 1; }
    [ "$(jq '[.roots[].changes[] | select(.action == "delete")] | length' "$work/run3/terragucci-report/report.json")" = 0 ] \
      || { log "a deleted object remains after the example was applied again"; return 1; }
    # A run that finds no drift closes the issue. The scratch root has no resources, so none can drift.
    mkdir -p "$work/clean/envs/empty"
    printf 'terraform {\n  backend "local" {}\n}\n' > "$work/clean/envs/empty/main.tf"
    REPORT_TREE="$work/clean" drift_run "$work/run4" || { log "the clean drift run failed"; return 1; }
    [ "$(jq '[.roots[].changes[]] | length' "$work/run4/terragucci-report/report.json")" = 0 ] || { log "the clean run reports drift"; return 1; }
    [ "$(open_issues | jq length)" = 0 ] || { log "the drift issue is still open with no drift"; return 1; }
  }
  drift_checks || rc=1
  drop_work "$work"
  # A run that stopped before the example was applied again leaves the queue
  # deleted; put it back, so the next claim meets the example as committed.
  if [ -n "$deleted" ]; then apply_roots "$root" || log "could not apply $root again"; fi
  [ $rc = 0 ] || return 1
  log "$root and $queue named in the report and one issue; a pending change on main was not drift; a run with none closed the issue"
}

claim_tips() {
  # Dev search's AWS provider is let float to "~> 6.0". With tips on, which is
  # the default, the report carries a tip that names its rule and links the
  # rule's page, the HTML has a Tips section and the note counts them. A second
  # run with `tips: false` has none of that, and both runs have the same change
  # set digest and the same plan digest for every root.
  # BREAK: the first run turns tips off, so the report has no tip to name.
  log() { echo "[smoke tips] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 on off cfg=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/on" "$work/off"
  [ -n "${BREAK:-}" ] && cfg="tips: false"
  REPORT_CONFIG="$cfg" report_run "$work/on" float || true
  REPORT_CONFIG="tips: false" report_run "$work/off" float || true
  on="$work/on/terragucci-report"; off="$work/off/terragucci-report"
  [ -f "$on/report.json" ] && [ -f "$off/report.json" ] || { log "a run wrote no report"; drop_work "$work"; return 1; }
  jq -e '.tips[] | select(.rule == "terragucci-floating-range" and .root == "envs/dev/search" and (.url | startswith("https://")))' "$on/report.json" >/dev/null \
    || { log "the floating provider in envs/dev/search is not tipped with its rule and page"; rc=1; }
  grep -q 'id="tips"' "$on/report.html" || { log "the HTML has no Tips section"; rc=1; }
  grep -q ' tip' "$on/note.md" || { log "the note does not count the tips"; rc=1; }
  jq -e 'has("tips") | not' "$off/report.json" >/dev/null || { log "tips: false left tips in the report"; rc=1; }
  grep -q 'id="tips"' "$off/report.html" && { log "tips: false left a Tips section in the HTML"; rc=1; }
  grep -q ' tip' "$off/note.md" && { log "tips: false left a tip line in the note"; rc=1; }
  if ! diff <(jq -S '{change_set, digests: [.roots[] | {path, plan_digest}], sets: [.waves[] | .set_digest]}' "$on/report.json") \
            <(jq -S '{change_set, digests: [.roots[] | {path, plan_digest}], sets: [.waves[] | .set_digest]}' "$off/report.json") >&2; then
    log "tips changed a plan digest or a set digest"; rc=1
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "terragucci-floating-range names envs/dev/search; tips: false removes it; the digests match"
}

claim_publish() {
  # The pipeline's publish job, on a Forgejo repo: a merge to the default branch
  # publishes each changed module to a TLS registry and as a git tag, a push
  # that changes nothing publishes nothing, and a change to one module moves
  # only that module. A clone that lacks the release tags is told the version
  # is already published. BREAK: the release tags are deleted from the remote
  # between pushes, so the git-tags target has no record of the release.
  log() { echo "[smoke publish] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work port="${TERRAGUCCI_REGISTRY_PORT:-5050}" name="publish-$(date +%s)" sha out before t
  # A fresh repo and registry repository per run: the registry keeps releases
  # between runs, and a release cut from an earlier run's commit would stop this one.
  local repo="$USER/$name"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  mkdir -p "$work/certs" "$work/tree/modules/service" "$work/tree/modules/queue" "$work/tree/envs/dev"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:registry,IP:127.0.0.1" \
    -keyout "$work/certs/registry.key" -out "$work/certs/registry.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; drop_work "$work"; return 1; }
  chmod 644 "$work/certs/registry.key"
  with_lock compose env TERRAGUCCI_REGISTRY_CERTS="$work/certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile registry up -d --force-recreate registry >&2 || { drop_work "$work"; return 1; }
  local i
  for i in $(seq 1 30); do
    curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 \
    || { log "the registry did not come up"; drop_work "$work"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  # The registry takes any credentials; the job still has to be handed them.
  for t in TERRAGUCCI_REGISTRY_USER TERRAGUCCI_REGISTRY_PASSWORD; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"data":"smoke"}' "$URL/api/v1/repos/$repo/actions/secrets/$t" \
      || { log "could not set the $t secret"; drop_work "$work"; return 1; }
  done
  # The job container reaches the registry as registry:5000 on the stack network
  # and trusts its certificate from the repo's copy, a path relative to the checkout.
  local tree="$work/tree" remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  cp "$work/certs/registry.crt" "$tree/registry.crt"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  printf 'resource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'resource "terraform_data" "queue" {}\n' > "$tree/modules/queue/main.tf"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/dev.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "dev" {}\n' "$name" > "$tree/envs/dev/main.tf"
  printf 'binary: tofu\nforge: forgejo\nenv:\n  NODE_EXTRA_CA_CERTS: registry.crt\nmodules:\n  path: modules/*\n  publish:\n    - oci://registry:5000/%s\n    - git-tags\n' "$repo" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  grep -q "terragucci publish" "$tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no publish job"; drop_work "$work"; return 1; }
  tags() { curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/$repo/$1/tags/list" | jq -r '.tags // [] | sort | join(",")'; }
  gittags() { git ls-remote --tags "$remote" 'refs/tags/modules/*' | sed -E 's#.*refs/tags/##; /\^\{\}$/d' | sort | paste -sd, -; }
  run() { # message: push the tree and wait for the run on it
    sha="$(push_tree "$tree" "$repo" main "$1")"
    wait_run "$repo" "$sha"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the run for '$1' ended $RUN_STATUS"; return 1; }
  }
  run "feat: modules" || { drop_work "$work"; return 1; }
  [ "$(tags service)" = "0.1.0" ] && [ "$(tags queue)" = "0.1.0" ] || { print_logs "$repo" "$RUN_ID" >&2; log "first merge: service has '$(tags service)', queue '$(tags queue)'"; drop_work "$work"; return 1; }
  [ "$(gittags)" = "modules/queue/v0.1.0,modules/service/v0.1.0" ] || { log "first merge: the remote has tags '$(gittags)'"; drop_work "$work"; return 1; }
  # A clone without the release tags is told the version is published, and exits 0.
  git clone -q --no-tags "$remote" "$work/clone" || { drop_work "$work"; return 1; }
  printf 'modules:\n  path: modules/*\n  publish: git-tags\n' > "$work/git-only.yml"
  out="$(cd "$work/clone" && "$TERRAGUCCI" publish --config "$work/git-only.yml" 2>&1)" || { echo "$out" >&2; log "a clone without tags did not exit 0"; drop_work "$work"; return 1; }
  echo "$out" >&2
  grep -q ": published" <<<"$out" && { log "a clone without tags published again"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    for t in $(gittags | tr ',' ' '); do git -C "$tree" push -q "$remote" ":refs/tags/$t"; done
  fi
  before="$(git ls-remote --tags "$remote" 'refs/tags/modules/*' | sort)"
  run "chore: nothing changed" || { drop_work "$work"; return 1; }
  [ "$(tags service)" = "0.1.0" ] && [ "$(tags queue)" = "0.1.0" ] && [ "$(git ls-remote --tags "$remote" 'refs/tags/modules/*' | sort)" = "$before" ] \
    || { print_logs "$repo" "$RUN_ID" >&2; log "a push that changed nothing published: registry '$(tags service)' '$(tags queue)', remote tags '$(gittags)'"; drop_work "$work"; return 1; }
  printf 'output "id" { value = terraform_data.service.id }\n' > "$tree/modules/service/outputs.tf"
  run "feat(service): an id output" || { drop_work "$work"; return 1; }
  [ "$(tags service)" = "0.1.0,0.2.0" ] && [ "$(tags queue)" = "0.1.0" ] || { print_logs "$repo" "$RUN_ID" >&2; log "after a change: service has '$(tags service)', queue '$(tags queue)'"; drop_work "$work"; return 1; }
  log "the pipeline published both modules on merge, a rerun published nothing, and a change to service alone moved it to 0.2.0"
  drop_work "$work"
}

claim_rollout() {
  # One repo, three roots taking modules/network by git tag: dev/app (the
  # canary), prod/net, and prod/app, which reads prod/net's state. The module
  # changes and tf-publish tags 0.2.0. A dry run with no version must find
  # 0.2.0; then each run opens at most one wave's pull request, changing only
  # that wave's root, and never opens a wave before the last one merged and its
  # apply passed on the merge commit. BREAK: the opening runs are dry runs, so
  # no pull request opens.
  log() { echo "[smoke rollout] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout" mode=apply out rc pr sha n files
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d '{"name":"rollout","private":false,"auto_init":false,"default_branch":"main"}' "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"

  local tree="$work/tree" remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  local source="git::http://forgejo:3000/$repo.git//modules/network?ref=modules/network/v0.1.0"
  mkdir -p "$tree/modules/network" "$tree/dev/app" "$tree/prod/net" "$tree/prod/app"
  printf 'variable "name" {}\n\noutput "name" {\n  value = var.name\n}\n' > "$tree/modules/network/main.tf"
  root() { # dir, state key, extra
    printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "rollout/%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\n%bmodule "network" {\n  source = "%s"\n  name   = "%s"\n}\n\noutput "name" {\n  value = module.network.name\n}\n' "$2" "$3" "$source" "$2" > "$tree/$1/main.tf"
  }
  root dev/app dev-app ""
  root prod/net prod-net ""
  root prod/app prod-app 'data "terraform_remote_state" "net" {\n  backend = "s3"\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "rollout/prod-net.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\n'
  printf 'binary: tofu\nforge: forgejo\nurl: %s/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\nwaves:\n  canary: ["dev/*"]\nmodules:\n  path: modules/*\n  publish: git-tags\n' "$URL" "$repo" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  ( cd "$tree" && git init -q -b main && git remote add origin "$remote" && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat: three roots on modules/network 0.1.0" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m "modules/network 0.1.0" \
    && git push -q origin refs/tags/modules/network/v0.1.0 main ) 2>/dev/null || { log "could not push the repo"; drop_work "$work"; return 1; }
  sha="$(git -C "$tree" rev-parse HEAD)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the first apply ended $RUN_STATUS"; drop_work "$work"; return 1; }

  # A new module version, published by tf-publish as a git tag.
  printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> "$tree/modules/network/main.tf"
  ( cd "$tree" && git add -A && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat(network): a version output" \
    && git push -q origin main ) 2>/dev/null || { drop_work "$work"; return 1; }
  wait_run "$repo" "$(git -C "$tree" rev-parse HEAD)"
  (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" publish) >&2 || { drop_work "$work"; return 1; }

  ro() { (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout modules/network "$@" 2>&1); }
  out="$(ro)" || { echo "$out" >&2; drop_work "$work"; return 1; }
  echo "$out" >&2
  grep -q "modules/network 0.1.0 -> 0.2.0 (newest published: tag modules/network/v0.2.0): would-open" <<<"$out" \
    || { log "the dry run did not find 0.2.0 on its own"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && mode=dry-run

  pr_for() { api "$URL/api/v1/repos/$repo/pulls?state=all&limit=50" | jq -r --arg b "terragucci/rollout/modules-network-0.2.0/wave-$1" '.[] | select(.head.ref == $b) | .number' | head -1; }
  local wave expect=("" "dev/app/main.tf" "prod/net/main.tf" "prod/app/main.tf")
  for wave in 1 2 3; do
    out="$(ro --mode "$mode")"; rc=$?
    echo "$out" >&2
    pr="$(pr_for "$wave")"
    [ -n "$pr" ] || { log "wave $wave: no pull request opened"; drop_work "$work"; return 1; }
    files="$(api "$URL/api/v1/repos/$repo/pulls/$pr/files" | jq -r '[.[].filename] | join(",")')"
    [ "$files" = "${expect[$wave]}" ] || { log "wave $wave's pull request changes '$files', not ${expect[$wave]}"; drop_work "$work"; return 1; }
    # Open: the next run waits and opens nothing.
    out="$(ro --mode "$mode")"; rc=$?
    [ $rc = 3 ] && [ -z "$(pr_for $((wave + 1)))" ] || { echo "$out" >&2; log "wave $wave open: exit $rc, or the next wave opened"; drop_work "$work"; return 1; }
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
    sha="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merge_commit_sha)"
    # Merged, apply not yet reported: still nothing opens.
    out="$(ro --mode "$mode")"; rc=$?
    if [ -n "$(pr_for $((wave + 1)))" ]; then
      n="$(api "$URL/api/v1/repos/$repo/commits/$sha/statuses" | jq -r '[.[] | select(.context | test("/ apply"))] | max_by(.id) | .status // "none"')"
      [ "$n" = success ] || { echo "$out" >&2; log "wave $((wave + 1)) opened while wave $wave's apply was '$n'"; drop_work "$work"; return 1; }
    fi
    wait_run "$repo" "$sha"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "wave $wave's apply ended $RUN_STATUS"; drop_work "$work"; return 1; }
  done
  out="$(ro --mode "$mode")"; rc=$?
  echo "$out" >&2
  drop_work "$work"
  [ $rc = 0 ] && grep -q ": complete" <<<"$out" || { log "after three waves the rollout is not complete (exit $rc)"; return 1; }
  log "0.2.0 found from its tag; three waves, one pull request each moving only its root, each opened only after the last applied"
}

# ── responses to pipeline events ──────────────────────────────────────────
# `terragucci respond <event>` runs in the tofu CI image on the stack's
# network, with the bundle built from this tree, against floci and a scratch
# Forgejo repo per claim. Nothing here needs the example booted.

# Unique to this process too: the runner may start two claims in one second.
STAMP="$(date +%s)$$"

# A new, empty Forgejo repo under the admin user; returns 1 if it never settles.
fresh_repo() { # name
  local repo="$USER/$1" i
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; echo "$1 never answered $2" >&2; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$1\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  settle "repos/$repo" 200
}

# Run a command in the tofu CI image, in DIR, with terragucci built from this tree.
in_image() { # dir, command...
  local dir="$1" image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"; shift
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  [ -f "$bundle" ] || build_cli || return 1
  docker run --rm --network terragucci -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" "$@"
}

# A tree with one root and a terragucci.yml that names the scratch repo, its
# origin the repo as the stack's network reaches it. Leaves it in $1/tree.
respond_tree() { # work, repo, main.tf
  local tree="$1/tree"
  mkdir -p "$tree/app"
  printf '%s\n' "$3" > "$tree/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/app/"
  printf 'binary: tofu\nforge: forgejo\nurl: http://forgejo:3000/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' "$2" > "$tree/terragucci.yml"
  git -C "$tree" init -q -b main
  git -C "$tree" remote add origin "http://$USER:$TOKEN@forgejo:3000/$2.git"
}

respond_root() { # state key, body
  printf 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nprovider "aws" {\n  region            = "us-east-1"\n  s3_use_path_style = true\n}\n\n%s' "$1" "$2"
}

sqs() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: AmazonSQS.$1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }

open_pr() { # repo, branch -> the open pull request's number, or nothing
  api "$URL/api/v1/repos/$1/pulls?state=open&limit=50" | jq -r --arg b "$2" '.[] | select(.head.ref == $b) | .number' | head -1
}

pr_files() { # repo, number
  api "$URL/api/v1/repos/$1/pulls/$2/files" | jq -r '[.[].filename] | sort | join(",")'
}

claim_respond_refused() {
  # Plan the example, then plan it again with the replace scenario. The
  # wave-refused response must name envs/prod/search alone, and hash_key as
  # what moved in it. BREAK: the second plan has no change, so nothing moved.
  log() { echo "[smoke respond-refused] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work out patches=(replace)
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] && patches=()
  mkdir -p "$work/approved" "$work/current"
  report_run "$work/approved" || true
  report_run "$work/current" "${patches[@]}" || true
  out="$(cd "$work/current" && "$TERRAGUCCI" respond wave-refused --approved "$work/approved/terragucci-report" --current terragucci-report --json)" || { drop_work "$work"; return 1; }
  drop_work "$work" 2>/dev/null || true
  jq -r .results.text <<<"$out" >&2
  [ "$(jq -c '[.results.data.roots[].root]' <<<"$out")" = '["envs/prod/search"]' ] || { log "expected envs/prod/search alone to have moved"; return 1; }
  jq -e '[.results.data.roots[0].changes[].attributes[]] | index("hash_key")' <<<"$out" >/dev/null || { log "hash_key is not named"; return 1; }
  log "envs/prod/search moved, and hash_key with it"
}

claim_respond_triage() {
  # An apply that meets a state lock someone else holds fails, and the triage
  # names it as a state lock with its fix. BREAK: no lock, so the apply passes
  # and there is nothing to triage.
  log() { echo "[smoke respond-triage] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work key="respond/triage-$STAMP.tfstate" out
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/app"
  respond_root "$key" 'resource "terraform_data" "mark" {}' > "$work/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$work/app/"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  [ -z "${BREAK:-}" ] && curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' \
    -d "{\"ID\":\"smoke-$STAMP\",\"Operation\":\"OperationTypeApply\",\"Info\":\"\",\"Who\":\"smoke@stack\",\"Version\":\"1.12.0\",\"Created\":\"2026-01-01T00:00:00Z\",\"Path\":\"shop-terraform-state/$key\"}" \
    "$FLOCI/shop-terraform-state/$key.tflock"
  in_image "$work" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color -lock-timeout=0s' > "$work/apply.log" 2>&1 || true
  tail -20 "$work/apply.log" >&2
  out="$(in_image "$work" terragucci respond apply-failed --log apply.log --json)" || { drop_work "$work" 2>/dev/null; return 1; }
  drop_work "$work" 2>/dev/null || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key.tflock" || true
  jq -r .results.text <<<"$out" >&2
  [ "$(jq -r '.results.data.known[0].class // empty' <<<"$out")" = state-lock ] || { log "the failure was not triaged as a state lock"; return 1; }
  log "the failed apply was triaged as a state lock, with its fix"
}

claim_respond_drift() {
  # A root with a literal visibility timeout is applied; then the queue's
  # timeout is changed in floci, and another queue is made there by hand. The
  # drift response must open one pull request that writes the live timeout
  # into main.tf and adds an import block and generated config for the other
  # queue. BREAK: no drift and no import, so no pull request opens.
  log() { echo "[smoke respond-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/respond-drift" queue="tg-drift-$STAMP" extra="tg-drift-$STAMP-extra" url xurl out pr files args=()
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo respond-drift || return 1
  respond_tree "$work" "$repo" "$(respond_root "respond/drift-$STAMP.tfstate" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
}")"
  push_tree "$work/tree" "$repo" main "a queue with a literal timeout" >/dev/null || return 1
  in_image "$work/tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the first apply failed"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r .QueueUrl)"
    sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null
    xurl="$(sqs CreateQueue "{\"QueueName\":\"$extra\"}" | jq -r .QueueUrl)"
    args=(--import "aws_sqs_queue.extra=$xurl")
  fi
  out="$(in_image "$work/tree" terragucci respond drift --root app --mode apply "${args[@]}" 2>&1)" || { echo "$out" >&2; drop_work "$work" 2>/dev/null; return 1; }
  echo "$out" >&2
  drop_work "$work" 2>/dev/null || true
  pr="$(open_pr "$repo" terragucci/drift)"
  [ -n "$pr" ] || { log "no drift pull request"; return 1; }
  files="$(pr_files "$repo" "$pr")"
  [ "$files" = "app/main.tf,app/terragucci_generated.tf,app/terragucci_imports.tf" ] || { log "the pull request changes $files"; return 1; }
  api "$URL/api/v1/repos/$repo/raw/app/main.tf?ref=terragucci%2Fdrift" | grep -q 'visibility_timeout_seconds = 45' || { log "main.tf on the branch does not hold the live timeout"; return 1; }
  api "$URL/api/v1/repos/$repo/raw/app/terragucci_generated.tf?ref=terragucci%2Fdrift" | grep -q "$extra" || { log "the generated config does not name $extra"; return 1; }
  log "pull request $pr writes the live timeout and imports $extra"
}

claim_respond_tips() {
  # Two roots: dev takes the AWS provider by a range, prod has no lock file,
  # and the config names no canary. The repo commits the pipeline init writes
  # and pushes to main: after the applies, its tips job must open three pull
  # requests, one per tip, each changing only its own files. BREAK: the repo
  # follows every tip already, so the tips job opens nothing.
  log() { echo "[smoke respond-tips] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/respond-tips" tree sha pr branch want i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo respond-tips || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  respond_tree "$work" "$repo" ""
  tree="$work/tree"
  rm -rf "$tree/app"
  mkdir -p "$tree/envs/dev/app" "$tree/envs/prod/app"
  respond_root "respond/tips-dev.tfstate" "" | sed 's/version = "6.67.0"/version = "~> 6.0"/' > "$tree/envs/dev/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/envs/dev/app/"
  respond_root "respond/tips-prod.tfstate" "" > "$tree/envs/prod/app/main.tf"
  # The tips job opens its pull requests with the job's own token.
  printf 'binary: tofu\nforge: forgejo\n' > "$tree/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    respond_root "respond/tips-dev.tfstate" "" > "$tree/envs/dev/app/main.tf"
    cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/envs/prod/app/"
    printf 'waves:\n  canary: ["envs/dev/*"]\n' >> "$tree/terragucci.yml"
  fi
  for key in respond/tips-dev.tfstate respond/tips-prod.tfstate; do curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true; done
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  grep -q 'terragucci respond tips' "$tree/.forgejo/workflows/terragucci.yml" || { log "the pipeline has no tips job"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "two roots")"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { log "the run ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; return 1; }
  print_logs "$repo" "$RUN_ID" | grep -A12 'terragucci respond tips' >&2 || true
  for want in "terragucci/tip/pin-hashicorp-aws|envs/dev/app/main.tf" "terragucci/tip/lock-files|envs/prod/app/.terraform.lock.hcl" "terragucci/tip/canary|terragucci.yml"; do
    branch="${want%%|*}"
    pr="$(open_pr "$repo" "$branch")"
    [ -n "$pr" ] || { log "no pull request from $branch"; rc=1; continue; }
    [ "$(pr_files "$repo" "$pr")" = "${want#*|}" ] || { log "$branch changes $(pr_files "$repo" "$pr"), not ${want#*|}"; rc=1; }
  done
  [ $rc = 0 ] && log "the pipeline's tips job opened three pull requests, each changing only its own file"
  return $rc
}

claim_respond_fmt() {
  # A pull request's branch carries an unformatted file. fmt on request must
  # push one commit to that branch, formatting it, and leave main alone.
  # BREAK: a dry run, which commits nothing.
  log() { echo "[smoke respond-fmt] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/respond-fmt" main_sha head subject mode=apply out
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo respond-fmt || return 1
  respond_tree "$work" "$repo" "$(respond_root "respond/fmt.tfstate" "")"
  main_sha="$(push_tree "$work/tree" "$repo" main "formatted")" || return 1
  printf 'locals {\n    team   = "orders"\n  owner = "shop"\n}\n' > "$work/tree/app/locals.tf"
  push_tree "$work/tree" "$repo" smoke-fmt "unformatted" >/dev/null || return 1
  [ -n "${BREAK:-}" ] && mode=dry-run
  out="$(in_image "$work/tree" terragucci respond fmt --branch smoke-fmt --mode "$mode" 2>&1)" || { echo "$out" >&2; drop_work "$work" 2>/dev/null; return 1; }
  echo "$out" >&2
  drop_work "$work" 2>/dev/null || true
  subject="$(api "$URL/api/v1/repos/$repo/branches/smoke-fmt" | jq -r '.commit.message' | head -1)"
  [ "$subject" = "style: tofu fmt" ] || { log "the branch's last commit is '$subject'"; return 1; }
  api "$URL/api/v1/repos/$repo/raw/app/locals.tf?ref=smoke-fmt" | grep -q '^  team  = "orders"$' || { log "locals.tf is not formatted on the branch"; return 1; }
  head="$(api "$URL/api/v1/repos/$repo/branches/main" | jq -r .commit.id)"
  [ "$head" = "$main_sha" ] || { log "main moved"; return 1; }
  log "one fmt commit on smoke-fmt; main untouched"
}

claim_respond_notes() {
  # A module released twice; the notes for the second release come from its
  # conventional commits, breaking change first. BREAK: the commits do not
  # follow the convention, so nothing is marked breaking.
  log() { echo "[smoke respond-notes] $*" >&2; }
  local work out c=(git -c user.name=t -c user.email=t@t -c commit.gpgsign=false) feat="feat(net)!: rename the queue output" fix="fix(net): tag the queue"
  [ -n "${BREAK:-}" ] && { feat="rename the queue output"; fix="tag the queue"; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/modules/net"
  ( cd "$work" && git init -q -b main && echo '# net' > modules/net/main.tf && git add -A && "${c[@]}" commit -qm "feat: the net module" \
    && git tag modules/net/v0.1.0 && echo '# tags' >> modules/net/main.tf && "${c[@]}" commit -qam "$fix" \
    && echo '# output' >> modules/net/main.tf && "${c[@]}" commit -qam "$feat" && git tag modules/net/v1.0.0 ) || { drop_work "$work"; return 1; }
  out="$(cd "$work" && "$TERRAGUCCI" respond publish --json)" || { drop_work "$work"; return 1; }
  drop_work "$work"
  jq -r .results.text <<<"$out" >&2
  jq -e '.results.data[0] | .version == "1.0.0" and .previous == "0.1.0" and (.notes | test("### Breaking changes\n\n- net: rename the queue output")) and (.notes | test("### Fixes"))' <<<"$out" >/dev/null \
    || { log "the 1.0.0 notes do not lead with the breaking change and list the fix"; return 1; }
  log "1.0.0's notes name the breaking change and the fix"
}

# ── the Terragrunt example's claims ──────────────────────────────────────

TG_EXAMPLE="$(cd "$HERE/../example-terragrunt" && pwd)"
TG_REPO_NAME=example-terragrunt

tg_image() { image_tag terragrunt; }

# The plan stage on a copy of the Terragrunt example, run in the CI image the
# way the plan job runs it: the base is the example as committed, the head is
# the base plus the named patches. REPORT_CONFIG is appended to terragucci.yml;
# TG_EDIT is a shell command run in the copy before the head commit.
# TG_STAGE names another stage (tf-drift); TG_RUN_EXTRA holds more `docker run`
# arguments and TG_STAGE_ARGS more stage arguments.
TG_RUN_EXTRA=()
TG_STAGE_ARGS=()
tg_report_run() { # work, patches...
  local work="$1"; shift
  local image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" p base rc=0
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example-terragrunt up' first" >&2; return 1; }
  build_cli || return 1
  cp -R "$TG_EXAMPLE/." "$work/"
  rm -rf "$work/.git"
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm base
  base="$(git -C "$work" rev-parse HEAD)"
  for p in "$@"; do git -C "$work" apply "$TG_EXAMPLE/changes/$p.patch" || return 1; done
  [ -n "${REPORT_CONFIG:-}" ] && printf '%s\n' "$REPORT_CONFIG" >> "$work/terragucci.yml"
  [ -n "${TG_EDIT:-}" ] && (cd "$work" && eval "$TG_EDIT")
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke $(date +%s%N)"
  docker run --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true \
    -e TG_BASE="${TG_BASE_OVERRIDE-$base}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${TG_RUN_EXTRA[@]+"${TG_RUN_EXTRA[@]}"} \
    "$image" terragucci stage "${TG_STAGE:-tf-plan}" --terragrunt --binary tofu ${TG_STAGE_ARGS[@]+"${TG_STAGE_ARGS[@]}"} >&2 || rc=$?
  clean_mounted "$work" "$image"
  return $rc
}

# The last run on the Terragrunt example's main, and one of its jobs' whole log.
tg_main_job_log() { # job name
  local run job
  run="$(api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/runs?branch=main" | jq -r '.workflow_runs[0].id')"
  job="$(api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/runs/$run/jobs" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id' | head -1)"
  api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/jobs/$job/logs"
}

# Apply some of the Terragrunt example's units as committed, each alone in
# the CI image. The reset a claim needs when it changed one unit's resources,
# instead of re-applying all 15 through the pipeline.
tg_apply_units() { # unit...
  local work image unit
  image="$(tg_image)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$TG_EXAMPLE/." "$work/"
  for unit in "$@"; do
    docker run --rm --network terragucci -v "$work:/repo" -w /repo \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true \
      "$image" terragrunt run --working-dir "$unit" -- apply -auto-approve -input=false -no-color >&2 || { drop_work "$work"; return 1; }
  done
  drop_work "$work"
}

# Put the Terragrunt example's main back to the example as committed, for a
# claim that pushed to main and has already put floci back itself. The commit
# asks the forge to skip CI, since there is nothing left to apply; if a run
# starts anyway, wait for it, so it cannot apply under the next claim.
tg_restore_main() {
  local work sha i n repo="$USER/$TG_REPO_NAME"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null || { drop_work "$work"; return 1; }
  find "$work/tree" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$TG_EXAMPLE/." "$work/tree/"
  sha="$(push_tree "$work/tree" "$repo" main "Reset to the example as committed [skip ci]")" || { drop_work "$work"; return 1; }
  drop_work "$work"
  for i in 1 2 3 4 5; do
    sleep 2
    n="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" 2>/dev/null | jq -r '.workflow_runs | length' 2>/dev/null || true)"
    if [ -n "$n" ] && [ "$n" != 0 ]; then wait_run "$repo" "$sha"; break; fi
  done
  return 0
}

claim_tg_zero_config() {
  # The example with its pipeline removed: init must find Terragrunt from
  # root.hcl and the 15 units, with no roots setting, and write exactly the
  # committed pipeline. BREAK: an exclude drops prod, so the units differ.
  local work rc=0 out
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$TG_EXAMPLE/." "$work/"
  rm -f "$work/.forgejo/workflows/terragucci.yml"
  [ -n "${BREAK:-}" ] && printf 'terragrunt:\n  exclude: ["live/prod/**"]\n' >> "$work/terragucci.yml"
  out="$(cd "$work" && "$TERRAGUCCI" init 2>&1)" || rc=1
  echo "$out" >&2
  grep -q "found Terragrunt (root.hcl): 15 units" <<<"$out" || { echo "[smoke tg-zero-config] init did not find 15 Terragrunt units" >&2; rc=1; }
  if [ $rc = 0 ] && ! diff -u "$TG_EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/.forgejo/workflows/terragucci.yml" >&2; then
    echo "[smoke tg-zero-config] init wrote a different pipeline" >&2
    rc=1
  fi
  drop_work "$work"
  return $rc
}

claim_tg_waves() {
  # Boot the example: every resource the units declare reaches floci, and the
  # apply job runs two waves, every dev unit's apply finishing before the
  # first staging or prod apply. BREAK: the pipeline is written with no
  # canary, so everything applies in one wave.
  log() { echo "[smoke tg-waves] $*" >&2; }
  local work="" rc=0 logs first_other last_dev
  if [ -n "${BREAK:-}" ]; then
    work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
    cp -R "$TG_EXAMPLE/." "$work/"
    printf 'binary: tofu\n' > "$work/terragucci.yml"
    (cd "$work" && "$TERRAGUCCI" init >/dev/null) || { drop_work "$work"; return 1; }
    TG_PIPELINE="$work/.forgejo/workflows/terragucci.yml" TG_CONFIG="$work/terragucci.yml" "$HERE/example-terragrunt.sh" up >&2 || rc=1
  else
    "$HERE/example-terragrunt.sh" up >&2 || rc=1
  fi
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  if [ $rc = 0 ]; then
    logs="$(tg_main_job_log apply)"
    grep -q "wave 1: 5 units" <<<"$logs" && grep -q "wave 2: 10 units" <<<"$logs" || { log "the apply job did not run a 5-unit canary wave and a 10-unit wave"; rc=1; }
    last_dev="$(grep -n '\[live/dev/[a-z]*\] tofu: Apply complete' <<<"$logs" | tail -1 | cut -d: -f1)"
    first_other="$(grep -nE '\[live/(staging|prod)/[a-z]*\] tofu: Apply complete' <<<"$logs" | head -1 | cut -d: -f1)"
    [ -n "$last_dev" ] && [ -n "$first_other" ] && [ "$last_dev" -lt "$first_other" ] \
      || { log "dev's applies did not all finish before the first staging or prod apply (last dev line ${last_dev:-none}, first other ${first_other:-none})"; rc=1; }
  fi
  # The BREAK run left every unit applied and main carrying the no-canary
  # pipeline: put main back. The runner runs this claim's BREAK before its plain
  # run, whose `up` pushes the example to a fresh repo, and then says so with
  # SMOKE_PLAIN_NEXT=1, so there is nothing to put back.
  if [ -n "$work" ]; then
    drop_work "$work"
    [ -n "${SMOKE_PLAIN_NEXT:-}" ] || tg_restore_main || true
  fi
  [ $rc = 0 ] && log "15 units applied to floci, the 5 dev units first, then the other 10"
  return $rc
}

claim_tg_check() {
  # A clean branch goes green; the same branch plus an unformatted .hcl file
  # goes red with the file named. BREAK: the "clean" branch carries the file.
  log() { echo "[smoke tg-check] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/$TG_REPO_NAME" work sha logs bad='locals {
    team   = "orders"
  owner = "shop"
}'
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example-terragrunt up' first"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && echo "$bad" > "$work/tree/live/dev/orders/owner.hcl"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke tg-check: clean $(date +%s)")"
  wait_run "$repo" "$sha"
  if [ "$RUN_STATUS" != success ]; then log "the clean push ended '$RUN_STATUS'"; drop_work "$work"; return 1; fi
  echo "$bad" > "$work/tree/live/dev/orders/owner.hcl"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke tg-check: unformatted $(date +%s)")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fcheck" || true
  drop_work "$work"
  [ "$RUN_STATUS" = failure ] || { log "the unformatted push ended '$RUN_STATUS'"; return 1; }
  grep -q "owner.hcl" <<<"$logs" || { log "the run failed but its log does not name owner.hcl"; return 1; }
  log "the unformatted push failed at the format check and named live/dev/orders/owner.hcl"
}

claim_tg_affected() {
  # module-bump changes only modules/service/policy.json, which the module
  # reads with file(). Terragrunt's git filter misses it; the plan must cover
  # the 12 service units, each saying why, and none of the 3 platform units.
  # BREAK: no base, so every unit is planned.
  log() { echo "[smoke tg-affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 r n
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then TG_BASE_OVERRIDE="" tg_report_run "$work" module-bump || true; else tg_report_run "$work" module-bump || true; fi
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; drop_work "$tree"; return 1; }
  n="$(jq '[.roots[] | select(.status == "planned")] | length' "$r")"
  [ "$n" = 12 ] || { log "$n units planned, not the 12 services"; rc=1; }
  jq -e '[.roots[] | select(.path | endswith("/platform"))] | length == 0' "$r" >/dev/null || { log "a platform unit was planned"; rc=1; }
  jq -e '[.roots[] | select(.terragrunt.selection | test("policy.json"))] | length == 12' "$r" >/dev/null || { log "not every service names policy.json as its reason"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "12 service units planned for policy.json, no platform unit"
  return $rc
}

claim_tg_mock_lint() {
  # prod email's dependency has mocks and no allow-list, so they could stand in
  # for apply. The report's tips name it as TF041 with the rule's page.
  # BREAK: prod email gets an allow-list first, so there is nothing to name.
  log() { echo "[smoke tg-mock-lint] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 edit=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] && edit="sed -i.bak 's|^  mock_outputs = {|  mock_outputs_allowed_terraform_commands = [\"validate\", \"plan\"]\n  mock_outputs = {|' live/prod/email/terragrunt.hcl && rm live/prod/email/terragrunt.hcl.bak"
  TG_EDIT="$edit" tg_report_run "$work" one-unit || true
  jq -e '.tips[] | select(.rule == "TF041" and .root == "live/prod/email" and (.url | startswith("https://")))' "$work/terragucci-report/report.json" >/dev/null 2>&1 \
    || { log "no TF041 tip names live/prod/email"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "TF041 names live/prod/email, whose mocks have no allow-list"
  return $rc
}

claim_tg_refuse() {
  # new-service adds ledger and billing, which reads ledger's outputs. Ledger
  # has none yet, so billing's plan would stand on its mocks: billing must not
  # be planned, and the report must say it waits for ledger. Ledger plans.
  # BREAK: ledger is applied first, so billing has real outputs and plans; the
  # claim must notice billing was not held back.
  log() { echo "[smoke tg-refuse] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 r tree
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    tree="$work/ledger"; cp -R "$TG_EXAMPLE/." "$tree/"; git -C "$tree" init -q; git -C "$tree" apply "$TG_EXAMPLE/changes/new-service.patch"
    TG_TREE="$tree" "$HERE/example-terragrunt.sh" tg run --working-dir live/dev/ledger -- apply -auto-approve >&2 || true
  fi
  mkdir -p "$work/run"
  tg_report_run "$work/run" new-service || true
  r="$work/run/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; rc=1; }
  if [ $rc = 0 ]; then
    jq -e '.roots[] | select(.path == "live/dev/ledger" and .status == "planned")' "$r" >/dev/null || { log "ledger was not planned"; rc=1; }
    jq -e '[.roots[] | select(.path == "live/dev/billing" and (.terragrunt.provisional | not))] | length == 0' "$r" >/dev/null || { log "billing was planned as real, on mock_outputs or ahead of ledger"; rc=1; }
    jq -e '.deferred[] | select(.unit == "live/dev/billing" and (.after | index("live/dev/ledger")))' "$r" >/dev/null || { log "the report does not say billing waits for ledger"; rc=1; }
    jq -e '.mock_reads[] | select(.unit == "live/dev/billing" and .upstream == "live/dev/ledger" and .reason == "no-outputs")' "$r" >/dev/null || { log "the report names no mock read for billing"; rc=1; }
  fi
  if [ -n "${BREAK:-}" ]; then
    TG_TREE="$tree" "$HERE/example-terragrunt.sh" tg run --working-dir live/dev/ledger -- destroy -auto-approve >&2 || true
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/terragrunt/live/dev/ledger/terraform.tfstate" || true
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "ledger planned; billing held back until ledger applies, with the mock read named"
  return $rc
}

claim_tg_mock_trap() {
  # Merge new-service to main. The apply job applies ledger before billing in
  # one run --all, so billing's state holds ledger's real bucket and no mock
  # value. BREAK: the pushed pipeline ignores Terragrunt's order, so billing
  # can run before ledger has outputs and take the mock, or fail.
  log() { echo "[smoke tg-mock-trap] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/$TG_REPO_NAME" work sha rc=0 state
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example-terragrunt up' first"; drop_work "$work"; return 1; }
  git -C "$work/tree" apply "$TG_EXAMPLE/changes/new-service.patch" || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && sed -i.bak 's#terragrunt run --all --no-color --no-filters-file#terragrunt run --all --no-color --no-filters-file --queue-ignore-dag-order#' "$work/tree/.forgejo/workflows/terragucci.yml" && rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  sha="$(push_tree "$work/tree" "$repo" main "smoke tg-mock-trap: add billing and its ledger $(date +%s)")"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { log "the apply ended '$RUN_STATUS'"; rc=1; }
  state="$(curl -fsS "$FLOCI/shop-terraform-state/terragrunt/live/dev/billing/terraform.tfstate" || true)"
  grep -q '"shop-tg-dev-ledger"' <<<"$state" || { log "billing's state does not name the ledger bucket"; rc=1; }
  grep -q 'mock-' <<<"$state" && { log "billing's state holds a mock value"; rc=1; }
  # Put the estate back: billing and ledger destroyed, their state gone, main as committed.
  TG_TREE="$work/tree" "$HERE/example-terragrunt.sh" tg run --all --no-filters-file --filter '{./live/dev/billing}' --filter '{./live/dev/ledger}' -- destroy -auto-approve >&2 || true
  for u in billing ledger; do curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/terragrunt/live/dev/$u/terraform.tfstate" || true; done
  tg_restore_main || true
  drop_work "$work"
  [ $rc = 0 ] && log "ledger applied before billing; billing's state names shop-tg-dev-ledger and holds no mock"
  return $rc
}

claim_tg_drift() {
  # The Terragrunt example is applied (run 'just example-terragrunt up' first).
  # Staging orders' jobs queue is deleted from floci, outside Terraform. A
  # tf-drift run over every unit, one refresh-only run --all per wave, must
  # report that unit and that queue as the only delete, and keep exactly one
  # open drift issue that names them. Run again it updates the issue.
  # floci keeps no tags or object metadata, so every unit shows tag and
  # metadata drift; the claim holds the deletes exact and every other drifted
  # attribute to that known set, as claim_drift does.
  # BREAK: the queue is not deleted, so there is no drift to name.
  log() { echo "[smoke tg-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 n issues body r unit="live/staging/orders" queue="shop-tg-staging-orders-jobs" repo="$USER/$TG_REPO_NAME" deletes extra
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  open_issues() { api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  drift_run() { # dir -> the run's report in $1/terragucci-report; the stage keeps the issue
    local TG_STAGE=tf-drift
    local -a TG_STAGE_ARGS=(--forge forgejo --report-url "http://forgejo:3000/$repo/actions")
    local -a TG_RUN_EXTRA=(-e "GITHUB_REPOSITORY=$repo" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN")
    mkdir -p "$1"
    tg_report_run "$1"
  }
  for n in $(open_issues | jq -r '.[].number'); do
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$repo/issues/$n"
  done
  local deleted=""
  if [ -z "${BREAK:-}" ]; then
    extra="$(curl -fsS -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.GetQueueUrl' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')" || extra=""
    [ -n "$extra" ] || { log "$queue is not in floci; run 'just example-terragrunt up' first"; drop_work "$work"; return 1; }
    curl -fsS -o /dev/null -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.DeleteQueue' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueUrl\":\"$extra\"}" || { drop_work "$work"; return 1; }
    deleted=1
  fi

  r="$work/run1/terragucci-report/report.json"
  if ! drift_run "$work/run1"; then log "the drift run failed"; rc=1
  elif [ ! -f "$r" ]; then log "no report"; rc=1
  else
    jq -e '.run.stage == "tf-drift"' "$r" >/dev/null || { log "the report is not a tf-drift report"; rc=1; }
    deletes="$(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$r")"
    [ "$deletes" = "$unit aws_sqs_queue.jobs" ] || { log "the deletes are not exactly $unit's queue: $deletes"; rc=1; }
    [ "$(jq -r '[.roots[].changes[] | select(.action != "delete") | .attributes[].path] | unique - ["tags", "tags_all", "metadata"] | join(",")' "$r")" = "" ] \
      || { log "attributes other than tags and metadata drifted"; rc=1; }
    issues="$(open_issues)"
    [ "$(jq length <<<"$issues")" = 1 ] || { log "expected one open drift issue, found $(jq length <<<"$issues")"; rc=1; }
    body="$(jq -r '.[0].body // ""' <<<"$issues")"
    grep -q "$unit" <<<"$body" && grep -q "$queue" <<<"$body" || { log "the issue does not name $unit and $queue"; rc=1; }
    if [ $rc = 0 ]; then
      drift_run "$work/run2" || { log "the second drift run failed"; rc=1; }
      [ "$(open_issues | jq length)" = 1 ] || { log "a second run left $(open_issues | jq length) open issues"; rc=1; }
    fi
  fi
  drop_work "$work"
  # Put back what the claim changed: the one queue, by applying its unit alone
  # rather than the whole example through the pipeline.
  if [ -n "$deleted" ]; then tg_apply_units "$unit" || log "could not apply $unit again"; fi
  [ $rc = 0 ] && log "$unit and $queue named, one issue kept, a second run updated it"
  return $rc
}

claim_fresh_plan() {
  # Two roots nothing has applied are added: fresh-net, and fresh-app, which
  # reads fresh-net's state. The plan job must stay green, plan fresh-net, not
  # plan fresh-app, and say in the report and the note that fresh-app waits
  # for fresh-net. BREAK: fresh-app reads dev's platform state, which is
  # applied, so the upstream counts as applied and fresh-app plans.
  log() { echo "[smoke fresh-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 run=0 r net=envs/dev/fresh-net app=envs/dev/fresh-app key=envs/dev/fresh-net.tfstate edit
  [ -n "${BREAK:-}" ] && key=envs/dev/platform.tfstate
  edit="mkdir -p $net $app
cat > $net/main.tf <<'TF'
terraform {
  required_version = \"~> 1.13.0\"

  backend \"s3\" {
    bucket         = \"shop-terraform-state\"
    key            = \"envs/dev/fresh-net.tfstate\"
    region         = \"us-east-1\"
    use_lockfile   = true
    use_path_style = true
  }
}

output \"logs_bucket\" {
  value = \"shop-dev-fresh\"
}
TF
cat > $app/main.tf <<TF
terraform {
  required_version = \"~> 1.13.0\"

  backend \"s3\" {
    bucket         = \"shop-terraform-state\"
    key            = \"envs/dev/fresh-app.tfstate\"
    region         = \"us-east-1\"
    use_lockfile   = true
    use_path_style = true
  }
}

data \"terraform_remote_state\" \"net\" {
  backend = \"s3\"
  config = {
    bucket         = \"shop-terraform-state\"
    key            = \"$key\"
    region         = \"us-east-1\"
    use_path_style = true
  }
}

output \"seen\" {
  value = data.terraform_remote_state.net.outputs.logs_bucket
}
TF"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  # The fresh estate has no state for either new root: clear any a past run left.
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/envs/dev/fresh-net.tfstate" || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/envs/dev/fresh-app.tfstate" || true
  REPORT_BASE=1 REPORT_EDIT="$edit" report_run "$work" || run=$?
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; drop_work "$tree"; return 1; }
  [ "$run" = 0 ] || { log "the plan job exited $run, so it is not green"; rc=1; }
  jq -e --arg n "$net" '.roots[] | select(.path == $n and .status == "planned")' "$r" >/dev/null || { log "$net was not planned"; rc=1; }
  jq -e --arg a "$app" '[.roots[] | select(.path == $a)] | length == 0' "$r" >/dev/null || { log "$app was planned though its upstream is unapplied"; rc=1; }
  jq -e --arg a "$app" --arg n "$net" '.deferred[] | select(.unit == $a and (.after | index($n)))' "$r" >/dev/null || { log "the report does not say $app waits for $net"; rc=1; }
  grep -qF "\`$app\` after \`$net\`" "$work/terragucci-report/note.md" || { log "the note does not name $app as waiting for $net"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "$net planned; $app held back until $net applies, named in the report and the note, and the job stayed green"
  return $rc
}

claim_policy() {
  # A new root plans a terraform_data resource, and the repo's terragucci.yml
  # turns on policy: a Rego rule denying terraform_data. tf-plan must exit 1,
  # fail that root, and name the denial in the report and the note; conftest is
  # fetched on demand, since the CI image does not carry it. The policy and the
  # key that turns it on are committed at the base, and the change under test
  # also rewrites that policy to deny nothing: the plan reads the base's copy,
  # so the pull request cannot allow itself. BREAK: the base's rule denies
  # nothing, so the violation does not fail the plan.
  log() { echo "[smoke policy] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work tree rc=0 run=0 r root=envs/dev/policy-probe edit rule='deny contains msg if {
  some rc in input.resource_changes
  rc.type == "terraform_data"
  msg := sprintf("%s: terraform_data is not allowed here", [rc.address])
}'
  [ -n "${BREAK:-}" ] && rule='deny contains msg if {
  input.nothing_ever_matches
  msg := "unreachable"
}'
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  cp -R "$EXAMPLE/." "$tree/"
  mkdir -p "$tree/policy"
  printf 'package main\n\nimport rego.v1\n\n%s\n' "$rule" > "$tree/policy/plan.rego"
  printf 'policy:\n  engine: conftest\n  path: policy\n' >> "$tree/terragucci.yml"
  edit="mkdir -p $root
cat > $root/main.tf <<'TF'
terraform {
  required_version = \"~> 1.13.0\"

  backend \"s3\" {
    bucket         = \"shop-terraform-state\"
    key            = \"envs/dev/policy-probe.tfstate\"
    region         = \"us-east-1\"
    use_lockfile   = true
    use_path_style = true
  }
}

resource \"terraform_data\" \"probe\" {
  input = 1
}
TF
printf 'package main\n\nimport rego.v1\n\ndeny contains msg if {\n  input.the_pull_request_allows_itself\n  msg := \"unreachable\"\n}\n' > policy/plan.rego"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  REPORT_TREE="$tree" REPORT_BASE=1 REPORT_EDIT="$edit" report_run "$work" || run=$?
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; drop_work "$tree"; return 1; }
  [ "$run" = 1 ] || { log "the plan job exited $run, not 1: the violation did not fail it"; rc=1; }
  jq -e --arg n "$root" '.roots[] | select(.path == $n and .status == "failed")' "$r" >/dev/null || { log "$root is not failed in the report"; rc=1; }
  grep -q "terraform_data.probe: terraform_data is not allowed here" "$r" || { log "the report does not name the violation"; rc=1; }
  grep -q "terraform_data.probe: terraform_data is not allowed here" "$work/terragucci-report/note.md" || { log "the note does not name the violation"; rc=1; }
  drop_work "$work"; drop_work "$tree"
  [ $rc = 0 ] && log "conftest denied terraform_data under the base's policy although the change rewrote it, $root failed the plan job, and the report and the note name the violation"
  return $rc
}

claim_forgejo_oidc() {
  # A scratch repo whose one root reads a data source that runs a probe in the
  # job: it reads the token the job wrote to $AWS_WEB_IDENTITY_TOKEN_FILE,
  # verifies its signature against Forgejo's published keys, trades it with
  # floci's STS for $AWS_ROLE_ARN, and writes what it saw to floci. The push to
  # main runs the apply job (the apply role); a pull request runs the plan job
  # (the plan role). floci accepts any token from an issuer it does not host,
  # so the signature check is the probe's own.
  # BREAK: enable-openid-connect is cut from the pushed pipeline, so the runner
  # serves no token and the apply job stops before it plans.
  log() { echo "[smoke forgejo-oidc] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/oidc" sha pr i mark plan_mark apply_mark rc=0 role trust subrepo
  local plan_role=terragucci-oidc-plan apply_role=terragucci-oidc-apply marks=shop-terraform-state/oidc-marks
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo oidc || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for mark in terragucci-plan terragucci-apply; do curl -s -o /dev/null -X DELETE "$FLOCI/$marks/$mark.json" || true; done
  # The two roles, trusting Forgejo's issuer for this repo. floci checks only
  # that the role exists for a token it cannot verify; AWS would check all of it.
  iam() { curl -sS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$1" --data-urlencode Version=2010-05-08 "${@:2}"; }
  for role in "$plan_role" "$apply_role"; do
    trust="$(jq -cn --arg repo "$repo" '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {Federated: "arn:aws:iam::000000000000:oidc-provider/forgejo:3000/api/actions"},
      Condition: {StringEquals: {"forgejo:3000/api/actions:aud": "sts.amazonaws.com"}, StringLike: {"forgejo:3000/api/actions:sub": "repo:\($repo):*"}}}]}')"
    iam CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$trust" >/dev/null || true
    iam GetRole --data-urlencode "RoleName=$role" | grep -q "<RoleName>$role</RoleName>" || { log "floci has no role $role"; return 1; }
  done
  mkdir -p "$work/tree/app"
  echo 1 > "$work/tree/app/rev.txt"
  cat > "$work/tree/app/main.tf" <<'TF'
terraform {
  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# init finds a root by its backend or provider block; state stays local.
provider "external" {}

data "external" "oidc" {
  program = ["node", "${path.module}/probe.mjs"]
}

resource "terraform_data" "rev" {
  input = file("${path.module}/rev.txt")
}

output "assumed" {
  value = data.external.oidc.result.assumed
}
TF
  cat > "$work/tree/app/probe.mjs" <<'JS'
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const e = process.env;
const fail = (m) => { console.error("oidc probe: " + m); process.exit(1); };
if (!e.AWS_WEB_IDENTITY_TOKEN_FILE || !e.AWS_ROLE_ARN) fail("no AWS_WEB_IDENTITY_TOKEN_FILE or AWS_ROLE_ARN, so the job took no role");
const jwt = readFileSync(e.AWS_WEB_IDENTITY_TOKEN_FILE, "utf8").trim();
const [h, p, s] = jwt.split(".");
if (!s) fail("the token file holds no JWT");
const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString());
const head = dec(h), claims = dec(p);
const server = (e.GITHUB_SERVER_URL || "").replace(/\/$/, "");
const conf = await (await fetch(server + "/api/actions/.well-known/openid-configuration")).json();
const jwks = await (await fetch(conf.jwks_uri)).json();
const jwk = jwks.keys.find((k) => !head.kid || k.kid === head.kid);
if (!jwk) fail("no published key matches kid " + head.kid);
const key = createPublicKey({ key: jwk, format: "jwk" });
const data = Buffer.from(h + "." + p), sig = Buffer.from(s, "base64url");
const hash = { 256: "sha256", 384: "sha384", 512: "sha512" }[head.alg.slice(2)];
const verified = head.alg === "EdDSA" ? verify(null, data, key, sig)
  : verify(hash, data, head.alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: e.AWS_ROLE_ARN, RoleSessionName: e.AWS_ROLE_SESSION_NAME, WebIdentityToken: jwt });
const r = await fetch(e.AWS_ENDPOINT_URL + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
const xml = await r.text();
const assumed = xml.match(/<AssumedRoleUser>[\s\S]*?<Arn>([^<]+)<\/Arn>/)?.[1];
if (!r.ok || !assumed) fail("STS answered " + r.status + ": " + xml.slice(0, 300));
const mark = { iss: claims.iss, sub: claims.sub, aud: claims.aud, alg: head.alg, issuer: conf.issuer, verified, assumed };
await fetch(e.AWS_ENDPOINT_URL + "/shop-terraform-state/oidc-marks/" + e.AWS_ROLE_SESSION_NAME + ".json", { method: "PUT", body: JSON.stringify(mark) });
console.log(JSON.stringify({ assumed }));
JS
  printf 'forge: forgejo\nbinary: tofu\ngate: never\noidc:\n  plan_role: arn:aws:iam::000000000000:role/%s\n  apply_role: arn:aws:iam::000000000000:role/%s\n' "$plan_role" "$apply_role" > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml) || { log "init failed"; return 1; }
  local wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q 'enable-openid-connect: true' "$wf" || { log "the pipeline sets no enable-openid-connect"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    grep -v 'enable-openid-connect: true' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
  fi
  checked() { # session, sub, role (mark on stdin) -> 0 when the mark shows a verified token for sub traded for role
    local m="$1"
    jq -e --arg sub "$2" --arg role "$3/$m" '.verified == true and .iss == .issuer and (.iss | endswith("/api/actions"))
      and .sub == $sub and ([.aud] | flatten | index("sts.amazonaws.com")) and (.assumed | contains(":assumed-role/" + $role))' >/dev/null
  }
  sha="$(push_tree "$work/tree" "$repo" main "oidc: first")"
  wait_run "$repo" "$sha"
  apply_mark="$(curl -fsS "$FLOCI/$marks/terragucci-apply.json" 2>/dev/null || true)"
  log "apply job: run $RUN_STATUS, mark ${apply_mark:-none}"
  if [ "$RUN_STATUS" != success ] || [ -z "$apply_mark" ]; then
    print_logs "$repo" "$RUN_ID" | grep -E 'OIDC|oidc probe|ACTIONS_ID_TOKEN' >&2 || true
    log "the apply job did not take the apply role over OIDC"
    return 1
  fi
  # Forgejo 16 names a repo in the subject as owner-<id>/repo-<id>.
  subrepo="$(api "$URL/api/v1/repos/$repo" | jq -r '"\(.owner.login)-\(.owner.id)/\(.name)-\(.id)"')"
  checked terragucci-apply "repo:$subrepo:ref:refs/heads/main" "$apply_role" <<<"$apply_mark" || { log "the apply mark is not a verified token for main traded for $apply_role"; rc=1; }
  echo 2 > "$work/tree/app/rev.txt"
  sha="$(push_tree "$work/tree" "$repo" oidc-change "oidc: change")"
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"oidc-change","base":"main","title":"oidc: plan"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  log "pull request $pr for ${sha:0:8}"
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    plan_mark="$(curl -fsS "$FLOCI/$marks/terragucci-plan.json" 2>/dev/null || true)"
    [ -n "$plan_mark" ] && break
    sleep 3
  done
  log "plan job: mark ${plan_mark:-none}"
  [ -n "$plan_mark" ] || { log "the plan job wrote no mark"; return 1; }
  checked terragucci-plan "repo:$subrepo:pull_request" "$plan_role" <<<"$plan_mark" || { log "the plan mark is not a verified pull_request token traded for $plan_role"; rc=1; }
  [ $rc = 0 ] && log "plan and apply jobs each got a token Forgejo signed and took their own role"
  return $rc
}

claim_steward() {
  # Changes the example: it boots it fresh with tf-apply handed to the fountain
  # steward (stack/steward.sh). The push to main goes green, every resource is
  # in floci, and the steward has a `chant run tf-apply` turn it did not have
  # before the push, which completed. The steward may already exist from an
  # earlier boot: the apply job moves it to a fresh conversation, so the new
  # turn is told apart by its id, not by a count. BREAK: the pipeline keeps its
  # own wave jobs, so the forge applies and every resource still appears; only
  # the steward's turns can tell that the steward ran nothing.
  log() { echo "[smoke steward] $*" >&2; }
  local handover=1 before new rc=0
  [ -n "${BREAK:-}" ] && handover=0
  tf_apply_turns() { "$HERE/steward.sh" turns 2>/dev/null | grep $'\tchant run tf-apply' || true; }
  # The tf-apply turns whose id was not there before the push, oldest first.
  new_turns() { tf_apply_turns | awk -F'\t' 'NR == FNR { seen[$1]; next } !($4 in seen)' <(printf '%s\n' "$before") -; }
  before="$(tf_apply_turns | cut -f4)"
  TG_STEWARD_HANDOVER=$handover "$HERE/example.sh" up --fresh --fountain >&2 || rc=1
  [ "$rc" = 0 ] && { "$HERE/example.sh" verify >&2 || rc=1; }
  new="$(new_turns)"
  if [ -z "$new" ]; then
    log "the steward ran no new tf-apply turn for this push"
    return 1
  fi
  # The pipeline is finished by now, so a turn still pending or running is a
  # job that ended before the steward's turn did.
  log "the steward's new turn: $(tail -1 <<<"$new" | cut -f1-3 | tr '\t' ' ')"
  case "$(tail -1 <<<"$new" | cut -f2)" in
    completed) ;;
    pending|running) log "the apply job ended before the steward's turn did"; return 1 ;;
    *) log "the steward's tf-apply turn did not complete"; return 1 ;;
  esac
  [ "$rc" = 0 ] || { log "the steward's turn completed, but the boot or the resource check failed"; return 1; }
  log "the steward's tf-apply turn completed, and every root's resources are in floci"
}

claim_comment_plan() {
  # A scratch repo with two roots, the pipeline init writes for it, a push to
  # main (which applies), and a pull request that changes one root (which
  # plans). Then comments, each by the repo's admin: `/terragucci plan app`
  # must start a run for the comment that posts a new terragucci/plan status
  # on the pull request's head; `/terragucci apply`, a root that is not one of
  # the repo's, and a root written as a shell command must each be answered
  # with a refusal and start no plan, and main must gain no terragucci/apply
  # status from any of them.
  # BREAK: the issue_comment trigger is cut from the pushed pipeline, so a
  # comment starts no run and the re-plan never comes.
  log() { echo "[smoke comment-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment" main_sha head_sha pr i rc=0 wf before after replies
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo comment || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$work/tree/app" "$work/tree/net"
  echo 1 > "$work/tree/app/rev.txt"
  echo 1 > "$work/tree/net/rev.txt"
  local root
  for root in app net; do
    cat > "$work/tree/$root/main.tf" <<'TF'
terraform {
  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# init finds a root by its backend or provider block; state stays local.
provider "external" {}

resource "terraform_data" "rev" {
  input = file("${path.module}/rev.txt")
}
TF
  done
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n' > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml) || { log "init failed"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  issue_comment:' "$wf" || { log "the pipeline has no issue_comment trigger"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    awk '/^  issue_comment:/ { skip = 2; next } skip > 0 { skip--; next } { print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
  fi
  main_sha="$(push_tree "$work/tree" "$repo" main "comment: first")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green"; return 1; }
  echo 2 > "$work/tree/app/rev.txt"
  head_sha="$(push_tree "$work/tree" "$repo" comment-change "comment: change")" || return 1
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"comment-change","base":"main","title":"comment: plan"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  log "pull request $pr for ${head_sha:0:8}"
  statuses() { # sha, context -> how many statuses carry it
    api "$URL/api/v1/repos/$repo/commits/$1/statuses?limit=100" | jq --arg c "$2" '[.[] | select(.context == $c)] | length'
  }
  # The pull request's own plan runs first; the comment's must come after it.
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(statuses "$head_sha" terragucci/plan)" -ge 2 ] && break
    sleep 3
  done
  before="$(statuses "$head_sha" terragucci/plan)"
  [ "$before" -ge 2 ] || { log "the pull request's own plan never finished"; return 1; }
  local applied_before
  applied_before="$(statuses "$main_sha" terragucci/apply)"
  comment() { # text -> posts it as the repo's admin
    api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$1" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$pr/comments"
  }
  # A comment run is one with the issue_comment event; wait for a finished one.
  comment_runs() { api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[] | select(.event == "issue_comment" and (.status == "success" or .status == "failure"))] | length'; }
  local runs_before wait=$(( TIMEOUT < 240 ? TIMEOUT : 240 ))
  runs_before="$(comment_runs)"
  comment "/terragucci plan app"
  for i in $(seq 1 $(( wait / 3 ))); do
    after="$(statuses "$head_sha" terragucci/plan)"
    [ "$after" -gt "$before" ] && [ "$(comment_runs)" -gt "$runs_before" ] && break
    sleep 3
  done
  after="$(statuses "$head_sha" terragucci/plan)"
  if [ "$after" -le "$before" ]; then
    log "the comment posted no new plan status on the pull request's head ($before before, $after after)"
    return 1
  fi
  log "the comment re-planned: terragucci/plan statuses on the head went from $before to $after"
  # Refusals: each is answered, and none starts a plan or an apply.
  before="$after"
  comment "/terragucci apply"
  comment "/terragucci plan envs/nope"
  comment '/terragucci plan $(id)'
  for i in $(seq 1 $(( wait / 3 ))); do
    replies="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | map(.body) | join("\n")')"
    [ "$(grep -c '^terragucci: ' <<<"$replies")" -ge 3 ] && break
    sleep 3
  done
  grep -q 'never runs `apply`' <<<"$replies" || { log "a comment that applies was not refused by name"; rc=1; }
  grep -q 'envs/nope is not a root' <<<"$replies" || { log "a root outside the configured ones was not refused"; rc=1; }
  grep -q 'the root is a path' <<<"$replies" || { log "a root written as a shell command was not refused"; rc=1; }
  after="$(statuses "$head_sha" terragucci/plan)"
  [ "$after" = "$before" ] || { log "a refused comment still planned ($before before, $after after)"; rc=1; }
  [ "$(statuses "$main_sha" terragucci/apply)" = "$applied_before" ] || { log "main gained an apply status from a comment"; rc=1; }
  [ "$(api "$URL/api/v1/repos/$repo/branches/main" | jq -r .commit.id)" = "$main_sha" ] || { log "main moved"; rc=1; }
  drop_work "$work" 2>/dev/null || true
  [ "$rc" = 0 ] && log "plan re-planned the pull request; apply, an unknown root and a shell-shaped root were each refused and planned nothing"
  return "$rc"
}

# ── state lock waits ──────────────────────────────────────────────────────
# A choudoufu built for Linux, which the tofu CI image runs: OpenTofu sends no
# span for a lock wait, choudoufu does (INTENTIUS/choudoufu#1898).
# CHOUDOUFU_BIN names a Linux build to use as is. Otherwise it is built from
# CHOUDOUFU_REF (default origin/main) of the checkout at CHOUDOUFU_DIR, read
# with git archive so the checkout itself is left alone, and kept under
# .state/choudoufu/<commit> for the next run. The host's Go cross-compiles it
# when there is one; otherwise a golang container does.
choudoufu_linux() {
  if [ -n "${CHOUDOUFU_BIN:-}" ]; then echo "$CHOUDOUFU_BIN"; return 0; fi
  local dir="${CHOUDOUFU_DIR:-$HOME/Documents/checkouts/intentius/choudoufu}" ref="${CHOUDOUFU_REF:-origin/main}" sha arch out src go
  sha="$(git -C "$dir" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || { echo "no choudoufu checkout at $dir with $ref; set CHOUDOUFU_DIR or CHOUDOUFU_BIN" >&2; return 1; }
  arch="$(docker version -f '{{.Server.Arch}}' 2>/dev/null)"; [ -n "$arch" ] || arch=amd64
  out="$HERE/.state/choudoufu/$sha-$arch/choudoufu"
  [ -x "$out" ] && { echo "$out"; return 0; }
  mkdir -p "$(dirname "$out")"
  src="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-choudoufu.XXXXXX")"
  git -C "$dir" archive "$sha" | tar -x -C "$src" || { drop_work "$src"; return 1; }
  echo "building choudoufu ${sha:0:10} for linux/$arch" >&2
  if command -v go >/dev/null 2>&1; then
    (cd "$src" && GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -o "$out" ./cmd/choudoufu) >&2 || { drop_work "$src"; return 1; }
  else
    go="$(sed -n 's/^go \([0-9.]*\)$/\1/p' "$src/go.mod")"
    docker run --rm -v "$src:/src" -v "$(dirname "$out"):/out" -v terragucci-go-cache:/root/go -w /src \
      -e GOOS=linux -e GOARCH="$arch" -e CGO_ENABLED=0 "golang:${go:-1}" go build -o /out/choudoufu ./cmd/choudoufu >&2 || { drop_work "$src"; return 1; }
  fi
  drop_work "$src"
  echo "$out"
}

claim_lock_wait() {
  # One root on floci's S3 with use_lockfile, planned by choudoufu. A second
  # plan of the same state takes the lock first and holds it: it waits at the
  # prompt for a variable it was not given, which comes after the lock. While
  # the lock object is in the bucket, the claimed run starts: a tf-apply wave
  # (tf-plan plans with -lock=false and never waits), whose plan retries the
  # lock until the holder lets go. The wave's report must list a lock wait of
  # two or more attempts, and the collector must hold the `State lock wait`
  # span with those attempts in the wave's trace.
  # BREAK: no second plan, so the lock is free and the plan takes it at once.
  log() { echo "[smoke lock-wait] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  collector_up || return 1
  local work image bin bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" bucket=terragucci-smoke-lock
  local key holder="" i d rc=0 commit report attempts=0 ms=0 trace="" spanned aws_env
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  bin="$(choudoufu_linux)" || { log "no choudoufu built for Linux"; return 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  key="lock-wait/$(date +%s)-$$/terraform.tfstate"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || true
  for d in repo holder; do
    mkdir -p "$work/$d/lock"
    cat >"$work/$d/lock/main.tf" <<HCL
terraform {
  backend "s3" {
    bucket         = "$bucket"
    key            = "$key"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

# Given to the claimed run, not to the holder, whose plan waits for it at a prompt while holding the lock.
variable "hold" {
  type = string
}

resource "terraform_data" "x" {
  input = "lock-wait"
}
HCL
  done
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke lock-wait $(date +%s%N)"
  commit="$(git -C "$work/repo" rev-parse HEAD)"
  aws_env=(-e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1)
  if [ -z "${BREAK:-}" ]; then
    holder="terragucci-smoke-lock-holder-$$"
    docker run -d --name "$holder" --network terragucci -v "$work/holder:/repo" -w /repo/lock -v "$bin:/usr/local/bin/choudoufu:ro" \
      "${aws_env[@]}" "$image" \
      sh -c 'choudoufu init -input=false -no-color >/dev/null && sleep 50 | choudoufu plan -input=true -no-color' >/dev/null || rc=1
    # The holder holds the lock once its lock object is in the bucket.
    for i in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$bucket/$key.tflock")" = 200 ] && break
      sleep 1
    done
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$bucket/$key.tflock")" != 200 ]; then
      log "the second plan never took the lock ($key.tflock is not in $bucket)"; docker logs "$holder" >&2 2>&1 || true; rc=1
    else
      log "the second plan holds $key.tflock"
    fi
  fi
  if [ $rc = 0 ]; then
    docker run --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" -v "$bin:/usr/local/bin/choudoufu:ro" \
      "${aws_env[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TF_VAR_hold=given \
      -e TF_CLI_ARGS_plan=-lock-timeout=150s \
      -e OTEL_EXPORTER_OTLP_ENDPOINT="$OTLP_ENDPOINT" \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage tf-apply --wave 1 --layers lock --binary choudoufu --gate never >&2 || { log "the wave did not apply"; rc=1; }
  fi
  [ -n "$holder" ] && { docker logs "$holder" 2>&1 | tail -3 | sed 's/^/[holder] /' >&2 || true; docker rm -f "$holder" >/dev/null 2>&1 || true; }
  report="$work/repo/terragucci-report/report.json"
  if [ $rc = 0 ]; then
    if [ ! -f "$report" ]; then
      log "the wave wrote no report"; rc=1
    else
      attempts="$(jq '[.roots[] | select(.path == "lock") | .timings.lock_waits[]? | .attempts // 0] | max // 0' "$report")"
      ms="$(jq '[.roots[] | select(.path == "lock") | .timings.lock_waits[]? | .ms] | max // 0' "$report")"
      [ "$attempts" -ge 2 ] || { log "the report's longest lock wait took $attempts attempt(s) and ${ms}ms: the plan never waited"; rc=1; }
      sleep 3   # the file exporter writes on its own schedule
      docker cp terragucci-otel-collector:/out/traces.jsonl - 2>/dev/null | tar -xO > "$work/traces.jsonl" || true
      trace="$(jq -rs --arg c "$commit" '[.[].resourceSpans[].scopeSpans[].spans[]
        | select(.name == "terragucci tf-apply" and any(.attributes[]; .key == "vcs.ref.head.revision" and .value.stringValue == $c))][0].traceId // empty' "$work/traces.jsonl" 2>/dev/null)"
      if [ -z "$trace" ]; then
        log "no tf-apply trace for commit $commit"; rc=1
      else
        spanned="$(jq -s --arg t "$trace" '[.[].resourceSpans[].scopeSpans[].spans[]
          | select(.traceId == $t and .name == "State lock wait")
          | [.attributes[]? | select(.key == "opentofu.state.lock.attempts") | .value.intValue // .value.doubleValue | tonumber][0] // 0] | max // 0' "$work/traces.jsonl")"
        [ "$spanned" -ge 2 ] || { log "trace $trace has no State lock wait span of two or more attempts (most: $spanned)"; rc=1; }
      fi
    fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] || return 1
  log "the wave's plan waited ${ms}ms over $attempts attempts for the lock the second plan held; trace $trace carries the State lock wait span"
}

# ── dashboards ────────────────────────────────────────────────────────────
# The dashboards `dashboards: true` writes into a repo, provisioned in the
# observability profile's Grafana from stack/observability/terragucci/ (the
# same renderer init runs, so each claim first checks init writes the file
# Grafana serves). Each claim runs a plan, a drift run and a gated wave as a
# project of its own, with telemetry on, then runs some of the dashboard's
# panels through Grafana's query API for that project: every one must return
# data. Needs the example booted for the plan and the drift run.
# BREAK: the three runs send no telemetry (OTEL_SDK_DISABLED=true), so the
# project has no data and the panels come back empty.

GRAFANA="http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}"
TEMPO="http://localhost:${TERRAGUCCI_TEMPO_PORT:-3210}"

dash_up() {
  collector_up || return 1
  local i
  dash_answers() { curl -fsS -o /dev/null -m 3 "$GRAFANA/api/health" && curl -fsS -o /dev/null -m 3 "$TEMPO/ready"; }
  dash_answers 2>/dev/null && return 0
  echo "starting Grafana and Tempo" >&2
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name terragucci --profile observability up -d >&2 || return 1
  for i in $(seq 1 45); do
    dash_answers 2>/dev/null && return 0
    sleep 2
  done
  echo "Grafana or Tempo did not answer after 90s" >&2
  return 1
}

# init, run on the example with `dashboards: true`, must write the dashboard
# file Grafana serves (stack/observability/terragucci, provisioned).
dash_rendered() { # work, uid
  local dir="$1/init" f="observability/terragucci/grafana/dashboards/$2.json"
  mkdir -p "$dir"
  cp -R "$EXAMPLE/." "$dir/"
  rm -rf "$dir/.git"
  printf '\ndashboards: true\n' >> "$dir/terragucci.yml"
  (cd "$dir" && "$TERRAGUCCI" init --forge forgejo --dry-run --json) | jq -j --arg f "$f" '.results.files[] | select(.path == $f) | .content' > "$1/rendered.json"
  [ -s "$1/rendered.json" ] || { log "init wrote no $f"; return 1; }
  cmp -s "$1/rendered.json" "$HERE/observability/terragucci/grafana/dashboards/$2.json" \
    || { log "init renders $f differently from what Grafana is provisioned with; run 'just ci'"; return 1; }
  curl -fsS -o /dev/null "$GRAFANA/api/dashboards/uid/$2" || { log "Grafana does not serve dashboard $2"; return 1; }
}

# A plan, a drift run and a gated wave, all as project $DASH_PROJECT.
dash_data() { # work
  local work="$1" image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" id env rc=0 code=0 kv
  local -a extra=()
  id="$(date +%s)$$${BREAK:+b}"
  DASH_PROJECT="smoke.local/dash/run-$id"
  env="GITHUB_SERVER_URL=http://smoke.local GITHUB_REPOSITORY=dash/run-$id TG_PR=7 OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT"
  [ -n "${BREAK:-}" ] && env="$env OTEL_SDK_DISABLED=true"
  image="$(image_tag tofu)"
  mkdir -p "$work/plan" "$work/drift" "$work/wave/gate"
  # One root is enough for every panel, and keeps the runs short.
  # Each run in a subshell, so REPORT_ARGS and REPORT_STAGE stay with it.
  (REPORT_ARGS=(--root envs/staging/orders); REPORT_ENV="$env" report_run "$work/plan") || true
  [ -f "$work/plan/terragucci-report/report.json" ] || { log "the plan wrote no report"; rc=1; }
  (REPORT_STAGE=tf-drift; REPORT_ARGS=(--root envs/staging/orders); REPORT_ENV="$env" report_run "$work/drift") || true
  [ -f "$work/drift/terragucci-report/report.json" ] || { log "the drift run wrote no report"; rc=1; }
  # The gated wave: one root that creates something, --gate always, and a bare
  # repo for origin, so the wave records its pending fact and waits (exit 3).
  cat >"$work/wave/gate/main.tf" <<'HCL'
terraform {
  backend "local" {}
}

resource "terraform_data" "dash" {
  input = "dashboards"
}
HCL
  git init -q --bare "$work/origin.git"
  git -C "$work/wave" init -q -b main
  git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke dashboards $id"
  git -C "$work/wave" remote add origin /origin.git
  for kv in $env; do extra+=(-e "$kv"); done
  docker run --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${extra[@]}" "$image" terragucci stage tf-apply --wave 1 --layers gate --binary tofu --gate always >&2 || code=$?
  clean_mounted "$work/wave" "$image"
  [ "$code" = 3 ] || { log "the wave did not wait for an approval (exit $code)"; rc=1; }
  return $rc
}

# How many values a dashboard panel's queries return for $DASH_PROJECT over the
# last hour, run through Grafana's query API as the panel runs them: the
# dashboard's variables are filled in ($project with the project), the rest
# of the query is the dashboard's own.
panel_points() { # uid, panel title
  local dash body
  dash="$(curl -fsS "$GRAFANA/api/dashboards/uid/$1")" || { echo 0; return 0; }
  body="$(jq -c --arg t "$2" --arg p "$DASH_PROJECT" '
    def fill: gsub("\\$project"; $p) | gsub("\\$stage"; ".+") | gsub("\\$__range"; "1h") | gsub("\\$__rate_interval"; "1m");
    [.dashboard.panels[] | (., (.panels // [])[]) | select(.title == $t) | (.datasource // {}) as $ds | (.targets // [])[]
      | . + {datasource: (.datasource // $ds), intervalMs: 15000, maxDataPoints: 200}
      | if .expr then .expr |= fill else . end
      | if .query then .query |= fill else . end]
    | {queries: ., from: "now-1h", to: "now"}' <<<"$dash")"
  [ "$(jq '.queries | length' <<<"$body")" -gt 0 ] || { echo 0; return 0; }
  curl -fsS -H 'content-type: application/json' -X POST -d "$body" "$GRAFANA/api/ds/query" 2>/dev/null \
    | jq '[.results[]?.frames[]?.data.values // [] | .[1:][]? | length] | add // 0' 2>/dev/null || echo 0
}

# The claim: render, data, then every named panel has data (retried while
# the collector, Prometheus and Tempo catch up).
dash_claim() { # uid, panel title...
  local uid="$1" work rc=0 i t n missing
  shift
  dash_up || return 1
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  dash_rendered "$work" "$uid" || rc=1
  [ $rc = 0 ] && { dash_data "$work" || rc=1; }
  if [ $rc = 0 ]; then
    for i in $(seq 1 18); do   # up to 90s: the span metrics flush, the scrape and Tempo's ingest
      missing=""
      for t in "$@"; do
        n="$(panel_points "$uid" "$t")"
        [ "${n:-0}" -gt 0 ] || missing="$missing, $t"
      done
      [ -z "$missing" ] && break
      sleep 5
    done
    [ -z "$missing" ] || { log "$uid: no data for $DASH_PROJECT in ${missing#, }"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "$uid renders as init writes it, and $# panel(s) show $DASH_PROJECT's plan, drift run and gated wave: $*"
}

claim_dash_pipeline() {
  log() { echo "[smoke dash-pipeline] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-pipeline-health "Runs per hour" "Errors" "Runs by result"
}

claim_dash_changes() {
  log() { echo "[smoke dash-changes] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-change-review "Roots changed per pull request" "Groups per pull request" "Changes by action"
}

claim_dash_waves() {
  log() { echo "[smoke dash-waves] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-rollouts-waves "Waves waiting" "Waiting for" "Wave runs by result" "Roots per wave"
}

claim_dash_drift() {
  log() { echo "[smoke dash-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-drift "Drifted roots" "Drift age"
}

claim_dash_estate() {
  log() { echo "[smoke dash-estate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-estate "Roots per project" "Versions"
}

claim_dash_runs() {
  log() { echo "[smoke dash-runs] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_claim terragucci-runs "Slowest roots" "Stage duration" "Runs"
}

claim_dash_slos() {
  # The plan SLO's dashboard, and its recorded SLI for this project: the
  # rules file init writes is loaded in Prometheus (promtool checks it), and
  # its recording rules record the project's plans.
  log() { echo "[smoke dash-slos] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  docker exec terragucci-prometheus promtool check rules /etc/prometheus/rules/terragucci.rules.yml >&2 \
    || { log "promtool does not accept the rules file"; return 1; }
  local slo
  for slo in slo-terragucci-apply-success slo-terragucci-drift-corrected; do
    curl -fsS -o /dev/null "$GRAFANA/api/dashboards/uid/$slo" || { log "Grafana does not serve dashboard $slo"; return 1; }
  done
  dash_claim slo-terragucci-plan-time "Error budget remaining" || return 1
  # The SLO panels read every project's series; this project's own must be among them.
  local q n=0 i
  q="slo:sli_error:ratio_rate5m{slo=\"terragucci-plan-time\",terragucci_project=\"$DASH_PROJECT\"}"
  for i in $(seq 1 12); do   # the rule evaluates every 5s once the counter has two samples
    n="$(curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$q" | jq '.data.result | length')"
    [ "${n:-0}" -gt 0 ] && break
    sleep 5
  done
  [ "${n:-0}" -gt 0 ] || { log "Prometheus recorded no plan SLI for $DASH_PROJECT"; return 1; }
  log "the plan SLO recorded $DASH_PROJECT's plans"
}

run_claim() { # name -> prints the SMOKE line, returns 1 on fail
  local name="$1" row issue started secs
  row="$(grep "^$name|" <<<"$CLAIMS")" || { echo "unknown claim '$name'" >&2; return 2; }
  issue="${row##*|}"
  if [ -n "$issue" ]; then
    say "$name" pending "needs=$issue"
    return 0
  fi
  started=$(date +%s)
  trap 'cleanup_works; exit 130' INT
  trap 'cleanup_works; exit 143' TERM
  if "claim_${name//-/_}"; then held=1; else held=0; fi
  cleanup_works
  secs=$(( $(date +%s) - started ))
  if [ -z "${BREAK:-}" ]; then
    if [ $held = 1 ]; then say "$name" pass "seconds=$secs"; else say "$name" fail "seconds=$secs"; return 1; fi
  else
    if [ $held = 0 ]; then say "$name" caught "seconds=$secs"; else say "$name" fail "seconds=$secs break=not-caught"; return 1; fi
  fi
}

names() { cut -d'|' -f1 <<<"$CLAIMS"; }
# The claims with no issue to wait for, in CLAIMS order.
runnable_names() { awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS"; }

# ── the runner ────────────────────────────────────────────────────────────
#
# What each claim shares with the others, one line per claim:
#
#   <claim> <token>...
#
# Most tokens are resources the claim's runs hold while they run: shared by
# default, exclusive with a trailing "!". A run starts only when it can hold
# all of its resources; any number of runs share a resource, and an exclusive
# hold waits for everyone else to let go.
#
#   ex         the plain example: its repo, its 15 roots' resources and their
#              state. Plans that only read it share it; boot and drift change
#              it, so they hold it alone.
#   tg         the Terragrunt example, the same way
#   tg-ledger  the Terragrunt example's dev ledger unit, which tg-refuse's BREAK
#              and tg-mock-trap apply
#   runner     the Forgejo runner, for claims whose pushes run a pipeline.
#              apply-serial's BREAK run holds it alone, so it is never free
#              slots, or the lack of them, that order its two applies.
#   otel       the collector and Prometheus: traces and metrics stay apart
#   self       the claim's own fixed names (its repo, branch, state keys), so
#              its plain and BREAK runs do not overlap
#   stack      every run holds it shared; a claim with no line here holds it
#              alone, after boot and tg-waves
#
# plain:<lock> and break:<lock> hold a lock in one of the two runs only.
# after=<claim>[,<claim>...] starts the claim's runs only once every run of
# those claims has finished: the example it reads must be booted first.
# break-first runs BREAK before plain, for a claim whose plain run boots from
# scratch and so puts back what its BREAK run left; that BREAK run sees
# SMOKE_PLAIN_NEXT=1. weight=<n> orders the queue, heaviest first (default
# 60): about the seconds both runs take, more for a claim others wait on.
# A run waiting for a resource keeps any run behind it in the queue from
# taking that resource first.
#
# zero-config, tg-zero-config and respond-notes use no stack at all.
# steward boots the example with `up --fresh`, which restarts floci and so
# wipes every claim's state and the Terragrunt example: it runs alone, after
# every claim that needs the Terragrunt example.
CLAIM_GROUPS='
tg-waves        tg! runner break-first weight=1000
boot            ex! runner break-first weight=900
drift           ex! after=boot weight=700
tg-affected     tg after=tg-waves weight=500
tg-refuse       tg tg-ledger! after=tg-waves weight=490
tg-check        tg runner self! after=tg-waves weight=480
tg-mock-lint    tg after=tg-waves weight=470
tg-drift        tg! after=tg-waves weight=460
tg-mock-trap    tg! tg-ledger! runner after=tg-waves weight=450
report          ex after=boot weight=400
respond-refused ex after=boot weight=350
metrics         ex otel! after=boot weight=340
traces          ex otel! after=boot weight=330
highlight       ex after=boot weight=300
tips            ex after=boot weight=300
reconcile       runner self! weight=300
rollout         runner self! weight=250
fresh-plan      ex after=boot weight=250
waves           runner self! weight=200
refuse          runner self! weight=200
sealed          runner self! weight=200
publish         runner self! weight=200
forgejo-oidc    runner self! weight=200
grouped         ex runner self! after=boot weight=200
check           ex runner self! after=boot weight=200
affected        ex after=boot weight=150
respond-tips    runner self! weight=150
apply-serial    runner self! break:runner! weight=100
respond-drift   self! weight=80
respond-fmt     self! weight=60
respond-triage  weight=60
zero-config     weight=30
tg-zero-config  weight=30
respond-notes   weight=20
policy          ex after=boot weight=150
steward         stack! after=boot,drift,tg-waves,tg-affected,tg-refuse,tg-check,tg-mock-lint,tg-drift,tg-mock-trap,policy weight=10
comment-plan    runner self! weight=150
lock-wait       otel! self! weight=150
dash-pipeline   ex otel after=boot weight=120
dash-changes    ex otel after=boot weight=120
dash-waves      ex otel after=boot weight=120
dash-drift      ex otel after=boot weight=120
dash-estate     ex otel after=boot weight=120
dash-runs       ex otel after=boot weight=120
dash-slos       ex otel after=boot weight=120
'

SMOKE_LOCKS="${SMOKE_LOCK_DIR:-$HERE/.state/locks}"

# ── the stack lock: one lock per shared resource ──
# $SMOKE_LOCKS/<resource>/<holder>.<s|x> is one hold, shared or exclusive,
# holding the pid of the process that took it; a hold whose process is gone
# is dropped. Every change happens under one mutex (a directory, made
# atomically), so separate smoke.sh processes on one stack take turns too.

lock_mutex() {
  local owner
  mkdir -p "$SMOKE_LOCKS"
  until mkdir "$SMOKE_LOCKS/.mutex" 2>/dev/null; do
    owner=""
    read -r owner 2>/dev/null <"$SMOKE_LOCKS/.mutex/pid" || true
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$SMOKE_LOCKS/.mutex"; continue; fi
    sleep 0.1
  done
  echo "$$" >"$SMOKE_LOCKS/.mutex/pid"
}

unlock_mutex() { rm -rf "$SMOKE_LOCKS/.mutex"; }

# holder, lock... -> 0 with every lock held, or 1 with the resources in the
# way on stdout. All or nothing, so two runs never each hold half of what the
# other needs.
try_lock() {
  local holder="$1" l res mode f p busy=""
  shift
  lock_mutex
  for f in "$SMOKE_LOCKS"/*/*.s "$SMOKE_LOCKS"/*/*.x; do
    [ -f "$f" ] || continue
    p=""; read -r p 2>/dev/null <"$f" || true
    if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then rm -f "$f"; fi
  done
  for l in "$@"; do
    res="${l%!}"; mode=s; [ "$res" = "$l" ] || mode=x
    for f in "$SMOKE_LOCKS/$res"/*.s "$SMOKE_LOCKS/$res"/*.x; do
      [ -f "$f" ] || continue
      case "$f" in "$SMOKE_LOCKS/$res/$holder".[sx]) continue ;; esac
      if [ "$mode" = x ] || [ "${f##*.}" = x ]; then busy="$busy $res"; break; fi
    done
  done
  if [ -z "$busy" ]; then
    for l in "$@"; do
      res="${l%!}"; mode=s; [ "$res" = "$l" ] || mode=x
      mkdir -p "$SMOKE_LOCKS/$res"
      echo "$$" >"$SMOKE_LOCKS/$res/$holder.$mode"
    done
  fi
  unlock_mutex
  [ -z "$busy" ] || { echo "$busy"; return 1; }
}

unlock_holder() { # holder
  [ -d "$SMOKE_LOCKS" ] || return 0
  lock_mutex
  rm -f "$SMOKE_LOCKS"/*/"$1".s "$SMOKE_LOCKS"/*/"$1".x
  unlock_mutex
}

# Every hold this process took, for the exit trap.
release_mine() {
  local f p
  [ -d "$SMOKE_LOCKS" ] || return 0
  lock_mutex
  for f in "$SMOKE_LOCKS"/*/*.s "$SMOKE_LOCKS"/*/*.x; do
    [ -f "$f" ] || continue
    p=""; read -r p 2>/dev/null <"$f" || true
    if [ "$p" = "$$" ]; then rm -f "$f"; fi
  done
  unlock_mutex
  return 0
}

hold_locks() { # holder, lock... : wait until every lock is held
  local holder="$1" busy said=""
  shift
  until busy="$(try_lock "$holder" "$@")"; do
    [ "$busy" = "$said" ] || { echo "[smoke] waiting for:$busy" >&2; said="$busy"; }
    sleep 2
  done
}

with_lock() { # resource, command... : run the command holding the resource alone
  local holder="$$.with.$1.$RANDOM" rc=0
  hold_locks "$holder" "$1!"
  shift
  "$@" || rc=$?
  unlock_holder "$holder"
  return $rc
}

# ── what a claim's runs hold ──

group_tokens() { # claim -> its tokens, or the default for a claim with no line
  local line
  line="$(awk -v n="$1" '$1 == n { $1 = ""; print; exit }' <<<"$CLAIM_GROUPS")"
  if [ -n "${line// /}" ]; then echo "$line"; else echo "stack! after=boot,tg-waves weight=1"; fi
}

claim_token() { # claim, key -> the value of its key=<value> token, if any
  local t
  for t in $(group_tokens "$1"); do
    case "$t" in "$2"=*) echo "${t#*=}"; return 0 ;; esac
  done
  return 0
}

claim_has() { case " $(group_tokens "$1") " in *" $2 "*) return 0 ;; esac; return 1; }

claim_locks() { # claim, plain|break -> the locks its run holds
  local name="$1" mode="$2" t out=""
  for t in $(group_tokens "$name"); do
    case "$t" in
      after=*|weight=*|break-first) continue ;;
      plain:*) [ "$mode" = plain ] || continue; t="${t#plain:}" ;;
      break:*) [ "$mode" = break ] || continue; t="${t#break:}" ;;
    esac
    case "$t" in self) t="claim-$name" ;; 'self!') t="claim-$name!" ;; esac
    out="$out $t"
  done
  case " $out " in *" stack! "*) ;; *) out="$out stack" ;; esac
  # An exclusive hold covers a shared one of the same resource.
  for t in $out; do
    case "$t" in
      *!) echo "$t" ;;
      *) case " $out " in *" $t! "*) ;; *) echo "$t" ;; esac ;;
    esac
  done | sort -u | tr '\n' ' '
}

# ── running the queue ──

SMOKE_JOBS="${SMOKE_JOBS:-6}"
case "$SMOKE_JOBS" in ''|*[!0-9]*|0) SMOKE_JOBS=6 ;; esac
[ -n "${SMOKE_SERIAL:-}" ] && SMOKE_JOBS=1
SMOKE_LOG_DIR="${SMOKE_LOG_DIR:-$HERE/.state/smoke-logs/$(date +%Y%m%d-%H%M%S)}"
SMOKE_LINES_TO=stdout
SMOKE_BREAK_VALUE=1
QUEUE=""

# A run's precomputed locks and claims to wait for live in RL_<key> and RA_<key>.
runvar_key() { local k="${1//-/_}"; RUNVAR_KEY="${k//:/__}"; }

smoke_line() { if [ "$SMOKE_LINES_TO" = stderr ]; then echo "$1" >&2; else echo "$1"; fi; }

# The runs of the named claims, one "<claim>:<plain|break>" per line, heaviest
# claim first and ties in CLAIMS order.
build_queue() { # "plain break" | plain | break, claim...
  local modes="$1" i=0 name w
  shift
  for name in "$@"; do
    i=$((i + 1))
    w="$(claim_token "$name" weight)"
    if [ "$modes" = "plain break" ]; then
      if claim_has "$name" break-first; then
        echo "${w:-60} $i 1 $name:break"; echo "${w:-60} $i 2 $name:plain"
      else
        echo "${w:-60} $i 1 $name:plain"; echo "${w:-60} $i 2 $name:break"
      fi
    else
      echo "${w:-60} $i 1 $name:$modes"
    fi
  done | sort -k1,1nr -k2,2n -k3,3n | awk '{ print $4 }'
}

# Pending claims print their line and run nothing.
record_pending() {
  local name issue line
  for name in $(names); do
    issue="$(grep "^$name|" <<<"$CLAIMS" | cut -d'|' -f3)"
    [ -n "$issue" ] || continue
    line="$(say "$name" pending "needs=$issue")"
    echo "$line" >"$SMOKE_LOG_DIR/$name.plain.verdict"
    smoke_line "$line"
  done
}

start_run() { # run
  local name="${1%:*}" mode="${1#*:}" brk="" next=""
  if [ "$mode" = break ]; then
    brk="$SMOKE_BREAK_VALUE"
    # shellcheck disable=SC2086
    case " $(echo $QUEUE) " in *" $name:plain "*) next=1 ;; esac
  fi
  echo "[smoke] start $name ($mode)" >&2
  BREAK="$brk" SMOKE_PLAIN_NEXT="$next" SMOKE_LOCKS_HELD=1 "$BASH" "$HERE/smoke.sh" "$name" \
    >"$SMOKE_LOG_DIR/$name.$mode.log" 2>&1 </dev/null &
  LAST_PID=$!
}

finish_run() { # run
  local run="$1" name="${1%:*}" mode="${1#*:}" line
  line="$(grep "^SMOKE claim=$name " "$SMOKE_LOG_DIR/$name.$mode.log" 2>/dev/null | tail -1 || true)"
  [ -n "$line" ] || line="SMOKE claim=$name verdict=fail no-verdict"
  echo "$line" >"$SMOKE_LOG_DIR/$name.$mode.verdict"
  unlock_holder "$$.$run"
  smoke_line "$line"
}

# Run every run in $QUEUE, at most $SMOKE_JOBS at a time, each its own
# smoke.sh process with its output in $SMOKE_LOG_DIR/<claim>.<mode>.log and its
# SMOKE line in <claim>.<mode>.verdict. The runner takes a run's locks for it
# before it starts and lets go when it ends.
run_queue() {
  local run name mode k r l locks busy blocked reserved picked waiting pid still n started
  started=$(date +%s)
  for run in $QUEUE; do
    runvar_key "$run"; name="${run%:*}"; mode="${run#*:}"
    printf -v "RL_$RUNVAR_KEY" '%s' "$(claim_locks "$name" "$mode")"
    printf -v "RA_$RUNVAR_KEY" '%s' "$(claim_token "$name" after | tr ',' ' ')"
  done
  while [ -n "$QUEUE" ] || [ -n "$SMOKE_RUNNING" ]; do
    still=""
    while read -r pid run; do
      [ -n "$pid" ] || continue
      if kill -0 "$pid" 2>/dev/null; then still="$still$pid $run"$'\n'; continue; fi
      wait "$pid" 2>/dev/null || true
      finish_run "$run"
    done <<<"$SMOKE_RUNNING"
    SMOKE_RUNNING="$still"
    while [ -n "$QUEUE" ]; do
      n="$(grep -c . <<<"$SMOKE_RUNNING" || true)"
      [ "$n" -lt "$SMOKE_JOBS" ] || break
      # shellcheck disable=SC2086,SC2046
      waiting=" $(echo $QUEUE $(awk '{ print $2 }' <<<"$SMOKE_RUNNING")) "
      picked=""; reserved=" "
      for run in $QUEUE; do
        runvar_key "$run"
        k="RA_$RUNVAR_KEY"; blocked=""
        for r in ${!k}; do case "$waiting" in *" $r:"*) blocked=1 ;; esac; done
        [ -z "$blocked" ] || continue
        k="RL_$RUNVAR_KEY"; locks="${!k}"
        for l in $locks; do
          r="${l%!}"
          case "$reserved" in *" $r "*) blocked="$blocked $r" ;; esac
        done
        if [ -z "$blocked" ]; then
          # shellcheck disable=SC2086
          if busy="$(try_lock "$$.$run" $locks)"; then picked="$run"; break; fi
          blocked="$busy"
        fi
        for r in $blocked; do reserved="$reserved$r "; done
      done
      [ -n "$picked" ] || break
      QUEUE="$(grep -vxF "$picked" <<<"$QUEUE" || true)"
      start_run "$picked"
      SMOKE_RUNNING="$SMOKE_RUNNING$LAST_PID $picked"$'\n'
    done
    sleep 1
  done
  echo "[smoke] every run finished in $(( $(date +%s) - started ))s, $SMOKE_JOBS at a time; logs in $SMOKE_LOG_DIR" >&2
}

# Before any run starts: build the bundle and work out the image tags once,
# build the CI images if they are missing, and start the stack (bootstrap.sh
# keeps a token that still works, so no run's token goes stale under it).
runner_prep() {
  mkdir -p "$SMOKE_LOG_DIR" || return 1
  echo "[smoke] logs in $SMOKE_LOG_DIR, $SMOKE_JOBS at a time" >&2
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || { echo "[smoke] the CLI did not build" >&2; return 1; }
  export SMOKE_CLI_BUILT=1
  SMOKE_TOFU_IMAGE="$(image_tag tofu)"; SMOKE_TG_IMAGE="$(image_tag terragrunt)"
  export SMOKE_TOFU_IMAGE SMOKE_TG_IMAGE
  if ! docker image inspect "$SMOKE_TOFU_IMAGE" >/dev/null 2>&1 || ! docker image inspect "$SMOKE_TG_IMAGE" >/dev/null 2>&1; then
    echo "[smoke] building the CI images (a few minutes the first time)" >&2
    (cd "$HERE/.." && npx tsx scripts/images.ts build >"$SMOKE_LOG_DIR/images.log" 2>&1) \
      || { echo "[smoke] the CI images did not build; see $SMOKE_LOG_DIR/images.log" >&2; return 1; }
  fi
  "$HERE/bootstrap.sh" forgejo >/dev/null 2>"$SMOKE_LOG_DIR/bootstrap.log" \
    || { cat "$SMOKE_LOG_DIR/bootstrap.log" >&2; echo "[smoke] the stack did not start" >&2; return 1; }
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
}

# Free space on the host's data volume, in GB. Docker Desktop's VM can hold
# deleted bind-mounted files until it restarts, which df on the host shows as
# space that never comes back (#113).
free_gb() {
  local vol=/System/Volumes/Data
  [ -d "$vol" ] || vol="${TMPDIR:-/tmp}"
  df -Pk "$vol" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}
# The job cache volume gains a provider per version and nothing prunes it.
# `just job-cache-prune` empties it.
job_cache_size() {
  local size
  size="$(docker system df -v --format '{{range .Volumes}}{{.Name}} {{.Size}}{{"\n"}}{{end}}' 2>/dev/null | awk -v v="$JOB_CACHE_VOLUME" '$1 == v { print $2 }')" || size=""
  echo "smoke: the ${JOB_CACHE_VOLUME} volume holds ${size:-an unknown size}; 'just job-cache-prune' removes it" >&2
}
SMOKE_DISK_WARN_GB="${SMOKE_DISK_WARN_GB:-50}"
# disk_check START_GB: say how much free space the record cost, and warn past the threshold.
disk_check() {
  local start="$1" end lost
  end="$(free_gb)"
  [ -n "$start" ] && [ -n "$end" ] || return 0
  lost=$((start - end))
  echo "smoke: free space ${start} GB at the start of the record, ${end} GB now" >&2
  job_cache_size
  if [ "$lost" -gt "$SMOKE_DISK_WARN_GB" ]; then
    echo "smoke: WARNING the record used ${lost} GB of disk, more than SMOKE_DISK_WARN_GB=${SMOKE_DISK_WARN_GB}. Docker Desktop may be holding deleted bind-mounted files; 'lsof +L1 -a -p <pid of the VM process>' lists them, and restarting Docker Desktop frees them." >&2
  fi
}

if [ "${1:-}" = --record ]; then
  out="${2:?usage: smoke.sh --record FILE}"
  SMOKE_LINES_TO=stderr
  disk_start="$(free_gb)"
  runner_prep || exit 1
  record_pending
  # shellcheck disable=SC2046
  QUEUE="$(build_queue "plain break" $(runnable_names))"
  run_queue
  # The rows in CLAIMS order, whatever order the runs finished in.
  rows=()
  for name in $(names); do
    plain="$(cat "$SMOKE_LOG_DIR/$name.plain.verdict" 2>/dev/null || true)"
    [ -n "$plain" ] || plain="SMOKE claim=$name verdict=fail no-verdict"
    broken="$(cat "$SMOKE_LOG_DIR/$name.break.verdict" 2>/dev/null || true)"
    row="$(grep "^$name|" <<<"$CLAIMS")"
    says="$(cut -d'|' -f2 <<<"$row")"; issue="$(cut -d'|' -f3 <<<"$row")"
    rows+=("$(jq -n --arg c "$name" --arg s "$says" --arg i "$issue" --arg p "$plain" --arg b "$broken" '{
      claim: $c, says: $s, needs: (if $i == "" then null else $i end),
      verdict: ($p | capture("verdict=(?<v>[a-z]+)").v),
      break: (if $b == "" then null else ($b | capture("verdict=(?<v>[a-z]+)").v) end)
    }')")
  done
  # Leave the example booted and clean for whoever runs next. Each claim puts
  # back what it changed, so this boots afresh only when something was left.
  "$HERE/example.sh" verify >&2 || "$HERE/example.sh" up --fresh >&2
  disk_check "$disk_start"
  new="$(printf '%s\n' "${rows[@]}" | jq -s .)"
  # Same verdicts as the last record: keep it, date and all, so nothing diffs.
  if [ -f "$out" ] && [ "$(jq -S .claims "$out")" = "$(jq -S . <<<"$new")" ]; then
    echo "unchanged $out" >&2
    exit 0
  fi
  jq --arg at "$(date -u +%Y-%m-%d)" --arg commit "$(git -C "$HERE/.." rev-parse --short HEAD)" \
    '{recorded: $at, commit: $commit, forge: "forgejo", claims: .}' <<<"$new" > "$out"
  echo "wrote $out" >&2
  exit 0
fi

rc=0
if [ -n "${1:-}" ]; then
  # One claim, in this process. Run by hand it first takes its locks, waiting
  # while another smoke.sh holds what it needs; run by the runner, the runner
  # holds them for it (SMOKE_LOCKS_HELD=1).
  name="$1"
  row="$(grep "^$name|" <<<"$CLAIMS")" || { echo "unknown claim '$name'" >&2; exit 2; }
  if [ -z "${SMOKE_LOCKS_HELD:-}" ] && [ -z "${row##*|}" ]; then
    mode=plain; [ -n "${BREAK:-}" ] && mode="break"
    # shellcheck disable=SC2046
    hold_locks "$$.$name.$mode" $(claim_locks "$name" "$mode")
  fi
  run_claim "$name" || rc=$?
else
  runner_prep || exit 1
  mode=plain; [ -n "${BREAK:-}" ] && mode="break"
  SMOKE_BREAK_VALUE="${BREAK:-}"
  record_pending
  # shellcheck disable=SC2046
  QUEUE="$(build_queue "$mode" $(runnable_names))"
  run_queue
  if grep -q 'verdict=fail' "$SMOKE_LOG_DIR"/*.verdict 2>/dev/null; then rc=1; fi
fi
exit $rc
