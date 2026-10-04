#!/usr/bin/env bash
#
# The Terragrunt example: the shop's 15 units on the stack's Forgejo, applied
# to floci. It runs beside the plain example: its names start with shop-tg and
# its state sits under terragrunt/ in the same state bucket.
#
#   stack/example-terragrunt.sh up          boot the forgejo profile, push the
#                                           example to a fresh repo's main and
#                                           apply every unit
#   stack/example-terragrunt.sh verify      every resource the units declare is in floci
#   stack/example-terragrunt.sh change <n>  open a pull request with one scenario
#   stack/example-terragrunt.sh reset       close every pull request, put main back
#                                           to the example as committed, apply it
#   stack/example-terragrunt.sh tg <args>   run terragrunt in the CI image against
#                                           a tree, with floci as AWS (TG_TREE=dir)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example-terragrunt" && pwd)"
CMD="${1:-}"; shift || true

log()  { echo "[example-terragrunt] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so the example cannot run."; exit 0; }

image() { (cd "$HERE/.." && npx tsx scripts/images.ts tags | awk -v n="$1" '$1 == n { print $2 }'); }

if [ "$CMD" = up ]; then
  ref="$(image terragrunt)"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "building the CI images (a few minutes the first time)…"
    (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || fail "the CI images did not build; run 'just images' to see why"
  fi
  log "starting Forgejo, its runner and floci…"
  boot_log="$(mktemp)"
  if ! "$HERE/bootstrap.sh" forgejo >"$boot_log" 2>&1; then
    cat "$boot_log" >&2; rm -f "$boot_log"; fail "the stack did not start"
  fi
  rm -f "$boot_log"
fi

# shellcheck source=lib.sh
. "$HERE/lib.sh"
REPO="$USER/example-terragrunt"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-example-tg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ensure_repo() {
  if ! api -o /dev/null "$URL/api/v1/repos/$REPO" 2>/dev/null; then
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d '{"name":"example-terragrunt","description":"The shop as 15 Terragrunt units on floci, run by terragucci","private":false,"auto_init":false,"default_branch":"main"}' \
      "$URL/api/v1/user/repos"
  fi
  api -o /dev/null -H 'content-type: application/json' -X PATCH \
    -d '{"has_actions":true}' "$URL/api/v1/repos/$REPO"
}

# What the units in a tree declare, by name: "kind name" lines.
expected() { # dir
  local dir="$1" f unit env name
  for f in "$dir"/live/*/*/terragrunt.hcl; do
    unit="${f#"$dir"/}"; unit="${unit%/terragrunt.hcl}"
    env="$(cut -d/ -f2 <<<"$unit")"; name="$(cut -d/ -f3 <<<"$unit")"
    if grep -q 'modules/platform' "$f"; then
      echo "bucket shop-tg-$env-$(sed -n 's/^ *name *= *"\(.*\)"/\1/p' "$f" | head -1 | grep . || echo logs)"
    else
      echo "bucket shop-tg-$env-$name-files"
      echo "queue shop-tg-$env-$name-jobs"
      grep -q 'records_table = false' "$f" || echo "table shop-tg-$env-$name-records"
      if grep -q 'dead_letter_queue = true' "$f"; then echo "queue shop-tg-$env-$name-dead-letter"; fi
    fi
  done
}

json() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: $1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }

verify_tree() { # dir
  local queues tables missing=0 kind name total
  queues="$(json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]? | split("/") | last')"
  tables="$(json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?')"
  while read -r kind name; do
    case "$kind" in
      bucket) [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$name")" = 200 ] ;;
      queue)  grep -qx "$name" <<<"$queues" ;;
      table)  grep -qx "$name" <<<"$tables" ;;
    esac || { echo "missing $kind $name"; missing=$((missing + 1)); }
  done < <(expected "$1")
  total="$(expected "$1" | wc -l | tr -d ' ')"
  [ "$missing" = 0 ] || { log "$missing of $total resources are missing from floci"; return 1; }
  log "all $total resources are in floci"
}

clone_main() { # dir
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git" "$1" 2>/dev/null \
    || fail "could not clone $REPO; run 'just example-terragrunt up' first"
}

apply_main_tree() { # message
  local sha
  sha="$(TG_FIXED_DATE="${TG_FIXED_DATE:-}" push_tree "$WORK/tree" "$REPO" main "$1")"
  log "pushed to main at ${sha:0:8}; the pipeline applies every unit, a wave at a time…"
  wait_run "$REPO" "$sha"
  if [ "$RUN_STATUS" != success ]; then
    print_logs "$REPO" "$RUN_ID"
    fail "the pipeline ended '$RUN_STATUS'"
  fi
  verify_tree "$WORK/tree"
}

