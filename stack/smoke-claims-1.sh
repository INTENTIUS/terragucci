# ── the implemented claims ────────────────────────────────────────────────
# Each returns 0 when the property held and 1 when it did not, and prints its
# evidence on stderr.

claim_boot/tofu() {
  # The example from nothing: its repo, its resources and its state are wiped,
  # then `example.sh up` pushes it and the pipeline applies every root. Only
  # the example is wiped (not all of floci, as `up --fresh` does), so claims on
  # other repos and the Terragrunt example keep running meanwhile.
  # BREAK: one root's apply is skipped, so only the resource check notices.
  log() { echo "[smoke boot] $*" >&2; }
  local skip=""
  [ -n "${BREAK:-}" ] && skip="envs/prod/email"
  # Another binary boots its own copy of the example (example-<binary>, its
  # names under shop<tag>-), so the example itself is left as it is.
  if [ "$SMOKE_BINARY" != tofu ]; then
    # shellcheck source=lib.sh
    . "$HERE/lib.sh"
    bin_prepare || return 1
    wipe_example || return 1
    TG_EXAMPLE_BINARY="$SMOKE_BINARY" TG_EXAMPLE_ENDPOINT="${CDF_ALIAS:+http://$CDF_ALIAS:4566}" TG_SKIP_ROOT="$skip" "$HERE/example.sh" up >&2 || return 1
    TG_EXAMPLE_BINARY="$SMOKE_BINARY" "$HERE/example.sh" verify >&2
    return
  fi
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
# Under SMOKE_BINARY the binary's copy: its repo, names and state (EX_REPO,
# EX_SHOP), and under choudoufu its estates' records.
wipe_example() {
  local mine="^$EX_SHOP-(dev|staging|prod)-" state="$EX_SHOP-terraform-state" b k u t n left i
  sqs_json() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: $1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$EX_REPO" 2>/dev/null || true
  for i in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$USER/$EX_REPO")" = 404 ] && break
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
  for k in $(curl -fsS "$FLOCI/$state?list-type=2&prefix=envs/" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true); do
    curl -s -o /dev/null -X DELETE "$FLOCI/$state/$k" || true
  done
  if [ "$SMOKE_BINARY" = choudoufu ]; then
    for b in tofu-records tofu-outputs tofu-hints tofu-receipts tofu-located tofu-residue tofu-provisioned; do
      for k in $(curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=$b/$EX_SHOP--" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true); do
        curl -s -o /dev/null -X DELETE "$FLOCI/$CDF_RECORDS/$(jq -rn --arg k "$k" '$k | split("/") | map(@uri) | join("/")')" || true
      done
    done
  fi
  # Anything left would make the apply meet a resource it did not create.
  left="$( { curl -fsS "$FLOCI/" | grep -o '<Name>[^<]*</Name>' | sed -E 's#</?Name>##g' | grep -E "$mine"
    sqs_json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]? | split("/") | last' | grep -E "$mine"
    sqs_json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?' | grep -E "$mine"
    curl -fsS "$FLOCI/$state?list-type=2&prefix=envs/" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
    [ "$SMOKE_BINARY" != choudoufu ] || curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=tofu-records/$EX_SHOP--" 2>/dev/null | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
  } 2>/dev/null || true)"
  n="$(grep -c . <<<"$left" || true)"
  [ "$n" = 0 ] || { log "the wipe left $n of the example's objects in floci: $(tr '\n' ' ' <<<"$left")"; return 1; }
  log "wiped the example's repo, resources and state"
}

