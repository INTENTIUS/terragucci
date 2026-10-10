#!/usr/bin/env bash
#
# The real-AWS pilot, SMOKE_AWS=1: boot, drift, respond-drift, tg-drift and
# report run against the account of the default AWS CLI profile instead of
# floci. Every other claim refuses to run under it. CONTRIBUTING.md says how
# to run it and what it costs.
#
#   stack/smoke-aws.sh guard            refuse unless a Budgets alert at $1 exists
#                                       and the month's spend is under $5
#   stack/smoke-aws.sh spend            the month's spend so far, from Cost Explorer
#   stack/smoke-aws.sh prefix           the run prefix every name carries
#   stack/smoke-aws.sh cleanup [--list] [--all]
#                                       list, then delete, every bucket (and its
#                                       objects), queue and table whose name starts
#                                       with the prefix. --list only lists; --all
#                                       takes every tgsmoke- prefix, not only this one.
#   stack/smoke-aws.sh count [FILE]     a measured run's AWS requests by service and
#                                       operation, from the provider's debug log
#                                       (default: the last measured run's log)
#
# smoke.sh, example.sh and example-terragrunt.sh source this file when
# SMOKE_AWS=1 and call the smoke_aws_* functions below.
#
# Names: every bucket, queue and table is "<prefix>-<the name floci uses>",
# state lives in the bucket "<prefix>-terraform-state" under "<prefix>/", and
# the prefix is SMOKE_AWS_PREFIX, or one made once (tgsmoke-<6 hex>) and kept in
# stack/.state/smoke-aws/prefix until a cleanup leaves nothing behind.
#
# Credentials: the default profile's, as short-lived keys from `aws configure
# export-credentials` (static keys are traded for a one-hour session token).
# They are exported to this process only, passed to `docker run` by name
# (never on a command line), and written into the config of a second Forgejo
# runner that exists only while a SMOKE_AWS pipeline runs. Nothing prints them.

SA_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SA_STATE="$SA_HERE/.state/smoke-aws"
SA_REGION=us-east-1
SA_PROFILE="${SMOKE_AWS_PROFILE:-default}"
SA_ALERT_USD=1
SA_CAP_USD=5
# The guard calls Cost Explorer, which bills $0.01 a request, so a passed
# check is kept for this long.
SA_GUARD_TTL="${SMOKE_AWS_GUARD_TTL:-1800}"
SA_CLAIMS="boot drift respond-drift tg-drift report"
SA_RUNNER=terragucci-smoke-aws
SA_RUNNER_CONTAINER=terragucci-smoke-aws-runner
SA_LABEL=smoke-aws
SA_CACHE_VOLUME="${JOB_CACHE_VOLUME:-terragucci-job-cache}"

sa_log() { echo "[smoke-aws] $*" >&2; }

# The aws CLI on the real endpoints, in us-east-1, as JSON, never reading
# stdin. Before the mode's keys are exported it reads the profile; afterwards
# the exported keys.
sa() {
  local p=()
  [ -n "${SMOKE_AWS_CREDS_AT:-}" ] || p=(--profile "$SA_PROFILE")
  AWS_PAGER="" env -u AWS_ENDPOINT_URL -u AWS_ENDPOINT_URL_S3 -u AWS_ENDPOINT_URL_SQS \
    -u AWS_ENDPOINT_URL_DYNAMODB -u AWS_ENDPOINT_URL_STS \
    aws ${p[@]+"${p[@]}"} --region "$SA_REGION" --output json "$@" </dev/null
}

smoke_aws_claim() { case " $SA_CLAIMS " in *" $1 "*) return 0 ;; esac; return 1; }

# ── the prefix ──────────────────────────────────────────────────────────────

smoke_aws_valid_prefix() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,22}[a-z0-9]$ ]]; }

