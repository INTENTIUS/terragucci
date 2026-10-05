#!/usr/bin/env bash
#
# Run one named claim against a running profile of the validation stack.
#
#   stack/validate.sh forgejo check
#   stack/validate.sh forgejo apply
#   BREAK=1 stack/validate.sh forgejo check     must fail
#
# Implemented today (forgejo only):
#
#   check  The fmt check passes on a formatted root and fails on an
#          unformatted one. Two pushes to a branch: the fixture as it is,
#          whose run must succeed, and the fixture plus an unformatted file,
#          whose run must fail with that file named in the job log.
#   apply  A push to main applies the root to floci. The bucket is deleted
#          from floci first, the run must succeed, and the bucket must then
#          exist when asked from the host.
#
# BREAK=1 breaks the property each claim is about and the claim must then
# fail, which shows the check can tell:
#
#   check  the push that should be clean carries the unformatted file.
#   apply  the pushed workflow has its `tofu apply` step removed, so the run
#          still goes green and only the host-side bucket check can catch it.
#
# Needs stack/bootstrap.sh forgejo first; the env it wrote to
# stack/.state/forgejo.env is read when the TERRAGUCCI_* vars are not set.
#
# Exit codes: 0 the claim held (or Docker is unavailable, a clean skip),
# 1 the claim failed, 2 usage or a claim not implemented for that forge.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORGE="${1:-forgejo}"
CLAIM="${2:-apply}"
BREAK="${BREAK:-}"
TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"
FIXTURE="$HERE/fixtures/s3-bucket"
BUCKET="terragucci-validate"

log()  { echo "[validate $FORGE $CLAIM] $*"; }
fail() { log "FAIL: $*"; exit 1; }
usage() { echo "usage: stack/validate.sh <forge> <claim>   (implemented: aws s3, forgejo check|apply, github and gitlab check|apply|reconcile)" >&2; exit 2; }

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker is not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP: the docker daemon is not reachable"; exit 0; }

if [ "$FORGE:$CLAIM" = "aws:s3" ]; then
  # floci answers S3 on the host's published port: create a bucket, see it,
  # delete it. BREAK=1 asks for a bucket that was never created, which must fail.
  FLOCI="${TERRAGUCCI_FLOCI_URL:-http://localhost:${TERRAGUCCI_FLOCI_PORT:-4580}}"
  b="terragucci-aws-claim"; probe="$b"
  [ -n "$BREAK" ] && probe="$b-never-created"
  curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$b" || fail "floci at $FLOCI did not create a bucket; run 'just stack-up aws' first"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$probe" || true)"
  curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true
  [ "$code" = 200 ] || fail "HEAD $probe answered $code; expected 200"
  log "PASS: floci created, listed and answered for a bucket"
  exit 0
fi

case "$FORGE:$CLAIM" in
  forgejo:check|forgejo:apply) ;;
  github:*|gitlab:*) exec "$HERE/validate-generated.sh" "$FORGE" "$CLAIM" ;;
  fountain:*)
    echo "the $FORGE profile has no validate.sh claims; the steward smoke claim checks it (just smoke steward)" >&2; exit 2 ;;
  forgejo:*)
    echo "claim '$CLAIM' is not implemented for forgejo yet (implemented: check, apply)" >&2; exit 2 ;;
  *) usage ;;
esac

# shellcheck source=lib.sh
. "$HERE/lib.sh"
REPO="$TERRAGUCCI_FORGEJO_REPO"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-validate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A fresh one-commit repo from the fixture each time. The commit message
# carries the claim and a timestamp, so every push has a new sha and the run
# can be found by it.
prepare() { # dir
  rm -rf "$1"
  mkdir -p "$1"
  cp -R "$FIXTURE/." "$1/"
}

push() { # dir, branch -> prints the pushed sha
  push_tree "$1" "$REPO" "$2" "validate $CLAIM $(date -u +%Y-%m-%dT%H:%M:%SZ) $$"
}

# The unformatted file the check claim relies on: valid HCL that tofu fmt
# would rewrite (the `=` is not aligned and the indent is wrong).
add_unformatted() { # dir
  cat > "$1/infra/unformatted.tf" <<'EOF'
locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}
EOF
}

bucket_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$BUCKET" || true; }

started=$(date +%s)
[ -n "$BREAK" ] && log "BREAK=1: breaking the property on purpose; this run must fail"

case "$CLAIM" in
  check)
    # The clean push must go green.
    prepare "$WORK/clean"
    [ -n "$BREAK" ] && add_unformatted "$WORK/clean"
    sha="$(push "$WORK/clean" validate/check)"
    log "pushed the formatted root to validate/check at ${sha:0:8}"
    wait_run "$REPO" "$sha"
    if [ "$RUN_STATUS" != "success" ]; then
      print_logs "$REPO" "$RUN_ID"
      fail "the formatted root's run ended '$RUN_STATUS'; expected success"
    fi

    # The unformatted push must go red, at the fmt check.
    prepare "$WORK/dirty"
    add_unformatted "$WORK/dirty"
    sha="$(push "$WORK/dirty" validate/check)"
    log "pushed an unformatted file to validate/check at ${sha:0:8}"
    wait_run "$REPO" "$sha"
    [ "$RUN_STATUS" = "failure" ] || fail "the unformatted root's run ended '$RUN_STATUS'; expected failure"
    logs="$(print_logs "$REPO" "$RUN_ID")"
    echo "$logs" | grep -q "unformatted.tf" \
      || { echo "$logs"; fail "the run failed, but its log does not name unformatted.tf, so it failed somewhere other than the fmt check"; }
    log "the run failed at the fmt check and named infra/unformatted.tf"
    ;;

  apply)
    curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
    [ "$(bucket_code)" = "404" ] || fail "could not clear $BUCKET from floci before the run"
    log "$BUCKET is absent from floci"

    prepare "$WORK/main"
    if [ -n "$BREAK" ]; then
      wf="$WORK/main/.forgejo/workflows/tofu.yml"
      sed '/- name: tofu apply/,$d' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    fi
    sha="$(push "$WORK/main" main)"
    log "pushed to main at ${sha:0:8}"
    wait_run "$REPO" "$sha"
    if [ "$RUN_STATUS" != "success" ]; then
      print_logs "$REPO" "$RUN_ID"
      fail "the apply run ended '$RUN_STATUS'; expected success"
    fi
    code="$(bucket_code)"
    if [ "$code" != "200" ]; then
      print_logs "$REPO" "$RUN_ID"
      fail "the run went green but $BUCKET is not in floci (HEAD answered $code)"
    fi
    log "$BUCKET exists in floci (HEAD $FLOCI/$BUCKET answered 200)"
    ;;
esac

log "PASS in $(( $(date +%s) - started ))s"
