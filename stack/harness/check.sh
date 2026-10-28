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
#   check.sh pr-run <branch> <status>     the newest pull_request run of the
#                                         branch's head ended status
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
#   check.sh plan-twice <root>            a clone of main planned twice in the
#                                         binary's CI image; both plans, shown
#                                         as JSON in key order with their
#                                         timestamps left out, are the same bytes
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
    wait_run "$REPO" "$sha" pull_request || exit 1
    [ "$RUN_STATUS" = "$want" ] || { log "the pull_request run of $branch ended $RUN_STATUS, not $want"; exit 1; }
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
  *) echo "usage: check.sh settle | main-runs <n> [status] | status <branch> <context> <state> | objects <bucket> <prefix> <jq> | no-objects <bucket> <prefix> | ledger-file <path> <jq> | branch-run <branch> <status> | job-running [match] | queue-estate <queue> <estate> | bucket-estate <bucket> <estate> | pr-run <branch> <status> | review <branch> | ec2-running <region> <n> | cross-estate <vpc-cidr> <subnet-cidr> <producer> <consumer> | approve [gate] | plan-twice <root>" >&2; exit 2 ;;
esac
