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
#   wait_run REPO SHA [EVENT]  wait for the Actions run on SHA (the newest one,
#                              or the one EVENT started); sets RUN_ID,
#                              RUN_INDEX, RUN_STATUS and RUN_URL
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

wait_run() { # repo, sha, [event]
  local repo="$1" sha="$2" event="${3:-}" deadline=$(( $(date +%s) + TIMEOUT )) run="" status=""
  while :; do
    # A branch with a pull request has two runs on its head: the push run and
    # the pull_request run, in whichever order Forgejo queued them.
    run="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" \
      | jq -c --arg e "$event" '[.workflow_runs[] | select($e == "" or .event == $e)][0] // empty')"
    if [ -n "$run" ]; then
      status="$(echo "$run" | jq -r '.status')"
      case "$status" in
        success|failure|cancelled|skipped) break ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      [ -n "$run" ] && print_logs "$repo" "$(echo "$run" | jq -r '.id')" >&2
      fail "no finished ${event:+$event }run for $sha after ${TIMEOUT}s (last status: ${status:-none})" || return 1
    fi
    sleep 3
  done
  RUN_ID="$(echo "$run" | jq -r '.id')"
  RUN_INDEX="$(echo "$run" | jq -r '.index_in_repo')"
  RUN_STATUS="$status"
  # Forgejo builds links from its in-network address; show the one a browser opens.
  RUN_URL="$(echo "$run" | jq -r '.html_url' | sed "s#^http://forgejo:3000#$URL#")"
  # A run's own page redirects to its first job at that in-network address,
  # which a browser cannot open, so link the first job that ran instead.
  # Forgejo numbers a run's jobs from 0 in the order it created them.
  local pos
  pos="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" 2>/dev/null \
    | jq -r 'sort_by(.id) | to_entries | map(select(.value.status != "skipped")) | .[0].key // empty' 2>/dev/null || true)"
  [ -z "$pos" ] || RUN_URL="$RUN_URL/jobs/$pos/attempt/1"
  log "run $RUN_INDEX for ${sha:0:8}${event:+ ($event)}: $status ($RUN_URL)"
}
