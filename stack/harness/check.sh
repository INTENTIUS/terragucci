#!/usr/bin/env bash
#
# The out-of-band checks of terragucci's harness scenarios (terragucci#1295).
# A scenario step runs one through chant's no-real-cloud wrapper, and its
# exit code is the step's outcome: 0 when what it checks holds, 1 when not.
# harness.ts sets TG_SCENARIO_REPO (<admin>/hs-<id>) and the forgejo.env
# variables; under the BREAK arm, BREAK=1.
#
#   check.sh settle                       every run of the repo has finished
#   check.sh main-runs <n> [status]       the newest n push runs on main ended
#                                         status (default success), waiting
#                                         for them first
#   check.sh status <branch> <context> <state>
#                                         the head of branch carries context at
#                                         state (success, failure, pending)
#   check.sh objects <bucket> <prefix> <jq>
#                                         the JSON objects under prefix in
#                                         floci, as one array, pass jq -e
#   check.sh no-objects <bucket> <prefix> nothing is under prefix
#   check.sh ledger-file <path> <jq>      the file at path on the repo's
#                                         chant/lifecycle ({} when there is
#                                         none) passes jq -e
#   check.sh branch-run <branch> <status> the newest push run of branch ended
#                                         status, waiting for it first
#   check.sh job-running [match]          a job container whose name holds
#                                         match runs on the stack's network
#                                         (waits up to five minutes)
#   check.sh queue-estate <queue> <estate>
#   check.sh bucket-estate <bucket> <estate>
#                                         the SQS queue or S3 bucket in floci
#                                         carries tofu-estate <estate>
#   check.sh pr-run <branch> <status> [workflow]
#                                         the newest pull_request run of the
#                                         branch's head (of that workflow file,
#                                         when named) ended status
#   check.sh review <branch>              the reviewer approves the open pull
#                                         request from branch (a review on the
#                                         forge, as a person gives it)
#   check.sh ec2-running <region> <n>     floci holds n running EC2 instances
#                                         in region
#   check.sh cross-estate <vpc-cidr> <subnet-cidr> <producer> <consumer>
#                                         the subnet's VpcId is the VPC's id,
#                                         and each carries its own estate's
#                                         tofu-estate tag (choudoufu's
#                                         cross-estate-dependency prove.sh,
#                                         checks 2)
#   check.sh approve [wave-<k> | <migration>]
#                                         terragucci approve as the reviewer
#                                         in a clone of main, with no digest
#                                         copied (the waiting wave's own)
#   check.sh chant-approve <op> <gate>    chant approve <op> <gate> as the
#                                         reviewer, in the reviewer's clone of
#                                         main with chant/lifecycle, with the
#                                         chant the tree pins, and the ledger
#                                         pushed back
#   check.sh rerun <workflow> [status]    the workflow run again on main (a
#                                         dispatch, or an empty commit when
#                                         Forgejo refuses one) ended status
#                                         (default success)
#   check.sh plan-twice <root>            a clone of main planned twice in the
#                                         binary's CI image; both plans, shown
#                                         as JSON in key order with their
#                                         timestamps left out, are the same bytes
#
# Templates (terragucci#1308-#1312). The product opens the pull request, so a
# scenario starts it here and binds it with await-pull. Each runs on a fresh
# clone of main; under BREAK=1 the scenario's overlays/break is copied over
# that clone first (the request, rollout and form read the catalog and the
# config from the checkout), and nothing is pushed but what the product
# pushes. terragucci runs from this checkout's bundle in the tofu CI image on
# the stack's network, where the repo's url (http://forgejo:3000) answers.
#
#   check.sh request <template> --name <n> [<request flag>...]
#                                         terragucci request as the author;
#                                         exits as it does (0 opened, 1 refused)
#   check.sh rollout <module> [<version>] terragucci rollout --mode apply as the
#                                         author; exits as it does (0 a wave
#                                         opened or all applied, 3 waiting,
#                                         1 stopped)
#   check.sh templates-apps <jq>          terragucci templates apps --json's
#                                         results pass jq -e
#   check.sh tg-net [-i] <command>...     the command in such a clone (the
#                                         MCP server agent-request starts)
#   check.sh agent-request <tool> <json>  stack/mcp-client.mjs calls the tool on
#                                         terragucci mcp --propose (without
#                                         --propose under BREAK=1), with the
#                                         author's token; 0 when the tool was
#                                         listed and answered without an error
#
# behold (behold#1035, #1036; #1037 adds its own). Each starts behold serve
# on the clone, with this checkout's terragucci first on PATH and the
# author's token as FORGEJO_TOKEN, makes the call a person's browser makes
# (same-origin, JSON), prints the answer, and stops behold. BEHOLD names the
# behold command (default: behold on PATH), such as
# "node ../behold/bin/behold.js" for a checkout of behold's
# integration/self-service.
#
#   check.sh behold-request <template> <name> [--app <app>] [--version <v>] [--input <k>=<v> | <k>=<v>]...
#                                         POST /api/templates/request; 0 on 202,
#                                         1 naming the refusal's code otherwise
#   check.sh behold-apps <app> [--addon <name>]...
#                                         GET /api/templates/apps lists the app
#                                         and each named add-on of it
#   check.sh behold-upgrade <app> [<version>]
#                                         POST /api/templates/upgrade; 0 on 202
#                                         (behold dispatches terragucci-rollout.yml)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
log() { echo "[check] $*" >&2; }
fail() { log "FAIL: $*"; return 1; }
# shellcheck source=../lib.sh
. "$HERE/../lib.sh"
REPO="${TG_SCENARIO_REPO:?check.sh runs from a harness scenario, which sets TG_SCENARIO_REPO}"
remote() { echo "${URL/#http:\/\//http://${1}:${2}@}/${REPO}.git"; }

