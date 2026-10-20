#!/usr/bin/env bash
#
# The opt-in decision service in the local stack (terragucci#29).
#
#   stack/decide.sh up     build terragucci-decide if it is not built, start it, wait until it is healthy
#   stack/decide.sh ask    ask it the three uses' questions (#30, #31, #32) through terragucci's client,
#                          and check it runs on CPU as the pinned model
#   stack/decide.sh down   stop and remove it
#
# REBUILD=1 rebuilds the image on up. The service listens on the terragucci
# network as http://decide:8790 and on the host at localhost:8790
# (TERRAGUCCI_DECIDE_PORT). The first build downloads the CPU torch build and
# the checkpoint (about 1.5 GB in all); the first start loads the checkpoint
# before /health answers, which takes up to a minute on CPU.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --project-name "${TG_PROJECT:-terragucci}" --profile decide)
PORT="${TERRAGUCCI_DECIDE_PORT:-8790}"

log() { echo "[decide] $*" >&2; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker is not available, so the decision service cannot start."; exit 0
fi

case "${1:-up}" in
  up)
    if [ "${REBUILD:-0}" = 1 ] || ! docker image inspect terragucci-decide:local >/dev/null 2>&1; then
      log "building terragucci-decide (images/Dockerfile.decide)"
      (cd "$ROOT" && npx tsx scripts/images.ts build-decide)
    fi
    "${COMPOSE[@]}" up -d --wait --wait-timeout 600 decide
    log "up: http://localhost:${PORT} on the host, http://decide:8790 on the terragucci network"
    ;;
  ask)
    (cd "$ROOT" && npx tsx scripts/decide-ask.ts "http://localhost:${PORT}")
    ;;
  down)
    "${COMPOSE[@]}" rm --stop --force decide
    ;;
  *)
    echo "usage: stack/decide.sh up|ask|down" >&2; exit 2
    ;;
esac
