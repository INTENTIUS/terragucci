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
#   stack/example.sh merge <name>     merge that scenario's pull request into main,
#                                     as the reader would, and show which wave waits
#                                     or refuses. The first merge lists the reader's
#                                     ssh key in .chant/allowed_signers on main.
#   stack/example.sh approve [wave-N] approve a waiting wave as the reader, sealed
#                                     with the reader's key. With no argument, the
#                                     wave the last run printed an approval for.
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
  # The pipeline runs in terragucci's CI image. Before an image is published,
  # build it into the local daemon, where the runner finds it without pulling.
  ref="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "building the CI images (a few minutes the first time)…"
    (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || fail "the CI images did not build; run 'just images' to see why"
  fi
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

# The reader's ssh key: it seals approvals, and its public half is the one line
# in .chant/allowed_signers. It lives in the stack's state, not in example/.
READER_KEY="$HERE/.state/reader"

# What a run asks of the reader: the approval command a waiting wave printed, or
# the lines of a refusal. One line each, without timestamps.
held_lines() { # run id
  local job
  for job in $(api "$URL/api/v1/repos/$REPO/actions/runs/$1/jobs" | jq -r '.[] | select(.status == "failure") | .id'); do
    api "$URL/api/v1/repos/$REPO/actions/jobs/$job/logs" 2>/dev/null \
      | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
      | grep -E 'chant approve tf-apply wave-|changed after it was approved|planned differently since' || true
  done
}

# The wave that the most recent failed run asked the reader to approve.
waiting_wave() {
  local run
  run="$(api "$URL/api/v1/repos/$REPO/actions/runs" | jq -r '[.workflow_runs[] | select(.status == "failure")][0].id // empty')"
  [ -n "$run" ] || return 0
  held_lines "$run" | grep -o 'chant approve tf-apply wave-[0-9]*' | head -1 | sed 's/.*tf-apply //' || true
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
import re, sys
p, root = sys.argv[1], sys.argv[2]
s = open(p).read()
# Each wave job names every root in --layers; drop the root from each of them.
def drop(m):
    layers = [[r for r in l.split(",") if r != root] for l in m.group(1).split(";")]
    return "--layers '%s'" % ";".join(",".join(l) for l in layers if l)
s, n = re.subn(r"--layers '([^']*)'", lambda m: drop(m) if "stage tf-apply" in s[s.rfind("\n", 0, m.start()):m.start()] else m.group(0), s)
assert root in open(p).read() and n, root
open(p, "w").write(s)
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

  merge)
    name="${1:-}"
    [ -n "$name" ] || fail "usage: example.sh merge <scenario>"
    pr="$(api "$URL/api/v1/repos/$REPO/pulls?state=open&limit=50" | jq -r --arg h "change/$name" '.[] | select(.head.ref == $h) | .number' | head -1)"
    [ -n "$pr" ] || fail "no open pull request for change/$name; run 'just example change $name' first"
    # wait_run's own line names a commit, which is not the same twice; the
    # summary below shows the run's link and status instead.
    log() { case "$*" in "run "*) ;; *) echo "[example] $*" >&2 ;; esac; }
    if [ ! -f "$READER_KEY" ]; then
      mkdir -p "$(dirname "$READER_KEY")"
      ssh-keygen -q -t ed25519 -N "" -C "$USER" -f "$READER_KEY"
    fi
    line="$USER $(cut -d' ' -f1,2 "$READER_KEY.pub")"
    clone_main "$WORK/tree"
    if ! grep -qxF "$line" "$WORK/tree/.chant/allowed_signers" 2>/dev/null; then
      mkdir -p "$WORK/tree/.chant"
      echo "$line" >> "$WORK/tree/.chant/allowed_signers"
      sha="$(push_tree "$WORK/tree" "$REPO" main "List the reader's key in .chant/allowed_signers")"
      log "listed the reader's key in .chant/allowed_signers"
      wait_run "$REPO" "$sha"
    fi
    api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$REPO/pulls/$pr/merge" \
      || fail "could not merge pull request $pr"
    sha="$(api "$URL/api/v1/repos/$REPO/branches/main" | jq -r '.commit.id')"
    log "merged change/$name into main"
    wait_run "$REPO" "$sha"
    printf '\n  Merged    pull request %s into main\n  Pipeline  %s (%s)\n' "$pr" "$RUN_URL" "$RUN_STATUS"
    held_lines "$RUN_ID" | sed 's/^/  /'
    ;;

  approve)
    wave="${1:-$(waiting_wave)}"
    [ -n "$wave" ] || fail "no wave is waiting; run 'just example change destroy' and 'just example merge destroy' first"
    [ -f "$READER_KEY" ] || fail "the reader's key is listed by 'just example merge'; merge a scenario first"
    clone_main "$WORK/approve"
    git -C "$WORK/approve" config user.name "$USER"
    git -C "$WORK/approve" config user.email "$USER@terragucci.local"
    out="$(cd "$WORK/approve" && "$HERE/../node_modules/.bin/chant" approve tf-apply "$wave" --actor "$USER" --sign "$READER_KEY" 2>&1)" \
      || { echo "$out" >&2; fail "chant approve tf-apply $wave failed"; }
    printf '\n  Approved  %s, signed as %s\n' "$wave" "$USER"
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