claim_check/tofu() {
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

claim_init/zero_config() {
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

claim_apply/serial() {
  # A scratch repo whose one root writes a mark to floci when its apply starts
  # and another when it ends, with a long pause between. The first push is
  # let run until its apply has started, then a second push lands. The marks
  # must read start end start end: the second apply waited for the first.
  # BREAK: the lock is cut out of the committed pipeline, so the applies overlap.
  # The runner has capacity 8, and under BREAK the smoke runner gives this claim
  # the runner to itself (runner! in CLAIM_GROUPS), so a free slot never forces
  # the order: only the concurrency group and the state lock do.
  # Under SMOKE_BINARY=terraform the repo, its state and its marks are
  # serial-terraform, and the pipeline runs in the Terraform image.
  log() { echo "[smoke apply-serial] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=serial
  [ "$SMOKE_BINARY" = tofu ] || name="serial-$SMOKE_BINARY"
  local work repo="$USER/$name" sha1 sha2 i listing marks bucket=shop-terraform-state mark
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local n; for n in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket"
  # Clear marks and state (with its lock file) from an earlier run.
  for mark in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=$name/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g') $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=$name-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
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
  if [ "$name" != serial ]; then
    sed "s#serial/app.tfstate#$name/app.tfstate#; s#/serial-marks/#/$name-marks/#" "$work/app/main.tf" > "$work/app/main.tf.new" && mv "$work/app/main.tf.new" "$work/app/main.tf"
  fi
  echo 1 > "$work/app/rev.txt"
  # The second push replaces the resource, which on-destructive would hold for an
  # approval; this claim is about the lock, so no wave waits.
  printf 'forge: forgejo\nbinary: %s\ngate: never\n' "$SMOKE_BINARY" > "$work/terragucci.yml"
  (cd "$work" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml)
  # BREAK=1 cuts all three guards; BREAK=lock,group,job names the ones to cut.
  local wf="$work/.forgejo/workflows/terragucci.yml" cut="${BREAK:-}"
  bin_pipeline "$wf" || { drop_work "$work"; return 1; }
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
  sha1="$(push_tree "$work" "$repo" main "$name: first")"
  for i in $(seq 1 120); do
    listing="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=$name-marks/" || true)"
    case "$listing" in *-start\</Key\>*) break ;; esac
    sleep 2
  done
  echo 2 > "$work/app/rev.txt"
  sha2="$(push_tree "$work" "$repo" main "$name: second")"
  wait_run "$repo" "$sha1"
  wait_run "$repo" "$sha2"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the second run ended $RUN_STATUS"; drop_work "$work"; return 1; }
  marks="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=$name-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' ')"
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

# ── the core claims on another binary (SMOKE_BINARY) ──────────────────────
# Under SMOKE_BINARY=terraform or choudoufu the core claims (BINARY_CLAIMS)
# write their trees for that binary (binary-tree.py) and run its CI image.
# choudoufu keeps no state file: each root is an estate whose records are in
# the record store bucket CDF_RECORDS, which choudoufu addresses
# virtual-hosted (<bucket>.<endpoint host>), so a claim's jobs and stage runs
# reach floci through a proxy of the claim's own (cdf_proxy_up), which the
# tree names in env: AWS_ENDPOINT_URL_S3. Each tree's estates are named
# <claim>-<time>--<root, / as -->, new on every run, so no run reads the
# records another left.
bin_image() { image_tag "$SMOKE_BINARY"; }
BIN_ESTATES=""
bin_prepare() { # -> under choudoufu, the record store bucket and the claim's proxy, which AWS_DOCKER_ENV then names
  [ "$SMOKE_BINARY" = choudoufu ] || return 0
  [ -z "${CDF_PROXY:-}" ] || return 0
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$d"
  cdf_bucket || { echo "could not set up the record store bucket $CDF_RECORDS" >&2; return 1; }
  cdf_proxy_up "$d" || { echo "the record store proxy did not start" >&2; return 1; }
  AWS_DOCKER_ENV=(-e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1)
}
bin_tree() { # dir, estate prefix, [binary-tree.py flags] -> the tree written for SMOKE_BINARY; sets BIN_ESTATES
  [ "$SMOKE_BINARY" != tofu ] || return 0
  local dir="$1" prefix="$2"
  shift 2
  local -a endpoint=()
  [ "$SMOKE_BINARY" = choudoufu ] && [ -n "${CDF_ALIAS:-}" ] && endpoint=(--endpoint "http://$CDF_ALIAS:4566")
  python3 "$HERE/binary-tree.py" "$dir" "$SMOKE_BINARY" "$prefix" --records "$CDF_RECORDS" ${endpoint[@]+"${endpoint[@]}"} "$@" >/dev/null || return 1
  BIN_ESTATES="$prefix"
}
# Under another binary, that a report's roots all ran it.
bin_ran() { # report.json
  [ "$SMOKE_BINARY" != tofu ] || return 0
  local got
  got="$(jq -r '[.roots[].binary.name // "none"] | unique | join(",")' "$1" 2>/dev/null || echo none)"
  [ "$got" = "$SMOKE_BINARY" ] || { echo "the report's roots ran ${got:-nothing}, not $SMOKE_BINARY" >&2; return 1; }
}
# Under another binary, that init wrote the pipeline in its CI image.
bin_pipeline() { # pipeline file
  [ "$SMOKE_BINARY" != tofu ] || return 0
  grep -q "image: ghcr.io/intentius/terragucci-$SMOKE_BINARY:" "$1" || { echo "the pipeline does not run in the $SMOKE_BINARY image" >&2; return 1; }
}
# The input the terraform_data of a root of BIN_ESTATES holds in its record, empty when it has none.
bin_record_input() { # root
  local estate="$BIN_ESTATES--${1//\//--}" k
  k="$(curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=tofu-records/$estate/terraform_data/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' | head -1)"
  [ -n "$k" ] || return 0
  curl -fsS "$FLOCI/$CDF_RECORDS/$(jq -rn --arg k "$k" '$k | split("/") | map(@uri) | join("/")')" 2>/dev/null | jq -r '.object.attrs.input // empty | if type == "object" then .value else . end' 2>/dev/null || true
}
# The roots of BIN_ESTATES that hold a record of a terraform_data, space-separated.
bin_recorded() {
  curl -fsS "$FLOCI/$CDF_RECORDS?list-type=2&prefix=tofu-records/$BIN_ESTATES--" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' \
    | grep '/terraform_data/' | sed -E "s#^tofu-records/$BIN_ESTATES--([^/]*)/.*#\\1#; s#--#/#g" | sort -u | tr '\n' ' '
}

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
  bin_prepare && bin_tree "$work/tree" "$name-$(date +%s)" || { log "the tree was not written for $SMOKE_BINARY"; return 1; }
  # With approval: sealed, init lists every wave gate under identity.gates, and
  # an approval counts only when its seal verifies against the signers file at
  # base. Without it (ledger, the default) any approval of the digest counts.
  [ -z "$approval" ] || echo "approval: $approval" >> "$work/tree/terragucci.yml"
  # Terramate finds its project root by git, as in any checkout a user runs init in.
  [ ! -f "$work/tree/terramate.tm.hcl" ] || git -C "$work/tree" init -q -b main
  if [ -n "${GATED_INIT_TG:-}" ]; then
    # An explicit stack is generated by Terragrunt, which init runs in the Terragrunt image.
    tg_in_image "$work/tree" -e TG_TF_PATH=tofu -- terragucci init >/dev/null 2>&1 || { log "init failed"; return 1; }
    clean_mounted "$work/tree" "$(tg_image)"
  else
    (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  fi
  bin_pipeline "$work/tree/.forgejo/workflows/terragucci.yml" || return 1
  # The approver's key goes in the signers file; an agent's never does.
  ssh-keygen -q -t ed25519 -N "" -C smoke-approver -f "$work/approver" || return 1
  mkdir -p "$work/tree/.chant"
  echo "smoke-approver $(cut -d' ' -f1,2 "$work/approver.pub")" > "$work/tree/.chant/allowed_signers"
}

gated_applied() { # name -> the roots with state under <name>/, space-separated (under choudoufu, with records)
  if [ "$SMOKE_BINARY" = choudoufu ]; then bin_recorded; return 0; fi
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

claim_waves/tofu() {
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
    run_logs "$repo" "$RUN_ID" | grep "terragucci approve wave-1" >/dev/null || { log "wave 1 did not print its approval command"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep -E "terragucci approve wave-1 .*--sign" >/dev/null && { log "under approval: ledger the command asks for --sign"; rc=1; }
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

claim_apply/branches() {
  # The gated-waves fixture with apply.branches: {release: ["canary/*"]}.
  # Push main: its wave 1 is fleet/*, which waits; canary/one is release's.
  # Approve it and push main again: fleet/* applies and canary/one has no
  # state. Push the same tree to release: its wave 1 is canary/one alone,
  # which waits at the same gate. Approve it and push release again:
  # canary/one applies.
  # BREAK: the pushed pipeline loses --branches and --branch, so the map is
  # ignored: main's wave 1 is canary/one, which applies from main.
  log() { echo "[smoke apply-branches] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/apply-branches" wf sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo apply-branches || { drop_work "$work"; return 1; }
  printf 'apply:\n  branches:\n    release: ["canary/*"]\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q "github.ref == 'refs/heads/release'" "$wf" || { log "the apply jobs do not run on release"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -e "s# --branch \"\$GITHUB_REF_NAME\"##g" -e "s# --branches 'release=canary/\*'##g" "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    ! grep -q -- "--branches" "$wf" || { log "BREAK left --branches in the pipeline"; drop_work "$work"; return 1; }
  fi
  sha="$(push_tree "$work/tree" "$repo" main "apply-branches: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  if [ $rc = 0 ]; then
    applied="$(gated_applied apply-branches)"
    log "main, first push: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied before wave 1 was approved"; rc=1; }
    logs="$(run_logs "$repo" "$RUN_ID")"
    grep -q "terragucci approve wave-1" <<<"$logs" || { log "wave 1 did not wait for its approval"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve apply-branches 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "apply-branches: main, wave 1 approved")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(gated_applied apply-branches)"
    log "main, after the approval: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "fleet/five fleet/four fleet/three fleet/two " ] || { log "expected the fleet roots alone to apply from main"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" release "apply-branches: release")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(gated_applied apply-branches)"
    log "release, first push: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "fleet/five fleet/four fleet/three fleet/two " ] || { log "canary/one applied from release before its wave was approved"; rc=1; }
    logs="$(run_logs "$repo" "$RUN_ID")"
    grep -q "apply.branches: release applies canary/one" <<<"$logs" || { log "release's wave did not say it applies canary/one alone"; rc=1; }
    grep -q "terragucci approve wave-1" <<<"$logs" || { log "release's wave 1 did not wait for its approval"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve apply-branches 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" release "apply-branches: release, wave 1 approved")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(gated_applied apply-branches)"
    log "release, after the approval: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one fleet/five fleet/four fleet/three fleet/two " ] || { log "expected canary/one to apply from release once approved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "main applied the fleet roots and never canary/one; release applied canary/one alone, once its wave was approved"
  return $rc
}

claim_apply/terragrunt_branches() {
  # The Terragrunt gated-waves fixture with apply.branches: {release:
  # ["live/canary/*"]}. Push main: its wave 1 is the fleet units, which wait;
  # live/canary/one is release's. Approve it and push main again: the fleet
  # units apply and live/canary/one has no state. Push the same tree to
  # release: its wave 1 is live/canary/one alone, which waits at the same
  # gate. Approve it and push release again: live/canary/one applies.
  # BREAK: the pushed pipeline loses --branches and --branch, so the map is
  # ignored: main's wave 1 is live/canary/one, which applies from main.
  log() { echo "[smoke tg-apply-branches] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-apply-branches" wf sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-apply-branches tg-gated-waves || { drop_work "$work"; return 1; }
  printf 'apply:\n  branches:\n    release: ["live/canary/*"]\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q "github.ref == 'refs/heads/release'" "$wf" || { log "the apply jobs do not run on release"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -e "s# --branch \"\$GITHUB_REF_NAME\"##g" -e "s# --branches 'release=live/canary/\*'##g" "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    ! grep -q -- "--branches" "$wf" || { log "BREAK left --branches in the pipeline"; drop_work "$work"; return 1; }
  fi
  sha="$(push_tree "$work/tree" "$repo" main "tg-apply-branches: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  if [ $rc = 0 ]; then
    applied="$(tg_gated_applied tg-apply-branches)"
    log "main, first push: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a unit applied before wave 1 was approved"; rc=1; }
    logs="$(run_logs "$repo" "$RUN_ID")"
    grep -q "terragucci approve wave-1" <<<"$logs" || { log "wave 1 did not wait for its approval"; rc=1; }
    grep -q "apply.branches: live/canary/one applies from release, not here" <<<"$logs" || { log "main's wave did not say live/canary/one applies from release"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve tg-apply-branches 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "tg-apply-branches: main, wave 1 approved")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(tg_gated_applied tg-apply-branches)"
    log "main, after the approval: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "live/fleet/three live/fleet/two " ] || { log "expected the fleet units alone to apply from main"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" release "tg-apply-branches: release")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(tg_gated_applied tg-apply-branches)"
    log "release, first push: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "live/fleet/three live/fleet/two " ] || { log "live/canary/one applied from release before its wave was approved"; rc=1; }
    logs="$(run_logs "$repo" "$RUN_ID")"
    grep -q "apply.branches: release applies live/canary/one" <<<"$logs" || { log "release's wave did not say it applies live/canary/one alone"; rc=1; }
    grep -q "terragucci approve wave-1" <<<"$logs" || { log "release's wave 1 did not wait for its approval"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve tg-apply-branches 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" release "tg-apply-branches: release, wave 1 approved")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    applied="$(tg_gated_applied tg-apply-branches)"
    log "release, after the approval: run ${RUN_STATUS:-none}, state for: ${applied:-nothing}"
    [ "$applied" = "live/canary/one live/fleet/three live/fleet/two " ] || { log "expected live/canary/one to apply from release once approved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "main applied the fleet units and never live/canary/one; release applied live/canary/one alone, once its wave was approved"
  return $rc
}

# A root of the apply-branches-drift repo, its state in the bucket under
# the key given: app holds a terraform_data, canary an SQS queue whose owner
# tag is the one given.
branches_drift_root() { # work, root, bucket, key, [queue, owner tag]
  local dir="$1/wave/$2"
  mkdir -p "$dir"
  if [ "$2" = app ]; then
    printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "%s"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "app" {\n  input = "app"\n}\n' "$3" "$4" > "$dir/main.tf"
    return
  fi
  printf 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n\n  backend "s3" {\n    bucket         = "%s"\n    key            = "%s"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nprovider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_sqs_queue" "jobs" {\n  name = "%s"\n  tags = { owner = "%s" }\n}\n' "$3" "$4" "$5" "$6" > "$dir/main.tf"
  cp "$EXAMPLE/envs/dev/platform/.terraform.lock.hcl" "$dir/"
}

branches_drift_apply() { # work, log name, tf-apply arguments... -> AUDIT_CODE
  local work="$1" name="$2"; shift 2
  AUDIT_CODE=0
  audit_in "$work" terragucci stage tf-apply --wave 1 --layers 'app,canary' --binary tofu --gate never "$@" > "$work/$name.log" 2>&1 || AUDIT_CODE=$?
  cat "$work/$name.log" >&2
  clean_mounted "$work/wave" "$(image_tag tofu)"
}

claim_drift/branches() {
  # Two roots with their state in floci and apply.branches: {release:
  # ["canary"]}: app, a terraform_data, and canary, an SQS queue. release
  # applies canary (owner tag v1, state at canary.tfstate), then moves its
  # state to release/canary.tfstate and applies owner v2; main still names
  # canary.tfstate, where the state of v1 is left, and applies app alone.
  # tf-drift on main then plans canary from release, the branch that applied
  # it: its log says so, and neither root drifted.
  # BREAK: the drift run's terragucci.yml has no apply.branches, so canary
  # plans from main, reads the state release left behind, and reports the
  # owner tag as drift: the false drift the claim catches.
  log() { echo "[smoke apply-branches-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="abd-$STAMP" queue="abd-q-$STAMP" map='release=canary' report sha url
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  branches_drift_root "$work" app "$bucket" app.tfstate
  branches_drift_root "$work" canary "$bucket" canary.tfstate "$queue" v1
  printf 'binary: tofu\nroots: ["app", "canary"]\napply:\n  branches:\n    release: ["canary"]\n' > "$work/wave/terragucci.yml"
  printf '.terraform/\nterragucci-report/\n' > "$work/wave/.gitignore"
  audit_origin "$work"
  git -C "$work/wave" checkout -q -b release
  git -C "$work/wave" push -q "$work/origin.git" release
  branches_drift_apply "$work" release-1 --branches "$map" --branch release
  [ "$AUDIT_CODE" = 0 ] || { log "release's first wave exited $AUDIT_CODE, not 0"; rc=1; }
  grep -q "apply.branches: release applies canary" "$work/release-1.log" || { log "release's wave did not apply canary alone"; rc=1; }
  if [ $rc = 0 ]; then
    # release moves canary's state to a key of its own, and applies a new owner tag there.
    curl -fsS -o /dev/null -X PUT -H "x-amz-copy-source: /$bucket/canary.tfstate" "$FLOCI/$bucket/release/canary.tfstate" || { log "could not copy canary's state to its new key"; rc=1; }
    branches_drift_root "$work" canary "$bucket" release/canary.tfstate "$queue" v2
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "release: canary's state under release/, owner v2"
    git -C "$work/wave" push -q "$work/origin.git" release
    sha="$(git -C "$work/wave" rev-parse --short=8 HEAD)"
    branches_drift_apply "$work" release-2 --branches "$map" --branch release
    [ "$AUDIT_CODE" = 0 ] || { log "release's second wave exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  git -C "$work/wave" checkout -q main
  if [ $rc = 0 ]; then
    branches_drift_apply "$work" main --branches "$map"
    [ "$AUDIT_CODE" = 0 ] || { log "main's wave exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ -n "${BREAK:-}" ] && printf 'binary: tofu\nroots: ["app", "canary"]\n' > "$work/wave/terragucci.yml"
    audit_in "$work" terragucci stage tf-drift --binary tofu --layers 'app,canary' > "$work/drift.log" 2>&1 || true
    cat "$work/drift.log" >&2
    clean_mounted "$work/wave" "$image"
    git -C "$work/wave" checkout -q -- terragucci.yml
    report="$work/wave/terragucci-report/report.json"
    [ -f "$report" ] || { log "the drift run wrote no report"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    log "drift by root: $(jq -c '[.roots[] | {path, changes: [.changes[] | {address, action, attributes: [.attributes[]?.path]}], error}]' "$report")"
    [ "$(jq -r '[.roots[] | .path] | sort | join(",")' "$report")" = "app,canary" ] || { log "the drift run did not check both roots"; rc=1; }
    jq -e '[.roots[] | select(.error != null)] | length == 0' "$report" >/dev/null || { log "a root failed its drift check"; rc=1; }
    jq -e '[.roots[] | select(.path == "canary") | .changes[]] | length == 0' "$report" >/dev/null || { log "canary reports drift that is only the difference between main and release"; rc=1; }
    jq -e '[.roots[] | select(.path == "app") | .changes[]] | length == 0' "$report" >/dev/null || { log "app reports drift"; rc=1; }
    grep -q "apply.branches: canary plans from release at $sha, the branch that applies it" "$work/drift.log" || { log "the drift run did not plan canary from release at $sha"; rc=1; }
  fi
  url="$(curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: AmazonSQS.GetQueueUrl" -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueName\":\"$queue\"}" 2>/dev/null | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] && curl -s -o /dev/null -X POST "$FLOCI/" -H "X-Amz-Target: AmazonSQS.DeleteQueue" -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueUrl\":\"$url\"}"
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the drift run planned canary from release, whose state and owner tag are the ones the cloud holds, and found no drift in either root"
  return $rc
}

claim_init/own_jobs() {
  # The gated-waves fixture under gate: never, with own_jobs: ci/own-jobs.yml
  # naming one job that needs check and prints a marker. init runs twice; the
  # pipeline still holds the job as the file has it, and on the push the job
  # runs and passes, its log carrying the marker.
  # BREAK: the second init runs without own_jobs, as init did before the key,
  # so it drops the job.
  log() { echo "[smoke own-jobs-kept] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/own-jobs-kept" wf image sha job id marker="own job ran for own-jobs-kept" rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo own-jobs-kept || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  image="$(awk '/^  check:/{c=1} c && /image:/{print $2; exit}' "$wf")"
  [ -n "$image" ] || { log "no image on the check job"; drop_work "$work"; return 1; }
  sed 's#^gate: always#gate: never#' "$work/tree/terragucci.yml" > "$work/tree/terragucci.yml.new" && mv "$work/tree/terragucci.yml.new" "$work/tree/terragucci.yml"
  mkdir -p "$work/tree/ci"
  cat > "$work/tree/ci/own-jobs.yml" <<EOF
own-job:
  needs: check
  runs-on: ubuntu-latest
  container:
    image: $image
  steps:
    - name: Say the job ran
      run: echo "$marker on \${{ github.ref_name }}"
EOF
  printf 'own_jobs: ci/own-jobs.yml\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "the first init failed"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    grep -v '^own_jobs:' "$work/tree/terragucci.yml" > "$work/tree/terragucci.yml.new" && mv "$work/tree/terragucci.yml.new" "$work/tree/terragucci.yml"
  fi
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "the second init failed"; drop_work "$work"; return 1; }
  grep -q '^  own-job:$' "$wf" || { log "after the second init the pipeline has no own-job"; rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "own-jobs-kept: init twice")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  fi
  if [ $rc = 0 ]; then
    job="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -c '[.[] | select(.name == "own-job")][0] // {}')"
    log "own-job: $(jq -r '.status // "none"' <<<"$job")"
    [ "$(jq -r '.status // ""' <<<"$job")" = success ] || { log "own-job did not run and pass"; rc=1; }
    id="$(jq -r '.id // ""' <<<"$job")"
    [ -n "$id" ] && { api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null | grep -q "$marker on main" || { log "own-job's log has no marker"; rc=1; }; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "init ran twice and kept own-job, which ran after check and passed"
  return $rc
}

# ── ephemeral environments ────────────────────────────────────────────────
# The gated-waves fixture under gate: never, with ephemeral naming canary/*.
# A pull request's copy of canary/one lives at <name>/canary/one-pr-<n>.tfstate.

ephemeral_repo() { # name, ttl -> the repo in $work/tree, pushed to main and applied
  gated_repo "$1" || return 1
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && mv "$work/tree/terragucci.yml.bak" "$work/"
  printf 'ephemeral:\n  roots: ["canary/*"]\n  ttl: %s\n  sweep: 60\n' "$2" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  grep -q "terragucci ephemeral up" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no ephemeral job"; return 1; }
  [ -f "$work/tree/.forgejo/workflows/terragucci-ephemeral.yml" ] || { log "init wrote no sweep workflow"; return 1; }
}

ephemeral_resources() { # name, pr -> how many resources the copy's state holds; empty when there is no state
  curl -fsS "$FLOCI/shop-terraform-state/$1/canary/one-pr-$2.tfstate" 2>/dev/null | jq -r '[.resources[]?.instances[]?] | length' 2>/dev/null || true
}

ephemeral_done() { # repo -> chant/lifecycle's _gates/tf-ephemeral/done.jsonl
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  git clone -q --single-branch --branch chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$1.git" "$d/l" >/dev/null 2>&1 && cat "$d/l/_gates/tf-ephemeral/done.jsonl" 2>/dev/null || true
  drop_work "$d"
}

ephemeral_runs() { # repo, head -> the ids of the default branch's pull_request_target runs on head, newest first
  api "$URL/api/v1/repos/$1/actions/runs?head_sha=$2" | jq -r '[.workflow_runs[] | select(.trigger_event == "pull_request_target")] | .[].id'
}

ephemeral_wait() { # repo, run id -> waits for the run to finish; sets RUN_STATUS
  local deadline=$(( $(date +%s) + TIMEOUT ))
  RUN_STATUS=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    RUN_STATUS="$(api "$URL/api/v1/repos/$1/actions/runs/$2" | jq -r '.status // empty')"
    case "$RUN_STATUS" in success|failure|cancelled|skipped) break ;; esac
    sleep 3
  done
  log "run $2: ${RUN_STATUS:-unknown}"
  [ "$RUN_STATUS" = success ] || print_logs "$1" "$2" >&2 || true
}

ephemeral_open() { # name, repo -> sets EPH_PR and EPH_HEAD once the pull request's copy applied
  echo "eph $RANDOM" > "$work/tree/canary/one/rev.txt"
  ephemeral_pr "$1" "$2" "$1: change canary/one"
}

ephemeral_pr() { # name, repo, title -> pushes $work/tree as the change branch, opens a pull request; sets EPH_PR and EPH_HEAD once its copy applied
  local i run=""
  EPH_HEAD="$(push_tree "$work/tree" "$2" change "$3")" || return 1
  git -C "$work/tree" checkout -q main
  EPH_PR="$(pr_open "$2" change "$3")" || return 1
  for i in $(seq 1 60); do
    run="$(ephemeral_runs "$2" "$EPH_HEAD" | head -1)"
    [ -n "$run" ] && break
    sleep 3
  done
  [ -n "$run" ] || { log "no pull_request_target run started for pull request $EPH_PR"; return 1; }
  ephemeral_wait "$2" "$run"
  [ "$RUN_STATUS" = success ] || { log "the ephemeral job of pull request $EPH_PR did not succeed"; return 1; }
}

claim_ephemeral/pr() {
  # Push the fixture to main, which applies every root at its own key. Open a
  # pull request that changes canary/one: the default branch's ephemeral job
  # applies its copy under <name>/canary/one-pr-<n>.tfstate, and the root's
  # own state stays as main left it. Close the pull request: the closed event
  # runs the job again, which plans the destroy and applies it, so the copy's
  # state holds no resource, and done.jsonl on chant/lifecycle records the
  # apply and the destroy with the reason closed.
  # BREAK: closed is cut from the pull_request_target types of the pushed
  # pipeline, and the sweep workflow is left out, so nothing destroys the
  # copy when the pull request closes.
  log() { echo "[smoke ephemeral-pr] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/ephemeral-pr" wf sha n before after run="" i done_lines rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  ephemeral_repo ephemeral-pr 24h || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak '/^  pull_request_target:/,/^[a-z]/{/^      - closed$/d;}' "$wf" && mv "$wf.bak" "$work/"
    mv "$work/tree/.forgejo/workflows/terragucci-ephemeral.yml" "$work/"
    ! grep -A6 '^  pull_request_target:' "$wf" | grep -q -- '- closed' || { log "BREAK left closed in the pipeline"; drop_work "$work"; return 1; }
  fi
  sha="$(push_tree "$work/tree" "$repo" main "ephemeral-pr: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && { ephemeral_open ephemeral-pr "$repo" || rc=1; }
  if [ $rc = 0 ]; then
    n="$(ephemeral_resources ephemeral-pr "$EPH_PR")"
    log "pull request $EPH_PR open: its copy holds ${n:-no state} resources at ephemeral-pr/canary/one-pr-$EPH_PR.tfstate"
    [ "${n:-0}" -ge 1 ] || { log "the pull request got no copy of canary/one"; rc=1; }
    [ "$(curl -fsS "$FLOCI/shop-terraform-state/ephemeral-pr/canary/one.tfstate" | jq -r '[.resources[]?.instances[]?.attributes.input | if type == "object" then .value else . end] | first // empty')" = 1 ] \
      || { log "the copy's apply touched canary/one's own state"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    before="$(ephemeral_runs "$repo" "$EPH_HEAD" | wc -l | tr -d ' ')"
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$repo/pulls/$EPH_PR" || { log "pull request $EPH_PR did not close"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # The closed event's run, if the pipeline has one: give it a minute to start.
    for i in $(seq 1 20); do
      after="$(ephemeral_runs "$repo" "$EPH_HEAD" | wc -l | tr -d ' ')"
      [ "$after" -gt "$before" ] && { run="$(ephemeral_runs "$repo" "$EPH_HEAD" | head -1)"; break; }
      sleep 3
    done
    if [ -n "$run" ]; then ephemeral_wait "$repo" "$run"; else log "no run started when pull request $EPH_PR closed"; fi
    n="$(ephemeral_resources ephemeral-pr "$EPH_PR")"
    log "pull request $EPH_PR closed: its copy holds ${n:-no state} resources"
    [ "$n" = 0 ] || { log "closing pull request $EPH_PR did not destroy its copy"; rc=1; }
    done_lines="$(ephemeral_done "$repo")"
    jq -c '{kind, pr, result, reason, roots: [.roots[].location]}' <<<"$done_lines" >&2 || true
    jq -e --argjson pr "$EPH_PR" 'select(.kind == "ephemeral-destroy" and .pr == $pr and .reason == "closed" and .result == "destroyed" and (.planDigest | test("sha256:")))' <<<"$done_lines" >/dev/null \
      || { log "chant/lifecycle records no destroy of the copy for the close"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "pull request $EPH_PR got its own copy of canary/one beside the root's state, and closing it destroyed the copy on the record"
  return $rc
}

claim_ephemeral/ttl() {
  # The same repo with ttl: 1m. The pull request's copy applies; once a
  # minute has passed, one run of the sweep workflow (dispatched, as its
  # schedule would run it) destroys the copy while the pull request is still
  # open, and done.jsonl records the destroy with the reason expired.
  # BREAK: the sweep workflow is left out of the pushed tree, so nothing
  # destroys a copy whose TTL passed.
  log() { echo "[smoke ephemeral-ttl] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/ephemeral-ttl" sha n run="" deadline status="" done_lines state rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  ephemeral_repo ephemeral-ttl 1m || { drop_work "$work"; return 1; }
  [ -z "${BREAK:-}" ] || mv "$work/tree/.forgejo/workflows/terragucci-ephemeral.yml" "$work/"
  sha="$(push_tree "$work/tree" "$repo" main "ephemeral-ttl: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && { ephemeral_open ephemeral-ttl "$repo" || rc=1; }
  if [ $rc = 0 ]; then
    n="$(ephemeral_resources ephemeral-ttl "$EPH_PR")"
    log "pull request $EPH_PR open: its copy holds ${n:-no state} resources"
    [ "${n:-0}" -ge 1 ] || { log "the pull request got no copy of canary/one"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # The TTL is a minute from the copy's apply, which finished before the run did.
    log "waiting out the copy's one-minute TTL"
    sleep 65
    if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
        "$URL/api/v1/repos/$repo/actions/workflows/terragucci-ephemeral.yml/dispatches" 2>/dev/null)"; then
      run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
      if [ -n "$run" ]; then ephemeral_wait "$repo" "$run"; else log "the dispatch named no run"; fi
    else
      log "Forgejo has no sweep workflow to run in $repo"
    fi
    n="$(ephemeral_resources ephemeral-ttl "$EPH_PR")"
    state="$(api "$URL/api/v1/repos/$repo/pulls/$EPH_PR" | jq -r '.state')"
    log "after the sweep: pull request $EPH_PR is $state, its copy holds ${n:-no state} resources"
    [ "$state" = open ] || { log "pull request $EPH_PR is not open, so this is not the TTL's doing"; rc=1; }
    [ "$n" = 0 ] || { log "the sweep did not destroy the expired copy"; rc=1; }
    done_lines="$(ephemeral_done "$repo")"
    jq -c '{kind, pr, result, reason, expiresAt}' <<<"$done_lines" >&2 || true
    jq -e --argjson pr "$EPH_PR" 'select(.kind == "ephemeral-destroy" and .pr == $pr and .reason == "expired" and .result == "destroyed")' <<<"$done_lines" >/dev/null \
      || { log "chant/lifecycle records no destroy of the copy for its TTL"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the copy of open pull request $EPH_PR was destroyed by the sweep once its TTL passed, on the record"
  return $rc
}

ephemeral_close() { # repo -> closes pull request $EPH_PR and waits for the run its closed event starts
  local before after i run=""
  before="$(ephemeral_runs "$1" "$EPH_HEAD" | wc -l | tr -d ' ')"
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$1/pulls/$EPH_PR" || { log "pull request $EPH_PR did not close"; return 1; }
  for i in $(seq 1 20); do
    after="$(ephemeral_runs "$1" "$EPH_HEAD" | wc -l | tr -d ' ')"
    [ "$after" -gt "$before" ] && { run="$(ephemeral_runs "$1" "$EPH_HEAD" | head -1)"; break; }
    sleep 3
  done
  if [ -n "$run" ]; then ephemeral_wait "$1" "$run"; else log "no run started when pull request $EPH_PR closed"; fi
}

ephemeral_destroyed() { # repo -> 0 when done.jsonl records the destroy of $EPH_PR's copy for the close
  local done_lines
  done_lines="$(ephemeral_done "$1")"
  jq -c '{kind, pr, result, reason, roots: [.roots[].location]}' <<<"$done_lines" >&2 || true
  jq -e --argjson pr "$EPH_PR" 'select(.kind == "ephemeral-destroy" and .pr == $pr and .reason == "closed" and .result == "destroyed" and (.planDigest | test("sha256:")))' <<<"$done_lines" >/dev/null
}

state_count() { # key -> how many resource instances the state at key in floci holds; empty when there is no state
  curl -fsS "$FLOCI/shop-terraform-state/$1" 2>/dev/null | jq -r '[.resources[]?.instances[]?] | length' 2>/dev/null || true
}

claim_ephemeral/terragrunt() {
  # The Terragrunt gated-waves fixture under gate: never, its root.hcl key
  # reading TERRAGUCCI_EPHEMERAL_SUFFIX, and ephemeral naming live/canary/*.
  # The push to main applies every unit at its own key. A pull request that
  # changes live/canary/one: the default branch's ephemeral job prepares the
  # unit through Terragrunt with the suffix set and applies its copy at
  # live/canary/one/terraform-pr-<n>.tfstate, and the unit's own state keeps
  # rev 1. Closing the pull request destroys the copy through a planned
  # destroy recorded on chant/lifecycle with the reason closed.
  # BREAK: root.hcl's key does not read the suffix, so the ephemeral job
  # refuses the copy as a config error and the pull request gets none.
  log() { echo "[smoke tg-ephemeral-pr] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-ephemeral-pr" name=tg-ephemeral-pr sha n logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo "$name" tg-gated-waves || { drop_work "$work"; return 1; }
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && mv "$work/tree/terragucci.yml.bak" "$work/"
  if [ -z "${BREAK:-}" ]; then
    perl -pi -e 's#/terraform\.tfstate"#/terraform\${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}.tfstate"#' "$work/tree/root.hcl"
    grep -q 'TERRAGUCCI_EPHEMERAL_SUFFIX' "$work/tree/root.hcl" || { log "root.hcl's key does not read the suffix"; drop_work "$work"; return 1; }
  fi
  printf 'ephemeral:\n  roots: ["live/canary/*"]\n  ttl: 24h\n  sweep: 60\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && TERRAGUCCI_TERRAGRUNT=/nonexistent/terragrunt "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -q "terragucci ephemeral up" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no ephemeral job"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "$name: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && [ "$(tg_gated_applied "$name")" != "" ] || { log "the push to main applied no unit"; rc=1; }
  if [ $rc = 0 ]; then
    echo "eph $RANDOM" > "$work/tree/live/canary/one/rev.txt"
    ephemeral_pr "$name" "$repo" "$name: change live/canary/one" || rc=1
    [ $rc = 0 ] || [ -z "${EPH_PR:-}" ] || { logs="$(run_logs "$repo" "$(ephemeral_runs "$repo" "$EPH_HEAD" | head -1)" 2>/dev/null || true)"; grep -m3 -E 'TERRAGUCCI_EPHEMERAL_SUFFIX|refused' <<<"$logs" >&2 || true; }
  fi
  if [ $rc = 0 ]; then
    n="$(state_count "$name/live/canary/one/terraform-pr-$EPH_PR.tfstate")"
    log "pull request $EPH_PR open: its copy holds ${n:-no state} resources at $name/live/canary/one/terraform-pr-$EPH_PR.tfstate"
    [ "${n:-0}" -ge 1 ] || { log "the pull request got no copy of live/canary/one"; rc=1; }
    [ "$(curl -fsS "$FLOCI/shop-terraform-state/$name/live/canary/one/terraform.tfstate" | jq -r '[.resources[]?.instances[]?.attributes.input | if type == "object" then .value else . end] | first // empty')" = 1 ] \
      || { log "the copy's apply touched live/canary/one's own state"; rc=1; }
    [ -z "$(state_count "$name/live/fleet/two/terraform-pr-$EPH_PR.tfstate")" ] || { log "live/fleet/two, which ephemeral does not name, got a copy"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    ephemeral_close "$repo" || rc=1
    n="$(state_count "$name/live/canary/one/terraform-pr-$EPH_PR.tfstate")"
    log "pull request $EPH_PR closed: its copy holds ${n:-no state} resources"
    [ "$n" = 0 ] || { log "closing pull request $EPH_PR did not destroy its copy"; rc=1; }
    ephemeral_destroyed "$repo" || { log "chant/lifecycle records no destroy of the copy for the close"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "pull request $EPH_PR got its own copy of the Terragrunt unit live/canary/one beside the unit's own state, and closing it destroyed the copy on the record"
  return $rc
}

claim_ephemeral/cdktn() {
  # The CDK Terrain app of cdktn-synth with each stack's state in floci under
  # cdktn-ephemeral/, gate: never, and ephemeral naming
  # cdktf.out/stacks/dev. The push to main synthesizes and applies both
  # stacks. A pull request that changes the size of dev in main.js: the
  # default branch's ephemeral job runs synth in the head's checkout and
  # applies its copy of dev at cdktn-ephemeral/dev-pr-<n>.tfstate with the
  # new size, while dev's own state keeps size 1. Closing the pull request
  # runs synth on the applied commit again and destroys the copy, recorded
  # with the reason closed.
  # BREAK: after init, terragucci.yml's synth becomes true, which writes no
  # stack, so the ephemeral job finds no root to copy (the pipeline's own
  # jobs keep the synth init wrote into them).
  log() { echo "[smoke cdktn-ephemeral] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-ephemeral" name=cdktn-ephemeral sha n rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo "$name" || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  cdktn_tree "$name" "$(printf 'binary: tofu\nforge: forgejo\ngate: never\nsynth: npm ci --no-audit --no-fund && npx cdktn synth\nephemeral:\n  roots: ["cdktf.out/stacks/dev"]\n  ttl: 24h\n  sweep: 60\n')" || { drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -q "terragucci ephemeral up" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init wrote no ephemeral job"; drop_work "$work"; return 1; }
  [ -z "${BREAK:-}" ] || perl -pi -e 's#^synth: .*#synth: "true"#' "$work/tree/terragucci.yml"
  sha="$(push_tree "$work/tree" "$repo" main "$name: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && { curl -fsS "$FLOCI/shop-terraform-state/$name/dev.tfstate" | jq -e '.outputs.size.value == 1' >/dev/null || { log "the push to main did not apply dev"; rc=1; }; }
  if [ $rc = 0 ]; then
    sed -i.bak 's/dev: 1,/dev: 2,/' "$work/tree/main.js" && mv "$work/tree/main.js.bak" "$work/"
    grep -q 'dev: 2,' "$work/tree/main.js" || { log "main.js does not set dev's size to 2"; rc=1; }
    [ $rc = 0 ] && { ephemeral_pr "$name" "$repo" "$name: dev holds 2" || rc=1; }
  fi
  if [ $rc = 0 ]; then
    n="$(state_count "$name/dev-pr-$EPH_PR.tfstate")"
    log "pull request $EPH_PR open: its copy holds ${n:-no state} resources at $name/dev-pr-$EPH_PR.tfstate"
    [ "${n:-0}" -ge 1 ] || { log "the pull request got no copy of dev"; rc=1; }
    curl -fsS "$FLOCI/shop-terraform-state/$name/dev-pr-$EPH_PR.tfstate" | jq -e '.outputs.size.value == 2' >/dev/null || { log "the copy does not hold the size the pull request's app synthesizes"; rc=1; }
    curl -fsS "$FLOCI/shop-terraform-state/$name/dev.tfstate" | jq -e '.outputs.size.value == 1' >/dev/null || { log "the copy's apply touched dev's own state"; rc=1; }
    [ -z "$(state_count "$name/prod-pr-$EPH_PR.tfstate")" ] || { log "prod, which ephemeral does not name, got a copy"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    ephemeral_close "$repo" || rc=1
    n="$(state_count "$name/dev-pr-$EPH_PR.tfstate")"
    log "pull request $EPH_PR closed: its copy holds ${n:-no state} resources"
    [ "$n" = 0 ] || { log "closing pull request $EPH_PR did not destroy its copy"; rc=1; }
    ephemeral_destroyed "$repo" || { log "chant/lifecycle records no destroy of the copy for the close"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "pull request $EPH_PR got a copy of the synthesized stack dev at its own key, and closing it destroyed the copy on the record"
  return $rc
}

claim_generate/cdktn() {
  # The CDK Terrain app of cdktn-synth with synth and a generate key that
  # gives every root an s3 backend. init and terragucci generate each refuse
  # it as a config error that names the CDK Terrain constructs that set a
  # backend, and generate writes nothing into the synthesized stacks.
  # BREAK: synth is left out of terragucci.yml, so init and generate accept
  # the generate key.
  log() { echo "[smoke cdktn-generate] $*" >&2; }
  local work out cfg rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cfg="$(printf 'binary: tofu\nforge: forgejo\nsynth: npm ci --no-audit --no-fund && npx cdktn synth\ngenerate:\n  backend:\n    s3: { bucket: shop-terraform-state, key: "{root}.tfstate", region: us-east-1 }\n')"
  [ -z "${BREAK:-}" ] || cfg="$(grep -v '^synth:' <<<"$cfg")"
  cdktn_tree "" "$cfg" || { drop_work "$work"; return 1; }
  if out="$(cd "$work/tree" && "$TERRAGUCCI" init 2>&1)"; then
    log "init accepted generate with synth"; rc=1
  else
    grep 'generate' <<<"$out" >&2 || true
    grep -q "config.generate: with synth the roots are written by the synth command, and the app sets what generate would write through its constructs: the backend with a backend construct (S3Backend, GcsBackend, AzurermBackend, LocalBackend" <<<"$out" || { log "init did not refuse generate naming the backend constructs"; rc=1; }
  fi
  if out="$(cd "$work/tree" && "$TERRAGUCCI" generate 2>&1)"; then
    log "generate ran with synth"; rc=1
  else
    grep -q "S3Backend" <<<"$out" || { log "generate did not say why: $out"; rc=1; }
  fi
  [ -z "$(find "$work/tree/cdktf.out" -name backend.tf)" ] || { log "generate wrote a backend.tf into a synthesized stack"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "init and generate refused generate with synth as a config error naming the CDK Terrain backend constructs"
  return $rc
}

claim_linked/cdktn() {
  # A CDK Terrain app of two stacks with their state in floci under
  # cdktn-linked/: net, whose output name is known when it plans and stamp
  # only once it applies, and app, which reads both through a
  # DataTerraformRemoteStateS3. Both applied at rev 1; net goes to rev 2 and
  # the app is synthesized again. tf-plan, run in the CI image with net and
  # app as its layers, plans app on net's planned outputs, read from the
  # synthesized cdk.tf.json: its name moves to net-2, its stamp is known
  # after apply, the report says app read net's planned outputs with stamp
  # unknown, and app's cdk.tf.json is as synth wrote it.
  # BREAK: tf-plan plans app alone (--root), so net is not planned with it
  # and app plans on net's applied state: no change.
  log() { echo "[smoke cdktn-linked] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" name=cdktn-linked net=cdktf.out/stacks/net app=cdktf.out/stacks/app r plan sum code=0 rc=0 stack args=()
  [ -n "${BREAK:-}" ] && args=(--root "$app")
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cdktn_tree "" "$(printf 'binary: tofu\nforge: forgejo\n')" || { drop_work "$work"; return 1; }
  cat > "$work/tree/main.js" <<'JS'
// Two CDK Terrain stacks: net, and app, which reads net's outputs through a
// remote state data source. Their state is in floci under STATE.
const { App, S3Backend, TerraformStack, TerraformResource, TerraformOutput, DataTerraformRemoteStateS3 } = require("cdktn");

const STATE = "@PREFIX@";
const REV = "1";
const state = (id) => ({ bucket: "shop-terraform-state", key: `${STATE}/${id}.tfstate`, region: "us-east-1", usePathStyle: true });

class Net extends TerraformStack {
  constructor(scope, id) {
    super(scope, id);
    new S3Backend(this, state(id));
    const rev = new TerraformResource(this, "this", { terraformResourceType: "terraform_data" });
    rev.addOverride("input", REV);
    new TerraformOutput(this, "name", { value: `net-${REV}` });
    new TerraformOutput(this, "stamp", { value: rev.getStringAttribute("output") });
  }
}

class Svc extends TerraformStack {
  constructor(scope, id) {
    super(scope, id);
    new S3Backend(this, state(id));
    const net = new DataTerraformRemoteStateS3(this, "net", state("net"));
    new TerraformResource(this, "name", { terraformResourceType: "terraform_data" }).addOverride("input", net.getString("name"));
    new TerraformResource(this, "stamp", { terraformResourceType: "terraform_data" }).addOverride("input", `stamp-${net.getString("stamp")}`);
  }
}

const app = new App();
new Net(app, "net");
new Svc(app, "app");
app.synth();
JS
  perl -pi -e "s#\@PREFIX\@#$name#" "$work/tree/main.js"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for stack in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$name/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$stack" || true
  done
  (cd "$work/tree" && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; drop_work "$work"; return 1; }
  grep -q 'data.terraform_remote_state.net.outputs.name' "$work/tree/$app/cdk.tf.json" || { log "app's cdk.tf.json does not read net's output"; drop_work "$work"; return 1; }
  for stack in "$net" "$app"; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w "/repo/$stack" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "could not apply $stack at rev 1"; drop_work "$work" "$image"; return 1; }
  done
  clean_mounted "$work/tree" "$image"
  perl -pi -e 's#^const REV = "1";#const REV = "2";#' "$work/tree/main.js"
  (cd "$work/tree" && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host at rev 2"; drop_work "$work"; return 1; }
  sum="$(shasum "$work/tree/$app/cdk.tf.json" | cut -d' ' -f1)"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "$name: net at rev 2"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers "$net;$app" ${args[@]+"${args[@]}"} >&2 || code=$?
  clean_mounted "$work/tree" "$image"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan exited $code and wrote no report"; drop_work "$work" "$image"; return 1; }
  plan="$(cat "$work/tree/terragucci-report/roots/$app/plan.txt" 2>/dev/null || true)"
  grep -E 'input|known after' <<<"$plan" >&2 || true
  grep -q '"net-1" -> "net-2"' <<<"$plan" || { log "app's plan does not move its name to net-2"; rc=1; }
  grep -q '"stamp-1" -> (known after apply)' <<<"$plan" || { log "app's plan does not leave its stamp unknown until net applies"; rc=1; }
  jq -e --arg net "$net" --arg app "$app" '.roots[] | select(.path == $app) | .reads == [{upstream: $net, data: "net", outputs: "planned", unknown: ["stamp"]}]' "$r" >/dev/null \
    || { log "the report does not say app read net's planned outputs with stamp unknown: $(jq -c --arg app "$app" '.roots[] | select(.path == $app) | .reads' "$r")"; rc=1; }
  [ "$(shasum "$work/tree/$app/cdk.tf.json" | cut -d' ' -f1)" = "$sum" ] || { log "the plan left app's cdk.tf.json changed"; rc=1; }
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "app planned on net's planned outputs read from its cdk.tf.json: name net-2, stamp unknown"
  return $rc
}

claim_waves/jobs() {
  # The gated-waves fixture with waves.jobs: 2. Wave 1 (canary/one) is one root
  # and one job; wave 2 (fleet/*, four roots) gets apply-wave-2, which plans
  # and gates the wave, and two share jobs of two roots each. Push, approve
  # wave 1, push: wave 1 applies and wave 2 waits at its one gate, its shares
  # skipped. Approve wave 2 once and push: each share applies its own two
  # roots, and the ledger holds one approval of wave 2, used once.
  # BREAK: the share jobs lose --shares 2 --share <s>, so each one plans,
  # gates and applies the whole wave: each applies all four roots and records
  # the approval as used again.
  log() { echo "[smoke wave-jobs] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/wave-jobs" sha applied rc=0 wf s want got ledger used approvals
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo wave-jobs || { drop_work "$work"; return 1; }
  echo "  jobs: 2" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init with waves.jobs: 2 failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  apply-wave-2-share-2:' "$wf" || { log "init wrote no share jobs for wave 2"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed 's# --shares 2 --share [0-9]##' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
  fi
  job_log() { # run id, job name
    local id
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '.[] | select(.name == $n) | .id' | head -1)"
    [ -n "$id" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null
  }
  job_status() { # run id, job name
    api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '[.[] | select(.name == $n)][0].status // "missing"'
  }
  sha="$(push_tree "$work/tree" "$repo" main "wave-jobs: first")"
  wait_run "$repo" "$sha"
  gated_approve wave-jobs 1 || rc=1
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "wave-jobs: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied wave-jobs)"
    log "after wave 1's approval: run $RUN_STATUS, state for: ${applied:-nothing}; share jobs $(job_status "$RUN_ID" apply-wave-2-share-1), $(job_status "$RUN_ID" apply-wave-2-share-2)"
    [ "$applied" = "canary/one " ] || { log "expected canary/one alone to apply, wave 2 waiting at its gate"; rc=1; }
    job_log "$RUN_ID" apply-wave-2 | grep "terragucci approve wave-2" >/dev/null || { log "apply-wave-2 did not print the approval command for wave 2"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve wave-jobs 2 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "wave-jobs: after wave 2 was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied wave-jobs)"
    log "after wave 2's approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the run ended $RUN_STATUS"; rc=1; }
    [ "$applied" = "canary/one fleet/five fleet/four fleet/three fleet/two " ] || { log "expected every root to have state"; rc=1; }
    # Wave 2's roots sorted and cut into contiguous shares, as chant cuts them
    # (#906): share 1 gets five and four, share 2 three and two.
    for s in 1 2; do
      want="$([ $s = 1 ] && echo "fleet/five fleet/four" || echo "fleet/three fleet/two")"
      got="$(job_log "$RUN_ID" "apply-wave-2-share-$s" | sed -n 's#.*applied \(fleet/[a-z]*\): .*#\1#p' | sort | tr '\n' ' ' | sed 's/ $//')"
      log "apply-wave-2-share-$s applied: ${got:-nothing}"
      [ "$got" = "$want" ] || { log "apply-wave-2-share-$s should have applied $want alone"; rc=1; }
    done
    job_log "$RUN_ID" apply-wave-2 | grep "applied fleet/" >/dev/null && { log "apply-wave-2 applied a root itself"; rc=1; }
    ledger="$(file_at "$repo" chant/lifecycle "$(remote_head "$repo" chant/lifecycle)" _gates/tf-apply.jsonl)"
    used="$(file_at "$repo" chant/lifecycle "$(remote_head "$repo" chant/lifecycle)" _gates/tf-apply/applied.jsonl | jq -s '[.[] | select(.gate == "wave-2")] | length')"
    approvals="$(jq -s '[.[] | select(.gate == "wave-2" and .kind != "pending")] | length' <<<"$ledger")"
    log "wave 2 on the ledger: $approvals approval(s), used $used time(s)"
    { [ "$approvals" = 1 ] && [ "$used" = 1 ]; } || { log "expected one approval of wave 2, used once"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 2 waited at one gate, then its two share jobs each applied their own roots under that one approval"
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

claim_approval/sealed() {
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
    # The refusals read as chant's gate-decision words them since #894.
    grep -q "an approval does not count: the approval of gate wave-1 by smoke-approver carries no seal" <<<"$logs" || { log "the run did not say the unsealed approval does not count"; rc=1; }
    grep -q "an approval does not count: the seal does not verify for smoke-approver against .chant/allowed_signers at base" <<<"$logs" || { log "the run did not say the agent's seal does not verify"; rc=1; }
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

claim_refuse/tofu() {
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

# The linked-states fixture's state keys under <name>/ in floci emptied, and
# its two roots applied at rev 1 in the tofu CI image, from a copy in $work/apply.
linked_apply() { # name
  local name="$1" key image root
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$name/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
  linked_copy "$name" "$work/apply"
  for root in net app; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/apply:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "could not apply $root"; return 1; }
  done
  clean_mounted "$work/apply" "$image"
}

linked_copy() { # name, dir -> the linked-states fixture in dir, its state keys under <name>/
  mkdir -p "$2"
  cp -R "$HERE/fixtures/linked-states/." "$2/"
  find "$2" -name main.tf -exec sed -i.bak "s#@PREFIX@#$1#" {} \;
  find "$2" -name '*.bak' -delete
}

linked_state() { # name, root -> the state's resources as "<name>=<input>" lines
  curl -fsS "$FLOCI/shop-terraform-state/$1/$2.tfstate" 2>/dev/null \
    | jq -r '.resources[]? | select(.mode == "managed") | .name as $n | .instances[]? | "\($n)=\(.attributes.input | if type == "object" then .value else . end)"' 2>/dev/null | sort || true
}

linked_key() { # prefix, sha -> the key of sha's run view in the reports bucket
  curl -fsS "$FLOCI/$REPORT_BUCKET?list-type=2&prefix=$1/" | grep -o "<Key>[^<]*/runs/$2/run.json</Key>" | sed -E 's#</?Key>##g' | head -1
}

claim_linked/plan() {
  # net (wave 1) and app (wave 2, reading net's state) applied at rev 1; then
  # net's rev.txt goes to 2 and tf-plan runs in the CI image. app plans on
  # net's planned outputs: its name moves to net-2, and its stamp, which net
  # knows only once it applies, shows as known after apply. The report says
  # app read net's planned outputs with stamp unknown, and wave 2 plans again
  # once wave 1 applies, with no review digest. app's files are as they were.
  # BREAK: tf-plan plans app alone (--root app), so net is not planned with
  # it and app plans on net's applied state: no change.
  log() { echo "[smoke linked-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" r plan code=0 rc=0 args=()
  [ -n "${BREAK:-}" ] && args=(--root app)
  image="$(image_tag tofu)"
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  linked_apply linked-plan || { drop_work "$work" "$image"; return 1; }
  linked_copy linked-plan "$work/tree"
  echo 2 > "$work/tree/net/rev.txt"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "linked-plan: net at rev 2"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers 'net;app' ${args[@]+"${args[@]}"} >&2 || code=$?
  clean_mounted "$work/tree" "$image"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan exited $code and wrote no report"; drop_work "$work" "$image"; return 1; }
  plan="$(cat "$work/tree/terragucci-report/roots/app/plan.txt" 2>/dev/null || true)"
  grep -q '"net-1" -> "net-2"' <<<"$plan" || { log "app's plan does not move its name to net-2: $(grep -m1 input <<<"$plan")"; rc=1; }
  grep -q '"stamp-1" -> (known after apply)' <<<"$plan" || { log "app's plan does not leave its stamp unknown until net applies"; rc=1; }
  jq -e '.roots[] | select(.path == "app") | .reads == [{upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"]}]' "$r" >/dev/null \
    || { log "the report does not say app read net's planned outputs with stamp unknown: $(jq -c '.roots[] | select(.path == "app") | .reads' "$r")"; rc=1; }
  jq -e '.waves[] | select(.number == 2) | .replans_after == [1] and .review_digest == null and .reads == [1]' "$r" >/dev/null \
    || { log "wave 2 is not marked to plan again once wave 1 applies: $(jq -c '.waves[] | select(.number == 2)' "$r")"; rc=1; }
  [ -z "$(git -C "$work/tree" status --porcelain -- net app)" ] || { log "the plan left app's or net's files changed: $(git -C "$work/tree" status --porcelain -- net app | tr '\n' ' ')"; rc=1; }
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "app planned on net's planned outputs: name net-2, stamp unknown, and wave 2 plans again once wave 1 applies"
  return $rc
}

claim_linked/local() {
  # The local-states fixture: net and app on the local backend, their state
  # files under state/, app reading net's through terraform_remote_state by
  # the same path. Both applied at rev 1, then net goes to rev 2 and tf-plan
  # runs in the CI image with no --layers, so terragucci finds the order from
  # the code: net in wave 1, app in wave 2 reading it, and app plans on net's
  # planned outputs (name net-2, stamp known once net applies).
  # BREAK: the bundle loses the local backend's address, so neither block
  # names a state terragucci can match: one wave, and app plans on net's
  # applied state.
  log() { echo "[smoke linked-plan-local] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle r plan root code=0 rc=0
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" state-address.ts '    case "local": {' '    case "local-cut": {' || { drop_work "$work"; return 1; }
  fi
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/local-states/." "$work/tree/"
  for root in net app; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "could not apply $root"; drop_work "$work" "$image"; return 1; }
  done
  [ -s "$work/tree/state/net.tfstate" ] && [ -s "$work/tree/state/app.tfstate" ] || { log "the applies left no state under state/"; drop_work "$work" "$image"; return 1; }
  echo 2 > "$work/tree/net/rev.txt"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "linked-plan-local: net at rev 2"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan >&2 || code=$?
  clean_mounted "$work/tree" "$image"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan exited $code and wrote no report"; drop_work "$work" "$image"; return 1; }
  log "waves: $(jq -c '[.waves[] | {number, roots, reads}]' "$r")"
  jq -e '[.waves[] | {roots, reads}] == [{roots: ["net"], reads: null}, {roots: ["app"], reads: [1]}]' "$r" >/dev/null \
    || { log "net and app are not in waves 1 and 2 with wave 2 reading wave 1"; rc=1; }
  jq -e '.roots[] | select(.path == "app") | .reads == [{upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"]}]' "$r" >/dev/null \
    || { log "the report does not say app read net's planned outputs with stamp unknown: $(jq -c '.roots[] | select(.path == "app") | .reads' "$r")"; rc=1; }
  plan="$(cat "$work/tree/terragucci-report/roots/app/plan.txt" 2>/dev/null || true)"
  grep -q '"net-1" -> "net-2"' <<<"$plan" || { log "app's plan does not move its name to net-2"; rc=1; }
  jq -e '[.roots[] | select(.unknown_reads or .unaddressed)] == []' "$r" >/dev/null || { log "the report names a state the code does not address: $(jq -c '[.roots[] | {path, unknown_reads, unaddressed}]' "$r")"; rc=1; }
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "net and app, on the local backend, ordered into waves 1 and 2 from their code, and app planned on net's planned outputs"
  return $rc
}

claim_linked/backend_config() {
  # The backend-config fixture: net and app on the local backend, each block
  # naming no path, and terragucci.yml's env passing -backend-config=backend.hcl
  # to every init through TF_CLI_ARGS_init; net's backend.hcl puts its state at
  # state/net.tfstate, which app reads through terraform_remote_state. Both
  # applied at rev 1 with that init, then net goes to rev 2 and tf-plan runs in
  # the CI image with no --layers and the job's TF_CLI_ARGS_init: net in wave
  # 1, app in wave 2 reading it, app planned on net's planned outputs, and no
  # state the report calls unaddressed.
  # BREAK: the bundle reads no -backend-config from terragucci.yml, so net's
  # state is terraform.tfstate beside it, which app does not read: one wave,
  # and app plans on net's applied state.
  log() { echo "[smoke linked-backend-config] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle r plan root code=0 rc=0 args='-backend-config=backend.hcl'
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" detect.ts '  const supplied = initArgs.length ? ' '  const supplied = initArgs.length < 0 ? ' || { drop_work "$work"; return 1; }
  fi
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/backend-config/." "$work/tree/"
  grep -qF "TF_CLI_ARGS_init: \"$args\"" "$work/tree/terragucci.yml" || { log "the fixture's terragucci.yml does not pass $args"; drop_work "$work"; return 1; }
  for root in net app; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "TF_CLI_ARGS_init=$args" \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "could not apply $root"; drop_work "$work" "$image"; return 1; }
  done
  [ -s "$work/tree/state/net.tfstate" ] && [ -s "$work/tree/state/app.tfstate" ] || { log "the applies left no state under state/: init did not take backend.hcl"; drop_work "$work" "$image"; return 1; }
  echo 2 > "$work/tree/net/rev.txt"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "linked-backend-config: net at rev 2"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "TF_CLI_ARGS_init=$args" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan >&2 || code=$?
  clean_mounted "$work/tree" "$image"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan exited $code and wrote no report"; drop_work "$work" "$image"; return 1; }
  log "waves: $(jq -c '[.waves[] | {number, roots, reads}]' "$r")"
  jq -e '[.waves[] | {roots, reads}] == [{roots: ["net"], reads: null}, {roots: ["app"], reads: [1]}]' "$r" >/dev/null \
    || { log "net and app are not in waves 1 and 2 with wave 2 reading wave 1"; rc=1; }
  jq -e '.roots[] | select(.path == "app") | .reads == [{upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"]}]' "$r" >/dev/null \
    || { log "the report does not say app read net's planned outputs with stamp unknown: $(jq -c '.roots[] | select(.path == "app") | .reads' "$r")"; rc=1; }
  plan="$(cat "$work/tree/terragucci-report/roots/app/plan.txt" 2>/dev/null || true)"
  grep -q '"net-1" -> "net-2"' <<<"$plan" || { log "app's plan does not move its name to net-2"; rc=1; }
  jq -e '[.roots[] | select(.unknown_reads or .unaddressed)] == []' "$r" >/dev/null || { log "the report names a state the code does not address: $(jq -c '[.roots[] | {path, unknown_reads, unaddressed}]' "$r")"; rc=1; }
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "net, whose path comes from the backend.hcl terragucci.yml passes to init, ordered before app, and app planned on net's planned outputs"
  return $rc
}

claim_note/blast() {
  # The resource-blast fixture: queue (a jobs queue, its policy, a
  # dead-letter queue, each ARN an output) and worker (a function reading
  # jobs_arn through terraform_remote_state, the mapping that feeds it, and a
  # log group reading only dead_arn), both applied on floci, their state
  # files under state/. A change gives the jobs queue a longer visibility
  # timeout, and tf-plan runs as a pull request's plan against the base. Its
  # note lists, under aws_sqs_queue.jobs, the policy in queue and the function
  # and mapping in worker through jobs_arn, and not the log group.
  # BREAK: the bundle's walk stops at the changed root, so the note names
  # worker as a root downstream and none of its resources.
  log() { echo "[smoke resource-blast] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle r note by root base code=0 rc=0 name="rb-$STAMP${BREAK:+b}"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" report/resource-blast.ts '        for (const reader of readersOf(up)) {' '        for (const reader of readersOf(up).slice(0, 0)) {' || { drop_work "$work"; return 1; }
  fi
  mkdir -p "$work/tree/state"
  cp -R "$HERE/fixtures/resource-blast/." "$work/tree/"
  for root in queue worker; do
    perl -pi -e "s/NAME/$name/g" "$work/tree/$root/main.tf"
    cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$work/tree/$root/"
  done
  for root in queue worker; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w "/repo/$root" "${AWS_DOCKER_ENV[@]}" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "could not apply $root"; drop_work "$work" "$image"; return 1; }
  done
  [ -s "$work/tree/state/queue.tfstate" ] && [ -s "$work/tree/state/worker.tfstate" ] || { log "the applies left no state under state/"; drop_work "$work" "$image"; return 1; }
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "resource-blast: base"
  base="$(git -C "$work/tree" rev-parse HEAD)"
  perl -pi -e 's/visibility_timeout_seconds = 30/visibility_timeout_seconds = 60/' "$work/tree/queue/main.tf"
  git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "resource-blast: a longer visibility timeout"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "TG_BASE=$base" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan >&2 || code=$?
  clean_mounted "$work/tree" "$image"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan exited $code and wrote no report"; drop_work "$work" "$image"; return 1; }
  note="$(cat "$work/tree/terragucci-report/note.md" 2>/dev/null || true)"
  log "the blast radius: $(jq -c '.blast' "$r")"
  # shellcheck disable=SC2016 # the backticks are the note's markdown
  grep -qF -- '(wave 2) reads `queue`' <<<"$note" || { log "the note does not name worker downstream of queue"; rc=1; }
  # shellcheck disable=SC2016
  grep -qF -- '- `aws_sqs_queue.jobs` in `queue` (update) reaches:' <<<"$note" || { log "the note lists nothing under the changed queue"; rc=1; }
  # shellcheck disable=SC2016
  grep -qF -- '  - `aws_sqs_queue_policy.jobs`' <<<"$note" || { log "the note does not list the queue's policy, in its own root"; rc=1; }
  # shellcheck disable=SC2016
  grep -qF -- '  - `aws_lambda_function.worker` in `worker`, through output `jobs_arn` of `queue`' <<<"$note" || { log "the note does not list the function that reads the queue's ARN in worker"; rc=1; }
  # shellcheck disable=SC2016
  grep -qF -- '  - `aws_lambda_event_source_mapping.jobs` in `worker`, through output `jobs_arn` of `queue`' <<<"$note" || { log "the note does not list the mapping that reads the queue's ARN in worker"; rc=1; }
  # The note's records list every resource of worker; the list by resource is what must leave the log group out.
  by="$(awk '/^\*\*By resource:\*\*/ { on = 1; next } on && /^(#|\*\*)/ { exit } on' <<<"$note")"
  if grep -qF 'aws_cloudwatch_log_group.dead' <<<"$by"; then log "the list by resource names the log group, which reads only dead_arn"; rc=1; fi
  jq -e '[.blast.resources[]? | select(.address == "aws_sqs_queue.jobs") | .reaches[] | select(.root == "worker") | .address] == ["aws_lambda_event_source_mapping.jobs", "aws_lambda_function.worker"]' "$r" >/dev/null \
    || { log "report.json's blast.resources does not hold the function and the mapping in worker: $(jq -c '.blast.resources' "$r")"; rc=1; }
  [ $rc = 0 ] || printf '%s\n' "$note" | grep -A12 -F 'Blast radius' >&2 || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the note lists, under the changed queue, its policy and the function and mapping that read its ARN in worker, and not the log group"
  return $rc
}

claim_linked/states() {
  # The linked-states fixture (net in wave 1, app in wave 2 reading net's
  # state), gate always, a reports bucket, both roots applied at rev 1. A pull
  # request moves net to rev 2: its plan note shows app's name moving to
  # net-2, says app read stamp before net knows it, and that wave 2 plans
  # again once wave 1 applies. Merged: wave 1 waits, and wave 2 plans nothing
  # yet. Wave 1 approved, the next run applies it, then wave 2 plans on the
  # state wave 1 applied: its plan shows net-2 and stamp-2, and it waits for
  # an approval of that digest. The run view in the bucket says wave 1
  # applied and wave 2 waiting on that digest. Wave 2 approved: app holds
  # net-2 and stamp-2, and the run view says both applied.
  # BREAK: apply-wave-2 loses its needs: apply-wave-1, so it plans while wave
  # 1 still waits, on net's old state.
  log() { echo "[smoke linked-states] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/linked-states" name=linked-states prefix sha head pr note merge logs key view plan digest pending wf rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  prefix="linked-$(date +%s)${BREAK:+b}"
  gated_repo "$name" linked-states || { drop_work "$work"; return 1; }
  linked_apply "$name" || { drop_work "$work"; return 1; }
  printf 'reports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" >> "$work/tree/terragucci.yml"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then sed '/^    needs: apply-wave-1$/d' "$wf" > "$wf.new" && mv "$wf.new" "$wf"; fi
  sha="$(push_tree "$work/tree" "$repo" main "linked-states: first")"
  wait_run "$repo" "$sha"
  log "first push, both roots applied at rev 1: run $RUN_STATUS"

  echo 2 > "$work/tree/net/rev.txt"
  head="$(push_tree "$work/tree" "$repo" change "linked-states: net to rev 2")" || rc=1
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "linked-states: net to rev 2")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=50" | jq -r '[.[] | select(.body | contains("terragucci tf-plan"))] | last | .body // empty')"
    grep -q "plans again once wave 1 applies" <<<"$note" || { log "the plan note does not say wave 2 plans again once wave 1 applies"; rc=1; }
    grep -q 'reads `net`; `stamp` known once it applies' <<<"$note" || { log "the plan note does not say app read net's stamp before net knows it"; rc=1; }
    grep -q '"net-1" -> "net-2"' <<<"$note" || { log "the plan note does not show app's name moving to net-2"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || { log "pull request $pr did not merge"; rc=1; }
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    { [ -n "$merge" ] && wait_run "$repo" "$merge" push; } || rc=1
  fi
  if [ $rc = 0 ]; then
    logs="$(run_logs "$repo" "$RUN_ID")"
    log "after the merge: run $RUN_STATUS; app at: $(linked_state "$name" app | tr '\n' ' ')"
    grep -q "terragucci approve wave-1" <<<"$logs" || { log "wave 1 did not wait for its approval"; rc=1; }
    # Wave 2 plans only once wave 1 applied: nothing of it runs while wave 1 waits.
    if grep -q "wave 2 of 2: planning app" <<<"$logs"; then
      log "wave 2 planned while wave 1 waited: $(grep -m1 'app: \(Plan\|No changes\)' <<<"$logs")"; rc=1
    fi
  fi
  [ $rc = 0 ] && { gated_approve "$name" 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "linked-states: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    logs="$(run_logs "$repo" "$RUN_ID")"
    log "after wave 1's approval: run $RUN_STATUS; net at: $(linked_state "$name" net | tr '\n' ' ')"
    grep -q "app plans on the state net (wave 1) applied" <<<"$logs" || { log "wave 2 did not say it plans on the state wave 1 applied"; rc=1; }
    grep -q "terragucci approve wave-2" <<<"$logs" || { log "wave 2 did not wait for an approval of its plan"; rc=1; }
    key="$(linked_key "$prefix" "$sha" || true)"
    view="$([ -z "$key" ] || curl -fsS "$FLOCI/$REPORT_BUCKET/$key")"
    [ -n "$view" ] || { log "no run view for $sha in $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    log "run view: $(jq -c '[.waves[] | {number, state, approval}]' <<<"$view")"
    jq -e '.waves[0].state == "applied" and .waves[1].state == "waiting" and .waves[1].reads == [1] and ((.roots[] | select(.root == "app") | .reads) == ["net"])' <<<"$view" >/dev/null \
      || { log "the run view does not say wave 1 applied and wave 2, reading net, waiting"; rc=1; }
    digest="$(jq -r '.waves[1].digest // empty' <<<"$view")"
    pending="$(file_at "$repo" chant/lifecycle "$(remote_head "$repo" chant/lifecycle)" _gates/tf-apply.jsonl | jq -rs '[.[] | select(.kind == "pending" and .gate == "wave-2")] | last | .planDigest // empty')"
    { [ -n "$digest" ] && [ "$digest" = "$pending" ]; } || { log "wave 2's digest in the run view ($digest) is not the one it waits on ($pending)"; rc=1; }
    plan="$(curl -fsS "$FLOCI/$REPORT_BUCKET/${key%/runs/*}/$(jq -r '.waves[1].report' <<<"$view")/report.json" | jq -c '.roots[] | select(.path == "app") | [.reads, [.changes[].attributes[]? | select(.path == "input") | .after]]')"
    log "wave 2's plan of app: $plan"
    jq -e '.[0] == [{upstream: "net", data: "net", outputs: "applied"}] and ((.[1] | sort) == ["net-2", "stamp-2"])' <<<"$plan" >/dev/null \
      || { log "wave 2's plan of app is not on net's applied state with net-2 and stamp-2"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve "$name" 2 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "linked-states: after wave 2 was approved")"
    wait_run "$repo" "$sha"
    log "after wave 2's approval: run $RUN_STATUS; app at: $(linked_state "$name" app | tr '\n' ' ')"
    [ "$(linked_state "$name" app | tr '\n' ' ')" = "name=net-2 stamp=stamp-2 " ] || { log "app does not hold net-2 and stamp-2"; rc=1; }
    key="$(linked_key "$prefix" "$sha" || true)"
    view="$([ -z "$key" ] || curl -fsS "$FLOCI/$REPORT_BUCKET/$key")"
    jq -e '[.waves[].state] == ["applied", "applied"]' <<<"$view" >/dev/null 2>&1 || { log "the run view after wave 2 applied: $(jq -c '[.waves[].state]' <<<"$view" 2>/dev/null)"; rc=1; }
    curl -fsS "$FLOCI/$REPORT_BUCKET/${key%.json}.html" | grep -q 'data-wave="2" data-state="applied"' || { log "run.html does not show wave 2 applied"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 2 planned again once wave 1 applied, showed net-2 and stamp-2, waited for that plan's approval, and the run view followed each wave"
  return $rc
}

claim_reconcile/tofu() {
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
  # The file stays: the jobs read token_env there, and reconcile leaves a
  # project's own file alone when it holds the control repo's value.
  printf 'forge: forgejo\nbinary: tofu\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' > "$work/in-line/terragucci.yml"
  (cd "$work/in-line" && "$TERRAGUCCI" init >/dev/null)
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

claim_reconcile/mixed() {
  # A control repo whose projects are on three forges: a Forgejo project on
  # the stack and a GitHub project on stack/mock-github, each with one root
  # and no pipeline, and a Forgejo project whose forge does not answer.
  # terragucci reconcile --mode apply opens a real pull request on Forgejo
  # with the pipeline init writes for Forgejo, and one on the mock with
  # GitHub's, fails the third project by name, and exits 1.
  # BREAK: the Forgejo project is listed as forge: github, so reconcile
  # speaks GitHub's API to Forgejo and opens no pull request there.
  log() { echo "[smoke reconcile-mixed] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/reconcile-mixed" forge=forgejo mock="tgs-mockgh-mixed-$STAMP" gh_token=tg-mock-github-token gh_repo=terragucci-admin/mixed
  local port out n pr files i rc=0
  [ -n "${BREAK:-}" ] && forge=github
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo reconcile-mixed || { drop_work "$work"; return 1; }
  mkdir -p "$work/tree/app" "$work/control"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {}\n' > "$work/tree/app/main.tf"
  push_tree "$work/tree" "$repo" main "reconcile-mixed: one root, no pipeline" >/dev/null || { drop_work "$work"; return 1; }
  [ -n "$(remote_head "$repo" main)" ] || { log "main is not on Forgejo"; drop_work "$work"; return 1; }
  # The GitHub project: the same tree on the mock, which serves git over HTTP and GitHub's REST paths under /api/v3.
  docker run -d --rm --name "$mock" -p 127.0.0.1::8188 -v "$HERE/mock-github:/srv:ro" \
    -e PORT=8188 -e MOCK_TOKEN="$gh_token" -e "MOCK_PUBLIC_URL=http://127.0.0.1:8188" \
    public.ecr.aws/docker/library/node:22-bookworm node /srv/server.mjs >/dev/null || { log "the mock did not start"; drop_work "$work"; return 1; }
  port="$(docker port "$mock" 8188/tcp | head -1 | sed 's/.*://')"
  for i in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$port/__mock/health" 2>/dev/null && break; sleep 1; done
  ghm() { curl -fsS -H "Authorization: Bearer $gh_token" -H 'content-type: application/json' "$@"; }
  ghm -o /dev/null -d '{"name":"mixed","default_branch":"main"}' "http://127.0.0.1:$port/api/v3/user/repos" || { log "could not make the repo on the mock"; rc=1; }
  git -C "$work/tree" push -q "http://x:$gh_token@127.0.0.1:$port/$gh_repo.git" HEAD:refs/heads/main 2>&1 | sed 's/^/  /' >&2 || true
  ghm -o /dev/null "http://127.0.0.1:$port/api/v3/repos/$gh_repo/branches/main" || { log "main is not on the mock"; rc=1; }
  cat > "$work/control/terragucci.yml" <<YML
defaults:
  binary: tofu
projects:
  localhost/$repo:
    forge: $forge
    url: $URL/$repo
  github.com/$gh_repo:
    url: http://127.0.0.1:$port/$gh_repo
  forgejo.invalid/smoke/reconcile-mixed:
    forge: forgejo
    url: http://127.0.0.1:9/smoke/reconcile-mixed
YML
  if [ $rc = 0 ]; then
    out="$(cd "$work/control" && FORGEJO_TOKEN="$TOKEN" GITHUB_TOKEN="$gh_token" "$TERRAGUCCI" reconcile --config terragucci.yml --mode apply 2>&1)"; n=$?
    echo "$out" | sed 's/^/  /' >&2
    [ "$n" = 1 ] || { log "reconcile exited $n, not 1"; rc=1; }
    grep -q "^forgejo.invalid/smoke/reconcile-mixed: FAILED " <<<"$out" || { log "reconcile did not name the unreachable project as failed"; rc=1; }
    # The Forgejo pull request, and the files it adds.
    pr="$(api "$URL/api/v1/repos/$repo/pulls?state=open" | jq -r '[.[] | select(.head.ref == "terragucci/pipeline")][0].number // empty')"
    if [ -z "$pr" ]; then
      log "no pull request from terragucci/pipeline on Forgejo"; rc=1
    else
      files="$(api "$URL/api/v1/repos/$repo/pulls/$pr/files" | jq -r '[.[].filename] | sort | join(",")')"
      log "Forgejo pull request $pr adds $files"
      grep -q '.forgejo/workflows/terragucci.yml' <<<"$files" || { log "the Forgejo pull request does not add Forgejo's pipeline"; rc=1; }
    fi
    # The mock's pull request, and Forgejo's pipeline nowhere in its branch.
    pr="$(ghm "http://127.0.0.1:$port/api/v3/repos/$gh_repo/pulls?state=open" | jq -r '[.[] | select(.head.ref == "terragucci/pipeline")][0].number // empty')"
    if [ -z "$pr" ]; then
      log "no pull request from terragucci/pipeline on the mock"; rc=1
    else
      git clone -q --branch terragucci/pipeline "http://127.0.0.1:$port/$gh_repo.git" "$work/gh" 2>/dev/null || true
      log "GitHub pull request $pr on the mock; its branch has $(cd "$work/gh" 2>/dev/null && find .github .forgejo -type f 2>/dev/null | sort | tr '\n' ' ')"
      [ -f "$work/gh/.github/workflows/terragucci.yml" ] && [ ! -e "$work/gh/.forgejo" ] || { log "the GitHub pull request does not carry GitHub's pipeline alone"; rc=1; }
    fi
  fi
  docker stop "$mock" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "one control repo, three forges: Forgejo and GitHub each got a pull request with their own pipeline, the unreachable project failed by name, and reconcile exited 1"
  return $rc
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
  case "$1" in tofu) cached="${SMOKE_TOFU_IMAGE:-}" ;; terragrunt) cached="${SMOKE_TG_IMAGE:-}" ;; terraform) cached="${SMOKE_TF_IMAGE:-}" ;; choudoufu) cached="${SMOKE_CDF_IMAGE:-}" ;; *) cached="" ;; esac
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
  if [ -f "$bundle" ] && [ -z "$(find "$HERE/../packages/terragucci/src" "$HERE/../packages/terragucci/package.json" "$HERE/../scripts/build-cli.mjs" "$HERE/../scripts/cli-bundle.mjs" -type f -newer "$bundle" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null)
}

# The CLI bundle with cuts in its sources (stack/break-bundle.mjs), for a
# claim whose BREAK takes its property out of the code itself: written to
# out, and mounted in place of the bundle build_cli wrote. scripts/check-breaks.mjs
# (just lint) checks every call's finds against the sources.
break_bundle() { # out, then file find replace, once or more
  (cd "$HERE/.." && node stack/break-bundle.mjs "$@") >&2 || break_setup_failed "its BREAK bundle did not build"
}

# A BREAK run whose own setup failed broke nothing, so it fails rather than
# counting as caught. The helpers that make a BREAK (break_bundle,
# break_image, break_unowned) write why to SMOKE_BREAK_SETUP, which run_claim
# makes for each BREAK run and reads when the claim returns. A file, so a
# helper run in $(...) reaches it too.
break_setup_failed() { # why -> returns 1
  [ -z "${SMOKE_BREAK_SETUP:-}" ] || printf '%s\n' "$1" >>"$SMOKE_BREAK_SETUP"
  return 1
}

# A claim whose BREAK took out a property terragucci no longer owns (it moved
# to chant) has nothing left to cut here: its BREAK run fails, naming why.
break_unowned() { # why -> returns 1
  echo "[smoke] no BREAK: $1" >&2
  break_setup_failed "no BREAK: $1"
}

# REPORT_BUNDLE: a bundle to run in place of the one build_cli wrote, such as a BREAK's.
report_run() {
  local work="$1"; shift
  local image bundle="${REPORT_BUNDLE:-$HERE/../packages/terragucci/dist/terragucci.mjs}" p rc=0
  image="$(bin_image)"
  bin_prepare || return 1
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
  # Another binary reads its own copy of the example, written as boot wrote
  # it, after the patches (written for the example itself) are in.
  if [ -z "${REPORT_TREE:-}" ]; then bin_tree "$work" "$EX_SHOP" --names "$EX_TAG" || return 1
  else bin_tree "$work" "report-$(date +%s)" || return 1; fi
  git -C "$work" remote add origin "http://forgejo:3000/$USER/$EX_REPO.git"
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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
  image="$(bin_image)"
  bin_prepare || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$work/"
  bin_tree "$work" "$EX_SHOP" --names "$EX_TAG" || { drop_work "$work"; return 1; }
  if [ -n "${SMOKE_AWS:-}" ]; then smoke_aws_overlay_example "$work" || return 1; smoke_aws_queue_settle; fi
  for root in "$@"; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w "/repo/$root" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "BIN=$SMOKE_BINARY" \
      "$image" sh -c '"$BIN" init -input=false -no-color >/dev/null && "$BIN" apply -auto-approve -input=false -no-color' >&2 || { drop_work "$work"; return 1; }
  done
  drop_work "$work"
}

claim_report/tofu() {
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
    bin_ran "$dir/report.json" || rc=1
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

claim_report/oidc() {
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

claim_affected/tofu() {
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

# The cases of affected/outside-roots, in the order it runs them. Each is a
# change outside every root's directory, made on a tree of
# fixtures/affected-outside-roots against the commit before it, and the roots
# tf-plan must plan for it.
OUTSIDE_CASES="var-files symlink config-keys policy-at-base synth-command"

# One case: its tree, its change, tf-plan in the tofu CI image with the
# bundle given, and the roots it planned against the roots it must plan.
# Returns 0 when they match, 1 when they do not, 2 when the case could not
# be set up. Reads $work and log from the claim.
outside_case() { # case, bundle, image
  local name="$1" bundle="$2" image="$3" tree base want got r code=0 version
  tree="$work/$name/tree"
  mkdir -p "$tree"
  if [ "$name" = synth-command ]; then
    cp -R "$HERE/fixtures/affected-outside-roots/synth/." "$tree/"
  else
    cp -R "$HERE/fixtures/affected-outside-roots/plain/." "$tree/"
    ln -s ../../../shared/common.tf "$tree/envs/prod/db/common.tf" || return 2
  fi
  git -C "$tree" init -q -b main
  git -C "$tree" add -A && git -C "$tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "outside-roots: base" || return 2
  base="$(git -C "$tree" rev-parse HEAD)"
  case "$name" in
    var-files)
      # Every prod root reads envs/prod/shared.tfvars through TF_CLI_ARGS_plan in env.
      echo 'size = 2' > "$tree/envs/prod/shared.tfvars"
      want="envs/prod/app,envs/prod/db" ;;
    symlink)
      # Only envs/prod/db links shared/common.tf.
      perl -pi -e 's/"ops"/"platform"/' "$tree/shared/common.tf"
      want="envs/prod/db" ;;
    config-keys)
      # A version for envs/prod/** alone: the release the image carries, so nothing installs.
      version="$(docker run --rm "$image" tofu version -json 2>/dev/null | jq -r .terraform_version)"
      [ -n "$version" ] && [ "$version" != null ] || { log "$name: could not read the image's tofu version"; return 2; }
      printf 'version:\n  "envs/prod/**": %s\n' "$version" >> "$tree/terragucci.yml"
      want="envs/prod/app,envs/prod/db" ;;
    policy-at-base)
      # A policy that would deny every root, an approval mode and a step: all read at the base.
      printf 'policy:\n  path: policy\napproval: pr-review\nsteps:\n  - run: "exit 1"\n    before: plan\n' >> "$tree/terragucci.yml"
      want="" ;;
    synth-command)
      # The command writes other roots now; the base wrote its own with sh gen.sh one.
      perl -pi -e 's/^synth: .*/synth: sh gen.sh two/' "$tree/terragucci.yml"
      want="out/a,out/b" ;;
  esac
  git -C "$tree" add -A && git -C "$tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "outside-roots: $name" || return 2
  [ "$name" != synth-command ] || (cd "$tree" && sh gen.sh two) || return 2
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "TG_BASE=$base" \
    -e "TF_CLI_ARGS_plan=-var-file=../shared.tfvars" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan >&2 || code=$?
  clean_mounted "$tree" "$image"
  r="$tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "$name: tf-plan exited $code and wrote no report"; return 1; }
  # Every root the report holds was selected, planned or failed (a policy denial fails one).
  got="$(jq -r '[.roots[].path] | sort | join(",")' "$r")"
  [ "$got" = "$want" ] || { log "$name: planned ${got:-nothing}, not ${want:-nothing}"; return 1; }
  log "$name: planned ${got:-nothing}, as it must"
}

claim_affected/outside_roots() {
  # Changes outside every root's directory, each on its own tree against the
  # commit before it (OUTSIDE_CASES):
  #   var-files       envs/prod/shared.tfvars, which TF_CLI_ARGS_plan in env
  #                   names as ../shared.tfvars: envs/prod/app and db plan.
  #   symlink         shared/common.tf, which envs/prod/db/common.tf links:
  #                   envs/prod/db plans.
  #   config-keys     a version for envs/prod/** in terragucci.yml: the two
  #                   prod roots plan, envs/dev/app does not.
  #   policy-at-base  a policy denying every root, an approval mode and a step added in
  #                   terragucci.yml: nothing plans, since they are read at
  #                   the base.
  #   synth-command   the synth command changes (sh gen.sh one to two): every
  #                   synthesized root plans.
  # BREAK=1 runs every case with its own cut, and BREAK=<case>[,<case>] the
  # ones named; it is caught only when every case it cut plans the wrong roots.
  # The cuts: no -var-file is read from TF_CLI_ARGS; no symlink is followed;
  # no terragucci.yml key selects a root; policy is compared as a plan key;
  # the synth command is not compared, so the base runs the head's command.
  log() { echo "[smoke outside-roots] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image plain="$HERE/../packages/terragucci/dist/terragucci.mjs" bundle name cut="${BREAK:-}" rc=0 caught=0 cuts=0 one
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ "$cut" = 1 ] && cut="${OUTSIDE_CASES// /,}"
  for name in $OUTSIDE_CASES; do
    bundle="$plain"
    if [ -n "$cut" ]; then
      case ",$cut," in *",$name,"*) ;; *) continue ;; esac
      bundle="$work/$name.mjs"
      case "$name" in
        var-files) break_bundle "$bundle" affected.ts '      const m = /^--?var-file(?:=(.*))?$/.exec(words[i]);' '      const m = /^--?var-file-cut(?:=(.*))?$/.exec(words[i]);' ;;
        symlink) break_bundle "$bundle" affected.ts '      if (e.isSymbolicLink()) {' '      if (e.isSymbolicLink() && false) {' ;;
        config-keys) break_bundle "$bundle" affected.ts '    const keys = PLAN_KEYS.filter((k) => stable(a[k]) !== stable(b[k]));' '    const keys = PLAN_KEYS.filter((k) => false && stable(a[k]) !== stable(b[k]));' ;;
        policy-at-base) break_bundle "$bundle" affected.ts \
          'export const PLAN_KEYS = ["version", "generate", "pass", "env", "oidc", "secrets"] as const;' 'export const PLAN_KEYS = ["version", "generate", "pass", "env", "oidc", "secrets", "policy"] as const;' \
          affected.ts '  return { version: versionPin(s.version, root)?.version,' '  return { policy: (s as Record<string, unknown>).policy, version: versionPin(s.version, root)?.version,' ;;
        synth-command) break_bundle "$bundle" report/stage.ts '    if (shape.kind === "synth" && outside.synth) {' '    if (shape.kind === "synth" && outside.synth && false) {' ;;
      esac || { drop_work "$work" "$image"; return 1; }
      cuts=$((cuts + 1))
    fi
    one=0
    outside_case "$name" "$bundle" "$image" || one=$?
    if [ $one = 2 ]; then log "$name: the case could not be set up"; drop_work "$work" "$image"; [ -z "$cut" ] || break_setup_failed "$name: the case could not be set up"; return 1; fi
    if [ -n "$cut" ]; then
      if [ $one = 1 ]; then caught=$((caught + 1)); else log "$name: its cut broke nothing"; fi
    else
      [ $one = 0 ] || rc=1
    fi
  done
  drop_work "$work" "$image"
  if [ -n "$cut" ]; then
    [ $cuts -gt 0 ] || { log "BREAK=$cut names no case of: $OUTSIDE_CASES"; break_setup_failed "BREAK names no case"; return 1; }
    # Caught (non-zero) only when every cut plans the wrong roots.
    log "$caught of $cuts cuts caught"
    [ $caught = $cuts ] && return 1
    return 0
  fi
  [ $rc = 0 ] && log "a shared var file, a symlink target and a version glob planned the roots that read them, a policy at head planned nothing, and a new synth command planned every root"
  return $rc
}

# The example's services read their environment's platform state, so a pull
# request on it plans them only while floci holds that state. floci keeps
# nothing across a restart, but the example repo on Forgejo outlives one:
# without this a restarted floci reads as a note with no groups.
example_applied() {
  local env
  [ -z "${SMOKE_AWS:-}" ] || return 0
  for env in dev prod staging; do
    curl -fsS -o /dev/null "$FLOCI/shop-terraform-state/envs/$env/platform.tfstate" 2>/dev/null \
      || { log "floci holds no state for envs/$env/platform (floci restarted since the example was applied?); run 'just example up --fresh' first"; return 1; }
  done
}

claim_note/grouped() {
  # A pull request on the example with module-bump, which reaches the twelve
  # service roots. Its plan job must post one plan note whose first line names
  # those twelve roots, and whose groups name every one of them, in fewer
  # groups than roots. BREAK: the pushed pipeline plans dev's roots alone, so
  # the note leaves out the staging and prod services.
  log() { echo "[smoke grouped] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" branch=smoke/grouped work sha pr rc=0 deadline state notes body roots want root groups
  example_applied || return 1
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
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" --profile observability up -d >&2 || return 1
  for i in $(seq 1 30); do
    answers 2>/dev/null && return 0
    sleep 2
  done
  echo "the collector or Prometheus did not answer after 60s" >&2
  return 1
}

# otel_trace SPAN COMMIT FILE -> prints the trace id of the SPAN span whose
# vcs.ref.head.revision is COMMIT, and leaves the collector's traces in FILE.
# The file exporter writes on its own schedule, and later under load, so it
# polls for up to OTEL_TRACE_WAIT seconds (default 60); empty when none comes.
otel_trace() {
  local span="$1" commit="$2" out="$3" t="" i
  for i in $(seq 1 "${OTEL_TRACE_WAIT:-60}"); do
    docker cp "${TG_PROJECT:-terragucci}-otel-collector":/out/traces.jsonl - 2>/dev/null | tar -xO > "$out" || true
    t="$(jq -rs --arg s "$span" --arg c "$commit" '[.[].resourceSpans[].scopeSpans[].spans[]
      | select(.name == $s and any(.attributes[]; .key == "vcs.ref.head.revision" and .value.stringValue == $c))][0].traceId // empty' "$out" 2>/dev/null)"
    [ -n "$t" ] && break
    sleep 1
  done
  echo "$t"
}

claim_telemetry/traces() {
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
  trace="$(otel_trace "terragucci tf-plan" "$commit" "$work/traces.jsonl")"
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

claim_telemetry/metrics() {
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

claim_report/highlight() {
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

claim_drift/tofu() {
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
  # Under choudoufu the example's roots are under live resource markers: each
  # plans in full, since choudoufu refuses a refresh-only plan there, and the
  # queue the plan would create again is the one reported gone.
  log() { echo "[smoke drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir issues n body root="envs/staging/orders" queue="$EX_SHOP-staging-orders-jobs"
  [ -z "${SMOKE_AWS:-}" ] || queue="$SMOKE_AWS_PREFIX-$queue"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  open_issues() { api "$URL/api/v1/repos/$USER/$EX_REPO/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  drift_run() { # dir -> the run's report in $1/terragucci-report; the stage keeps the issue
    mkdir -p "$1"
    local REPORT_STAGE=tf-drift
    local -a REPORT_ARGS=(--forge forgejo --report-url "http://forgejo:3000/$USER/$EX_REPO/actions")
    local -a REPORT_EXTRA=(-e "GITHUB_REPOSITORY=$USER/$EX_REPO" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN")
    if [ -n "${REPORT_TREE:-}" ]; then report_run "$1"; else report_run "$1" one-root; fi
  }
  # Start with no drift issue open, so the claim reads only this run's.
  for n in $(open_issues | jq -r '.[].number'); do
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$USER/$EX_REPO/issues/$n"
  done
  local deleted=""
  if [ -z "${BREAK:-}" ]; then
    if [ -n "${SMOKE_AWS:-}" ]; then
      smoke_aws_delete_queue "$queue" || { drop_work "$work"; return 1; }
    elif [ "$SMOKE_BINARY" != tofu ]; then
      # drift.sh deletes the example's own queue; this is its copy's.
      local url
      url="$(floci_json AmazonSQS.GetQueueUrl "$(jq -cn --arg q "$queue" '{QueueName: $q}')" | jq -r '.QueueUrl // empty')" || url=""
      [ -n "$url" ] || { log "$queue is not in floci; boot the example for $SMOKE_BINARY first"; drop_work "$work"; return 1; }
      floci_json AmazonSQS.DeleteQueue "$(jq -cn --arg u "$url" '{QueueUrl: $u}')" >/dev/null || { drop_work "$work"; return 1; }
      log "deleted $queue from floci, outside $SMOKE_BINARY"
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
    bin_ran "$dir/report.json" || rc=1
    # Exactly one object is gone, and it is this queue in this root.
    [ "$(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$dir/report.json")" = "$root module.service.aws_sqs_queue.jobs" ] \
      || { log "the deletes are not exactly $root's queue: $(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$dir/report.json")"; rc=1; }
    # Everything else that drifted is a tag or object metadata. Anything more would be a real
    # difference, such as dev orders' retention change that is only on main. Under choudoufu
    # each live root plans in full, which cannot tell that change from one made outside it,
    # so it is the one other attribute reported.
    local others="" got
    [ "$SMOKE_BINARY" != choudoufu ] || others="envs/dev/orders message_retention_seconds"
    got="$(jq -r '[.roots[] | .path as $p | .changes[] | select(.action != "delete") | .attributes[].path | select(IN("tags", "tags_all", "metadata") | not) | "\($p) \(.)"] | unique | join(",")' "$dir/report.json")"
    [ "$got" = "$others" ] || { log "attributes other than tags and metadata drifted: ${got:-none}, not ${others:-none}"; rc=1; }
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
  log "$root and $queue named in the report and one issue, the only delete; a run with none closed the issue"
}

claim_tips/tofu() {
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

# The cosign release the publish job installs for modules.attest (COSIGN_VERSION in packages/terragucci/src/install.ts).
COSIGN_VERSION="$(sed -n 's/^export const COSIGN_VERSION = "\(.*\)";$/\1/p' "$HERE/../packages/terragucci/src/install.ts")"

# The TLS registry the publish claims push to, on a certificate made for this
# run. It bind-mounts its certificates and outlives the claim. They live in a
# directory no run removes and are rewritten in place (same inode), so Docker
# Desktop's VM never holds a deleted file open. The claims that call it hold
# the registry lock, since a recreate drops what another run pushed.
registry_up() { # work, port
  local work="$1" port="$2" certs="$HERE/.state/registry-certs" i
  mkdir -p "$certs" "$work/newcerts"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:registry,IP:127.0.0.1" \
    -keyout "$work/newcerts/registry.key" -out "$work/newcerts/registry.crt" >/dev/null 2>&1 \
    || { echo "openssl could not make a certificate" >&2; return 1; }
  cat "$work/newcerts/registry.key" > "$certs/registry.key"
  cat "$work/newcerts/registry.crt" > "$certs/registry.crt"
  chmod 644 "$certs/registry.key"
  with_lock compose env TERRAGUCCI_REGISTRY_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" \
    --profile registry up -d --force-recreate registry >&2 || return 1
  for i in $(seq 1 30); do
    curl -fsS --cacert "$certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

claim_modules/publish() {
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
  local certs="$HERE/.state/registry-certs"
  mkdir -p "$work/tree/modules/service" "$work/tree/modules/queue" "$work/tree/envs/dev"
  registry_up "$work" "$port" || { log "the registry did not come up"; drop_work "$work"; return 1; }
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

claim_modules/attest() {
  # modules.attest on a Forgejo repo: the pipeline's publish job signs
  # modules/service with the repo's cosign key, attests its provenance and
  # SBOM, and records the release on chant/lifecycle with the tag, on a TLS
  # registry and as a git tag. verify-release, in the CI image, then verifies
  # both targets from a fresh clone, the ledger holds one record per target
  # whose digest is the one verified, and cosign verifies the signature
  # attached to the OCI manifest with the committed public key. BREAK: the git
  # tag is replaced by one pushed by hand on a changed commit, so no ledger
  # record matches it, and verify-release must refuse it.
  log() { echo "[smoke publish-attest] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work port="${TERRAGUCCI_REGISTRY_PORT:-5050}" name="attest-$(date +%s)" sha out rc=0 t image digest records
  local repo="$USER/$name"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just images' first"; drop_work "$work"; return 1; }
  local certs="$HERE/.state/registry-certs" tree="$work/tree"
  mkdir -p "$tree/modules/service" "$tree/envs/dev" "$work/keys"
  registry_up "$work" "$port" || { log "the registry did not come up"; drop_work "$work"; return 1; }
  # The key pair, made by the cosign the publish job installs; the private half goes to the repo's secrets only.
  in_image "$work/keys" sh -c "export PATH=\"\$(terragucci install cosign $COSIGN_VERSION):\$PATH\" && COSIGN_PASSWORD=smoke-attest cosign generate-key-pair && chmod 644 cosign.key" >/dev/null 2>&1 \
    && [ -s "$work/keys/cosign.key" ] && [ -s "$work/keys/cosign.pub" ] || { log "cosign $COSIGN_VERSION could not make a key pair"; drop_work "$work"; return 1; }
  fresh_repo "$name" || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  secret() { jq -n --arg d "$2" '{data: $d}' | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/$1" || { log "could not set the $1 secret"; return 1; }; }
  for t in TERRAGUCCI_REGISTRY_USER TERRAGUCCI_REGISTRY_PASSWORD; do secret "$t" smoke || { drop_work "$work"; return 1; }; done
  secret COSIGN_PRIVATE_KEY "$(cat "$work/keys/cosign.key")" && secret COSIGN_PASSWORD smoke-attest || { drop_work "$work"; return 1; }
  cp "$certs/registry.crt" "$tree/registry.crt"
  cp "$work/keys/cosign.pub" "$tree/cosign.pub"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  printf 'terraform {\n  required_providers {\n    random = { source = "hashicorp/random", version = "~> 3.6" }\n  }\n}\n\nresource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/dev.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "dev" {}\n' "$name" > "$tree/envs/dev/main.tf"
  printf 'binary: tofu\nforge: forgejo\nenv:\n  NODE_EXTRA_CA_CERTS: registry.crt\nmodules:\n  path: modules/*\n  publish:\n    - oci://registry:5000/%s\n    - git-tags\n  attest: true\n' "$repo" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  grep -q "secrets.COSIGN_PRIVATE_KEY" "$tree/.forgejo/workflows/terragucci.yml" || { log "init gave the publish job no signing key"; drop_work "$work"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "feat: service")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the run ended $RUN_STATUS"; drop_work "$work"; return 1; }
  local remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  git ls-remote --exit-code "$remote" refs/tags/modules/service/v0.1.0 refs/heads/chant/lifecycle >/dev/null \
    || { print_logs "$repo" "$RUN_ID" >&2; log "the run left no release tag or no chant/lifecycle"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # A tag pushed by hand in place of the release: no attested publish wrote it, so the ledger has no record of it.
    git clone -q "$remote" "$work/hand" && printf 'output "id" { value = terraform_data.service.id }\n' > "$work/hand/modules/service/outputs.tf" \
      && git -C "$work/hand" add -A && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand -c commit.gpgsign=false commit -q -m "fix: by hand" \
      && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand tag -f -a modules/service/v0.1.0 -m "by hand" >/dev/null \
      && git -C "$work/hand" push -q -f "$remote" refs/tags/modules/service/v0.1.0 \
      || { log "could not push the hand-made tag"; drop_work "$work"; return 1; }
  fi
  # A fresh clone in the CI image, on the stack network, as a root's job would see the release.
  out="$(in_image "$work" sh -c "git clone -q http://$USER:$TOKEN@forgejo:3000/$repo.git c && cd c && TERRAGUCCI_REGISTRY_USER=smoke TERRAGUCCI_REGISTRY_PASSWORD=smoke NODE_EXTRA_CA_CERTS=registry.crt terragucci verify-release modules/service 0.1.0" 2>&1)" || rc=$?
  echo "${out//$TOKEN/***}" >&2
  [ "$rc" = 0 ] || { log "verify-release refused the release (exit $rc)"; drop_work "$work"; return 1; }
  grep -q "^modules/service/v0.1.0: verified (ledger, signature, provenance, sbom)" <<<"$out" \
    && grep -q "^registry:5000/$repo/service:0.1.0: verified (ledger, signature, provenance, sbom)" <<<"$out" \
    || { log "verify-release did not verify both targets"; drop_work "$work"; return 1; }
  digest="$(grep "^registry:5000/" <<<"$out" | grep -o 'sha256:[0-9a-f]\{64\}' | head -1)"
  records="$(in_image "$work" sh -c "cd c && git fetch -q origin chant/lifecycle && git show FETCH_HEAD:modules/releases.jsonl" 2>/dev/null)"
  [ "$(jq -s --arg d "$digest" '[.[] | select(.component == "modules/service" and .env == "modules")] | length' <<<"$records")" = 2 ] \
    && [ "$(jq -s --arg d "$digest" '[.[] | select(.digest == $d)] | length' <<<"$records")" = 1 ] \
    || { echo "$records" >&2; log "the ledger does not hold one record per target with the verified digest"; drop_work "$work"; return 1; }
  in_image "$work" sh -c "cd c && export PATH=\"\$(terragucci install cosign $COSIGN_VERSION):\$PATH\" && cosign verify --key cosign.pub --insecure-ignore-tlog --registry-cacert registry.crt registry:5000/$repo/service@$digest" >/dev/null 2>&1 \
    || { log "cosign did not verify the signature attached to registry:5000/$repo/service@$digest"; drop_work "$work"; return 1; }
  log "the publish job signed, attested and recorded modules/service 0.1.0 on both targets, and verify-release and cosign verified it from a fresh clone"
  drop_work "$work"
}

# modules.require: attested on a Forgejo repo that publishes modules/service
# attested: the pipeline publishes 0.1.0, then tf-plan runs in the CI image on
# a clone whose envs/dev pins a release of it. $1 is what BREAK does to the
# pin: tampered moves the 0.1.0 tag to a changed commit; unrecorded pins
# 0.1.1, a tag pushed by hand. Either way no ledger record matches, and tf-plan
# must refuse the root before init, naming it, the call and the version.
require_claim() { # claim name, tampered|unrecorded
  local claim="$1" break_as="$2"
  log() { echo "[smoke $claim] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work name="$claim-$(date +%s)" sha out rc=0 image version=0.1.0
  local repo="$USER/$name"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just images' first"; drop_work "$work"; return 1; }
  local tree="$work/tree"
  mkdir -p "$tree/modules/service" "$tree/envs/dev" "$work/keys"
  in_image "$work/keys" sh -c "export PATH=\"\$(terragucci install cosign $COSIGN_VERSION):\$PATH\" && COSIGN_PASSWORD=smoke-require cosign generate-key-pair && chmod 644 cosign.key" >/dev/null 2>&1 \
    && [ -s "$work/keys/cosign.key" ] || { log "cosign $COSIGN_VERSION could not make a key pair"; drop_work "$work"; return 1; }
  fresh_repo "$name" || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for t in COSIGN_PRIVATE_KEY COSIGN_PASSWORD; do
    jq -n --arg d "$( [ "$t" = COSIGN_PASSWORD ] && echo smoke-require || cat "$work/keys/cosign.key")" '{data: $d}' \
      | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/$t" || { log "could not set the $t secret"; drop_work "$work"; return 1; }
  done
  cp "$work/keys/cosign.pub" "$tree/cosign.pub"
  printf 'resource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'resource "terraform_data" "dev" {}\n' > "$tree/envs/dev/main.tf"
  printf 'binary: tofu\nforge: forgejo\nroots: ["envs/*"]\nmodules:\n  path: modules/*\n  publish: git-tags\n  attest: true\n  require: attested\n' > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "feat: service")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the run ended $RUN_STATUS"; drop_work "$work"; return 1; }
  local remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  git ls-remote --exit-code "$remote" refs/tags/modules/service/v0.1.0 refs/heads/chant/lifecycle >/dev/null \
    || { print_logs "$repo" "$RUN_ID" >&2; log "the run published no attested 0.1.0"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # A tag no attested publish wrote: moved over 0.1.0, or a new 0.1.1.
    [ "$break_as" = unrecorded ] && version=0.1.1
    git clone -q "$remote" "$work/hand" && printf 'output "id" { value = terraform_data.service.id }\n' > "$work/hand/modules/service/outputs.tf" \
      && git -C "$work/hand" add -A && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand -c commit.gpgsign=false commit -q -m "fix: by hand" \
      && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand tag -f -a "modules/service/v$version" -m "by hand" >/dev/null \
      && git -C "$work/hand" push -q -f "$remote" "refs/tags/modules/service/v$version" \
      || { log "could not push the hand-made tag"; drop_work "$work"; return 1; }
  fi
  # The root that pins the release, planned in the CI image from a fresh clone, as a pull request's plan job would.
  out="$(in_image "$work" sh -c "git clone -q http://$USER:$TOKEN@forgejo:3000/$repo.git c && cd c \
    && printf 'module \"service\" {\n  source = \"git::http://forgejo:3000/$repo.git//modules/service?ref=modules/service/v$version\"\n}\n' > envs/dev/pin.tf \
    && terragucci stage tf-plan --root envs/dev --out /tmp/report" 2>&1)" || rc=$?
  echo "${out//$TOKEN/***}" >&2
  [ "$rc" = 0 ] || { log "tf-plan refused envs/dev pinning modules/service $version (exit $rc)"; drop_work "$work"; return 1; }
  grep -q "^envs/dev: attested module.service git::http://forgejo:3000/$repo.git//modules/service modules/service/v$version" <<<"$out" \
    || { log "tf-plan did not say it verified the pin"; drop_work "$work"; return 1; }
  log "tf-plan verified envs/dev's pin of modules/service $version against the ledger and the key, and planned it"
  drop_work "$work"
}

claim_modules/require() { require_claim require-attested tampered; }
claim_modules/recorded() { require_claim require-recorded unrecorded; }

claim_modules/registry() {
  # modules.registry with modules.test, the CLI in the CI image: two releases
  # of modules/network, 1.0.0 and 1.1.0, each tested with tofu test first, are
  # written to a floci bucket as the module registry protocol's files. A TLS
  # server in front of the bucket serves it as the registry host
  # 127.0.0.1:8443, and a root whose call pins version "~> 1.0" resolves 1.1.0
  # with tofu init. BREAK: the second release has no tests, so modules.test
  # refuses it, publish fails, and the registry still lists 1.0.0 alone.
  log() { echo "[smoke module-registry] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work tree out rc=0 bucket="tg-registry-$(date +%s)$$${BREAK:+b}" versions
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  mkdir -p "$tree/modules/network/tests" "$tree/envs/dev"
  # tofu reaches a registry host only over https: a certificate for localhost, made for this run.
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout "$work/tls.key" -out "$work/tls.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "floci made no bucket $bucket"; drop_work "$work"; return 1; }
  # The bucket served as a static site over TLS: each GET is the object at that key.
  cat > "$work/serve.mjs" <<'JS'
import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";
const [bucket, port] = process.argv.slice(2);
https.createServer({ key: readFileSync("/repo/tls.key"), cert: readFileSync("/repo/tls.crt") }, (req, res) => {
  const path = req.url.split("?")[0];
  http.get(`http://floci:4566/${bucket}${path}`, (up) => {
    console.error(`serve: GET ${path} ${up.statusCode}`);
    res.writeHead(up.statusCode, { "content-type": up.headers["content-type"] ?? "application/octet-stream" });
    up.pipe(res);
  }).on("error", (e) => { res.writeHead(502); res.end(String(e)); });
}).listen(Number(port), "127.0.0.1", () => console.error(`serve: https://127.0.0.1:${port} -> ${bucket}`));
JS
  printf 'variable "name" {\n  type = string\n}\n\nresource "terraform_data" "net" {\n  input = var.name\n}\n\noutput "name" {\n  value = terraform_data.net.input\n}\n' > "$tree/modules/network/main.tf"
  printf 'variables {\n  name = "dev"\n}\n\nrun "names" {\n  command = plan\n\n  assert {\n    condition     = terraform_data.net.input == "dev"\n    error_message = "the name is not passed through"\n  }\n}\n' > "$tree/modules/network/tests/main.tftest.hcl"
  echo 1.0.0 > "$tree/modules/network/version"
  printf 'module "network" {\n  source  = "127.0.0.1:8443/acme/network/generic"\n  version = "~> 1.0"\n  name    = "dev"\n}\n' > "$tree/envs/dev/main.tf"
  printf 'binary: tofu\nroots: ["envs/*"]\nmodules:\n  path: modules/*\n  test: true\n  registry:\n    bucket: s3://%s\n    url: https://127.0.0.1:8443\n    namespace: acme\n' "$bucket" > "$tree/terragucci.yml"
  git -C "$tree" init -q -b main
  commitall() { git -C "$tree" add -A && git -C "$tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -q -m "$1"; }
  commitall "feat: network"
  publish_run() { in_image "$work" sh -c 'cd tree && terragucci publish' 2>&1; }
  out="$(publish_run)" || { echo "$out" >&2; log "the first publish failed"; drop_work "$work"; return 1; }
  echo "$out" >&2
  grep -q "network 1.0.0: published to registry https://127.0.0.1:8443" <<<"$out" || { log "1.0.0 was not published"; drop_work "$work"; return 1; }
  printf 'output "id" {\n  value = terraform_data.net.id\n}\n' > "$tree/modules/network/outputs.tf"
  echo 1.1.0 > "$tree/modules/network/version"
  # BREAK: the tests leave the module, so the release is untested.
  [ -n "${BREAK:-}" ] && mv "$tree/modules/network/tests" "$work/tests.moved"
  commitall "feat(network): an id output"
  out="$(publish_run)" || rc=$?
  echo "$out" >&2
  versions="$(curl -fsS "$FLOCI/$bucket/v1/modules/acme/network/generic/versions" | jq -r '[.modules[0].versions[].version] | join(",")')" || versions=""
  if [ "$rc" != 0 ]; then
    grep -q "network 1.1.0: refused" <<<"$out" && log "modules.test refused 1.1.0: $(grep -m1 -o 'has no tests[^,]*' <<<"$out" || true); the registry lists '$versions'"
    log "the second publish failed"; drop_work "$work"; return 1
  fi
  grep -q "network 1.1.0: published to registry https://127.0.0.1:8443" <<<"$out" || { log "1.1.0 was not published"; drop_work "$work"; return 1; }
  [ "$versions" = "1.0.0,1.1.0" ] || { log "the versions endpoint lists '$versions', not 1.0.0,1.1.0"; drop_work "$work"; return 1; }
  curl -fsS "$FLOCI/$bucket/.well-known/terraform.json" | jq -e '."modules.v1" == "/v1/modules/"' >/dev/null || { log "no service discovery file"; drop_work "$work"; return 1; }
  # tofu, in the CI image, resolves "~> 1.0" against the registry and installs the newest 1.x.
  out="$(in_image "$work" sh -c "node /repo/serve.mjs $bucket 8443 & sleep 1; cd tree/envs/dev && SSL_CERT_FILE=/repo/tls.crt tofu init -backend=false -input=false -no-color && cat .terraform/modules/modules.json" 2>&1)" \
    || { echo "$out" >&2; log "tofu init could not resolve the module from the registry"; drop_work "$work"; return 1; }
  echo "$out" >&2
  grep -q "Downloading 127.0.0.1:8443/acme/network/generic 1.1.0 for network" <<<"$out" || { log "tofu init did not download 1.1.0"; drop_work "$work"; return 1; }
  grep -q '"Version":"1.1.0"' <<<"$out" || { log "modules.json does not record 1.1.0"; drop_work "$work"; return 1; }
  drop_work "$work"
  log "both releases passed tofu test and reached the bucket; tofu resolved ~> 1.0 to 1.1.0 from the registry it serves"
}

claim_modules/terragrunt_require() {
  # modules.require: attested in a Terragrunt repo whose pipeline publishes
  # modules/service 0.1.0 attested. A branch whose unit live/dev pins 0.1.1,
  # a tag pushed by hand, must fail its tf-check job with the unit, its
  # terraform source and the version named, and tf-plan, in the Terragrunt CI
  # image, must refuse the unit without planning it. Pinned to 0.1.0, both pass.
  # BREAK: the pipeline's check job skips terragucci check-pins, as it did
  # before, so the branch's tf-check goes green.
  local claim=tg-require-attested
  log() { echo "[smoke $claim] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work name="$claim-$(date +%s)" sha out logs rc=0 image tgimage
  local repo="$USER/$name"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  image="$(image_tag tofu)"; tgimage="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 && docker image inspect "$tgimage" >/dev/null 2>&1 \
    || { log "no CI image $image or $tgimage; run 'just images' first"; drop_work "$work"; return 1; }
  local tree="$work/tree"
  mkdir -p "$tree/modules/service" "$tree/live/dev" "$work/keys"
  in_image "$work/keys" sh -c "export PATH=\"\$(terragucci install cosign $COSIGN_VERSION):\$PATH\" && COSIGN_PASSWORD=smoke-require cosign generate-key-pair && chmod 644 cosign.key" >/dev/null 2>&1 \
    && [ -s "$work/keys/cosign.key" ] || { log "cosign $COSIGN_VERSION could not make a key pair"; drop_work "$work"; return 1; }
  fresh_repo "$name" || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for t in COSIGN_PRIVATE_KEY COSIGN_PASSWORD; do
    jq -n --arg d "$( [ "$t" = COSIGN_PASSWORD ] && echo smoke-require || cat "$work/keys/cosign.key")" '{data: $d}' \
      | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/$t" || { log "could not set the $t secret"; drop_work "$work"; return 1; }
  done
  cp "$work/keys/cosign.pub" "$tree/cosign.pub"
  : > "$tree/root.hcl"
  printf 'resource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'resource "terraform_data" "dev" {}\n' > "$tree/live/dev/main.tf"
  unit() { # the terraform block, or nothing
    printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n%b' "$1" > "$tree/live/dev/terragrunt.hcl"
  }
  unit ""
  printf 'binary: tofu\nforge: forgejo\nmodules:\n  path: modules/*\n  publish: git-tags\n  attest: true\n  require: attested\n' > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { drop_work "$work"; return 1; }
  local pipeline="$tree/.forgejo/workflows/terragucci.yml"
  grep -q '^ *terragucci check-pins$' "$pipeline" || { log "init gave the Terragrunt check job no check-pins step"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && perl -ni -e 'print unless /^ *terragucci check-pins$/' "$pipeline"
  sha="$(push_tree "$tree" "$repo" main "feat: service")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the first run ended $RUN_STATUS"; drop_work "$work"; return 1; }
  local remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  git ls-remote --exit-code "$remote" refs/tags/modules/service/v0.1.0 refs/heads/chant/lifecycle >/dev/null \
    || { print_logs "$repo" "$RUN_ID" >&2; log "the run published no attested 0.1.0"; drop_work "$work"; return 1; }
  # 0.1.1, a tag no attested publish wrote.
  git clone -q "$remote" "$work/hand" && printf 'output "id" { value = terraform_data.service.id }\n' > "$work/hand/modules/service/outputs.tf" \
    && git -C "$work/hand" add -A && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand -c commit.gpgsign=false commit -q -m "fix: by hand" \
    && git -C "$work/hand" -c user.email=hand@smoke -c user.name=hand tag -a modules/service/v0.1.1 -m "by hand" >/dev/null \
    && git -C "$work/hand" push -q "$remote" refs/tags/modules/service/v0.1.1 \
    || { log "could not push the hand-made tag"; drop_work "$work"; return 1; }
  local source="git::http://forgejo:3000/$repo.git//modules/service"
  unit "\nterraform {\n  source = \"$source?ref=modules/service/v0.1.1\"\n}\n"
  sha="$(push_tree "$tree" "$repo" smoke/pin "pin modules/service 0.1.1")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  logs="$(print_logs "$repo" "$RUN_ID" 2>&1)"
  [ "$RUN_STATUS" = failure ] || { echo "$logs" >&2; log "tf-check on the branch pinning 0.1.1 ended '$RUN_STATUS'"; drop_work "$work"; return 1; }
  grep -q "refused: live/dev: terraform (live/dev/terragrunt.hcl) pins $source at modules/service/v0.1.1, which modules.require: attested refuses" <<<"$logs" \
    && grep -q "FAILED live/dev: modules.require: attested refused 1 module pin" <<<"$logs" \
    || { echo "$logs" >&2; log "tf-check failed but did not name live/dev's pin of 0.1.1"; drop_work "$work"; return 1; }
  # tf-plan on the branch, in the Terragrunt CI image, as a pull request's plan job runs it; then the same unit pinned to 0.1.0.
  out="$(IN_IMAGE="$tgimage" in_image "$work" sh -c "git clone -q -b smoke/pin http://$USER:$TOKEN@forgejo:3000/$repo.git c && cd c \
    && { terragucci stage tf-plan --terragrunt --root live/dev --out /tmp/refused; echo \"refused-exit=\$?\"; } \
    && sed -i 's#v0.1.1#v0.1.0#' live/dev/terragrunt.hcl \
    && { terragucci check-pins; echo \"check-exit=\$?\"; } \
    && { terragucci stage tf-plan --terragrunt --root live/dev --out /tmp/attested; echo \"plan-exit=\$?\"; }" 2>&1)" || rc=$?
  echo "${out//$TOKEN/***}" >&2
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fpin" || true
  [ "$rc" = 0 ] || { log "the tf-plan run in the Terragrunt image did not finish (exit $rc)"; drop_work "$work"; return 1; }
  grep -q "^refused-exit=0" <<<"$out" && { log "tf-plan passed live/dev pinning 0.1.1"; drop_work "$work"; return 1; }
  grep -q "^live/dev: refused by modules.require: attested" <<<"$out" \
    || { log "tf-plan did not refuse live/dev by modules.require"; drop_work "$work"; return 1; }
  grep -q "^check-exit=0" <<<"$out" && grep -q "^attested live/dev: terraform $source modules/service/v0.1.0" <<<"$out" \
    || { log "tf-check's check-pins did not pass live/dev pinning the attested 0.1.0"; drop_work "$work"; return 1; }
  grep -q "^plan-exit=0" <<<"$out" && grep -q "^live/dev: attested terraform $source modules/service/v0.1.0" <<<"$out" \
    || { log "tf-plan did not verify and plan live/dev pinning the attested 0.1.0"; drop_work "$work"; return 1; }
  log "tf-check and tf-plan refused live/dev pinning the hand-made 0.1.1, named its terraform source, and passed it pinning the attested 0.1.0"
  drop_work "$work"
}

claim_rollout/tofu() {
  # One repo, three roots taking modules/network by git tag: dev/app (the
  # canary), prod/net, and prod/app, which reads prod/net's state, with
  # rollouts set and token_env naming a repo secret that holds the admin's
  # token, so init writes the rollout workflow beside the pipeline (its cron
  # is a day a year, so only the dispatch runs it). The module changes and
  # tf-publish tags 0.2.0. A dry run with no version must find 0.2.0. Then
  # each wave's pull request changes only that wave's root, and no wave opens
  # before the last one merged and its apply passed on the merge commit:
  # wave 1 is opened by hand, wave 2 by one run of the rollout job with no
  # rollout run by hand, and wave 3 by hand; after three waves the rollout is
  # complete.
  # BREAK breaks two properties on the one repo, each in turn, and is caught
  # only when both are: the first run that opens wave 1 is a dry run, so no
  # pull request opens (wave 1 is then opened in apply mode to go on); and
  # respond.rollout: off, so init writes no rollout workflow and the dispatch
  # opens no wave 2, checked once, right after the dispatch, never by waiting.
  log() { echo "[smoke rollout] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout" out rc pr sha n files run status deadline caught=""
  local wf=".forgejo/workflows/terragucci-rollout.yml" b="terragucci/rollout/modules-network-0.2.0/wave"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # A step that fails ends the plain run as a failure; it ends a BREAK run as
  # not caught, since that run never reached the breaks it had left.
  stop() { drop_work "$work"; [ -z "${BREAK:-}" ] && return 1; log "the BREAK run stopped before its breaks were checked (caught so far: ${caught:-none})"; return 0; }
  rollout_repo rollout || { stop; return; }
  api -o /dev/null -H 'content-type: application/json' -X PUT -d "{\"data\":\"$TOKEN\"}" "$URL/api/v1/repos/$repo/actions/secrets/TERRAGUCCI_FORGEJO_TOKEN" \
    || { log "could not set the TERRAGUCCI_FORGEJO_TOKEN secret"; stop; return; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true

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
  printf 'binary: tofu\nforge: forgejo\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\nwaves:\n  canary: ["dev/*"]\nmodules:\n  path: modules/*\n  publish: git-tags\nrollouts: "0 0 1 1 *"\n' > "$tree/terragucci.yml"
  [ -n "${BREAK:-}" ] && printf 'respond:\n  rollout: "off"\n' >> "$tree/terragucci.yml"
  out="$(cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu 2>&1)" || { echo "$out" >&2; stop; return; }
  if [ -f "$tree/$wf" ]; then log "init wrote $wf"; else log "init wrote no $wf"; fi
  # The tag goes up with main, so this push is git's own, not push_tree's: the
  # pipeline is pointed at this tree's images here, or the release's image
  # runs a pipeline this tree wrote.
  local_images "$tree" || { stop; return; }
  ( cd "$tree" && git init -q -b main && git remote add origin "$remote" && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat: three roots on modules/network 0.1.0" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m "modules/network 0.1.0" \
    && git push -q origin refs/tags/modules/network/v0.1.0 main ) 2>/dev/null || { log "could not push the repo"; stop; return; }
  sha="$(git -C "$tree" rev-parse HEAD)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the first apply ended $RUN_STATUS"; stop; return; }

  # A new module version, published by tf-publish as a git tag.
  printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> "$tree/modules/network/main.tf"
  ( cd "$tree" && git add -A && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat(network): a version output" \
    && git push -q origin main ) 2>/dev/null || { stop; return; }
  wait_run "$repo" "$(git -C "$tree" rev-parse HEAD)"
  (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" publish) >&2 || { stop; return; }

  ro() { (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout modules/network "$@" 2>&1); }
  out="$(ro)" || { echo "$out" >&2; stop; return; }
  echo "$out" >&2
  grep -q "modules/network 0.1.0 -> 0.2.0 (newest published: tag modules/network/v0.2.0): would-open" <<<"$out" \
    || { log "the dry run did not find 0.2.0 on its own"; stop; return; }

  pr_for() { branch_pr "$repo" "$b-$1"; }
  # The rollout job, once, as its schedule runs it.
  rollout_job() {
    dispatched() { api "$URL/api/v1/repos/$repo/actions/runs?event=workflow_dispatch&limit=50" | jq -c '.workflow_runs // []'; }
    if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
        "$URL/api/v1/repos/$repo/actions/workflows/terragucci-rollout.yml/dispatches" 2>/dev/null)"; then
      run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
      deadline=$(( $(date +%s) + TIMEOUT )); status=""
      while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(dispatched | jq -r --arg r "${run:-0}" '[.[] | select($r == "0" or .id == ($r | tonumber))] | (.[0].status // "")')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
        sleep 3
      done
      log "the rollout job ended '${status:-unknown}'"
      [ "$status" = success ] || { [ -n "$run" ] && print_logs "$repo" "$run" >&2; }
    else
      log "Forgejo has no rollout workflow to run in $repo"
    fi
  }
  local wave expect=("" "dev/app/main.tf" "prod/net/main.tf" "prod/app/main.tf")
  for wave in 1 2 3; do
    case $wave in
      1)
        if [ -n "${BREAK:-}" ]; then
          out="$(ro --mode dry-run)"; echo "$out" >&2
          if [ -z "$(pr_for 1)" ]; then caught="dry-run"; log "caught: the dry run opened no pull request for wave 1"
          else log "missed: the dry run opened wave 1's pull request"; drop_work "$work"; return 0; fi
        fi
        out="$(ro --mode apply)"; echo "$out" >&2 ;;
      2)
        rollout_job
        if [ -n "${BREAK:-}" ]; then
          drop_work "$work"
          [ -z "$(pr_for 2)" ] || { log "missed: wave 2 opened with respond.rollout off"; return 0; }
          log "caught: with respond.rollout off the dispatch opened no wave 2; caught $caught and rollout-job"
          return 1
        fi ;;
      3)
        out="$(ro --mode apply)"; echo "$out" >&2 ;;
    esac
    pr="$(pr_for "$wave")"
    [ -n "$pr" ] || { log "wave $wave: no pull request opened"; stop; return; }
    files="$(pr_files "$repo" "$pr")"
    [ "$files" = "${expect[$wave]}" ] || { log "wave $wave's pull request changes '$files', not ${expect[$wave]}"; stop; return; }
    # Open: the next run waits and opens nothing.
    out="$(ro --mode apply)"; rc=$?
    [ $rc = 3 ] && [ -z "$(pr_for $((wave + 1)))" ] || { echo "$out" >&2; log "wave $wave open: exit $rc, or the next wave opened"; stop; return; }
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
    sha="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merge_commit_sha)"
    # Merged, apply not yet reported: still nothing opens. Not after wave 1,
    # whose next wave only the rollout job may open.
    if [ $wave != 1 ]; then
      out="$(ro --mode apply)"
      if [ -n "$(pr_for $((wave + 1)))" ]; then
        n="$(api "$URL/api/v1/repos/$repo/commits/$sha/statuses" | jq -r '[.[] | select(.context | test("/ apply"))] | max_by(.id) | .status // "none"')"
        [ "$n" = success ] || { echo "$out" >&2; log "wave $((wave + 1)) opened while wave $wave's apply was '$n'"; stop; return; }
      fi
    fi
    wait_run "$repo" "$sha" push
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "wave $wave's apply ended $RUN_STATUS"; stop; return; }
    # Wave 2 is the rollout job's to open, so it is not open before the job runs.
    if [ $wave = 1 ] && [ -n "$(pr_for 2)" ]; then log "wave 2 opened before the rollout job ran"; stop; return; fi
  done
  out="$(ro --mode apply)"; rc=$?
  echo "$out" >&2
  drop_work "$work"
  [ $rc = 0 ] && grep -q ": complete" <<<"$out" || { log "after three waves the rollout is not complete (exit $rc)"; return 1; }
  log "0.2.0 found from its tag; three waves, one pull request each moving only its root, each opened only after the last applied, wave 2 by one run of the rollout job"
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
in_image() { # dir, command...; IN_IMAGE names another CI image
  local dir="$1" image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"; shift
  image="${IN_IMAGE:-$(image_tag tofu)}"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  [ -f "$bundle" ] || build_cli || return 1
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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

claim_respond/refused() {
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

claim_respond/triage() {
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

claim_respond/drift() {
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

claim_respond/tips() {
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

claim_respond/fmt() {
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

claim_respond/notes() {
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
# TG_BASE_CONFIG is appended to terragucci.yml before the base commit, so the
# base holds it. TG_BUNDLE runs another terragucci bundle (a BREAK's).
# TG_STAGE names another stage (tf-drift); TG_RUN_EXTRA holds more `docker run`
# arguments and TG_STAGE_ARGS more stage arguments.
TG_RUN_EXTRA=()
TG_STAGE_ARGS=()
tg_report_run() { # work, patches...
  local work="$1"; shift
  local image bundle="${TG_BUNDLE:-$HERE/../packages/terragucci/dist/terragucci.mjs}" p base rc=0
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example-terragrunt up' first" >&2; return 1; }
  build_cli || return 1
  cp -R "$TG_EXAMPLE/." "$work/"
  rm -rf "$work/.git"
  [ -z "${SMOKE_AWS:-}" ] || smoke_aws_overlay_tg "$work" || return 1
  [ -n "${TG_BASE_CONFIG:-}" ] && printf '%s\n' "$TG_BASE_CONFIG" >> "$work/terragucci.yml"
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm base
  base="$(git -C "$work" rev-parse HEAD)"
  for p in "$@"; do git -C "$work" apply "$TG_EXAMPLE/changes/$p.patch" || return 1; done
  [ -n "${REPORT_CONFIG:-}" ] && printf '%s\n' "$REPORT_CONFIG" >> "$work/terragucci.yml"
  [ -n "${TG_EDIT:-}" ] && (cd "$work" && eval "$TG_EDIT")
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke $(date +%s%N)"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo \
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

claim_init/terragrunt() {
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

claim_waves/terragrunt() {
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

claim_check/terragrunt() {
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

claim_affected/terragrunt() {
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

claim_tips/terragrunt_mock() {
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

claim_linked/terragrunt_mock() {
  # new-service adds ledger and billing, which reads ledger's logs_bucket and
  # has a mock for it. Ledger has no state yet, so Terragrunt alone would hand
  # billing the mock. Ledger's plan knows the bucket it makes, so billing plans
  # on that planned output instead: the report says billing read ledger's
  # planned outputs, its plan names shop-tg-dev-ledger and no mock, and no
  # mock read is reported.
  # BREAK: ledger is applied first, so its plan changes no output and billing
  # plans on its applied state; the claim must notice billing did not read
  # ledger's planned outputs.
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
    jq -e '.roots[] | select(.path == "live/dev/billing" and .status == "planned" and .reads == [{upstream: "live/dev/ledger", data: "ledger", outputs: "planned"}])' "$r" >/dev/null \
      || { log "billing did not plan on ledger's planned outputs: $(jq -c '[.roots[] | select(.path == "live/dev/billing") | {status, reads, error}], .deferred' "$r")"; rc=1; }
    jq -e '[.roots[] | select(.path == "live/dev/billing") | .changes[].attributes[]? | (.after // "") | tostring | select(test("shop-tg-dev-ledger"))] | length > 0' "$r" >/dev/null || { log "billing's plan does not name ledger's planned bucket, shop-tg-dev-ledger"; rc=1; }
    grep -q 'mock-ledger-bucket' "$r" && { log "billing's plan names the mock bucket"; rc=1; }
    jq -e '[.mock_reads[]? | select(.unit == "live/dev/billing")] | length == 0' "$r" >/dev/null || { log "the report names a mock read for billing"; rc=1; }
  fi
  if [ -n "${BREAK:-}" ]; then
    TG_TREE="$tree" "$HERE/example-terragrunt.sh" tg run --working-dir live/dev/ledger -- destroy -auto-approve >&2 || true
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/terragrunt/live/dev/ledger/terraform.tfstate" || true
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "ledger planned; billing planned on ledger's planned bucket, shop-tg-dev-ledger, and never on its mock"
  return $rc
}

claim_linked/terragrunt_mock_trap() {
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

claim_linked/fresh() {
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

claim_policy/tofu() {
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

claim_policy/wave() {
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
  image="$(bin_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$HERE/fixtures/policy-wave/." "$work/"
  [ -z "${BREAK:-}" ] && printf 'policy:\n  engine: %s\n  path: %s\n  input: %s\n' "$engine" "$dir" "$input" >> "$work/terragucci.yml"
  bin_tree "$work" "policy-wave-$(date +%s)" || { log "the tree was not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke policy-wave"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary "$SMOKE_BINARY" --gate never >&2 || code=$?
  clean_mounted "$work" "$image"
  r="$work/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "the wave exited $code, not 1: the policy did not refuse it"; rc=1; }
  if [ -f "$work/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$work/app/terraform.tfstate" >/dev/null 2>&1; then
    log "app has state: the wave applied it"; rc=1
  fi
  # choudoufu's local record store: a record of the probe means it applied.
  if [ -n "$(find "$work/app" -path '*/.tofu-records/*terraform_data*' -type f 2>/dev/null | head -1)" ]; then
    log "app has a record of terraform_data.probe: the wave applied it"; rc=1
  fi
  if [ ! -f "$r" ]; then
    log "the wave wrote no report"; rc=1
  else
    bin_ran "$r" || rc=1
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

claim_report/wave() {
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
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

claim_oidc/forgejo() {
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

claim_oidc/audience_stages() {
  # oidc.audience as a map: plan terragucci-plan, apply terragucci-apply,
  # drift terragucci-drift. Two roles in floci, each trusting Forgejo's issuer
  # for this repo and its own stage's audience alone. A scratch repo whose one
  # root reads a data source that runs a probe in the job, a child of the
  # binary: it reads the token the job wrote to $AWS_WEB_IDENTITY_TOKEN_FILE,
  # verifies it against Forgejo's published keys, records its aud and whether
  # ACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN is in its
  # own environment (when one is, it asks for a token for the apply audience,
  # as a change's code could), reads both roles' trust from floci and
  # evaluates their aud and sub conditions on the token itself, trades it with
  # floci's STS for the job's role when that role's trust admits it, and
  # writes what it saw to floci. floci does not enforce a trust policy's
  # conditions (it grants any role a token names), so the probe's evaluation
  # stands in for the check AWS makes. The push to main runs the apply job; a
  # pull request runs the plan job. Each job's token must carry its stage's
  # audience, the apply role's trust must refuse the plan job's token, and
  # neither probe may see a token-request variable.
  # BREAK: init runs a bundle whose stageTokens fetches the tokens but leaves
  # out the restart without the token-request variables, so the step, the
  # binary and the probe keep them.
  log() { echo "[smoke audience-stages] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/audience-stages" sha pr mark plan_mark apply_mark rc=0 role trust subrepo stage wf TERRAGUCCI="$TERRAGUCCI"
  local plan_role=terragucci-aud-plan apply_role=terragucci-aud-apply marks=shop-terraform-state/audience-marks
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      render.ts '    restartWithout("bash", OIDC_REQUEST_VARS, OIDC_RESTART),' '' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  fresh_repo audience-stages || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  # Forgejo 16 names a repo in the subject as owner-<id>/repo-<id>.
  subrepo="$(api "$URL/api/v1/repos/$repo" | jq -r '"\(.owner.login)-\(.owner.id)/\(.name)-\(.id)"')"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for mark in terragucci-plan terragucci-apply; do curl -s -o /dev/null -X DELETE "$FLOCI/$marks/$mark.json" || true; done
  # Each role trusts its own stage's audience, for this repo. A role left
  # from an earlier run is deleted first, so its trust is this run's.
  iam() { curl -sS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$1" --data-urlencode Version=2010-05-08 "${@:2}"; }
  for stage in plan apply; do
    role="terragucci-aud-$stage"
    trust="$(jq -cn --arg sub "repo:$subrepo:*" --arg aud "terragucci-$stage" '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {Federated: "arn:aws:iam::000000000000:oidc-provider/forgejo:3000/api/actions"},
      Condition: {StringEquals: {"forgejo:3000/api/actions:aud": $aud}, StringLike: {"forgejo:3000/api/actions:sub": $sub}}}]}')"
    iam DeleteRole --data-urlencode "RoleName=$role" >/dev/null 2>&1 || true
    iam CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$trust" >/dev/null || true
    iam GetRole --data-urlencode "RoleName=$role" | grep -q "<RoleName>$role</RoleName>" || { log "floci has no role $role"; drop_work "$work"; return 1; }
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

data "external" "audience" {
  program = ["node", "${path.module}/probe.mjs"]
}

resource "terraform_data" "rev" {
  input = file("${path.module}/rev.txt")
}

output "assumed" {
  value = data.external.audience.result.assumed
}
TF
  jq -n --arg plan "$plan_role" --arg apply "$apply_role" --arg marks "$marks" \
    '{plan: $plan, apply: $apply, apply_audience: "terragucci-apply", marks: $marks}' > "$work/tree/app/roles.json"
  cat > "$work/tree/app/probe.mjs" <<'JS'
// In a job, as a child of the binary: the job's token, the token-request
// variables in this process's environment, and the verdict of each role's
// trust on the token, evaluated here, since floci grants any role a token
// names. What it saw goes to floci under the job's session name.
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const e = process.env;
const fail = (m) => { console.error("audience probe: " + m); process.exit(1); };
const cfg = JSON.parse(readFileSync(new URL("./roles.json", import.meta.url), "utf8"));
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
// The token-request variables, as this process holds them. With them a
// change's code could ask for a token for any audience; the probe asks for
// the apply role's, to show what they would give.
const request = { url: "ACTIONS_ID_TOKEN_REQUEST_URL" in e, token: "ACTIONS_ID_TOKEN_REQUEST_TOKEN" in e };
let asked = null;
if (e.ACTIONS_ID_TOKEN_REQUEST_URL) {
  try {
    const r = await fetch(e.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=" + encodeURIComponent(cfg.apply_audience), { headers: { authorization: "bearer " + (e.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "") } });
    asked = r.ok ? { aud: dec((await r.json()).value.split(".")[1]).aud } : { refused: r.status };
  } catch (err) {
    asked = { failed: err.message };
  }
}
// Each role's trust as floci holds it, and its conditions on aud and sub
// evaluated on this token: StringEquals and StringLike, as AWS reads them.
const iam = async (Action, extra) => (await fetch(e.AWS_ENDPOINT_URL + "/", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ Action, Version: "2010-05-08", ...extra }),
})).text();
const unxml = (t) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const trustOf = async (name) => {
  const raw = unxml(/<AssumeRolePolicyDocument>([\s\S]*?)<\/AssumeRolePolicyDocument>/.exec(await iam("GetRole", { RoleName: name }))?.[1] ?? "").trim();
  if (!raw) fail("floci returned no trust policy for " + name);
  return JSON.parse(raw.startsWith("{") ? raw : decodeURIComponent(raw));
};
const glob = (pat, v) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(v);
const admits = (doc) => [doc.Statement].flat().some((st) => st.Effect === "Allow"
  && Object.entries(st.Condition ?? {}).every(([op, conds]) => Object.entries(conds).every(([k, want]) => {
    const have = [claims[k.slice(k.lastIndexOf(":") + 1)]].flat().filter((v) => v !== undefined).map(String);
    const wants = [want].flat().map(String);
    if (op === "StringEquals") return have.some((v) => wants.includes(v));
    if (op === "StringLike") return have.some((v) => wants.some((w) => glob(w, v)));
    return false;
  })));
const trust = { plan: admits(await trustOf(cfg.plan)), apply: admits(await trustOf(cfg.apply)) };
const role = e.AWS_ROLE_ARN.split("/").pop();
const stage = role === cfg.plan ? "plan" : role === cfg.apply ? "apply" : null;
let assumed = null;
if (stage && trust[stage]) {
  const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: e.AWS_ROLE_ARN, RoleSessionName: e.AWS_ROLE_SESSION_NAME, WebIdentityToken: jwt });
  const r = await fetch(e.AWS_ENDPOINT_URL + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const xml = await r.text();
  assumed = xml.match(/<AssumedRoleUser>[\s\S]*?<Arn>([^<]+)<\/Arn>/)?.[1] ?? null;
  if (!r.ok || !assumed) fail("STS answered " + r.status + ": " + xml.slice(0, 300));
}
const mark = { iss: claims.iss, sub: claims.sub, aud: claims.aud, issuer: conf.issuer, verified, role, trust, request, asked, assumed };
await fetch(e.AWS_ENDPOINT_URL + "/" + cfg.marks + "/" + e.AWS_ROLE_SESSION_NAME + ".json", { method: "PUT", body: JSON.stringify(mark) });
if (!assumed) fail(`the trust of ${role} refuses this token (aud ${JSON.stringify(claims.aud)}), as AWS would`);
console.log(JSON.stringify({ assumed }));
JS
  printf 'forge: forgejo\nbinary: tofu\ngate: never\noidc:\n  plan_role: arn:aws:iam::000000000000:role/%s\n  apply_role: arn:aws:iam::000000000000:role/%s\n  audience:\n    plan: terragucci-plan\n    apply: terragucci-apply\n    drift: terragucci-drift\n' \
    "$plan_role" "$apply_role" > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q "tg oidc \"\$TERRAGUCCI_OIDC_FILE\" 'terragucci-plan'" "$wf" && grep -q "tg oidc \"\$TERRAGUCCI_OIDC_FILE\" 'terragucci-apply'" "$wf" \
    || { log "the pipeline asks for no token for the plan or the apply audience"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    ! grep -q 'TG_NO_OIDC_REQUEST=1' "$wf" || { break_setup_failed "the BREAK pipeline still restarts without the token-request variables"; drop_work "$work"; return 1; }
  else
    grep -q 'exec env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN TG_NO_OIDC_REQUEST=1' "$wf" \
      || { log "the pipeline does not restart without the token-request variables"; drop_work "$work"; return 1; }
  fi
  # A mark from a job of STAGE: a verified token for SUB with that stage's
  # audience alone, admitted by that stage's role, refused by the other one's,
  # traded for that stage's role, and no token-request variable in reach.
  checked() { # stage, sub (mark on stdin)
    local m other
    m="$(cat)"
    other=apply; [ "$1" = apply ] && other=plan
    jq -e '.verified == true and .iss == .issuer' <<<"$m" >/dev/null || { log "the $1 job's token does not verify against Forgejo's keys"; return 1; }
    jq -e --arg sub "$2" '.sub == $sub' <<<"$m" >/dev/null || { log "the $1 job's token names $(jq -r .sub <<<"$m"), not $2"; return 1; }
    jq -e --arg aud "terragucci-$1" '[.aud] | flatten == [$aud]' <<<"$m" >/dev/null || { log "the $1 job's token carries aud $(jq -c .aud <<<"$m"), not terragucci-$1"; return 1; }
    jq -e --arg s "$1" '.trust[$s] == true' <<<"$m" >/dev/null || { log "the $1 role's trust refuses the $1 job's token"; return 1; }
    jq -e --arg o "$other" '.trust[$o] == false' <<<"$m" >/dev/null || { log "the $other role's trust admits the $1 job's token"; return 1; }
    jq -e --arg role "terragucci-aud-$1/terragucci-$1" '.assumed // "" | contains(":assumed-role/" + $role)' <<<"$m" >/dev/null \
      || { log "the $1 job's token was not traded for terragucci-aud-$1: $(jq -c .assumed <<<"$m")"; return 1; }
    jq -e '.request.url == false and .request.token == false and .asked == null' <<<"$m" >/dev/null \
      || { log "the $1 job's probe, a child of the binary, holds the token-request variables $(jq -c .request <<<"$m") and asked for the apply audience: $(jq -c .asked <<<"$m")"; return 1; }
  }
  sha="$(push_tree "$work/tree" "$repo" main "audience-stages: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  apply_mark="$(curl -fsS "$FLOCI/$marks/terragucci-apply.json" 2>/dev/null || true)"
  log "apply job: run $RUN_STATUS, mark ${apply_mark:-none}"
  if [ -z "$apply_mark" ]; then
    print_logs "$repo" "$RUN_ID" | grep -E 'OIDC|audience probe|ACTIONS_ID_TOKEN' >&2 || true
    log "the apply job's probe wrote no mark"
    drop_work "$work"; return 1
  fi
  checked apply "repo:$subrepo:ref:refs/heads/main" <<<"$apply_mark" || rc=1
  [ "$RUN_STATUS" = success ] || { log "the push to main ended '$RUN_STATUS'"; rc=1; }
  echo 2 > "$work/tree/app/rev.txt"
  sha="$(push_tree "$work/tree" "$repo" audience-change "audience-stages: change")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" audience-change "audience-stages: plan")" || { drop_work "$work"; return 1; }
  log "pull request $pr for ${sha:0:8}"
  wait_run "$repo" "$sha" pull_request || { drop_work "$work"; return 1; }
  plan_mark="$(curl -fsS "$FLOCI/$marks/terragucci-plan.json" 2>/dev/null || true)"
  log "plan job: run $RUN_STATUS, mark ${plan_mark:-none}"
  if [ -z "$plan_mark" ]; then
    print_logs "$repo" "$RUN_ID" | grep -E 'OIDC|audience probe|ACTIONS_ID_TOKEN' >&2 || true
    log "the plan job's probe wrote no mark"
    drop_work "$work"; return 1
  fi
  checked plan "repo:$subrepo:pull_request" <<<"$plan_mark" || rc=1
  drop_work "$work"
  [ $rc = 0 ] && log "the plan job's token carried terragucci-plan, which the apply role refuses, the apply job's terragucci-apply, and neither job's code held a token-request variable"
  return $rc
}

claim_apply/groups() {
  # One apply job per environment. environments prod (envs/prod/**) and dev
  # (envs/dev/**), each with its own plan and apply roles, made in floci, and
  # gate: always. envs/prod/app and envs/dev/app read nothing of each other,
  # so wave 1 holds both: init renders apply-wave-1, which plans both roots
  # with the plan roles and decides the gate, then apply-wave-1-prod and
  # apply-wave-1-dev. Each root reads a data source whose program, a child of
  # the binary, writes to floci what its job handed it: the job's name
  # (GITHUB_JOB), TERRAGUCCI_ROOT_ROLES, the root's AWS_ROLE_ARN, the token's
  # sub and aud, and the role floci's STS gave for that token. The first push
  # waits at wave 1's gate; after one approval of its digest, a second push of
  # the same tree applies both group jobs. Each group job must apply its own
  # root alone and carry its own environment's apply role alone, and the
  # deciding job no apply role at all.
  # What this does not show: Forgejo's token names the repo and the ref, and
  # both group jobs run on main, so they present the same subject and the
  # same audience. No trust policy can tell them apart, and floci grants any
  # role a token names in any case. The separation shown here is only which
  # roles each job's variables carry and that the deciding job holds no apply
  # role: a job that learnt the other environment's role ARN could still
  # assume it. config check says so in its shared-subject tip.
  # BREAK: init runs a bundle whose groupOidc keeps every role by glob for
  # each group, so each group job carries both environments' apply roles.
  log() { echo "[smoke apply-groups] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/apply-groups" sha rc=0 env role wf key m applied ledger approvals TERRAGUCCI="$TERRAGUCCI"
  local marks=shop-terraform-state/groups-marks prefix=arn:aws:iam::000000000000:role/terragucci-grp
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      groups.ts '    const out = Object.fromEntries(Object.entries(roles).filter(([g]) => used.has(g)));' '    const out = { ...roles };' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  fresh_repo apply-groups || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=groups-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
  # The job's own pair and each environment's, each trusting Forgejo's issuer.
  # floci checks no condition, so the trust only lets its STS answer.
  iam() { curl -sS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$1" --data-urlencode Version=2010-05-08 "${@:2}"; }
  for role in plan apply prod-plan prod-apply dev-plan dev-apply; do
    role="terragucci-grp-$role"
    iam DeleteRole --data-urlencode "RoleName=$role" >/dev/null 2>&1 || true
    iam CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$(jq -cn '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {Federated: "arn:aws:iam::000000000000:oidc-provider/forgejo:3000/api/actions"}}]}')" >/dev/null || true
    iam GetRole --data-urlencode "RoleName=$role" | grep -q "<RoleName>$role</RoleName>" || { log "floci has no role $role"; drop_work "$work"; return 1; }
  done
  for env in prod dev; do
    mkdir -p "$work/tree/envs/$env/app"
    echo 1 > "$work/tree/envs/$env/app/rev.txt"
    jq -n --arg env "$env" --arg marks "$marks" '{env: $env, marks: $marks}' > "$work/tree/envs/$env/app/probe.json"
    cat > "$work/tree/envs/$env/app/main.tf" <<'TF'
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

# The probe's result is the same in every job, so the deciding job's plan of
# this root and its group job's plan match.
data "external" "groups" {
  program = ["node", "${path.module}/probe.mjs"]
}

resource "terraform_data" "rev" {
  input = trimspace(file("${path.module}/rev.txt"))
}
TF
    cat > "$work/tree/envs/$env/app/probe.mjs" <<'JS'
// In a job, as a child of the binary: the job's name, the roles by root glob
// the job handed the binary, this root's role, the token's sub and aud, and
// the role floci's STS gave for the token, written to floci as
// <marks>/<job>--<environment>.json. It prints the same result in every job.
import { readFileSync } from "node:fs";
const e = process.env;
const fail = (m) => { console.error("groups probe: " + m); process.exit(1); };
const cfg = JSON.parse(readFileSync(new URL("./probe.json", import.meta.url), "utf8"));
if (!e.GITHUB_JOB) fail("no GITHUB_JOB, so the probe cannot say which job it ran in");
if (!e.AWS_WEB_IDENTITY_TOKEN_FILE || !e.AWS_ROLE_ARN) fail("no AWS_WEB_IDENTITY_TOKEN_FILE or AWS_ROLE_ARN, so the root took no role");
let roles;
try { roles = JSON.parse(e.TERRAGUCCI_ROOT_ROLES || "[]"); } catch { fail("TERRAGUCCI_ROOT_ROLES is not JSON: " + e.TERRAGUCCI_ROOT_ROLES); }
const jwt = readFileSync(e.AWS_WEB_IDENTITY_TOKEN_FILE, "utf8").trim();
const claims = JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64url").toString() || "{}");
const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: e.AWS_ROLE_ARN, RoleSessionName: e.AWS_ROLE_SESSION_NAME || "terragucci", WebIdentityToken: jwt });
const r = await fetch(e.AWS_ENDPOINT_URL + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
const xml = await r.text();
const assumed = xml.match(/<AssumedRoleUser>[\s\S]*?<Arn>([^<]+)<\/Arn>/)?.[1] ?? null;
const mark = { job: e.GITHUB_JOB, env: cfg.env, role: e.AWS_ROLE_ARN, roles, sub: claims.sub, aud: claims.aud, assumed };
await fetch(`${e.AWS_ENDPOINT_URL}/${cfg.marks}/${e.GITHUB_JOB}--${cfg.env}.json`, { method: "PUT", body: JSON.stringify(mark) });
if (!assumed) fail("STS answered " + r.status + ": " + xml.slice(0, 300));
console.log(JSON.stringify({ env: cfg.env }));
JS
  done
  {
    printf 'forge: forgejo\nbinary: tofu\ngate: always\noidc:\n  plan_role: %s-plan\n  apply_role: %s-apply\nenvironments:\n' "$prefix" "$prefix"
    for env in prod dev; do
      printf '  %s:\n    roots: ["envs/%s/**"]\n    oidc:\n      plan_role: %s-%s-plan\n      apply_role: %s-%s-apply\n' "$env" "$env" "$prefix" "$env" "$prefix" "$env"
    done
  } > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # The TERRAGUCCI_ROOT_ROLES a job of the pipeline exports, as init wrote it.
  job_roles() { # job
    awk -v j="  $1:" '/^  [^ #][^:]*:$/ { inside = ($0 == j) } inside && /export TERRAGUCCI_ROOT_ROLES=/ { sub(/.*TERRAGUCCI_ROOT_ROLES=/, ""); print; exit }' "$wf"
  }
  for m in apply-wave-1 apply-wave-1-prod apply-wave-1-dev; do
    grep -q "^  $m:\$" "$wf" || { log "init wrote no $m job"; drop_work "$work"; return 1; }
  done
  ! grep -q '^  apply-wave-1-default:$' "$wf" || { log "init wrote a default group, though every root is in an environment"; drop_work "$work"; return 1; }
  log "apply-wave-1-prod exports $(job_roles apply-wave-1-prod), apply-wave-1-dev $(job_roles apply-wave-1-dev)"
  if [ -n "${BREAK:-}" ]; then
    job_roles apply-wave-1-prod | grep -q dev-apply || { break_setup_failed "the BREAK pipeline's apply-wave-1-prod still carries prod's roles alone"; drop_work "$work"; return 1; }
  fi
  job_log() { # run id, job name
    local id
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '.[] | select(.name == $n) | .id' | head -1)"
    [ -n "$id" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null
  }
  job_status() { # run id, job name
    api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '[.[] | select(.name == $n)][0].status // "missing"'
  }
  mark_of() { curl -fsS "$FLOCI/$marks/$1.json" 2>/dev/null || true; }
  # A group job's mark: the root took ENV's apply role, which STS gave, and
  # the job's variables name that role alone.
  group_ok() { # env, mark
    local want="$prefix-$1-apply"
    [ -n "$2" ] || { log "the apply-wave-1-$1 job's probe wrote no mark"; return 1; }
    jq -e --arg w "$want" '.role == $w' <<<"$2" >/dev/null || { log "envs/$1/app took $(jq -r .role <<<"$2") in apply-wave-1-$1, not $want"; return 1; }
    jq -e --arg w "$want" --arg g "envs/$1/**" '.roles == [[$g, $w]]' <<<"$2" >/dev/null \
      || { log "apply-wave-1-$1's TERRAGUCCI_ROOT_ROLES is $(jq -c .roles <<<"$2"), not $1's apply role alone"; return 1; }
    jq -e --arg r "terragucci-grp-$1-apply/" '.assumed // "" | contains(":assumed-role/" + $r)' <<<"$2" >/dev/null \
      || { log "apply-wave-1-$1's token was not traded for $want: $(jq -c .assumed <<<"$2")"; return 1; }
  }
  # The deciding job's mark: the root took ENV's plan role, and no apply role
  # is anywhere in the job's variables.
  decide_ok() { # env, mark
    [ -n "$2" ] || { log "apply-wave-1's probe in envs/$1/app wrote no mark"; return 1; }
    jq -e --arg w "$prefix-$1-plan" '.role == $w' <<<"$2" >/dev/null || { log "envs/$1/app took $(jq -r .role <<<"$2") in apply-wave-1, not $1's plan role"; return 1; }
    jq -e '[.roles[][1] | select(endswith("-apply"))] == []' <<<"$2" >/dev/null || { log "apply-wave-1, which decides and applies nothing, carries an apply role: $(jq -c .roles <<<"$2")"; return 1; }
  }
  sha="$(push_tree "$work/tree" "$repo" main "apply-groups: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  log "first push: run $RUN_STATUS; apply-wave-1-prod $(job_status "$RUN_ID" apply-wave-1-prod), apply-wave-1-dev $(job_status "$RUN_ID" apply-wave-1-dev)"
  job_log "$RUN_ID" apply-wave-1 | grep -q "terragucci approve wave-1" || { log "apply-wave-1 did not wait for an approval of wave 1"; rc=1; }
  [ $rc = 0 ] && { gated_approve apply-groups 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "apply-groups: after wave 1 was approved")" || { drop_work "$work"; return 1; }
    wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
    log "after the approval: run $RUN_STATUS; apply-wave-1-prod $(job_status "$RUN_ID" apply-wave-1-prod), apply-wave-1-dev $(job_status "$RUN_ID" apply-wave-1-dev)"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | grep -E 'groups probe|applied|refus' >&2 || true; log "the run ended $RUN_STATUS"; rc=1; }
    for env in prod dev; do
      applied="$(job_log "$RUN_ID" "apply-wave-1-$env" | sed -n 's#.*applied \(envs/[a-z]*/app\): .*#\1#p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
      log "apply-wave-1-$env applied: ${applied:-nothing}"
      [ "$applied" = "envs/$env/app" ] || { log "apply-wave-1-$env should have applied envs/$env/app alone"; rc=1; }
      m="$(mark_of "apply-wave-1-$env--$env")"
      log "apply-wave-1-$env: ${m:-no mark}"
      group_ok "$env" "$m" || rc=1
      m="$(mark_of "apply-wave-1--$env")"
      log "apply-wave-1 in envs/$env/app: ${m:-no mark}"
      decide_ok "$env" "$m" || rc=1
    done
    [ -z "$(mark_of apply-wave-1-prod--dev)$(mark_of apply-wave-1-dev--prod)" ] || { log "a group job planned the other environment's root"; rc=1; }
    # The limit, as the run shows it: both group jobs' tokens name one subject.
    log "the group jobs' token subjects: prod $(mark_of apply-wave-1-prod--prod | jq -r '.sub // "none"' 2>/dev/null), dev $(mark_of apply-wave-1-dev--dev | jq -r '.sub // "none"' 2>/dev/null)"
    ledger="$(file_at "$repo" chant/lifecycle "$(remote_head "$repo" chant/lifecycle)" _gates/tf-apply.jsonl)"
    approvals="$(jq -s '[.[] | select(.gate == "wave-1" and .kind != "pending")] | length' <<<"$ledger")"
    log "wave 1 on the ledger: $approvals approval(s)"
    [ "$approvals" = 1 ] || { log "expected the one approval of wave 1 to apply both group jobs"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "apply-wave-1 decided with the plan roles alone, then under one approval apply-wave-1-prod and apply-wave-1-dev each applied their own root, each job carrying its own environment's apply role alone"
  return $rc
}

claim_apply/check_job() {
  # An environment's apply job that runs on a ref its environment does not
  # apply from stops before it takes a token. environments prod (envs/prod/**)
  # and dev (envs/dev/**), each with its own plan and apply roles, made in
  # floci, and gate: never. Wave 1 holds envs/prod/app and envs/dev/app, so
  # init renders apply-wave-1, which decides, and apply-wave-1-prod and
  # apply-wave-1-dev, whose first line is `terragucci check-job --forge
  # forgejo --environment <env> --branches "$TG_BRANCH"`. Each root reads a
  # data source whose program, a child of the binary, trades the job's token
  # with floci's STS for the root's role and writes a mark to floci under the
  # commit and the job's name: the probe runs only once the job has fetched
  # its token and handed the binary its role.
  # The hand edit: the condition each apply job of wave 1 runs on, `if:
  # github.ref == ... default_branch`, is widened to any push, as someone
  # testing the pipeline on a branch might. The first push, to main, applies:
  # each group job's check names its ref and lets the job go on, and both
  # group jobs leave a mark. The second, to the branch hotfix, runs the same
  # jobs there: apply-wave-1 decides, and each group job must fail, its log
  # naming the expected ref refs/heads/main and the found refs/heads/hotfix,
  # with no mark from it, so it took no token to STS.
  # What this cannot show: Forgejo has no deployment environments, so the
  # forge environment is not checked here (GitLab and github.com check it),
  # and its runner names no labels to a job; the ref is what a Forgejo job
  # can be checked on. The check is a line of the job: whoever widened the
  # condition could cut it too, as the BREAK does.
  # BREAK: init runs a bundle whose apply jobs lose their check-job line
  # (render.ts), so the group jobs on hotfix go on to trade their tokens.
  log() { echo "[smoke check-job] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/check-job" sha first second rc=0 env role wf m line i done_jobs TERRAGUCCI="$TERRAGUCCI"
  local marks=shop-terraform-state/check-job-marks prefix=arn:aws:iam::000000000000:role/terragucci-cj
  local cond="    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      render.ts '    ...(input.checkJob ? [input.checkJob] : []),' '' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  fresh_repo check-job || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  # The job's own pair and each environment's, each trusting Forgejo's issuer.
  # floci checks no condition, so the trust only lets its STS answer.
  iam() { curl -sS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$1" --data-urlencode Version=2010-05-08 "${@:2}"; }
  for role in plan apply prod-plan prod-apply dev-plan dev-apply; do
    role="terragucci-cj-$role"
    iam DeleteRole --data-urlencode "RoleName=$role" >/dev/null 2>&1 || true
    iam CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$(jq -cn '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {Federated: "arn:aws:iam::000000000000:oidc-provider/forgejo:3000/api/actions"}}]}')" >/dev/null || true
    iam GetRole --data-urlencode "RoleName=$role" | grep -q "<RoleName>$role</RoleName>" || { log "floci has no role $role"; drop_work "$work"; return 1; }
  done
  for env in prod dev; do
    mkdir -p "$work/tree/envs/$env/app"
    echo 1 > "$work/tree/envs/$env/app/rev.txt"
    jq -n --arg env "$env" --arg marks "$marks" '{env: $env, marks: $marks}' > "$work/tree/envs/$env/app/probe.json"
    cat > "$work/tree/envs/$env/app/main.tf" <<'TF'
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

# The probe's result is the same in every job, so the deciding job's plan of
# this root and its group job's plan match.
data "external" "check" {
  program = ["node", "${path.module}/probe.mjs"]
}

resource "terraform_data" "rev" {
  input = trimspace(file("${path.module}/rev.txt"))
}
TF
    cat > "$work/tree/envs/$env/app/probe.mjs" <<'JS'
// In a job, as a child of the binary: the job's name and ref, this root's
// role, and the role floci's STS gave for the job's token, written to floci
// as <marks>/<commit>/<job>--<environment>.json. A mark means the job got
// past its first lines, fetched its token and traded it.
import { readFileSync } from "node:fs";
const e = process.env;
const fail = (m) => { console.error("check-job probe: " + m); process.exit(1); };
const cfg = JSON.parse(readFileSync(new URL("./probe.json", import.meta.url), "utf8"));
if (!e.GITHUB_JOB || !e.GITHUB_SHA) fail("no GITHUB_JOB or GITHUB_SHA, so the probe cannot say which job it ran in");
if (!e.AWS_WEB_IDENTITY_TOKEN_FILE || !e.AWS_ROLE_ARN) fail("no AWS_WEB_IDENTITY_TOKEN_FILE or AWS_ROLE_ARN, so the root took no role");
const jwt = readFileSync(e.AWS_WEB_IDENTITY_TOKEN_FILE, "utf8").trim();
const claims = JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64url").toString() || "{}");
const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: e.AWS_ROLE_ARN, RoleSessionName: e.AWS_ROLE_SESSION_NAME || "terragucci", WebIdentityToken: jwt });
const r = await fetch(e.AWS_ENDPOINT_URL + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
const xml = await r.text();
const assumed = xml.match(/<AssumedRoleUser>[\s\S]*?<Arn>([^<]+)<\/Arn>/)?.[1] ?? null;
const mark = { job: e.GITHUB_JOB, ref: e.GITHUB_REF, env: cfg.env, role: e.AWS_ROLE_ARN, sub: claims.sub, assumed };
await fetch(`${e.AWS_ENDPOINT_URL}/${cfg.marks}/${e.GITHUB_SHA}/${e.GITHUB_JOB}--${cfg.env}.json`, { method: "PUT", body: JSON.stringify(mark) });
if (!assumed) fail("STS answered " + r.status + ": " + xml.slice(0, 300));
console.log(JSON.stringify({ env: cfg.env }));
JS
  done
  {
    printf 'forge: forgejo\nbinary: tofu\ngate: never\noidc:\n  plan_role: %s-plan\n  apply_role: %s-apply\nenvironments:\n' "$prefix" "$prefix"
    for env in prod dev; do
      printf '  %s:\n    roots: ["envs/%s/**"]\n    oidc:\n      plan_role: %s-%s-plan\n      apply_role: %s-%s-apply\n' "$env" "$env" "$prefix" "$env" "$prefix" "$env"
    done
  } > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # A job's lines, as init wrote them.
  cj_job() { # job
    awk -v j="  $1:" '/^  [^ #][^:]*:$/ { inside = ($0 == j) } inside { print }' "$wf"
  }
  for m in apply-wave-1 apply-wave-1-prod apply-wave-1-dev; do
    grep -q "^  $m:\$" "$wf" || { log "init wrote no $m job"; drop_work "$work"; return 1; }
    cj_job "$m" | grep -qxF "$cond" || { log "$m does not run on the default branch alone"; drop_work "$work"; return 1; }
  done
  for env in prod dev; do
    line="$(cj_job "apply-wave-1-$env" | grep -F 'terragucci check-job' || true)"
    if [ -n "${BREAK:-}" ]; then
      [ -z "$line" ] || { break_setup_failed "the BREAK pipeline's apply-wave-1-$env still checks: $line"; drop_work "$work"; return 1; }
    else
      log "apply-wave-1-$env: ${line:-no check}"
      grep -qF "terragucci check-job --forge forgejo --environment '$env' --branches \"\$TG_BRANCH\"" <<<"$line" \
        || { log "apply-wave-1-$env checks no ref before it takes a token"; drop_work "$work"; return 1; }
    fi
  done
  # The hand edit: wave 1's apply jobs run on any push.
  awk -v c="$cond" '/^  [^ #][^:]*:$/ { inside = ($0 ~ /^  apply-wave-1(-prod|-dev)?:$/) } inside && $0 == c { print "    if: github.event_name == '"'"'push'"'"'"; next } { print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
  for m in apply-wave-1 apply-wave-1-prod apply-wave-1-dev; do
    cj_job "$m" | grep -qxF "    if: github.event_name == 'push'" || { log "the hand edit left $m on the default branch alone"; drop_work "$work"; return 1; }
  done
  log "hand edit: apply-wave-1, apply-wave-1-prod and apply-wave-1-dev run on any push"
  cj_log() { # run id, job name
    local id
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '.[] | select(.name == $n) | .id' | head -1)"
    [ -n "$id" ] && api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null
  }
  cj_status() { # run id, job name
    api "$URL/api/v1/repos/$repo/actions/runs/$1/jobs" | jq -r --arg n "$2" '[.[] | select(.name == $n)][0].status // "missing"'
  }
  cj_mark() { curl -fsS "$FLOCI/$marks/$1/$2.json" 2>/dev/null || true; } # sha, <job>--<env>
  # On main: each group job's check passes and the job trades its token.
  first="$(push_tree "$work/tree" "$repo" main "check-job: main")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$first" || { drop_work "$work"; return 1; }
  log "main: run $RUN_STATUS; apply-wave-1-prod $(cj_status "$RUN_ID" apply-wave-1-prod), apply-wave-1-dev $(cj_status "$RUN_ID" apply-wave-1-dev)"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | grep -E 'check-job|probe' >&2 || true; log "the push to main ended $RUN_STATUS"; rc=1; }
  for env in prod dev; do
    m="$(cj_mark "$first" "apply-wave-1-$env--$env")"
    log "apply-wave-1-$env on main: ${m:-no mark}"
    jq -e --arg r "terragucci-cj-$env-apply/" '.ref == "refs/heads/main" and (.assumed // "" | contains(":assumed-role/" + $r))' <<<"${m:-null}" >/dev/null \
      || { log "apply-wave-1-$env on main did not trade its token for $env's apply role"; rc=1; }
    if [ -z "${BREAK:-}" ]; then
      cj_log "$RUN_ID" "apply-wave-1-$env" | grep -F "terragucci check-job: environment $env: ref refs/heads/main" >&2 \
        || { log "apply-wave-1-$env's check did not name its ref refs/heads/main"; rc=1; }
    fi
  done
  # On hotfix: the same jobs, on a ref their environments do not apply from.
  echo 2 > "$work/tree/envs/prod/app/rev.txt"
  echo 2 > "$work/tree/envs/dev/app/rev.txt"
  second="$(push_tree "$work/tree" "$repo" hotfix "check-job: hotfix")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$second" push || { drop_work "$work"; return 1; }
  # Forgejo ends the run at the first failed job, while the other group job
  # may still be running: wait for both to finish before reading them.
  for i in $(seq 1 60); do
    done_jobs=0
    for env in prod dev; do
      case "$(cj_status "$RUN_ID" "apply-wave-1-$env")" in success|failure|cancelled|skipped) done_jobs=$((done_jobs + 1)) ;; esac
    done
    [ $done_jobs = 2 ] && break
    sleep 2
  done
  log "hotfix: run $RUN_STATUS; apply-wave-1 $(cj_status "$RUN_ID" apply-wave-1), apply-wave-1-prod $(cj_status "$RUN_ID" apply-wave-1-prod), apply-wave-1-dev $(cj_status "$RUN_ID" apply-wave-1-dev)"
  [ "$(cj_status "$RUN_ID" apply-wave-1)" = success ] || { log "apply-wave-1 did not decide wave 1 on hotfix, so no group job ran there"; rc=1; }
  for env in prod dev; do
    [ "$(cj_status "$RUN_ID" "apply-wave-1-$env")" = failure ] || { log "apply-wave-1-$env on hotfix did not fail"; rc=1; }
    cj_log "$RUN_ID" "apply-wave-1-$env" | grep -E 'terragucci check-job|probe' >&2 || true
    cj_log "$RUN_ID" "apply-wave-1-$env" | grep -qF "terragucci check-job: environment $env: ref: expected refs/heads/main, found refs/heads/hotfix" \
      || { log "apply-wave-1-$env on hotfix named no expected refs/heads/main and found refs/heads/hotfix"; rc=1; }
    cj_log "$RUN_ID" "apply-wave-1-$env" | grep -qF "terragucci check-job: environment $env: this job does not run where $env's apply is set to run, so it stops before any cloud credential is taken" \
      || { log "apply-wave-1-$env on hotfix did not stop before taking a credential"; rc=1; }
    m="$(cj_mark "$second" "apply-wave-1-$env--$env")"
    [ -z "$m" ] || { log "apply-wave-1-$env on hotfix traded its token: $m"; rc=1; }
  done
  log "apply-wave-1 on hotfix, which holds the plan roles and checks nothing: $(cj_mark "$second" apply-wave-1--prod | jq -c '{ref, role}' 2>/dev/null || echo 'no mark')"
  drop_work "$work"
  [ $rc = 0 ] && log "on main each group job's check named refs/heads/main and the job traded its token; on hotfix each refused, naming refs/heads/main and refs/heads/hotfix, and traded none"
  return $rc
}

claim_forge/check() {
  # terragucci forge check on a Forgejo repo and AWS roles, run from the host;
  # no pipeline runs. The repo $USER/forge-check, and a floci of the claim's
  # own with IAM enforcement on (the stack's floci runs with it off), which
  # holds the roles. The config names a plan and an apply role; config
  # identities --json, given the repo's numeric ids, prints the trust each
  # role needs, and the claim creates both roles with exactly that trust and
  # protects main. Then forge check must exit 0 with every row a match. Each
  # mismatch in turn, put back after its run, must exit 1 with its one row a
  # mismatch whose expected and found name the values: main unprotected
  # (expected protected, found not protected); the apply role's sub moved to
  # StringLike repo:* (expected the apply job's sub, found repo:*); and the
  # plan role's aud a list with an extra audience (found that audience).
  # Read-only: forge check runs with the token of a user who is admin on the
  # repo (branch protections need it) but whose token is scoped
  # read:repository alone, and Forgejo must refuse that token a write; and
  # with the keys of a role floci grants iam:GetRole alone. The claim tries a
  # CreateRole with those keys and logs whether floci refused it: when floci
  # enforces the grant, the keys can only read; when it does not, the keys
  # are the test account's in effect, and only the command's own guard keeps
  # it to reads. Either way forge check reaches Forgejo and floci through a
  # recorder of the claim's own (the config's url and AWS_ENDPOINT_URL_IAM
  # point at it), and every request it recorded must be a GET or HEAD to
  # Forgejo, and a GetRole to floci, which forge check sends as a form POST.
  # BREAK: forge check runs a bundle whose trust comparison takes a live
  # wildcard sub as within a literal one whenever it matches it, so the role
  # that trusts repo:* reports a match.
  log() { echo "[smoke forge-check] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/forge-check" rc=0 TERRAGUCCI="$TERRAGUCCI" fimg name="terragucci-smoke-floci-forge-check" floci port i
  local reader=forge-check-reader rpass rtoken code ids owner_id repo_id prefix=arn:aws:iam::000000000000:role/terragucci-fc
  local roles role policy creds ak="" sk="" st="" probe enforced="" pids="" fport aport plan_aud apply_aud apply_sub widened extra bad reads
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      forge-check.ts '  if (!expectedLike) return false;' '  if (!expectedLike) return likeMatch(v.value, expected);' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  fimg="$(awk '/^  floci:/ { f = 1 } f && /image:/ { print $2; exit }' "$HERE/docker-compose.yml")"
  [ -n "$fimg" ] || { log "no floci image in docker-compose.yml"; drop_work "$work"; return 1; }
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label "terragucci.run-copied=$$" -p 127.0.0.1::4566 \
    -e FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true "$fimg" >/dev/null || { log "could not start floci with IAM enforcement"; drop_work "$work"; return 1; }
  port="$(docker port "$name" 4566/tcp | head -1 | sed 's/.*://')"
  floci="http://127.0.0.1:$port"
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$floci/" 2>/dev/null)" != 000 ] && break
    sleep 1
  done
  # IAM and STS calls on this floci: as the test key, or with KEYS="ak sk st".
  fq() { # service version action [curl args...]
    local svc="$1" ver="$2" act="$3" k
    shift 3
    if [ -n "${KEYS:-}" ]; then
      read -r -a k <<<"$KEYS"
      curl -sS --aws-sigv4 "aws:amz:us-east-1:$svc" --user "${k[0]}:${k[1]}" -H "x-amz-security-token: ${k[2]}" -X POST "$floci/" \
        -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$act" --data-urlencode "Version=$ver" "$@"
    else
      curl -sS --aws-sigv4 "aws:amz:us-east-1:$svc" --user test:test -X POST "$floci/" \
        -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$act" --data-urlencode "Version=$ver" "$@"
    fi
  }
  fiam() { fq iam 2010-05-08 "$@"; }
  # A role's trust as floci answers GetRole to the test key, compact with sorted keys.
  trust_of() { # role name
    fiam GetRole --data-urlencode "RoleName=$1" | node -e '
let x = "";
process.stdin.on("data", (c) => (x += c)).on("end", () => {
  const m = /<AssumeRolePolicyDocument>([^<]*)<\/AssumeRolePolicyDocument>/.exec(x);
  if (!m) process.exit(1);
  let t = m[1].replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, String.fromCharCode(39)).replace(/&amp;/g, "&").trim();
  try { t = decodeURIComponent(t); } catch {}
  process.stdout.write(t);
});' | jq -cS . 2>/dev/null
  }
  # The role's trust set to POLICY, made when it is missing; floci must answer it back.
  set_trust() { # role name, policy
    if [ -z "$(trust_of "$1")" ]; then
      fiam CreateRole --data-urlencode "RoleName=$1" --data-urlencode "AssumeRolePolicyDocument=$2" >/dev/null
    else
      fiam UpdateAssumeRolePolicy --data-urlencode "RoleName=$1" --data-urlencode "PolicyDocument=$2" >/dev/null
    fi
    [ "$(trust_of "$1")" = "$(jq -cS . <<<"$2")" ] || { log "floci holds $(trust_of "$1" || echo nothing) as the trust of $1, not $(jq -c . <<<"$2")"; return 1; }
  }

  fresh_repo forge-check || { docker rm -f "$name" >/dev/null 2>&1; drop_work "$work"; return 1; }
  ids="$(api "$URL/api/v1/repos/$repo" | jq -r '"\(.owner.id) \(.id)"')"
  read -r owner_id repo_id <<<"$ids"
  # The reader: admin on the repo, with a token scoped read:repository alone.
  rpass="smoke-$RANDOM-$RANDOM-Aa1"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$reader?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$reader" --arg p "$rpass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" \
    || { log "could not create $reader"; rc=1; }
  [ $rc = 0 ] && { api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"admin"}' "$URL/api/v1/repos/$repo/collaborators/$reader" || { log "could not make $reader admin on $repo"; rc=1; }; }
  if [ $rc = 0 ]; then
    rtoken="$(curl -fsS -u "$reader:$rpass" -H 'content-type: application/json' -X POST -d '{"name":"forge-check","scopes":["read:repository"]}' "$URL/api/v1/users/$reader/tokens" | jq -r '.sha1 // empty')"
    [ -n "$rtoken" ] || { log "no read:repository token for $reader"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $rtoken" -H 'content-type: application/json' -X POST \
      -d '{"rule_name":"forge-check-probe","branch_name":"forge-check-probe"}' "$URL/api/v1/repos/$repo/branch_protections")"
    log "a branch protection posted with the reader's token: $code"
    case "$code" in
      2*) log "the read:repository token could write to $repo"; api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branch_protections/forge-check-probe" || true; rc=1 ;;
      401|403) ;;
      *) log "Forgejo answered $code to a write with the reader's token, not 403"; rc=1 ;;
    esac
  fi

  # The recorder: one per upstream, each logging every request it passes on
  # (method, path, AWS Query action) as a JSON line. The Host header is passed
  # on as sent, so floci checks the signature forge check made.
  cat > "$work/record.mjs" <<'JS'
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const [upstream, logFile, portFile] = process.argv.slice(2);
const up = new URL(upstream);
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://recorder");
    const form = String(req.headers["content-type"] || "").includes("x-www-form-urlencoded") ? new URLSearchParams(body.toString()).get("Action") : null;
    appendFileSync(logFile, JSON.stringify({ method: req.method, path: url.pathname, action: url.searchParams.get("Action") ?? form }) + "\n");
    const p = http.request({ hostname: up.hostname, port: up.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    p.end(body);
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
JS
  : > "$work/forgejo.log"; : > "$work/floci.log"
  node "$work/record.mjs" "$URL" "$work/forgejo.log" "$work/forgejo.port" & pids="$pids $!"
  node "$work/record.mjs" "$floci" "$work/floci.log" "$work/floci.port" & pids="$pids $!"
  for i in $(seq 1 20); do [ -s "$work/forgejo.port" ] && [ -s "$work/floci.port" ] && break; sleep 0.5; done
  fport="$(cat "$work/forgejo.port" 2>/dev/null)"; aport="$(cat "$work/floci.port" 2>/dev/null)"
  [ -n "$fport" ] && [ -n "$aport" ] || { log "the recorders did not start"; rc=1; }

  mkdir -p "$work/tree"
  printf 'forge: forgejo\nbinary: tofu\nurl: http://127.0.0.1:%s\noidc:\n  plan_role: %s-plan\n  apply_role: %s-apply\n' "$fport" "$prefix" "$prefix" > "$work/tree/terragucci.yml"
  if [ $rc = 0 ]; then
    (cd "$work/tree" && "$TERRAGUCCI" config identities --json --no-roots --repo "$repo" --owner-id "$owner_id" --repo-id "$repo_id") > "$work/identities.json" \
      || { log "config identities failed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    ! grep -q '<owner-id>\|<repo-id>' "$work/identities.json" || { log "config identities left the numeric ids as placeholders"; rc=1; }
    roles="$(jq -c '[.results.environments[].stages[] | select(. != null) | .aws | select(. != null) | {role, policy: .assume_role_policy}] | unique_by(.role) | .[]' "$work/identities.json")"
    plan_aud="$(jq -r '[.results.environments[].stages.plan.aws.audience // empty] | first // empty' "$work/identities.json")"
    apply_aud="$(jq -r '[.results.environments[].stages.apply.aws.audience // empty] | first // empty' "$work/identities.json")"
    apply_sub="$(jq -r '[.results.environments[].stages.apply.token.subject // empty] | first // empty' "$work/identities.json")"
    log "the contract: plan aud $plan_aud, apply aud $apply_aud, apply sub $apply_sub"
    [ "$(grep -c . <<<"$roles")" = 2 ] && [ -n "$plan_aud" ] && [ -n "$apply_sub" ] || { log "config identities named no plan and apply role: $roles"; rc=1; }
  fi
  # Each role with exactly the trust the contract prints.
  if [ $rc = 0 ]; then
    while read -r role; do
      set_trust "$(jq -r '.role | sub(".*:role/"; "")' <<<"$role")" "$(jq -r .policy <<<"$role")" || rc=1
    done <<<"$roles"
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"rule_name":"main","branch_name":"main"}' "$URL/api/v1/repos/$repo/branch_protections" \
      || { log "could not protect main"; rc=1; }
  fi
  # The reader's keys: a role floci grants iam:GetRole alone, assumed with the test key.
  if [ $rc = 0 ]; then
    fiam CreateRole --data-urlencode "RoleName=terragucci-fc-reader" \
      --data-urlencode 'AssumeRolePolicyDocument={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}' >/dev/null || true
    fiam PutRolePolicy -f --data-urlencode "RoleName=terragucci-fc-reader" --data-urlencode PolicyName=read-trust \
      --data-urlencode 'PolicyDocument={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"iam:GetRole","Resource":"*"}]}' >/dev/null \
      || { log "could not grant terragucci-fc-reader iam:GetRole"; rc=1; }
    creds="$(fq sts 2011-06-15 AssumeRole --data-urlencode "RoleArn=arn:aws:iam::000000000000:role/terragucci-fc-reader" --data-urlencode RoleSessionName=forge-check | tr -d '\n\t ')"
    ak="$(sed -n 's#.*<AccessKeyId>\([^<]*\)</AccessKeyId>.*#\1#p' <<<"$creds")"
    sk="$(sed -n 's#.*<SecretAccessKey>\([^<]*\)</SecretAccessKey>.*#\1#p' <<<"$creds")"
    st="$(sed -n 's#.*<SessionToken>\([^<]*\)</SessionToken>.*#\1#p' <<<"$creds")"
    [ -n "$ak" ] && [ -n "$sk" ] || { log "could not assume terragucci-fc-reader: $creds"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    probe="$(KEYS="$ak $sk $st" fiam CreateRole --data-urlencode "RoleName=terragucci-fc-probe" \
      --data-urlencode 'AssumeRolePolicyDocument={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}')"
    if grep -q '<RoleName>terragucci-fc-probe</RoleName>' <<<"$probe"; then
      log "floci let the reader's keys create a role: it does not enforce IAM policies on IAM, so only forge check's own guard keeps it to reads, which the recorder checks"
      fiam DeleteRole --data-urlencode "RoleName=terragucci-fc-probe" >/dev/null || true
    else
      enforced=1
      log "floci refused the reader's keys a CreateRole: $(grep -o '<Code>[^<]*' <<<"$probe" | head -1 | sed 's/<Code>//')"
    fi
  fi

  # One run of forge check as the reader, through the recorders: $work/fc-<name>.json, FC_EXIT.
  fc_run() { # name
    FC_EXIT=0
    (cd "$work/tree" && env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_ENDPOINT_URL -u GOOGLE_OAUTH_ACCESS_TOKEN -u AZURE_GRAPH_TOKEN \
      FORGEJO_TOKEN="$rtoken" AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$st" \
      AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_ENDPOINT_URL_IAM="http://127.0.0.1:$aport" \
      "$TERRAGUCCI" forge check --json --no-roots --repo "$repo") > "$work/fc-$1.json" 2> "$work/fc-$1.err" || FC_EXIT=$?
    log "$1: exit $FC_EXIT; $(jq -c '[.results.rows[]? | {where, subject, status}]' "$work/fc-$1.json" 2>/dev/null || head -c 400 "$work/fc-$1.err")"
  }
  fc_row() { # name, where, text in the subject -> the first such row
    jq -c --arg w "$2" --arg s "$3" '[.results.rows[]? | select(.where == $w and (.subject | contains($s)))] | first // empty' "$work/fc-$1.json" 2>/dev/null
  }
  # The run exited 1 with that row its one mismatch, its expected and found naming the values.
  fc_mismatch() { # name, where, text in the subject, text in expected, text in found
    local r
    r="$(fc_row "$1" "$2" "$3")"
    [ -n "$r" ] || { log "$1: no $2 row for $3"; return 1; }
    log "$1: $2 $3 expected '$(jq -r .expected <<<"$r")', found '$(jq -r .found <<<"$r")', $(jq -r .status <<<"$r")"
    [ "$FC_EXIT" = 1 ] || { log "$1: forge check exited $FC_EXIT, not 1"; return 1; }
    jq -e '.status == "mismatch"' <<<"$r" >/dev/null || { log "$1: the $2 row for $3 is not a mismatch"; return 1; }
    jq -e --arg e "$4" '.expected | contains($e)' <<<"$r" >/dev/null || { log "$1: its expected does not name $4"; return 1; }
    jq -e --arg f "$5" '.found | contains($f)' <<<"$r" >/dev/null || { log "$1: its found does not name $5"; return 1; }
    jq -e '.results.counts.mismatch == 1' "$work/fc-$1.json" >/dev/null || { log "$1: other rows are mismatches too"; return 1; }
  }

  if [ $rc = 0 ]; then
    fc_run match
    [ "$FC_EXIT" = 0 ] || { log "the matching setup: forge check exited $FC_EXIT, not 0"; rc=1; }
    jq -e '.results.rows | length > 0 and all(.status == "match")' "$work/fc-match.json" >/dev/null || { log "the matching setup has a row that is not a match"; rc=1; }
    [ "$(jq -r '[.results.rows[]? | select(.where == "aws")] | length' "$work/fc-match.json")" = 2 ] || { log "the matching setup has no row for each of the two roles"; rc=1; }
    jq -e '[.results.rows[]? | select(.where == "forgejo" and .check == "protected-branch" and .subject == "main" and .status == "match")] | length == 1' "$work/fc-match.json" >/dev/null \
      || { log "the matching setup has no matching row for main"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branch_protections/main" || { log "could not unprotect main"; rc=1; }
    [ $rc = 0 ] && { fc_run unprotected; fc_mismatch unprotected forgejo main protected "not protected" || rc=1; }
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"rule_name":"main","branch_name":"main"}' "$URL/api/v1/repos/$repo/branch_protections" || { log "could not protect main again"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    policy="$(jq -r --arg r "$prefix-apply" 'select(.role == $r) | .policy' <<<"$roles")"
    widened="$(jq -c '.Statement |= map(.Condition as $c | ($c.StringEquals | keys[] | select(endswith(":sub"))) as $k | .Condition = {StringEquals: ($c.StringEquals | del(.[$k])), StringLike: {($k): "repo:*"}})' <<<"$policy")"
    set_trust terragucci-fc-apply "$widened" || rc=1
    [ $rc = 0 ] && { fc_run widened; fc_mismatch widened aws terragucci-fc-apply "$apply_sub" "repo:*" || rc=1; }
    set_trust terragucci-fc-apply "$policy" || rc=1
  fi
  if [ $rc = 0 ]; then
    policy="$(jq -r --arg r "$prefix-plan" 'select(.role == $r) | .policy' <<<"$roles")"
    extra="$(jq -c '.Statement |= map(.Condition.StringEquals |= with_entries(if (.key | endswith(":aud")) then .value = [.value, "forge-check-extra"] else . end))' <<<"$policy")"
    set_trust terragucci-fc-plan "$extra" || rc=1
    [ $rc = 0 ] && { fc_run extra-aud; fc_mismatch extra-aud aws terragucci-fc-plan "aud $plan_aud" forge-check-extra || rc=1; }
    set_trust terragucci-fc-plan "$policy" || rc=1
  fi
  # What the recorders saw of every run: reads alone.
  if [ -f "$work/fc-match.json" ]; then
    reads="$(jq -s 'length' "$work/forgejo.log") to Forgejo, $(jq -s '[.[] | select(.action == "GetRole")] | length' "$work/floci.log") GetRole to floci"
    bad="$(cat "$work/forgejo.log" "$work/floci.log" | jq -c 'select(((.method == "GET" or .method == "HEAD") and .action == null) or ((.method == "GET" or .method == "POST") and .action == "GetRole") | not)')"
    log "the recorders saw ${reads}${bad:+, and these other requests: $bad}"
    [ -z "$bad" ] || { log "forge check sent a request that is not a read"; rc=1; }
    [ "$(jq -s '[.[] | select(.action == "GetRole")] | length' "$work/floci.log")" -gt 0 ] && [ -s "$work/forgejo.log" ] \
      || { log "forge check did not reach Forgejo and floci through the recorders"; rc=1; }
  fi
  # shellcheck disable=SC2086 # one pid per word
  [ -z "$pids" ] || kill $pids 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "forge check exited 0 on the matching setup, and 1 on an unprotected main, a role trusting repo:* and a role trusting an extra audience, each row naming what it expected and found; it read with a read:repository token and keys granted iam:GetRole alone${enforced:+, which floci enforced}, and sent nothing but reads"
  return $rc
}

claim_apply/steward() {
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

claim_comment/plan() {
  # A scratch repo with two roots, the pipeline init writes for it, a push to
  # main (which applies), and a pull request that changes one root (which
  # plans). Then comments, each by the repo's admin: `/terragucci plan app`
  # must start a run for the comment that posts a new terragucci/plan status
  # on the pull request's head; `/terragucci apply`, a root that is not one of
  # the repo's, a root written as a shell command, and `/terragucci approve`,
  # `merge`, `destroy`, `import`, `state` and `force-unlock` (a comment never
  # runs these) must each be answered with a refusal and start no plan, and
  # main must gain no terragucci/apply status from any of them.
  # BREAK: the issue_comment trigger is cut from the pushed pipeline, so a
  # comment starts no run and the re-plan never comes.
  log() { echo "[smoke comment-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment" main_sha head_sha pr i rc=0 wf before after replies verb
  local verbs=(approve merge destroy import state force-unlock)
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
  for verb in "${verbs[@]}"; do comment "/terragucci $verb"; done
  # Each comment is answered within a minute; five minutes is the wait.
  for i in $(seq 1 100); do
    replies="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | map(.body) | join("\n")')"
    [ "$(grep -c '^terragucci: ' <<<"$replies")" -ge $(( 3 + ${#verbs[@]} )) ] && break
    [ $(( i % 20 )) = 0 ] && log "$(grep -c '^terragucci: ' <<<"$replies") of $(( 3 + ${#verbs[@]} )) comments answered after $(( i * 3 ))s"
    sleep 3
  done
  grep -q "pull request $pr is not merged" <<<"$replies" || { log "a comment that applies was not refused"; rc=1; }
  grep -q 'envs/nope is not a root' <<<"$replies" || { log "a root outside the configured ones was not refused"; rc=1; }
  grep -q 'the root is a path' <<<"$replies" || { log "a root written as a shell command was not refused"; rc=1; }
  for verb in "${verbs[@]}"; do
    grep -qF "a comment never runs \`$verb\`" <<<"$replies" || { log "/terragucci $verb got no refusal"; rc=1; }
  done
  after="$(statuses "$head_sha" terragucci/plan)"
  [ "$after" = "$before" ] || { log "a refused comment still planned ($before before, $after after)"; rc=1; }
  [ "$(statuses "$main_sha" terragucci/apply)" = "$applied_before" ] || { log "main gained an apply status from a comment"; rc=1; }
  [ "$(remote_head "$repo" main)" = "$main_sha" ] || { log "main moved"; rc=1; }
  drop_work "$work" 2>/dev/null || true
  [ "$rc" = 0 ] && log "plan re-planned the pull request; apply, an unknown root, a shell-shaped root, approve, merge, destroy, import, state and force-unlock were each refused and planned nothing"
  return "$rc"
}

claim_import/atlantis() {
  # The example as an Atlantis repo would have it: an atlantis.yaml whose six
  # projects are dev's five roots and staging's orders, with a workflow that
  # sets a variable, passes a flag and has an import stage. `terragucci import
  # atlantis` writes terragucci.yml from it and names the import stage as left
  # out on purpose; `init` writes the pipeline; and that pipeline's plan step,
  # run on the tree in the CI image, must plan exactly the six projects'
  # directories. BREAK: one project is dropped from the written terragucci.yml
  # before init, so the pipeline plans five.
  log() { echo "[smoke import-atlantis] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local tree work rc=0 out wf layers got r
  local want="envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/platform,envs/dev/search,envs/staging/orders"
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$tree/"
  cat > "$tree/atlantis.yaml" <<'YAML'
version: 3
automerge: true
projects:
- name: dev-platform
  dir: envs/dev/platform
  apply_requirements: [approved]
  workflow: shop
- name: dev-email
  dir: envs/dev/email
  workflow: shop
- name: dev-orders
  dir: ./envs/dev/orders/
  autoplan:
    when_modified: ["*.tf", "../../../modules/**/*.tf"]
- name: dev-payments
  dir: envs/dev/payments
- name: dev-search
  dir: envs/dev/search
  execution_order_group: 2
- name: staging-orders
  dir: envs/staging/orders
  workspace: default
workflows:
  shop:
    plan:
      steps:
      - env:
          name: TF_VAR_team
          value: shop
      - init
      - plan:
          extra_args: ["-lock=false"]
    import:
      steps: [init, import]
YAML
  # The example's own terragucci.yml gives way to the imported one.
  out="$(cd "$tree" && "$TERRAGUCCI" import atlantis --force --forge forgejo 2>&1)" || { log "import failed: $out"; return 1; }
  grep -q '^  workflows.shop.import (`import` or `state rm` from a comment): The guide: every state change comes from a reviewed commit' <<<"$out" \
    || { log "the import did not name the import stage as left out on purpose"; rc=1; }
  grep -q 'workflows.shop.plan.steps\[2\].plan.extra_args (Flags at run time)' <<<"$out" || { log "the import did not name the flag a step passes"; rc=1; }
  if [ -n "${BREAK:-}" ]; then
    grep -v 'envs/staging/orders' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed on the imported terragucci.yml"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  layers="$(grep -o "terragucci stage tf-plan --out terragucci-report --binary [a-z]* --layers '[^']*'" "$wf" | head -1 | sed -E "s/.*--layers '([^']*)'/\1/")"
  [ -n "$layers" ] || { log "the pipeline has no plan step with --layers"; return 1; }
  log "the pipeline's plan step: --layers $layers"
  local -a REPORT_ARGS=(--layers "$layers")
  REPORT_TREE="$tree" report_run "$work" || true
  r="$work/terragucci-report/report.json"
  [ -f "$r" ] || { log "no report"; return 1; }
  got="$(jq -r '[.roots[] | select(.status == "planned") | .path] | sort | join(",")' "$r")"
  [ "$got" = "$want" ] || { log "the pipeline planned $got, not the Atlantis projects $want"; rc=1; }
  drop_work "$work"; drop_work "$tree"
  [ $rc = 0 ] && log "the imported pipeline planned the six Atlantis projects and nothing else"
  return $rc
}

claim_import/spacelift() {
  # The example as a Spacelift repo would have it: an admin stack's code
  # (spacelift/stacks.tf, no provider block, so it is not a root) declaring a
  # stack per root on OpenTofu 1.13.1, two dependencies the state reads do not
  # give (staging's platform on dev's platform and orders, prod's platform on
  # staging's platform), a context every stack gets with a secret and a plain
  # variable, and a .spacelift/config.yml with a before_plan hook for prod's
  # payments. `terragucci import spacelift` writes terragucci.yml from them and
  # names what it cannot map; `config check` passes; and `init --dry-run` finds
  # the example's 15 roots and cuts them into the waves the dependencies ask
  # for. BREAK: the written waves block, the dependency mapping, is dropped
  # before init, so staging no longer waits for dev.
  log() { echo "[smoke import-spacelift] $*" >&2; }
  local tree out rc=0 got roots canary env svc
  local want="envs/dev/platform|envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/search|envs/staging/platform|envs/prod/platform,envs/staging/email,envs/staging/orders,envs/staging/payments,envs/staging/search|envs/prod/email,envs/prod/orders,envs/prod/payments,envs/prod/search"
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  cp -R "$EXAMPLE/." "$tree/"
  mkdir -p "$tree/spacelift" "$tree/.spacelift"
  for env in dev staging prod; do
    for svc in platform email orders payments search; do
      cat >> "$tree/spacelift/stacks.tf" <<TF
resource "spacelift_stack" "${env}_${svc}" {
  name                    = "${env}-${svc}"
  repository              = "shop"
  branch                  = "main"
  project_root            = "envs/${env}/${svc}"
  terraform_workflow_tool = "OPEN_TOFU"
  terraform_version       = "1.13.1"
  autodeploy              = true
  manage_state            = false
}

TF
    done
  done
  cat >> "$tree/spacelift/stacks.tf" <<'TF'
resource "spacelift_stack_dependency" "staging_platform_on_dev_platform" {
  stack_id            = spacelift_stack.staging_platform.id
  depends_on_stack_id = spacelift_stack.dev_platform.id
}

resource "spacelift_stack_dependency" "staging_platform_on_dev_orders" {
  stack_id            = spacelift_stack.staging_platform.id
  depends_on_stack_id = spacelift_stack.dev_orders.id
}

resource "spacelift_stack_dependency" "prod_platform_on_staging_platform" {
  stack_id            = spacelift_stack.prod_platform.id
  depends_on_stack_id = spacelift_stack.staging_platform.id
}

resource "spacelift_context" "shop" {
  name   = "shop"
  labels = ["autoattach:*"]
}

resource "spacelift_environment_variable" "team" {
  context_id = spacelift_context.shop.id
  name       = "TF_VAR_team"
  value      = "shop"
  write_only = false
}

resource "spacelift_environment_variable" "api_key" {
  context_id = spacelift_context.shop.id
  name       = "TF_VAR_api_key"
  value      = var.api_key
}
TF
  cat > "$tree/.spacelift/config.yml" <<'YAML'
version: "1"
stacks:
  prod-payments:
    before_plan:
      - tofu fmt -check
YAML
  # The example's own terragucci.yml gives way to the imported one.
  out="$(cd "$tree" && "$TERRAGUCCI" import spacelift --force --forge forgejo 2>&1)" || { log "import failed: $out"; return 1; }
  grep -q '^  spacelift_stack_dependency.prod_platform_on_staging_platform (Order): waves.after: envs/prod/platform after envs/staging/platform' <<<"$out" \
    || { log "the import did not write prod's platform after staging's platform into waves.after"; rc=1; }
  grep -q '^  spacelift_environment_variable.api_key (Variables): pass.secrets: TF_VAR_api_key' <<<"$out" || { log "the import did not list the write-only variable as a secret to create"; rc=1; }
  grep -q '^  stacks.prod-payments.before_plan (Hooks): steps: before: plan for envs/prod/payments' <<<"$out" || { log "the import did not make the hook a step for prod's payments"; rc=1; }
  if [ -n "${BREAK:-}" ]; then
    awk '/^waves:/{skip=1; next} skip && /^  /{next} {skip=0; print}' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  (cd "$tree" && "$TERRAGUCCI" config check >/dev/null 2>&1) || { log "config check failed on the imported terragucci.yml"; return 1; }
  out="$(cd "$tree" && "$TERRAGUCCI" init --dry-run --forge forgejo --json 2>/dev/null)" || { log "init --dry-run failed on the imported terragucci.yml"; return 1; }
  roots="$(jq -r '[.results.roots[].path] | sort | join(",")' <<<"$out")"
  [ "$roots" = "$(cd "$tree" && find envs -mindepth 2 -maxdepth 2 -type d | sort | paste -sd, -)" ] || { log "init found the roots $roots, not the stacks' project roots"; rc=1; }
  canary="$(jq -r '.results.files[] | select(.path | test("workflows")) | .content' <<<"$out" | grep -o -- "--canary '[^']*'" | head -1 | sed -E "s/--canary '([^']*)'/\1/")"
  got="$(jq -r --arg c "$canary" '($c | split(",") | map(select(. != ""))) as $c
    | .results.layers as $l
    | ([$l[] | map(select(. as $r | $c | index($r)))] + [$l[] | map(select(. as $r | $c | index($r) | not))])
    | map(select(length > 0) | sort | join(",")) | join("|")' <<<"$out")"
  [ "$got" = "$want" ] || { log "the pipeline applies $got, not the waves the stack dependencies ask for, $want"; rc=1; }
  drop_work "$tree"
  [ $rc = 0 ] && log "the imported pipeline applies dev, then staging's platform, then prod's platform with staging's services, then prod's services"
  return $rc
}

claim_import/env0() {
  # The example as an env zero repo would have it: admin code
  # (env0/environments.tf, no provider block) with an OpenTofu 1.13.1
  # template and an environment per root, each waiting for an approval, the
  # dev environments in a project whose policy gives a 2-d TTL, and a
  # sensitive variable; an env0.yml custom flow in prod's payments; and an
  # env0-discovery.yml that adds a drift schedule to prod's search.
  # `terragucci import env0` writes terragucci.yml from them; `config check`
  # passes; and `init --dry-run` finds the 15 roots, writes the ephemeral
  # workflow for dev's roots, and passes --gate always to every wave. BREAK:
  # the written ephemeral and gate keys are dropped before init, so no
  # ephemeral workflow is written and the waves apply without an approval.
  log() { echo "[smoke import-env0] $*" >&2; }
  local tree out rc=0 roots env svc project eph wf
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  cp -R "$EXAMPLE/." "$tree/"
  mkdir -p "$tree/env0"
  cat > "$tree/env0/environments.tf" <<'TF'
resource "env0_project" "dev" {
  name = "dev"
}

resource "env0_project" "live" {
  name = "live"
}

resource "env0_project_policy" "dev" {
  project_id  = env0_project.dev.id
  default_ttl = "2-d"
  max_ttl     = "1-w"
}

resource "env0_configuration_variable" "api_key" {
  name         = "api_key"
  type         = "terraform"
  value        = var.api_key
  is_sensitive = true
}

TF
  for env in dev staging prod; do
    project=live; [ "$env" = dev ] && project=dev
    for svc in platform email orders payments search; do
      cat >> "$tree/env0/environments.tf" <<TF
resource "env0_template" "${env}_${svc}" {
  name             = "${env}-${svc}"
  repository       = "https://example.com/shop"
  type             = "opentofu"
  path             = "envs/${env}/${svc}"
  opentofu_version = "1.13.1"
}

resource "env0_environment" "${env}_${svc}" {
  name                       = "${env}-${svc}"
  project_id                 = env0_project.${project}.id
  template_id                = env0_template.${env}_${svc}.id
  approve_plan_automatically = false
}

TF
    done
  done
  cat > "$tree/envs/prod/payments/env0.yml" <<'YAML'
version: 2
deploy:
  steps:
    opentofuPlan:
      before:
        - tofu fmt -check
YAML
  cat > "$tree/env0-discovery.yml" <<'YAML'
environments:
  prod-search:
    name: prod-search
    projectName: live
    templateName: prod-search
    driftDetectionCron: "0 5 * * *"
YAML
  out="$(cd "$tree" && "$TERRAGUCCI" import env0 --force --forge forgejo 2>&1)" || { log "import failed: $out"; return 1; }
  grep -q '^  env0_environment.dev_orders: dev-orders (TTL): ephemeral.roots: envs/dev/orders, ttl: 2d' <<<"$out" || { log "the import did not make dev's orders an ephemeral root"; rc=1; }
  grep -q '^  env0_configuration_variable.api_key (Variables): pass.secrets: TF_VAR_api_key' <<<"$out" || { log "the import did not list the sensitive variable as a secret to create"; rc=1; }
  grep -q '^  envs/prod/payments/env0.yml: deploy.steps.opentofuPlan.before (Hooks): steps: before: plan for envs/prod/payments' <<<"$out" || { log "the import did not make the custom flow a step for prod's payments"; rc=1; }
  grep -q '^  environments.prod-search.driftDetectionCron (Drift): drift: "0 5 \* \* \*"' <<<"$out" || { log "the import did not take the discovery file's drift schedule"; rc=1; }
  if [ -n "${BREAK:-}" ]; then
    awk '/^(ephemeral|gate):/{skip=1; next} skip && /^  /{next} {skip=0; print}' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  (cd "$tree" && "$TERRAGUCCI" config check >/dev/null 2>&1) || { log "config check failed on the imported terragucci.yml"; return 1; }
  out="$(cd "$tree" && "$TERRAGUCCI" init --dry-run --forge forgejo --json 2>/dev/null)" || { log "init --dry-run failed on the imported terragucci.yml"; return 1; }
  roots="$(jq -r '[.results.roots[].path] | sort | join(",")' <<<"$out")"
  [ "$roots" = "$(cd "$tree" && find envs -mindepth 2 -maxdepth 2 -type d | sort | paste -sd, -)" ] || { log "init found the roots $roots, not the environments' template paths"; rc=1; }
  eph="$(jq -r '[.results.files[] | select(.path | test("terragucci-ephemeral"))] | length' <<<"$out")"
  [ "$eph" = 1 ] || { log "init wrote no ephemeral workflow for the environments with a TTL"; rc=1; }
  wf="$(jq -r '.results.files[] | select(.path == ".forgejo/workflows/terragucci.yml") | .content' <<<"$out")"
  grep -q -- '--gate always' <<<"$wf" || { log "the pipeline's waves do not wait for an approval, as every environment did"; rc=1; }
  drop_work "$tree"
  [ $rc = 0 ] && log "the imported pipeline plans the 15 environments' roots, keeps an ephemeral copy of dev's, and holds every wave for an approval"
  return $rc
}

# The TFE API mock (stack/fixtures/tfe-api/tfe.mjs) on the claims' network as
# host, serving fixture (hcp.json or scalr.json) over HTTPS with a certificate
# made here; sets TFE_MOCK (the container) and TFE_CTL (its control URL).
tfe_mock() { # work, host, token, fixture
  local work="$1" host="$2" token="$3" fixture="$4" image port i
  image="$(image_tag tofu)"
  mkdir -p "$work/tfe"
  cp "$HERE/fixtures/tfe-api/tfe.mjs" "$work/tfe/" && cp "$HERE/fixtures/tfe-api/$fixture" "$work/tfe/api.json" || return 1
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$host" -addext "subjectAltName=DNS:$host" \
    -keyout "$work/tfe/key.pem" -out "$work/tfe/cert.pem" >/dev/null 2>&1 || { echo "openssl could not make the API's certificate" >&2; return 1; }
  TFE_MOCK="$(run_copied -d --name "$host" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::8080 -e "TOKEN=$token" -v "$work/tfe:/tfe:ro" "$image" node /tfe/tfe.mjs)" || { echo "the TFE API did not start" >&2; return 1; }
  port="$(docker port "$TFE_MOCK" 8080/tcp | head -1 | sed 's/.*://')"
  TFE_CTL="http://127.0.0.1:$port"
  for i in $(seq 1 30); do curl -fsS -o /dev/null "$TFE_CTL/status" 2>/dev/null && return 0; sleep 1; done
  echo "the TFE API never answered on $TFE_CTL" >&2
  return 1
}

# terragucci, from the bundle, in the CI image on the claims' network, in
# tree, with the token for host and the mock's certificate trusted.
tfe_terragucci() { # work, tree, host, token, args...
  local work="$1" tree="$2" host="$3" token="$4"; shift 4
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$tree:/repo" -w /repo \
    -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -e "TF_TOKEN_$host=$token" -e NODE_EXTRA_CA_CERTS=/tfe-ca/cert.pem -v "$work/tfe:/tfe-ca:ro" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag tofu)" terragucci "$@"
}

claim_import/hcp() {
  # The example as HCP Terraform runs it: organization acme
  # (stack/fixtures/tfe-api/hcp.json, served by the TFE API mock over HTTPS,
  # five workspaces to a page) holds a workspace per dev and staging root of
  # repo acme/shop, two workspaces on envs/prod/orders, one on another repo
  # and one CLI-driven. dev-platform and staging-platform set a Terraform
  # variable, an env variable and a sensitive variable; a variable set on
  # dev-orders adds a sensitive one; staging-platform's run trigger comes
  # from dev-orders, an order no terraform_remote_state read gives.
  # `terragucci import hcp`, run in the CI image with the token in
  # TF_TOKEN_<host>, only GETs from the API and writes terragucci.yml and the
  # tfvars; it lists envs/prod/orders to split and names both secrets; no
  # sensitive value (the mock sends one, as the real API never does) lands in
  # the tree or the output. `config check` passes, and `init --dry-run`
  # plans the ten roots in the waves the reads and the trigger ask for: dev's
  # platform, dev's services, staging's platform, staging's services, with
  # both secrets passed to the jobs.
  # BREAK: the written waves block, the run trigger's order, is dropped before
  # init, so staging's platform applies beside dev's.
  log() { echo "[smoke import-hcp] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local tree work image rc=0 host="tgtfe$$x$RANDOM" token="smoke-tfe-$STAMP" out got wf status
  local want="envs/dev/platform|envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/search|envs/staging/platform|envs/staging/email,envs/staging/orders,envs/staging/payments,envs/staging/search"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$tree/"
  TFE_MOCK=""
  tfe_mock "$work" "$host" "$token" hcp.json || rc=1
  if [ $rc = 0 ]; then
    # The example's own terragucci.yml gives way to the imported one.
    out="$(tfe_terragucci "$work" "$tree" "$host" "$token" import hcp --hostname "$host" --organization acme --repo acme/shop --forge forgejo --force 2>&1)" || { log "import failed: $out"; rc=1; }
    printf '%s\n' "$out" >&2
  fi
  if [ $rc = 0 ]; then
    grep -q '^  workspaces\[prod-orders, prod-orders-blue\] (Several workspaces on one working directory): envs/prod/orders runs 2 workspaces' <<<"$out" || { log "the import did not list envs/prod/orders to split"; rc=1; }
    grep -q '^Secrets to create .*: TF_VAR_api_token, TF_VAR_db_password$' <<<"$out" || { log "the import did not name the two sensitive variables as secrets to create"; rc=1; }
    grep -q '^region = "us-east-1"$' "$tree/envs/dev/platform/terraform.tfvars" 2>/dev/null || { log "envs/dev/platform/terraform.tfvars does not hold dev-platform's region"; rc=1; }
    if grep -rq never-copy-this "$tree" || grep -q never-copy-this <<<"$out"; then log "a sensitive value reached the tree or the output"; rc=1; fi
    status="$(curl -fsS "$TFE_CTL/status")"
    [ "$(jq '[.calls[] | select(startswith("GET ") | not)] | length' <<<"$status")" = 0 ] || { log "the import did more than read: $(jq -c '[.calls[] | select(startswith("GET ") | not)]' <<<"$status")"; rc=1; }
    [ "$(jq '[.calls[] | select(test("organizations/acme/workspaces"))] | length' <<<"$status")" = 3 ] || { log "the import did not read the three pages of workspaces"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    awk '/^waves:/{skip=1; next} skip && /^  /{next} {skip=0; print}' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  if [ $rc = 0 ]; then
    cat "$tree/terragucci.yml" >&2
    (cd "$tree" && "$TERRAGUCCI" config check >/dev/null 2>&1) || { log "config check failed on the imported terragucci.yml"; rc=1; }
    out="$(cd "$tree" && "$TERRAGUCCI" init --dry-run --forge forgejo --json 2>/dev/null)" || { log "init --dry-run failed on the imported terragucci.yml"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    got="$(jq -r '[.results.roots[].path] | sort | join(",")' <<<"$out")"
    [ "$got" = "$(tr '|' ',' <<<"$want" | tr ',' '\n' | sort | paste -sd, -)" ] || { log "init found the roots $got, not the ten workspaces'"; rc=1; }
    got="$(jq -r '.results.layers | map(sort | join(",")) | join("|")' <<<"$out")"
    [ "$got" = "$want" ] || { log "the pipeline applies $got, not the order the reads and the run trigger ask for, $want"; rc=1; }
    wf="$(jq -r '.results.files[] | select(.path | test("workflows")) | .content' <<<"$out")"
    for got in TF_VAR_api_token TF_VAR_db_password; do
      grep -qF "$got: '\${{ secrets.$got }}'" <<<"$wf" || { log "the pipeline does not pass the secret $got to the jobs"; rc=1; }
    done
  fi
  [ -n "$TFE_MOCK" ] && { docker rm -f "$TFE_MOCK" >/dev/null 2>&1 || true; }
  drop_work "$work"; drop_work "$tree"
  [ $rc = 0 ] && log "the imported pipeline applies dev, then staging's platform after dev's orders, then staging's services, with both secrets passed and no value copied"
  return $rc
}

claim_import/scalr() {
  # The example as Scalr runs it: account <host> (stack/fixtures/tfe-api/
  # scalr.json on Scalr's own API, /api/iacp/v3/, by the same mock) holds
  # environments staging and prod, five OpenTofu workspaces of acme/shop
  # and one CLI-driven, a sensitive DATADOG_API_KEY on each environment, an
  # account variable TEAM, a sensitive db_password on staging-platform, and a
  # policy group cost-guard with a hard-mandatory, a soft-mandatory and an
  # advisory policy. `terragucci import scalr`, run in the CI image with the
  # token, only GETs from Scalr's API, writes the five roots with binary:
  # tofu, TEAM in env and both secrets under pass, names each policy's level
  # and what it becomes, and copies no sensitive value. `config check`
  # passes, and `init --dry-run` plans the five roots with both secrets
  # passed to the jobs.
  # BREAK: the written pass block is dropped before init, so the jobs get
  # neither secret.
  log() { echo "[smoke import-scalr] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local tree work image rc=0 host="tgscalr$$x$RANDOM" token="smoke-scalr-$STAMP" out got wf status
  local want="envs/prod/email,envs/prod/orders,envs/prod/platform,envs/staging/orders,envs/staging/platform"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$tree/"
  TFE_MOCK=""
  tfe_mock "$work" "$host" "$token" scalr.json || rc=1
  if [ $rc = 0 ]; then
    out="$(tfe_terragucci "$work" "$tree" "$host" "$token" import scalr --hostname "$host" --repo acme/shop --forge forgejo --force 2>&1)" || { log "import failed: $out"; rc=1; }
    printf '%s\n' "$out" >&2
  fi
  if [ $rc = 0 ]; then
    grep -q '^  policy-groups\[cost-guard\] (Scalr OPA policy group): on staging, prod, from acme/policies/cost at main; .*max_monthly_cost (hard-mandatory): a deny rule; instance_types (soft-mandatory): a deny rule that a person in policy.override can let through; owner_tags (advisory): a warn rule' <<<"$out" \
      || { log "the import did not name the policy group's policies and what each level becomes"; rc=1; }
    grep -q '^  workspaces\[prod/prod-legacy\] (Workspace): no VCS connection' <<<"$out" || { log "the import did not list the CLI-driven workspace as skipped"; rc=1; }
    if grep -rq never-copy-this "$tree" || grep -q never-copy-this <<<"$out"; then log "a sensitive value reached the tree or the output"; rc=1; fi
    status="$(curl -fsS "$TFE_CTL/status")"
    [ "$(jq '[.calls[] | select(startswith("GET /api/iacp/v3/") | not)] | length' <<<"$status")" = 0 ] || { log "the import did more than read Scalr's API: $(jq -c '[.calls[] | select(startswith("GET /api/iacp/v3/") | not)]' <<<"$status")"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    awk '/^pass:/{skip=1; next} skip && /^  /{next} {skip=0; print}' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  if [ $rc = 0 ]; then
    cat "$tree/terragucci.yml" >&2
    [ "$(sed -n 's/^binary: //p' "$tree/terragucci.yml")" = tofu ] || { log "terragucci.yml does not run tofu, as the workspaces' iac-platform asks"; rc=1; }
    (cd "$tree" && "$TERRAGUCCI" config check >/dev/null 2>&1) || { log "config check failed on the imported terragucci.yml"; rc=1; }
    out="$(cd "$tree" && "$TERRAGUCCI" init --dry-run --forge forgejo --json 2>/dev/null)" || { log "init --dry-run failed on the imported terragucci.yml"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    got="$(jq -r '[.results.roots[].path] | sort | join(",")' <<<"$out")"
    [ "$got" = "$want" ] || { log "init found the roots $got, not the five workspaces' $want"; rc=1; }
    wf="$(jq -r '.results.files[] | select(.path | test("workflows")) | .content' <<<"$out")"
    for got in DATADOG_API_KEY TF_VAR_db_password; do
      grep -qF "$got: '\${{ secrets.$got }}'" <<<"$wf" || { log "the pipeline does not pass the secret $got to the jobs"; rc=1; }
    done
  fi
  [ -n "$TFE_MOCK" ] && { docker rm -f "$TFE_MOCK" >/dev/null 2>&1 || true; }
  drop_work "$work"; drop_work "$tree"
  [ $rc = 0 ] && log "the imported pipeline plans the five Scalr workspaces' roots on tofu with both secrets passed, the policy group named, and no value copied"
  return $rc
}

claim_import/terragrunt_scale() {
  # The Terragrunt example as a Terragrunt Scale repo would have it: Gruntwork
  # Pipelines' .gruntwork/aws.hcl reading accounts.yml, an environment block
  # per account (dev and staging by account reference, prod by literal ARNs),
  # live/prod/payments with roles of its own in its gruntwork.hcl, and
  # tf_binary. `terragucci import terragrunt-scale` writes terragucci.yml;
  # `config check` passes; `init --dry-run` writes a pipeline whose plan and
  # apply jobs hand the auth provider those roles; and `terragucci
  # auth-provider`, run in each unit as Terragrunt runs it, gives every unit
  # the plan and apply role of its environment, and payments its own.
  # BREAK: the written terragrunt block, the role split, is dropped before
  # init, so no unit gets a role.
  log() { echo "[smoke import-tg-scale] $*" >&2; }
  local tree out rc=0 phase roles unit want got arn=arn:aws:iam
  tree="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$tree"
  cp -R "$TG_EXAMPLE/." "$tree/"
  mkdir -p "$tree/.gruntwork"
  cat > "$tree/accounts.yml" <<'YAML'
"dev":
  "email": "dev@example.com"
  "id": "111111111111"
"staging":
  "email": "staging@example.com"
  "id": "222222222222"
YAML
  cat > "$tree/.gruntwork/aws.hcl" <<'HCL'
aws {
  accounts "all" {
    path = "accounts.yml"
  }
}
HCL
  cat > "$tree/.gruntwork/environments.hcl" <<'HCL'
environment "dev" {
  filter {
    paths = ["live/dev/*"]
  }
  authentication {
    aws_oidc {
      account_id         = aws.accounts.all.dev.id
      plan_iam_role_arn  = "arn:aws:iam::${aws.accounts.all.dev.id}:role/pipelines-plan"
      apply_iam_role_arn = "arn:aws:iam::${aws.accounts.all.dev.id}:role/pipelines-apply"
    }
  }
}

environment "staging" {
  filter {
    paths = ["live/staging/*"]
  }
  authentication {
    aws_oidc {
      account_id         = aws.accounts.all.staging.id
      plan_iam_role_arn  = "arn:aws:iam::${aws.accounts.all.staging.id}:role/pipelines-plan"
      apply_iam_role_arn = "arn:aws:iam::${aws.accounts.all.staging.id}:role/pipelines-apply"
    }
  }
}

environment "prod" {
  filter {
    paths = ["live/prod/*"]
  }
  authentication {
    aws_oidc {
      account_id         = "333333333333"
      plan_iam_role_arn  = "arn:aws:iam::333333333333:role/pipelines-plan"
      apply_iam_role_arn = "arn:aws:iam::333333333333:role/pipelines-apply"
    }
  }
}
HCL
  cat > "$tree/.gruntwork/repository.hcl" <<'HCL'
repository {
  tf_binary = "opentofu"
}
HCL
  cat > "$tree/live/prod/payments/gruntwork.hcl" <<'HCL'
unit {
  authentication {
    aws_oidc {
      account_id         = "333333333333"
      plan_iam_role_arn  = "arn:aws:iam::333333333333:role/payments-plan"
      apply_iam_role_arn = "arn:aws:iam::333333333333:role/payments-apply"
    }
  }
}
HCL
  # The example's own terragucci.yml gives way to the imported one.
  out="$(cd "$tree" && "$TERRAGUCCI" import terragrunt-scale --force 2>&1)" || { log "import failed: $out"; return 1; }
  grep -q '^  \.gruntwork/environments\.hcl: environment\.dev\.authentication\.aws_oidc (Roles): terragrunt\.credentials "live/dev/\*\*": plan arn:aws:iam::111111111111:role/pipelines-plan' <<<"$out" \
    || { log "the import did not write dev's roles from accounts.yml"; rc=1; }
  grep -q '^  \.gruntwork/repository\.hcl: repository\.tf_binary (Binary): binary: tofu' <<<"$out" || { log "the import did not map tf_binary"; rc=1; }
  if [ -n "${BREAK:-}" ]; then
    awk '/^terragrunt:/{skip=1; next} skip && /^  /{next} {skip=0; print}' "$tree/terragucci.yml" > "$tree/terragucci.yml.new" && mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  fi
  (cd "$tree" && "$TERRAGUCCI" config check >/dev/null 2>&1) || { log "config check failed on the imported terragucci.yml"; return 1; }
  out="$(cd "$tree" && "$TERRAGUCCI" init --dry-run --forge forgejo --json 2>/dev/null)" || { log "init --dry-run failed on the imported terragucci.yml"; return 1; }
  printf 'smoke-token' > "$tree/.oidc-token"
  for phase in plan apply; do
    # The role map the generated job exports for the auth provider in this phase.
    roles="$(jq -r '.results.files[] | select(.path | test("workflows")) | .content' <<<"$out" | grep -o "TERRAGUCCI_PHASE=$phase TERRAGUCCI_TG_ROLES='[^']*'" | head -1 | sed -E "s/.*TERRAGUCCI_TG_ROLES='([^']*)'/\1/")"
    [ -n "$roles" ] || { log "the $phase job hands the auth provider no roles"; rc=1; continue; }
    for unit in live/dev/orders live/staging/search live/prod/platform live/prod/payments; do
      case "$unit" in
        live/dev/*) want="$arn::111111111111:role/pipelines-$phase" ;;
        live/staging/*) want="$arn::222222222222:role/pipelines-$phase" ;;
        live/prod/payments) want="$arn::333333333333:role/payments-$phase" ;;
        *) want="$arn::333333333333:role/pipelines-$phase" ;;
      esac
      # The repo as the unit's working directory resolves it: TMPDIR may sit behind a symlink, as /var does on macOS.
      got="$(cd "$tree/$unit" && TERRAGUCCI_REPO="$(cd "$tree" && pwd -P)" TERRAGUCCI_PHASE="$phase" TERRAGUCCI_TG_ROLES="$roles" AWS_WEB_IDENTITY_TOKEN_FILE="$tree/.oidc-token" "$TERRAGUCCI" auth-provider 2>/dev/null | jq -r '.awsRole.roleARN // "none"')"
      [ "$got" = "$want" ] || { log "$phase: $unit assumes $got, not $want"; rc=1; }
    done
  done
  drop_work "$tree"
  [ $rc = 0 ] && log "each environment's units plan and apply with that environment's roles, and live/prod/payments with its own"
  return $rc
}

claim_waves/after() {
  # A scratch repo with three plain roots that read nothing of each other's
  # state, and terragucci.yml whose waves.after puts app after database and
  # database after network. init must cut them into three waves, network,
  # database, app; the push to main must go green; and a pull request that
  # changes network alone must plan all three, its plan note naming them.
  # BREAK: terragucci.yml has no waves.after, so the three share one wave and
  # the pull request plans network alone.
  log() { echo "[smoke waves-after] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/waves-after" main_sha head_sha pr root cfg out layers deadline state notes roots rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo waves-after || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in network database app; do
    mkdir -p "$work/tree/$root"
    echo 1 > "$work/tree/$root/rev.txt"
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
  cfg='forge: forgejo\nbinary: tofu\ngate: never\n'
  [ -z "${BREAK:-}" ] && cfg="${cfg}waves:\n  after:\n    app: [database]\n    database: [network]\n"
  # shellcheck disable=SC2059 # the config's newlines are printf escapes
  printf "$cfg" > "$work/tree/terragucci.yml"
  out="$(cd "$work/tree" && "$TERRAGUCCI" init --dry-run --json 2>/dev/null)" || { log "init --dry-run failed"; return 1; }
  layers="$(jq -r '[.results.layers[] | sort | join(",")] | join("|")' <<<"$out")"
  log "init's waves: $layers"
  [ "$layers" = "network|database|app" ] || { log "init cut the roots into $layers, not network|database|app"; rc=1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  main_sha="$(push_tree "$work/tree" "$repo" main "waves-after: first")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green"; return 1; }
  echo 2 > "$work/tree/network/rev.txt"
  head_sha="$(push_tree "$work/tree" "$repo" network-change "waves-after: change network")" || return 1
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"network-change","base":"main","title":"waves-after: change network"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  [ -n "$pr" ] && [ "$pr" != null ] || { log "no pull request"; return 1; }
  log "pull request $pr for ${head_sha:0:8}"
  # The plan job's status on the head says when its note is up.
  deadline=$(( $(date +%s) + TIMEOUT ))
  state=pending
  while [ "$state" = pending ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    state="$(api "$URL/api/v1/repos/$repo/commits/$head_sha/statuses" | jq -r '[.[] | select(.context == "terragucci/plan")][0].status // "pending"')"
  done
  log "terragucci/plan on ${head_sha:0:8}: $state"
  notes="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq '[.[] | select(.body | startswith("<!-- terragucci:plan"))]')"
  if [ "$(jq length <<<"$notes")" -lt 1 ]; then
    log "pull request $pr has no plan note"; rc=1
  else
    roots="$(jq -r '.[-1].body' <<<"$notes" | head -1 | sed -E 's/.*roots=([^ ]*) -->.*/\1/' | tr , '\n' | sort | paste -sd, -)"
    log "the plan note covers $roots"
    [ "$roots" = "app,database,network" ] || { log "a change to network planned $roots, not app,database,network"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "network, database and app apply in three waves, and a change to network plans all three"
  return $rc
}

claim_comment/atlantis() {
  # A scratch repo with two roots and atlantis_comments: true, the pipeline
  # init writes for it, a push to main, and a pull request that changes one
  # root. `atlantis plan -d app` by the repo's admin must start a run that
  # posts a new terragucci/plan status on the head. Then `atlantis apply` on
  # the open pull request must be refused as `/terragucci apply` is (it is not
  # merged), `atlantis plan -w blue` must be refused with the guide's reason,
  # neither may plan, and main gains no terragucci/apply status.
  # BREAK: the pipeline is written without atlantis_comments, so the comment
  # starts no job and the re-plan never comes.
  log() { echo "[smoke comment-atlantis] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/comment-atlantis" main_sha head_sha pr i rc=0 before after replies root cfg
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo comment-atlantis || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in app net; do
    mkdir -p "$work/tree/$root"
    echo 1 > "$work/tree/$root/rev.txt"
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
  cfg='forge: forgejo\nbinary: tofu\ngate: never\n'
  [ -z "${BREAK:-}" ] && cfg="${cfg}atlantis_comments: true\n"
  # shellcheck disable=SC2059 # the config's newlines are printf escapes
  printf "$cfg" > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  main_sha="$(push_tree "$work/tree" "$repo" main "comment-atlantis: first")" || return 1
  wait_run "$repo" "$main_sha" || return 1
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green"; return 1; }
  echo 2 > "$work/tree/app/rev.txt"
  head_sha="$(push_tree "$work/tree" "$repo" atlantis-change "comment-atlantis: change")" || return 1
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"atlantis-change","base":"main","title":"comment-atlantis: plan"}' "$URL/api/v1/repos/$repo/pulls" | jq -r .number)"
  log "pull request $pr for ${head_sha:0:8}"
  statuses() { api "$URL/api/v1/repos/$repo/commits/$1/statuses?limit=100" | jq --arg c "$2" '[.[] | select(.context == $c)] | length'; }
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(statuses "$head_sha" terragucci/plan)" -ge 2 ] && break
    sleep 3
  done
  before="$(statuses "$head_sha" terragucci/plan)"
  [ "$before" -ge 2 ] || { log "the pull request's own plan never finished"; return 1; }
  local applied_before
  applied_before="$(statuses "$main_sha" terragucci/apply)"
  comment() { api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg b "$1" '{body: $b}')" "$URL/api/v1/repos/$repo/issues/$pr/comments"; }
  comment_runs() { api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq '[.workflow_runs[] | select(.event == "issue_comment" and (.status == "success" or .status == "failure" or .status == "skipped"))] | length'; }
  local runs_before wait=$(( TIMEOUT < 240 ? TIMEOUT : 240 ))
  runs_before="$(comment_runs)"
  comment "atlantis plan -d app"
  # The re-plan's note job posts the status inside the comment's run, so once that run has finished the status is there or never comes.
  for i in $(seq 1 $(( wait / 3 ))); do
    after="$(statuses "$head_sha" terragucci/plan)"
    [ "$after" -gt "$before" ] && break
    [ "$(comment_runs)" -gt "$runs_before" ] && { sleep 3; break; }
    sleep 3
  done
  after="$(statuses "$head_sha" terragucci/plan)"
  [ "$after" -gt "$before" ] || { log "atlantis plan -d app posted no new plan status on the head ($before before, $after after)"; return 1; }
  log "atlantis plan -d app re-planned: terragucci/plan statuses on the head went from $before to $after"
  before="$after"
  comment "atlantis apply"
  comment "atlantis plan -w blue"
  for i in $(seq 1 $(( wait / 3 ))); do
    replies="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("terragucci: "))] | map(.body) | join("\n")')"
    [ "$(grep -c '^terragucci: ' <<<"$replies")" -ge 2 ] && break
    sleep 3
  done
  grep -q "pull request $pr is not merged" <<<"$replies" || { log "atlantis apply on an open pull request was not refused as /terragucci apply is"; rc=1; }
  grep -q 'picks a workspace, and terragucci has no flag: each root is a directory with one state' <<<"$replies" || { log "atlantis plan -w was not refused with the guide's reason"; rc=1; }
  after="$(statuses "$head_sha" terragucci/plan)"
  [ "$after" = "$before" ] || { log "a refused comment still planned ($before before, $after after)"; rc=1; }
  [ "$(statuses "$main_sha" terragucci/apply)" = "$applied_before" ] || { log "main gained an apply status from a comment"; rc=1; }
  [ "$(remote_head "$repo" main)" = "$main_sha" ] || { log "main moved"; rc=1; }
  drop_work "$work" 2>/dev/null || true
  [ "$rc" = 0 ] && log "atlantis plan re-planned; atlantis apply and atlantis plan -w were refused with the terragucci reasons and planned nothing"
  return "$rc"
}

