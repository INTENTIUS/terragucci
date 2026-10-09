#!/usr/bin/env bash
# The scale bench: a terralith carved into many roots across several repos, one
# control repo over them, and the pipeline the published release generates,
# run end to end on Forgejo against floci.
#
#   stack/scale/scale.sh up                  start the bench's stack (compose project tgscale)
#   stack/scale/scale.sh run <scale>...      run the bench at each terralith scale, in order
#   stack/scale/scale.sh record [file]       write the runs into docs-site/src/data/scale.json
#   stack/scale/scale.sh down                remove the bench's stack
#
# A terralith at scale s declares 74*s+5 resources (79, 301, 745, 3705, 10069
# at 1, 4, 10, 50, 136). carve.py splits it into 10*s+1 roots: the platform
# repo (the network, cluster and zone, and every root that reads them) and
# identity repos of TGSCALE_ROOTS_PER_REPO roots (100).
#
# One run, for each scale:
#   1. terralith-gen (INTENTIUS/choudoufu, TGSCALE_CHOUDOUFU_REF) writes the
#      terralith; carve.py carves it; each repo's main gets its roots and no
#      pipeline. floci starts empty.
#   2. reconcile: the control repo lists every repo, and `terragucci reconcile
#      --mode apply` opens the pipeline pull request in each one.
#   3. create: every pull request is merged; each repo's apply waves plan every
#      root and apply it, from nothing.
#   4. plan: a pull request in each repo changes modules/estate, which every
#      root calls, so the plan job plans every root and posts the plan note.
#   5. change: those pull requests are merged and the waves apply the change.
#   6. verify: the state files in the bucket hold every resource the terralith
#      declares.
# Each phase's wall time runs from its first push or merge to the end of its
# last run. Runner minutes add up every job's own time. The note size is the
# plan note's bytes; the report sizes are the objects the runs wrote to the
# reports bucket. The run's record goes to stack/scale/.state/runs/.
#
# The bench measures the newest published release (TGSCALE_RELEASE to pick
# one): reconcile runs from npm, and its pipeline pulls the release's images.
# TGSCALE_BUILD=tree measures this tree instead: reconcile runs the tree's
# bundle, and each pipeline pull request gets one more commit that points its
# jobs at tgscale-tofu:<commit>, the release's tofu image with the tree's
# bundle in it. Nothing here calls AWS.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/.state"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
FORGEJO_PORT="${TGSCALE_FORGEJO_PORT:-3410}"
FLOCI_PORT="${TGSCALE_FLOCI_PORT:-4690}"
ADMIN_USER="tgscale-admin"
ADMIN_PW="Tgscale-local-pw-1234"
CAPACITY="${TGSCALE_CAPACITY:-3}"
PER_REPO="${TGSCALE_ROOTS_PER_REPO:-100}"
# Roots each job plans and applies at once. Every one starts an AWS provider of
# about 800 MB, so the default 16, in three jobs at once, needs some 40 GB.
PARALLELISM="${TGSCALE_PARALLELISM:-4}"
CHOUDOUFU_REF="${TGSCALE_CHOUDOUFU_REF:-1c8ede26372fcb0b653084574d1b326f1c58d935}"
STATE_BUCKET=terralith-state
REPORT_BUCKET=terralith-reports
# A run that has not finished this long after its phase began has stalled.
PHASE_TIMEOUT="${TGSCALE_PHASE_TIMEOUT:-14400}"

log() { echo "[scale $(date -u +%H:%M:%S)] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

URL="http://localhost:${FORGEJO_PORT}"
FLOCI="http://localhost:${FLOCI_PORT}"

load_env() {
  [ -f "$STATE/scale.env" ] || die "no $STATE/scale.env; run 'stack/scale/scale.sh up' first"
  # shellcheck disable=SC1091
  . "$STATE/scale.env"
  TOKEN="$TGSCALE_TOKEN"
}
api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }
jpost() { api -H 'content-type: application/json' -X "$1" -d "$2" "$URL/api/v1/$3"; }

