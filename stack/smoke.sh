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
# A run whose log has not grown for SMOKE_STALL_MIN minutes (default: the
# claim timeout plus two, 17 for the default 900 s timeout) is
# stopped and fails as stalled, its last lines and the stack's job containers
# printed, so nothing waits out a long timeout without anyone looking.
#
# A claim is named <area>/<part>: the area is the behaviour (lock, waves,
# refuse, policy), the part the flavor or case that proves it (lock/terragrunt,
# lock/plan). An area alone names all of its parts: `--only lock`. A new claim:
# add its line to CLAIMS and its function claim_<area>/<part> (hyphens in the
# part become underscores), and give it a line in CLAIM_GROUPS naming what it
# shares. A claim with no line there runs alone, after boot/tofu and
# waves/terragrunt: safe, and slow.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A person starts a run (stack/human-gate.sh); --list reads CLAIMS only.
# A grant (stack/grant.sh) covers --only runs of the claims it names.
if [ "${1:-}" != --list ]; then
  . "$HERE/human-gate.sh"
  gate_names=()
  [ "${1:-}" = --only ] && read -r -a gate_names <<<"$(tr ',' ' ' <<<"${2:-}")"
  human_gate "smoke claims, plain and under BREAK, holding the shared stack (or the GitLab lab, or a binary's example copy) for minutes to hours" ${gate_names[@]+"${gate_names[@]}"}
  unset gate_names
fi

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
# The forge the claims run on: forgejo, the validation stack, or gitlab, the
# GitLab lab (stack/gitlab/gitlab.sh), whose claims are in smoke-gitlab.sh.
SMOKE_FORGE="${SMOKE_FORGE:-forgejo}"
case "$SMOKE_FORGE" in forgejo|gitlab) ;; *) echo "smoke: SMOKE_FORGE is forgejo or gitlab, not '$SMOKE_FORGE'" >&2; exit 2 ;; esac
export SMOKE_FORGE
# The binary the core claims run on (BINARY_CLAIMS, below CLAIMS): tofu, the
# default and every claim's, or terraform or choudoufu, which run the core
# claims alone, each on its binary, with the fixtures written for it
# (binary-tree.py). Their rows in smoke.json carry binary: <name>.
SMOKE_BINARY="${SMOKE_BINARY:-tofu}"
case "$SMOKE_BINARY" in tofu|terraform|choudoufu) ;; *) echo "smoke: SMOKE_BINARY is tofu, terraform or choudoufu, not '$SMOKE_BINARY'" >&2; exit 2 ;; esac
if [ "$SMOKE_BINARY" != tofu ] && { [ "$SMOKE_FORGE" != forgejo ] || [ -n "${SMOKE_AWS:-}" ]; }; then
  echo "smoke: SMOKE_BINARY=$SMOKE_BINARY runs on Forgejo and floci only" >&2; exit 2
