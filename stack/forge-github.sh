#!/usr/bin/env bash
# The github profile's side of validate-generated.sh. GitHub has no
# self-hostable edition, so the forge is stack/mock-github (repos, pull
# requests and git over HTTP) and the runner is `act` on the host: it runs the
# repo's real workflow file, with the job containers on the terragucci
# network, so the pipeline reaches floci by name just as it does on the
# other forges. A push is a git push to the mock; "the run" is act on a fresh
# clone of the pushed commit, with a push event for that branch.
#
# Defines the interface validate-generated.sh calls:
#   forge_load                      reads stack/.state/github.env
#   forge_reset_repo NAME           an empty repo NAME under the admin
#   forge_remote NAME               its git URL with credentials
#   forge_push DIR NAME BRANCH MSG  one commit of DIR, force-pushed; prints the sha
#   forge_run NAME BRANCH SHA       run the pipeline for SHA; sets RUN_STATUS, writes RUN_LOG
#   forge_logs                      prints the last run's log
#   forge_open_pr NAME HEAD         prints the number of the open PR from HEAD, or nothing
#   forge_merge_pr NAME N
#   forge_branch_sha NAME BRANCH
#   forge_config_url NAME           the url for a terragucci config project
FORGE_TOKEN_ENV=TERRAGUCCI_GITHUB_TOKEN
PIPELINE_FILE=.github/workflows/terragucci.yml
WORKFLOW_DIR_NOTE=".github/workflows"

forge_load() {
  if [ -z "${TERRAGUCCI_GITHUB_TOKEN:-}" ]; then
    [ -f "$HERE/.state/github.env" ] || fail "no stack/.state/github.env; run 'just stack-up github' first"
    # shellcheck disable=SC1091
    . "$HERE/.state/github.env"
  fi
  URL="$TERRAGUCCI_GITHUB_URL"; TOKEN="$TERRAGUCCI_GITHUB_TOKEN"; USER="$TERRAGUCCI_GITHUB_USER"; FLOCI="$TERRAGUCCI_FLOCI_URL"
  REPO="$TERRAGUCCI_GITHUB_REPO"
  command -v act >/dev/null 2>&1 || fail "act is not installed (brew install act)"
  curl -fsS -o /dev/null "$URL/__mock/health" 2>/dev/null || fail "the mock GitHub at $URL does not answer; run 'just stack-up github' first"
}

gh() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

forge_reset_repo() { # name
  curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" -X DELETE "$URL/api/v3/repos/$USER/$1"
  gh -o /dev/null -d "{\"name\":\"$1\",\"default_branch\":\"main\"}" "$URL/api/v3/user/repos"
}

forge_remote() { echo "${URL/#http:\/\//http://oauth2:${TOKEN}@}/$USER/$1.git"; }

forge_push() { # dir name branch message
  push_dir "$1" "$(forge_remote "$2")" "$3" "$4"
}

forge_branch_sha() { gh "$URL/api/v3/repos/$USER/$1/branches/$2" | jq -r .commit.sha; }

# act on a fresh clone of the commit, the way a runner checks out a push. The
# payload is a push event: the ref decides whether the apply job's condition
# (the default branch) holds. Output goes to RUN_LOG.
forge_run() { # name branch sha
  local name="$1" branch="$2" sha="$3" dir="$WORK/run-$RANDOM" image
  image="$(ci_image)"
  git clone -q "${URL/#http:\/\//http://oauth2:${TOKEN}@}/$USER/$name.git" "$dir" 2>/dev/null
  git -C "$dir" checkout -q "$sha"
  jq -n --arg ref "refs/heads/$branch" --arg sha "$sha" --arg repo "$USER/$name" \
    '{ref: $ref, after: $sha, repository: {full_name: $repo, default_branch: "main"}}' > "$dir.event.json"
  RUN_LOG="$dir.log"
  log "act push on ${name}@${sha:0:8} ($branch)"
  if (cd "$dir" && act push -W "$PIPELINE_FILE" -e "$dir.event.json" --network terragucci \
        -P "ubuntu-latest=$image" --pull=false --rm \
        --env AWS_ENDPOINT_URL=http://floci:4566 --env AWS_ACCESS_KEY_ID=test \
        --env AWS_SECRET_ACCESS_KEY=test --env AWS_REGION=us-east-1 \
        --env GITHUB_API_URL=http://mock-github:8188/api/v3 \
        --github-instance mock-github:8188) >"$RUN_LOG" 2>&1; then
    RUN_STATUS=success
  else
    RUN_STATUS=failure
  fi
  log "run for ${sha:0:8}: $RUN_STATUS"
}

forge_logs() { tail -80 "$RUN_LOG"; }

forge_open_pr() { # name head
  gh "$URL/api/v3/repos/$USER/$1/pulls?state=open" | jq -r --arg h "$2" '.[] | select(.head.ref == $h) | .number' | head -1
}

forge_merge_pr() { gh -o /dev/null -X PUT "$URL/api/v3/repos/$USER/$1/pulls/$2/merge" -d '{}'; }

forge_config_url() { echo "$URL/$USER/$1"; }
forge_project_key() { echo "localhost/$USER/$1"; }