up() {
  log "starting the tgscale stack…"
  "${COMPOSE[@]}" up -d >&2
  local i
  for i in $(seq 1 90); do curl -fs -o /dev/null "$URL/api/v1/version" && break; sleep 2; done
  curl -fs -o /dev/null "$URL/api/v1/version" || die "Forgejo did not answer on $URL"
  if ! curl -fs -o /dev/null -u "$ADMIN_USER:$ADMIN_PW" "$URL/api/v1/user"; then
    "${COMPOSE[@]}" exec -T -u git forgejo forgejo admin user create --admin --username "$ADMIN_USER" \
      --password "$ADMIN_PW" --email "$ADMIN_USER@example.com" --must-change-password=false >&2
  fi
  curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PW" -X DELETE "$URL/api/v1/users/$ADMIN_USER/tokens/tgscale" || true
  TOKEN="$(curl -fsS -u "$ADMIN_USER:$ADMIN_PW" -H 'content-type: application/json' \
    -d '{"name":"tgscale","scopes":["all"]}' "$URL/api/v1/users/$ADMIN_USER/tokens" | jq -r .sha1)"
  [ -n "$TOKEN" ] && [ "$TOKEN" != null ] || die "could not mint a token"
  local id
  for id in $(api "$URL/api/v1/admin/actions/runners" | jq -r '.[] | select(.name == "tgscale-docker") | .id'); do
    api -o /dev/null -X DELETE "$URL/api/v1/admin/actions/runners/$id" || true
  done
  local reg uuid rtoken
  reg="$(jpost POST '{"name":"tgscale-docker","description":"terragucci scale bench"}' admin/actions/runners)"
  uuid="$(jq -r .uuid <<<"$reg")"; rtoken="$(jq -r .token <<<"$reg")"
  [ -n "$uuid" ] && [ "$uuid" != null ] || die "runner creation returned $reg"
  # As the validation stack's runner (stack/bootstrap.sh), on the tgscale
  # network with its own cache volume, and a job timeout long enough for a
  # wave of a few hundred roots.
  "${COMPOSE[@]}" exec -T forgejo-runner sh -c 'cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml' <<EOF
log:
  level: info
  job_level: info
runner:
  file: /data/.runner
  capacity: ${CAPACITY}
  timeout: 4h
  shutdown_timeout: 0s
  fetch_interval: 2s
  report_interval: 1s
  envs:
    TF_PLUGIN_CACHE_DIR: /cache
    AWS_ENDPOINT_URL: http://floci:4566
    AWS_ACCESS_KEY_ID: test
    AWS_SECRET_ACCESS_KEY: test
    AWS_REGION: us-east-1
  labels:
    - "docker:docker://node:22-bookworm"
    - "ubuntu-latest:docker://node:22-bookworm"
cache:
  enabled: false
container:
  network: tgscale
  privileged: false
  options: "-v tgscale-job-cache:/cache"
  valid_volumes:
    - tgscale-job-cache
  docker_host: "-"
  force_pull: false
server:
  connections:
    forgejo:
      url: http://forgejo:3000/
      uuid: ${uuid}
      token: ${rtoken}
EOF
  "${COMPOSE[@]}" restart forgejo-runner >&2
  for i in $(seq 1 60); do
    api "$URL/api/v1/admin/actions/runners" | jq -e 'map(select(.name == "tgscale-docker" and .status != "offline")) | length > 0' >/dev/null 2>&1 && break
    sleep 2
  done
  mkdir -p "$STATE"
  printf 'export TGSCALE_TOKEN=%s\n' "$TOKEN" > "$STATE/scale.env"
  log "ready: Forgejo $URL, floci $FLOCI, runner capacity $CAPACITY"
}

down() {
  "${COMPOSE[@]}" down -v --remove-orphans >&2
}

