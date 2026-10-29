#!/usr/bin/env bash
#
# The repo a harness scenario plays on (terragucci#1295), made before its
# first step: stack/harness/harness.ts run calls it.
#
#   stack/harness/seed.sh <scenario id>
#
# It reads the scenario's tree.base and its line in scenarios/index.json. A
# line with a source reads the tree from another repo instead:
#
#   <repo>:<path>                INTENTIUS/<repo>, from DEMO_<REPO>_TREES or the
#                                clone stack/demo.sh keeps under the state
#                                directory, at DEMO_<REPO>_TREES_REF (default
#                                main), as the demo reads choudoufu's trees
#   <owner>/<repo>@<ref>:<path>  github.com/<owner>/<repo> at that commit, in a
#                                clone under the state directory (trees/)
#
# and the line's into (a directory of the base the tree goes in), lift (moves
# inside the base, from:to, such as a tree's forgejo/.forgejo to .forgejo),
# secrets and vars (the repo's Actions secrets and variables) shape the repo.
# The line's fixtures name directories of stack/harness/fixtures/ copied into
# the base first, with @REPO@ in each file read as the repo's <owner>/<name>:
# templates is the fixture module registry the template scenarios read (its
# catalog, the registry protocol's files and the modules, served by the repo's
# own files on Forgejo).
# A seed/ directory beside the scenario file is copied over the base before
# terragucci init, for what a sourced tree lacks (terragucci.yml, a backend).
# The line's recordStore names a choudoufu sidecar in the base whose s3
# record store is made in floci, with versioning, a noncurrent-version
# lifecycle rule and the public access block, and whose bucket_owner is
# rewritten to floci's account, as the tree's own smoke does.
#
# Then it:
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
# BASE_SHA= and ENGINE_VERSION=: the choudoufu release the tree's own
# workflows download, when they download one, and otherwise the version the
# binary's CI image reports.
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
base_src=""
source="$(jq -r '.source // empty' <<<"$entry")"
case "$source" in
  */*@*:*)
    # github.com/<owner>/<repo> at a commit.
    gh_repo="${source%%@*}"; rest="${source#*@}"; gh_ref="${rest%%:*}"; src_path="${rest#*:}"
    checkout="$TG_STATE/trees/${gh_repo//\//-}"
    if [ ! -d "$checkout/.git" ]; then
      mkdir -p "$(dirname "$checkout")"
      log "cloning $gh_repo into $checkout for its tree"
      git clone -q --filter=blob:none "https://github.com/$gh_repo.git" "$checkout" >&2
    fi
    git -C "$checkout" fetch -q origin "$gh_ref" && git -C "$checkout" checkout -q --detach FETCH_HEAD \
      || { log "could not fetch $gh_ref of $gh_repo"; exit 1; }
    source=""
    base_src="$checkout/$src_path"
    [ -d "$base_src" ] || { log "$src_path is not in $gh_repo at $gh_ref"; exit 1; }
    ;;
esac
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
elif [ -z "${base_src:-}" ]; then
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
while IFS=$'\t' read -r k v; do
  [ -n "$k" ] || continue
  jq -n --arg d "$v" '{data: $d}' | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/$k"
done < <(jq -r '(.secrets // {}) | to_entries[] | [.key, .value] | @tsv' <<<"$entry")
while IFS=$'\t' read -r k v; do
  [ -n "$k" ] || continue
  jq -n --arg v "$v" '{value: $v}' | api -o /dev/null -H 'content-type: application/json' -X POST -d @- "$URL/api/v1/repos/$repo/actions/variables/$k" \
    || jq -n --arg v "$v" '{value: $v}' | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/variables/$k"
done < <(jq -r '(.vars // {}) | to_entries[] | [.key, .value] | @tsv' <<<"$entry")

base="$TG_STATE/scenarios/$ID/base-$(date +%Y%m%d-%H%M%S)-$$"
into="$(jq -r '.into // empty' <<<"$entry")"
mkdir -p "$base/$into"
(cd "$base_src" && tar --exclude=.git --exclude=node_modules --exclude=.terraform -cf - .) | (cd "$base/$into" && tar -xf -)
while IFS= read -r move; do
  [ -n "$move" ] || continue
  from="${move%%:*}"; to="${move#*:}"
  [ -e "$base/$from" ] || { log "lift: $from is not in the tree"; exit 1; }
  mkdir -p "$(dirname "$base/$to")"
  mv "$base/$from" "$base/$to"
done < <(jq -r '(.lift // [])[]' <<<"$entry")
sidecar="$(jq -r '.recordStore // empty' <<<"$entry")"
if [ -n "$sidecar" ]; then
  [ -f "$base/$sidecar" ] || { log "recordStore: $sidecar is not in the tree"; exit 1; }
  bucket="$(sed -nE 's/^[[:space:]]*bucket[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$base/$sidecar" | head -1)"
  [ -n "$bucket" ] || { log "recordStore: $sidecar names no bucket"; exit 1; }
  s3_put() { # query, xml body: a bucket subresource, with the Content-MD5 S3 asks of these two
    curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?$1" -H 'content-type: application/xml' \
      -H "Content-MD5: $(printf '%s' "$2" | openssl md5 -binary | base64)" --data-binary "$2"
  }
  S3NS='xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || true
  s3_put versioning "<VersioningConfiguration $S3NS><Status>Enabled</Status></VersioningConfiguration>" \
    && s3_put lifecycle "<LifecycleConfiguration $S3NS><Rule><ID>expire-noncurrent</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>" \
    && s3_put publicAccessBlock "<PublicAccessBlockConfiguration $S3NS><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>" \
    || { log "recordStore: s3://$bucket did not take its settings"; exit 1; }
  # floci's account, read from its STS as the tree's smoke reads it. floci
  # checks no signature; the credential scope routes the call.
  account="$(curl -fsS -X POST "$FLOCI/" -H 'content-type: application/x-www-form-urlencoded' \
    -H "Authorization: AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=0" \
    --data 'Action=GetCallerIdentity&Version=2011-06-15' | tr -d '\n' | sed -n 's#.*<Account>\([0-9]*\)</Account>.*#\1#p')"
  [[ "$account" =~ ^[0-9]{12}$ ]] || { log "recordStore: floci reported account '${account}', not twelve digits"; exit 1; }
  if grep -qE '^[[:space:]]*bucket_owner[[:space:]]*=' "$base/$sidecar"; then
    perl -pi -e 's/^(\s*bucket_owner\s*=\s*)"[0-9]+"/$1"'"$account"'"/' "$base/$sidecar"
  fi
  log "record store s3://$bucket on floci, owned by $account"
fi
while IFS= read -r fixture; do
  [ -n "$fixture" ] || continue
  [ -d "$HERE/fixtures/$fixture" ] || { log "fixture $fixture is not in stack/harness/fixtures"; exit 1; }
  (cd "$HERE/fixtures/$fixture" && tar -cf - .) | (cd "$base" && tar -xf -)
  while IFS= read -r f; do perl -pi -e 's#\@REPO\@#'"$repo"'#g' "$base/$f"; done < <(cd "$HERE/fixtures/$fixture" && find . -type f)
  log "fixture $fixture copied into the base, served as $repo"
done < <(jq -r '(.fixtures // [])[]' <<<"$entry")
[ ! -d "$HERE/scenarios/$ID/seed" ] || cp -R "$HERE/scenarios/$ID/seed/." "$base/"
if [ ! -d "$base/.forgejo/workflows" ]; then
  (cd "$base" && node "$ROOT/packages/terragucci/dist/terragucci.mjs" init >/dev/null) || { log "terragucci init failed in the base"; exit 1; }
fi
git -C "$base" init -q -b main
git -C "$base" remote add origin "http://$USER:$TOKEN@forgejo:3000/$repo.git"
sha="$(push_tree "$base" "$repo" main "$ID: the base")"
wait_run "$repo" "$sha" >&2 || log "the base's first run did not finish green; the scenario's reset settles it again"

# The engine the row names: a tree whose workflows download their own
# choudoufu runs that release (cross-estate-dependency's v0.18.0), not the
# CI image's.
version=""
if [ "$binary" = choudoufu ] && [ -d "$base/.forgejo/workflows" ]; then
  pinned="$(grep -rhoE 'choudoufu/releases/download/v[0-9]+\.[0-9]+\.[0-9]+' "$base/.forgejo/workflows" | sed 's#.*/download/##' | sort -u || true)"
  case "$(printf '%s' "$pinned" | grep -c . || true)" in
    0) ;;
    1) version="$pinned"; log "the tree's workflows download choudoufu $version" ;;
    *) log "the tree's workflows download several choudoufu releases ($(echo $pinned)); the row cannot name one"; exit 1 ;;
  esac
fi
[ -n "$version" ] || version="$(docker run --rm --entrypoint "$binary" "$(tag_of "$binary")" version 2>/dev/null | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)"
[ -n "$version" ] || { log "the $binary image reported no version"; exit 1; }

echo "REPO=$repo"
echo "BASE_DIR=$base"
echo "BASE_SHA=$sha"
echo "ENGINE_VERSION=$version"
