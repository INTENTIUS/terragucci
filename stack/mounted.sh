#!/usr/bin/env bash
# Source after `set -euo pipefail`. Docker Desktop's VM keeps a deleted
# bind-mounted file open until it restarts, so a work dir that held `.terraform`
# or `.terragrunt-cache` (provider binaries of 400 MB or more) is emptied from
# inside a container while it is still mounted, and only then removed on the host.
# The same holds for every other file a container saw in a bind-mounted work dir
# (.git/hooks, the wave, plan and drift trees, chant.workspace.json), so a work
# dir is emptied from inside a container before the host removes it.
#
#   clean_mounted DIR [IMAGE]   remove DIR's .terraform and .terragrunt-cache dirs from inside a container
#   empty_mounted DIR [IMAGE]   remove everything under DIR from inside a container
#   drop_work DIR [IMAGE]       empty_mounted, then rm -rf DIR on the host
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

# Runs as root, so files a container wrote as another user go too. Skipped when
# the image is not on the host (no stack, or no docker): a dir no container
# mounted holds nothing in the VM.
empty_mounted() { # dir [image]
  local dir="$1" image="${2:-${SMOKE_TOFU_IMAGE:-}}"
  [ -d "$dir" ] || return 0
  [ -n "$(find "$dir" -mindepth 1 -print -quit 2>/dev/null)" ] || return 0
  if [ -z "$image" ] && declare -F image_tag >/dev/null; then image="$(image_tag tofu 2>/dev/null || true)"; fi
  [ -n "$image" ] || return 0
  docker image inspect "$image" >/dev/null 2>&1 || return 0
  docker run --rm --user 0:0 -v "$dir:/clean" "$image" \
    sh -c 'find /clean -mindepth 1 -maxdepth 1 -exec rm -rf {} +' >/dev/null 2>&1 || true
}

drop_work() { # dir [image]
  [ -n "${1:-}" ] || return 0
  empty_mounted "$@"
  rm -rf "$1"
}
