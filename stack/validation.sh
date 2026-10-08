#!/usr/bin/env bash
#
# The validation claims per forge, run in bulk.
#
#   stack/validation.sh run FORGE              every claim of FORGE, plain, then
#                                              under BREAK=1 (it must fail); exits
#                                              1 when any claim is not as expected.
#                                              The profile must already be up.
#   stack/validation.sh record FILE [FORGE...] boot each forge's profile in turn,
#                                              run its claims plain and broken, tear
#                                              the stack down, and merge the verdicts
#                                              into FILE (other forges' rows are kept).
#
# A row is pass when the claim held and caught when it failed under BREAK=1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# forge|claim|what the claim shows
CLAIMS='aws|s3|floci starts and answers S3
forgejo|check|a push that is formatted goes green, and one with an unformatted file goes red naming the file
forgejo|apply|a push to main applies the root, and the bucket exists afterwards
forgejo|tg-check|the generated workflow for a Terragrunt repo fails an unformatted unit file and names it
forgejo|tg-apply|the generated workflow for a Terragrunt repo applies both of its units on the default branch
forgejo|cdf-check|the generated workflow for a choudoufu estate fails a resource that live-check refuses and names it
forgejo|cdf-apply|the generated workflow for a choudoufu estate applies it on the default branch, and the bucket carries the estate marker
forgejo|pr-review|with approval: pr-review a pull request approved on its head by a second user with write access merges, and its gated wave applies with no chant approve
github|check|the generated workflow fails an unformatted root and names the file
github|apply|the generated workflow applies the root on the default branch
github|reconcile|a control repo opens one pull request per project that changes, and the merged pipeline applies both roots
github|tg-check|the generated workflow for a Terragrunt repo fails an unformatted unit file and names it
github|tg-apply|the generated workflow for a Terragrunt repo applies both of its units on the default branch
github|cdf-check|the generated workflow for a choudoufu estate fails a resource that live-check refuses and names it
github|cdf-apply|the generated workflow for a choudoufu estate applies it on the default branch, and the bucket carries the estate marker
gitlab|check|the generated pipeline fails an unformatted root and names the file
gitlab|apply|the generated pipeline applies the root on the default branch
gitlab|reconcile|a control repo opens one merge request per project that changes, and the merged pipeline applies both roots
gitlab|tg-check|the generated pipeline for a Terragrunt repo fails an unformatted unit file and names it
gitlab|tg-apply|the generated pipeline for a Terragrunt repo applies both of its units on the default branch
gitlab|cdf-check|the generated pipeline for a choudoufu estate fails a resource that live-check refuses and names it
gitlab|cdf-apply|the generated pipeline for a choudoufu estate applies it on the default branch, and the bucket carries the estate marker
gitlab|gate-wait|a wave that waits for its approval ends its job with exit code 3 and fails the terragucci/apply status with its approval command, so the pipeline ends
gitlab|own-jobs|init adds an include to a repo with its own .gitlab-ci.yml, and the pipeline runs that repo job in its stage beside the generated check
gitlab|pr-review|with approval: pr-review a merge request approval given before the latest push leaves the wave waiting, and one given after it applies the wave'
ALL_FORGES="aws forgejo github gitlab"

claims_of() { grep "^$1|" <<<"$CLAIMS" | cut -d'|' -f2; }

one() { # forge claim -> prints "pass|caught|fail"
  local forge="$1" claim="$2" plain broken
  if "$HERE/validate.sh" "$forge" "$claim" >&2; then plain=pass; else plain=fail; fi
  if BREAK=1 "$HERE/validate.sh" "$forge" "$claim" >&2; then broken=not-caught; else broken=caught; fi
  echo "$plain $broken"
}

case "${1:-}" in
  run)
    forge="${2:?usage: validation.sh run FORGE}"
    rc=0
    for claim in $(claims_of "$forge"); do
      read -r plain broken < <(one "$forge" "$claim")
      echo "VALIDATION forge=$forge claim=$claim verdict=$plain break=$broken"
      [ "$plain" = pass ] && [ "$broken" = caught ] || rc=1
    done
    exit $rc
    ;;
  record)
    out="${2:?usage: validation.sh record FILE [FORGE...]}"; shift 2
    forges="${*:-$ALL_FORGES}"
    rows=()
    rc=0
    for forge in $forges; do
      "$HERE/down.sh" >&2
      "$HERE/bootstrap.sh" "$forge" >&2
      for claim in $(claims_of "$forge"); do
        read -r plain broken < <(one "$forge" "$claim")
        [ "$plain" = pass ] && [ "$broken" = caught ] || rc=1
        says="$(grep "^$forge|$claim|" <<<"$CLAIMS" | cut -d'|' -f3)"
        rows+=("$(jq -n --arg f "$forge" --arg c "$claim" --arg s "$says" --arg v "$plain" --arg b "$broken" \
          '{forge: $f, claim: $c, says: $s, verdict: $v, break: $b}')")
      done
    done
    "$HERE/down.sh" >&2
    new="$(printf '%s\n' "${rows[@]}" | jq -s .)"
    old='[]'; [ -f "$out" ] && old="$(jq .claims "$out")"
    # New rows replace the old ones for the same forge and claim; the rest stay,
    # in the order CLAIMS lists them.
    merged="$(jq -n --argjson old "$old" --argjson new "$new" --arg order "$CLAIMS" '
      ($order | split("\n") | map(split("|") | .[0] + " " + .[1])) as $ord
      | (($old + $new) | group_by(.forge + " " + .claim) | map(last))
      | sort_by(. as $r | ($ord | index($r.forge + " " + $r.claim)) // 99)')"
    jq -n --argjson c "$merged" '{claims: $c}' > "$out"
    echo "wrote $out" >&2
    exit $rc
    ;;
  *) echo "usage: validation.sh run FORGE | record FILE [FORGE...]" >&2; exit 2 ;;
esac
