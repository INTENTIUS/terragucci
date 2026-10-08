#!/usr/bin/env bash
# Fails a pull request that would undo a change main already has, in a file
# the pull request touches. A rebase that keeps a stale copy of a file puts
# back the lines a commit merged before it changed, and the squash then
# reverts that commit without saying so.
#
#   scripts/diff-guard.sh BASE HEAD     BASE: the branch merged into (origin/main)
#                                       HEAD: the pull request's head commit
#
# For each file HEAD changes against its merge base with BASE, it takes the
# commits among the merge base's last DIFF_GUARD_DEPTH (20) first parents that
# changed the file, and asks git apply whether each one's change to the file
# applies to HEAD's tree and not to the merge base's. It applies to HEAD only
# when HEAD holds the lines as they were before that commit, so the pull
# request would undo it. The window is where a rebase goes wrong: the commits
# merged while the pull request was open. An older change that a pull request
# undoes on purpose is out of it, and so is a file the pull request deletes or
# adds.
#
# DIFF_GUARD_ALLOW=1 passes with the findings printed, for a pull request
# that reverts on purpose (the workflow sets it for the label "revert").
set -euo pipefail

base_ref="${1:?usage: scripts/diff-guard.sh BASE HEAD}"
head="${2:?usage: scripts/diff-guard.sh BASE HEAD}"
depth="${DIFF_GUARD_DEPTH:-20}"
base="$(git merge-base "$base_ref" "$head")"
since="$(git rev-list --first-parent -n 1 --skip="$depth" "$base")"
range="${since:+$since..}$base"

work="$(mktemp -d "${TMPDIR:-/tmp}/diff-guard.XXXXXX")"
trap 'rm -rf "$work"' EXIT
GIT_INDEX_FILE="$work/head" git read-tree "$head"
GIT_INDEX_FILE="$work/base" git read-tree "$base"
applies() { GIT_INDEX_FILE="$work/$1" git apply --cached --check "$work/patch" 2>/dev/null; }

found=0
checked=0
while IFS=$'\t' read -r status path; do
  case "$status" in D|A) continue ;; esac
  checked=$((checked + 1))
  for c in $(git log --first-parent --format=%H "$range" -- "$path"); do
    git rev-parse -q --verify "$c^" >/dev/null || continue
    git diff --binary "$c^" "$c" -- "$path" > "$work/patch"
    [ -s "$work/patch" ] || continue
    if applies head && ! applies base; then
      echo "$path: this pull request undoes $(git rev-parse --short=12 "$c") ($(git log -1 --format=%s "$c")), which main has; rebase again and keep main's copy of the file"
      found=1
      break
    fi
  done
done < <(git diff --name-status --no-renames "$base" "$head")

if [ "$found" = 1 ]; then
  if [ "${DIFF_GUARD_ALLOW:-}" = 1 ]; then echo "DIFF_GUARD_ALLOW=1: passing, the pull request reverts on purpose"; exit 0; fi
  exit 1
fi
echo "diff-guard: $checked changed files against $(git rev-parse --short=12 "$base"), none undoes one of its last $depth commits"
