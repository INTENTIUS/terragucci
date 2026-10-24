# ── applies kept apart per root, and with choudoufu per resource ──────────
# Every binary but choudoufu applies per root: no apply job waits for
# another run's, and the backend's state lock keeps one root's applies apart.
# A choudoufu wave holds the resources its plans change, on chant/lifecycle
# (_locks/apply-rows.json), from before its apply to its end. These claims
# run on the Forgejo stack, choudoufu's on a record store bucket on floci
# behind the hold proxy (cdf_proxy_up), which holds the calls a claim names.

# A new repo $USER/<name> with Actions on, and nothing under per-root/ or the marks in floci.
rows_repo() { # name
  local repo="$USER/$1" n
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  for n in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$repo")" = 404 ] && break; sleep 1; done
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$1\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos" || return 1
  for n in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$repo")" = 200 ] && break; sleep 1; done
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
}

# The newest run on a commit, once Forgejo lists it: its id.
rows_run_id() { # repo sha
  local i id=""
  for i in $(seq 1 60); do
    id="$(api "$URL/api/v1/repos/$1/actions/runs?head_sha=$2" | jq -r '.workflow_runs[0].id // empty')"
    [ -n "$id" ] && break
    sleep 2
  done
  echo "$id"
}

rows_run_status() { api "$URL/api/v1/repos/$1/actions/runs/$2" 2>/dev/null | jq -r '.status // empty'; }

# Kill the job containers of a run that are running: what a runner that died does to an apply.
rows_kill_run() { # repo run
  local job task
  for job in $(api "$URL/api/v1/repos/$1/actions/runs/$2/jobs" 2>/dev/null | jq -r '.[] | select(.status == "running") | .task_id'); do
    for task in $(docker ps -q --filter "name=FORGEJO-ACTIONS-TASK-${job}_"); do docker kill "$task" >/dev/null 2>&1 || true; done
  done
}

# How many calls the proxy holds that it has not let through.
rows_held() { curl -fsS "$CDF_CTL/held" 2>/dev/null | jq '[.[] | select(.sent | not)] | length' 2>/dev/null || echo 0; }

# The rows file on the repo's chant/lifecycle, as JSON; {} when there is none.
rows_file() { # repo
  file_at "$1" chant/lifecycle chant/lifecycle _locks/apply-rows.json 2>/dev/null || echo '{}'
}

# Every log line of a run's jobs that matches the regex.
rows_log() { # repo run regex
  run_logs "$1" "$2" | grep -E "$3" || true
}

claim_apply/per_root() {
  # A repo of two roots, one and two, each a terraform_data whose local-exec
  # writes a mark to floci when its apply starts and another when it ends;
  # waves.canary puts one in wave 1 and two in wave 2, gate: never. The first
  # push changes two, whose apply then waits for a go mark. Once it has
  # started, a second push changes one. Its wave 1 must start applying one
  # while two's apply is still going: one's start mark lands between two's
  # start and end marks. The claim then writes the go mark, and both runs
  # must apply.
  # BREAK: the pipeline is rendered with the repo-wide scope (applyScope
  # returns repo): one apply in the repo at a time, the lock tag on Forgejo,
  # so one's apply starts only after two's ended.
  log() { echo "[smoke apply-per-root] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=per-root repo="$USER/per-root" work bucket=shop-terraform-state sha1 sha2 run1 run2 i marks k cli="$TERRAGUCCI" s1 s2 rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    break_bundle "$work/break.mjs" apply-rows.ts 'return Object.hasOwn(BINARY, name) ? BINARY[name as Binary].applyScope : "root";' 'return "repo";' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
    cli="$work/break.mjs"
  fi
  rows_repo "$name" || { log "could not make $repo"; drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || true
  for k in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=per-root" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$k" || true
  done
  mkdir -p "$work/tree"
  for k in one two; do
    mkdir -p "$work/tree/$k"
    cat >"$work/tree/$k/main.tf" <<TF
terraform {
  backend "s3" {
    bucket         = "$bucket"
    key            = "per-root/$k.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

# Marks this root's apply in floci; two's second apply waits for the claim's go mark.
resource "terraform_data" "slow" {
  triggers_replace = file("\${path.module}/rev.txt")
  provisioner "local-exec" {
    command = <<-SH
      mark() { node -e "fetch(process.env.AWS_ENDPOINT_URL + '/$bucket/per-root-marks/' + Date.now() + '-$k-' + process.argv[1], { method: 'PUT', body: 'x' })" "\$1"; }
      mark start
      if [ "$k" = two ] && [ "\$(cat rev.txt)" = 2 ]; then
        node -e "(async () => { for (let i = 0; i < 300; i++) { if ((await fetch(process.env.AWS_ENDPOINT_URL + '/$bucket/per-root-go')).ok) return; await new Promise((r) => setTimeout(r, 1000)); } })()"
      else
        sleep 5
      fi
      mark end
    SH
  }
}
TF
    echo 1 >"$work/tree/$k/rev.txt"
  done
  printf 'forge: forgejo\nbinary: tofu\ngate: never\nwaves:\n  canary:\n    - one\n' >"$work/tree/terragucci.yml"
  (cd "$work/tree" && "$cli" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    grep -q 'terragucci-apply-lock' "$work/tree/.forgejo/workflows/terragucci.yml" || { log "the BREAK pipeline holds no lock tag, so BREAK proves nothing"; drop_work "$work"; return 0; }
  else
    ! grep -qE 'terragucci-apply-lock|group: terragucci-apply-' "$work/tree/.forgejo/workflows/terragucci.yml" || { log "the pipeline still serializes its apply jobs"; rc=1; }
  fi
  sha1="$(push_tree "$work/tree" "$repo" main "per-root: both roots")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha1" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | tail -40 >&2; log "the first apply of both roots ended $RUN_STATUS"; drop_work "$work"; return 1; }
  for k in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=per-root-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$k" || true; done
  marks_now() { curl -fsS "$FLOCI/$bucket?list-type=2&prefix=per-root-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' '; }
  # 1. The first push changes two; its apply starts and waits.
  echo 2 >"$work/tree/two/rev.txt"
  sha1="$(push_tree "$work/tree" "$repo" main "per-root: two changes")" || { drop_work "$work"; return 1; }
  run1="$(rows_run_id "$repo" "$sha1")"
  for i in $(seq 1 150); do case " $(marks_now)" in *" two-start "*) break ;; esac; sleep 2; done
  case " $(marks_now)" in *" two-start "*) ;; *) log "two's apply never started (run ${run1:-none}: $(rows_run_status "$repo" "${run1:-0}"))"; curl -fsS -o /dev/null -X PUT --data x "$FLOCI/$bucket/per-root-go" || true; drop_work "$work"; return 1 ;; esac
  log "two is applying in run $run1"
  # 2. The second push changes one, while two is still applying.
  echo 2 >"$work/tree/one/rev.txt"
  sha2="$(push_tree "$work/tree" "$repo" main "per-root: one changes")" || { curl -fsS -o /dev/null -X PUT --data x "$FLOCI/$bucket/per-root-go" || true; drop_work "$work"; return 1; }
  run2="$(rows_run_id "$repo" "$sha2")"
  for i in $(seq 1 120); do case " $(marks_now)" in *" one-start "*) break ;; esac; sleep 2; done
  log "marks before the go: $(marks_now)"
  curl -fsS -o /dev/null -X PUT --data x "$FLOCI/$bucket/per-root-go" || { log "could not write the go mark"; rc=1; }
  wait_run "$repo" "$sha1" || rc=1; s1="$RUN_STATUS"
  wait_run "$repo" "$sha2" || rc=1; s2="$RUN_STATUS"
  marks="$(marks_now)"
  log "marks in key order: $marks; run $run1 $s1, run $run2 $s2"
  [ "$s1" = success ] || { print_logs "$repo" "$run1" | tail -30 >&2; log "the first push's run ended $s1"; rc=1; }
  [ "$s2" = success ] || { print_logs "$repo" "$run2" | tail -30 >&2; log "the second push's run ended $s2"; rc=1; }
  # Keys sort by millisecond, so the listing is the order they happened in.
  case "$marks" in
    "two-start one-start one-end two-end "|"two-start one-start two-end one-end ") ;;
    *) log "one did not start applying while two was applying: the applies ran one after the other"; rc=1 ;;
  esac
  drop_work "$work"
  [ $rc = 0 ] && log "the second push applied one while the first was still applying two, and both runs applied"
  return $rc
}

claim_apply/stand_down() {
  # A repo of two roots in two waves, slow (wave 1, waves.canary) and two
  # (wave 2), each a terraform_data whose local-exec writes a mark to floci
  # naming its root and revision when its apply starts. The first push moves
  # both to revision 2, and slow's apply then waits for a go mark. Once it
  # has started, a second push moves two to revision 3, and the claim writes
  # the go mark. The first push's wave 2 then finds the newer push on main and
  # stands down: two never applies revision 2, its terragucci/apply says
  # superseded by a newer push, and the second push applies revision 3.
  # BREAK: the pushed pipeline's apply jobs lose both stand-down checks (the
  # tip check at the top of each wave and tf-apply's --stand-down), so the
  # first push's wave 2 applies revision 2 after the newer push landed.
  log() { echo "[smoke apply-stand-down] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=stand-down repo="$USER/stand-down" work bucket=shop-terraform-state wf sha1 sha2 run1 i k marks st s1 s2 rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  rows_repo "$name" || { log "could not make $repo"; drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || true
  for k in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=stand-down" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$k" || true
  done
  mkdir -p "$work/tree"
  for k in slow two; do
    mkdir -p "$work/tree/$k"
    cat >"$work/tree/$k/main.tf" <<TF
terraform {
  backend "s3" {
    bucket         = "$bucket"
    key            = "stand-down/$k.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

# Marks this root's apply in floci, by revision; slow's second apply waits for the claim's go mark.
resource "terraform_data" "rev" {
  triggers_replace = file("\${path.module}/rev.txt")
  provisioner "local-exec" {
    command = <<-SH
      rev="\$(cat rev.txt)"
      node -e "fetch(process.env.AWS_ENDPOINT_URL + '/$bucket/stand-down-marks/' + Date.now() + '-$k-' + process.argv[1] + '-start', { method: 'PUT', body: 'x' })" "\$rev"
      if [ "$k" = slow ] && [ "\$rev" = 2 ]; then
        node -e "(async () => { for (let i = 0; i < 300; i++) { if ((await fetch(process.env.AWS_ENDPOINT_URL + '/$bucket/stand-down-go')).ok) return; await new Promise((r) => setTimeout(r, 1000)); } })()"
      fi
    SH
  }
}
TF
    echo 1 >"$work/tree/$k/rev.txt"
  done
  printf 'forge: forgejo\nbinary: tofu\ngate: never\nwaves:\n  canary:\n    - slow\n' >"$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q -- '--stand-down' "$wf" && grep -qF '"$tip" != "${GITHUB_SHA:-}"' "$wf" || { log "the pipeline's apply jobs do not check for a newer push"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    perl -pi -e 's/ --stand-down//g; s/if \[ -n "\$tip" \] && \[ "\$tip" != "\$\{GITHUB_SHA:-\}" \]; then/if false; then/g' "$wf"
    ! grep -q -- '--stand-down' "$wf" && ! grep -qF '"$tip" != "${GITHUB_SHA:-}"' "$wf" || { log "the BREAK pipeline still checks for a newer push"; drop_work "$work"; return 1; }
  fi
  sha1="$(push_tree "$work/tree" "$repo" main "stand-down: both roots")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha1" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | tail -40 >&2; log "the first apply of both roots ended $RUN_STATUS"; drop_work "$work"; return 1; }
  for k in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=stand-down-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$k" || true; done
  marks_now() { curl -fsS "$FLOCI/$bucket?list-type=2&prefix=stand-down-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' '; }
  go() { curl -fsS -o /dev/null -X PUT --data x "$FLOCI/$bucket/stand-down-go"; }
  # 1. The first push moves both roots; its wave 1 starts applying slow and waits.
  echo 2 >"$work/tree/slow/rev.txt"; echo 2 >"$work/tree/two/rev.txt"
  sha1="$(push_tree "$work/tree" "$repo" main "stand-down: revision 2")" || { drop_work "$work"; return 1; }
  run1="$(rows_run_id "$repo" "$sha1")"
  for i in $(seq 1 150); do case " $(marks_now)" in *" slow-2-start "*) break ;; esac; sleep 2; done
  case " $(marks_now)" in *" slow-2-start "*) ;; *) log "slow's apply never started (run ${run1:-none}: $(rows_run_status "$repo" "${run1:-0}"))"; go || true; drop_work "$work"; return 1 ;; esac
  log "the first push's wave 1 is applying slow in run $run1"
  # 2. The second push lands on main while that wave is still applying, then slow is let finish.
  echo 3 >"$work/tree/two/rev.txt"
  sha2="$(push_tree "$work/tree" "$repo" main "stand-down: revision 3 of two")" || { go || true; drop_work "$work"; return 1; }
  go || { log "could not write the go mark"; rc=1; }
  wait_run "$repo" "$sha1" || rc=1; s1="$RUN_STATUS"
  wait_run "$repo" "$sha2" || rc=1; s2="$RUN_STATUS"
  marks="$(marks_now)"
  st="$(api "$URL/api/v1/repos/$repo/commits/$sha1/statuses" | jq -r '[.[] | select(.context == "terragucci/apply")] | sort_by(.id) | last | .status + ":" + .description')"
  log "marks in key order: $marks; first push: run $run1 $s1, terragucci/apply $st; second push: $s2"
  run_logs "$repo" "$run1" | grep -m2 'standing down' | sed 's/^/[first push] /' >&2 || true
  [ "$s1" = success ] || { print_logs "$repo" "$run1" | tail -30 >&2; log "the first push's run ended $s1"; rc=1; }
  [ "$s2" = success ] || { print_logs "$repo" "$RUN_ID" | tail -30 >&2; log "the second push's run ended $s2"; rc=1; }
  case " $marks" in *" two-2-start "*) log "the first push's wave 2 applied two at revision 2 after the newer push landed: it did not stand down"; rc=1 ;; esac
  case " $marks" in *" two-3-start "*) ;; *) log "the second push did not apply two at revision 3"; rc=1 ;; esac
  [ "$st" = "success:superseded by a newer push" ] || { log "the first push's terragucci/apply does not say it was superseded"; rc=1; }
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/stand-down-go" || true
  drop_work "$work"
  [ $rc = 0 ] && log "the first push's wave 2 stood down once the second push landed, and the second push applied two at revision 3"
  return $rc
}

# A choudoufu estate in one root, estate/: a live block naming the estate and
# the record store bucket, and the resources given.
rows_estate() { # dir estate resources-hcl
  mkdir -p "$1/estate"
  cat >"$1/estate/main.tf" <<HCL
terraform {
  live {
    estate = "$2"

    record_store "s3" {
      bucket = "$CDF_RECORDS"
    }

    retry {
      max_attempts = 1
    }
  }
}
$3
HCL
  printf '.terraform/\n.terraform.lock.hcl\n.tofu-records/\nterragucci-report/\n' >"$1/.gitignore"
}

rows_data() { # left right -> two terraform_data
  printf 'resource "terraform_data" "left" {\n  input = "%s"\n}\n\nresource "terraform_data" "right" {\n  input = "%s"\n}\n' "$1" "$2"
}

# An SQS queue, whose visibility timeout the provider reads back from the API.
rows_queue() { # name seconds
  cat <<HCL
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_sqs_queue" "q" {
  name                       = "$1"
  visibility_timeout_seconds = $2
}
HCL
}

# The queue's visibility timeout in floci.
rows_visibility() { # queue
  local url
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$1\"}" | jq -r '.QueueUrl // empty')" || return 0
  [ -n "$url" ] || return 0
  sqs GetQueueAttributes "{\"QueueUrl\":\"$url\",\"AttributeNames\":[\"VisibilityTimeout\"]}" | jq -r '.Attributes.VisibilityTimeout // empty'
}

claim_choudoufu/rows_overlap() {
  # A repo of one choudoufu estate on the Forgejo stack, two terraform_data,
  # left and right, applied at left-0 and right-0; gate: never. The proxy
  # holds every record write of the estate. A first push sets left to
  # left-1; its wave holds left and reaches its record write. A second push
  # sets right to right-2 and leaves left as the estate holds it, so its plan
  # changes right alone: its wave must hold right beside the first wave and
  # reach its own record write while the first is still held. Both writes are
  # then let through, both runs must apply, the records hold left-1 and
  # right-2, neither wave waited, and no row is left held.
  # BREAK: the pipeline is rendered with the repo-wide scope, so the second
  # push's wave waits for the lock tag the first holds and never reaches its
  # write while the first is held.
  log() { echo "[smoke cdf-rows-overlap] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=cdf-rows-overlap repo="$USER/cdf-rows-overlap" work estate sha1 sha2 run1 run2 i held=0 cli="$TERRAGUCCI" s1 s2 values ev rc=0
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    break_bundle "$work/break.mjs" apply-rows.ts 'return Object.hasOwn(BINARY, name) ? BINARY[name as Binary].applyScope : "root";' 'return "repo";' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
    cli="$work/break.mjs"
  fi
  estate="smoke-rows-overlap-$(date +%s)-$$"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  rows_repo "$name" || { log "could not make $repo"; cdf_down "$work"; return 1; }
  mkdir -p "$work/tree"
  rows_estate "$work/tree" "$estate" "$(rows_data left-0 right-0)"
  printf 'forge: forgejo\nbinary: choudoufu\ngate: never\nenv:\n  AWS_ENDPOINT_URL_S3: http://%s:4566\n' "$CDF_ALIAS" >"$work/tree/terragucci.yml"
  (cd "$work/tree" && "$cli" init >/dev/null) || { log "init failed"; cdf_down "$work"; return 1; }
  sha1="$(push_tree "$work/tree" "$repo" main "cdf-rows-overlap: left-0 right-0")" || { cdf_down "$work"; return 1; }
  wait_run "$repo" "$sha1" || { cdf_down "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | tail -40 >&2; log "the first apply ended $RUN_STATUS"; cdf_down "$work"; return 1; }
  values="$(cdf_values "$estate")"
  [ "$values" = "left-0 right-0" ] || { log "after the first apply the estate holds '$values', not left-0 and right-0"; cdf_down "$work"; return 1; }
  cdf_hold "^/$CDF_RECORDS/tofu-records/$estate/terraform_data/" left-1,right-2 || { log "the proxy did not take the hold"; cdf_down "$work"; return 1; }
  # 1. The first push changes left, and its wave reaches its record write.
  rows_estate "$work/tree" "$estate" "$(rows_data left-1 right-0)"
  sha1="$(push_tree "$work/tree" "$repo" main "cdf-rows-overlap: left-1")" || { cdf_down "$work"; return 1; }
  run1="$(rows_run_id "$repo" "$sha1")"
  for i in $(seq 1 150); do [ "$(rows_held)" -ge 1 ] && break; sleep 2; done
  [ "$(rows_held)" -ge 1 ] || { log "the first push's wave never reached its record write (run ${run1:-none}: $(rows_run_status "$repo" "${run1:-0}"))"; curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true; cdf_down "$work"; return 1; }
  log "run $run1 holds left and its record write is held"
  # 2. The second push changes right alone, while the first is still applying.
  rows_estate "$work/tree" "$estate" "$(rows_data left-0 right-2)"
  sha2="$(push_tree "$work/tree" "$repo" main "cdf-rows-overlap: right-2")" || { curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true; cdf_down "$work"; return 1; }
  run2="$(rows_run_id "$repo" "$sha2")"
  for i in $(seq 1 120); do
    held="$(rows_held)"
    [ "$held" -ge 2 ] && break
    case "$(rows_run_status "$repo" "${run2:-0}")" in success|failure|cancelled|skipped) break ;; esac
    sleep 2
  done
  log "record writes held while both runs were applying: $(curl -fsS "$CDF_CTL/held" | jq -c '[.[] | {seq, marker}]')"
  [ "$held" -ge 2 ] || { log "only $held write reached the store while the other was in flight: the second wave waited for the first"; rc=1; }
  curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=1,2" || true
  curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
  wait_run "$repo" "$sha1" || rc=1; s1="$RUN_STATUS"
  wait_run "$repo" "$sha2" || rc=1; s2="$RUN_STATUS"
  if [ $rc = 0 ]; then
    [ "$s1" = success ] || { print_logs "$repo" "$run1" | tail -30 >&2; log "the first push's run ended $s1"; rc=1; }
    [ "$s2" = success ] || { print_logs "$repo" "$run2" | tail -30 >&2; log "the second push's run ended $s2"; rc=1; }
    values="$(cdf_values "$estate")"
    [ "$values" = "left-1 right-2" ] || { log "the estate holds '$values', not left-1 and right-2"; rc=1; }
    # Overlap in time: both writes arrived before either was answered.
    ev="$(curl -fsS "$CDF_CTL/events" | jq -c '[.[] | select(.seq != null)] | {arrived: (map(.arrived) | max), answered: (map(.answered) | min)}')"
    log "the held writes: last arrived and first answered (epoch ms): $ev"
    [ "$(jq '.arrived < .answered' <<<"$ev")" = true ] || { log "the second write arrived after the first was answered"; rc=1; }
    [ -n "$(rows_log "$repo" "$run2" 'holding the resource its plans change')" ] || { log "the second push's wave did not say it held the resource it changes"; rc=1; }
    [ -z "$(rows_log "$repo" "$run2" 'waiting for it')" ] || { log "the second push's wave waited for the first"; rc=1; }
    [ "$(rows_file "$repo" | jq '(.rows // {}) | length')" = 0 ] || { log "rows are still held: $(rows_file "$repo" | jq -c .rows)"; rc=1; }
  fi
  cdf_down "$work"
  [ $rc = 0 ] && log "the second push's wave held right and reached its record write while the first still held left and its write; both applied, the estate holds $values, and no row is left held"
  return $rc
}

claim_choudoufu/rows_wait() {
  # One choudoufu estate of one SQS queue on floci, visibility timeout 30,
  # applied. Two checkouts of a Forgejo repo set it to 411 and 422; each runs
  # tf-apply wave 1 in the choudoufu CI image, with every AWS call through
  # the proxy and its rows on the repo's chant/lifecycle. The proxy holds
  # SetQueueAttributes. a starts, and its call is held while its wave holds
  # the queue. b starts: it must wait for a's run, and make no
  # SetQueueAttributes call while a's is held, as the proxy's request log
  # shows. a's call is then let through: b must plan again once a let go, and
  # its call must arrive after a's was answered. Both apply, and the queue
  # ends at b's 422.
  # BREAK: the waves hold no rows (applyScope returns root), so b's call
  # reaches the API while a's is held.
  log() { echo "[smoke cdf-rows-wait] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=cdf-rows-wait repo="$USER/cdf-rows-wait" work estate queue bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" inner host i side held got ev rc=0
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    break_bundle "$work/terragucci.mjs" apply-rows.ts 'return Object.hasOwn(BINARY, name) ? BINARY[name as Binary].applyScope : "root";' 'return "root";' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
    bundle="$work/terragucci.mjs"
  fi
  estate="smoke-rows-wait-$(date +%s)-$$"
  queue="tgs-rows-wait-$(date +%s)-$$"
  inner="http://${USER}:${TOKEN}@forgejo:3000/$repo.git"
  host="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  rows_wave() { # side log
    run_copied --rm --name "$CDF_ALIAS-$1" --network "${TG_NETWORK:-terragucci}" -v "$work/$1:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_LOCK_POLL=2 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$(image_tag choudoufu)" terragucci stage tf-apply --wave 1 --layers estate --binary choudoufu --gate never >"$2" 2>&1
  }
  rows_commit() { git -C "$1" add -A && git -C "$1" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "$2"; }
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  rows_repo "$name" || { log "could not make $repo"; cdf_down "$work"; return 1; }
  mkdir -p "$work/tree"
  rows_estate "$work/tree" "$estate" "$(rows_queue "$queue" 30)"
  push_tree "$work/tree" "$repo" main "cdf-rows-wait: the queue at 30" >/dev/null || { cdf_down "$work"; return 1; }
  for side in a b; do
    git clone -q "$host" "$work/$side" && git -C "$work/$side" remote set-url origin "$inner" || { log "could not clone $repo"; cdf_down "$work"; return 1; }
  done
  if ! rows_wave a "$work/seed.log"; then log "the first apply of the queue failed"; tail -20 "$work/seed.log" >&2; cdf_down "$work"; return 1; fi
  clean_mounted "$work/a"
  [ "$(rows_visibility "$queue")" = 30 ] || { log "after the first apply the queue's visibility timeout is '$(rows_visibility "$queue")', not 30"; cdf_down "$work"; return 1; }
  rows_estate "$work/a" "$estate" "$(rows_queue "$queue" 411)"; rows_commit "$work/a" "a: 411"
  rows_estate "$work/b" "$estate" "$(rows_queue "$queue" 422)"; rows_commit "$work/b" "b: 422"
  curl -fsS -o /dev/null -X POST -G "$CDF_CTL/hold" --data-urlencode 're=^/$' --data-urlencode methods=POST \
    --data-urlencode 'target=SetQueueAttributes' --data-urlencode 'markers="411","422"' || { log "the proxy did not take the hold"; cdf_down "$work"; return 1; }
  # 1. a holds the queue, and its call is held.
  ( rows_wave a "$work/a.log" && echo 0 >"$work/a.rc" || echo $? >"$work/a.rc" ) >/dev/null 2>&1 &
  for i in $(seq 1 120); do [ "$(rows_held)" -ge 1 ] && break; [ -s "$work/a.rc" ] && break; sleep 2; done
  [ "$(rows_held)" -ge 1 ] || { log "a's SetQueueAttributes never arrived"; tail -20 "$work/a.log" >&2; curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true; wait; cdf_down "$work"; return 1; }
  log "a's SetQueueAttributes is held"
  # 2. b waits for a's run, and calls nothing while a's call is held.
  ( rows_wave b "$work/b.log" && echo 0 >"$work/b.rc" || echo $? >"$work/b.rc" ) >/dev/null 2>&1 &
  for i in $(seq 1 120); do
    grep -q 'waiting for it' "$work/b.log" 2>/dev/null && break
    [ "$(rows_held)" -ge 2 ] && break
    [ -s "$work/b.rc" ] && break
    sleep 2
  done
  sleep 4
  held="$(rows_held)"
  log "b: $(grep -m1 -E 'waiting for it|holding the' "$work/b.log" 2>/dev/null | cut -c1-200); calls held: $held"
  [ "$held" = 1 ] || { log "b's SetQueueAttributes reached the API while a's was held"; rc=1; }
  grep -q 'waiting for it' "$work/b.log" || { log "b did not wait for a's run"; rc=1; }
  # 3. a's call goes through; b plans again and applies after it.
  curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=1" || true
  curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true
  for i in $(seq 1 240); do [ -s "$work/a.rc" ] && [ -s "$work/b.rc" ] && break; sleep 2; done
  for side in a b; do [ -s "$work/$side.rc" ] || { docker rm -f "$CDF_ALIAS-$side" >/dev/null 2>&1 || true; echo 124 >"$work/$side.rc"; }; done
  wait
  for side in a b; do
    [ "$(cat "$work/$side.rc")" = 0 ] || { log "the wave in checkout $side did not apply (exit $(cat "$work/$side.rc"))"; tail -20 "$work/$side.log" >&2; rc=1; }
  done
  ev="$(curl -fsS "$CDF_CTL/events" | jq -c '[.[] | select(.target | test("SetQueueAttributes"))] | map({marker, arrived, answered, status})')"
  log "SetQueueAttributes calls: $ev"
  if [ $rc = 0 ]; then
    [ "$(jq '[.[] | select(.marker == "\"411\"")] | length' <<<"$ev")" = 1 ] || { log "a made other than one SetQueueAttributes call"; rc=1; }
    [ "$(jq '([.[] | select(.marker == "\"422\"")][0].arrived) >= ([.[] | select(.marker == "\"411\"")][0].answered)' <<<"$ev")" = true ] \
      || { log "b's SetQueueAttributes arrived before a's was answered"; rc=1; }
    grep -q 'planning again' "$work/b.log" || { log "b did not plan again once a let go"; rc=1; }
    got="$(rows_visibility "$queue")"
    [ "$got" = 422 ] || { log "the queue's visibility timeout is '$got', not b's 422"; rc=1; }
  fi
  cdf_down "$work"
  [ $rc = 0 ] && log "b waited while a's SetQueueAttributes was held and called nothing; once a let go it planned again, its call came after a's, and the queue holds 422"
  return $rc
}

