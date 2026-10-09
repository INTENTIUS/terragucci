#!/usr/bin/env bash
# The GitLab lab: GitLab CE, a gitlab-runner with the docker executor and
# floci, under the compose project tglab (stack/gitlab/docker-compose.yml).
# The GitLab smoke claims run on it (SMOKE_FORGE=gitlab stack/smoke.sh).
#
#   stack/gitlab/gitlab.sh up      start it, mint the root token, register the
#                                  runner, write stack/gitlab/.state/gitlab.env
#   stack/gitlab/gitlab.sh status  its containers, their memory, its volumes' size
#   stack/gitlab/gitlab.sh stop    stop it and keep GitLab's volumes, so the next
#                                  up skips GitLab's first-boot setup
#   stack/gitlab/gitlab.sh down    remove its containers, job containers, network
#                                  and volumes
#
# GitLab is heavy: about 4 GB of memory and 3 GB of image, and several minutes
# to boot under emulation. Nothing starts it but `up`. up refuses when the
# data volume has less than TGLAB_MIN_FREE_GB (40) free.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/.state"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
GITLAB_PORT="${TGLAB_GITLAB_PORT:-8959}"
FLOCI_PORT="${TGLAB_FLOCI_PORT:-4710}"
MIN_FREE_GB="${TGLAB_MIN_FREE_GB:-40}"
NETWORK=tglab
JOB_CACHE=tglab-job-cache
REPO=validate

log() { echo "[gitlab-lab $(date -u +%H:%M:%S)] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so the GitLab lab cannot run."; exit 0; }

free_gb() {
  local vol=/System/Volumes/Data
  [ -d "$vol" ] || vol="${TMPDIR:-/tmp}"
  df -Pk "$vol" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

# The image a job runs in when its pipeline names none: the tofu CI image of
# this tree, built into the local daemon when it is missing. Prints its tag.
ensure_ci_image() {
  local ref
  ref="$(cd "$ROOT" && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "building the CI images (a few minutes the first time)…"
    (cd "$ROOT" && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || die "the CI images did not build; run 'just images' to see why"
  fi
  echo "$ref"
}

up() {
  local started free
  started=$(date +%s)
  free="$(free_gb)"
  if ! docker inspect tglab-gitlab >/dev/null 2>&1 && [ -n "$free" ] && [ "$free" -lt "$MIN_FREE_GB" ]; then
    die "${free} GB free, under TGLAB_MIN_FREE_GB=${MIN_FREE_GB}; GitLab needs about 5 GB more"
  fi
  CI_IMAGE="$(ensure_ci_image)"
  log "starting the tglab stack (GitLab under emulation takes minutes)…"
  "${COMPOSE[@]}" up -d >&2
  for _ in $(seq 1 60); do curl -s -o /dev/null -m 2 "http://localhost:$FLOCI_PORT/" && break; sleep 1; done
  curl -s -o /dev/null -m 2 "http://localhost:$FLOCI_PORT/" || die "floci did not answer on port $FLOCI_PORT"
  # shellcheck source=../gitlab-boot.sh
  . "$HERE/../gitlab-boot.sh"
  GL_URL="http://localhost:$GITLAB_PORT"
  GL_TOKEN="glpat-terragucci-local-0001"
  GL_CONTAINER=tglab-gitlab GL_NETWORK="$NETWORK" GL_CACHE_VOLUME="$JOB_CACHE" GL_RUNNER=tglab-docker CI_IMAGE="$CI_IMAGE" \
    gitlab_boot
  # Avatars from gravatar.com would load from outside the lab.
  glapi -o /dev/null -X PUT "$GL_URL/api/v4/application/settings" --data-urlencode "gravatar_enabled=false" || true
  curl -fsS -o /dev/null -X PUT "http://localhost:$FLOCI_PORT/shop-terraform-state"
  mkdir -p "$STATE"
  {
    echo "export TERRAGUCCI_GITLAB_URL=$GL_URL"
    echo "export TERRAGUCCI_GITLAB_TOKEN=$GL_TOKEN"
    echo "export TERRAGUCCI_GITLAB_USER=root"
    echo "export TERRAGUCCI_GITLAB_REPO=root/$REPO"
    echo "export TERRAGUCCI_FLOCI_URL=http://localhost:$FLOCI_PORT"
    echo "export TGLAB_NETWORK=$NETWORK"
    echo "export TGLAB_JOB_CACHE=$JOB_CACHE"
  } > "$STATE/gitlab.env.new"
  mv "$STATE/gitlab.env.new" "$STATE/gitlab.env"
  log "wrote $STATE/gitlab.env"
  log "ready in $(( $(date +%s) - started ))s: GitLab $GL_URL (root / Tg9QvK3mNt8RpLb2WdHf), floci http://localhost:$FLOCI_PORT"
}

status() {
  local c
  "${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  echo
  # shellcheck disable=SC2046 # one argument per container id
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \
    $(docker ps -q --filter name=^tglab- 2>/dev/null) 2>/dev/null || true
  echo
  docker system df -v 2>/dev/null | awk '/^VOLUME NAME/ { t = 1; print; next } t && NF == 0 { t = 0 } t && $1 ~ /^tglab-/'
  echo
  for c in gitlab/gitlab-ce:17.11.0-ce.0 gitlab/gitlab-runner:v17.11.0; do
    docker image inspect "$c" --format "{{index .RepoTags 0}} {{.Size}}" 2>/dev/null | awk '{ printf "%s %.1f GB\n", $1, $2 / 1e9 }' || true
  done
}

# Job containers belong to the runner, not to compose; one cut off mid-run
# would keep the network from going.
job_containers() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || return 0
  local c
  for c in $(docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}'); do
    case "$c" in runner-*) docker rm -f "$c" >/dev/null && log "removed job container $c" ;; esac
  done
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  stop) job_containers; "${COMPOSE[@]}" stop >&2 ;;
  down)
    job_containers
    "${COMPOSE[@]}" down -v --remove-orphans >&2
    [ ! -f "$STATE/gitlab.env" ] || mv "$STATE/gitlab.env" "$STATE/gitlab.env.down"
    log "tglab removed"
    ;;
  *) sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
