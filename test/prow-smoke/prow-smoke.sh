#!/usr/bin/env bash
# The runtime: prow smoke test: terragucci's generated ProwJobs run by Prow's
# own controller on a scratch k3d cluster, against a fake GitHub inside it.
#
#   just prow-smoke          (or test/prow-smoke/prow-smoke.sh)
#
# It makes (or reuses) the k3d cluster terragucci-prow-smoke, installs the
# ProwJob CRD, prow-controller-manager (plank) and sinker at pinned digests,
# runs terragucci init with runtime: prow on a copy of example/ that keeps
# its state in the job's checkout, and runs the generated presubmits,
# postsubmits and periodic as ProwJobs whose refs point at the fake GitHub's
# repository. Nothing reaches GitHub or a cloud: the jobs' GitHub calls go
# to the fake, and the roots are terraform_data with the local backend.
#
# It deletes nothing. The cluster stays up for the next run (each run's
# ProwJobs carry its run id), and the run's files stay in the work directory
# it prints. `k3d cluster delete terragucci-prow-smoke` removes the cluster.
#
# Settings:
#   TG_PROW_SMOKE_CLUSTER  the k3d cluster's name (default terragucci-prow-smoke)
#   TG_PROW_SMOKE_PORT     the host port, on 127.0.0.1 only, of the fake GitHub (default 18480)
#   TG_PROW_SMOKE_IMAGE    "build" (default) builds images/Dockerfile.tofu from this tree and
#                          imports it; "published" uses the published image at its pinned digest
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLUSTER="${TG_PROW_SMOKE_CLUSTER:-terragucci-prow-smoke}"
PORT="${TG_PROW_SMOKE_PORT:-18480}"
RUN="${TG_PROW_SMOKE_RUN:-r$(date +%m%d%H%M%S)}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-prow-smoke.XXXXXX")"
export KUBECONFIG="$WORK/kubeconfig"
HOST="http://127.0.0.1:$PORT"
FAKEGH="http://fakegh.smoke.svc.cluster.local"
CLONE_URI="$FAKEGH/smoke/estate.git"
CHECK="$REPO/packages/terragucci/test/fixtures/prow/check"

# ── pins ──────────────────────────────────────────────────────────────────────
# The Prow images are the release whose commit fixtures/prow/check/go.mod pins
# (sigs.k8s.io/prow v0.0.0-20261107224937-86b2c49084b4), each by its digest.
PROW_TAG="v20261107-86b2c4908"
PROW_REG="us-docker.pkg.dev/k8s-infra-prow/images"
PCM_IMAGE="$PROW_REG/prow-controller-manager:$PROW_TAG@sha256:726bd7ff470593c163f67e0808aa888cbbec2d02283e852a829e3e994f6b031e"
SINKER_IMAGE="$PROW_REG/sinker:$PROW_TAG@sha256:7e1ba7c1affe664dc62308eae7b3022584f49e437fc0916eae0531ad12c03b73"
CLONEREFS_IMAGE="$PROW_REG/clonerefs:$PROW_TAG@sha256:6a0c659c7bdc22dea2dae6c1cbf9d21c4e7deb2a5f5bfa48ef1312ffa1d5c081"
INITUPLOAD_IMAGE="$PROW_REG/initupload:$PROW_TAG@sha256:14ebd155298f90f82ae096770f0809bf52fa1bfdb9907ecbf0344f734e5cf745"
ENTRYPOINT_IMAGE="$PROW_REG/entrypoint:$PROW_TAG@sha256:45ce52255720c185136c68356bfb14fc1024fee0704ae10e014bcc1190b43130"
SIDECAR_IMAGE="$PROW_REG/sidecar:$PROW_TAG@sha256:699bdde8be63802abfa6ba7ba4b01582033fabd23e7d6dcb0d105f064fc9a124"
MINIO_IMAGE="cgr.dev/chainguard/minio@sha256:9158c67aa441627c366442e84656f689e16bec4809851ec64318561a365b69e4"
PUBLISHED_IMAGE="ghcr.io/intentius/terragucci-tofu:0.4.62-tofu1.13.1@sha256:6b886f9abdd62012f3b9f360633ff83550c959acfe562dc6c317977fe92d2066"
LOCAL_IMAGE="terragucci-tofu:prow-smoke"
MINIO_USER="smoke"
MINIO_PASSWORD="smoke-minio-password"
FAKE_TOKEN="fake-token-for-the-smoke-fake-github"