claim_drift/choudoufu() {
  # A repo of one choudoufu estate of one SQS queue on floci, visibility
  # timeout 30, under live resource markers, with drift set, applied. init
  # takes drift there. The queue's timeout is then set to 77 outside
  # choudoufu. tf-drift plans the root in full, since choudoufu refuses a
  # refresh-only plan under live markers, and must exit 0 with the root's one
  # change in its report, the queue's visibility_timeout_seconds, and one open
  # drift issue naming the root and the attribute. The timeout is set back to
  # 30 outside choudoufu, and the next run finds nothing and closes the issue.
  # BREAK: drift keeps the refresh-only plan on the live root, which choudoufu
  # refuses: the stage fails and no issue names the change.
  log() { echo "[smoke cdf-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=cdf-drift repo="$USER/cdf-drift" work estate queue bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" inner host code rc=0 issues body url
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    break_bundle "$work/terragucci.mjs" report/stage.ts 'drift && !live.has(root) ? ["-refresh-only"]' 'drift ? ["-refresh-only"]' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
    bundle="$work/terragucci.mjs"
  fi
  estate="smoke-drift-$(date +%s)-$$"
  queue="tgs-drift-$(date +%s)-$$"
  inner="http://${USER}:${TOKEN}@forgejo:3000/$repo.git"
  host="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  open_issues() { api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]'; }
  cdf_visibility() { # seconds
    url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
    [ -n "$url" ] && sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"$1\"}}" >/dev/null
  }
  cdf_in() { # log, command...
    local out="$1"; shift
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e "GITHUB_REPOSITORY=$repo" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN" \
      "$(image_tag choudoufu)" "$@" >"$out" 2>&1
  }
  cdf_drift_run() { # log -> exit code in code
    code=0
    cdf_in "$1" terragucci stage tf-drift --binary choudoufu --forge forgejo --layers estate --report-url "http://forgejo:3000/$repo/actions" || code=$?
    clean_mounted "$work/tree"
  }
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  rows_repo "$name" || { log "could not make $repo"; cdf_down "$work"; return 1; }
  mkdir -p "$work/seed"
  rows_estate "$work/seed" "$estate" "$(rows_queue "$queue" 30)"
  printf 'binary: choudoufu\nforge: forgejo\ndrift: "17 4 * * *"\n' >"$work/seed/terragucci.yml"
  # init takes drift on a root under live resource markers.
  code=0
  (cd "$work/seed" && "$TERRAGUCCI" init --dry-run --forge forgejo >"$work/init.log" 2>&1) || code=$?
  [ "$code" = 0 ] || { log "init with drift on a live root exited $code: $(tail -1 "$work/init.log")"; cdf_down "$work"; return 1; }
  push_tree "$work/seed" "$repo" main "cdf-drift: the queue at 30" >/dev/null || { cdf_down "$work"; return 1; }
  git clone -q "$host" "$work/tree" && git -C "$work/tree" remote set-url origin "$inner" || { log "could not clone $repo"; cdf_down "$work"; return 1; }
  if ! cdf_in "$work/apply.log" sh -c 'cd estate && choudoufu init -input=false -no-color >/dev/null && choudoufu apply -auto-approve -input=false -no-color'; then
    log "the first apply of the queue failed"; tail -20 "$work/apply.log" >&2; clean_mounted "$work/tree"; cdf_down "$work"; return 1
  fi
  clean_mounted "$work/tree"
  [ "$(rows_visibility "$queue")" = 30 ] || { log "after the apply the queue's visibility timeout is '$(rows_visibility "$queue")', not 30"; cdf_down "$work"; return 1; }
  cdf_visibility 77 || { log "could not change the queue outside choudoufu"; cdf_down "$work"; return 1; }
  log "set $queue's visibility timeout to 77 outside choudoufu"
  # 1. The change is drift: the report and one issue name the root and the attribute.
  cdf_drift_run "$work/run1.log"
  log "tf-drift exited $code: $(grep -E '^estate:' "$work/run1.log" | tail -1)"
  [ "$code" = 0 ] || { log "tf-drift exited $code, not 0"; tail -15 "$work/run1.log" >&2; rc=1; }
  local rep="$work/tree/terragucci-report/report.json"
  if [ $rc = 0 ]; then
    [ -f "$rep" ] || { log "no report"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -r '[.roots[] | .path as $p | .changes[] | "\($p) \(.address) \(.action) \([.attributes[].path] | join(","))"] | join(";")' "$rep")" = "estate aws_sqs_queue.q update visibility_timeout_seconds" ] \
      || { log "the report's drift is not the queue's visibility_timeout_seconds: $(jq -c '[.roots[] | .path as $p | .changes[] | {root: $p, address, action, attrs: [.attributes[].path]}]' "$rep")"; rc=1; }
  fi
  issues="$(open_issues)"
  [ "$(jq length <<<"$issues")" = 1 ] || { log "expected one open drift issue, found $(jq length <<<"$issues")"; rc=1; }
  body="$(jq -r '.[0].body // ""' <<<"$issues")"
  grep -qF '`estate`' <<<"$body" && grep -qF '`visibility_timeout_seconds`' <<<"$body" || { log "the issue does not name estate and visibility_timeout_seconds"; rc=1; }
  # 2. Put back outside choudoufu: no drift, and the issue closes.
  if [ $rc = 0 ]; then
    cdf_visibility 30 || { log "could not set the queue back"; rc=1; }
    cdf_drift_run "$work/run2.log"
    [ "$code" = 0 ] || { log "the second tf-drift exited $code, not 0"; tail -15 "$work/run2.log" >&2; rc=1; }
    [ "$(jq '[.roots[].changes[]] | length' "$rep" 2>/dev/null)" = 0 ] || { log "the second run reports drift with the queue back at 30"; rc=1; }
    [ "$(open_issues | jq length)" = 0 ] || { log "the drift issue is still open with no drift"; rc=1; }
  fi
  cdf_down "$work"
  [ $rc = 0 ] && log "init took drift; tf-drift planned the live root in full, named estate and visibility_timeout_seconds in the report and one issue, and closed it once the queue was back at 30"
  return $rc
}

claim_choudoufu/rows_takeover() {
  # A repo of one choudoufu estate of one SQS queue on the Forgejo stack,
  # visibility timeout 30, applied; gate: never, TG_LOCK_POLL 3. The proxy
  # holds SetQueueAttributes. A first push sets 411: its wave holds the queue
  # and its call is held. A second push sets 422: its wave plans against 30
  # and waits for the first run. The proxy then holds the first run's next
  # call too and lets its SetQueueAttributes through, so 411 lands, and the
  # first run's job is killed while it still holds the queue. Nobody unlocks
  # anything. The second run must take the row over from the run that is
  # gone, and the apply's re-read must refuse its plan, which 411 made stale
  # ("The approved plan no longer matches the live system"), before any
  # SetQueueAttributes of its own: the queue stays at 411. No row is left held.
  # BREAK: the waves never find a holder gone (forgeLiveness answers alive),
  # so the second run waits on and the claim catches it never taking over.
  log() { echo "[smoke cdf-rows-takeover] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=cdf-rows-takeover repo="$USER/cdf-rows-takeover" work estate queue sha1 sha2 run1 run2 i s1 s2 ev seq killed log2 got rc=0 suffix="${TG_IMAGE_SUFFIX:-}"
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    break_bundle "$work/break.mjs" apply-rows.ts 'return ["success", "failure", "cancelled", "skipped", "completed"].includes(status) ? "dead" : "alive";' 'return "alive";' \
      && suffix="$(break_image "$work/break.mjs" choudoufu)" || { log "the BREAK image did not build"; drop_work "$work"; return 1; }
  fi
  estate="smoke-rows-takeover-$(date +%s)-$$"
  queue="tgs-rows-takeover-$(date +%s)-$$"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  rows_repo "$name" || { log "could not make $repo"; cdf_down "$work"; return 1; }
  mkdir -p "$work/tree"
  rows_estate "$work/tree" "$estate" "$(rows_queue "$queue" 30)"
  printf 'forge: forgejo\nbinary: choudoufu\ngate: never\nenv:\n  AWS_ENDPOINT_URL_S3: http://%s:4566\n  AWS_ENDPOINT_URL_SQS: http://%s:4566\n  TG_LOCK_POLL: "3"\n' "$CDF_ALIAS" "$CDF_ALIAS" >"$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; cdf_down "$work"; return 1; }
  ends() { case "$(rows_run_status "$repo" "$1")" in success|failure|cancelled|skipped) return 0 ;; esac; return 1; }
  cleanup() { curl -fsS -o /dev/null -X POST "$CDF_CTL/open" || true; for r in "$@"; do [ -n "$r" ] && rows_kill_run "$repo" "$r"; done; cdf_down "$work"; }
  sha1="$(TG_IMAGE_SUFFIX="$suffix" push_tree "$work/tree" "$repo" main "cdf-rows-takeover: the queue at 30")" || { cdf_down "$work"; return 1; }
  wait_run "$repo" "$sha1" || { cdf_down "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" | tail -40 >&2; log "the first apply ended $RUN_STATUS"; cdf_down "$work"; return 1; }
  [ "$(rows_visibility "$queue")" = 30 ] || { log "after the first apply the queue's visibility timeout is '$(rows_visibility "$queue")', not 30"; cdf_down "$work"; return 1; }
  curl -fsS -o /dev/null -X POST -G "$CDF_CTL/hold" --data-urlencode 're=^/$' --data-urlencode methods=POST \
    --data-urlencode 'target=SetQueueAttributes' --data-urlencode 'markers="411","422"' || { log "the proxy did not take the hold"; cdf_down "$work"; return 1; }
  # 1. The first push holds the queue, and its call is held.
  rows_estate "$work/tree" "$estate" "$(rows_queue "$queue" 411)"
  sha1="$(TG_IMAGE_SUFFIX="$suffix" push_tree "$work/tree" "$repo" main "cdf-rows-takeover: 411")" || { cleanup; return 1; }
  run1="$(rows_run_id "$repo" "$sha1")"
  for i in $(seq 1 150); do [ "$(rows_held)" -ge 1 ] && break; ends "${run1:-0}" && break; sleep 2; done
  [ "$(rows_held)" -ge 1 ] || { log "the first run's SetQueueAttributes never arrived (run ${run1:-none}: $(rows_run_status "$repo" "${run1:-0}"))"; cleanup "$run1"; return 1; }
  log "run $run1 holds the queue and its SetQueueAttributes is held"
  # 2. The second push plans against 30 and waits for the first run.
  rows_estate "$work/tree" "$estate" "$(rows_queue "$queue" 422)"
  sha2="$(TG_IMAGE_SUFFIX="$suffix" push_tree "$work/tree" "$repo" main "cdf-rows-takeover: 422")" || { cleanup "$run1"; return 1; }
  run2="$(rows_run_id "$repo" "$sha2")"
  for i in $(seq 1 120); do
    [ -n "$(rows_log "$repo" "${run2:-0}" 'waiting for it')" ] && break
    ends "${run2:-0}" && break
    sleep 3
  done
  [ -n "$(rows_log "$repo" "${run2:-0}" 'waiting for it')" ] || { log "the second run never waited for the first (run ${run2:-none}: $(rows_run_status "$repo" "${run2:-0}"))"; cleanup "$run1" "$run2"; return 1; }
  log "run $run2 waits for run $run1"
  # 3. 411 lands, the first run's next call is held, and its job is killed.
  curl -fsS -o /dev/null -X POST -G "$CDF_CTL/hold" --data-urlencode 're=.' --data-urlencode methods=POST,PUT --data-urlencode 'markers="411","422"' || true
  curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=1" || true
  for i in $(seq 1 60); do [ "$(rows_held)" -ge 1 ] && break; sleep 1; done
  got="$(rows_visibility "$queue")"
  [ "$got" = 411 ] || { log "the first run's call did not land: the queue is at '$got'"; cleanup "$run1" "$run2"; return 1; }
  rows_kill_run "$repo" "$run1"
  # What is held once the first run's container is gone is all the first
  # run's: the second takes over only after the forge says the first ended.
  killed="$(curl -fsS "$CDF_CTL/held" | jq -r '[.[] | select(.sent | not) | .seq | tostring] | join(" ")')"
  for i in $(seq 1 60); do ends "$run1" && break; sleep 2; done
  log "run $run1, killed after 411 landed while it held the queue: $(rows_run_status "$repo" "$run1")"
  ends "$run1" || { log "run $run1 did not end after its job was killed"; cleanup "$run1" "$run2"; return 1; }
  # Hold only SetQueueAttributes again. What the killed run left held is
  # never let through. What the second run sent once it took over, under the
  # wide hold, goes on: dropped, its record store reads the 503 as an outage.
  curl -fsS -o /dev/null -X POST -G "$CDF_CTL/hold" --data-urlencode 're=^/$' --data-urlencode methods=POST \
    --data-urlencode 'target=SetQueueAttributes' --data-urlencode 'markers="411","422"' || true
  for seq in $killed; do curl -fsS -o /dev/null -X POST "$CDF_CTL/drop?seq=$seq" || true; done
  seq="$(curl -fsS "$CDF_CTL/held" | jq -r '[.[] | select(.sent | not) | .seq | tostring] | join(",")')"
  [ -z "$seq" ] || curl -fsS -o /dev/null -X POST "$CDF_CTL/release?order=$seq" || true
  # 4. The second run takes the row over, and its apply's re-read refuses.
  for i in $(seq 1 60); do ends "$run2" && break; sleep 3; done
  if ! ends "$run2"; then
    log "run $run2 never took the queue over from run $run1, which is gone"
    rows_log "$repo" "$run2" 'waiting for it|taking|takes them over' | tail -3 >&2
    cleanup "$run2"; return 1
  fi
  s2="$(rows_run_status "$repo" "$run2")"
  log2="$(run_logs "$repo" "$run2")"
  grep -q "run $run1 held resources and is gone; this wave takes them over" <<<"$log2" || { log "run $run2 did not say it took the queue over from run $run1"; rc=1; }
  grep -q 'The approved plan no longer matches the live system' <<<"$log2" || { log "run $run2's apply did not refuse the plan 411 made stale"; grep -E 'Error|FAILED|applied' <<<"$log2" | head -5 >&2; rc=1; }
  [ "$s2" = failure ] || { log "run $run2 ended $s2, not failure"; rc=1; }
  ev="$(curl -fsS "$CDF_CTL/events" | jq -c '[.[] | select(.target | test("SetQueueAttributes"))] | map({marker, status})')"
  log "SetQueueAttributes calls: $ev"
  [ "$(jq '[.[] | select(.marker == "\"422\"")] | length' <<<"$ev")" = 0 ] || { log "run $run2 called SetQueueAttributes"; rc=1; }
  got="$(rows_visibility "$queue")"
  [ "$got" = 411 ] || { log "the queue is at '$got', not the killed run's 411"; rc=1; }
  [ "$(rows_file "$repo" | jq '(.rows // {}) | length')" = 0 ] || { log "rows are still held: $(rows_file "$repo" | jq -c .rows)"; rc=1; }
  cleanup
  [ $rc = 0 ] && log "run $run2 took the queue over from run $run1, killed after 411 landed, with nothing unlocked; its apply's re-read refused the stale plan before any call, and no row is left held"
  return $rc
}

