#!/usr/bin/env bash
#
# Bring up one profile of the validation stack and print the env vars a
# validation run needs.
#
#   stack/bootstrap.sh forgejo        floci + Forgejo + forgejo-runner
#   stack/bootstrap.sh aws            floci alone
#
# For forgejo it also mints an admin and an API token, registers the runner
# and creates the repo the claims push to. Re-running it is safe: the admin is
# reused, the token is replaced, a runner that is already online is kept, and
# an existing repo is left alone.
#
# The env vars go to stdout as `export` lines and to stack/.state/<profile>.env,
# which stack/validate.sh reads, so `eval "$(stack/bootstrap.sh forgejo)"` is
# optional. Progress goes to stderr.
#
# github, gitlab and fountain are declared in docker-compose.yml but not
# validated; this script refuses them unless TERRAGUCCI_UNVALIDATED=1, and then
# only starts their containers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-forgejo}"
STATE="$HERE/.state"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --project-name terragucci)

FORGEJO_PORT="${TERRAGUCCI_FORGEJO_PORT:-3300}"
FLOCI_PORT="${TERRAGUCCI_FLOCI_PORT:-4580}"
FORGEJO_URL="http://localhost:${FORGEJO_PORT}"
FLOCI_URL="http://localhost:${FLOCI_PORT}"
NETWORK="terragucci"

# A throwaway instance on localhost; these never leave the machine.
ADMIN_USER="terragucci-admin"
ADMIN_PW="Terragucci-local-pw-1234"
ADMIN_EMAIL="terragucci-admin@example.com"
REPO="validate"

# The image every job runs in, under both labels a workflow may ask for. The
# chant forgejo dialect maps ubuntu-latest to docker.
JOB_IMAGE="node:22-bookworm"

log() { echo "[bootstrap] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

wait_http() { # url, label, tries (2s apart)
  local i
  for i in $(seq 1 "$3"); do
    local code
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then log "$2 answered ($code) after ~$((i * 2))s"; return 0; fi
    sleep 2
  done
  "${COMPOSE[@]}" --profile "$PROFILE" logs --tail=60 >&2 || true
  die "$2 did not answer on $1"
}

write_env() { # profile, then KEY=VALUE pairs
  local profile="$1"; shift
  mkdir -p "$STATE"
  : > "$STATE/$profile.env"
  local kv
  for kv in "$@"; do
    echo "export $kv" >> "$STATE/$profile.env"
    echo "export $kv"
  done
  log "wrote $STATE/$profile.env"
}

case "$PROFILE" in
  aws|forgejo) ;;
  github|gitlab|fountain)
    if [ "${TERRAGUCCI_UNVALIDATED:-}" != "1" ]; then
      die "the $PROFILE profile is declared but not validated yet (see stack/README.md). Set TERRAGUCCI_UNVALIDATED=1 to start its containers anyway."
    fi
    log "starting the $PROFILE profile's containers; nothing is configured or checked"
    "${COMPOSE[@]}" --profile "$PROFILE" up -d >&2
    exit 0
    ;;
  *) die "unknown profile '$PROFILE' (aws, forgejo, github, gitlab, fountain)" ;;
esac

started=$(date +%s)
log "starting the $PROFILE profile…"
"${COMPOSE[@]}" --profile "$PROFILE" up -d >&2
wait_http "$FLOCI_URL/" "floci" 60

if [ "$PROFILE" = "aws" ]; then
  write_env aws "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
  log "ready in $(( $(date +%s) - started ))s"
  exit 0
fi

# ── forgejo ────────────────────────────────────────────────────────────────
wait_http "$FORGEJO_URL/api/v1/version" "Forgejo" 90
log "Forgejo $(curl -fsS "$FORGEJO_URL/api/v1/version")"

log "creating the admin user (an existing one is reused)…"
if ! curl -fs -o /dev/null -u "$ADMIN_USER:$ADMIN_PW" "$FORGEJO_URL/api/v1/user"; then
  "${COMPOSE[@]}" exec -T -u git forgejo forgejo admin user create \
    --admin --username "$ADMIN_USER" --password "$ADMIN_PW" \
    --email "$ADMIN_EMAIL" --must-change-password=false >&2
fi

# Basic auth mints the token, so a re-run deletes the old one by name and
# creates a fresh one rather than piling up tokens or failing on the name.
log "minting an API token…"
curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PW" -X DELETE \
  "$FORGEJO_URL/api/v1/users/$ADMIN_USER/tokens/terragucci" || true