# terralith-gen, built from choudoufu at the pinned commit.
terralith_gen() {
  local bin="$STATE/terralith-gen-${CHOUDOUFU_REF:0:12}" src dir="${CHOUDOUFU_DIR:-$HOME/Documents/checkouts/intentius/choudoufu}"
  if [ ! -x "$bin" ]; then
    if [ ! -d "$dir/.git" ]; then
      dir="$STATE/choudoufu"
      [ -d "$dir/.git" ] || git clone -q --filter=blob:none https://github.com/INTENTIUS/choudoufu.git "$dir"
    fi
    git -C "$dir" cat-file -e "$CHOUDOUFU_REF^{commit}" 2>/dev/null || git -C "$dir" fetch -q origin
    src="$(mktemp -d "${TMPDIR:-/tmp}/tgscale-gen.XXXXXX")"
    git -C "$dir" archive "$CHOUDOUFU_REF" go.mod go.sum tools/terralith-gen | tar -x -C "$src"
    (cd "$src" && go build -o "$bin" ./tools/terralith-gen) >&2
  fi
  echo "$bin"
}

floci_fresh() {
  "${COMPOSE[@]}" up -d --force-recreate floci >&2
  local i
  for i in $(seq 1 60); do curl -fs -o /dev/null "$FLOCI/_floci/health" 2>/dev/null && break; curl -s -o /dev/null -m 2 "$FLOCI/" && break; sleep 1; done
  curl -fsS -o /dev/null -X PUT "$FLOCI/$STATE_BUCKET"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET"
}

fresh_repo() { # name
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$ADMIN_USER/$1" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$ADMIN_USER/$1")" = 404 ] && break; sleep 1; done
  jpost POST "{\"name\":\"$1\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" user/repos >/dev/null
  jpost PATCH '{"has_actions":true}' "repos/$ADMIN_USER/$1" >/dev/null
  # Forgejo answers for a new repo's pull requests a moment after it creates it.
  for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$ADMIN_USER/$1/pulls?state=open")" = 200 ] && break; sleep 1; done
}

remote() { echo "http://${ADMIN_USER}:${TOKEN}@localhost:${FORGEJO_PORT}/${ADMIN_USER}/$1.git"; }

push_dir() { # dir, repo, branch, message -> sha
  (
    cd "$1"
    [ -d .git ] || git init -q -b main
    git checkout -q -B "$3"
    git add -A
    git -c user.email=scale@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q --allow-empty -m "$4"
    git push -q --force "$(remote "$2")" "HEAD:refs/heads/$3" 2>/dev/null
    git rev-parse HEAD
  )
}

head_of() { git ls-remote "$(remote "$1")" "refs/heads/$2" | awk '{print $1}'; }

