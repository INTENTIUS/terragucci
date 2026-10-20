#!/usr/bin/env bash
# Downloads the docs site's large media into docs-site/public/media/. They live
# as assets of the repository's `site-media` GitHub release, not in git or LFS,
# so a clone doesn't carry them. Each file is pinned by sha256; a file already
# in place with the right hash is left alone.
#
#   scripts/fetch-media.sh
#
# To add or replace a file: upload it to the release
# (`gh release upload site-media <file> --clobber`), then add or update its
# line below with `shasum -a 256 <file>`.
set -euo pipefail

base="https://github.com/INTENTIUS/terragucci/releases/download/site-media"
dest="$(cd "$(dirname "$0")/.." && pwd)/docs-site/public/media"

# name sha256
media=(
  "launch-party.mp4 6acfe8f1645765732aa754348a623a4a757aceb0bd122d913ffe512398ac8a6e"
)

sha256() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

mkdir -p "$dest"
for entry in "${media[@]}"; do
  name="${entry%% *}"; want="${entry##* }"; file="$dest/$name"
  [ -f "$file" ] && [ "$(sha256 "$file")" = "$want" ] && continue
  curl -fsSL --retry 3 -o "$file.part" "$base/$name"
  got="$(sha256 "$file.part")"
  if [ "$got" != "$want" ]; then
    echo "fetch-media: $name has sha256 $got, expected $want ($base/$name)" >&2
    exit 1
  fi
  mv "$file.part" "$file"
  echo "  ✓ $name"
done
