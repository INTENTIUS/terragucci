#!/usr/bin/env bash
# Source after `set -euo pipefail`. Docker Desktop's VM shares host paths with
# containers over virtiofs, and it keeps a host file descriptor open for every
# file a container opened in a bind-mounted host dir, after the file is deleted
# and until Docker Desktop restarts. Deleting the files from inside a later
# container does not let go of them either: a record that emptied every work
# dir from inside a container before removing it still left 13,916 deleted
# files under terragucci-smoke.* work dirs held by the VM, all of them files a
# claim's container had used. So a temp work dir is never bind-mounted:
# run_copied copies it into the container before the run and back out after,
# through the Docker API, and the VM never sees the host path.
#
#   run_copied ARGS...         `docker run ARGS...`, with each -v of a host temp
#                              dir or file copied in and (unless :ro) back out
#   clean_mounted DIR [IMAGE]  remove DIR's .terraform and .terragrunt-cache dirs
#   drop_work DIR [IMAGE]      rm -rf DIR (IMAGE is ignored; kept for callers)
#
# Providers come from the named volume terragucci-job-cache
# (TF_PLUGIN_CACHE_DIR=/cache), so they are not in the work dir to begin with;
# a run copies back only what init still leaves there (symlinks into /cache,
# module copies, lock state), and clean_mounted removes that on the host.
JOB_CACHE_VOLUME="${JOB_CACHE_VOLUME:-terragucci-job-cache}"

# Whether a -v source is a host temp path (a mktemp dir or a file in one),
# which run_copied copies instead of mounting. Named volumes and paths in the
# checkout (the CLI bundle, .state) are mounted as given.
copied_source() { # path
  local p="$1" t="${TMPDIR:-/tmp}"
  t="${t%/}"
  case "$p" in /*) ;; *) return 1 ;; esac
  [ -e "$p" ] || return 1
  case "$p" in "$t"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;; esac
  return 1
}

# `docker run` without bind-mounting host temp paths: the container is created,
# each copied source goes in with `docker cp`, the container runs attached
# (its exit code is returned), each writable one comes back out over the
# emptied host path, and the container is removed. With -d it is started and
# its id printed, as `docker run -d` does; nothing is copied back, and the
# caller removes it. Takes the `docker run` options the stack scripts use; the
# first argument that is not an option is the image, and the rest the command.
run_copied() { # docker run arguments...
  local -a opts=() srcs=() dsts=() ros=() attach=()
  local a spec src rest dst mode cid rc=0 i detach=0
  while [ $# -gt 0 ]; do
    a="$1"; shift
    case "$a" in
      --rm) ;;
      -d|--detach) detach=1 ;;
      -i|--interactive) opts+=(-i); attach=(-i) ;;
      -v|--volume)
        spec="$1"; shift
        src="${spec%%:*}"; rest="${spec#*:}"; dst="${rest%%:*}"; mode=""
        [ "$rest" = "$dst" ] || mode="${rest#*:}"
        if copied_source "$src"; then
          srcs+=("$src"); dsts+=("$dst")
          case ",$mode," in *,ro,*) ros+=(1) ;; *) ros+=(0) ;; esac
        else
          opts+=(-v "$spec")
        fi ;;
      -e|--env|--env-file|-w|--workdir|--network|--name|-u|--user|--entrypoint|-l|--label|-p|--publish|--add-host|--platform|-h|--hostname|--mount|--tmpfs)
        opts+=("$a" "$1"); shift ;;
      -*) opts+=("$a") ;;
      *) set -- "$a" "$@"; break ;;
    esac
  done
  # docker cp leaves the copies owned by another uid than the one git runs as
  # inside, and git then refuses a repository there ("dubious ownership").
  # Trust every path in the container, through the environment, so no git
  # config is written into the copied trees.
  [ ${#srcs[@]} -gt 0 ] && opts+=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e "GIT_CONFIG_VALUE_0=*")
  cid="$(docker create ${opts[@]+"${opts[@]}"} "$@")" || return 1
  for i in ${srcs[@]+"${!srcs[@]}"}; do
    if [ -d "${srcs[$i]}" ]; then
      docker cp -q "${srcs[$i]}/." "$cid:${dsts[$i]}" >/dev/null || rc=1
    else
      docker cp -q "${srcs[$i]}" "$cid:${dsts[$i]}" >/dev/null || rc=1
    fi
  done
  if [ $rc != 0 ]; then
    echo "run_copied: could not copy the work dir into the container" >&2
    docker rm -f "$cid" >/dev/null 2>&1 || true
    return 1
  fi
  if [ $detach = 1 ]; then
    docker start "$cid" >/dev/null || { docker rm -f "$cid" >/dev/null 2>&1 || true; return 1; }
    echo "$cid"
    return 0
  fi
  docker start -a ${attach[@]+"${attach[@]}"} "$cid" || rc=$?
  for i in ${srcs[@]+"${!srcs[@]}"}; do
    [ "${ros[$i]}" = 0 ] || continue
    if [ -d "${srcs[$i]}" ]; then
      find "${srcs[$i]}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      docker cp -q "$cid:${dsts[$i]}/." "${srcs[$i]}" >/dev/null \
        || { echo "run_copied: could not copy ${dsts[$i]} back out of the container" >&2; [ $rc != 0 ] || rc=1; }
    else
      docker cp -q "$cid:${dsts[$i]}" "${srcs[$i]}" >/dev/null \
        || { echo "run_copied: could not copy ${dsts[$i]} back out of the container" >&2; [ $rc != 0 ] || rc=1; }
    fi
  done
  docker rm -f "$cid" >/dev/null 2>&1 || true
  return $rc
}

# Work dirs are copied, not mounted, so this runs on the host.
clean_mounted() { # dir [image]
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" \( -name .terraform -o -name .terragrunt-cache \) -prune -exec rm -rf {} + 2>/dev/null || true
}

drop_work() { # dir [image]
  [ -n "${1:-}" ] || return 0
  rm -rf "$1"
}
