#!/usr/bin/env bash
# release-image.sh <name>: build one CI image as the OCI archive a release
# records (chant.config.ts, release.images; chant issue 4657).
#
# chant's cut runs this before the bundle that pins the images is built, and
# `chant release images` runs it again in the publish job; the oci target
# then refuses an archive whose digest is not the one the cut recorded. So
# the archive must come out the same from the same commit: timestamps are
# rewritten from SOURCE_DATE_EPOCH (chant sets it to the commit's time), and
# buildx writes no attestations into it (chant attaches the SBOM and the
# provenance itself). The image carries a bundle built with no digest table,
# as it always has.
#
# Both platforms the images ship for go into one archive, an image index.
# Building arm64 on amd64 needs QEMU's binfmt handlers: the publish workflow
# installs them, and Docker Desktop has them.
set -euo pipefail
name="${1:?usage: release-image.sh <tofu|terraform|terragrunt|choudoufu>}"
case "$name" in tofu | terraform | terragrunt | choudoufu) ;; *) echo "release-image.sh: no CI image named $name" >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
: "${SOURCE_DATE_EPOCH:=$(git log -1 --format=%ct)}"
export SOURCE_DATE_EPOCH
platforms="${TERRAGUCCI_IMAGE_PLATFORMS:-linux/amd64,linux/arm64}"
builder="terragucci-release"

# The bundle the image carries: built without CHANT_RELEASE_DIGESTS, so it is the same in the cut and the publish job.
if [ ! -f packages/terragucci/dist/terragucci.mjs ] || [ "${TERRAGUCCI_IMAGE_REBUILD_CLI:-1}" = 1 ]; then
  env -u CHANT_RELEASE_DIGESTS node scripts/build-cli.mjs >/dev/null
fi

# An OCI archive with timestamps rewritten needs the docker-container driver.
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi

mkdir -p dist/images
docker buildx build --builder "$builder" --no-cache --platform "$platforms" \
  --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  --output "type=oci,dest=dist/images/$name.tar,rewrite-timestamp=true" \
  -f "images/Dockerfile.$name" . >&2
echo "dist/images/$name.tar"