# Sets and exports SMOKE_AWS_PREFIX and SMOKE_AWS_STATE_BUCKET.
smoke_aws_prefix() {
  local pfx="${SMOKE_AWS_PREFIX:-}" file="$SA_STATE/prefix" tmp
  if [ -z "$pfx" ] && [ -s "$file" ]; then pfx="$(cat "$file")"; fi
  if [ -z "$pfx" ]; then
    mkdir -p "$SA_STATE"
    tmp="$file.$$"
    echo "tgsmoke-$(openssl rand -hex 3)" > "$tmp"
    # Two runs that start together keep whichever prefix was written first.
    if [ -s "$file" ]; then rm -f "$tmp"; else mv "$tmp" "$file"; fi
    pfx="$(cat "$file")"
    sa_log "a new run prefix: $pfx"
  fi
  smoke_aws_valid_prefix "$pfx" \
    || { sa_log "SMOKE_AWS_PREFIX '$pfx' is not 3 to 24 lower-case letters, digits and hyphens"; return 1; }
  export SMOKE_AWS_PREFIX="$pfx"
  export SMOKE_AWS_STATE_BUCKET="$pfx-terraform-state"
}

# ── credentials ─────────────────────────────────────────────────────────────

sa_epoch() { python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$1" 2>/dev/null || true; }

# Exports AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN from
# the profile. Keys a parent process exported are kept while they have 20
# minutes left.
smoke_aws_creds() {
  local now j until left
  now="$(date +%s)"
  if [ -n "${SMOKE_AWS_CREDS_AT:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ] \
    && [ $(( ${SMOKE_AWS_CREDS_UNTIL:-$((SMOKE_AWS_CREDS_AT + 3600))} - now )) -gt 1200 ]; then
    return 0
  fi
  unset SMOKE_AWS_CREDS_AT SMOKE_AWS_CREDS_UNTIL
  j="$(AWS_PAGER="" env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    aws configure export-credentials --profile "$SA_PROFILE" --format process 2>/dev/null)" \
    || { sa_log "aws configure export-credentials --profile $SA_PROFILE gave no keys; sign in to the profile first"; return 1; }
  if [ -z "$(jq -r '.SessionToken // empty' <<<"$j")" ]; then
    # Long-lived keys: trade them for an hour's session, so no job sees them.
    j="$(sa sts get-session-token --duration-seconds 3600 | jq '.Credentials')" \
      || { sa_log "sts get-session-token failed for the profile's keys"; return 1; }
  fi
  AWS_ACCESS_KEY_ID="$(jq -r '.AccessKeyId' <<<"$j")"
  AWS_SECRET_ACCESS_KEY="$(jq -r '.SecretAccessKey' <<<"$j")"
  AWS_SESSION_TOKEN="$(jq -r '.SessionToken' <<<"$j")"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  export AWS_REGION="$SA_REGION" AWS_DEFAULT_REGION="$SA_REGION"
  unset AWS_PROFILE AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3 AWS_ENDPOINT_URL_SQS AWS_ENDPOINT_URL_DYNAMODB AWS_ENDPOINT_URL_STS
  export SMOKE_AWS_CREDS_AT="$now"
  until="$(sa_epoch "$(jq -r '.Expiration // empty' <<<"$j")")"
  if [ -n "$until" ]; then
    export SMOKE_AWS_CREDS_UNTIL="$until"
    left=$(( (until - now) / 60 ))
    [ "$left" -ge 20 ] || sa_log "WARNING: the profile's keys expire in $left minutes; sign in again before a long run"
  fi
  j=""
}

# ── the guard: a $1 alert, and under $5 spent this month ────────────────────

sa_tomorrow() { date -u -v+1d +%Y-%m-%d 2>/dev/null || date -u -d tomorrow +%Y-%m-%d; }

# The month's spend so far in USD, unblended. Cost Explorer lags by up to a day.
smoke_aws_spend() {
  local start
  start="$(date -u +%Y-%m-01)"
  sa ce get-cost-and-usage --time-period "Start=$start,End=$(sa_tomorrow)" \
    --granularity MONTHLY --metrics UnblendedCost \
    | jq -r '[.ResultsByTime[]?.Total.UnblendedCost.Amount | tonumber] | add // 0'
}

# The name of a cost budget with an alert at $1 or less: an absolute threshold,
# or a percentage of the budget's limit that comes to $1 or less.
smoke_aws_alert() {
  local acct budgets name limit
  acct="$(sa sts get-caller-identity | jq -r '.Account')" || return 1
  budgets="$(sa budgets describe-budgets --account-id "$acct")" || return 1
  while IFS=$'\t' read -r name limit; do
    [ -n "$name" ] || continue
    if sa budgets describe-notifications-for-budget --account-id "$acct" --budget-name "$name" \
      | jq -e --argjson l "${limit:-0}" --argjson a "$SA_ALERT_USD" '
          [.Notifications[]? | select(if .ThresholdType == "ABSOLUTE_VALUE" then .Threshold <= $a
                                      else (.Threshold * $l / 100) <= $a end)] | length > 0' >/dev/null; then
      echo "$name"
      return 0
    fi
  done < <(jq -r '.Budgets[]? | select(.BudgetType == "COST" and .BudgetLimit.Unit == "USD") | [.BudgetName, .BudgetLimit.Amount] | @tsv' <<<"$budgets")
  return 1
}

smoke_aws_guard() {
  local file="$SA_STATE/guard" now at spend budget
  now="$(date +%s)"
  if [ -s "$file" ]; then
    read -r at spend budget <"$file" || true
    if [ -n "${at:-}" ] && [ $((now - at)) -lt "$SA_GUARD_TTL" ]; then
      sa_log "guard passed $(( (now - at) / 60 )) minutes ago: budget '$budget' alerts at \$$SA_ALERT_USD, \$$spend spent this month"
      return 0
    fi
  fi
  budget="$(smoke_aws_alert)" \
    || { sa_log "REFUSED: no AWS Budgets cost budget alerts at \$$SA_ALERT_USD or less (aws budgets describe-budgets). Create one first."; return 1; }
  spend="$(smoke_aws_spend)" || { sa_log "REFUSED: Cost Explorer did not give this month's spend"; return 1; }
  if ! awk -v s="$spend" -v c="$SA_CAP_USD" 'BEGIN { exit !(s + 0 < c + 0) }'; then
    sa_log "REFUSED: \$$spend spent this month, at or over the \$$SA_CAP_USD cap"
    return 1
  fi
  mkdir -p "$SA_STATE"
  # Budget names may hold spaces; the name is last on the line.
  echo "$now $spend $budget" >"$file"
  sa_log "guard: budget '$budget' alerts at \$$SA_ALERT_USD, \$$spend spent this month (cap \$$SA_CAP_USD)"
}

# ── buckets, queues, tables ─────────────────────────────────────────────────

smoke_aws_bucket() { # name: make it if it is not there
  sa s3api head-bucket --bucket "$1" >/dev/null 2>&1 && return 0
  sa s3api create-bucket --bucket "$1" >/dev/null
}

smoke_aws_queue_url() { sa sqs get-queue-url --queue-name "$1" 2>/dev/null | jq -r '.QueueUrl // empty' | grep .; }

# Delete a queue by name, outside Terraform, and wait until SQS stops
# answering for it: for up to a minute after a delete, reads may still find it.
SMOKE_AWS_QUEUE_DELETED_AT=""
smoke_aws_delete_queue() { # name
  local url gone=0
  url="$(smoke_aws_queue_url "$1")" || { sa_log "$1 is not in AWS"; return 1; }
  sa sqs delete-queue --queue-url "$url" >/dev/null || return 1
  SMOKE_AWS_QUEUE_DELETED_AT="$(date +%s)"
  for _ in $(seq 1 45); do
    if ! smoke_aws_queue_url "$1" >/dev/null && ! sa sqs get-queue-attributes --queue-url "$url" >/dev/null 2>&1; then
      gone=$((gone + 1)); [ "$gone" -ge 3 ] && break
    else
      gone=0
    fi
    sleep 2
  done
  sa_log "deleted $1 from AWS, outside Terraform"
}

# SQS refuses a queue name for 60 seconds after it was deleted; wait that out
# before anything creates the queue again.
smoke_aws_queue_settle() {
  [ -n "$SMOKE_AWS_QUEUE_DELETED_AT" ] || return 0
  local wait=$(( SMOKE_AWS_QUEUE_DELETED_AT + 65 - $(date +%s) ))
  if [ "$wait" -gt 0 ]; then sa_log "waiting ${wait}s before the deleted queue's name can be used again"; sleep "$wait"; fi
  SMOKE_AWS_QUEUE_DELETED_AT=""
}

sa_buckets() { sa s3api list-buckets | jq -r '.Buckets[]?.Name'; }
sa_queues() { sa sqs list-queues --queue-name-prefix "$1" | jq -r '.QueueUrls[]?'; }
sa_tables() { sa dynamodb list-tables | jq -r '.TableNames[]?'; }

sa_drop_bucket() { # name: its objects (and any versions), then the bucket
  local b="$1" batch
  sa s3 rm "s3://$b" --recursive --quiet >/dev/null 2>&1 || true
  batch="$(sa s3api list-object-versions --bucket "$b" 2>/dev/null \
    | jq -c '{Objects: ([(.Versions // [])[], (.DeleteMarkers // [])[]] | map({Key, VersionId}) | .[0:1000]), Quiet: true}' || true)"
  if [ -n "$batch" ] && [ "$(jq '.Objects | length' <<<"$batch")" != 0 ]; then
    sa s3api delete-objects --bucket "$b" --delete "$batch" >/dev/null || true
  fi
  sa s3api delete-bucket --bucket "$b" >/dev/null
}

# Delete the resources whose names match ^<prefix>-<name regex> and the state
# under <prefix>/<key prefix> in the state bucket; fail if any is left.
smoke_aws_wipe() { # name regex, state key prefix
  local re="^$SMOKE_AWS_PREFIX-$1" b u t k left n queues=""
  for b in $(sa_buckets | grep -E "$re" || true); do sa_drop_bucket "$b" || true; done
  for u in $(sa_queues "$SMOKE_AWS_PREFIX-" || true); do
    grep -qE "$re" <<<"${u##*/}" || continue
    sa sqs delete-queue --queue-url "$u" >/dev/null || true
    queues=1
  done
  for t in $(sa_tables | grep -E "$re" || true); do
    sa dynamodb delete-table --table-name "$t" >/dev/null || true
    sa dynamodb wait table-not-exists --table-name "$t" || true
  done
  for k in $(sa s3api list-objects-v2 --bucket "$SMOKE_AWS_STATE_BUCKET" --prefix "$SMOKE_AWS_PREFIX/$2" 2>/dev/null | jq -r '.Contents[]?.Key' || true); do
    sa s3api delete-object --bucket "$SMOKE_AWS_STATE_BUCKET" --key "$k" >/dev/null || true
  done
  if [ -n "$queues" ]; then
    # The names come back only after 60 seconds, and listings may show them until then.
    sa_log "waiting 65s: SQS keeps a deleted queue's name for 60"
    sleep 65
  fi
  left="$( { sa_buckets | grep -E "$re"
    sa_queues "$SMOKE_AWS_PREFIX-" | sed 's#.*/##' | grep -E "$re"
    sa_tables | grep -E "$re"
    sa s3api list-objects-v2 --bucket "$SMOKE_AWS_STATE_BUCKET" --prefix "$SMOKE_AWS_PREFIX/$2" | jq -r '.Contents[]?.Key'
  } 2>/dev/null || true)"
  n="$(grep -c . <<<"$left" || true)"
  [ "$n" = 0 ] || { sa_log "the wipe left $n names in AWS: $(tr '\n' ' ' <<<"$left")"; return 1; }
}

