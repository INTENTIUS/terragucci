#!/usr/bin/env bash
#
# One smoke claim per feature the site claims, run against the example.
#
#   stack/smoke.sh               every claim
#   stack/smoke.sh <claim>       one claim
#   BREAK=1 stack/smoke.sh boot  break the property; the claim must print "caught"
#   stack/smoke.sh --record FILE every claim, plain and under BREAK=1, as JSON
#
# Each claim prints one line:
#
#   SMOKE claim=<name> verdict=pass|caught|fail|pending [detail]
#
# pending means the stage the claim needs is not built yet; the line names the
# issue that builds it. Exit codes: 0 when every claim passed, was caught or is
# pending; 1 when any claim failed; 2 for an unknown claim.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"

# name|what the site says|issue that builds it (empty: implemented here)
CLAIMS='boot|the example boots and deploys locally|
check|tf-check fails an unformatted root and names the file|
affected|only the roots a change touches are planned|chant#3183
grouped|one note groups many plans|chant#3188
report|the report is JSON and HTML, and links every root to its full plan|
highlight|destroys and outliers are open, identical groups are folded|
waves|each wave goes out only once approved|chant#3049
refuse|a wave whose plans changed after approval applies nothing|chant#3049
drift|drift is reported by root|terragucci#13
rollout|a module version rolls out one pull request per wave|
publish|changed modules are published at a new version|
tips|tips are on by default and name their rule|terragucci#10
zero-config|with no terragucci.yml, init writes the same pipeline|
apply-serial|two pushes to main apply one after the other, and the commit carries one terragucci/apply status|
reconcile|a control repo opens one pull request per project that changes, and the merged pipeline applies|'