# Wait until every repo's runs for its sha have finished: for each event named
# (push, pull_request, or both, comma-separated) the newest run of that event.
# A run that has not finished by the deadline fails the phase. Prints one line
# per finished run: repo<TAB>run json.
wait_runs() { # events, deadline, then repo=sha pairs
  local events="$1" deadline="$2"; shift 2
  local pending=("$@") next pair repo sha runs done_ last=0 idle=0
  while [ "${#pending[@]}" -gt 0 ]; do
    next=()
    for pair in "${pending[@]}"; do
      repo="${pair%%=*}"; sha="${pair#*=}"
      runs="$(api "$URL/api/v1/repos/$ADMIN_USER/$repo/actions/runs?head_sha=$sha" \
        | jq -c --arg e "$events" '($e | split(",")) as $want | [$want[] as $w | ([.workflow_runs[] | select(.event == $w)] | sort_by(.id) | last)] | if any(. == null) then empty else . end')"
      done_="$(jq -r 'if . == null then "no" elif all(.[]; .status == "success" or .status == "failure" or .status == "cancelled" or .status == "skipped") then "yes" else "no" end' <<<"${runs:-null}")"
      if [ "$done_" = yes ]; then
        jq -c '.[]' <<<"$runs" | while read -r run; do printf '%s\t%s\n' "$repo" "$run"; done
      else
        next+=("$pair")
      fi
    done
    pending=("${next[@]+"${next[@]}"}")
    [ "${#pending[@]}" -eq 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "still running past the deadline: ${pending[*]%%=*}"
      return 1
    fi
    # Forgejo 16 can leave a job waiting after the run ahead of it in its
    # concurrency group ends, with the runner idle: the runner fetches it
    # only once it polls afresh. A minute of that restarts the runner, and the
    # record counts each restart.
    if api "$URL/api/v1/admin/actions/runners" | jq -e 'map(select(.name == "tgscale-docker" and .status == "idle")) | length > 0' >/dev/null 2>&1; then
      idle=$((idle + 1))
    else
      idle=0
    fi
    if [ "$idle" -ge 12 ]; then
      log "$events: the runner sat idle for a minute with runs waiting; restarting it"
      "${COMPOSE[@]}" restart forgejo-runner >/dev/null 2>&1
      echo restart >> "$NUDGES"
      idle=0
    fi
    if [ $(( $(date +%s) - last )) -ge 120 ]; then
      log "$events: waiting on ${#pending[@]} repo(s): $(printf '%s ' "${pending[@]%%=*}" | head -c 300)"
      last=$(date +%s)
    fi
    sleep 5
  done
}

# Every job of a run that ran, as JSON lines: name, status and its first and
# last log lines' times (the API leaves a job's own times empty).
run_jobs() { # repo, run id
  local id name status log
  api "$URL/api/v1/repos/$ADMIN_USER/$1/actions/runs/$2/jobs" \
    | jq -r '.[] | select(.status != "skipped") | "\(.id)\t\(.name)\t\(.status)"' \
    | while IFS=$'\t' read -r id name status; do
        log="$(api "$URL/api/v1/repos/$ADMIN_USER/$1/actions/jobs/$id/logs" 2>/dev/null || true)"
        jq -nc --arg n "$name" --arg s "$status" --arg a "$(head -1 <<<"$log" | cut -d' ' -f1)" --arg b "$(tail -1 <<<"$log" | cut -d' ' -f1)" \
          '{name: $n, status: $s, started_at: $a, completed_at: $b}'
      done
}

# The plan note on a pull request, as posted.
note_of() { # repo, pr
  api "$URL/api/v1/repos/$ADMIN_USER/$1/issues/$2/comments?limit=50" \
    | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))][0].body // empty'
}

# The objects of a bucket under a prefix: key<TAB>size.
objects() { # bucket
  local token="" out
  while :; do
    out="$(curl -fsS "$FLOCI/$1?list-type=2&max-keys=1000${token:+&continuation-token=$(jq -rn --arg t "$token" '$t|@uri')}")"
    python3 -c 'import sys,re
x=sys.stdin.read()
for c in re.findall(r"<Contents>(.*?)</Contents>", x, re.S):
    k=re.search(r"<Key>(.*?)</Key>", c).group(1); s=re.search(r"<Size>(\d+)</Size>", c).group(1)
    print(k+"\t"+s)' <<<"$out"
    token="$(sed -n 's#.*<NextContinuationToken>\(.*\)</NextContinuationToken>.*#\1#p' <<<"$out")"
    [ -n "$token" ] || break
  done
}

# How many resource instances the state files in the bucket hold.
state_instances() {
  local key total=0 n
  while IFS=$'\t' read -r key _; do
    case "$key" in *.tfstate) ;; *) continue ;; esac
    n="$(curl -fsS "$FLOCI/$STATE_BUCKET/$key" | jq '[.resources[] | select(.mode == "managed") | .instances | length] | add // 0')"
    total=$((total + n))
  done < <(objects "$STATE_BUCKET")
  echo "$total"
}