push_runs() { # -> the repo's push runs on main, newest first, as JSON lines
  api "$URL/api/v1/repos/$REPO/actions/runs?event=push&branch=main&limit=50" | jq -c '.workflow_runs[]?'
}

wait_settled() {
  local deadline=$(( $(date +%s) + TIMEOUT )) busy
  while :; do
    busy="$(api "$URL/api/v1/repos/$REPO/actions/runs?limit=50" | jq '[.workflow_runs[]? | select(.status as $s | ["success", "failure", "cancelled", "skipped"] | index($s) | not)] | length')"
    [ "$busy" = 0 ] && return 0
    [ "$(date +%s)" -lt "$deadline" ] || { log "$busy run(s) of $REPO still going after ${TIMEOUT}s"; return 1; }
    sleep 3
  done
}

clone_main() { # dir
  git clone -q --single-branch --branch main "$(remote "$USER" "$TOKEN")" "$1" >&2
}

# ── templates: terragucci and behold as the product ─────────────────────────
# shellcheck source=../mounted.sh
. "$HERE/../mounted.sh"
BUNDLE="$ROOT/packages/terragucci/dist/terragucci.mjs"
AUTHOR="${TERRAGUCCI_FORGEJO_AUTHOR:-}"
AUTHOR_TOKEN="${TERRAGUCCI_FORGEJO_AUTHOR_TOKEN:-}"

break_overlay() { # -> the scenario's overlays/break under BREAK=1, else nothing
  local dir="$HERE/scenarios/${TG_SCENARIO:?}/overlays/break"
  [ -n "${BREAK:-}" ] && [ -d "$dir" ] && echo "$dir"
  return 0
}

ci_image() { # binary -> its CI image tag
  (cd "$ROOT" && npx tsx scripts/images.ts tags | awk -v n="$1" '$1 == n { print $2 }')
}

