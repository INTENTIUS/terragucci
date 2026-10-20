#!/usr/bin/env bash
# Fails when a binary would land in git history as a plain blob instead of
# going through Git LFS. Every clone downloads every version of a plain blob,
# so one picture recaptured a few times a day grows the repo for good.
#
#   scripts/lfs-check.sh                 the index (what the next commit holds)
#   scripts/lfs-check.sh BASE HEAD       HEAD's tree, and the blobs HEAD adds since its merge base with BASE
#
# Two rules:
#   - a tracked file named *.png, *.jpg, *.jpeg, *.gif, *.webp, *.ico, *.mp4,
#     *.webm or *.pdf (any case) is an LFS pointer;
#   - no blob the branch adds, in any of its commits, is over LFS_CHECK_MAX
#     bytes (512 KB). A blob that large is never an LFS pointer.
#
# With no arguments the second rule runs against origin/main when that ref
# exists, and is skipped when it does not. The checks read git's objects, so
# they need neither git-lfs nor the LFS files themselves.
set -euo pipefail

max="${LFS_CHECK_MAX:-524288}"
pattern='\.(png|jpe?g|gif|webp|ico|mp4|webm|pdf)$'
pointer='version https://git-lfs.github.com/spec/v1'

if [ $# -eq 0 ]; then
  where="the index"
  list() { git ls-files -s -z | while IFS= read -r -d '' line; do printf '%s\t%s\n' "$(cut -d' ' -f2 <<<"${line%%$'\t'*}")" "${line#*$'\t'}"; done; }
  head=""
  if git rev-parse -q --verify origin/main >/dev/null; then base_ref=origin/main; head=HEAD; fi
else
  base_ref="${1:?usage: scripts/lfs-check.sh [BASE HEAD]}"
  head="${2:?usage: scripts/lfs-check.sh [BASE HEAD]}"
  where="$(git rev-parse --short=12 "$head")"
  list() { git ls-tree -r -z "$head" | while IFS= read -r -d '' line; do printf '%s\t%s\n' "$(cut -d' ' -f3 <<<"${line%%$'\t'*}")" "${line#*$'\t'}"; done; }
fi

found=0
binaries=0
while IFS=$'\t' read -r sha path; do
  shopt -s nocasematch
  [[ "$path" =~ $pattern ]] || { shopt -u nocasematch; continue; }
  shopt -u nocasematch
  binaries=$((binaries + 1))
  size="$(git cat-file -s "$sha")"
  if [ "$size" -gt 1024 ] || [ "$(git cat-file blob "$sha" | head -c ${#pointer} | tr -d '\0')" != "$pointer" ]; then
    echo "$path: a plain git blob ($size bytes), not an LFS pointer. Run 'git lfs track \"*.${path##*.}\"' if .gitattributes lacks the type, then 'git add --renormalize $path' and commit."
    found=1
  fi
done < <(list)

if [ -n "$head" ]; then
  base="$(git merge-base "$base_ref" "$head")"
  while read -r type sha size path; do
    [ "$type" = blob ] && [ "$size" -gt "$max" ] || continue
    echo "${path:-$sha}: a $size-byte blob added since $(git rev-parse --short=12 "$base") is not in LFS (the limit is $max bytes). Run 'git lfs track \"$path\"', then 'git add --renormalize $path', and rewrite the branch's commits so no commit holds the plain blob."
    found=1
  done < <(git rev-list --objects "$base..$head" | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)')
fi

if [ "$found" = 1 ]; then exit 1; fi
echo "lfs-check: $binaries binary files in $where are LFS pointers${head:+, and no blob added since $(git rev-parse --short=12 "$base") is over $max bytes}"