case "$CMD" in
  up)
    started=$(date +%s)
    # A fresh repo, so the push always starts a run: the same tree has the same
    # sha, and an old run on it says nothing about a floci that was wiped since.
    api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO" 2>/dev/null || true
    for _ in $(seq 1 30); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/repos/$REPO")" = 404 ] && break
      sleep 1
    done
    ensure_repo
    mkdir -p "$WORK/tree"
    cp -R "$EXAMPLE/." "$WORK/tree/"
    # TG_PIPELINE: a pipeline file to push instead of the committed one (smoke BREAKs).
    [ -n "${TG_PIPELINE:-}" ] && cp "$TG_PIPELINE" "$WORK/tree/.forgejo/workflows/terragucci.yml"
    [ -n "${TG_CONFIG:-}" ] && cp "$TG_CONFIG" "$WORK/tree/terragucci.yml"
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
    TG_FIXED_DATE=1 apply_main_tree "The shop's estate, on Terragrunt"
    log "ready in $(( $(date +%s) - started ))s"
    cat <<OUT

  The Terragrunt example is running.

  Forgejo     $URL/$REPO
  Pipeline    $RUN_URL
  floci       $FLOCI (the AWS stand-in)

  Next: just example-terragrunt change one-unit
OUT
    ;;

  verify)
    clone_main "$WORK/tree"
    verify_tree "$WORK/tree"
    ;;

  change)
    name="${1:-}"
    case "$name" in
      one-unit) title="Keep dev orders' unclaimed jobs for seven days" ;;
      module-bump) title="Keep every service's files for 60 days" ;;
      destroy) title="Stop keeping records for staging email" ;;
      new-service) title="Add billing to dev, with the ledger it writes to" ;;
      unformatted) title="Name dev orders' owner, without running terragrunt hcl fmt" ;;
      *) fail "unknown scenario '$name' (one-unit, unformatted, module-bump, destroy, new-service)" ;;
    esac
    clone_main "$WORK/tree"
    git -C "$WORK/tree" apply "$EXAMPLE/changes/$name.patch" \
      || fail "changes/$name.patch does not apply to main; run 'just example-terragrunt reset' first"
    sha="$(TG_FIXED_DATE=1 push_tree "$WORK/tree" "$REPO" "change/$name" "$title")"
    pr="$(api -H 'content-type: application/json' -X POST \
      -d "$(jq -n --arg t "$title" --arg h "change/$name" '{title:$t, head:$h, base:"main", body:"A scenario from the terragucci Terragrunt example (example-terragrunt/changes)."}')" \
      "$URL/api/v1/repos/$REPO/pulls" 2>/dev/null | jq -r '.html_url // empty')"
    [ -n "$pr" ] || pr="$(api "$URL/api/v1/repos/$REPO/pulls?state=open" | jq -r --arg h "change/$name" '.[] | select(.head.ref == $h) | .html_url' | head -1)"
    pr="${pr/#http:\/\/forgejo:3000/$URL}"
    log "pushed change/$name at ${sha:0:8}"
    wait_run "$REPO" "$sha"
    cat <<OUT

  Pull request  $pr
  Pipeline      $RUN_URL ($RUN_STATUS)
OUT
    ;;

  reset)
    for n in $(api "$URL/api/v1/repos/$REPO/pulls?state=open&limit=50" | jq -r '.[].number'); do
      api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"state":"closed"}' "$URL/api/v1/repos/$REPO/pulls/$n"
    done
    for b in $(api "$URL/api/v1/repos/$REPO/branches?limit=50" | jq -r '.[].name | select(. != "main")'); do
      api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO/branches/${b//\//%2F}" || true
    done
    clone_main "$WORK/tree"
    find "$WORK/tree" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -R "$EXAMPLE/." "$WORK/tree/"
    apply_main_tree "Reset to the example as committed"
    ;;

  tg)
    # terragrunt in the CI image against TG_TREE, as a pipeline job would run it.
    tree="${TG_TREE:?TG_TREE=<dir> names the tree}"
    # Providers go in the tree, so a later call in a new container finds the ones an earlier one installed.
    mkdir -p "$tree/.terragrunt-cache/plugins"
    docker run --rm --network terragucci -v "$tree:/repo" -w /repo \
      -e TF_PLUGIN_CACHE_DIR=/repo/.terragrunt-cache/plugins -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
      -e TG_TF_PATH=tofu -e TG_NON_INTERACTIVE=true -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      "$(image terragrunt)" terragrunt "$@"
    ;;

  *)
    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
