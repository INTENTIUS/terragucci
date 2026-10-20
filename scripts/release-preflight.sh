#!/usr/bin/env bash
# Says which commit a release tags: the newest commit on main that passed CI,
# as `chant ci last-green` reads it from the ci/ tags chant-ci-green.yml
# pushes, and never a hand-picked one.
#
#   scripts/release-preflight.sh VERSION           the newest green commit
#   scripts/release-preflight.sh VERSION COMMIT    COMMIT, which must be green
#
# It fetches main and the ci/ tags from origin, and passes when the commit has
# ci/green/<sha> and no ci/revoked/<sha>, and its packages/terragucci/package.json
# is at VERSION. It prints the tag commands and pushes nothing.
#
# The tags are a convenience, not a dependency: when there is no green commit
# (the tick has not run, or CI_GREEN_TOKEN is missing and every recent commit
# changed a workflow), it says why and refuses, and
# TERRAGUCCI_RELEASE_SKIP_GREEN=1 releases COMMIT (default origin/main)
# without the check.
set -euo pipefail

version="${1:?usage: scripts/release-preflight.sh VERSION [COMMIT]}"
want="${2:-}"
remote="${TERRAGUCCI_RELEASE_REMOTE:-origin}"

git fetch -q "$remote" main "+refs/tags/ci/*:refs/tags/ci/*" 2>/dev/null \
  || echo "release-preflight: could not fetch main and the ci/ tags from $remote; reading the local ones" >&2

has_tag() { git rev-parse -q --verify "refs/tags/ci/$1/$2" >/dev/null; }
newest_green() {
  local c
  for c in $(git rev-list --first-parent --max-count 200 "$remote/main" 2>/dev/null || git rev-list --first-parent --max-count 200 main); do
    if has_tag green "$c" && ! has_tag revoked "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

skip="${TERRAGUCCI_RELEASE_SKIP_GREEN:-}"
if [ -n "$want" ]; then
  sha="$(git rev-parse --verify "$want^{commit}")"
elif green="$(newest_green)"; then
  sha="$green"
elif [ "$skip" = 1 ]; then
  sha="$(git rev-parse --verify "$remote/main^{commit}" 2>/dev/null || git rev-parse --verify "main^{commit}")"
else
  echo "release-preflight: no commit among main's last 200 has a ci/green tag. chant-ci-green.yml tags a commit once ci.yml passes on it; without the CI_GREEN_TOKEN secret it cannot push the tag of a commit that changes .github/workflows. Wait for a green commit, or set TERRAGUCCI_RELEASE_SKIP_GREEN=1 to release main as it is." >&2
  exit 1
fi
short="$(git rev-parse --short=12 "$sha")"

at="$(git show "$sha:packages/terragucci/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
if [ "$at" != "$version" ]; then
  echo "release-preflight: $short has packages/terragucci/package.json at $at, not $version; merge the version bump and release from a green commit after it" >&2
  exit 1
fi

if has_tag revoked "$sha"; then state=revoked; elif has_tag green "$sha"; then state=green; else state=none; fi
if [ "$state" != green ]; then
  if [ "$skip" = 1 ]; then
    echo "TERRAGUCCI_RELEASE_SKIP_GREEN=1: releasing $short without a ci/green tag ($state)" >&2
  elif [ "$state" = revoked ]; then
    echo "release-preflight: $short passed CI and then failed a re-run (ci/revoked/$sha); release from \`chant ci last-green\`" >&2
    exit 1
  else
    echo "release-preflight: $short has no ci/green tag (CI may still be running); release from \`chant ci last-green\`, or set TERRAGUCCI_RELEASE_SKIP_GREEN=1" >&2
    exit 1
  fi
else
  echo "release-preflight: $short passed CI (ci/green/$sha) and is at $version"
fi
echo "git tag v$version $sha && git push $remote v$version"
