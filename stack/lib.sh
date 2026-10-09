#!/usr/bin/env bash
# Helpers shared by validate.sh, example.sh and smoke.sh. Source it after
# `set -euo pipefail`. It reads stack/.state/forgejo.env when the TERRAGUCCI_*
# variables are not already set, and defines:
#
#   URL TOKEN USER FLOCI       the stack's Forgejo, admin token, admin and floci
#   api ARGS...                curl with the admin token
#   verify_tree DIR            every resource the example's roots in DIR declare
#                              is in floci (expected lists them)
#   push_tree DIR REPO BRANCH MESSAGE   commit DIR as one commit and force-push it;
#                              on Forgejo, waits until the repo is not empty;
#                              prints the sha. TG_FIXED_DATE=1 pins the commit
#                              dates so the same tree always gets the same sha.
#   wait_run REPO SHA [EVENT]  wait for the Actions run on SHA (the newest one,
#                              or the one EVENT started); sets RUN_ID,
#                              RUN_INDEX, RUN_STATUS and RUN_URL
#   print_logs REPO RUN_ID     every job's log tail, for a run that went wrong
#
# LIB_FORGE=gitlab reads stack/.state/gitlab.env instead: URL, TOKEN and USER
# are the stack's GitLab, its root token and root, and api sends the token as
# GitLab asks. push_tree, remote_head, file_at and verify_tree work the same;
# wait_run and print_logs read Forgejo's Actions API, so they are Forgejo's
# alone (example-gitlab.sh has its own).
#
# Callers define log() and fail() before sourcing.

# A caller that defines no fail() gets this one.
declare -F fail >/dev/null || fail() { echo "$*" >&2; return 1; }

LIB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"

if [ "${LIB_FORGE:-forgejo}" = gitlab ]; then
  if [ -z "${TERRAGUCCI_GITLAB_TOKEN:-}" ]; then
    [ -f "$LIB_HERE/.state/gitlab.env" ] || fail "no stack/.state/gitlab.env; run 'just stack-up gitlab' first" || return 1
    # shellcheck disable=SC1091
    . "$LIB_HERE/.state/gitlab.env"
  fi
  URL="$TERRAGUCCI_GITLAB_URL"
  TOKEN="$TERRAGUCCI_GITLAB_TOKEN"
  USER="$TERRAGUCCI_GITLAB_USER"
  FLOCI="$TERRAGUCCI_FLOCI_URL"
  api() { curl -fsS -H "PRIVATE-TOKEN: $TOKEN" "$@"; }
  api -o /dev/null "$URL/api/v4/user" 2>/dev/null \
    || fail "GitLab at $URL does not accept the token; run 'just stack-up gitlab' again" || return 1
else
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
  api -o /dev/null "$URL/api/v1/user" 2>/dev/null \
    || fail "Forgejo at $URL does not accept the token; run 'just stack-up forgejo' again" || return 1
fi
# Forgejo fills GET /repos/<repo>/branches/<name> from a push queue, so it can
# 404 or lag for seconds after a push. A head is read from git itself instead.
remote_head() { # repo, branch -> prints the branch's sha (empty when it is gone)
  git ls-remote "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$1.git" "refs/heads/$2" 2>/dev/null | awk -v r="refs/heads/$2" '$2 == r { print $1 }'
}

# Forgejo's raw endpoint can 404 for a sha it has just been pushed, so a file
# is read from git itself.
file_at() { # repo, branch, sha, path -> prints the file as the sha holds it
  local repo="$1" branch="$2" sha="$3" path="$4" dir rc=0
  dir="$(mktemp -d "${TMPDIR:-/tmp}/tgs.XXXXXX")" || return 1
  git clone -q --single-branch --branch "$branch" "${URL/#http:\/\/http://${USER}:${TOKEN}@}/$repo.git" "$dir/repo" >/dev/null 2>&1 \
    && git -C "$dir/repo" show "$sha:$path" 2>/dev/null || rc=1
  rm -rf "$dir"
  return $rc
}

