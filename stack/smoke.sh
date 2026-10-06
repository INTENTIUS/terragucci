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
# The AWS a claim's own `docker run` sees: floci. Under SMOKE_AWS=1,
# smoke_aws_start (stack/smoke-aws.sh) swaps in the real account's keys.
AWS_DOCKER_ENV=(-e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1)

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
# root per run, and no provider binary sits in a work dir (run_copied in mounted.sh copies work dirs in and out instead of bind-mounting them).
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
dash-slos|the SLO dashboards init writes are provisioned, and the plan SLO records the plans of a project from the rules init writes|
drill-down|the plan note links the report in the bucket, the report links each root plan and the trace of the run, the trace and the dashboards link back to the report, and the index row links the commit, pull request and job|
policy-wave|a tf-apply wave whose plan the policy denies applies nothing, and its report keeps the changes of the denied root with the denial and the warnings|
check-diagnostics|tf-check fails with the cause in its log for a validate error, a failing policy test and a choudoufu live-check refusal|
comment-not-affected|a re-plan comment for a root the pull request does not reach is answered that it is not affected and plans nothing, and a re-plan whose forge call fails fails its job with the cause|
drift-attribute|with respond.drift: attribute, tf-drift lists who changed each drifted attribute under its root in the drift issue|
version-bump-job|with respond.version-bump: suggest, the version-bump job of the pipeline runs after the last apply on the default branch and opens a release pull request with the answer of the decision service|
tg-spans|the plan of each Terragrunt unit sends its spans to the report through the TG_TF_PATH wrapper, and waits up to five minutes for the state lock|
oidc-clouds|a job with oidc.gcp and oidc.azure gets an external_account file and the ARM_* variables the google and azurerm providers read, with a token for the audience of each cloud|
comment-apply|a comment on a merged pull request re-runs its apply from the merge commit, applies a wave only once its approval is sealed, and refuses an open pull request and a commenter with no write access|
comment-agent|a /terragucci agent comment pushes the commit of the stand-in agent to the branch of the pull request, which re-plans it and is linked in the reply, and a forbidden path, a non-writer and a fork push nothing|'

say() { echo "SMOKE claim=$1 verdict=$2${3:+ $3}"; }

