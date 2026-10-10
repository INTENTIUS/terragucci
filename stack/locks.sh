# The stack lock, shared by stack/smoke.sh and stack/tutorial-capture.sh:
# every process that drives the stack takes the locks it needs here, so a
# capture that resets the stack never runs under a claim, nor two claims on
# one resource. Sourced; needs HERE (the stack/ directory) and, optionally,
# SMOKE_LOCK_DIR.
# Every worktree of the repo drives the one stack, so they share one lock
# directory: the main worktree's (git's common dir), not each tree's own.
SMOKE_LOCKS_DEFAULT="$HERE/.state/locks"
if common="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && [ -d "$(dirname "$common")/stack" ]; then
  SMOKE_LOCKS_DEFAULT="$(dirname "$common")/stack/.state/locks"
fi
# The GitLab lab is one too (compose project tglab), with locks of its own beside the stack's.
[ "${SMOKE_FORGE:-}" != gitlab ] || SMOKE_LOCKS_DEFAULT="$SMOKE_LOCKS_DEFAULT/gitlab"
SMOKE_LOCKS="${SMOKE_LOCK_DIR:-$SMOKE_LOCKS_DEFAULT}"

# ── the stack lock: one lock per shared resource ──
# $SMOKE_LOCKS/<resource>/<holder>.<s|x> is one hold, shared or exclusive,
# holding the pid of the process that took it; a hold whose process is gone
# is dropped. Every change happens under one mutex (a directory, made
# atomically), so separate smoke.sh processes on one stack take turns too.

lock_mutex() {
  local owner
  mkdir -p "$SMOKE_LOCKS"
  until mkdir "$SMOKE_LOCKS/.mutex" 2>/dev/null; do
    owner=""
    read -r owner 2>/dev/null <"$SMOKE_LOCKS/.mutex/pid" || true
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$SMOKE_LOCKS/.mutex"; continue; fi
    sleep 0.1
  done
  echo "$$" >"$SMOKE_LOCKS/.mutex/pid"
}

unlock_mutex() { rm -rf "$SMOKE_LOCKS/.mutex"; }

# holder, lock... -> 0 with every lock held, or 1 with the resources in the
# way on stdout. All or nothing, so two runs never each hold half of what the
# other needs.
try_lock() {
  local holder="$1" l res mode f p busy=""
  shift
  lock_mutex
  for f in "$SMOKE_LOCKS"/*/*.s "$SMOKE_LOCKS"/*/*.x "$SMOKE_LOCKS"/*/*.w; do
    [ -f "$f" ] || continue
    p=""; read -r p 2>/dev/null <"$f" || true
    if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then rm -f "$f"; fi
  done
  for l in "$@"; do
    res="${l%!}"; mode=s; [ "$res" = "$l" ] || mode=x
    for f in "$SMOKE_LOCKS/$res"/*.s "$SMOKE_LOCKS/$res"/*.x; do
      [ -f "$f" ] || continue
      case "$f" in "$SMOKE_LOCKS/$res/$holder".[sx]) continue ;; esac
      if [ "$mode" = x ] || [ "${f##*.}" = x ]; then busy="$busy $res"; break; fi
    done
    # A run waiting to hold the resource alone (its .w marker) goes first: a
    # shared hold queues behind it, so a steady stream of shared runs from
    # other worktrees never starves it.
    if [ "$mode" = s ]; then
      for f in "$SMOKE_LOCKS/$res"/*.w; do
        [ -f "$f" ] || continue
        case "$f" in "$SMOKE_LOCKS/$res/$holder".w) continue ;; esac
        busy="$busy $res"; break
      done
    fi
  done
  if [ -z "$busy" ]; then
    for l in "$@"; do
      res="${l%!}"; mode=s; [ "$res" = "$l" ] || mode=x
      mkdir -p "$SMOKE_LOCKS/$res"
      echo "$$" >"$SMOKE_LOCKS/$res/$holder.$mode"
    done
    rm -f "$SMOKE_LOCKS"/*/"$holder".w
  fi
  unlock_mutex
  [ -z "$busy" ] || { echo "$busy"; return 1; }
}

unlock_holder() { # holder
  [ -d "$SMOKE_LOCKS" ] || return 0
  lock_mutex
  rm -f "$SMOKE_LOCKS"/*/"$1".s "$SMOKE_LOCKS"/*/"$1".x "$SMOKE_LOCKS"/*/"$1".w
  unlock_mutex
}

# Every hold this process took, for the exit trap.
release_mine() {
  local f p
  [ -d "$SMOKE_LOCKS" ] || return 0
  lock_mutex
  for f in "$SMOKE_LOCKS"/*/*.s "$SMOKE_LOCKS"/*/*.x "$SMOKE_LOCKS"/*/*.w; do
    [ -f "$f" ] || continue
    p=""; read -r p 2>/dev/null <"$f" || true
    if [ "$p" = "$$" ]; then rm -f "$f"; fi
  done
  unlock_mutex
  return 0
}

hold_locks() { # holder, lock... : wait until every lock is held
  local holder="$1" busy said=""
  shift
  until busy="$(try_lock "$holder" "$@")"; do
    [ "$busy" = "$said" ] || { echo "[smoke] waiting for:$busy" >&2; said="$busy"; mark_waiting "$holder" "$@"; }
    sleep 2
  done
}

mark_waiting() { # holder, lock... : leave a .w marker for each lock wanted alone
  local holder="$1" l
  shift
  lock_mutex
  for l in "$@"; do
    case "$l" in *!) mkdir -p "$SMOKE_LOCKS/${l%!}"; echo "$$" >"$SMOKE_LOCKS/${l%!}/$holder.w" ;; esac
  done
  unlock_mutex
}

with_lock() { # resource, command... : run the command holding the resource alone
  local holder="$$.with.$1.$RANDOM" rc=0
  hold_locks "$holder" "$1!"
  shift
  "$@" || rc=$?
  unlock_holder "$holder"
  return $rc
}
