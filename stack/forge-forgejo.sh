#!/usr/bin/env bash
# The forgejo profile's side of validate-generated.sh, for the claims that run
# the pipeline terragucci generates (tg-*, cdf-*); validate.sh's own forgejo
# check and apply run a hand-written workflow. Forgejo and its runner are on
# the terragucci network, the runner gives every job floci's AWS environment,
# and a push starts the run by itself; "the run" is the one on the pushed sha,
# polled to the end with lib.sh's wait_run.
#
# Defines the part of forge-github.sh's interface the tg-* and cdf-* claims
# call: forge_load, forge_reset_repo, forge_remote, forge_push, forge_run,
# forge_logs.
FORGE_TOKEN_ENV=TERRAGUCCI_FORGEJO_TOKEN
PIPELINE_FILE=.forgejo/workflows/terragucci.yml

forge_load() {
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
}

forge_remote() { echo "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/$1.git"; }

# A fresh repo each time, with Actions on and main seeded by an empty commit
# (no workflow, so no run), so main is the default branch before the first
# claim push lands on another branch.
forge_reset_repo() { # name
  local repo="$USER/$1" i
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$repo")" = "$1" ]; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  for i in $(seq 1 30); do answers 404 && break; sleep 1; done
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$1\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
  for i in $(seq 1 30); do answers 200 && break; sleep 1; done
  answers 200 || fail "Forgejo did not create $repo"
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  local seed="$WORK/seed-$1"
  rm -rf "$seed"; mkdir -p "$seed"
  push_dir "$seed" "$(forge_remote "$1")" main "seed" >/dev/null
}

forge_push() { # dir name branch message
  push_dir "$1" "$(forge_remote "$2")" "$3" "$4"
}

# Every job's whole log goes to RUN_LOG; RUN_STATUS is success or failure.
forge_run() { # name branch sha
  local repo="$USER/$1" id name status
  RUN_LOG="$WORK/run-$RANDOM.log"
  wait_run "$repo" "$3"
  : > "$RUN_LOG"
  api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '.[] | "\(.id)\t\(.name)\t\(.status)"' \
    | while IFS=$'\t' read -r id name status; do
        echo "----- job '$name' ($status) -----" >> "$RUN_LOG"
        api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" >> "$RUN_LOG" 2>/dev/null || true
      done
  [ "$RUN_STATUS" = success ] || RUN_STATUS=failure
}

forge_logs() { tail -80 "$RUN_LOG"; }