# tg_net [-i] <command>...: the command in a clone of main, in the tofu CI
# image on the stack's network, as the author, with this checkout's bundle as
# terragucci. The clone gets overlays/break under BREAK=1. Its stdout is the
# command's; the clone's progress goes to stderr.
tg_net() {
  local -a tty=()
  [ "${1:-}" = -i ] && { tty=(-i); shift; }
  local image overlay
  image="$(ci_image tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just images' first"; return 1; }
  [ -f "$BUNDLE" ] || { log "no $BUNDLE; run 'just build-cli' first"; return 1; }
  [ -n "$AUTHOR_TOKEN" ] || { log "TERRAGUCCI_FORGEJO_AUTHOR_TOKEN is not set; harness.ts passes forgejo.env"; return 1; }
  overlay="$(break_overlay)"
  local -a mounts=(-v "$BUNDLE:/opt/tg/terragucci.mjs:ro")
  [ -z "$overlay" ] || mounts+=(-v "$overlay:/break:ro")
  run_copied --rm ${tty[@]+"${tty[@]}"} --network "$TG_NETWORK" "${mounts[@]}" \
    -e "TERRAGUCCI_FORGEJO_TOKEN=$AUTHOR_TOKEN" -e "TG_CLONE=http://$AUTHOR:$AUTHOR_TOKEN@forgejo:3000/$REPO.git" -e "TG_AUTHOR=$AUTHOR" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    --entrypoint sh "$image" -c 'mkdir -p /tmp/bin && printf "#!/bin/sh\nexec node /opt/tg/terragucci.mjs \"\$@\"\n" > /tmp/bin/terragucci && chmod +x /tmp/bin/terragucci && export PATH="/tmp/bin:$PATH" \
      && git clone -q --branch main "$TG_CLONE" /tmp/repo >&2 && cd /tmp/repo \
      && git config user.name "$TG_AUTHOR" && git config user.email "$TG_AUTHOR@terragucci.local" \
      && { [ ! -d /break ] || { cp -R /break/. . && echo "[check] overlays/break copied over the clone" >&2; }; } \
      && exec "$@"' tg-net "$@"
}

# behold_up <dir>: behold serve on the checkout in dir, on a free loopback port
# (BEHOLD_URL), with this checkout's terragucci first on PATH. behold_down stops it.
BEHOLD_PID=""
behold_up() {
  local dir="$1" shim i
  local -a behold
  read -r -a behold <<<"${BEHOLD:-behold}"
  command -v "${behold[0]}" >/dev/null 2>&1 || { log "no behold to run: set BEHOLD to the behold command, such as \"node <behold checkout>/bin/behold.js\""; return 1; }
  [ -n "$AUTHOR_TOKEN" ] || { log "TERRAGUCCI_FORGEJO_AUTHOR_TOKEN is not set; harness.ts passes forgejo.env"; return 1; }
  shim="$(dirname "$dir")/bin"
  mkdir -p "$shim"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$BUNDLE" > "$shim/terragucci"
  chmod +x "$shim/terragucci"
  BEHOLD_PORT="${BEHOLD_PORT:-$(( 4700 + RANDOM % 200 ))}"
  BEHOLD_URL="http://127.0.0.1:$BEHOLD_PORT"
  PATH="$shim:$PATH" FORGEJO_TOKEN="$AUTHOR_TOKEN" FORGEJO_URL="$URL" \
    "${behold[@]}" serve "$dir" --port "$BEHOLD_PORT" > "$(dirname "$dir")/behold.log" 2>&1 &
  BEHOLD_PID=$!
  trap behold_down EXIT
  for i in $(seq 1 120); do
    curl -fsS -o /dev/null "$BEHOLD_URL/api/project" 2>/dev/null && { log "behold serves $dir at $BEHOLD_URL"; return 0; }
    kill -0 "$BEHOLD_PID" 2>/dev/null || break
    sleep 1
  done
  log "behold did not serve within two minutes: $(tail -5 "$(dirname "$dir")/behold.log" 2>/dev/null)"
  return 1
}
behold_down() {
  [ -z "$BEHOLD_PID" ] || { kill "$BEHOLD_PID" 2>/dev/null || true; wait "$BEHOLD_PID" 2>/dev/null || true; BEHOLD_PID=""; }
}
# behold_call <method> <path> [json]: the call a person's browser makes. Sets
# B_STATUS and B_BODY.
behold_call() {
  local out
  out="$(mktemp "${TMPDIR:-/tmp}/tg-behold.XXXXXX")"
  local -a body=()
  [ -z "${3:-}" ] || body=(-H 'content-type: application/json' --data-binary "$3")
  B_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" -H "Origin: $BEHOLD_URL" -H 'Sec-Fetch-Site: same-origin' ${body[@]+"${body[@]}"} "$BEHOLD_URL$2")" || B_STATUS=000
  B_BODY="$(cat "$out")"
  log "behold $1 $2: $B_STATUS $(printf '%s' "$B_BODY" | head -c 400)"
}
# behold_checkout -> a fresh clone of main for behold to serve, with overlays/break under BREAK=1
behold_checkout() {
  local work overlay
  work="$(mktemp -d "${TMPDIR:-/tmp}/tg-check.XXXXXX")"
  git clone -q --single-branch --branch main "$URL/$REPO.git" "$work/repo" >&2
  overlay="$(break_overlay)"
  [ -z "$overlay" ] || { cp -R "$overlay/." "$work/repo/"; log "overlays/break copied over behold's checkout"; }
  echo "$work/repo"
}