# Check that every "kind name" line on stdin is in AWS under the prefix.
smoke_aws_verify() {
  local buckets queues tables kind name missing=0 total=0
  buckets="$(sa_buckets)"; queues="$(sa_queues "$SMOKE_AWS_PREFIX-" | sed 's#.*/##')"; tables="$(sa_tables)"
  while read -r kind name; do
    [ -n "$kind" ] || continue
    total=$((total + 1)); name="$SMOKE_AWS_PREFIX-$name"
    case "$kind" in
      bucket) grep -qx "$name" <<<"$buckets" ;;
      queue)  grep -qx "$name" <<<"$queues" ;;
      table)  grep -qx "$name" <<<"$tables" ;;
    esac || { echo "missing $kind $name"; missing=$((missing + 1)); }
  done
  [ "$missing" = 0 ] || { sa_log "$missing of $total resources are missing from AWS"; return 1; }
  sa_log "all $total resources are in AWS, under $SMOKE_AWS_PREFIX-"
}

# S3 reads for the report claim.
smoke_aws_s3_get() { sa s3 cp "s3://$1/$2" - 2>/dev/null; }
smoke_aws_s3_has() { sa s3api head-object --bucket "$1" --key "$2" >/dev/null 2>&1; }

# ── overrides: what makes a copy of an example run on AWS ───────────────────