claim_note/approve_command() {
  # The gated fixture, approval ledger (the default). A pull request changes
  # canary/one; its plan note gives wave 1 the command terragucci approve
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
    noted="$(grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' <<<"$note" | head -1)"
    log "the note gives: ${noted:-no command}"
    [ -n "$noted" ] || { log "the plan note gives no terragucci approve command for wave 1"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || rc=1
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    [ -n "$merge" ] || { log "pull request $pr has no merge commit"; rc=1; }
    [ $rc = 0 ] && { wait_run "$repo" "$merge" push || rc=1; }
  fi
  if [ $rc = 0 ]; then
    waited="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1)"
    log "the merge waits for: ${waited:-nothing}"
    [ "$waited" = "$noted" ] || { log "the merge's wave 1 asks for another digest than the note gave"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver ${BREAK:+--dry-run} 2>&1)" || { log "terragucci approve failed: $out"; rc=1; }
    log "terragucci approve: $(tr '\n' ' ' <<<"$out")"
    grep -qF -- "approve tf-apply wave-1 --plan ${noted##* --plan }" <<<"$out" || { log "terragucci approve did not approve the digest the note gave"; rc=1; }
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

claim_refuse/approve_plan() {
  # The gated fixture, approval ledger. A push to main waits at wave 1 for
  # digest D0; a second push changes canary/one, and wave 1 now waits for D1.
  # In a clone, terragucci approve --plan D0, the digest a person read before
  # the plans moved, must approve nothing: it exits 1, names D1 as the digest
  # waiting, and chant/lifecycle gets no approval of wave 1.
  # BREAK: the approval names D1, the digest waiting, so it is recorded.
  log() { echo "[smoke approve-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approve-plan" sha d0 d1 pinned out code=0 resolved rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approve-plan || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approve-plan: first")"
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && d0="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1 | sed 's/.* --plan //')"
  [ -n "${d0:-}" ] || { log "wave 1 of the first push did not wait"; rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    sha="$(push_tree "$work/tree" "$repo" main "approve-plan: canary/one moves")"
    wait_run "$repo" "$sha" || rc=1
  fi
  [ $rc = 0 ] && d1="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1 | sed 's/.* --plan //')"
  [ -n "${d1:-}" ] && [ "${d1:-}" != "${d0:-}" ] || { [ $rc = 0 ] && log "wave 1 of the second push does not wait for a new digest (${d0:-none}, then ${d1:-none})"; rc=1; }
  if [ $rc = 0 ]; then
    pinned="$d0"
    [ -z "${BREAK:-}" ] || pinned="$d1"
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --plan "$pinned" --actor smoke-approver 2>&1)" || code=$?
    log "terragucci approve --plan ${pinned}: exit $code: $(tr '\n' ' ' <<<"$out")"
    [ "$code" = 1 ] || { log "terragucci approve --plan of a stale digest exited $code, not 1"; rc=1; }
    grep -qF "waiting: wave-1 for $d1" <<<"$out" || { log "the refusal does not name the digest waiting, $d1"; rc=1; }
    git -C "$work/approver-clone" fetch -q origin chant/lifecycle || rc=1
    resolved="$(git -C "$work/approver-clone" show origin/chant/lifecycle:_gates/tf-apply.jsonl | jq -s '[.[] | select(.kind == "resolution" and .gate == "wave-1")] | length')"
    [ "$resolved" = 0 ] || { log "chant/lifecycle has $resolved approval(s) of wave 1"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the stale digest approved nothing, and the refusal named the digest waiting"
  return $rc
}

claim_approval/resume() {
  # The gated fixture, approval ledger. A pull request changes canary/one and
  # merges; wave 1 of the merge commit waits. In a clone, with FORGEJO_TOKEN
  # set to the approver's token, terragucci approve approves the wave and,
  # since Forgejo's API has no re-run, comments /terragucci apply on the
  # merged pull request as the approver. The apply-comment job runs, and
  # canary/one applies with nothing else done.
  # BREAK: --no-resume, so the approval is recorded and nothing starts: no
  # comment is posted and canary/one stays out.
  log() { echo "[smoke resume-approve] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/resume-approve" sha head pr merge out before applied i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo resume-approve || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "resume-approve: first")"
  wait_run "$repo" "$sha" || rc=1
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    head="$(push_tree "$work/tree" "$repo" change "resume-approve: change canary/one")" || rc=1
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "resume-approve: change canary/one")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || rc=1
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    [ -n "$merge" ] || { log "pull request $pr has no merge commit"; rc=1; }
    [ $rc = 0 ] && { wait_run "$repo" "$merge" push || rc=1; }
    [ $rc = 0 ] && { run_logs "$repo" "$RUN_ID" | grep -q 'terragucci approve wave-1 --plan' || { log "wave 1 of the merge commit did not wait"; rc=1; }; }
  fi
  if [ $rc = 0 ]; then
    before="$(pr_replies "$repo" "$pr")"
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && FORGEJO_TOKEN="$TOKEN" PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver ${BREAK:+--no-resume} 2>&1)" || { log "terragucci approve failed: $out"; rc=1; }
    log "terragucci approve: $(tr '\n' ' ' <<<"$out")"
    grep -qF "resumed: commented /terragucci apply on pull request $pr" <<<"$out" || { log "terragucci approve did not resume the wave on pull request $pr"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # The comment's apply-comment job answers with a reply once it ran.
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      [ "$(pr_replies "$repo" "$pr")" -gt "$before" ] && break
      [ $(( i % 20 )) = 0 ] && log "waiting for the apply-comment job's reply on pull request $pr"
      sleep 3
    done
    applied="$(gated_applied resume-approve)"
    log "after the approval: state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply after terragucci approve, with nothing else done"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "terragucci approve recorded the approval and resumed the wave, and canary/one applied"
  return $rc
}

claim_approval/resume_schedule() {
  # The gated fixture, approval ledger, apply.resume: 5, so init writes the
  # resume workflow (its cron is checked by test/resume.test.ts). A push waits
  # at wave 1. In a clone, terragucci approve --no-resume records the
  # approval and starts nothing. One run of the resume workflow, dispatched as
  # its schedule would start it, applies canary/one; wave 2 then waits at its
  # own gate. The check is made once that run ended, never by waiting on the
  # cron.
  # BREAK: nobody approves, so the dispatched run applies nothing.
  log() { echo "[smoke resume-schedule] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/resume-schedule" sha out run status deadline applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo resume-schedule || { drop_work "$work"; return 1; }
  printf 'apply:\n  resume: 5\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  [ -f "$work/tree/.forgejo/workflows/terragucci-resume.yml" ] || { log "init wrote no resume workflow"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "resume-schedule: first")"
  wait_run "$repo" "$sha" || rc=1
  [ $rc = 0 ] && { run_logs "$repo" "$RUN_ID" | grep -q 'terragucci approve wave-1 --plan' || { log "wave 1 did not wait"; rc=1; }; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver --no-resume 2>&1)" || { log "terragucci approve failed: $out"; rc=1; }
    log "terragucci approve: $(tr '\n' ' ' <<<"$out")"
  fi
  if [ $rc = 0 ]; then
    # The resume job, once, as its schedule runs it.
    dispatched() { api "$URL/api/v1/repos/$repo/actions/runs?event=workflow_dispatch&limit=50" | jq -c '.workflow_runs // []'; }
    if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
        "$URL/api/v1/repos/$repo/actions/workflows/terragucci-resume.yml/dispatches" 2>/dev/null)"; then
      run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
      deadline=$(( $(date +%s) + TIMEOUT )); status=""
      while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(dispatched | jq -r --arg r "${run:-0}" '[.[] | select($r == "0" or .id == ($r | tonumber))] | (.[0].status // "")')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
        sleep 3
      done
      log "the dispatched resume run ${run:-?} ended '${status:-unknown}'"
      [ -n "$run" ] && print_logs "$repo" "$run" 2>/dev/null | grep -E 'terragucci resume|wave [0-9]+' >&2 || true
    else
      log "Forgejo has no resume workflow to run in $repo"; rc=1
    fi
    applied="$(gated_applied resume-schedule)"
    log "after the resume run: state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected the resume run to apply canary/one"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the approval started nothing, and one run of the resume workflow applied canary/one"
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
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

claim_policy/override() {
  # policy.override at base lists smoke-approver. The first wave is denied
  # and exits 1, recording the denial; smoke-approver overrides it with
  # terragucci override, and the next wave applies app, its report naming the
  # override (who, the rules, the reason and the plan digest) and its note
  # too. Then what terragucci adds around chant's override gate, on the same
  # repo: a commit changes app, and the wave exits 1, naming policy.override
  # at base and the terragucci override command for the new plan; an
  # override by smoke-stranger, whom the list does not name, leaves it at
  # exit 1 and is refused naming policy.override; smoke-approver overrides
  # it, a commit changes app again, and the wave exits 4, applying nothing.
  # chant decides, records and spends the overrides (override-gate,
  # op-waves-run); this part holds terragucci's key, command, report and exit
  # codes around them.
  # BREAK: the config lists nobody under policy.override, so the wave records
  # no denial and nothing can be overridden.
  log() { echo "[smoke policy/override] $*" >&2; }
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
  # A new plan: the override app applied under is spent, so the wave is denied again and says who may override it, and how.
  if [ $rc = 0 ]; then
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {\n  input = "policy, after the override applied"\n}\n' > "$work/wave/app/main.tf"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "smoke: app changes after its override applied" || rc=1
  fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 1 ] || { log "the run after app changed exited $code, not 1"; rc=1; }
    grep -q "app: policy.override at base lists smoke-approver; one of them can let this plan through with:" "$work/run.log" || { log "the wave does not name policy.override at base and who it lists"; rc=1; }
    grep -q "terragucci override app --rule" "$work/run.log" || { log "the wave gives no terragucci override command for the new plan"; rc=1; }
    grep -q "after the override applied" "$work/wave/app/terraform.tfstate" && { log "app applied its new plan under the spent override"; rc=1; }
  fi
  # An override by someone policy.override does not list.
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-stranger || rc=1; fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 1 ] || { log "the run after an override by smoke-stranger exited $code, not 1"; rc=1; }
    grep -q "smoke-stranger is not listed in policy.override" "$work/run.log" || { log "the wave does not say smoke-stranger is not listed in policy.override"; rc=1; }
    grep -q "after the override applied" "$work/wave/app/terraform.tfstate" && { log "an override by smoke-stranger let app apply"; rc=1; }
  fi
  # An override of a plan that moved on: exit 4.
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ]; then
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {\n  input = "policy, moved"\n}\n' > "$work/wave/app/main.tf"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "smoke: app moves after its override" || rc=1
  fi
  if [ $rc = 0 ]; then
    code="$(policy_override_wave "$work" "$image")"
    [ "$code" = 4 ] || { log "the run after the plan moved past its override exited $code, not 4"; rc=1; }
    grep -q "policy, moved" "$work/wave/app/terraform.tfstate" && { log "an override of an earlier plan let app apply"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "smoke-approver's override let the denied wave apply and the report names it; the next plan was denied again with the command, smoke-stranger's override counted for nothing, and an override of an earlier plan made the wave exit 4"
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/$name:/projects/$name" -v "$work/stub:/stub" -w "/projects/$name" \
    -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    "${BLOB_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" sh -c 'node "/stub/$0" >>/stub/stub.log 2>&1 & i=0; until [ -s /stub/ready ] || [ $i -ge 50 ]; do sleep 0.1; i=$((i+1)); done; "$@"' "$stub" "$@"
}

claim_report/azure() {
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
  with_lock compose env TERRAGUCCI_AZURITE_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" \
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

claim_report/gcs() {
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
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" --profile blob up -d gcs >&2 || { drop_work "$work"; return 1; }
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

# ── state on GCS and Azure Blob Storage ───────────────────────────────────
# Roots whose state is on fake-gcs-server (a gcs backend) or on Azurite (an
# azurerm backend), run in the CI image as a job or a person runs them, with
# reports on floci. A gcs backend names the emulator as its
# storage_custom_endpoint, and the job's GOOGLE_OAUTH_ACCESS_TOKEN is a token
# the emulator takes. An azurerm backend names metadata_host 127.0.0.1:
# blobstate.mjs, in the job container, answers the cloud's metadata with the
# storage suffix azurite:10000, stands in for Entra ID at
# login.microsoftonline.com, and forwards devstoreaccount1.blob.azurite:10000
# to Azurite over TLS. Both names point at 127.0.0.1 inside the container,
# so no request leaves it but the hop to the emulator.

# Azurite's documented key for devstoreaccount1.
AZURITE_KEY='Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
BLOB_STATE_TENANT=7d2c0b4e-0000-4000-8000-00000000a2e1

# The emulator, up: started when it is not running, never recreated. For
# azurite, $work/stub holds blobstate.mjs and a certificate for the names it
# answers.
blob_state_up() { # work, gcs|azurite
  local work="$1" i certs="$HERE/.state/azurite-certs" name="${TG_PROJECT:-terragucci}-$2"
  mkdir -p "$work/stub"
  if [ -z "$(docker ps -q --filter "name=^${name}\$")" ]; then
    with_lock compose env TERRAGUCCI_AZURITE_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" --profile blob up -d "$2" >&2 || return 1
  fi
  if [ "$2" = gcs ]; then
    for i in $(seq 1 30); do curl -sf -o /dev/null -H 'Host: gcs:4443' "http://localhost:${TERRAGUCCI_GCS_PORT:-4453}/_internal/healthcheck" && return 0; sleep 1; done
    echo "fake-gcs-server is not answering" >&2; return 1
  fi
  for i in $(seq 1 30); do [ "$(az_curl -o /dev/null -w '%{http_code}' "?comp=list" 2>/dev/null)" = 200 ] && break; sleep 1; done
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=blobstate" \
    -addext "subjectAltName=DNS:devstoreaccount1.blob.azurite,DNS:login.microsoftonline.com,IP:127.0.0.1" \
    -keyout "$work/stub/blobstate.key" -out "$work/stub/blobstate.crt" >/dev/null 2>&1 || { echo "openssl could not make a certificate" >&2; return 1; }
  cat > "$work/stub/blobstate.mjs" <<'JS'
// The Azure cloud's metadata and Entra ID on 443, Google STS and IAM Credentials on 8181, and a TLS hop to Azurite on 10000.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import tls from "node:tls";
const key = readFileSync("/stub/blobstate.key"), cert = readFileSync("/stub/blobstate.crt");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c21va2U`;
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req, fn) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => fn(b)); };
https({ key, cert }, (req, res) => read(req, (body) => {
  console.log(`azure ${req.method} ${req.url.split("?")[0]}`);
  if (req.url.startsWith("/metadata/endpoints")) return send(res, 200, { name: "AzureCloud", authentication: { loginEndpoint: "https://login.microsoftonline.com/", audiences: ["https://management.core.windows.net/"], tenant: "common", identityProvider: "AAD" }, resourceManager: "https://management.azure.com/", microsoftGraphResourceId: "https://graph.microsoft.com/", suffixes: { storage: "azurite:10000" } });
  const oc = /^\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration/.exec(req.url);
  if (oc) { const b = `https://login.microsoftonline.com/${oc[1]}`; return send(res, 200, { token_endpoint: `${b}/oauth2/v2.0/token`, authorization_endpoint: `${b}/oauth2/v2.0/authorize`, issuer: `${b}/v2.0`, jwks_uri: `${b}/discovery/v2.0/keys` }); }
  const t = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(req.url);
  if (t) {
    const f = new URLSearchParams(body);
    if (f.get("client_assertion") !== readFileSync("/stub/forge-token", "utf-8").trim()) return send(res, 400, { error: "invalid_client", error_description: "AADSTS700213: No matching federated identity record found." });
    appendFileSync("/stub/azure-clients.log", `${f.get("client_id")}\n`);
    const now = Math.floor(Date.now() / 1000);
    return send(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: jwt({ aud: "https://storage.azure.com", iss: `https://sts.windows.net/${t[1]}/`, iat: now - 60, nbf: now - 60, exp: now + 3600, oid: f.get("client_id"), tid: t[1], appid: f.get("client_id") }) });
  }
  send(res, 404, { error: "not_found" });
})).listen(443, "127.0.0.1");
http((req, res) => read(req, (body) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/v1/token") return send(res, 200, { access_token: "federated", token_type: "Bearer", expires_in: 3600 });
  const sa = /\/serviceAccounts\/([^:]+):generateAccessToken$/.exec(path)?.[1];
  if (sa && req.headers.authorization === "Bearer federated") {
    appendFileSync("/stub/gcp-accounts.log", `${sa}\n`);
    return send(res, 200, { accessToken: `token-${sa}`, expireTime: new Date(Date.now() + 3600_000).toISOString() });
  }
  send(res, 403, { error: { code: 403, message: `refused ${req.method} ${path}` } });
})).listen(8181, "127.0.0.1");
tls.createServer({ key, cert }, (sock) => {
  // An emulator hop: Azurite's own certificate is not what the job trusts.
  const up = tls.connect({ host: "azurite", port: 10000, servername: "azurite", rejectUnauthorized: false }, () => { sock.pipe(up); up.pipe(sock); });
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
}).listen(10000, "127.0.0.1", () => writeFileSync("/stub/ready", "1"));
JS
  printf 'forge-oidc-token-%s' "$(date +%s)" > "$work/stub/forge-token"
}

# A request to Azurite from the host, as devstoreaccount1 with a bearer token
# Azurite's basic OAuth takes. The path is under the account.
az_curl() { # [curl options...] path
  local now path="${*: -1}" jwt
  now="$(date +%s)"
  jwt="$(blob_jwt "{\"aud\":\"https://storage.azure.com\",\"iss\":\"https://sts.windows.net/$BLOB_STATE_TENANT/\",\"iat\":$((now - 60)),\"nbf\":$((now - 60)),\"exp\":$((now + 3600)),\"oid\":\"smoke\",\"tid\":\"$BLOB_STATE_TENANT\"}")"
  curl -sSk -H "Authorization: Bearer $jwt" -H 'x-ms-version: 2021-08-06' "${@:1:$#-1}" "https://localhost:${TERRAGUCCI_AZURITE_PORT:-10010}/devstoreaccount1/${path#/}"
}

# A request to fake-gcs-server's JSON API from the host.
gcs_curl() { # [curl options...] path
  curl -sS -H 'Host: gcs:4443' "${@:1:$#-1}" "http://localhost:${TERRAGUCCI_GCS_PORT:-4453}/${*: -1}"
}

# Run a command in the CI image in /repo, with the stand-in listening when
# $work/stub/blobstate.mjs is there, and the variables both backends read;
# BLOB_STATE_ENV adds docker arguments.
blob_state_in() { # work, command...
  local work="$1" rc=0; shift
  STATE_IN_EXTRA=(-v "$work/stub:/stub" -e GOOGLE_OAUTH_ACCESS_TOKEN=smoke-gcs-token)
  if [ -f "$work/stub/blobstate.mjs" ]; then
    : > "$work/stub/ready"
    STATE_IN_EXTRA+=(--add-host devstoreaccount1.blob.azurite:127.0.0.1 --add-host login.microsoftonline.com:127.0.0.1 -e SSL_CERT_FILE=/stub/blobstate.crt -e NODE_EXTRA_CA_CERTS=/stub/blobstate.crt -e "ARM_ACCESS_KEY=$AZURITE_KEY")
  fi
  # Last, so a claim's own variables win.
  STATE_IN_EXTRA+=(${BLOB_STATE_ENV[@]+"${BLOB_STATE_ENV[@]}"})
  # shellcheck disable=SC2016 # expanded by the container's shell
  state_in "$work" sh -c 'if [ -f /stub/blobstate.mjs ]; then node /stub/blobstate.mjs >>/stub/stub.log 2>&1 & i=0; until [ -s /stub/ready ] || [ $i -ge 50 ]; do sleep 0.1; i=$((i+1)); done; fi; "$@"' sh "$@" || rc=$?
  STATE_IN_EXTRA=()
  return $rc
}

# A gcs backend block on the emulator.
gcs_backend() { # bucket, prefix
  printf 'terraform {\n  backend "gcs" {\n    bucket                  = "%s"\n    prefix                  = "%s"\n    storage_custom_endpoint = "http://gcs:4443/storage/v1/"\n  }\n}\n' "$1" "$2"
}

# An azurerm backend block on Azurite, through the stand-in's metadata; the rest are extra lines in the block.
az_backend() { # container, key, [lines...]
  local c="$1" k="$2" l; shift 2
  printf 'terraform {\n  backend "azurerm" {\n    storage_account_name = "devstoreaccount1"\n    container_name       = "%s"\n    key                  = "%s"\n    metadata_host        = "127.0.0.1"\n' "$c" "$k"
  for l in "$@"; do printf '    %s\n' "$l"; done
  printf '  }\n}\n'
}

# A bucket on fake-gcs-server, with object versioning on or off.
gcs_bucket() { # bucket, true|false
  gcs_curl -f -o /dev/null -X POST -H 'content-type: application/json' -d "{\"name\":\"$1\",\"versioning\":{\"enabled\":$2}}" "storage/v1/b?project=smoke-project"
}

# A container on Azurite.
az_container() { # container
  [ "$(az_curl -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Length: 0' "$1?restype=container")" = 201 ]
}

# Each generation fake-gcs-server holds of an object, oldest first.
gcs_generations() { # bucket, key
  gcs_curl "storage/v1/b/$1/o?versions=true&prefix=$(jq -rn --arg k "$2" '$k | @uri')" | jq -r --arg k "$2" '[.items[]? | select(.name == $k) | .generation] | sort_by(tonumber) | .[]'
}

# Each snapshot Azurite holds of a blob.
az_snapshots() { # container, blob
  az_curl "$1?restype=container&comp=list&include=snapshots&prefix=$2" | grep -o '<Snapshot>[^<]*</Snapshot>' | sed 's/<[^>]*>//g'
}

# The repo: root app on `backend`, its reports on floci under a prefix of the claim's own.
blob_state_repo() { # work, prefix, backend block, input
  mkdir -p "$1/wave/app"
  printf '%s\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$3" "$4" > "$1/wave/app/main.tf"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$2" > "$1/wave/terragucci.yml"
  audit_origin "$1"
}

# Apply the repo's app twice, a new input the second time; BLOB_VERSIONS gets the version each wave's log names.
blob_state_applies() { # work, location the log names, image
  local work="$1" location="$2" n v
  BLOB_VERSIONS=()
  for n in 1 2; do
    if [ $n = 2 ]; then
      perl -pi -e "s/input = \"[^\"]*\"/input = \"bs-$STAMP-2\"/" "$work/wave/app/main.tf"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app input 2"
    fi
    blob_state_in "$work" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never > "$work/run-$n.log" 2>&1 || { cat "$work/run-$n.log" >&2; echo "apply $n failed" >&2; return 1; }
    clean_mounted "$work/wave" "$3"
    grep "^app: state" "$work/run-$n.log" >&2
    v="$(sed -n "s#^app: state $location version \\(.*\\)\$#\\1#p" "$work/run-$n.log")"
    [ -n "$v" ] || { echo "apply $n named no version of $location" >&2; return 1; }
    BLOB_VERSIONS+=("$v")
  done
}

# state export of app at version V1 asks (exit 3), bob approves it in a clone, and the export writes it to $work/out/app.tfstate; BLOB_EXPORT_LOG gets the logs.
blob_state_export() { # work, version
  local work="$1" v="$2" code=0 digest
  mkdir -p "$work/out"
  local -a BLOB_STATE_ENV=(-v "$work/out:/out" ${BLOB_STATE_ENV[@]+"${BLOB_STATE_ENV[@]}"})
  blob_state_in "$work" terragucci state export app --version "$v" --actor alice > "$work/ask.log" 2>&1 || code=$?
  cat "$work/ask.log" >&2
  [ "$code" = 3 ] || { echo "the request exited $code, not 3" >&2; return 1; }
  digest="$(grep -o 'terragucci approve export app --plan sha256:[0-9a-f]*' "$work/ask.log" | head -1 | awk '{print $NF}')"
  [ -n "$digest" ] || { echo "the request printed no terragucci approve command" >&2; return 1; }
  git clone -q "$work/origin.git" "$work/bob"
  (cd "$work/bob" && GIT_AUTHOR_NAME=bob GIT_AUTHOR_EMAIL=bob@localhost GIT_COMMITTER_NAME=bob GIT_COMMITTER_EMAIL=bob@localhost "$TERRAGUCCI" approve export app --plan "$digest" --actor bob) >&2 || { echo "bob could not approve the request" >&2; return 1; }
  code=0
  # shellcheck disable=SC2016 # expanded by the container's shell
  blob_state_in "$work" sh -c 'terragucci state export app --version "$0" --actor alice --out /out/app.tfstate && stat -c "mode %a" /out/app.tfstate' "$v" > "$work/get.log" 2>&1 || code=$?
  cat "$work/get.log" >&2
  [ "$code" = 0 ] || { echo "the export after bob's approval exited $code, not 0" >&2; return 1; }
  grep -q '^mode 600$' "$work/get.log" || { echo "the file is not mode 600" >&2; return 1; }
  git -C "$work/bob" fetch -q origin "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle"
  BLOB_DONE="$(git -C "$work/bob" show "refs/remotes/origin/chant/lifecycle:_gates/tf-state-export/done.jsonl" 2>/dev/null)"
  jq -se --arg v "$v" 'map(select(.kind == "state-export" and .root == "app" and .version_id == $v and .exportedBy == "alice" and .approvedBy == "bob")) | length == 1' <<<"$BLOB_DONE" >/dev/null \
    || { echo "done.jsonl does not record alice exporting app version $v, approved by bob: $BLOB_DONE" >&2; return 1; }
}

