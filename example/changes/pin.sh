#!/usr/bin/env bash
# Pin: publish modules/service as 1.1.0 and open the first rollout wave.
#
# The example's roots call modules/service by path, so there is nothing to pin
# yet. This scenario does what a team does once it starts versioning a module:
#   1. publishes the module as 1.0.0 (a git tag),
#   2. pins the 12 service roots to that tag and gives the module a new output,
#      as one commit on main, which the pipeline applies,
#   3. publishes the changed module as 1.1.0 (tf-publish),
#   4. runs tf-rollout in apply mode, which opens the pull request for wave 1.
# It needs the example booted and untouched: 'just example reset' first.
# The first wave is the canary, envs/dev; merge its pull request and run
# 'terragucci rollout modules/service --mode apply' from a clone for the next.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STACK="$ROOT/stack"
TERRAGUCCI="$ROOT/node_modules/.bin/terragucci"

log()  { case "$*" in "run "*) ;; *) echo "[pin] $*" >&2 ;; esac; }
fail() { log "FAIL: $*"; exit 1; }

# shellcheck source=../../stack/lib.sh
. "$STACK/lib.sh"
REPO="$USER/example"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-pin.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"

git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git" "$TREE" 2>/dev/null \
  || fail "could not clone $REPO; run 'just example up' first"
if grep -rq 'modules/service?ref=' "$TREE/envs" 2>/dev/null; then
  fail "main already pins modules/service; run 'just example reset' first"
fi

# A release tag left by an earlier run would be taken for the module's history.
for tag in $(api "$URL/api/v1/repos/$REPO/tags?limit=50" | jq -r '.[].name | select(startswith("modules/service/v"))'); do
  api -o /dev/null -X DELETE "$URL/api/v1/repos/$REPO/tags/${tag//\//%2F}" || true
done

cd "$TREE"
git config user.name "$USER"
git config user.email "$USER@terragucci.local"
git config commit.gpgsign false

# The release config. The example's own terragucci.yml has no modules block, and
# the forge and url are what the rollout needs to open a pull request.
{
  cat terragucci.yml
  printf 'forge: forgejo\nurl: %s/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\nmodules:\n  path: modules/*\n  publish: git-tags\n' "$URL" "$REPO"
} > "$WORK/release.yml"
export TERRAGUCCI_FORGEJO_TOKEN="$TOKEN"

# 1. modules/service at 1.0.0, tagged locally and pushed as a tag only. The
#    commit reaches main with the next push.
echo "1.0.0" > modules/service/version
git add -A
git commit -q -m "chore(service): release 1.0.0"
"$TERRAGUCCI" publish --config "$WORK/release.yml" >&2 || fail "publishing 1.0.0 failed"

# 2. Pin every service root to 1.0.0, and give the module a new output and the
#    version 1.1.0.
source_url="git::http://forgejo:3000/$REPO.git//modules/service?ref=modules/service/v1.0.0"
for f in envs/*/*/main.tf; do
  grep -q 'source = "../../../modules/service"' "$f" || continue
  sed "s#source = \"../../../modules/service\"#source = \"$source_url\"#" "$f" > "$f.new" && mv "$f.new" "$f"
done
cat >> modules/service/main.tf <<'HCL'

output "prefix" {
  value = local.prefix
}
HCL
echo "1.1.0" > modules/service/version
git add -A
git -c user.email=example@terragucci.local -c user.name=terragucci commit -q -m "feat(service): export the name prefix"
git push -q origin HEAD:refs/heads/main 2>&1 | sed "s/${TOKEN}/***/g" >&2 || true
sha="$(git rev-parse HEAD)"
[ "$(api "$URL/api/v1/repos/$REPO/branches/main" | jq -r '.commit.id')" = "$sha" ] || fail "main did not take the pinned roots"
log "main pins the service roots to modules/service 1.0.0; the pipeline applies them"
wait_run "$REPO" "$sha"
if [ "$RUN_STATUS" != success ]; then
  print_logs "$REPO" "$RUN_ID" >&2
  fail "the pipeline ended '$RUN_STATUS'"
fi

# 3. Publish the changed module: 1.1.0.
"$TERRAGUCCI" publish --config "$WORK/release.yml" >&2 || fail "publishing 1.1.0 failed"

# 4. Open the first wave.
out="$("$TERRAGUCCI" rollout modules/service --config "$WORK/release.yml" --mode apply 2>&1)" \
  || { echo "$out" >&2; fail "the rollout did not open a wave"; }
echo "$out"
pr="$(grep -o "http[^ ]*/pulls/[0-9]*" <<<"$out" | head -1 || true)"
pr="${pr/#http:\/\/forgejo:3000/$URL}"
[ -n "$pr" ] || fail "the rollout opened no pull request"

# Let the wave's checks finish, so the pull request shows its plans.
branch="terragucci/rollout/modules-service-1.1.0/wave-1"
head="$(api "$URL/api/v1/repos/$REPO/branches/${branch//\//%2F}" | jq -r '.commit.id // empty')"
if [ -n "$head" ]; then wait_run "$REPO" "$head" || true; fi
printf '\n  Pull request  %s\n  Pipeline      %s (%s)\n' "$pr" "${RUN_URL:-}" "${RUN_STATUS:-}"