# A copy of the plain example (or any tree of roots): beside each root's own
# files, smoke_aws_override.tf moves its state into the prefixed bucket and
# key, reads other roots' state there, addresses S3 virtual-hosted, and
# prefixes each literal bucket, queue and table name and each "shop-" local.
# The pipeline's jobs ask for the SMOKE_AWS runner. example/ is never edited.
smoke_aws_overlay_example() { # dir
  python3 - "$1" "$SMOKE_AWS_PREFIX" <<'PY'
import os, re, sys

tree, p = sys.argv[1], sys.argv[2]
state = f"{p}-terraform-state"
head = "# Written by stack/smoke-aws.sh for a SMOKE_AWS run on real AWS. The example itself is never edited.\n"


def block(text, start):
    depth = 0
    for i in range(text.index("{", start), len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def attr(body, name):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % name, body)
    return m.group(1) if m else None


def strip(text):
    return "\n".join(re.sub(r"\s*(#|//).*$", "", line) for line in text.splitlines())


for dirpath, dirnames, files in os.walk(tree):
    dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
    tfs = sorted(f for f in files if f.endswith(".tf") and not f.endswith("override.tf"))
    if not tfs:
        continue
    text = strip("\n".join(open(os.path.join(dirpath, f)).read() for f in tfs))
    out = []
    m = re.search(r'\bbackend\s+"s3"\s*\{', text)
    if m:
        key = attr(block(text, m.start()), "key")
        out.append(
            "terraform {\n"
            '  backend "s3" {\n'
            f'    bucket       = "{state}"\n'
            f'    key          = "{p}/{key}"\n'
            '    region       = "us-east-1"\n'
            "    use_lockfile = true\n"
            "  }\n"
            "}\n"
        )
    if re.search(r'^\s*provider\s+"aws"\s*\{', text, re.M):
        out.append('provider "aws" {\n  region            = "us-east-1"\n  s3_use_path_style = false\n}\n')
    for m in re.finditer(r'\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{', text):
        key = attr(block(text, m.start()), "key")
        if key:
            out.append(
                f'data "terraform_remote_state" "{m.group(1)}" {{\n'
                "  config = {\n"
                f'    bucket = "{state}"\n'
                f'    key    = "{p}/{key}"\n'
                '    region = "us-east-1"\n'
                "  }\n"
                "}\n"
            )
    for m in re.finditer(r'\bresource\s+"(aws_s3_bucket|aws_sqs_queue|aws_dynamodb_table)"\s+"([^"]+)"\s*\{', text):
        field = "bucket" if m.group(1) == "aws_s3_bucket" else "name"
        lit = attr(block(text, m.start()), field)
        if lit and "${" not in lit and not lit.startswith(p + "-"):
            out.append(f'resource "{m.group(1)}" "{m.group(2)}" {{\n  {field} = "{p}-{lit}"\n}}\n')
    for m in re.finditer(r"^\s*locals\s*\{", text, re.M):
        for name, value in re.findall(r'^\s*(\w+)\s*=\s*"(shop-[^"]*)"\s*$', block(text, m.start()), re.M):
            out.append(f'locals {{\n  {name} = "{p}-{value}"\n}}\n')
    if out:
        with open(os.path.join(dirpath, "smoke_aws_override.tf"), "w") as f:
            f.write(head + "\n" + "\n".join(out))

wf = os.path.join(tree, ".forgejo", "workflows")
if os.path.isdir(wf):
    for name in os.listdir(wf):
        path = os.path.join(wf, name)
        s = open(path).read()
        s2 = re.sub(r"^(\s*runs-on:\s*)docker\s*$", r"\1smoke-aws", s, flags=re.M)
        if s2 != s:
            open(path, "w").write(s2)
PY
}