say() { echo "SMOKE claim=$1 verdict=$2${3:+ $3}"; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so no claim can run."; exit 0; }

# ── the implemented claims ────────────────────────────────────────────────
# Each returns 0 when the property held and 1 when it did not, and prints its
# evidence on stderr.

claim_boot() {
  local skip=""
  [ -n "${BREAK:-}" ] && skip="envs/prod/email"
  TG_SKIP_ROOT="$skip" "$HERE/example.sh" up --fresh >&2 || return 1
  "$HERE/example.sh" verify >&2
}

claim_check() {
  # A clean branch must go green, and the same branch plus an unformatted file
  # must go red with the file named in the log.
  log() { echo "[smoke check] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local repo="$USER/example" work sha logs
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/tree" 2>/dev/null \
    || { log "no example repo; run 'just example up' first"; rm -rf "$work"; return 1; }
  local unformatted='locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}'
  [ -n "${BREAK:-}" ] && echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: clean $(date +%s)")"
  wait_run "$repo" "$sha"
  if [ "$RUN_STATUS" != success ]; then log "the clean push ended '$RUN_STATUS'"; rm -rf "$work"; return 1; fi
  echo "$unformatted" > "$work/tree/envs/dev/orders/unformatted.tf"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "smoke check: unformatted $(date +%s)")"
  wait_run "$repo" "$sha"
  logs="$(print_logs "$repo" "$RUN_ID")"
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo/branches/smoke%2Fcheck" || true
  rm -rf "$work"
  [ "$RUN_STATUS" = failure ] || { log "the unformatted push ended '$RUN_STATUS'"; return 1; }
  grep -q "unformatted.tf" <<<"$logs" || { log "the run failed but its log does not name unformatted.tf"; return 1; }
  log "the unformatted push failed at the format check and named envs/dev/orders/unformatted.tf"
}

TERRAGUCCI="$HERE/../node_modules/.bin/terragucci"

claim_zero_config() {
  # The example with its terragucci.yml removed: init must write exactly the
  # pipeline the example commits, found from the repo alone.
  local work rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  cp -R "$EXAMPLE/." "$work/"
  rm -f "$work/terragucci.yml"
  # BREAK: a config that leaves out prod, so init finds fewer roots.
  [ -n "${BREAK:-}" ] && printf 'roots: ["envs/dev/*", "envs/staging/*"]\n' > "$work/terragucci.yml"
  (cd "$work" && "$TERRAGUCCI" init) >&2 || rc=1
  if [ $rc = 0 ] && ! diff -u "$EXAMPLE/.forgejo/workflows/terragucci.yml" "$work/.forgejo/workflows/terragucci.yml" >&2; then
    echo "[smoke zero-config] init wrote a different pipeline" >&2
    rc=1
  fi
  rm -rf "$work"
  return $rc
}

claim_apply_serial() {
  # A scratch repo whose one root writes a mark to floci when its apply starts
  # and another when it ends, with a long pause between. The first push is
  # let run until its apply has started, then a second push lands. The marks
  # must read start end start end: the second apply waited for the first.
  # BREAK: the lock is cut out of the committed pipeline, so the applies overlap.
  log() { echo "[smoke apply-serial] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/serial" sha1 sha2 i marks bucket=shop-terraform-state mark
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local n; for n in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d '{"name":"serial","private":false,"auto_init":false,"default_branch":"main"}' "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket"
  # Clear marks from an earlier run.
  for mark in $(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" | grep -o '<Key>[^<]*</Key>' | sed 's#</\?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/$bucket/$mark" || true
  done
  mkdir -p "$work/app"
  cat > "$work/app/main.tf" <<'TF'
terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "serial/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "slow" {
  triggers_replace = file("${path.module}/rev.txt")
  provisioner "local-exec" {
    command = <<-SH
      mark() { node -e "fetch(process.env.AWS_ENDPOINT_URL + '/shop-terraform-state/serial-marks/' + Date.now() + '-$1', { method: 'PUT', body: 'x' })"; }
      mark start
      sleep 20
      mark end
    SH
  }
}
TF
  echo 1 > "$work/app/rev.txt"
  (cd "$work" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null && rm -f terragucci.yml)
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak 's#^\( *\)until git push -q origin .*; do#\1until true; do#' "$work/.forgejo/workflows/terragucci.yml"
    rm -f "$work/.forgejo/workflows/terragucci.yml.bak"
  fi
  sha1="$(push_tree "$work" "$repo" main "serial: first")"
  for i in $(seq 1 120); do
    curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" | grep -q -- '-start</Key>' && break
    sleep 2
  done
  echo 2 > "$work/app/rev.txt"
  sha2="$(push_tree "$work" "$repo" main "serial: second")"
  wait_run "$repo" "$sha1"
  wait_run "$repo" "$sha2"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the second run ended $RUN_STATUS"; rm -rf "$work"; return 1; }
  marks="$(curl -fsS "$FLOCI/$bucket?list-type=2&prefix=serial-marks/" | grep -o '<Key>[^<]*</Key>' | sed 's#</\?Key>##g; s#.*/[0-9]*-##' | tr '\n' ' ')"
  log "marks in key order: $marks"
  rm -rf "$work"
  # Keys sort by millisecond timestamp, so the listing is the order they happened in.
  [ "$marks" = "start end start end " ] || { log "the applies overlapped or one did not run"; return 1; }
  local statuses
  statuses="$(api "$URL/api/v1/repos/$repo/commits/$sha2/statuses" | jq -r '[.[] | select(.context == "terragucci/apply")] | map(.status + ":" + .description) | join(",")')"
  log "terragucci/apply on the second commit: $statuses"
  [ "$statuses" = "success:1 roots in 1 groups applied" ] || { log "expected one success status for the stage"; return 1; }
}

claim_reconcile() {
  # A control repo names two projects with the same two roots: in-line already
  # has the pipeline init writes, two-roots has none. Apply must leave in-line
  # alone and open one pull request on two-roots; its check must pass; merged,
  # its pipeline must apply both roots, network before app, since app's bucket
  # name comes from network's state.
  log() { echo "[smoke reconcile] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/two-roots" mode=apply out pr sha
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  local name
  # Forgejo settles a deleted or new repo a moment after answering; wait for it,
  # or the next call can meet the old repo or a 404.
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  for name in two-roots in-line; do
    api -o /dev/null -X DELETE "$URL/api/v1/repos/$USER/$name" 2>/dev/null || true
    settle "repos/$USER/$name" 404 || return 1
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
    settle "repos/$USER/$name" 200 || return 1
    api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$name"
  done
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for b in tg-reconcile-network tg-reconcile-network-app; do curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true; done
  mkdir -p "$work/two-roots/network" "$work/two-roots/app"
  local head='terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "KEY"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region            = "us-east-1"
  s3_use_path_style = true
}
'
  { echo "${head/KEY/reconcile/network.tfstate}"
    printf 'resource "aws_s3_bucket" "this" {\n  bucket = "tg-reconcile-network"\n}\n\noutput "bucket" {\n  value = aws_s3_bucket.this.bucket\n}\n'
  } > "$work/two-roots/network/main.tf"
  { echo "${head/KEY/reconcile/app.tfstate}"
    printf 'data "terraform_remote_state" "network" {\n  backend = "s3"\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "reconcile/network.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "aws_s3_bucket" "this" {\n  bucket = "${data.terraform_remote_state.network.outputs.bucket}-app"\n}\n'
  } > "$work/two-roots/app/main.tf"
  # in-line: the same two roots under their own names and state keys, with the
  # pipeline init writes already committed. Its push runs that pipeline; the
  # claim never waits on it, and nothing it applies touches two-roots.
  cp -R "$work/two-roots" "$work/in-line"
  sed -i.bak 's#reconcile/#inline/#; s#tg-reconcile-#tg-inline-#' "$work/in-line/network/main.tf" "$work/in-line/app/main.tf"
  rm -f "$work/in-line/network/main.tf.bak" "$work/in-line/app/main.tf.bak"
  (cd "$work/in-line" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null && rm -f terragucci.yml)
  push_tree "$work/in-line" "$USER/in-line" main "Two roots, pipeline in line" >/dev/null
  push_tree "$work/two-roots" "$repo" main "Two roots, no pipeline" >/dev/null
  settle "repos/$USER/in-line/branches/main" 200 || return 1
  settle "repos/$repo/branches/main" 200 || return 1
  settle "repos/$repo/pulls?state=open" 200 || return 1

  cat > "$work/terragucci.yml" <<YML
defaults:
  forge: forgejo
  binary: tofu
  token_env: TERRAGUCCI_FORGEJO_TOKEN
projects:
  localhost/$USER/in-line:
    url: $URL/$USER/in-line
  localhost/$repo:
    url: $URL/$repo
YML
  [ -n "${BREAK:-}" ] && mode=dry-run   # BREAK: a dry run opens nothing
  out="$(TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" reconcile --config "$work/terragucci.yml" --mode "$mode" 2>&1)" || { echo "$out" >&2; rm -rf "$work"; return 1; }
  echo "$out" >&2
  rm -rf "$work"
  grep -q "localhost/$USER/in-line: unchanged" <<<"$out" || { log "in-line was not left alone"; return 1; }
  pr="$(api "$URL/api/v1/repos/$repo/pulls?state=open" | jq -r '.[] | select(.head.ref == "terragucci/pipeline") | .number' | head -1)"
  [ -n "$pr" ] || { log "no pull request on $repo"; return 1; }
  sha="$(api "$URL/api/v1/repos/$repo/branches/terragucci%2Fpipeline" | jq -r .commit.id)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the pull request's check ended $RUN_STATUS"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
  sha="$(api "$URL/api/v1/repos/$repo/branches/main" | jq -r .commit.id)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the merged pipeline ended $RUN_STATUS"; return 1; }
  for b in tg-reconcile-network tg-reconcile-network-app; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -I "$FLOCI/$b")" = 200 ] || { log "$b is not in floci"; return 1; }
  done
  log "one pull request on $repo, check green, merged, both roots applied in order; in-line unchanged"
}

