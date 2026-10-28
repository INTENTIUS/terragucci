#!/usr/bin/env bash
#
# The repo a harness scenario plays on (terragucci#1295), made before its
# first step: stack/harness/harness.ts run calls it.
#
#   stack/harness/seed.sh <scenario id>
#
# It reads the scenario's tree.base and its line in scenarios/index.json (a
# line with source: <repo>:<path> reads the tree from that INTENTIUS repo
# instead, as stack/demo.sh reads choudoufu's demo trees), and:
#
#   1. meets each of the line's needs, in order:
#        image:<name>    a CI image scripts/images.ts names (tofu, terraform,
#                        choudoufu, terragrunt) is built, or it stops
#        profile:<name>  the stack's compose profile is up (tg_compose)
#        bucket:<name>   the floci bucket is there
#        versioned:<name>  the floci bucket is there with versioning on
#        script:<cmd>    a command line runs once, from the repo root
#                        (bash -c), such as a demo.sh up that builds a
#                        demo image and starts the records proxy
#   2. makes the Forgejo repo <admin>/hs-<id> afresh, with Actions on, the
#      demo's author and reviewer as writers, and the admin's token as the
#      TERRAGUCCI_FORGEJO_TOKEN secret the pipelines read;
#   3. copies the base tree into a new directory under the instance's state,
#      runs terragucci init there when the tree has no pipeline, and pushes it
#      to main as the base commit.
#
# It prints, one per line: REPO=, BASE_DIR= (a git checkout of the base),
# BASE_SHA= and ENGINE_VERSION= (the version the binary's CI image reports).
# Progress goes to stderr.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ID="${1:?usage: seed.sh <scenario id>}"
SCENARIO="$HERE/scenarios/$ID/scenario.json"
[ -f "$SCENARIO" ] || { echo "seed: no $SCENARIO" >&2; exit 2; }
log() { echo "[seed $ID] $*" >&2; }
fail() { log "FAIL: $*"; return 1; }
# shellcheck source=../lib.sh
. "$HERE/../lib.sh"

entry="$(jq -c --arg id "$ID" '.[$id] // empty' "$HERE/scenarios/index.json")"
[ -n "$entry" ] || { log "no line for $ID in scenarios/index.json"; exit 2; }
binary="$(jq -r .binary <<<"$entry")"
base_rel="$(jq -r .tree.base "$SCENARIO")"
source="$(jq -r '.source // empty' <<<"$entry")"
if [ -n "$source" ]; then
  # A tree another repo holds, <repo>:<path> (INTENTIUS/<repo>), read from
  # DEMO_<REPO>_TREES or the clone stack/demo.sh keeps under the state
  # directory, at DEMO_<REPO>_TREES_REF (default main), as the demo reads it.
  src_repo="${source%%:*}"; src_path="${source#*:}"
  upper="$(printf '%s' "$src_repo" | tr a-z- A-Z_)"
  override_var="DEMO_${upper}_TREES"; ref_var="DEMO_${upper}_TREES_REF"
  checkout="${!override_var:-$TG_STATE/trees/$src_repo}"
  if [ -z "${!override_var:-}" ]; then
    if [ ! -d "$checkout/.git" ]; then
      mkdir -p "$(dirname "$checkout")"
      log "cloning INTENTIUS/$src_repo into $checkout for its trees"
      git clone -q --filter=blob:none "https://github.com/INTENTIUS/$src_repo.git" "$checkout" >&2
    fi
    git -C "$checkout" fetch -q origin "${!ref_var:-main}" && git -C "$checkout" checkout -q --detach FETCH_HEAD \
      || log "could not fetch ${!ref_var:-main} of INTENTIUS/$src_repo; using $checkout as it is"
  fi
  base_src="$checkout/$src_path"
  [ -d "$base_src" ] || { log "$source is not in $checkout"; exit 1; }
else
  base_src="$(cd "$(dirname "$SCENARIO")/$base_rel" && pwd)"
fi
tag_of() { (cd "$ROOT" && npx tsx scripts/images.ts tags | awk -v n="$1" '$1 == n { print $2 }'); }

while IFS= read -r need; do
  [ -n "$need" ] || continue
  case "$need" in
    image:*)
      img="$(tag_of "${need#image:}")"
      docker image inspect "$img" >/dev/null 2>&1 || { log "no CI image $img; run 'just images' first"; exit 1; }
      ;;
    profile:*) tg_compose --profile "${need#profile:}" up -d --wait >&2 || { log "the ${need#profile:} profile did not start"; exit 1; } ;;
    bucket:*) curl -fsS -o /dev/null -X PUT "$FLOCI/${need#bucket:}" || true ;;
    versioned:*)
      curl -fsS -o /dev/null -X PUT "$FLOCI/${need#versioned:}" || true
      curl -fsS -o /dev/null -X PUT "$FLOCI/${need#versioned:}?versioning" -H 'content-type: application/xml' \
        --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
        || { log "versioning did not turn on for ${need#versioned:}"; exit 1; }
      ;;
    script:*) (cd "$ROOT" && bash -c "${need#script:}") >&2 </dev/null || { log "${need#script:} failed"; exit 1; } ;;
    *) log "need '$need' is not image:, profile:, bucket:, versioned: or script:"; exit 2 ;;
  esac
done < <(jq -r '.needs[]' <<<"$entry")

name="hs-$ID"
repo="$USER/$name"
answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$URL/api/v1/$1")" = "$2" ]; }
settle() { local i; for i in $(seq 1 30); do answers "$1" "$2" && return 0; sleep 1; done; log "$1 never answered $2"; return 1; }
api -o /dev/null -X DELETE "$URL/api/v1/repos/$repo" 2>/dev/null || true
settle "repos/$repo" 404
api -o /dev/null -H 'content-type: application/json' -X POST \
  -d "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" "$URL/api/v1/user/repos"
settle "repos/$repo" 200
api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
for who in "$TERRAGUCCI_FORGEJO_AUTHOR" "$TERRAGUCCI_FORGEJO_REVIEWER"; do
  api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"write"}' "$URL/api/v1/repos/$repo/collaborators/$who"
done
jq -n --arg d "$TOKEN" '{data: $d}' | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/TERRAGUCCI_FORGEJO_TOKEN"

base="$TG_STATE/scenarios/$ID/base-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$base"
cp -R "$base_src/." "$base/"
[ ! -d "$base/.git" ] || mv "$base/.git" "$base.git-of-source"
if [ ! -d "$base/.forgejo/workflows" ]; then
  (cd "$base" && node "$ROOT/packages/terragucci/dist/terragucci.mjs" init >/dev/null) || { log "terragucci init failed in the base"; exit 1; }
fi
git -C "$base" init -q -b main
git -C "$base" remote add origin "http://$USER:$TOKEN@forgejo:3000/$repo.git"
sha="$(push_tree "$base" "$repo" main "$ID: the base")"
wait_run "$repo" "$sha" >&2 || log "the base's first run did not finish green; the scenario's reset settles it again"

version="$(docker run --rm --entrypoint "$binary" "$(tag_of "$binary")" version 2>/dev/null | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)"
[ -n "$version" ] || { log "the $binary image reported no version"; exit 1; }

echo "REPO=$repo"
echo "BASE_DIR=$base"
echo "BASE_SHA=$sha"
echo "ENGINE_VERSION=$version"