claim_state/gcs() {
  # A root, app, whose state is app/default.tfstate in a bucket on
  # fake-gcs-server with object versioning on, applies in tf-apply wave 1
  # twice, a new input the second time. Each wave's log names the state's
  # generation, each one the bucket holds for the object, the second its
  # live one. terragucci state export app --version <the first> --actor
  # alice then records a request and exits 3; bob approves it, and the
  # export writes that generation to /out, mode 0600, byte for byte as the
  # bucket holds it, and done.jsonl names alice, bob and the generation.
  # BREAK: the bucket keeps no versions, so a wave's log names none.
  log() { echo "[smoke gcs-state] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tg-gcs-state-$STAMP" held live v
  local -a BLOB_STATE_ENV=() BLOB_VERSIONS=()
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  blob_state_up "$work" gcs || { drop_work "$work"; return 1; }
  gcs_bucket "$bucket" "$([ -n "${BREAK:-}" ] && echo false || echo true)" || { log "fake-gcs-server did not make bucket $bucket"; drop_work "$work"; return 1; }
  blob_state_repo "$work" "gcs-state-$STAMP" "$(gcs_backend "$bucket" app)" "bs-$STAMP-1"
  blob_state_applies "$work" "gs://$bucket/app/default.tfstate" "$image" || rc=1
  if [ $rc = 0 ]; then
    held="$(gcs_generations "$bucket" app/default.tfstate | tr '\n' ' ')"
    live="$(gcs_curl "storage/v1/b/$bucket/o/app%2Fdefault.tfstate" | jq -r '.generation')"
    log "the waves named ${BLOB_VERSIONS[*]}; the bucket holds $held, live $live"
    for v in "${BLOB_VERSIONS[@]}"; do case " $held " in *" $v "*) ;; *) log "generation $v is not one the bucket holds"; rc=1 ;; esac; done
    [ "${BLOB_VERSIONS[1]}" = "$live" ] || { log "the second wave named ${BLOB_VERSIONS[1]}, and the live generation is $live"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    blob_state_export "$work" "${BLOB_VERSIONS[0]}" || rc=1
  fi
  if [ $rc = 0 ]; then
    cmp -s "$work/out/app.tfstate" <(gcs_curl "storage/v1/b/$bucket/o/app%2Fdefault.tfstate?alt=media&generation=${BLOB_VERSIONS[0]}") || { log "the file is not generation ${BLOB_VERSIONS[0]} as the bucket holds it"; rc=1; }
    grep -q "bs-$STAMP-1" "$work/out/app.tfstate" || { log "the file is not the state the first wave wrote"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "each wave named the generation it left, and alice exported the first once bob approved it"
  return $rc
}

claim_state/azurerm() {
  # A root, app, whose state is the blob app.tfstate in a container on
  # Azurite, its azurerm backend set to take snapshots (snapshot = true),
  # applies in tf-apply wave 1 twice, a new input the second time. Azurite
  # keeps no blob versions, so each wave takes a snapshot of the blob it left
  # and its log names that snapshot, each one Azurite holds. terragucci state
  # export app --version <the first> --actor alice then records a request
  # and exits 3; bob approves it, and the export writes that snapshot to
  # /out, byte for byte as Azurite holds it, and done.jsonl names alice, bob
  # and the snapshot.
  # BREAK: the backend takes no snapshots, so a wave's log names no version.
  log() { echo "[smoke azurerm-state] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 container="tg-az-state-$STAMP" held v
  local -a BLOB_STATE_ENV=() BLOB_VERSIONS=() lines=()
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  blob_state_up "$work" azurite || { drop_work "$work"; return 1; }
  az_container "$container" || { log "Azurite did not make container $container"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] || lines=("snapshot             = true")
  blob_state_repo "$work" "az-state-$STAMP" "$(az_backend "$container" app.tfstate ${lines[@]+"${lines[@]}"})" "bs-$STAMP-1"
  blob_state_applies "$work" "az://devstoreaccount1/$container/app.tfstate" "$image" || rc=1
  if [ $rc = 0 ]; then
    held="$(az_snapshots "$container" app.tfstate | tr '\n' ' ')"
    log "the waves named ${BLOB_VERSIONS[*]}; Azurite holds the snapshots $held"
    for v in "${BLOB_VERSIONS[@]}"; do case " $held " in *" $v "*) ;; *) log "snapshot $v is not one Azurite holds"; rc=1 ;; esac; done
    cmp -s <(az_curl "$container/app.tfstate?snapshot=${BLOB_VERSIONS[1]}") <(az_curl "$container/app.tfstate") || { log "the second wave's snapshot is not the blob it left"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    blob_state_export "$work" "${BLOB_VERSIONS[0]}" || rc=1
  fi
  if [ $rc = 0 ]; then
    cmp -s "$work/out/app.tfstate" <(az_curl "$container/app.tfstate?snapshot=${BLOB_VERSIONS[0]}") || { log "the file is not snapshot ${BLOB_VERSIONS[0]} as Azurite holds it"; rc=1; }
    grep -q "bs-$STAMP-1" "$work/out/app.tfstate" || { log "the file is not the state the first wave wrote"; rc=1; }
  fi
  [ $rc = 0 ] || sed 's/^/[blobstate] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "each wave named the snapshot it took, and alice exported the first once bob approved it"
  return $rc
}

# The unlock claims: app's terraform_data.slow sleeps var.hold seconds in a
# local-exec; an apply killed while it sleeps leaves the backend's lock.
blob_unlock() { # gcs|azurerm
  local kind="$1" work image rc=0 name="unlock-$1-$STAMP" bucket="tg-unlock-$STAMP" container="tg-unlock-$STAMP" code=0 out digest id="" done location held
  local -a BLOB_STATE_ENV=()
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  if [ "$kind" = gcs ]; then
    blob_state_up "$work" gcs && gcs_bucket "$bucket" true || { log "fake-gcs-server did not make bucket $bucket"; drop_work "$work"; return 1; }
    location="gs://$bucket/app/default.tflock"
    held() { gcs_curl "storage/v1/b/$bucket/o/app%2Fdefault.tflock" | jq -r '.generation // empty'; }
  else
    blob_state_up "$work" azurite && az_container "$container" || { log "Azurite did not make container $container"; drop_work "$work"; return 1; }
    location="az://devstoreaccount1/$container/app.tfstate"
    held() { az_curl -o /dev/null -D - -I "$container/app.tfstate" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-ms-lease-state" && $2 == "leased" { print "leased" }'; }
  fi
  # A repo of its own on Forgejo, with no run: unlock-state asks it which runs are alive.
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$name" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false}" "$URL/api/v1/user/repos" \
    && api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$name" || { log "could not make $USER/$name on Forgejo"; drop_work "$work"; return 1; }
  mkdir -p "$work/wave/app"
  { if [ "$kind" = gcs ]; then gcs_backend "$bucket" app; else az_backend "$container" app.tfstate; fi
    printf '\nvariable "hold" {\n  type    = number\n  default = 300\n}\n\nresource "terraform_data" "slow" {\n  input = "ul-%s"\n  provisioner "local-exec" {\n    command = "sleep ${var.hold}"\n  }\n}\n' "$STAMP"; } > "$work/wave/app/main.tf"
  printf 'binary: tofu\nforge: forgejo\nurl: http://forgejo:3000/%s/%s\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$USER" "$name" "$REPORT_BUCKET" "$name" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  # The apply, killed while its provisioner sleeps: a runner that kills a job leaves the lock this way.
  # shellcheck disable=SC2016 # expanded by the container's shell
  blob_state_in "$work" sh -c 'tofu -chdir=app init -input=false -no-color >/dev/null && { tofu -chdir=app apply -auto-approve -no-color >/tmp/apply.log 2>&1 & p=$!; sleep 20; kill -9 $p; grep -q "Still creating\|Provisioning with" /tmp/apply.log && echo killed; }' > "$work/kill.log" 2>&1 || true
  cat "$work/kill.log" >&2
  clean_mounted "$work/wave" "$image"
  [ -n "$(held)" ] || { log "the killed apply left no lock on $location"; rc=1; }
  if [ $rc = 0 ]; then
    BLOB_STATE_ENV=(-e "FORGEJO_TOKEN=$TOKEN")
    blob_state_in "$work" terragucci unlock-state app --actor smoke-operator > "$work/ask.log" 2>&1 || code=$?
    cat "$work/ask.log" >&2
    clean_mounted "$work/wave" "$image"
    digest="$(sed -n 's/.*terragucci approve unlock app --plan \([^ ]*\).*/\1/p' "$work/ask.log" | head -1)"
    [ "$code" = 3 ] && [ -n "$digest" ] || { log "unlock-state exited $code and printed no approval to wait for"; rc=1; }
    id="$(sed -n "s#.*app: $location holds lock \\([^,]*\\),.*#\\1#p" "$work/ask.log" | head -1)"
    [ "$kind" != gcs ] || [ "$id" = "$(held)" ] || { log "the lock ID unlock-state names, $id, is not the lock object's generation, $(held)"; rc=1; }
    [ -n "$(held)" ] || { log "the lock was released before any approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # BREAK: the approval names another lock's digest.
    [ -n "${BREAK:-}" ] && digest="jcs1-sha256:$(printf '0%.0s' $(seq 1 64))"
    git clone -q "$work/origin.git" "$work/approver"
    (cd "$work/approver" && GIT_AUTHOR_NAME=smoke-approver GIT_AUTHOR_EMAIL=smoke-approver@localhost GIT_COMMITTER_NAME=smoke-approver GIT_COMMITTER_EMAIL=smoke-approver@localhost \
      "$CHANT" approve tf-unlock app --plan "$digest" --approver smoke-approver) >&2 || { log "chant approve tf-unlock failed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    code=0
    blob_state_in "$work" terragucci unlock-state app --actor smoke-operator > "$work/release.log" 2>&1 || code=$?
    cat "$work/release.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$code" = 0 ] || { log "unlock-state exited $code after the approval"; rc=1; }
    [ -z "$(held)" ] || { log "$location is still locked after the approved release"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    git -C "$work/approver" fetch -q origin "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle"
    done="$(git -C "$work/approver" show "refs/remotes/origin/chant/lifecycle:_gates/tf-unlock/done.jsonl" 2>/dev/null)"
    [ "$(jq -r 'select(.gate == "app") | [.location, .lock.ID, .approvedBy, .releasedBy] | join(" ")' <<<"$done" 2>/dev/null)" = "$location $id smoke-approver smoke-operator" ] \
      || { log "done.jsonl does not record lock $id on $location released by smoke-operator under smoke-approver's approval: $done"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    BLOB_STATE_ENV=(-e TF_VAR_hold=0)
    code=0
    blob_state_in "$work" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never > "$work/after.log" 2>&1 || code=$?
    clean_mounted "$work/wave" "$image"
    [ "$code" = 0 ] || { cat "$work/after.log" >&2; log "the apply after the release exited $code"; rc=1; }
  fi
  [ $rc = 0 ] || sed 's/^/[blobstate] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$name" 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the killed apply's lock $id on $location was released once approved, recorded, and the next apply ran"
  return $rc
}

claim_state/gcs_unlock() {
  # app's apply on a gcs backend on fake-gcs-server is killed while its
  # provisioner sleeps, so app/default.tflock stays. terragucci unlock-state
  # app reads the lock, names as its ID the lock object's generation (the ID
  # the binary's force-unlock takes), finds no live run on the repo's
  # Forgejo, records a request and exits 3, the lock still there.
  # smoke-approver approves the digest it printed, and unlock-state releases
  # the lock: the object is gone, done.jsonl names the location, the ID, the
  # approver and who released it, and an apply then runs.
  # BREAK: the approval names another lock's digest, so the lock stays.
  log() { echo "[smoke gcs-unlock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  blob_unlock gcs
}

claim_state/azurerm_unlock() {
  # app's apply on an azurerm backend on Azurite is killed while its
  # provisioner sleeps, so the lease on app.tfstate stays, with the lock info
  # in the blob's metadata. terragucci unlock-state app reads the lock from
  # the lease and the metadata, finds no live run on the repo's Forgejo,
  # records a request and exits 3, the blob still leased. smoke-approver
  # approves the digest it printed, and unlock-state releases the lock: the
  # lease is gone, done.jsonl names the location, the ID, the approver and
  # who released it, and an apply then runs.
  # BREAK: the approval names another lock's digest, so the lease stays.
  log() { echo "[smoke azurerm-unlock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  blob_unlock azurerm
}

claim_migrate/blob() {
  # Root one keeps its state on fake-gcs-server (gcs backend, object
  # versioning on) and holds terraform_data.keep and terraform_data.moved;
  # root two keeps its state on Azurite (azurerm, snapshot = true). A commit
  # moves the moved block to two and adds migrations/move-moved.yml. Wave 1
  # proves the migration and waits for its digest; once smoke-approver
  # approves it, wave 1 takes one's lock object and a lease on two's blob,
  # writes one's state with the binary and two's under its lease, plans both
  # with no change, and applies nothing. one's state then holds keep and
  # two's moved, no lock object or lease is left, and the record names one's
  # generation before and after (the live one) and two's snapshots before and
  # after, each one Azurite holds.
  # BREAK: after the approval, one's lock object is taken (as a run holding
  # it would), so the wave writes nothing.
  log() { echo "[smoke blob-migrate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tg-mig-$STAMP" container="tg-mig-$STAMP" code digest record one two snaps v n
  local -a BLOB_STATE_ENV=()
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  { blob_state_up "$work" gcs && gcs_bucket "$bucket" true && blob_state_up "$work" azurite && az_container "$container"; } || { log "could not make the bucket and the container"; drop_work "$work"; return 1; }
  mkdir -p "$work/wave/one" "$work/wave/two"
  blob_migrate_root() { # root, names...
    local root="$1"; shift
    { if [ "$root" = one ]; then gcs_backend "$bucket" one; else az_backend "$container" two.tfstate "snapshot             = true"; fi
      for n in "$@"; do printf '\nresource "terraform_data" "%s" {\n  input = "bm-%s-%s"\n}\n' "$n" "$STAMP" "$n"; done; } > "$work/wave/$root/main.tf"
  }
  blob_migrate_root one keep moved
  blob_migrate_root two
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: blob-migrate-%s\n' "$REPORT_BUCKET" "$STAMP" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  blob_wave() { # log name -> AUDIT_CODE
    AUDIT_CODE=0
    blob_state_in "$work" terragucci stage tf-apply --wave 1 --layers one,two --binary tofu --gate never > "$work/$1.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/$1.log" >&2
    clean_mounted "$work/wave" "$image"
  }
  blob_wave first
  [ "$AUDIT_CODE" = 0 ] || { log "the first apply exited $AUDIT_CODE, not 0"; rc=1; }
  if [ $rc = 0 ]; then
    blob_migrate_root one keep
    blob_migrate_root two moved
    mkdir -p "$work/wave/migrations"
    printf 'moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.moved]\n' > "$work/wave/migrations/move-moved.yml"
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "moved from one to two"
    blob_wave waits
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the migration"; rc=1; }
    digest="$(sed -n 's/^migration move-moved waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/waits.log")"
    [ -n "$digest" ] || { log "wave 1 printed no digest to approve"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_approve "$work/origin.git" "$work/ledger" smoke-approver move-moved "$digest" || { log "could not approve the migration"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    gcs_curl -f -o /dev/null -X POST -H 'content-type: application/json' --data-binary "{\"ID\":\"held-$STAMP\",\"Operation\":\"OperationTypeApply\",\"Who\":\"another-run\",\"Created\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      "upload/storage/v1/b/$bucket/o?uploadType=media&name=one%2Fdefault.tflock&ifGenerationMatch=0" || { log "could not take one's lock object"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    blob_wave applies
    [ "$AUDIT_CODE" != 0 ] && grep -q "its state is locked (gs://$bucket/one/default.tflock" "$work/applies.log" && log "wave 1 refused: one's lock object is held"
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the approval, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "^migration move-moved applied$" "$work/applies.log" || { log "the log does not say the migration applied"; rc=1; }
    one="$(gcs_curl "storage/v1/b/$bucket/o/one%2Fdefault.tfstate?alt=media" | jq -r '[.resources[].name] | join(",")')"
    two="$(az_curl "$container/two.tfstate" | jq -r '[.resources[].name] | join(",")')"
    [ "$one" = keep ] && [ "$two" = moved ] || { log "one holds [$one] and two [$two], not keep and moved"; rc=1; }
    [ -z "$(gcs_curl "storage/v1/b/$bucket/o/one%2Fdefault.tflock" | jq -r '.generation // empty')" ] || { log "one's lock object is left"; rc=1; }
    az_curl -o /dev/null -D - -I "$container/two.tfstate" | tr -d '\r' | grep -qi '^x-ms-lease-state: available' || { log "two's blob is still leased"; rc=1; }
    record="$(cat "$work/wave/terragucci-report/migrations/move-moved.json" 2>/dev/null)" || { log "no migration record in terragucci-report/"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '{status, roots: [.roots[] | {root, location, before: .before.version_id, after: .after.version_id}]}' <<<"$record" >&2
    [ "$(jq -r .status <<<"$record")" = applied ] || { log "the record says $(jq -r .status <<<"$record"), not applied"; rc=1; }
    v="$(jq -r '.roots[] | select(.root == "one") | .after.version_id' <<<"$record")"
    [ "$v" = "$(gcs_curl "storage/v1/b/$bucket/o/one%2Fdefault.tfstate" | jq -r .generation)" ] || { log "one's version after, $v, is not its live generation"; rc=1; }
    [ -n "$(jq -r '.roots[] | select(.root == "one") | .before.version_id // empty' <<<"$record")" ] || { log "the record names no version of one before"; rc=1; }
    snaps=" $(az_snapshots "$container" two.tfstate | tr '\n' ' ') "
    for v in $(jq -r '.roots[] | select(.root == "two") | .before.version_id, .after.version_id' <<<"$record"); do
      case "$snaps" in *" $v "*) ;; *) log "two's version $v is not a snapshot Azurite holds ($snaps)"; rc=1 ;; esac
    done
    cmp -s <(az_curl "$container/two.tfstate?snapshot=$(jq -r '.roots[] | select(.root == "two") | .after.version_id' <<<"$record")") <(az_curl "$container/two.tfstate") || { log "two's version after is not the blob the migration left"; rc=1; }
  fi
  [ $rc = 0 ] || sed 's/^/[blobstate] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "moved went from a gcs state to an azurerm state under both locks, approved by digest, with each version before and after recorded"
  return $rc
}

claim_oidc/cloud_roles() {
  # A repo with four roots, envs/dev/gcs and envs/prod/gcs on gcs backends on
  # fake-gcs-server and envs/dev/az and envs/prod/az on azurerm backends on
  # Azurite over Entra ID (use_oidc, use_azuread_auth), and terragucci.yml
  # giving oidc.gcp.roles and oidc.azure.roles a service account and a
  # client for envs/dev/** and for envs/prod/**. config check lists what
  # each reaches. init writes the pipeline, and the apply job's
  # TERRAGUCCI_ROOT_GCP_SERVICE_ACCOUNTS and TERRAGUCCI_ROOT_AZURE_CLIENTS
  # exports run before tf-apply of the dev roots, then of the prod roots, in
  # the CI image with the job's own identity (the apply service account and
  # client). The stand-ins for Google's STS and IAM and for Entra ID record
  # which service account each token impersonates and which client each
  # token is for: the dev wave's are the dev ones alone, the prod wave's the
  # prod ones, and never the job's.
  # BREAK: the exports are left out, so every root takes the job's identity.
  log() { echo "[smoke cloud-roles] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tg-roles-$STAMP" container="tg-roles-$STAMP" env got exports out code
  local -a BLOB_STATE_ENV=()
  local job_sa="tg-apply@smoke-project.iam.gserviceaccount.com"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  { blob_state_up "$work" gcs && gcs_bucket "$bucket" true && blob_state_up "$work" azurite && az_container "$container"; } || { log "could not make the bucket and the container"; drop_work "$work"; return 1; }
  for env in dev prod; do
    mkdir -p "$work/wave/envs/$env/gcs" "$work/wave/envs/$env/az"
    { gcs_backend "$bucket" "$env"; printf '\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$env"; } > "$work/wave/envs/$env/gcs/main.tf"
    { az_backend "$container" "$env.tfstate" "use_oidc             = true" "use_azuread_auth     = true"; printf '\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$env"; } > "$work/wave/envs/$env/az/main.tf"
  done
  cat > "$work/wave/terragucci.yml" <<YML
binary: tofu
forge: forgejo
reports:
  bucket: s3://$REPORT_BUCKET
  endpoint: http://floci:4566
  prefix: cloud-roles-$STAMP
oidc:
  gcp:
    workload_identity_provider: projects/1/locations/global/workloadIdentityPools/smoke/providers/forge
    plan_service_account: tg-plan@smoke-project.iam.gserviceaccount.com
    apply_service_account: $job_sa
    roles:
      "envs/dev/**": { plan: dev-plan@smoke-project.iam.gserviceaccount.com, apply: dev-apply@smoke-project.iam.gserviceaccount.com }
      "envs/prod/**": { plan: prod-plan@smoke-project.iam.gserviceaccount.com, apply: prod-apply@smoke-project.iam.gserviceaccount.com }
  azure:
    tenant_id: $BLOB_STATE_TENANT
    subscription_id: 00000000-0000-4000-8000-000000000001
    plan_client_id: client-plan
    apply_client_id: client-apply
    roles:
      "envs/dev/**": { plan: client-dev-plan, apply: client-dev-apply }
      "envs/prod/**": { plan: client-prod-plan, apply: client-prod-apply }
YML
  audit_origin "$work"
  out="$(cd "$work/wave" && "$TERRAGUCCI" config check 2>&1)" || { printf '%s\n' "$out" >&2; log "config check failed"; rc=1; }
  printf '%s\n' "$out" >&2
  [ $rc = 0 ] && { grep -qF "prod-apply@smoke-project.iam.gserviceaccount.com (gcp, apply, envs/prod/**): gs://$bucket/prod" <<<"$out" && grep -qF "client-dev-apply (azure, apply, envs/dev/**): dev.tfstate" <<<"$out" || { log "config check does not list what each service account and client reaches"; rc=1; }; }
  if [ $rc = 0 ]; then
    (cd "$work/wave" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; rc=1; }
    exports="$(grep -ho "export TERRAGUCCI_ROOT_\(GCP_SERVICE_ACCOUNTS\|AZURE_CLIENTS\)='[^']*'" "$work/wave/.forgejo/workflows/terragucci.yml" | grep -- '-apply' | sort -u)"
    printf '%s\n' "$exports" >&2
    [ "$(wc -l <<<"$exports" | tr -d ' ')" = 2 ] || { log "the pipeline does not export the apply stage's service accounts and clients by root glob"; rc=1; }
    [ -z "${BREAK:-}" ] || exports=""
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "pipeline" || true
  fi
  if [ $rc = 0 ]; then
    # The job's own identity, as oidc.gcp and oidc.azure set it for the apply stage, with STS, IAM and Entra ID at the stand-in.
    printf '{"type":"external_account","audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/smoke/providers/forge","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"http://127.0.0.1:8181/v1/token","service_account_impersonation_url":"http://127.0.0.1:8181/v1/projects/-/serviceAccounts/%s:generateAccessToken","credential_source":{"file":"/stub/forge-token"}}\n' "$job_sa" > "$work/stub/gcp-creds.json"
    printf '%s\n' "$exports" > "$work/stub/exports.sh"
    BLOB_STATE_ENV=(-e GOOGLE_OAUTH_ACCESS_TOKEN= -e GOOGLE_APPLICATION_CREDENTIALS=/stub/gcp-creds.json -e ARM_USE_OIDC=true -e "ARM_TENANT_ID=$BLOB_STATE_TENANT" -e ARM_CLIENT_ID=client-apply -e ARM_OIDC_TOKEN_FILE_PATH=/stub/forge-token -e ARM_ACCESS_KEY=)
    for env in dev prod; do
      : > "$work/stub/gcp-accounts.log"; : > "$work/stub/azure-clients.log"
      code=0
      # shellcheck disable=SC2016 # expanded by the container's shell
      blob_state_in "$work" sh -c '. /stub/exports.sh; terragucci stage tf-apply --wave 1 --layers "envs/$0/gcs,envs/$0/az" --binary tofu --gate never' "$env" > "$work/$env.log" 2>&1 || code=$?
      clean_mounted "$work/wave" "$image"
      [ "$code" = 0 ] || { cat "$work/$env.log" >&2; log "the $env wave exited $code"; rc=1; break; }
      grep "^envs/$env/.*: state" "$work/$env.log" >&2
      got="$(sort -u "$work/stub/gcp-accounts.log" | tr '\n' ' ')"
      log "the $env wave impersonated: $got"
      [ "$got" = "$env-apply@smoke-project.iam.gserviceaccount.com " ] || { log "the $env roots did not impersonate $env-apply alone"; rc=1; }
      got="$(sort -u "$work/stub/azure-clients.log" | tr '\n' ' ')"
      log "the $env wave's Entra ID tokens were for: $got"
      [ "$got" = "client-$env-apply " ] || { log "the $env roots did not take client-$env-apply alone"; rc=1; }
    done
  fi
  [ $rc = 0 ] || sed 's/^/[blobstate] /' "$work/stub/stub.log" >&2 2>/dev/null || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "each environment's roots took its own service account and client, from the pipeline's exports, and never the job's"
  return $rc
}

# ── the plan note's diff ──────────────────────────────────────────────────

claim_note/diff() {
  # A pull request on the example with one-root, which raises the job
  # retention of dev orders to 604800 seconds. Its plan note must show the
  # change as the binary prints it, before the whole plans: a diff block whose
  # line for message_retention_seconds holds the value before and 604800
  # after it. BREAK: the pushed pipeline's plan job deletes every line
  # holding "->" from the note it writes for the plan-note job, as a note
  # that names only the attributes reads.
  log() { echo "[smoke note-diff] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" branch=smoke/note-diff work wf sha pr rc=0 deadline state notes body groups line before
  example_applied || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example up' first"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # The pipeline this tree renders, so the pull request runs it whatever main carries.
  cp "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$wf"
  git -C "$work/tree" apply "$EXAMPLE/changes/one-root.patch" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # The plan job writes the note into the report, and the plan-note job posts it from there.
    sed 's#\(cat terragucci-report/note.md; } >terragucci-report/plan-note.md\)$#\1; sed -i -e "/->/d" terragucci-report/plan-note.md#' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'sed -i -e "/->/d" terragucci-report/plan-note.md' "$wf" || { log "BREAK found no line that writes the plan note to cut"; drop_work "$work"; return 1; }
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$dir:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan "$@" >&2 || rc=$?
  clean_mounted "$dir" "$image"
  return $rc
}

claim_note/split() {
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

claim_note/report_link() {
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

claim_init/config_ts() {
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

claim_init/role_refused() {
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
  STANDIN="$(run_copied -d --name "$name" --network "${TG_NETWORK:-terragucci}" -p "127.0.0.1::$port" -e "PORT=$port" ${envs[@]+"${envs[@]}"} \
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

claim_review/description() {
  # A repo with respond.description: check and decide: pointing at a stand-in
  # for the decision service, which answers yes at 0.95 in the shape every
  # backend speaks. init puts the check in the plan job. The plan destroys
  # app: terraform_data.gone, and the pull request says Tags only: the check
  # run as the plan job runs it writes a flag naming the destroy at the top of
  # note.md and in report.html, and writes intent.json with the decision. The
  # same check is then asked through decide.backend von, decider and jev in
  # turn: config check passes each block; each flags the destroy and names
  # the pinned model; the request pins that model, and jev alone sends its key
  # from token_env as a bearer token. One stand-in and one repo serve them all.
  # BREAK: the stand-in answers yes at 0.55, under the 0.8 threshold, so no
  # backend flags anything.
  log() { echo "[smoke description-check] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 name="tgs-decide-$STAMP" noul=0.95 dir first backend model block req key="smoke-jev-$STAMP"
  [ -n "${BREAK:-}" ] && noul=0.55
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
  [ $rc = 0 ] && log "laya: the note opens with a flag naming app: terraform_data.gone (destroy), and intent.json records the decision"
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
  [ $rc = 0 ] && log "laya, von, decider and jev each answered the description check through the same client, each pinned to its model, jev with its bearer token"
  return $rc
}

claim_telemetry/headers() {
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
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

claim_init/pinned_install() {
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

claim_generate/terragrunt() {
  # A Terragrunt repo of two units, live/dev/app and live/prod/app, each with
  # include "terragucci" and nothing of its own about backends or providers,
  # and a terragucci.yml whose generate key gives the s3 backend with a key
  # per unit, the aws provider and its version, and eu-west-1 for
  # live/prod/*. terragucci generate writes terragucci.hcl. The check step
  # init writes, run in the Terragrunt image as the check job runs it, passes:
  # hcl fmt, generate --check and hcl validate. tf-apply --terragrunt wave 1
  # then applies both units: each state lands at the key generate gives it,
  # and the providers.tf Terragrunt wrote for live/prod/app names eu-west-1.
  # BREAK: after generate, live/prod/app's include of terragucci.hcl is
  # dropped, so the check step refuses it by name and fails.
  log() { echo "[smoke tg-generate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bucket="tggen-$STAMP" body code=0 u rc=0
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  mkdir -p "$work/wave/modules/app"
  printf 'resource "terraform_data" "app" {\n  input = "app"\n}\n' > "$work/wave/modules/app/main.tf"
  printf '# Every unit takes its backend and providers from terragucci.hcl.\n' > "$work/wave/root.hcl"
  for u in live/dev/app live/prod/app; do
    mkdir -p "$work/wave/$u"
    printf 'include "terragucci" {\n  path = find_in_parent_folders("terragucci.hcl")\n}\n\nterraform {\n  source = "../../../modules/app"\n}\n' > "$work/wave/$u/terragrunt.hcl"
    cp "$EXAMPLE/envs/dev/platform/.terraform.lock.hcl" "$work/wave/$u/"
  done
  cat > "$work/wave/terragucci.yml" <<YML
forge: forgejo
binary: tofu
generate:
  backend:
    s3:
      bucket: $bucket
      key: "{root}/terraform.tfstate"
      region: us-east-1
      use_lockfile: true
      use_path_style: true
  providers:
    aws:
      source: hashicorp/aws
      version: "6.67.0"
      region: us-east-1
      s3_use_path_style: true
  dirs:
    "live/prod/*":
      providers: { aws: { region: eu-west-1 } }
YML
  printf '.terragrunt-cache/\nterragucci-report/\n' > "$work/wave/.gitignore"
  (cd "$work/wave" && "$TERRAGUCCI" generate >&2) || { log "generate failed"; drop_work "$work"; return 1; }
  [ -f "$work/wave/terragucci.hcl" ] || { log "generate wrote no terragucci.hcl"; drop_work "$work"; return 1; }
  # After generate, someone drops live/prod/app's include.
  [ -n "${BREAK:-}" ] && printf 'terraform {\n  source = "../../../modules/app"\n}\n' > "$work/wave/live/prod/app/terragrunt.hcl"
  (cd "$work/wave" && TERRAGUCCI_TERRAGRUNT=/nonexistent/terragrunt "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  body="$(check_step_body "$work/wave/.forgejo/workflows/terragucci.yml")"
  grep -q '^terragucci generate --check$' <<<"$body" || { log "the check step runs no terragucci generate --check"; rc=1; }
  audit_origin "$work"
  AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true sh -c "$body" > "$work/check.log" 2>&1 || code=$?
  cat "$work/check.log" >&2
  clean_mounted "$work/wave" "$image"
  if [ "$code" != 0 ]; then
    log "the check step exited $code"
    grep -q '^refused: live/prod/app/terragrunt.hcl does not include terragucci.hcl' "$work/check.log" && log "it refused live/prod/app, which does not include terragucci.hcl, by name"
    rc=1
  else
    grep -q '^generated files match terragucci.yml: 1 file for 2 units$' "$work/check.log" || { log "the check step did not say terragucci.hcl matches for both units"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    AUDIT_CODE=0
    AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true sh -c 'terragucci stage tf-apply --wave 1 --layers "live/dev/app,live/prod/app" --binary tofu --gate never --terragrunt && cat live/prod/app/.terragrunt-cache/*/*/providers.tf' > "$work/apply.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/apply.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "the wave exited $AUDIT_CODE, not 0"; rc=1; }
    for u in live/dev/app live/prod/app; do
      curl -fsS -o /dev/null "$FLOCI/$bucket/$u/terraform.tfstate" || { log "no state for $u at $bucket/$u/terraform.tfstate"; rc=1; }
    done
    grep -q 'region            = "eu-west-1"' "$work/apply.log" || { log "the providers.tf Terragrunt wrote for live/prod/app does not name eu-west-1"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "generate wrote terragucci.hcl, the check step passed it, and each unit applied with the backend key and the provider region generate gives it"
  return $rc
}

claim_generate/terragrunt_init() {
  # A Terragrunt repo of one unit, live/app, that includes terragucci.hcl,
  # and a terragucci.yml whose generate key gives the s3 backend in a bucket
  # nobody created, with disable_init: false. terragucci generate writes
  # disable_init = false in terragucci.hcl's remote_state; the check step
  # init writes passes it (hcl fmt, generate --check, hcl validate). Then
  # tf-apply --terragrunt wave 1, run in the Terragrunt image as the apply job
  # runs it, has Terragrunt bootstrap the backend: the bucket exists after,
  # and live/app's state is in it. force_path_style, not use_path_style, is
  # what Terragrunt's own S3 client reads to reach floci by path.
  # BREAK: terragucci.yml leaves disable_init out, so terragucci.hcl keeps
  # disable_init = true, nothing creates the bucket and the wave fails.
  log() { echo "[smoke tg-generate-init] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bucket="tggeninit-$STAMP" body code=0 rc=0 init_line="  disable_init: false"
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  [ -n "${BREAK:-}" ] && init_line=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null "$FLOCI/$bucket" 2>/dev/null && { log "the bucket $bucket exists before the run"; drop_work "$work"; return 1; }
  mkdir -p "$work/wave/modules/app" "$work/wave/live/app"
  printf 'resource "terraform_data" "app" {\n  input = "app"\n}\n' > "$work/wave/modules/app/main.tf"
  printf '# The unit takes its backend from terragucci.hcl.\n' > "$work/wave/root.hcl"
  printf 'include "terragucci" {\n  path = find_in_parent_folders("terragucci.hcl")\n}\n\nterraform {\n  source = "../../modules/app"\n}\n' > "$work/wave/live/app/terragrunt.hcl"
  cat > "$work/wave/terragucci.yml" <<YML
forge: forgejo
binary: tofu
generate:
$init_line
  backend:
    s3:
      bucket: $bucket
      key: "{root}/terraform.tfstate"
      region: us-east-1
      use_lockfile: true
      force_path_style: true
YML
  printf '.terragrunt-cache/\nterragucci-report/\n' > "$work/wave/.gitignore"
  (cd "$work/wave" && "$TERRAGUCCI" generate >&2) || { log "generate failed"; drop_work "$work"; return 1; }
  if grep -q '^  disable_init = false$' "$work/wave/terragucci.hcl"; then log "terragucci.hcl's remote_state has disable_init = false"
  else log "terragucci.hcl's remote_state has $(grep -m1 'disable_init' "$work/wave/terragucci.hcl" | sed 's/^ *//'), not disable_init = false"; rc=1; fi
  (cd "$work/wave" && TERRAGUCCI_TERRAGRUNT=/nonexistent/terragrunt "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  body="$(check_step_body "$work/wave/.forgejo/workflows/terragucci.yml")"
  audit_origin "$work"
  AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true sh -c "$body" > "$work/check.log" 2>&1 || code=$?
  cat "$work/check.log" >&2
  clean_mounted "$work/wave" "$image"
  [ "$code" = 0 ] || { log "the check step exited $code"; rc=1; }
  AUDIT_CODE=0
  AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers "live/app" --binary tofu --gate never --terragrunt > "$work/apply.log" 2>&1 || AUDIT_CODE=$?
  cat "$work/apply.log" >&2
  clean_mounted "$work/wave" "$image"
  [ "$AUDIT_CODE" = 0 ] || { log "the wave exited $AUDIT_CODE, not 0"; rc=1; }
  grep -q 'Terragrunt bootstraps its backend (TG_BACKEND_BOOTSTRAP)' "$work/apply.log" || { log "the wave did not say it bootstraps the backend"; rc=1; }
  curl -fsS -o /dev/null "$FLOCI/$bucket" || { log "the bucket $bucket does not exist after the wave"; rc=1; }
  curl -fsS -o /dev/null "$FLOCI/$bucket/live/app/terraform.tfstate" || { log "no state for live/app at $bucket/live/app/terraform.tfstate"; rc=1; }
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "generate wrote disable_init = false, the check step passed it, and the apply job had Terragrunt create $bucket and apply live/app into it"
  return $rc
}

claim_init/root_pins() {
  # Two roots in one wave: old pins OpenTofu 1.10.6 in its .opentofu-version,
  # which the tofu image does not carry, and new pins nothing. tf-plan, run in
  # the tofu image as the plan job runs it, installs 1.10.6 for old, checked
  # against its SHA256SUMS, and plans new with the image's tofu. Each root's
  # plan.json says which tofu made it, and the report and the note name each
  # root's binary and version.
  # BREAK: old's pin is ignored (the stage never sees it), so both roots plan
  # with the image's tofu.
  log() { echo "[smoke root-pins] $*" >&2; }
  local work rc=0 dir image carried old new r
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  for r in old new; do
    mkdir -p "$work/repo/$r"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "%s" {\n  input = "%s"\n}\n' "$r" "$r" > "$work/repo/$r/main.tf"
  done
  [ -n "${BREAK:-}" ] || echo 1.10.6 > "$work/repo/old/.opentofu-version"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "two roots, two versions"
  # One layer, so one wave: the stage plans both roots at once.
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TOFU_INSTALL_DIR=/cache/bin -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers 'new,old' --forge github >"$work/plan.log" 2>&1 || { log "the plan run failed"; rc=1; }
  cat "$work/plan.log" >&2
  clean_mounted "$work/repo" "$image"
  dir="$work/repo/terragucci-report"
  [ -f "$dir/report.json" ] || { log "the plan wrote no report"; drop_work "$work"; return 1; }
  [ "$(jq -c '[.waves[] | .roots | sort]' "$dir/report.json")" = '[["new","old"]]' ] || { log "old and new are not one wave: $(jq -c '[.waves[].roots]' "$dir/report.json")"; rc=1; }
  old="$(jq -r '.terraform_version // ""' "$dir/roots/old/plan.json" 2>/dev/null)"
  new="$(jq -r '.terraform_version // ""' "$dir/roots/new/plan.json" 2>/dev/null)"
  carried="$(jq -r '.roots[] | select(.path == "new") | .binary.version // ""' "$dir/report.json")"
  log "old planned with tofu ${old:-?}, new with tofu ${new:-?}; the image carries ${carried:-?}"
  [ "$old" = 1.10.6 ] || { log "old did not plan with the tofu 1.10.6 its .opentofu-version pins"; rc=1; }
  [ -n "$new" ] && [ "$new" = "$carried" ] && [ "$new" != 1.10.6 ] || { log "new did not plan with the image's tofu"; rc=1; }
  [ "$(jq -c '.roots[] | select(.path == "old") | .binary' "$dir/report.json")" = '{"name":"tofu","version":"1.10.6","pin":".opentofu-version"}' ] \
    || { log "the report does not name old's binary as tofu 1.10.6 pinned by .opentofu-version: $(jq -c '.roots[] | select(.path == "old") | .binary' "$dir/report.json")"; rc=1; }
  grep -qF "Binaries: tofu 1.10.6 for \`old\` (.opentofu-version); tofu $carried for 1 root." "$dir/note.md" || { log "the note does not name each root's binary and version"; rc=1; }
  grep -qF 'old: tofu 1.10.6 (.opentofu-version)' "$work/plan.log" || { log "the log does not say old runs tofu 1.10.6"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "one wave planned old with the tofu 1.10.6 it pins, installed and checked in the job, and new with the image's tofu $carried, and the report and the note name both"
  return $rc
}

claim_generate/tofu() {
  # Three roots under envs/ and a terragucci.yml whose generate key gives the
  # backend, the aws provider and its version at the repo level, a bucket for
  # envs/prod/* and a region for envs/prod/network. terragucci generate writes
  # each root's backend.tf, providers.tf and versions.tf. The repo-level bucket
  # changes, and a second generate rewrites the backend.tf of the one root that
  # takes it; the backend region changes, and a third rewrites all three. The
  # check step init writes, run in the tofu image as the check job runs it,
  # passes: generate --check, fmt -check over the generated files, and
  # validate in each root.
  # BREAK: envs/prod/app/backend.tf is edited by hand after generate, so the
  # check step refuses it by name and fails.
  log() { echo "[smoke generate] $*" >&2; }
  local work tree image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" out code=0 body r f rc=0
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  for r in envs/dev/app envs/prod/app envs/prod/network; do
    mkdir -p "$tree/$r"
    printf 'resource "terraform_data" "this" {\n  input = "%s"\n}\n' "$r" > "$tree/$r/main.tf"
    cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$tree/$r/"
  done
  cat > "$tree/terragucci.yml" <<'YML'
forge: forgejo
binary: tofu
roots: ["envs/*/*"]
generate:
  backend:
    s3:
      bucket: shop-terraform-state
      key: "generate/{root}.tfstate"
      region: us-east-1
      use_lockfile: true
      use_path_style: true
  providers:
    aws:
      source: hashicorp/aws
      version: "6.67.0"
      region: us-east-1
      s3_use_path_style: true
  required_version: ">= 1.6"
  dirs:
    "envs/prod/*":
      backend: { s3: { bucket: shop-terraform-state-prod } }
  roots:
    envs/prod/network:
      providers: { aws: { region: eu-west-1 } }
YML
  (cd "$tree" && "$TERRAGUCCI" generate >&2) || { log "generate failed"; drop_work "$work"; return 1; }
  for r in envs/dev/app envs/prod/app envs/prod/network; do
    for f in backend.tf providers.tf versions.tf; do
      [ -f "$tree/$r/$f" ] || { log "generate wrote no $r/$f"; rc=1; }
    done
  done
  grep -q 'region            = "eu-west-1"' "$tree/envs/prod/network/providers.tf" || { log "envs/prod/network does not configure aws in its own region"; rc=1; }
  grep -q 'key            = "generate/envs/dev/app.tfstate"' "$tree/envs/dev/app/backend.tf" || { log "envs/dev/app's state key does not name the root"; rc=1; }
  # One global changes: the repo-level bucket. The root that takes it follows; the prod roots keep their glob's.
  perl -pi -e 's#^      bucket: shop-terraform-state$#      bucket: shop-terraform-state-2#' "$tree/terragucci.yml"
  out="$(cd "$tree" && "$TERRAGUCCI" generate 2>&1)" || { echo "$out" >&2; log "the second generate failed"; drop_work "$work"; return 1; }
  echo "$out" >&2
  [ "$(grep '^updated ' <<<"$out" | tr '\n' ' ')" = "updated envs/dev/app/backend.tf " ] || { log "the second generate did not update exactly the backend file of the one root that takes the repo-level bucket"; rc=1; }
  grep -q 'bucket         = "shop-terraform-state-2"' "$tree/envs/dev/app/backend.tf" || { log "envs/dev/app's backend did not follow the new bucket"; rc=1; }
  for r in envs/prod/app envs/prod/network; do
    grep -q 'bucket         = "shop-terraform-state-prod"' "$tree/$r/backend.tf" || { log "$r lost the bucket its glob sets"; rc=1; }
  done
  # Another global: the backend's region, which no level below sets. Every root's backend.tf follows.
  perl -0pi -e 's#(key: "generate/\{root\}\.tfstate"\n      region: )us-east-1#${1}us-east-2#' "$tree/terragucci.yml"
  out="$(cd "$tree" && "$TERRAGUCCI" generate 2>&1)" || { echo "$out" >&2; log "the third generate failed"; drop_work "$work"; return 1; }
  echo "$out" >&2
  [ "$(grep '^updated ' <<<"$out" | tr '\n' ' ')" = "updated envs/dev/app/backend.tf updated envs/prod/app/backend.tf updated envs/prod/network/backend.tf " ] || { log "the backend region change did not reach exactly every root's backend.tf"; rc=1; }
  for r in envs/dev/app envs/prod/app envs/prod/network; do
    grep -q 'region         = "us-east-2"' "$tree/$r/backend.tf" || { log "$r's backend.tf does not name us-east-2"; rc=1; }
  done
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  body="$(check_step_body "$tree/.forgejo/workflows/terragucci.yml")"
  grep -q '^terragucci generate --check || failed=1$' <<<"$body" || { log "the check step runs no terragucci generate --check"; rc=1; }
  [ -n "${BREAK:-}" ] && perl -pi -e 's#shop-terraform-state-prod#hand-edited#' "$tree/envs/prod/app/backend.tf"
  git -C "$tree" init -q -b main
  git -C "$tree" add -A && git -C "$tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "generated roots"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$tree:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" sh -c "$body" >"$work/check.log" 2>&1 || code=$?
  cat "$work/check.log" >&2
  clean_mounted "$tree" "$image"
  if [ "$code" != 0 ]; then
    log "the check step exited $code"
    grep -q '^refused: envs/prod/app/backend.tf differs from what terragucci generate writes' "$work/check.log" && log "it refused the hand-edited envs/prod/app/backend.tf by name"
    rc=1
  else
    grep -q '^generated files match terragucci.yml: 9 files in 3 roots$' "$work/check.log" || { log "the check step did not say the 9 generated files match"; rc=1; }
    for r in envs/dev/app envs/prod/app envs/prod/network; do
      grep -q "^valid $r$" "$work/check.log" || { log "$r did not validate with its generated files"; rc=1; }
    done
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "generate wrote each root's backend, provider and version files from three levels, a changed global reached every root that takes it, and tf-check passed them"
  return $rc
}

claim_drift/close() {
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

claim_estate/control() {
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
    out="$(run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/control:/control" -w /control -v "$bundle:/usr/local/bin/terragucci:ro" \
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

claim_estate/override() {
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/page:/page" -w /page -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
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

claim_report/contracts() {
  # One project plans, then applies wave 1, with its reports in the bucket;
  # terragucci estate then writes estate.json to the same prefix. Each object
  # is read back from floci and held to the JSON Schema the built package
  # ships: both index.json files, estate.json and each run's report.json. The
  # check reads an object with properties as closed, so a field the writer
  # adds and the schema lacks fails it. Then a repo with no remote, in a
  # directory named views, plans: its upload is refused, and nothing is
  # under <prefix>/views/.
  # BREAK: the index is held to a copy of its schema without the row field
  # `changed`, as a schema that fell behind its writer would be.
  log() { echo "[smoke reader-contracts] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 code=0 prefix="reader-contracts-$STAMP" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" dist="$HERE/../packages/terragucci/dist" project=smoke.local/contracts/app schemas f out listed
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  for f in contracts views; do
    estate_project "$work/$f" "$(printf '  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s' "$REPORT_BUCKET" "$prefix")"
  done
  in_dir() { # project dir, then the command; the repo is named after the directory unless the environment names it
    local dir="$1"; shift
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/$dir:/work/$dir" -w "/work/$dir" -v "$bundle:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' "$image" "$@"
  }
  local named=(env GITHUB_SERVER_URL=http://smoke.local GITHUB_REPOSITORY=contracts/app GITHUB_RUN_ID=7)
  in_dir contracts "${named[@]}" terragucci stage tf-plan --layers app >&2 || { log "the plan run failed"; rc=1; }
  clean_mounted "$work/contracts" "$image"
  if [ $rc = 0 ]; then
    in_dir contracts "${named[@]}" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >&2 || { log "the wave failed"; rc=1; }
    clean_mounted "$work/contracts" "$image"
  fi
  if [ $rc = 0 ]; then
    mkdir -p "$work/page"
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/page:/page" -w /page -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
      "$image" terragucci estate --bucket "s3://$REPORT_BUCKET" --bucket-endpoint http://floci:4566 --bucket-prefix "$prefix" --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    mkdir -p "$work/got"
    curl -fsS -o "$work/got/top-index.json" "$FLOCI/$REPORT_BUCKET/$prefix/index.json" || { log "no index.json at the top of $prefix"; rc=1; }
    curl -fsS -o "$work/got/project-index.json" "$FLOCI/$REPORT_BUCKET/$prefix/$project/index.json" || { log "no index.json at $prefix/$project"; rc=1; }
    curl -fsS -o "$work/got/estate.json" "$FLOCI/$REPORT_BUCKET/$prefix/estate.json" || { log "no estate.json at $prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -r '[.reports[].stage] | sort | join(",")' "$work/got/project-index.json")" = "tf-apply,tf-plan" ] || { log "the project index lists $(jq -c '[.reports[].stage]' "$work/got/project-index.json"), not a plan and a wave"; rc=1; }
    local n=0 path
    for path in $(jq -r '.reports[].path' "$work/got/project-index.json"); do
      n=$((n + 1))
      curl -fsS -o "$work/got/report-$n.json" "$FLOCI/$REPORT_BUCKET/$prefix/$project/$path/report.json" || { log "no report.json at $prefix/$project/$path"; rc=1; }
    done
    schemas="$dist"
    if [ -n "${BREAK:-}" ]; then
      schemas="$work/schemas"; mkdir -p "$schemas"; cp "$dist"/*.schema.json "$schemas/"
      jq 'del(.["$defs"].row.properties.changed)' "$dist/report-index.schema.json" > "$schemas/report-index.schema.json"
    fi
    check() { (cd "$HERE/.." && npx tsx scripts/schema-check.ts "$@") >&2; }
    check "$schemas/report-index.schema.json" "$work/got/top-index.json" "$work/got/project-index.json" || { log "an index.json does not hold to report-index.schema.json"; rc=1; }
    check "$schemas/estate.schema.json" "$work/got/estate.json" || { log "estate.json does not hold to estate.schema.json"; rc=1; }
    check "$schemas/report.schema.json" "$work/got"/report-*.json || { log "a report.json does not hold to report.schema.json"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    out="$(in_dir views terragucci stage tf-plan --layers app 2>&1)" || code=$?
    clean_mounted "$work/views" "$image"
    printf '%s\n' "$out" | tail -n 5 >&2
    [ "$code" != 0 ] || { log "the plan of a project named views passed its upload"; rc=1; }
    grep -q "kept for viewers" <<<"$out" || { log "the refusal does not say the prefix is kept for viewers"; rc=1; }
    listed="$(curl -fsS "$FLOCI/$REPORT_BUCKET?list-type=2&prefix=$prefix/views/" | grep -o '<Key>[^<]*</Key>' || true)"
    [ -z "$listed" ] || { log "objects landed under $prefix/views/: $listed"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "both indexes, estate.json and both reports hold to the shipped schemas, and a project named views wrote nothing under $prefix/views/"
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

claim_note/footer() {
  # A scratch repo with two roots and a pull request that changes app. Its
  # plan note's last line is the footer, Forgejo's Markdown renderer makes an
  # image of the footer's taco, and the image answers 200 with a PNG.
  # BREAK: the plan job points the note's footer at an image the site does
  # not serve, so the note has a broken taco.
  log() { echo "[smoke note-footer] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/note-footer" wf head pr i note footer img html got magic rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo note-footer || return 1
  if [ -n "${BREAK:-}" ]; then
    wf="$work/tree/.forgejo/workflows/terragucci.yml"
    sed 's#\(cat terragucci-report/note.md; } >terragucci-report/plan-note.md\)$#\1; sed -i -e "s|brand/taco-small.png|brand/taco-gone.png|" terragucci-report/plan-note.md#' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'taco-gone' "$wf" || { log "BREAK found no line that writes the plan note"; drop_work "$work"; return 1; }
  fi
  echo 2 > "$work/tree/app/rev.txt"
  head="$(push_tree "$work/tree" "$repo" footer-change "note-footer: change app")" || return 1
  pr="$(pr_open "$repo" footer-change "note-footer: change app")" || return 1
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty')"
    [ -n "$note" ] && break
    sleep 3
  done
  [ -n "$note" ] || { log "pull request $pr has no plan note"; rc=1; }
  if [ $rc = 0 ]; then
    footer="$(printf '%s\n' "$note" | sed '/^[[:space:]]*$/d' | tail -1)"
    log "last line: $footer"
    [[ "$footer" == "<sub><img "*"Posted by [terragucci]("*"</sub>" ]] || { log "the note's last line is not the footer"; rc=1; }
    img="$(grep -o 'src="[^"]*"' <<<"$footer" | head -1 | sed 's/^src="//; s/"$//' || true)"
    html="$(api -H 'content-type: application/json' -X POST -d "$(jq -n --arg t "$footer" --arg c "$URL/$repo" '{Text: $t, Mode: "gfm", Context: $c}')" "$URL/api/v1/markdown" || true)"
    grep -qE "<img [^>]*src=\"$img\"" <<<"$html" || { log "Forgejo does not render the footer's image: $html"; rc=1; }
    got="$(curl -sS -m 20 -o "$work/taco.png" -w '%{http_code} %{content_type}' "$img" 2>/dev/null || true)"
    magic="$(head -c 8 "$work/taco.png" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
    log "$img answers ${got:-nothing}"
    [[ "$got" == "200 image/png"* ]] && [ "$magic" = 89504e470d0a1a0a ] || { log "the footer's image is not a PNG that answers 200"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "pull request $pr: the note ends with the footer, Forgejo renders its taco, and $img is a PNG"
  return $rc
}

claim_comment/dispatch() {
  # A scratch repo with two roots and a pull request that changes app. Once
  # its own plan finished, a user who can only read dispatches the plan
  # workflow with pr set: Forgejo refuses it with 403 and starts no run. The
  # admin dispatches it with pr set: the run's replan job re-plans the pull
  # request, posts a new terragucci/plan status on its head, and the
  # replan-note job edits the same plan note, the only one on the pull
  # request.
  # BREAK: the replan job's condition loses its workflow_dispatch clause, so
  # the dispatched run plans nothing and the note stays as it was.
  log() { echo "[smoke replan-dispatch] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/replan-dispatch" wf head pr i before after note0 note1 run code reader="smoke-reader-dispatch" pass rc=0
  local clause=" || (github.event_name == 'workflow_dispatch' && github.event.inputs.pr != '')"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo replan-dispatch || return 1
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  workflow_dispatch:' "$wf" || { log "the pipeline has no workflow_dispatch trigger"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # A dispatch runs the default branch's workflow, so the cut goes to main.
    CLAUSE="$clause" perl -pe 's/\Q$ENV{CLAUSE}\E$// if /^    if: \(github\.event_name == .issue_comment/' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    awk '/^  replan:$/ { on = 1; next } on && /^    if: / { print; exit }' "$wf" | grep -q "workflow_dispatch" && { log "BREAK did not cut the dispatch clause from the replan job"; drop_work "$work"; return 1; }
    MAIN_SHA="$(push_tree "$work/tree" "$repo" main "replan-dispatch: no dispatch clause")" || return 1
    wait_run "$repo" "$MAIN_SHA" || return 1
  fi
  echo 2 > "$work/tree/app/rev.txt"
  head="$(push_tree "$work/tree" "$repo" dispatch-change "replan-dispatch: change app")" || return 1
  pr="$(pr_open "$repo" dispatch-change "replan-dispatch: change app")" || return 1
  log "pull request $pr for ${head:0:8}"
  # The pull request's own plan first: pending, then its verdict, and its note.
  notes() { api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq -c '[.[] | select(.body | startswith("<!-- terragucci:plan")) | {id, updated_at}]'; }
  for i in $(seq 1 $(( TIMEOUT / 3 ))); do
    [ "$(statuses_of "$repo" "$head" terragucci/plan)" -ge 2 ] && [ "$(notes | jq length)" = 1 ] && break
    sleep 3
  done
  before="$(statuses_of "$repo" "$head" terragucci/plan)"
  note0="$(notes)"
  [ "$before" -ge 2 ] && [ "$(jq length <<<"$note0")" = 1 ] || { log "the pull request's own plan never finished with one note ($before statuses, notes $note0)"; drop_work "$work"; return 1; }
  dispatch() { # curl auth args... -> the HTTP code; the body in $work/dispatch.json
    curl -sS -o "$work/dispatch.json" -w '%{http_code}' "$@" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg pr "$pr" '{ref: "main", inputs: {pr: $pr}, return_run_info: true}')" \
      "$URL/api/v1/repos/$repo/actions/workflows/terragucci.yml/dispatches"
  }
  # A reader may not dispatch: Forgejo answers 403 and starts nothing.
  pass="Smoke-$STAMP-r9"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$reader?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$reader" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || { log "could not create $reader"; rc=1; }
  api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"read"}' "$URL/api/v1/repos/$repo/collaborators/$reader" || { log "could not add $reader as a reader"; rc=1; }
  code="$(dispatch -u "$reader:$pass")"
  log "a reader's dispatch: $code $(jq -r '.message // empty' "$work/dispatch.json" 2>/dev/null)"
  [ "$code" = 403 ] || { log "Forgejo did not refuse the dispatch of a reader"; rc=1; }
  # The admin's dispatch: a run of its own, whose replan job plans the pull request.
  code="$(dispatch -H "Authorization: token $TOKEN")"
  run="$(jq -r '.id // empty' "$work/dispatch.json" 2>/dev/null)"
  [ "$code" = 201 ] && [ -n "$run" ] || { log "the dispatch answered $code with no run"; drop_work "$work"; return 1; }
  ephemeral_wait "$repo" "$run"
  log "run $run, jobs: $(api "$URL/api/v1/repos/$repo/actions/runs/$run/jobs" | jq -r 'map("\(.name) \(.status)") | join(", ")')"
  for i in $(seq 1 20); do
    after="$(statuses_of "$repo" "$head" terragucci/plan)"
    note1="$(notes)"
    [ "$after" -gt "$before" ] && [ "$note1" != "$note0" ] && break
    sleep 3
  done
  log "terragucci/plan statuses on the head: $before before, $after after; plan notes $note0 then $note1"
  [ "$after" -gt "$before" ] || { log "the dispatch posted no new terragucci/plan status on the head"; rc=1; }
  [ "$(jq length <<<"$note1")" = 1 ] && [ "$(jq -r '.[0].id' <<<"$note1")" = "$(jq -r '.[0].id' <<<"$note0")" ] || { log "the re-plan did not keep one plan note"; rc=1; }
  [ "$(jq -r '.[0].updated_at' <<<"$note1")" != "$(jq -r '.[0].updated_at' <<<"$note0")" ] || { log "the re-plan did not update the plan note"; rc=1; }
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$reader?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "a reader's dispatch was refused; the admin's dispatch of pull request $pr re-planned it and updated its one note"
  return $rc
}

claim_note/stale() {
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

claim_pr_apply/confirm() {
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

claim_pr_apply/guard() {
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

claim_lock/close_release() {
  # On the lock-pr setup (apply.when: pull-request). Pull requests A and B each change
  # canary/one. /terragucci lock on A locks it; A is closed unmerged; then
  # /terragucci lock on B takes canary/one, which the closed A no longer holds.
  # BREAK: A stays open, so B is refused for the lock A holds.
  log() { echo "[smoke lock/close-release] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/lock-pr" pr_a pr_b reply rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  setup_shared lock-pr lock_pr_make || { drop_work "$work"; return 1; }
  echo a > "$work/tree/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" close-a "lock/close-release: a" >/dev/null || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  echo b > "$work/tree/canary/one/rev.txt"
  push_tree "$work/tree" "$repo" close-b "lock/close-release: b" >/dev/null || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" close-a "lock/close-release: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" close-b "lock/close-release: b")" || { drop_work "$work"; return 1; }
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

claim_lock/terragrunt_fanout() {
  # On the lock-tg setup (apply.when: pull-request). Pull request A changes
  # root.hcl, in no unit's directory: /terragucci lock on it says it locks
  # every unit because of root.hcl, and locks all three. Pull request B
  # changes Markdown only: /terragucci lock on it locks nothing.
  # BREAK: A changes live/fleet/three/rev.txt instead, so it locks that unit
  # alone.
  log() { echo "[smoke lock/terragrunt-fanout] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/lock-tg" pr_a pr_b reply held rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  setup_shared lock-tg lock_tg_make || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    echo a > "$work/tree/live/fleet/three/rev.txt"
  else
    printf '\n# a change outside every unit\n' >> "$work/tree/root.hcl"
  fi
  push_tree "$work/tree" "$repo" fanout-a "lock/terragrunt-fanout: a" >/dev/null || { drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q main
  printf '# Notes\n\nNothing here reaches a unit.\n' > "$work/tree/NOTES.md"
  push_tree "$work/tree" "$repo" fanout-b "lock/terragrunt-fanout: notes" >/dev/null || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" fanout-a "lock/terragrunt-fanout: a")" || { drop_work "$work"; return 1; }
  pr_b="$(pr_open "$repo" fanout-b "lock/terragrunt-fanout: notes")" || { drop_work "$work"; return 1; }
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

claim_security/token_scrub() {
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo/app -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 "${envs[@]}" \
      "$(image_tag tofu)" sh -c 'tofu init -input=false -no-color >/dev/null && tofu plan -input=false -no-color' >&2 || true
  else
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
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

claim_security/plan_token_free() {
  # A scratch repo with two roots. A pull request adds to app an external data
  # source, the change's own code, which looks for a forge token where it
  # runs: the forge token variables in its environment and in each parent
  # process's, by name, and a credential in the checkout's git config. It
  # prints only the names it found and fails the plan when it finds one. The
  # pull request's run and a /terragucci plan re-plan must both go green, and
  # the plan-note job must post the plan note and terragucci/plan success.
  # BREAK: the pushed workflow gives the plan job TG_TOKEN and its plan step
  # keeps the runner's token variables, as the plan job did before, so the
  # probe finds the token and the plan fails.
  log() { echo "[smoke plan-token-free] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/plan-token-free" wf head pr n rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  two_root_repo plan-token-free || return 1
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -n "${BREAK:-}" ]; then
    grep -v 'TG_NO_FORGE_TOKEN=1 bash' "$wf" | awk '
      /^  plan:$/ { inplan = 1 } /^  [a-z-]+:$/ && !/^  plan:$/ { inplan = 0 }
      { print } inplan && /^    env:$/ && !done { print "      TG_TOKEN: ${{ github.token }}"; done = 1 }' > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'TG_TOKEN: \${{ github.token }}' "$wf" || { log "could not give the plan job TG_TOKEN"; return 1; }
    MAIN_SHA="$(push_tree "$work/tree" "$repo" main "plan-token-free: the plan job holds the token")" || return 1
    wait_run "$repo" "$MAIN_SHA" || return 1
  fi
  git -C "$work/tree" checkout -q -B probe
  cat > "$work/tree/app/probe.sh" <<'SH'
#!/bin/sh
# Names only: which forge token variables and git credentials this process can reach.
found=""
names="TG_TOKEN TG_MERGE_TOKEN GITHUB_TOKEN GH_TOKEN GITEA_TOKEN FORGEJO_TOKEN ACTIONS_RUNTIME_TOKEN"
for v in $names; do
  eval "x=\${$v:-}"
  [ -z "$x" ] || found="$found env:$v"
done
p="$PPID"
while [ -n "$p" ] && [ "$p" -gt 1 ] && [ -r "/proc/$p/environ" ]; do
  for v in $names; do
    tr '\0' '\n' < "/proc/$p/environ" | grep -q "^$v=." && found="$found parent:$v"
  done
  p="$(awk '/^PPid:/ { print $2 }' "/proc/$p/status")"
done
git -C "$1" config --get-regexp '^http\..*extraheader$' >/dev/null 2>&1 && found="$found git-config:extraheader"
git -C "$1" remote get-url origin 2>/dev/null | grep -q '://[^/@]*@' && found="$found git-config:remote"
if [ -n "$found" ]; then echo "token-probe: reachable:$found" >&2; exit 1; fi
echo '{"probe":"clean"}'
SH
  chmod +x "$work/tree/app/probe.sh"
  # shellcheck disable=SC2016 # HCL interpolation
  printf 'terraform {\n  required_providers {\n    external = {\n      source  = "hashicorp/external"\n      version = "~> 2.3"\n    }\n  }\n}\n\ndata "external" "probe" {\n  program = ["sh", "${path.module}/probe.sh", abspath(path.root)]\n}\n\nresource "terraform_data" "probe" {\n  input = data.external.probe.result\n}\n' > "$work/tree/app/probe.tf"
  head="$(push_tree "$work/tree" "$repo" probe "plan-token-free: the change's code looks for a token")" || return 1
  pr="$(pr_open "$repo" probe "plan-token-free: probe")" || return 1
  wait_run "$repo" "$head" pull_request || return 1
  [ "$RUN_STATUS" = success ] || { log "the pull request's run ended '$RUN_STATUS'"; run_logs "$repo" "$RUN_ID" | grep -E 'token-probe|terragucci' | tail -20 >&2; rc=1; }
  [ "$(api "$URL/api/v1/repos/$repo/commits/$head/statuses?limit=100" | jq -r '[.[] | select(.context == "terragucci/plan")][0].status // empty')" = success ] || { log "terragucci/plan on ${head:0:8} is not success"; rc=1; }
  n="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=100" | jq '[.[] | select(.body | startswith("<!-- terragucci:plan roots="))] | length')"
  [ "$n" = 1 ] || { log "pull request $pr has $n plan notes; expected 1"; rc=1; }
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"body":"/terragucci plan"}' "$URL/api/v1/repos/$repo/issues/$pr/comments" || return 1
    wait_run "$repo" "$MAIN_SHA" issue_comment || return 1
    [ "$RUN_STATUS" = success ] || { log "the re-plan's run ended '$RUN_STATUS'"; run_logs "$repo" "$RUN_ID" | grep -E 'token-probe|terragucci' | tail -20 >&2; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the plan and the re-plan ran the change's code with no forge token in reach, and the note jobs posted the note and terragucci/plan"
  return $rc
}

claim_security/replan_apply_role() {
  # A scratch repo with oidc plan_role and apply_role in floci. A pull request
  # adds to app an external data source, the change's own code, that hunts for
  # a token the apply role's trust would accept: the token files the job's
  # variables name, a token asked for with the token-request variables in its
  # environment or in any parent process's, and any JWT in a file under
  # RUNNER_TEMP or /tmp. Each one it finds it checks against Forgejo's
  # published keys and, when it is a token for the default branch with
  # audience sts.amazonaws.com, trades with floci's STS for the apply role. It
  # writes what it found to floci and never fails the plan. A /terragucci plan
  # re-plan then runs it from the default branch's workflow: the re-plan must
  # go green, trade the job's token for the plan role alone and leave the
  # probe that role's keys, and leave it no token the apply role accepts and
  # no token-request variable. floci
  # grants any role a token names, so the subject and the audience are the
  # probe's own check, as they are an apply role's trust.
  # BREAK: init runs a bundle that renders the re-plan as it was: no trade
  # step, and a plan step that keeps the token-request variables and writes
  # the job's token to AWS_WEB_IDENTITY_TOKEN_FILE.
  log() { echo "[smoke replan-apply-role] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/replan-apply-role" head pr mark subrepo role trust rc=0 TERRAGUCCI="$TERRAGUCCI"
  local plan_role=terragucci-replan-plan apply_role=terragucci-replan-apply marks=shop-terraform-state/replan-apply-role
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      render.ts '      ...(trades ? [new Step({ if: go, name: "Trade the job'"'"'s OIDC token for the plan identities"' '      ...(false ? [new Step({ if: go, name: "Trade the job'"'"'s OIDC token for the plan identities"' \
      render.ts ': `${dropForgeTokens("bash", true)}\n${planFilesScript(binary, layers, forge, oidc, report, { replan: true, traded: trades })}`,' ': `${dropForgeTokens()}\n${planFilesScript(binary, layers, forge, oidc, report, { replan: true, sweep: false })}`,' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  fresh_repo replan-apply-role || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for mark in pull_request issue_comment; do curl -s -o /dev/null -X DELETE "$FLOCI/$marks/$mark.json" || true; done
  iam() { curl -sS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "Action=$1" --data-urlencode Version=2010-05-08 "${@:2}"; }
  for role in "$plan_role" "$apply_role"; do
    trust="$(jq -cn --arg repo "$repo" '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {Federated: "arn:aws:iam::000000000000:oidc-provider/forgejo:3000/api/actions"},
      Condition: {StringEquals: {"forgejo:3000/api/actions:aud": "sts.amazonaws.com"}, StringLike: {"forgejo:3000/api/actions:sub": "repo:\($repo):*"}}}]}')"
    iam CreateRole --data-urlencode "RoleName=$role" --data-urlencode "AssumeRolePolicyDocument=$trust" >/dev/null || true
    iam GetRole --data-urlencode "RoleName=$role" | grep -q "<RoleName>$role</RoleName>" || { log "floci has no role $role"; drop_work "$work"; return 1; }
  done
  mkdir -p "$work/tree/app"
  echo 1 > "$work/tree/app/rev.txt"
  # shellcheck disable=SC2016 # HCL interpolation
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "rev" {\n  input = file("${path.module}/rev.txt")\n}\n' > "$work/tree/app/main.tf"
  printf 'forge: forgejo\nbinary: tofu\ngate: never\noidc:\n  plan_role: arn:aws:iam::000000000000:role/%s\n  apply_role: arn:aws:iam::000000000000:role/%s\n' "$plan_role" "$apply_role" > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -q 'Trade the job' "$work/tree/.forgejo/workflows/terragucci.yml" && [ -n "${BREAK:-}" ] && { break_setup_failed "the BREAK pipeline still trades the token"; drop_work "$work"; return 1; }
  MAIN_SHA="$(push_tree "$work/tree" "$repo" main "replan-apply-role: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$MAIN_SHA" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { log "the push to main ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q -B probe
  cat > "$work/tree/app/probe.mjs" <<JS
// The change's own code: every token it can reach that the apply role's trust would accept.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const e = process.env, apply = "arn:aws:iam::000000000000:role/$apply_role";
const found = [], seen = new Set();
const add = (where, jwt) => { if (jwt && !seen.has(jwt)) { seen.add(jwt); found.push({ where, jwt }); } };
const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g;
const fileTokens = (where, f) => { try { for (const m of readFileSync(f, "utf8").matchAll(JWT)) add(where, m[0]); } catch {} };
for (const v of ["AWS_WEB_IDENTITY_TOKEN_FILE", "ARM_OIDC_TOKEN_FILE_PATH", "TERRAGUCCI_GCP_TOKEN_FILE"]) if (e[v]) fileTokens("file:" + v, e[v]);
// The token-request variables: this process's, then each parent's.
const asks = [];
if (e.ACTIONS_ID_TOKEN_REQUEST_URL) asks.push(["env", e.ACTIONS_ID_TOKEN_REQUEST_URL, e.ACTIONS_ID_TOKEN_REQUEST_TOKEN]);
let p = process.ppid;
while (p > 1) {
  try {
    const env = Object.fromEntries(readFileSync("/proc/" + p + "/environ", "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    if (env.ACTIONS_ID_TOKEN_REQUEST_URL) asks.push(["parent:" + p, env.ACTIONS_ID_TOKEN_REQUEST_URL, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN]);
    p = Number(/PPid:\s*(\d+)/.exec(readFileSync("/proc/" + p + "/status", "utf8"))[1]);
  } catch { break; }
}
for (const [where, url, tok] of asks) {
  try { const r = await fetch(url + "&audience=sts.amazonaws.com", { headers: { authorization: "bearer " + tok } }); if (r.ok) add("request:" + where, (await r.json()).value); } catch {}
}
// Any file under the job's temp directories that holds a JWT.
const walk = (d, depth) => { let names = []; try { names = readdirSync(d); } catch { return; } for (const n of names) { const f = d + "/" + n; let s; try { s = statSync(f); } catch { continue; } if (s.isDirectory() && depth > 0) walk(f, depth - 1); else if (s.isFile() && s.size < 65536) fileTokens("file:" + f, f); } };
for (const d of [e.RUNNER_TEMP, "/tmp"].filter(Boolean)) walk(d, 2);
const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString());
const server = (e.GITHUB_SERVER_URL || "").replace(/\/\$/, "");
let jwks = { keys: [] };
try { const conf = await (await fetch(server + "/api/actions/.well-known/openid-configuration")).json(); jwks = await (await fetch(conf.jwks_uri)).json(); } catch {}
const out = [];
for (const { where, jwt } of found) {
  const [h, b, s] = jwt.split(".");
  let head, claims; try { head = dec(h); claims = dec(b); } catch { continue; }
  const jwk = jwks.keys.find((k) => !head.kid || k.kid === head.kid);
  let verified = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" }), data = Buffer.from(h + "." + b), sig = Buffer.from(s, "base64url");
    const hash = { 256: "sha256", 384: "sha384", 512: "sha512" }[String(head.alg).slice(2)];
    verified = head.alg === "EdDSA" ? verify(null, data, key, sig) : verify(hash, data, String(head.alg).startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
  } catch {}
  const accepted = verified && String(claims.sub).endsWith(":ref:refs/heads/main") && [claims.aud].flat().includes("sts.amazonaws.com");
  let assumed;
  if (accepted && e.AWS_ENDPOINT_URL) {
    const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: apply, RoleSessionName: "probe", WebIdentityToken: jwt });
    try { assumed = (await (await fetch(e.AWS_ENDPOINT_URL + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).text()).match(/<AssumedRoleUser>[\s\S]*?<Arn>([^<]+)<\/Arn>/)?.[1]; } catch {}
  }
  out.push({ where, sub: claims.sub, aud: claims.aud, verified, accepted, ...(assumed ? { assumed } : {}) });
}
// The identities the trade step left this step, by name.
let traded = [];
try { traded = Object.keys(JSON.parse(readFileSync(e.CHANT_CLOUD_TARGETS, "utf8")).clouds?.aws?.vars ?? {}); } catch {}
const mark = { event: e.GITHUB_EVENT_NAME, tokens: out, traded, asks: asks.map(([w]) => w) };
try { await fetch(e.AWS_ENDPOINT_URL + "/$marks/" + e.GITHUB_EVENT_NAME + ".json", { method: "PUT", body: JSON.stringify(mark) }); } catch {}
console.error("apply-role probe: " + JSON.stringify({ ...mark, tokens: out.map(({ where, sub, accepted }) => ({ where, sub, accepted })) }));
console.log("{}");
JS
  # shellcheck disable=SC2016 # HCL interpolation
  printf 'terraform {\n  required_providers {\n    external = {\n      source  = "hashicorp/external"\n      version = "~> 2.3"\n    }\n  }\n}\n\ndata "external" "probe" {\n  program = ["node", "${path.module}/probe.mjs"]\n}\n\nresource "terraform_data" "probe" {\n  input = data.external.probe.result\n}\n' > "$work/tree/app/probe.tf"
  head="$(push_tree "$work/tree" "$repo" probe "replan-apply-role: the change's code hunts for a token")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" probe "replan-apply-role: probe")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$head" pull_request || { drop_work "$work"; return 1; }
  log "the pull request's run: $RUN_STATUS, mark $(curl -fsS "$FLOCI/$marks/pull_request.json" 2>/dev/null | jq -c '[.tokens[] | {where, sub, accepted}]' 2>/dev/null || echo none)"
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"body":"/terragucci plan"}' "$URL/api/v1/repos/$repo/issues/$pr/comments" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$MAIN_SHA" issue_comment || { drop_work "$work"; return 1; }
  mark="$(curl -fsS "$FLOCI/$marks/issue_comment.json" 2>/dev/null || true)"
  log "the re-plan's run: $RUN_STATUS, mark ${mark:-none}"
  [ "$RUN_STATUS" = success ] || { log "the re-plan's run ended '$RUN_STATUS'"; run_logs "$repo" "$RUN_ID" | grep -E 'apply-role probe|terragucci' | tail -20 >&2; rc=1; }
  if [ -z "$mark" ]; then
    log "the probe wrote no mark in the re-plan: the change's code did not run there"; rc=1
  else
    # Forgejo 16 names a repo in the subject as owner-<id>/repo-<id>.
    subrepo="$(api "$URL/api/v1/repos/$repo" | jq -r '"\(.owner.login)-\(.owner.id)/\(.name)-\(.id)"')"
    jq -e --arg sub "repo:$subrepo:ref:refs/heads/main" '[.tokens[] | select(.accepted or .sub == $sub)] | length == 0' <<<"$mark" >/dev/null \
      || { log "the re-plan's code reached a token for main with audience sts.amazonaws.com: $(jq -c '[.tokens[] | select(.accepted) | {where, sub, assumed}]' <<<"$mark")"; rc=1; }
    jq -e '.asks | length == 0' <<<"$mark" >/dev/null || { log "the re-plan's code reached the token-request variables: $(jq -c .asks <<<"$mark")"; rc=1; }
    jq -e --arg plan "arn:aws:iam::000000000000:role/$plan_role" '.traded == [$plan]' <<<"$mark" >/dev/null \
      || { log "the re-plan's step holds $(jq -c .traded <<<"$mark") traded, not the plan role alone"; rc=1; }
  fi
  [ $rc = 0 ] && { run_logs "$repo" "$RUN_ID" | grep -q "traded the job's OIDC token for arn:aws:iam::000000000000:role/$plan_role" || { log "the re-plan's log does not say it traded the token for $plan_role"; rc=1; }; }
  drop_work "$work"
  [ $rc = 0 ] && log "the re-plan traded its token for the plan role, and the change's code found no token the apply role accepts and no way to ask for one"
  return $rc
}

claim_security/replan_cache() {
  # A Terragrunt scratch repo (the gated-waves fixture, gate: never) whose
  # module carries an external data source, the change's own code: in an
  # issue_comment run it writes a marker into the workspace's
  # .terragrunt-cache, and in every run it records in floci whether the
  # marker is there. A pull request changes live/canary/one/terragrunt.hcl,
  # so its cache key is one no run on main has saved (Forgejo keeps what the
  # pull request's own run saves to that pull request). /terragucci plan
  # re-plans it from the default branch's workflow, and the probe writes the
  # marker; then the pull request merges. The push of the merge commit
  # restores the cache under that key in its apply waves: the probe must run
  # there and find no marker, so the re-plan saved no cache the apply jobs
  # restore.
  # The stack's runner has no cache server, so every job runs on a runner of
  # the claim's own (cached_runner) with one on. root.hcl carries a comment
  # unique to the run, so no key matches a cache an earlier run saved.
  # BREAK: init runs a bundle whose re-plan caches as the plan job does,
  # saving .terragrunt-cache when the job ends.
  log() { echo "[smoke replan-cache] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/replan-cache" head pr merge marks=shop-terraform-state/replan-cache-marks keys k got wrote=0 ran=0 seen=0 rc=0 TERRAGUCCI="$TERRAGUCCI"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    TERRAGUCCI="$work/break.mjs"
    break_bundle "$TERRAGUCCI" \
      render.ts '      ...toolSteps(true, true, go, true),' '      ...toolSteps(true, true, go),' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  gated_repo replan-cache tg-gated-waves || { drop_work "$work"; return 1; }
  sed -i.bak 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"
  cached_runner >/dev/null || { drop_work "$work"; return 1; }
  printf 'runner: %s\n' "$CACHED_LABEL" >> "$work/tree/terragucci.yml"
  printf '\n# run %s\n' "${work##*/}" >> "$work/tree/root.hcl"
  for k in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=replan-cache-marks/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$k" || true
  done
  # The change's own code, in every unit's module: it plants in a re-plan, and looks in every run.
  cat > "$work/tree/modules/rev/probe.mjs" <<JS
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const e = process.env;
const dir = e.TG_DOWNLOAD_DIR ? e.TG_DOWNLOAD_DIR.replace(/\/sources\/?\$/, "") : (e.GITHUB_WORKSPACE || ".") + "/.terragrunt-cache";
const marker = dir + "/replan-planted";
let wrote = false;
if (e.GITHUB_EVENT_NAME === "issue_comment") { try { mkdirSync(dir, { recursive: true }); writeFileSync(marker, e.GITHUB_SHA || "planted"); wrote = true; } catch {} }
const mark = { event: e.GITHUB_EVENT_NAME, job: e.GITHUB_JOB, sha: e.GITHUB_SHA, dir, wrote, seen: existsSync(marker) && !wrote };
try { await fetch(e.AWS_ENDPOINT_URL + "/$marks/" + e.GITHUB_EVENT_NAME + "-" + e.GITHUB_SHA + "-" + e.GITHUB_JOB + "-" + process.pid + ".json", { method: "PUT", body: JSON.stringify(mark) }); } catch {}
console.error("replan-cache probe: " + JSON.stringify(mark));
console.log("{}");
JS
  # shellcheck disable=SC2016 # HCL interpolation
  printf '\ndata "external" "probe" {\n  program = ["node", "${path.module}/probe.mjs"]\n}\n' >> "$work/tree/modules/rev/main.tf"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -qx "    runs-on: $CACHED_LABEL" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init did not write runs-on: $CACHED_LABEL"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    grep -q 'actions/cache/restore@' "$work/tree/.forgejo/workflows/terragucci.yml" && { break_setup_failed "the BREAK pipeline's re-plan still restores the cache read-only"; drop_work "$work"; return 1; }
  else
    grep -q 'actions/cache/restore@' "$work/tree/.forgejo/workflows/terragucci.yml" || { log "the pipeline's re-plan does not restore the cache read-only"; drop_work "$work"; return 1; }
  fi
  MAIN_SHA="$(push_tree "$work/tree" "$repo" main "replan-cache: first")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$MAIN_SHA" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { log "the push to main ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; drop_work "$work"; return 1; }
  git -C "$work/tree" checkout -q -B plant
  printf '\n# a change to the cache key\n' >> "$work/tree/live/canary/one/terragrunt.hcl"
  echo 2 > "$work/tree/live/canary/one/rev.txt"
  head="$(push_tree "$work/tree" "$repo" plant "replan-cache: a new cache key")" || { drop_work "$work"; return 1; }
  pr="$(pr_open "$repo" plant "replan-cache: plant")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$head" pull_request || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"body":"/terragucci plan"}' "$URL/api/v1/repos/$repo/issues/$pr/comments" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$MAIN_SHA" issue_comment || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { log "the re-plan's run ended '$RUN_STATUS'"; rc=1; }
  log "the re-plan's cache: $(run_logs "$repo" "$RUN_ID" | grep -iE 'cache (restored|saved|not found)|replan-cache probe' | tail -6 | tr '\n' ' ')"
  keys="$(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=replan-cache-marks/issue_comment-" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g')"
  for k in $keys; do curl -fsS "$FLOCI/shop-terraform-state/$k" | jq -e .wrote >/dev/null 2>&1 && wrote=$((wrote + 1)); done
  [ "$wrote" -gt 0 ] || { log "the probe planted nothing in the re-plan: the change's code did not run there"; rc=1; }
  if [ $rc = 0 ]; then
    merge_pr "$repo" "$pr" || { drop_work "$work"; return 1; }
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    [ -n "$merge" ] || { log "pull request $pr has no merge commit"; drop_work "$work"; return 1; }
    wait_run "$repo" "$merge" push || { drop_work "$work"; return 1; }
    log "the merge's run: $RUN_STATUS; its cache: $(run_logs "$repo" "$RUN_ID" | grep -iE 'cache (restored|saved|not found)|replan-cache probe' | tail -8 | tr '\n' ' ')"
    keys="$(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=replan-cache-marks/push-$merge-" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g')"
    for k in $keys; do
      got="$(curl -fsS "$FLOCI/shop-terraform-state/$k" 2>/dev/null || true)"
      ran=$((ran + 1))
      jq -e .seen <<<"$got" >/dev/null 2>&1 && { seen=$((seen + 1)); log "the planted marker reached $(jq -r .job <<<"$got") on main: $got"; }
    done
    [ "$ran" -gt 0 ] || { log "the probe ran in no job of the merge's run, so no job there restored the cache under the new key"; rc=1; }
    [ "$seen" = 0 ] || { log "the re-plan saved a cache that $seen probe run(s) of the merge's run restored with its marker"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the re-plan planted a marker in .terragrunt-cache and saved no cache: the merge's apply jobs ($ran probe runs) restored none of it"
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
    --data-urlencode "password=$TG_FORGEJO_ADMIN_PW" "$URL/user/login" || return 1
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

claim_security/fork() {
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

claim_report/sensitive() {
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

# ── plans and the state lock, sensitive values, the provider cache ────────

claim_lock/plan_none() {
  # One root on floci's S3 with use_lockfile, applied once. An apply of a
  # change to it takes the root's lock and holds it at its approval prompt.
  # While the lock object is in the bucket, a pull request plan of the change
  # (tf-plan with TG_BASE) and a drift run (tf-drift) run on the root, each
  # with -lock-timeout=30s, as a job that waits for locks sets it. Both must
  # plan the root, and the apply must still hold its lock when both are done:
  # neither took the lock or waited for it.
  # BREAK: a bundle whose plan leaves out -lock=false (break_bundle), so the
  # pull request plan waits 30s for the lock and fails.
  log() { echo "[smoke plan-no-lock] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" bucket=terragucci-smoke-lock
  local key holder="terragucci-smoke-plan-no-lock-$STAMP${BREAK:+-break}" base i rc=0 s t0 took
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    # shellcheck disable=SC2016 # TypeScript, not shell
    break_bundle "$bundle" report/stage.ts '"-no-color", "-lock=false", ...estate.args' '"-no-color", ...estate.args' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  key="plan-no-lock/$STAMP${BREAK:+-break}/terraform.tfstate"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || true
  root_tf() { # input
    printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "%s"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "x" {\n  input = "%s"\n}\n' "$bucket" "$key" "$1"
  }
  mkdir -p "$work/repo/app" "$work/holder/app"
  root_tf one > "$work/repo/app/main.tf"
  root_tf two > "$work/holder/app/main.tf"
  printf 'binary: tofu\nroots: ["app"]\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "plan-no-lock: one"
  base="$(git -C "$work/repo" rev-parse HEAD)"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo/app "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    "$image" sh -c 'tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 \
    || { log "the first apply failed"; drop_work "$work"; return 1; }
  clean_mounted "$work/repo"
  # The holder's apply plans input = two and waits at its approval prompt, the
  # lock held, until /tmp/release appears (or ten minutes pass); then stdin
  # closes, the apply is cancelled and lets go of the lock.
  # shellcheck disable=SC2016 # expanded by the container's shell
  run_copied -d --name "$holder" --network "${TG_NETWORK:-terragucci}" -v "$work/holder:/repo" -w /repo/app "${AWS_DOCKER_ENV[@]}" \
    "$image" sh -c 'tofu init -input=false -no-color >/dev/null && { i=0; while [ ! -f /tmp/release ] && [ $i -lt 600 ]; do sleep 1; i=$((i+1)); done; } | tofu apply -input=true -no-color' >/dev/null \
    || { log "the holding apply did not start"; drop_work "$work"; return 1; }
  lock_held() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$bucket/$key.tflock")" = 200 ]; }
  for i in $(seq 1 90); do lock_held && break; sleep 1; done
  if ! lock_held; then
    log "the apply never took the lock ($key.tflock is not in $bucket)"; docker logs "$holder" 2>&1 | tail -5 >&2 || true; rc=1
  else
    log "the apply holds $key.tflock"
  fi
  root_tf two > "$work/repo/app/main.tf"
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "plan-no-lock: two"
  for s in tf-plan tf-drift; do
    [ $rc = 0 ] || break
    t0="$(date +%s)"
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TF_CLI_ARGS_plan=-lock-timeout=30s -e "TG_BASE=$base" \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage "$s" --layers app --out "$s-report" >&2 || { log "$s failed while the apply held the lock"; rc=1; }
    took=$(( $(date +%s) - t0 ))
    clean_mounted "$work/repo"
    [ $rc = 0 ] || break
    jq -e '.roots[] | select(.path == "app" and .status == "planned")' "$work/repo/$s-report/report.json" >/dev/null 2>&1 || { log "$s did not plan app"; rc=1; break; }
    lock_held && [ "$(docker inspect -f '{{.State.Running}}' "$holder" 2>/dev/null)" = true ] \
      || { log "the apply no longer holds the lock once $s is done: $s waited for it"; rc=1; break; }
    log "$s planned app in ${took}s, the apply still holding the lock"
  done
  # tf-drift has no base: the refresh-only plan reads the real objects.
  [ $rc = 0 ] && { jq -e '.run.stage == "tf-drift"' "$work/repo/tf-drift-report/report.json" >/dev/null || { log "the drift report is not a tf-drift report"; rc=1; }; }
  docker exec "$holder" touch /tmp/release >/dev/null 2>&1 || true
  for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Running}}' "$holder" 2>/dev/null)" = true ] || break; sleep 1; done
  # awk ends the last line, which the prompt leaves open, so the SMOKE line starts a line of its own.
  docker logs "$holder" 2>&1 | tail -3 | awk '{ print "[holder] " $0 }' >&2 || true
  docker rm -f "$holder" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$key.tflock" || true
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$key" || true
  drop_work "$work"
  [ $rc = 0 ] && log "a pull request plan and a drift run planned app while an apply held its lock, and neither waited"
  return $rc
}

claim_note/sensitive() {
  # One root with a sensitive variable, db_password, that a terraform_data
  # takes as its input, and a sensitive output, token, its upper case. Applied
  # with one password and planned by tf-plan with another, the report copied
  # to a fresh prefix of the reports bucket on floci. Neither password nor
  # either token is in the plan note, report.json, report.html, any other file
  # of the report, the job log, index.json or any object under the prefix.
  # BREAK: a bundle whose redactPlan returns the plan as the binary printed it
  # (break_bundle), so show -json's plain values reach plan.json.
  log() { echo "[smoke sensitive-redacted] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" prefix="smoke-sensitive-$STAMP${BREAK:+-break}" rc=0
  local old="tg-old-pw-$STAMP" new="tg-new-pw-$STAMP" values=() v f k keys dir n=0
  values=("$old" "$new" "$(tr '[:lower:]' '[:upper:]' <<<"$old")" "$(tr '[:lower:]' '[:upper:]' <<<"$new")")
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" report/redact.ts 'export function redactPlan(plan: unknown): Redacted {' 'export function redactPlan(plan: unknown): Redacted {
  return { plan, values: 0 };' || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  mkdir -p "$work/repo/app"
  cat > "$work/repo/app/main.tf" <<'HCL'
terraform {
  backend "local" {}
}

variable "db_password" {
  type      = string
  sensitive = true
}

resource "terraform_data" "db" {
  input = var.db_password
}

output "token" {
  value     = upper(var.db_password)
  sensitive = true
}
HCL
  printf 'binary: tofu\nroots: ["app"]\nreports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/repo/terragucci.yml"
  in_image "$work/repo" env "TF_VAR_db_password=$old" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 \
    || { log "the first apply failed"; drop_work "$work"; return 1; }
  clean_mounted "$work/repo"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" remote add origin "http://forgejo:3000/$USER/example.git"
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke sensitive-redacted"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    "${AWS_DOCKER_ENV[@]}" -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e "TF_VAR_db_password=$new" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers app >"$work/job.log" 2>&1 || { log "the plan run exited non-zero"; rc=1; }
  sed 's/^/[job] /' "$work/job.log" >&2
  clean_mounted "$work/repo"
  dir="$work/repo/terragucci-report"
  leaks() { # what, file: the values the file holds
    for v in "${values[@]}"; do grep -qF -- "$v" "$2" && { log "$1 holds a sensitive value ($v)"; return 0; }; done
    return 1
  }
  if [ $rc = 0 ]; then
    for f in note.md report.json report.html; do [ -s "$dir/$f" ] || { log "the run wrote no $f"; rc=1; }; done
    # The plan must change both, or there is nothing to redact.
    jq -e '.roots[] | select(.path == "app") | .changes[] | select(.address == "terraform_data.db" and .action == "update")' "$dir/report.json" >/dev/null \
      || { log "the report shows no update of terraform_data.db"; rc=1; }
    grep -q 'token' "$dir/$(jq -r '.roots[] | select(.path == "app") | .plan.text' "$dir/report.json")" || { log "the plan shows no change to the output token"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    while IFS= read -r f; do
      n=$((n + 1))
      leaks "${f#"$dir"/}" "$f" && rc=1
    done < <(find "$dir" -type f)
    leaks "the job log" "$work/job.log" && rc=1
    keys="$(curl -fsS "$FLOCI/$REPORT_BUCKET?list-type=2&prefix=$prefix/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true)"
    grep -q '/index.json$' <<<"$keys" || { log "no index.json under $REPORT_BUCKET/$prefix"; rc=1; }
    grep -q '/report.json$' <<<"$keys" || { log "no report.json under $REPORT_BUCKET/$prefix"; rc=1; }
    for k in $keys; do
      curl -fsS -o "$work/object" "$FLOCI/$REPORT_BUCKET/$k" || { log "could not read $k"; rc=1; continue; }
      leaks "$REPORT_BUCKET/$k" "$work/object" && rc=1
    done
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "a changed sensitive variable and output: none of the four values is in the $n report files, the job log or the $(wc -w <<<"$keys" | tr -d ' ') objects under $REPORT_BUCKET/$prefix"
  return $rc
}

claim_apply/provider_cache() {
  # A wave of eight roots, r1 to r8, each a null_resource of hashicorp/null
  # 3.2.4 with the .terraform.lock.hcl that pins it (stack/fixtures/
  # provider-cache), planned by tf-plan in one job whose TF_PLUGIN_CACHE_DIR
  # is an empty volume of its own. The job log names one download of the
  # provider, and the volume holds one copy of it.
  # BREAK: a bundle in which each root inits with a cache of its own under
  # the volume (break_bundle), so each of the eight downloads the provider.
  log() { echo "[smoke provider-cache-once] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" vol="terragucci-smoke-provider-cache-$STAMP${BREAK:+-break}" layer="" i rc=0 got copies
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    # shellcheck disable=SC2016 # TypeScript, not shell
    break_bundle "$bundle" \
      report/stage.ts 'const initTurn = oneAtATime();' 'const initTurn = oneAtATime();
  const rootCache = (i: number): string => { const d = join(binEnv.TF_PLUGIN_CACHE_DIR!, `root-${i}`); mkdirSync(d, { recursive: true }); return d; };' \
      report/stage.ts 'const rootEnv = rootCacheEnv(workspaceEnv(rootRoleEnv(binEnv, root), dir), dir, bin.name);' 'const rootEnv = rootCacheEnv(workspaceEnv(rootRoleEnv({ ...binEnv, TF_PLUGIN_CACHE_DIR: rootCache(index) }, root), dir), dir, bin.name);' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  for i in 1 2 3 4 5 6 7 8; do
    mkdir -p "$work/repo/r$i"
    printf 'terraform {\n  required_providers {\n    null = {\n      source  = "hashicorp/null"\n      version = "3.2.4"\n    }\n  }\n}\n\nresource "null_resource" "n" {\n  triggers = {\n    root = "r%s"\n  }\n}\n' "$i" > "$work/repo/r$i/main.tf"
    cp "$HERE/fixtures/provider-cache/.terraform.lock.hcl" "$work/repo/r$i/"
    layer="${layer:+$layer,}r$i"
  done
  printf 'binary: tofu\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke provider-cache-once"
  docker volume create "$vol" >/dev/null || { log "could not make the volume $vol"; drop_work "$work"; return 1; }
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$vol:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers "$layer" >"$work/job.log" 2>&1 || { log "the plan run exited non-zero"; rc=1; }
  sed 's/^/[job] /' "$work/job.log" >&2
  clean_mounted "$work/repo"
  if [ $rc = 0 ]; then
    got="$(jq '[.roots[] | select(.status == "planned")] | length' "$work/repo/terragucci-report/report.json" 2>/dev/null || echo 0)"
    [ "$got" = 8 ] || { log "the wave planned $got of its eight roots"; rc=1; }
    got="$(grep -c ': downloaded hashicorp/null v3.2.4' "$work/job.log" || true)"
    [ "$got" = 1 ] || { log "the job log names $got downloads of hashicorp/null v3.2.4"; rc=1; }
    copies="$(docker run --rm -v "$vol:/cache" "$image" sh -c 'find /cache -type d -path "*/hashicorp/null/3.2.4/*" -name "*_*"' | grep -c . || true)"
    [ "$copies" = 1 ] || { log "the cache volume holds $copies copies of hashicorp/null v3.2.4"; rc=1; }
  fi
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "eight roots planned with one download of hashicorp/null v3.2.4 in the job log and one copy in the cache volume"
  return $rc
}

claim_apply/provider_cache_no_lock() {
  # With binary: terraform, a wave of nine roots, r1 to r9, each a
  # null_resource of hashicorp/null 3.2.4, planned by tf-plan in one job whose
  # TF_PLUGIN_CACHE_DIR is an empty volume of its own. r1 to r8 have no
  # .terraform.lock.hcl; r9 has the OpenTofu lock of stack/fixtures/
  # provider-cache, which names registry.opentofu.org, so Terraform has no
  # entry for its provider either. Every root plans, the stage log counts all
  # nine as taking their providers from the shared cache with no lock entry,
  # the job log names one download, and no init fails with "text file busy".
  # BREAK: rootCacheEnv returns the env unchanged (break_bundle), so no root
  # sets TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE and each init downloads
  # the provider again. The verdict rests on the download count, which is
  # deterministic; whether a download lands on a running plan is timing.
  log() { echo "[smoke provider-cache-no-lock] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" vol="terragucci-smoke-provider-cache-no-lock-$STAMP${BREAK:+-break}" layer="" i rc=0 got
  image="$(image_tag terraform)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" \
      report/stage.ts 'if (!env.TF_PLUGIN_CACHE_DIR || lockCovers(dir, binaryName)) return env;' 'return env;' \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  for i in 1 2 3 4 5 6 7 8 9; do
    mkdir -p "$work/repo/r$i"
    printf 'terraform {\n  required_providers {\n    null = {\n      source  = "hashicorp/null"\n      version = "3.2.4"\n    }\n  }\n}\n\nresource "null_resource" "n" {\n  triggers = {\n    root = "r%s"\n  }\n}\n' "$i" > "$work/repo/r$i/main.tf"
    layer="${layer:+$layer,}r$i"
  done
  cp "$HERE/fixtures/provider-cache/.terraform.lock.hcl" "$work/repo/r9/"
  printf 'binary: terraform\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke provider-cache-no-lock"
  docker volume create "$vol" >/dev/null || { log "could not make the volume $vol"; drop_work "$work"; return 1; }
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/repo:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$vol:/cache" -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan --layers "$layer" >"$work/job.log" 2>&1 || { log "the plan run exited non-zero"; rc=1; }
  sed 's/^/[job] /' "$work/job.log" >&2
  clean_mounted "$work/repo"
  got="$(grep -c ': downloaded hashicorp/null v3.2.4' "$work/job.log" || true)"
  [ "$got" = 1 ] || { log "the job log names $got downloads of hashicorp/null v3.2.4"; rc=1; }
  if grep -qi 'text file busy' "$work/job.log"; then log "an init failed with text file busy"; rc=1; fi
  if [ $rc = 0 ]; then
    got="$(jq '[.roots[] | select(.status == "planned")] | length' "$work/repo/terragucci-report/report.json" 2>/dev/null || echo 0)"
    [ "$got" = 9 ] || { log "the wave planned $got of its nine roots"; rc=1; }
    grep -q '9 roots take their providers from the shared cache with no lock entry' "$work/job.log" \
      || { log "the stage did not count all nine roots, r9 with its OpenTofu lock among them, as having no lock entry for Terraform"; rc=1; }
  fi
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "nine roots on Terraform, eight with no lock file and one with an OpenTofu lock, planned with one download of hashicorp/null v3.2.4 and no text file busy"
  return $rc
}

# ── approval upkeep ───────────────────────────────────────────────────────

claim_approval/signer_trust() {
  # The gated fixture under approval: sealed with no signers file. In the
  # checkout, git config user.signingkey names the approver key, and
  # terragucci init --signer smoke-approver writes .chant/allowed_signers from
  # it. wave 1 waits; an approval sealed with the key lets canary/one apply.
  # Where the signers file may live (.chant/trust.json) is chant's, proven in
  # its gate-decision tests.
  # BREAK: user.signingkey names another key, so init --signer writes that key
  # for smoke-approver and the approver's key is not in the signers file.
  log() { echo "[smoke signer-trust] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/signer-trust" sha applied key rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo signer-trust gated-waves sealed || { drop_work "$work"; return 1; }
  rm -f "$work/tree/.chant/allowed_signers"
  key="$work/approver.pub"
  if [ -n "${BREAK:-}" ]; then
    ssh-keygen -q -t ed25519 -N "" -C smoke-other -f "$work/other" || { drop_work "$work"; return 1; }
    key="$work/other.pub"
  fi
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" config user.signingkey "$key"
  (cd "$work/tree" && "$TERRAGUCCI" init --signer smoke-approver >&2) || { log "init --signer failed"; drop_work "$work"; return 1; }
  grep -q "^smoke-approver $(cut -d' ' -f1,2 "$work/approver.pub")" "$work/tree/.chant/allowed_signers" 2>/dev/null \
    || { log "init --signer did not write the approver key"; rc=1; }
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
    [ "$applied" = "canary/one " ] || { log "the approval sealed with the key init wrote did not let canary/one apply"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "init --signer wrote the approver key from git config, and the sealed approval let canary/one apply"
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

claim_rollout/control() {
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

claim_rollout/pins() {
  # One repo, no pipeline, three roots each pinning at a kind of its own:
  # app locks hashicorp/external at 2.3.4 (pinned exactly in
  # required_providers) and hashicorp/aws at 6.67.0; dev/oci calls
  # modules/network from an OCI registry pinned ?tag=1.3.0; dev/reg calls
  # acme/network/aws from a registry with version = "1.3.0". Three rollouts,
  # each --mode apply in the tofu CI image, open one pull request each, and
  # each changes its own root alone:
  #   rollout --provider hashicorp/external 2.3.5 changes
  #     app/.terraform.lock.hcl and app/main.tf: the external entry and its
  #     constraint are at 2.3.5, and the aws entry is the same text as before;
  #   rollout modules/network 1.4.0 ends the OCI source ?tag=1.4.0;
  #   rollout acme/network/aws 1.4.0 says version = "1.4.0".
  # BREAK: the rollouts run as dry runs, so no pull request opens.
  log() { echo "[smoke rollout-pins] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout-pins" tree mode=apply out want pr args branch files line sha lock aws_before aws_after i rc=0
  [ -n "${BREAK:-}" ] && mode=dry-run
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  rollout_repo rollout-pins || return 1
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
  tree="$work/tree"
  rm -f "$tree/app/.terraform.lock.hcl"
  in_image "$tree" sh -c 'cd app && tofu providers lock -no-color >/dev/null' >&2 || { log "could not lock the providers"; return 1; }
  clean_mounted "$tree"
  lock="$tree/app/.terraform.lock.hcl"
  grep -q 'provider "registry.opentofu.org/hashicorp/external"' "$lock" || { log "the lock file has no external entry"; return 1; }
  aws_before="$(awk '/^provider "registry.opentofu.org\/hashicorp\/aws"/,/^}/' "$lock")"
  mkdir -p "$tree/dev/oci" "$tree/dev/reg"
  printf 'terraform {\n  backend "local" {}\n}\n\nmodule "network" {\n  source = "oci://registry.example.com/acme/modules/network?tag=1.3.0"\n  name   = "oci"\n}\n' > "$tree/dev/oci/main.tf"
  printf 'terraform {\n  backend "local" {}\n}\n\nmodule "network" {\n  source  = "acme/network/aws"\n  version = "1.3.0"\n  name    = "reg"\n}\n' > "$tree/dev/reg/main.tf"
  push_tree "$tree" "$repo" main "three roots on three pin kinds" >/dev/null || return 1
  # Forgejo marks a repo not empty a moment after its first push, and until then
  # answers 404 for its pull requests, which the rollout would take for a failure.
  for i in $(seq 1 30); do api -o /dev/null "$URL/api/v1/repos/$repo/pulls?state=all&limit=1" 2>/dev/null && break; sleep 1; done
  for want in "--provider hashicorp/external 2.3.5|terragucci/rollout/hashicorp-external-2.3.5/wave-1|app/.terraform.lock.hcl,app/main.tf|version = \"2.3.5\"" \
              "modules/network 1.4.0|terragucci/rollout/modules-network-1.4.0/wave-1|dev/oci/main.tf|source = \"oci://registry.example.com/acme/modules/network?tag=1.4.0\"" \
              "acme/network/aws 1.4.0|terragucci/rollout/acme-network-aws-1.4.0/wave-1|dev/reg/main.tf|version = \"1.4.0\""; do
    IFS='|' read -r args branch files line <<<"$want"
    # shellcheck disable=SC2086
    out="$(in_image "$tree" terragucci rollout $args --mode "$mode" 2>&1)" || true
    echo "$out" >&2
    pr="$(branch_pr "$repo" "$branch")"
    [ -n "$pr" ] || { log "$args: no pull request from $branch"; rc=1; continue; }
    [ "$(pr_files "$repo" "$pr")" = "$files" ] || { log "$args: the pull request changes $(pr_files "$repo" "$pr"), not $files"; rc=1; }
    sha="$(remote_head "$repo" "$branch")"
    file_at "$repo" "$branch" "$sha" "${files##*,}" | grep -qF "$line" || { log "$args: ${files##*,} on $branch does not hold $line"; rc=1; }
    if [ "${args%% *}" = --provider ]; then
      file_at "$repo" "$branch" "$sha" app/.terraform.lock.hcl > "$work/new.lock" || { log "cannot read the lock file on $branch"; rc=1; continue; }
      awk '/^provider "registry.opentofu.org\/hashicorp\/external"/,/^}/' "$work/new.lock" | grep -q 'version *= "2.3.5"' || { log "external is not at 2.3.5 in the new lock file"; rc=1; }
      aws_after="$(awk '/^provider "registry.opentofu.org\/hashicorp\/aws"/,/^}/' "$work/new.lock")"
      [ "$aws_after" = "$aws_before" ] || { log "the aws entry of the lock file moved"; rc=1; }
    fi
  done
  drop_work "$work"
  [ $rc = 0 ] && log "external moved to 2.3.5 in the lock file and its constraint with aws left as it was, and the OCI tag and the registry version each moved to 1.4.0 in its own shape, one pull request each"
  return $rc
}

# ── policy engines and Terragrunt ─────────────────────────────────────────

claim_policy/opa() {
  # policy-wave with engine: opa: the same denial, warning and report as with
  # conftest. BREAK: as policy-wave, no policy is turned on.
  SMOKE_POLICY_ENGINE=opa SMOKE_POLICY_INPUT=plan claim_policy/wave
}

claim_policy/hcp() {
  # policy-wave with engine: opa and input: hcp, reading the HCP Terraform
  # policy in policy-hcp/ that names input.run.workspace.name. BREAK: as
  # policy-wave, no policy is turned on.
  SMOKE_POLICY_ENGINE=opa SMOKE_POLICY_INPUT=hcp claim_policy/wave
}

claim_policy/hcl() {
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo \
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$dir:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${extra[@]+"${extra[@]}"} "$(tg_image)" terragucci stage "$@" >&2 || code=$?
  clean_mounted "$dir"
  return $code
}

claim_oidc/terragrunt() {
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

claim_affected/terragrunt_dependents() {
  # The Terragrunt gated fixture with live/fleet/two depending on
  # live/canary/one, a fourth unit under live/sandbox, and terragrunt.exclude
  # leaving live/sandbox/** out. A change to live/canary/one and to the
  # sandbox unit is planned twice against the base: with no dependents key,
  # the default, live/fleet/two is previewed, provisional and deferred; with
  # dependents: follow it is not planned; both runs have the same set
  # digests, and neither plans the sandbox unit.
  # BREAK: the first run has dependents: follow, the old default, so nothing
  # is previewed.
  log() { echo "[smoke tg-dependents] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="tg-dep-$STAMP" dir mode base r1 r2 rc=0 i
  # "default" writes no dependents key.
  local -a dep_modes=(default follow)
  [ -n "${BREAK:-}" ] && dep_modes=(follow follow)
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  for i in 1 2; do
    dir="$work/run$i"; mode="${dep_modes[$((i - 1))]}"
    if [ "$mode" = default ]; then
      tg_fixture "$dir" "$prefix" "$(printf 'terragrunt:\n  exclude: ["live/sandbox/**"]')" || return 1
    else
      tg_fixture "$dir" "$prefix" "$(printf 'terragrunt:\n  exclude: ["live/sandbox/**"]\n  dependents: %s' "$mode")" || return 1
    fi
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
  jq -e '.roots[] | select(.path == "live/fleet/two" and .terragrunt.provisional == true)' "$r1" >/dev/null || { log "by default live/fleet/two was not previewed as provisional"; rc=1; }
  jq -e '.deferred[] | select(.unit == "live/fleet/two" and .previewed == true)' "$r1" >/dev/null || { log "live/fleet/two is not deferred and previewed"; rc=1; }
  jq -e '[.roots[] | select(.path == "live/fleet/two")] | length == 0' "$r2" >/dev/null || { log "dependents: follow planned live/fleet/two"; rc=1; }
  [ "$(jq -c '[.waves[]?.set_digest]' "$r1")" = "$(jq -c '[.waves[]?.set_digest]' "$r2")" ] || { log "the preview changed a set digest"; rc=1; }
  jq -e '[.roots[] | select(.path | startswith("live/sandbox"))] | length == 0' "$r1" >/dev/null || { log "the excluded sandbox unit was planned"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "by default live/fleet/two was previewed outside every digest, dependents: follow left it for later, and the excluded unit never planned"
  return $rc
}

# ── Terragrunt previews ───────────────────────────────────────────────────
# stack/fixtures/tg-preview: live/net; live/app, whose dependency reads net's
# rev, which net's plan knows; live/edge, whose dependency reads app's out,
# which app knows only once it applies. State in floci under the prefix.

tg_preview_copy() { # dir, prefix -> the tg-preview fixture in dir, its state under <prefix>/
  mkdir -p "$1"
  cp -R "$HERE/fixtures/tg-preview/." "$1/"
  sed "s#@PREFIX@#$2#" "$1/root.hcl" > "$1/root.hcl.new" && mv "$1/root.hcl.new" "$1/root.hcl"
}

tg_preview_apply() { # dir -> every unit of the fixture in dir applied as it stands, with Terragrunt in the CI image
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$1:/repo" -w /repo -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true \
    "$(tg_image)" terragrunt run --all --no-color -- apply -auto-approve -input=false >&2 || { clean_mounted "$1"; return 1; }
  clean_mounted "$1"
}

tg_preview_unstate() { # prefix -> the fixture's state under it removed from floci
  local key
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$1/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
}

claim_linked/terragrunt_preview() {
  # The fixture applied at rev 1; net's rev.txt goes to 2 and tf-plan runs in
  # the CI image, as the plan job runs it. live/app plans on net's planned
  # outputs, so its input moves from 1-r1 to 1-r2, and the report says it
  # read net's planned outputs. live/edge reads app's out, which app knows
  # only once it applies: it is not planned, and the report and the note name
  # out and wave 2. No unit plans on a mock.
  # BREAK: tf-plan plans live/app alone (--root live/app), so net is not
  # planned with it and app plans on net's applied state: no change.
  log() { echo "[smoke tg-preview] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work prefix="tg-preview-$STAMP${BREAK:+b}" r note app rc=0 args=()
  [ -n "${BREAK:-}" ] && args=(--root live/app)
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_preview_copy "$work/tree" "$prefix"
  tg_preview_apply "$work/tree" || { log "could not apply the fixture at rev 1"; tg_preview_unstate "$prefix"; drop_work "$work"; return 1; }
  echo 2 > "$work/tree/live/net/rev.txt"
  git -C "$work/tree" init -q -b main
  git -C "$work/tree" add -A && git -C "$work/tree" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "tg-preview: net at rev 2"
  tg_fixture_stage "$work/tree" -- tf-plan --terragrunt --binary tofu ${args[@]+"${args[@]}"} || log "tf-plan exited non-zero"
  r="$work/tree/terragucci-report/report.json"
  [ -f "$r" ] || { log "tf-plan wrote no report"; tg_preview_unstate "$prefix"; drop_work "$work"; return 1; }
  app="$(jq -c '.roots[] | select(.path == "live/app") | [.reads, [.changes[].attributes[]? | select(.path == "input") | [.before, .after]]]' "$r")"
  log "live/app: ${app:-not planned}"
  jq -e '.[1] == [["1-r1", "1-r2"]]' <<<"${app:-null}" >/dev/null 2>&1 || { log "live/app's input does not move from 1-r1 to 1-r2, net's planned rev"; rc=1; }
  jq -e '.[0] == [{upstream: "live/net", data: "net", outputs: "planned"}]' <<<"${app:-null}" >/dev/null 2>&1 || { log "the report does not say live/app read live/net's planned outputs"; rc=1; }
  jq -e '.deferred[]? | select(.unit == "live/edge" and .why == "reads `out` of live/app, unknown until wave 2 applies" and .previewed == false)' "$r" >/dev/null \
    || { log "the report does not name out and wave 2 for live/edge: $(jq -c '.deferred' "$r")"; rc=1; }
  jq -e '[.roots[] | select(.path == "live/edge")] | length == 0' "$r" >/dev/null || { log "live/edge was planned with a stand-in for app's out"; rc=1; }
  note="$(cat "$work/tree/terragucci-report/note.md" 2>/dev/null || true)"
  grep -qF '`live/edge` after `live/app`: reads `out` of live/app, unknown until wave 2 applies' <<<"$note" || { log "the note does not name out and wave 2 for live/edge"; rc=1; }
  jq -e '(.mock_reads // []) | length == 0' "$r" >/dev/null || { log "a unit would have read mock_outputs"; rc=1; }
  tg_preview_unstate "$prefix"
  drop_work "$work"
  [ $rc = 0 ] && log "live/app planned on net's planned rev (1-r1 -> 1-r2), and live/edge, which reads app's out, named with wave 2 and not planned"
  return $rc
}

claim_linked/terragrunt_preview_gate() {
  # The fixture with approval: pr-review and dependents: plan, its units
  # applied at rev 1 and pushed. A pull request moves net to rev 2: its plan
  # note previews live/app on net's planned outputs (input 1-r2), and the
  # reviewer approves its head. Then a commit on main moves app to rev 5, so
  # the merge plans app on another input than the preview showed. Merged:
  # wave 1 applies net on the review; wave 2 plans app on the state net left,
  # 5-r2, and before it waits for an approval says that app plans differently
  # from the pull request's preview, naming the attribute.
  # BREAK: nothing lands on main in between, so app plans as previewed and the
  # gate names no difference.
  log() { echo "[smoke tg-preview-gate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work name=tg-preview-gate repo="$USER/tg-preview-gate" sha head pr merge note logs five at wait rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; drop_work "$work"; return 1; }
  gated_repo "$name" tg-preview || { drop_work "$work"; return 1; }
  # gated_repo filled the prefix in: apply a copy of the tree, so no cache lands in what is pushed.
  mkdir -p "$work/apply" && cp -R "$work/tree/live" "$work/tree/modules" "$work/tree/root.hcl" "$work/apply/"
  tg_preview_apply "$work/apply" || { log "could not apply the fixture at rev 1"; tg_preview_unstate "$name"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "$name: first")"
  wait_run "$repo" "$sha" || rc=1
  log "first push, every unit applied at rev 1: run $RUN_STATUS"
  [ $rc = 0 ] && { pr_reviewer "$repo" "reviewer-$name" || rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/live/net/rev.txt"
    head="$(push_tree "$work/tree" "$repo" change "$name: net to rev 2")" || rc=1
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "$name: net to rev 2")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments?limit=50" | jq -r '[.[] | select(.body | contains("terragucci tf-plan"))] | last | .body // empty')"
    grep -q '"unit":"live/app"' <<<"$note" || { log "the plan note of pull request $pr carries no preview of live/app"; rc=1; }
    grep -qF 'reads `out` of live/app, unknown until wave 2 applies' <<<"$note" || { log "the plan note does not name out and wave 2 for live/edge"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    curl -fsS -o /dev/null -H "Authorization: token $PR_REVIEWER_TOKEN" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg c "$head" '{event: "APPROVED", body: "read the plans", commit_id: $c}')" "$URL/api/v1/repos/$repo/pulls/$pr/reviews" || { log "the reviewer could not approve pull request $pr"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    five="$(printf '5\n' | base64 | tr -d '\n')"
    at="$(api "$URL/api/v1/repos/$repo/contents/live/app/rev.txt?ref=main" | jq -r '.sha // empty')"
    sha="$(api -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg c "$five" --arg s "$at" '{content: $c, sha: $s, branch: "main", message: "tg-preview-gate: app to rev 5 after the review"}')" "$URL/api/v1/repos/$repo/contents/live/app/rev.txt" | jq -r '.commit.sha // empty')"
    [ -n "$sha" ] || { log "could not commit to main"; rc=1; }
    [ $rc = 0 ] && { wait_run "$repo" "$sha" push || rc=1; }
  fi
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge" || { log "pull request $pr did not merge"; rc=1; }
    merge="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
    { [ -n "$merge" ] && wait_run "$repo" "$merge" push; } || rc=1
  fi
  if [ $rc = 0 ]; then
    logs="$(run_logs "$repo" "$RUN_ID")"
    log "after the merge: run $RUN_STATUS; $(grep -m1 'previewed live/app\|plans as pull request' <<<"$logs" || echo 'nothing said of the preview')"
    grep -q "wave 1 of 3: pull request $pr was approved on its head" <<<"$logs" || { log "wave 1 did not apply on the review"; rc=1; }
    grep -qF "wave 2 of 3: pull request $pr previewed live/app on the planned outputs of the waves before; this unit plans differently now:" <<<"$logs" \
      || { log "wave 2 did not say live/app plans differently from the preview"; rc=1; }
    grep -qF "wave 2 of 3:   live/app: terraform_data.this (update): input differs from the preview" <<<"$logs" || { log "wave 2 did not name the input that moved"; rc=1; }
    # Before anyone approves: the difference comes before the approve command.
    at="$(grep -n 'input differs from the preview' <<<"$logs" | head -1 | cut -d: -f1)"
    wait="$(grep -n 'terragucci approve wave-2' <<<"$logs" | head -1 | cut -d: -f1)"
    { [ -n "$at" ] && [ -n "$wait" ] && [ "$at" -lt "$wait" ]; } || { log "wave 2 did not show the difference before its approve command"; rc=1; }
  fi
  tg_preview_unstate "$name"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/reviewer-$name?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "wave 2 said live/app's input differs from pull request $pr's preview before it waited for an approval"
  return $rc
}

# ── binary: terraform ─────────────────────────────────────────────────────

claim_binary/terraform() {
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
  run_logs "$repo" "$RUN_ID" | grep -q "terragucci approve wave-1" || { log "wave 1 did not wait for its approval"; rc=1; }
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

claim_binary/terragrunt_terraform() {
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

claim_drift/tfquery() {
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
  out="$(run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
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

claim_telemetry/alerts() {
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
  STANDIN="$(run_copied -d --name "$name" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::9090 -v "$work/prom:/prom:ro" "$prom" \
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/$n:/repo" -v "$work/$n.git:/origin.git" -w /repo \
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
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/drift:/repo" -w /repo/app -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
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

claim_report/gcs_key() {
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
  with_lock compose docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" --profile blob up -d gcs >&2 || { drop_work "$work"; return 1; }
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

claim_report/azure_key() {
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
  with_lock compose env TERRAGUCCI_AZURITE_CERTS="$certs" docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" \
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

claim_report/index_writes() {
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
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/$1:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
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

claim_choudoufu/shared_bucket() {
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

