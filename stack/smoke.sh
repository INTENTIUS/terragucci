#!/usr/bin/env bash
#
# One smoke claim per feature the site claims, run against the example.
#
#   stack/smoke.sh               every claim, several at a time
#   stack/smoke.sh <claim>       one claim
#   BREAK=1 stack/smoke.sh boot  break the property; the claim must print "caught"
#   stack/smoke.sh --record FILE every claim, plain and under BREAK=1, as JSON
#   stack/smoke.sh --only a,b    the named claims, plain and under BREAK=1, in
#                                parallel; with --record FILE their rows are
#                                written into FILE and every other row is kept
#   stack/smoke.sh --affected [base]
#                                --only the claims stack/claims-affected.sh
#                                picks from the change since base (origin/main)
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
# A run whose log has not grown for SMOKE_STALL_MIN minutes (default 10) is
# stopped and fails as stalled, its last lines and the stack's job containers
# printed, so nothing waits out a long timeout without anyone looking.
#
# A new claim: add its line to CLAIMS and its function claim_<name>, and give
# it a line in CLAIM_GROUPS naming what it shares. A claim with no line there
# runs alone, after boot and tg-waves: safe, and slow.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --only and --affected pick the claims; the rest of the arguments mean what
# they mean without them. The names are checked once CLAIMS is known.
SMOKE_ONLY="${SMOKE_ONLY:-}"
case "${1:-}" in
  --only)
    SMOKE_ONLY="$(tr ', ' '\n\n' <<<"${2:?usage: smoke.sh --only claim[,claim...]}" | grep . || true)"
    shift 2
    [ -n "$SMOKE_ONLY" ] || { echo "smoke: --only names no claim" >&2; exit 2; }
    ;;
  --affected)
    shift
    base=origin/main
    if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then base="$1"; shift; fi
    SMOKE_ONLY="$("$HERE/claims-affected.sh" "$base")" || exit 2
    [ -n "$SMOKE_ONLY" ] || { echo "smoke: the change affects no claim" >&2; exit 0; }
    ;;
esac
export SMOKE_ONLY
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
  reap_run_copied mine
  [ -z "${SMOKE_TMP:-}" ] || rm -rf "$SMOKE_TMP"
  local pid run
  while read -r pid run; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done <<<"$SMOKE_RUNNING"
  if declare -F release_mine >/dev/null; then release_mine; fi
  return 0
}
trap on_exit EXIT
# Everything this process makes in $TMPDIR, the CLI's own scratch dirs
# (terragucci-plan-*, terragucci-apply-*, ...) and the work dirs, goes under one
# dir of its own that on_exit removes, so a record leaves none behind. A claim
# process the runner starts runs inside the runner's dir and reuses it: it does
# not make another, and only the process that made the dir removes it, so a
# claim killed mid-run leaves nothing the runner's exit does not remove. A dir
# is the runner's when it is named tgs.* and its pid file names a live process
# (SMOKE_RUN_DIR, exported below, says the same to a child whose TMPDIR a tool
# changed). A kill that skips the trap leaves the dir; the next outermost start
# removes any whose process is gone, and the stopped run_copied containers of
# such a process.
#
# The name is short because tsx listens on a Unix socket under $TMPDIR, and
# macOS caps a socket path at 104 bytes. Worst case, one level deep:
#   /var/folders/jz/jz_28g4x5r7_8qgbd7k3p2740000gn/T   49  ($TMPDIR on macOS)
#   /tgs.XXXXXX                                        11
#   /tsx-501/                                           9  (tsx-<uid>)
#   <pid>.pipe                                         12  (7-digit pid)
#                                                      81
# Nested under a second dir of the old 23-byte name it was 116: over the limit.
SMOKE_TMP=""
if [ "${1:-}" != --list ]; then
  SMOKE_OUTER="${SMOKE_RUN_DIR:-}"
  case "${TMPDIR:-}" in */tgs.??????) SMOKE_OUTER="${TMPDIR%/}" ;; esac
  if [ -n "$SMOKE_OUTER" ] && [ -f "$SMOKE_OUTER/pid" ] && kill -0 "$(cat "$SMOKE_OUTER/pid" 2>/dev/null)" 2>/dev/null; then
    export TMPDIR="$SMOKE_OUTER" SMOKE_RUN_DIR="$SMOKE_OUTER"
  else
    SMOKE_BASE="${TMPDIR:-/tmp}"; SMOKE_BASE="${SMOKE_BASE%/}"
    for d in "$SMOKE_BASE"/tgs.* "$SMOKE_BASE"/terragucci-smoke-run.*; do
      [ -f "$d/pid" ] && ! kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null && rm -rf "$d"
    done
    unset d
    SMOKE_TMP="$(mktemp -d "$SMOKE_BASE/tgs.XXXXXX")" && echo $$ > "$SMOKE_TMP/pid" && export TMPDIR="$SMOKE_TMP" SMOKE_RUN_DIR="$SMOKE_TMP" \
      || { echo "smoke: no temp dir in $SMOKE_BASE" >&2; exit 1; }
    reap_run_copied stale
  fi
  unset SMOKE_OUTER
fi
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
sealed|under approval: sealed a wave counts only an approval sealed by a key the signers file lists|
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
tg-waves|the Terragrunt example boots in five waves, one job each: the dependency layers of the dev canary, then the layers of staging and prod, each with one run --all|
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
steward|tf-apply runs as a turn on a fountain steward, started by the forge job, and applies every root|273
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
comment-apply|a comment on a merged pull request re-runs its apply from the merge commit, applies a wave under approval: sealed only once its approval is sealed, and refuses an open pull request and a commenter with no write access|
comment-agent|a /terragucci agent comment pushes the commit of the stand-in agent to the branch of the pull request, which re-plans it and is linked in the reply, and a forbidden path, a non-writer and a fork push nothing|
wave-report|the report of a tf-apply wave behind a gate says waiting and links the ledger that holds its record, and approved once an approval of its digest stands|
policy-delete-key|a pull request that deletes the policy key from terragucci.yml and adds a change the policy denies still fails tf-plan, checked against the policy of the base branch|
report-oidc|with no static keys, the plan job writes its report to the bucket as the role it assumes with its OIDC token through STS, and the index lists the run|
tg-gate-wait|a Terragrunt wave waits for an approval of its set digest, and once approved applies its saved plans while the next wave waits at its own gate|
tg-gate-refuse|a Terragrunt wave whose plans changed after approval applies nothing and names the unit that moved|
tg-sealed|under approval: sealed a Terragrunt wave counts only an approval sealed by a key the signers file lists|
pr-apply|with apply.when: pull-request, a comment on an open and approved pull request applies its head in waves and then merges it with apply.merge: auto|
pr-apply-lock|a second pull request that reaches a root another open pull request has applied is refused with the root and the holder named, and applies once the first is unlocked with /terragucci unlock|
pr-apply-stale|a comment on an approved pull request whose head is behind the default branch is refused as not up to date, and nothing applies|
tg-comment-apply|a comment on a merged pull request in a Terragrunt repo re-runs its waves of units from the merge commit, applies a wave under approval: sealed only once its approval is sealed, and refuses an open pull request|
provider-calls|with binary: choudoufu the report lists the slowest provider calls of a root, each with its method, provider and resource type, from the provider call spans choudoufu sends|
summed-timings|with binary: choudoufu past its span budget the report lists the timings choudoufu summed by resource type, and the note of the root says it summed them|
foreign-checkout|a job that runs as root in the CI image on a checkout another user owns, with no git setting of its own, plans only the roots a change touches|
tg-layers|a Terragrunt repo of three units in a chain goes out in three waves, one job each, every wave waiting for an approval of its own set digest before it applies|
policy-source|a project of a control repo with no policy directory is checked against the shared policy source the control repo defaults name, at its pinned ref|
pr-requires|with apply.requires: [approved] an approved pull request behind the default branch applies from its head, the default requirements refuse it as not up to date, and a pull request that conflicts with the default branch is refused as not mergeable|
pr-lock|/terragucci lock on an open pull request locks the roots it reaches and applies nothing, and a second pull request that reaches one is refused with the root and the holder named|
front-door|the front door template puts CloudFront in front of the private reports bucket at its own domain, reads the bucket through Origin Access Control and runs the sign-in check on every viewer request|
ledger-default|with no approval key a wave counts an unsigned approval of its set digest, init declares no gate, and the waiting wave prints the approval command without --sign|
approval-at-base|a merge that switches approval from sealed to ledger is judged by the sealed rule of the commit before it, and the next merge by ledger|
sealed-migrate|a repo whose chant.workspace.json lists the wave gates and whose config names no approval mode stays sealed, and the wave and config check say so|
estate|terragucci estate writes one page to the reports bucket from the index of every project: three projects, a waiting wave with its age and a drift, with a presigned link to the page|
drift-overdue|the plan of a pull request says in its note that drift checks are overdue when the drift schedule has come round twice with no drift run|
pr-review|with approval: pr-review a pull request approved on its head by a writer other than its author merges, and its gated wave applies with no chant approve, recorded on the ledger as via pr-review|
pr-review-moved|with approval: pr-review a wave whose plans changed between the review of the head and the merge applies nothing and prints the chant approve command for its new digest|
pr-review-status|with approval: pr-review terragucci/approval on the head of a pull request is pending while a wave waits, and success once a writer other than the author approves the head|
cdf-concurrency|with binary: choudoufu two tf-apply waves of one estate that change different resources run at once, both reach their record write together and both apply, with no lock wait and no lock object|
cdf-write-race|with binary: choudoufu two tf-apply waves of one estate that change the same resource at once: one lands, the other fails its conditional write naming the resource and overwrites nothing, and its re-plan shows the value that landed|
cdf-iam|with binary: choudoufu a role granted one estate by its ownership tag applies a change to that estate, and IAM refuses it a change to an instance of another estate|
approve-command|the plan note of a pull request gives the chant approve command with the digest its gated wave asks for after the merge, and terragucci approve in a checkout approves that wave with no digest copied|
tg-pr-apply|with apply.when: pull-request in a Terragrunt repo, a comment on an open and approved pull request applies its waves of units from its head and then merges it with apply.merge: auto|
tg-pr-apply-lock|in a Terragrunt repo, a pull request that changes a unit whose dependencies block names a unit another open pull request applied is refused with the unit and the holder named|
plan-lock|with locks: plan a pull request locks the roots it reaches from its first plan, a second pull request that reaches one gets a failing terragucci/lock and a reply naming the root and the holder, and after /terragucci unlock its /terragucci plan takes the lock|
plan-lock-release|with locks: plan the merge of a pull request releases the lock its first plan took|
policy-override|a tf-apply wave the policy denies applies once an approver listed under policy.override at base overrides its plan with terragucci override, and its report names the override with who, the rules, the reason and the plan digest|
policy-override-moved|an override of an earlier plan digest counts for nothing: once the root plans another digest the wave applies nothing and exits 4|
policy-override-unlisted|an override by someone policy.override at base does not list counts for nothing: the wave applies nothing and names why|
blob-azure|with reports.bucket az://<account>/<container> and only the Azure OIDC identity of the job, tf-plan writes the report and both indexes to Azure Blob Storage, and terragucci estate writes the page there and prints a user delegation SAS that serves it|
blob-gcs|with reports.bucket gs://<bucket> and only the GCP OIDC identity of the job, tf-plan writes the report and both indexes to GCS through its JSON API, and terragucci estate writes the page there and prints a V4 signed URL that the service account signed|
note-diff|the plan note on Forgejo shows the diff of a group as the binary prints it, with the value before and after of the attribute that changes, and the whole plan of the root in a collapsed block|
note-split|a plan over the comment limit of the forge stays one note within the limit: the largest whole plan is left out and named in a Cut line that links its plan.txt, and the rest stays|
note-report-link|with reports.bucket set and no reports.url, the plan note links report.html and each plan.txt in the bucket by presigned links, which open from floci|
config-ts|init writes the pipeline from a terragucci.ts folded as data, and config check refuses a terragucci.ts that reads process.env at its line|
role-refused|config check and init refuse an oidc block that names one role for plan and apply|
description-check|with respond.description: check the plan job flags a destroy the pull request description leaves out, at the top of the note and in the report, and writes intent.json|
decide-backends|decide.backend von, decider and jev each answer the description check through the same client, each pinned to its model, jev with its bearer token from token_env|
otlp-headers|telemetry.headers_secret maps the collector key into the jobs, spans reach a collector that wants it, and a collector that does not answer leaves the plan green|
pinned-install|a pinned binary version the image does not carry is installed in the job and checked against the SHA256SUMS of its release|
drift-close|a drift run that finds no drift closes the drift issue an earlier run opened|
estate-control|terragucci estate in a control repo reads each project from its own bucket with its own reports.role and writes one page to the bucket under defaults|
estate-override|the estate page counts the roots applied under a policy override, in estate.json and estate.html|
comment-refused|a comment naming approve, merge, destroy, import, state or force-unlock is answered that a comment never runs it, and nothing plans or applies|
note-stale|a push to the default branch that changes a root an open pull request planned marks its plan note stale|
pr-confirm|with apply.when: pull-request the push of the merge commit runs confirm, which plans every root, posts terragucci/apply success and applies nothing|
pr-base-config|with apply.when: pull-request a pull request that sets gate: never still waits at the gate of the default branch|
pr-guard|with apply.when: pull-request a pull request that changes the pipeline file, or whose checks failed, is refused and applies nothing|
pr-close-release|with apply.when: pull-request closing a pull request releases the roots it locked|
tg-lock-fanout|in a Terragrunt repo a change to root.hcl locks every unit and says why, and a Markdown-only change locks none|
token-scrub|the binary tf-plan starts gets no forge token by name or by value, and a TF_ variable passes as set|
fork-no-plan|a pull request from a fork runs check and no plan job|
highlight-sensitive|IAM, security group, KMS and DNS changes are open with their reasons, and an import and a forget are named, the forget not counted as a destroy|
approval-revoke|removing an approval line from chant/lifecycle makes its wave wait again|
pending-expiry|a pending fact past its 48 hours is recorded afresh by the next run of its wave|
signer-trust|init --signer writes the signers line from git config user.signingkey, .chant/trust.json moves the signers file, and a sealed approval verifies against it|
rollout-control|from a control repo a module rollout opens wave 1 as one pull request per project for its canaries, then each project in turn, each wave once the last applied|
rollout-provider|rollout --provider moves that provider alone in the lock file and its exact constraint, one pull request per wave|
rollout-pins|rollout moves an oci:// tag and a registry version pin, each in the shape it had|
policy-opa|with policy.engine: opa a tf-apply wave the policy denies applies nothing, and its report keeps the denial and the warnings|
policy-hcp|with policy.input: hcp an HCP Terraform policy reads input.plan and input.run and denies the wave|
policy-hcl|with a policies.hcl a mandatory policy denies the wave and an advisory one warns|
tg-policy|in a Terragrunt repo a unit the policy denies fails tf-plan, and its wave applies nothing|
tg-credentials|in a Terragrunt repo each unit assumes the plan role of the first glob its path matches, and a unit with its own iam_role keeps it|
tg-dependents|terragrunt.dependents: plan previews the dependents of a change provisional and outside every digest, and terragrunt.exclude leaves a unit out|
tf-terraform|with binary: terraform the pipeline runs in the terraform image, check and the plan pass, and a wave waits for its approval and then applies with Terraform|
tg-terraform|in a Terragrunt repo with binary: terraform the pipeline installs Terraform and Terragrunt applies every unit with it|
tfquery-import|with binary: terraform a root with a .tfquery.hcl gets the drift pull request with the config terraform query generated for what it lists|
alerts-fire|with short thresholds every alert init writes fires on its signal, and the apply-success and drift-corrected SLOs record|
blob-gcs-key|with a service_account key file the job writes the report and both indexes to GCS, and the estate link is signed with the key|
blob-azure-key|with AZURE_STORAGE_KEY the job writes the report and both indexes to Azure Blob Storage, and the estate link is a SAS signed with the account key|
index-writes|two plan runs that write one index at once both land in it, and a store that answers 501 to a conditional write gets the row without the condition|
cdf-shared-bucket|with binary: choudoufu one tf-apply wave applies two estates into one record store bucket, each under its own prefix and estate tag, and the next plan of both shows no change|
cdktn-synth|with synth set to npx cdktn synth the pipeline synthesizes the CDK Terrain stacks before check, apply and tf-plan, and tf-plan plans the stack the change reaches|
audit|terragucci audit writes one record to the bucket: every approval on the ledger with its approver, digest and time, the request, and the apply that names its approval; --check passes and the estate page links the audit page|
audit-override|the audit record keeps a policy refusal after its report is replaced, and holds the override with its reason and rules and the apply under it|
audit-refused|a wave whose plans changed after approval is in the audit record as refused, with the approver, the digest approved and the root that moved|
audit-control|terragucci audit in a control repo fetches each project ledger from its url and reads each project reports into one record|
notify-chat|with notify naming a Slack and a Teams webhook secret, a wave that waits posts the wave, its root, the approve command and the run link to each|
cost-estimate|with cost set, the plan note of a pull request gives the monthly cost change of each root and the total, from the estimator run with the key the plan job gets from its secret|
approval-used|once a wave applied under its approval, the next merge that moves its plans waits with the approve command for the new digest, and only an approval of plans that never applied refuses|
cdktn-affected|with synth set a pull request that changes one CDK Terrain stack plans that stack alone, and the plan note says how many stacks were unchanged|'

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

gated_repo() { # name [fixture] [approval] -> a fresh repo $USER/<name>, the fixture (default gated-waves) in $work/tree with its pipeline, no state under <name>/
  local name="$1" fixture="${2:-gated-waves}" approval="${3:-}" key
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
  cp -R "$HERE/fixtures/$fixture/." "$work/tree/"
  find "$work/tree" \( -name main.tf -o -name root.hcl \) -exec sed -i.bak "s#@PREFIX@#$name#" {} \;
  find "$work/tree" -name '*.bak' -delete
  # With approval: sealed, init lists every wave gate under identity.gates, and
  # an approval counts only when its seal verifies against the signers file at
  # base. Without it (ledger, the default) any approval of the digest counts.
  [ -z "$approval" ] || echo "approval: $approval" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  # The approver's key goes in the signers file; an agent's never does.
  ssh-keygen -q -t ed25519 -N "" -C smoke-approver -f "$work/approver" || return 1
  mkdir -p "$work/tree/.chant"
  echo "smoke-approver $(cut -d' ' -f1,2 "$work/approver.pub")" > "$work/tree/.chant/allowed_signers"
}

gated_applied() { # name -> the roots with state under <name>/, space-separated
  curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$1/" | grep -o '<Key>[^<]*\.tfstate</Key>' \
    | sed -E "s#</?Key>##g; s#^$1/##; s#\.tfstate\$##" | sort | tr '\n' ' '
}

# The smoke stands in for the person who approves: it reads nothing and
# approves the wave's standing plan, as `chant approve` would be run by hand,
# unsigned, or with "sign" sealed with the approver's key.
gated_approve() { # name, wave, [sign|unlisted]
  # unlisted: the approver's clone commits identity.gates away and points
  # origin/HEAD, where chant reads the declaration, at that commit (only
  # chant/lifecycle is pushed), so chant writes an unsigned approval of a gate
  # the repo seals.
  local clone="$work/approve-$2-$RANDOM" sign=()
  [ "${3:-}" = sign ] && sign=(--sign "$work/approver")
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/$1.git" "$clone" || return 1
  if [ "${3:-}" = unlisted ] && [ -f "$clone/chant.workspace.json" ]; then
    jq 'del(.identity.gates)' "$clone/chant.workspace.json" > "$clone/chant.workspace.json.new" && mv "$clone/chant.workspace.json.new" "$clone/chant.workspace.json"
    git -C "$clone" -c commit.gpgsign=false commit -q -am "unlisted gates, never pushed" || return 1
    git -C "$clone" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || true
    git -C "$clone" update-ref refs/remotes/origin/HEAD HEAD || return 1
  fi
  git -C "$clone" config user.name smoke-approver
  git -C "$clone" config user.email smoke-approver@terragucci.local
  (cd "$clone" && "$CHANT" approve tf-apply "wave-$2" --approver smoke-approver ${sign[@]+"${sign[@]}"}) >&2 || { log "chant approve tf-apply wave-$2 failed"; return 1; }
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
    run_logs "$repo" "$RUN_ID" | grep "chant approve tf-apply wave-1" >/dev/null || { log "wave 1 did not print its approval command"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep -E "chant approve tf-apply wave-1 .*--sign" >/dev/null && { log "under approval: ledger the command asks for --sign"; rc=1; }
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

# The BREAK of the sealed claims: the tree goes back to ledger, the default.
unseal_tree() {
  sed -i.bak '/^approval:/d' "$work/tree/terragucci.yml"
  rm -f "$work/tree/terragucci.yml.bak" "$work/tree/chant.workspace.json"
}

claim_sealed() {
  # Push the fixture; wave 1 waits. Write an unsealed approval of its plan, and
  # one sealed with an agent's key the signers file does not list, both in the
  # approver's name, and push again: nothing applies, and the run says the
  # approvals do not count. Then the approver runs chant approve --sign with
  # the listed key, and canary/one applies. The repo sets approval: sealed.
  # BREAK: the approval key and chant.workspace.json are left out of the pushed
  # tree, so approval is ledger and the unsealed approval lets wave 1 apply.
  log() { echo "[smoke sealed] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/sealed" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo sealed gated-waves sealed || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && unseal_tree
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
    gated_approve sealed 1 sign || rc=1
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
  # in-line must hold exactly what init writes, digest pins included, or reconcile
  # sees a change; its push runs a pipeline the claim never waits on.
  TG_KEEP_DIGESTS=1 push_tree "$work/in-line" "$USER/in-line" main "Two roots, pipeline in line" >/dev/null
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
# REPORT_OWNER=uid:gid hands the checkout to that owner before the stage, which runs as the image's user (root), and
# leaves out the safe.directory the other runs pass, so git sees the checkout as a github.com container job does.
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
  local -a stage=(terragucci stage)
  if [ -n "${REPORT_OWNER:-}" ]; then
    # shellcheck disable=SC2016 # expanded by the container's shell
    stage=(sh -c 'chown -R "$0" /repo && exec terragucci stage "$@"' "$REPORT_OWNER")
  else
    extra+=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
  fi
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    ${extra[@]+"${extra[@]}"} \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    ${REPORT_EXTRA[@]+"${REPORT_EXTRA[@]}"} \
    "$image" "${stage[@]}" "${REPORT_STAGE:-tf-plan}" ${REPORT_ARGS[@]+"${REPORT_ARGS[@]}"} >&2 || rc=$?
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

claim_report_oidc() {
  # The plan job of a pipeline with oidc: AWS_ROLE_ARN and a token in
  # AWS_WEB_IDENTITY_TOKEN_FILE, and no AWS_ACCESS_KEY_ID. The report goes to
  # the bucket with the keys AssumeRoleWithWebIdentity answers, and the index
  # lists the commit. BREAK: no role and no token, so nothing is written.
  log() { echo "[smoke report-oidc] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 prefix commit index env=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/run"
  prefix="smoke-oidc-$(date +%s)"
  # A token shaped like the forge's; floci's STS answers it with keys of its own.
  printf '%s' 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOm1lL2V4YW1wbGU6cHVsbF9yZXF1ZXN0In0.c21va2U' >"$work/run/.oidc-token"
  [ -z "${BREAK:-}" ] && env="AWS_ROLE_ARN=arn:aws:iam::000000000000:role/terragucci-reports AWS_WEB_IDENTITY_TOKEN_FILE=/repo/.oidc-token AWS_ROLE_SESSION_NAME=smoke"
  local -a REPORT_EXTRA=(-e AWS_ACCESS_KEY_ID= -e AWS_SECRET_ACCESS_KEY= -e AWS_SESSION_TOKEN=) REPORT_ARGS=(--root envs/dev/platform)
  REPORT_ENV="$env" REPORT_CONFIG="$(printf 'reports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix")" report_run "$work/run" || true
  commit="$(git -C "$work/run" rev-parse HEAD 2>/dev/null || true)"
  [ -f "$work/run/terragucci-report/report.json" ] || { log "the run wrote no report"; rc=1; }
  if [ $rc = 0 ]; then
    if ! index="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json")"; then
      log "no index at $REPORT_BUCKET/$prefix/index.json"; rc=1
    elif [ -z "$(jq -r --arg c "$commit" '.reports[] | select(.commit == $c) | .path' <<<"$index")" ]; then
      log "the index does not list commit $commit"; rc=1
    fi
  fi
  drop_work "$work"
  [ $rc = 0 ] || return 1
  log "with only a role and an OIDC token, the report of $commit is in $REPORT_BUCKET/$prefix and its index"
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
  # no commit (reference/observability.mdx), so the run is its own project and
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
    rc=0; q=""
    want="$(jq '.roots | length' "$report")"
    got="$(value "terragucci_roots_planned{project=\"$project\"}")"
    [ "$got" = "$want" ] || { rc=1; q="roots_planned: $got, want $want"; }
    for action in create update replace delete; do
      want="$(jq --arg a "$action" '.totals[$a] // 0' "$report")"
      got="$(value "terragucci_plan_changes{project=\"$project\",action=\"$action\"}")"
      [ "$got" = "$want" ] || { rc=1; q="${q:+$q; }plan_changes $action: $got, want $want"; }
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
  # The registry bind-mounts its certificates and outlives the claim. They live in a
  # directory no run removes and are rewritten in place (same inode), so Docker
  # Desktop's VM never holds a deleted file open.
  local certs="$HERE/.state/registry-certs"
  mkdir -p "$certs" "$work/newcerts" "$work/tree/modules/service" "$work/tree/modules/queue" "$work/tree/envs/dev"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:registry,IP:127.0.0.1" \
    -keyout "$work/newcerts/registry.key" -out "$work/newcerts/registry.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; drop_work "$work"; return 1; }
  cat "$work/newcerts/registry.key" > "$certs/registry.key"
  cat "$work/newcerts/registry.crt" > "$certs/registry.crt"
  chmod 644 "$certs/registry.key"
  with_lock compose env TERRAGUCCI_REGISTRY_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile registry up -d --force-recreate registry >&2 || { drop_work "$work"; return 1; }
  local i
  for i in $(seq 1 30); do
    curl -fsS --cacert "$certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --cacert "$certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 \
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
  cp "$certs/registry.crt" "$tree/registry.crt"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  printf 'resource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'resource "terraform_data" "queue" {}\n' > "$tree/modules/queue/main.tf"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/dev.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "dev" {}\n' "$name" > "$tree/envs/dev/main.tf"
  printf 'binary: tofu\nforge: forgejo\nenv:\n  NODE_EXTRA_CA_CERTS: registry.crt\nmodules:\n  path: modules/*\n  publish:\n    - oci://registry:5000/%s\n    - git-tags\n' "$repo" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  grep -q "terragucci publish" "$tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no publish job"; drop_work "$work"; return 1; }
  tags() { curl -fsS --cacert "$certs/registry.crt" "https://localhost:$port/v2/$repo/$1/tags/list" | jq -r '.tags // [] | sort | join(",")'; }
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
  local work repo="$USER/respond-drift" sha queue="tg-drift-$STAMP" extra="tg-drift-$STAMP-extra" url xurl out pr files args=()
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
  # The branch table lags a push; the files are read by the sha git ls-remote gives.
  sha="$(remote_head "$repo" terragucci/drift)"
  [ -n "$sha" ] || { log "terragucci/drift has no head"; return 1; }
  file_at "$repo" terragucci/drift "$sha" app/main.tf | grep -q 'visibility_timeout_seconds = 45' || { log "main.tf on the branch does not hold the live timeout"; return 1; }
  file_at "$repo" terragucci/drift "$sha" app/terragucci_generated.tf | grep -q "$extra" || { log "the generated config does not name $extra"; return 1; }
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
  local work clone repo="$USER/respond-fmt" main_sha head subject mode=apply out refs sha
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
  # The raw endpoint can lag even for a sha, so the file comes from git: a
  # clone of the branch, then the file at the sha.
  clone="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$clone"
  git clone -q --single-branch --branch smoke-fmt "${URL/#http:\/\/http://${USER}:${TOKEN}@}/${repo}.git" "$clone/repo" >&2 || { log "cannot clone smoke-fmt"; return 1; }
  git -C "$clone/repo" show "$sha:app/locals.tf" | grep -q '^  team  = "orders"$' || { log "locals.tf is not formatted on the branch"; return 1; }
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
  # pipeline runs one job per wave, each wave a dependency layer: the dev
  # platform, the other dev units, then the staging and prod platforms, the
  # services that read them, and last prod search, which goes out after prod
  # orders. A unit already applied plans no change and applies nothing, so the
  # claim reads which units each wave job planned, and example-terragrunt.sh
  # verifies the resources.
  # BREAK: the pipeline is written with no canary, so dev no longer goes first
  # and there are three waves, not five.
  log() { echo "[smoke tg-waves] $*" >&2; }
  local work="" rc=0 want k n pat logs line got bad
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
    # Each line: the wave, how many units it plans, and the pattern every one of them matches.
    while read -r k n pat; do
      logs="$(tg_main_job_log "apply-wave-$k")"
      # The first line of each wave job names every unit of its wave.
      line="$(grep -m1 "wave $k of 5: planning " <<<"$logs" | sed 's/.*: planning //' || true)"
      got="$(tr ',' '\n' <<<"$line" | sed 's/^ *//' | grep -c . || true)"
      bad="$(tr ',' '\n' <<<"$line" | sed 's/^ *//' | grep . | grep -vcE "^($pat)\$" || true)"
      if [ "$got" != "$n" ] || [ "$bad" != 0 ]; then
        log "apply-wave-$k did not plan its $n units alone (${line:-no wave $k of 5})"; rc=1
      fi
      grep -q "wave $k of 5 applied" <<<"$logs" || { log "apply-wave-$k did not end applied"; rc=1; }
    done <<'WAVES'
1 1 live/dev/platform
2 4 live/dev/(email|orders|payments|search)
3 2 live/(staging|prod)/platform
4 7 live/(staging|prod)/(email|orders|payments)|live/staging/search
5 1 live/prod/search
WAVES
  fi
  # The BREAK run left every unit applied and main carrying the no-canary
  # pipeline: put main back. The runner runs this claim's BREAK before its plain
  # run, whose `up` pushes the example to a fresh repo, and then says so with
  # SMOKE_PLAIN_NEXT=1, so there is nothing to put back.
  if [ -n "$work" ]; then
    drop_work "$work"
    [ -n "${SMOKE_PLAIN_NEXT:-}" ] || tg_restore_main || true
  fi
  [ $rc = 0 ] && log "15 units applied to floci in five waves, one job each: dev platform, dev services, staging and prod platforms, their services, prod search"
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
  # Merge new-service to main. Wave 1 applies ledger with the dev platform;
  # billing reads ledger, so it is in wave 2 and plans once ledger applied, and
  # its state holds ledger's real bucket and no mock value. BREAK: wave 1 of the
  # pushed pipeline applies billing alone in place of the stage, before ledger
  # exists, so billing takes the mock; ledger applies after it, and wave 2 does
  # nothing, so no stage plans billing again before the claim reads its state.
  # The mock bucket is made first, so billing's apply on the mock completes.
  log() { echo "[smoke tg-mock-trap] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/$TG_REPO_NAME" work sha rc=0 state u
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example-terragrunt up' first"; drop_work "$work"; return 1; }
  git -C "$work/tree" apply "$TG_EXAMPLE/changes/new-service.patch" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    curl -fsS -o /dev/null -X PUT "$FLOCI/mock-ledger-bucket" || { drop_work "$work"; return 1; }
    sed -i.bak \
      -e 's|TG_OUTCOME="$outcome" terragucci stage tf-apply --wave 1 |for u in billing ledger; do terragrunt run --no-color --working-dir "live/dev/$u" -- apply -auto-approve -input=false; done; exit 0 #|' \
      -e 's|TG_OUTCOME="$outcome" terragucci stage tf-apply --wave 2 |exit 0 #|' \
      "$work/tree/.forgejo/workflows/terragucci.yml" && rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "smoke tg-mock-trap: add billing and its ledger $(date +%s)")"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { log "the apply ended '$RUN_STATUS'"; rc=1; }
  state="$(curl -fsS "$FLOCI/shop-terraform-state/terragrunt/live/dev/billing/terraform.tfstate" || true)"
  grep -q 'mock-' <<<"$state" && { log "billing applied on the mock: its state holds $(grep -o 'mock-[a-z-]*' <<<"$state" | sort -u | paste -sd ' ' -)"; rc=1; }
  grep -q '"shop-tg-dev-ledger"' <<<"$state" || { log "billing's state does not name the ledger bucket"; rc=1; }
  # Put the estate back: billing and ledger destroyed, their state gone, main as committed.
  TG_TREE="$work/tree" "$HERE/example-terragrunt.sh" tg run --all --no-filters-file --filter '{./live/dev/billing}' --filter '{./live/dev/ledger}' -- destroy -auto-approve >&2 || true
  for u in billing ledger; do curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/terragrunt/live/dev/$u/terraform.tfstate" || true; done
  if [ -n "${BREAK:-}" ]; then
    curl -s -o /dev/null -X DELETE "$FLOCI/mock-ledger-bucket/services/billing.json" || true
    curl -s -o /dev/null -X DELETE "$FLOCI/mock-ledger-bucket" || true
  fi
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

claim_wave_report() {
  # One root that creates something, --gate always, and a bare repo for origin.
  # The first run waits (exit 3): its report.json says the wave is waiting and
  # names the chant/lifecycle ledger that holds the record, and report.html
  # shows both. An approval of the pending digest is appended to the ledger, as
  # chant approve writes it; the second run applies (exit 0) and the report
  # says approved.
  # BREAK: the run uses --gate never, so no wave waits and nothing is recorded.
  log() { echo "[smoke wave-report] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" gate=always code=0 rc=0 r digest clone
  [ -n "${BREAK:-}" ] && gate=never
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/wave/gate"
  cat >"$work/wave/gate/main.tf" <<'HCL'
terraform {
  backend "local" {}
}

resource "terraform_data" "report" {
  input = "wave-report"
}
HCL
  git init -q --bare "$work/origin.git"
  git -C "$work/wave" init -q -b main
  git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke wave-report"
  git -C "$work/wave" remote add origin /origin.git
  wave_run() {
    run_copied --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage tf-apply --wave 1 --layers gate --binary tofu --gate "$gate" >&2
  }
  r="$work/wave/terragucci-report/report.json"
  wave_run || code=$?
  clean_mounted "$work/wave" "$image"
  [ "$code" = 3 ] || { log "the first run exited $code, not 3: the wave did not wait for an approval"; rc=1; }
  if [ $rc = 0 ]; then
    jq -e '.waves[0] | .approval == "waiting" and .gate.branch == "chant/lifecycle" and .gate.path == "_gates/tf-apply.jsonl"' "$r" >/dev/null \
      || { log "the waiting wave's report does not say waiting with its ledger: $(jq -c '.waves[0]' "$r")"; rc=1; }
    grep -q "_gates/tf-apply.jsonl" "$work/wave/terragucci-report/report.html" || { log "report.html does not show the record"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/ledger"
    git clone -q -b chant/lifecycle "$work/origin.git" "$clone" || rc=1
  fi
  if [ $rc = 0 ]; then
    digest="$(jq -rs '[.[] | select(.kind == "pending" and .gate == "wave-1")] | last | .planDigest' "$clone/_gates/tf-apply.jsonl")"
    # The approval is stamped to the second and must be newer than the pending
    # fact, which carries milliseconds; a person reading the plan takes longer.
    sleep 1
    printf '%s\n' "$(jq -cn --arg d "$digest" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "smoke-approver", timestamp: $t, planDigest: $d}')" >> "$clone/_gates/tf-apply.jsonl"
    git -C "$clone" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "approve wave-1" && git -C "$clone" push -q origin chant/lifecycle || rc=1
  fi
  if [ $rc = 0 ]; then
    code=0
    wave_run || code=$?
    clean_mounted "$work/wave" "$image"
    [ "$code" = 0 ] || { log "the second run exited $code, not 0: the approval did not let the wave apply"; rc=1; }
    jq -e '.waves[0] | .approval == "approved" and .gate.path == "_gates/tf-apply.jsonl"' "$r" >/dev/null \
      || { log "the applied wave's report does not say approved: $(jq -c '.waves[0]' "$r")"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the report said waiting with its ledger, then approved once the digest was approved"
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

# ── choudoufu timings ─────────────────────────────────────────────────────
# A tf-apply wave of one root of four null_resource instances (the small
# hashicorp/null provider, run as a plugin over gRPC, and no cloud), run in the
# CI image of the binary given (BINARY, default choudoufu, the image
# `binary: choudoufu` runs), with extra `docker run` arguments ("$@", such as
# -e for a span budget). The wave inits each root with a provider cache of its
# own, so the provider is downloaded. The report's timings come from the spans
# the binary sent the stage's loopback receiver. Prints the path of the
# report.json, which stays under the work dir until drop_work.
timings_wave() { # work [docker run args...]
  local work="$1" image bin="${BINARY:-choudoufu}" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  shift
  image="$(image_tag "$bin")"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just images' first" >&2; return 1; }
  build_cli || return 1
  mkdir -p "$work/repo/calls"
  cat >"$work/repo/calls/main.tf" <<'HCL'
terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "3.2.4"
    }
  }
}

resource "null_resource" "n" {
  count = 4

  triggers = {
    index = count.index
  }
}
HCL
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke timings $(date +%s%N)"
  run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$@" \
    "$image" terragucci stage tf-apply --wave 1 --layers calls --binary "$bin" --gate never >&2 || { echo "the $bin wave did not apply" >&2; return 1; }
  [ -f "$work/repo/terragucci-report/report.json" ] || { echo "the $bin wave wrote no report" >&2; return 1; }
  echo "$work/repo/terragucci-report/report.json"
}

claim_provider_calls() {
  # With binary: choudoufu, the wave report lists the slowest provider calls
  # of the root, read from the tfplugin5/6.Provider spans choudoufu sends with
  # rpc.method, opentofu.provider.address and opentofu.resource.type: at least
  # one call about a null_resource, with its method and provider named.
  # BREAK: the same wave run by tofu, which sends no provider call spans.
  log() { echo "[smoke provider-calls] $*" >&2; }
  local work report calls rc=0 bin=choudoufu
  [ -n "${BREAK:-}" ] && bin=tofu
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  report="$(BINARY="$bin" timings_wave "$work")" || { drop_work "$work"; return 1; }
  calls="$(jq -c '[.roots[] | select(.path == "calls") | .timings.provider_calls[]?
    | select(.type == "null_resource" and (.method // "") != "" and ((.provider // "") | test("hashicorp/null")))]' "$report")"
  if [ "$(jq length <<<"$calls")" -lt 1 ]; then
    log "the $bin wave report lists no provider call for a null_resource with its method and provider ($(jq -c '[.roots[] | select(.path == "calls") | .timings | {spans, detail, provider_calls: (.provider_calls | length)}]' "$report"))"
    rc=1
  else
    log "the $bin wave report lists $(jq length <<<"$calls") provider call(s) for null_resource, the slowest $(jq -r '.[0] | "\(.method) on \(.provider) in \(.ms)ms"' <<<"$calls")"
  fi
  drop_work "$work"
  return "$rc"
}

claim_summed_timings() {
  # With binary: choudoufu and a span budget of one detail span per walk
  # (CHOUDOUFU_TRACE_SPAN_BUDGET=1), choudoufu sums the rest into Aggregate:
  # spans, and the wave report lists those sums: an aggregate for the
  # null_resource resources that counts more instances than it detailed, with
  # a total time, and the note of the root says how many were summed.
  # BREAK: a span budget the four null_resource instances cannot exceed, so nothing is summed.
  log() { echo "[smoke summed-timings] $*" >&2; }
  local work report summed budget=1 rc=0
  [ -n "${BREAK:-}" ] && budget=100000
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  report="$(timings_wave "$work" -e "CHOUDOUFU_TRACE_SPAN_BUDGET=$budget")" || { drop_work "$work"; return 1; }
  summed="$(jq -c '[.roots[] | select(.path == "calls") | .timings.aggregates[]?
    | select(.kind == "resource_instance" and .type == "null_resource" and .count > .detailed)]' "$report")"
  if [ "$(jq length <<<"$summed")" -lt 1 ]; then
    log "with a span budget of $budget the report lists no summed null_resource timings ($(jq -c '[.roots[] | select(.path == "calls") | .timings | {spans, detail, note, aggregates: (.aggregates | length)}]' "$report"))"
    rc=1
  elif ! jq -e '.roots[] | select(.path == "calls") | .timings.note // "" | test("summed")' "$report" >/dev/null; then
    log "the report sums null_resource timings but the note of the root does not say so"
    rc=1
  else
    log "with a span budget of $budget the report sums $(jq -r '.[0] | "\(.count) \(.of) spans of \(.type) (\(.detailed) detailed) to \(.ms)ms, longest \(.max_ms)ms"' <<<"$summed")"
  fi
  drop_work "$work"
  return "$rc"
}

claim_foreign_checkout() {
  # On github.com a container job runs as root and the runner's user (uid 1001)
  # owns the checkout; git refuses such a checkout unless it is marked safe.
  # The same change as affected, with the checkout handed to uid 1001 and no
  # safe.directory passed: the CI image's own git config must let affected
  # selection read the range, so envs/dev/platform and the four dev services
  # that read its state plan, and nothing else. The image must be built from
  # this tree (just images), since the setting lives in it.
  # BREAK: GIT_CONFIG_NOSYSTEM=1, so git skips the image's config, refuses the
  # checkout, and every root plans.
  log() { echo "[smoke foreign-checkout] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work r got want rc=0
  local -a REPORT_EXTRA=()
  want="envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/platform,envs/dev/search"
  [ -n "${BREAK:-}" ] && REPORT_EXTRA=(-e GIT_CONFIG_NOSYSTEM=1)
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  REPORT_OWNER=1001:1001 REPORT_BASE=1 \
    REPORT_EDIT='printf "\n# smoke foreign-checkout: a change to this root alone\n" >> envs/dev/platform/main.tf' report_run "$work" || true
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; return 1; }
  got="$(jq -r '[.roots[] | select(.status == "planned") | .path] | sort | join(",")' "$r")"
  [ "$got" = "$want" ] || { log "planned $got, not $want: git refused the checkout uid 1001 owns"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "as root on a checkout uid 1001 owns, envs/dev/platform changed: it and the four dev services that read its state planned, nothing else"
  return $rc
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
  sha="$(push_tree "$tree" "$repo" diag-policy "check-diagnostics: a policy test the base branch fails")" || return 1
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
  # The queue carries a tag: floci reads an untagged queue's tags as {} where
  # the state holds null, a tags drift that no run clears.
  respond_tree "$work" "$repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
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
  # gate) and reply with a link to the run. The repo sets approval: sealed.
  # BREAK: the approval key and chant.workspace.json are left out of the pushed
  # tree, so approval is ledger, and the unsealed approval lets the first
  # comment apply wave 1.
  log() { echo "[smoke comment-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-apply" sha merge pr open_pr applied reply rc=0
  local stranger="smoke-stranger" pass stoken
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo comment-apply gated-waves sealed || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && unseal_tree
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
    gated_approve comment-apply 1 sign || rc=1
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

# ── apply before merge (apply.when: pull-request) ──
# Each of the three claims below runs on a repo of its own made by gated_repo:
# the five roots, gate never (so no wave waits and the claim is about the pull
# request, not the gate), and apply.when: pull-request. A user of its own, a
# collaborator with write access, approves the pull requests: Forgejo counts no
# approval from the author of a pull request, who is the admin here.

pr_repo() { # name, merge (auto|manual), [merge] -> the repo in $work/tree, its pipeline written for apply before merge (or after, with a third argument)
  gated_repo "$1" || return 1
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  [ -n "${3:-}" ] || printf 'apply:\n  when: pull-request\n  merge: %s\n' "$2" >> "$work/tree/terragucci.yml"
  # Forgejo refuses a merge made with the job's own token, so merge: auto merges with the admin's, from a secret.
  if [ -z "${3:-}" ] && [ "$2" = auto ]; then
    echo '  merge_token_env: TG_SMOKE_MERGE_TOKEN' >> "$work/tree/terragucci.yml"
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "$TOKEN" '{data: $d}')" "$URL/api/v1/repos/$USER/$1/actions/secrets/TG_SMOKE_MERGE_TOKEN" \
      || { log "could not set TG_SMOKE_MERGE_TOKEN on $USER/$1"; return 1; }
  fi
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

pr_reviewer() { # repo, user -> sets PR_REVIEWER_TOKEN, for a new user with write access to the repo
  local pass="smoke-$RANDOM-$RANDOM-Aa1" who="$2"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$who" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || return 1
  api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"write"}' "$URL/api/v1/repos/$1/collaborators/$who" || return 1
  PR_REVIEWER_TOKEN="$(curl -fsS -u "$who:$pass" -H 'content-type: application/json' -X POST -d '{"name":"smoke","scopes":["write:repository","write:issue"]}' "$URL/api/v1/users/$who/tokens" | jq -r '.sha1 // empty')"
  [ -n "$PR_REVIEWER_TOKEN" ] || { log "no token for $who"; return 1; }
}

pr_open() { # repo, branch, title -> prints the number of the pull request into main
  # Forgejo checks the head against its branch table, which a push queue fills,
  # so a pull request opened right after the push can 404. Wait for the branch.
  local i n=""
  for i in $(seq 1 30); do
    api -o /dev/null "$URL/api/v1/repos/$1/branches/$2" 2>/dev/null && break
    sleep 2
  done
  n="$(api -H 'content-type: application/json' -X POST -d "$(jq -cn --arg h "$2" --arg t "$3" '{head: $h, base: "main", title: $t}')" "$URL/api/v1/repos/$1/pulls" | jq -r '.number // empty')"
  [ -n "$n" ] || { log "no pull request opened from $2"; return 1; }
  echo "$n"
}

pr_ready() { # repo, number, head sha -> waits for the runs on the head, then the reviewer approves it
  wait_run "$1" "$3" push || return 1
  wait_run "$1" "$3" pull_request || return 1
  curl -fsS -o /dev/null -H "Authorization: token $PR_REVIEWER_TOKEN" -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg c "$3" '{event: "APPROVED", body: "looks right", commit_id: $c}')" "$URL/api/v1/repos/$1/pulls/$2/reviews" || { log "the reviewer could not approve pull request $2"; return 1; }
}

pr_replies() { # repo, number -> how many replies terragucci posted on it
  api "$URL/api/v1/repos/$1/issues/$2/comments?limit=100" | jq '[.[] | select(.body | startswith("terragucci: "))] | length'
}

pr_say() { # repo, number, text -> prints the reply terragucci posts, once it has
  local before i
  before="$(pr_replies "$1" "$2")"
  api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$3" '{body: $b}')" "$URL/api/v1/repos/$1/issues/$2/comments" || return 1
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(pr_replies "$1" "$2")" -gt "$before" ] && break
    sleep 3
  done
  api "$URL/api/v1/repos/$1/issues/$2/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | last | .body // empty'
}

pr_state_input() { # name, root -> the input its terraform_data holds in the state (tofu writes it as {value, type}), empty when it has none
  curl -fsS "$FLOCI/shop-terraform-state/$1/$2.tfstate" 2>/dev/null | jq -r '[.resources[]?.instances[]?.attributes.input // empty] | first // empty | if type == "object" then .value else . end' 2>/dev/null || true
}

claim_pr_apply() {
  # A repo with apply.when: pull-request and apply.merge: auto. A pull request
  # changes canary/one; once its runs finished, a reviewer approves its
  # head and the admin comments /terragucci apply on it while it is open. The
  # reply must say both waves applied from the head and the pull request was
  # merged; the forge must show it merged; every root must have state, and
  # canary/one must hold the value of the pull request.
  # BREAK: the pipeline is written without apply.when, so it applies after
  # merge only: the comment on the open pull request is refused, canary/one
  # never holds the value of the pull request, and nothing merges.
  log() { echo "[smoke pr-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-apply" head pr reply applied merged rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-apply auto ${BREAK:+merge} || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-apply: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-apply || { drop_work "$work"; return 1; }
  echo opened > "$work/tree/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "pr-apply: change canary/one")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "pr-apply: change canary/one")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr" "$head" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
  applied="$(gated_applied pr-apply)"
  merged="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merged)"
  log "reply: ${reply:-none}; state for: ${applied:-nothing}; merged: $merged"
  grep -q "applied wave 1, 2 of pull request $pr at ${head:0:8}, and merged pull request $pr" <<<"$reply" || { log "the reply does not say both waves applied from the head and the pull request merged"; rc=1; }
  [ "$merged" = true ] || { log "pull request $pr was not merged"; rc=1; }
  [ "$applied" = "canary/one fleet/five fleet/four fleet/three fleet/two " ] || { log "not every root has state"; rc=1; }
  [ "$(pr_state_input pr-apply canary/one)" = opened ] || { log "canary/one does not hold the value of the pull request"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-apply?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the open pull request applied from its head in both waves and was merged after the last one"
  return $rc
}

claim_pr_apply_lock() {
  # A repo with apply.when: pull-request and apply.merge: manual. Pull requests
  # A and B each change canary/one (to a and to b). A is applied on a comment
  # and stays open, holding the lock on canary/one. /terragucci apply on B must
  # be refused, naming canary/one and pull request A, and canary/one must
  # still hold a. /terragucci unlock on A must say it released canary/one, and
  # /terragucci apply on B must then apply it: canary/one holds b.
  # BREAK: the lock file is deleted from chant/lifecycle after A applied, so
  # nothing holds canary/one and the first comment on B applies it.
  log() { echo "[smoke pr-apply-lock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-apply-lock" head_a head_b pr_a pr_b reply clone rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-apply-lock manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-apply-lock: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-apply-lock || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  head_a="$(push_tree "$work/tree" "$repo" change-a "pr-apply-lock: a")" || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/canary/one/rev.txt"
  head_b="$(push_tree "$work/tree" "$repo" change-b "pr-apply-lock: b")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "pr-apply-lock: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "pr-apply-lock: b")" || { drop_work "$work"; return 1; }
  { pr_ready "$repo" "$pr_a" "$head_a" && pr_ready "$repo" "$pr_b" "$head_b"; } || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr_a" "/terragucci apply")"
  log "A ($pr_a): ${reply:-no reply}; canary/one holds $(pr_state_input pr-apply-lock canary/one)"
  grep -q "Merge it when you are ready" <<<"$reply" || { log "A did not apply"; rc=1; }
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    clone="$work/lifecycle"
    { git clone -q --branch chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" \
      && git -C "$clone" rm -q _locks/tf-apply.json \
      && git -C "$clone" -c user.name=smoke -c user.email=smoke@terragucci.local -c commit.gpgsign=false commit -qm "drop the locks" \
      && git -C "$clone" push -q origin chant/lifecycle; } || rc=1
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci apply")"
    log "B ($pr_b) while A holds the lock: ${reply:-no reply}; canary/one holds $(pr_state_input pr-apply-lock canary/one)"
    grep -q "\`canary/one\` is locked by pull request $pr_a" <<<"$reply" || { log "B was not refused for the lock A holds"; rc=1; }
    [ "$(pr_state_input pr-apply-lock canary/one)" = a ] || { log "canary/one moved while A held it"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_a" "/terragucci unlock")"
    log "unlock on A: ${reply:-no reply}"
    grep -q "released the locks pull request $pr_a held on .*canary/one" <<<"$reply" || { log "the unlock did not release canary/one"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci apply")"
    log "B after the unlock: ${reply:-no reply}; canary/one holds $(pr_state_input pr-apply-lock canary/one)"
    [ "$(pr_state_input pr-apply-lock canary/one)" = b ] || { log "B did not apply canary/one after the unlock"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-apply-lock?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "B was refused while A held canary/one, and applied once A was unlocked"
  return $rc
}

claim_pr_apply_stale() {
  # A repo with apply.when: pull-request. A pull request changes canary/one
  # and is approved; then main moves (fleet/two changes on it). The comment
  # /terragucci apply must be refused as not up to date with main, and no
  # root may have state.
  # BREAK: main is merged into the pull request and its new head approved
  # before the comment, so the head is up to date and the comment applies.
  log() { echo "[smoke pr-apply-stale] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-apply-stale" head moved pr reply applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-apply-stale manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-apply-stale: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-apply-stale || { drop_work "$work"; return 1; }
  echo stale > "$work/tree/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "pr-apply-stale: change canary/one")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "pr-apply-stale: change canary/one")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr" "$head" || { drop_work "$work"; return 1; }
  # main moves on under the pull request.
  git -C "$work/tree" checkout -q main
  echo moved > "$work/tree/fleet/two/rev.txt"
  moved="$(push_tree "$work/tree" "$repo" main "pr-apply-stale: main moves")" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    git -C "$work/tree" checkout -q change || rc=1
    git -C "$work/tree" -c user.name=t -c user.email=t@terragucci.local -c commit.gpgsign=false merge -q --no-edit main || rc=1
    head="$(push_tree "$work/tree" "$repo" change "pr-apply-stale: main merged in")" || rc=1
    [ $rc != 0 ] || pr_ready "$repo" "$pr" "$head" || rc=1
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
    applied="$(gated_applied pr-apply-stale)"
    log "main is at ${moved:0:8}; reply: ${reply:-none}; state for: ${applied:-nothing}"
    grep -q "pull request $pr is not up to date with main" <<<"$reply" || { log "the stale head was not refused as not up to date"; rc=1; }
    [ -z "$applied" ] || { log "a refused comment applied: $applied"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-apply-stale?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the comment on a head behind main was refused and applied nothing"
  return $rc
}

pr_mergeable() { # repo, number -> waits until the forge has finished checking the pull request, then prints its mergeable
  local i m=""
  for i in $(seq 1 20); do
    m="$(api "$URL/api/v1/repos/$1/pulls/$2" | jq -r .mergeable)"
    [ "$m" = true ] && break
    sleep 3
  done
  echo "$m"
}

claim_pr_requires() {
  # Two repos with apply.when: pull-request and apply.merge: manual. In
  # pr-requires, apply.requires is [approved]: a pull request changes
  # canary/one and is approved, then main moves (fleet/two changes on it).
  # /terragucci apply must apply its head anyway: canary/one holds behind.
  # In pr-requires-all, with no requires (so all four), the same steps must be
  # refused as not up to date with main, and a second approved pull request
  # that writes fleet/two/rev.txt as main does not must be refused as not
  # mergeable, with no root given state.
  # BREAK: pr-requires is written with no requires, so the behind head is
  # refused and canary/one never holds behind.
  log() { echo "[smoke pr-requires] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local base work repo name head pr head_c pr_c reply applied rc=0
  base="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$base"
  for name in pr-requires pr-requires-all; do
    [ $rc = 0 ] || break
    repo="$USER/$name"
    # Each repo gets a work dir of its own under base, so the second tree starts with no history.
    work="$base/$name"; mkdir -p "$work"
    gated_repo "$name" || { rc=1; break; }
    sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
    printf 'apply:\n  when: pull-request\n  merge: manual\n' >> "$work/tree/terragucci.yml"
    [ "$name" = pr-requires ] && [ -z "${BREAK:-}" ] && printf '  requires: [approved]\n' >> "$work/tree/terragucci.yml"
    (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed in $name"; rc=1; break; }
    push_tree "$work/tree" "$repo" main "$name: first" >/dev/null || { rc=1; break; }
    pr_reviewer "$repo" "smoke-rev-$name" || { rc=1; break; }
    echo behind > "$work/tree/canary/one/rev.txt"
    head="$(push_tree "$work/tree" "$repo" change "$name: change canary/one")" || { rc=1; break; }
    pr="$(pr_open "$repo" change "$name: change canary/one")" || { rc=1; break; }
    pr_ready "$repo" "$pr" "$head" || { rc=1; break; }
    head_c=""; pr_c=""
    if [ "$name" = pr-requires-all ]; then
      git -C "$work/tree" checkout -q main
      echo conflict > "$work/tree/fleet/two/rev.txt"
      head_c="$(push_tree "$work/tree" "$repo" conflict "$name: fleet/two as main will not have it")" || { rc=1; break; }
      pr_c="$(pr_open "$repo" conflict "$name: fleet/two as main will not have it")" || { rc=1; break; }
      pr_ready "$repo" "$pr_c" "$head_c" || { rc=1; break; }
    fi
    # main moves on under the pull requests.
    git -C "$work/tree" checkout -q main
    echo moved > "$work/tree/fleet/two/rev.txt"
    push_tree "$work/tree" "$repo" main "$name: main moves" >/dev/null || { rc=1; break; }
    if [ "$name" = pr-requires ]; then
      reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
      log "$name: behind and approved: ${reply:-no reply}; canary/one holds $(pr_state_input "$name" canary/one)"
      grep -q "Merge it when you are ready" <<<"$reply" || { log "the approved head behind main did not apply with requires: [approved]"; rc=1; }
      [ "$(pr_state_input "$name" canary/one)" = behind ] || { log "canary/one does not hold the value of the pull request"; rc=1; }
    else
      log "$name: the forge says pull request $pr merges: $(pr_mergeable "$repo" "$pr")"
      reply="$(pr_say "$repo" "$pr_c" "/terragucci apply")"
      log "$name: conflicting ($pr_c): ${reply:-no reply}"
      grep -q "pull request $pr_c is not mergeable: the forge reports conflicts with main" <<<"$reply" || { log "the conflicting pull request was not refused as not mergeable"; rc=1; }
      reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
      applied="$(gated_applied "$name")"
      log "$name: behind and approved ($pr): ${reply:-no reply}; state for: ${applied:-nothing}"
      grep -q "pull request $pr is not up to date with main" <<<"$reply" || { log "the default requirements did not refuse the head behind main"; rc=1; }
      [ -z "$applied" ] || { log "a refused comment applied: $applied"; rc=1; }
    fi
  done
  for name in pr-requires pr-requires-all; do
    api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-$name?purge=true" 2>/dev/null || true
  done
  drop_work "$base"
  [ $rc = 0 ] && log "requires: [approved] applied the head behind main; the defaults refused it as not up to date and the conflicting one as not mergeable"
  return $rc
}

claim_pr_lock() {
  # A repo with apply.when: pull-request and apply.merge: manual. Pull requests
  # A and B each change canary/one. /terragucci lock on A must say it locked
  # canary/one and apply nothing. /terragucci apply on B, approved and green,
  # must be refused naming canary/one, pull request A and the lock, and
  # /terragucci lock on B must be refused the same way; no root has state.
  # BREAK: A is unlocked with /terragucci unlock right after the lock, so
  # nothing holds canary/one and the apply on B applies it.
  log() { echo "[smoke pr-lock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-lock" head_a head_b pr_a pr_b reply applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-lock manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-lock: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-lock || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  head_a="$(push_tree "$work/tree" "$repo" change-a "pr-lock: a")" || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/canary/one/rev.txt"
  head_b="$(push_tree "$work/tree" "$repo" change-b "pr-lock: b")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "pr-lock: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "pr-lock: b")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr_b" "$head_b" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr_a" "/terragucci lock")"
  applied="$(gated_applied pr-lock)"
  log "lock on A ($pr_a at ${head_a:0:8}): ${reply:-no reply}; state for: ${applied:-nothing}"
  grep -q "locked \`canary/one\` for pull request $pr_a" <<<"$reply" || { log "the lock on A did not lock canary/one"; rc=1; }
  grep -q "nothing was applied" <<<"$reply" || { log "the lock reply does not say nothing was applied"; rc=1; }
  [ -z "$applied" ] || { log "the lock applied: $applied"; rc=1; }
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    reply="$(pr_say "$repo" "$pr_a" "/terragucci unlock")"
    log "unlock on A: ${reply:-no reply}"
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci apply")"
    log "apply on B ($pr_b) while A holds the lock: ${reply:-no reply}; canary/one holds $(pr_state_input pr-lock canary/one)"
    grep -q "\`canary/one\` is locked by pull request $pr_a (locked with \`/terragucci lock\` by $USER)" <<<"$reply" || { log "the apply on B was not refused for the lock A holds"; rc=1; }
    [ -z "$(pr_state_input pr-lock canary/one)" ] || { log "canary/one was applied while A held it"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci lock")"
    log "lock on B: ${reply:-no reply}"
    grep -q "\`canary/one\` is locked by pull request $pr_a .*so pull request $pr_b is not locked" <<<"$reply" || { log "the lock on B was not refused for the lock A holds"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-lock?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "A locked canary/one without applying, and B was refused naming A"
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
  [ "$(file_at "$repo" agent-change "$new_sha" app/rev.txt)" = 3 ] || { log "the agent's commit does not set app/rev.txt to 3"; rc=1; }
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

claim_policy_delete_key() {
  # The base turns policy on: a Rego rule denying terraform_data, and the
  # policy key in terragucci.yml. The change under test adds a root planning a
  # terraform_data resource and deletes the policy key, so the checkout has no
  # policy at all. tf-plan must still exit 1 and fail that root, because the
  # base branch decides whether policy runs, and the report must say the
  # policy was read from the base. BREAK: the base never turns policy on (the
  # directory is there, the key is not), so nothing checks the plan and it
  # passes.
  log() { echo "[smoke policy-delete-key] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work tree rc=0 run=0 r root=envs/dev/policy-unkeyed edit
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  cp -R "$EXAMPLE/." "$tree/"
  mkdir -p "$tree/policy"
  printf 'package main\n\nimport rego.v1\n\ndeny contains msg if {\n  some rc in input.resource_changes\n  rc.type == "terraform_data"\n  msg := sprintf("%%s: terraform_data is not allowed here", [rc.address])\n}\n' > "$tree/policy/plan.rego"
  [ -z "${BREAK:-}" ] && printf 'policy:\n  engine: conftest\n  path: policy\n' >> "$tree/terragucci.yml"
  edit="mkdir -p $root
cat > $root/main.tf <<'TF'
terraform {
  required_version = \"~> 1.13.0\"

  backend \"s3\" {
    bucket         = \"shop-terraform-state\"
    key            = \"envs/dev/policy-unkeyed.tfstate\"
    region         = \"us-east-1\"
    use_lockfile   = true
    use_path_style = true
  }
}

resource \"terraform_data\" \"probe\" {
  input = 1
}
TF
awk '/^policy:/ { exit } { print }' terragucci.yml > terragucci.yml.new && mv terragucci.yml.new terragucci.yml"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  REPORT_TREE="$tree" REPORT_BASE=1 REPORT_EDIT="$edit" report_run "$work" || run=$?
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; drop_work "$work"; drop_work "$tree"; return 1; }
  if grep -q '^policy:' "$work/terragucci.yml"; then log "the change did not delete the policy key"; rc=1; fi
  [ "$run" = 1 ] || { log "the plan job exited $run, not 1: deleting the policy key waived the check"; rc=1; }
  jq -e --arg n "$root" '.roots[] | select(.path == $n and .status == "failed" and .policy.result == "denied")' "$r" >/dev/null || { log "$root is not failed with policy.result denied in the report"; rc=1; }
  jq -e '.policy.from == "base"' "$r" >/dev/null || { log "the report does not say the policy was read from the base"; rc=1; }
  grep -q "terraform_data.probe: terraform_data is not allowed here" "$work/terragucci-report/note.md" || { log "the note does not name the violation"; rc=1; }
  drop_work "$work"; drop_work "$tree"
  [ $rc = 0 ] && log "the change deleted the policy key, yet conftest denied terraform_data under the base policy and $root failed the plan job"
  return $rc
}

claim_policy_source() {
  # A shared policy repo on Forgejo holds policy/plan.rego twice: the tag v0
  # denies nothing, the tag v1 denies terraform_data. A control repo whose
  # defaults set policy.source to that repo at v1 is reconciled in a dry run
  # over one project: the policy-wave fixture root, with no policy directory
  # and no terragucci.yml. The terragucci.yml reconcile would write is
  # committed to the project, and a tf-apply wave runs there in the tofu CI
  # image. It must fetch the source at v1 and refuse the wave: exit 1, no
  # state, the report names the shared denial, and the log names the source.
  # BREAK: the control repo pins v0, so nothing denies the plan.
  log() { echo "[smoke policy-source] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" repo="$USER/shared-policy" ref=v1 remote code=0 rc=0 r file
  [ -n "${BREAK:-}" ] && ref=v0
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  fresh_repo shared-policy || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/shared/policy" "$work/project/app"
  git -C "$work/shared" init -q -b main
  printf 'package main\n\nimport rego.v1\n\ndeny contains msg if {\n  input.nothing_ever_matches\n  msg := "unreachable"\n}\n' > "$work/shared/policy/plan.rego"
  git -C "$work/shared" add -A && git -C "$work/shared" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm v0 && git -C "$work/shared" tag v0
  printf 'package main\n\nimport rego.v1\n\ndeny contains msg if {\n  some rc in input.resource_changes\n  rc.type == "terraform_data"\n  msg := sprintf("%%s: the shared policy denies terraform_data", [rc.address])\n}\n' > "$work/shared/policy/plan.rego"
  git -C "$work/shared" add -A && git -C "$work/shared" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm v1 && git -C "$work/shared" tag v1
  remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  git -C "$work/shared" push -q --force "$remote" main v0 v1 >/dev/null 2>&1 || { log "could not push the shared policy to $repo"; drop_work "$work"; return 1; }
  cp "$HERE/fixtures/policy-wave/app/main.tf" "$work/project/app/"
  git -C "$work/project" init -q -b main
  git -C "$work/project" add -A && git -C "$work/project" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "one root, no policy"
  cat > "$work/control.yml" <<YML
defaults:
  forge: forgejo
  binary: tofu
  policy:
    source: git+http://$USER:$TOKEN@forgejo:3000/$repo.git@$ref
projects:
  localhost/$USER/policy-project:
    url: /repo/project
YML
  in_image "$work" sh -c 'terragucci reconcile --config control.yml --json > reconcile.json' >&2 || { log "reconcile failed: $(head -c 2000 "$work/reconcile.json" 2>/dev/null)"; drop_work "$work"; return 1; }
  file="$(jq -r '.results.projects[0].changes[] | select(.path == "terragucci.yml") | .content' "$work/reconcile.json")"
  [ -n "$file" ] || { log "reconcile would write no terragucci.yml into the project"; drop_work "$work"; return 1; }
  grep -q "source: git+http://.*/$repo.git@$ref" <<<"$file" || { log "the project terragucci.yml does not name the source at $ref"; rc=1; }
  printf '%s\n' "$file" > "$work/project/terragucci.yml"
  [ ! -e "$work/project/policy" ] || { log "the project has a policy directory of its own"; rc=1; }
  git -C "$work/project" add -A && git -C "$work/project" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "terragucci.yml from the control repo"
  run_copied --rm --network terragucci -v "$work/project:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never > "$work/wave.log" 2>&1 || code=$?
  clean_mounted "$work/project" "$image"
  sed "s#$TOKEN#***#g" "$work/wave.log" >&2
  r="$work/project/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "the wave exited $code, not 1: the shared policy did not refuse it"; rc=1; }
  if [ -f "$work/project/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$work/project/app/terraform.tfstate" >/dev/null 2>&1; then
    log "app has state: the wave applied it"; rc=1
  fi
  grep -q "policy: read from git+http://forgejo:3000/$repo.git@$ref at commit" "$work/wave.log" || { log "the wave log does not name the shared source at $ref"; rc=1; }
  if grep -q "$TOKEN" "$work/wave.log"; then log "the wave log shows the token in the source URL"; rc=1; fi
  if [ ! -f "$r" ]; then
    log "the wave wrote no report"; rc=1
  else
    jq -e '.roots[] | select(.path == "app" and .status == "failed" and .policy.result == "denied") | .policy.denials | any(test("terraform_data.probe: the shared policy denies terraform_data"))' "$r" >/dev/null \
      || { log "the report does not fail app with the shared denial"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the project has no policy directory, reconcile wrote the control repo source into its terragucci.yml, and the wave fetched $repo at $ref and refused app with its denial"
  return $rc
}

claim_drift_overdue() {
  # A repo on Forgejo with Actions on and no run ever, so the forge has no
  # drift run to name. Its checkout commits terragucci.yml (drift: "0 6 * * *")
  # and the pipeline file on 2026-01-01, then a pull request adds one root. The
  # tf-plan of that change, in the tofu CI image with the forge in its
  # environment, asks Forgejo for the drift runs, counts from the pipeline
  # file, and must say in its log and its note that drift checks are overdue.
  # BREAK: the pipeline file is committed now, so the schedule has not come
  # round twice and nothing is overdue.
  log() { echo "[smoke drift-overdue] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" repo="$USER/drift-overdue" when="2026-01-01T00:00:00Z" base code=0 rc=0 note
  [ -n "${BREAK:-}" ] && when="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  fresh_repo drift-overdue || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/.forgejo/workflows"
  printf 'binary: tofu\nforge: forgejo\ndrift: "0 6 * * *"\n' > "$work/terragucci.yml"
  printf '# Generated by terragucci.\nname: terragucci\non:\n  schedule:\n    - cron: "0 6 * * *"\n' > "$work/.forgejo/workflows/terragucci.yml"
  git -C "$work" init -q -b main
  git -C "$work" add -A
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "pipeline with a drift schedule"
  base="$(git -C "$work" rev-parse HEAD)"
  mkdir -p "$work/app"
  cp "$HERE/fixtures/policy-wave/app/main.tf" "$work/app/"
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "one root"
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_BASE="$base" \
    -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_REPOSITORY="$repo" -e TG_TOKEN="$TOKEN" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --binary tofu --forge forgejo > "$work/plan.log" 2>&1 || code=$?
  clean_mounted "$work" "$image"
  sed "s#$TOKEN#***#g" "$work/plan.log" >&2
  note="$work/terragucci-report/note.md"
  [ "$code" = 0 ] || { log "the plan exited $code"; rc=1; }
  if grep -q "the forge did not say when the drift job last ran" "$work/plan.log"; then log "Forgejo did not answer for the drift runs"; rc=1; fi
  grep -q "Drift checks are overdue: .* since the pipeline was added on 2026-01-01" "$work/plan.log" || { log "the plan log does not say drift checks are overdue"; rc=1; }
  if [ ! -f "$note" ]; then
    log "the plan wrote no note"; rc=1
  else
    grep -q "^> Drift checks are overdue: the schedule .0 6 \* \* \*. has come round at least twice" "$note" || { log "the note does not say drift checks are overdue"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "with no drift run on Forgejo since the pipeline was added on 2026-01-01, the plan log and note say drift checks are overdue"
  return $rc
}

# ── gated waves on Terragrunt units ───────────────────────────────────────
# stack/fixtures/tg-gated-waves: three Terragrunt units, live/canary/one in
# the canary wave and live/fleet/* after it, gate: always. Each claim gets its
# own Forgejo repo and state prefix, through gated_repo, gated_approve and
# gated_forge as the plain claims use them.

tg_gated_applied() { # name -> the units with state under <name>/, space-separated
  curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$1/" | grep -o '<Key>[^<]*/terraform\.tfstate</Key>' \
    | sed -E "s#</?Key>##g; s#^$1/##; s#/terraform\.tfstate\$##" | sort | tr '\n' ' '
}

claim_tg_gate_wait() {
  # Push the fixture. Wave 1 (live/canary/one) plans its unit, waits for an
  # approval of its set digest and prints the command, so no unit has state.
  # Approve wave 1 with a sealed approval and push again: live/canary/one
  # applies from its saved plan, and wave 2 waits for its own approval.
  # BREAK: the pushed pipeline runs with --gate never, so wave 2 applies with
  # nothing approved.
  log() { echo "[smoke tg-gate-wait] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-gate-wait" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-gate-wait tg-gated-waves || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak 's#--gate always#--gate never#' "$work/tree/.forgejo/workflows/terragucci.yml"
    rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "tg-gate-wait: first")"
  wait_run "$repo" "$sha"
  applied="$(tg_gated_applied tg-gate-wait)"
  logs="$(print_logs "$repo" "$RUN_ID")"
  log "after the first push: run $RUN_STATUS, state for: ${applied:-nothing}"
  [ -z "$applied" ] || { log "a unit applied before any wave was approved"; rc=1; }
  if [ $rc = 0 ]; then
    grep -q "chant approve tf-apply wave-1 --plan" <<<"$logs" || { log "wave 1 did not print its approval command"; rc=1; }
    grep -q -- "-auto-approve" <<<"$logs" && { log "a job ran an apply with -auto-approve"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve tg-gate-wait 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "tg-gate-wait: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    applied="$(tg_gated_applied tg-gate-wait)"
    log "after the approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "live/canary/one " ] || { log "expected live/canary/one alone to apply, wave 2 waiting for its own approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "no unit applied until wave 1 was approved; then live/canary/one applied and wave 2 waited at its own gate"
  return $rc
}

claim_tg_gate_refuse() {
  # Push the fixture; wave 1 waits. Approve it, then change live/canary/one
  # and push again. Wave 1 plans a different set digest from the approved one,
  # so it applies nothing, names live/canary/one, and the run fails.
  # BREAK: the pushed pipeline runs with --gate never, so the changed wave applies.
  log() { echo "[smoke tg-gate-refuse] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-gate-refuse" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-gate-refuse tg-gated-waves || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak 's#--gate always#--gate never#' "$work/tree/.forgejo/workflows/terragucci.yml"
    rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "tg-gate-refuse: first")"
  wait_run "$repo" "$sha"
  if [ -z "${BREAK:-}" ]; then
    gated_approve tg-gate-refuse 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/live/canary/one/rev.txt"
    sha="$(push_tree "$work/tree" "$repo" main "tg-gate-refuse: change live/canary/one after its wave was approved")"
    wait_run "$repo" "$sha"
    applied="$(tg_gated_applied tg-gate-refuse)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the change: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a unit applied after its wave's plans changed"; rc=1; }
    [ "$RUN_STATUS" = failure ] || { log "the run ended '$RUN_STATUS', not failure"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "changed after it was approved, so nothing in it was applied" <<<"$logs" || { log "wave 1 did not refuse as changed"; rc=1; }
    grep -q "planned differently since: live/canary/one" <<<"$logs" || { log "the refusal does not name live/canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 changed after its approval, applied nothing and named live/canary/one"
  return $rc
}

claim_tg_sealed() {
  # Push the fixture; wave 1 waits. Write an unsealed approval of its plan,
  # and one sealed with an agent key the signers file does not list, both in
  # the approver name, and push again: nothing applies, and the run says the
  # approvals do not count. Then the approver runs chant approve --sign with
  # the listed key, and live/canary/one applies. The repo sets approval: sealed.
  # BREAK: the approval key and chant.workspace.json are left out of the pushed
  # tree, so approval is ledger and the unsealed approval lets wave 1 apply.
  log() { echo "[smoke tg-sealed] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-sealed" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-sealed tg-gated-waves sealed || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && unseal_tree
  ssh-keygen -q -t ed25519 -N "" -C agent -f "$work/agent" || rc=1
  sha="$(push_tree "$work/tree" "$repo" main "tg-sealed: first")"
  wait_run "$repo" "$sha"
  if [ $rc = 0 ]; then
    gated_forge tg-sealed 1 unsealed || rc=1
    gated_forge tg-sealed 1 "$work/agent" || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "tg-sealed: after an unsealed and an agent-sealed approval")"
    wait_run "$repo" "$sha"
    applied="$(tg_gated_applied tg-sealed)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the unsealed and agent-sealed approvals: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a unit applied on an approval no listed key sealed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "an approval does not count: the approval by smoke-approver is not signed" <<<"$logs" || { log "the run did not say the unsealed approval does not count"; rc=1; }
    grep -q "an approval does not count: the seal by smoke-approver does not verify" <<<"$logs" || { log "the run did not say the agent seal does not verify"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve tg-sealed 1 sign || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "tg-sealed: after a sealed approval")"
    wait_run "$repo" "$sha"
    applied="$(tg_gated_applied tg-sealed)"
    log "after the sealed approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "live/canary/one " ] || { log "expected live/canary/one to apply on the sealed approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "unsealed and agent-sealed approvals let no unit apply; the sealed one let wave 1 apply"
  return $rc
}

claim_tg_layers() {
  # stack/fixtures/tg-three-layers: live/net, live/app after it and live/edge
  # after app, gate: always. init writes three wave jobs. Push, then approve
  # each wave and push again: every push
  # applies exactly one more layer, and the wave after it waits at its own
  # gate, until all three have state and the run succeeds. The approvals are
  # unsigned: approval is ledger, the default.
  # BREAK: edge no longer names app, so the repo has two layers and edge goes
  # out with app.
  log() { echo "[smoke tg-layers] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-layers" sha applied logs rc=0 k want wf
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-layers tg-three-layers || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak '/dependencies {/,/^}/d' "$work/tree/live/edge/terragrunt.hcl"
    rm -f "$work/tree/live/edge/terragrunt.hcl.bak"
    (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  fi
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  sha="$(push_tree "$work/tree" "$repo" main "tg-layers: first")"
  wait_run "$repo" "$sha"
  applied="$(tg_gated_applied tg-layers)"
  logs="$(print_logs "$repo" "$RUN_ID")"
  log "after the first push: run $RUN_STATUS, state for: ${applied:-nothing}"
  [ -z "$applied" ] || { log "a unit applied before any wave was approved"; rc=1; }
  grep -q "wave 1 of 3: planning live/net" <<<"$logs" || { log "wave 1 of 3 did not plan live/net alone"; rc=1; }
  for k in 1 2 3; do
    [ $rc = 0 ] || break
    gated_approve tg-layers "$k" || { rc=1; break; }
    sha="$(push_tree "$work/tree" "$repo" main "tg-layers: after wave $k was approved")"
    wait_run "$repo" "$sha"
    applied="$(tg_gated_applied tg-layers)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after approving wave $k: run $RUN_STATUS, state for: ${applied:-nothing}"
    case "$k" in
      1) want="live/net " ;;
      2) want="live/app live/net " ;;
      3) want="live/app live/edge live/net " ;;
    esac
    [ "$applied" = "$want" ] || { log "expected state for $want after approving wave $k"; rc=1; }
    if [ "$k" -lt 3 ]; then
      grep -q "chant approve tf-apply wave-$((k + 1)) --plan" <<<"$logs" || { log "wave $((k + 1)) did not wait at its own gate"; rc=1; }
    else
      [ "$RUN_STATUS" = success ] || { log "the run ended '$RUN_STATUS' once every wave was approved"; rc=1; }
    fi
  done
  grep -q -- "-auto-approve" <<<"$logs" && { log "a job ran an apply with -auto-approve"; rc=1; }
  for k in 1 2 3; do
    grep -q "^  apply-wave-$k:" "$wf" || { log "init wrote no apply-wave-$k job"; rc=1; }
  done
  drop_work "$work"
  [ $rc = 0 ] && log "live/net, live/app and live/edge went out in three waves, each after an approval of its own digest"
  return $rc
}

claim_tg_comment_apply() {
  # The Terragrunt gated fixture on main, where wave 1 (live/canary/one) waits.
  # A pull request changes live/canary/one and is merged; the merge commit's
  # apply waits at wave 1 for its new digest. An agent writes an unsealed
  # approval of that plan to chant/lifecycle. `/terragucci apply` on the merged
  # pull request must be answered that wave 1 waits, with its set digest and
  # the chant approve command, and apply no unit. The same comment on an open
  # pull request is refused. The approver approves wave 1 with a sealed record,
  # and `/terragucci apply` again must apply live/canary/one through the
  # Terragrunt path (wave 2 waits at its own gate) and reply with a link to the
  # run. The repo sets approval: sealed.
  # BREAK: the approval key and chant.workspace.json are left out of the pushed
  # tree, so approval is ledger, and the unsealed approval lets the first
  # comment apply wave 1.
  log() { echo "[smoke tg-comment-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-comment-apply" wf sha merge pr open_pr applied reply rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-comment-apply tg-gated-waves sealed || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && unseal_tree
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  apply-comment:' "$wf" || { log "the Terragrunt pipeline has no apply-comment job"; drop_work "$work"; return 1; }
  grep -q 'tf-apply --wave "\$wave".* --terragrunt' "$wf" || { log "the apply-comment job does not run tf-apply with --terragrunt"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "tg-comment-apply: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  echo 2 > "$work/tree/live/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" change "tg-comment-apply: change live/canary/one" >/dev/null || { drop_work "$work"; return 1; }
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"change","base":"main","title":"tg-comment-apply: change live/canary/one"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || { log "pull request $pr did not merge"; drop_work "$work"; return 1; }
  merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
  [ -n "$merge" ] || { log "pull request $pr has no merge commit"; drop_work "$work"; return 1; }
  wait_run "$repo" "$merge" || { drop_work "$work"; return 1; }
  log "pull request $pr merged as ${merge:0:8}; its apply: $RUN_STATUS, state for: $(tg_gated_applied tg-comment-apply)"
  gated_forge tg-comment-apply 1 unsealed || rc=1

  # tg_reply n text -> the reply terragucci posts on n, once it has.
  tg_reply_count() { api "$URL/api/v1/repos/$repo/issues/$1/comments?limit=100" | jq '[.[] | select(.body | startswith("terragucci: "))] | length'; }
  tg_reply() {
    local n="$1" before i
    before="$(tg_reply_count "$n")"
    api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$2" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$n/comments" || return 1
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      [ "$(tg_reply_count "$n")" -gt "$before" ] && break
      sleep 3
    done
    api "$URL/api/v1/repos/$repo/issues/$n/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | last | .body // empty'
  }

  if [ $rc = 0 ]; then
    reply="$(tg_reply "$pr" "/terragucci apply")"
    applied="$(tg_gated_applied tg-comment-apply)"
    log "first comment: state for: ${applied:-nothing}; reply: ${reply:-none}"
    [ -z "$applied" ] || { log "the comment applied a unit with no sealed approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -Eq "wave 1 waits for an approval of its set digest (jcs1-)?sha256:[0-9a-f]+" <<<"$reply" || { log "the reply does not say wave 1 waits, with its digest"; rc=1; }
    grep -Eq 'chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' <<<"$reply" || { log "the reply does not give the chant approve command"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    echo open > "$work/tree/live/fleet/two/rev.txt"
    push_tree "$work/tree" "$repo" open-change "tg-comment-apply: an open change" >/dev/null || rc=1
    open_pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"open-change","base":"main","title":"tg-comment-apply: open"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
    reply="$(tg_reply "$open_pr" "/terragucci apply")"
    log "open pull request $open_pr: ${reply:-no reply}"
    grep -q "pull request $open_pr is not merged" <<<"$reply" || { log "an apply comment on an open pull request was not refused"; rc=1; }
    applied="$(tg_gated_applied tg-comment-apply)"
    [ -z "$applied" ] || { log "a refused comment applied: $applied"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve tg-comment-apply 1 sign || rc=1; }
  if [ $rc = 0 ]; then
    reply="$(tg_reply "$pr" "/terragucci apply")"
    applied="$(tg_gated_applied tg-comment-apply)"
    log "after the sealed approval: state for: ${applied:-nothing}; reply: ${reply:-none}"
    [ "$applied" = "live/canary/one " ] || { log "expected live/canary/one alone to apply, wave 2 waiting at its own gate"; rc=1; }
    grep -q "/actions/runs/" <<<"$reply" || { log "the reply does not link the run"; rc=1; }
    grep -q "wave 2 waits" <<<"$reply" || { log "the reply does not say wave 2 waits"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the comment applied no unit while wave 1 had only an unsealed approval, refused an open pull request, and applied live/canary/one once wave 1 was sealed"
  return $rc
}

# ── apply before merge in a Terragrunt repo ──
# The Terragrunt gated fixture (stack/fixtures/tg-gated-waves) with gate never,
# apply.when: pull-request, and live/fleet/two after live/canary/one through a
# dependencies block, so the lock claim has a unit reached only through one.
# A user of its own approves the pull requests, as for the plain claims.

tg_pr_repo() { # name, merge (auto|manual), [merge] -> the repo in $work/tree, its pipeline written for apply before merge (or after, with a third argument)
  gated_repo "$1" tg-gated-waves || return 1
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  printf '\ndependencies {\n  paths = ["../../canary/one"]\n}\n' >> "$work/tree/live/fleet/two/terragrunt.hcl"
  [ -n "${3:-}" ] || printf 'apply:\n  when: pull-request\n  merge: %s\n' "$2" >> "$work/tree/terragucci.yml"
  if [ -z "${3:-}" ] && [ "$2" = auto ]; then
    echo '  merge_token_env: TG_SMOKE_MERGE_TOKEN' >> "$work/tree/terragucci.yml"
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "$TOKEN" '{data: $d}')" "$URL/api/v1/repos/$USER/$1/actions/secrets/TG_SMOKE_MERGE_TOKEN" \
      || { log "could not set TG_SMOKE_MERGE_TOKEN on $USER/$1"; return 1; }
  fi
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

claim_tg_pr_apply() {
  # A Terragrunt repo with apply.when: pull-request and apply.merge: auto. A
  # pull request changes live/canary/one; once its runs finished, a reviewer
  # approves its head and the admin comments /terragucci apply on it while it
  # is open. The reply must say both waves of units applied from the head and
  # the pull request was merged; the forge must show it merged; every unit
  # must have state, and live/canary/one must hold the value of the pull request.
  # BREAK: the pipeline is written without apply.when, so it applies after
  # merge only: the comment on the open pull request is refused, the unit
  # never holds the value of the pull request, and nothing merges.
  log() { echo "[smoke tg-pr-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-pr-apply" wf head pr reply applied merged rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_pr_repo tg-pr-apply auto ${BREAK:+merge} || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -z "${BREAK:-}" ]; then
    grep -q 'comment-apply .*--when pull-request.* --terragrunt' "$wf" || { log "the apply-comment job does not decide with --terragrunt"; drop_work "$work"; return 1; }
    grep -q '^  confirm:' "$wf" || { log "the Terragrunt pipeline has no confirm job"; drop_work "$work"; return 1; }
  fi
  push_tree "$work/tree" "$repo" main "tg-pr-apply: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-tg-pr-apply || { drop_work "$work"; return 1; }
  echo opened > "$work/tree/live/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "tg-pr-apply: change live/canary/one")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "tg-pr-apply: change live/canary/one")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr" "$head" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
  applied="$(tg_gated_applied tg-pr-apply)"
  merged="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merged)"
  log "reply: ${reply:-none}; state for: ${applied:-nothing}; merged: $merged"
  grep -q "applied wave 1, 2 of pull request $pr at ${head:0:8}, and merged pull request $pr" <<<"$reply" || { log "the reply does not say both waves of units applied from the head and the pull request merged"; rc=1; }
  [ "$merged" = true ] || { log "pull request $pr was not merged"; rc=1; }
  [ "$applied" = "live/canary/one live/fleet/three live/fleet/two " ] || { log "not every unit has state"; rc=1; }
  [ "$(pr_state_input tg-pr-apply live/canary/one/terraform)" = opened ] || { log "live/canary/one does not hold the value of the pull request"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-tg-pr-apply?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the open pull request applied its waves of units from its head and was merged after the last one"
  return $rc
}

claim_tg_pr_apply_lock() {
  # A Terragrunt repo with apply.when: pull-request and apply.merge: manual.
  # Pull request A changes live/canary/one, and B changes live/fleet/two, which
  # names live/canary/one in its dependencies block and in no other way. A is
  # applied on a comment and stays open, holding live/canary/one and its
  # dependent live/fleet/two. /terragucci apply on B must be refused, naming
  # live/fleet/two and pull request A, and live/fleet/two must still hold the
  # value A applied.
  # BREAK: the lock file is deleted from chant/lifecycle after A applied, so
  # nothing holds live/fleet/two and the comment on B applies it.
  log() { echo "[smoke tg-pr-apply-lock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-pr-apply-lock" head_a head_b pr_a pr_b reply clone rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_pr_repo tg-pr-apply-lock manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "tg-pr-apply-lock: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-tg-pr-apply-lock || { drop_work "$work"; return 1; }
  echo a > "$work/tree/live/canary/one/rev.txt"
  head_a="$(push_tree "$work/tree" "$repo" change-a "tg-pr-apply-lock: a")" || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/live/fleet/two/rev.txt"
  head_b="$(push_tree "$work/tree" "$repo" change-b "tg-pr-apply-lock: b")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "tg-pr-apply-lock: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "tg-pr-apply-lock: b")" || { drop_work "$work"; return 1; }
  { pr_ready "$repo" "$pr_a" "$head_a" && pr_ready "$repo" "$pr_b" "$head_b"; } || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr_a" "/terragucci apply")"
  log "A ($pr_a): ${reply:-no reply}; live/fleet/two holds $(pr_state_input tg-pr-apply-lock live/fleet/two/terraform)"
  grep -q "Merge it when you are ready" <<<"$reply" || { log "A did not apply"; rc=1; }
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    clone="$work/lifecycle"
    { git clone -q --branch chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" \
      && git -C "$clone" rm -q _locks/tf-apply.json \
      && git -C "$clone" -c user.name=smoke -c user.email=smoke@terragucci.local -c commit.gpgsign=false commit -qm "drop the locks" \
      && git -C "$clone" push -q origin chant/lifecycle; } || rc=1
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci apply")"
    log "B ($pr_b) while A holds the lock: ${reply:-no reply}; live/fleet/two holds $(pr_state_input tg-pr-apply-lock live/fleet/two/terraform)"
    grep -q "\`live/fleet/two\` is locked by pull request $pr_a" <<<"$reply" || { log "B was not refused for the lock A holds on live/fleet/two"; rc=1; }
    [ "$(pr_state_input tg-pr-apply-lock live/fleet/two/terraform)" = 1 ] || { log "live/fleet/two moved while A held it"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-tg-pr-apply-lock?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "B, which reaches live/canary/one only through the dependencies block of live/fleet/two, was refused while A held it"
  return $rc
}

# ── plan locks (locks: plan) ──
# The plain gated-waves fixture with gate never and locks: plan, applying after
# merge. The pr-lock job runs on pull_request_target from the default branch,
# so its run is not on the head commit: the claims read terragucci/lock on the
# head and the lock file on chant/lifecycle instead of waiting for a run.

plan_lock_repo() { # name -> the repo in $work/tree, its pipeline written with locks: plan (left out under BREAK when $2 is break)
  gated_repo "$1" || return 1
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  [ "${2:-}" = break ] || echo 'locks: plan' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

lock_status() { # repo, sha -> "<state> <description>" of the latest terragucci/lock status on the commit, empty when it has none
  api "$URL/api/v1/repos/$1/commits/$2/statuses?limit=50" 2>/dev/null \
    | jq -r '[.[] | select(.context == "terragucci/lock")] | sort_by(.id) | last | if . == null then empty else "\(.status // .state) \(.description)" end' 2>/dev/null || true
}

wait_lock_status() { # repo, sha, state -> prints the status once its state is <state>, or the last one seen
  local i got=""
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    got="$(lock_status "$1" "$2")"
    [ "${got%% *}" = "$3" ] && break
    sleep 3
  done
  echo "$got"
}

lock_file() { # repo -> _locks/tf-apply.json on chant/lifecycle, empty when there is none
  api "$URL/api/v1/repos/$1/raw/_locks%2Ftf-apply.json?ref=chant%2Flifecycle" 2>/dev/null || true
}

last_reply() { # repo, number -> the last reply terragucci posted on it
  api "$URL/api/v1/repos/$1/issues/$2/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | last | .body // empty'
}

claim_plan_lock() {
  # A repo with locks: plan. Pull request A changes canary/one; the pr-lock job
  # locks it on pull_request_target and posts terragucci/lock success on the
  # head. Pull request B changes canary/one too: its terragucci/lock fails, and
  # the reply names canary/one and A, planned by its author. /terragucci unlock
  # on A releases it, and /terragucci plan on B then takes it.
  # BREAK: locks: plan is left out of terragucci.yml, so there is no pr-lock
  # job and B is never answered as locked.
  log() { echo "[smoke plan-lock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/plan-lock" head_a head_b pr_a pr_b got reply rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  plan_lock_repo plan-lock ${BREAK:+break} || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    grep -q '^  pr-lock:' "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no pr-lock job"; drop_work "$work"; return 1; }
  fi
  wait_run "$repo" "$(push_tree "$work/tree" "$repo" main "plan-lock: first")" || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  head_a="$(push_tree "$work/tree" "$repo" change-a "plan-lock: a")" || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/canary/one/rev.txt"
  head_b="$(push_tree "$work/tree" "$repo" change-b "plan-lock: b")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "plan-lock: a")" || { drop_work "$work"; return 1; }
  # Under BREAK no job posts the status, so A is not waited for.
  if [ -z "${BREAK:-}" ]; then
    got="$(wait_lock_status "$repo" "$head_a" success)"
    log "A ($pr_a): terragucci/lock ${got:-none}"
    [ "$got" = "success holds canary/one" ] || { log "A does not hold canary/one"; rc=1; }
  fi
  pr_b="$(pr_open "$repo" change-b "plan-lock: b")" || { drop_work "$work"; return 1; }
  got="$(wait_lock_status "$repo" "$head_b" failure)"
  reply="$(last_reply "$repo" "$pr_b")"
  log "B ($pr_b): terragucci/lock ${got:-none}; reply: ${reply:-none}"
  [ "${got%% *}" = failure ] || { log "terragucci/lock on B did not fail"; rc=1; }
  grep -q "\`canary/one\` is locked by pull request $pr_a (planned by $USER), so pull request $pr_b is not locked" <<<"$reply" || { log "B was not answered as locked, naming canary/one and A"; rc=1; }
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_a" "/terragucci unlock")"
    log "unlock on A: ${reply:-no reply}"
    grep -q "released the locks pull request $pr_a held on \`canary/one\`" <<<"$reply" || { log "the unlock did not release canary/one"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"body":"/terragucci plan"}' "$URL/api/v1/repos/$repo/issues/$pr_b/comments" || rc=1
    got="$(wait_lock_status "$repo" "$head_b" success)"
    log "B after the unlock and /terragucci plan: terragucci/lock ${got:-none}; locks: $(lock_file "$repo" | jq -c '.locks | map_values(.pr)' 2>/dev/null)"
    [ "$got" = "success holds canary/one" ] || { log "B did not take canary/one after the unlock"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "A locked canary/one at its first plan, B was answered as locked by A, and took it once A was unlocked"
  return $rc
}

claim_plan_lock_release() {
  # A repo with locks: plan, applying after merge. Pull request A changes
  # canary/one and locks it; then A merges, and the closed event releases its
  # lock: canary/one is gone from _locks/tf-apply.json.
  # BREAK: closed is cut from the pull_request_target types of the committed
  # pipeline, so nothing releases the lock and A still holds canary/one.
  log() { echo "[smoke plan-lock-release] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/plan-lock-release" wf head pr got i held rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  plan_lock_repo plan-lock-release || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak '/^  pull_request_target:/,/^[a-z]/{/^      - closed$/d;}' "$wf" && rm -f "$wf.bak"
  fi
  wait_run "$repo" "$(push_tree "$work/tree" "$repo" main "plan-lock-release: first")" || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "plan-lock-release: a")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "plan-lock-release: a")" || { drop_work "$work"; return 1; }
  got="$(wait_lock_status "$repo" "$head" success)"
  log "A ($pr): terragucci/lock ${got:-none}"
  [ "$got" = "success holds canary/one" ] || { log "A does not hold canary/one"; rc=1; }
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || { log "pull request $pr did not merge"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      held="$(lock_file "$repo" | jq -r '.locks["canary/one"].pr // empty' 2>/dev/null)"
      [ -z "$held" ] && break
      sleep 3
    done
    log "after the merge: canary/one is held by ${held:-nobody}"
    [ -z "$held" ] || { log "the merge of pull request $pr did not release canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "A held canary/one from its first plan, and its merge released it"
  return $rc
}

claim_front_door() {
  # The reports front door template the site offers
  # (docs-site/public/reports-front-door.json) deploys through floci's
  # CloudFormation in front of a private bucket, with a hosted zone and a
  # given certificate. The stack must reach CREATE_COMPLETE with its Url and
  # DistributionId outputs, and list every resource its conditions select as
  # CREATE_COMPLETE (the certificate left out, since one is given). The
  # template floci accepted (GetTemplate) must answer at the domain over HTTPS
  # only, read the bucket through the Origin Access Control and run the edge
  # function's published version on every viewer request; its bucket policy
  # must admit cloudfront.amazonaws.com for that distribution only, its alias
  # records must point at the distribution, and its settings secret must
  # generate the session key. Its limits: floci's CloudFormation stubs the
  # distribution, the Origin Access Control, the bucket policy, the records and
  # the secret (none reaches its service's API) and runs no Lambda@Edge, so
  # the claim holds the stack floci accepted, not the deployed resources. Those
  # are held by the manual check on AWS in the pull request that added the
  # front door, and the sign-in by test/front-door.test.ts, which runs the
  # inlined code.
  # BREAK: the template loses its viewer-request association, so a request
  # would reach the bucket with no sign-in.
  log() { echo "[smoke front-door] $*" >&2; }
  local floci="${TERRAGUCCI_FLOCI_URL:-http://localhost:${TERRAGUCCI_FLOCI_PORT:-4580}}"
  local stack=terragucci-smoke-door domain=reports.door.test
  local tpl="$HERE/../docs-site/public/reports-front-door.json" work status="" xml dist got r i rc=0
  local auth='AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/cloudformation/aws4_request, SignedHeaders=host, Signature=0'
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    jq '(.Resources[] | select(.Type == "AWS::CloudFront::Distribution") | .Properties.DistributionConfig.DefaultCacheBehavior) |= del(.LambdaFunctionAssociations)' "$tpl" > "$work/template.json"
  else
    cp "$tpl" "$work/template.json"
  fi
  cfn() { curl -fsS -X POST "$floci/" -H "Authorization: $auth" --data-urlencode "Version=2010-05-15" --data-urlencode "Action=$1" "${@:2}"; }
  stack_status() { cfn DescribeStacks --data-urlencode "StackName=$stack" 2>/dev/null | grep -o '<StackStatus>[^<]*' | head -1 | sed 's/<StackStatus>//'; }
  # A run before this one may have left its stack.
  cfn DeleteStack --data-urlencode "StackName=$stack" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do [ -z "$(stack_status)" ] && break; sleep 2; done
  cfn CreateStack --data-urlencode "StackName=$stack" --data-urlencode "TemplateBody@$work/template.json" \
    --data-urlencode "Capabilities.member.1=CAPABILITY_IAM" \
    --data-urlencode "Parameters.member.1.ParameterKey=ReportsBucket" --data-urlencode "Parameters.member.1.ParameterValue=terragucci-smoke-door" \
    --data-urlencode "Parameters.member.2.ParameterKey=DomainName" --data-urlencode "Parameters.member.2.ParameterValue=$domain" \
    --data-urlencode "Parameters.member.3.ParameterKey=HostedZoneId" --data-urlencode "Parameters.member.3.ParameterValue=Z0SMOKEDOOR" \
    --data-urlencode "Parameters.member.4.ParameterKey=CertificateArn" --data-urlencode "Parameters.member.4.ParameterValue=arn:aws:acm:us-east-1:000000000000:certificate/terragucci-smoke-door" \
    --data-urlencode "Parameters.member.5.ParameterKey=OidcIssuer" --data-urlencode "Parameters.member.5.ParameterValue=https://idp.door.test" \
    --data-urlencode "Parameters.member.6.ParameterKey=OidcClientId" --data-urlencode "Parameters.member.6.ParameterValue=terragucci-reports" \
    --data-urlencode "Parameters.member.7.ParameterKey=OidcClientSecretName" --data-urlencode "Parameters.member.7.ParameterValue=terragucci-smoke-door-client" \
    --data-urlencode "Parameters.member.8.ParameterKey=WriteBucketPolicy" --data-urlencode "Parameters.member.8.ParameterValue=true" \
    > "$work/create.xml" 2>&1 || { log "CreateStack was refused: $(head -c 600 "$work/create.xml")"; drop_work "$work"; return 1; }
  for i in $(seq 1 60); do
    status="$(stack_status)"
    case "$status" in *_COMPLETE|*_FAILED) break ;; esac
    sleep 2
  done
  if [ "$status" != CREATE_COMPLETE ]; then
    log "the stack ended '$status'"
    cfn DescribeStackEvents --data-urlencode "StackName=$stack" 2>/dev/null | grep -o '<ResourceStatusReason>[^<]*' | head -5 | sed 's/^/[smoke front-door]   /' >&2 || true
    cfn DeleteStack --data-urlencode "StackName=$stack" >/dev/null 2>&1 || true
    drop_work "$work"; return 1
  fi
  xml="$(cfn DescribeStacks --data-urlencode "StackName=$stack" 2>/dev/null | tr -d '\n' || true)"
  grep -q "<OutputValue>https://$domain</OutputValue>" <<<"$xml" || { log "the Url output is not https://$domain"; rc=1; }
  dist="$(grep -o '<OutputKey>DistributionId</OutputKey>[^/]*<OutputValue>[^<]*' <<<"$xml" | sed 's/.*<OutputValue>//')"
  [ -n "$dist" ] || { log "the stack has no DistributionId output"; rc=1; }
  # Every resource the conditions select is created, and the certificate (one was given) is not.
  got="$(cfn ListStackResources --data-urlencode "StackName=$stack" 2>/dev/null | tr -d '\n' | grep -o '<LogicalResourceId>[^<]*</LogicalResourceId>\(<[^>]*>[^<]*</[^>]*>\)*' || true)"
  for r in doorAccess doorBucketPolicy doorDistribution doorDnsA doorDnsAAAA doorEdge doorEdgeVersion doorRole doorSettings; do
    grep "<LogicalResourceId>$r</LogicalResourceId>" <<<"$got" | grep -q CREATE_COMPLETE || { log "the stack did not create $r"; rc=1; }
  done
  ! grep -q '<LogicalResourceId>doorCertificate</LogicalResourceId>' <<<"$got" || { log "the stack requested a certificate though one was given"; rc=1; }
  # The template floci accepted, as GetTemplate returns it.
  cfn GetTemplate --data-urlencode "StackName=$stack" 2>/dev/null \
    | python3 -c 'import sys, xml.etree.ElementTree as E; t = [e.text for e in E.fromstring(sys.stdin.read()).iter() if e.tag.endswith("TemplateBody")]; print(t[0] if t else "")' \
    > "$work/accepted.json" 2>/dev/null || true
  if ! jq -e . "$work/accepted.json" >/dev/null 2>&1; then
    log "GetTemplate returned no template"; rc=1
  else
    held() { jq -e "$2" "$work/accepted.json" >/dev/null 2>&1 || { log "$1"; rc=1; }; }
    held "the distribution does not answer at DomainName" '.Resources.doorDistribution.Properties.DistributionConfig.Aliases == [{"Ref": "DomainName"}]'
    held "the distribution serves plain HTTP" '.Resources.doorDistribution.Properties.DistributionConfig | .DefaultCacheBehavior.ViewerProtocolPolicy == "redirect-to-https" and (.CacheBehaviors // [] | length) == 0'
    held "the origin is not the bucket through the Origin Access Control" '.Resources.doorDistribution.Properties.DistributionConfig.Origins | length == 1 and .[0].OriginAccessControlId == {"Fn::GetAtt": ["doorAccess", "Id"]} and .[0].S3OriginConfig.OriginAccessIdentity == "" and (.[0].DomainName | tostring | contains("ReportsBucket"))'
    held "no published version of the edge function runs on viewer requests" '.Resources.doorDistribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations == [{"EventType": "viewer-request", "LambdaFunctionARN": {"Ref": "doorEdgeVersion"}}] and .Resources.doorEdgeVersion.Properties.FunctionName == {"Fn::GetAtt": ["doorEdge", "Arn"]}'
    held "the bucket policy does not admit the distribution alone" '.Resources.doorBucketPolicy.Properties.PolicyDocument.Statement | length == 1 and .[0].Principal == {"Service": "cloudfront.amazonaws.com"} and .[0].Action == "s3:GetObject" and (.[0].Condition.StringEquals["AWS:SourceArn"] | tostring | contains("{\"Fn::GetAtt\":[\"doorDistribution\",\"Id\"]}"))'
    held "the alias records do not point at the distribution" '[.Resources.doorDnsA, .Resources.doorDnsAAAA] | map(.Properties.AliasTarget.DNSName == {"Fn::GetAtt": ["doorDistribution", "DomainName"]} and .Properties.Name == {"Ref": "DomainName"}) | all'
    held "the settings secret generates no session key" '.Resources.doorSettings.Properties.GenerateSecretString | .GenerateStringKey == "sessionKey" and .PasswordLength == 64'
  fi
  cfn DeleteStack --data-urlencode "StackName=$stack" >/dev/null 2>&1 || true
  drop_work "$work"
  return $rc
}

# ── approval modes ────────────────────────────────────────────────────────
# Each claim runs on the gated fixture in a repo of its own (gated_repo).

claim_ledger_default() {
  # No approval key: init declares no gate in chant.workspace.json, and wave 1
  # waits, saying approval ledger and printing its command without --sign. An
  # unsigned chant approve of its digest, and a push, let canary/one apply.
  # BREAK: terragucci.yml sets approval: sealed after init, so the config at
  # base seals the gate and the unsigned approval counts for nothing.
  log() { echo "[smoke ledger-default] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/ledger-default" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo ledger-default || { drop_work "$work"; return 1; }
  if [ -f "$work/tree/chant.workspace.json" ] && ! jq -e '(.identity.gates // {}) | length == 0' "$work/tree/chant.workspace.json" >/dev/null; then
    log "init declared gates under identity.gates with no approval key"; rc=1
  fi
  [ -n "${BREAK:-}" ] && echo "approval: sealed" >> "$work/tree/terragucci.yml"
  sha="$(push_tree "$work/tree" "$repo" main "ledger-default: first")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  if [ $rc = 0 ]; then
    grep -q "wave 1 of 2: approval ledger (the default)" <<<"$logs" || { log "wave 1 did not say approval ledger (the default)"; rc=1; }
    grep -Eq "chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+" <<<"$logs" || { log "wave 1 did not print its approval command"; rc=1; }
    grep -E "chant approve tf-apply wave-1 --plan" <<<"$logs" | grep -q -- "--sign" && { log "the approval command asks for --sign under ledger"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve ledger-default 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "ledger-default: after an unsigned approval")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied ledger-default)"
    log "after the unsigned approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the unsigned approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "no gate declared, the command had no --sign, and an unsigned approval of the digest let wave 1 apply"
  return $rc
}

claim_approval_at_base() {
  # The repo sets approval: sealed; wave 1 waits, and an unsigned approval of
  # its plan is written. One commit then sets approval: ledger and drops
  # chant.workspace.json: its run reads the rule at base, the commit before
  # it, so it says approval sealed and applies nothing. The commit after it is
  # judged by ledger, and the same unsigned approval lets canary/one apply.
  # BREAK: the switch goes out as two commits in one push, so the run of the
  # head already reads ledger at base and the unsigned approval applies wave 1.
  log() { echo "[smoke approval-at-base] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approval-at-base" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approval-at-base gated-waves sealed || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approval-at-base: first, sealed")"
  wait_run "$repo" "$sha"
  gated_approve approval-at-base 1 unlisted || rc=1
  if [ $rc = 0 ]; then
    sed -i.bak 's/^approval: sealed$/approval: ledger/' "$work/tree/terragucci.yml"
    rm -f "$work/tree/terragucci.yml.bak" "$work/tree/chant.workspace.json"
    if [ -n "${BREAK:-}" ]; then
      git -C "$work/tree" add -A
      git -C "$work/tree" -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q -m "approval-at-base: switch to ledger"
    fi
    sha="$(push_tree "$work/tree" "$repo" main "approval-at-base: switch to ledger")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied approval-at-base)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "the switch: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "the merge that switched to ledger applied on an unsigned approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "approval sealed (approval: sealed in the config at base)" <<<"$logs" || { log "the switch was not judged sealed at base"; rc=1; }
    grep -q "an approval does not count: the approval by smoke-approver is not signed" <<<"$logs" || { log "the run did not say the unsigned approval does not count"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "approval-at-base: the next merge")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied approval-at-base)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "the next merge: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply once ledger held at base"; rc=1; }
    grep -q "approval ledger (approval: ledger in the config at base)" <<<"$logs" || { log "the next merge did not read ledger at base"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the switch to ledger was judged sealed and applied nothing; the next merge read ledger and applied wave 1"
  return $rc
}

claim_sealed_migrate() {
  # A repo set up before the approval key: init lists the wave gates under
  # identity.gates, and terragucci.yml names no approval mode. Wave 1 waits;
  # an unsigned approval of its plan is written and pushed on: nothing
  # applies, the run says approval sealed from identity.gates with a note, and
  # config check says the same. A sealed approval then lets canary/one apply.
  # BREAK: chant.workspace.json is dropped too, so approval is ledger and the
  # unsigned approval applies wave 1.
  log() { echo "[smoke sealed-migrate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/sealed-migrate" sha applied logs checked rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo sealed-migrate gated-waves sealed || { drop_work "$work"; return 1; }
  sed -i.bak '/^approval:/d' "$work/tree/terragucci.yml"
  rm -f "$work/tree/terragucci.yml.bak"
  [ -n "${BREAK:-}" ] && rm -f "$work/tree/chant.workspace.json"
  sha="$(push_tree "$work/tree" "$repo" main "sealed-migrate: first")"
  wait_run "$repo" "$sha"
  gated_forge sealed-migrate 1 unsealed || rc=1
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "sealed-migrate: after an unsigned approval")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied sealed-migrate)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the unsigned approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied on an unsigned approval in a repo whose gates are declared"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "approval sealed (identity.gates in chant.workspace.json at base, with no approval key)" <<<"$logs" || { log "the run did not say sealed from identity.gates"; rc=1; }
    grep -q "note: set approval: sealed in terragucci.yml" <<<"$logs" || { log "the run gave no note on choosing a mode"; rc=1; }
    checked="$(cd "$work/tree" && "$TERRAGUCCI" config check 2>&1)" || true
    log "config check: $checked"
    grep -q "approval: sealed (identity.gates in chant.workspace.json here, with no approval key)" <<<"$checked" || { log "config check did not report sealed from identity.gates"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve sealed-migrate 1 sign || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "sealed-migrate: after a sealed approval")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied sealed-migrate)"
    log "after the sealed approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the sealed approval"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "with gates declared and no key, the unsigned approval counted for nothing and the sealed one let wave 1 apply"
  return $rc
}

claim_estate() {
  # Three projects copy their reports to one bucket prefix: a plan, a drift
  # check that finds a queue deleted outside OpenTofu, and a gated tf-apply wave
  # that waits for an approval. `terragucci estate` then reads the indexes and
  # writes estate.json and estate.html to the prefix, with a presigned link:
  # three projects, the waiting wave and the drift are on the page.
  # BREAK: the wave runs with --gate never, so no wave waits and the page shows none.
  log() { echo "[smoke estate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" gate=always code=0 rc=0 prefix queue url out page name
  [ -n "${BREAK:-}" ] && gate=never
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  prefix="estate-$(date +%s)"   # a fresh prefix, so the page lists only these three
  queue="estate-smoke-$(date +%s)"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  # Each project is a repo whose directory name is its project name (no remote names it).
  for name in estate-plan estate-drift estate-wave; do
    mkdir -p "$work/$name"
    printf 'reports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/$name/terragucci.yml"
  done
  mkdir -p "$work/estate-plan/app" "$work/estate-wave/gate" "$work/estate-drift/queue"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "estate-plan"\n}\n' > "$work/estate-plan/app/main.tf"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "gate" {\n  input = "estate-wave"\n}\n' > "$work/estate-wave/gate/main.tf"
  cat > "$work/estate-drift/queue/main.tf" <<HCL
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "local" {}
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_sqs_queue" "jobs" {
  name = "$queue"
}
HCL
  # The example's lock pins the provider the job cache already holds.
  cp "$EXAMPLE/envs/dev/platform/.terraform.lock.hcl" "$work/estate-drift/queue/"
  for name in estate-plan estate-drift estate-wave; do
    git -C "$work/$name" init -q -b main
    git -C "$work/$name" add -A && git -C "$work/$name" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke estate $name"
  done
  git init -q --bare "$work/origin.git"
  git -C "$work/estate-wave" remote add origin /origin.git
  in_image() { # project dir, then the command
    local dir="$1"; shift
    run_copied --rm --network terragucci -v "$work/$dir:/projects/$dir" -v "$work/origin.git:/origin.git" -w "/projects/$dir" \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" "$@"
  }
  in_image estate-plan terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/estate-plan" "$image"
  if [ $rc = 0 ]; then
    in_image estate-drift sh -c 'cd queue && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color' >&2 || { log "the drift project did not apply"; rc=1; }
    clean_mounted "$work/estate-drift" "$image"
  fi
  if [ $rc = 0 ]; then
    sqs() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: AmazonSQS.$1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }
    url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
    [ -n "$url" ] && sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null || { log "could not delete $queue from floci"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    in_image estate-drift terragucci stage tf-drift --layers queue >&2 || true
    clean_mounted "$work/estate-drift" "$image"
    jq -e '[.roots[] | select(.changes | length > 0)] | length >= 1' "$work/estate-drift/terragucci-report/report.json" >/dev/null 2>&1 || { log "the drift check found no drift"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    in_image estate-wave terragucci stage tf-apply --wave 1 --layers gate --binary tofu --gate "$gate" >&2 || code=$?
    clean_mounted "$work/estate-wave" "$image"
    log "the wave exited $code"
  fi
  if [ $rc = 0 ]; then
    mkdir -p "$work/estate-page"
    out="$(run_copied --rm --network terragucci -v "$work/estate-page:/page" -w /page -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
      "$image" terragucci estate --bucket "s3://$REPORT_BUCKET" --bucket-endpoint http://floci:4566 --bucket-prefix "$prefix" --link-hours 1)" || { log "terragucci estate failed"; rc=1; }
    printf '%s\n' "$out" >&2
  fi
  if [ $rc = 0 ]; then
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -r '[.projects[].project] | join(",")' <<<"$page")" = "estate-drift,estate-plan,estate-wave" ] || { log "the page lists $(jq -c '[.projects[].project]' <<<"$page"), not the three projects"; rc=1; }
    [ "$(jq -r '[.projects[].waiting[] | "\(.project) wave \(.wave)"] | join(",")' <<<"$page")" = "estate-wave wave 1" ] || { log "the waiting waves are $(jq -c '[.projects[].waiting[]]' <<<"$page"), not estate-wave wave 1"; rc=1; }
    [ "$(jq -r '[.projects[] | select(.drifted > 0) | .project] | join(",")' <<<"$page")" = "estate-drift" ] || { log "the drifted projects are $(jq -c '[.projects[] | select(.drifted > 0) | .project]' <<<"$page"), not estate-drift"; rc=1; }
    curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html" | grep -q '<b>1</b><span>wave waiting</span>' || { log "estate.html does not show one wave waiting"; rc=1; }
    grep -Eq "X-Amz-Signature=[0-9a-f]{64}" <<<"$out" || { log "the command printed no presigned link"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "three projects on one page, estate-wave wave 1 waiting and estate-drift drifted, with a presigned link"
  return $rc
}

# ── approval: pr-review ───────────────────────────────────────────────────
# Each claim: the gated fixture with approval: pr-review on main (wave 1,
# canary/one, waits: no pull request made that push), a reviewer with write
# access (pr_reviewer), and a pull request that changes canary/one.

review_pr() { # name, [reviewer permission] -> REVIEW_PR and REVIEW_HEAD, the pull request open from branch change and planned
  gated_repo "$1" gated-waves pr-review || return 1
  local sha
  sha="$(push_tree "$work/tree" "$USER/$1" main "$1: first")"
  wait_run "$USER/$1" "$sha" || return 1
  pr_reviewer "$USER/$1" "reviewer-$1" || return 1
  [ -z "${2:-}" ] || api -o /dev/null -H 'content-type: application/json' -X PUT -d "{\"permission\":\"$2\"}" "$URL/api/v1/repos/$USER/$1/collaborators/reviewer-$1" || return 1
  echo 2 > "$work/tree/canary/one/rev.txt"
  REVIEW_HEAD="$(push_tree "$work/tree" "$USER/$1" change "$1: change canary/one")" || return 1
  REVIEW_PR="$(pr_open "$USER/$1" change "$1: change canary/one")" || return 1
  wait_run "$USER/$1" "$REVIEW_HEAD" pull_request || return 1
}

review_approve() { # name, sha -> the reviewer approves the pull request on sha
  curl -fsS -o /dev/null -H "Authorization: token $PR_REVIEWER_TOKEN" -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg c "$2" '{event: "APPROVED", body: "read the plans", commit_id: $c}')" "$URL/api/v1/repos/$USER/$1/pulls/$REVIEW_PR/reviews" || { log "the reviewer could not approve pull request $REVIEW_PR"; return 1; }
}

review_merge() { # name -> REVIEW_MERGE, the merge commit, once its run ended
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$USER/$1/pulls/$REVIEW_PR/merge" || { log "pull request $REVIEW_PR did not merge"; return 1; }
  REVIEW_MERGE="$(api "$URL/api/v1/repos/$USER/$1/pulls/$REVIEW_PR" | jq -r '.merge_commit_sha // empty')"
  [ -n "$REVIEW_MERGE" ] || { log "pull request $REVIEW_PR has no merge commit"; return 1; }
  wait_run "$USER/$1" "$REVIEW_MERGE" push
}

approval_status() { # name, sha -> the state and description of terragucci/approval on sha
  api "$URL/api/v1/repos/$USER/$1/commits/$2/statuses?limit=50" | jq -r '[.[] | select(.context == "terragucci/approval")] | sort_by(.id) | last | if . == null then "" else .status + ":" + .description end'
}

claim_pr_review() {
  # The reviewer approves the pull request on its head and it merges. Wave 1
  # plans the merge commit, finds the digest the plan note recorded for that
  # head, records the approval on chant/lifecycle with via pr-review, and
  # canary/one applies with no chant approve. Wave 2 (fleet/*), which the pull
  # request did not reach, waits at its own gate.
  # BREAK: a second push to the pull request lands after the review, so the
  # review names an older head and counts for nothing.
  log() { echo "[smoke pr-review] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-review" applied logs ledger rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  review_pr pr-review || { drop_work "$work"; return 1; }
  review_approve pr-review "$REVIEW_HEAD" || rc=1
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    echo after > "$work/tree/fleet/two/rev.txt"
    REVIEW_HEAD="$(push_tree "$work/tree" "$repo" change "pr-review: a push after the review")"
    wait_run "$repo" "$REVIEW_HEAD" pull_request || rc=1
  fi
  [ $rc = 0 ] && { review_merge pr-review || rc=1; }
  if [ $rc = 0 ]; then
    applied="$(gated_applied pr-review)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the merge: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one alone to apply on the review"; rc=1; }
    grep -q "pull request $REVIEW_PR was approved on its head ${REVIEW_HEAD:0:8} by reviewer-pr-review" <<<"$logs" || { log "wave 1 did not say the review approved it"; rc=1; }
    grep -q "chant approve tf-apply wave-2 --plan" <<<"$logs" || { log "wave 2 did not wait at its own gate"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    ledger="$(git clone -q -b chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/ledger" && cat "$work/ledger/_gates/tf-apply.jsonl")"
    jq -se --argjson pr "$REVIEW_PR" --arg h "$REVIEW_HEAD" 'map(select(.via == "pr-review" and .gate == "wave-1" and .pr == $pr and .head == $h and .reviewers == ["reviewer-pr-review"])) | length == 1' <<<"$ledger" >/dev/null \
      || { log "the ledger has no via pr-review resolution for wave 1 naming the pull request, its head and the reviewer"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/reviewer-pr-review?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the review of the head applied wave 1, recorded as via pr-review, and wave 2 waited"
  return $rc
}

claim_pr_review_moved() {
  # The reviewer approves the head. Before the merge, a commit on main adds a
  # resource to canary/one, so the merge commit plans a change the review
  # never saw: wave 1 applies nothing, exits 4, says the plans changed since
  # the review and prints the chant approve command for its new digest.
  # BREAK: nothing lands on main in between, so the merge plans what the
  # review saw and canary/one applies.
  log() { echo "[smoke pr-review-moved] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-review-moved" applied logs sha extra rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  review_pr pr-review-moved || { drop_work "$work"; return 1; }
  review_approve pr-review-moved "$REVIEW_HEAD" || rc=1
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    extra="$(printf 'resource "terraform_data" "extra" {\n  input = "after the review"\n}\n' | base64 | tr -d '\n')"
    sha="$(api -H 'content-type: application/json' -X POST -d "$(jq -cn --arg c "$extra" '{content: $c, branch: "main", message: "pr-review-moved: a change on main after the review"}')" "$URL/api/v1/repos/$repo/contents/canary/one/extra.tf" | jq -r '.commit.sha // empty')"
    [ -n "$sha" ] || { log "could not commit to main"; rc=1; }
    [ $rc = 0 ] && { wait_run "$repo" "$sha" push || rc=1; }
  fi
  [ $rc = 0 ] && { review_merge pr-review-moved || rc=1; }
  if [ $rc = 0 ]; then
    applied="$(gated_applied pr-review-moved)"
    logs="$(print_logs "$repo" "$RUN_ID")"
    log "after the merge: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied on a review of other plans"; rc=1; }
    grep -q "but the plans changed since that review, so nothing in it was applied" <<<"$logs" || { log "wave 1 did not say its plans changed since the review"; rc=1; }
    grep -Eq "chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+" <<<"$logs" || { log "wave 1 printed no chant approve command for its new digest"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/reviewer-pr-review-moved?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "plans that moved after the review applied nothing, and the wave printed the command for its new digest"
  return $rc
}

claim_pr_review_status() {
  # Once the pull request is planned, terragucci/approval on its head is
  # pending: wave 1 waits under gate always. The reviewer approves the head;
  # the approval job, started by the review, turns it to success naming the
  # reviewer.
  # BREAK: the reviewer has read access only, so Forgejo does not count the
  # review as official and the status stays pending.
  log() { echo "[smoke pr-review-status] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work st i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  review_pr pr-review-status "${BREAK:+read}" || { drop_work "$work"; return 1; }
  st="$(approval_status pr-review-status "$REVIEW_HEAD")"
  log "after the plan: terragucci/approval is ${st:-absent}"
  case "$st" in pending:*"wave 1"*"waits"*) ;; *) log "expected terragucci/approval pending, naming wave 1"; rc=1 ;; esac
  [ $rc = 0 ] && { review_approve pr-review-status "$REVIEW_HEAD" || rc=1; }
  if [ $rc = 0 ]; then
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      st="$(approval_status pr-review-status "$REVIEW_HEAD")"
      case "$st" in success:*) break ;; esac
      sleep 3
    done
    log "after the review: terragucci/approval is ${st:-absent}"
    case "$st" in success:*"by reviewer-pr-review-status"*) ;; *) log "expected terragucci/approval success, naming the reviewer"; rc=1 ;; esac
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/reviewer-pr-review-status?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "terragucci/approval was pending while wave 1 waited, and success once the reviewer approved the head"
  return $rc
}

# ── choudoufu estates: applies at once, settled by the record store ───────
# A choudoufu estate keeps no state file and takes no lock. Each resource has
# its own record in the estate's record store, and every record write is one
# conditional PutObject: If-None-Match: * to create, If-Match: <version> to
# update. cdf-concurrency and cdf-write-race run two tf-apply waves of
# one estate at once, from two checkouts, in the choudoufu CI image, against a
# record store bucket on floci. Their S3 traffic goes through
# stack/fixtures/cdf-race/s3-hold.mjs, which holds the record writes until
# both waves have reached theirs: two waves started together rarely overlap
# otherwise, since one writes before the other has read.

CDF_RECORDS=terragucci-smoke-records

# The record store bucket, with the three settings choudoufu asserts before an
# apply writes a record: versioning, a lifecycle rule that expires noncurrent
# versions, and all four public access blocks.
cdf_bucket() {
  local b="$CDF_RECORDS" ns='xmlns="http://s3.amazonaws.com/doc/2006-03-01/"' xml md5
  curl -s -o /dev/null -X PUT "$FLOCI/$b" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$b?versioning" -H 'content-type: application/xml' \
    --data-binary "<VersioningConfiguration $ns><Status>Enabled</Status></VersioningConfiguration>" || return 1
  xml="<LifecycleConfiguration $ns><Rule><ID>expire-noncurrent</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>"
  md5="$(printf '%s' "$xml" | openssl md5 -binary | base64)"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$b?lifecycle" -H 'content-type: application/xml' -H "Content-MD5: $md5" --data-binary "$xml" || return 1
  curl -fsS -o /dev/null -X PUT "$FLOCI/$b?publicAccessBlock" -H 'content-type: application/xml' \
    --data-binary "<PublicAccessBlockConfiguration $ns><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>" || return 1
}

# Start the proxy in a container of the choudoufu image (it has node), on the
# stack's network under a name of its own and <bucket>.<name>, the host
# choudoufu's record store sends the bucket's requests to. Sets CDF_PROXY
# (the container), CDF_ALIAS (its name) and CDF_CTL (its control URL on
# the host).
cdf_proxy_up() { # work
  local work="$1" port i
  CDF_ALIAS="tgs-records-$$-$RANDOM"
  mkdir -p "$work/proxy" && cp "$HERE/fixtures/cdf-race/s3-hold.mjs" "$work/proxy/" || return 1
  CDF_PROXY="$(run_copied -d --name "$CDF_ALIAS" --network terragucci "--network-alias=$CDF_RECORDS.$CDF_ALIAS" \
    -p 127.0.0.1::8080 -e "ALIAS=$CDF_ALIAS" -e UPSTREAM=floci:4566 -v "$work/proxy:/proxy:ro" \
    "$(image_tag choudoufu)" node /proxy/s3-hold.mjs)" || return 1
  port="$(docker port "$CDF_PROXY" 8080/tcp | head -1 | sed 's/.*://')"
  CDF_CTL="http://127.0.0.1:$port"
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "$CDF_CTL/held" 2>/dev/null && return 0
    sleep 1
  done
  echo "the record store proxy never answered on $CDF_CTL" >&2
  return 1
}

# A checkout of one estate: the root estate/ with one terraform_data per
# name=value, committed. CDF_BACKEND=tofu puts the same resources in one
# state file with use_lockfile instead, the way stock OpenTofu keeps an estate.
cdf_checkout() { # dir estate name=value...
  local dir="$1" estate="$2" kv
  shift 2
  mkdir -p "$dir/estate"
  {
    if [ "${CDF_BACKEND:-}" = tofu ]; then
      cat <<HCL
terraform {
  backend "s3" {
    bucket         = "$CDF_RECORDS"
    key            = "cdf-concurrency/$estate/terraform.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}
HCL
    else
      cat <<HCL
terraform {
  live {
    estate = "$estate"

    record_store "s3" {
      bucket = "$CDF_RECORDS"
    }

    retry {
      max_attempts = 1
    }
  }
}
HCL
    fi
    for kv in "$@"; do
      printf '\nresource "terraform_data" "%s" {\n  input = "%s"\n}\n' "${kv%%=*}" "${kv#*=}"
    done
  } >"$dir/estate/main.tf"
  printf '.terraform/\n.terraform.lock.hcl\n.tofu-records/\nterragucci-report/\n' >"$dir/.gitignore"
  [ -d "$dir/.git" ] || git -C "$dir" init -q -b main
  git -C "$dir" add -A && git -C "$dir" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke estate $(date +%s%N)"
}

# One stage run in a checkout, in the CI image of BIN (choudoufu or tofu),
# with its S3 calls sent to the proxy, as the container NAME. OVERRIDE, when
# not empty, is a Linux build mounted over the image's binary. The run's
# output goes to LOG.
cdf_run() { # dir log name bin override stage-args...
  local dir="$1" logf="$2" name="$3" bin="$4" over="$5" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" rc=0
  local -a mount=()
  shift 5
  [ -n "$over" ] && mount=(-v "$over:/usr/local/bin/$bin:ro")
  run_copied --rm --name "$name" --network terragucci -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" ${mount[@]+"${mount[@]}"} \
    -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag "$bin")" terragucci stage "$@" >"$logf" 2>&1 || rc=$?
  clean_mounted "$dir"
  return $rc
}

# The values an estate holds now, as the store keeps them: the tokens
# (left-N, right-N, seed, from-a, from-b) found in its records, or in its
# state file for CDF_BACKEND=tofu, sorted and joined by spaces.
cdf_values() { # estate
  local estate="$1" k
  {
    for k in $(curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=tofu-records/$estate/terraform_data/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
      curl -fsS "$FLOCI/$CDF_RECORDS/$(jq -rn --arg k "$k" '$k | split("/") | map(@uri) | join("/")')" || true
    done
    curl -fsS "$FLOCI/$CDF_RECORDS/cdf-concurrency/$estate/terraform.tfstate" 2>/dev/null || true
  } | grep -oE '(left|right)-[0-9]|seed|from-[ab]' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# The record keys an estate has, one per line.
cdf_keys() { # estate
  curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=tofu-records/$1/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
}

# Start a tf-apply wave in each of the checkouts $work/a and $work/b at once,
# in the background, their exit codes landing in $work/a.rc and $work/b.rc,
# and wait up to three minutes for the proxy to hold two writes (or for both
# waves to end). Sets CDF_HELD to how many writes it holds.
CDF_HELD=0
CDF_PIDS=()
cdf_race() { # work bin override
  local work="$1" bin="$2" over="$3" side i n=0
  CDF_PIDS=()
  for side in a b; do
    ( cdf_run "$work/$side" "$work/$side.log" "$CDF_ALIAS-$side" "$bin" "$over" tf-apply --wave 1 --layers estate --binary "$bin" --gate never \
        && echo 0 >"$work/$side.rc" || echo $? >"$work/$side.rc" ) >/dev/null 2>&1 &
    CDF_PIDS+=($!)
  done
  for i in $(seq 1 180); do
    n="$(curl -fsS "$CDF_CTL/held" 2>/dev/null | jq length 2>/dev/null || true)"
    n="${n:-0}"
    [ "$n" -ge 2 ] && break
    [ -s "$work/a.rc" ] && [ -s "$work/b.rc" ] && break
    sleep 1
  done
  CDF_HELD="$n"
}

# Wait up to five minutes for both waves of cdf_race to end; stop any that is still running.
cdf_race_end() { # work
  local work="$1" i side
  for i in $(seq 1 300); do
    [ -s "$work/a.rc" ] && [ -s "$work/b.rc" ] && break
    sleep 1
  done
  for side in a b; do
    [ -s "$work/$side.rc" ] || { docker rm -f "$CDF_ALIAS-$side" >/dev/null 2>&1 || true; echo 124 >"$work/$side.rc"; }
  done
  for i in ${CDF_PIDS[@]+"${CDF_PIDS[@]}"}; do wait "$i" 2>/dev/null || true; done
  CDF_PIDS=()
}

cdf_down() { # work
  [ -n "${CDF_PROXY:-}" ] && { docker rm -f "$CDF_PROXY" >/dev/null 2>&1 || true; }
  CDF_PROXY=""
  drop_work "$1"
}

# Hold the PUTs whose path matches the regex, naming each by the first of the
# comma-separated markers its body carries.
cdf_hold() { # regex markers
  curl -fsS -o /dev/null -X POST -G "$CDF_CTL/hold" --data-urlencode "re=$1" --data-urlencode "markers=$2"
}

flat_log() { tr '\n' ' ' <"$1" | sed 's/│/ /g' | tr -s ' '; }

claim_cdf_concurrency() {
  # Two tf-apply waves of one choudoufu estate run at once from two checkouts
  # that differ from the estate in one resource each: a changes
  # terraform_data.left to left-1, b changes terraform_data.right to right-2.
  # The proxy holds each record write until both waves have reached theirs, so
  # each wave planned and applied while the other was in flight, then lets them
  # through in turn. Both waves must apply, the records hold left-1 and
  # right-2, both writes carry If-Match, neither report lists a lock wait, and
  # nothing lock-shaped is in the bucket.
  # BREAK: the same two waves in stock OpenTofu, with the estate in one state
  # file under use_lockfile. The first wave holds the estate lock while its
  # state write is held, so the second waits for the lock and never reaches
  # its write: only one write is in flight.
  log() { echo "[smoke cdf-concurrency] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work estate bin=choudoufu backend="" re held rc=0 values got side n
  [ -n "${BREAK:-}" ] && { bin=tofu; backend=tofu; }
  docker image inspect "$(image_tag "$bin")" >/dev/null 2>&1 || { log "no CI image $(image_tag "$bin"); run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  estate="smoke-concurrency-$(date +%s)-$$"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  CDF_BACKEND="$backend" cdf_checkout "$work/a" "$estate" left=left-0 right=right-0
  CDF_BACKEND="$backend" cdf_checkout "$work/b" "$estate" left=left-0 right=right-0
  if ! cdf_run "$work/a" "$work/seed.log" "$CDF_ALIAS-seed" "$bin" "" tf-apply --wave 1 --layers estate --binary "$bin" --gate never; then
    log "the first apply of the estate failed"; tail -20 "$work/seed.log" >&2; cdf_down "$work"; return 1
  fi
  values="$(cdf_values "$estate")"
  [ "$values" = "left-0 right-0" ] || { log "after the first apply the estate holds '$values', not left-0 and right-0"; cdf_down "$work"; return 1; }
  CDF_BACKEND="$backend" cdf_checkout "$work/a" "$estate" left=left-1 right=right-0
  CDF_BACKEND="$backend" cdf_checkout "$work/b" "$estate" left=left-0 right=right-2
  if [ "$bin" = tofu ]; then re="^/$CDF_RECORDS/cdf-concurrency/$estate/terraform\\.tfstate\$"; else re="^/$CDF_RECORDS/tofu-records/$estate/terraform_data/"; fi
  cdf_hold "$re" left-1,right-2 || { log "the proxy did not take the hold"; cdf_down "$work"; return 1; }
  cdf_race "$work" "$bin" ""; held="$CDF_HELD"
  log "writes held while both waves ran: $(curl -fsS "$CDF_CTL/held" | jq -c '[.[] | {seq, marker, record: (.path | split("?")[0] | split("/") | last | @base64d)}]')"
  if [ "$held" -lt 2 ]; then
    log "only $held of the two waves reached its write while the other was in flight: one waited for the other"
    for side in a b; do grep -iE 'lock' "$work/$side.log" | head -3 | sed "s/^/[$side] /" >&2 || true; done
    rc=1
    curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
    for side in a b; do docker rm -f "$CDF_ALIAS-$side" >/dev/null 2>&1 || true; done
    cdf_race_end "$work"
    cdf_down "$work"
    return $rc
  fi
  curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=1,2" || { log "the proxy did not release the writes"; rc=1; }
  curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
  cdf_race_end "$work"
  curl -fsS "$CDF_CTL/log" | grep "^PUT /$CDF_RECORDS/tofu-records/$estate/terraform_data/" | while read -r m p st c; do echo "[proxy] $m $(basename "$p" | base64 -d 2>/dev/null) $st $c"; done >&2 || true
  for side in a b; do
    [ "$(cat "$work/$side.rc")" = 0 ] || { log "the wave in checkout $side did not apply (exit $(cat "$work/$side.rc"))"; tail -20 "$work/$side.log" >&2; rc=1; }
  done
  values="$(cdf_values "$estate")"
  [ "$values" = "left-1 right-2" ] || { log "the estate holds '$values', not left-1 and right-2"; rc=1; }
  curl -fsS "$CDF_CTL/log" >"$work/proxy.log" || true
  n="$(grep -cE "^PUT /$CDF_RECORDS/tofu-records/$estate/terraform_data/[^ ]* 200 if-match:" "$work/proxy.log" || true)"
  [ "$n" -ge 2 ] || { log "$n record update(s) landed with If-Match, not 2"; rc=1; }
  ! grep -qE "^PUT /$CDF_RECORDS/tofu-records/$estate/[^ ]* [0-9]+ no-precondition" "$work/proxy.log" || { log "a record write carried no condition"; rc=1; }
  for side in a b; do
    got="$(jq '[.roots[]?.timings.lock_waits[]?] | length' "$work/$side/terragucci-report/report.json" 2>/dev/null || echo missing)"
    [ "$got" = 0 ] || { log "the report of checkout $side lists lock waits: $got"; rc=1; }
  done
  got="$(cdf_keys "$estate" | grep -iE 'lock' || true)"
  [ -z "$got" ] || { log "a lock-shaped object is in the bucket: $got"; rc=1; }
  cdf_down "$work"
  [ $rc = 0 ] && log "both waves held their record writes at once and both applied: the estate holds $values, each write carried If-Match, and neither wave waited on a lock"
  return $rc
}

# A choudoufu whose record update carries no If-Match, for cdf-write-race's
# BREAK: the source of CHOUDOUFU_BREAK_REF (default v0.22.0, the release the
# choudoufu image runs) in the checkout at CHOUDOUFU_DIR, with the line of
# S3Store.PutIfVersion that sets the condition replaced. Built for Linux the
# way choudoufu_linux builds, and kept under .state/choudoufu.
choudoufu_no_if_match() {
  local dir="${CHOUDOUFU_DIR:-$HOME/Documents/checkouts/intentius/choudoufu}" ref="${CHOUDOUFU_BREAK_REF:-v0.22.0}" sha arch out src go
  local file=internal/live/staterecord/s3.go cut='s/input\.IfMatch = aws\.String(expectedVersion)/_ = expectedVersion \/\/ smoke BREAK: an update with no precondition/'
  sha="$(git -C "$dir" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || { echo "no choudoufu checkout at $dir with $ref; set CHOUDOUFU_DIR" >&2; return 1; }
  [ "$(git -C "$dir" show "$sha:$file" | grep -c 'input\.IfMatch = aws\.String(expectedVersion)')" = 1 ] \
    || { echo "$file at ${sha:0:10} does not set input.IfMatch on one line, so the BREAK build would not change it" >&2; return 1; }
  arch="$(docker version -f '{{.Server.Arch}}' 2>/dev/null)"; [ -n "$arch" ] || arch=amd64
  out="$HERE/.state/choudoufu/$sha-$arch-no-if-match/choudoufu"
  [ -x "$out" ] && { echo "$out"; return 0; }
  mkdir -p "$(dirname "$out")"
  echo "building choudoufu ${sha:0:10} for linux/$arch with no If-Match on a record update" >&2
  if command -v go >/dev/null 2>&1; then
    src="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-choudoufu.XXXXXX")"
    git -C "$dir" archive "$sha" | tar -x -C "$src" || { rm -rf "$src"; return 1; }
    sed -e "$cut" "$src/$file" >"$src/$file.new" && mv "$src/$file.new" "$src/$file"
    ! grep -q 'input\.IfMatch' "$src/$file" || { rm -rf "$src"; echo "the If-Match line is still in $file" >&2; return 1; }
    (cd "$src" && GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -o "$out" ./cmd/choudoufu) >&2 || { rm -rf "$src"; return 1; }
    rm -rf "$src"
  else
    go="$(git -C "$dir" show "$sha:go.mod" | sed -n 's/^go \([0-9.]*\)$/\1/p')"
    git -C "$dir" archive "$sha" | docker run -i --rm -v "$(dirname "$out"):/out" -v terragucci-go-cache:/root/go \
      -e GOOS=linux -e GOARCH="$arch" -e CGO_ENABLED=0 -e "CUT=$cut" -e "FILE=$file" "golang:${go:-1}" \
      sh -c 'mkdir -p /src && tar -x -C /src && cd /src && sed -i -e "$CUT" "$FILE" && ! grep -q "input\.IfMatch" "$FILE" && go build -o /out/choudoufu ./cmd/choudoufu' >&2 || return 1
  fi
  echo "$out"
}

claim_cdf_write_race() {
  # Two tf-apply waves of one choudoufu estate change terraform_data.shared at
  # once, from two checkouts: a to from-a, b to from-b. The proxy holds both
  # record writes until both are in flight, then lets the first to arrive
  # through and the second after it. The first must land. The second must fail
  # its If-Match: its wave fails, naming a record store write conflict for
  # terraform_data.shared and saying nothing was overwritten. Nothing is half
  # written: the estate holds one record, with the value that landed, tagged
  # with the estate and terraform_data.shared. tf-plan in the losing checkout
  # then shows input changing from the value that landed to its own.
  # BREAK: both waves run a choudoufu built with no If-Match on a record
  # update (choudoufu_no_if_match), so both writes land and both waves apply.
  log() { echo "[smoke cdf-write-race] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work estate over="" first winner loser held rc=0 values keys key tags text side got
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then over="$(choudoufu_no_if_match)" || { log "no choudoufu built without If-Match"; return 1; }; fi
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  estate="smoke-race-$(date +%s)-$$"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  cdf_checkout "$work/a" "$estate" shared=seed
  cdf_checkout "$work/b" "$estate" shared=seed
  if ! cdf_run "$work/a" "$work/seed.log" "$CDF_ALIAS-seed" choudoufu "$over" tf-apply --wave 1 --layers estate --binary choudoufu --gate never; then
    log "the first apply of the estate failed"; tail -20 "$work/seed.log" >&2; cdf_down "$work"; return 1
  fi
  values="$(cdf_values "$estate")"
  [ "$values" = seed ] || { log "after the first apply the estate holds '$values', not seed"; cdf_down "$work"; return 1; }
  cdf_checkout "$work/a" "$estate" shared=from-a
  cdf_checkout "$work/b" "$estate" shared=from-b
  cdf_hold "^/$CDF_RECORDS/tofu-records/$estate/terraform_data/" from-a,from-b || { log "the proxy did not take the hold"; cdf_down "$work"; return 1; }
  cdf_race "$work" choudoufu "$over"; held="$CDF_HELD"
  if [ "$held" -lt 2 ]; then
    log "only $held of the two writes reached the store while the other was in flight, so there was no race to judge"
    for side in a b; do tail -5 "$work/$side.log" | sed "s/^/[$side] /" >&2; done
    curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
    cdf_race_end "$work"; cdf_down "$work"
    return 1
  fi
  first="$(curl -fsS "$CDF_CTL/held" | jq -r '.[] | select(.seq == 1) | .marker')"
  curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=1,2" || { log "the proxy did not release the writes"; rc=1; }
  cdf_race_end "$work"
  curl -fsS "$CDF_CTL/log" >"$work/proxy.log" || true
  grep -E "^PUT /$CDF_RECORDS/tofu-records/$estate/terraform_data/" "$work/proxy.log" | tail -2 | sed 's/^/[proxy] /' >&2 || true
  if [ "$(cat "$work/a.rc")" = 0 ] && [ "$(cat "$work/b.rc")" = 0 ]; then
    log "both waves applied over one record: the second write replaced the first, and the estate holds '$(cdf_values "$estate")'"
    cdf_down "$work"; return 1
  fi
  if [ "$(cat "$work/a.rc")" != 0 ] && [ "$(cat "$work/b.rc")" != 0 ]; then
    log "both waves failed; one write should have landed"
    for side in a b; do tail -10 "$work/$side.log" | sed "s/^/[$side] /" >&2; done
    cdf_down "$work"; return 1
  fi
  if [ "$(cat "$work/a.rc")" = 0 ]; then winner=a; loser=b; else winner=b; loser=a; fi
  [ "from-$winner" = "$first" ] || { log "the write released first carried $first, but the wave in checkout $winner applied"; rc=1; }
  text="$(flat_log "$work/$loser.log")"
  grep -q 'Record store write conflict' <<<"$text" || { log "the wave in checkout $loser failed without naming a record store write conflict"; tail -20 "$work/$loser.log" >&2; rc=1; }
  grep -q 'persisted record for terraform_data.shared' <<<"$text" || { log "the conflict does not name terraform_data.shared"; rc=1; }
  grep -q 'Nothing was overwritten' <<<"$text" || { log "the conflict does not say nothing was overwritten"; rc=1; }
  values="$(cdf_values "$estate")"
  [ "$values" = "from-$winner" ] || { log "the estate holds '$values', not from-$winner"; rc=1; }
  keys="$(cdf_keys "$estate" | grep '/terraform_data/' || true)"
  [ "$(grep -c . <<<"$keys")" = 1 ] || { log "the estate has $(grep -c . <<<"$keys") terraform_data records, not one: $keys"; rc=1; }
  key="$(head -1 <<<"$keys")"
  tags="$(curl -fsS "$FLOCI/$CDF_RECORDS/$(jq -rn --arg k "$key" '$k | split("/") | map(@uri) | join("/")')?tagging" | tr -d '\n\t ' || true)"
  grep -qF "<Key>tofu-estate</Key><Value>$estate</Value>" <<<"$tags" || { log "the record is not tagged tofu-estate=$estate: $tags"; rc=1; }
  grep -qF "<Key>tofu-address</Key><Value>terraform_data.shared</Value>" <<<"$tags" || { log "the record is not tagged tofu-address=terraform_data.shared: $tags"; rc=1; }
  curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
  if [ $rc = 0 ]; then
    # --layers names the root: it has no backend and no provider block, which is what tf-plan finds roots by.
    if ! cdf_run "$work/$loser" "$work/replan.log" "$CDF_ALIAS-replan" choudoufu "" tf-plan --layers estate --binary choudoufu; then
      log "tf-plan in checkout $loser failed"; tail -20 "$work/replan.log" >&2; rc=1
    else
      got="$(jq -r '[.roots[] | select(.path == "estate") | .changes[] | select(.address == "terraform_data.shared") | .attributes[] | select(.path == "input") | "\(.before) \(.after)"][0] // "none"' "$work/$loser/terragucci-report/report.json" 2>/dev/null || echo none)"
      [ "$got" = "from-$winner from-$loser" ] || { log "the re-plan in checkout $loser shows input as '$got', not from-$winner to from-$loser"; rc=1; }
    fi
  fi
  cdf_down "$work"
  [ $rc = 0 ] && log "from-$winner landed; the wave in checkout $loser failed its If-Match on terraform_data.shared and overwrote nothing, the one record holds from-$winner under the estate and address tags, and the re-plan shows from-$winner to from-$loser"
  return $rc
}

claim_cdf_iam() {
  # Two choudoufu estates, terragucci-smoke-iam-a and -b, of one EC2 instance
  # each (stack/fixtures/cdf-iam), on a floci of the claim's own with IAM
  # enforcement on; the stack's floci runs with it off, and floci lets the
  # test key through either way. Both are applied with the test key. A role
  # is then granted estate a by its ownership tag, the grant choudoufu's
  # live/MARKERS.md publishes: reads, and CreateTags, DeleteTags and
  # TerminateInstances only where aws:ResourceTag/tofu-estate names estate a.
  # Each Name tag changes, and tf-apply runs as the role: estate a must apply
  # and its tag change; estate b must fail its apply on a CreateTags floci
  # refuses, with its tag unchanged.
  # EC2 and not S3: floci evaluates aws:ResourceTag on EC2 tag writes, while
  # the AWS provider reads and writes an S3 bucket tags through S3 Control,
  # which floci authorizes with no tag condition.
  # BREAK: the role gets the same reach with no condition, so estate b applies.
  log() { echo "[smoke cdf-iam] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image fimg name="terragucci-smoke-floci-iam" url port i rc=0 role=terragucci-smoke-estate-a creds ak sk st policy trust f text
  local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  image="$(image_tag choudoufu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just images' first"; return 1; }
  build_cli || return 1
  fimg="$(awk '/^  floci:/ { f = 1 } f && /image:/ { print $2; exit }' "$HERE/docker-compose.yml")"
  [ -n "$fimg" ] || { log "no floci image in docker-compose.yml"; return 1; }
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label "terragucci.run-copied=$$" --network terragucci -p 127.0.0.1::4566 \
    -e FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true "$fimg" >/dev/null || { log "could not start floci with IAM enforcement"; return 1; }
  port="$(docker port "$name" 4566/tcp | head -1 | sed 's/.*://')"
  url="http://127.0.0.1:$port"
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null)" != 000 ] && break
    sleep 1
  done
  aws_query() { # service version action [curl args...]: a signed query call as the test key
    local svc="$1" ver="$2" act="$3"
    shift 3
    curl -sS --aws-sigv4 "aws:amz:us-east-1:$svc" --user test:test -X POST "$url/" -H 'content-type: application/x-www-form-urlencoded' \
      --data-urlencode "Action=$act" --data-urlencode "Version=$ver" "$@"
  }
  # The Name tag of the instance whose tofu-estate tag names the estate, read with the test key.
  name_of() { # estate
    aws_query ec2 2016-11-15 DescribeInstances --data-urlencode "Filter.1.Name=tag:tofu-estate" --data-urlencode "Filter.1.Value.1=$1" \
      | tr -d '\n\t ' | grep -o '<key>Name</key><value>[^<]*</value>' | head -1 | sed -e 's#.*<value>##' -e 's#</value>##'
  }
  iam_wave() { # log layers [docker run args...]: tf-apply wave 1 of those roots of $work/repo on this floci
    local logf="$1" layers="$2" r=0
    shift 2
    run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      -e "AWS_ENDPOINT_URL=http://$name:4566" -e AWS_REGION=us-east-1 "$@" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage tf-apply --wave 1 --layers "$layers" --binary choudoufu --gate never >"$logf" 2>&1 || r=$?
    clean_mounted "$work/repo"
    return $r
  }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo"
  cp -R "$HERE/fixtures/cdf-iam/." "$work/repo/"
  printf '.terraform/\n.terraform.lock.hcl\n.tofu-records/\nterragucci-report/\n' >"$work/repo/.gitignore"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke cdf-iam $(date +%s%N)"
  if ! iam_wave "$work/setup.log" a,b -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test; then
    log "the test key could not apply the two estates"; tail -20 "$work/setup.log" >&2; rc=1
  elif [ "$(name_of terragucci-smoke-iam-a)" != a-1 ] || [ "$(name_of terragucci-smoke-iam-b)" != b-1 ]; then
    log "after the first apply the instances are named '$(name_of terragucci-smoke-iam-a)' and '$(name_of terragucci-smoke-iam-b)', not a-1 and b-1 under their estate tags"; rc=1
  fi
  if [ $rc = 0 ]; then
    trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}'
    policy='{"Version":"2012-10-17","Statement":[
 {"Sid":"ReadTheAccount","Effect":"Allow","Action":["ec2:Describe*","ec2:Get*","tag:GetResources","sts:GetCallerIdentity"],"Resource":"*"},
 {"Sid":"ActOnMyEstate","Effect":"Allow","Action":["ec2:CreateTags","ec2:DeleteTags","ec2:TerminateInstances"],"Resource":"*",
  "Condition":{"StringEquals":{"aws:ResourceTag/tofu-estate":"terragucci-smoke-iam-a"}}},
 {"Sid":"CreateIntoMyEstate","Effect":"Allow","Action":["ec2:RunInstances","ec2:CreateTags"],"Resource":"*",
  "Condition":{"StringEquals":{"aws:RequestTag/tofu-estate":"terragucci-smoke-iam-a"}}}]}'
    [ -n "${BREAK:-}" ] && policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ec2:*","tag:*","sts:GetCallerIdentity"],"Resource":"*"}]}'
    aws_query iam 2010-05-08 CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$trust" >/dev/null || true
    aws_query iam 2010-05-08 PutRolePolicy -f --data-urlencode "RoleName=$role" --data-urlencode PolicyName=estate --data-urlencode "PolicyDocument=$policy" >/dev/null \
      || { log "could not grant $role"; rc=1; }
    creds="$(aws_query sts 2011-06-15 AssumeRole --data-urlencode "RoleArn=arn:aws:iam::000000000000:role/$role" --data-urlencode RoleSessionName=estate-a | tr -d '\n\t ')"
    ak="$(sed -n 's#.*<AccessKeyId>\([^<]*\)</AccessKeyId>.*#\1#p' <<<"$creds")"
    sk="$(sed -n 's#.*<SecretAccessKey>\([^<]*\)</SecretAccessKey>.*#\1#p' <<<"$creds")"
    st="$(sed -n 's#.*<SessionToken>\([^<]*\)</SessionToken>.*#\1#p' <<<"$creds")"
    [ -n "$ak" ] && [ -n "$sk" ] || { log "could not assume $role: $creds"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    for f in a b; do
      sed "s/Name = \"$f-1\"/Name = \"$f-2\"/" "$work/repo/$f/main.tf" >"$work/main.tf" && mv "$work/main.tf" "$work/repo/$f/main.tf"
    done
    git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke cdf-iam rename $(date +%s%N)"
    if ! iam_wave "$work/a.log" a -e "AWS_ACCESS_KEY_ID=$ak" -e "AWS_SECRET_ACCESS_KEY=$sk" -e "AWS_SESSION_TOKEN=$st"; then
      log "the role scoped to estate a could not apply estate a"; tail -20 "$work/a.log" >&2; rc=1
    elif [ "$(name_of terragucci-smoke-iam-a)" != a-2 ]; then
      log "estate a applied but its instance is named '$(name_of terragucci-smoke-iam-a)', not a-2"; rc=1
    else
      log "the role scoped to estate a applied estate a: its instance is named a-2"
    fi
  fi
  if [ $rc = 0 ]; then
    if iam_wave "$work/b.log" b -e "AWS_ACCESS_KEY_ID=$ak" -e "AWS_SECRET_ACCESS_KEY=$sk" -e "AWS_SESSION_TOKEN=$st"; then
      log "the role scoped to estate a applied estate b: its instance is named '$(name_of terragucci-smoke-iam-b)'"; rc=1
    else
      text="$(sed -n '/^FAILED b$/,$p' "$work/b.log" | tr '\n' ' ' | tr -s ' ')"
      if ! grep -qE 'CreateTags.{0,200}(StatusCode: 403|UnauthorizedOperation|AccessDenied|not authorized)' <<<"$text"; then
        log "estate b failed, but not on a CreateTags that floci refused"; tail -20 "$work/b.log" >&2; rc=1
      elif [ "$(name_of terragucci-smoke-iam-b)" != b-1 ]; then
        log "estate b was refused but its instance is named '$(name_of terragucci-smoke-iam-b)', not b-1"; rc=1
      else
        log "refused on estate b: $(grep -oE 'CreateTags.{0,160}' <<<"$text" | head -1)"
      fi
    fi
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "a role granted estate a by its tofu-estate tag applied estate a, and floci refused its CreateTags on the instance of estate b, which kept its name"
  return $rc
}

claim_approve_command() {
  # The gated fixture, approval ledger (the default). A pull request changes
  # canary/one; its plan note gives wave 1 the command chant approve tf-apply
  # wave-1 --plan <digest>. Merged, wave 1 waits for that same digest. In a
  # clone, terragucci approve finds the waiting wave and approves its digest;
  # the next push applies canary/one.
  # BREAK: terragucci approve runs with --dry-run, so nothing is approved and
  # canary/one stays out.
  log() { echo "[smoke approve-command] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approve-command" sha head pr merge note noted waited out applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approve-command || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approve-command: first")"
  wait_run "$repo" "$sha" || rc=1
  echo 2 > "$work/tree/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "approve-command: change canary/one")"
  pr="$(pr_open "$repo" change "approve-command: change canary/one")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -r '[.[] | select(.body | contains("terragucci:waves"))] | last | .body // empty')"
    noted="$(grep -Eo 'chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' <<<"$note" | head -1)"
    log "the note gives: ${noted:-no command}"
    [ -n "$noted" ] || { log "the plan note gives no chant approve command for wave 1"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || rc=1
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    [ -n "$merge" ] || { log "pull request $pr has no merge commit"; rc=1; }
    [ $rc = 0 ] && { wait_run "$repo" "$merge" push || rc=1; }
  fi
  if [ $rc = 0 ]; then
    waited="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'chant approve tf-apply wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1)"
    log "the merge waits for: ${waited:-nothing}"
    [ "$waited" = "$noted" ] || { log "the merge's wave 1 asks for another digest than the note gave"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver ${BREAK:+--dry-run} 2>&1)" || { log "terragucci approve failed: $out"; rc=1; }
    log "terragucci approve: $(tr '\n' ' ' <<<"$out")"
    grep -qF -- "${noted#chant }" <<<"$out" || { log "terragucci approve did not approve the digest the note gave"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "approve-command: after terragucci approve")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied approve-command)"
    log "after terragucci approve: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply once terragucci approve approved wave 1"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the note gave the digest the merge asked for, and terragucci approve approved it with nothing copied"
  return $rc
}

# ── policy overrides ──────────────────────────────────────────────────────
# stack/fixtures/policy-wave with a bare repo for origin, the policy key
# listing smoke-approver under override, and gate: never, so only the policy
# holds the wave. The first run is denied (exit 1) and records the denial on
# chant/lifecycle; terragucci override, run on the host in a clone with chant
# from node_modules, writes the override as chant approve does.

policy_override_repo() { # work [override list] -> $work/wave committed, $work/origin.git
  local work="$1" listed="${2-}"
  cp -R "$HERE/fixtures/policy-wave/." "$work/wave/"
  printf 'policy:\n  engine: conftest\n  path: policy\n' >> "$work/wave/terragucci.yml"
  [ -n "$listed" ] && printf '  override: [%s]\n' "$listed" >> "$work/wave/terragucci.yml"
  git init -q --bare "$work/origin.git"
  git -C "$work/wave" init -q -b main
  git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke policy override"
  git -C "$work/wave" push -q "$work/origin.git" main
  git -C "$work/wave" remote add origin /origin.git
}

policy_override_wave() { # work image -> the exit code of one tf-apply wave 1
  local work="$1" image="$2" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" code=0
  run_copied --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >"$work/run.log" 2>&1 || code=$?
  cat "$work/run.log" >&2
  clean_mounted "$work/wave" "$image"
  echo "$code"
}

policy_override_write() { # work actor -> runs terragucci override for app with the rules the denial recorded
  local work="$1" actor="$2"
  local clone="$work/approver" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" rules out
  [ -d "$clone" ] || git clone -q "$work/origin.git" "$clone" || return 1
  git -C "$clone" config user.name "$actor"
  git -C "$clone" config user.email "$actor@terragucci.local"
  git -C "$clone" fetch -q origin chant/lifecycle || return 1
  rules="$(git -C "$clone" show origin/chant/lifecycle:_gates/policy-override.jsonl | jq -rs '[.[] | select(.kind == "pending" and .gate == "app")] | last | .rules // [] | join(",")')"
  [ -n "$rules" ] || { echo "the denial of app names no rule" >&2; return 1; }
  echo "[smoke policy-override] the denial names $rules" >&2
  out="$(cd "$clone" && PATH="$(dirname "$CHANT"):$PATH" node "$bundle" override app --rule "$rules" --reason "smoke: the probe goes out" --actor "$actor" 2>&1)" || { echo "terragucci override failed: $out" >&2; return 1; }
  echo "[smoke policy-override] terragucci override: $(tr '\n' ' ' <<<"$out")" >&2
}

policy_override_applied() { # work -> 0 when app has state with a resource
  [ -f "$1/wave/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$1/wave/app/terraform.tfstate" >/dev/null 2>&1
}

claim_policy_override() {
  # A denied wave records the denial; smoke-approver, whom policy.override at
  # base lists, overrides it with terragucci override; the next run applies
  # app, and its report names the override: who, the rules, the reason and
  # the plan digest.
  # BREAK: the config lists nobody under policy.override, so the wave records
  # no denial and nothing can be overridden.
  log() { echo "[smoke policy-override] $*" >&2; }
  local work image code rc=0 r q listed=smoke-approver
  [ -n "${BREAK:-}" ] && listed=""
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/wave"
  policy_override_repo "$work" "$listed"
  code="$(policy_override_wave "$work" "$image")"
  [ "$code" = 1 ] || { log "the first run exited $code, not 1: the policy did not deny the wave"; rc=1; }
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 0 ] || { log "the run after the override exited $code, not 0"; rc=1; }
    policy_override_applied "$work" || { log "app has no state: the override did not let it apply"; rc=1; }
    r="$work/wave/terragucci-report/report.json"
    q='.roots[] | select(.path == "app") | .policy'
    jq -e "$q | .result == \"denied\" and .override.by == \"smoke-approver\" and .override.reason == \"smoke: the probe goes out\" and (.override.rules | length > 0) and (.override.plan_digest | test(\"sha256:\"))" "$r" >/dev/null \
      || { log "the report does not name the override under app: $(jq -c "$q" "$r" 2>/dev/null)"; rc=1; }
    jq -e '.policy.overridden == ["app"]' "$r" >/dev/null || { log "the report policy does not list app as overridden"; rc=1; }
    grep -q "overridden by smoke-approver" "$work/wave/terragucci-report/note.md" || { log "the wave note does not name the override"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the denied wave applied once smoke-approver overrode its plan, and the report names who, the rules, the reason and the digest"
  return $rc
}

claim_policy_override_moved() {
  # smoke-approver overrides the denial of one plan; then a commit changes app,
  # so the wave plans another digest. The override counts for nothing: the
  # wave applies nothing, exits 4 and says the override names an earlier plan.
  # BREAK: no commit changes app, so the override still names its plan and
  # the wave applies.
  log() { echo "[smoke policy-override-moved] $*" >&2; }
  local work image code rc=0
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/wave"
  policy_override_repo "$work" smoke-approver
  code="$(policy_override_wave "$work" "$image")"
  [ "$code" = 1 ] || { log "the first run exited $code, not 1: the policy did not deny the wave"; rc=1; }
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {\n  input = "policy, moved"\n}\n' > "$work/wave/app/main.tf"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "smoke: app moves after its override" || rc=1
  fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 4 ] || { log "the run after the plan moved exited $code, not 4"; rc=1; }
    policy_override_applied "$work" && { log "app has state: an override of an earlier plan let it apply"; rc=1; }
    grep -q "overrode an earlier plan or other rules" "$work/run.log" || { log "the wave does not say the override names an earlier plan"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "an override of the earlier plan applied nothing once app planned another digest, and the wave exited 4"
  return $rc
}

claim_policy_override_unlisted() {
  # smoke-stranger, whom policy.override at base does not list, overrides the
  # denial with terragucci override. The override counts for nothing: the
  # wave exits 1, applies nothing, and says smoke-stranger is not listed.
  # BREAK: smoke-approver, who is listed, writes the override, so the wave
  # applies.
  log() { echo "[smoke policy-override-unlisted] $*" >&2; }
  local work image code rc=0 actor=smoke-stranger
  [ -n "${BREAK:-}" ] && actor=smoke-approver
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/wave"
  policy_override_repo "$work" smoke-approver
  code="$(policy_override_wave "$work" "$image")"
  [ "$code" = 1 ] || { log "the first run exited $code, not 1: the policy did not deny the wave"; rc=1; }
  if [ $rc = 0 ]; then policy_override_write "$work" "$actor" || rc=1; fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 1 ] || { log "the run after an override by $actor exited $code, not 1"; rc=1; }
    policy_override_applied "$work" && { log "app has state: an override by $actor let it apply"; rc=1; }
    grep -q "$actor is not listed under policy.override at base" "$work/run.log" || { log "the wave does not say $actor is not listed"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "an override by smoke-stranger, whom policy.override at base does not list, applied nothing"
  return $rc
}

# ── reports on Azure Blob Storage and GCS ─────────────────────────────────
# Each claim: one project whose reports.bucket names the emulator, a tf-plan
# that copies its report there, then `terragucci estate` writing the page and
# printing its link. The job has only the OIDC identity a job with oidc.azure
# or oidc.gcp gets; a stand-in for the cloud's token service runs in the job
# container on 127.0.0.1 and answers only the token the job was handed.

# A JWT with these claims and a signature nobody checks: what the stand-ins answer.
blob_jwt() { # claims json
  local h b
  h="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=\n')"
  b="$(printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n')"
  printf '%s.%s.c21va2U' "$h" "$b"
}

# A project named NAME in WORK/NAME with one terraform_data root, app/, and the reports block.
blob_project() { # work, name, reports yaml
  mkdir -p "$1/$2/app"
  printf '%s\n' "$3" >"$1/$2/terragucci.yml"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$2" >"$1/$2/app/main.tf"
  git -C "$1/$2" init -q -b main
  git -C "$1/$2" add -A && git -C "$1/$2" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke $2"
}

# Run a command in the CI image for project NAME, with WORK/stub at /stub and
# the stand-in STUB (a file in it) listening first. The rest of the -e
# arguments come from BLOB_ENV.
blob_run() { # work, name, image, stub, command...
  local work="$1" name="$2" image="$3" stub="$4"; shift 4
  run_copied --rm --network terragucci -v "$work/$name:/projects/$name" -v "$work/stub:/stub" -w "/projects/$name" \
    -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${BLOB_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" sh -c 'node "/stub/$0" >>/stub/stub.log 2>&1 & i=0; until [ -s /stub/ready ] || [ $i -ge 50 ]; do sleep 0.1; i=$((i+1)); done; "$@"' "$stub" "$@"
}

claim_blob_azure() {
  # reports.bucket is az://devstoreaccount1/<container> on Azurite, over TLS
  # with OAuth on. The job has ARM_TENANT_ID, ARM_CLIENT_ID and a token in
  # ARM_OIDC_TOKEN_FILE_PATH and no account key; the stand-in for Entra ID
  # (AZURE_AUTHORITY_HOST) takes that token as the client assertion for that
  # client and scope, and answers a storage token. tf-plan copies the report
  # and both indexes to the container; terragucci estate writes the page and
  # prints a user delegation SAS, and Azurite serves the page on that link.
  # BREAK: one character of the link signature changes, and Azurite must refuse it.
  log() { echo "[smoke blob-azure] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image port="${TERRAGUCCI_AZURITE_PORT:-10010}" certs="$HERE/.state/azurite-certs" name=blob-azure container tenant=7d2c0b4e-0000-4000-8000-00000000a2e1 client=4f1a9c0d-0000-4000-8000-0000000c11e7
  local now jwt out link served path rc=0 i code
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # Azurite bind-mounts its certificates and outlives the claim: rewritten in place, as the registry's are.
  mkdir -p "$certs" "$work/newcerts" "$work/stub"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:azurite,IP:127.0.0.1" \
    -keyout "$work/newcerts/azurite.key" -out "$work/newcerts/azurite.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; drop_work "$work"; return 1; }
  cat "$work/newcerts/azurite.key" >"$certs/azurite.key"
  cat "$work/newcerts/azurite.crt" >"$certs/azurite.crt"
  chmod 644 "$certs/azurite.key"
  cp "$certs/azurite.crt" "$work/stub/ca.crt"
  with_lock compose env TERRAGUCCI_AZURITE_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile blob up -d --force-recreate azurite >&2 || { drop_work "$work"; return 1; }
  # What Entra ID would answer: Azurite checks the audience, the issuer and the lifetime (iat, nbf and exp, all three present), and keys the delegation on oid and tid.
  now="$(date +%s)"
  jwt="$(blob_jwt "{\"aud\":\"https://storage.azure.com\",\"iss\":\"https://sts.windows.net/$tenant/\",\"iat\":$((now - 60)),\"nbf\":$((now - 60)),\"exp\":$((now + 3600)),\"oid\":\"$client\",\"tid\":\"$tenant\",\"appid\":\"$client\"}")"
  azr() { curl -sS --cacert "$certs/azurite.crt" -H "Authorization: Bearer $jwt" -H 'x-ms-version: 2021-08-06' "$@"; }
  for i in $(seq 1 30); do
    [ "$(azr -o /dev/null -w '%{http_code}' "https://localhost:$port/devstoreaccount1?comp=list" 2>/dev/null)" = 200 ] && break
    sleep 1
  done
  container="tg-$(date +%s)"
  code="$(azr -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Length: 0' "https://localhost:$port/devstoreaccount1/$container?restype=container" 2>/dev/null)" || true
  [ "$code" = 201 ] || { log "Azurite did not make container $container ($code)"; drop_work "$work"; return 1; }
  printf 'forge-oidc-token-%s' "$now" >"$work/stub/forge-token"
  printf '%s' "$jwt" >"$work/stub/storage-token"
  cat >"$work/stub/entra.mjs" <<'JS'
// Entra ID's token endpoint for one tenant and client: a client assertion that is the job's token buys the storage token.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [tenant, client] = [process.env.ARM_TENANT_ID, process.env.ARM_CLIENT_ID];
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const f = new URLSearchParams(body);
    const ok = req.method === "POST" && req.url === `/${tenant}/oauth2/v2.0/token` && f.get("client_id") === client && f.get("grant_type") === "client_credentials"
      && f.get("scope") === "https://storage.azure.com/.default" && f.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
      && f.get("client_assertion") === readFileSync("/stub/forge-token", "utf-8");
    console.log(`${req.method} ${req.url} ${ok ? "token" : "refused"}`);
    res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { token_type: "Bearer", expires_in: 3599, access_token: readFileSync("/stub/storage-token", "utf-8") } : { error: "invalid_client", error_description: "AADSTS700213: No matching federated identity record found." }));
  });
}).listen(8180, "127.0.0.1", () => writeFileSync("/stub/ready", "1"));
JS
  blob_project "$work" "$name" "$(printf 'reports:\n  bucket: az://devstoreaccount1/%s\n  endpoint: https://azurite:10000/devstoreaccount1\n  prefix: reports' "$container")"
  local -a BLOB_ENV=(-e "ARM_TENANT_ID=$tenant" -e "ARM_CLIENT_ID=$client" -e ARM_OIDC_TOKEN_FILE_PATH=/stub/forge-token -e ARM_USE_OIDC=true
    -e AZURE_AUTHORITY_HOST=http://127.0.0.1:8180 -e NODE_EXTRA_CA_CERTS=/stub/ca.crt)
  blob_run "$work" "$name" "$image" entra.mjs terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/$name" "$image"
  if [ $rc = 0 ]; then
    path="$(azr "https://localhost:$port/devstoreaccount1/$container/reports/$name/index.json" | jq -r '.reports[0].path // empty')"
    [ -n "$path" ] || { log "no row in reports/$name/index.json"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    azr -f -o /dev/null "https://localhost:$port/devstoreaccount1/$container/reports/$name/$path/report.html" || { log "no report.html at reports/$name/$path"; rc=1; }
    [ "$(azr "https://localhost:$port/devstoreaccount1/$container/reports/index.json" | jq -r '[.reports[].project] | join(",")')" = "$name" ] || { log "the top index does not list $name"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    : >"$work/stub/ready"
    out="$(blob_run "$work" "$name" "$image" entra.mjs terragucci estate --bucket "az://devstoreaccount1/$container" --bucket-endpoint https://azurite:10000/devstoreaccount1 --bucket-prefix reports --link-hours 1)" || { log "terragucci estate failed"; rc=1; }
    printf '%s\n' "$out" >&2
  fi
  if [ $rc = 0 ]; then
    link="$(grep -E '^https://azurite:10000/devstoreaccount1/' <<<"$out" | head -1)"
    grep -q 'skoid=' <<<"$link" || { log "the command printed no user delegation SAS"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ -n "${BREAK:-}" ] && link="${link/sig=/sig=A}"
    served="$(curl -sS --cacert "$certs/azurite.crt" -w '\n%{http_code}' "https://localhost:$port${link#https://azurite:10000}")" || true
    [ "$(tail -1 <<<"$served")" = 200 ] || { log "Azurite refused the link ($(tail -1 <<<"$served"))"; rc=1; }
    [ $rc = 0 ] && { grep -q "$name" <<<"$served" || { log "the link does not serve the page with $name on it"; rc=1; }; }
  fi
  [ $rc = 0 ] || sed 's/^/[entra] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "with only its Azure OIDC identity the job wrote the report, both indexes and the estate page to $container, and the SAS link served the page"
  return $rc
}

claim_blob_gcs() {
  # reports.bucket is gs://<bucket> on fake-gcs-server, written through the
  # JSON API. The job has GOOGLE_APPLICATION_CREDENTIALS, an external_account
  # file like the one oidc.gcp writes: its token file, Google STS and the
  # service account it impersonates, here a stand-in that answers only the
  # job's token and signs blobs with the service account's key. tf-plan
  # copies the report and both indexes to the bucket; terragucci estate
  # writes the page and prints a V4 signed URL. The emulator checks no
  # signature, so the claim verifies it with the service account's public
  # key, then reads the page through the link.
  # BREAK: one hex digit of the link signature changes, and the signature must not verify.
  log() { echo "[smoke blob-gcs] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image port="${TERRAGUCCI_GCS_PORT:-4453}" name=blob-gcs bucket sa=terragucci-plan@smoke-project.iam.gserviceaccount.com
  local out link served path rc=0 i sig flip
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/stub"
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name terragucci --profile blob up -d gcs >&2 || { drop_work "$work"; return 1; }
  gcs() { curl -sS -H 'Host: gcs:4443' "$@"; }
  for i in $(seq 1 30); do
    gcs -f -o /dev/null "http://localhost:$port/_internal/healthcheck" 2>/dev/null && break
    sleep 1
  done
  bucket="tg-blob-$(date +%s)"
  gcs -f -o /dev/null -X POST -H 'content-type: application/json' -d "{\"name\":\"$bucket\"}" "http://localhost:$port/storage/v1/b?project=smoke-project" \
    || { log "fake-gcs-server did not make bucket $bucket"; drop_work "$work"; return 1; }
  openssl genrsa -out "$work/stub/sa.pem" 2048 >/dev/null 2>&1 || { log "openssl could not make a key"; drop_work "$work"; return 1; }
  openssl rsa -in "$work/stub/sa.pem" -pubout -out "$work/sa.pub" >/dev/null 2>&1
  printf 'forge-oidc-token-%s' "$(date +%s)" >"$work/stub/forge-token"
  # What oidc.gcp writes, with STS and IAM at the stand-in.
  printf '{"type":"external_account","audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/smoke/providers/forge","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"http://127.0.0.1:8181/v1/token","service_account_impersonation_url":"http://127.0.0.1:8181/v1/projects/-/serviceAccounts/%s:generateAccessToken","credential_source":{"file":"/stub/forge-token"}}\n' "$sa" >"$work/stub/creds.json"
  cat >"$work/stub/google.mjs" <<'JS'
// Google STS, then IAM Credentials for one service account: the job's token buys a federated token,
// that buys the service account's token, and that signs blobs with the service account's key.
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const sa = process.env.SMOKE_SA;
const answer = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const path = decodeURIComponent(req.url);
    const bearer = req.headers.authorization;
    console.log(`${req.method} ${path}`);
    if (path === "/v1/token") {
      const f = new URLSearchParams(body);
      const ok = f.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" && f.get("subject_token") === readFileSync("/stub/forge-token", "utf-8")
        && f.get("audience") === "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/smoke/providers/forge";
      return ok ? answer(res, 200, { access_token: "federated-token", token_type: "Bearer", expires_in: 3600 }) : answer(res, 400, { error: "invalid_grant", error_description: "The token is not valid" });
    }
    if (path === `/v1/projects/-/serviceAccounts/${sa}:generateAccessToken` && bearer === "Bearer federated-token") {
      return answer(res, 200, { accessToken: "sa-token", expireTime: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path === `/v1/projects/-/serviceAccounts/${sa}:signBlob` && bearer === "Bearer sa-token") {
      const payload = Buffer.from(JSON.parse(body).payload, "base64");
      return answer(res, 200, { keyId: "smoke", signedBlob: createSign("RSA-SHA256").update(payload).sign(readFileSync("/stub/sa.pem", "utf-8")).toString("base64") });
    }
    answer(res, 403, { error: { code: 403, message: `refused ${req.method} ${path}` } });
  });
}).listen(8181, "127.0.0.1", () => writeFileSync("/stub/ready", "1"));
JS
  blob_project "$work" "$name" "$(printf 'reports:\n  bucket: gs://%s\n  endpoint: http://gcs:4443\n  prefix: reports' "$bucket")"
  local -a BLOB_ENV=(-e GOOGLE_APPLICATION_CREDENTIALS=/stub/creds.json -e "SMOKE_SA=$sa")
  blob_run "$work" "$name" "$image" google.mjs terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/$name" "$image"
  obj() { gcs "http://localhost:$port/storage/v1/b/$bucket/o/$(jq -rn --arg k "$1" '$k | @uri')?alt=media"; }
  if [ $rc = 0 ]; then
    path="$(obj "reports/$name/index.json" | jq -r '.reports[0].path // empty')"
    [ -n "$path" ] || { log "no row in reports/$name/index.json"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    obj "reports/$name/$path/report.html" | grep -q '<!doctype html>' || { log "no report.html at reports/$name/$path"; rc=1; }
    [ "$(obj reports/index.json | jq -r '[.reports[].project] | join(",")')" = "$name" ] || { log "the top index does not list $name"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    : >"$work/stub/ready"
    out="$(blob_run "$work" "$name" "$image" google.mjs terragucci estate --bucket "gs://$bucket" --bucket-endpoint http://gcs:4443 --bucket-prefix reports --link-hours 1)" || { log "terragucci estate failed"; rc=1; }
    printf '%s\n' "$out" >&2
  fi
  if [ $rc = 0 ]; then
    link="$(grep -E "^http://gcs:4443/$bucket/reports/estate.html\\?X-Goog-Algorithm=GOOG4-RSA-SHA256&" <<<"$out" | head -1)"
    [ -n "$link" ] || { log "the command printed no signed URL"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    sig="${link##*X-Goog-Signature=}"
    flip=0; [ "${sig:0:1}" = 0 ] && flip=1
    link="${link%X-Goog-Signature=*}X-Goog-Signature=$flip${sig:1}"
  fi
  if [ $rc = 0 ]; then
    # GOOG4-RSA-SHA256 as Google checks it: the canonical request from the link, its hash in the string-to-sign, the signature over that.
    node -e '
      const { createHash, createVerify, readFileSync } = { ...require("node:crypto"), ...require("node:fs") };
      const u = new URL(process.argv[1]);
      const query = u.search.slice(1).replace(/&X-Goog-Signature=.*$/, "");
      const stamp = u.searchParams.get("X-Goog-Date");
      const canonical = ["GET", u.pathname, query, "host:" + u.host, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
      const toSign = ["GOOG4-RSA-SHA256", stamp, stamp.slice(0, 8) + "/auto/storage/goog4_request", createHash("sha256").update(canonical).digest("hex")].join("\n");
      process.exit(createVerify("RSA-SHA256").update(toSign).verify(readFileSync(process.argv[2], "utf-8"), Buffer.from(u.searchParams.get("X-Goog-Signature"), "hex")) ? 0 : 1);
    ' "$link" "$work/sa.pub" || { log "the signature of the link does not verify with the public key of $sa"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    served="$(gcs -f "http://localhost:$port${link#http://gcs:4443}")" || { log "the emulator did not serve the link"; rc=1; }
    [ $rc = 0 ] && { grep -q "$name" <<<"$served" || { log "the link does not serve the page with $name on it"; rc=1; }; }
  fi
  [ $rc = 0 ] || sed 's/^/[google] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "with only its GCP OIDC identity the job wrote the report, both indexes and the estate page to $bucket through the JSON API, and the link is signed by $sa"
  return $rc
}

# ── the plan note's diff ──────────────────────────────────────────────────

claim_note_diff() {
  # A pull request on the example with one-root, which raises the job
  # retention of dev orders to 604800 seconds. Its plan note must show the
  # change as the binary prints it, before the whole plans: a diff block whose
  # line for message_retention_seconds holds the value before and 604800
  # after it. BREAK: the pushed pipeline deletes every line holding "->"
  # from the note before it posts it, as a note that names only the
  # attributes reads.
  log() { echo "[smoke note-diff] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" branch=smoke/note-diff work wf sha pr rc=0 deadline state notes body groups line before
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example up' first"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # The pipeline this tree renders, so the pull request runs it whatever main carries.
  cp "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$wf"
  git -C "$work/tree" apply "$EXAMPLE/changes/one-root.patch" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # shellcheck disable=SC2016 # written into the workflow, expanded by the job
    sed -i.bak 's#tg note "\$note"#sed -i -e "/->/d" "$note"; tg note "$note"#' "$wf" && rm -f "$wf.bak"
    grep -q 'sed -i -e "/->/d"' "$wf" || { log "BREAK found no tg note line to cut"; drop_work "$work"; return 1; }
  fi
  sha="$(push_tree "$work/tree" "$repo" "$branch" "smoke note-diff: one-root $(date +%s)")"
  pr="$(open_pr "$repo" "$branch")"
  [ -n "$pr" ] || pr="$(api -H 'content-type: application/json' -X POST \
    -d "$(jq -n --arg h "$branch" '{head: $h, base: "main", title: "smoke note-diff: one-root"}')" "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  [ -n "$pr" ] && [ "$pr" != null ] || { log "no pull request"; drop_work "$work"; return 1; }
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
    # The groups, before the whole plans.
    groups="$(sed '/^\*\*Each root/q' <<<"$body")"
    grep -q '^```diff$' <<<"$groups" || { log "no group in the note shows a diff"; rc=1; }
    line="$(grep -E '^~ +message_retention_seconds += [0-9]+ -> 604800$' <<<"$groups" | head -1)"
    if [ -z "$line" ]; then log "no diff line shows message_retention_seconds before and after"; rc=1
    else
      before="$(sed -E 's/.*= ([0-9]+) -> 604800$/\1/' <<<"$line")"
      [ "$before" != 604800 ] || { log "the line shows no change: $line"; rc=1; }
    fi
    grep -q '^<details><summary><code>envs/dev/orders</code>' <<<"$body" || { log "the note holds no whole plan of envs/dev/orders"; rc=1; }
  fi
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$repo/pulls/$pr" || true
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fnote-diff" || true
  drop_work "$work"
  [ $rc = 0 ] && log "the note on pull request $pr shows message_retention_seconds $before -> 604800 in a diff block"
  return $rc
}

# A repo of two terraform_data roots, as the CI image plans them: big holds
# 3000 lines, so its whole plan is over GitHub's 65,536 characters; small holds one.
note_repo() { # dir, reports config or nothing
  local dir="$1"
  mkdir -p "$dir/big" "$dir/small"
  # shellcheck disable=SC2016 # HCL interpolation
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "big" {\n  input = flatten([for a in range(30) : [for b in range(100) : "line ${a * 100 + b} of a plan too long for one GitHub comment"]])\n}\n' > "$dir/big/main.tf"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "small" {\n  input = "small"\n}\n' > "$dir/small/main.tf"
  [ -z "${2:-}" ] || printf '%s\n' "$2" > "$dir/terragucci.yml"
  git -C "$dir" init -q -b main
  git -C "$dir" add -A && git -C "$dir" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke note"
}

note_stage() { # dir, stage args...
  local dir="$1" image rc=0
  shift
  image="$(image_tag tofu)"
  run_copied --rm --network terragucci -v "$dir:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan "$@" >&2 || rc=$?
  clean_mounted "$dir" "$image"
  return $rc
}

claim_note_split() {
  # The two roots of note_repo plan with --forge github. The note keeps to
  # GitHub's limit as one comment: it leaves out the whole plan of big, the
  # largest, with a Cut line naming it and linking its plan.txt, keeps the
  # whole plan of small, and plan.txt keeps all 3000 lines. BREAK: the stage
  # runs with --forge gitlab, whose limit is 1,000,000, so the note is over
  # the limit of GitHub.
  log() { echo "[smoke note-split] $*" >&2; }
  local work forge=github rc=0 dir chars
  [ -n "${BREAK:-}" ] && forge=gitlab
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  note_repo "$work/repo"
  note_stage "$work/repo" --layers 'big,small' --forge "$forge" || { log "the plan run failed"; rc=1; }
  dir="$work/repo/terragucci-report"
  [ -f "$dir/note.md" ] || { log "the plan wrote no note"; drop_work "$work"; return 1; }
  chars="$(jq -Rs length <"$dir/note.md")"
  [ "$chars" -le 65536 ] || { log "the note is $chars characters, over the 65536 of GitHub"; rc=1; }
  grep -qF 'this note leaves out the whole plans of 1 root ([`big`](roots/big/plan.txt))' "$dir/note.md" || { log "no Cut line names the whole plan of big"; rc=1; }
  grep -qF '<details><summary><code>small</code>' "$dir/note.md" || { log "the whole plan of small is not in the note"; rc=1; }
  grep -q 'line 2999 of a plan' "$dir/roots/big/plan.txt" || { log "plan.txt of big does not hold its last line"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "a $chars-character note leaves out the whole plan of big, names it in its Cut line, and keeps small"
  return $rc
}

claim_note_report_link() {
  # A plan run with reports.bucket on floci and no reports.url. The note links
  # report.html in the bucket by a presigned link, which opens the report the
  # run wrote, and the plan.txt of small the same way, the same text as the
  # file the run kept. BREAK: the config names a bucket that does not exist,
  # so the link opens nothing.
  log() { echo "[smoke note-report-link] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work bucket="$REPORT_BUCKET" prefix rc=0 dir url plan hostport
  [ -n "${BREAK:-}" ] && bucket="$REPORT_BUCKET-gone"
  prefix="note-link-$(date +%s)$$"
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  note_repo "$work/repo" "$(printf 'reports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s' "$bucket" "$prefix")"
  note_stage "$work/repo" --layers 'big,small' --forge github || log "the plan run exited non-zero"
  dir="$work/repo/terragucci-report"
  [ -f "$dir/note.md" ] || { log "the plan wrote no note"; drop_work "$work"; return 1; }
  url="$(grep -o '\[Full report\]([^)]*)' "$dir/note.md" | head -1 | sed -E 's/^\[Full report\]\((.*)\)$/\1/')"
  plan="$(grep -A40 '<summary><code>small</code>' "$dir/note.md" | grep -o '\[plan.txt\]([^)]*)' | head -1 | sed -E 's/^\[plan.txt\]\((.*)\)$/\1/')"
  case "$url" in *"/$prefix/"*report.html\?*X-Amz-Signature=*) ;; *) log "the note links '$url', not a presigned report.html under $prefix"; rc=1 ;; esac
  # The link names floci as the job sees it; reach it from here with the same Host, which the signature covers.
  hostport="${FLOCI#*://}"; hostport="${hostport%%/*}"
  if [ $rc = 0 ]; then
    curl -fsS --connect-to "floci:4566:$hostport" -o "$work/opened.html" "$url" || { log "the link to report.html does not open"; rc=1; }
  fi
  [ $rc = 0 ] && { grep -q 'id="terragucci-report"' "$work/opened.html" || { log "the link opens no report"; rc=1; }; }
  if [ $rc = 0 ]; then
    [ -n "$plan" ] && curl -fsS --connect-to "floci:4566:$hostport" -o "$work/plan.txt" "$plan" || { log "the link to plan.txt of small does not open"; rc=1; }
    [ $rc = 0 ] && { cmp -s "$work/plan.txt" "$dir/roots/small/plan.txt" || { log "the linked plan.txt is not the one the run kept"; rc=1; }; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the note links report.html and plan.txt in $REPORT_BUCKET/$prefix presigned, and both open from floci"
  return $rc
}

# ── config, decisions, telemetry and installs ─────────────────────────────

claim_config_ts() {
  # The example with its terragucci.yml written as terragucci.ts, the same
  # keys as data. config check passes it, and init writes exactly the
  # pipeline the example commits. A second terragucci.ts reads its binary
  # from process.env: config check refuses it and names the rule and line.
  # BREAK: the second file sets its binary as a literal, so nothing is refused.
  log() { echo "[smoke config-ts] $*" >&2; }
  local work rc=0 out binary='process.env.TG_BINARY'
  [ -n "${BREAK:-}" ] && binary='"tofu"'
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/ts" "$work/env"
  cp -R "$EXAMPLE/." "$work/ts/"
  rm -f "$work/ts/terragucci.yml"
  printf 'export default {\n  binary: "tofu",\n  waves: { canary: ["envs/dev/*"] },\n  drift: "0 6 * * *",\n};\n' > "$work/ts/terragucci.ts"
  (cd "$work/ts" && "$TERRAGUCCI" config check) >&2 || { log "config check refused the TypeScript config"; rc=1; }
  if (cd "$work/ts" && "$TERRAGUCCI" init) >&2; then
    diff -u "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/ts/.forgejo/workflows/terragucci.yml" >&2 || { log "init from terragucci.ts wrote a different pipeline"; rc=1; }
  else
    log "init failed on terragucci.ts"; rc=1
  fi
  printf 'export default {\n  binary: %s,\n};\n' "$binary" > "$work/env/terragucci.ts"
  if out="$(cd "$work/env" && "$TERRAGUCCI" config check 2>&1)"; then
    echo "$out" >&2
    log "config check passed a terragucci.ts that reads process.env"; rc=1
  else
    echo "$out" >&2
    grep -q 'is not data (F-Eval-Ident): 2:' <<<"$out" || { log "the refusal does not name the rule and the line"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "init from terragucci.ts wrote the example pipeline; a terragucci.ts that reads process.env was refused at its line"
  return $rc
}

claim_role_refused() {
  # The example with oidc naming one role for plan and for apply. config
  # check and init both refuse it and say why; nothing is written.
  # BREAK: plan and apply name two roles, so nothing is refused.
  log() { echo "[smoke role-refused] $*" >&2; }
  local work rc=0 out apply=terragucci
  [ -n "${BREAK:-}" ] && apply=terragucci-apply
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$work/"
  rm -rf "$work/.forgejo"
  printf 'oidc:\n  plan_role: arn:aws:iam::123456789012:role/terragucci\n  apply_role: arn:aws:iam::123456789012:role/%s\n' "$apply" >> "$work/terragucci.yml"
  if out="$(cd "$work" && "$TERRAGUCCI" config check 2>&1)"; then
    echo "$out" >&2; log "config check passed one role for plan and apply"; rc=1
  else
    echo "$out" >&2
    grep -q 'plan_role and apply_role are the same role' <<<"$out" || { log "config check failed without naming the shared role"; rc=1; }
  fi
  if out="$(cd "$work" && "$TERRAGUCCI" init 2>&1)"; then
    log "init wrote a pipeline with one role for plan and apply"; rc=1
  else
    grep -q 'plan_role and apply_role are the same role' <<<"$out" || { echo "$out" >&2; log "init failed without naming the shared role"; rc=1; }
  fi
  [ -e "$work/.forgejo/workflows/terragucci.yml" ] && [ -z "${BREAK:-}" ] && { log "init wrote a pipeline anyway"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "config check and init refused one role for plan and apply"
  return $rc
}

# A stand-in service (stack/fixtures/stand-in/server.mjs) on the stack's
# network, in the tofu CI image. STANDIN is its container, STANDIN_CTL its
# address from the host, where GET /_requests lists what it took.
stand_in_up() { # work, name, port, KEY=VALUE...
  local work="$1" name="$2" port="$3" i hostport kv
  shift 3
  local -a envs=()
  for kv in "$@"; do envs+=(-e "$kv"); done
  mkdir -p "$work/stand-in" && cp "$HERE/fixtures/stand-in/server.mjs" "$work/stand-in/" || return 1
  STANDIN="$(run_copied -d --name "$name" --network terragucci -p "127.0.0.1::$port" -e "PORT=$port" ${envs[@]+"${envs[@]}"} \
    -v "$work/stand-in:/stand-in:ro" "$(image_tag tofu)" node /stand-in/server.mjs)" || return 1
  hostport="$(docker port "$STANDIN" "$port/tcp" | head -1 | sed 's/.*://')"
  STANDIN_CTL="http://127.0.0.1:$hostport"
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "$STANDIN_CTL/_requests" 2>/dev/null && return 0
    sleep 1
  done
  echo "the stand-in $name never answered on $STANDIN_CTL" >&2
  return 1
}

stand_in_down() {
  [ -n "${STANDIN:-}" ] && { docker rm -f "$STANDIN" >/dev/null 2>&1 || true; }
  STANDIN=""
}

# One root, app, with two terraform_data applied in local state, then gone
# removed and committed: a plan that destroys app: terraform_data.gone.
# terragucci.yml takes the decide block given and respond.description: check.
description_repo() { # dir, decide block (YAML lines under decide:)
  local dir="$1"
  mkdir -p "$dir/app"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "keep" {\n  input = "keep"\n}\n\nresource "terraform_data" "gone" {\n  input = "gone"\n}\n' > "$dir/app/main.tf"
  printf 'binary: tofu\nforge: forgejo\nroots: ["app"]\nrespond:\n  description: check\ndecide:\n%s\n' "$2" > "$dir/terragucci.yml"
  in_image "$dir" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || return 1
  clean_mounted "$dir"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "keep" {\n  input = "keep"\n}\n' > "$dir/app/main.tf"
  git -C "$dir" init -q -b main
  git -C "$dir" add -A && git -C "$dir" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke description: drop gone"
  in_image "$dir" terragucci stage tf-plan --layers app >&2
  clean_mounted "$dir"
  jq -e '[.roots[].changes[]? | select(.action == "delete")] | length == 1' "$dir/terragucci-report/report.json" >/dev/null 2>&1 \
    || { echo "the plan of app does not destroy terraform_data.gone" >&2; return 1; }
}

# The description check the plan job runs, with the title and description a
# pull request would carry. Extra arguments go before it, such as env K=V.
description_check() { # dir, [env K=V...]
  local dir="$1"
  shift
  in_image "$dir" "$@" terragucci respond description --mode apply --report terragucci-report --title "retag app" --description "Tags only." >&2
}

claim_description_check() {
  # A repo with respond.description: check and decide: pointing at a stand-in
  # for the decision service, which answers yes at 0.95. init puts the check
  # in the plan job. The plan destroys app: terraform_data.gone, and the pull
  # request says Tags only: the check run as the plan job runs it writes a
  # flag naming the destroy at the top of note.md and in report.html, and
  # writes intent.json with the decision.
  # BREAK: the stand-in answers no (0.05), so nothing is flagged.
  log() { echo "[smoke description-check] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 name="tgs-decide-$STAMP" noul=0.95 dir first
  [ -n "${BREAK:-}" ] && noul=0.05
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  stand_in_up "$work" "$name" 8790 MODE=decide "NOUL=$noul" || { stand_in_down; return 1; }
  description_repo "$work/repo" "$(printf '  backend: laya\n  url: http://%s:8790' "$name")" || rc=1
  if [ $rc = 0 ]; then
    (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; rc=1; }
    grep -q 'terragucci respond description --mode apply --report terragucci-report' "$work/repo/.forgejo/workflows/terragucci.yml" \
      || { log "the plan job does not run the description check"; rc=1; }
  fi
  [ $rc = 0 ] && { description_check "$work/repo" || { log "respond description failed"; rc=1; }; }
  dir="$work/repo/terragucci-report"
  if [ $rc = 0 ]; then
    jq -e '.flagged == true and (.unmentioned | index("app: terraform_data.gone"))' "$dir/intent.json" >/dev/null 2>&1 \
      || { log "intent.json does not flag app: terraform_data.gone: $(jq -c . "$dir/intent.json" 2>/dev/null)"; rc=1; }
    first="$(head -1 "$dir/note.md")"
    grep -q 'Check the description of this pull request.*terraform_data.gone.*(destroy)' <<<"$first" || { log "the note does not open with the flag: $first"; rc=1; }
    grep -q 'id="description-flag"' "$dir/report.html" || { log "report.html has no flag"; rc=1; }
    jq -e '.intent.flagged == true' "$dir/report.json" >/dev/null || { log "report.json does not carry the decision"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "the note opens with a flag naming app: terraform_data.gone (destroy), and intent.json records the decision"
  return $rc
}

claim_decide_backends() {
  # The description check of description_repo asked through decide.backend
  # von, decider and jev in turn, each at a stand-in that answers yes at 0.95
  # in the shape all three speak. config check passes each block; each flags
  # the destroy and names the pinned model; the request pins that model, and
  # jev alone sends its key from token_env as a bearer token.
  # BREAK: the stand-in answers yes at 0.55, under the 0.8 threshold, so no
  # backend flags anything.
  log() { echo "[smoke decide-backends] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 name="tgs-backends-$STAMP" noul=0.95 dir backend model block req key="smoke-jev-$STAMP"
  [ -n "${BREAK:-}" ] && noul=0.55
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  stand_in_up "$work" "$name" 8790 MODE=decide "NOUL=$noul" || { stand_in_down; return 1; }
  description_repo "$work/repo" "$(printf '  backend: von\n  url: http://%s:8790\n  model: von-1.0.0' "$name")" || rc=1
  dir="$work/repo/terragucci-report"
  for backend in von decider jev; do
    [ $rc = 0 ] || break
    model="$backend-1.0.0"
    block="$(printf '  backend: %s\n  url: http://%s:8790\n  model: %s' "$backend" "$name" "$model")"
    [ "$backend" = jev ] && block="$(printf '%s\n  token_env: SMOKE_JEV_KEY' "$block")"
    printf 'binary: tofu\nforge: forgejo\nroots: ["app"]\nrespond:\n  description: check\ndecide:\n%s\n' "$block" > "$work/repo/terragucci.yml"
    (cd "$work/repo" && "$TERRAGUCCI" config check) >&2 || { log "$backend: config check refused the decide block"; rc=1; continue; }
    description_check "$work/repo" env "SMOKE_JEV_KEY=$key" || { log "$backend: respond description failed"; rc=1; continue; }
    jq -e --arg m "$model" '.flagged == true and .model == $m' "$dir/intent.json" >/dev/null 2>&1 \
      || { log "$backend: intent.json does not flag the destroy as $model: $(jq -c '{status, flagged, decision, model}' "$dir/intent.json" 2>/dev/null)"; rc=1; }
    req="$(curl -fsS "$STANDIN_CTL/_requests" | jq -c 'map(select(.path | startswith("/v1/systemone"))) | last')"
    [ "$(jq -r '.body.model' <<<"$req")" = "$model" ] || { log "$backend: the request pinned $(jq -r '.body.model' <<<"$req"), not $model"; rc=1; }
    if [ "$backend" = jev ]; then
      [ "$(jq -r '.headers.authorization // ""' <<<"$req")" = "Bearer $key" ] || { log "jev: the request carried no bearer token from token_env"; rc=1; }
    else
      [ "$(jq -r '.headers.authorization // ""' <<<"$req")" = "" ] || { log "$backend: the request carried a token it was not given"; rc=1; }
    fi
    [ $rc = 0 ] && log "$backend: flagged as $model"
  done
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "von, decider and jev each answered the description check through the same client, each pinned to its model, jev with its bearer token"
  return $rc
}

claim_otlp_headers() {
  # A collector stand-in that answers 401 unless the request carries
  # x-api-key. init with telemetry.headers_secret maps the secret into the
  # jobs as OTEL_EXPORTER_OTLP_HEADERS; a plan run with that variable sends
  # its spans, and the stand-in takes them. A plan run whose endpoint does
  # not answer stays green and writes its report.
  # BREAK: the plan run has no OTEL_EXPORTER_OTLP_HEADERS, so every span
  # is refused.
  log() { echo "[smoke otlp-headers] $*" >&2; }
  local work rc=0 name="tgs-otlp-$STAMP" key="smoke-$STAMP" headers=() code=0 taken
  [ -z "${BREAK:-}" ] && headers=(-e "OTEL_EXPORTER_OTLP_HEADERS=x-api-key=$key")
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  note_repo "$work/repo" "$(printf 'forge: forgejo\nbinary: tofu\nenv:\n  OTEL_EXPORTER_OTLP_ENDPOINT: http://%s:4318\ntelemetry:\n  headers_secret: OTLP_HEADERS' "$name")"
  (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; rc=1; }
  if [ $rc = 0 ]; then
    # The YAML writer quotes the forge expression; quoted or not it is the same value.
    grep -qE "OTEL_EXPORTER_OTLP_HEADERS: '?\\\$\\{\\{ secrets\\.OTLP_HEADERS \\}\\}'?\$" "$work/repo/.forgejo/workflows/terragucci.yml" \
      || { log "the pipeline does not map OTLP_HEADERS into OTEL_EXPORTER_OTLP_HEADERS"; rc=1; }
    git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke otlp: pipeline"
  fi
  [ $rc = 0 ] && { stand_in_up "$work" "$name" 4318 MODE=otlp "REQUIRE=x-api-key=$key" || rc=1; }
  otlp_plan() { # endpoint, docker run args...
    local endpoint="$1" code=0
    shift
    run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e "OTEL_EXPORTER_OTLP_ENDPOINT=$endpoint" "$@" "$(image_tag tofu)" terragucci stage tf-plan --layers small >&2 || code=$?
    clean_mounted "$work/repo"
    return $code
  }
  if [ $rc = 0 ]; then
    otlp_plan "http://$name:4318" ${headers[@]+"${headers[@]}"} || true
  fi
  if [ $rc = 0 ]; then
    taken="$(curl -fsS "$STANDIN_CTL/_requests" | jq '[.[] | select(.path == "/v1/traces" and .status == 200)
      | select(any(.body.resourceSpans[]?.resource.attributes[]?; .key == "service.name" and .value.stringValue == "terragucci"))] | length')"
    log "the stand-in took $taken trace posts from terragucci, and refused $(curl -fsS "$STANDIN_CTL/_requests" | jq '[.[] | select(.status == 401)] | length')"
    [ "${taken:-0}" -ge 1 ] || { log "no span of the plan run reached the collector that wants the key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    rm -rf "$work/repo/terragucci-report"
    otlp_plan "http://tgs-nowhere-$STAMP:4318" || code=$?
    [ "$code" = 0 ] || { log "with a collector that does not answer the plan run exited $code"; rc=1; }
    [ -f "$work/repo/terragucci-report/report.json" ] || { log "with a collector that does not answer the plan run wrote no report"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "spans reached the collector with the key from OTEL_EXPORTER_OTLP_HEADERS, and a collector that does not answer left the plan green"
  return $rc
}

claim_pinned_install() {
  # A repo that pins OpenTofu 1.10.6, which the tofu image does not carry.
  # init adds an install step to the jobs; the step, run in the tofu image as
  # the job runs it, fetches the release, checks it against its SHA256SUMS,
  # and puts it on the path, where tofu version says 1.10.6.
  # BREAK: the step runs with every sum in SHA256SUMS replaced by zeros, so
  # the check refuses the download and the step fails.
  log() { echo "[smoke pinned-install] $*" >&2; }
  local work rc=0 wf out preload=()
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  note_repo "$work/repo" "$(printf 'forge: forgejo\nbinary: tofu\nversion: 1.10.6')"
  (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/repo/.forgejo/workflows/terragucci.yml"
  # shellcheck disable=SC2016 # the step's own text
  if ! grep -q 'name: Install tofu 1.10.6' "$wf" || ! grep -qF 'dir="$(terragucci install tofu 1.10.6)"' "$wf"; then
    log "the pipeline has no step that installs tofu 1.10.6"; rc=1
  fi
  if [ -n "${BREAK:-}" ]; then
    cat > "$work/repo/zero-sums.cjs" <<'JS'
// Every sum in a SHA256SUMS the job fetches reads as zeros.
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await real(url, init);
  if (!String(url).includes("SHA256SUMS")) return res;
  const text = (await res.text()).replace(/^[0-9a-f]{64}/gm, "0".repeat(64));
  return new Response(text, { status: res.status });
};
JS
    preload=(env NODE_OPTIONS=--require=/repo/zero-sums.cjs)
  fi
  if [ $rc = 0 ]; then
    # The step as the pipeline writes it, then the job's next step with the path it added.
    # shellcheck disable=SC2016 # expanded by the container's shell
    if out="$(in_image "$work/repo" ${preload[@]+"${preload[@]}"} sh -c 'export GITHUB_PATH=/tmp/github-path; dir="$(terragucci install tofu 1.10.6)" && echo "$dir" >> "$GITHUB_PATH" && PATH="$(cat "$GITHUB_PATH"):$PATH" tofu version' 2>&1)"; then
      echo "$out" >&2
      grep -q '^OpenTofu v1.10.6' <<<"$out" || { log "the step put another tofu on the path"; rc=1; }
    else
      echo "$out" >&2
      log "the install step failed"; rc=1
    fi
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the install step fetched OpenTofu 1.10.6, checked it against its SHA256SUMS and put it on the path"
  return $rc
}

claim_drift_close() {
  # A queue applied with a visibility timeout of 30, then set to 45 in floci
  # outside OpenTofu: tf-drift opens the drift issue naming app. The timeout
  # goes back to 30, and the next tf-drift run finds no drift and closes the
  # issue.
  # BREAK: the timeout stays at 45, so the second run still finds drift and
  # the issue stays open.
  log() { echo "[smoke drift-close] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/drift-close" queue="tg-drift-close-$STAMP" key="respond/drift-close-$STAMP.tfstate" url issue state rc=0 back=30
  [ -n "${BREAK:-}" ] && back=45
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo drift-close || return 1
  # The queue carries a tag: floci reads an untagged queue's tags as {} where
  # the state holds null, a tags drift that no run clears.
  respond_tree "$work" "$repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
}")"
  push_tree "$work/tree" "$repo" main "a queue with a timeout of 30" >/dev/null || return 1
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  in_image "$work/tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the apply failed"; return 1; }
  clean_mounted "$work/tree"
  drift_issues() { api "$URL/api/v1/repos/$repo/issues?state=$1&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  drift_stage() {
    in_image "$work/tree" env "GITHUB_REPOSITORY=$repo" GITHUB_SERVER_URL=http://forgejo:3000 GITHUB_API_URL=http://forgejo:3000/api/v1 "TG_TOKEN=$TOKEN" \
      terragucci stage tf-drift --forge forgejo --report-url "http://forgejo:3000/$repo/actions" >&2
    clean_mounted "$work/tree"
  }
  queue_timeout() { sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"$1\"}}" >/dev/null; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] || { log "$queue is not in floci"; return 1; }
  queue_timeout 45
  drift_stage || { log "the first drift run failed"; rc=1; }
  if [ $rc = 0 ]; then
    issue="$(drift_issues open | jq -r '.[0].number // empty')"
    [ -n "$issue" ] || { log "the first run opened no drift issue"; rc=1; }
    [ -n "$issue" ] && { drift_issues open | jq -r '.[0].body' | grep -q 'app' || { log "the drift issue does not name app"; rc=1; }; }
  fi
  if [ $rc = 0 ]; then
    queue_timeout "$back"
    drift_stage || { log "the second drift run failed"; rc=1; }
    state="$(api "$URL/api/v1/repos/$repo/issues/$issue" | jq -r .state)"
    [ "$state" = closed ] || { log "drift issue $issue is $state after a run with no drift"; rc=1; }
    [ "$(drift_issues open | jq length)" = 0 ] || { log "a drift issue is still open"; rc=1; }
  fi
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  drop_work "$work"
  [ $rc = 0 ] && log "drift issue $issue opened for the changed timeout and closed by the run that found none"
  return $rc
}

# ── the estate page ───────────────────────────────────────────────────────

# A project with one root, app, whose terragucci.yml names its reports block.
estate_project() { # dir, reports block (YAML lines under reports:)
  mkdir -p "$1/app"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$(basename "$1")" > "$1/app/main.tf"
  printf 'binary: tofu\nreports:\n%s\n' "$2" > "$1/terragucci.yml"
  git -C "$1" init -q -b main
  git -C "$1" add -A && git -C "$1" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke estate $(basename "$1")"
}

claim_estate_control() {
  # Two projects of a control repo, forgejo:3000/smoke/estate-a and -b, each
  # copying its plan report to a bucket of its own. The control repo names
  # each project's bucket with a reports.role of its own, and the page's
  # bucket under defaults.reports with a third. terragucci estate, run with
  # no static keys and only an OIDC token, assumes each role through STS,
  # reads both indexes, and writes one page listing both projects to the
  # defaults bucket.
  # BREAK: estate-b's reports name no role, so with no static keys its index
  # cannot be read.
  log() { echo "[smoke estate-control] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 prefix="estate-control-$STAMP" p page out roleb=$'\n      role: arn:aws:iam::000000000000:role/estate-b-reader' bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  [ -n "${BREAK:-}" ] && roleb=""
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  for p in a b; do
    curl -fsS -o /dev/null -X PUT "$FLOCI/terragucci-estate-$p" || true
    estate_project "$work/estate-$p" "$(printf '  bucket: s3://terragucci-estate-%s\n  endpoint: http://floci:4566\n  prefix: %s' "$p" "$prefix")"
    in_image "$work/estate-$p" env "GITHUB_REPOSITORY=smoke/estate-$p" GITHUB_SERVER_URL=http://forgejo:3000 terragucci stage tf-plan --layers app >&2 \
      || { log "the plan of estate-$p failed"; rc=1; }
    clean_mounted "$work/estate-$p"
    curl -fsS -o /dev/null "$FLOCI/terragucci-estate-$p/$prefix/forgejo:3000/smoke/estate-$p/index.json" \
      || { log "estate-$p has no index in its own bucket"; rc=1; }
  done
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  mkdir -p "$work/control"
  cat > "$work/control/terragucci.yml" <<YAML
defaults:
  reports:
    bucket: s3://$REPORT_BUCKET
    endpoint: http://floci:4566
    prefix: $prefix
    role: arn:aws:iam::000000000000:role/estate-page
projects:
  forgejo:3000/smoke/estate-a:
    reports:
      bucket: s3://terragucci-estate-a
      endpoint: http://floci:4566
      prefix: $prefix
      role: arn:aws:iam::000000000000:role/estate-a-reader
  forgejo:3000/smoke/estate-b:
    reports:
      bucket: s3://terragucci-estate-b
      endpoint: http://floci:4566
      prefix: $prefix$roleb
YAML
  printf '%s' 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOnNtb2tlL2NvbnRyb2w6cmVmOnJlZnMvaGVhZHMvbWFpbiJ9.c21va2U' > "$work/control/.oidc-token"
  if [ $rc = 0 ]; then
    out="$(run_copied --rm --network terragucci -v "$work/control:/control" -w /control -v "$bundle:/usr/local/bin/terragucci:ro" \
      "${AWS_DOCKER_ENV[@]}" -e AWS_ACCESS_KEY_ID= -e AWS_SECRET_ACCESS_KEY= -e AWS_WEB_IDENTITY_TOKEN_FILE=/control/.oidc-token -e AWS_ROLE_SESSION_NAME=smoke \
      "$(image_tag tofu)" terragucci estate --link-hours 1 2>&1)" || log "terragucci estate exited non-zero"
    printf '%s\n' "$out" >&2
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -r '[.projects[] | select(.status == "ok" and .plan != null) | .project] | join(",")' <<<"$page")" = "forgejo:3000/smoke/estate-a,forgejo:3000/smoke/estate-b" ] \
      || { log "the page does not show both projects with their plans: $(jq -c '[.projects[] | {project, status, error}]' <<<"$page")"; rc=1; }
    grep -Eq "X-Amz-Signature=[0-9a-f]{64}" <<<"$out" || { log "the command printed no presigned link"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "one page in $REPORT_BUCKET/$prefix lists estate-a and estate-b, each read from its own bucket with its own role"
  return $rc
}

claim_estate_override() {
  # The policy-override repo copies its reports to the bucket. Its wave is
  # denied, smoke-approver overrides it, and the next run applies app. Then
  # terragucci estate reads the index: estate.json counts one root applied
  # by policy override, for the project and in the totals, and estate.html
  # shows the count.
  # BREAK: nobody overrides the denial, so nothing applies under an override.
  log() { echo "[smoke estate-override] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image code rc=0 prefix="estate-override-$STAMP" page bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  mkdir -p "$work/wave"
  cp -R "$HERE/fixtures/policy-wave/." "$work/wave/"
  printf 'policy:\n  engine: conftest\n  path: policy\n  override: [smoke-approver]\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" >> "$work/wave/terragucci.yml"
  git init -q --bare "$work/origin.git"
  git -C "$work/wave" init -q -b main
  git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke estate override"
  git -C "$work/wave" push -q "$work/origin.git" main
  git -C "$work/wave" remote add origin /origin.git
  override_wave() {
    code=0
    run_copied --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >"$work/run.log" 2>&1 || code=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
  }
  override_wave
  [ "$code" = 1 ] || { log "the first run exited $code, not 1: the policy did not deny the wave"; rc=1; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ]; then
    override_wave
    log "the run after the override exited $code"
    mkdir -p "$work/page"
    run_copied --rm --network terragucci -v "$work/page:/page" -w /page -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
      "$image" terragucci estate --bucket "s3://$REPORT_BUCKET" --bucket-endpoint http://floci:4566 --bucket-prefix "$prefix" --link-hours 1 >&2 || log "terragucci estate exited non-zero"
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -e '.totals.overridden_roots == 1 and ([.projects[].overridden // 0] | add) == 1' <<<"$page" >/dev/null \
      || { log "estate.json does not count one root applied by policy override: $(jq -c '{totals, projects: [.projects[] | {project, overridden}]}' <<<"$page")"; rc=1; }
    curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html" | grep -q '<b>1</b><span>root applied by policy override</span>' \
      || { log "estate.html does not show one root applied by policy override"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "after an overridden apply, estate.json and estate.html count one root applied by policy override"
  return $rc
}

# ── comments, notes and the edge rules of apply before merge ──────────────

# A scratch repo with two roots, app and net, each a terraform_data with local
# state, gate never, and the pipeline init writes, pushed to main and green.
# Leaves the tree in $work/tree on main and MAIN_SHA.
two_root_repo() { # name
  local name="$1" repo="$USER/$1" root
  fresh_repo "$name" || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in app net; do
    mkdir -p "$work/tree/$root"
    echo 1 > "$work/tree/$root/rev.txt"
    # shellcheck disable=SC2016 # HCL interpolation
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "rev" {\n  input = file("${path.module}/rev.txt")\n}\n' > "$work/tree/$root/main.tf"
  done
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n' > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  MAIN_SHA="$(push_tree "$work/tree" "$repo" main "$name: first")" || return 1
  wait_run "$repo" "$MAIN_SHA" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; return 1; }
}

statuses_of() { # repo, sha, context -> how many statuses carry it
  api "$URL/api/v1/repos/$1/commits/$2/statuses?limit=100" | jq --arg c "$3" '[.[] | select(.context == $c)] | length'
}

claim_comment_refused() {
  # A scratch repo with two roots and a pull request that changes app. Once
  # its own plan finished, the admin comments /terragucci approve, merge,
  # destroy, import, state and force-unlock on it. Each is answered that a
  # comment never runs it, none plans, and main gains no apply.
  # BREAK: the issue_comment trigger is cut from the pipeline on main, the
  # one a comment runs, so no comment is answered.
  log() { echo "[smoke comment-refused] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-refused" head pr i before after replies verb applied rc=0 wf
  local verbs=(approve merge destroy import state force-unlock)
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo comment-refused || return 1
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    awk '/^  issue_comment:/ { skip = 2; next } skip > 0 { skip--; next } { print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    # A comment runs the workflow of the default branch, not the pull request's.
    MAIN_SHA="$(push_tree "$work/tree" "$repo" main "comment-refused: no issue_comment trigger")" || return 1
    wait_run "$repo" "$MAIN_SHA" || return 1
  fi
  echo 2 > "$work/tree/app/rev.txt"
  head="$(push_tree "$work/tree" "$repo" refused-change "comment-refused: change app")" || return 1
  pr="$(pr_open "$repo" refused-change "comment-refused: change app")" || return 1
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(statuses_of "$repo" "$head" terragucci/plan)" -ge 2 ] && break
    sleep 3
  done
  before="$(statuses_of "$repo" "$head" terragucci/plan)"
  applied="$(statuses_of "$repo" "$MAIN_SHA" terragucci/apply)"
  for verb in "${verbs[@]}"; do
    api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "/terragucci $verb" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$pr/comments"
  done
  # Each comment is answered within a minute; five minutes is the wait, with
  # a line each minute so the runner sees the claim is alive.
  for i in $(seq 1 100); do
    replies="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: ")) | .body] | join("\n")')"
    [ "$(grep -c 'a comment never runs' <<<"$replies")" -ge ${#verbs[@]} ] && break
    [ $(( i % 20 )) = 0 ] && log "$(grep -c 'a comment never runs' <<<"$replies") of ${#verbs[@]} comments answered after $(( i * 3 ))s"
    sleep 3
  done
  for verb in "${verbs[@]}"; do
    grep -qF "a comment never runs \`$verb\`" <<<"$replies" || { log "/terragucci $verb got no refusal"; rc=1; }
  done
  after="$(statuses_of "$repo" "$head" terragucci/plan)"
  [ "$after" = "$before" ] || { log "a refused comment planned ($before plan statuses before, $after after)"; rc=1; }
  [ "$(statuses_of "$repo" "$MAIN_SHA" terragucci/apply)" = "$applied" ] || { log "main gained an apply status from a comment"; rc=1; }
  [ "$(remote_head "$repo" main)" = "$MAIN_SHA" ] || { log "main moved"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "approve, merge, destroy, import, state and force-unlock were each refused by name, and nothing planned or applied"
  return $rc
}

claim_note_stale() {
  # A scratch repo with two roots. A pull request changes app, and its plan
  # note covers app. Then a push to main changes app too: its first apply
  # wave marks the note stale, naming main and app.
  # BREAK: the push to main changes net only, which the note does not
  # cover, so the note stays as it was.
  log() { echo "[smoke note-stale] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/note-stale" head pr i note moved=app sha rc=0
  [ -n "${BREAK:-}" ] && moved=net
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo note-stale || return 1
  plan_note() { api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))][0].body // empty'; }
  echo 2 > "$work/tree/app/rev.txt"
  head="$(push_tree "$work/tree" "$repo" stale-change "note-stale: change app")" || return 1
  pr="$(pr_open "$repo" stale-change "note-stale: change app")" || return 1
  wait_run "$repo" "$head" pull_request || return 1
  for i in $(seq 1 20); do note="$(plan_note)"; [ -n "$note" ] && break; sleep 3; done
  head -1 <<<"$note" | grep -q 'roots=app -->' || { log "the plan note does not cover app: $(head -1 <<<"$note")"; return 1; }
  git -C "$work/tree" checkout -q main
  echo 3 > "$work/tree/$moved/rev.txt"
  sha="$(push_tree "$work/tree" "$repo" main "note-stale: main changes $moved")" || return 1
  wait_run "$repo" "$sha" push || return 1
  note="$(plan_note)"
  log "the note after main moved under $moved: $(sed -n 2p <<<"$note")"
  grep -qF '> This plan is stale: main moved under app. Push to this pull request to plan again. <!-- terragucci:stale -->' <<<"$note" \
    || { log "the plan note of pull request $pr is not marked stale"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the push to main that changed app marked the plan note of pull request $pr stale"
  return $rc
}

pr_serial() { # name, root -> the serial of the root's state, empty when it has none
  curl -fsS "$FLOCI/shop-terraform-state/$1/$2.tfstate" 2>/dev/null | jq -r '.serial // empty' 2>/dev/null || true
}

claim_pr_confirm() {
  # A repo with apply.when: pull-request and apply.merge: auto. A pull request
  # changes canary/one, is approved, applies on /terragucci apply and merges.
  # The push of the merge commit runs confirm, which plans every root and
  # posts terragucci/apply success, and no apply wave: the state of
  # canary/one keeps the serial the pull request left.
  # BREAK: the pipeline is written to apply after merge, and the pull request
  # is merged by hand, so the merge commit runs the apply waves and no confirm.
  log() { echo "[smoke pr-confirm] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-confirm" head pr reply merge serial jobs status rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-confirm auto ${BREAK:+merge} || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-confirm: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-confirm || { drop_work "$work"; return 1; }
  echo confirmed > "$work/tree/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "pr-confirm: change canary/one")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "pr-confirm: change canary/one")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr" "$head" || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
    log "reply: ${reply:-none}"
    serial="$(pr_serial pr-confirm canary/one)"
  else
    serial="$(pr_serial pr-confirm canary/one)"
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || rc=1
  fi
  merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
  [ -n "$merge" ] && [ "$merge" != null ] || { log "pull request $pr did not merge"; rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$merge" push || rc=1; }
  if [ $rc = 0 ]; then
    jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
    log "the merge commit ran: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
    [ "$(jq -r '.[] | select(.name == "confirm") | .status' <<<"$jobs")" = success ] || { log "the merge commit ran no successful confirm job"; rc=1; }
    [ -z "$(jq -r '.[] | select((.name | startswith("apply-wave")) and .status != "skipped") | .name' <<<"$jobs")" ] || { log "the merge commit ran an apply wave"; rc=1; }
    status="$(api "$URL/api/v1/repos/$repo/commits/$merge/statuses?limit=100" | jq -r '[.[] | select(.context == "terragucci/apply")] | sort_by(.id) | last | if . == null then "none" else "\(.status // .state) \(.description)" end')"
    log "terragucci/apply on the merge commit: $status"
    case "$status" in "success applied before merge; every root plans no change"*) ;; *) log "terragucci/apply does not say every root plans no change"; rc=1 ;; esac
    [ "$(pr_serial pr-confirm canary/one)" = "$serial" ] || { log "the state of canary/one moved after the merge (serial $serial, now $(pr_serial pr-confirm canary/one))"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-confirm?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the merge commit ran confirm, which planned no change and applied nothing"
  return $rc
}

claim_pr_base_config() {
  # A repo with apply.when: pull-request and gate: always on main. A pull
  # request changes canary/one and sets gate: never in its own terragucci.yml.
  # /terragucci apply runs the default branch's pipeline and its gate: wave 1
  # waits for an approval, and nothing applies.
  # BREAK: main itself has gate: never, so the wave applies.
  log() { echo "[smoke pr-base-config] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-base-config" head pr reply applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo pr-base-config || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && { sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"; }
  printf 'apply:\n  when: pull-request\n  merge: manual\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-base-config: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-base-config || { drop_work "$work"; return 1; }
  echo relaxed > "$work/tree/canary/one/rev.txt"
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  head="$(push_tree "$work/tree" "$repo" change "pr-base-config: gate never in the pull request")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" change "pr-base-config: gate never in the pull request")" || { drop_work "$work"; return 1; }
  pr_ready "$repo" "$pr" "$head" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr" "/terragucci apply")"
  applied="$(gated_applied pr-base-config)"
  log "reply: ${reply:-none}; state for: ${applied:-nothing}"
  grep -q "wave 1 waits for an approval of its set digest" <<<"$reply" || { log "wave 1 did not wait under the gate of main"; rc=1; }
  [ -z "$applied" ] || { log "the gate: never of the pull request let $applied apply"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-base-config?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "a pull request that sets gate: never still waited at the gate main sets, and applied nothing"
  return $rc
}

claim_pr_guard() {
  # A repo with apply.when: pull-request. Pull request A changes canary/one
  # and the pipeline file; pull request B changes fleet/two and carries a
  # failed status (smoke/ci) on its head. Both are approved. /terragucci
  # apply on A is refused for the pipeline file, on B for its checks, and no
  # root has state.
  # BREAK: A leaves the pipeline file alone and B has no failed status, so
  # both apply.
  log() { echo "[smoke pr-guard] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-guard" head_a head_b pr_a pr_b reply applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-guard manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-guard: first" >/dev/null || { drop_work "$work"; return 1; }
  pr_reviewer "$repo" smoke-rev-pr-guard || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  [ -n "${BREAK:-}" ] || echo '# a change to the pipeline file' >> "$work/tree/.forgejo/workflows/terragucci.yml"
  head_a="$(push_tree "$work/tree" "$repo" change-a "pr-guard: a")" || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/fleet/two/rev.txt"
  head_b="$(push_tree "$work/tree" "$repo" change-b "pr-guard: b")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "pr-guard: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "pr-guard: b")" || { drop_work "$work"; return 1; }
  { pr_ready "$repo" "$pr_a" "$head_a" && pr_ready "$repo" "$pr_b" "$head_b"; } || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"context":"smoke/ci","state":"failure","description":"a check outside terragucci failed"}' \
      "$URL/api/v1/repos/$repo/statuses/$head_b" || { log "could not post the failed status"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_a" "/terragucci apply")"
    log "A ($pr_a): ${reply:-no reply}"
    grep -q "pull request $pr_a changes .forgejo/workflows/terragucci.yml, and the apply runs the pipeline of main" <<<"$reply" || { log "A was not refused for the pipeline file"; rc=1; }
    reply="$(pr_say "$repo" "$pr_b" "/terragucci apply")"
    log "B ($pr_b): ${reply:-no reply}"
    grep -q "the checks of pull request $pr_b are not green: smoke/ci failed" <<<"$reply" || { log "B was not refused for its failed check"; rc=1; }
  fi
  applied="$(gated_applied pr-guard)"
  [ -z "$applied" ] || { log "a refused pull request applied: $applied"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/smoke-rev-pr-guard?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the change to the pipeline file and the failed check were each refused, and nothing applied"
  return $rc
}

claim_pr_close_release() {
  # A repo with apply.when: pull-request. Pull requests A and B each change
  # canary/one. /terragucci lock on A locks it; A is closed unmerged; then
  # /terragucci lock on B takes canary/one, which the closed A no longer holds.
  # BREAK: A stays open, so B is refused for the lock A holds.
  log() { echo "[smoke pr-close-release] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pr-close-release" pr_a pr_b reply rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  pr_repo pr-close-release manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "pr-close-release: first" >/dev/null || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" change-a "pr-close-release: a" >/dev/null || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" change-b "pr-close-release: b" >/dev/null || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "pr-close-release: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "pr-close-release: b")" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr_a" "/terragucci lock")"
  log "lock on A ($pr_a): ${reply:-no reply}"
  grep -q "locked \`canary/one\` for pull request $pr_a" <<<"$reply" || { log "the lock on A did not lock canary/one"; rc=1; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$repo/pulls/$pr_a" || { log "could not close pull request $pr_a"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$pr_b" "/terragucci lock")"
    log "lock on B ($pr_b): ${reply:-no reply}; locks: $(lock_file "$repo" | jq -c '.locks | map_values(.pr)' 2>/dev/null)"
    grep -q "locked \`canary/one\` for pull request $pr_b" <<<"$reply" || { log "B did not take canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "closing A released canary/one, and B locked it"
  return $rc
}

claim_tg_lock_fanout() {
  # A Terragrunt repo with apply.when: pull-request. Pull request A changes
  # root.hcl, in no unit's directory: /terragucci lock on it says it locks
  # every unit because of root.hcl, and locks all three. Pull request B
  # changes Markdown only: /terragucci lock on it locks nothing.
  # BREAK: A changes live/fleet/three/rev.txt instead, so it locks that unit
  # alone.
  log() { echo "[smoke tg-lock-fanout] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-lock-fanout" pr_a pr_b reply held rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_pr_repo tg-lock-fanout manual || { drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "tg-lock-fanout: first" >/dev/null || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    echo a > "$work/tree/live/fleet/three/rev.txt"
  else
    printf '\n# a change outside every unit\n' >> "$work/tree/root.hcl"
  fi
  push_tree "$work/tree" "$repo" change-a "tg-lock-fanout: a" >/dev/null || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  printf '# Notes\n\nNothing here reaches a unit.\n' > "$work/tree/NOTES.md"
  push_tree "$work/tree" "$repo" change-b "tg-lock-fanout: notes" >/dev/null || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" change-a "tg-lock-fanout: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" change-b "tg-lock-fanout: notes")" || { drop_work "$work"; return 1; }
  reply="$(pr_say "$repo" "$pr_a" "/terragucci lock")"
  log "lock on A ($pr_a): ${reply:-no reply}"
  grep -qF "pull request $pr_a locks every unit: it changes \`root.hcl\`, which is in no unit's directory" <<<"$reply" || { log "A does not say root.hcl locks every unit"; rc=1; }
  grep -qF "locked \`live/canary/one\`, \`live/fleet/three\`, \`live/fleet/two\` for pull request $pr_a" <<<"$reply" || { log "A did not lock all three units"; rc=1; }
  reply="$(pr_say "$repo" "$pr_b" "/terragucci lock")"
  log "lock on B ($pr_b): ${reply:-no reply}"
  grep -qF "pull request $pr_b reaches no unit, so nothing is locked" <<<"$reply" || { log "the Markdown change was not answered as reaching no unit"; rc=1; }
  held="$(lock_file "$repo" | jq -r '[.locks // {} | to_entries[] | select(.value.pr == '"${pr_b:-0}"') | .key] | join(",")' 2>/dev/null)"
  [ -z "$held" ] || { log "B holds $held"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "a root.hcl change locked every unit and said why; a Markdown change locked none"
  return $rc
}

claim_token_scrub() {
  # A root whose external data source writes the environment it runs in to
  # a file. tf-plan runs it with TG_TOKEN, GITHUB_TOKEN and FORGEJO_TOKEN
  # set, SMOKE_COPY holding the value of TG_TOKEN, and TF_VAR_token holding
  # it too. The binary sees none of the three tokens and not SMOKE_COPY,
  # and TF_VAR_token passes as set.
  # BREAK: the root is planned by tofu itself in the same environment, not
  # by terragucci, so every token reaches the data source.
  log() { echo "[smoke token-scrub] $*" >&2; }
  local work rc=0 secret="tg-secret-$STAMP" seen
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo/app"
  cat > "$work/repo/app/main.tf" <<'TF'
terraform {
  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
  backend "local" {}
}

variable "token" {
  type    = string
  default = ""
}

# What a pull request's code can read: the environment the binary gives it.
data "external" "env" {
  program = ["sh", "-c", "env > \"$0/seen.env\"; echo '{}'", path.module]
}

resource "terraform_data" "probe" {
  input = data.external.env.result
}
TF
  printf 'binary: tofu\nroots: ["app"]\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke token scrub"
  local -a envs=(-e "TG_TOKEN=$secret" -e "GITHUB_TOKEN=$secret-gh" -e "FORGEJO_TOKEN=$secret-fj" -e "SMOKE_COPY=$secret" -e "TF_VAR_token=$secret")
  if [ -n "${BREAK:-}" ]; then
    run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo/app -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 "${envs[@]}" \
      "$(image_tag tofu)" sh -c 'tofu init -input=false -no-color >/dev/null && tofu plan -input=false -no-color' >&2 || true
  else
    run_copied --rm --network terragucci -v "$work/repo:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' "${envs[@]}" \
      "$(image_tag tofu)" terragucci stage tf-plan --layers app >&2 || true
  fi
  clean_mounted "$work/repo"
  seen="$work/repo/app/seen.env"
  [ -s "$seen" ] || { log "the data source wrote no environment"; drop_work "$work"; return 1; }
  grep -E '^(TG_TOKEN|GITHUB_TOKEN|FORGEJO_TOKEN|SMOKE_COPY)=' "$seen" | cut -d= -f1 | sed 's/^/[smoke token-scrub]   the binary saw /' >&2 || true
  grep -Eq '^(TG_TOKEN|GITHUB_TOKEN|FORGEJO_TOKEN)=' "$seen" && { log "a forge token reached the data source by name"; rc=1; }
  grep -q '^SMOKE_COPY=' "$seen" && { log "the value of TG_TOKEN reached the data source under another name"; rc=1; }
  grep -qx "TF_VAR_token=$secret" "$seen" || { log "TF_VAR_token did not pass as set"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the data source saw no forge token by name or by value, and TF_VAR_token as set"
  return $rc
}

# Forgejo has no API to approve the held run of a fork pull request; a
# maintainer does it on the pull request page, which posts trust=once to
# /<repo>/pulls/<n>/action-user-trust. This signs in as the admin, with the
# password stack/bootstrap.sh gives it, and does that.
fork_trust_once() { # repo, pull request number
  local jar="$work/admin-cookies" csrf
  csrf_of() { awk '$6 == "_csrf" { print $7 }' "$jar" | tail -1; }
  curl -fsS -o /dev/null -c "$jar" -b "$jar" "$URL/user/login" || return 1
  curl -fsS -o /dev/null -c "$jar" -b "$jar" -X POST --data-urlencode "_csrf=$(csrf_of)" --data-urlencode "user_name=$USER" \
    --data-urlencode "password=Terragucci-local-pw-1234" "$URL/user/login" || return 1
  curl -fsS -o /dev/null -c "$jar" -b "$jar" "$URL/$1/pulls/$2" || return 1
  csrf="$(csrf_of)"
  case "$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -X POST --data-urlencode "_csrf=$csrf" -d trust=once "$URL/$1/pulls/$2/action-user-trust")" in
    2??|3??) ;;
    *) return 1 ;;
  esac
  # The run leaves the hold: its jobs are no longer blocked.
  local i
  for i in $(seq 1 30); do
    api "$URL/api/v1/repos/$1/actions/runs?event=pull_request" | jq -e '[.workflow_runs[]? | select(.need_approval == true)] | length == 0' >/dev/null && return 0
    sleep 1
  done
  return 1
}

claim_fork_no_plan() {
  # A scratch repo with two roots. A second user forks it and opens a pull
  # request from the fork that changes app. Forgejo holds the run of a fork
  # pull request until a maintainer trusts it; the admin approves it once,
  # as the pull request page's trust panel does. The run on the base repo
  # then runs check and skips plan: no terragucci/plan status on its head.
  # BREAK: the pushed pipeline drops the same-repo condition from the plan
  # job, so the fork pull request runs plan.
  log() { echo "[smoke fork-no-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/fork-no-plan" who=tg-fork-user pass="tg-fork-user-$$-Aa1" ftoken fork="tg-fork-user/fork-no-plan" sha fpr i run="" jobs rc=0 wf
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo fork-no-plan || return 1
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak "s/github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository\$/github.event_name == 'pull_request'/" "$wf" && rm -f "$wf.bak"
    grep -q "head.repo.full_name == github.repository" "$wf" && { log "the same-repo condition is still on the plan job"; return 1; }
    MAIN_SHA="$(push_tree "$work/tree" "$repo" main "fork-no-plan: plan for every pull request")" || return 1
    wait_run "$repo" "$MAIN_SHA" || return 1
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$who" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || return 1
  ftoken="$(curl -fsS -u "$who:$pass" -H 'content-type: application/json' -X POST -d '{"name":"smoke","scopes":["write:repository","write:issue"]}' "$URL/api/v1/users/$who/tokens" | jq -r '.sha1 // empty')"
  [ -n "$ftoken" ] || { log "no token for $who"; return 1; }
  curl -fsS -o /dev/null -H "Authorization: token $ftoken" -H 'content-type: application/json' -X POST -d '{}' "$URL/api/v1/repos/$repo/forks" || { log "$who could not fork $repo"; return 1; }
  for i in $(seq 1 30); do api -o /dev/null "$URL/api/v1/repos/$fork" 2>/dev/null && break; sleep 1; done
  echo 2 > "$work/tree/app/rev.txt"
  git -C "$work/tree" checkout -q -B fork-change
  git -C "$work/tree" add -A
  git -C "$work/tree" -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q -m "fork-no-plan: fork change"
  git -C "$work/tree" push -q --force "${URL/#http:\/\//http://${who}:${ftoken}@}/${fork}.git" HEAD:refs/heads/fork-change 2>/dev/null || { log "could not push to the fork"; return 1; }
  sha="$(git -C "$work/tree" rev-parse HEAD)"
  fpr="$(curl -fsS -H "Authorization: token $ftoken" -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg h "$who:fork-change" '{head: $h, base: "main", title: "fork-no-plan: from a fork"}')" "$URL/api/v1/repos/$repo/pulls" | jq -r '.number // empty')"
  [ -n "$fpr" ] || { log "could not open a pull request from the fork"; return 1; }
  fork_trust_once "$repo" "$fpr" || { log "the admin could not approve the run of pull request $fpr"; rc=1; }
  if [ $rc = 0 ]; then
    wait_run "$repo" "$sha" pull_request || { log "the pull request from the fork started no run in $repo"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
    log "the run of pull request $fpr from the fork: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
    [ "$(jq -r '.[] | select(.name == "check") | .status' <<<"$jobs")" = success ] || { log "check did not run for the fork"; rc=1; }
    [ "$(jq -r '[.[] | select(.name == "plan")][0].status // "none"' <<<"$jobs")" = skipped ] || { log "plan was not skipped for the fork"; rc=1; }
    [ "$(statuses_of "$repo" "$sha" terragucci/plan)" = 0 ] || { log "the head of the fork got a terragucci/plan status"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the pull request from the fork ran check and no plan"
  return $rc
}

claim_highlight_sensitive() {
  # One root that creates an IAM role, a security group, a KMS key and a
  # Route 53 zone, imports a queue made in floci by hand, and forgets a
  # terraform_data its state holds with a removed block. In the report each
  # of the four is open with the reason for its type, the import and the
  # forget are named, the forget is not counted as a destroy, and the note
  # names both.
  # BREAK: the root creates four SQS queues in place of the four sensitive
  # resources and has no import or removed block.
  log() { echo "[smoke highlight-sensitive] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 queue="tg-import-$STAMP" url r t why
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo/sens"
  local head='terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
  backend "local" {}
}

provider "aws" {
  region = "us-east-1"
}
'
  printf '%s\nresource "terraform_data" "old" {\n  input = "old"\n}\n' "$head" > "$work/repo/sens/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$work/repo/sens/"
  printf 'binary: tofu\nroots: ["sens"]\n' > "$work/repo/terragucci.yml"
  in_image "$work/repo" sh -c 'cd sens && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the first apply failed"; drop_work "$work"; return 1; }
  clean_mounted "$work/repo"
  url="$(sqs CreateQueue "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] || { log "could not make $queue in floci"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    printf '%s\nresource "terraform_data" "old" {\n  input = "old"\n}\n' "$head" > "$work/repo/sens/main.tf"
    for t in a b c d; do printf '\nresource "aws_sqs_queue" "%s" {\n  name = "tg-plain-%s-%s"\n}\n' "$t" "$t" "$STAMP" >> "$work/repo/sens/main.tf"; done
  else
    cat > "$work/repo/sens/main.tf" <<HCL
$head
resource "aws_iam_role" "deploy" {
  name = "tg-deploy-$STAMP"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }]
  })
}

resource "aws_security_group" "web" {
  name = "tg-web-$STAMP"
}

resource "aws_kms_key" "data" {
  description = "tg-data-$STAMP"
}

resource "aws_route53_zone" "internal" {
  name = "tg-$STAMP.internal"
}

import {
  to = aws_sqs_queue.imported
  id = "$url"
}

resource "aws_sqs_queue" "imported" {
  name = "$queue"
}

removed {
  from = terraform_data.old
}
HCL
  fi
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke highlight-sensitive"
  in_image "$work/repo" terragucci stage tf-plan --layers sens >&2 || log "the plan run exited non-zero"
  clean_mounted "$work/repo"
  r="$work/repo/terragucci-report/report.json"
  if [ ! -f "$r" ]; then
    log "no report"; rc=1
  else
    for t in "aws_iam_role|IAM:" "aws_security_group|security group:" "aws_kms_key|KMS key:" "aws_route53_zone|DNS:"; do
      why="$(jq -r --arg t "${t%%|*}" '[.roots[].changes[] | select(.type == $t)][0] | "\(.fold) \(.why // "")"' "$r")"
      case "$why" in "open ${t#*|}"*) ;; *) log "${t%%|*} is not open for its type: $why"; rc=1 ;; esac
    done
    jq -e '.named[] | select(.action == "import" and .address == "aws_sqs_queue.imported")' "$r" >/dev/null || { log "the import of aws_sqs_queue.imported is not named"; rc=1; }
    jq -e '.named[] | select(.action == "forget" and .address == "terraform_data.old")' "$r" >/dev/null || { log "the forget of terraform_data.old is not named"; rc=1; }
    jq -e '[.named[] | select(.action == "delete")] | length == 0' "$r" >/dev/null || { log "the forget is counted as a destroy"; rc=1; }
    grep -q 'aws_sqs_queue.imported' "$work/repo/terragucci-report/note.md" || { log "the note does not name the import"; rc=1; }
    grep -q 'terraform_data.old' "$work/repo/terragucci-report/note.md" || { log "the note does not name the forget"; rc=1; }
  fi
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "IAM, security group, KMS and DNS changes are open with their reasons; the import and the forget are named, and the forget is no destroy"
  return $rc
}

# ── approval upkeep ───────────────────────────────────────────────────────

claim_approval_revoke() {
  # The gated fixture: wave 1 waits and is approved. The approval line is
  # then removed from _gates/tf-apply.jsonl on chant/lifecycle in a normal
  # commit, as the runbook says. The next push waits at wave 1 again, and no
  # root has state.
  # BREAK: the approval stays, so the next push applies canary/one.
  log() { echo "[smoke approval-revoke] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approval-revoke" sha applied clone rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approval-revoke || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approval-revoke: first")"
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  [ -z "$(gated_applied approval-revoke)" ] || { log "a root applied before any approval"; rc=1; }
  [ $rc = 0 ] && { gated_approve approval-revoke 1 || rc=1; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    clone="$work/lifecycle"
    { git clone -q --branch chant/lifecycle --single-branch "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" \
      && jq -c 'select(.kind == "pending")' "$clone/_gates/tf-apply.jsonl" > "$clone/kept.jsonl" \
      && mv "$clone/kept.jsonl" "$clone/_gates/tf-apply.jsonl" \
      && git -C "$clone" -c user.name=smoke-approver -c user.email=smoke-approver@terragucci.local -c commit.gpgsign=false commit -qam "revoke the approval of wave-1" \
      && git -C "$clone" push -q origin chant/lifecycle; } || { log "could not revoke the approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "approval-revoke: after the revoke")"
    wait_run "$repo" "$sha" || rc=1
    applied="$(gated_applied approval-revoke)"
    log "after the revoke: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "the revoked approval let $applied apply"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep -q "chant approve tf-apply wave-1" || { log "wave 1 did not wait for an approval again"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "with its approval line removed, wave 1 waited again and nothing applied"
  return $rc
}

claim_pending_expiry() {
  # The gated fixture: wave 1 waits and records one pending fact. That fact is
  # then aged past its 48 hours on chant/lifecycle. The next push records a
  # fresh pending fact for wave 1 that expires in the future.
  # BREAK: the fact is not aged, so the next push records none.
  log() { echo "[smoke pending-expiry] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pending-expiry" sha clone count now old expired rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo pending-expiry || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "pending-expiry: first")"
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  pending() { file_at "$repo" chant/lifecycle "$(remote_head "$repo" chant/lifecycle)" _gates/tf-apply.jsonl | jq -c 'select(.kind == "pending" and .gate == "wave-1")'; }
  count="$(pending | wc -l | tr -d ' ')"
  [ "$count" = 1 ] || { log "wave 1 recorded $count pending facts, not 1"; rc=1; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    old="$(date -u -v-50H +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '50 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)"
    expired="$(date -u -v-2H +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)"
    clone="$work/lifecycle"
    { git clone -q --branch chant/lifecycle --single-branch "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" \
      && jq -c --arg t "$old" --arg x "$expired" 'if .kind == "pending" and .gate == "wave-1" then .timestamp = $t | .expiresAt = $x else . end' "$clone/_gates/tf-apply.jsonl" > "$clone/aged.jsonl" \
      && mv "$clone/aged.jsonl" "$clone/_gates/tf-apply.jsonl" \
      && git -C "$clone" -c user.name=smoke -c user.email=smoke@terragucci.local -c commit.gpgsign=false commit -qam "age the pending fact of wave-1 past 48 hours" \
      && git -C "$clone" push -q origin chant/lifecycle; } || { log "could not age the pending fact"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "pending-expiry: the next run")"
    wait_run "$repo" "$sha" || rc=1
    now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    count="$(pending | jq -s --arg n "$now" '"\(length) \([.[] | select(.expiresAt > $n)] | length)"' -r)"
    log "after the next run: wave-1 has ${count% *} pending facts, ${count#* } of them unexpired"
    [ "$count" = "2 1" ] || { log "the next run did not record a fresh pending fact beside the expired one"; rc=1; }
    [ -z "$(gated_applied pending-expiry)" ] || { log "a root applied"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "a pending fact past its 48 hours was recorded afresh by the next run"
  return $rc
}

claim_signer_trust() {
  # The gated fixture under approval: sealed with no signers file. In the
  # checkout, git config user.signingkey names the approver key, and
  # terragucci init --signer smoke-approver writes .chant/allowed_signers from
  # it. The file moves to security/allowed_signers, and .chant/trust.json
  # names that path. wave 1 waits; an approval sealed with the key lets
  # canary/one apply.
  # BREAK: trust.json names a path with no file, so the sealed approval
  # verifies against nothing and the wave keeps waiting.
  log() { echo "[smoke signer-trust] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/signer-trust" sha applied path=security/allowed_signers rc=0
  [ -n "${BREAK:-}" ] && path=security/nobody
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo signer-trust gated-waves sealed || { drop_work "$work"; return 1; }
  rm -f "$work/tree/.chant/allowed_signers"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" config user.signingkey "$work/approver.pub"
  (cd "$work/tree" && "$TERRAGUCCI" init --signer smoke-approver >&2) || { log "init --signer failed"; drop_work "$work"; return 1; }
  grep -q "^smoke-approver $(cut -d' ' -f1,2 "$work/approver.pub")" "$work/tree/.chant/allowed_signers" 2>/dev/null \
    || { log "init --signer did not write the approver key"; rc=1; }
  mkdir -p "$work/tree/security"
  mv "$work/tree/.chant/allowed_signers" "$work/tree/security/allowed_signers"
  printf '{"schema": 1, "signers": "%s"}\n' "$path" > "$work/tree/.chant/trust.json"
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "signer-trust: first")"
    wait_run "$repo" "$sha" || rc=1
    [ -z "$(gated_applied signer-trust)" ] || { log "a root applied before any approval"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve signer-trust 1 sign || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "signer-trust: after the sealed approval")"
    wait_run "$repo" "$sha" || rc=1
    applied="$(gated_applied signer-trust)"
    log "after the sealed approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "the approval sealed with the key init wrote, read through trust.json, did not let canary/one apply"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "init --signer wrote the key, trust.json moved the file, and the sealed approval let canary/one apply"
  return $rc
}

# ── rollouts across projects, providers and pin kinds ─────────────────────

# A new, empty repo with Actions on, under the admin.
rollout_repo() { # name
  fresh_repo "$1" || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$1"
}

# The open or merged pull request of a branch, in any state.
branch_pr() { # repo, branch -> the number, or nothing
  api "$URL/api/v1/repos/$1/pulls?state=all&limit=50" | jq -r --arg b "$2" '[.[] | select(.head.ref == $b)][0].number // empty'
}

claim_rollout_control() {
  # A control repo with two projects, ro-a and ro-b, each with dev/app (a
  # canary) and prod/app on modules/network 0.1.0 from a module repo by git
  # tag. rollout modules/network 0.2.0 --mode apply from the control repo:
  # wave 1 opens one pull request on each project, moving dev/app alone, and
  # nothing else; the next run waits. Both merged and applied, wave 2 opens on
  # ro-a alone (prod/app); merged and applied, wave 3 opens on ro-b.
  # BREAK: the opening runs are dry runs, so no pull request opens.
  log() { echo "[smoke rollout-control] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work mode=apply mod="$USER/ro-mod" source p r out rc=0 pr sha files wave key
  local branch="terragucci/rollout/modules-network-0.2.0"
  [ -n "${BREAK:-}" ] && mode=dry-run
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  for p in ro-mod ro-a ro-b; do rollout_repo "$p" || return 1; done
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=rollout-control/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
  # The module, tagged 0.1.0 and then 0.2.0.
  mkdir -p "$work/mod/modules/network"
  printf 'variable "name" {}\n\noutput "name" {\n  value = var.name\n}\n' > "$work/mod/modules/network/main.tf"
  ( cd "$work/mod" && git init -q -b main && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -qm "feat: modules/network" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m 0.1.0 \
    && printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> modules/network/main.tf \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -qam "feat(network): a version output" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.2.0 -m 0.2.0 \
    && git push -q --tags "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$mod.git" main ) 2>/dev/null || { log "could not push the module repo"; return 1; }
  source="git::http://forgejo:3000/$mod.git//modules/network?ref=modules/network/v0.1.0"
  for p in ro-a ro-b; do
    for r in dev/app prod/app; do
      mkdir -p "$work/$p/$r"
      printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "rollout-control/%s/%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nmodule "network" {\n  source = "%s"\n  name   = "%s-%s"\n}\n' "$p" "$r" "$source" "$p" "${r%/app}" > "$work/$p/$r/main.tf"
    done
    printf 'forge: forgejo\nbinary: tofu\ngate: never\nwaves:\n  canary: ["dev/*"]\n' > "$work/$p/terragucci.yml"
    (cd "$work/$p" && "$TERRAGUCCI" init >/dev/null) || { log "init failed in $p"; return 1; }
    sha="$(push_tree "$work/$p" "$USER/$p" main "$p: two roots on modules/network 0.1.0")" || return 1
    wait_run "$USER/$p" "$sha" || return 1
    [ "$RUN_STATUS" = success ] || { print_logs "$USER/$p" "$RUN_ID" | tail -40 >&2; log "the first apply of $p ended $RUN_STATUS"; return 1; }
  done
  mkdir -p "$work/control"
  cat > "$work/control/terragucci.yml" <<YML
defaults:
  forge: forgejo
  binary: tofu
  token_env: TERRAGUCCI_FORGEJO_TOKEN
  waves:
    canary: ["dev/*"]
projects:
  localhost/$USER/ro-a:
    url: $URL/$USER/ro-a
  localhost/$USER/ro-b:
    url: $URL/$USER/ro-b
YML
  ( cd "$work/control" && git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm "the control repo" ) || return 1
  ro() { (cd "$work/control" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout modules/network 0.2.0 --mode "$mode" 2>&1); }
  wave_files() { # project, wave -> the files its pull request changes, or nothing
    local n
    n="$(branch_pr "$USER/$1" "$branch/wave-$2")"
    [ -n "$n" ] && pr_files "$USER/$1" "$n"
  }
  merge_wave() { # project, wave -> merges its pull request and waits for the apply on the merge commit
    local n m
    n="$(branch_pr "$USER/$1" "$branch/wave-$2")"
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$USER/$1/pulls/$n/merge" || return 1
    m="$(api "$URL/api/v1/repos/$USER/$1/pulls/$n" | jq -r .merge_commit_sha)"
    wait_run "$USER/$1" "$m" push || return 1
    [ "$RUN_STATUS" = success ] || { log "the apply of $1 wave $2 ended $RUN_STATUS"; return 1; }
  }
  out="$(ro)"; echo "$out" >&2
  for p in ro-a ro-b; do
    files="$(wave_files "$p" 1)"
    [ "$files" = "dev/app/main.tf" ] || { log "wave 1 on $p changes '${files:-nothing}', not dev/app/main.tf"; rc=1; }
  done
  [ $rc = 0 ] || { drop_work "$work"; return 1; }
  out="$(ro)"; r=$?
  [ -z "$(wave_files ro-a 2)$(wave_files ro-b 2)$(wave_files ro-b 3)" ] || { echo "$out" >&2; log "a later wave opened while wave 1 was open"; rc=1; }
  { merge_wave ro-a 1 && merge_wave ro-b 1; } || rc=1
  if [ $rc = 0 ]; then
    out="$(ro)"; echo "$out" >&2
    [ "$(wave_files ro-a 2)" = "prod/app/main.tf" ] || { log "wave 2 did not open on ro-a for prod/app"; rc=1; }
    [ -z "$(wave_files ro-b 2)$(wave_files ro-b 3)" ] || { log "ro-b got a pull request before wave 2 on ro-a applied"; rc=1; }
  fi
  [ $rc = 0 ] && { merge_wave ro-a 2 || rc=1; }
  if [ $rc = 0 ]; then
    out="$(ro)"; echo "$out" >&2
    [ "$(wave_files ro-b 3)" = "prod/app/main.tf" ] || { log "wave 3 did not open on ro-b for prod/app"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 opened one pull request per project for its canary, then wave 2 on ro-a and wave 3 on ro-b, each once the last applied"
  return $rc
}

claim_rollout_provider() {
  # A repo whose root app locks hashicorp/external at 2.3.4 (pinned exactly
  # in required_providers) and hashicorp/aws at 6.67.0. rollout --provider
  # hashicorp/external 2.3.5 --mode apply, run in the tofu CI image, opens one
  # pull request that changes app/.terraform.lock.hcl and app/main.tf: the
  # external entry and its constraint are at 2.3.5, and the aws entry is the
  # same text as before.
  # BREAK: the rollout runs as a dry run, so no pull request opens.
  log() { echo "[smoke rollout-provider] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout-provider" mode=apply out pr sha lock aws_before aws_after files rc=0
  local branch="terragucci/rollout/hashicorp-external-2.3.5/wave-1"
  [ -n "${BREAK:-}" ] && mode=dry-run
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  rollout_repo rollout-provider || return 1
  respond_tree "$work" "$repo" 'terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "2.3.4"
    }
  }
  backend "local" {}
}'
  rm -f "$work/tree/app/.terraform.lock.hcl"
  in_image "$work/tree" sh -c 'cd app && tofu providers lock -no-color >/dev/null' >&2 || { log "could not lock the providers"; return 1; }
  clean_mounted "$work/tree"
  lock="$work/tree/app/.terraform.lock.hcl"
  grep -q 'provider "registry.opentofu.org/hashicorp/external"' "$lock" || { log "the lock file has no external entry"; return 1; }
  aws_before="$(awk '/^provider "registry.opentofu.org\/hashicorp\/aws"/,/^}/' "$lock")"
  push_tree "$work/tree" "$repo" main "app locks external 2.3.4 and aws 6.67.0" >/dev/null || return 1
  out="$(in_image "$work/tree" terragucci rollout --provider hashicorp/external 2.3.5 --mode "$mode" 2>&1)" || true
  echo "$out" >&2
  pr="$(branch_pr "$repo" "$branch")"
  [ -n "$pr" ] || { log "no pull request from $branch"; drop_work "$work"; return 1; }
  files="$(pr_files "$repo" "$pr")"
  [ "$files" = "app/.terraform.lock.hcl,app/main.tf" ] || { log "the pull request changes $files"; rc=1; }
  sha="$(remote_head "$repo" "$branch")"
  file_at "$repo" "$branch" "$sha" app/.terraform.lock.hcl > "$work/new.lock" || { log "cannot read the lock file on $branch"; rc=1; }
  awk '/^provider "registry.opentofu.org\/hashicorp\/external"/,/^}/' "$work/new.lock" | grep -q 'version *= "2.3.5"' || { log "external is not at 2.3.5 in the new lock file"; rc=1; }
  aws_after="$(awk '/^provider "registry.opentofu.org\/hashicorp\/aws"/,/^}/' "$work/new.lock")"
  [ "$aws_after" = "$aws_before" ] || { log "the aws entry of the lock file moved"; rc=1; }
  file_at "$repo" "$branch" "$sha" app/main.tf | grep -q 'version = "2.3.5"' || { log "the exact constraint of external did not move to 2.3.5"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "pull request $pr moves external to 2.3.5 in the lock file and its constraint, and leaves aws as it was"
  return $rc
}

claim_rollout_pins() {
  # A repo with two roots: dev/oci calls modules/network from an OCI registry
  # pinned ?tag=1.3.0, and dev/reg calls acme/network/aws from a registry with
  # version = "1.3.0". rollout modules/network 1.4.0 and rollout
  # acme/network/aws 1.4.0, each with --mode apply, open one pull request each:
  # the OCI source ends ?tag=1.4.0 and the registry call says version =
  # "1.4.0", each in the shape it had, and each changes its own root alone.
  # BREAK: the rollouts run as dry runs, so no pull request opens.
  log() { echo "[smoke rollout-pins] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout-pins" tree mode=apply out want pr name branch file line sha rc=0
  [ -n "${BREAK:-}" ] && mode=dry-run
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  rollout_repo rollout-pins || return 1
  tree="$work/tree"
  mkdir -p "$tree/dev/oci" "$tree/dev/reg"
  printf 'terraform {\n  backend "local" {}\n}\n\nmodule "network" {\n  source = "oci://registry.example.com/acme/modules/network?tag=1.3.0"\n  name   = "oci"\n}\n' > "$tree/dev/oci/main.tf"
  printf 'terraform {\n  backend "local" {}\n}\n\nmodule "network" {\n  source  = "acme/network/aws"\n  version = "1.3.0"\n  name    = "reg"\n}\n' > "$tree/dev/reg/main.tf"
  printf 'forge: forgejo\nbinary: tofu\nurl: %s/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' "$URL" "$repo" > "$tree/terragucci.yml"
  ( cd "$tree" && git init -q -b main && git remote add origin "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" ) || return 1
  push_tree "$tree" "$repo" main "two roots on two pin kinds" >/dev/null || return 1
  for want in "modules/network|terragucci/rollout/modules-network-1.4.0/wave-1|dev/oci/main.tf|source = \"oci://registry.example.com/acme/modules/network?tag=1.4.0\"" \
              "acme/network/aws|terragucci/rollout/acme-network-aws-1.4.0/wave-1|dev/reg/main.tf|version = \"1.4.0\""; do
    IFS='|' read -r name branch file line <<<"$want"
    out="$(cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout "$name" 1.4.0 --mode "$mode" 2>&1)" || true
    echo "$out" >&2
    pr="$(branch_pr "$repo" "$branch")"
    [ -n "$pr" ] || { log "$name: no pull request from $branch"; rc=1; continue; }
    [ "$(pr_files "$repo" "$pr")" = "$file" ] || { log "$name: the pull request changes $(pr_files "$repo" "$pr"), not $file"; rc=1; }
    sha="$(remote_head "$repo" "$branch")"
    file_at "$repo" "$branch" "$sha" "$file" | grep -qF "$line" || { log "$name: $file on $branch does not hold $line"; rc=1; }
  done
  drop_work "$work"
  [ $rc = 0 ] && log "the OCI tag and the registry version each moved to 1.4.0 in its own shape, one pull request each"
  return $rc
}

# ── policy engines and Terragrunt ─────────────────────────────────────────

claim_policy_opa() {
  # policy-wave with engine: opa: the same denial, warning and report as with
  # conftest. BREAK: as policy-wave, no policy is turned on.
  SMOKE_POLICY_ENGINE=opa SMOKE_POLICY_INPUT=plan claim_policy_wave
}

claim_policy_hcp() {
  # policy-wave with engine: opa and input: hcp, reading the HCP Terraform
  # policy in policy-hcp/ that names input.run.workspace.name. BREAK: as
  # policy-wave, no policy is turned on.
  SMOKE_POLICY_ENGINE=opa SMOKE_POLICY_INPUT=hcp claim_policy_wave
}

claim_policy_hcl() {
  # stack/fixtures/policy-wave with engine: opa, input: hcp and the policy set
  # in policy-hcl/: its policies.hcl names no_terraform_data mandatory and
  # probe_note advisory. The wave exits 1 and applies nothing; the report
  # denies app with the mandatory policy's message and carries the advisory
  # one as a warning, each named by its policy.
  # BREAK: policies.hcl marks no_terraform_data advisory too, so nothing
  # denies and the wave applies.
  log() { echo "[smoke policy-hcl] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" code=0 rc=0 r q
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$HERE/fixtures/policy-wave/." "$work/"
  printf 'policy:\n  engine: opa\n  path: policy-hcl\n  input: hcp\n' >> "$work/terragucci.yml"
  [ -n "${BREAK:-}" ] && sed -i.bak 's/enforcement_level = "mandatory"/enforcement_level = "advisory"/' "$work/policy-hcl/policies.hcl" && rm -f "$work/policy-hcl/policies.hcl.bak"
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke policy-hcl"
  run_copied --rm --network terragucci -v "$work:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >&2 || code=$?
  clean_mounted "$work" "$image"
  r="$work/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "the wave exited $code, not 1: the mandatory policy did not deny it"; rc=1; }
  if [ -f "$work/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$work/app/terraform.tfstate" >/dev/null 2>&1; then
    log "app has state: the wave applied it"; rc=1
  fi
  if [ ! -f "$r" ]; then
    log "the wave wrote no report"; rc=1
  else
    q='.roots[] | select(.path == "app")'
    jq -e "$q | .policy.result == \"denied\" and (.policy.denials | any(test(\"^no_terraform_data: terraform_data.probe: terraform_data is not allowed here\")))" "$r" >/dev/null \
      || { log "app is not denied by no_terraform_data: $(jq -c "$q | .policy" "$r")"; rc=1; }
    jq -e "$q | .policy.warnings | any(test(\"^probe_note: terraform_data.probe: a new resource, check its owner tag\"))" "$r" >/dev/null \
      || { log "the advisory policy probe_note is not a warning"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "policies.hcl: the mandatory policy denied the wave and the advisory one warned"
  return $rc
}

# The Terragrunt gated fixture as a local repo under STATE PREFIX, with
# terragucci.yml extra lines and the CI image's way of running a stage.
tg_fixture() { # dir, prefix, extra config
  mkdir -p "$1"
  cp -R "$HERE/fixtures/tg-gated-waves/." "$1/"
  find "$1" -name root.hcl -exec sed -i.bak "s#@PREFIX@#$2#" {} \;
  find "$1" -name '*.bak' -delete
  sed -i.bak 's/^gate: always$/gate: never/' "$1/terragucci.yml" && rm -f "$1/terragucci.yml.bak"
  [ -z "${3:-}" ] || printf '%s\n' "$3" >> "$1/terragucci.yml"
}

tg_fixture_stage() { # dir, docker run args (up to --), stage args...
  local dir="$1" code=0
  shift
  local -a extra=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do extra+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  run_copied --rm --network terragucci -v "$dir:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${extra[@]+"${extra[@]}"} "$(tg_image)" terragucci stage "$@" >&2 || code=$?
  clean_mounted "$dir"
  return $code
}

claim_tg_policy() {
  # The Terragrunt gated fixture with a policy that denies a terraform_data
  # whose input is "denied", and live/canary/one set to "denied". tf-plan
  # --terragrunt exits 1 with live/canary/one failed under policy and
  # live/fleet/two planned; the tf-apply wave 1, which holds live/canary/one,
  # exits 1 and leaves it with no state.
  # BREAK: live/canary/one keeps its value, so nothing is denied and the wave
  # applies it.
  log() { echo "[smoke tg-policy] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="tg-policy-$STAMP" code=0 r layers rc=0
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_fixture "$work/repo" "$prefix" "$(printf 'policy:\n  engine: conftest\n  path: policy')"
  mkdir -p "$work/repo/policy"
  printf 'package main\n\nimport rego.v1\n\ndeny contains msg if {\n  some rc in input.resource_changes\n  rc.type == "terraform_data"\n  rc.change.after.input == "denied"\n  msg := sprintf("%%s: this input is denied", [rc.address])\n}\n' > "$work/repo/policy/plan.rego"
  [ -n "${BREAK:-}" ] || echo denied > "$work/repo/live/canary/one/rev.txt"
  (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  layers="$(grep -o "tf-apply --wave 1 --layers '[^']*'" "$work/repo/.forgejo/workflows/terragucci.yml" | head -1 | sed "s/.*--layers '//; s/'$//")"
  [ -n "$layers" ] || { log "the pipeline names no layers"; drop_work "$work"; return 1; }
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke tg-policy"
  tg_fixture_stage "$work/repo" -- tf-plan --terragrunt --binary tofu --layers "$layers" || code=$?
  r="$work/repo/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "tf-plan exited $code, not 1"; rc=1; }
  if [ -f "$r" ]; then
    jq -e '.roots[] | select(.path == "live/canary/one" and .status == "failed" and .policy.result == "denied")' "$r" >/dev/null || { log "live/canary/one is not failed by the policy"; rc=1; }
    jq -e '.roots[] | select(.path == "live/fleet/two" and .status == "planned")' "$r" >/dev/null || { log "live/fleet/two did not plan"; rc=1; }
  else
    log "tf-plan wrote no report"; rc=1
  fi
  code=0
  rm -rf "$work/repo/terragucci-report"
  tg_fixture_stage "$work/repo" -- tf-apply --wave 1 --layers "$layers" --binary tofu --gate never --terragrunt || code=$?
  [ "$code" = 1 ] || { log "the wave exited $code, not 1"; rc=1; }
  [ -z "$(tg_gated_applied "$prefix")" ] || { log "the denied wave applied: $(tg_gated_applied "$prefix")"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the denied unit failed tf-plan, and its wave applied nothing"
  return $rc
}

claim_tg_credentials() {
  # The Terragrunt gated fixture with terragrunt.credentials naming one role
  # pair for live/canary/** and another for live/fleet/**, and live/fleet/three
  # setting its own iam_role. init puts the plan roles in the plan job's auth
  # provider. tf-plan runs with that environment and an STS stand-in: the
  # stand-in is asked for the canary plan role, the fleet plan role and the
  # own role of live/fleet/three, each with the job token.
  # BREAK: the role map is empty, so only the own role of live/fleet/three is
  # asked for.
  log() { echo "[smoke tg-credentials] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="tg-cred-$STAMP" name="tgs-sts-$STAMP" roles got want rc=0 arn=arn:aws:iam::000000000000:role
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_fixture "$work/repo" "$prefix" "$(printf 'terragrunt:\n  credentials:\n    "live/canary/**": { plan: %s/canary-plan, apply: %s/canary-apply }\n    "live/fleet/**": { plan: %s/fleet-plan, apply: %s/fleet-apply }' "$arn" "$arn" "$arn" "$arn")"
  printf '\niam_role = "%s/three-own"\n' "$arn" >> "$work/repo/live/fleet/three/terragrunt.hcl"
  (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  roles="[[\"live/canary/**\",\"$arn/canary-plan\"],[\"live/fleet/**\",\"$arn/fleet-plan\"]]"
  grep -qF "TERRAGUCCI_PHASE=plan TERRAGUCCI_TG_ROLES='$roles'" "$work/repo/.forgejo/workflows/terragucci.yml" \
    || { log "the plan job does not hand the auth provider the plan roles"; rc=1; }
  [ -n "${BREAK:-}" ] && roles='[]'
  printf '%s' 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOnNtb2tlL3RnOnB1bGxfcmVxdWVzdCJ9.c21va2U' > "$work/repo/.oidc-token"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke tg-credentials"
  [ $rc = 0 ] && { stand_in_up "$work" "$name" 8791 MODE=sts || rc=1; }
  if [ $rc = 0 ]; then
    tg_fixture_stage "$work/repo" -e AWS_WEB_IDENTITY_TOKEN_FILE=/repo/.oidc-token -e TERRAGUCCI_REPO=/repo -e TERRAGUCCI_PHASE=plan \
      -e "TERRAGUCCI_TG_ROLES=$roles" -e "TG_AUTH_PROVIDER_CMD=terragucci auth-provider" -e TG_IAM_ASSUME_ROLE_WEB_IDENTITY_TOKEN=/repo/.oidc-token \
      -e "AWS_ENDPOINT_URL_STS=http://$name:8791" -- tf-plan --terragrunt --binary tofu || log "tf-plan exited non-zero"
    got="$(curl -fsS "$STANDIN_CTL/_requests" | jq -r '[.[] | select(.form.Action == "AssumeRoleWithWebIdentity") | .form.RoleArn] | unique | join(",")')"
    want="$arn/canary-plan,$arn/fleet-plan,$arn/three-own"
    log "the units asked STS for: ${got:-nothing}"
    [ "$got" = "$want" ] || { log "the roles asked for are not $want"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "live/canary/one and live/fleet/two assumed the plan roles of their globs, and live/fleet/three its own iam_role"
  return $rc
}

claim_tg_dependents() {
  # The Terragrunt gated fixture with live/fleet/two depending on
  # live/canary/one, a fourth unit under live/sandbox, and terragrunt.exclude
  # leaving live/sandbox/** out. A change to live/canary/one and to the
  # sandbox unit is planned twice against the base: with dependents: plan,
  # live/fleet/two is previewed, provisional and deferred; with
  # dependents: follow it is not planned; both runs have the same set
  # digests, and neither plans the sandbox unit.
  # BREAK: the first run also has dependents: follow, so nothing is previewed.
  log() { echo "[smoke tg-dependents] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="tg-dep-$STAMP" dir mode base r1 r2 rc=0 i
  local -a dep_modes=(plan follow)
  [ -n "${BREAK:-}" ] && dep_modes=(follow follow)
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  for i in 1 2; do
    dir="$work/run$i"; mode="${dep_modes[$((i - 1))]}"
    tg_fixture "$dir" "$prefix" "$(printf 'terragrunt:\n  exclude: ["live/sandbox/**"]\n  dependents: %s' "$mode")" || return 1
    printf '\ndependencies {\n  paths = ["../../canary/one"]\n}\n' >> "$dir/live/fleet/two/terragrunt.hcl"
    mkdir -p "$dir/live/sandbox/four"
    cp "$dir/live/fleet/three/terragrunt.hcl" "$dir/live/sandbox/four/"
    echo 1 > "$dir/live/sandbox/four/rev.txt"
    git -C "$dir" init -q -b main
    git -C "$dir" add -A && git -C "$dir" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm base
    base="$(git -C "$dir" rev-parse HEAD)"
    echo 2 > "$dir/live/canary/one/rev.txt"
    echo 2 > "$dir/live/sandbox/four/rev.txt"
    git -C "$dir" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "change canary/one and the sandbox"
    tg_fixture_stage "$dir" -e "TG_BASE=$base" -- tf-plan --terragrunt --binary tofu || log "dependents: $mode: tf-plan exited non-zero"
  done
  r1="$work/run1/terragucci-report/report.json"
  r2="$work/run2/terragucci-report/report.json"
  [ -f "$r1" ] && [ -f "$r2" ] || { log "a run wrote no report"; drop_work "$work"; return 1; }
  jq -e '.roots[] | select(.path == "live/canary/one" and .status == "planned" and (.terragrunt.provisional | not))' "$r1" >/dev/null || { log "live/canary/one is not a real plan"; rc=1; }
  jq -e '.roots[] | select(.path == "live/fleet/two" and .terragrunt.provisional == true)' "$r1" >/dev/null || { log "dependents: plan did not preview live/fleet/two as provisional"; rc=1; }
  jq -e '.deferred[] | select(.unit == "live/fleet/two" and .previewed == true)' "$r1" >/dev/null || { log "live/fleet/two is not deferred and previewed"; rc=1; }
  jq -e '[.roots[] | select(.path == "live/fleet/two")] | length == 0' "$r2" >/dev/null || { log "dependents: follow planned live/fleet/two"; rc=1; }
  [ "$(jq -c '[.waves[]?.set_digest]' "$r1")" = "$(jq -c '[.waves[]?.set_digest]' "$r2")" ] || { log "the preview changed a set digest"; rc=1; }
  jq -e '[.roots[] | select(.path | startswith("live/sandbox"))] | length == 0' "$r1" >/dev/null || { log "the excluded sandbox unit was planned"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "dependents: plan previewed live/fleet/two outside every digest, follow left it for later, and the excluded unit never planned"
  return $rc
}

# ── binary: terraform ─────────────────────────────────────────────────────

claim_tf_terraform() {
  # The gated fixture with binary: terraform, so init writes the pipeline in
  # the terragucci-terraform image. A pull request that changes fleet/two
  # gets a passing terragucci/plan; the push to main passes check and waits
  # at wave 1; approved, the next push applies canary/one with Terraform,
  # whose state says terraform_version 1.14.9.
  # BREAK: the pushed pipeline runs in the tofu image, which has no
  # terraform, so nothing plans or applies.
  log() { echo "[smoke tf-terraform] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tf-terraform" wf sha head pr jobs version rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tf-terraform || { drop_work "$work"; return 1; }
  sed -i.bak 's/^binary: tofu$/binary: terraform/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q 'ghcr.io/intentius/terragucci-terraform:' "$wf" || { log "the pipeline does not run in the terraform image"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak "s#ghcr.io/intentius/terragucci-terraform:[^ \"']*#$(image_tag tofu)#g" "$wf" && rm -f "$wf.bak"
  fi
  sha="$(push_tree "$work/tree" "$repo" main "tf-terraform: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
  log "the first push ran: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
  [ "$(jq -r '.[] | select(.name == "check") | .status' <<<"$jobs")" = success ] || { log "check did not pass with terraform"; rc=1; }
  [ -z "$(gated_applied tf-terraform)" ] || { log "a root applied before wave 1 was approved"; rc=1; }
  run_logs "$repo" "$RUN_ID" | grep -q "chant approve tf-apply wave-1" || { log "wave 1 did not wait for its approval"; rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/fleet/two/rev.txt"
    head="$(push_tree "$work/tree" "$repo" change "tf-terraform: change fleet/two")" || rc=1
    git -C "$work/tree" checkout -q main
    echo 1 > "$work/tree/fleet/two/rev.txt"
  fi
  if [ $rc = 0 ]; then
    pr="$(pr_open "$repo" change "tf-terraform: change fleet/two")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
    [ $rc = 0 ] && { [ "$(context_state "$repo" "$head" terragucci/plan)" = success ] || { log "terragucci/plan did not pass on pull request $pr"; rc=1; }; }
  fi
  [ $rc = 0 ] && { gated_approve tf-terraform 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "tf-terraform: after wave 1 was approved")"
    wait_run "$repo" "$sha" || rc=1
    [ "$(gated_applied tf-terraform)" = "canary/one " ] || { log "canary/one did not apply alone: $(gated_applied tf-terraform)"; rc=1; }
    version="$(curl -fsS "$FLOCI/shop-terraform-state/tf-terraform/canary/one.tfstate" 2>/dev/null | jq -r '.terraform_version // empty')"
    log "canary/one state written by version ${version:-none}"
    [ "$version" = 1.14.9 ] || { log "Terraform 1.14.9 did not write the state of canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "with binary: terraform, check and the plan passed, wave 1 waited, and its approval applied canary/one with Terraform 1.14.9"
  return $rc
}

# The state of the latest status of a context on a commit, or none.
context_state() { # repo, sha, context
  api "$URL/api/v1/repos/$1/commits/$2/statuses?limit=50" 2>/dev/null \
    | jq -r --arg c "$3" '[.[] | select(.context == $c)] | sort_by(.id) | last | if . == null then "none" else (.status // .state) end' 2>/dev/null || echo none
}

claim_tg_terraform() {
  # The Terragrunt gated fixture with binary: terraform and gate: never. The
  # pipeline installs Terraform beside Terragrunt and the push to main
  # applies every unit; each unit's state says terraform_version 1.14.9.
  # BREAK: binary stays tofu, so OpenTofu writes the state.
  log() { echo "[smoke tg-terraform] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-terraform" wf sha unit version rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-terraform tg-gated-waves || { drop_work "$work"; return 1; }
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  [ -n "${BREAK:-}" ] || { sed -i.bak 's/^binary: tofu$/binary: terraform/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -z "${BREAK:-}" ]; then
    # shellcheck disable=SC2016 # the step's own text
    grep -qF 'dir="$(terragucci install terraform 1.14.9)"' "$wf" || { log "the pipeline does not install Terraform"; rc=1; }
  fi
  sha="$(push_tree "$work/tree" "$repo" main "tg-terraform: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  log "the push ended $RUN_STATUS; units with state: $(tg_gated_applied tg-terraform)"
  [ "$(tg_gated_applied tg-terraform)" = "live/canary/one live/fleet/three live/fleet/two " ] || { log "not every unit applied"; rc=1; }
  for unit in live/canary/one live/fleet/two live/fleet/three; do
    version="$(curl -fsS "$FLOCI/shop-terraform-state/tg-terraform/$unit/terraform.tfstate" 2>/dev/null | jq -r '.terraform_version // empty')"
    [ "$version" = 1.14.9 ] || { log "$unit state was written by ${version:-nothing}, not Terraform 1.14.9"; rc=1; }
  done
  drop_work "$work"
  [ $rc = 0 ] && log "Terragrunt ran Terraform 1.14.9, installed in the job, and applied every unit"
  return $rc
}

claim_tfquery_import() {
  # A root with binary: terraform and a roles.tfquery.hcl listing IAM roles,
  # and a role made in floci by hand that the state does not hold. respond
  # drift --mode apply, in the terraform image, runs terraform query and
  # opens the drift pull request with generated config that names the role.
  # BREAK: the root has no .tfquery.hcl, so nothing is imported and no pull
  # request opens.
  log() { echo "[smoke tfquery-import] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tfquery-import" role="tg-query-$STAMP" out pr sha rc=0
  local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" image
  image="$(image_tag terraform)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo tfquery-import || return 1
  respond_tree "$work" "$repo" "$(respond_root "respond/tfquery-$STAMP.tfstate" "")"
  rm -f "$work/tree/app/.terraform.lock.hcl"
  sed -i.bak 's/^binary: tofu$/binary: terraform/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  [ -n "${BREAK:-}" ] || printf 'list "aws_iam_role" "all" {\n  provider = aws\n}\n' > "$work/tree/app/roles.tfquery.hcl"
  push_tree "$work/tree" "$repo" main "a root that lists IAM roles" >/dev/null || return 1
  curl -fsS -o /dev/null -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode Action=CreateRole --data-urlencode Version=2010-05-08 --data-urlencode "RoleName=$role" \
    --data-urlencode 'AssumeRolePolicyDocument={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    || { log "floci did not make IAM role $role"; return 1; }
  out="$(run_copied --rm --network terragucci -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e "TERRAGUCCI_FORGEJO_TOKEN=$TOKEN" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci respond drift --root app --mode apply 2>&1)" || true
  echo "$out" >&2
  clean_mounted "$work/tree"
  pr="$(open_pr "$repo" terragucci/drift)"
  if [ -z "$pr" ]; then
    log "no drift pull request"; rc=1
  else
    sha="$(remote_head "$repo" terragucci/drift)"
    file_at "$repo" terragucci/drift "$sha" app/terragucci_generated.tf | grep -q "$role" || { log "the generated config does not name $role"; rc=1; }
  fi
  curl -s -o /dev/null -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode Action=DeleteRole --data-urlencode Version=2010-05-08 --data-urlencode "RoleName=$role" || true
  drop_work "$work"
  [ $rc = 0 ] && log "terraform query listed $role, and pull request $pr imports it with generated config"
  return $rc
}

# ── alerts and SLOs ───────────────────────────────────────────────────────

claim_alerts_fire() {
  # init with dashboards drift_age, wave_wait and schedule at 10s writes the
  # alert rules; a Prometheus of the claim loads them and scrapes the stack's
  # collector. Runs of one project each: a wave that waits, a drift run that
  # finds a changed queue and opens its drift issue on a scratch repo, an
  # apply that fails twice, and a wave refused after its approval. TerragucciWaveWaiting, TerragucciDriftOld,
  # TerragucciDriftStopped, TerragucciApplyFailed, TerragucciWaveRefused and
  # ErrorBudgetBurn for apply success fire, and the apply-success and
  # drift-corrected SLOs record.
  # BREAK: init keeps the default thresholds (1d, 4h and 2d), so the three
  # alerts on age never fire.
  log() { echo "[smoke alerts-fire] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  dash_up || { log "the observability profile did not start"; return 1; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" prom name="tgs-prom-$STAMP" hostport promurl i q got rc=0 code
  local queue="tg-alerts-$STAMP" url digest clone dash='dashboards:\n  dir: obs\n  drift_age: 10s\n  wave_wait: 10s\n  schedule: 10s\n'
  [ -n "${BREAK:-}" ] && dash='dashboards:\n  dir: obs\n'
  image="$(image_tag tofu)"
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # The rules init writes, in a Prometheus of their own.
  mkdir -p "$work/rules-repo/app"
  printf 'terraform {\n  backend "local" {}\n}\n' > "$work/rules-repo/app/main.tf"
  # shellcheck disable=SC2059 # the format holds the dashboards block
  printf "forge: forgejo\nbinary: tofu\n$dash" > "$work/rules-repo/terragucci.yml"
  (cd "$work/rules-repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  mkdir -p "$work/prom/rules"
  cp "$work/rules-repo/obs/prometheus/terragucci.rules.yml" "$work/prom/rules/" || { log "init wrote no rules file"; drop_work "$work"; return 1; }
  printf 'global:\n  scrape_interval: 5s\n  evaluation_interval: 5s\nrule_files:\n  - /prom/rules/*.yml\nscrape_configs:\n  - job_name: otel-collector\n    static_configs:\n      - targets: [otel-collector:8889]\n' > "$work/prom/prometheus.yml"
  prom="$(grep -o 'prom/prometheus:[^ ]*' "$HERE/docker-compose.yml" | head -1)"
  STANDIN="$(run_copied -d --name "$name" --network terragucci -p 127.0.0.1::9090 -v "$work/prom:/prom:ro" "$prom" \
    --config.file=/prom/prometheus.yml)" || { log "the Prometheus of the claim did not start"; drop_work "$work"; return 1; }
  hostport="$(docker port "$STANDIN" 9090/tcp | head -1 | sed 's/.*://')"
  promurl="http://127.0.0.1:$hostport"
  for i in $(seq 1 30); do curl -fsS -o /dev/null "$promurl/-/ready" 2>/dev/null && break; sleep 1; done
  # One project per signal, each its own repo and ledger.
  signal() { # name, main.tf body -> $work/<name> committed, with /origin.git
    mkdir -p "$work/$1/app"
    printf '%s\n' "$2" > "$work/$1/app/main.tf"
    cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$work/$1/app/"
    printf 'binary: tofu\n' > "$work/$1/terragucci.yml"
    git init -q --bare "$work/$1.git"
    git -C "$work/$1" init -q -b main
    git -C "$work/$1" add -A && git -C "$work/$1" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke alerts $1"
    git -C "$work/$1" remote add origin /origin.git
  }
  stage() { # name, stage args...
    local n="$1"
    shift
    run_copied --rm --network terragucci -v "$work/$n:/repo" -v "$work/$n.git:/origin.git" -w /repo \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e "OTEL_EXPORTER_OTLP_ENDPOINT=$OTLP_ENDPOINT" -e GITHUB_SERVER_URL=http://smoke.local -e "GITHUB_REPOSITORY=alerts/$n-$STAMP" \
      ${ALERT_ENV[@]+"${ALERT_ENV[@]}"} "$image" terragucci stage "$@" >&2
    local c=$?
    clean_mounted "$work/$n"
    return $c
  }
  local tf='terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
  backend "local" {}
}

provider "aws" {
  region = "us-east-1"
}
'
  signal wait "$tf"'resource "terraform_data" "w" {
  input = "waits"
}'
  signal fail "$tf"'resource "terraform_data" "f" {
  input = "fails"

  provisioner "local-exec" {
    command = "exit 1"
  }
}'
  signal refused "$tf"'resource "terraform_data" "r" {
  input = "first"
}'
  signal drift "$tf""resource \"aws_sqs_queue\" \"q\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
}"
  code=0; stage wait tf-apply --wave 1 --layers app --binary tofu --gate always || code=$?
  [ "$code" = 3 ] || { log "the wave of wait did not wait (exit $code)"; rc=1; }
  for i in 1 2; do
    code=0; stage fail tf-apply --wave 1 --layers app --binary tofu --gate never || code=$?
    [ "$code" != 0 ] || { log "the apply of fail did not fail"; rc=1; }
    sleep 6
  done
  # refused: wait, approve the digest on the ledger, change the plan, run again.
  code=0; stage refused tf-apply --wave 1 --layers app --binary tofu --gate always || code=$?
  [ "$code" = 3 ] || { log "the wave of refused did not wait (exit $code)"; rc=1; }
  clone="$work/refused-ledger"
  if git clone -q -b chant/lifecycle "$work/refused.git" "$clone" 2>/dev/null; then
    digest="$(jq -rs '[.[] | select(.kind == "pending" and .gate == "wave-1")] | last | .planDigest' "$clone/_gates/tf-apply.jsonl")"
    sleep 1
    printf '%s\n' "$(jq -cn --arg d "$digest" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "smoke-approver", timestamp: $t, planDigest: $d}')" >> "$clone/_gates/tf-apply.jsonl"
    { git -C "$clone" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "approve wave-1" && git -C "$clone" push -q origin chant/lifecycle; } || { log "could not approve wave-1 of refused"; rc=1; }
  else
    log "refused recorded no ledger"; rc=1
  fi
  sed -i.bak 's/input = "first"/input = "moved"/' "$work/refused/app/main.tf" && rm -f "$work/refused/app/main.tf.bak"
  git -C "$work/refused" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "the plan moves after its approval"
  code=0; stage refused tf-apply --wave 1 --layers app --binary tofu --gate always || code=$?
  [ "$code" = 4 ] || { log "the wave of refused was not refused (exit $code)"; rc=1; }
  # drift: apply the queue, change its timeout in floci, run tf-drift.
  run_copied --rm --network terragucci -v "$work/drift:/repo" -w /repo/app -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 \
    || { log "the queue of drift did not apply"; rc=1; }
  clean_mounted "$work/drift"
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] && sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null
  # The drift issue is what gives drift its age, so this run keeps one on a repo of its own.
  if fresh_repo alerts-drift; then
    local -a ALERT_ENV=(-e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "GITHUB_REPOSITORY=$USER/alerts-drift" -e "TG_TOKEN=$TOKEN")
    stage drift tf-drift --forge forgejo --layers app || true
    ALERT_ENV=()
  else
    rc=1
  fi
  # Prometheus evaluates every 5s; the age alerts need 10s past their stamps.
  alert() { # alertname, label, value -> 0 once firing
    curl -fsS -G "$promurl/api/v1/query" --data-urlencode "query=ALERTS{alertname=\"$1\",alertstate=\"firing\",$2=\"$3\"}" | jq -e '.data.result | length > 0' >/dev/null 2>&1
  }
  local -a want=("TerragucciWaveWaiting|project|smoke.local/alerts/wait-$STAMP" "TerragucciDriftOld|project|forgejo:3000/$USER/alerts-drift"
    "TerragucciDriftStopped|project|forgejo:3000/$USER/alerts-drift" "TerragucciApplyFailed|terragucci_project|smoke.local/alerts/fail-$STAMP"
    "TerragucciWaveRefused|terragucci_project|smoke.local/alerts/refused-$STAMP" "ErrorBudgetBurn|slo|terragucci-apply-success")
  local w left
  for i in $(seq 1 36); do
    left=""
    for w in "${want[@]}"; do
      IFS='|' read -r q got hostport <<<"$w"
      alert "$q" "$got" "$hostport" || left="$left $q"
    done
    [ -z "$left" ] && break
    sleep 5
  done
  [ -z "$left" ] || { log "not firing after 3 minutes:$left"; rc=1; }
  # Each SLO records from its shortest window: 5m for apply success, 2h for
  # drift corrected. The 2h window samples every 5m on the clock, so it
  # records at the first 5-minute mark after the drift run, within 5 minutes.
  for q in terragucci-apply-success:5m terragucci-drift-corrected:2h; do
    for i in $(seq 1 72); do
      curl -fsS -G "$promurl/api/v1/query" --data-urlencode "query=slo:sli_error:ratio_rate${q#*:}{slo=\"${q%:*}\"}" | jq -e '.data.result | length > 0' >/dev/null 2>&1 && break
      [ "$i" = 72 ] && { log "the ${q%:*} SLO records nothing in its ${q#*:} window"; rc=1; }
      sleep 5
    done
  done
  [ -n "$url" ] && sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "every alert init writes fired on its signal with short thresholds, and the apply-success and drift-corrected SLOs record"
  return $rc
}

# ── report stores: key credentials and index writes ──────────────────────

claim_blob_gcs_key() {
  # reports.bucket is gs://<bucket> on fake-gcs-server, and the job has a
  # service_account key file in GOOGLE_APPLICATION_CREDENTIALS and nothing
  # else. tf-plan writes the report and both indexes; terragucci estate
  # writes the page and prints a V4 signed URL that verifies with the public
  # half of the key, and the emulator serves it.
  # BREAK: one character of the signature changes, so it does not verify.
  log() { echo "[smoke blob-gcs-key] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image port="${TERRAGUCCI_GCS_PORT:-4453}" name=blob-gcs-key bucket sa=terragucci-plan@smoke-project.iam.gserviceaccount.com
  local out link served path rc=0 i sig flip
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/stub"
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name terragucci --profile blob up -d gcs >&2 || { drop_work "$work"; return 1; }
  gcs() { curl -sS -H 'Host: gcs:4443' "$@"; }
  for i in $(seq 1 30); do gcs -f -o /dev/null "http://localhost:$port/_internal/healthcheck" 2>/dev/null && break; sleep 1; done
  bucket="tg-key-$(date +%s)"
  gcs -f -o /dev/null -X POST -H 'content-type: application/json' -d "{\"name\":\"$bucket\"}" "http://localhost:$port/storage/v1/b?project=smoke-project" \
    || { log "fake-gcs-server did not make bucket $bucket"; drop_work "$work"; return 1; }
  openssl genrsa -out "$work/sa.pem" 2048 >/dev/null 2>&1 || { log "openssl could not make a key"; drop_work "$work"; return 1; }
  openssl rsa -in "$work/sa.pem" -pubout -out "$work/sa.pub" >/dev/null 2>&1
  jq -n --arg k "$(cat "$work/sa.pem")" --arg e "$sa" '{type: "service_account", project_id: "smoke-project", private_key_id: "smoke", private_key: $k, client_email: $e, client_id: "1", token_uri: "https://oauth2.googleapis.com/token"}' > "$work/stub/key.json"
  printf 'import { writeFileSync } from "node:fs";\nwriteFileSync("/stub/ready", "1");\n' > "$work/stub/none.mjs"
  blob_project "$work" "$name" "$(printf 'reports:\n  bucket: gs://%s\n  endpoint: http://gcs:4443\n  prefix: reports' "$bucket")"
  local -a BLOB_ENV=(-e GOOGLE_APPLICATION_CREDENTIALS=/stub/key.json)
  blob_run "$work" "$name" "$image" none.mjs terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/$name" "$image"
  obj() { gcs "http://localhost:$port/storage/v1/b/$bucket/o/$(jq -rn --arg k "$1" '$k | @uri')?alt=media"; }
  if [ $rc = 0 ]; then
    path="$(obj "reports/$name/index.json" | jq -r '.reports[0].path // empty')"
    [ -n "$path" ] || { log "no row in reports/$name/index.json"; rc=1; }
    [ "$(obj reports/index.json | jq -r '[.reports[].project] | join(",")')" = "$name" ] || { log "the top index does not list $name"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    : >"$work/stub/ready"
    out="$(blob_run "$work" "$name" "$image" none.mjs terragucci estate --bucket "gs://$bucket" --bucket-endpoint http://gcs:4443 --bucket-prefix reports --link-hours 1)" || { log "terragucci estate failed"; rc=1; }
    printf '%s\n' "$out" >&2
    link="$(grep -E "^http://gcs:4443/$bucket/reports/estate.html\\?X-Goog-Algorithm=GOOG4-RSA-SHA256&" <<<"$out" | head -1)"
    [ -n "$link" ] || { log "the command printed no signed URL"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    sig="${link##*X-Goog-Signature=}"
    flip=0; [ "${sig:0:1}" = 0 ] && flip=1
    link="${link%X-Goog-Signature=*}X-Goog-Signature=$flip${sig:1}"
  fi
  if [ $rc = 0 ]; then
    node -e '
      const { createHash, createVerify, readFileSync } = { ...require("node:crypto"), ...require("node:fs") };
      const u = new URL(process.argv[1]);
      const query = u.search.slice(1).replace(/&X-Goog-Signature=.*$/, "");
      const stamp = u.searchParams.get("X-Goog-Date");
      const canonical = ["GET", u.pathname, query, "host:" + u.host, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
      const toSign = ["GOOG4-RSA-SHA256", stamp, stamp.slice(0, 8) + "/auto/storage/goog4_request", createHash("sha256").update(canonical).digest("hex")].join("\n");
      process.exit(createVerify("RSA-SHA256").update(toSign).verify(readFileSync(process.argv[2], "utf-8"), Buffer.from(u.searchParams.get("X-Goog-Signature"), "hex")) ? 0 : 1);
    ' "$link" "$work/sa.pub" || { log "the signature of the link does not verify with the public half of the key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    served="$(gcs -f "http://localhost:$port${link#http://gcs:4443}")" || { log "the emulator did not serve the link"; rc=1; }
    [ $rc = 0 ] && { grep -q "$name" <<<"$served" || { log "the link does not serve the page with $name on it"; rc=1; }; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "with only a service account key file the job wrote the report, both indexes and the page to $bucket, and the link is signed with the key"
  return $rc
}

claim_blob_azure_key() {
  # reports.bucket is az://devstoreaccount1/<container> on Azurite, and the
  # job has the account key in AZURE_STORAGE_KEY and no OIDC identity.
  # tf-plan writes the report and both indexes with Shared Key; terragucci
  # estate writes the page and prints a service SAS signed with the account
  # key, which Azurite serves.
  # BREAK: one character of the link signature changes, and Azurite refuses it.
  log() { echo "[smoke blob-azure-key] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image port="${TERRAGUCCI_AZURITE_PORT:-10010}" certs="$HERE/.state/azurite-certs" name=blob-azure-key container
  local key='Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==' tenant=7d2c0b4e-0000-4000-8000-00000000a2e1
  local now jwt out link served path rc=0 i code
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$certs" "$work/newcerts" "$work/stub"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:azurite,IP:127.0.0.1" \
    -keyout "$work/newcerts/azurite.key" -out "$work/newcerts/azurite.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; drop_work "$work"; return 1; }
  cat "$work/newcerts/azurite.key" >"$certs/azurite.key"
  cat "$work/newcerts/azurite.crt" >"$certs/azurite.crt"
  chmod 644 "$certs/azurite.key"
  cp "$certs/azurite.crt" "$work/stub/ca.crt"
  with_lock compose env TERRAGUCCI_AZURITE_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile blob up -d --force-recreate azurite >&2 || { drop_work "$work"; return 1; }
  # The claim reads Azurite with a token Azurite takes, as blob-azure does; the job has only the key.
  now="$(date +%s)"
  jwt="$(blob_jwt "{\"aud\":\"https://storage.azure.com\",\"iss\":\"https://sts.windows.net/$tenant/\",\"iat\":$((now - 60)),\"nbf\":$((now - 60)),\"exp\":$((now + 3600)),\"oid\":\"smoke\",\"tid\":\"$tenant\"}")"
  azr() { curl -sS --cacert "$certs/azurite.crt" -H "Authorization: Bearer $jwt" -H 'x-ms-version: 2021-08-06' "$@"; }
  for i in $(seq 1 30); do
    [ "$(azr -o /dev/null -w '%{http_code}' "https://localhost:$port/devstoreaccount1?comp=list" 2>/dev/null)" = 200 ] && break
    sleep 1
  done
  container="tg-key-$(date +%s)"
  code="$(azr -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Length: 0' "https://localhost:$port/devstoreaccount1/$container?restype=container" 2>/dev/null)" || true
  [ "$code" = 201 ] || { log "Azurite did not make container $container ($code)"; drop_work "$work"; return 1; }
  printf 'import { writeFileSync } from "node:fs";\nwriteFileSync("/stub/ready", "1");\n' > "$work/stub/none.mjs"
  blob_project "$work" "$name" "$(printf 'reports:\n  bucket: az://devstoreaccount1/%s\n  endpoint: https://azurite:10000/devstoreaccount1\n  prefix: reports' "$container")"
  local -a BLOB_ENV=(-e "AZURE_STORAGE_KEY=$key" -e NODE_EXTRA_CA_CERTS=/stub/ca.crt)
  blob_run "$work" "$name" "$image" none.mjs terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/$name" "$image"
  if [ $rc = 0 ]; then
    path="$(azr "https://localhost:$port/devstoreaccount1/$container/reports/$name/index.json" | jq -r '.reports[0].path // empty')"
    [ -n "$path" ] || { log "no row in reports/$name/index.json"; rc=1; }
    [ "$(azr "https://localhost:$port/devstoreaccount1/$container/reports/index.json" | jq -r '[.reports[].project] | join(",")')" = "$name" ] || { log "the top index does not list $name"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    : >"$work/stub/ready"
    out="$(blob_run "$work" "$name" "$image" none.mjs terragucci estate --bucket "az://devstoreaccount1/$container" --bucket-endpoint https://azurite:10000/devstoreaccount1 --bucket-prefix reports --link-hours 1)" || { log "terragucci estate failed"; rc=1; }
    printf '%s\n' "$out" >&2
    link="$(grep -E '^https://azurite:10000/devstoreaccount1/' <<<"$out" | head -1)"
    grep -q 'sig=' <<<"$link" || { log "the command printed no SAS link"; rc=1; }
    grep -q 'skoid=' <<<"$link" && { log "the link is a user delegation SAS, not one signed with the account key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ -n "${BREAK:-}" ] && link="${link/sig=/sig=A}"
    served="$(curl -sS --cacert "$certs/azurite.crt" -w '\n%{http_code}' "https://localhost:$port${link#https://azurite:10000}")" || true
    [ "$(tail -1 <<<"$served")" = 200 ] || { log "Azurite refused the link ($(tail -1 <<<"$served"))"; rc=1; }
    [ $rc = 0 ] && { grep -q "$name" <<<"$served" || { log "the link does not serve the page with $name on it"; rc=1; }; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "with only the account key the job wrote the report, both indexes and the page to $container, and the key-signed link served it"
  return $rc
}

claim_index_writes() {
  # Two projects plan at once through an S3 stand-in in front of floci that
  # holds the first two PUTs of the top index.json and sends them together,
  # so both writers read the same index: one conditional write lands, the
  # other is refused and retried, and the top index lists both projects.
  # Then a third project plans through a stand-in that answers 501 to a
  # conditional index write: it drops the condition and its row lands.
  # BREAK: the first stand-in drops If-Match and If-None-Match, as a store
  # that ignores them would, so the second write overwrites the first.
  log() { echo "[smoke index-writes] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="index-writes-$STAMP" name="tgs-s3-$STAMP" p rc=0 index pids=() strip=()
  [ -n "${BREAK:-}" ] && strip=(STRIP=1)
  docker image inspect "$(image_tag tofu)" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  index_plan() { # project dir, endpoint
    run_copied --rm --network terragucci -v "$work/$1:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' -e GITHUB_SERVER_URL=http://smoke.local -e "GITHUB_REPOSITORY=index/$1" \
      "$(image_tag tofu)" terragucci stage tf-plan --layers app > "$work/$1.log" 2>&1
  }
  for p in race-a race-b fallback; do
    estate_project "$work/$p" "$(printf '  bucket: s3://%s\n  endpoint: http://%s:4566\n  prefix: %s' "$REPORT_BUCKET" "$name" "$prefix")"
  done
  stand_in_up "$work" "$name" 4566 MODE=s3 UPSTREAM=floci:4566 "HOLD_PATH=/$REPORT_BUCKET/$prefix/index.json" ${strip[@]+"${strip[@]}"} || { stand_in_down; drop_work "$work"; return 1; }
  index_plan race-a & pids+=($!)
  index_plan race-b & pids+=($!)
  for p in "${pids[@]}"; do wait "$p" || true; done
  cat "$work/race-a.log" "$work/race-b.log" | grep -E 'index|copied' >&2 || true
  curl -fsS "$STANDIN_CTL/_requests" | jq -r --arg p "/$REPORT_BUCKET/$prefix/index.json" '.[] | select(.method == "PUT" and .path == $p) | "[smoke index-writes]   PUT top index: \(.status) \(.cond)"' >&2 || true
  index="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" 2>/dev/null || true)"
  [ "$(jq -r '[.reports[].project] | unique | join(",")' <<<"$index" 2>/dev/null)" = "smoke.local/index/race-a,smoke.local/index/race-b" ] \
    || { log "the top index lists $(jq -c '[.reports[].project]' <<<"$index" 2>/dev/null || echo nothing), not both projects"; rc=1; }
  stand_in_down
  if [ $rc = 0 ]; then
    stand_in_up "$work" "$name-501" 4566 MODE=s3 UPSTREAM=floci:4566 ANSWER_501=1 || rc=1
    if [ $rc = 0 ]; then
      sed -i.bak "s#http://$name:4566#http://$name-501:4566#" "$work/fallback/terragucci.yml" && rm -f "$work/fallback/terragucci.yml.bak"
      git -C "$work/fallback" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "the 501 stand-in"
      index_plan fallback || true
      curl -fsS "$STANDIN_CTL/_requests" | jq -e '[.[] | select(.status == 501)] | length > 0' >/dev/null || { log "the stand-in answered no conditional write with 501"; rc=1; }
      index="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" 2>/dev/null || true)"
      jq -e '[.reports[].project] | index("smoke.local/index/fallback")' <<<"$index" >/dev/null 2>&1 || { log "after a 501 the row of fallback did not land"; rc=1; }
    fi
    stand_in_down
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "two writers that read the same index both landed, and a store that answers 501 got the row without the condition"
  return $rc
}

claim_cdf_shared_bucket() {
  # Two choudoufu estates in one record store bucket, applied by one tf-apply
  # wave of one repo: root a is estate <name>, root b is estate <name>-eu, so
  # one name starts the other, and each holds terraform_data.this (a from-a,
  # b from-b), with the record_store pointing both at terragucci-smoke-records.
  # Each estate must hold its own value under tofu-records/<estate>/, as one
  # record tagged with its own estate, and a tf-plan of both roots right after
  # must show no change: each read its own records back and no other.
  # BREAK: root b names estate a, so the two roots share one estate and one
  # prefix: the wave fails on the second create, or b's apply overwrites a's
  # record, and estate a no longer holds from-a alone.
  log() { echo "[smoke cdf-shared-bucket] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work ea eb eb_root side estate want values keys key tags rc=0 got
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  ea="smoke-shared-$(date +%s)-$$"
  eb="$ea-eu"
  eb_root="$eb"
  [ -n "${BREAK:-}" ] && eb_root="$ea"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  for side in a b; do
    estate="$ea"; [ "$side" = b ] && estate="$eb_root"
    mkdir -p "$work/repo/$side"
    cat >"$work/repo/$side/main.tf" <<HCL
terraform {
  live {
    estate = "$estate"

    record_store "s3" {
      bucket = "$CDF_RECORDS"
    }

    retry {
      max_attempts = 1
    }
  }
}

resource "terraform_data" "this" {
  input = "from-$side"
}
HCL
  done
  printf '.terraform/\n.terraform.lock.hcl\n.tofu-records/\nterragucci-report/\n' >"$work/repo/.gitignore"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke cdf-shared-bucket $(date +%s%N)"
  if ! cdf_run "$work/repo" "$work/apply.log" "$CDF_ALIAS-apply" choudoufu "" tf-apply --wave 1 --layers a,b --binary choudoufu --gate never; then
    log "the wave did not apply both estates into $CDF_RECORDS"; tail -20 "$work/apply.log" >&2; cdf_down "$work"; return 1
  fi
  for side in a b; do
    estate="$ea"; [ "$side" = b ] && estate="$eb"
    want="from-$side"
    values="$(cdf_values "$estate")"
    [ "$values" = "$want" ] || { log "estate $estate holds '$values', not $want"; rc=1; continue; }
    keys="$(cdf_keys "$estate" | grep '/terraform_data/' || true)"
    [ "$(grep -c . <<<"$keys")" = 1 ] || { log "estate $estate has $(grep -c . <<<"$keys") terraform_data records, not one: $keys"; rc=1; continue; }
    key="$(head -1 <<<"$keys")"
    case "$key" in "tofu-records/$estate/"*) ;; *) log "the record of estate $estate is at $key, outside tofu-records/$estate/"; rc=1 ;; esac
    tags="$(curl -fsS "$FLOCI/$CDF_RECORDS/$(jq -rn --arg k "$key" '$k | split("/") | map(@uri) | join("/")')?tagging" | tr -d '\n\t ' || true)"
    grep -qF "<Key>tofu-estate</Key><Value>$estate</Value>" <<<"$tags" || { log "the record of estate $estate is not tagged tofu-estate=$estate: $tags"; rc=1; }
    [ $rc = 0 ] && log "estate $estate holds $want in one record at $key, tagged with its estate"
  done
  if [ $rc = 0 ]; then
    if ! cdf_run "$work/repo" "$work/plan.log" "$CDF_ALIAS-plan" choudoufu "" tf-plan --layers a,b --binary choudoufu; then
      log "tf-plan of both estates failed"; tail -20 "$work/plan.log" >&2; rc=1
    else
      got="$(jq -c '[.roots[].path] | sort' "$work/repo/terragucci-report/report.json" 2>/dev/null || echo none)"
      [ "$got" = '["a","b"]' ] || { log "the plan reports roots $got, not a and b"; rc=1; }
      got="$(jq '[.roots[].changes[]?] | length' "$work/repo/terragucci-report/report.json" 2>/dev/null || echo missing)"
      [ "$got" = 0 ] || { log "the plan of both estates right after the apply shows $got change(s), not none"; rc=1; }
    fi
  fi
  cdf_down "$work"
  [ $rc = 0 ] && log "one wave applied estates $ea and $eb into $CDF_RECORDS, each under its own prefix and estate tag, and a plan of both read each one back with no change"
  return $rc
}

claim_cdktn_synth() {
  # A CDK Terrain app (fixtures/cdktn) on cdktn 0.24.0 with two stacks, and
  # synth in terragucci.yml. Its .npmrc sets engine-strict, so npm ci stops
  # on a job image whose Node is older than the 22.19 cdktn 0.24 needs. The
  # stacks are synthesized on the host so init finds them under
  # cdktf.out/stacks; the pushed pipeline runs synth itself, since cdktf.out
  # is not committed. The push to main passes check and applies
  # both stacks; a pull request that changes the size of prod in main.js gets
  # a passing terragucci/plan whose job ran cdktn synth before tf-plan and
  # planned prod.
  # BREAK: synth is left out of terragucci.yml, so the pipeline runs no synth
  # step and its checkout holds no stacks to check, apply or plan.
  log() { echo "[smoke cdktn-synth] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-synth" wf sha head pr jobs id plan_log rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-synth || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/cdktn/." "$work/tree/"
  if [ -n "${BREAK:-}" ]; then sed -i.bak '/^synth:/d' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"; fi
  (cd "$work/tree" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  [ -n "${BREAK:-}" ] || grep -q 'npx cdktn synth' "$wf" || { log "the pipeline runs no synth step"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-synth: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
  log "the push to main ran: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
  [ "$(jq -r '.[] | select(.name == "check") | .status' <<<"$jobs")" = success ] || { log "check did not pass on the synthesized stacks"; rc=1; }
  [ "$(jq -r '.[] | select(.name == "apply-wave-1") | .status' <<<"$jobs")" = success ] || { log "apply-wave-1 did not apply the synthesized stacks"; rc=1; }
  if [ $rc = 0 ]; then
    sed -i.bak 's/prod: 3/prod: 5/' "$work/tree/main.js" && rm -f "$work/tree/main.js.bak"
    head="$(push_tree "$work/tree" "$repo" change "cdktn-synth: prod holds 5")" || rc=1
    git -C "$work/tree" checkout -q main
  fi
  if [ $rc = 0 ]; then
    pr="$(pr_open "$repo" change "cdktn-synth: prod holds 5")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(context_state "$repo" "$head" terragucci/plan)" = success ] || { log "terragucci/plan did not pass on pull request $pr"; rc=1; }
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '.[] | select(.name == "plan") | .id')"
    plan_log="$(api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null || true)"
    grep -E 'Generated Terraform code|synth at the base|affected: |cdktf.out/stacks/[a-z]+: ' <<<"$plan_log" >&2 || true
    grep -q 'Generated Terraform code for the stacks: dev, prod' <<<"$plan_log" || { log "the plan job did not run cdktn synth"; rc=1; }
    [ "$(grep -n 'Generated Terraform code' <<<"$plan_log" | head -1 | cut -d: -f1)" -lt "$(grep -n 'synth at the base: ' <<<"$plan_log" | head -1 | cut -d: -f1)" ] 2>/dev/null || { log "synth did not run before tf-plan"; rc=1; }
    grep -q "cdktf.out/stacks/prod: Plan:" <<<"$plan_log" || { log "tf-plan did not plan cdktf.out/stacks/prod"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "synth ran before check, apply and tf-plan, which planned the synthesized stack prod"
  return $rc
}

claim_cdktn_affected() {
  # The CDK Terrain app of cdktn-synth (fixtures/cdktn, stacks dev and prod)
  # on main, and a pull request that changes the size of prod in main.js.
  # tf-plan runs the synth command on the base too and compares each stack's
  # synthesized files: the plan job plans prod and not dev, and the plan note
  # says one stack was unchanged and not planned.
  # BREAK: main names an app file that does not exist in cdktf.json, and the
  # pull request puts it back, so synth fails on the base. tf-plan then plans
  # every stack, the unchanged dev with them.
  log() { echo "[smoke cdktn-affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-affected" sha head pr id plan_log notes body rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-affected || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/cdktn/." "$work/tree/"
  (cd "$work/tree" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then sed -i.bak 's#"node main.js"#"node gone.js"#' "$work/tree/cdktf.json" && rm -f "$work/tree/cdktf.json.bak"; fi
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-affected: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then sed -i.bak 's#"node gone.js"#"node main.js"#' "$work/tree/cdktf.json" && rm -f "$work/tree/cdktf.json.bak"; fi
  sed -i.bak 's/prod: 3/prod: 5/' "$work/tree/main.js" && rm -f "$work/tree/main.js.bak"
  head="$(push_tree "$work/tree" "$repo" change "cdktn-affected: prod holds 5")" || rc=1
  git -C "$work/tree" checkout -q main
  if [ $rc = 0 ]; then
    pr="$(pr_open "$repo" change "cdktn-affected: prod holds 5")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(context_state "$repo" "$head" terragucci/plan)" = success ] || { log "terragucci/plan did not pass on pull request $pr"; rc=1; }
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '.[] | select(.name == "plan") | .id')"
    plan_log="$(api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null || true)"
    grep -E 'synth at the base|every root: |affected: |cdktf.out/stacks/[a-z]+: ' <<<"$plan_log" >&2 || true
    grep -q "cdktf.out/stacks/prod: Plan:" <<<"$plan_log" || { log "tf-plan did not plan cdktf.out/stacks/prod, which changed"; rc=1; }
    if grep -q "cdktf.out/stacks/dev: " <<<"$plan_log"; then log "tf-plan planned cdktf.out/stacks/dev, which the change leaves alone"; rc=1; fi
    notes="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq '[.[] | select(.body | startswith("<!-- terragucci:plan"))]')"
    body="$(jq -r '.[0].body // ""' <<<"$notes")"
    grep -E 'synth command|synthesized root' <<<"$body" >&2 || true
    grep -q '1 synthesized root planned, 1 unchanged and not planned' <<<"$body" || { log "the plan note does not say one stack was unchanged"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "synth ran on the base too: prod differed and planned, dev was unchanged, not planned, and the note says so"
  return $rc
}

# ── the audit trail ───────────────────────────────────────────────────────
# A repo with one root, app, a terraform_data with local state, whose
# reports go to the bucket under a fresh prefix, and beside it origin.git,
# which holds main and, once a wave records something, chant/lifecycle.
audit_repo() { # work, prefix -> $1/wave and $1/origin.git
  local work="$1" prefix="$2"
  mkdir -p "$work/wave/app"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "first"\n}\n' > "$work/wave/app/main.tf"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
}

audit_origin() { # work -> commits $1/wave and pushes it to $1/origin.git, its origin as the image sees it
  git init -q --bare "$1/origin.git"
  git -C "$1/wave" init -q -b main
  git -C "$1/wave" add -A && git -C "$1/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke audit"
  git -C "$1/wave" push -q "$1/origin.git" main
  git -C "$1/wave" remote add origin /origin.git
}

audit_in() { # work, command... -> runs it in the CI image in /repo ($1/wave), with /origin.git
  local work="$1" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"; shift
  run_copied --rm --network terragucci -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag tofu)" "$@"
}

audit_wave() { # work, gate -> AUDIT_CODE, the exit code of wave 1
  AUDIT_CODE=0
  audit_in "$1" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate "$2" > "$1/run.log" 2>&1 || AUDIT_CODE=$?
  cat "$1/run.log" >&2
  clean_mounted "$1/wave" "$(image_tag tofu)"
}

audit_run() { # work, flags... -> AUDIT_OUT and AUDIT_CODE of terragucci audit, run in the repo
  local work="$1"; shift
  AUDIT_CODE=0
  AUDIT_OUT="$(audit_in "$work" terragucci audit --link-hours 1 "$@" 2>&1)" || AUDIT_CODE=$?
  printf '%s\n' "$AUDIT_OUT" >&2
  clean_mounted "$work/wave" "$(image_tag tofu)"
}

audit_approve() { # origin.git, clone dir, actor, gate, [digest] -> an approval line on chant/lifecycle: the digest given, else the gate's newest pending one
  local origin="$1" clone="$2" actor="$3" gate="$4" digest="${5:-}"
  if [ -d "$clone" ]; then git -C "$clone" pull -q --ff-only origin chant/lifecycle || return 1
  else git clone -q -b chant/lifecycle "$origin" "$clone" || return 1; fi
  [ -n "$digest" ] || digest="$(jq -rs --arg g "$gate" '[.[] | select(.kind == "pending" and .gate == $g)] | last | .planDigest // empty' "$clone/_gates/tf-apply.jsonl")"
  [ -n "$digest" ] || { echo "no pending line for $gate" >&2; return 1; }
  # The approval is stamped to the second and must be newer than the pending line, which carries milliseconds.
  sleep 1
  printf '%s\n' "$(jq -cn --arg d "$digest" --arg g "$gate" --arg a "$actor" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{version: 1, kind: "resolution", op: "tf-apply", gate: $g, resolvedBy: $a, timestamp: $t, planDigest: $d}')" >> "$clone/_gates/tf-apply.jsonl"
  git -C "$clone" -c user.name="$actor" -c user.email="$actor@localhost" -c commit.gpgsign=false commit -qam "approve $gate" && git -C "$clone" push -q origin chant/lifecycle
}

audit_record() { # prefix, file -> downloads the record
  curl -fsS -o "$2" "$FLOCI/$REPORT_BUCKET/$1/audit.jsonl"
}

audit_unrecorded() { # origin.git, ledger file, entry kind, record -> each approval or override line of the ledger with no entry of that kind: who, digest, time
  comm -23 <(git -C "$1" show "chant/lifecycle:$2" 2>/dev/null | jq -r 'select(.kind != "pending") | "\(.resolvedBy) \(.planDigest) \(.timestamp)"' | sort) \
    <(jq -r --arg k "$3" 'select(.kind == $k) | "\(.who) \(.digest) \(.at)"' "$4" | sort)
}

claim_audit() {
  # A repo whose reports go to the bucket: wave 1 waits, smoke-approver
  # approves its digest on chant/lifecycle, and the next run applies it.
  # terragucci audit, run in the repo, writes audit.jsonl, audit.html and
  # audit.json to the prefix with a presigned link. Every approval line on the
  # ledger has an entry with its approver, digest and time, the request has
  # one, and the apply names the approval it applied under. terragucci audit
  # --check passes, and terragucci estate links audit.html from its page.
  # BREAK: an approval of wave-2 lands on the ledger after the record was
  # written, so the record lacks it, and --check names it and exits 1.
  log() { echo "[smoke audit] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-$STAMP" approval missing
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_repo "$work" "$prefix"
  audit_wave "$work" always
  [ "$AUDIT_CODE" = 3 ] || { log "the first run exited $AUDIT_CODE, not 3: wave 1 did not wait"; rc=1; }
  if [ $rc = 0 ]; then audit_approve "$work/origin.git" "$work/ledger" smoke-approver wave-1 || { log "could not approve wave 1"; rc=1; }; fi
  if [ $rc = 0 ]; then
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 0 ] || { log "the run after the approval exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
    grep -Eq "X-Amz-Signature=[0-9a-f]{64}" <<<"$AUDIT_OUT" || { log "terragucci audit printed no presigned link"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    audit_approve "$work/origin.git" "$work/ledger" late-approver wave-2 "sha256:$(printf '%064d' 2)" || { log "could not write the late approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    missing="$(audit_unrecorded "$work/origin.git" _gates/tf-apply.jsonl approval "$work/audit.jsonl")"
    [ -z "$missing" ] || { log "approvals on the ledger with no entry in the record: $missing"; rc=1; }
    jq -se '[.[] | select(.schema == "terragucci.audit/v1" and .kind == "approval-requested" and .what == "wave-1" and (.digest | type == "string"))] | length >= 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no entry for the request of wave 1"; rc=1; }
    approval="$(jq -rs '[.[] | select(.kind == "approval" and .who == "smoke-approver" and .what == "wave-1")] | last | .id // empty' "$work/audit.jsonl")"
    jq -se --arg a "$approval" '[.[] | select(.kind == "apply" and .result == "applied" and .who == "smoke-approver" and .detail.approval == $a and .evidence.source == "report")] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the apply of wave 1 does not name the approval it applied under: $(jq -c 'select(.kind == "apply") | {who, result, detail}' "$work/audit.jsonl")"; rc=1; }
    curl -fsS -o /dev/null "$FLOCI/$REPORT_BUCKET/$prefix/audit.html" || { log "no audit.html at $REPORT_BUCKET/$prefix"; rc=1; }
    audit_run "$work" --check
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit --check exited $AUDIT_CODE: the record lacks an entry the sources hold"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || log "terragucci estate exited non-zero"
    clean_mounted "$work/wave" "$image"
    curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html" | grep -q 'href="audit.html" id="audit-trail"' || { log "estate.html does not link audit.html"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the record holds the request, the approval by smoke-approver and the apply that names it, --check passes, and the estate page links it"
  return $rc
}

claim_audit_override() {
  # The policy-wave repo with policy.override and reports in the bucket. Its
  # wave is denied and terragucci audit runs; smoke-approver overrides the
  # denial, the next run applies app (its report replaces the denied one) and
  # terragucci audit runs again. The record keeps the refusal
  # (denied-by-policy, app denied) and appends the override (who, the reason,
  # the rules and the plan digest of the denial it answers) and the apply
  # that names it. Every override line on the ledger has an entry, and
  # --check passes.
  # BREAK: the override is written after the record, so the record lacks it,
  # and --check names it and exits 1.
  log() { echo "[smoke audit-override] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-override-$STAMP" missing
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  mkdir -p "$work/wave"
  cp -R "$HERE/fixtures/policy-wave/." "$work/wave/"
  printf 'policy:\n  engine: conftest\n  path: policy\n  override: [smoke-approver]\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" >> "$work/wave/terragucci.yml"
  audit_origin "$work"
  audit_wave "$work" never
  [ "$AUDIT_CODE" = 1 ] || { log "the first run exited $AUDIT_CODE, not 1: the policy did not deny the wave"; rc=1; }
  # A scheduled audit records the refusal while its report stands; the run after the override replaces that report.
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE after the denial"; rc=1; }
  fi
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    audit_wave "$work" never
    [ "$AUDIT_CODE" = 0 ] || { log "the run after the override exited $AUDIT_CODE, not 0"; rc=1; }
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE after the apply"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    missing="$(audit_unrecorded "$work/origin.git" _gates/policy-override.jsonl override "$work/audit.jsonl")"
    [ -z "$missing" ] || { log "overrides on the ledger with no entry in the record: $missing"; rc=1; }
    jq -se '[.[] | select(.kind == "refused" and .result == "denied-by-policy" and .detail.denied == ["app"] and (.detail.rules.app | length > 0))] | length >= 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no denied-by-policy refusal of app: $(jq -c 'select(.kind == "refused")' "$work/audit.jsonl")"; rc=1; }
    jq -se '[.[] | select(.kind == "override" and .what == "app" and .who == "smoke-approver" and .detail.reason == "smoke: the probe goes out" and (.detail.rules | length > 0) and (.detail.plan_digest | type == "string"))] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the override of app is not in the record with its reason, rules and plan digest: $(jq -c 'select(.kind == "override")' "$work/audit.jsonl")"; rc=1; }
    jq -se '[.[] | select(.kind == "apply" and .result == "applied" and .detail.overrides[0].root == "app" and .detail.overrides[0].by == "smoke-approver")] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the apply of app does not name its override: $(jq -c 'select(.kind == "apply")' "$work/audit.jsonl")"; rc=1; }
    audit_run "$work" --check
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit --check exited $AUDIT_CODE: the record lacks an entry the sources hold"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the record holds the denial of app, the override by smoke-approver with its reason and rules, and the apply under it"
  return $rc
}

claim_audit_refused() {
  # Wave 1 waits and smoke-approver approves its digest; then app changes in
  # a new commit and wave 1 runs again. Its plans moved, so it applies nothing
  # and exits 4, and its report says why in waves[].refused. terragucci audit
  # records the refusal: changed-after-approval, by smoke-approver, with the
  # digest approved and app as the root that moved.
  # BREAK: app does not change, so the second run applies and nothing is refused.
  log() { echo "[smoke audit-refused] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-refused-$STAMP" approved
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_repo "$work" "$prefix"
  audit_wave "$work" always
  [ "$AUDIT_CODE" = 3 ] || { log "the first run exited $AUDIT_CODE, not 3: wave 1 did not wait"; rc=1; }
  if [ $rc = 0 ]; then audit_approve "$work/origin.git" "$work/ledger" smoke-approver wave-1 || { log "could not approve wave 1"; rc=1; }; fi
  if [ $rc = 0 ]; then
    approved="$(jq -rs '[.[] | select(.kind == "resolution" and .gate == "wave-1")] | last | .planDigest' "$work/ledger/_gates/tf-apply.jsonl")"
    if [ -z "${BREAK:-}" ]; then
      printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "moved"\n}\n' > "$work/wave/app/main.tf"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app moves after its approval"
    fi
    audit_wave "$work" always
    log "the run after the approval exited $AUDIT_CODE"
    jq -e '.waves[0].refused | .reason == "approval" and .by == "smoke-approver" and .roots == ["app"]' "$work/wave/terragucci-report/report.json" >/dev/null 2>&1 \
      || { log "the wave report does not say it was refused after the approval: $(jq -c '.waves[0]' "$work/wave/terragucci-report/report.json" 2>/dev/null)"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    jq -se --arg d "$approved" '[.[] | select(.kind == "refused" and .result == "changed-after-approval" and .who == "smoke-approver" and .detail.approved == $d and .detail.moved == ["app"] and .digest != $d)] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no changed-after-approval refusal of wave 1: $(jq -c 'select(.kind == "refused" or .kind == "apply") | {kind, who, result, digest, detail}' "$work/audit.jsonl")"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the refused wave is in the record: changed after the approval by smoke-approver, app moved"
  return $rc
}

claim_audit_control() {
  # A control repo names two projects, smoke.local/audit/a and b, each a repo
  # of its own (a.git and b.git, named by url:) copying its reports to the
  # bucket. Wave 1 of each waits; smoke-approver approves a, and its next run
  # applies (its report replaces the waiting run of the same commit).
  # terragucci audit, run in the control repo, fetches each project
  # chant/lifecycle from its url and reads each project reports: one record
  # holds the request, approval and apply of a and the request and waiting
  # run of b, and --check passes.
  # BREAK: the url of b names a repo that does not exist, so its ledger
  # cannot be read: the command exits 1 and the record lacks the request of b.
  log() { echo "[smoke audit-control] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-control-$STAMP" p code burl=/work/b.git out bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  [ -n "${BREAK:-}" ] && burl=/work/missing.git
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  control_in() { # dir under /work, command...
    local dir="$1"; shift
    run_copied --rm --network terragucci -v "$work:/work" -w "/work/$dir" \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e GITHUB_SERVER_URL=http://smoke.local -e "GITHUB_REPOSITORY=audit/$dir" "$image" "$@"
  }
  for p in a b; do
    estate_project "$work/$p" "$(printf '  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s' "$REPORT_BUCKET" "$prefix")"
    git init -q --bare "$work/$p.git"
    git -C "$work/$p" push -q "$work/$p.git" main
    git -C "$work/$p" remote add origin "/work/$p.git"
    code=0
    control_in "$p" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate always >&2 || code=$?
    clean_mounted "$work/$p" "$image"
    [ "$code" = 3 ] || { log "wave 1 of $p exited $code, not 3"; rc=1; }
  done
  if [ $rc = 0 ]; then audit_approve "$work/a.git" "$work/a-ledger" smoke-approver wave-1 || { log "could not approve wave 1 of a"; rc=1; }; fi
  if [ $rc = 0 ]; then
    code=0
    control_in a terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate always >&2 || code=$?
    clean_mounted "$work/a" "$image"
    [ "$code" = 0 ] || { log "wave 1 of a exited $code after its approval, not 0"; rc=1; }
  fi
  mkdir -p "$work/control"
  cat > "$work/control/terragucci.yml" <<YAML
defaults:
  reports:
    bucket: s3://$REPORT_BUCKET
    endpoint: http://floci:4566
    prefix: $prefix
projects:
  smoke.local/audit/a:
    url: /work/a.git
  smoke.local/audit/b:
    url: $burl
YAML
  if [ $rc = 0 ]; then
    code=0
    out="$(control_in control terragucci audit --link-hours 1 2>&1)" || code=$?
    printf '%s\n' "$out" >&2
    clean_mounted "$work/control" "$image"
    [ "$code" = 0 ] || { log "terragucci audit exited $code"; rc=1; }
    audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -rs '[.[] | select(.project == "smoke.local/audit/a") | "\(.kind):\(.result)"] | sort | join(",")' "$work/audit.jsonl")" = "apply:applied,approval-requested:waiting,approval:unsigned" ] \
      || { log "the entries of a are $(jq -rsc '[.[] | select(.project == "smoke.local/audit/a") | "\(.kind):\(.result)"] | sort' "$work/audit.jsonl")"; rc=1; }
    [ "$(jq -rs '[.[] | select(.project == "smoke.local/audit/b") | "\(.kind):\(.result)"] | sort | join(",")' "$work/audit.jsonl")" = "apply:waiting,approval-requested:waiting" ] \
      || { log "the entries of b are $(jq -rsc '[.[] | select(.project == "smoke.local/audit/b") | "\(.kind):\(.result)"] | sort' "$work/audit.jsonl")"; rc=1; }
    code=0
    control_in control terragucci audit --check >&2 || code=$?
    clean_mounted "$work/control" "$image"
    [ "$code" = 0 ] || { log "terragucci audit --check exited $code"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "one record holds both projects: the request, approval and apply of a and the request and waiting run of b"
  return $rc
}

claim_notify_chat() {
  # The gated fixture (gate: always) with notify naming two secrets, which
  # hold the addresses of a webhook stand-in: one path for Slack, one for
  # Teams. The push to main stops at wave 1, waiting for its approval, and
  # its job posts once to each: the Slack text and the Teams card both name
  # the wave, its root canary/one, the chant approve command for its digest
  # and the run.
  # BREAK: terragucci.yml has no notify, so the pipeline maps no webhook and
  # nothing is posted.
  log() { echo "[smoke notify-chat] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/notify-chat" name="tgs-chat-$STAMP" wf sha reqs slack teams s rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo notify-chat || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    printf 'notify:\n  slack: CHAT_SLACK\n  teams: CHAT_TEAMS\n' >> "$work/tree/terragucci.yml"
    (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
    wf="$work/tree/.forgejo/workflows/terragucci.yml"
    # shellcheck disable=SC2016 # the expression the forge expands
    grep -qF 'TERRAGUCCI_SLACK_WEBHOOK: '"'"'${{ secrets.CHAT_SLACK }}'"'" "$wf" || { log "the apply jobs do not map CHAT_SLACK"; drop_work "$work"; return 1; }
  fi
  for s in CHAT_SLACK:"http://$name:8790/slack" CHAT_TEAMS:"http://$name:8790/teams"; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "${s#*:}" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/${s%%:*}" \
      || { log "could not set the ${s%%:*} secret"; drop_work "$work"; return 1; }
  done
  stand_in_up "$work" "$name" 8790 MODE=webhook || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "notify-chat: two waves")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    run_logs "$repo" "$RUN_ID" | grep -E 'chant approve tf-apply wave-1|terragucci notify' >&2 || { log "wave 1 did not wait for its approval"; rc=1; }
    reqs="$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')"
    slack="$(jq -r '[.[] | select(.method == "POST" and .path == "/slack")] | last | .body.text // empty' <<<"$reqs")"
    teams="$(jq -c '[.[] | select(.method == "POST" and .path == "/teams")] | last | .body // empty' <<<"$reqs")"
    log "Slack got: ${slack:-nothing}"
    log "Teams got: ${teams:-nothing}"
    for want in "wave 1 of" "canary/one" "chant approve tf-apply wave-1 --plan" "/actions/runs/"; do
      grep -qF -- "$want" <<<"$slack" || { log "the Slack message does not say $want"; rc=1; }
      grep -qF -- "$want" <<<"$teams" || { log "the Teams card does not say $want"; rc=1; }
    done
    [ "$(jq -r '.attachments[0].contentType // empty' <<<"$teams")" = application/vnd.microsoft.card.adaptive ] || { log "the Teams body is not an Adaptive Card"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 waited, and Slack and Teams each got the wave, its root, the approve command and the run"
  return $rc
}

claim_cost_estimate() {
  # Two roots, app and net, and cost in terragucci.yml naming the secret
  # COST_KEY and a command, cost.mjs, that sends the root's plan with that key
  # to a cost stand-in, which answers Infracost's JSON: 10.00 a month for each
  # resource a plan creates, and 401 without the key. A pull request that adds
  # a resource to app gets a plan note whose cost table names app at +20.00
  # (its two resources, as the job holds no state) and a total of +20.00, and
  # the stand-in took the estimate with the key the plan job got from the secret.
  # BREAK: terragucci.yml has no cost, so the plan runs no estimator and the
  # note has no cost table.
  log() { echo "[smoke cost-estimate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cost-estimate" name="tgs-cost-$STAMP" key="smoke-cost-$STAMP" tree wf sha head pr note root rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo cost-estimate || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "$key" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/COST_KEY" \
    || { log "could not set the COST_KEY secret"; drop_work "$work"; return 1; }
  for root in app net; do
    mkdir -p "$tree/$root"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "%s" {\n  input = 1\n}\n' "$root" > "$tree/$root/main.tf"
  done
  cat > "$tree/cost.mjs" <<'JS'
// Sends the root's plan to the cost stand-in with the key, and prints its estimate.
import { readFileSync } from "node:fs";
const r = await fetch(process.env.COST_URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.INFRACOST_API_KEY ?? "" }, body: readFileSync(process.env.TG_PLAN_JSON) });
if (!r.ok) {
  console.error(`the cost stand-in answered ${r.status}`);
  process.exit(1);
}
process.stdout.write(await r.text());
JS
  printf 'binary: tofu\nforge: forgejo\ngate: never\nenv:\n  COST_URL: http://%s:8790/estimate\n' "$name" > "$tree/terragucci.yml"
  [ -n "${BREAK:-}" ] || printf 'cost:\n  key_secret: COST_KEY\n  command: node cost.mjs\n' >> "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  # shellcheck disable=SC2016 # the expression the forge expands
  [ -n "${BREAK:-}" ] || grep -qF 'INFRACOST_API_KEY: '"'"'${{ secrets.COST_KEY }}'"'" "$wf" || { log "the plan job does not map COST_KEY"; drop_work "$work"; return 1; }
  stand_in_up "$work" "$name" 8790 MODE=cost "REQUIRE=x-api-key=$key" || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "cost-estimate: two roots")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    printf '\nresource "terraform_data" "more" {\n  input = 2\n}\n' >> "$tree/app/main.tf"
    head="$(push_tree "$tree" "$repo" change "cost-estimate: one more resource in app")" || rc=1
    git -C "$tree" checkout -q main
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "cost-estimate: one more resource in app")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty')"
    grep -E 'Monthly cost|^\| ' <<<"$note" >&2 || true
    grep -qF 'Monthly cost (USD' <<<"$note" || { log "the plan note of pull request $pr has no cost table"; rc=1; }
    grep -qE '^\| \[?`app`.* \| 0\.00 \| 20\.00 \| \+20\.00 \|$' <<<"$note" || { log "the cost table does not give app +20.00"; rc=1; }
    grep -qF '| **Total** | 0.00 | 20.00 | **+20.00** |' <<<"$note" || { log "the cost table does not total +20.00"; rc=1; }
    [ "$(curl -fsS "$STANDIN_CTL/_requests" | jq '[.[] | select(.path == "/estimate" and .status == 200)] | length')" -ge 1 ] \
      || { log "the cost stand-in took no estimate with the key"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "the plan note gave app +20.00 a month and a total of +20.00, estimated with the key from the COST_KEY secret"
  return $rc
}

claim_approval_used() {
  # Push the fixture; wave 1 waits. Approve it and push again: canary/one
  # applies, and the wave records on chant/lifecycle that it used the
  # approval. Then change canary/one and push: wave 1 plans another digest,
  # and since the approval it has applied under is used, it waits with the
  # approve command for the new digest instead of refusing.
  # BREAK: the record of the apply is emptied on chant/lifecycle before the
  # change, so the approval reads as one of plans that never applied: stale,
  # and the moved wave is refused.
  log() { echo "[smoke approval-used] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approval-used" sha applied logs first second clone rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approval-used || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approval-used: first")"
  wait_run "$repo" "$sha"
  first="$(run_logs "$repo" "$RUN_ID" | grep -o 'chant approve tf-apply wave-1 --plan [^ ]*' | head -1 | sed 's/.* //' || true)"
  [ -n "$first" ] || { log "wave 1 did not wait with its approve command"; rc=1; }
  if [ $rc = 0 ]; then
    gated_approve approval-used 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "approval-used: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied approval-used)"
    log "after the approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/lifecycle"
    git clone -q -b chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" || rc=1
  fi
  if [ $rc = 0 ]; then
    jq -e --arg d "$first" 'select(.gate == "wave-1" and .planDigest == $d)' "$clone/_gates/tf-apply/applied.jsonl" >/dev/null 2>&1 \
      || { log "chant/lifecycle holds no record that wave 1 applied under the approval of $first"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    : > "$clone/_gates/tf-apply/applied.jsonl"
    git -C "$clone" -c user.name=smoke -c user.email=smoke@terragucci.local -c commit.gpgsign=false commit -q -am "forget the apply" || rc=1
    git -C "$clone" push -q origin chant/lifecycle || rc=1
  fi
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    sha="$(push_tree "$work/tree" "$repo" main "approval-used: change canary/one after its approved wave applied")"
    wait_run "$repo" "$sha"
    logs="$(run_logs "$repo" "$RUN_ID")"
    second="$(grep -o 'chant approve tf-apply wave-1 --plan [^ ]*' <<<"$logs" | head -1 | sed 's/.* //' || true)"
    log "after the change: run $RUN_STATUS, approve command for ${second:-nothing}"
    grep -qE 'changed after it was approved|planned differently since' <<<"$logs" && { log "wave 1 was refused on the approval it already applied under"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -qE "wave 1 of [0-9]+ waits for an approval of digest $second" <<<"$logs" || { log "wave 1 did not wait for an approval of its new digest"; rc=1; }
    [ -n "$second" ] && [ "$second" != "$first" ] || { log "the approve command names ${second:-no digest}, not a new one"; rc=1; }
    grep -qE "the approval of [^ ]+ by smoke-approver was used by the apply of those plans" <<<"$logs" || { log "the run did not say the earlier approval was used"; rc=1; }
    [ "$(gated_applied approval-used)" = "canary/one " ] || { log "a root applied with nothing approved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the approval wave 1 applied under refused nothing; the moved wave waits for an approval of $second"
  return $rc
}

names() { only "$(cut -d'|' -f1 <<<"$CLAIMS")"; }
# The names given, kept to SMOKE_ONLY when it is set.
only() {
  if [ -z "$SMOKE_ONLY" ]; then echo "$1"; return 0; fi
  grep -xF -f <(echo "$SMOKE_ONLY") <<<"$1" || true
}
# The claims with no issue to wait for, in CLAIMS order.
runnable_names() {
  if [ -n "${SMOKE_AWS:-}" ]; then
    # Only the pilot's claims run on real AWS.
    only "$(awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS")" | while read -r n; do smoke_aws_claim "$n" && echo "$n"; done
    return 0
  fi
  only "$(awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS")"
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
wave-report     weight=120
policy-delete-key    ex after=boot weight=150
report-oidc          ex after=boot weight=150
tg-gate-wait         runner self! weight=200
tg-gate-refuse       runner self! weight=200
tg-sealed            runner self! weight=200
pr-apply             runner self! weight=250
pr-apply-lock        runner self! weight=300
pr-apply-stale       runner self! weight=200
tg-comment-apply     runner self! weight=200
provider-calls       weight=90
summed-timings       weight=90
foreign-checkout     ex after=boot weight=150
tg-layers            runner self! weight=300
policy-source        self! weight=150
pr-requires          runner self! weight=300
pr-lock              runner self! weight=200
front-door           self! weight=40
ledger-default       runner self! weight=200
approval-at-base     runner self! weight=250
sealed-migrate       runner self! weight=250
estate               weight=120
drift-overdue        self! weight=60
pr-review            runner self! weight=300
pr-review-moved      runner self! weight=300
pr-review-status     runner self! weight=250
cdf-concurrency      weight=150
cdf-write-race       weight=150
cdf-iam              self! weight=250
approve-command      runner self! weight=250
tg-pr-apply          runner self! weight=300
tg-pr-apply-lock     runner self! weight=300
plan-lock            runner self! weight=250
plan-lock-release    runner self! weight=200
policy-override      weight=150
policy-override-moved     weight=150
policy-override-unlisted  weight=150
blob-azure           azurite! weight=120
blob-gcs             gcs! weight=120
note-diff            ex runner self! after=boot weight=200
note-split           weight=60
note-report-link     weight=60
config-ts            weight=20
role-refused         weight=20
description-check    weight=60
decide-backends      weight=80
otlp-headers         weight=60
pinned-install       weight=60
drift-close          self! weight=90
estate-control       self! weight=80
estate-override      weight=150
comment-refused      runner self! weight=200
note-stale           runner self! weight=200
pr-confirm           runner self! weight=300
pr-base-config       runner self! weight=250
pr-guard             runner self! weight=300
pr-close-release     runner self! weight=200
tg-lock-fanout       runner self! weight=200
token-scrub          weight=60
fork-no-plan         runner self! weight=250
highlight-sensitive  weight=90
approval-revoke      runner self! weight=250
pending-expiry       runner self! weight=250
signer-trust         runner self! weight=250
rollout-control      runner self! weight=400
rollout-provider     self! weight=120
rollout-pins         self! weight=80
policy-opa           weight=150
policy-hcp           weight=150
policy-hcl           weight=150
tg-policy            weight=200
tg-credentials       weight=200
tg-dependents        weight=250
tf-terraform         runner self! weight=300
tg-terraform         runner self! weight=300
tfquery-import       self! weight=120
alerts-fire          otel self! weight=300
blob-gcs-key         gcs! weight=120
blob-azure-key       azurite! weight=120
index-writes         self! weight=90
cdf-shared-bucket    weight=120
cdktn-synth          runner self! weight=200
audit                weight=150
audit-override       weight=150
audit-refused        weight=150
audit-control        weight=150
notify-chat          runner self! weight=150
cost-estimate        runner self! weight=150
approval-used        runner self! weight=200
cdktn-affected       runner self! weight=200
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

SMOKE_STALL_MIN="${SMOKE_STALL_MIN:-10}"
case "$SMOKE_STALL_MIN" in ''|*[!0-9]*|0) SMOKE_STALL_MIN=10 ;; esac

# A run whose log has not grown for SMOKE_STALL_MIN minutes: say what it was
# doing and what the stack is running, stop it and its children, and leave a
# failing SMOKE line in its log. Returns 1 while the run is still moving.
stalled() { # pid, run
  local pid="$1" run="$2" name="${2%:*}" mode="${2#*:}" log
  log="$SMOKE_LOG_DIR/$name.$mode.log"
  [ -n "$(find "$log" -mmin "+$SMOKE_STALL_MIN" 2>/dev/null)" ] || return 1
  {
    echo "[smoke] $name ($mode) stalled: no output for $SMOKE_STALL_MIN minutes; its last lines:"
    tail -5 "$log" | sed 's/^/[smoke]   /'
    echo "[smoke] job containers:"
    docker ps --format '{{.Names}} {{.RunningFor}}' 2>/dev/null | grep -E 'ACTIONS-TASK|runner-' | sed 's/^/[smoke]   /' || echo "[smoke]   none"
  } >&2
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "SMOKE claim=$name verdict=fail stalled: no output for $SMOKE_STALL_MIN minutes" >>"$log"
  return 0
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
      if kill -0 "$pid" 2>/dev/null; then
        stalled "$pid" "$run" || { still="$still$pid $run"$'\n'; continue; }
      fi
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
  # Built every time: a forge job runs the bundle inside the image, so an
  # image left from an older tree would test older code. The layer cache
  # makes a rebuild take seconds when only the bundle moved.
  echo "[smoke] building the CI images (a few minutes the first time)" >&2
  (cd "$HERE/.." && npx tsx scripts/images.ts build >"$SMOKE_LOG_DIR/images.log" 2>&1) \
    || { echo "[smoke] the CI images did not build; see $SMOKE_LOG_DIR/images.log" >&2; return 1; }
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

if [ -n "$SMOKE_ONLY" ]; then
  for n in $SMOKE_ONLY; do
    grep -q "^$n|" <<<"$CLAIMS" || { echo "smoke: unknown claim '$n'" >&2; exit 2; }
  done
  echo "[smoke] only: $(echo $SMOKE_ONLY)" >&2
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
  if [ -n "$SMOKE_ONLY" ]; then
    # Only these claims ran: their rows replace the old ones and every other
    # row stays as the last record left it, all in CLAIMS order. Each new row
    # names the commit it ran on; the file's own commit is the last full record's.
    [ -f "$out" ] || { echo "smoke: --only --record needs an existing $out" >&2; exit 2; }
    new="$(jq --arg commit "$(git -C "$HERE/.." rev-parse --short HEAD)" --argjson order "$(cut -d'|' -f1 <<<"$CLAIMS" | jq -R . | jq -s .)" \
      --slurpfile old "$out" '(map(. + {commit: $commit}) | map({key: .claim, value: .}) | from_entries) as $mine
        | ($old[0].claims | map({key: .claim, value: .}) | from_entries) as $was
        | [$order[] | ($mine[.] // $was[.]) | select(. != null)]' <<<"$new")"
    if [ "$(jq -S .claims "$out")" = "$(jq -S . <<<"$new")" ]; then echo "unchanged $out" >&2; exit 0; fi
    jq --argjson c "$new" '.claims = $c' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
    echo "wrote $(echo $SMOKE_ONLY | wc -w | tr -d ' ') rows into $out" >&2
    exit 0
  fi
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
  # Claims picked by name run both ways: a claim proves nothing until its
  # BREAK run is caught too.
  if [ -n "$SMOKE_ONLY" ]; then mode="plain break"; SMOKE_BREAK_VALUE=1; fi
  record_pending
  # shellcheck disable=SC2046
  QUEUE="$(build_queue "$mode" $(runnable_names))"
  run_queue
  if grep -q 'verdict=fail' "$SMOKE_LOG_DIR"/*.verdict 2>/dev/null; then rc=1; fi
fi
exit $rc