push_tree() { # dir, repo, branch, message -> prints the pushed sha
  local dir="$1" repo="$2" branch="$3" message="$4"
  (
    cd "$dir"
    [ -d .git ] || git init -q -b "$branch"
    git checkout -q -B "$branch"
    # init pins terragucci's CI images by the digest of the published release.
    # The stack tests the code as it is now, built by `just images` under the
    # same tag, so the pushed pipeline names the image by its tag alone and the
    # runner takes the local build. TG_KEEP_DIGESTS=1 pushes the pins as written.
    if [ -z "${TG_KEEP_DIGESTS:-}" ]; then
      for f in .forgejo/workflows/*.yml .github/workflows/*.yml .gitlab/*.yml .gitlab-ci.yml; do
        if [ -f "$f" ]; then perl -pi -e 's#(ghcr\.io/intentius/terragucci-[a-z]+:[^@\s]+)\@sha256:[0-9a-f]{64}#$1#g' "$f"; fi
        # This tree's own tags (TG_IMAGE_SUFFIX, set by smoke.sh): any suffix a ref
        # already has is replaced, so a pipeline pushed twice keeps one.
        if [ -f "$f" ] && [ -n "${TG_IMAGE_SUFFIX:-}" ]; then perl -pi -e 's#(ghcr\.io/intentius/terragucci-(?:tofu|terraform|terragrunt|choudoufu):[A-Za-z0-9_.-]+?)(?:-t[0-9a-f]{12})?(?=[\s"\x27]|$)#$1$ENV{TG_IMAGE_SUFFIX}#g' "$f"; fi
        # The GitLab lab's image: the tofu image with this tree's bundle (gitlab.sh image).
        if [ -f "$f" ] && [ -n "${TG_TOFU_IMAGE:-}" ]; then TG_TOFU_IMAGE="$TG_TOFU_IMAGE" perl -pi -e 's#ghcr\.io/intentius/terragucci-tofu:[^@\s"'"'"']+#$ENV{TG_TOFU_IMAGE}#g' "$f"; fi
      done
    fi
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
    # Forgejo makes the first branch its push queue handles in an empty repo
    # the default, whatever default_branch the repo was created with, and the
    # queue can take a later push first. Wait until the repo is not empty, so
    # the branch pushed first is the default before anything else is pushed.
    if [ "${LIB_FORGE:-forgejo}" != gitlab ]; then
      local empty=""
      for _ in $(seq 1 120); do
        empty="$(api "$URL/api/v1/repos/$repo" 2>/dev/null | jq -r '.empty | tostring')"
        [ "$empty" = false ] && break
        sleep 1
      done
      [ "$empty" = false ] || { echo "$repo still reads as empty after the push of $branch" >&2; exit 1; }
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

# Every job's whole log, for a claim that looks for a line in it. print_logs
# keeps the last 60 lines of each, which a job's artifact upload and checkout
# cleanup can fill after the line was printed.
run_logs() { # repo, run id
  local id
  api "$URL/api/v1/repos/$1/actions/runs/$2/jobs" | jq -r '.[].id' | while read -r id; do
    api "$URL/api/v1/repos/$1/actions/jobs/$id/logs" 2>/dev/null || true
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

# The example's resources (example.sh, example-gitlab.sh).
# What the 15 roots declare, by name. prod payments adds a dead-letter queue;
# a scenario applied to main changes this, so verify reads main's tree.
expected() { # dir -> lines "kind name"
  local dir="$1" env svc
  for env in dev staging prod; do
    echo "bucket shop-$env-logs"
    for svc in orders payments search email; do
      echo "bucket shop-$env-$svc-files"
      echo "queue shop-$env-$svc-jobs"
      if ! grep -q 'records_table = false' "$dir/envs/$env/$svc/main.tf"; then
        echo "table shop-$env-$svc-records"
      fi
      if grep -q 'dead_letter_queue = true' "$dir/envs/$env/$svc/main.tf"; then
        echo "queue shop-$env-$svc-dead-letter"
      fi
    done
  done
}

floci_json() { # target, body
  curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: $1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"
}

verify_tree() { # dir
  if [ -n "${SMOKE_AWS:-}" ]; then expected "$1" | smoke_aws_verify; return; fi
  local queues tables missing=0 kind name
  queues="$(floci_json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]? | split("/") | last')"
  tables="$(floci_json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?')"
  while read -r kind name; do
    case "$kind" in
      bucket) [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$name")" = 200 ] ;;
      queue)  grep -qx "$name" <<<"$queues" ;;
      table)  grep -qx "$name" <<<"$tables" ;;
    esac || { echo "missing $kind $name"; missing=$((missing + 1)); }
  done < <(expected "$1")
  local total; total="$(expected "$1" | wc -l | tr -d ' ')"
  if [ "$missing" -gt 0 ]; then
    log "$missing of $total resources are missing from floci"
    return 1
  fi
  log "all $total resources are in floci"
}