# A copy of the Terragrunt example: root.hcl, which writes every unit's
# backend.tf and provider.tf, keeps state in the prefixed bucket and key and
# addresses S3 virtual-hosted; the shop's names start with the prefix; the
# pipeline's jobs ask for the SMOKE_AWS runner. Terragrunt generates those two
# files itself, so the copy's root.hcl is changed rather than overridden.
# example-terragrunt/ is never edited.
smoke_aws_overlay_tg() { # dir
  python3 - "$1" "$SMOKE_AWS_PREFIX" <<'PY'
import os, re, sys

tree, p = sys.argv[1], sys.argv[2]


def sub(path, edits):
    s = open(path).read()
    for pattern, repl in edits:
        s, n = re.subn(pattern, repl, s, count=1, flags=re.M)
        assert n == 1, "%s: no match for %s" % (path, pattern)
    open(path, "w").write(s)


sub(os.path.join(tree, "root.hcl"), [
    (r'^(\s*bucket\s*=\s*")shop-terraform-state"', r'\g<1>%s-terraform-state"' % p),
    (r'^(\s*key\s*=\s*")terragrunt/', r"\g<1>%s/terragrunt/" % p),
    (r"^(\s*use_path_style\s*=\s*)true", r"\g<1>false"),
    (r"^(\s*s3_use_path_style\s*=\s*)true", r"\g<1>false"),
])
sub(os.path.join(tree, "live", "common.hcl"), [(r'^(\s*shop\s*=\s*")', r"\g<1>%s-" % p)])
wf = os.path.join(tree, ".forgejo", "workflows")
if os.path.isdir(wf):
    for name in os.listdir(wf):
        f = os.path.join(wf, name)
        s = open(f).read()
        open(f, "w").write(re.sub(r"^(\s*runs-on:\s*)docker\s*$", r"\1smoke-aws", s, flags=re.M))
PY
}

