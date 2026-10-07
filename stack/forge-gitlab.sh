#!/usr/bin/env bash
# The gitlab profile's side of validate-generated.sh: GitLab CE and a
# gitlab-runner with the docker executor, both on the terragucci network. A
# push starts the pipeline by itself; "the run" is that pipeline, found by the
# pushed sha and polled to the end.
#
# Defines the same interface as forge-github.sh.
FORGE_TOKEN_ENV=TERRAGUCCI_GITLAB_TOKEN
PIPELINE_FILE=.gitlab-ci.yml

forge_load() {
  if [ -z "${TERRAGUCCI_GITLAB_TOKEN:-}" ]; then
    [ -f "$HERE/.state/gitlab.env" ] || fail "no stack/.state/gitlab.env; run 'just stack-up gitlab' first"
    # shellcheck disable=SC1091
    . "$HERE/.state/gitlab.env"
  fi
  URL="$TERRAGUCCI_GITLAB_URL"; TOKEN="$TERRAGUCCI_GITLAB_TOKEN"; USER="$TERRAGUCCI_GITLAB_USER"; FLOCI="$TERRAGUCCI_FLOCI_URL"
  REPO="$TERRAGUCCI_GITLAB_REPO"
  glapi -o /dev/null "$URL/api/v4/version" 2>/dev/null || fail "GitLab at $URL does not accept the token; run 'just stack-up gitlab' first"
}

glapi() { curl -fsS -H "PRIVATE-TOKEN: $TOKEN" "$@"; }
pid() { echo "$USER%2F$1"; }

# A project is kept between runs (deleting one is asynchronous and holds its
# name for a while). Reset it instead: open merge requests closed, the
# pipeline branch gone, main unprotected so a run can force-push it.
forge_reset_repo() { # name
  if ! glapi -o /dev/null "$URL/api/v4/projects/$(pid "$1")" 2>/dev/null; then
    glapi -o /dev/null -X POST "$URL/api/v4/projects" --data-urlencode "name=$1" \
      --data-urlencode "visibility=public" --data-urlencode "initialize_with_readme=false" --data-urlencode "default_branch=main"
  fi
  local mr
  for mr in $(glapi "$URL/api/v4/projects/$(pid "$1")/merge_requests?state=opened" | jq -r '.[].iid'); do
    glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")/merge_requests/$mr" --data-urlencode "state_event=close"
  done
  curl -s -o /dev/null -H "PRIVATE-TOKEN: $TOKEN" -X DELETE "$URL/api/v4/projects/$(pid "$1")/repository/branches/terragucci%2Fpipeline"
  # The first branch pushed to an empty project becomes its default branch,
  # which must be main for the apply job's rule. Seed main with an empty
  # commit (no pipeline file, so no pipeline), then unprotect it.
  local seed="$WORK/seed-$1"
  rm -rf "$seed"; mkdir -p "$seed"
  unprotect_all "$1"
  forge_seed "$seed" "$1"
  glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")" --data-urlencode "default_branch=main"
  unprotect_all "$1"
}

unprotect_all() { # name
  local b
  for b in $(glapi "$URL/api/v4/projects/$(pid "$1")/protected_branches" | jq -r '.[].name'); do
    curl -s -o /dev/null -H "PRIVATE-TOKEN: $TOKEN" -X DELETE "$URL/api/v4/projects/$(pid "$1")/protected_branches/$(printf %s "$b" | jq -sRr @uri)"
  done
}

# A CI/CD variable on the project, set or replaced.
forge_ci_var() { # name key value
  glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")/variables/$2" --data-urlencode "value=$3" --data-urlencode "protected=false" 2>/dev/null \
    || glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$1")/variables" --data-urlencode "key=$2" --data-urlencode "value=$3" --data-urlencode "protected=false"
}

forge_seed() { # dir name
  (cd "$1" && git init -q -b main && git -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q --allow-empty -m "seed" \
    && git push -q --force "$(forge_remote "$2")" HEAD:refs/heads/main) >/dev/null 2>&1 || true
}

forge_remote() { echo "${URL/#http:\/\//http://oauth2:${TOKEN}@}/$USER/$1.git"; }

# GitLab protects the first branch of a project a moment after the push that
# created it, so a force-push can meet the protection; unprotect and retry.
forge_push() { # dir name branch message
  local sha i
  for i in 1 2 3; do
    if sha="$(push_dir "$1" "$(forge_remote "$2")" "$3" "$4" 2>"$WORK/push.err")"; then echo "$sha"; return 0; fi
    grep -q "protected branch" "$WORK/push.err" || break
    unprotect_all "$2"; sleep 2
  done
  cat "$WORK/push.err" >&2
  return 1
}

forge_branch_sha() { glapi "$URL/api/v4/projects/$(pid "$1")/repository/branches/$(printf %s "$2" | jq -sRr @uri)" | jq -r .commit.id; }

# A fourth argument "push" waits for the branch pipeline, which runs the
# check. A merge request also gets its own pipeline, which plans every root;
# a root that reads another's state cannot plan until that one is applied, so
# that pipeline is not what "the request's check" means.
forge_run() { # name branch sha [job]
  local name="$1" sha="$3" source="${4:-}" deadline=$(( $(date +%s) + TIMEOUT )) p="" status=""
  RUN_LOG="$WORK/run-$RANDOM.log"
  while :; do
    p="$(glapi "$URL/api/v4/projects/$(pid "$name")/pipelines?sha=$sha${source:+&source=$source}" | jq -c '.[0] // empty')"
    if [ -n "$p" ]; then
      status="$(jq -r .status <<<"$p")"
      case "$status" in success|failed|canceled|skipped) break ;; esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      RUN_STATUS=failure; echo "no finished pipeline for $sha after ${TIMEOUT}s (last status: ${status:-none})" > "$RUN_LOG"
      log "no finished pipeline for ${sha:0:8} (last status: ${status:-none})"; return 0
    fi
    sleep 5
  done
  local id jobid jobname
  id="$(jq -r .id <<<"$p")"
  : > "$RUN_LOG"
  glapi "$URL/api/v4/projects/$(pid "$name")/pipelines/$id/jobs" | jq -r '.[] | "\(.id) \(.name)"' | while read -r jobid jobname; do
    echo "----- job '$jobname' -----" >> "$RUN_LOG"
    glapi "$URL/api/v4/projects/$(pid "$name")/jobs/$jobid/trace" >> "$RUN_LOG" 2>/dev/null || true
  done
  if [ "$status" = success ]; then RUN_STATUS=success; else RUN_STATUS=failure; fi
  log "pipeline $id for ${sha:0:8}: $status ($URL/$USER/$name/-/pipelines/$id)"
}

forge_logs() { tail -80 "$RUN_LOG"; }

forge_open_pr() { # name head
  glapi "$URL/api/v4/projects/$(pid "$1")/merge_requests?state=opened&source_branch=$(printf %s "$2" | jq -sRr @uri)" | jq -r '.[0].iid // empty'
}

forge_merge_pr() { # name iid
  local i
  # The merge request is mergeable once GitLab has checked it; retry a 405/406.
  for i in $(seq 1 30); do
    glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")/merge_requests/$2/merge" 2>/dev/null && return 0
    sleep 3
  done
  fail "merge request $2 on $1 could not be merged"
}

forge_config_url() { echo "$URL/$USER/$1"; }
forge_project_key() { echo "localhost/$USER/$1"; }
