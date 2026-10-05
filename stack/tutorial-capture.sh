#!/usr/bin/env bash
#
# Run the tutorial's steps against the example and record what a reader sees.
#
#   stack/tutorial-capture.sh
#
# For each step whose smoke claims pass (docs-site/src/data/smoke.json), it
# runs the step's commands, normalizes their output, and screenshots the
# Forgejo pages the step points at in light and dark. It writes:
#
#   docs-site/src/data/tutorial/<step>.json      commands, output, exit codes,
#                                                and the example's hash
#   docs-site/src/assets/tutorial/<step>-<view>-<theme>.png
#   docs-site/src/data/tutorial/manifest.json    date, commit and versions
#
# A step whose normalized output is unchanged keeps its files as they are, so
# re-running with no real change leaves no diff. The example is booted fresh,
# so commit shas and run numbers are the same on every capture.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DATA="$ROOT/docs-site/src/data/tutorial"
SHOTS="$ROOT/docs-site/src/assets/tutorial"
SMOKE="$ROOT/docs-site/src/data/smoke.json"

log()  { echo "[capture] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so nothing can be captured."; exit 0; }
[ -f "$SMOKE" ] || fail "no $SMOKE; run 'just smoke-record' first"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
[ -n "$CHROME" ] || fail "no Chrome or Chromium found; set CHROME"

mkdir -p "$DATA" "$SHOTS"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-capture.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# The example's hash: every file under example/, path and content. A capture
# older than the example it came from fails `just tutorial-check`.
SOURCE_HASH="$(cd "$ROOT" && find example -type f ! -path '*/.terraform/*' | LC_ALL=C sort | while read -r f; do
  printf '%s\0' "$f"; cat "$f"; done | shasum -a 256 | cut -c1-16)"

claims_pass() { # claim...
  local c
  for c in "$@"; do
    [ "$(jq -r --arg c "$c" '.claims[] | select(.claim == $c) | .verdict' "$SMOKE")" = pass ] || return 1
  done
}

# Output a reader would see, with what changes run to run made stable.
normalize() {
  sed -E \
    -e 's/ready in [0-9]+s/ready in 90s/' \
    -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
    -e 's/\x1b\[[0-9;]*m//g'
}

# step name -> appends one command's record to $STAGE/<step>.cmds
run_cmd() { # step, shown command, real command...
  local step="$1" shown="$2"; shift 2
  local out rc=0
  out="$("$@" 2>&1 </dev/null)" || rc=$?
  jq -n --arg cmd "$shown" --arg out "$(normalize <<<"$out")" --argjson rc "$rc" \
    '{cmd: $cmd, output: $out, exit: $rc}' >> "$STAGE/$step.cmds"
  log "$shown -> exit $rc"
}

shot() { # step, view, url
  local step="$1" view="$2" url="$3" theme scheme
  for theme in light dark; do
    scheme=1; [ "$theme" = dark ] && scheme=0
    # The virtual time budget lets the page's scripts finish, so a job log
    # has loaded before the picture is taken.
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,860 \
      --blink-settings=preferredColorScheme=$scheme --virtual-time-budget=8000 \
      --screenshot="$STAGE/$step-$view-$theme.png" "$url" >/dev/null 2>&1 || true
    [ -s "$STAGE/$step-$view-$theme.png" ] || fail "no screenshot of $url"
  done
  log "screenshot $step-$view ($url)"
}

# Keep a step's files unless its normalized output changed.
commit_step() { # step
  local step="$1" new="$STAGE/$step.json" old="$DATA/$step.json"
  jq -s --arg s "$step" --arg h "$SOURCE_HASH" '{step: $s, source_hash: $h, commands: .}' "$STAGE/$step.cmds" > "$new"
  if [ -f "$old" ] && [ "$(jq -S . "$old")" = "$(jq -S . "$new")" ]; then
    # Keep what is there, but add a screenshot this step has never had.
    local png
    for png in "$STAGE/$step"-*.png; do
      [ -f "$SHOTS/$(basename "$png")" ] || { cp "$png" "$SHOTS/"; CHANGED=1; log "$step: added $(basename "$png")"; }
    done
    log "$step: unchanged, files kept"
    return
  fi
  cp "$new" "$old"
  cp "$STAGE/$step"-*.png "$SHOTS/" 2>/dev/null || true
  CHANGED=1
  log "$step: written"
}

CHANGED=0
FORGEJO=""

