#!/usr/bin/env bash
# Source after `set -euo pipefail`. Docker Desktop's VM keeps a deleted
# bind-mounted file open until it restarts, so a work dir that held `.terraform`
# or `.terragrunt-cache` (provider binaries of 400 MB or more) is emptied from
# inside a container while it is still mounted, and only then removed on the host.
#
#   clean_mounted DIR [IMAGE]   remove DIR's .terraform and .terragrunt-cache dirs from inside a container
#   drop_work DIR [IMAGE]       clean_mounted, then rm -rf DIR on the host
#
# Providers themselves come from the named volume terragucci-job-cache
# (TF_PLUGIN_CACHE_DIR=/cache), so they are not in the work dir to begin with;
# this removes what init still leaves there (symlinks, module copies, lock state).
JOB_CACHE_VOLUME="${JOB_CACHE_VOLUME:-terragucci-job-cache}"

clean_mounted() { # dir [image]
  local dir="$1" image="${2:-${SMOKE_TOFU_IMAGE:-}}"
  [ -d "$dir" ] || return 0
  [ -n "$(find "$dir" \( -name .terraform -o -name .terragrunt-cache \) -prune -print -quit 2>/dev/null)" ] || return 0
  if [ -z "$image" ] && declare -F image_tag >/dev/null; then image="$(image_tag tofu 2>/dev/null || true)"; fi
  [ -n "$image" ] || return 0
  docker run --rm -v "$dir:/clean" "$image" \
    sh -c 'find /clean \( -name .terraform -o -name .terragrunt-cache \) -prune -exec rm -rf {} +' >/dev/null 2>&1 || true
}

drop_work() { # dir [image]
  [ -n "${1:-}" ] || return 0
  clean_mounted "$@"
  rm -rf "$1"
}
