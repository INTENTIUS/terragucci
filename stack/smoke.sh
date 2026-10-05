#!/usr/bin/env bash
#
# One smoke claim per feature the site claims, run against the example.
#
#   stack/smoke.sh               every claim
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
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"

# Every claim's temp work dir is recorded here and removed on every exit path:
# when the claim returns (run_claim), and on exit, interrupt or termination.
SMOKE_WORKS=()
track_work() { SMOKE_WORKS+=("$1"); }
cleanup_works() {
  local d
  for d in ${SMOKE_WORKS[@]+"${SMOKE_WORKS[@]}"}; do [ -n "$d" ] && rm -rf "$d"; done
  SMOKE_WORKS=()
}
trap cleanup_works EXIT
trap 'cleanup_works; exit 130' INT
trap 'cleanup_works; exit 143' TERM

# The provider and binary cache the forge's job containers mount at /cache
# (container.options in bootstrap.sh). The local report runs mount it too, so
# a provider downloads once per stack pass, not once per root per run.
JOB_CACHE_VOLUME=terragucci-job-cache

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
forgejo-oidc|a Forgejo job gets an OIDC token Forgejo signed for its repo and ref, and trades it for the plan or apply role|'

say() { echo "SMOKE claim=$1 verdict=$2${3:+ $3}"; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so no claim can run."; exit 0; }

# ── the implemented claims ────────────────────────────────────────────────
# Each returns 0 when the property held and 1 when it did not, and prints its
# evidence on stderr.

claim_boot() {
  local skip=""
  [ -n "${BREAK:-}" ] && skip="envs/prod/email"
  TG_SKIP_ROOT="$skip" "$HERE/example.sh" up --fresh >&2 || return 1
  "$HERE/example.sh" verify >&2
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
    || { log "no example repo; run 'just example up' first"; rm -rf "$work"; return 1; }
  local unformatted='locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}'
  [ -n "${BREAK:-}" ] && echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: clean $(date +%s)")"
  wait_run "$repo" "$sha"
  if [ "$RUN_STATUS" != success ]; then log "the clean push ended '$RUN_STATUS'"; rm -rf "$work"; return 1; fi
  echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: unformatted $(date +%s)")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fcheck" || true
  rm -rf "$work"
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
  rm -rf "$work"
  return $rc
}

claim_apply_serial() {
  # A scratch repo whose one root writes a mark to floci when its apply starts
  # and another when it ends, with a long pause between. The first push is
  # let run until its apply has started, then a second push lands. The marks
  # must read start end start end: the second apply waited for the first.
  # BREAK: the lock is cut out of the committed pipeline, so the applies overlap.
  # The runner has capacity 4, so a free slot never forces the order: only the
  # concurrency group and the state lock do.
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
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the second run ended $RUN_STATUS"; rm -rf "$work"; return 1; }
  marks="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' ')"
  log "marks in key order: $marks"
  rm -rf "$work"
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
  gated_repo waves || { rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  gated_repo sealed || { rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  gated_repo refuse || { rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  out="$(TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" reconcile --config "$work/terragucci.yml" --mode "$mode" 2>&1)" || { echo "$out" >&2; rm -rf "$work"; return 1; }
  echo "$out" >&2
  rm -rf "$work"
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
report_run() {
  local work="$1"; shift
  local image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" p
  image="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || return 1
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
    "$image" terragucci stage "${REPORT_STAGE:-tf-plan}" ${REPORT_ARGS[@]+"${REPORT_ARGS[@]}"} >&2
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
  rm -rf "$work"
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
  [ -f "$r" ] || { log "no report"; rm -rf "$work"; return 1; }
  got="$(jq -r '[.roots[] | select(.status == "planned") | .path] | sort | join(",")' "$r")"
  [ "$got" = "$want" ] || { log "planned $got, not $want"; rc=1; }
  rm -rf "$work"
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
    || { log "no example repo; run 'just example up' first"; rm -rf "$work"; return 1; }
  # The pipeline this tree renders, so the pull request runs it whatever main carries.
  cp "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/tree/.forgejo/workflows/terragucci.yml"
  git -C "$work/tree" apply "$EXAMPLE/changes/module-bump.patch" || { rm -rf "$work"; return 1; }
  [ -n "${BREAK:-}" ] && sed -i.bak "s#terragucci stage tf-plan --out#terragucci stage tf-plan --root 'envs/dev/*' --out#" "$work/tree/.forgejo/workflows/terragucci.yml" && rm -f "$work/tree/.forgejo/workflows/terragucci.yml.bak"
  sha="$(push_tree "$work/tree" "$repo" "$branch" "smoke grouped: module-bump $(date +%s)")"
  pr="$(open_pr "$repo" "$branch")"
  [ -n "$pr" ] || pr="$(api -H 'content-type: application/json' -X POST \
    -d "$(jq -n --arg h "$branch" '{head: $h, base: "main", title: "smoke grouped: module-bump"}')" "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  [ -n "$pr" ] && [ "$pr" != null ] || { log "no pull request"; rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  docker compose -f "$HERE/docker-compose.yml" --project-name terragucci --profile observability up -d >&2 || return 1
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
  rm -rf "$work"
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
  [ -f "$report" ] || { log "the run wrote no report"; rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  [ -f "$dir/report.json" ] || { log "no report"; rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
  [ -n "${BREAK:-}" ] || TERRAGUCCI_FLOCI_URL="$FLOCI" "$EXAMPLE/changes/drift.sh" >&2 || { rm -rf "$work"; return 1; }

  drift_run "$work/run1" || { log "the drift run failed"; rm -rf "$work"; return 1; }
  dir="$work/run1/terragucci-report"
  [ -f "$dir/report.json" ] || { log "no report"; rm -rf "$work"; return 1; }
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
  [ $rc = 0 ] || { rm -rf "$work"; return 1; }

  # A second run on the same drift updates the one issue.
  drift_run "$work/run2" || { log "the second drift run failed"; rm -rf "$work"; return 1; }
  [ "$(open_issues | jq length)" = 1 ] || { log "a second run left $(open_issues | jq length) open issues"; rm -rf "$work"; return 1; }

  # The example applied again recreates the queue, so no delete is left.
  "$HERE/example.sh" reset >&2 || { log "could not apply the example again"; rm -rf "$work"; return 1; }
  drift_run "$work/run3" || { log "the third drift run failed"; rm -rf "$work"; return 1; }
  [ "$(jq '[.roots[].changes[] | select(.action == "delete")] | length' "$work/run3/terragucci-report/report.json")" = 0 ] \
    || { log "a deleted object remains after the example was applied again"; rm -rf "$work"; return 1; }
  # A run that finds no drift closes the issue. The scratch root has no resources, so none can drift.
  mkdir -p "$work/clean/envs/empty"
  printf 'terraform {\n  backend "local" {}\n}\n' > "$work/clean/envs/empty/main.tf"
  REPORT_TREE="$work/clean" drift_run "$work/run4" || { log "the clean drift run failed"; rm -rf "$work"; return 1; }
  [ "$(jq '[.roots[].changes[]] | length' "$work/run4/terragucci-report/report.json")" = 0 ] || { log "the clean run reports drift"; rm -rf "$work"; return 1; }
  [ "$(open_issues | jq length)" = 0 ] || { log "the drift issue is still open with no drift"; rm -rf "$work"; return 1; }
  rm -rf "$work"
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
  [ -f "$on/report.json" ] && [ -f "$off/report.json" ] || { log "a run wrote no report"; rm -rf "$work"; return 1; }
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
  rm -rf "$work"
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
    || { log "openssl could not make a certificate"; rm -rf "$work"; return 1; }
  chmod 644 "$work/certs/registry.key"
  TERRAGUCCI_REGISTRY_CERTS="$work/certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile registry up -d --force-recreate registry >&2 || { rm -rf "$work"; return 1; }
  local i
  for i in $(seq 1 30); do
    curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 \
    || { log "the registry did not come up"; rm -rf "$work"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || { rm -rf "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || { rm -rf "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  # The registry takes any credentials; the job still has to be handed them.
  for t in TERRAGUCCI_REGISTRY_USER TERRAGUCCI_REGISTRY_PASSWORD; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"data":"smoke"}' "$URL/api/v1/repos/$repo/actions/secrets/$t" \
      || { log "could not set the $t secret"; rm -rf "$work"; return 1; }
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
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { rm -rf "$work"; return 1; }
  grep -q "terragucci publish" "$tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no publish job"; rm -rf "$work"; return 1; }
  tags() { curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/$repo/$1/tags/list" | jq -r '.tags // [] | sort | join(",")'; }
  gittags() { git ls-remote --tags "$remote" 'refs/tags/modules/*' | sed -E 's#.*refs/tags/##; /\^\{\}$/d' | sort | paste -sd, -; }
  run() { # message: push the tree and wait for the run on it
    sha="$(push_tree "$tree" "$repo" main "$1")"
    wait_run "$repo" "$sha"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the run for '$1' ended $RUN_STATUS"; return 1; }
  }
  run "feat: modules" || { rm -rf "$work"; return 1; }
  [ "$(tags service)" = "0.1.0" ] && [ "$(tags queue)" = "0.1.0" ] || { print_logs "$repo" "$RUN_ID" >&2; log "first merge: service has '$(tags service)', queue '$(tags queue)'"; rm -rf "$work"; return 1; }
  [ "$(gittags)" = "modules/queue/v0.1.0,modules/service/v0.1.0" ] || { log "first merge: the remote has tags '$(gittags)'"; rm -rf "$work"; return 1; }
  # A clone without the release tags is told the version is published, and exits 0.
  git clone -q --no-tags "$remote" "$work/clone" || { rm -rf "$work"; return 1; }
  printf 'modules:\n  path: modules/*\n  publish: git-tags\n' > "$work/git-only.yml"
  out="$(cd "$work/clone" && "$TERRAGUCCI" publish --config "$work/git-only.yml" 2>&1)" || { echo "$out" >&2; log "a clone without tags did not exit 0"; rm -rf "$work"; return 1; }
  echo "$out" >&2
  grep -q ": published" <<<"$out" && { log "a clone without tags published again"; rm -rf "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    for t in $(gittags | tr ',' ' '); do git -C "$tree" push -q "$remote" ":refs/tags/$t"; done
  fi
  before="$(git ls-remote --tags "$remote" 'refs/tags/modules/*' | sort)"
  run "chore: nothing changed" || { rm -rf "$work"; return 1; }
  [ "$(tags service)" = "0.1.0" ] && [ "$(tags queue)" = "0.1.0" ] && [ "$(git ls-remote --tags "$remote" 'refs/tags/modules/*' | sort)" = "$before" ] \
    || { print_logs "$repo" "$RUN_ID" >&2; log "a push that changed nothing published: registry '$(tags service)' '$(tags queue)', remote tags '$(gittags)'"; rm -rf "$work"; return 1; }
  printf 'output "id" { value = terraform_data.service.id }\n' > "$tree/modules/service/outputs.tf"
  run "feat(service): an id output" || { rm -rf "$work"; return 1; }
  [ "$(tags service)" = "0.1.0,0.2.0" ] && [ "$(tags queue)" = "0.1.0" ] || { print_logs "$repo" "$RUN_ID" >&2; log "after a change: service has '$(tags service)', queue '$(tags queue)'"; rm -rf "$work"; return 1; }
  log "the pipeline published both modules on merge, a rerun published nothing, and a change to service alone moved it to 0.2.0"
  rm -rf "$work"
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
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { rm -rf "$work"; return 1; }
  ( cd "$tree" && git init -q -b main && git remote add origin "$remote" && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat: three roots on modules/network 0.1.0" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m "modules/network 0.1.0" \
    && git push -q origin refs/tags/modules/network/v0.1.0 main ) 2>/dev/null || { log "could not push the repo"; rm -rf "$work"; return 1; }
  sha="$(git -C "$tree" rev-parse HEAD)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the first apply ended $RUN_STATUS"; rm -rf "$work"; return 1; }

  # A new module version, published by tf-publish as a git tag.
  printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> "$tree/modules/network/main.tf"
  ( cd "$tree" && git add -A && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat(network): a version output" \
    && git push -q origin main ) 2>/dev/null || { rm -rf "$work"; return 1; }
  wait_run "$repo" "$(git -C "$tree" rev-parse HEAD)"
  (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" publish) >&2 || { rm -rf "$work"; return 1; }

  ro() { (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout modules/network "$@" 2>&1); }
  out="$(ro)" || { echo "$out" >&2; rm -rf "$work"; return 1; }
  echo "$out" >&2
  grep -q "modules/network 0.1.0 -> 0.2.0 (newest published: tag modules/network/v0.2.0): would-open" <<<"$out" \
    || { log "the dry run did not find 0.2.0 on its own"; rm -rf "$work"; return 1; }
  [ -n "${BREAK:-}" ] && mode=dry-run

  pr_for() { api "$URL/api/v1/repos/$repo/pulls?state=all&limit=50" | jq -r --arg b "terragucci/rollout/modules-network-0.2.0/wave-$1" '.[] | select(.head.ref == $b) | .number' | head -1; }
  local wave expect=("" "dev/app/main.tf" "prod/net/main.tf" "prod/app/main.tf")
  for wave in 1 2 3; do
    out="$(ro --mode "$mode")"; rc=$?
    echo "$out" >&2
    pr="$(pr_for "$wave")"
    [ -n "$pr" ] || { log "wave $wave: no pull request opened"; rm -rf "$work"; return 1; }
    files="$(api "$URL/api/v1/repos/$repo/pulls/$pr/files" | jq -r '[.[].filename] | join(",")')"
    [ "$files" = "${expect[$wave]}" ] || { log "wave $wave's pull request changes '$files', not ${expect[$wave]}"; rm -rf "$work"; return 1; }
    # Open: the next run waits and opens nothing.
    out="$(ro --mode "$mode")"; rc=$?
    [ $rc = 3 ] && [ -z "$(pr_for $((wave + 1)))" ] || { echo "$out" >&2; log "wave $wave open: exit $rc, or the next wave opened"; rm -rf "$work"; return 1; }
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
    sha="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merge_commit_sha)"
    # Merged, apply not yet reported: still nothing opens.
    out="$(ro --mode "$mode")"; rc=$?
    if [ -n "$(pr_for $((wave + 1)))" ]; then
      n="$(api "$URL/api/v1/repos/$repo/commits/$sha/statuses" | jq -r '[.[] | select(.context | test("/ apply"))] | max_by(.id) | .status // "none"')"
      [ "$n" = success ] || { echo "$out" >&2; log "wave $((wave + 1)) opened while wave $wave's apply was '$n'"; rm -rf "$work"; return 1; }
    fi
    wait_run "$repo" "$sha"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "wave $wave's apply ended $RUN_STATUS"; rm -rf "$work"; return 1; }
  done
  out="$(ro --mode "$mode")"; rc=$?
  echo "$out" >&2
  rm -rf "$work"
  [ $rc = 0 ] && grep -q ": complete" <<<"$out" || { log "after three waves the rollout is not complete (exit $rc)"; return 1; }
  log "0.2.0 found from its tag; three waves, one pull request each moving only its root, each opened only after the last applied"
}

# ── responses to pipeline events ──────────────────────────────────────────
# `terragucci respond <event>` runs in the tofu CI image on the stack's
# network, with the bundle built from this tree, against floci and a scratch
# Forgejo repo per claim. Nothing here needs the example booted.

STAMP="$(date +%s)"

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
  image="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  [ -f "$bundle" ] || (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || return 1
  docker run --rm --network terragucci -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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
  out="$(cd "$work/current" && "$TERRAGUCCI" respond wave-refused --approved "$work/approved/terragucci-report" --current terragucci-report --json)" || { rm -rf "$work"; return 1; }
  rm -rf "$work" 2>/dev/null || true
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
  out="$(in_image "$work" terragucci respond apply-failed --log apply.log --json)" || { rm -rf "$work" 2>/dev/null; return 1; }
  rm -rf "$work" 2>/dev/null || true
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
  out="$(in_image "$work/tree" terragucci respond drift --root app --mode apply "${args[@]}" 2>&1)" || { echo "$out" >&2; rm -rf "$work" 2>/dev/null; return 1; }
  echo "$out" >&2
  rm -rf "$work" 2>/dev/null || true
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
  # and the config names no canary. The tips response must open three pull
  # requests, one per tip, each changing only its own files. BREAK: the repo
  # follows every tip already, so nothing opens.
  log() { echo "[smoke respond-tips] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/respond-tips" tree out pr branch want i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo respond-tips || return 1
  respond_tree "$work" "$repo" ""
  tree="$work/tree"
  rm -rf "$tree/app"
  mkdir -p "$tree/envs/dev/app" "$tree/envs/prod/app"
  respond_root "respond/tips-dev.tfstate" "" | sed 's/version = "6.67.0"/version = "~> 6.0"/' > "$tree/envs/dev/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/envs/dev/app/"
  respond_root "respond/tips-prod.tfstate" "" > "$tree/envs/prod/app/main.tf"
  if [ -n "${BREAK:-}" ]; then
    respond_root "respond/tips-dev.tfstate" "" > "$tree/envs/dev/app/main.tf"
    cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/envs/prod/app/"
    printf 'waves:\n  canary: ["envs/dev/*"]\n' >> "$tree/terragucci.yml"
  fi
  push_tree "$tree" "$repo" main "two roots" >/dev/null || return 1
  # Forgejo takes in a push a moment after it lands, and until then the repo
  # counts as empty and its pull requests answer 404.
  for i in $(seq 1 30); do
    [ "$(api "$URL/api/v1/repos/$repo" | jq -r .empty)" = false ] && break
    sleep 1
  done
  out="$(in_image "$tree" terragucci respond tips --mode apply --platform linux_amd64,linux_arm64 2>&1)" || { echo "$out" >&2; rm -rf "$work" 2>/dev/null; return 1; }
  echo "$out" >&2
  rm -rf "$work" 2>/dev/null || true
  for want in "terragucci/tip/pin-hashicorp-aws|envs/dev/app/main.tf" "terragucci/tip/lock-files|envs/prod/app/.terraform.lock.hcl" "terragucci/tip/canary|terragucci.yml"; do
    branch="${want%%|*}"
    pr="$(open_pr "$repo" "$branch")"
    [ -n "$pr" ] || { log "no pull request from $branch"; rc=1; continue; }
    [ "$(pr_files "$repo" "$pr")" = "${want#*|}" ] || { log "$branch changes $(pr_files "$repo" "$pr"), not ${want#*|}"; rc=1; }
  done
  [ $rc = 0 ] && log "three tips, three pull requests, each changing only its own file"
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
  out="$(in_image "$work/tree" terragucci respond fmt --branch smoke-fmt --mode "$mode" 2>&1)" || { echo "$out" >&2; rm -rf "$work" 2>/dev/null; return 1; }
  echo "$out" >&2
  rm -rf "$work" 2>/dev/null || true
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
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/modules/net"
  ( cd "$work" && git init -q -b main && echo '# net' > modules/net/main.tf && git add -A && "${c[@]}" commit -qm "feat: the net module" \
    && git tag modules/net/v0.1.0 && echo '# tags' >> modules/net/main.tf && "${c[@]}" commit -qam "$fix" \
    && echo '# output' >> modules/net/main.tf && "${c[@]}" commit -qam "$feat" && git tag modules/net/v1.0.0 ) || { rm -rf "$work"; return 1; }
  out="$(cd "$work" && "$TERRAGUCCI" respond publish --json)" || { rm -rf "$work"; return 1; }
  rm -rf "$work"
  jq -r .results.text <<<"$out" >&2
  jq -e '.results.data[0] | .version == "1.0.0" and .previous == "0.1.0" and (.notes | test("### Breaking changes\n\n- net: rename the queue output")) and (.notes | test("### Fixes"))' <<<"$out" >/dev/null \
    || { log "the 1.0.0 notes do not lead with the breaking change and list the fix"; return 1; }
  log "1.0.0's notes name the breaking change and the fix"
}

# ── the Terragrunt example's claims ──────────────────────────────────────

TG_EXAMPLE="$(cd "$HERE/../example-terragrunt" && pwd)"
TG_REPO_NAME=example-terragrunt

tg_image() { (cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "terragrunt" { print $2 }'); }

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
  local image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" p base
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example-terragrunt up' first" >&2; return 1; }
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || return 1
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
    "$image" terragucci stage "${TG_STAGE:-tf-plan}" --terragrunt --binary tofu ${TG_STAGE_ARGS[@]+"${TG_STAGE_ARGS[@]}"} >&2
}

# The last run on the Terragrunt example's main, and one of its jobs' whole log.
tg_main_job_log() { # job name
  local run job
  run="$(api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/runs?branch=main" | jq -r '.workflow_runs[0].id')"
  job="$(api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/runs/$run/jobs" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id' | head -1)"
  api "$URL/api/v1/repos/$USER/$TG_REPO_NAME/actions/jobs/$job/logs"
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
  rm -rf "$work"
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
    (cd "$work" && "$TERRAGUCCI" init >/dev/null) || { rm -rf "$work"; return 1; }
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
  if [ -n "$work" ]; then rm -rf "$work"; "$HERE/example-terragrunt.sh" reset >&2 || true; fi
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
    || { log "no example repo; run 'just example-terragrunt up' first"; rm -rf "$work"; return 1; }
  [ -n "${BREAK:-}" ] && echo "$bad" > "$work/tree/live/dev/orders/owner.hcl"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke tg-check: clean $(date +%s)")"
  wait_run "$repo" "$sha"
  if [ "$RUN_STATUS" != success ]; then log "the clean push ended '$RUN_STATUS'"; rm -rf "$work"; return 1; fi
  echo "$bad" > "$work/tree/live/dev/orders/owner.hcl"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke tg-check: unformatted $(date +%s)")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fcheck" || true
  rm -rf "$work"
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
  [ -f "$r" ] || { log "no report"; rm -rf "$work"; return 1; }
  n="$(jq '[.roots[] | select(.status == "planned")] | length' "$r")"
  [ "$n" = 12 ] || { log "$n units planned, not the 12 services"; rc=1; }
  jq -e '[.roots[] | select(.path | endswith("/platform"))] | length == 0' "$r" >/dev/null || { log "a platform unit was planned"; rc=1; }
  jq -e '[.roots[] | select(.terragrunt.selection | test("policy.json"))] | length == 12' "$r" >/dev/null || { log "not every service names policy.json as its reason"; rc=1; }
  rm -rf "$work"
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
  rm -rf "$work"
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
  rm -rf "$work"
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
    || { log "no example repo; run 'just example-terragrunt up' first"; rm -rf "$work"; return 1; }
  git -C "$work/tree" apply "$TG_EXAMPLE/changes/new-service.patch" || { rm -rf "$work"; return 1; }
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
  "$HERE/example-terragrunt.sh" reset >&2 || true
  rm -rf "$work"
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
  if [ -z "${BREAK:-}" ]; then
    extra="$(curl -fsS -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.GetQueueUrl' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')" || extra=""
    [ -n "$extra" ] || { log "$queue is not in floci; run 'just example-terragrunt up' first"; rm -rf "$work"; return 1; }
    curl -fsS -o /dev/null -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.DeleteQueue' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueUrl\":\"$extra\"}" || { rm -rf "$work"; return 1; }
  fi

  drift_run "$work/run1" || { log "the drift run failed"; rm -rf "$work"; return 1; }
  r="$work/run1/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; rm -rf "$work"; return 1; }
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
  rm -rf "$work"
  "$HERE/example-terragrunt.sh" reset >&2 || log "could not apply the example again"
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
  [ -f "$r" ] || { log "no report"; rm -rf "$work"; return 1; }
  [ "$run" = 0 ] || { log "the plan job exited $run, so it is not green"; rc=1; }
  jq -e --arg n "$net" '.roots[] | select(.path == $n and .status == "planned")' "$r" >/dev/null || { log "$net was not planned"; rc=1; }
  jq -e --arg a "$app" '[.roots[] | select(.path == $a)] | length == 0' "$r" >/dev/null || { log "$app was planned though its upstream is unapplied"; rc=1; }
  jq -e --arg a "$app" --arg n "$net" '.deferred[] | select(.unit == $a and (.after | index($n)))' "$r" >/dev/null || { log "the report does not say $app waits for $net"; rc=1; }
  rm -rf "$work"
  [ $rc = 0 ] && log "$net planned; $app held back until $net applies, and the job stayed green"
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

if [ "${1:-}" = --record ]; then
  out="${2:?usage: smoke.sh --record FILE}"
  rows=()
  for name in $(names); do
    plain="$(BREAK= run_claim "$name" | tail -1)" || true
    echo "$plain" >&2
    broken=""
    if ! grep -q 'verdict=pending' <<<"$plain"; then
      broken="$(BREAK=1 run_claim "$name" | tail -1)" || true
      echo "$broken" >&2
    fi
    row="$(grep "^$name|" <<<"$CLAIMS")"
    says="$(cut -d'|' -f2 <<<"$row")"; issue="$(cut -d'|' -f3 <<<"$row")"
    rows+=("$(jq -n --arg c "$name" --arg s "$says" --arg i "$issue" --arg p "$plain" --arg b "$broken" '{
      claim: $c, says: $s, needs: (if $i == "" then null else $i end),
      verdict: ($p | capture("verdict=(?<v>[a-z]+)").v),
      break: (if $b == "" then null else ($b | capture("verdict=(?<v>[a-z]+)").v) end)
    }')")
  done
  # Leave the example booted and clean for whoever runs next.
  "$HERE/example.sh" up --fresh >&2
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
  run_claim "$1" || rc=$?
else
  for name in $(names); do run_claim "$name" || rc=1; done
fi
exit $rc