# TGSCALE_BUILD=tree: build the release's tofu image with this tree's bundle,
# and point each repo's pipeline pull request at it.
tree_image() { # work, image, repos
  local work="$1" image="$2" repos="$3" repo clone base ctx="$1/image"
  for repo in $repos; do
    clone="$work/pipeline-$repo"
    git clone -q --branch terragucci/pipeline "$(remote "$repo")" "$clone"
    if [ ! -d "$ctx" ]; then
      base="$(grep -o -m1 'image: ghcr\.io/intentius/terragucci-tofu:[^ ]*' "$clone"/.forgejo/workflows/terragucci.yml | cut -d' ' -f2)"
      mkdir -p "$ctx"
      cp "$ROOT/packages/terragucci/dist/terragucci.mjs" "$ctx/terragucci.mjs"
      printf 'FROM %s\nCOPY --chmod=0755 terragucci.mjs /usr/local/bin/terragucci\n' "$base" > "$ctx/Dockerfile"
      docker build -q -t "$image" "$ctx" >&2
    fi
    perl -pi -e "s#image: ghcr\.io/intentius/terragucci-tofu:\S+#image: $image#g" "$clone"/.forgejo/workflows/terragucci.yml
    git -C "$clone" -c user.email=scale@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -qam "Run this tree's build"
    git -C "$clone" push -q "$(remote "$repo")" terragucci/pipeline 2>/dev/null
  done
}

# Fail the run when a phase's run did not succeed: the next phase would only measure the wreck.
phase_ok() { # phase, runs file
  local bad
  bad="$(awk -F'\t' -v p="$1" '$1 == p' "$2" | grep -v '"status":"success"' | cut -f2 | sort -u | tr '\n' ' ' || true)"
  [ -z "$bad" ] || die "$1: the runs of ${bad}did not succeed; Forgejo has their logs at $URL"
}

