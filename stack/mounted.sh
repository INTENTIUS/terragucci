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
#                              (a file in it that is the run's own stdout or
#                              stderr keeps what the run wrote to it)
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

# The uid:gid a created container runs as: its --user, or its image's USER,
# with a name looked up in the container's /etc/passwd. Fails when it can't
# tell.
container_owner() { # container id
  local spec u g line
  spec="$(docker inspect -f '{{.Config.User}}' "$1")" || return 1
  u="${spec%%:*}"; g=""
  [ "$spec" = "$u" ] || g="${spec#*:}"
  [ -n "$u" ] || u=0
  case "$u" in
    *[!0-9]*)
      line="$(docker cp "$1:/etc/passwd" - 2>/dev/null | tar -xOf - passwd 2>/dev/null \
        | awk -F: -v n="$u" '$1 == n { print $3 ":" $4; exit }')" || true
      [ -n "$line" ] || return 1
      u="${line%%:*}"; [ -n "$g" ] || g="${line#*:}" ;;
  esac
  case "$g" in ''|*[!0-9]*) g=0 ;; esac
  echo "$u:$g"
}

# Copy a host dir's contents (or a file) to DST in a created container, owned
# by OWNER (uid:gid, from container_owner) as a bind mount's files would be.
# A plain `docker cp` keeps the host uid, and git in the container then
# refuses a repository there ("dubious ownership"). safe.directory does not
# help with a repository used as a remote: git drops GIT_CONFIG_COUNT and
# GIT_CONFIG_PARAMETERS from the upload-pack and receive-pack it starts for a
# local path, and those check ownership again. The copy is a tar stream, with
# its owner and its path set, unpacked at /. With no OWNER, a plain docker cp.
copy_in() { # container id, host path, container path, owner
  local cid="$1" src="$2" dst="$3" rel="${3#/}" uid gid
  local s=""
  local -a own=() name=()
  if [ -z "$4" ]; then
    if [ -d "$src" ]; then docker cp -q "$src/." "$cid:$dst" >/dev/null
    else docker cp -q "$src" "$cid:$dst" >/dev/null; fi
    return
  fi
  uid="${4%%:*}"; gid="${4#*:}"
  # bsdtar (macOS) and GNU tar spell the owner and the rename differently;
  # S keeps a symlink's target as it is.
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    own=(--owner="$uid" --group="$gid" --numeric-owner); name=(--transform); s=s
  else
    own=(--uid "$uid" --gid "$gid"); name=(-s)
  fi
  if [ -d "$src" ]; then
    tar -C "$src" -cf - "${own[@]}" "${name[@]}" "$s,^\\.,$rel,S" . | docker cp -q - "$cid:/" >/dev/null
  else
    tar -C "$(dirname "$src")" -cf - "${own[@]}" "${name[@]}" "$s,^.*\$,$rel,S" "$(basename "$src")" \
      | docker cp -q - "$cid:/" >/dev/null
  fi
}

# A caller may send the run's own output into a file in a dir it copies, as
# `run_copied -v "$work:/repo" ... > "$work/apply.log"`. The shell opened that
# file before the run, so the container has only the empty copy, and the
# copy-back would replace the log with it. Such a file stays the host's: it is
# moved aside (same inode, so the open descriptor keeps writing into it) before
# the dir is emptied and moved back over the container's copy after.
# OUTPUT_IDS holds the dev:inode of the caller's stdout and stderr, set by
# run_copied; `stat` on stdin is an fstat with GNU and BSD stat alike (on macOS
# stat of /dev/fd/N gives the descriptor's node, not the file).
OUTPUT_IDS=""
file_id() { # [path]: dev:inode of the path, or of stdin with none
  if [ $# = 0 ]; then stat -c '%d:%i' - 2>/dev/null || stat -f '%d:%i' 2>/dev/null
  else stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null; fi
}

output_file() { # host path: whether it is the caller's stdout or stderr
  local id
  id="$(file_id "$1")" || return 1
  case " $OUTPUT_IDS " in *" $id "*) return 0 ;; esac
  return 1
}

KEEP_OUTPUT=""
keep_output_out() { # host dir
  local f rel id
  KEEP_OUTPUT=""
  for id in $OUTPUT_IDS; do
    while IFS= read -r -d '' f; do
      output_file "$f" || continue
      [ -n "$KEEP_OUTPUT" ] || KEEP_OUTPUT="$(mktemp -d "$(dirname "$1")/.run_copied.XXXXXX")" || return 0
      rel="${f#"$1"/}"
      mkdir -p "$KEEP_OUTPUT/$(dirname "$rel")" && mv "$f" "$KEEP_OUTPUT/$rel"
    done < <(find "$1" -type f -inum "${id#*:}" -print0 2>/dev/null)
  done
}

keep_output_in() { # host dir
  local f rel
  [ -n "$KEEP_OUTPUT" ] || return 0
  while IFS= read -r -d '' f; do
    rel="${f#"$KEEP_OUTPUT"/}"
    mkdir -p "$1/$(dirname "$rel")" && mv -f "$f" "$1/$rel"
  done < <(find "$KEEP_OUTPUT" -type f -print0)
  rm -rf "$KEEP_OUTPUT"
  KEEP_OUTPUT=""
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
  local a spec src rest dst mode cid owner rc=0 i detach=0
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
  cid="$(docker create ${opts[@]+"${opts[@]}"} "$@")" || return 1
  if [ ${#srcs[@]} -gt 0 ]; then
    owner="$(container_owner "$cid")" || owner=""
    for i in "${!srcs[@]}"; do
      copy_in "$cid" "${srcs[$i]}" "${dsts[$i]}" "$owner" || rc=1
    done
  fi
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
  { OUTPUT_IDS="$(file_id <&3) $(file_id <&4)"; } 3>&1 4>&2
  for i in ${srcs[@]+"${!srcs[@]}"}; do
    [ "${ros[$i]}" = 0 ] || continue
    if [ -d "${srcs[$i]}" ]; then
      keep_output_out "${srcs[$i]}"
      find "${srcs[$i]}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      docker cp -q "$cid:${dsts[$i]}/." "${srcs[$i]}" >/dev/null \
        || { echo "run_copied: could not copy ${dsts[$i]} back out of the container" >&2; [ $rc != 0 ] || rc=1; }
      keep_output_in "${srcs[$i]}"
    elif output_file "${srcs[$i]}"; then
      :
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
