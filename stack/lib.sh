#!/usr/bin/env bash
# Helpers shared by validate.sh, example.sh and smoke.sh. Source it after
# `set -euo pipefail`. It reads stack/.state/forgejo.env when the TERRAGUCCI_*
# variables are not already set, and defines:
#
#   URL TOKEN USER FLOCI       the stack's Forgejo, admin token, admin and floci
#   api ARGS...                curl with the admin token
#   push_tree DIR REPO BRANCH MESSAGE   commit DIR as one commit and force-push it;
#                              prints the sha. TG_FIXED_DATE=1 pins the commit
#                              dates so the same tree always gets the same sha.
#   wait_run REPO SHA          wait for the Actions run on SHA; sets RUN_ID,
#                              RUN_STATUS and RUN_URL
#   print_logs REPO RUN_ID     every job's log tail, for a run that went wrong
#
# Callers define log() and fail() before sourcing.

# A caller that defines no fail() gets this one.
declare -F fail >/dev/null || fail() { echo "$*" >&2; return 1; }

LIB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"

if [ -z "${TERRAGUCCI_FORGEJO_TOKEN:-}" ]; then
  [ -f "$LIB_HERE/.state/forgejo.env" ] || fail "no stack/.state/forgejo.env; run 'just stack-up forgejo' first" || return 1
  # shellcheck disable=SC1091
  . "$LIB_HERE/.state/forgejo.env"
fi
URL="$TERRAGUCCI_FORGEJO_URL"
TOKEN="$TERRAGUCCI_FORGEJO_TOKEN"
USER="$TERRAGUCCI_FORGEJO_USER"
FLOCI="$TERRAGUCCI_FLOCI_URL"

api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }
# Forgejo fills GET /repos/<repo>/branches/<name> from a push queue, so it can
# 404 or lag for seconds after a push. A head is read from git itself instead.
remote_head() { # repo, branch -> prints the branch's sha (empty when it is gone)
  git ls-remote "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$1.git" "refs/heads/$2" 2>/dev/null | awk -v r="refs/heads/$2" '$2 == r { print $1 }'
}

api -o /dev/null "$URL/api/v1/user" 2>/dev/null \
  || fail "Forgejo at $URL does not accept the token; run 'just stack-up forgejo' again" || return 1

push_tree() { # dir, repo, branch, message -> prints the pushed sha
  local dir="$1" repo="$2" branch="$3" message="$4"
  (
    cd "$dir"
    [ -d .git ] || git init -q -b "$branch"
    git checkout -q -B "$branch"
    git add -A
    if [ -n "${TG_FIXED_DATE:-}" ]; then
      export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
    fi
    # Never sign: these are throwaway commits, and an unsigned commit has the
    # same sha on every machine, which the tutorial's captures rely on.
    git -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false \
      commit -q --allow-empty -m "$message"
    local remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/${repo}.git"
    # Forgejo's "create a pull request" hint is noise; show output only on failure.
    if ! out="$(git push -q --force "$remote" "HEAD:refs/heads/$branch" 2>&1)"; then
      echo "${out//${TOKEN}/***}" >&2
      exit 1
    fi
    git rev-parse HEAD
  )
}

print_logs() { # repo, run id
  local jobs id name status
  jobs="$(api "$URL/api/v1/repos/$1/actions/runs/$2/jobs" || echo '[]')"
  echo "$jobs" | jq -r '.[] | "\(.id)\t\(.name)\t\(.status)"' | while IFS=$'\t' read -r id name status; do
    echo "----- job '$name' ($status), last 60 lines -----"
    api "$URL/api/v1/repos/$1/actions/jobs/$id/logs" 2>/dev/null | tail -60 || echo "(no log)"
  done
}

wait_run() { # repo, sha
  local repo="$1" sha="$2" deadline=$(( $(date +%s) + TIMEOUT )) run="" status=""
  while :; do
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" | jq -c '.workflow_runs[0] // empty')"
    if [ -n "$run" ]; then
      status="$(echo "$run" | jq -r '.status')"
      case "$status" in
        success|failure|cancelled|skipped) break ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      [ -n "$run" ] && print_logs "$repo" "$(echo "$run" | jq -r '.id')" >&2
      fail "no finished run for $sha after ${TIMEOUT}s (last status: ${status:-none})" || return 1
    fi
    sleep 3
  done
  RUN_ID="$(echo "$run" | jq -r '.id')"
  RUN_STATUS="$status"
  # Forgejo builds links from its in-network address; show the one a browser opens.
  RUN_URL="$(echo "$run" | jq -r '.html_url' | sed "s#^http://forgejo:3000#$URL#")"
  log "run $(echo "$run" | jq -r '.index_in_repo') for ${sha:0:8}: $status ($RUN_URL)"
}