run_scale() { # scale
  local scale="$1" gen work release tg started
  load_env
  local build_image=""
  if [ "${TGSCALE_BUILD:-}" = tree ]; then
    # The build is named for the newest commit of the package, which must hold all of it.
    git -C "$ROOT" diff --quiet HEAD -- packages/terragucci || die "packages/terragucci has uncommitted changes; commit them, since the build is named for its commit"
    (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null)
    release="$(jq -r .version "$ROOT/packages/terragucci/package.json")+$(git -C "$ROOT" log -1 --format=%h --abbrev=7 -- packages/terragucci)"
    tg=(node "$ROOT/packages/terragucci/dist/terragucci.mjs")
    build_image="tgscale-tofu:${release#*+}"
  else
    release="${TGSCALE_RELEASE:-$(npm view @intentius/terragucci version)}"
    tg=(npx -y "@intentius/terragucci@$release")
  fi
  gen="$(terralith_gen)"
  mkdir -p "$STATE/runs"
  work="$(mktemp -d "${TMPDIR:-/tmp}/tgscale-$scale.XXXXXX")"
  log "scale $scale: terragucci $release, work in $work"
  "$gen" -scale "$scale" -out "$work/terralith" -fmt-bin "$(command -v tofu || echo tofu)" >&2
  python3 "$HERE/carve.py" --terralith "$work/terralith" --out "$work/estate" --roots-per-repo "$PER_REPO" --bucket "$STATE_BUCKET"
  local manifest="$work/estate/estate.json" repos repo resources roots
  repos="$(jq -r '.repos[].name' "$manifest")"
  resources="$(jq -r .terralith.resources "$manifest")"
  roots="$(jq -r .roots "$manifest")"

  log "floci starts empty; the repos are created fresh"
  floci_fresh
  fresh_repo control
  for repo in $repos; do
    fresh_repo "$repo"
    # The apply waves read the reports bucket from the repo's own terragucci.yml.
    printf 'parallelism: %s\nreports:\n  bucket: s3://%s\n  prefix: %s\n' "$PARALLELISM" "$REPORT_BUCKET" "$repo" > "$work/estate/$repo/terragucci.yml"
    push_dir "$work/estate/$repo" "$repo" main "The $repo roots of a terralith at scale $scale" >/dev/null
  done
  mkdir -p "$work/control"
  {
    printf 'defaults:\n  forge: forgejo\n  binary: tofu\n  token_env: TERRAGUCCI_FORGEJO_TOKEN\n  reports:\n    bucket: s3://%s\nprojects:\n' "$REPORT_BUCKET"
    for repo in $repos; do
      printf '  localhost/%s/%s:\n    url: %s/%s/%s\n    reports:\n      bucket: s3://%s\n      prefix: %s\n' "$ADMIN_USER" "$repo" "$URL" "$ADMIN_USER" "$repo" "$REPORT_BUCKET" "$repo"
    done
  } > "$work/control/terragucci.yml"
  push_dir "$work/control" control main "The control repo" >/dev/null
  # Forgejo fills a pushed repo's branches from a queue; reconcile reads them through the API.
  local i
  for repo in $repos; do
    for i in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$ADMIN_USER/$repo/branches/main")" = 200 ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$ADMIN_USER/$repo/pulls?state=open")" = 200 ] && break
      sleep 1
    done
  done

  # ── reconcile ──
  local t0 out pairs=() prs=() pr sha phase_json="{}" runs_file="$work/runs.tsv"
  : > "$runs_file"
  NUDGES="$work/nudges"
  : > "$NUDGES"
  # The host's one-minute load average, once a minute, for the record: other work on the host slows the run.
  ( while :; do uptime | sed -E 's/.*load averages?: *//; s/,//g' | awk '{print $1}'; sleep 60; done ) > "$work/load" &
  SAMPLER=$!
  trap 'kill "${SAMPLER:-}" 2>/dev/null || true' EXIT
  t0=$(date +%s)
  out="$(cd "$work/control" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "${tg[@]}" reconcile --config terragucci.yml --mode apply 2>&1)" || { echo "$out" >&2; die "reconcile failed"; }
  echo "$out" | tail -3 >&2
  [ -z "$build_image" ] || tree_image "$work" "$build_image" "$repos"
  for repo in $repos; do
    sha="$(head_of "$repo" terragucci/pipeline)"
    [ -n "$sha" ] || die "reconcile opened no branch on $repo"
    pairs+=("$repo=$sha")
  done
  wait_runs push,pull_request $(( t0 + PHASE_TIMEOUT )) "${pairs[@]}" | sed 's/^/reconcile\t/' >> "$runs_file" || die "the pipeline pull requests did not finish"
  phase_ok reconcile "$runs_file"
  phase_json="$(jq -c --argjson s "$t0" --argjson e "$(date +%s)" '. + {reconcile: {start: $s, end: $e}}' <<<"$phase_json")"

  # ── create ──
  pairs=()
  t0=$(date +%s)
  for repo in $repos; do
    pr="$(api "$URL/api/v1/repos/$ADMIN_USER/$repo/pulls?state=open" | jq -r '.[] | select(.head.ref == "terragucci/pipeline") | .number' | head -1)"
    [ -n "$pr" ] || die "no pipeline pull request on $repo"
    jpost POST '{"Do":"merge"}' "repos/$ADMIN_USER/$repo/pulls/$pr/merge" >/dev/null
  done
  for repo in $repos; do pairs+=("$repo=$(head_of "$repo" main)"); done
  wait_runs push $(( t0 + PHASE_TIMEOUT )) "${pairs[@]}" | sed 's/^/create\t/' >> "$runs_file" || die "the create runs did not finish"
  phase_ok create "$runs_file"
  phase_json="$(jq -c --argjson s "$t0" --argjson e "$(date +%s)" '. + {create: {start: $s, end: $e}}' <<<"$phase_json")"
  local created; created="$(state_instances)"
  log "create: the state files hold $created of $resources resources"
  [ "$created" = "$resources" ] || die "create: the state files hold $created of the $resources resources the terralith declares"

  # ── plan ──
  pairs=()
  t0=$(date +%s)
  for repo in $repos; do
    local clone="$work/clone-$repo"
    git clone -q "$(remote "$repo")" "$clone"
    perl -pi -e 's/revision = "1"/revision = "2"/' "$clone/modules/estate/main.tf"
    git -C "$clone" checkout -q -b scale/revision-2
    git -C "$clone" -c user.email=scale@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -qam "Tag every resource with revision 2"
    git -C "$clone" push -q "$(remote "$repo")" scale/revision-2 2>/dev/null
    pr="$(jpost POST '{"head":"scale/revision-2","base":"main","title":"Tag every resource with revision 2"}' "repos/$ADMIN_USER/$repo/pulls" | jq -r .number)"
    prs+=("$repo=$pr")
    pairs+=("$repo=$(git -C "$clone" rev-parse HEAD)")
  done
  wait_runs push,pull_request $(( t0 + PHASE_TIMEOUT )) "${pairs[@]}" | sed 's/^/plan\t/' >> "$runs_file" || die "the plan runs did not finish"
  phase_ok plan "$runs_file"
  phase_json="$(jq -c --argjson s "$t0" --argjson e "$(date +%s)" '. + {plan: {start: $s, end: $e}}' <<<"$phase_json")"
  local notes="$work/notes.tsv" note
  : > "$notes"
  for pair in "${prs[@]}"; do
    repo="${pair%%=*}"; pr="${pair#*=}"
    note="$(note_of "$repo" "$pr")"
    printf '%s\t%s\t%s\t%s\n' "$repo" "$(printf '%s' "$note" | wc -c | tr -d ' ')" "$(printf '%s' "$note" | sed -n 's/^<!-- terragucci:plan roots=\(.*\) -->$/\1/p' | tr ',' '\n' | grep -c . || true)" "$(printf '%s' "$note" | grep -c '^\*\*Cut:\*\*' || true)" >> "$notes"
  done

  # ── change ──
  pairs=()
  t0=$(date +%s)
  for pair in "${prs[@]}"; do
    jpost POST '{"Do":"merge"}' "repos/$ADMIN_USER/${pair%%=*}/pulls/${pair#*=}/merge" >/dev/null
  done
  for repo in $repos; do pairs+=("$repo=$(head_of "$repo" main)"); done
  wait_runs push $(( t0 + PHASE_TIMEOUT )) "${pairs[@]}" | sed 's/^/change\t/' >> "$runs_file" || die "the change runs did not finish"
  phase_ok change "$runs_file"
  phase_json="$(jq -c --argjson s "$t0" --argjson e "$(date +%s)" '. + {change: {start: $s, end: $e}}' <<<"$phase_json")"

  # ── verify and record ──
  kill "$SAMPLER" 2>/dev/null || true
  local held; held="$(state_instances)"
  log "verify: the state files hold $held of $resources resources"
  local jobs="$work/jobs.jsonl" ph id
  : > "$jobs"
  while IFS=$'\t' read -r ph repo run; do
    id="$(jq -r .id <<<"$run")"
    run_jobs "$repo" "$id" | jq -c --arg p "$ph" --arg r "$repo" --argjson run "$run" '. + {phase: $p, repo: $r, run_status: $run.status}' >> "$jobs"
  done < "$runs_file"
  objects "$REPORT_BUCKET" > "$work/reports.tsv"
  local out_file="$STATE/runs/scale-$resources.json"
  python3 "$HERE/summarize.py" --manifest "$manifest" --runs "$runs_file" --jobs "$jobs" --notes "$notes" --reports "$work/reports.tsv" \
    --phases "$phase_json" --created "$created" --held "$held" --release "$release" --choudoufu "$CHOUDOUFU_REF" \
    --capacity "$CAPACITY" --per-repo "$PER_REPO" --parallelism "$PARALLELISM" --restarts "$(wc -l < "$NUDGES" | tr -d ' ')" --load "$work/load" > "$out_file"
  log "scale $scale: record in $out_file"
  jq -c '{resources: .estate.resources, roots: .estate.roots, repos: .estate.repos, passed, wall_seconds, runner_minutes, note_bytes_max: .note.bytes_max, report_bytes_max: .reports.report_json_bytes_max}' "$out_file" >&2
  jq -e .passed "$out_file" >/dev/null || return 1
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  run)
    shift
    [ $# -gt 0 ] || die "usage: scale.sh run <scale>..."
    for s in "$@"; do run_scale "$s"; done
    ;;
  record)
    python3 "$HERE/summarize.py" --merge "$STATE/runs" --out "${2:-$ROOT/docs-site/src/data/scale.json}"
    ;;
  *) die "usage: scale.sh up | run <scale>... | record [file] | down" ;;
esac