# --list needs no Docker: `just lint` runs it to catch a broken CLAIMS.
[ "${1:-}" = --list ] || { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; } \
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
  if [ -n "${SMOKE_AWS:-}" ]; then
    smoke_aws_wipe 'shop-(dev|staging|prod)-' envs/ || return 1
    log "wiped the example's repo, and its resources and state in AWS under $SMOKE_AWS_PREFIX-"
    return 0
  fi
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
  # With a guard cut, the second run meets the first's state lock. The default
  # wait is 5m, which is what the BREAK run spent its time on (321 s against 69 s);
  # a few seconds is enough to see that nothing but the guards kept it out.
  if [ -n "$cut" ]; then
    awk '{print} /^  TF_INPUT: / {print "  TF_CLI_ARGS_plan: -lock-timeout=3s"; print "  TF_CLI_ARGS_apply: -lock-timeout=3s"}' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'TF_CLI_ARGS_apply' "$wf" || { log "the pipeline has no env block to set a lock timeout in"; return 1; }
  fi
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
  [ -n "$(remote_head "$USER/in-line" main)" ] && [ -n "$(remote_head "$repo" main)" ] || { log "a pushed main is not listed by git"; return 1; }
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
  sha="$(remote_head "$repo" terragucci/pipeline)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the pull request's check ended $RUN_STATUS"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
  sha="$(remote_head "$repo" main)"
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
  [ -z "${SMOKE_AWS:-}" ] || smoke_aws_overlay_example "$work" || return 1
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
  if [ -n "${SMOKE_AWS:-}" ]; then smoke_aws_bucket "$REPORT_BUCKET" || true
  else curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true; fi
  # REPORT_ENV: extra KEY=VALUE pairs for the stage, space-separated.
  local extra=() kv
  for kv in ${REPORT_ENV:-}; do extra+=(-e "$kv"); done
  [ -n "$base" ] && extra+=(-e "TG_BASE=$base")
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    ${extra[@]+"${extra[@]}"} \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${AWS_DOCKER_ENV[@]}" \
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
  if [ -n "${SMOKE_AWS:-}" ]; then smoke_aws_overlay_example "$work" || return 1; smoke_aws_queue_settle; fi
  for root in "$@"; do
    run_copied --rm --network terragucci -v "$work:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" \
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
  # The bucket's objects: floci's S3 over plain HTTP, or under SMOKE_AWS the aws CLI.
  if [ -n "${SMOKE_AWS:-}" ]; then
    report_get() { smoke_aws_s3_get "$REPORT_BUCKET" "$1"; }
    report_has() { smoke_aws_s3_has "$REPORT_BUCKET" "$1"; }
  else
    report_get() { curl -fsS "$FLOCI/$REPORT_BUCKET/$1"; }
    report_has() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$REPORT_BUCKET/$1")" = 200 ]; }
  fi
  if [ $rc = 0 ]; then
    if ! index="$(report_get "$prefix/index.json")"; then
      log "no index at $REPORT_BUCKET/$prefix/index.json"; rc=1
    else
      for c in "${commits[@]}"; do
        path="$(jq -r --arg c "$c" '.reports[] | select(.commit == $c) | .path' <<<"$index" | head -1)"
        if [ -z "$path" ]; then log "the index does not list commit $c"; rc=1; continue; fi
        report_has "$prefix/$path/report.html" || { log "$path/report.html is not in the bucket"; rc=1; }
        f="$(report_get "$prefix/$path/report.json" | jq -r '.roots[0].plan.text')"
        report_has "$prefix/$path/$f" || { log "$path/$f is not in the bucket"; rc=1; }
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
  # metrics with the report's root count and change totals. The metrics carry
  # no commit (reference/observability.md), so the run is its own project and
  # its series are found by the project label.
  log() { echo "[smoke metrics] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  collector_up || return 1
  local work rc=1 id project report i q want got action env
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  id="$(date +%s)$$${BREAK:+b}"
  env="GITHUB_SERVER_URL=http://smoke.local GITHUB_REPOSITORY=metrics/run-$id OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT"
  # BREAK: metrics off, so nothing reaches Prometheus.
  [ -n "${BREAK:-}" ] && env="$env OTEL_METRICS_EXPORTER=none"
  mkdir -p "$work/run"
  REPORT_ENV="$env" report_run "$work/run" module-bump destroy || true
  report="$work/run/terragucci-report/report.json"
  [ -f "$report" ] || { log "the run wrote no report"; drop_work "$work"; return 1; }
  project="$(jq -r '.run.project' "$report")"
  [ "$project" = "smoke.local/metrics/run-$id" ] || { log "the run's project is $project, want smoke.local/metrics/run-$id"; drop_work "$work"; return 1; }
  value() { curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'; }
  for i in $(seq 1 12); do   # Prometheus scrapes every 5s
    rc=0
    want="$(jq '.roots | length' "$report")"
    got="$(value "terragucci_roots_planned{project=\"$project\"}")"
    [ "$got" = "$want" ] || { rc=1; q="roots_planned: $got, want $want"; }
    for action in create update replace delete; do
      want="$(jq --arg a "$action" '.totals[$a] // 0' "$report")"
      got="$(value "terragucci_plan_changes{project=\"$project\",action=\"$action\"}")"
      [ "$got" = "$want" ] || { rc=1; q="plan_changes $action: $got, want $want"; }
    done
    [ $rc = 0 ] && break
    sleep 5
  done
  drop_work "$work"
  [ $rc = 0 ] || { log "Prometheus does not hold the run's metrics ($q)"; return 1; }
  log "Prometheus holds project $project's roots planned and changes by action, equal to the report"
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
  [ -z "${SMOKE_AWS:-}" ] || queue="$SMOKE_AWS_PREFIX-$queue"
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
    if [ -n "${SMOKE_AWS:-}" ]; then
      smoke_aws_delete_queue "$queue" || { drop_work "$work"; return 1; }
    else
      TERRAGUCCI_FLOCI_URL="$FLOCI" "$EXAMPLE/changes/drift.sh" >&2 || { drop_work "$work"; return 1; }
    fi
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
  run_copied --rm --network terragucci -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TERRAGUCCI_FORGEJO_TOKEN="${TOKEN:-}" \
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
  if [ -n "${SMOKE_AWS:-}" ]; then queue="$SMOKE_AWS_PREFIX-$queue"; extra="$SMOKE_AWS_PREFIX-$extra"; fi
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo respond-drift || return 1
  respond_tree "$work" "$repo" "$(respond_root "respond/drift-$STAMP.tfstate" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
}")"
  [ -z "${SMOKE_AWS:-}" ] || smoke_aws_overlay_example "$work/tree" || return 1
  push_tree "$work/tree" "$repo" main "a queue with a literal timeout" >/dev/null || return 1
  in_image "$work/tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the first apply failed"; return 1; }
  if [ -z "${BREAK:-}" ] && [ -n "${SMOKE_AWS:-}" ]; then
    url="$(smoke_aws_queue_url "$queue")" || { log "$queue is not in AWS"; return 1; }
    sa sqs set-queue-attributes --queue-url "$url" --attributes VisibilityTimeout=45 >/dev/null || return 1
    xurl="$(sa sqs create-queue --queue-name "$extra" | jq -r .QueueUrl)" || return 1
    args=(--import "aws_sqs_queue.extra=$xurl")
  elif [ -z "${BREAK:-}" ]; then
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
  local work repo="$USER/respond-fmt" main_sha head subject mode=apply out refs sha
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
  # Forgejo fills its branch table from a push queue, so /branches/<name> can
  # 404 or lag for seconds after a push. The refs come from git itself, and
  # the commit and file are read by sha.
  refs="$(git ls-remote "${URL/#http:\/\//http://${USER}:${TOKEN}@}/${repo}.git" refs/heads/main refs/heads/smoke-fmt)" || { log "cannot list the repo's branches"; return 1; }
  sha="$(awk '$2 == "refs/heads/smoke-fmt" { print $1 }' <<<"$refs")"
  head="$(awk '$2 == "refs/heads/main" { print $1 }' <<<"$refs")"
  [ -n "$sha" ] || { log "smoke-fmt is gone"; return 1; }
  subject="$(api "$URL/api/v1/repos/$repo/git/commits/$sha?stat=false&files=false&verification=false" | jq -r '.commit.message' | head -1)"
  [ "$subject" = "style: tofu fmt" ] || { log "the branch's last commit is '$subject'"; return 1; }
  api "$URL/api/v1/repos/$repo/raw/app/locals.tf?ref=$sha" | grep -q '^  team  = "orders"$' || { log "locals.tf is not formatted on the branch"; return 1; }
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
  [ -z "${SMOKE_AWS:-}" ] || smoke_aws_overlay_tg "$work" || return 1
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm base
  base="$(git -C "$work" rev-parse HEAD)"
  for p in "$@"; do git -C "$work" apply "$TG_EXAMPLE/changes/$p.patch" || return 1; done
  [ -n "${REPORT_CONFIG:-}" ] && printf '%s\n' "$REPORT_CONFIG" >> "$work/terragucci.yml"
  [ -n "${TG_EDIT:-}" ] && (cd "$work" && eval "$TG_EDIT")
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke $(date +%s%N)"
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${AWS_DOCKER_ENV[@]}" \
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
  if [ -n "${SMOKE_AWS:-}" ]; then smoke_aws_overlay_tg "$work" || return 1; smoke_aws_queue_settle; fi
  for unit in "$@"; do
    run_copied --rm --network terragucci -v "$work:/repo" -w /repo \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" \
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
  if [ -n "${SMOKE_AWS:-}" ]; then
    queue="$SMOKE_AWS_PREFIX-$queue"
    # tg-waves does not run on AWS, so the claim boots the Terragrunt example there itself.
    if ! smoke_aws_queue_url "$queue" >/dev/null; then
      log "$queue is not in AWS; booting the Terragrunt example there"
      "$HERE/example-terragrunt.sh" up >&2 || return 1
    fi
  fi
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
  if [ -z "${BREAK:-}" ] && [ -n "${SMOKE_AWS:-}" ]; then
    smoke_aws_delete_queue "$queue" || { drop_work "$work"; return 1; }
    deleted=1
  elif [ -z "${BREAK:-}" ]; then
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

claim_policy_wave() {
  # stack/fixtures/policy-wave: one root creating a terraform_data resource,
  # local state, gate: never, and a policy that denies terraform_data. A
  # tf-apply wave runs in the tofu CI image; the policy must refuse it: the
  # wave exits 1, the root has no state, and the wave's report.json marks the
  # root failed with policy.result denied, names the denial, and keeps the
  # root's changes. The engine is fetched on demand at its pinned digest.
  #   SMOKE_POLICY_ENGINE=conftest|opa  the engine (default conftest)
  #   SMOKE_POLICY_INPUT=plan|hcp       plan: policy/ (package main, a deny_*
  #     rule and a warn rule, whose warning the report must carry); hcp:
  #     policy-hcp/, an HCP Terraform policy reading input.plan and input.run
  #     (default plan)
  # BREAK: the config turns no policy on, so the wave applies the root.
  log() { echo "[smoke policy-wave] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" code=0 rc=0 r q
  local engine="${SMOKE_POLICY_ENGINE:-conftest}" input="${SMOKE_POLICY_INPUT:-plan}" dir=policy
  [ "$input" = hcp ] && dir=policy-hcp
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$HERE/fixtures/policy-wave/." "$work/"
  [ -z "${BREAK:-}" ] && printf 'policy:\n  engine: %s\n  path: %s\n  input: %s\n' "$engine" "$dir" "$input" >> "$work/terragucci.yml"
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke policy-wave"
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >&2 || code=$?
  clean_mounted "$work" "$image"
  r="$work/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "the wave exited $code, not 1: the policy did not refuse it"; rc=1; }
  if [ -f "$work/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$work/app/terraform.tfstate" >/dev/null 2>&1; then
    log "app has state: the wave applied it"; rc=1
  fi
  if [ ! -f "$r" ]; then
    log "the wave wrote no report"; rc=1
  else
    q='.roots[] | select(.path == "app")'
    jq -e "$q | select(.status == \"failed\" and .policy.result == \"denied\")" "$r" >/dev/null || { log "app is not failed with policy.result denied in the report"; rc=1; }
    jq -e "$q | .policy.denials | any(test(\"terraform_data.probe: terraform_data is not allowed here\"))" "$r" >/dev/null || { log "the report does not name the denial under app"; rc=1; }
    jq -e "$q | .changes | any(.address == \"terraform_data.probe\" and .action == \"create\")" "$r" >/dev/null || { log "the report lost app's change detail"; rc=1; }
    jq -e --arg e "$engine" --arg i "$input" '.policy.engine == $e and .policy.input == $i and (.policy.denied == ["app"])' "$r" >/dev/null || { log "the report's policy field does not name $engine, input $input and app"; rc=1; }
    if [ "$input" = hcp ]; then
      jq -e "$q | .policy.denials | any(test(\"workspace app\"))" "$r" >/dev/null || { log "the HCP policy did not read input.run.workspace.name"; rc=1; }
    else
      jq -e "$q | .policy.warnings | any(test(\"a new resource, check its owner tag\"))" "$r" >/dev/null || { log "the report does not carry the policy's warning"; rc=1; }
    fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "$engine (input $input) refused the wave, app has no state, and the report keeps its change with the denial"
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
  # Changes the example: it boots it from nothing with tf-apply handed to the
  # fountain steward (stack/steward.sh). The push to main goes green, every
  # resource is in floci, and the steward has a `chant run tf-apply` turn it
  # did not have before the push, which completed. The steward may already
  # exist from an earlier boot with turns on its thread, so the new turn is told
  # apart by its id, not by a count. BREAK: the pipeline
  # keeps its own wave jobs, so the forge applies and every resource still
  # appears; only the steward's turns can tell that the steward ran
  # nothing.
  # Like boot, it wipes only the example (its repo, resources and state), not
  # all of floci, so claims on other repos and the Terragrunt example keep
  # running meanwhile. It leaves main carrying the steward's pipeline; boot
  # runs after it and puts the plain example back.
  log() { echo "[smoke steward] $*" >&2; }
  local handover=1 before new rc=0
  [ -n "${BREAK:-}" ] && handover=0
  tf_apply_turns() { "$HERE/steward.sh" turns 2>/dev/null | grep $'\tchant run tf-apply' || true; }
  # The tf-apply turns whose id was not there before the push, oldest first.
  new_turns() { tf_apply_turns | awk -F'\t' 'NR == FNR { seen[$1]; next } !($4 in seen)' <(printf '%s\n' "$before") -; }
  before="$(tf_apply_turns | cut -f4)"
  if (. "$HERE/lib.sh") >/dev/null 2>&1; then
    # shellcheck source=lib.sh
    . "$HERE/lib.sh"
    wipe_example || return 1
  else
    log "no stack yet, so nothing to wipe; example.sh up starts it"
  fi
  TG_STEWARD_HANDOVER=$handover "$HERE/example.sh" up --fountain >&2 || rc=1
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
  # Every comment run, finished or not. Forgejo records a run as soon as the
  # comment lands, waiting or running; when none has appeared after a while,
  # none is coming, and neither is the re-plan.
  comment_runs_any() { api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[] | select(.event == "issue_comment")] | length'; }
  local runs_before any_before wait=$(( TIMEOUT < 240 ? TIMEOUT : 240 ))
  runs_before="$(comment_runs)"
  any_before="$(comment_runs_any)"
  comment "/terragucci plan app"
  for i in $(seq 1 $(( wait / 3 ))); do
    after="$(statuses "$head_sha" terragucci/plan)"
    [ "$after" -gt "$before" ] && [ "$(comment_runs)" -gt "$runs_before" ] && break
    if [ $(( i * 3 )) -ge 90 ] && [ "$(comment_runs_any)" -le "$any_before" ]; then
      log "no run started for the comment in 90s"
      break
    fi
    sleep 3
  done
  after="$(statuses "$head_sha" terragucci/plan)"
  if [ "$after" -le "$before" ]; then
    log "the comment posted no new plan status on the pull request's head ($before before, $after after)"
    # The replan job's decision line says why: who asked, and what stopped it.
    local run job
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq -r '[.workflow_runs[] | select(.event == "issue_comment")] | max_by(.id) | .id // empty')"
    job="$([ -n "$run" ] && api "$URL/api/v1/repos/$repo/actions/runs/$run/jobs" | jq -r '.[] | select(.name == "replan") | .id' | head -1)"
    [ -n "$job" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$job/logs" 2>/dev/null | grep -E 'terragucci( comment)?:' | cut -c30- | sed 's/^/[smoke comment-plan]   /' >&2
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
  grep -q "pull request $pr is not merged" <<<"$replies" || { log "a comment that applies was not refused"; rc=1; }
  grep -q 'envs/nope is not a root' <<<"$replies" || { log "a root outside the configured ones was not refused"; rc=1; }
  grep -q 'the root is a path' <<<"$replies" || { log "a root written as a shell command was not refused"; rc=1; }
  after="$(statuses "$head_sha" terragucci/plan)"
  [ "$after" = "$before" ] || { log "a refused comment still planned ($before before, $after after)"; rc=1; }
  [ "$(statuses "$main_sha" terragucci/apply)" = "$applied_before" ] || { log "main gained an apply status from a comment"; rc=1; }
  [ "$(remote_head "$repo" main)" = "$main_sha" ] || { log "main moved"; rc=1; }
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
# when there is one; otherwise a golang container does, from the archive piped
# into its stdin and unpacked inside it. No host temp dir is bind-mounted, so
# Docker Desktop's VM has no deleted source tree to keep open afterwards; only
# the output dir under .state, which is kept, is mounted.
choudoufu_linux() {
  if [ -n "${CHOUDOUFU_BIN:-}" ]; then echo "$CHOUDOUFU_BIN"; return 0; fi
  local dir="${CHOUDOUFU_DIR:-$HOME/Documents/checkouts/intentius/choudoufu}" ref="${CHOUDOUFU_REF:-origin/main}" sha arch out src go
  sha="$(git -C "$dir" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || { echo "no choudoufu checkout at $dir with $ref; set CHOUDOUFU_DIR or CHOUDOUFU_BIN" >&2; return 1; }
  arch="$(docker version -f '{{.Server.Arch}}' 2>/dev/null)"; [ -n "$arch" ] || arch=amd64
  out="$HERE/.state/choudoufu/$sha-$arch/choudoufu"
  [ -x "$out" ] && { echo "$out"; return 0; }
  mkdir -p "$(dirname "$out")"
  echo "building choudoufu ${sha:0:10} for linux/$arch" >&2
  if command -v go >/dev/null 2>&1; then
    src="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-choudoufu.XXXXXX")"
    git -C "$dir" archive "$sha" | tar -x -C "$src" || { rm -rf "$src"; return 1; }
    (cd "$src" && GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -o "$out" ./cmd/choudoufu) >&2 || { rm -rf "$src"; return 1; }
    rm -rf "$src"
  else
    go="$(git -C "$dir" show "$sha:go.mod" | sed -n 's/^go \([0-9.]*\)$/\1/p')"
    git -C "$dir" archive "$sha" | docker run -i --rm -v "$(dirname "$out"):/out" -v terragucci-go-cache:/root/go \
      -e GOOS=linux -e GOARCH="$arch" -e CGO_ENABLED=0 "golang:${go:-1}" \
      sh -c 'mkdir -p /src && tar -x -C /src && cd /src && go build -o /out/choudoufu ./cmd/choudoufu' >&2 || return 1
  fi
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
    run_copied -d --name "$holder" --network terragucci -v "$work/holder:/repo" -w /repo/lock -v "$bin:/usr/local/bin/choudoufu:ro" \
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
    run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" -v "$bin:/usr/local/bin/choudoufu:ro" \
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
  # The stack's reports bucket, as scripts/render-dashboards.ts names it: the Runs and Estate dashboards link it.
  printf '\ndashboards: true\nreports:\n  bucket: s3://terragucci-reports\n  prefix: reports\n  url: http://localhost:%s/terragucci-reports\n' "${TERRAGUCCI_FLOCI_PORT:-4580}" >> "$dir/terragucci.yml"
  (cd "$dir" && "$TERRAGUCCI" init --forge forgejo --dry-run --json) | jq -j --arg f "$f" '.results.files[] | select(.path == $f) | .content' > "$1/rendered.json"
  [ -s "$1/rendered.json" ] || { log "init wrote no $f"; return 1; }
  # The committed file carries a placeholder for floci's port; the compose file swaps it in for Grafana.
  sed "s/TGPH0FLOCIPORT/${TERRAGUCCI_FLOCI_PORT:-4580}/g" "$HERE/observability/terragucci/grafana/dashboards/$2.json" > "$1/committed.json"
  cmp -s "$1/rendered.json" "$1/committed.json" \
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
  run_copied --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
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
# of the query is the dashboard's own. Panels can share a title (an SLO
# dashboard shows its error budget as a stat and as a graph), so each query
# gets its own refId; Grafana refuses a request that repeats one. A NaN comes
# back as null and is not counted: the panel shows no number for it.
panel_points() { # uid, panel title
  local dash body
  dash="$(curl -fsS "$GRAFANA/api/dashboards/uid/$1")" || { echo 0; return 0; }
  body="$(jq -c --arg t "$2" --arg p "$DASH_PROJECT" '
    def fill: gsub("\\$project"; $p) | gsub("\\$stage"; ".+") | gsub("\\$__range"; "1h") | gsub("\\$__rate_interval"; "1m") | gsub("\\$__interval"; "15s");
    [.dashboard.panels[] | (., (.panels // [])[]) | select(.title == $t) | (.datasource // {}) as $ds | (.targets // [])[]
      | . + {datasource: (.datasource // $ds), intervalMs: 15000, maxDataPoints: 200}
      | if .expr then .expr |= fill else . end
      | if .query then .query |= fill else . end]
    | to_entries | map(.value + {refId: "q\(.key)"})
    | {queries: ., from: "now-1h", to: "now"}' <<<"$dash")"
  [ "$(jq '.queries | length' <<<"$body")" -gt 0 ] || { echo 0; return 0; }
  curl -fsS -H 'content-type: application/json' -X POST -d "$body" "$GRAFANA/api/ds/query" 2>/dev/null \
    | jq '[.results[]?.frames[]?.data.values // [] | .[1:][]? | map(select(. != null)) | length] | add // 0' 2>/dev/null || echo 0
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
    # Up to 90s: the span metrics flush, the scrape and Tempo's ingest. Under
    # BREAK nothing was sent, and a flush (5s), a scrape (5s) and Tempo's ingest
    # have all had their turn after 30s, so the absence is certain by then.
    local tries=18
    [ -n "${BREAK:-}" ] && tries=6
    for i in $(seq 1 "$tries"); do
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
  dash_claim terragucci-pipeline-health "Runs per hour" "Errors" "Duration p95" "Runs by result"
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
  dash_claim terragucci-rollouts-waves "Waves waiting" "Waiting for" "Wave runs by result" "Refused and failed waves" "Roots per wave"
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
  # Prometheus and Grafana may not be up yet on a fresh stack.
  dash_up || { log "the observability profile did not start"; return 1; }
  docker exec terragucci-prometheus promtool check rules /etc/prometheus/rules/terragucci.rules.yml >&2 \
    || { log "promtool does not accept the rules file"; return 1; }
  local slo
  for slo in slo-terragucci-apply-success slo-terragucci-drift-corrected; do
    curl -fsS -o /dev/null "$GRAFANA/api/dashboards/uid/$slo" || { log "Grafana does not serve dashboard $slo"; return 1; }
  done
  dash_claim slo-terragucci-plan-time "Error budget remaining" || return 1
  # The SLO panels read every project's series; this project's own error
  # budget must be among them, as a number: its one plan counts, so the
  # budget is not 0/0.
  local q n=0 i
  q="slo:error_budget:remaining{slo=\"terragucci-plan-time\",terragucci_project=\"$DASH_PROJECT\"}"
  for i in $(seq 1 12); do   # the rules evaluate every 5s
    n="$(curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$q" | jq '[.data.result[] | select(.value[1] != "NaN")] | length')"
    [ "${n:-0}" -gt 0 ] && break
    sleep 5
  done
  [ "${n:-0}" -gt 0 ] || { log "Prometheus recorded no plan SLO error budget for $DASH_PROJECT"; return 1; }
  log "the plan SLO recorded $DASH_PROJECT's plans, and its error budget"
}

# ── drill-down ────────────────────────────────────────────────────────────
# One plan run with reports.url and telemetry.trace_url set, then the path a
# reader clicks: the note's link to report.html in the bucket (its anchors
# there), a root's plan from the report, the report's trace link (Tempo's API,
# which answers only for a trace it holds) whose stage span names the report's
# address, the Runs dashboard's link from the trace to the report and the
# Estate dashboard's link to the index, and the index row's links to the
# commit, the pull request and the job.
# BREAK: reports.url names a bucket that does not exist, so the note's link is
# broken and the walk stops at its first step.

claim_drill_down() {
  log() { echo "[smoke drill-down] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_up || return 1
  local work rc=0 id project base cfg env url html dir f anchor trace link body i dash got index row page
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  id="$(date +%s)$$${BREAK:+b}"
  project="smoke.local/drill/run-$id"
  # The prefix and address the stack's dashboards are rendered with (scripts/render-dashboards.ts).
  base="$FLOCI/$REPORT_BUCKET"
  [ -n "${BREAK:-}" ] && base="$FLOCI/$REPORT_BUCKET-gone"
  cfg="$(printf 'reports:\n  bucket: s3://%s\n  prefix: reports\n  url: "%s"\ntelemetry:\n  trace_url: "%s"\n' "$REPORT_BUCKET" "$base" "$TEMPO/api/traces/{trace_id}")"
  env="GITHUB_SERVER_URL=http://smoke.local GITHUB_REPOSITORY=drill/run-$id GITHUB_RUN_ID=1 TG_PR=7 OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT"
  mkdir -p "$work/run"
  # The run's page, as the pipeline passes it on GitHub and Forgejo: the bucket's copy must win over it.
  (REPORT_ARGS=(--root envs/staging/orders --report-url "http://smoke.local/drill/run-$id/actions/runs/1"); REPORT_CONFIG="$cfg" REPORT_ENV="$env" report_run "$work/run" module-bump) || true
  dir="$work/run/terragucci-report"
  [ -f "$dir/note.md" ] && [ -f "$dir/report.json" ] || { log "the plan wrote no report"; drop_work "$work"; return 1; }

  # 1. The note links report.html in the bucket, and the page is there.
  url="$(grep -o '\[Full report\]([^)]*)' "$dir/note.md" | head -1 | sed -E 's/^\[Full report\]\((.*)\)$/\1/')"
  [ "$url" = "$(jq -r '.run.report_url // empty' "$dir/report.json")" ] && [ -n "$url" ] || { log "the note links '$url', not the bucket's report.html"; rc=1; }
  html="$work/report.html"
  if [ $rc = 0 ] && ! curl -fsS -o "$html" "$url"; then log "the note's link $url does not open"; rc=1; fi
  # 2. Its anchors are on that page, and it links a root's plan, which opens.
  if [ $rc = 0 ]; then
    for anchor in $(grep -o "$url#[^)]*" "$dir/note.md" | sed 's/.*#//' | sort -u); do
      grep -q "id=\"$anchor\"" "$html" || { log "the note links #$anchor, which the report does not have"; rc=1; }
    done
    f="$(jq -r '[.roots[] | select(.status == "planned")][0].plan.text // empty' "$dir/report.json")"
    [ -n "$f" ] && grep -q "href=\"$f\"" "$html" || { log "the report does not link a root's plan"; rc=1; }
    [ -n "$f" ] && curl -fsS -o /dev/null "${url%/report.html}/$f" || { log "the plan ${url%/report.html}/$f does not open"; rc=1; }
  fi
  # 3. The report links the run's trace, and the trace links the report.
  trace="$(jq -r '.run.trace_id // empty' "$dir/report.json")"
  if [ $rc = 0 ]; then
    link="$(grep -o '<a href="[^"]*" id="trace">' "$html" | sed -E 's/<a href="([^"]*)".*/\1/' | sed 's/&amp;/\&/g')"
    [ -n "$trace" ] && [ "$link" = "$TEMPO/api/traces/$trace" ] || { log "the report links trace '$link' for trace id '$trace'"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    got=""
    for i in $(seq 1 18); do   # Tempo's ingest
      body="$(curl -fsS "$link" 2>/dev/null)" && got="$(jq -r '[.. | objects | select(.key? == "terragucci.report.url") | .value.stringValue][0] // empty' <<<"$body" 2>/dev/null)"
      [ -n "$got" ] && break
      sleep 5
    done
    [ "$got" = "$url" ] || { log "trace $trace does not name the report (terragucci.report.url '$got')"; rc=1; }
  fi
  # 4. The Runs dashboard links the trace to its report; the Estate dashboard links the index.
  if [ $rc = 0 ]; then
    dash="$(curl -fsS "$GRAFANA/api/dashboards/uid/terragucci-runs")" || { log "Grafana does not serve the Runs dashboard"; rc=1; }
    page="$(jq -r '[.dashboard.panels[] | (., (.panels // [])[]) | select(.title == "Runs") | .fieldConfig.overrides[]? | select(.matcher.options == "traceName") | .properties[].value[]?.url][0] // empty' <<<"$dash" 2>/dev/null)"
    page="${page//\$\{__data.fields.traceID\}/$trace}"
    [ -n "$page" ] && curl -fsS "$page" 2>/dev/null | grep -q "${url#"$base"/reports/}" \
      || { log "the Runs dashboard's link from trace $trace ($page) does not lead to its report"; rc=1; }
    dash="$(curl -fsS "$GRAFANA/api/dashboards/uid/terragucci-estate")" || { log "Grafana does not serve the Estate dashboard"; rc=1; }
    index="$(jq -r '[.dashboard.links[]?.url][0] // empty' <<<"$dash" 2>/dev/null)"
    [ -n "$index" ] && curl -fsS "$index" 2>/dev/null | grep -q "$project" \
      || { log "the Estate dashboard's index link ($index) does not list $project"; rc=1; }
  fi
  # 5. The project's index row links the commit, the pull request and the job.
  if [ $rc = 0 ]; then
    row="$(curl -fsS "$base/reports/$project/index.json" | jq -c --arg c "$(git -C "$work/run" rev-parse HEAD)" '[.reports[] | select(.commit == $c)][0] // empty')"
    [ -n "$row" ] && [ "$(jq -r '.commit_url' <<<"$row")" = "http://smoke.local/drill/run-$id/commit/$(jq -r .commit <<<"$row")" ] \
      && [ "$(jq -r '.pull_request_url' <<<"$row")" = "http://smoke.local/drill/run-$id/pull/7" ] \
      && [ "$(jq -r '.job_url' <<<"$row")" = "http://smoke.local/drill/run-$id/actions/runs/1" ] \
      || { log "the index row does not link the commit, the pull request and the job: $row"; rc=1; }
    curl -fsS "$base/reports/$project/index.html" | grep -q 'href="http://smoke.local/drill/run-'"$id"'/pull/7"' \
      || { log "the index page does not link the pull request"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "note -> $url -> $f -> trace $trace -> back to the report; the dashboards and the index row link down"
}

# ── tf-check's diagnostics ────────────────────────────────────────────────
# The check step of a pipeline as it was before tf-check printed diagnostics:
# validate with its output thrown away, no live-check, no policy tests.
check_step_unchecked() { # workflow file
  sed -i.bak -e 's#terragucci check-root "$dir" --binary \([a-z]*\) || failed=1#\1 -chdir="$dir" validate -no-color >/dev/null#' \
    -e '/terragucci check-policy || failed=1/d' "$1" && rm -f "$1.bak"
}

# The run: body of a Forgejo workflow's "Format check and validate" step, dedented.
check_step_body() { # workflow file
  awk '/name: Format check and validate/ { f = 1; next }
    f && /run: \|/ { r = 1; next }
    r && /^      - / { exit }
    r { sub(/^          /, ""); print }' "$1"
}

claim_check_diagnostics() {
  # tf-check fails with the cause in its job log for each of three faults. On
  # a scratch repo whose main carries a policy (terragucci.yml's policy:, a
  # Rego rule and its test), main goes green first. Then:
  #   validate  a branch whose root sets an argument its resource does not
  #             have: the check job fails and its log names the file, the
  #             line and column, and "Unsupported argument".
  #   policy    main gains a policy test that fails, and a branch that
  #             rewrites the test to pass: the check job reads the test from
  #             main, fails, and its log says conftest verify failed on the
  #             policy read from origin/main and names the test.
  #   live-check a binary: choudoufu repo whose root holds a terraform_data
  #             resource and no live block: init writes its pipeline in the
  #             choudoufu CI image, and the check step, run in that image,
  #             fails and its log names the refused resource. The Forgejo
  #             runner's job image is the tofu one, so this one runs the job's
  #             own script in the choudoufu image rather than on the runner.
  # BREAK: every pipeline's check step is the one before tf-check printed
  # diagnostics (validate -no-color >/dev/null, no live-check, no policy
  # tests), so the validate error is not named, and the failing policy test
  # and the refusal pass.
  log() { echo "[smoke check-diagnostics] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/checkdiag" tree wf sha main_sha logs rc=0 image cimage bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" code=0 body cdir
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  # The check job's own log, whole.
  check_log() { # run id
    local job
    job="$(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r '.[] | select(.name == "check") | .id' | head -1)"
    [ -n "$job" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$job/logs" 2>/dev/null
  }
  fresh_repo checkdiag || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$tree/app" "$tree/policy"
  cat > "$tree/app/main.tf" <<'TF'
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

resource "terraform_data" "probe" {
  input = "check-diagnostics"
}
TF
  cat > "$tree/policy/plan.rego" <<'REGO'
package main

import rego.v1

deny contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_instance"
  msg := sprintf("%s: no instances here", [rc.address])
}
REGO
  policy_test() { # the count the test expects: 1 passes, 0 fails
    printf 'package main\n\nimport rego.v1\n\ntest_denies_an_instance if {\n  count(deny) == %s with input as {"resource_changes": [{"address": "aws_instance.web", "type": "aws_instance"}]}\n}\n' "$1" > "$tree/policy/plan_test.rego"
  }
  policy_test 1
  printf 'forge: forgejo\nbinary: tofu\ngate: never\npolicy:\n  engine: conftest\n  path: policy\n' > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  grep -q 'terragucci check-root' "$wf" || { log "the pipeline's check step runs no terragucci check-root"; return 1; }
  [ -n "${BREAK:-}" ] && check_step_unchecked "$wf"
  main_sha="$(push_tree "$tree" "$repo" main "check-diagnostics: clean")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the clean push to main ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" >&2; return 1; }

  # validate: an argument terraform_data does not have.
  awk '{ print } /^  input = "check-diagnostics"$/ { print "  bogus = 1" }' "$tree/app/main.tf" > "$tree/app/main.tf.new" && mv "$tree/app/main.tf.new" "$tree/app/main.tf"
  grep -q '^  bogus = 1$' "$tree/app/main.tf" || { log "could not add the bogus argument"; return 1; }
  sha="$(push_tree "$tree" "$repo" diag-validate "check-diagnostics: unsupported argument")" || return 1
  wait_run "$repo" "$sha" || return 1
  logs="$(check_log "$RUN_ID")"
  if [ "$RUN_STATUS" != failure ]; then
    log "the push with an unsupported argument ended '$RUN_STATUS'"; rc=1
  elif grep -Eq 'error: app/main\.tf:[0-9]+:[0-9]+[-0-9:]*: Unsupported argument' <<<"$logs"; then
    log "validate: $(grep -Eo 'error: app/main\.tf:[0-9]+:[0-9]+[-0-9:]*: Unsupported argument' <<<"$logs" | head -1)"
  else
    log "the check failed but its log does not name app/main.tf with a line and column and 'Unsupported argument'"
    grep -E 'Unsupported|FAILED|valid ' <<<"$logs" | cut -c1-200 | sed 's/^/[smoke check-diagnostics]   /' >&2 || true
    rc=1
  fi
  git -C "$tree" checkout -q main

  # policy: main's test fails; the branch's copy passes, and is not the one read.
  policy_test 0
  main_sha="$(push_tree "$tree" "$repo" main "check-diagnostics: a failing policy test")" || return 1
  git -C "$tree" checkout -q -b diag-policy
  policy_test 1
  sha="$(push_tree "$tree" "$repo" diag-policy "check-diagnostics: the branch's policy test passes")" || return 1
  wait_run "$repo" "$sha" || return 1
  logs="$(check_log "$RUN_ID")"
  if [ "$RUN_STATUS" != failure ]; then
    log "the push under main's failing policy test ended '$RUN_STATUS'"; rc=1
  elif grep -Eq 'FAILED policy tests: conftest verify exited [0-9]+ \(read from origin/main' <<<"$logs" && grep -q 'test_denies_an_instance' <<<"$logs"; then
    log "policy: $(grep -Eo 'FAILED policy tests: conftest verify exited [0-9]+ \(read from origin/main[^)]*\)' <<<"$logs" | head -1), naming test_denies_an_instance"
  else
    log "the check failed but its log does not say conftest verify failed on main's policy and name test_denies_an_instance"
    grep -E 'policy|FAIL' <<<"$logs" | cut -c1-200 | sed 's/^/[smoke check-diagnostics]   /' >&2 || true
    rc=1
  fi
  wait_run "$repo" "$main_sha" >/dev/null 2>&1 || true

  # live-check: a choudoufu root that holds a logical resource and no live block.
  cimage="$(image_tag choudoufu)"
  docker image inspect "$cimage" >/dev/null 2>&1 || { log "no CI image $cimage; run 'just images' first"; return 1; }
  cdir="$work/choudoufu"
  mkdir -p "$cdir/app"
  cp "$tree/app/main.tf" "$cdir/app/main.tf"
  sed -i.bak '/^  bogus = 1$/d' "$cdir/app/main.tf" && rm -f "$cdir/app/main.tf.bak"
  printf 'forge: forgejo\nbinary: choudoufu\ngate: never\n' > "$cdir/terragucci.yml"
  (cd "$cdir" && "$TERRAGUCCI" init >/dev/null) || { log "init failed for the choudoufu repo"; return 1; }
  [ -n "${BREAK:-}" ] && check_step_unchecked "$cdir/.forgejo/workflows/terragucci.yml"
  body="$(check_step_body "$cdir/.forgejo/workflows/terragucci.yml")"
  grep -q '^choudoufu fmt -check' <<<"$body" || { log "no check step for choudoufu in the pipeline init wrote"; return 1; }
  grep -qF "image: $cimage" "$cdir/.forgejo/workflows/terragucci.yml" || { log "the pipeline init wrote for the choudoufu repo does not run in $cimage"; return 1; }
  run_copied --rm --network terragucci -v "$cdir:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$cimage" sh -c "$body" >"$work/choudoufu.log" 2>&1 || code=$?
  if [ "$code" = 0 ]; then
    log "the choudoufu check step passed: nothing refused terraform_data.probe"; rc=1
  elif grep -q 'refused: app: terraform_data.probe (terraform_data)' "$work/choudoufu.log"; then
    log "live-check: $(grep -m1 'refused: app: terraform_data.probe' "$work/choudoufu.log" | cut -c1-200)"
  elif grep -q '^refused: app:.*terraform_data' "$work/choudoufu.log" && grep -q '^refused: app:.*Logical resource is not admitted' "$work/choudoufu.log"; then
    log "live-check (text output): $(grep -m1 '^refused: app:.*Logical resource is not admitted' "$work/choudoufu.log" | cut -c1-200)"
  else
    log "the choudoufu check step exited $code but its log names no refusal of terraform_data.probe"
    tail -20 "$work/choudoufu.log" | sed 's/^/[smoke check-diagnostics]   /' >&2
    rc=1
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] || return 1
  log "tf-check failed with the cause in its log for a validate error, a failing policy test read from main, and a choudoufu live-check refusal"
}

# ── comment re-plans that plan nothing ────────────────────────────────────
claim_comment_not_affected() {
  # A scratch repo with two roots, app and net, the pipeline init writes for
  # it, a push to main, and a pull request that changes app only. Then, as
  # the repo's admin:
  #   `/terragucci plan net`  the comment's run succeeds, replies "net is not
  #       affected by this pull request, so nothing was planned.", and the
  #       pull request's head gains no terragucci/plan status, pending or not.
  #   `/terragucci plan app`, after main's pipeline gives the re-plan job a
  #       token the forge refuses: the run fails, and the job's log says it
  #       could not read the pull request and what the forge answered. On
  #       Forgejo the commenter's permission comes from the event, not the
  #       API, so the forge call that fails is the pull request read, not the
  #       permission read; the token is refused outright (401), not short of
  #       a permission (403).
  # BREAK: the pushed pipeline is the re-plan job as it was before: it neither
  # answers a root the change does not reach nor fails when `terragucci
  # comment` does (its `|| exit 1` is `|| exit 0`).
  log() { echo "[smoke comment-not-affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-na" tree wf main_sha head_sha pr i rc=0 before after last root replies logs
  local wait=$(( TIMEOUT < 240 ? TIMEOUT : 240 ))
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo comment-na || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in app net; do
    mkdir -p "$tree/$root"
    echo 1 > "$tree/$root/rev.txt"
    cat > "$tree/$root/main.tf" <<'TF'
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
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n' > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml) || { log "init failed"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  grep -q 'is not affected by this pull request' "$wf" || { log "the pipeline's re-plan job has no not-affected answer"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak -e '/is not affected by this pull request/d' \
      -e 's#--out terragucci-comment.json || exit 1#--out terragucci-comment.json || exit 0#' "$wf" && rm -f "$wf.bak"
  fi
  main_sha="$(push_tree "$tree" "$repo" main "comment-na: first")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green"; return 1; }
  echo 2 > "$tree/app/rev.txt"
  head_sha="$(push_tree "$tree" "$repo" comment-na-change "comment-na: change app")" || return 1
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"comment-na-change","base":"main","title":"comment-na: app"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  log "pull request $pr for ${head_sha:0:8}"
  statuses() { # sha -> how many terragucci/plan statuses it carries
    api "$URL/api/v1/repos/$repo/commits/$1/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/plan")] | length'
  }
  latest_status() { # sha -> the state of its newest terragucci/plan status
    api "$URL/api/v1/repos/$repo/commits/$1/statuses?limit=100" | jq -r '[.[] | select(.context == "terragucci/plan")] | max_by(.id) | .status // "none"'
  }
  comment() { # text -> posts it as the repo's admin
    api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$1" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$pr/comments"
  }
  last_comment_run() { api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[] | select(.event == "issue_comment") | .id] | max // 0'; }
  # Wait for the first comment run newer than $1 to finish; sets CR_ID and CR_STATUS.
  wait_comment_run() { # run id
    local run
    CR_ID=""; CR_STATUS=""
    for i in $(seq 1 $(( wait / 3 ))); do
      run="$(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq -c --argjson after "$1" '[.workflow_runs[] | select(.event == "issue_comment" and .id > $after)] | min_by(.id) // empty')"
      if [ -n "$run" ]; then
        CR_ID="$(jq -r .id <<<"$run")"; CR_STATUS="$(jq -r .status <<<"$run")"
        case "$CR_STATUS" in success|failure|cancelled|skipped) return 0 ;; esac
      elif [ $(( i * 3 )) -ge 90 ]; then
        log "no run started for the comment in 90s"; return 1
      fi
      sleep 3
    done
    log "the comment's run $CR_ID did not finish in ${wait}s (last status: ${CR_STATUS:-none})"; return 1
  }
  replan_log() { # run id
    local job
    job="$(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r '.[] | select(.name == "replan") | .id' | head -1)"
    [ -n "$job" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$job/logs" 2>/dev/null
  }
  # The pull request's own plan runs first; the comments' runs come after it.
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(statuses "$head_sha")" -ge 2 ] && break
    sleep 3
  done
  before="$(statuses "$head_sha")"
  [ "$before" -ge 2 ] || { log "the pull request's own plan never finished"; return 1; }

  # Not affected: net is a root, and the change does not reach it.
  last="$(last_comment_run)"
  comment "/terragucci plan net"
  if wait_comment_run "$last"; then
    [ "$CR_STATUS" = success ] || { log "the not-affected comment's run ended '$CR_STATUS', not success"; rc=1; }
    replies="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | map(.body) | join("\n")')"
    grep -Fqx 'terragucci: net is not affected by this pull request, so nothing was planned.' <<<"$replies" \
      || { log "no reply says net is not affected (replies: ${replies:-none})"; rc=1; }
    after="$(statuses "$head_sha")"
    [ "$after" = "$before" ] || { log "the not-affected comment posted terragucci/plan statuses ($before before, $after after)"; rc=1; }
    [ "$(latest_status "$head_sha")" != pending ] || { log "the head's newest terragucci/plan status is pending"; rc=1; }
    [ $rc = 0 ] && log "/terragucci plan net: run $CR_ID succeeded, replied that net is not affected, and left the head's $before plan statuses as they were"
  else
    rc=1
  fi

  # An infrastructure error: main's pipeline gives the re-plan job a token the forge refuses.
  git -C "$tree" checkout -q main
  sed -i.bak "/^  replan:/,/TG_TOKEN:/s/TG_TOKEN: '\${{ github.token }}'/TG_TOKEN: 'not-a-forgejo-token'/" "$wf" && rm -f "$wf.bak"
  grep -q "TG_TOKEN: 'not-a-forgejo-token'" "$wf" || { log "could not give the re-plan job a refused token"; return 1; }
  main_sha="$(push_tree "$tree" "$repo" main "comment-na: the re-plan job's token is refused")" || return 1
  wait_run "$repo" "$main_sha" >/dev/null 2>&1 || true
  before="$(statuses "$head_sha")"
  last="$(last_comment_run)"
  comment "/terragucci plan app"
  if wait_comment_run "$last"; then
    logs="$(replan_log "$CR_ID")"
    if [ "$CR_STATUS" != failure ]; then
      log "the re-plan whose forge call was refused ended '$CR_STATUS', not failure"; rc=1
    elif grep -Eq "could not read pull request $pr \(GET repos/$repo/pulls/$pr answered 40[0-9]\)" <<<"$logs"; then
      log "/terragucci plan app with a refused token: run $CR_ID failed: $(grep -Eo "could not read pull request $pr \(GET [^)]*\)" <<<"$logs" | head -1)"
    else
      log "the run failed but the re-plan job's log does not say the pull request read was refused"
      grep -E 'terragucci( comment)?:' <<<"$logs" | cut -c1-200 | sed 's/^/[smoke comment-not-affected]   /' >&2 || true
      rc=1
    fi
    after="$(statuses "$head_sha")"
    [ "$after" = "$before" ] || { log "the refused re-plan posted terragucci/plan statuses ($before before, $after after)"; rc=1; }
  else
    rc=1
  fi
  drop_work "$work" 2>/dev/null || true
  [ "$rc" = 0 ] && log "a root the change does not reach was answered not affected and planned nothing, and a re-plan whose forge call was refused failed its job with the cause"
  return "$rc"
}

claim_drift_attribute() {
  # A scratch repo with one root, a queue with a literal visibility timeout,
  # is applied to floci; then the timeout is changed in floci, outside
  # Terraform. With respond.drift: attribute in terragucci.yml, a tf-drift run
  # must open the drift issue with "Who changed it" under the root, naming the
  # person the audit log gives for the timeout. floci has no CloudTrail and
  # the CI image has no aws CLI, so the run's `aws` is a stand-in that answers
  # LookupEvents with one SetQueueAttributes record by the IAM user alice, as
  # drift.test.ts's fake audit log does; the claim also checks the run asked
  # it about this queue by name.
  # BREAK: the config leaves respond.drift at its default, so the run
  # attributes nothing and the issue says nothing of who.
  log() { echo "[smoke drift-attribute] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/drift-attribute" queue="tg-attr-$STAMP" key="respond/attribute-$STAMP.tfstate" tree url issues body image rc=0
  local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  image="$(image_tag tofu)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo drift-attribute || return 1
  respond_tree "$work" "$repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
}")"
  [ -n "${BREAK:-}" ] || printf 'respond:\n  drift: attribute\n' >> "$tree/terragucci.yml"
  push_tree "$tree" "$repo" main "a queue with a literal timeout" >/dev/null || return 1
  in_image "$tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the first apply failed"; return 1; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r .QueueUrl)"
  sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null || { log "could not change $queue's timeout"; return 1; }
  # The stand-in audit log: every call is noted, and lookup-events answers one write by a person.
  mkdir -p "$work/smoke"
  cat > "$work/smoke/aws" <<'SH'
#!/bin/sh
echo "$*" >> /smoke/aws-calls.log
[ "$1 $2" = "cloudtrail lookup-events" ] || { echo "the smoke stand-in answers only cloudtrail lookup-events" >&2; exit 1; }
cat <<'JSON'
{"Events":[{"EventName":"SetQueueAttributes","EventTime":"2026-10-01T09:00:00Z","CloudTrailEvent":"{\"eventName\":\"SetQueueAttributes\",\"eventTime\":\"2026-10-01T09:00:00Z\",\"readOnly\":false,\"userAgent\":\"aws-cli/2.17.0\",\"userIdentity\":{\"type\":\"IAMUser\",\"userName\":\"alice\",\"arn\":\"arn:aws:iam::000000000000:user/alice\"}}"}]}
JSON
SH
  chmod +x "$work/smoke/aws"
  open_issues() { api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  run_copied --rm --network terragucci -v "$tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$work/smoke:/smoke" -v "$work/smoke/aws:/usr/local/bin/aws:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TERRAGUCCI_FORGEJO_TOKEN="${TOKEN:-}" \
    -e "GITHUB_REPOSITORY=$repo" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-drift --forge forgejo --report-url "http://forgejo:3000/$repo/actions" >&2 || true
  clean_mounted "$tree" "$image"
  if [ ! -f "$tree/terragucci-report/report.json" ]; then
    log "the drift run wrote no report"; rc=1
  else
    jq -e '[.roots[].changes[] | .attributes[]?.path] | index("visibility_timeout_seconds")' "$tree/terragucci-report/report.json" >/dev/null \
      || { log "the report does not show the timeout drifted"; rc=1; }
    grep -q "AttributeValue=$queue" "$work/smoke/aws-calls.log" 2>/dev/null \
      || { log "the run never asked the audit log about $queue"; rc=1; }
    issues="$(open_issues)"
    [ "$(jq length <<<"$issues")" = 1 ] || { log "expected one open drift issue, found $(jq length <<<"$issues")"; rc=1; }
    body="$(jq -r '.[0].body // ""' <<<"$issues")"
    awk '/^#### /{ f = index($0, "`app`") > 0 } f' <<<"$body" | grep -qx -- '- Who changed it:' \
      || { log "the issue has no 'Who changed it' under app"; rc=1; }
    # shellcheck disable=SC2016 # the backticks are the issue's markdown
    grep -Fq '`aws_sqs_queue.jobs` `visibility_timeout_seconds`: a person (audit log: SetQueueAttributes by alice at 2026-10-01T09:00:00Z)' <<<"$body" \
      || { log "the issue does not name alice for the timeout"; rc=1; }
    [ $rc = 0 ] || grep -A8 'Who changed it' <<<"$body" | sed 's/^/[smoke drift-attribute]   /' >&2 || true
  fi
  # The queue is this run's own; it goes with the claim.
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  drop_work "$work" "$image" 2>/dev/null || true
  [ $rc = 0 ] && log "the drift issue lists who changed it under app: alice, from the audit log, for visibility_timeout_seconds"
  return $rc
}

claim_version_bump_job() {
  # A scratch repo with one root, app, and a module, modules/queue, released
  # as modules/queue/v0.1.0. main then gains a commit to the module with no
  # conventional type, so only the decision service can suggest its bump.
  # terragucci.yml sets respond.version-bump: suggest and decide: at the
  # stack's service (http://decide:8790), and the repo commits the pipeline
  # init writes. The push to main must run the version-bump job after the
  # apply wave, and the job must open the release pull request that writes
  # modules/queue/version, its body saying what the service answered.
  # The service is opt-in (stack/decide.sh up builds a 1.5 GB image). When it
  # is running, the body must carry its answer. When it is not, the job's call
  # gets no answer, the pull request proposes a patch and says the service did
  # not answer, and the claim's evidence says so: it then shows the job runs
  # and reaches the service call, not a model's suggestion.
  # BREAK: the config leaves version-bump off, so the pipeline has no
  # version-bump job and no release pull request opens.
  log() { echo "[smoke version-bump-job] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/version-bump" tree wf sha jobs job status pr body logs decide_up="" remote rc=0
  local c=(git -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false)
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  [ -n "$(docker ps -q --filter name=terragucci-decide --filter health=healthy 2>/dev/null)" ] && decide_up=1
  fresh_repo version-bump || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$tree/app" "$tree/modules/queue"
  respond_root "respond/version-bump.tfstate" 'resource "terraform_data" "mark" {}' > "$tree/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/app/"
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/respond/version-bump.tfstate" || true
  printf 'variable "name" {\n  type = string\n}\n\nresource "aws_sqs_queue" "jobs" {\n  name = var.name\n}\n' > "$tree/modules/queue/main.tf"
  printf 'binary: tofu\nforge: forgejo\nroots: ["app"]\ndecide:\n  backend: laya\n  url: http://decide:8790\nrespond:\n  tips: "off"\n' > "$tree/terragucci.yml"
  [ -n "${BREAK:-}" ] || printf '  version-bump: suggest\n' >> "$tree/terragucci.yml"
  (cd "$tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  if [ -z "${BREAK:-}" ]; then
    awk '/^  version-bump:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$wf" | grep -q '^    needs: apply-wave-1$' \
      || { log "the pipeline has no version-bump job after apply-wave-1"; return 1; }
  fi
  # The release, then a change to the module that names no conventional type.
  (cd "$tree" && git add -A && "${c[@]}" commit -qm "add the queue module" && git tag modules/queue/v0.1.0) || return 1
  printf '\nvariable "tags" {\n  type    = map(string)\n  default = {}\n}\n' >> "$tree/modules/queue/main.tf"
  (cd "$tree" && git add -A && "${c[@]}" commit -qm "add an optional tags variable to the queue module") || return 1
  # The tag and main in one push: the pipeline runs on branches only, so the tag starts no run.
  remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  git -C "$tree" push -q --force "$remote" refs/tags/modules/queue/v0.1.0 HEAD:refs/heads/main 2>/dev/null || { log "the push failed"; return 1; }
  sha="$(git -C "$tree" rev-parse HEAD)"
  wait_run "$repo" "$sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the run ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; return 1; }
  jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
  [ "$(jq -r '.[] | select(.name == "apply-wave-1") | .status' <<<"$jobs")" = success ] || { log "apply-wave-1 did not succeed"; rc=1; }
  job="$(jq -r '.[] | select(.name == "version-bump") | .id' <<<"$jobs" | head -1)"
  if [ -z "$job" ]; then
    log "the run has no version-bump job"; return 1
  fi
  status="$(jq -r --argjson id "$job" '.[] | select(.id == $id) | .status' <<<"$jobs")"
  [ "$status" = success ] || { log "the version-bump job ended '$status'"; rc=1; }
  logs="$(api "$URL/api/v1/repos/$repo/actions/jobs/$job/logs" 2>/dev/null || true)"
  if grep -Eq 'modules/queue 0\.1\.0 -> ' <<<"$logs"; then
    grep -E 'modules/queue 0\.1\.0 -> ' <<<"$logs" | head -3 | sed 's/^/[smoke version-bump-job]   /' >&2
  else
    log "the job's log has no suggestion for modules/queue"; rc=1
  fi
  pr="$(open_pr "$repo" terragucci/release/modules-queue)"
  [ -n "$pr" ] || { log "no release pull request from terragucci/release/modules-queue"; return 1; }
  [ "$(pr_files "$repo" "$pr")" = "modules/queue/version" ] || { log "the release pull request changes $(pr_files "$repo" "$pr"), not modules/queue/version"; rc=1; }
  body="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.body // ""')"
  if [ -n "$decide_up" ]; then
    grep -Eq 'with probability [0-9.]+|below the [0-9.]+ threshold' <<<"$body" \
      || { log "the decision service is up, but the pull request carries no answer from it: $(head -1 <<<"$body")"; rc=1; }
    [ $rc = 0 ] && log "after apply-wave-1 the version-bump job opened pull request $pr writing modules/queue/version, with the service's answer: $(head -1 <<<"$body")"
  else
    grep -q 'the service did not answer' <<<"$body" \
      || { log "the pull request does not say the service did not answer: $(head -1 <<<"$body")"; rc=1; }
    [ $rc = 0 ] && log "after apply-wave-1 the version-bump job opened pull request $pr writing modules/queue/version; the decision service was not running (stack/decide.sh up), so the job's call to it got no answer and the pull request proposes a patch and says so"
  fi
  drop_work "$work" 2>/dev/null || true
  return $rc
}

claim_tg_spans() {
  # module-bump reaches the Terragrunt example's 12 service units. Their
  # tf-plan run must give every planned unit timings from Terragrunt's run
  # report (source terragrunt) with spans > 0: its plan's own spans, which
  # OpenTofu 1.13 sends for provider start-up and the state lock (detail
  # "none", nothing per resource) and which reach the stage only through the
  # TG_TF_PATH wrapper. Terragrunt itself is a logging shim in front of the
  # real one (TERRAGUCCI_TERRAGRUNT), so the claim also sees that each
  # `run --all -- plan` carries -lock-timeout=5m and runs with TG_TF_PATH
  # pointed at the wrapper rather than at tofu.
  # BREAK: the shim points TG_TF_PATH back at tofu after noting it, so
  # Terragrunt runs the binary without the wrapper and no unit's spans arrive.
  log() { echo "[smoke tg-spans] $*" >&2; }
  local work r n plans rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/run" "$work/smoke"
  cat > "$work/smoke/terragrunt" <<'SH'
#!/bin/sh
echo "TG_TF_PATH=${TG_TF_PATH:-} $*" >> /smoke/terragrunt-calls.log
if [ -n "${SMOKE_BYPASS:-}" ]; then TG_TF_PATH=tofu; export TG_TF_PATH; fi
exec terragrunt "$@"
SH
  chmod +x "$work/smoke/terragrunt"
  local -a TG_RUN_EXTRA=(-v "$work/smoke:/smoke" -e TERRAGUCCI_TERRAGRUNT=/smoke/terragrunt)
  [ -n "${BREAK:-}" ] && TG_RUN_EXTRA+=(-e SMOKE_BYPASS=1)
  tg_report_run "$work/run" module-bump || true
  r="$work/run/terragucci-report/report.json"
  if [ ! -f "$r" ]; then
    log "no report"; rc=1
  else
    n="$(jq '[.roots[] | select(.status == "planned")] | length' "$r")"
    [ "$n" -gt 0 ] || { log "no unit was planned"; rc=1; }
    jq -r '.roots[] | select(.status == "planned") | "\(.path) source=\(.timings.source // "none") spans=\(.timings.spans // 0) detail=\(.timings.detail // "none")"' "$r" | sed 's/^/[smoke tg-spans]   /' >&2
    [ "$(jq '[.roots[] | select(.status == "planned") | select(.timings.source == "terragrunt" and (.timings.spans // 0) > 0)] | length' "$r")" = "$n" ] \
      || { log "not every planned unit has spans from its plan"; rc=1; }
    plans="$(grep -E -- ' -- plan( |$)' "$work/smoke/terragrunt-calls.log" 2>/dev/null || true)"
    if [ -z "$plans" ]; then
      log "Terragrunt was never asked to plan"; rc=1
    else
      if grep -vq -- '-lock-timeout=5m' <<<"$plans"; then
        log "a Terragrunt plan ran without -lock-timeout=5m: $(grep -v -- '-lock-timeout=5m' <<<"$plans" | head -1)"; rc=1
      fi
      if grep -Eq '^TG_TF_PATH=(tofu)? ' <<<"$plans"; then
        log "a Terragrunt plan ran with TG_TF_PATH at tofu, not the wrapper"; rc=1
      fi
    fi
  fi
  drop_work "$work" "$(tg_image)" 2>/dev/null || true
  [ $rc = 0 ] && log "$n units planned, each with spans from its plan through the TG_TF_PATH wrapper, and every Terragrunt plan carried -lock-timeout=5m"
  return $rc
}

claim_oidc_clouds() {
  # A scratch tree whose terragucci.yml sets oidc.gcp and oidc.azure (no AWS).
  # init writes its Forgejo pipeline; the plan job's and apply-wave-1's scripts
  # are cut before they plan, lock or post (their forge calls and credential
  # steps stay), and run in the tofu image against a stand-in token endpoint
  # in the same container that answers each request with a token naming its
  # audience. Each must leave a GOOGLE_APPLICATION_CREDENTIALS file that is an
  # external_account config for the provider and the stage's service account,
  # whose credential_source.file holds the token for the provider's audience,
  # and ARM_USE_OIDC, ARM_CLIENT_ID (the stage's), ARM_TENANT_ID,
  # ARM_SUBSCRIPTION_ID and an ARM_OIDC_TOKEN_FILE_PATH holding the token for
  # api://AzureADTokenExchange. Its limits: floci serves neither cloud, so no
  # Google STS or Entra ID exchange happens and the forge's token is a
  # stand-in; the claim shows the job hands the google and azurerm providers
  # the configuration they read, not that a cloud accepts it.
  # BREAK: the credential steps are dropped from the scripts, so nothing is
  # written and no ARM_* variable is set.
  log() { echo "[smoke oidc-clouds] $*" >&2; }
  local work job name sa client rc=0 provider="projects/123456789/locations/global/workloadIdentityPools/forge/providers/ci"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/tree/app"
  printf 'provider "external" {}\n\nresource "terraform_data" "mark" {}\n' > "$work/tree/app/main.tf"
  cat > "$work/tree/terragucci.yml" <<YML
forge: forgejo
binary: tofu
oidc:
  gcp:
    workload_identity_provider: $provider
    plan_service_account: tg-plan@shop.iam.gserviceaccount.com
    apply_service_account: tg-apply@shop.iam.gserviceaccount.com
  azure:
    tenant_id: tenant-0001
    subscription_id: sub-0002
    plan_client_id: client-plan
    apply_client_id: client-apply
YML
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  # Each job's credential prefix, as the job runs it, from the generated workflow.
  (cd "$HERE/.." && npx tsx -e '
import { readFileSync, writeFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
const [wf, out, brk] = process.argv.slice(1);
const doc = parseYAML(readFileSync(wf, "utf-8").split("\n").filter((l) => !l.startsWith("#")).join("\n"));
for (const job of ["plan", "apply-wave-1"]) {
  const run = doc.jobs[job].steps.map((s) => s.run ?? "").find((r) => r.startsWith("set +e -uo pipefail"));
  if (!run) throw new Error("no script in " + job);
  let lines = run.split("\n");
  lines = lines.slice(0, lines.findIndex((l) => /^(lock_ref=|tg status terragucci\/|terragucci stage )/.test(l)));
  if (brk) {
    const a = lines.findIndex((l) => l.startsWith("export TERRAGUCCI_GCP_TOKEN_FILE=")), b = lines.findIndex((l) => l.startsWith("tg oidc \"$ARM_OIDC_TOKEN_FILE_PATH\""));
    if (a >= 0 && b >= a) lines.splice(a, b - a + 1);
  }
  writeFileSync(out + "/" + job + ".sh", lines.join("\n") + "\n");
}' "$work/tree/.forgejo/workflows/terragucci.yml" "$work" "${BREAK:-}") || { log "could not read the jobs' scripts from the pipeline"; drop_work "$work"; return 1; }
  cat > "$work/token-server.mjs" <<'JS'
import { createServer } from "node:http";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
createServer((req, res) => {
  const aud = new URL(req.url, "http://x").searchParams.get("audience");
  const ok = req.headers.authorization === "bearer stand-in-request-token";
  res.statusCode = ok ? 200 : 401;
  res.end(JSON.stringify({ value: b64({ alg: "none" }) + "." + b64({ aud, sub: "repo:shop/infra:pull_request" }) + ".x" }));
}).listen(8080, "127.0.0.1");
JS
  cat > "$work/check.mjs" <<'JS'
import { existsSync, readFileSync } from "node:fs";
const [provider, sa, client] = process.argv.slice(2);
const e = process.env, bad = [];
const aud = (file) => JSON.parse(Buffer.from(readFileSync(file, "utf-8").split(".")[1], "base64url").toString()).aud;
const want = (what, got, exp) => { if (got !== exp) bad.push(`${what} is ${JSON.stringify(got)}, not ${JSON.stringify(exp)}`); };
if (!e.GOOGLE_APPLICATION_CREDENTIALS || !existsSync(e.GOOGLE_APPLICATION_CREDENTIALS)) bad.push("no GOOGLE_APPLICATION_CREDENTIALS file");
else {
  const c = JSON.parse(readFileSync(e.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"));
  want("type", c.type, "external_account");
  want("audience", c.audience, "//iam.googleapis.com/" + provider);
  want("subject_token_type", c.subject_token_type, "urn:ietf:params:oauth:token-type:jwt");
  want("token_url", c.token_url, "https://sts.googleapis.com/v1/token");
  want("service_account_impersonation_url", c.service_account_impersonation_url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`);
  if (!c.credential_source?.file || !existsSync(c.credential_source.file)) bad.push("credential_source.file is not a file");
  else want("the GCP token's aud", aud(c.credential_source.file), "https://iam.googleapis.com/" + provider);
}
want("ARM_USE_OIDC", e.ARM_USE_OIDC, "true");
want("ARM_CLIENT_ID", e.ARM_CLIENT_ID, client);
want("ARM_TENANT_ID", e.ARM_TENANT_ID, "tenant-0001");
want("ARM_SUBSCRIPTION_ID", e.ARM_SUBSCRIPTION_ID, "sub-0002");
if (!e.ARM_OIDC_TOKEN_FILE_PATH || !existsSync(e.ARM_OIDC_TOKEN_FILE_PATH)) bad.push("no ARM_OIDC_TOKEN_FILE_PATH file");
else want("the Azure token's aud", aud(e.ARM_OIDC_TOKEN_FILE_PATH), "api://AzureADTokenExchange");
for (const b of bad) console.error("oidc-clouds: " + b);
if (bad.length) process.exit(1);
console.log("credential config for " + sa + " and " + client + " is what the google and azurerm providers read");
JS
  for job in plan:tg-plan:client-plan apply-wave-1:tg-apply:client-apply; do
    IFS=: read -r name sa client <<<"$job"
    in_image "$work" bash -c '
node /repo/token-server.mjs & server=$!
for i in $(seq 1 50); do node -e "fetch(\"http://127.0.0.1:8080/\").then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && break; sleep 0.1; done
export ACTIONS_ID_TOKEN_REQUEST_URL="http://127.0.0.1:8080/token?api-version=2.0" ACTIONS_ID_TOKEN_REQUEST_TOKEN=stand-in-request-token
set +e
. "/repo/$1.sh"
rc=$?
set +u
[ "$rc" = 0 ] && node /repo/check.mjs "$2" "$3" "$4"; rc=$?
kill "$server" 2>/dev/null
exit "$rc"' oidc "$name" "$provider" "$sa@shop.iam.gserviceaccount.com" "$client" >&2 || { log "$name: the job's credential step did not leave the GCP and Azure configuration"; rc=1; }
  done
  drop_work "$work"
  [ $rc = 0 ] && log "plan and apply-wave-1 each wrote an external_account file for their service account and set the ARM_* variables for their client, with each cloud's token"
  return $rc
}

claim_comment_apply() {
  # The gated fixture (gate always; wave 1 is canary/one, wave 2 fleet/*) on
  # main, where wave 1 waits. A pull request changes canary/one and is merged;
  # the merge commit's apply waits at wave 1 for its new digest. An agent then
  # writes an unsealed approval of that plan to chant/lifecycle. As the repo's
  # admin, `/terragucci apply` on the merged pull request must be answered that
  # wave 1 waits, with its set digest and the `chant approve ... --sign`
  # command, and apply nothing. `/terragucci apply` on an open pull request,
  # and from a user with no write access, must each be refused with a reply,
  # and apply nothing. The approver approves wave 1 with a sealed record, and
  # `/terragucci apply` again must apply canary/one (wave 2 waits at its own
  # gate) and reply with a link to the run.
  # BREAK: chant.workspace.json is left out of the pushed tree, so no gate needs
  # a seal, and the unsealed approval lets the first comment apply wave 1.
  log() { echo "[smoke comment-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-apply" sha merge pr open_pr applied reply rc=0
  local stranger="smoke-stranger" pass stoken
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo comment-apply || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && rm -f "$work/tree/chant.workspace.json"
  grep -q '^  apply-comment:' "$work/tree/.forgejo/workflows/terragucci.yml" || { log "the pipeline has no apply-comment job"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "comment-apply: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  # The pull request, merged by the forge: its merge commit is what the comment applies.
  echo 2 > "$work/tree/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" change "comment-apply: change canary/one" >/dev/null || { drop_work "$work"; return 1; }
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"change","base":"main","title":"comment-apply: change canary/one"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || { log "pull request $pr did not merge"; drop_work "$work"; return 1; }
  merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
  [ -n "$merge" ] || { log "pull request $pr has no merge commit"; drop_work "$work"; return 1; }
  wait_run "$repo" "$merge" || { drop_work "$work"; return 1; }
  log "pull request $pr merged as ${merge:0:8}; its apply: $RUN_STATUS, state for: $(gated_applied comment-apply)"
  # An approval no person sealed, of the plan wave 1 waits on.
  gated_forge comment-apply 1 unsealed || rc=1

  # reply_count n; comment_as token n text -> the reply terragucci posts on n, once it has.
  reply_count() { api "$URL/api/v1/repos/$repo/issues/$1/comments?limit=100" | jq '[.[] | select(.body | startswith("terragucci: "))] | length'; }
  comment_as() {
    local token="$1" n="$2" before i
    before="$(reply_count "$n")"
    curl -fsS -o /dev/null -H "Authorization: token $token" -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$3" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$n/comments" || return 1
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      [ "$(reply_count "$n")" -gt "$before" ] && break
      sleep 3
    done
    api "$URL/api/v1/repos/$repo/issues/$n/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | last | .body // empty'
  }

  if [ $rc = 0 ]; then
    reply="$(comment_as "$TOKEN" "$pr" "/terragucci apply")"
    applied="$(gated_applied comment-apply)"
    log "first comment: state for: ${applied:-nothing}; reply: ${reply:-none}"
    [ -z "$applied" ] || { log "the comment applied a wave with no sealed approval"; rc=1; }
    if [ $rc = 0 ]; then
      grep -Eq "wave 1 waits for an approval of its set digest (jcs1-)?sha256:[0-9a-f]+" <<<"$reply" || { log "the reply does not say wave 1 waits, with its digest"; rc=1; }
      grep -Eq 'chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+ --sign' <<<"$reply" || { log "the reply does not give the chant approve --sign command"; rc=1; }
    fi
  fi

  # Refused: an open pull request, and a commenter with no write access.
  if [ $rc = 0 ]; then
    echo open > "$work/tree/fleet/two/rev.txt"
    push_tree "$work/tree" "$repo" open-change "comment-apply: an open change" >/dev/null || rc=1
    open_pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"open-change","base":"main","title":"comment-apply: open"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
    reply="$(comment_as "$TOKEN" "$open_pr" "/terragucci apply")"
    log "open pull request $open_pr: ${reply:-no reply}"
    grep -q "pull request $open_pr is not merged" <<<"$reply" || { log "an apply comment on an open pull request was not refused"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    pass="smoke-$RANDOM-$RANDOM-Aa1"
    api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$stranger?purge=true" 2>/dev/null || true
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg u "$stranger" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || rc=1
    stoken="$(curl -fsS -u "$stranger:$pass" -H 'content-type: application/json' -X POST -d '{"name":"smoke","scopes":["write:issue","read:repository"]}' "$URL/api/v1/users/$stranger/tokens" | jq -r '.sha1 // empty')"
    [ -n "$stoken" ] || { log "no token for $stranger"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(comment_as "$stoken" "$pr" "/terragucci apply")"
    log "a commenter with no write access: ${reply:-no reply}"
    grep -q "$stranger has no write access" <<<"$reply" || { log "an apply comment from a user with no write access was not refused"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    applied="$(gated_applied comment-apply)"
    [ -z "$applied" ] || { log "a refused comment applied: $applied"; rc=1; }
  fi

  # Approved with a sealed record: the comment applies wave 1 and links the run.
  if [ $rc = 0 ]; then
    gated_approve comment-apply 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    reply="$(comment_as "$TOKEN" "$pr" "/terragucci apply")"
    applied="$(gated_applied comment-apply)"
    log "after the sealed approval: state for: ${applied:-nothing}; reply: ${reply:-none}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one alone to apply, wave 2 waiting at its own gate"; rc=1; }
    grep -q "/actions/runs/" <<<"$reply" || { log "the reply does not link the run"; rc=1; }
    grep -q "wave 2 waits" <<<"$reply" || { log "the reply does not say wave 2 waits"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$stranger?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the comment applied nothing while wave 1 had only an unsealed approval, refused an open pull request and a non-writer, and applied wave 1 once it was sealed"
  return $rc
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

# ── the agent comment ─────────────────────────────────────────────────────
claim_comment_agent() {
  # A scratch repo with two roots, app and net, whose terragucci.yml turns
  # agent.comment on with a stand-in agent: .smoke/agent.sh reads the prompt
  # on stdin and sets app/rev.txt to 3, and also appends to the pipeline file
  # when the ask says "touch ci". Its push token (AGENT_TOKEN) is the admin's.
  # A push to main, and a pull request from the same repo that changes net.
  # Then:
  #   `/terragucci agent set app's rev to 3`, by the admin: the head branch
  #       gains one commit on top of the old head that sets app/rev.txt to 3,
  #       the reply links it, and the new head gets its own terragucci/plan
  #       statuses (the push re-plans it).
  #   `/terragucci agent touch ci ...`, by the admin: the reply names
  #       .forgejo/workflows/terragucci.yml and the branch does not move.
  #   `/terragucci agent ...`, by a user with no write access: no reply, and
  #       the branch does not move.
  #   `/terragucci agent ...` on a pull request from that user's fork, by the
  #       admin: the reply says a fork gets no agent, and the fork's branch
  #       does not move.
  # main never moves and gains no terragucci/apply status from a comment.
  # BREAK: the pushed pipeline's push step applies and pushes the agent's
  # patch itself, without `terragucci comment --agent push` and its path
  # guard, so the ask that touches CI is pushed.
  log() { echo "[smoke comment-agent] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-agent" tree wf main_sha head_sha new_sha pr fpr i rc=0 replies last root
  local reader=tg-agent-reader rpass="tg-agent-reader-$$" rtoken applied_before
  local wait=$(( TIMEOUT < 300 ? TIMEOUT : 300 ))
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo comment-agent || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  local s
  for s in AGENT_TOKEN:"$TOKEN" AGENT_KEY:stand-in; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "${s#*:}" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/${s%%:*}" \
      || { log "could not set the ${s%%:*} secret"; return 1; }
  done
  for root in app net; do
    mkdir -p "$tree/$root"
    echo 1 > "$tree/$root/rev.txt"
    cat > "$tree/$root/main.tf" <<'TF'
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
  mkdir -p "$tree/.smoke"
  cat > "$tree/.smoke/agent.sh" <<'SH'
#!/bin/sh
# A stand-in agent: the prompt comes on stdin, and it edits one file.
ask="$(sed -n '/^<ask>$/,/^<\/ask>$/p')"
echo "stand-in agent asked: $ask"
echo 3 > app/rev.txt
case "$ask" in
  *"touch ci"*) echo "# the agent was here" >> .forgejo/workflows/terragucci.yml ;;
esac
SH
  cat > "$tree/terragucci.yml" <<'YML'
forge: forgejo
binary: tofu
gate: never
agent:
  via: forge
  token_env: AGENT_TOKEN
  comment:
    command: sh .smoke/agent.sh
    key_secret: AGENT_KEY
    timeout: 10
YML
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml) || { log "init failed"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  agent-push:' "$wf" || { log "the pipeline has no agent-push job"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    awk -v cmd="git apply --index /tmp/terragucci-agent/change/change.patch && git -c user.name=agent -c user.email=agent@localhost commit -qm agent && git -c \"http.extraHeader=Authorization: Basic \$(printf 'x-access-token:%s' \"\$TG_TOKEN\" | base64 -w0)\" push -q origin \"HEAD:refs/heads/\$TG_HEAD\"" \
      '/terragucci comment --agent push / { match($0, /^ */); print substr($0, 1, RLENGTH) cmd; next } { print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'git apply --index /tmp/terragucci-agent' "$wf" || { log "could not take the path guard out of the push step"; return 1; }
  fi
  main_sha="$(push_tree "$tree" "$repo" main "comment-agent: first")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green"; return 1; }
  applied_before="$(api "$URL/api/v1/repos/$repo/commits/$main_sha/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/apply")] | length')"
  echo 2 > "$tree/net/rev.txt"
  head_sha="$(push_tree "$tree" "$repo" agent-change "comment-agent: change net")" || return 1
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"agent-change","base":"main","title":"comment-agent: net"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  log "pull request $pr for ${head_sha:0:8}"
  plans() { # sha -> how many terragucci/plan statuses it carries
    api "$URL/api/v1/repos/$repo/commits/$1/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/plan")] | length'
  }
  branch_sha() { remote_head "$1" "$2"; }
  comment() { # pr, text[, token] -> posts it, as the admin unless a token is given
    curl -fsS -o /dev/null -H "Authorization: token ${3:-$TOKEN}" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg b "$2" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$1/comments"
  }
  replies() { api "$URL/api/v1/repos/$repo/issues/$1/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | map(.body) | join("\n")'; }
  last_comment_run() { api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[] | select(.event == "issue_comment") | .id] | max // 0'; }
  # Wait for the first comment run newer than $1 to finish; sets CR_ID and CR_STATUS.
  wait_comment_run() { # run id
    local run
    CR_ID=""; CR_STATUS=""
    for i in $(seq 1 $(( wait / 3 ))); do
      run="$(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq -c --argjson after "$1" '[.workflow_runs[] | select(.event == "issue_comment" and .id > $after)] | min_by(.id) // empty')"
      if [ -n "$run" ]; then
        CR_ID="$(jq -r .id <<<"$run")"; CR_STATUS="$(jq -r .status <<<"$run")"
        case "$CR_STATUS" in success|failure|cancelled|skipped) return 0 ;; esac
      elif [ $(( i * 3 )) -ge 90 ]; then
        log "no run started for the comment in 90s"; return 1
      fi
      sleep 3
    done
    log "the comment's run $CR_ID did not finish in ${wait}s (last status: ${CR_STATUS:-none})"; return 1
  }
  run_logs() { # run id -> the agent jobs' terragucci lines
    local job
    for job in $(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r '.[] | select(.name == "agent" or .name == "agent-push") | .id'); do
      api "$URL/api/v1/repos/$repo/actions/jobs/$job/logs" 2>/dev/null | grep -E 'terragucci( comment)?:|stand-in agent' | cut -c30- | sed 's/^/[smoke comment-agent]   /' >&2 || true
    done
  }
  # The pull request's own plan runs first.
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(plans "$head_sha")" -ge 2 ] && break
    sleep 3
  done
  [ "$(plans "$head_sha")" -ge 2 ] || { log "the pull request's own plan never finished"; return 1; }

  # 1. The ask: one commit on the head branch, a reply that links it, and a re-plan of the new head.
  last="$(last_comment_run)"
  comment "$pr" "/terragucci agent set app's rev to 3"
  wait_comment_run "$last" || return 1
  new_sha="$(branch_sha "$repo" agent-change)"
  if [ "$new_sha" = "$head_sha" ]; then
    log "the agent comment pushed nothing (run $CR_ID: $CR_STATUS)"; run_logs "$CR_ID"; return 1
  fi
  [ "$(api "$URL/api/v1/repos/$repo/git/commits/$new_sha" | jq -r '.parents[0].sha')" = "$head_sha" ] || { log "the agent's commit ${new_sha:0:8} is not on top of the old head"; rc=1; }
  [ "$(api "$URL/api/v1/repos/$repo/raw/app/rev.txt?ref=$new_sha")" = 3 ] || { log "the agent's commit does not set app/rev.txt to 3"; rc=1; }
  grep -q "^terragucci: pushed \[\`${new_sha:0:8}\`\]" <<<"$(replies "$pr")" || { log "no reply links the pushed commit ${new_sha:0:8}"; rc=1; }
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(plans "$new_sha")" -ge 2 ] && break
    sleep 3
  done
  [ "$(plans "$new_sha")" -ge 2 ] || { log "the pushed commit was not re-planned (no terragucci/plan statuses on ${new_sha:0:8})"; rc=1; }
  [ $rc = 0 ] && log "the ask pushed ${new_sha:0:8} on top of ${head_sha:0:8}, the reply links it, and the push re-planned the pull request"

  # 2. A forbidden path: refused by name, nothing pushed.
  head_sha="$new_sha"
  last="$(last_comment_run)"
  comment "$pr" "/terragucci agent touch ci and set app's rev to 3"
  wait_comment_run "$last" || return 1
  if [ "$(branch_sha "$repo" agent-change)" != "$head_sha" ]; then
    log "an ask that touches the pipeline file was pushed"; rc=1
  elif grep -q 'touches `.forgejo/workflows/terragucci.yml`' <<<"$(replies "$pr")"; then
    log "an ask that touches the pipeline file was refused by path and pushed nothing"
  else
    log "an ask that touches the pipeline file pushed nothing, but no reply names the path"; run_logs "$CR_ID"; rc=1
  fi

  # 3. A user with no write access: nothing, not even a reply.
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$reader?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$reader" --arg p "$rpass" '{username: $u, email: ($u + "@smoke.local"), password: $p, must_change_password: false}')" \
    "$URL/api/v1/admin/users" || { log "could not create $reader"; return 1; }
  rtoken="$(curl -fsS -u "$reader:$rpass" -H 'content-type: application/json' -X POST -d '{"name":"smoke","scopes":["write:repository","write:issue","read:user"]}' "$URL/api/v1/users/$reader/tokens" | jq -r .sha1)"
  [ -n "$rtoken" ] && [ "$rtoken" != null ] || { log "could not make a token for $reader"; return 1; }
  local nreplies
  nreplies="$(replies "$pr" | grep -c '^terragucci: ' || true)"
  last="$(last_comment_run)"
  comment "$pr" "/terragucci agent set app's rev to 3" "$rtoken"
  # A run that never starts for a stranger's comment is as good as one that stops at the permission check.
  if wait_comment_run "$last" || [ -z "$CR_ID" ]; then
    [ "$(branch_sha "$repo" agent-change)" = "$head_sha" ] || { log "a non-writer's ask was pushed"; rc=1; }
    [ "$(replies "$pr" | grep -c '^terragucci: ' || true)" = "$nreplies" ] || { log "a non-writer's ask was answered"; rc=1; }
    [ $rc = 0 ] && log "a non-writer's ask got no reply and pushed nothing${CR_ID:+ (run $CR_ID: $CR_STATUS)}"
  else
    rc=1
  fi

  # 4. A pull request from a fork: refused, and the fork's branch does not move.
  local fork="$reader/comment-agent" fork_sha remote
  curl -fsS -o /dev/null -H "Authorization: token $rtoken" -H 'content-type: application/json' -X POST -d '{}' "$URL/api/v1/repos/$repo/forks" \
    || { log "$reader could not fork $repo"; return 1; }
  for i in $(seq 1 30); do api -o /dev/null "$URL/api/v1/repos/$fork" 2>/dev/null && break; sleep 1; done
  git -C "$tree" checkout -q main
  echo 5 > "$tree/net/rev.txt"
  git -C "$tree" checkout -q -B fork-change
  git -C "$tree" add -A
  git -C "$tree" -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q -m "comment-agent: fork change"
  remote="${URL/#http:\/\//http://${reader}:${rtoken}@}/${fork}.git"
  git -C "$tree" push -q --force "$remote" HEAD:refs/heads/fork-change 2>/dev/null || { log "could not push to the fork"; return 1; }
  fork_sha="$(git -C "$tree" rev-parse HEAD)"
  fpr="$(curl -fsS -H "Authorization: token $rtoken" -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg h "$reader:fork-change" '{head: $h, base: "main", title: "comment-agent: fork"}')" "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  [ -n "$fpr" ] && [ "$fpr" != null ] || { log "could not open a pull request from the fork"; return 1; }
  last="$(last_comment_run)"
  comment "$fpr" "/terragucci agent set app's rev to 3"
  if wait_comment_run "$last"; then
    [ "$(branch_sha "$fork" fork-change)" = "$fork_sha" ] || { log "the agent pushed to the fork's branch"; rc=1; }
    grep -q 'a pull request from a fork gets no agent' <<<"$(replies "$fpr")" || { log "the fork's pull request got no refusal"; run_logs "$CR_ID"; rc=1; }
  else
    rc=1
  fi

  [ "$(branch_sha "$repo" main)" = "$main_sha" ] || { log "main moved"; rc=1; }
  [ "$(api "$URL/api/v1/repos/$repo/commits/$main_sha/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/apply")] | length')" = "$applied_before" ] \
    || { log "main gained an apply status from a comment"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$reader?purge=true" 2>/dev/null || true
  drop_work "$work" 2>/dev/null || true
  [ "$rc" = 0 ] && log "the ask was pushed and re-planned; a forbidden path, a non-writer and a fork pushed nothing"
  return "$rc"
}

names() { cut -d'|' -f1 <<<"$CLAIMS"; }
# The claims with no issue to wait for, in CLAIMS order.
runnable_names() {
  if [ -n "${SMOKE_AWS:-}" ]; then
    # Only the pilot's claims run on real AWS.
    awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS" | while read -r n; do smoke_aws_claim "$n" && echo "$n"; done
    return 0
  fi
  awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS"
}

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
#   fountain   the fountain profile and its steward, which only steward uses
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
# steward boots the example from nothing the way boot does (its own wipe, the
# running floci), with tf-apply on the steward, so it holds the example alone
# and shares the rest of the stack. It goes first: it leaves main carrying the
# steward's pipeline, and boot, which runs after it, puts the plain example
# back for every claim that reads it. tg-mock-trap goes right after tg-waves,
# while steward and boot hold the example, so the Terragrunt plans that share
# tg follow it instead of holding it up at the end.
CLAIM_GROUPS='
tg-waves        tg! runner break-first weight=1000
boot            ex! runner break-first after=steward weight=900
drift           ex! after=boot weight=700
tg-affected     tg after=tg-waves weight=500
tg-refuse       tg tg-ledger! after=tg-waves weight=490
tg-check        tg runner self! after=tg-waves weight=480
tg-mock-lint    tg after=tg-waves weight=470
tg-drift        tg! after=tg-waves weight=460
tg-mock-trap    tg! tg-ledger! runner after=tg-waves weight=520
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
steward         ex! runner fountain! weight=950
comment-plan    runner self! weight=150
lock-wait       otel! self! weight=150
dash-pipeline   ex otel after=boot weight=120
dash-changes    ex otel after=boot weight=120
dash-waves      ex otel after=boot weight=120
dash-drift      ex otel after=boot weight=120
dash-estate     ex otel after=boot weight=120
dash-runs       ex otel after=boot weight=120
dash-slos       ex otel after=boot weight=120
drill-down      ex otel after=boot weight=120
policy-wave     weight=150
check-diagnostics    runner self! weight=150
comment-not-affected runner self! weight=150
drift-attribute      self! weight=90
version-bump-job     runner self! weight=150
tg-spans             tg after=tg-waves weight=450
oidc-clouds          weight=20
comment-apply        runner self! weight=200
comment-agent        runner self! weight=200
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

# --list: one line per claim, "name function=yes|no group=yes|no", then exits
# before anything touches Docker. scripts/check-smoke.mjs reads it.
if [ "${1:-}" = --list ]; then
  while IFS='|' read -r n _; do
    [ -n "$n" ] || continue
    f=no; declare -F "claim_${n//-/_}" >/dev/null && f=yes
    g=no; awk -v n="$n" '$1 == n { f = 1 } END { exit !f }' <<<"$CLAIM_GROUPS" && g=yes
    echo "$n function=$f group=$g"
  done <<<"$CLAIMS"
  exit 0
fi

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
  [ -z "${SMOKE_AWS:-}" ] || return 0
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
  # The steward claim runs alongside others, so its fountain profile starts
  # here, before any run: the claim's own bootstrap then finds it up and
  # starts nothing while other runs use the stack.
  if runnable_names | grep -qx steward; then
    "$HERE/bootstrap.sh" fountain >/dev/null 2>"$SMOKE_LOG_DIR/bootstrap-fountain.log" \
      || { cat "$SMOKE_LOG_DIR/bootstrap-fountain.log" >&2; echo "[smoke] the fountain profile did not start" >&2; return 1; }
  fi
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
# `docker system df -v` prints a "Local Volumes space usage" table (VOLUME
# NAME, LINKS, SIZE); when that has no row for it, du inside the CI image,
# which is already pulled, measures the volume read-only.
job_cache_size() {
  local size image
  size="$(docker system df -v 2>/dev/null | awk -v v="$JOB_CACHE_VOLUME" '
    /^VOLUME NAME/ { t = 1; next } t && NF == 0 { t = 0 } t && $1 == v { print $NF; exit }')" || size=""
  if [ -z "$size" ] || [ "$size" = N/A ]; then
    image="$(image_tag tofu 2>/dev/null || true)"
    [ -n "$image" ] && size="$(docker run --rm --entrypoint du -v "$JOB_CACHE_VOLUME:/cache:ro" "$image" -sh /cache 2>/dev/null | awk '{ print $1 }')" || size=""
  fi
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

# SMOKE_AWS=1: the pilot on real AWS (stack/smoke-aws.sh, CONTRIBUTING.md).
# Five claims run there; any other refuses, and so does --record, which is
# floci's record.
if [ -n "${SMOKE_AWS:-}" ]; then
  # shellcheck source=smoke-aws.sh
  . "$HERE/smoke-aws.sh"
  if [ "${1:-}" = --record ]; then
    echo "smoke: SMOKE_AWS=1 does not record; smoke.json is floci's record" >&2; exit 2
  fi
  if [ -n "${1:-}" ] && ! smoke_aws_claim "$1"; then
    echo "smoke: claim '$1' refuses to run under SMOKE_AWS=1; only $SA_CLAIMS run on real AWS" >&2; exit 2
  fi
  smoke_aws_start || exit 1
  REPORT_BUCKET="$SMOKE_AWS_PREFIX-terragucci-reports"
fi

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