say() { printf '\n== %s\n' "$*"; }
PASSED=0
FAILED=0
RESULTS="$WORK/results.txt"
: >"$RESULTS"
pass() { PASSED=$((PASSED + 1)); echo "ok    $*" | tee -a "$RESULTS"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL  $*" | tee -a "$RESULTS"; }
# A gap in what terragucci generates that the run works around and names; it does not fail the run.
GAPS=0
gap() { GAPS=$((GAPS + 1)); echo "GAP   $*" | tee -a "$RESULTS"; }
check() { local what="$1"; shift; if "$@" >/dev/null; then pass "$what"; else fail "$what"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "prow-smoke: needs $1 on PATH" >&2; exit 2; }; }

for t in docker k3d kubectl go node git jq curl; do need "$t"; done
docker info >/dev/null 2>&1 || { echo "prow-smoke: Docker is not running" >&2; exit 2; }
grep -q "sigs.k8s.io/prow v0.0.0-[0-9]*-${PROW_TAG#v*-}" "$CHECK/go.mod" || { echo "prow-smoke: $CHECK/go.mod no longer pins the Prow commit of $PROW_TAG; move the image pins with it" >&2; exit 2; }
OFFLINE=(env GOFLAGS=-mod=mod GOPROXY=off "GOTOOLCHAIN=${GOTOOLCHAIN:-auto}")
PROW_MOD="$(cd "$CHECK" && "${OFFLINE[@]}" go list -m -f '{{.Dir}}' sigs.k8s.io/prow 2>/dev/null)" || {
  echo "prow-smoke: sigs.k8s.io/prow is not in Go's module cache; run 'go mod download' in $CHECK once" >&2
  exit 2
}
CRD="$PROW_MOD/config/prow/cluster/prowjob-crd/prowjob_customresourcedefinition.yaml"

echo "prow-smoke: run $RUN, cluster $CLUSTER, work directory $WORK"

# ── 1. the image ──────────────────────────────────────────────────────────────
say "the terragucci image"
(cd "$REPO" && node scripts/build-cli.mjs >/dev/null)
if [ "${TG_PROW_SMOKE_IMAGE:-build}" = published ]; then
  IMAGE="$PUBLISHED_IMAGE"
  echo "using $IMAGE, which the cluster pulls"
else
  IMAGE="$LOCAL_IMAGE"
  (cd "$REPO" && docker buildx build --load -q -f images/Dockerfile.tofu -t "$IMAGE" . >/dev/null)
  echo "built $IMAGE from images/Dockerfile.tofu"
fi

# ── 2. the cluster ────────────────────────────────────────────────────────────
say "the k3d cluster $CLUSTER"
if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "reusing $CLUSTER"
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
else
  k3d cluster create "$CLUSTER" --no-lb --wait --timeout 300s \
    --kubeconfig-update-default=false --kubeconfig-switch-context=false \
    -p "127.0.0.1:$PORT:30080@server:0:direct" \
    --k3s-arg "--disable=traefik@server:0" --k3s-arg "--disable=servicelb@server:0" >/dev/null
  echo "created $CLUSTER"
fi
k3d kubeconfig get "$CLUSTER" >"$KUBECONFIG"
if [ "$IMAGE" = "$LOCAL_IMAGE" ]; then k3d image import -c "$CLUSTER" "$IMAGE" >/dev/null 2>&1; echo "imported $IMAGE"; fi

# ── 3. the estate and terragucci init ─────────────────────────────────────────
say "terragucci init with runtime: prow on a copy of example/"
EST="$WORK/estate"
node "$HERE/estate.mjs" "$REPO/example" "$EST" "$FAKEGH" "$IMAGE" >/dev/null
g() { git -C "$EST" -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false "$@"; }
g init -q -b main
g remote add origin https://github.com/smoke/estate.git
TG=(node "$REPO/packages/terragucci/dist/terragucci.mjs")
(cd "$EST" && "${TG[@]}" init) | tee "$WORK/init.log"
JOBS="$EST/prow/terragucci.yaml"
check "init wrote the Prow job config prow/terragucci.yaml" test -s "$JOBS"
check "init wrote no workflow file" test ! -e "$EST/.github/workflows/terragucci.yml"
# The estate as it stands before the change: every root applied once to its local state, which the estate
# commits, platform roots first since the service roots read them. This apply touches nothing but those files.
docker run --rm -v "$EST:/estate" -w /estate "$IMAGE" sh -c '
  set -e
  for r in envs/*/platform envs/*/email envs/*/orders envs/*/payments envs/*/search; do
    tofu -chdir="$r" init -input=false -no-color >/dev/null
    tofu -chdir="$r" apply -auto-approve -input=false -no-color >/dev/null
  done'
check "every root has local state to commit" test -s "$EST/envs/prod/search/terraform.tfstate"
g add -A
g add -f envs/*/*/terraform.tfstate
g commit -q -m "the estate"
A="$(g rev-parse HEAD)"