TOKEN="$(curl -fsS -u "$ADMIN_USER:$ADMIN_PW" -H 'content-type: application/json' \
  -d '{"name":"terragucci","scopes":["all"]}' \
  "$FORGEJO_URL/api/v1/users/$ADMIN_USER/tokens" | jq -r '.sha1')"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || die "could not mint a token"
api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }

# Runner registration on Forgejo 16 / forgejo-runner 13. `forgejo-runner
# register` and `create-runner-file` are both marked deprecated; the current
# path is to create the runner on the server (POST /admin/actions/runners),
# which returns a uuid and a token, and to name that pair in the runner's
# config under server.connections. The config also carries the two things
# that make jobs work here: container.network puts every job container on the
# terragucci network, and container.options mounts the shared cache volume.
runner_online() {
  api "$FORGEJO_URL/api/v1/admin/actions/runners" \
    | jq -e 'map(select(.name == "terragucci-docker" and .status != "offline")) | length > 0' >/dev/null 2>&1
}

if "${COMPOSE[@]}" exec -T forgejo-runner test -s /data/config.yml 2>/dev/null && runner_online; then
  log "the runner is already registered and online"
else
  # A runner from an earlier registration that is no longer polling would
  # sit in the list as offline forever; drop it before adding the new one.
  for stale in $(api "$FORGEJO_URL/api/v1/admin/actions/runners" \
      | jq -r '.[] | select(.name == "terragucci-docker" and .status == "offline") | .id'); do
    api -o /dev/null -X DELETE "$FORGEJO_URL/api/v1/admin/actions/runners/$stale" || true
  done
  log "registering forgejo-runner…"
  REG="$(api -H 'content-type: application/json' -X POST \
    -d '{"name":"terragucci-docker","description":"terragucci stack, docker executor"}' \
    "$FORGEJO_URL/api/v1/admin/actions/runners")"
  RUNNER_UUID="$(echo "$REG" | jq -r '.uuid')"
  RUNNER_TOKEN="$(echo "$REG" | jq -r '.token')"
  [ -n "$RUNNER_UUID" ] && [ "$RUNNER_UUID" != "null" ] || die "runner creation returned no uuid: $REG"

  "${COMPOSE[@]}" exec -T forgejo-runner sh -c 'cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml' <<EOF
log:
  level: info
  job_level: info
runner:
  file: /data/.runner
  capacity: 1
  timeout: 30m
  shutdown_timeout: 0s
  fetch_interval: 2s
  report_interval: 1s
  envs:
    # Read by the fixture workflow's install step and by tofu itself.
    TOFU_INSTALL_DIR: /cache/bin
    TF_PLUGIN_CACHE_DIR: /cache
  labels:
    - "docker:docker://${JOB_IMAGE}"
    - "ubuntu-latest:docker://${JOB_IMAGE}"
cache:
  enabled: false
container:
  network: ${NETWORK}
  privileged: false
  options: "-v terragucci-job-cache:/cache"
  valid_volumes:
    - terragucci-job-cache
  docker_host: "-"
  force_pull: false
server:
  connections:
    forgejo:
      url: http://forgejo:3000/
      uuid: ${RUNNER_UUID}
      token: ${RUNNER_TOKEN}
EOF
  # The runner's entrypoint waits for the config on first boot. On a re-run
  # it is already running with the old credentials, so restart it.
  "${COMPOSE[@]}" restart forgejo-runner >&2

  log "waiting for the runner to come online…"
  for i in $(seq 1 60); do
    runner_online && { log "runner online after ~$((i * 2))s"; break; }
    sleep 2
    if [ "$i" = 60 ]; then
      "${COMPOSE[@]}" logs --tail=60 forgejo-runner >&2 || true
      die "the runner did not come online"
    fi
  done
fi

log "creating $ADMIN_USER/$REPO (an existing one is kept)…"
if ! api -o /dev/null "$FORGEJO_URL/api/v1/repos/$ADMIN_USER/$REPO" 2>/dev/null; then
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$REPO\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" \
    "$FORGEJO_URL/api/v1/user/repos"
fi
# Actions is on in the instance; make sure the repo has the unit enabled.
api -o /dev/null -H 'content-type: application/json' -X PATCH \
  -d '{"has_actions":true}' "$FORGEJO_URL/api/v1/repos/$ADMIN_USER/$REPO"

write_env forgejo \
  "TERRAGUCCI_FORGEJO_URL=$FORGEJO_URL" \
  "TERRAGUCCI_FORGEJO_TOKEN=$TOKEN" \
  "TERRAGUCCI_FORGEJO_USER=$ADMIN_USER" \
  "TERRAGUCCI_FORGEJO_REPO=$ADMIN_USER/$REPO" \
  "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
log "ready in $(( $(date +%s) - started ))s"
