#!/usr/bin/env bash
# Applies every root: the three platform roots together, then the twelve
# service roots together. Each root's output goes to its own log, printed
# once the root is done, so the job log reads root by root.
set -uo pipefail

run_root() { # dir
  local dir="$1" log
  log="$(mktemp)"
  if tofu -chdir="$dir" init -no-color >"$log" 2>&1 &&
    tofu -chdir="$dir" apply -auto-approve -no-color >>"$log" 2>&1; then
    echo "applied $dir: $(grep -o 'Resources: .*destroyed' "$log" | tail -1)"
    rm -f "$log"
  else
    echo "FAILED $dir"
    sed 's/^/    /' "$log"
    rm -f "$log"
    return 1
  fi
}

apply_together() { # dir...
  local pids=() rc=0
  for dir in "$@"; do
    run_root "$dir" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid" || rc=1; done
  return $rc
}

apply_together envs/*/platform || exit 1
apply_together $(ls -d envs/*/*/ | grep -v /platform/) || exit 1
echo "all roots applied"