# The arguments that give a `docker run` the mode's keys. Names only: docker
# reads the values from this process's environment.
smoke_aws_docker_env() {
  # shellcheck disable=SC2034 # smoke.sh's docker runs read it
  AWS_DOCKER_ENV=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e "AWS_REGION=$SA_REGION")
}

# ── the SMOKE_AWS runner ────────────────────────────────────────────────────
# A second forgejo-runner beside the stack's, registered as terragucci-smoke-aws
# with the one label smoke-aws, which only an overlaid pipeline asks for. Its
# config, on a tmpfs inside the container, carries the mode's keys into every
# job container it starts. The stack's own runner keeps floci, so a floci claim
# can never reach AWS. Needs lib.sh's api and URL.

sa_runner_image() { sed -n 's#^ *image: *\(data\.forgejo\.org/forgejo/runner:[^ ]*\) *$#\1#p' "$SA_HERE/docker-compose.yml" | head -1; }

smoke_aws_runner_down() {
  local id
  docker rm -f "$SA_RUNNER_CONTAINER" >/dev/null 2>&1 || true
  declare -F api >/dev/null || return 0
  for id in $(api "$URL/api/v1/admin/actions/runners" 2>/dev/null | jq -r --arg n "$SA_RUNNER" '.[]? | select(.name == $n) | .id' || true); do
    api -o /dev/null -X DELETE "$URL/api/v1/admin/actions/runners/$id" 2>/dev/null || true
  done
}

# SMOKE_AWS_MEASURE=1: every job's OpenTofu (core, backend and provider) logs at
# debug level to /cache/smoke-aws-logs/<prefix>/<name>-<time>.log in the job
# cache volume, which `stack/smoke-aws.sh count` reads.
smoke_aws_runner_up() { # name of the run, for its log
  local image reg uuid token log_env="" log_path
  smoke_aws_runner_down
  image="$(sa_runner_image)"
  [ -n "$image" ] || { sa_log "no forgejo runner image in docker-compose.yml"; return 1; }
  if [ -n "${SMOKE_AWS_MEASURE:-}" ]; then
    log_path="/cache/smoke-aws-logs/$SMOKE_AWS_PREFIX/${1:-run}-$(date +%s).log"
    docker run --rm --user 0:0 -v "$SA_CACHE_VOLUME:/cache" "$image" \
      sh -c "mkdir -p '$(dirname "$log_path")' && chmod 777 '$(dirname "$log_path")'" >/dev/null || return 1
    log_env="$(printf '    TF_LOG: debug\n    TF_LOG_PATH: %s\n' "$log_path")"
    sa_log "measuring: every job's debug log goes to $log_path in the $SA_CACHE_VOLUME volume"
  fi
  reg="$(api -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$SA_RUNNER\",\"description\":\"SMOKE_AWS jobs, on real AWS\"}" \
    "$URL/api/v1/admin/actions/runners")" || return 1
  uuid="$(jq -r '.uuid' <<<"$reg")"; token="$(jq -r '.token' <<<"$reg")"
  [ -n "$uuid" ] && [ "$uuid" != null ] || { sa_log "Forgejo registered no runner"; return 1; }
  docker run -d --name "$SA_RUNNER_CONTAINER" --network "${TG_NETWORK:-terragucci}" --user 0:0 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$SA_CACHE_VOLUME:/cache" \
    --tmpfs /data -w /data "$image" \
    sh -c 'while [ ! -s /data/config.yml ]; do sleep 1; done; exec forgejo-runner daemon -c /data/config.yml' >/dev/null || return 1
  docker exec -i "$SA_RUNNER_CONTAINER" sh -c 'umask 077; cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml' <<EOF
