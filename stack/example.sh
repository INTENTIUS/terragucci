#!/usr/bin/env bash
#
# The example: the shop's 15 roots on the stack's Forgejo, applied to floci.
#
#   stack/example.sh up [--fresh]     boot the forgejo profile, push the example
#                                     to main and apply every root. --fresh wipes
#                                     floci first, so every resource is new.
#   stack/example.sh verify           every resource the 15 roots declare is in floci
#   stack/example.sh change <name>    open a pull request with one scenario from
#                                     example/changes (drift and pin act directly)
#   stack/example.sh logs             the last failed run's failing lines
#   stack/example.sh reset            close every pull request, put main back to
#                                     the example as committed, and apply it again
#   stack/example.sh down             remove the stack
#
# The example repo is public, so its pages open without a login.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"
CMD="${1:-}"; shift || true

log()  { echo "[example] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so the example cannot run."; exit 0; }

if [ "$CMD" = down ]; then exec "$HERE/down.sh"; fi

if [ "$CMD" = up ]; then
  log "starting Forgejo, its runner and floci (a minute or two the first time)…"
  boot_log="$(mktemp)"
  if ! "$HERE/bootstrap.sh" forgejo >"$boot_log" 2>&1; then
    cat "$boot_log" >&2; rm -f "$boot_log"; fail "the stack did not start"
  fi
  rm -f "$boot_log"
fi

# shellcheck source=lib.sh
. "$HERE/lib.sh"
REPO="$USER/example"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-example.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ensure_repo() {
  if ! api -o /dev/null "$URL/api/v1/repos/$REPO" 2>/dev/null; then
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d '{"name":"example","description":"The shop: 15 Terraform roots on floci, run by terragucci","private":false,"auto_init":false,"default_branch":"main"}' \
      "$URL/api/v1/user/repos"
  fi
  api -o /dev/null -H 'content-type: application/json' -X PATCH \
    -d '{"has_actions":true}' "$URL/api/v1/repos/$REPO"
}

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

json() { # target, body
  curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: $1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"
}

verify_tree() { # dir
  local queues tables missing=0 kind name
  queues="$(json AmazonSQS.ListQueues '{}' | jq -r '.QueueUrls[]? | split("/") | last')"
  tables="$(json DynamoDB_20120810.ListTables '{}' | jq -r '.TableNames[]?')"
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

clone_main() { # dir
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git" "$1" 2>/dev/null \
    || fail "could not clone $REPO; run 'just example up' first"
}

apply_main_tree() { # message -> waits for the run and verifies
  local sha
  sha="$(TG_FIXED_DATE="${TG_FIXED_DATE:-}" push_tree "$WORK/tree" "$REPO" main "$1")"
  log "pushed to main at ${sha:0:8}; the pipeline applies every root…"
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
    if [ "${1:-}" = --fresh ]; then
      log "wiping floci and the example repo…"
      docker restart terragucci-floci >/dev/null
      until curl -s -o /dev/null "$FLOCI/"; do sleep 1; done
      api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO" 2>/dev/null || true
    fi
    ensure_repo
    mkdir -p "$WORK/tree"
    cp -R "$EXAMPLE/." "$WORK/tree/"
    # BREAK support for the boot claim: skip one root's apply, so the pipeline
    # stays green and only the resource check can notice.
    if [ -n "${TG_SKIP_ROOT:-}" ]; then
      python3 - "$WORK/tree/.forgejo/workflows/terragucci.yml" "$TG_SKIP_ROOT" <<'PY'
import sys
p, root = sys.argv[1], sys.argv[2]
s = open(p).read()
a = " '%s'" % root
lines = s.split("\n")
hits = [i for i, l in enumerate(lines) if "apply_together '" in l and a in l]
assert hits, a
lines[hits[0]] = lines[hits[0]].replace(a, "", 1)
open(p, "w").write("\n".join(lines))
PY
    fi
    # The roots keep their state in this bucket. In a real account it exists
    # before the first pipeline runs; on a fresh floci, make it.
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
    # The sha depends only on the example's contents, so a capture can rely on it.
    TG_FIXED_DATE=1 apply_main_tree "The shop's estate"
    log "ready in $(( $(date +%s) - started ))s"
    cat <<OUT

  The example is running.

  Forgejo     $URL/$REPO
  Pipeline    $RUN_URL
  Sign in as  $USER / Terragucci-local-pw-1234 (only needed to merge or comment)
  floci       $FLOCI (the AWS stand-in)

  Next: just example change one-root
OUT
    ;;

  verify)
    clone_main "$WORK/tree"
    verify_tree "$WORK/tree"
    ;;

  change)
    name="${1:-}"
    case "$name" in
      drift) exec "$EXAMPLE/changes/drift.sh" ;;
      pin) exec "$EXAMPLE/changes/pin.sh" ;;
      one-root) title="Keep dev orders' unclaimed jobs for seven days" ;;
      module-bump) title="Wait 60 seconds before retrying a job, in every service" ;;
      replace) title="Key prod search's records by sku" ;;
      destroy) title="Stop keeping records for staging email" ;;
      float) title="Let dev search's AWS provider version float" ;;
      unformatted) title="Add an owner to dev orders, without running tofu fmt" ;;
      *) fail "unknown scenario '$name' (one-root, unformatted, module-bump, replace, destroy, float, drift, pin)" ;;
    esac
    clone_main "$WORK/tree"
    git -C "$WORK/tree" apply "$EXAMPLE/changes/$name.patch" \
      || fail "changes/$name.patch does not apply to main; run 'just example reset' first"
    sha="$(TG_FIXED_DATE=1 push_tree "$WORK/tree" "$REPO" "change/$name" "$title")"
    pr="$(api -H 'content-type: application/json' -X POST \
      -d "$(jq -n --arg t "$title" --arg h "change/$name" '{title:$t, head:$h, base:"main", body:"A scenario from the terragucci example (example/changes)."}')" \
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

  logs)
    # The most recent run that failed: each failed job's last lines before it
    # exited, without timestamps or the runner's own messages.
    run="$(api "$URL/api/v1/repos/$REPO/actions/runs" | jq -r '[.workflow_runs[] | select(.status == "failure")][0].id // empty')"
    [ -n "$run" ] || { log "no failed run"; exit 0; }
    for job in $(api "$URL/api/v1/repos/$REPO/actions/runs/$run/jobs" | jq -r '.[] | select(.status == "failure") | .id'); do
      api "$URL/api/v1/repos/$REPO/actions/jobs/$job/logs" \
        | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
        | sed -n '1,/exitcode/p' \
        | grep -vE '^(::|##|⚙|⭐|🐳|🏁|☁|  ✅|  ❌|\[command\])' \
        | awk '/\.(tf|tofu|hcl)$/ && !seen { seen = 1 } seen { print; next } { held[++n] = $0 }
               END { if (!seen) for (i = (n > 12 ? n - 11 : 1); i <= n; i++) print held[i] }'
    done
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

  *)
    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