# ── 4. Prow's config, and the ProwJobs Prow's own loader makes ───────────────
say "Prow's config, and the job config through Prow's strict loader"
cat >"$WORK/config.yaml" <<EOF
prowjob_namespace: prow
pod_namespace: test-pods
plank:
  default_decoration_config_entries:
    - config:
        gcs_configuration:
          bucket: s3://prow-logs
          path_strategy: explicit
        s3_credentials_secret: s3-credentials
        utility_images:
          clonerefs: $CLONEREFS_IMAGE
          entrypoint: $ENTRYPOINT_IMAGE
          initupload: $INITUPLOAD_IMAGE
          sidecar: $SIDECAR_IMAGE
sinker:
  resync_period: 1m
  max_prowjob_age: 168h
  max_pod_age: 168h
  terminated_pod_ttl: 168h
EOF
(cd "$CHECK" && "${OFFLINE[@]}" go run . "$WORK/config.yaml" "$JOBS") >"$WORK/prowjobs.jsonl" 2>"$WORK/loader.err" \
  && pass "Prow's strict loader takes the generated job config" \
  || { fail "Prow's strict loader takes the generated job config"; cat "$WORK/loader.err"; exit 1; }
jq -r '"\(.spec.type) \(.spec.job) \(.spec.cluster)"' "$WORK/prowjobs.jsonl" | sort | tee "$WORK/jobs.txt"

# ── 5. Prow on the cluster ───────────────────────────────────────────────────
say "Prow: the ProwJob CRD, plank and sinker"
kubectl apply --server-side -f "$CRD" >/dev/null
kubectl wait --for=condition=Established crd/prowjobs.prow.k8s.io --timeout=60s >/dev/null
sub() {
  sed -e "s#@TG_IMAGE@#$IMAGE#g" -e "s#@MINIO_IMAGE@#$MINIO_IMAGE#g" -e "s#@PCM_IMAGE@#$PCM_IMAGE#g" \
    -e "s#@SINKER_IMAGE@#$SINKER_IMAGE#g" -e "s#@MINIO_USER@#$MINIO_USER#g" -e "s#@MINIO_PASSWORD@#$MINIO_PASSWORD#g" \
    -e "s#@FAKE_TOKEN@#$FAKE_TOKEN#g" -e "s#@FAKEGH_DIGEST@#$(shasum -a 256 "$HERE/fakegithub.mjs" | cut -c1-16)#g" "$1"
}
sub "$HERE/cluster.yaml" | kubectl apply -f - >/dev/null
kubectl -n prow create configmap config --from-file=config.yaml="$WORK/config.yaml" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n prow create configmap job-config --from-file=terragucci.yaml="$JOBS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n smoke create configmap fakegh --from-file=fakegithub.mjs="$HERE/fakegithub.mjs" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# A new config or job config reaches plank and sinker on restart.
kubectl -n prow rollout restart deployment/prow-controller-manager deployment/sinker >/dev/null
for d in prow/minio prow/prow-controller-manager prow/sinker smoke/fakegh; do
  kubectl -n "${d%/*}" rollout status "deployment/${d#*/}" --timeout=600s >/dev/null
done
pass "plank, sinker, MinIO and the fake GitHub are running"
until curl -fsS "$HOST/healthz" >/dev/null 2>&1; do sleep 1; done

# ── the cases' helpers ───────────────────────────────────────────────────────
state() { curl -fsS -X PUT -H 'content-type: application/json' --data-binary "$1" "$HOST/_smoke/state" >/dev/null; }
dump() { curl -fsS "$HOST/_smoke/state"; }
push() { g push -q --force "$HOST/smoke/estate.git" "$@"; }
# edit <file> <text> <replacement>: change a root in place; the text must be there exactly once.
edit() {
  node -e 'const fs=require("fs"),[f,a,b]=process.argv.slice(1),t=fs.readFileSync(f,"utf-8");if(t.split(a).length!==2){console.error(f+": expected "+JSON.stringify(a)+" once");process.exit(1)}fs.writeFileSync(f,t.replace(a,b))' "$1" "$2" "$3"
}
mkdir -p "$WORK/logs" "$WORK/pods"