step_boot() {
  # A reader's first boot starts from nothing, so the capture does too.
  "$HERE/down.sh" >/dev/null 2>&1 || true
  run_cmd boot "just example up" "$HERE/example.sh" up
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
  FORGEJO="$TERRAGUCCI_FORGEJO_URL/$TERRAGUCCI_FORGEJO_USER/example"
  shot boot repo "$FORGEJO"
  # Forgejo redirects a run to its first job at its in-network address, so
  # ask for the job page directly.
  shot boot run "$FORGEJO/actions/runs/1/jobs/1/attempt/1"
}

step_first_pr() {
  run_cmd first-pr "just example change one-root" "$HERE/example.sh" change one-root
  shot first-pr pull "$FORGEJO/pulls/1"
  shot first-pr files "$FORGEJO/pulls/1/files"
}

step_check() {
  run_cmd check "just example change unformatted" "$HERE/example.sh" change unformatted
  run_cmd check "just example logs" "$HERE/example.sh" logs
  shot check pull "$FORGEJO/pulls/2"
  # The failed check job's log, opened at the format step.
  shot check log "$FORGEJO/actions/runs/3/jobs/0/attempt/1"
}

# The example's gate is on-destroy, so only a change that destroys makes a wave
# wait. Merge the destroy scenario as the reader would, and read what waits.
step_wave_waiting() {
  run_cmd wave-waiting "just example change destroy" "$HERE/example.sh" change destroy
  run_cmd wave-waiting "just example merge destroy" "$HERE/example.sh" merge destroy
}

# Approve that wave, then merge a change that moves its plans: it refuses.
step_wave_refused() {
  run_cmd wave-refused "just example approve" "$HERE/example.sh" approve
  run_cmd wave-refused "just example change module-bump" "$HERE/example.sh" change module-bump
  run_cmd wave-refused "just example merge module-bump" "$HERE/example.sh" merge module-bump
}

# Publish modules/service and open the first rollout wave. The scenario pins
# the roots first, so it leaves main changed: reset afterwards so the steps
# after this one start from the example as committed.
step_pin() {
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
  run_cmd pin "just example change pin" "$HERE/example.sh" change pin
  local pr
  pr="$(grep -o 'pulls/[0-9]*' "$STAGE/pin.cmds" | tail -1 || true)"
  if [ -n "$pr" ]; then
    shot pin pull "$FORGEJO/$pr"
    shot pin files "$FORGEJO/$pr/files"
  else
    log "pin: the output named no pull request"
  fi
  "$HERE/example.sh" reset >/dev/null 2>&1 || log "pin: reset failed"
}

# tf-apply on a fountain steward (the move-apply-to-fountain guide): boot the
# example fresh with the steward taking the apply, and show the thread's turn.
step_fountain_apply() {
  run_cmd fountain-apply "just example up --fresh --fountain" "$HERE/example.sh" up --fresh --fountain
  run_cmd fountain-apply "just example verify" "$HERE/example.sh" verify
}

# step|claims it needs
STEPS='boot|boot
first-pr|check
check|check
wave-waiting|waves sealed
wave-refused|waves sealed refuse
pin|publish rollout
fountain-apply|steward'

booted=0
while IFS='|' read -r -u 3 step claims; do
  # shellcheck disable=SC2086
  if ! claims_pass $claims; then
    log "$step: skipped, its claims ($claims) do not all pass"
    continue
  fi
  if [ $booted = 0 ] && [ "$step" != boot ]; then step_boot; commit_step boot; booted=1; fi
  "step_${step//-/_}"
  [ "$step" = boot ] && booted=1
  commit_step "$step"
done 3<<<"$STEPS"

if [ "$CHANGED" = 1 ] || [ ! -f "$DATA/manifest.json" ]; then
  # shellcheck disable=SC1091
  . "$HERE/.state/forgejo.env"
  jq -n \
    --arg at "$(date -u +%Y-%m-%d)" \
    --arg commit "$(git -C "$ROOT" rev-parse --short HEAD)" \
    --arg tofu "$(sed -n 's/^  TOFU_VERSION: "\(.*\)"/\1/p' "$ROOT/example/.forgejo/workflows/terragucci.yml")" \
    --arg provider "$(sed -n 's/^ *version = "\([0-9.]*\)"/\1/p' "$ROOT/example/envs/dev/orders/main.tf" | head -1)" \
    --arg forgejo "$(curl -fsS "$TERRAGUCCI_FORGEJO_URL/api/v1/version" | jq -r .version | cut -d+ -f1)" \
    --arg floci "$(sed -n 's#.*image: ghcr.io/lex00/floci@sha256:\(.\{12\}\).*#\1#p' "$HERE/docker-compose.yml")" \
    '{captured: $at, commit: $commit, tofu: $tofu, aws_provider: $provider, forgejo: $forgejo, floci: $floci}' \
    > "$DATA/manifest.json"
  log "wrote manifest.json"
fi
log "done"