log:
  level: info
  job_level: info
runner:
  file: /data/.runner
  capacity: 8
  timeout: 30m
  shutdown_timeout: 0s
  fetch_interval: 2s
  report_interval: 1s
  envs:
    TOFU_INSTALL_DIR: /cache/bin
    TF_PLUGIN_CACHE_DIR: /cache
    AWS_ACCESS_KEY_ID: "$AWS_ACCESS_KEY_ID"
    AWS_SECRET_ACCESS_KEY: "$AWS_SECRET_ACCESS_KEY"
    AWS_SESSION_TOKEN: "$AWS_SESSION_TOKEN"
    AWS_REGION: $SA_REGION
$log_env
  labels:
    - "$SA_LABEL:docker://node:22-bookworm"
cache:
  enabled: false
container:
  network: terragucci
  privileged: false
  options: "-v $SA_CACHE_VOLUME:/cache"
  valid_volumes:
    - $SA_CACHE_VOLUME
  docker_host: "-"
  force_pull: false
server:
  connections:
    forgejo:
      url: http://forgejo:3000/
      uuid: $uuid
      token: $token
EOF
  for _ in $(seq 1 60); do
    if api "$URL/api/v1/admin/actions/runners" | jq -e --arg n "$SA_RUNNER" 'map(select(.name == $n and .status != "offline")) | length > 0' >/dev/null 2>&1; then
      sa_log "the SMOKE_AWS runner is online"
      return 0
    fi
    sleep 2
  done
  docker logs --tail 40 "$SA_RUNNER_CONTAINER" >&2 || true
  sa_log "the SMOKE_AWS runner did not come online"
  return 1
}

# ── the mode ────────────────────────────────────────────────────────────────

# The prefix, the keys, the guard and the state bucket, in that order. Every
# process of a SMOKE_AWS run calls it; the guard's answer is kept for
# SA_GUARD_TTL seconds, the keys while they have 20 minutes left.
smoke_aws_start() {
  local tool
  for tool in aws jq python3 openssl; do
    command -v "$tool" >/dev/null 2>&1 || { sa_log "SMOKE_AWS=1 needs $tool"; return 1; }
  done
  smoke_aws_prefix || return 1
  smoke_aws_creds || return 1
  smoke_aws_guard || return 1
  smoke_aws_bucket "$SMOKE_AWS_STATE_BUCKET" || { sa_log "could not make the state bucket $SMOKE_AWS_STATE_BUCKET"; return 1; }
  smoke_aws_docker_env
}

# ── the commands ────────────────────────────────────────────────────────────

# The prefix of the last run, without making one: cleanup and count never do.
sa_known_prefix() {
  if [ -z "${SMOKE_AWS_PREFIX:-}" ] && [ ! -s "$SA_STATE/prefix" ]; then
    sa_log "no run prefix: SMOKE_AWS_PREFIX is unset and $SA_STATE/prefix does not exist (--all takes every tgsmoke- prefix)"
    return 1
  fi
  smoke_aws_prefix
}