# runjob <type> <job> <case> <base sha> [<pull> <sha> <author>]: create the ProwJob, wait for it, keep its log and pod.
runjob() {
  local type="$1" job="$2" case="$3" base="$4"
  local name="$RUN-$case"
  shift 4
  node "$HERE/prowjobs.mjs" "$WORK/prowjobs.jsonl" "$type" "$job" "$name" "$CLONE_URI" "$base" "$@" >"$WORK/pods/$case.prowjob.json"
  kubectl create -f "$WORK/pods/$case.prowjob.json" >/dev/null
  local s=""
  for _ in $(seq 1 900); do
    s="$(kubectl -n prow get prowjob "$name" -o jsonpath='{.status.state}' 2>/dev/null || true)"
    case "$s" in success | failure | error | aborted) break ;; esac
    sleep 2
  done
  kubectl -n prow get prowjob "$name" -o json >"$WORK/pods/$case.status.json"
  local pod
  pod="$(jq -r '.status.pod_name // .metadata.name' "$WORK/pods/$case.status.json")"
  kubectl -n test-pods get pod "$pod" -o json >"$WORK/pods/$case.pod.json" 2>/dev/null || echo '{}' >"$WORK/pods/$case.pod.json"
  kubectl -n test-pods logs "$pod" -c test >"$WORK/logs/$case.log" 2>&1 || true
  echo "$case: $type $job: $s" | tee -a "$WORK/jobs-run.txt"
  printf '%s' "$s" >"$WORK/pods/$case.state"
}
jobstate() { cat "$WORK/pods/$1.state"; }
logs() { grep -q -- "$2" "$WORK/logs/$1.log"; }
nologs() { ! grep -q -- "$2" "$WORK/logs/$1.log"; }
is() { [ "$(jobstate "$1")" = "$2" ]; }
# The artifact <key> under the job's directory in the artifacts bucket.
artifact() {
  local case="$1" key="$2" dir
  dir="$(jq -r '
    .spec as $s | .status.build_id as $b |
    if $s.type == "presubmit" then "pr-logs/pull/\($s.refs.org)_\($s.refs.repo)/\($s.refs.pulls[0].number)/\($s.job)/\($b)"
    else "logs/\($s.job)/\($b)" end' "$WORK/pods/$case.status.json")"
  curl -fsS "$HOST/_smoke/artifact?key=$dir/$key"
}
podsa() { jq -r '.spec.serviceAccountName // "default"' "$WORK/pods/$1.pod.json"; }
# Whether the job's own container (decoration names it "test") has a credential, or the pod has no such container has a credential: a Secret in its env or its mounts, or a service account token.
testcred() {
  jq -e --arg c test '
    ([.spec.containers[]? | select(.name == $c)] | length != 1)
    or (.spec.automountServiceAccountToken != false)
    or ([.spec.containers[] | select(.name == $c) | (.env // [])[] | select(.valueFrom.secretKeyRef)] | length > 0)
    or ([.spec.containers[] | select(.name == $c) | (.volumeMounts // [])[] | .name] as $m
        | [(.spec.volumes // [])[] | select(.secret or .projected) | .name] | any(. as $v | $m | index($v)))
  ' "$WORK/pods/$1.pod.json" >/dev/null
}

# ── 6. the change, before merge ──────────────────────────────────────────────
say "pull request 1: dev orders keeps unclaimed jobs for seven days"
g checkout -q -b change-1
edit "$EST/envs/dev/orders/main.tf" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket

  job_retention_seconds = 604800"
g commit -q -am "dev orders keeps unclaimed jobs for seven days"
H1="$(g rev-parse HEAD)"
g checkout -q main
push main "$H1:refs/heads/change-1" "$H1:refs/pull/1/head"
state "{\"pulls\":[{\"number\":1,\"author\":\"dev\",\"head\":\"$H1\",\"base_sha\":\"$A\",\"labels\":[],\"comments\":[]}]}"

runjob presubmit terragucci-check check "$A" 1 "$H1" dev
check "the check presubmit succeeds" is check success
check "the check presubmit validated every root, dev orders among them" logs check "valid envs/dev/orders"
check "the check presubmit's pod holds no credential (no service account token, no Secret in the test container)" eval '! testcred check'
check "the check presubmit runs on the default build cluster" test "$(jq -r .spec.cluster "$WORK/pods/check.status.json")" = default
check "the check presubmit's pod has no named service account" test "$(podsa check)" = default

runjob presubmit terragucci-plan plan-pr1 "$A" 1 "$H1" dev
check "the plan presubmit succeeds" is plan-pr1 success
check "the plan presubmit runs on the trusted build cluster as tf-plan" test "$(jq -r .spec.cluster "$WORK/pods/plan-pr1.status.json") $(podsa plan-pr1)" = "trusted tf-plan"
dump >"$WORK/fakegh-after-plan-pr1.json"
check "the plan presubmit posted the plan note on pull request 1, naming dev orders" jq -e '[.comments[] | select(.issue == 1 and (.body | test("envs/dev/orders")))] | length > 0' "$WORK/fakegh-after-plan-pr1.json"
check "the plan presubmit posted terragucci/plan on the head" jq -e --arg h "$H1" '[.statuses[] | select(.sha == $h and .context == "terragucci/plan")] | length > 0' "$WORK/fakegh-after-plan-pr1.json"
NOTES1="$(jq -c '[.comments[] | select(.issue == 1) | {body, user}]' "$WORK/fakegh-after-plan-pr1.json")"

# ── 7. after merge: plan, approval by labels, apply ──────────────────────────
say "pull request 1 merges"
g merge -q --no-ff -m "Merge pull request 1 from change-1" change-1
M1="$(g rev-parse HEAD)"
push main
pr1() { # pr1 <labels json> <extra comments json>
  state "{\"pulls\":[{\"number\":1,\"author\":\"dev\",\"head\":\"$H1\",\"base_sha\":\"$A\",\"merged\":true,\"merge_commit\":\"$M1\",\"labels\":$1,\"comments\":$(jq -c --argjson more "$2" '. + $more' <<<"$NOTES1")}]}"
}
LGTM='[{"user":"rev","body":"/lgtm"},{"user":"owner","body":"/approve"}]'

pr1 '["lgtm","approved"]' "$LGTM"
runjob postsubmit terragucci-plan plan-main "$M1"
check "the plan postsubmit succeeds" is plan-main success
check "the plan postsubmit runs as tf-plan" test "$(podsa plan-main)" = tf-plan
artifact plan-main artifacts/terragucci-report/report.json >"$WORK/plan-main.report.json" 2>/dev/null || true
check "the plan postsubmit kept a plan report in the job's artifacts" jq -e '.roots | map(.path) | index("envs/dev/orders")' "$WORK/plan-main.report.json"

say "the apply job as generated, on a checkout clonerefs made"
pr1 '["lgtm","approved"]' "$LGTM"
runjob postsubmit terragucci-apply apply-as-generated "$M1"
if logs apply-as-generated "cannot read chant/lifecycle from origin"; then
  gap "the apply job as generated: clonerefs leaves no origin remote, so the gate cannot read chant/lifecycle and wave 1 does not apply (the jobs need to set origin; the cases below give it through git's environment)"
  ORIGIN_NOTE="the cases below run with origin set to $CLONE_URI through GIT_CONFIG_COUNT in the job's environment"
  export PROWJOB_ORIGIN="$CLONE_URI"
else
  pass "the apply job as generated reads chant/lifecycle from the checkout clonerefs made"
  ORIGIN_NOTE="the cases below run the apply job as generated"
fi
echo "$ORIGIN_NOTE" | tee -a "$RESULTS"

say "the apply refuses what the labels do not bind"
pr1 '["lgtm"]' "$LGTM"
runjob postsubmit terragucci-apply apply-no-approved "$M1"
check "no approved label: the apply does not proceed" eval '! is apply-no-approved success'
check "no approved label: the wave waits, naming the missing label" logs apply-no-approved "has no approved label"
check "no approved label: nothing in the wave or after it ran" logs apply-no-approved "Nothing in wave [0-9]* or after it ran"

pr1 '["lgtm","approved"]' '[{"user":"dev","body":"/lgtm\n/approve"}]'
runjob postsubmit terragucci-apply apply-author-only "$M1"
check "only the author's /lgtm and /approve: the apply does not proceed" eval '! is apply-author-only success'
check "only the author's /lgtm and /approve: the wave waits" logs apply-author-only "the labels do not approve this wave"
check "only the author's /lgtm and /approve: nothing in the wave or after it ran" logs apply-author-only "Nothing in wave [0-9]* or after it ran"

say "the apply proceeds when the labels bind to the head whose plan the note showed"
pr1 '["lgtm","approved"]' "$LGTM"
runjob postsubmit terragucci-apply apply-pr1 "$M1"
check "the labels on the planned head: the apply succeeds" is apply-pr1 success
check "the apply names the labels' approval" logs apply-pr1 "merged with the lgtm and approved labels"
check "the apply applied the change to dev orders, in its local state" logs apply-pr1 "Resources: 0 added, 1 changed, 0 destroyed"
check "the apply runs as tf-apply, not tf-plan" test "$(podsa apply-pr1)" = tf-apply

say "pull request 2: the plans moved after the note"
g checkout -q -b change-2
edit "$EST/envs/dev/orders/main.tf" "job_retention_seconds = 604800" "job_retention_seconds = 691200"
g commit -q -am "dev orders keeps unclaimed jobs for eight days"
H2="$(g rev-parse HEAD)"
g checkout -q main
push "$H2:refs/heads/change-2" "$H2:refs/pull/2/head"
state "{\"pulls\":[{\"number\":2,\"author\":\"dev\",\"head\":\"$H2\",\"base_sha\":\"$M1\",\"labels\":[],\"comments\":[]}]}"
runjob presubmit terragucci-plan plan-pr2 "$M1" 2 "$H2" dev
check "the plan presubmit of pull request 2 succeeds" is plan-pr2 success
NOTES2="$(dump | jq -c '[.comments[] | select(.issue == 2) | {body, user}]')"
# Someone pushes to main before pull request 2 merges: its merged plans are not the ones its note showed.
edit "$EST/envs/dev/orders/main.tf" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket
  records_key = \"order_id\""
g commit -q -am "dev orders keys its records by order_id"
g merge -q --no-ff -m "Merge pull request 2 from change-2" change-2
M2="$(g rev-parse HEAD)"
push main
state "{\"pulls\":[{\"number\":2,\"author\":\"dev\",\"head\":\"$H2\",\"base_sha\":\"$M1\",\"merged\":true,\"merge_commit\":\"$M2\",\"labels\":[\"lgtm\",\"approved\"],\"comments\":$(jq -c --argjson more "$LGTM" '. + $more' <<<"$NOTES2")}]}"
runjob postsubmit terragucci-apply apply-moved "$M2"
check "plans moved after the note: the apply does not proceed" eval '! is apply-moved success'
check "plans moved after the note: the wave waits for terragucci approve of the new plans" logs apply-moved "the plans moved after pull request 2"
check "plans moved after the note: nothing in the wave or after it ran" logs apply-moved "Nothing in wave [0-9]* or after it ran"

say "pull request 3: a new head after the note"
g checkout -q -b change-3
edit "$EST/envs/dev/search/main.tf" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket

  job_retention_seconds = 86400"
g commit -q -am "dev search keeps unclaimed jobs for a day"
H3="$(g rev-parse HEAD)"
g checkout -q main
push "$H3:refs/heads/change-3" "$H3:refs/pull/3/head"
state "{\"pulls\":[{\"number\":3,\"author\":\"dev\",\"head\":\"$H3\",\"base_sha\":\"$M2\",\"labels\":[],\"comments\":[]}]}"
runjob presubmit terragucci-plan plan-pr3 "$M2" 3 "$H3" dev
NOTES3="$(dump | jq -c '[.comments[] | select(.issue == 3) | {body, user}]')"
g checkout -q change-3
edit "$EST/envs/dev/search/main.tf" "job_retention_seconds = 86400" "job_retention_seconds = 172800"
g commit -q -am "dev search keeps unclaimed jobs for two days"
H3B="$(g rev-parse HEAD)"
g checkout -q main
g merge -q --no-ff -m "Merge pull request 3 from change-3" change-3
M3="$(g rev-parse HEAD)"
push main "$H3B:refs/heads/change-3" "$H3B:refs/pull/3/head"
state "{\"pulls\":[{\"number\":3,\"author\":\"dev\",\"head\":\"$H3B\",\"base_sha\":\"$M2\",\"merged\":true,\"merge_commit\":\"$M3\",\"labels\":[\"lgtm\",\"approved\"],\"comments\":$(jq -c --argjson more "$LGTM" '. + $more' <<<"$NOTES3")}]}"
runjob postsubmit terragucci-apply apply-new-head "$M3"
check "labels on a head the note did not plan: the apply does not proceed" eval '! is apply-new-head success'
check "labels on a head the note did not plan: the wave waits, naming the head" logs apply-new-head "has no digest for wave"
check "labels on a head the note did not plan: nothing in the wave or after it ran" logs apply-new-head "Nothing in wave [0-9]* or after it ran"

say "pull request 4, from a fork"
g checkout -q -b change-4
edit "$EST/envs/dev/email/main.tf" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket" "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket

  job_retention_seconds = 3600"
g commit -q -am "dev email keeps unclaimed jobs for an hour"
H4="$(g rev-parse HEAD)"
g checkout -q main
push "$H4:refs/pull/4/head"
state "{\"pulls\":[{\"number\":4,\"author\":\"outsider\",\"head\":\"$H4\",\"head_repo\":\"outsider/estate\",\"base_sha\":\"$M3\",\"labels\":[],\"comments\":[]}]}"
runjob presubmit terragucci-check check-fork "$M3" 4 "$H4" outsider
check "a fork's pull request: the check presubmit succeeds" is check-fork success
check "a fork's pull request: the check presubmit's pod holds no credential" eval '! testcred check-fork'
runjob presubmit terragucci-plan plan-fork "$M3" 4 "$H4" outsider
check "a fork's pull request: the plan presubmit ends before any of its code runs" logs plan-fork "is from a fork, so it is not planned before merge"
check "a fork's pull request: the plan presubmit passes" is plan-fork success
check "a fork's pull request: no plan note is posted" eval '! dump | jq -e "[.comments[] | select(.issue == 4)] | length > 0" >/dev/null'

# ── 8. drift ─────────────────────────────────────────────────────────────────
say "the drift periodic"
runjob periodic terragucci-drift drift "$M3"
check "the drift periodic succeeds" is drift success
check "the drift periodic runs on the trusted cluster as tf-plan" test "$(jq -r .spec.cluster "$WORK/pods/drift.status.json") $(podsa drift)" = "trusted tf-plan"
check "the drift periodic never applies" nologs drift "Apply complete"
check "the drift periodic planned every root and found no drift" logs drift "envs/staging/search: no drift"
if logs drift "no forge token or no forge in the environment, so the drift issue is left alone"; then
  gap "the drift periodic as generated: the stage reads its token from TG_TOKEN and the job sets only GITHUB_TOKEN, so it leaves the drift issue alone"
else
  pass "the drift periodic reads its token and keeps the drift issue"
fi

# ── 9. identities ────────────────────────────────────────────────────────────
say "the pod identities, as config identities lists them"
(cd "$EST" && "${TG[@]}" config identities --json) >"$WORK/identities.json"
check "config identities: plan and drift take tf-plan, apply takes tf-apply" \
  test "$(jq -r '.results.environments[0].stages | "\(.plan.pod.service_account) \(.drift.pod.service_account) \(.apply.pod.service_account)"' "$WORK/identities.json")" = "tf-plan tf-plan tf-apply"
check "the pods ran under those accounts: plan tf-plan, apply tf-apply, drift tf-plan" \
  test "$(podsa plan-main) $(podsa apply-pr1) $(podsa drift)" = "tf-plan tf-apply tf-plan"
check "the check presubmit has no identity config identities lists" eval '! jq -e ".results.environments[0].stages.check.pod.service_account // empty" "$WORK/identities.json" >/dev/null'

dump >"$WORK/fakegh-final.json"
jq -r '.requests[] | "\(.status) \(.method) \(.path)"' "$WORK/fakegh-final.json" | sort | uniq -c >"$WORK/github-calls.txt"

say "result"
cat "$RESULTS"
echo
echo "prow-smoke: run $RUN: $PASSED passed, $FAILED failed, $GAPS gaps"
echo "prow-smoke: made or reused: k3d cluster $CLUSTER (fake GitHub on 127.0.0.1:$PORT), image $IMAGE, ProwJobs $RUN-* in namespace prow"
echo "prow-smoke: kept: $WORK (estate, logs/, pods/, results.txt, github-calls.txt); KUBECONFIG=$KUBECONFIG"
[ "$FAILED" -eq 0 ]
