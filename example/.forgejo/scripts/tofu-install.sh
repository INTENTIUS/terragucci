#!/bin/sh
# Installs OpenTofu once per stack into the runner's shared cache.
set -eu
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac
dir="${TOFU_INSTALL_DIR:-/tmp/tofu}/$TOFU_VERSION"
if [ ! -x "$dir/tofu" ]; then
  mkdir -p "$dir"
  tmp="$(mktemp -d "$dir.XXXX")"
  curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.tar.gz" | tar -xz -C "$tmp" tofu
  mv -f "$tmp/tofu" "$dir/tofu"
  rm -rf "$tmp"
fi
echo "$dir" >> "$GITHUB_PATH"
