#!/usr/bin/env bash
#
# The smoke claims a change can affect, one name per line, for
# `stack/smoke.sh --only` (`just claims-affected`).
#
#   stack/claims-affected.sh [base]   base defaults to origin/main
#
# The change is everything between the merge base with <base> and the working
# tree. A file picks claims this way:
#
#   stack/smoke.sh          the claims whose CLAIMS row, CLAIM_GROUPS line or
#                           claim_<name> function a changed line falls in; a
#                           changed line anywhere else (a shared helper) picks
#                           every claim
#   a docs page             the claims its `claims:` front matter newly lists
#   anything else           the claim globs stack/claim-paths.txt gives its
#                           path; ALL picks every claim, and a path the file
#                           does not name picks none
#
# Each reason goes to stderr, so a run says why it runs what it runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
base="${1:-origin/main}"
cd "$ROOT"

mb="$(git merge-base "$base" HEAD)" || { echo "claims-affected: no merge base with $base" >&2; exit 2; }
all="$(bash "$HERE/smoke.sh" --list | awk '{ print $1 }')"
picked=""
pick() { # reason, claim...
  local why="$1" c
  shift
  [ "$#" -gt 0 ] || return 0
  echo "claims-affected: $why: $*" >&2
  for c in "$@"; do picked="$picked$c"$'\n'; done
}
pick_glob() { # reason, glob...
  local why="$1" g c out=""
  shift
  for g in "$@"; do
    if [ "$g" = ALL ]; then out="$all"; break; fi
    for c in $all; do
      # shellcheck disable=SC2254
      case "$c" in $g) out="$out$c"$'\n' ;; esac
    done
  done
  # shellcheck disable=SC2086
  # shellcheck disable=SC2046
  pick "$why" $(sort -u <<<"$out")
}

# Committed, staged, unstaged and untracked changes since the merge base.
files="$( { git diff --name-only "$mb"; git ls-files --others --exclude-standard; } | sort -u)"
[ -n "$files" ] || { echo "claims-affected: nothing changed since $(git rev-parse --short "$mb")" >&2; exit 0; }

# The claim each line of smoke.sh belongs to: a CLAIMS row, a CLAIM_GROUPS
# line, or a claim_<name> function; "-" for any other line.
smoke_owner() {
  awk '
    /^CLAIMS=\047/ { sect = "claims"; print "-"; next }
    /^CLAIM_GROUPS=\047/ { sect = "groups"; print "-"; next }
    sect != "" && /^\047/ { sect = ""; print "-"; next }
    sect == "claims" { split($0, f, "|"); print (f[1] == "" ? "-" : f[1]); next }
    sect == "groups" { print (NF ? $1 : "-"); next }
    /^claim_[a-z0-9_]+\(\) *\{/ { fn = $0; sub(/^claim_/, "", fn); sub(/\(.*/, "", fn); gsub(/_/, "-", fn); print fn; next }
    # A claim runs to the next top-level definition: a "}" at column 0 can
    # close a heredoc inside it.
    /^[A-Za-z_][A-Za-z0-9_]*\(\) *\{/ { fn = $0; sub(/\(.*/, "", fn); fn = "h:" fn; print fn; next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { fn = ""; print "-"; next }
    fn != "" { print fn; next }
    { print "-" }
  ' "$HERE/smoke.sh"
}

while read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    stack/smoke.sh)
      owners="$(smoke_owner)"
      # New-file line numbers of every changed hunk (deleted lines count
      # against the line after them).
      lines="$(git diff -U0 "$mb" -- stack/smoke.sh | awk '/^@@/ {
        split($3, a, ","); s = substr(a[1], 2) + 0; n = (a[2] == "" ? 1 : a[2] + 0)
        if (n == 0) { print s + 1 } else { for (i = s; i < s + n; i++) print i } }')"
      helper=""; claims=""; helpers=""
      for l in $lines; do
        o="$(sed -n "${l}p" <<<"$owners")"
        case "$o" in h:*) helpers="$helpers ${o#h:}"; continue ;; esac
        if [ -z "$o" ] || [ "$o" = - ]; then
          # A blank or comment line between claims changes no claim.
          sed -n "${l}p" "$HERE/smoke.sh" | grep -qE '^[[:space:]]*(#.*)?$' || helper="$l"
        else
          claims="$claims $o"
        fi
      done
      # A changed helper function picks the claims that call it, and the
      # claims that call a helper that calls it.
      for h in $(tr ' ' '\n' <<<"$helpers" | sort -u); do
        callers="$(paste -d' ' <(echo "$owners") "$HERE/smoke.sh" | awk -v h="$h" '
          { o = $1; $1 = ""; if (o == "-" || o == "h:" h) next
            if (match($0, "(^|[^A-Za-z0-9_-])" h "([^A-Za-z0-9_-]|$)")) print o }' | sort -u)"
        for c in $callers; do
          case "$c" in h:*) for x in $(paste -d' ' <(echo "$owners") "$HERE/smoke.sh" | awk -v h="${c#h:}" '
            { o = $1; $1 = ""; if (o ~ /^h:/ || o == "-") next
              if (match($0, "(^|[^A-Za-z0-9_-])" h "([^A-Za-z0-9_-]|$)")) print o }' | sort -u); do claims="$claims $x"; done ;;
            *) claims="$claims $c" ;;
          esac
        done
        [ -n "$callers" ] || helper="the helper $h, which no claim calls by name"
      done
      if [ -n "$helper" ]; then
        # shellcheck disable=SC2086
        pick "stack/smoke.sh: ${helper/#[0-9]*/line $helper} is outside any claim" $all
      else
        # shellcheck disable=SC2086
        # shellcheck disable=SC2046
        pick "stack/smoke.sh changes these claims" $(tr ' ' '\n' <<<"$claims" | sort -u)
      fi
      ;;
    docs-site/src/content/docs/*.md|docs-site/src/content/docs/*.mdx)
      [ -f "$f" ] || continue
      # Prose changes no claim's verdict; a claim the page newly lists has
      # to run so the record has its row.
      page_claims() { awk '/^---$/ { n++; next } n == 1 && /^claims:/ { sub(/^claims: */, ""); gsub(/[][,"]/, " "); print; exit }' | tr ' ' '\n' | grep . | sort -u; }
      c="$(comm -13 <(git show "$mb:$f" 2>/dev/null | page_claims) <(page_claims <"$f"))"
      # shellcheck disable=SC2086
      pick "$f newly lists" $c
      ;;
    *)
      globs="$(awk -v f="$f" '!/^#/ && NF > 1 && index(f, $1) == 1 { $1 = ""; print; exit }' "$HERE/claim-paths.txt")"
      if [ -n "$globs" ]; then
        # shellcheck disable=SC2086
        pick_glob "$f" $globs
      else
        echo "claims-affected: $f: no claim" >&2
      fi
      ;;
  esac
done <<<"$files"

sort -u <<<"$picked" | grep . || true