# ── the plan report ───────────────────────────────────────────────────────
# `terragucci stage tf-plan` runs in the tofu CI image on the stack's network,
# against the example's state in floci, with the bundle built from this tree.
# Its report goes to a floci bucket, which stands in for any S3-compatible
# store. Needs the example booted (`just example up`, or the boot claim).

REPORT_BUCKET=terragucci-reports

# work dir, then the patches to apply; leaves the run's report in $1/terragucci-report
report_run() {
  local work="$1"; shift
  local image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" p
  image="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "no CI image $image; run 'just example up' first" >&2; return 1; }
  (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null) || return 1
  cp -R "$EXAMPLE/." "$work/"
  rm -rf "$work/.git"
  git -C "$work" init -q -b main
  for p in "$@"; do git -C "$work" apply "$EXAMPLE/changes/$p.patch" || return 1; done
  [ -n "${REPORT_CONFIG:-}" ] && printf '%s\n' "$REPORT_CONFIG" >> "$work/terragucci.yml"
  git -C "$work" remote add origin "http://forgejo:3000/$USER/example.git"
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost commit -qm "smoke report $(date +%s%N)"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  docker run --rm --network terragucci -v "$work:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-plan >&2
}

claim_report() {
  # Two runs on two commits, each copying its report to the bucket. Each run
  # writes report.json and report.html, every planned root links to its full
  # plan text and JSON and those files exist, the HTML carries the JSON
  # inline, and the index lists both runs, the first one still there.
  log() { echo "[smoke report] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir root f n i index path commits=() prefix cfg=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  prefix="smoke-$(date +%s)"   # a fresh index for each claim run
  # BREAK: no bucket named, so nothing reaches the index.
  [ -z "${BREAK:-}" ] && cfg="$(printf 'reports:\n  bucket: s3://%s\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix")"
  for i in 1 2; do
    mkdir -p "$work/run$i"
    # tf-plan exits 1 when a root refuses to plan; the report is written either way.
    REPORT_CONFIG="$cfg" report_run "$work/run$i" module-bump destroy || true
    dir="$work/run$i/terragucci-report"
    [ -f "$dir/report.json" ] && [ -f "$dir/report.html" ] || { log "run $i wrote no report"; rc=1; break; }
    commits+=("$(git -C "$work/run$i" rev-parse HEAD)")
    n="$(jq '[.roots[] | select(.status == "planned")] | length' "$dir/report.json")"
    [ "$n" -ge 15 ] || { log "run $i planned only $n roots"; rc=1; }
    for root in $(jq -r '.roots[] | select(.status == "planned") | .path' "$dir/report.json"); do
      for f in $(jq -r --arg r "$root" '.roots[] | select(.path == $r) | .plan.text, .plan.json' "$dir/report.json"); do
        [ -s "$dir/$f" ] || { log "$root: $f is missing"; rc=1; }
        grep -q "href=\"$f\"" "$dir/report.html" || { log "$root: the HTML does not link $f"; rc=1; }
      done
      grep -q "id=\"root-$root\"" "$dir/report.html" || { log "$root has no anchor in the HTML"; rc=1; }
    done
    if ! diff <(sed -n '/id="terragucci-report"/,/<\/script>/p' "$dir/report.html" | sed '1d;$d' | jq -S .) <(jq -S . "$dir/report.json") >/dev/null; then
      log "the JSON inlined in report.html is not report.json"; rc=1
    fi
  done
  if [ $rc = 0 ]; then
    if ! index="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json")"; then
      log "no index at $REPORT_BUCKET/$prefix/index.json"; rc=1
    else
      for c in "${commits[@]}"; do
        path="$(jq -r --arg c "$c" '.reports[] | select(.commit == $c) | .path' <<<"$index" | head -1)"
        if [ -z "$path" ]; then log "the index does not list commit $c"; rc=1; continue; fi
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$REPORT_BUCKET/$prefix/$path/report.html")" = 200 ] || { log "$path/report.html is not in the bucket"; rc=1; }
        f="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$path/report.json" | jq -r '.roots[0].plan.text')"
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/$REPORT_BUCKET/$prefix/$path/$f")" = 200 ] || { log "$path/$f is not in the bucket"; rc=1; }
      done
    fi
  fi
  rm -rf "$work"
  [ $rc = 0 ] || return 1
  log "two runs, each root linked to its plan, both in $REPORT_BUCKET/$prefix/index.json"
}

