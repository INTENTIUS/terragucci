#!/usr/bin/env bash
# A person grants a coding agent runs of named claims, or of the tutorial
# capture, without typing "run" for each (stack/human-gate.sh).
#
#   stack/grant.sh <name>... [--runs N] [--hours H]   grant: N runs each (2), for H hours (4)
#   stack/grant.sh --show                             what the grant holds now
#   stack/grant.sh --end                              end the grant
#
# A name is a smoke claim (`stack/smoke.sh --list`), an area of them (`lock`
# grants every lock/ claim), or `capture`. Granting
# replaces any grant before it. The agent passes the gate only for the names
# here, a run at a time, and each granted run stops itself when it goes quiet.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=human-gate.sh
. "$HERE/human-gate.sh"

case "${1:-}" in
  --show)
    if [ -f "$GRANT_FILE" ]; then
      expires="$(awk '$1 == "expires" { print $2 }' "$GRANT_FILE")"
      if [ "$(date +%s)" -lt "${expires:-0}" ]; then
        echo "until $(date -r "$expires" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$expires" '+%Y-%m-%d %H:%M'):"
        awk 'NR > 1 { print "  " $1 ": " $2 " run" ($2 == 1 ? "" : "s") " left" }' "$GRANT_FILE"
        exit 0
      fi
    fi
    echo "no grant"; exit 0 ;;
  --end)
    [ -f "$GRANT_FILE" ] && printf 'expires 0\n' > "$GRANT_FILE"
    echo "no grant"; exit 0 ;;
  ""|-h|--help) sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

runs=2 hours=4 names=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runs) runs="${2:?--runs takes a number}"; shift 2 ;;
    --hours) hours="${2:?--hours takes a number}"; shift 2 ;;
    -*) echo "grant: unknown flag $1" >&2; exit 2 ;;
    *) names+=("$1"); shift ;;
  esac
done
[[ "$runs" =~ ^[1-9][0-9]*$ ]] || { echo "grant: --runs takes a whole number from 1" >&2; exit 2; }
[[ "$hours" =~ ^[1-9][0-9]*$ ]] || { echo "grant: --hours takes a whole number from 1" >&2; exit 2; }
[ "${#names[@]}" -gt 0 ] || { echo "grant: name at least one claim, or capture" >&2; exit 2; }

known="$("$HERE/smoke.sh" --list 2>/dev/null | awk '{ print $1 }')"
for n in "${names[@]}"; do
  # A claim is <area>/<part>; an area alone grants every part of it.
  [ "$n" = capture ] || grep -qx -- "$n" <<<"$known" || grep -q -- "^$n/" <<<"$known" \
    || { echo "grant: $n is not a claim or an area of claims (stack/smoke.sh --list), or capture" >&2; exit 2; }
done

# Only a person grants: with no terminal this stops (TG_HUMAN_RUN does not count here).
unset TG_HUMAN_RUN
human_gate "a grant letting a coding agent run ${names[*]}, $runs time$([ "$runs" = 1 ] || echo s) each, for $hours hour$([ "$hours" = 1 ] || echo s)"

mkdir -p "$(dirname "$GRANT_FILE")"
{
  echo "expires $(( $(date +%s) + hours * 3600 ))"
  for n in "${names[@]}"; do echo "$n $runs"; done
} > "$GRANT_FILE"
"$0" --show
