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
usage() { echo "usage: stack/validate.sh <forge> <claim>   (implemented: forgejo check, forgejo apply)" >&2; exit 2; }

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker is not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP: the docker daemon is not reachable"; exit 0; }

case "$FORGE:$CLAIM" in
  forgejo:check|forgejo:apply) ;;
  github:*|gitlab:*|fountain:*)
    echo "the $FORGE profile is declared but not validated yet; no claims run on it (see stack/README.md)" >&2; exit 2 ;;
  forgejo:*)
    echo "claim '$CLAIM' is not implemented for forgejo yet (implemented: check, apply)" >&2; exit 2 ;;
  *) usage ;;
esac

if [ -z "${TERRAGUCCI_FORGEJO_TOKEN:-}" ]; then
  [ -f "$HERE/.state/forgejo.env" ] || fail "no stack/.state/forgejo.env; run 'just stack-up forgejo' first"
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
fi
URL="$TERRAGUCCI_FORGEJO_URL"
TOKEN="$TERRAGUCCI_FORGEJO_TOKEN"
REPO="$TERRAGUCCI_FORGEJO_REPO"
FLOCI="$TERRAGUCCI_FLOCI_URL"
API="$URL/api/v1/repos/$REPO"
api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }

api -o /dev/null "$URL/api/v1/user" 2>/dev/null \
  || fail "Forgejo at $URL does not accept the token; run 'just stack-up forgejo' again"

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
  local dir="$1" branch="$2"
  (
    cd "$dir"
    git init -q -b "$branch"
    git add -A
    git -c user.email=validate@terragucci.local -c user.name=terragucci-validate \
      commit -qm "validate $CLAIM $(date -u +%Y-%m-%dT%H:%M:%SZ) $$"
    local remote="${URL/#http:\/\//http://${TERRAGUCCI_FORGEJO_USER}:${TOKEN}@}/${REPO}.git"
    # Forgejo's "create a pull request" hint is noise here; show output only
    # when the push fails.
    if ! out="$(git push -q --force "$remote" "HEAD:refs/heads/$branch" 2>&1)"; then
      echo "${out//${TOKEN}/***}" >&2
      exit 1
    fi
    git rev-parse HEAD
  )
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

print_logs() { # run id
  local jobs id name status
  jobs="$(api "$API/actions/runs/$1/jobs" || echo '[]')"
  echo "$jobs" | jq -r '.[] | "\(.id)\t\(.name)\t\(.status)"' | while IFS=$'\t' read -r id name status; do
    echo "----- job '$name' ($status), last 60 lines -----"
    api "$API/actions/jobs/$id/logs" 2>/dev/null | tail -60 || echo "(no log)"
  done
}

# Poll the run for a sha until it is done; prints the run id, sets RUN_STATUS.
wait_run() { # sha
  local sha="$1" deadline=$(( $(date +%s) + TIMEOUT )) run="" status=""
  while :; do
    run="$(api "$API/actions/runs?head_sha=$sha" | jq -c '.workflow_runs[0] // empty')"
    if [ -n "$run" ]; then
      status="$(echo "$run" | jq -r '.status')"
      case "$status" in
        success|failure|cancelled|skipped) break ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      [ -n "$run" ] && print_logs "$(echo "$run" | jq -r '.id')" >&2
      fail "no finished run for $sha after ${TIMEOUT}s (last status: ${status:-none})"
    fi
    sleep 3
  done
  RUN_ID="$(echo "$run" | jq -r '.id')"
  RUN_STATUS="$status"
  log "run $(echo "$run" | jq -r '.index_in_repo') for ${sha:0:8}: $status ($(echo "$run" | jq -r '.html_url'))"
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
    wait_run "$sha"
    if [ "$RUN_STATUS" != "success" ]; then
      print_logs "$RUN_ID"
      fail "the formatted root's run ended '$RUN_STATUS'; expected success"
    fi

    # The unformatted push must go red, at the fmt check.
    prepare "$WORK/dirty"
    add_unformatted "$WORK/dirty"
    sha="$(push "$WORK/dirty" validate/check)"
    log "pushed an unformatted file to validate/check at ${sha:0:8}"
    wait_run "$sha"
    [ "$RUN_STATUS" = "failure" ] || fail "the unformatted root's run ended '$RUN_STATUS'; expected failure"
    logs="$(print_logs "$RUN_ID")"
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
    wait_run "$sha"
    if [ "$RUN_STATUS" != "success" ]; then
      print_logs "$RUN_ID"
      fail "the apply run ended '$RUN_STATUS'; expected success"
    fi
    code="$(bucket_code)"
    if [ "$code" != "200" ]; then
      print_logs "$RUN_ID"
      fail "the run went green but $BUCKET is not in floci (HEAD answered $code)"
    fi
    log "$BUCKET exists in floci (HEAD $FLOCI/$BUCKET answered 200)"
    ;;
esac

log "PASS in $(( $(date +%s) - started ))s"