case "${1:-}" in
  settle) wait_settled ;;
  main-runs)
    n="${2:?main-runs <n> [status]}"; want="${3:-success}"
    wait_settled || exit 1
    got="$(push_runs | head -n "$n" | jq -r .status | sort | uniq -c | awk '{ printf "%s%s=%s", sep, $2, $1; sep = "," }')"
    log "the newest $n push runs on main: $got"
    [ "$got" = "$want=$n" ]
    ;;
  status)
    branch="${2:?}"; context="${3:?}"; want="${4:?}"
    sha="$(remote_head "$REPO" "$branch")"
    [ -n "$sha" ] || { log "$branch has no head"; exit 1; }
    got="$(api "$URL/api/v1/repos/$REPO/commits/$sha/statuses?limit=50" | jq -r --arg c "$context" '[.[] | select(.context == $c)] | sort_by(.id) | last | .status // "none"')"
    log "$context on $branch (${sha:0:8}): $got"
    [ "$got" = "$want" ]
    ;;
  objects|no-objects)
    bucket="${2:?}"; prefix="${3:?}"
    keys="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=$prefix" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g' || true)"
    if [ "$1" = no-objects ]; then
      [ -z "$keys" ] || { log "under s3://$bucket/$prefix: $(echo $keys)"; exit 1; }
      exit 0
    fi
    filter="${4:?objects <bucket> <prefix> <jq>}"
    [ -n "$keys" ] || { log "nothing under s3://$bucket/$prefix"; exit 1; }
    for k in $keys; do curl -fsS "$FLOCI/$bucket/$k"; echo; done | jq -s -e "$filter" >&2
    ;;
  ledger-file)
    path="${2:?ledger-file <path> <jq>}"; filter="${3:?ledger-file <path> <jq>}"
    { file_at "$REPO" chant/lifecycle chant/lifecycle "$path" 2>/dev/null || echo '{}'; } | jq -e "$filter" >&2
    ;;
  branch-run)
    branch="${2:?branch-run <branch> <status>}"; want="${3:?branch-run <branch> <status>}"
    sha=""
    for _ in $(seq 1 60); do sha="$(remote_head "$REPO" "$branch")"; [ -n "$sha" ] && break; sleep 2; done
    [ -n "$sha" ] || { log "$branch has no head"; exit 1; }
    wait_run "$REPO" "$sha" push || exit 1
    [ "$RUN_STATUS" = "$want" ] || { log "the push run of $branch ended $RUN_STATUS, not $want"; exit 1; }
    ;;
  job-running)
    for _ in $(seq 1 150); do
      if docker ps --filter "network=$TG_NETWORK" --format '{{.Names}}' | grep ACTIONS-TASK | grep -q -- "${2:-}"; then exit 0; fi
      sleep 2
    done
    log "no job container${2:+ matching $2} ran on $TG_NETWORK within five minutes"; exit 1
    ;;
  queue-estate)
    url="$(curl -fsS -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.GetQueueUrl' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueName\":\"${2:?}\"}" | jq -r '.QueueUrl // empty')" || true
    [ -n "$url" ] || { log "no queue $2 in floci"; exit 1; }
    got="$(curl -fsS -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.ListQueueTags' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueUrl\":\"$url\"}" | jq -r '.Tags["tofu-estate"] // empty')"
    log "queue $2 carries tofu-estate '${got}'"
    [ "$got" = "${3:?}" ]
    ;;
  bucket-estate)
    got="$(curl -fsS "$FLOCI/${2:?}?tagging" | tr -d '\n' | sed -n 's#.*<Key>tofu-estate</Key><Value>\([^<]*\)</Value>.*#\1#p')"
    log "bucket $2 carries tofu-estate '${got}'"
    [ "$got" = "${3:?}" ]
    ;;
  pr-run)
    branch="${2:?pr-run <branch> <status>}"; want="${3:?pr-run <branch> <status>}"
    sha=""
    for _ in $(seq 1 60); do sha="$(remote_head "$REPO" "$branch")"; [ -n "$sha" ] && break; sleep 2; done
    [ -n "$sha" ] || { log "$branch has no head"; exit 1; }
    WAIT_WORKFLOW="${4:-}" wait_run "$REPO" "$sha" pull_request || exit 1
    [ "$RUN_STATUS" = "$want" ] || { log "the pull_request run${4:+ of $4} on $branch ended $RUN_STATUS, not $want"; exit 1; }
    ;;
  review)
    branch="${2:?review <branch>}"
    pr="$(api "$URL/api/v1/repos/$REPO/pulls?state=open&limit=50" | jq -r --arg b "$branch" '.[] | select(.head.ref == $b) | .number' | head -1)"
    [ -n "$pr" ] || { log "no open pull request from $branch"; exit 1; }
    curl -fsS -o /dev/null -H "Authorization: token $TERRAGUCCI_FORGEJO_REVIEWER_TOKEN" -H 'content-type: application/json' -X POST \
      -d '{"event":"APPROVED","body":"Approved by the e2e harness."}' "$URL/api/v1/repos/$REPO/pulls/$pr/reviews" \
      || { log "$TERRAGUCCI_FORGEJO_REVIEWER could not approve pull request $pr"; exit 1; }
    log "$TERRAGUCCI_FORGEJO_REVIEWER approved pull request $pr"
    ;;
  ec2-running|cross-estate)
    # floci's EC2 Query API, in the region a SigV4 credential scope names. floci
    # checks no signature, so the scope is the only part of the header it reads.
    ec2() { # region, query string -> the XML answer
      curl -fsS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' \
        -H "Authorization: AWS4-HMAC-SHA256 Credential=test/20260101/$1/ec2/aws4_request, SignedHeaders=host, Signature=0" \
        --data "Version=2016-11-15&$2"
    }
    first() { sed -n "s#.*<$1>\([^<]*\)</$1>.*#\1#p" | head -1; }
    estate_tag() { # region, resource id
      ec2 "$1" "Action=DescribeTags&Filter.1.Name=resource-id&Filter.1.Value.1=$2&Filter.2.Name=key&Filter.2.Value.1=tofu-estate" | tr -d '\n' | sed -n 's#.*<value>\([^<]*\)</value>.*#\1#p'
    }
    if [ "$1" = ec2-running ]; then
      region="${2:?ec2-running <region> <n>}"; want="${3:?ec2-running <region> <n>}"
      got="$(ec2 "$region" "Action=DescribeInstances&Filter.1.Name=instance-state-name&Filter.1.Value.1=running" | grep -c '<instanceId>' || true)"
      log "$got running instance(s) in $region"
      [ "$got" = "$want" ]
    else
      vpc_cidr="${2:?}"; subnet_cidr="${3:?}"; producer="${4:?}"; consumer="${5:?}"
      vpc="$(ec2 us-east-1 "Action=DescribeVpcs&Filter.1.Name=cidr&Filter.1.Value.1=$vpc_cidr" | first vpcId)"
      subnet="$(ec2 us-east-1 "Action=DescribeSubnets&Filter.1.Name=cidr-block&Filter.1.Value.1=$subnet_cidr" | first subnetId)"
      subnet_vpc="$(ec2 us-east-1 "Action=DescribeSubnets&SubnetId.1=$subnet" | first vpcId)"
      log "VPC ${vpc:-none} ($(estate_tag us-east-1 "$vpc")), subnet ${subnet:-none} ($(estate_tag us-east-1 "$subnet")) in ${subnet_vpc:-none}"
      [ -n "$vpc" ] && [ "$subnet_vpc" = "$vpc" ] || { log "the subnet is not in the producer's VPC"; exit 1; }
      [ "$(estate_tag us-east-1 "$vpc")" = "$producer" ] && [ "$(estate_tag us-east-1 "$subnet")" = "$consumer" ] \
        || { log "the VPC and the subnet do not carry $producer and $consumer"; exit 1; }
    fi
    ;;
  approve)
    work="$(mktemp -d "${TMPDIR:-/tmp}/tg-check.XXXXXX")"
    clone_main "$work/repo"
    (cd "$work/repo" && TERRAGUCCI_FORGEJO_TOKEN="$TERRAGUCCI_FORGEJO_REVIEWER_TOKEN" \
      node "$ROOT/packages/terragucci/dist/terragucci.mjs" approve ${2:+"$2"} --actor "$TERRAGUCCI_FORGEJO_REVIEWER" >&2)
    ;;
  chant-approve)
    op="${2:?chant-approve <op> <gate>}"; gate="${3:?chant-approve <op> <gate>}"
    who="$TERRAGUCCI_FORGEJO_REVIEWER"
    work="$(mktemp -d "${TMPDIR:-/tmp}/tg-check.XXXXXX")"
    git clone -q "$(remote "$who" "$TERRAGUCCI_FORGEJO_REVIEWER_TOKEN")" "$work/repo" >&2
    git -C "$work/repo" show-ref -q --verify refs/remotes/origin/chant/lifecycle \
      || { log "$REPO has no chant/lifecycle, so no gate is waiting"; exit 1; }
    git -C "$work/repo" branch -q chant/lifecycle origin/chant/lifecycle
    git -C "$work/repo" config user.name "$who"
    git -C "$work/repo" config user.email "$who@terragucci.local"
    # The tree's own chant, so the resolution is written as the jobs' chant reads it.
    (cd "$work/repo" && npm ci --no-audit --no-fund >/dev/null && npx chant approve "$op" "$gate" --approver "$who") >&2 \
      || { log "chant approve $op $gate failed"; exit 1; }
    # chant pushes the ledger itself and lets a failed push pass; push it here too.
    git -C "$work/repo" push -q origin chant/lifecycle >&2 || { log "the approval did not reach chant/lifecycle on $REPO"; exit 1; }
    log "$who approved $op $gate"
    ;;
  rerun)
    workflow="${2:?rerun <workflow> [status]}"; want="${3:-success}"
    wait_settled || exit 1
    run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
      "$URL/api/v1/repos/$REPO/actions/workflows/$workflow/dispatches" 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)"
    if [ -n "$run" ]; then
      log "dispatched $workflow on main: run $run"
      deadline=$(( $(date +%s) + TIMEOUT ))
      while :; do
        status="$(api "$URL/api/v1/repos/$REPO/actions/runs/$run" | jq -r '.status')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
        [ "$(date +%s)" -lt "$deadline" ] || { log "run $run of $workflow still $status after ${TIMEOUT}s"; exit 1; }
        sleep 3
      done
    else
      # A Forgejo that refuses the dispatch: a push to main runs the workflow again.
      work="$(mktemp -d "${TMPDIR:-/tmp}/tg-check.XXXXXX")"
      clone_main "$work/repo"
      git -C "$work/repo" -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false \
        commit -q --allow-empty -m "run $workflow again"
      git -C "$work/repo" push -q origin HEAD:main >&2 || { log "could not push to main of $REPO"; exit 1; }
      sha="$(git -C "$work/repo" rev-parse HEAD)"
      log "Forgejo refused a dispatch of $workflow; pushed ${sha:0:8} to main instead"
      WAIT_WORKFLOW="$workflow" wait_run "$REPO" "$sha" push || exit 1
      status="$RUN_STATUS"
    fi
    log "$workflow run again on main: $status"
    [ "$status" = "$want" ]
    ;;
  plan-twice)
    root="${2:?plan-twice <root>}"
    binary="$(jq -r --arg id "${TG_SCENARIO:?}" '.[$id].binary' "$HERE/scenarios/index.json")"
    image="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk -v n="$binary" '$1 == n { print $2 }')"
    work="$(mktemp -d "${TMPDIR:-/tmp}/tg-check.XXXXXX")"
    clone_main "$work/repo"
    for i in 1 2; do
      docker run --rm --network "$TG_NETWORK" -v "$work/repo:/repo" -w "/repo/$root" \
        -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
        --entrypoint sh "$image" -c "$binary init -input=false -no-color >/dev/null && $binary plan -input=false -no-color -out=/tmp/p >/dev/null && $binary show -json /tmp/p > plan-$i.json" >&2 \
        || { log "plan $i of $root failed"; exit 1; }
    done
    # Every plan stamps its top-level timestamp; the rest must match in key order.
    a="$(jq -S 'del(.timestamp)' "$work/repo/$root/plan-1.json")"; b="$(jq -S 'del(.timestamp)' "$work/repo/$root/plan-2.json")"
    if [ "$a" = "$b" ]; then
      log "the two plans of $root are the same $(printf '%s' "$a" | wc -c | tr -d ' ') bytes"
    else
      log "the two plans of $root differ: $(diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | head -10)"
      exit 1
    fi
    ;;
  tg-net)
    # tg_net for a child process, such as the MCP server stack/mcp-client.mjs starts.
    shift
    tg_net "$@"
    ;;
  request)
    shift
    [ $# -ge 3 ] || { log "request <template> --name <n> [<request flag>...]"; exit 2; }
    rc=0
    tg_net terragucci request "$@" --requested-by "$AUTHOR" --json || rc=$?
    log "terragucci request $* exited $rc"
    exit "$rc"
    ;;
  rollout)
    shift
    [ $# -ge 1 ] || { log "rollout <module> [<version>]"; exit 2; }
    rc=0
    tg_net terragucci rollout "$@" --mode apply --json || rc=$?
    log "terragucci rollout $* --mode apply exited $rc"
    exit "$rc"
    ;;
  templates-apps)
    filter="${2:?templates-apps <jq>}"
    tg_net terragucci templates apps --json | jq -e ".results | $filter" >&2
    ;;
  agent-request)
    tool="${2:?agent-request <tool> <json>}"; json="${3:?agent-request <tool> <json>}"
    propose=(--propose)
    [ -z "${BREAK:-}" ] || { propose=(); log "BREAK: the server starts without --propose"; }
    rc=0
    # The server is terragucci mcp in a clone, on the stack's network (check.sh tg-net); the client appends --propose.
    (cd "$ROOT" && node stack/mcp-client.mjs ${propose[@]+"${propose[@]}"} call "$tool" "$json" -- \
      bash "$HERE/check.sh" tg-net -i terragucci mcp) || rc=$?
    exit "$rc"
    ;;
  behold-request)
    template="${2:?behold-request <template> <name> [--app <app>] [--version <v>] [--input <k>=<v>]...}"; name="${3:?behold-request <template> <name> ...}"
    shift 3
    app=""; version=""; inputs='{}'
    while [ $# -gt 0 ]; do
      case "$1" in
        --app) app="${2:?--app <app>}"; shift 2 ;;
        --version) version="${2:?--version <v>}"; shift 2 ;;
        --input) kv="${2:?--input <k>=<v>}"; shift 2; inputs="$(jq -c --arg k "${kv%%=*}" --arg v "${kv#*=}" '. + {($k): $v}' <<<"$inputs")" ;;
        *=*) inputs="$(jq -c --arg k "${1%%=*}" --arg v "${1#*=}" '. + {($k): $v}' <<<"$inputs")"; shift ;;
        *) log "behold-request: $1 is not --app, --version or an input <k>=<v>"; exit 2 ;;
      esac
    done
    body="$(jq -nc --arg t "$template" --arg n "$name" --arg a "$app" --arg v "$version" --argjson i "$inputs" \
      '{template: $t, name: $n, inputs: $i} + (if $a == "" then {} else {app: $a} end) + (if $v == "" then {} else {version: $v} end)')"
    behold_up "$(behold_checkout)" || exit 1
    behold_call GET /api/templates
    behold_call POST /api/templates/request "$body"
    [ "$B_STATUS" = 202 ] || { log "behold refused the request: $(jq -r '.code // "no code"' <<<"$B_BODY" 2>/dev/null)"; exit 1; }
    ;;
  behold-apps)
    app="${2:?behold-apps <app> [--addon <name>]...}"; shift 2
    addons='[]'
    while [ $# -gt 0 ]; do
      [ "$1" = --addon ] || { log "behold-apps: $1 is not --addon"; exit 2; }
      addons="$(jq -c --arg a "${2:?--addon <name>}" '. + [$a]' <<<"$addons")"; shift 2
    done
    behold_up "$(behold_checkout)" || exit 1
    behold_call GET /api/templates/apps
    [ "$B_STATUS" = 200 ] || exit 1
    jq -e --arg app "$app" --argjson addons "$addons" \
      '.results | map(select(.app == $app)) | length == 1 and (.[0] as $r | $addons | all(. as $a | $r.addons | any(.name == $a)))' <<<"$B_BODY" >&2 \
      || { log "behold's apps read does not list $app$( [ "$addons" = '[]' ] || echo " with $addons")"; exit 1; }
    ;;
  behold-upgrade)
    app="${2:?behold-upgrade <app> [<version>]}"; version="${3:-}"
    body="$(jq -nc --arg a "$app" --arg v "$version" '{app: $a} + (if $v == "" then {} else {version: $v} end)')"
    behold_up "$(behold_checkout)" || exit 1
    behold_call POST /api/templates/upgrade "$body"
    [ "$B_STATUS" = 202 ] || { log "behold refused the upgrade: $(jq -r '.code // "no code"' <<<"$B_BODY" 2>/dev/null)"; exit 1; }
    ;;
  *) echo "usage: check.sh settle | main-runs <n> [status] | status <branch> <context> <state> | objects <bucket> <prefix> <jq> | no-objects <bucket> <prefix> | ledger-file <path> <jq> | branch-run <branch> <status> | job-running [match] | queue-estate <queue> <estate> | bucket-estate <bucket> <estate> | pr-run <branch> <status> [workflow] | review <branch> | ec2-running <region> <n> | cross-estate <vpc-cidr> <subnet-cidr> <producer> <consumer> | approve [gate] | chant-approve <op> <gate> | rerun <workflow> [status] | plan-twice <root> | request <template> --name <n> [flag...] | rollout <module> [<version>] | templates-apps <jq> | agent-request <tool> <json> | behold-request <template> <name> [--app <app>] [--version <v>] [<k>=<v>...] | behold-apps <app> [--addon <name>]... | behold-upgrade <app> [<version>]" >&2; exit 2 ;;
esac