claim_highlight() {
  # One run with a module bump (identical change in every root), a destroy and
  # a replacement. The destroy and the replacement are named and their roots
  # open; the bump's big group is folded.
  log() { echo "[smoke highlight] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 dir patches=(module-bump replace destroy) del rep big
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  [ -n "${BREAK:-}" ] && patches=(module-bump replace)   # BREAK: no destroy to name
  report_run "$work" "${patches[@]}" || true
  dir="$work/terragucci-report"
  [ -f "$dir/report.json" ] || { log "no report"; rm -rf "$work"; return 1; }
  del="$(jq -r '.named[] | select(.action == "delete" and .root == "envs/staging/email") | .address' "$dir/report.json" | head -1)"
  rep="$(jq -r '.named[] | select(.action == "replace" and .root == "envs/prod/search") | .address' "$dir/report.json" | head -1)"
  [ -n "$del" ] || { log "the destroy in envs/staging/email is not named"; rc=1; }
  [ -n "$rep" ] || { log "the replacement in envs/prod/search is not named"; rc=1; }
  jq -e '.named[] | select(.action == "replace" and .root == "envs/prod/search") | .replace_paths | length > 0' "$dir/report.json" >/dev/null \
    || { log "the replacement does not say which attribute forced it"; rc=1; }
  for root in envs/staging/email envs/prod/search; do
    grep -qE "<details class=\"root\" id=\"root-$root\"[^>]* open>" "$dir/report.html" || { log "$root is not open in the HTML"; rc=1; }
  done
  big="$(jq -r '[.groups[] | select(.units | length >= 5)] | sort_by(-(.units | length)) | .[0].id // empty' "$dir/report.json")"
  if [ -z "$big" ]; then log "no group of five or more identical roots"; rc=1
  else
    jq -e --arg g "$big" '.groups[] | select(.id == $g) | .fold == "folded"' "$dir/report.json" >/dev/null || { log "group $big is not folded"; rc=1; }
    grep -qE "<details class=\"group\" id=\"group-$big\"[^>]* open>" "$dir/report.html" && { log "group $big is open in the HTML"; rc=1; }
  fi
  rm -rf "$work"
  [ $rc = 0 ] || return 1
  log "named $del (delete) and $rep (replace), both roots open; group $big folded"
}

claim_publish() {
  # A module changed on the default branch is published to a TLS registry and
  # as a git tag; an unchanged module is not published again, and re-running on
  # the same commit publishes nothing. BREAK: lose the git tags between runs,
  # so the second run has no record of the release and publishes again.
  log() { echo "[smoke publish] $*" >&2; }
  local work port="${TERRAGUCCI_REGISTRY_PORT:-5050}" repo out tags
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  repo="acme/modules-$(date +%s)"
  mkdir -p "$work/certs" "$work/tree/modules/service" "$work/tree/modules/queue"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:registry,IP:127.0.0.1" \
    -keyout "$work/certs/registry.key" -out "$work/certs/registry.crt" >/dev/null 2>&1 \
    || { log "openssl could not make a certificate"; rm -rf "$work"; return 1; }
  chmod 644 "$work/certs/registry.key"
  TERRAGUCCI_REGISTRY_CERTS="$work/certs" docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
    --profile registry up -d --force-recreate registry >&2 || { rm -rf "$work"; return 1; }
  local i
  for i in $(seq 1 30); do
    curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/" >/dev/null 2>&1 \
    || { log "the registry did not come up"; rm -rf "$work"; return 1; }
  printf 'resource "terraform_data" "service" {}\n' > "$work/tree/modules/service/main.tf"
  printf 'resource "terraform_data" "queue" {}\n' > "$work/tree/modules/queue/main.tf"
  printf 'modules:\n  path: modules/*\n  publish:\n    - oci://localhost:%s/%s\n    - git-tags\n' "$port" "$repo" > "$work/tree/terragucci.yml"
  git init -q -b main "$work/remote.git" --bare
  (cd "$work/tree" && git init -q -b main && git remote add origin "$work/remote.git" \
    && git add -A && git -c user.name=t -c user.email=t@t commit -q -m "feat: modules") || { rm -rf "$work"; return 1; }
  export NODE_EXTRA_CA_CERTS="$work/certs/registry.crt"
  tags() { curl -fsS --cacert "$work/certs/registry.crt" "https://localhost:$port/v2/$repo/$1/tags/list" | jq -r '.tags // [] | sort | join(",")'; }
  (cd "$work/tree" && "$TERRAGUCCI" publish) >&2 || { rm -rf "$work"; return 1; }
  [ "$(tags service)" = "0.1.0" ] && [ "$(tags queue)" = "0.1.0" ] || { log "first run: service has '$(tags service)', queue '$(tags queue)'"; rm -rf "$work"; return 1; }
  [ "$(git -C "$work/remote.git" tag --list | sort | paste -sd, -)" = "modules/queue/v0.1.0,modules/service/v0.1.0" ] \
    || { log "first run: the remote has tags '$(git -C "$work/remote.git" tag --list | paste -sd, -)'"; rm -rf "$work"; return 1; }
  [ -n "${BREAK:-}" ] && git -C "$work/tree" tag --list | xargs git -C "$work/tree" tag -d >/dev/null
  out="$(cd "$work/tree" && "$TERRAGUCCI" publish 2>&1)" || { echo "$out" >&2; rm -rf "$work"; return 1; }
  echo "$out" >&2
  grep -q ": published" <<<"$out" && { log "a second run on the same commit published again"; rm -rf "$work"; return 1; }
  printf 'output "id" { value = terraform_data.service.id }\n' > "$work/tree/modules/service/outputs.tf"
  (cd "$work/tree" && git add -A && git -c user.name=t -c user.email=t@t commit -q -m "feat(service): an id output") || { rm -rf "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" publish) >&2 || { rm -rf "$work"; return 1; }
  [ "$(tags service)" = "0.1.0,0.2.0" ] && [ "$(tags queue)" = "0.1.0" ] || { log "after a change: service has '$(tags service)', queue '$(tags queue)'"; rm -rf "$work"; return 1; }
  log "both modules published to the registry and as tags, a rerun published nothing, and a change to service alone moved it to 0.2.0"
  rm -rf "$work"
}

claim_rollout() {
  # One repo, three roots taking modules/network by git tag: dev/app (the
  # canary), prod/net, and prod/app, which reads prod/net's state. The module
  # changes and tf-publish tags 0.2.0. A dry run with no version must find
  # 0.2.0; then each run opens at most one wave's pull request, changing only
  # that wave's root, and never opens a wave before the last one merged and its
  # apply passed on the merge commit. BREAK: the opening runs are dry runs, so
  # no pull request opens.
  log() { echo "[smoke rollout] $*" >&2; }
  fail() { log "FAIL: $*"; return 1; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/rollout" mode=apply out rc pr sha n files
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"
  answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
  settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
  settle "repos/$repo" 404 || return 1
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d '{"name":"rollout","private":false,"auto_init":false,"default_branch":"main"}' "$URL/api/v1/user/repos"
  settle "repos/$repo" 200 || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"

  local tree="$work/tree" remote="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git"
  local source="git::http://forgejo:3000/$repo.git//modules/network?ref=modules/network/v0.1.0"
  mkdir -p "$tree/modules/network" "$tree/dev/app" "$tree/prod/net" "$tree/prod/app"
  printf 'variable "name" {}\n\noutput "name" {\n  value = var.name\n}\n' > "$tree/modules/network/main.tf"
  root() { # dir, state key, extra
    printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "rollout/%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\n%bmodule "network" {\n  source = "%s"\n  name   = "%s"\n}\n\noutput "name" {\n  value = module.network.name\n}\n' "$2" "$3" "$source" "$2" > "$tree/$1/main.tf"
  }
  root dev/app dev-app ""
  root prod/net prod-net ""
  root prod/app prod-app 'data "terraform_remote_state" "net" {\n  backend = "s3"\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "rollout/prod-net.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\n'
  printf 'binary: tofu\nforge: forgejo\nurl: %s/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\nwaves:\n  canary: ["dev/*"]\nmodules:\n  path: modules/*\n  publish: git-tags\n' "$URL" "$repo" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init --forge forgejo --binary tofu >/dev/null) || { rm -rf "$work"; return 1; }
  ( cd "$tree" && git init -q -b main && git remote add origin "$remote" && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat: three roots on modules/network 0.1.0" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m "modules/network 0.1.0" \
    && git push -q origin refs/tags/modules/network/v0.1.0 main ) 2>/dev/null || { log "could not push the repo"; rm -rf "$work"; return 1; }
  sha="$(git -C "$tree" rev-parse HEAD)"
  wait_run "$repo" "$sha"
  [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "the first apply ended $RUN_STATUS"; rm -rf "$work"; return 1; }

  # A new module version, published by tf-publish as a git tag.
  printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> "$tree/modules/network/main.tf"
  ( cd "$tree" && git add -A && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat(network): a version output" \
    && git push -q origin main ) 2>/dev/null || { rm -rf "$work"; return 1; }
  wait_run "$repo" "$(git -C "$tree" rev-parse HEAD)"
  (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" publish) >&2 || { rm -rf "$work"; return 1; }

  ro() { (cd "$tree" && TERRAGUCCI_FORGEJO_TOKEN="$TOKEN" "$TERRAGUCCI" rollout modules/network "$@" 2>&1); }
  out="$(ro)" || { echo "$out" >&2; rm -rf "$work"; return 1; }
  echo "$out" >&2
  grep -q "modules/network 0.1.0 -> 0.2.0 (newest published: tag modules/network/v0.2.0): would-open" <<<"$out" \
    || { log "the dry run did not find 0.2.0 on its own"; rm -rf "$work"; return 1; }
  [ -n "${BREAK:-}" ] && mode=dry-run

  pr_for() { api "$URL/api/v1/repos/$repo/pulls?state=all&limit=50" | jq -r --arg b "terragucci/rollout/modules-network-0.2.0/wave-$1" '.[] | select(.head.ref == $b) | .number' | head -1; }
  local wave expect=("" "dev/app/main.tf" "prod/net/main.tf" "prod/app/main.tf")
  for wave in 1 2 3; do
    out="$(ro --mode "$mode")"; rc=$?
    echo "$out" >&2
    pr="$(pr_for "$wave")"
    [ -n "$pr" ] || { log "wave $wave: no pull request opened"; rm -rf "$work"; return 1; }
    files="$(api "$URL/api/v1/repos/$repo/pulls/$pr/files" | jq -r '[.[].filename] | join(",")')"
    [ "$files" = "${expect[$wave]}" ] || { log "wave $wave's pull request changes '$files', not ${expect[$wave]}"; rm -rf "$work"; return 1; }
    # Open: the next run waits and opens nothing.
    out="$(ro --mode "$mode")"; rc=$?
    [ $rc = 3 ] && [ -z "$(pr_for $((wave + 1)))" ] || { echo "$out" >&2; log "wave $wave open: exit $rc, or the next wave opened"; rm -rf "$work"; return 1; }
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$repo/pulls/$pr/merge"
    sha="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r .merge_commit_sha)"
    # Merged, apply not yet reported: still nothing opens.
    out="$(ro --mode "$mode")"; rc=$?
    if [ -n "$(pr_for $((wave + 1)))" ]; then
      n="$(api "$URL/api/v1/repos/$repo/commits/$sha/statuses" | jq -r '[.[] | select(.context | test("/ apply"))] | max_by(.id) | .status // "none"')"
      [ "$n" = success ] || { echo "$out" >&2; log "wave $((wave + 1)) opened while wave $wave's apply was '$n'"; rm -rf "$work"; return 1; }
    fi
    wait_run "$repo" "$sha"
    [ "$RUN_STATUS" = success ] || { print_logs "$repo" "$RUN_ID" >&2; log "wave $wave's apply ended $RUN_STATUS"; rm -rf "$work"; return 1; }
  done
  out="$(ro --mode "$mode")"; rc=$?
  echo "$out" >&2
  rm -rf "$work"
  [ $rc = 0 ] && grep -q ": complete" <<<"$out" || { log "after three waves the rollout is not complete (exit $rc)"; return 1; }
  log "0.2.0 found from its tag; three waves, one pull request each moving only its root, each opened only after the last applied"
}

run_claim() { # name -> prints the SMOKE line, returns 1 on fail
  local name="$1" row issue started secs
  row="$(grep "^$name|" <<<"$CLAIMS")" || { echo "unknown claim '$name'" >&2; return 2; }
  issue="${row##*|}"
  if [ -n "$issue" ]; then
    say "$name" pending "needs=$issue"
    return 0
  fi
  started=$(date +%s)
  if "claim_${name//-/_}"; then held=1; else held=0; fi
  secs=$(( $(date +%s) - started ))
  if [ -z "${BREAK:-}" ]; then
    if [ $held = 1 ]; then say "$name" pass "seconds=$secs"; else say "$name" fail "seconds=$secs"; return 1; fi
  else
    if [ $held = 0 ]; then say "$name" caught "seconds=$secs"; else say "$name" fail "seconds=$secs break=not-caught"; return 1; fi
  fi
}

names() { cut -d'|' -f1 <<<"$CLAIMS"; }

if [ "${1:-}" = --record ]; then
  out="${2:?usage: smoke.sh --record FILE}"
  rows=()
  for name in $(names); do
    plain="$(BREAK= run_claim "$name" | tail -1)" || true
    echo "$plain" >&2
    broken=""
    if ! grep -q 'verdict=pending' <<<"$plain"; then
      broken="$(BREAK=1 run_claim "$name" | tail -1)" || true
      echo "$broken" >&2
    fi
    row="$(grep "^$name|" <<<"$CLAIMS")"
    says="$(cut -d'|' -f2 <<<"$row")"; issue="$(cut -d'|' -f3 <<<"$row")"
    rows+=("$(jq -n --arg c "$name" --arg s "$says" --arg i "$issue" --arg p "$plain" --arg b "$broken" '{
      claim: $c, says: $s, needs: (if $i == "" then null else $i end),
      verdict: ($p | capture("verdict=(?<v>[a-z]+)").v),
      break: (if $b == "" then null else ($b | capture("verdict=(?<v>[a-z]+)").v) end)
    }')")
  done
  # Leave the example booted and clean for whoever runs next.
  "$HERE/example.sh" up --fresh >&2
  new="$(printf '%s\n' "${rows[@]}" | jq -s .)"
  # Same verdicts as the last record: keep it, date and all, so nothing diffs.
  if [ -f "$out" ] && [ "$(jq -S .claims "$out")" = "$(jq -S . <<<"$new")" ]; then
    echo "unchanged $out" >&2
    exit 0
  fi
  jq --arg at "$(date -u +%Y-%m-%d)" --arg commit "$(git -C "$HERE/.." rev-parse --short HEAD)" \
    '{recorded: $at, commit: $commit, forge: "forgejo", claims: .}' <<<"$new" > "$out"
  echo "wrote $out" >&2
  exit 0
fi

rc=0
if [ -n "${1:-}" ]; then
  run_claim "$1" || rc=$?
else
  for name in $(names); do run_claim "$name" || rc=1; done
fi
exit $rc