sa_cleanup() { # [--list] [--all]
  local list="" all="" a pre b u t n left
  for a in "$@"; do
    case "$a" in
      --list) list=1 ;;
      --all) all=1 ;;
      *) sa_log "unknown flag '$a' (--list, --all)"; return 2 ;;
    esac
  done
  if [ -n "$all" ]; then
    pre="tgsmoke-"
  else
    sa_known_prefix || return 1
    pre="$SMOKE_AWS_PREFIX-"
  fi
  local buckets queues tables
  buckets="$(sa_buckets | grep "^$pre" || true)"
  queues="$(sa_queues "$pre" || true)"
  tables="$(sa_tables | grep "^$pre" || true)"
  echo "names starting $pre in the account of profile $SA_PROFILE, $SA_REGION:"
  for b in $buckets; do echo "  bucket  $b ($(sa s3api list-objects-v2 --bucket "$b" | jq '.KeyCount // 0') objects)"; done
  for u in $queues; do echo "  queue   ${u##*/}"; done
  for t in $tables; do echo "  table   $t"; done
  n="$(printf '%s\n%s\n%s\n' "$buckets" "$queues" "$tables" | grep -c . || true)"
  [ "$n" != 0 ] || echo "  (none)"
  [ -z "$list" ] || return 0
  # The SMOKE_AWS runner, if a run stopped before it removed it.
  if (. "$SA_HERE/lib.sh") >/dev/null 2>&1; then
    # shellcheck source=lib.sh
    . "$SA_HERE/lib.sh"
  fi
  smoke_aws_runner_down
  if [ "$n" != 0 ]; then
    for b in $buckets; do sa_drop_bucket "$b" && echo "  deleted bucket $b" || echo "  could not delete bucket $b"; done
    for u in $queues; do sa sqs delete-queue --queue-url "$u" >/dev/null && echo "  deleted queue ${u##*/}" || echo "  could not delete queue ${u##*/}"; done
    for t in $tables; do sa dynamodb delete-table --table-name "$t" >/dev/null && echo "  deleted table $t" || echo "  could not delete table $t"; done
    for t in $tables; do sa dynamodb wait table-not-exists --table-name "$t" || true; done
    if [ -n "$queues" ]; then echo "waiting 65s for SQS to drop the deleted queues"; sleep 65; fi
  fi
  # The measured runs' debug logs, in the job cache volume.
  if docker volume inspect "$SA_CACHE_VOLUME" >/dev/null 2>&1 && [ -n "$(sa_runner_image)" ]; then
    if [ -n "$all" ]; then
      docker run --rm --user 0:0 -v "$SA_CACHE_VOLUME:/cache" "$(sa_runner_image)" sh -c 'rm -rf /cache/smoke-aws-logs' >/dev/null 2>&1 || true
    else
      docker run --rm --user 0:0 -v "$SA_CACHE_VOLUME:/cache" "$(sa_runner_image)" sh -c "rm -rf '/cache/smoke-aws-logs/$SMOKE_AWS_PREFIX'" >/dev/null 2>&1 || true
    fi
  fi
  left="$( { sa_buckets | grep "^$pre"; sa_queues "$pre" | sed 's#.*/##'; sa_tables | grep "^$pre"; } 2>/dev/null || true)"
  if [ -n "$left" ]; then
    echo "left in AWS:"; sed 's/^/  /' <<<"$left"
    return 1
  fi
  echo "nothing starting $pre is left in AWS"
  # A clean account: the next run makes a new prefix, so no name is reused.
  if [ -z "${SMOKE_AWS_PREFIX_FROM_ENV:-}" ] && [ -f "$SA_STATE/prefix" ]; then
    if [ -n "$all" ] || [ "$(cat "$SA_STATE/prefix")" = "${SMOKE_AWS_PREFIX:-}" ]; then
      rm -f "$SA_STATE/prefix" "$SA_STATE/guard"
    fi
  fi
}

sa_count() { # [file]
  if [ -n "${1:-}" ]; then
    python3 "$SA_HERE/smoke-aws-count.py" "$1"
    return
  fi
  local image dir latest
  image="$(sa_runner_image)"
  sa_known_prefix || return 1
  dir="/cache/smoke-aws-logs/$SMOKE_AWS_PREFIX"
  latest="$(docker run --rm --user 0:0 -v "$SA_CACHE_VOLUME:/cache:ro" "$image" sh -c "ls -t '$dir'/*.log 2>/dev/null | head -1")"
  [ -n "$latest" ] || { sa_log "no measured log in $dir; run SMOKE_AWS=1 SMOKE_AWS_MEASURE=1 stack/smoke.sh boot first"; return 1; }
  sa_log "counting $latest"
  docker run --rm --user 0:0 -v "$SA_CACHE_VOLUME:/cache:ro" "$image" cat "$latest" | python3 "$SA_HERE/smoke-aws-count.py" -
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  [ -n "${SMOKE_AWS_PREFIX:-}" ] && export SMOKE_AWS_PREFIX_FROM_ENV=1
  cmd="${1:-}"; shift || true
  case "$cmd" in
    guard) smoke_aws_guard ;;
    spend) echo "\$$(smoke_aws_spend) spent this month (Cost Explorer, which lags by up to a day)" ;;
    prefix) smoke_aws_prefix && echo "$SMOKE_AWS_PREFIX" ;;
    cleanup) sa_cleanup "$@" ;;
    count) sa_count "$@" ;;
    *) sed -n '8,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
fi