fi
export SMOKE_BINARY
# The example the claims read: example on Forgejo with names under shop-, or
# for another binary its own copy (example.sh's TG_EXAMPLE_BINARY).
EX_REPO=example; EX_SHOP=shop; EX_TAG=""
case "$SMOKE_BINARY" in terraform) EX_TAG=tf ;; choudoufu) EX_TAG=cdf ;; esac
[ -z "$EX_TAG" ] || { EX_REPO="example-$SMOKE_BINARY"; EX_SHOP="shop$EX_TAG"; }
# A claim's function is claim_<area>/<part> on Forgejo and gitlab_claim_<area>/<part> on GitLab.
CLAIM_FN=claim_
[ "$SMOKE_FORGE" = gitlab ] && CLAIM_FN=gitlab_claim_
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
CLAIMS='boot/tofu|the example boots and deploys locally|
check/tofu|tf-check fails an unformatted root and names the file|
affected/tofu|only the roots a change touches are planned|
affected/outside-roots|a change outside every root plans the roots that read it: a shared var file TF_CLI_ARGS names plans the roots that read it, a file a symlink points at plans the root that links it, a version for envs/prod/** in terragucci.yml plans those roots only, a new synth command plans every root, and a policy, approval mode or step added at head plans nothing, since they are read at the base|
note/grouped|one note groups many plans|
report/tofu|the report is JSON and HTML, and links every root to its full plan|
report/highlight|destroys and outliers are open, identical groups are folded|
waves/tofu|each wave goes out only once approved|
refuse/tofu|a wave whose plans changed after approval applies nothing|
approval/sealed|under approval: sealed a wave counts only an approval sealed by a key the signers file lists|
drift/tofu|drift is reported by root|
rollout/tofu|a module version rolls out one pull request per wave, each opened only after the last merged and applied, and with rollouts set the rollout job opens the next wave with no manual run|
modules/publish|changed modules are published at a new version|
modules/attest|with modules.attest each release is signed, attested and recorded in the release ledger with its tag|
modules/require|with modules.require: attested tf-plan plans a root that pins an attested release, and refuses one whose tag was moved|
modules/recorded|with modules.require: attested tf-plan refuses a root that pins a version the release ledger does not record|
modules/terragrunt-require|with modules.require: attested in a Terragrunt repo tf-check and tf-plan refuse a unit whose terraform source pins an unattested release, and pass one that pins an attested release|
modules/registry|with modules.registry each release is written as the module registry protocol to a bucket, and a root that pins ~> 1.0 resolves the newest 1.x from it; with modules.test an untested release is refused|
tips/tofu|tips are on by default and name their rule|
init/zero-config|with no more than a drift schedule and the canary wave in terragucci.yml, init writes the same pipeline|
apply/serial|two pushes to main apply one after the other, and the commit carries one terragucci/apply status|
reconcile/tofu|a control repo opens one pull request per project that changes, and the merged pipeline applies|
reconcile/mixed|a control repo with projects on Forgejo, on GitHub (the mock) and on a forge that does not answer opens the Forgejo pull request and the GitHub one, each with its own pipeline, names the project that failed, and exits 1|
telemetry/traces|each plan run is one trace, with a span per root and the binary spans inside it|
telemetry/metrics|the metrics of a plan run reach Prometheus with the counts in its report|
init/terragrunt|init finds Terragrunt and its 15 units on its own and writes the pipeline the Terragrunt example commits|
waves/terragrunt|the Terragrunt example boots in five waves, one job each: the dependency layers of the dev canary, then the layers of staging and prod, each with one run --all|
check/terragrunt|tf-check fails an unformatted Terragrunt file and names it|
affected/terragrunt|only the units a change reaches are planned, including a file a module reads that Terragrunt misses|
tips/terragrunt-mock|a dependency whose mock_outputs can stand in for apply is named by a tip|
linked/terragrunt-mock|a unit that reads a new upstream is planned on the planned outputs of that upstream, never on its mock_outputs|
linked/terragrunt-mock-trap|a new upstream and its dependent merge together and apply in order, so no mock reaches real state|
respond/refused|a refused wave names each root whose plan moved and the attributes that moved|
respond/triage|a failed apply is triaged from the known-error table|
respond/drift|drift on a literal becomes a pull request with the live value, and import blocks for what is unmanaged|
respond/tips|each tip becomes its own small pull request|
respond/fmt|fmt on request commits to the pull request branch and nowhere else|
respond/notes|release notes come from the conventional commits that touched the module|
linked/fresh|on a fresh estate the plan job holds back a root whose upstream is unapplied, names it in the report, and stays green|
oidc/forgejo|a Forgejo job gets an OIDC token Forgejo signed for its repo and ref, and trades it for the plan or apply role|
oidc/audience-stages|with oidc.audience a map, the plan job of a pull request and the apply job of main each hold a token for their own stage audience, a role whose trust names the apply audience refuses the plan token, and the code each job runs finds no token-request variable in its environment|
apply/groups|with environments prod and dev, each with its own roles, a wave holding a root of each is planned and gated by one job that holds no apply role, then applied by one job per environment, each carrying the apply role of its own environment alone, under one approval; on Forgejo both jobs present the same token subject, so the roles each job is handed are all that keeps them apart|
apply/check-job|with environments prod and dev and the condition of the apply jobs widened by hand to any push, the apply job of each environment on a branch it does not apply from fails before it trades a token, naming the expected and the found ref, and on main passes its check and trades its token; Forgejo has no deployment environments and names no runner labels to a job, so the ref is what is checked here|
forge/check|terragucci forge check exits 0 when main is protected and each role in floci trusts exactly what config identities prints, and exits 1 with a row naming the expected and found value when main is unprotected, a role trusts any subject, or a role trusts an extra audience; it runs with a Forgejo token scoped read:repository and AWS keys granted iam:GetRole alone, and sends no request but GET and GetRole|
apply/steward|tf-apply runs as a turn on a fountain steward, started by the forge job, and applies every root|273
policy/tofu|an opt-in policy denies a plan, fails the root in tf-plan, and names the violation|
comment/plan|a pull request comment re-plans on request and never applies; apply on an open pull request, a root outside the configured ones, and approve, merge, destroy, import, state or force-unlock are each answered with a refusal, and nothing plans or applies|
import/atlantis|terragucci import atlantis writes terragucci.yml from an atlantis.yaml, names what it leaves out, and the pipeline init then writes plans exactly the Atlantis projects|
import/spacelift|terragucci import spacelift writes terragucci.yml from spacelift_* code and .spacelift/config.yml, with context secrets to create and hooks as steps, and init then applies the roots in the order the stack dependencies ask|
import/env0|terragucci import env0 writes terragucci.yml from env0_* code, env0.yml and env0-discovery.yml, and init then plans the environment roots, keeps ephemeral copies of the ones with a TTL, and holds every wave for an approval|
import/hcp|terragucci import hcp reads the workspaces of an organization over the TFE API, only reading, and writes a root per workspace directory, lists a directory several workspaces run to split, names sensitive variables as secrets without their values, and init then applies in the order the run triggers ask|
import/scalr|terragucci import scalr reads the workspaces of a Scalr account over the Scalr API, only reading, and writes their roots on tofu with the sensitive variables as secrets the pipeline passes, without their values, and names the policies of each OPA policy group|
import/terragrunt-scale|terragucci import terragrunt-scale writes the plan and apply roles of each Gruntwork Pipelines environment as terragrunt.credentials, and every unit then assumes the roles of its environment, a unit with its own gruntwork.hcl its own|
waves/after|waves.after orders plain roots that read nothing of each other: network, database and app apply in three waves, and a pull request that changes network plans all three|
comment/atlantis|with atlantis_comments on, atlantis plan re-plans a pull request, and atlantis apply and an Atlantis-only flag are refused as the terragucci forms are|
lock/wait-span|a plan that waits for a state lock another plan holds shows the wait as a State lock wait span, in its report and its trace|
telemetry/dash-pipeline|the Pipeline health dashboard init writes shows the runs, errors and results of a plan, a drift run and a gated wave|
telemetry/dash-changes|the Change review dashboard init writes shows the roots, groups and changes by action of a pull request|
telemetry/dash-waves|the Rollouts and waves dashboard init writes shows a wave waiting for its approval, how long, and wave runs by result|
telemetry/dash-drift|the Drift dashboard init writes shows the roots a drift run found drifted and how old the drift is|
telemetry/dash-estate|the Estate dashboard init writes shows the roots of a project and the binary and terragucci versions it runs|
telemetry/dash-runs|the Runs dashboard init writes shows the slowest roots, stage durations and the trace of each run from Tempo|
telemetry/dash-slos|the SLO dashboards init writes are provisioned, and the plan SLO records the plans of a project from the rules init writes|
report/drill-down|the plan note links the report in the bucket, the report links each root plan and the trace of the run, the trace and the dashboards link back to the report, and the index row links the commit, pull request and job|
policy/wave|a tf-apply wave whose plan the policy denies applies nothing, and its report keeps the changes of the denied root with the denial and the warnings|
check/diagnostics|tf-check fails with the cause in its log for a validate error, a failing policy test and a choudoufu live-check refusal|
comment/not-affected|a re-plan comment for a root the pull request does not reach is answered that it is not affected and plans nothing, and a re-plan whose forge call fails fails its job with the cause|
drift/attribute|with respond.drift: attribute, tf-drift lists who changed each drifted attribute under its root in the drift issue|
modules/version-bump|with respond.version-bump: suggest, the version-bump job of the pipeline runs after the last apply on the default branch and opens a release pull request with the answer of the decision service|
telemetry/terragrunt-spans|the plan of each Terragrunt unit sends its spans to the report through the TG_TF_PATH wrapper, and waits up to five minutes for the state lock|
oidc/clouds|a job with oidc.gcp and oidc.azure gets an external_account file and the ARM_* variables the google and azurerm providers read, with a token for the audience of each cloud|
comment/apply|a comment on a merged pull request re-runs its apply from the merge commit, applies a wave under approval: sealed only once its approval is sealed, and refuses an open pull request and a commenter with no write access|
agent/comment|a /terragucci agent comment pushes the commit of the stand-in agent to the branch of the pull request, which re-plans it and is linked in the reply, and a forbidden path, a non-writer and a fork push nothing|
agent/review|with review.agent on, the review workflow of the default branch runs on pull_request_target after the plan, and its review job runs a stand-in reviewer on the pull request, its plan and the instructions of the default branch, with the key of the model and no forge token, and the note it posts flags a destroy the description does not mention and approves nothing|
policy/review-risk|a tf-apply wave gives the policy the risk the review workflow of the default branch kept as its artifact for the head of the merged pull request as input.review; the edited review job of the pull request itself keeping risk low and a forged low-risk note posted with the pipeline token change nothing, and a policy that denies risk high stops the wave|
report/wave|the report of a tf-apply wave behind a gate says waiting and links the ledger that holds its record, and approved once an approval of its digest stands|
policy/delete-key|a pull request that deletes the policy key from terragucci.yml and adds a change the policy denies still fails tf-plan, checked against the policy of the base branch|
report/oidc|with no static keys, the plan job writes its report to the bucket as the role it assumes with its OIDC token through STS, and the index lists the run|
pr-apply/tofu|with apply.when: pull-request, a comment on an open and approved pull request applies its head in waves and then merges it with apply.merge: auto|
lock/apply|a second pull request that reaches a root another open pull request has applied is refused with the root and the holder named, and applies once the first is unlocked with /terragucci unlock|
pr-apply/stale|a comment on an approved pull request whose head is behind the default branch is refused as not up to date, and nothing applies|
telemetry/provider-calls|with binary: choudoufu the report lists the slowest provider calls of a root, each with its method, provider and resource type, from the provider call spans choudoufu sends|
telemetry/summed-timings|with binary: choudoufu past its span budget the report lists the timings choudoufu summed by resource type, and the note of the root says it summed them|
init/foreign-checkout|a job that runs as root in the CI image on a checkout another user owns, with no git setting of its own, plans only the roots a change touches|
waves/terragrunt-layers|a Terragrunt repo of three units in a chain goes out in three waves, one job each, every wave waiting for an approval of its own set digest before it applies|
waves/atmos|init names one root per Atmos instance, <stack>/<component>, from atmos describe stacks, and cuts a wave per layer of dependencies.components: each dependent instance applies in the wave after its dependency, behind its own gate|
apply/atmos-workspace|each Atmos instance plans and applies in the Terraform workspace Atmos names for it, never default: the instances of one component in two stacks keep their own states, and plan no change after the apply|
affected/atmos|a pull request that changes one Atmos instance plans that instance and the instances whose dependencies.components name it, and no other|
linked/atmos|an Atmos instance whose stack reads an unapplied instance with !terraform.state is held back, never planned on a stand-in, and applies on the output of the upstream once it has applied|
check/atmos|the check job of an Atmos repo runs atmos validate stacks before it writes the instances, and fails on a manifest Atmos refuses, with the error Atmos gives|
init/atmos-version|atmos.version in terragucci.yml is the Atmos release every job installs|
waves/terramate|init takes the stacks of a Terramate repo as roots and cuts a wave per layer of their order: a stack after a tag or before another applies in the wave its order gives it, behind its own gate|
affected/terramate|a pull request that changes one Terramate stack plans that stack and the stacks whose after or before put them after it, and no other|
linked/terramate|a Terramate stack whose input block reads an output of an unapplied stack is held back, never planned on the mock, and applies on the output of the upstream once it has applied|
check/terramate|the check job of a Terramate repo fails on stale generated code, naming the file terramate generate would change|
oidc/atmos-roles|oidc.roles by stack glob gives the instances of each Atmos stack roles of their own: config check lists each role with the states of its stack, and each instance plans and applies as the role of its stack|
lock/atmos|with apply.when: pull-request in an Atmos repo, a pull request applied on a comment locks the Atmos instances it reaches (every instance, for a change to a stack manifest), and a second pull request that changes one is refused with the instance and the holder named, its state left as the first applied it|
init/atmos-refuse|config check and init refuse the drift pull request of an Atmos repo in the same words, about the vars of the stack, never synth; respond tips proposes lock files for the components and a canary of instances|
policy/source|a project of a control repo with no policy directory is checked against the shared policy source the control repo defaults name, at its pinned ref|
reconcile/parallelism|a project of a control repo plans with the parallelism its defaults set: reconcile writes the key into the terragucci.yml of the project, and the plan job reads it there|
reconcile/provider|the terragucci provider, applied with tofu, writes a project and the defaults into the terragucci.yml of a control repo, plans show a changed setting, and reconcile gives the project its pipeline with the setting|
pr-apply/requires|with apply.requires: [approved] an approved pull request behind the default branch applies from its head, the default requirements refuse it as not up to date, and a pull request that conflicts with the default branch is refused as not mergeable|
lock/comment|/terragucci lock on an open pull request locks the roots it reaches and applies nothing, and a second pull request that reaches one is refused with the root and the holder named|
report/front-door|the front door template puts CloudFront in front of the private reports bucket at its own domain, reads the bucket through Origin Access Control and runs the sign-in check on every viewer request|
approval/ledger|with no approval key a wave counts an unsigned approval of its set digest, init declares no gate, and the waiting wave prints the approval command without --sign|
approval/at-base|a merge that switches approval from sealed to ledger is judged by the sealed rule of the commit before it, and the next merge by ledger|
approval/sealed-migrate|a repo whose chant.workspace.json lists the wave gates and whose config names no approval mode stays sealed, and the wave and config check say so|
estate/tofu|terragucci estate writes one page to the reports bucket from the index of every project: three projects, a waiting wave with its age and a drift, with a presigned link to the page|
behold/view|the behold step of the estate job reads the reports from the bucket and publishes the view of the commit under views/behold/<commit>/ with latest.json and history.json naming it, and headless Chrome, opening views/behold/ from the bucket, draws the drift the drift check found on the card of the deleted queue|
behold/serve|behold serve, given the checkout and the reports bucket, draws both roots, marks the queue deleted outside Terraform with the time the drift check finished, gives the terragucci approve line of the waiting wave and refuses a deploy, and refuses a corrupted index.json|
behold/terragucci-view|terragucci view, reading the bucket and project from terragucci.yml, starts the pinned behold, which draws both roots, marks the queue deleted outside Terraform with the time the drift check finished and gives the terragucci approve line of the waiting wave, and stops on SIGTERM; a corrupted index.json stops it with one line|
note/drift-overdue|the plan of a pull request says in its note that drift checks are overdue when the drift schedule has come round twice with no drift run|
approval/pr-review|with approval: pr-review a pull request approved on its head by a writer other than its author merges, and its gated wave applies with no terragucci approve, recorded on the ledger as via pr-review|
refuse/pr-review|with approval: pr-review a wave whose plans changed between the review of the head and the merge applies nothing and prints the terragucci approve command for its new digest|
approval/pr-review-status|with approval: pr-review terragucci/approval on the head of a pull request is pending while a wave waits, and success once a writer other than the author approves the head|
choudoufu/concurrency|with binary: choudoufu, two waves on one estate that each add a resource taking 60 seconds to create both finish in under 90 seconds. Two that change different resources both write their records and apply, with no lock wait and no lock object. Two that change the same resource at once: one write lands, the other fails naming the resource and overwrites nothing, and its re-plan shows the value that landed|
choudoufu/killed|with binary: choudoufu, while an approved wave applies, the run view and progress.json show the first resource done and a slow second one in progress. Killed then, the wave leaves a record for the first and none for the second, and running the wave again applies only the second, under the same approval|
choudoufu/record-versions|with binary: choudoufu a record changed by three tf-apply waves shows three versions, newest first, on the estate page and in its history, listed by choudoufu live-history|
choudoufu/iam|with binary: choudoufu, a role that IAM limits to resources tagged with one estate applies a change to that estate, and IAM denies it a change to a resource of another estate|
apply/per-root|a second push applies one root while the wave of the first push is still applying another: no apply job waits for another run, and the state lock of the backend keeps the applies of one root apart|
apply/stand-down|a wave of a push whose commit is no longer the tip of main stands down once the newer push has landed: it applies nothing, its terragucci/apply says superseded by a newer push, and the newer push applies the root|
choudoufu/rows-overlap|with binary: choudoufu, two pushes that change different resources of one estate apply at the same time. Each wave lists the resource it changes in _locks/apply-rows.json, both apply, and both entries are removed afterward|
choudoufu/rows-wait|with binary: choudoufu, two waves change the visibility timeout of one SQS queue on floci. The second makes no call until the first finishes its call, as the floci request log shows, then plans again and applies its own value|
drift/choudoufu|with binary: choudoufu a queue changed outside choudoufu on a root under live resource markers is drift: tf-drift plans the root in full, its report and one drift issue name the root and the attribute, and a run with no change closes the issue|
choudoufu/rows-takeover|with binary: choudoufu, a wave killed after its change lands leaves its entry for the queue in _locks/apply-rows.json. The wave of the next push takes that entry over with no unlock step. Its apply finds the queue changed by the killed run and refuses its own plan before any call|
approval/resume|terragucci approve, given a forge token of the approver, resumes the waiting wave of a merged pull request, which applies with nothing else done|
approval/resume-schedule|with apply.resume set, a run of the resume workflow applies a waiting wave once an approval of its digest is on chant/lifecycle|
refuse/approve-plan|terragucci approve --plan with a digest the plans moved past approves nothing, exits 1 and names the digest waiting|
note/approve-command|the plan note of a pull request gives the terragucci approve command with the digest its gated wave asks for after the merge, and terragucci approve in a checkout approves that wave with no digest copied|
lock/terragrunt|in a Terragrunt repo, a pull request that changes a unit whose dependencies block names a unit another open pull request applied is refused with the unit and the holder named|
lock/plan|with locks: plan a pull request locks the roots it reaches from its first plan, a second pull request that reaches one gets a failing terragucci/lock and a reply naming the root and the holder, and after /terragucci unlock its /terragucci plan takes the lock|
lock/plan-release|with locks: plan the merge of a pull request releases the lock its first plan took|
lock/plan-fmt|with locks: plan a pull request whose push the fmt job formats, with a push that starts no run, has its lock answered on the formatted head|
policy/override|a tf-apply wave the policy denies applies once an approver listed under policy.override at base overrides its plan with terragucci override, and its report names the override with who, the rules, the reason and the plan digest; the next plan the policy denies exits 1 naming policy.override and the terragucci override command, an override by someone it does not list counts for nothing, and an override of a plan that moved on exits 4|
report/azure|with reports.bucket az://<account>/<container> and only the Azure OIDC identity of the job, tf-plan writes the report and both indexes to Azure Blob Storage, and terragucci estate writes the page there and prints a user delegation SAS that serves it|
report/gcs|with reports.bucket gs://<bucket> and only the GCP OIDC identity of the job, tf-plan writes the report and both indexes to GCS through its JSON API, and terragucci estate writes the page there and prints a V4 signed URL that the service account signed|
note/diff|the plan note on Forgejo shows the diff of a group as the binary prints it, with the value before and after of the attribute that changes, and the whole plan of the root in a collapsed block|
note/split|a plan over the comment limit of the forge stays one note within the limit: the largest whole plan is left out and named in a Cut line that links its plan.txt, and the rest stays|
note/report-link|with reports.bucket set and no reports.url, the plan note links report.html and each plan.txt in the bucket by presigned links, which open from floci|
init/config-ts|init writes the pipeline from a terragucci.ts folded as data, and config check refuses a terragucci.ts that reads process.env at its line|
init/role-refused|config check and init refuse an oidc block that names one role for plan and apply|
review/description|with respond.description: check the plan job flags a destroy the pull request description leaves out, at the top of the note and in the report, and writes intent.json; decide.backend laya, von, decider and jev each answer the check through the same client, each pinned to its model, jev with its bearer token from token_env|
telemetry/headers|telemetry.headers_secret maps the collector key into the jobs, spans reach a collector that wants it, and a collector that does not answer leaves the plan green|
init/pinned-install|a pinned binary version the image does not carry is installed in the job and checked against the SHA256SUMS of its release|
generate/tofu|terragucci generate writes the backend, provider and version files of each root from the repo, directory glob and root levels of terragucci.yml, a changed global reaches the backend file of every root, and tf-check refuses a hand-edited generated file|
generate/terragrunt|in a Terragrunt repo terragucci generate writes terragucci.hcl from terragucci.yml, the check step passes it, and each unit that includes it applies with the backend key and provider settings generate gives it, while a unit that does not include it is refused by name|
generate/terragrunt-init|with generate.disable_init: false terragucci generate writes disable_init = false in the remote_state of terragucci.hcl, the check step passes it, and the apply job has Terragrunt create the missing state bucket and applies into it|
init/root-pins|two roots of one wave plan on two OpenTofu versions, the one the .opentofu-version of a root pins, installed in the job and checked against its SHA256SUMS, and the one in the image, and the report and the plan note name the binary and version of each root|
drift/close|a drift run that finds no drift closes the drift issue an earlier run opened|
estate/control|terragucci estate in a control repo reads each project from its own bucket with its own reports.role and writes one page to the bucket under defaults|
estate/override|the estate page counts the roots applied under a policy override, in estate.json and estate.html|
report/contracts|the index.json files, estate.json and report.json a run and terragucci estate write to the bucket hold to the JSON Schemas the package ships, and a project named views writes nothing under the prefix kept for viewers|
note/stale|a push to the default branch that changes a root an open pull request planned marks its plan note stale|
pr-apply/confirm|with apply.when: pull-request the push of the merge commit runs confirm, which plans every root, posts terragucci/apply success and applies nothing|
pr-apply/guard|with apply.when: pull-request a pull request that changes the pipeline file, or whose checks failed, is refused and applies nothing|
lock/close-release|with apply.when: pull-request closing a pull request releases the roots it locked|
lock/terragrunt-fanout|in a Terragrunt repo a change to root.hcl locks every unit and says why, and a Markdown-only change locks none|
security/token-scrub|the binary tf-plan starts gets no forge token by name or by value, and a TF_ variable passes as set|
security/plan-token-free|the plan and re-plan jobs run the code of a pull request with no forge token variable in its environment or that of its parent processes and no credential in the checkout, and the note jobs still post the note and terragucci/plan|
security/replan-apply-role|a /terragucci plan re-plan trades its OIDC token for the plan role before any pull request code runs, and that code finds no token the apply role trusts and no way to ask for one|
security/replan-cache|a /terragucci plan re-plan restores the Terragrunt cache and saves none, so what the code of a pull request leaves in .terragrunt-cache never reaches an apply job|
security/fork|a pull request from a fork runs check and no plan job|
report/sensitive|IAM, security group, KMS and DNS changes are open with their reasons, and an import and a forget are named, the forget not counted as a destroy|
approval/signer-trust|init --signer writes the signers line from git config user.signingkey, and an approval sealed with that key lets the wave apply|
rollout/control|from a control repo a module rollout opens wave 1 as one pull request per project for its canaries, then each project in turn, each wave once the last applied|
rollout/pins|rollout moves a provider alone in the lock file and its exact constraint, an oci:// tag and a registry version pin, each in the shape it had|
policy/opa|with policy.engine: opa a tf-apply wave the policy denies applies nothing, and its report keeps the denial and the warnings|
policy/hcp|with policy.input: hcp an HCP Terraform policy reads input.plan and input.run and denies the wave|
policy/hcl|with a policies.hcl a mandatory policy denies the wave and an advisory one warns|
policy/sources-module|with sources.modules set, tf-plan and the check job fail a root that calls a module from an unlisted host before its init, and tf-plan fails one whose listed remote module calls an unlisted one after its init and before its plan, naming the module path; in a Terragrunt repo tf-plan fails such a unit after Terragrunt inits it and before its plan, naming the unit and the module path, and the check job fails a unit whose source is on an unlisted host before its validate|
policy/sources-provider|with sources.providers set, tf-plan fails a root whose required_providers names an unlisted provider before its init, and one whose remote module brings in an unlisted provider after its init and before its plan, naming the module; in a Terragrunt repo tf-plan fails a unit whose source brings in an unlisted provider after Terragrunt inits it and before its plan, naming the unit and the provider|
policy/sources-at-base|a pull request that adds an unlisted host to its own sources list is still refused, checked against the list of the base branch|
oidc/terragrunt|in a Terragrunt repo each unit assumes the plan role of the first glob its path matches, and a unit with its own iam_role keeps it|
affected/terragrunt-dependents|by default a pull request previews the dependents of a changed Terragrunt unit, provisional and outside every digest, terragrunt.dependents: follow opts out, and terragrunt.exclude leaves a unit out|
linked/terragrunt-preview|a pull request previews the later layers of a Terragrunt change: a unit is planned on the planned outputs of its upstream, and one that reads a value known only once its upstream applies is named with that value and wave, never planned on a stand-in|
linked/terragrunt-preview-gate|a Terragrunt wave whose plan differs from the preview of it in the pull request says so at its gate, naming what moved, before anyone approves|
binary/terraform|with binary: terraform the pipeline runs in the terraform image, check and the plan pass, and a wave waits for its approval and then applies with Terraform|
binary/terragrunt-terraform|in a Terragrunt repo with binary: terraform the pipeline installs Terraform and Terragrunt applies every unit with it|
drift/tfquery|with binary: terraform a root with a .tfquery.hcl gets the drift pull request with the config terraform query generated for what it lists|
telemetry/alerts|with short thresholds every alert init writes fires on its signal, and the apply-success and drift-corrected SLOs record|
report/gcs-key|with a service_account key file the job writes the report and both indexes to GCS, and the estate link is signed with the key|
report/azure-key|with AZURE_STORAGE_KEY the job writes the report and both indexes to Azure Blob Storage, and the estate link is a SAS signed with the account key|
report/index-writes|two plan runs that write one index at once both land in it, and a store that answers 501 to a conditional write gets the row without the condition|
note/footer|the plan note on a pull request ends with the terragucci footer, Forgejo renders its taco image, and the image answers 200 with a PNG|
comment/dispatch|a workflow_dispatch of the plan workflow with pr set re-plans that pull request: the replan job posts a new terragucci/plan status on its head and updates the same plan note, and Forgejo refuses the dispatch of a user with read access only|
choudoufu/shared-bucket|with binary: choudoufu, one wave applies two estates that keep their records in one S3 bucket, each under its own key prefix and estate tag, and the next plan of both shows no changes|
choudoufu/migrate|with binary: choudoufu two migrations in one change apply in one wave, each proved and approved by its digest: one moves a resource between two estates by rewriting its ownership tags and records the move on chant/lifecycle, the other adopts a root on s3 state into an estate, stamps its resources and leaves the old state as the version it was; the next plan of every root shows no change|
init/cdktn-synth|with synth set to npx cdktn synth the pipeline synthesizes the CDK Terrain stacks before check, apply and tf-plan, and tf-plan plans the stack the change reaches|
report/outcome|stage tf-apply writes how its wave ended to TG_OUTCOME_JSON as terragucci.outcome/v1: waiting with its digest, mode and approve command, refused with the digest approved and the root that moved, and failed with the root|
audit/tofu|terragucci audit writes one record to the bucket: every approval on the ledger with its approver, digest and time and who relayed it, the request, and the apply that names its approval; --check passes and the estate page links the audit page|
audit/override|the audit record keeps a policy refusal after its report is replaced, and holds the override with its reason and rules and the apply under it|
audit/refused|a wave whose plans changed after approval is in the audit record as refused, with the approver, the digest approved and the root that moved|
audit/control|terragucci audit in a control repo fetches each project ledger from its url and reads each project reports into one record|
estate/inventory|after two apply waves of the example roots the estate page lists every resource of each root by address, type and provider, with the count of each type, and no value|
estate/graph|the estate page draws the example roots by wave with an edge for each state the example reads and an edge from a root of another project that reads one, and the run view shows the blast radius of wave 1 and a timeline of the plan, gate wait and apply of each wave|
estate/history|one resource changed by three approved applies has a history that lists the three in order with their approvers from the audit trail, linked from the estate page, and no value|
estate/query|terragucci query, run on the reports bucket with no server, answers the SQS queues changed in the last 7 days with their approvers with the rows the audit trail holds|
state/versions|a root whose state is in a versioned S3 bucket applies twice, and the estate page lists both state version ids newest first, each one the bucket holds, and no state content|
oidc/state-roles|with oidc.roles each environment root plans and applies as the role of its own environment, config check lists the state key of each role, and it warns when a prod root reads the dev state|
state/export|terragucci state export records a request, waits for an approval by someone else, then writes the state version on the machine of the person who asked, recorded on chant/lifecycle and in the audit trail, with no state in the bucket|
state/gcs|a root whose state is in a bucket on fake-gcs-server with object versioning applies twice, each wave naming the generation it left, and terragucci state export writes the first generation once someone else approved the request|
state/azurerm|a root whose azurerm backend on Azurite takes snapshots applies twice, each wave naming the snapshot it took of the state blob, and terragucci state export writes the first snapshot once someone else approved the request|
state/gcs-unlock|terragucci unlock-state reads the lock a killed apply left on a gcs backend, by the generation of the lock object, and releases it only after an approval of that lock, recording who released it|
state/azurerm-unlock|terragucci unlock-state reads the lease a killed apply left on an azurerm state blob, with the lock info in its metadata, and releases it only after an approval of that lock, recording who released it|
migrate/blob|a migration moves a resource from a root whose state is on GCS to one whose state is on Azure Blob Storage: approved by digest, written under the lock object and the blob lease, and each version before and after recorded|
oidc/cloud-roles|with oidc.gcp.roles and oidc.azure.roles, the roots of each environment plan and apply with the service account and the client of their glob, from the exports of the pipeline, and never the identity of the job|
estate/state-edges|the estate page lists a root that reads the state of another with its last plan against the last apply of the producer: stale after the producer alone applied, current once the consumer planned again|
migrate/resume|with gate: never and apply.resume set, init still writes the resume workflow, terragucci approve with no argument approves a migration that waits in wave 1 of a Forgejo run, and one run of the resume workflow writes both states and applies, with nobody running wave 1 again|
migrate/backends|one migration moves the states of six roots to new backends, from s3, a TFE workspace, pg, kubernetes, consul and http: each source read by version, through discovery or with state pull, proved with no change, approved by digest, written under the lock of its backend, each source left as it was, and the versions read and written recorded where the backend keeps them|
migrate/split|a migration file splits one root into two: the plan proves it with no change, wave 1 waits for its digest, and once approved writes both states under their locks with no change, recording each version before and after; terragucci migrate revert then writes the migration that puts each state back to the version the split recorded, refused when a state moved past the version the split left|
estate/dora|terragucci estate computes the four DORA metrics from the audit trail and the indexes into dora.json and the estate page: deployments, lead time with the share at the gate, a change failure rate counting a failed apply and an applied wave that drifted, and the time to restore each|
notify/chat|with notify naming a Slack and a Teams webhook secret and approval: pr-review, a wave of a merged pull request that waits posts the wave, its root, the digest, the approve command, the run and a link to review the pull request to each, and once that review lands the next run applies it|
notify/webhook|with notify naming a generic webhook and its key, a wave that waits posts a chant.notify/v1 event from terragucci signed with HMAC-SHA256 over its timestamp and body, carrying the outcome, digest and approve command|
cost/estimate|with cost set, the plan note of a pull request gives the monthly cost change of each root and the total, from the estimator run with the key the plan job gets from its secret|
cost/gate|with cost.approve_above set, a wave whose monthly change is over the amount waits for an approval under gate: never, its log naming the change, the amount and the commit read, and the plan note of a pull request sets the change of each wave against the amount at base|
cost/policy|with cost set, an HCP Terraform policy set reads the cost of the root from input.run.cost_estimate and of its wave from input.cost, and its mandatory policy denies the wave|
refuse/approval-used|once a wave applied under its approval, the next merge that moves its plans waits with the approve command for the new digest, and only an approval of plans that never applied refuses|
affected/cdktn|with synth set a pull request that changes one CDK Terrain stack plans that stack alone, and the plan note says how many stacks were unchanged|
apply/cdktn|with synth set each apply wave synthesizes the CDK Terrain stacks and applies its stack behind the gate: dev once wave 1 is approved, prod once wave 2 is|
lock/cdktn|with synth and apply.when: pull-request, a pull request applied on a comment locks every CDK Terrain stack, since its change to the app can reach any, and a second pull request that changes a stack is refused with the stack and the holder named, its state left as the first applied it|
tips/cdktn|with synth set the tips job synthesizes the CDK Terrain stacks and opens the canary tip, and says the pin and lock file tips are left out|
migrate/cdktn|a migration moves a resource between two CDK Terrain stacks, whose roots are cdk.tf.json: wave 1 proves it with no change on those roots, waits for its digest, and once approved writes both states under their lock files|
init/cdktn-refuse|with synth set init refuses the drift pull request and rollouts as config errors saying why, and with respond.drift: attribute the drift job runs no pull request|
apply/branches|with apply.branches mapping release to canary/*, a push to main applies the fleet roots behind the gate and never canary/one, and a push to release applies canary/one alone, waiting at the same gate until its wave is approved|
drift/branches|with apply.branches mapping release to canary, the drift run on main plans canary from release, the branch that applied it, and finds no drift where planning it from main would read the state release left behind and report a false drift|
init/own-jobs|with own_jobs naming a file of jobs in terragucci.yml, init run twice keeps the job in the Forgejo pipeline as the file has it, and the job runs after the check job and passes|
waves/jobs|with waves.jobs: 2 a wave of four roots waits at one gate in its own job, and once approved applies in two share jobs of two roots each, under one approval used once|
steps/before-plan|a step before plan writes a file the plan reads, read from terragucci.yml at base, and the plan note lists the step|
steps/stop|a step before apply that exits 1 fails the wave job before anything applies|
steps/gate|a step with on_failure approve that fails holds its wave at the gate under gate never, naming the step, with the approve command for its digest|
respond/terragrunt-fmt|in a Terragrunt repo the fmt job runs terragrunt hcl fmt after a branch fails its check and pushes the formatting commit to the branch, and nowhere else|
state/terragrunt-versions|a Terragrunt unit whose state is in a versioned S3 bucket applies twice, its backend read from its remote_state block, and the estate page lists both state version ids newest first, each one the bucket holds|
respond/terragrunt-drift|a drifted Terragrunt unit gets a pull request that writes the live value into its own terragrunt.hcl inputs and leaves the module its units share alone|
drift/terragrunt-attribute|with respond.drift: attribute in a Terragrunt repo, tf-drift lists who changed each drifted attribute under its unit in the drift issue|
migrate/terragrunt-split|a migration file moves a resource from the state of one Terragrunt unit to that of another: wave 1 proves it on the units Terragrunt prepares, waits for its digest, and once approved writes both states under their locks at their remote_state keys, recording each version before and after|
init/terragrunt-root-pins|three Terragrunt units of one wave plan with their own releases: the tofu the .opentofu-version of a unit pins and the Terragrunt its terragrunt_version_constraint pins, each installed and checked in the job, and the releases of the image for the third, and the report names each|
binary/terragrunt-choudoufu|in a Terragrunt repo with binary: choudoufu the jobs run in the choudoufu image with Terragrunt installed beside it, and every unit plans with choudoufu through TG_TF_PATH|
estate/terragrunt-graph|in a Terragrunt repo the plan note gives the blast radius of a changed unit through the units that depend on it, and the run view and the estate graph hold each unit by wave with an edge for each dependency block|
estate/terragrunt-remote-state|a Terragrunt unit whose root.hcl remote_state builds its key from path_relative_to_include() holds that state in its run view, and the estate graph draws an edge to the root of another project that reads it through terraform_remote_state|
state/terragrunt-export|terragucci state export of a Terragrunt unit prepares it through Terragrunt, asks for the version of the state its remote_state block names, and once someone else approved it writes that version on the machine of the person who asked, recorded on chant/lifecycle|
apply/terragrunt-branches|with apply.branches mapping release to live/canary/*, a push to main applies the fleet units behind the gate and never live/canary/one, and a push to release applies live/canary/one alone, waiting at the same gate until its wave is approved|
waves/terragrunt-stack|the units of an explicit stack are generated before discovery, cut into waves by their dependencies, and applied in order from a checkout that holds none of them|
check/terragrunt-stack|the check job of a Terragrunt repo generates its explicit stack and validates the generated units, failing on a unit whose template reads a value the stack file does not feed it, and naming that unit|
affected/terragrunt-stack|a pull request that changes one value in a terragrunt.stack.hcl plans only the unit that value feeds, says so, lists the unit that depends on it as waiting, and the report and note name the stack file|
drift/terragrunt-stack|tf-drift from a checkout that holds no generated unit generates the explicit stack, reports the resource deleted outside Terraform under its generated unit, and names the stack file that unit comes from|
chat/slack|a click on the Approve button of the Slack message of a waiting wave, signed with the signing secret of the app, reaches the relay, which maps the Slack user to their principal in the signers file, records the approval of that digest as them and says so in the thread; the resume workflow then applies the wave|
chat/lambda|the relay built as the AWS Lambda function of the guide, run under the Lambda runtime interface emulator, takes a signed Slack click as a function URL event and records the approval of that digest as the mapped principal; the resume workflow then applies the wave|
chat/teams|a Teams reply that approves a waiting wave, signed as an outgoing webhook signs it, reaches the relay, which maps the Teams user to their principal in the signers file and records the approval of that digest as them; the resume workflow then applies the wave|
chat/replan|with notify naming a Slack webhook, a drift run that finds drift posts the drifted root with a Re-plan button that opens the drift workflow, which runs on workflow_dispatch|
linked/plan|a root that reads the state of another plans in tf-plan on the planned outputs of that root, unknown where unknown, and its wave is marked to plan again once the upstream applies|
linked/local|two roots on the local backend, one reading the other through terraform_remote_state by the same path: terragucci orders them into two waves on its own, and the reader plans on the planned outputs of the writer|
linked/backend-config|a root whose backend block names no path, which init takes from the backend.hcl that TF_CLI_ARGS_init in terragucci.yml passes, is ordered before the root that reads its state, and the reader plans on its planned outputs|
note/blast|a pull request that changes a queue gets a plan note whose blast radius lists, under the queue, its policy in the same root and the function and mapping that read its ARN in another root, and leaves out the log group that reads only another output|
linked/states|after a pull request changes an output of wave 1, wave 2 plans again once wave 1 applied, shows the new value, and waits for an approval of that plan; the run view in the bucket shows where each wave stands|
lock/plan-none|a pull request plan and a drift run plan a root while an apply holds its state lock, and neither waits for it|
note/sensitive|a change to a sensitive variable and a sensitive output keeps both values out of the plan note, the report, the job log and every object in the reports bucket|
apply/provider-cache|a wave of eight roots that use one provider downloads it once: the job log names one download and the cache volume holds one copy|
apply/provider-cache-no-lock|with binary: terraform, a wave of eight roots with no .terraform.lock.hcl and one whose lock names the OpenTofu registry plans at once on one shared provider cache: every root plans, the job log names one download, and no init fails with text file busy|
state/unlock|terragucci unlock-state refuses to release a state lock while a run that began before it is alive, and once the apply that held it is killed releases it only after an approval of its lock ID, recording who released which lock, and the next wave applies|
tips/moved|a resource renamed on a branch plans as a destroy and a create, the plan report tips the moved block, respond tips opens a pull request into the branch that adds it, and once merged the plan moves the resource and destroys nothing|
estate/mcp|an MCP client of terragucci mcp, which reads the reports bucket with the credentials of its environment, reads the last apply of a root, and the server lists only read-only tools and refuses an approve call and a token argument|
agent/drift|with agent.drift on, a drift run that opens the drift issue runs the stand-in agent with no forge token in its step, and the push job opens a pull request with its change, which plans like any other and is linked on the issue|
drift/github|on GitHub, a drift run opens the drift issue, and a second run finds it and updates it instead of opening another|
apply/runner-nudge|on the validation stack a job left waiting after the run ahead of it in its concurrency group is cancelled, with nothing running, starts within three minutes: a wait restarts the idle runner|
ephemeral/pr|with ephemeral naming canary/*, opening a pull request applies its own copy of canary/one under the state key suffixed -pr-<n>, beside the state of the root itself, and closing it destroys the copy through a planned destroy recorded on chant/lifecycle with the reason closed|
ephemeral/ttl|with ephemeral naming canary/* and a TTL of one minute, a run of the sweep workflow once the TTL has passed destroys the copy of an open pull request through a planned destroy recorded with the reason expired|
ephemeral/terragrunt|in a Terragrunt repo whose remote_state key reads TERRAGUCCI_EPHEMERAL_SUFFIX, opening a pull request applies its own copy of a unit at the key suffixed -pr-<n>, prepared through Terragrunt, beside the state of the unit itself, and closing it destroys the copy on the record|
ephemeral/cdktn|with synth set, opening a pull request runs the synth command in its checkout and applies its own copy of a CDK Terrain stack at the key suffixed -pr-<n>, beside the state of the stack itself, and closing it destroys the copy on the record|
generate/cdktn|with synth set init and terragucci generate refuse a generate key as a config error that names the CDK Terrain constructs that set a backend|
linked/cdktn|a CDK Terrain stack that reads the state of another through a remote state data source plans in tf-plan on the planned outputs of that stack, read from its cdk.tf.json, unknown where unknown|
init/image|with image naming an image built from the terragucci image, init writes it into every job of the pipeline and the jobs run in it: check passes, a step prints a file only that image holds, and the root applies|
init/env|with env setting TF_VAR_greeting, init writes it into the pipeline, and the apply job applies the root with that value in its state|
estate/local-plan|terragucci plan run on a machine plans each root its glob names against the applied state: the changed root plans its one change, the others none, and the --json envelope lists them all with exit 0|
init/runner-label|with runner.apply naming a label only a second Forgejo runner serves, init writes it as the runs-on of the apply jobs alone, and the push to main runs check on the runner of the stack and the apply job on the labelled one|
init/pass-secrets|with pass naming a repo secret and a repo variable, init writes their names and never their values into the jobs that plan and apply, and the apply job applies the root with both values in its state|'

# The core claims, which SMOKE_BINARY=terraform and SMOKE_BINARY=choudoufu run
# on that binary, each a row of its own in smoke.json.
BINARY_CLAIMS='boot/tofu waves/tofu pr-apply/tofu policy/wave notify/webhook report/tofu drift/tofu cost/gate steps/gate refuse/approve-plan estate/inventory estate/history estate/graph audit/tofu'
# A core claim that shows something else on a binary: <binary> <claim>|what
# its row shows.
BINARY_SAYS='choudoufu drift|with binary: choudoufu and the roots under live resource markers, each root plans in full: the queue deleted outside choudoufu is named by root in the report and one drift issue, the change waiting on main shows as drift too, and a run with no drift closes it
terraform lock-wait|with binary: terraform a tf-apply wave whose plan meets a state lock another Terraform plan holds waits for it under the default -lock-timeout terragucci adds, the root'"'"'s plan time in the report covering the wait, and applies once the lock is released
choudoufu unlock-state|with binary: choudoufu, on a root whose resources carry ownership tags, terragucci unlock-state finds no state file and no state lock. It says there is nothing to release, runs no binary, asks for no approval and records nothing'
# The locking claims a binary runs besides the core ones: <binary> <claim>...
# Terraform takes the backend's state lock as OpenTofu does, so it runs all
# three. choudoufu under live resource markers takes no state lock at all, so
# it runs unlock-state alone, which there has nothing to release; apply-serial
# and lock-wait are about a lock it never takes (its own side is
# choudoufu/concurrency, choudoufu/rows-* and choudoufu/killed, and the plain lock-wait
# row is choudoufu on an s3 backend).
BINARY_LOCK_CLAIMS='terraform apply/serial state/unlock lock/wait-span
choudoufu state/unlock'
# The claims SMOKE_BINARY runs.
binary_claims() { echo $BINARY_CLAIMS $(grep "^$SMOKE_BINARY " <<<"$BINARY_LOCK_CLAIMS" | cut -d' ' -f2-); }

say() { echo "SMOKE claim=$1 verdict=$2${3:+ $3}"; }

# --list needs no Docker: `just lint` runs it to catch a broken CLAIMS.
[ "${1:-}" = --list ] || { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; } \
  || { echo "SKIP: Docker is not available, so no claim can run."; exit 0; }

# The claims, in four parts that stay under the 512 KB lfs-check allows a blob.
# shellcheck source=smoke-claims-1.sh
. "$HERE/smoke-claims-1.sh"
# shellcheck source=smoke-claims-2.sh
. "$HERE/smoke-claims-2.sh"
# shellcheck source=smoke-claims-3.sh
. "$HERE/smoke-claims-3.sh"
# shellcheck source=smoke-claims-4.sh
. "$HERE/smoke-claims-4.sh"
# ── the GitLab claims ─────────────────────────────────────────────────────
# GITLAB_CLAIMS, GITLAB_CLAIM_GROUPS and a gitlab_claim_<area>/<part> per claim.
# shellcheck source=smoke-gitlab.sh
. "$HERE/smoke-gitlab.sh"

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
#   <setup>!   a setup the parts of an area share (setup_shared), named for
#              its repo: lock-pr, lock-tg, lock-plan. Its parts take turns.
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
waves/terragrunt        tg! runner break-first weight=1000
boot/tofu            ex! runner break-first after=apply/steward weight=900
drift/tofu           ex! after=boot/tofu weight=700
affected/terragrunt     tg after=waves/terragrunt weight=500
linked/terragrunt-mock       tg tg-ledger! after=waves/terragrunt weight=490
check/terragrunt        tg runner self! after=waves/terragrunt weight=480
tips/terragrunt-mock    tg after=waves/terragrunt weight=470
linked/terragrunt-mock-trap    tg! tg-ledger! runner after=waves/terragrunt weight=520
report/tofu          ex after=boot/tofu weight=400
respond/refused ex after=boot/tofu weight=350
telemetry/metrics         ex otel! after=boot/tofu weight=340
telemetry/traces          ex otel! after=boot/tofu weight=330
report/highlight       ex after=boot/tofu weight=300
tips/tofu            ex after=boot/tofu weight=300
reconcile/tofu       runner self! weight=300
reconcile/mixed self! weight=60
rollout/tofu         runner self! weight=500
linked/fresh      ex after=boot/tofu weight=250
waves/tofu           runner self! weight=200
linked/states   runner self! weight=260
linked/plan     self! weight=90
linked/local self! weight=90
linked/backend-config self! weight=90
note/blast  weight=150
refuse/tofu          runner self! weight=200
approval/sealed          runner self! weight=200
modules/publish         runner self! registry! weight=200
modules/attest  runner self! registry! weight=200
modules/require runner self! weight=200
modules/recorded runner self! weight=200
modules/terragrunt-require runner self! weight=220
modules/registry self! weight=120
oidc/forgejo    runner self! weight=200
oidc/audience-stages    runner self! weight=200
apply/groups            runner self! weight=250
apply/check-job         runner self! weight=250
forge/check             self! weight=120
note/grouped         ex runner self! after=boot/tofu weight=200
check/tofu           ex runner self! after=boot/tofu weight=200
affected/tofu        ex after=boot/tofu weight=150
affected/outside-roots  weight=150
respond/tips    runner self! weight=150
apply/serial    runner self! break:runner! weight=100
respond/drift   self! weight=80
respond/fmt     self! weight=60
respond/triage  weight=60
init/zero-config     weight=30
init/terragrunt  weight=30
respond/notes   weight=20
policy/tofu          ex after=boot/tofu weight=150
apply/steward         ex! runner fountain! weight=950
comment/plan    runner self! weight=150
comment/atlantis runner self! weight=150
import/atlantis ex after=boot/tofu weight=150
import/spacelift weight=30
import/env0     weight=30
import/hcp      weight=60
import/scalr    weight=60
import/terragrunt-scale weight=30
waves/after     runner self! weight=150
lock/wait-span       otel! self! weight=150
telemetry/dash-pipeline   ex otel after=boot/tofu weight=120
telemetry/dash-changes    ex otel after=boot/tofu weight=120
telemetry/dash-waves      ex otel after=boot/tofu weight=120
telemetry/dash-drift      ex otel after=boot/tofu weight=120
telemetry/dash-estate     ex otel after=boot/tofu weight=120
telemetry/dash-runs       ex otel after=boot/tofu weight=120
telemetry/dash-slos       ex otel after=boot/tofu weight=120
report/drill-down      ex otel after=boot/tofu weight=120
policy/wave     weight=150
check/diagnostics    runner self! weight=150
comment/not-affected runner self! weight=150
drift/attribute      self! weight=90
modules/version-bump     runner self! weight=150
telemetry/terragrunt-spans             tg after=waves/terragrunt weight=450
oidc/clouds          weight=20
comment/apply        runner self! weight=200
agent/comment        runner self! weight=200
agent/review         runner self! weight=200
policy/review-risk        runner self! weight=250
report/wave     weight=120
policy/delete-key    ex after=boot/tofu weight=150
report/oidc          ex after=boot/tofu weight=150
pr-apply/tofu             runner self! weight=250
lock/apply        runner self! lock-pr! weight=300
pr-apply/stale       runner self! weight=200
telemetry/provider-calls       weight=90
telemetry/summed-timings       weight=90
init/foreign-checkout     ex after=boot/tofu weight=150
waves/terragrunt-layers            runner self! weight=300
waves/atmos          runner self! weight=350
apply/atmos-workspace      self! weight=150
affected/atmos       runner self! weight=250
linked/atmos  runner self! weight=400
check/atmos          runner self! weight=150
init/atmos-version        self! weight=90
oidc/atmos-roles          self! weight=150
waves/terramate      runner self! weight=350
affected/terramate   runner self! weight=250
linked/terramate    runner self! weight=400
check/terramate      runner self! weight=150
init/atmos-refuse         weight=60
policy/source        self! weight=150
reconcile/parallelism weight=120
reconcile/provider self! weight=90
pr-apply/requires          runner self! weight=300
lock/comment              runner self! lock-pr! weight=200
report/front-door           self! weight=40
approval/ledger       runner self! weight=200
approval/at-base     runner self! weight=250
approval/sealed-migrate       runner self! weight=250
estate/tofu               weight=120
behold/view          weight=120
behold/serve         weight=150
behold/terragucci-view      weight=150
note/drift-overdue        self! weight=60
approval/pr-review            runner self! weight=300
refuse/pr-review      runner self! weight=300
approval/pr-review-status     runner self! weight=250
refuse/approve-plan         runner self! weight=150
approval/resume       runner self! weight=250
approval/resume-schedule      runner self! weight=300
choudoufu/concurrency      weight=500
choudoufu/iam              self! weight=250
choudoufu/record-versions  weight=120
choudoufu/killed           weight=300
apply/per-root       runner self! weight=300
apply/stand-down     runner self! weight=300
choudoufu/rows-overlap     runner self! weight=250
choudoufu/rows-wait        self! weight=200
choudoufu/rows-takeover    runner self! weight=300
drift/choudoufu            self! weight=150
note/approve-command      runner self! weight=250
lock/terragrunt     runner self! lock-tg! weight=300
lock/atmos  runner self! weight=300
lock/plan            runner self! plain:lock-plan! weight=250
lock/plan-release    runner self! plain:lock-plan! weight=190
policy/override      weight=150
report/azure           azurite! weight=120
report/gcs             gcs! weight=120
note/diff            ex runner self! after=boot/tofu weight=200
note/split           weight=60
note/report-link     weight=60
init/config-ts            weight=20
init/role-refused         weight=20
review/description    weight=100
telemetry/headers         weight=60
init/pinned-install       weight=60
init/root-pins            weight=60
generate/tofu             weight=60
generate/terragrunt          weight=150
generate/terragrunt-init     weight=120
drift/close          self! weight=90
estate/control       self! weight=80
estate/override      weight=150
report/contracts     weight=110
note/stale           runner self! weight=200
pr-apply/confirm           runner self! weight=300
pr-apply/guard             runner self! weight=300
lock/close-release     runner self! lock-pr! weight=200
lock/terragrunt-fanout       runner self! lock-tg! weight=200
security/token-scrub          weight=60
security/plan-token-free      runner self! weight=250
security/replan-apply-role    runner self! weight=250
security/replan-cache         runner self! weight=300
security/fork         runner self! weight=250
report/sensitive  weight=90
approval/signer-trust         runner self! weight=250
rollout/control      runner self! weight=400
rollout/pins         self! weight=180
policy/opa           weight=150
policy/hcp           weight=150
policy/hcl           weight=150
policy/sources-module    ex after=boot/tofu weight=150
policy/sources-provider  ex after=boot/tofu weight=150
policy/sources-at-base   ex after=boot/tofu weight=150
oidc/terragrunt       weight=200
affected/terragrunt-dependents        weight=250
linked/terragrunt-preview           self! weight=120
linked/terragrunt-preview-gate      runner self! weight=400
binary/terraform         runner self! weight=300
binary/terragrunt-terraform         runner self! weight=300
drift/tfquery       self! weight=120
telemetry/alerts          otel self! weight=300
report/gcs-key         gcs! weight=120
report/azure-key       azurite! weight=120
report/index-writes         self! weight=90
note/footer          runner self! weight=150
comment/dispatch      runner self! weight=150
choudoufu/shared-bucket    weight=120
choudoufu/migrate          weight=350
init/cdktn-synth          runner self! weight=200
audit/tofu                weight=150
report/outcome        self! weight=120
audit/override       weight=150
audit/refused        weight=150
audit/control        weight=150
estate/inventory            weight=150
estate/graph         weight=200
estate/history     weight=200
estate/query            weight=200
state/versions       weight=150
oidc/state-roles          weight=150
state/export         weight=200
state/gcs            gcs! weight=150
state/azurerm        azurite! weight=150
state/gcs-unlock           gcs! weight=150
state/azurerm-unlock       azurite! weight=150
migrate/blob         gcs! azurite! weight=200
oidc/cloud-roles          gcs! azurite! weight=200
estate/state-edges          weight=250
migrate/split        weight=350
migrate/cdktn        weight=200
migrate/backends     weight=300
migrate/resume       runner self! weight=300
estate/dora                 weight=250
notify/chat          runner self! weight=250
notify/webhook       runner self! weight=150
cost/estimate        runner self! weight=150
cost/gate            runner self! weight=200
cost/policy          weight=150
refuse/approval-used        runner self! weight=200
affected/cdktn       runner self! weight=200
apply/cdktn          runner self! weight=300
lock/cdktn  runner self! weight=400
tips/cdktn           runner self! weight=200
init/cdktn-refuse        weight=60
waves/jobs            runner self! weight=250
init/own-jobs        runner self! weight=120
apply/branches       runner self! weight=300
drift/branches weight=200
steps/before-plan    runner self! weight=200
steps/stop           runner self! weight=150
steps/gate           runner self! weight=200
respond/terragrunt-fmt       runner self! weight=150
state/terragrunt-versions    weight=150
respond/terragrunt-drift          self! weight=150
drift/terragrunt-attribute   self! weight=150
migrate/terragrunt-split     weight=200
init/terragrunt-root-pins         weight=150
binary/terragrunt-choudoufu         weight=120
waves/terragrunt-stack            weight=150
check/terragrunt-stack       runner self! weight=150
affected/terragrunt-stack    weight=120
drift/terragrunt-stack       weight=150
estate/terragrunt-graph      weight=200
estate/terragrunt-remote-state weight=220
state/terragrunt-export      weight=200
apply/terragrunt-branches    runner self! weight=300
chat/slack         runner self! weight=300
chat/teams   runner self! weight=300
chat/lambda  runner self! weight=350
chat/replan          self! weight=90
lock/plan-none         weight=120
note/sensitive   weight=90
apply/provider-cache  weight=90
apply/provider-cache-no-lock  weight=90
state/unlock         runner self! weight=300
tips/moved            self! weight=150
estate/mcp       weight=120
agent/drift          runner self! weight=250
apply/runner-nudge         stack! self! weight=200
drift/github   self! weight=90
lock/plan-fmt        runner self! plain:lock-plan! weight=200
ephemeral/pr         runner self! weight=250
ephemeral/ttl        runner self! weight=250
ephemeral/terragrunt      runner self! weight=300
ephemeral/cdktn      runner self! weight=300
generate/cdktn       weight=60
linked/cdktn         self! weight=90
init/image                runner self! weight=150
init/env                  runner self! weight=150
init/runner-label         runner self! weight=150
init/pass-secrets         runner self! weight=150
estate/local-plan           ex after=boot/tofu weight=90
'

# The Forgejo claims' table, which orders the rows of smoke.json on any forge.
FORGEJO_CLAIMS="$CLAIMS"
# Under SMOKE_BINARY=terraform or choudoufu the claims are the core ones.
if [ "$SMOKE_BINARY" != tofu ]; then
  CLAIMS="$(awk -F'|' -v keep=" $(binary_claims) " 'index(keep, " " $1 " ")' <<<"$CLAIMS")"
fi
# On GitLab the claims are GitLab's, with their own groups and locks: no lock
# of a run on the validation stack holds up a run on the lab.
if [ "$SMOKE_FORGE" = gitlab ]; then
  CLAIMS="$GITLAB_CLAIMS"
  CLAIM_GROUPS="$GITLAB_CLAIM_GROUPS"
fi
# shellcheck source=locks.sh
. "$HERE/locks.sh"

settle_example() { # the example verified, or booted afresh when a claim left something
  "$HERE/example.sh" verify >&2 || "$HERE/example.sh" up --fresh >&2
}

# --list: one line per claim, "name function=yes|no group=yes|no", then exits
# before anything touches Docker. scripts/check-smoke.mjs reads it.
if [ "${1:-}" = --list ]; then
  while IFS='|' read -r n _; do
    [ -n "$n" ] || continue
    f=no; declare -F "$CLAIM_FN${n//-/_}" >/dev/null && f=yes
    g=no; awk -v n="$n" '$1 == n { f = 1 } END { exit !f }' <<<"$CLAIM_GROUPS" && g=yes
    echo "$n function=$f group=$g"
  done <<<"$CLAIMS"
  exit 0
fi

# ── what a claim's runs hold ──

group_tokens() { # claim -> its tokens, or the default for a claim with no line
  local line
  line="$(awk -v n="$1" '$1 == n { $1 = ""; print; exit }' <<<"$CLAIM_GROUPS")"
  # Another binary's runs hold its own copy of the example, not the example.
  [ "$SMOKE_BINARY" = tofu ] || line="$(sed -E "s/(^| )ex(!?)( |$)/\1ex-$SMOKE_BINARY\2\3/g" <<<"$line")"
  if [ -n "${line// /}" ]; then echo "$line"; else echo "stack! after=boot/tofu,waves/terragrunt weight=1"; fi
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
if [ "$SMOKE_FORGE" = gitlab ]; then SMOKE_LOG_BASE="$HERE/gitlab/.state/smoke-logs"; else SMOKE_LOG_BASE="$HERE/.state/smoke-logs"; fi
SMOKE_LOG_DIR="${SMOKE_LOG_DIR:-$SMOKE_LOG_BASE/$(date +%Y%m%d-%H%M%S)}"
SMOKE_LINES_TO=stdout
SMOKE_BREAK_VALUE=1
QUEUE=""

# A run's precomputed locks and claims to wait for live in RL_<key> and RA_<key>.
# A claim is <area>/<part>, so the slash becomes _S_ as the hyphen becomes _ and the colon __.
runvar_key() { local k="${1//-/_}"; k="${k//\//_S_}"; RUNVAR_KEY="${k//:/__}"; }

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
    echo "$line" >"$SMOKE_LOG_DIR/${name//\//.}.plain.verdict"
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
    >"$SMOKE_LOG_DIR/${name//\//.}.$mode.log" 2>&1 </dev/null &
  LAST_PID=$!
}

finish_run() { # run
  local run="$1" name="${1%:*}" mode="${1#*:}" line
  line="$(grep "^SMOKE claim=$name " "$SMOKE_LOG_DIR/${name//\//.}.$mode.log" 2>/dev/null | tail -1 || true)"
  [ -n "$line" ] || line="SMOKE claim=$name verdict=fail no-verdict"
  echo "$line" >"$SMOKE_LOG_DIR/${name//\//.}.$mode.verdict"
  unlock_holder "$$.$run"
  smoke_line "$line"
}

# A claim can wait silently for up to its timeout (lib.sh's TIMEOUT) on
# something its break keeps from happening, so the default allows that plus
# two minutes: a claim silent past its own timeout is stuck.
stall_default=$(( ${TERRAGUCCI_VALIDATE_TIMEOUT:-900} / 60 + 2 ))
SMOKE_STALL_MIN="${SMOKE_STALL_MIN:-$stall_default}"
case "$SMOKE_STALL_MIN" in ''|*[!0-9]*|0) SMOKE_STALL_MIN=$stall_default ;; esac

# A run whose log has not grown for SMOKE_STALL_MIN minutes: say what it was
# doing and what the stack is running, stop it and its children, and leave a
# failing SMOKE line in its log. Returns 1 while the run is still moving.
stalled() { # pid, run
  local pid="$1" run="$2" name="${2%:*}" mode="${2#*:}" log
  log="$SMOKE_LOG_DIR/${name//\//.}.$mode.log"
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
  # This tree's own image tags: a run from another worktree builds its own, so
  # neither runs the other's bundle (scripts/images.ts, push_tree in lib.sh).
  if [ "$SMOKE_FORGE" != gitlab ]; then
    TG_IMAGE_SUFFIX="-t$(cd "$HERE/.." && cat packages/terragucci/dist/terragucci.mjs images/Dockerfile.* | shasum -a 256 | cut -c1-12)"
    export TG_IMAGE_SUFFIX
  fi
  SMOKE_TOFU_IMAGE="$(image_tag tofu)"; SMOKE_TG_IMAGE="$(image_tag terragrunt)"
  SMOKE_TF_IMAGE="$(image_tag terraform)"; SMOKE_CDF_IMAGE="$(image_tag choudoufu)"
  export SMOKE_TOFU_IMAGE SMOKE_TG_IMAGE SMOKE_TF_IMAGE SMOKE_CDF_IMAGE
  # The lab is never started here: GitLab is heavy, and `just gitlab-lab up`
  # is a choice. Its jobs run the lab's own image, the tofu image with this
  # tree's bundle (gitlab.sh image), so a GitLab run leaves the shared image
  # tags as they are.
  if [ "$SMOKE_FORGE" = gitlab ]; then
    gitlab_lab_env || return 1
    TG_TOFU_IMAGE="$("$HERE/gitlab/gitlab.sh" image 2>"$SMOKE_LOG_DIR/images.log")" \
      || { echo "[smoke] the lab's image did not build; see $SMOKE_LOG_DIR/images.log" >&2; return 1; }
    export TG_TOFU_IMAGE
    return
  fi
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
  if runnable_names | grep -qx apply/steward; then
    "$HERE/bootstrap.sh" fountain >/dev/null 2>"$SMOKE_LOG_DIR/bootstrap-fountain.log" \
      || { cat "$SMOKE_LOG_DIR/bootstrap-fountain.log" >&2; echo "[smoke] the fountain profile did not start" >&2; return 1; }
  fi
  # shellcheck disable=SC1091
  . "${TG_STATE:-$HERE/.state}/forgejo.env"
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
  # A claim is <area>/<part>; an area alone names every part of it, so
  # `--only lock` runs lock/apply, lock/terragrunt and the rest.
  SMOKE_ONLY="$(for n in $SMOKE_ONLY; do
    case "$n" in
      */*) echo "$n" ;;
      *) parts="$(awk -F'|' -v a="$n/" 'index($1, a) == 1 { print $1 }' <<<"$CLAIMS")"; echo "${parts:-$n}" ;;
    esac
  done)"
  export SMOKE_ONLY
  for n in $SMOKE_ONLY; do
    grep -q "^$n|" <<<"$CLAIMS" && continue
    if [ "$SMOKE_FORGE" = gitlab ]; then echo "smoke: no GitLab claim '$n' (GITLAB_CLAIMS in stack/smoke-gitlab.sh)" >&2
    elif [ "$SMOKE_BINARY" != tofu ]; then echo "smoke: no $SMOKE_BINARY claim '$n'; SMOKE_BINARY runs$(printf ' %s' $(binary_claims))" >&2
    else echo "smoke: unknown claim '$n'" >&2; fi
    exit 2
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
    plain="$(cat "$SMOKE_LOG_DIR/${name//\//.}.plain.verdict" 2>/dev/null || true)"
    [ -n "$plain" ] || plain="SMOKE claim=$name verdict=fail no-verdict"
    broken="$(cat "$SMOKE_LOG_DIR/${name//\//.}.break.verdict" 2>/dev/null || true)"
    row="$(grep "^$name|" <<<"$CLAIMS")"
    says="$(cut -d'|' -f2 <<<"$row")"; issue="$(cut -d'|' -f3 <<<"$row")"
    alt="$(grep "^$SMOKE_BINARY $name|" <<<"$BINARY_SAYS" | cut -d'|' -f2 || true)"
    [ -z "$alt" ] || says="$alt"
    # A GitLab row names its forge; a row with none is Forgejo's, as the
    # file's own forge says. A row of another binary names it; a row with
    # none is OpenTofu's.
    rows+=("$(jq -n --arg c "$name" --arg s "$says" --arg i "$issue" --arg p "$plain" --arg b "$broken" --arg f "${SMOKE_FORGE#forgejo}" --arg bin "${SMOKE_BINARY#tofu}" '{
      claim: $c, says: $s, needs: (if $i == "" then null else $i end),
      verdict: ($p | capture("verdict=(?<v>[a-z]+)").v),
      break: (if $b == "" then null else ($b | capture("verdict=(?<v>[a-z]+)").v) end)
    } + (if $f == "" then {} else {forge: $f} end) + (if $bin == "" then {} else {binary: $bin} end)')")
  done
  # Leave the example booted and clean for whoever runs next. Each claim puts
  # back what it changed, so this boots afresh only when something was left.
  # `up --fresh` recreates floci under every run on the stack, so it waits for
  # the stack alone: runs from other worktrees share the locks and finish first.
  # Most records end with the example intact: verify only reads, so it needs
  # no lock, and only a broken example waits for the stack alone.
  # Another binary's runs read their own copy of the example, which nothing else reads.
  [ "$SMOKE_FORGE" != forgejo ] || [ "$SMOKE_BINARY" != tofu ] || "$HERE/example.sh" verify >&2 || with_lock stack settle_example
  disk_check "$disk_start"
  new="$(printf '%s\n' "${rows[@]}" | jq -s .)"
  # The rows' order: each Forgejo claim in CLAIMS order with its Terraform,
  # choudoufu and GitLab rows after it, then the GitLab claims Forgejo has no
  # row for. A row's key is its forge, its binary and its claim.
  order="$( { while IFS='|' read -r n _; do [ -n "$n" ] && printf 'forgejo tofu %s\nforgejo terraform %s\nforgejo choudoufu %s\ngitlab tofu %s\n' "$n" "$n" "$n" "$n"; done <<<"$FORGEJO_CLAIMS"
    cut -d'|' -f1 <<<"$GITLAB_CLAIMS" | sed 's/^/gitlab tofu /'; } | awk '!seen[$0]++' | jq -R . | jq -s .)"
  if [ -n "$SMOKE_ONLY" ] || [ "$SMOKE_FORGE" != forgejo ] || [ "$SMOKE_BINARY" != tofu ]; then
    # Only these claims ran: their rows replace the old ones (the same claim
    # on the same forge) and every other row stays as the last record left it.
    # Each new row names the commit it ran on; the file's own commit is the
    # last full record's.
    [ -f "$out" ] || { echo "smoke: --only --record needs an existing $out" >&2; exit 2; }
    new="$(jq --arg commit "$(git -C "$HERE/.." rev-parse --short HEAD)" --argjson order "$order" \
      --slurpfile old "$out" 'def key: (.forge // "forgejo") + " " + (.binary // "tofu") + " " + .claim;
        (map(. + {commit: $commit}) | map({key: key, value: .}) | from_entries) as $mine
        | ($old[0].claims | map({key: key, value: .}) | from_entries) as $was
        | [$order[] | ($mine[.] // $was[.]) | select(. != null)]' <<<"$new")"
    if [ "$(jq -S .claims "$out")" = "$(jq -S . <<<"$new")" ]; then echo "unchanged $out" >&2; exit 0; fi
    jq --argjson c "$new" '.claims = $c' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
    echo "wrote the rows of $(echo ${SMOKE_ONLY:-$(names)} | wc -w | tr -d ' ') $SMOKE_FORGE $SMOKE_BINARY claims into $out" >&2
    exit 0
  fi
  # Every Forgejo claim ran; the rows of other forges stay as they were.
  if [ -f "$out" ]; then
    new="$(jq --argjson order "$order" --slurpfile old "$out" 'def key: (.forge // "forgejo") + " " + (.binary // "tofu") + " " + .claim;
      (map({key: key, value: .}) | from_entries) as $mine
      | ($old[0].claims | map(select((.forge // "forgejo") != "forgejo" or (.binary // "tofu") != "tofu")) | map({key: key, value: .}) | from_entries) as $was
      | [$order[] | ($mine[.] // $was[.]) | select(. != null)]' <<<"$new")"
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
    hold_locks "$$.${name//\//.}.$mode" $(claim_locks "$name" "$mode")
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
