#!/usr/bin/env bash
#
# Bring up one profile of the validation stack and print the env vars a
# validation run needs.
#
#   stack/bootstrap.sh forgejo        floci + Forgejo + forgejo-runner
#   stack/bootstrap.sh github         floci + the mock GitHub API (the runner is act, on the host)
#   stack/bootstrap.sh gitlab         floci + GitLab CE + gitlab-runner (GitLab runs under emulation on arm64)
#   stack/bootstrap.sh aws            floci alone
#   stack/bootstrap.sh observability  an OpenTelemetry collector, Prometheus, Tempo and Grafana
#   stack/bootstrap.sh fountain       floci + fountain + a fountain runner for a steward
#
# For each forge it also mints a token, registers the runner where there is
# one to register, and creates the repo the claims push to. Re-running it is
# safe: the admin is reused, a token that still works is kept (so a smoke run
# in progress keeps working), a runner that is already online with the same
# capacity is kept, and an existing repo is left alone.
#
# The env vars go to stdout as `export` lines and to stack/.state/<profile>.env,
# which stack/validate.sh reads, so `eval "$(stack/bootstrap.sh forgejo)"` is
# optional. Progress goes to stderr.
#
# fountain starts floci, fountain and a fountain runner whose sandboxes run the
# steward's turns. It builds the runner's image (stack/fountain/Dockerfile),
# registers the admin account, mints an API key (an existing key that still
# authenticates is kept) and starts the runner with it. stack/steward.sh
# declares the steward for a repo on top of it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-forgejo}"
STATE="$HERE/.state"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --project-name terragucci)

FORGEJO_PORT="${TERRAGUCCI_FORGEJO_PORT:-3300}"
FLOCI_PORT="${TERRAGUCCI_FLOCI_PORT:-4580}"
GITHUB_PORT="${TERRAGUCCI_GITHUB_PORT:-8198}"
GITLAB_PORT="${TERRAGUCCI_GITLAB_PORT:-8939}"
FOUNTAIN_PORT="${TERRAGUCCI_FOUNTAIN_PORT:-4010}"
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
JOB_IMAGE="public.ecr.aws/docker/library/node:22-bookworm"

# Jobs the Forgejo runner runs at once. The smoke runner runs several claims
# together; apply-serial's BREAK run holds the runner alone, so its applies are
# ordered by the concurrency group, never by a lack of free slots.
RUNNER_CAPACITY="${TERRAGUCCI_RUNNER_CAPACITY:-8}"

log() { echo "[bootstrap] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

ensure_image() { # ref: pull once, retrying; an ECR Public library image falls back to Docker Hub's
  local ref="$1" i hub
  docker image inspect "$ref" >/dev/null 2>&1 && return 0
  for i in 1 2 3 4 5; do
    log "pulling $ref (attempt $i)…"
    docker pull -q "$ref" >&2 && return 0
    sleep $((i * 5))
  done
  case "$ref" in
    public.ecr.aws/docker/library/*) hub="docker.io/library/${ref##*/library/}" ;;
    *) die "could not pull $ref" ;;
  esac
  log "ECR Public refused $ref; pulling $hub instead"
  for i in 1 2 3; do
    docker pull -q "$hub" >&2 && docker tag "$hub" "$ref" && return 0
    sleep $((i * 5))
  done
  die "could not pull $ref or $hub"
}
ensure_job_image() { ensure_image "$JOB_IMAGE"; }

# Every ECR Public image the compose file names, pulled once before any
# profile starts: hosted CI runners share an IP, and ECR Public's anonymous
# limit answers parallel pulls with "toomanyrequests: Rate exceeded".
ensure_stack_images() {
  local ref
  for ref in $(sed -n 's/^ *image: *\(public\.ecr\.aws\/[^ ]*\).*/\1/p' "$HERE/docker-compose.yml" | sort -u); do
    ensure_image "$ref"
  done
}

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

write_env() { # profile, then KEY=VALUE pairs; written whole, then moved into place, so a reader never sees half
  local profile="$1"; shift
  mkdir -p "$STATE"
  local kv tmp="$STATE/$profile.env.$$" # per process: two bootstraps at once must not move each other's file
  : > "$tmp"
  for kv in "$@"; do
    echo "export $kv" >> "$tmp"
    echo "export $kv"
  done
  mv "$tmp" "$STATE/$profile.env"
  log "wrote $STATE/$profile.env"
}

case "$PROFILE" in
  aws|forgejo|github|gitlab|fountain) ;;
  observability)
    log "starting the observability profile…"
    ensure_stack_images
    "${COMPOSE[@]}" --profile observability up -d >&2
    wait_http "http://localhost:${TERRAGUCCI_OTEL_HEALTH_PORT:-13143}/" "the collector" 30
    wait_http "http://localhost:${TERRAGUCCI_PROMETHEUS_PORT:-9190}/-/ready" "Prometheus" 30
    wait_http "http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}/api/health" "Grafana" 60
    write_env observability "TERRAGUCCI_OTLP_URL=http://localhost:${TERRAGUCCI_OTLP_PORT:-4328}" "TERRAGUCCI_PROMETHEUS_URL=http://localhost:${TERRAGUCCI_PROMETHEUS_PORT:-9190}" "TERRAGUCCI_GRAFANA_URL=http://localhost:${TERRAGUCCI_GRAFANA_PORT:-3310}"
    exit 0
    ;;
  *) die "unknown profile '$PROFILE' (aws, forgejo, observability, github, gitlab, fountain)" ;;
esac

# The pipelines terragucci generates run in its tofu image. Before an image is
# published, build it into the local daemon, where both runners find it
# without pulling.
ensure_ci_image() {
  local ref
  ref="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "building the CI images (a few minutes the first time)…"
    (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || die "the CI images did not build; run 'just images' to see why"
  fi
  CI_IMAGE="$ref"
}

# ── fountain ───────────────────────────────────────────────────────────────
if [ "$PROFILE" = fountain ]; then
  started=$(date +%s)
  FOUNTAIN_URL="http://localhost:${FOUNTAIN_PORT}"
  STEWARD_IMAGE="terragucci-fountain-steward:local"
  # The runner's image: the tofu CI image, the fountain CLI of the server's
  # release, and the chant terragucci pins. A label records all three, so a
  # change to any of them rebuilds it.
  ensure_ci_image
  fountain_version="$(sed -n 's#.*image: ghcr.io/managoat/fountain:\(v[0-9.]*\)@.*#\1#p' "$HERE/docker-compose.yml")"
  chant_version="$(jq -r '.devDependencies["@intentius/chant"]' "$HERE/../package.json")"
  [ -n "$fountain_version" ] && [ "$chant_version" != null ] || die "cannot read the fountain or chant version to build the steward image"
  # After `just chant-local`, node_modules holds a local chant build marked
  # with its commit; the steward installs the same build from .chant-local/.
  chant_local="$(jq -r '.chantLocal.commit // empty' "$HERE/../node_modules/@intentius/chant/package.json" 2>/dev/null || true)"
  local_args=()
  if [ -n "$chant_local" ]; then
    [ -f "$HERE/../.chant-local/intentius-chant-lexicon-fountain.tgz" ] || die "node_modules has chant $chant_local but .chant-local/ has no fountain tarball; run 'just chant-local' again"
    chant_version="local-$chant_local"
    local_args=(--build-context "chant-local=$HERE/../.chant-local")
  fi
  want="$CI_IMAGE fountain=$fountain_version chant=$chant_version"
  have="$(docker image inspect -f '{{index .Config.Labels "terragucci.steward"}}' "$STEWARD_IMAGE" 2>/dev/null || true)"
  if [ "$have" != "$want" ]; then
    log "building $STEWARD_IMAGE (fountain $fountain_version, chant $chant_version)…"
    docker build -q --label "terragucci.steward=$want" ${local_args[@]+"${local_args[@]}"} \
      --build-arg "BASE=$CI_IMAGE" --build-arg "FOUNTAIN_VERSION=$fountain_version" --build-arg "CHANT_VERSION=$chant_version" \
      -t "$STEWARD_IMAGE" "$HERE/fountain" >&2 || die "the steward image did not build"
  fi

  log "starting floci, fountain and its database…"
  ensure_stack_images
  "${COMPOSE[@]}" --profile fountain up -d floci fountain-postgres fountain >&2
  wait_http "$FLOCI_URL/" "floci" 60
  wait_http "$FOUNTAIN_URL/health" "fountain" 90

  # The key from an earlier run is kept while it authenticates. Otherwise
  # register the admin (an existing account answers 422 and is kept) and mint
  # a full-scope key, which the runner and a steward's caller both need.
  KEY=""
  [ -f "$STATE/fountain.env" ] && KEY="$(sed -n 's/^export TERRAGUCCI_FOUNTAIN_TOKEN=//p' "$STATE/fountain.env")"
  if [ -n "$KEY" ] && curl -fs -o /dev/null -H "Authorization: Bearer $KEY" "$FOUNTAIN_URL/api/auth/me"; then
    log "the API key from the last run still authenticates"
  else
    body="$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PW" '{email: $e, password: $p}')"
    reg="$(mktemp)"
    code="$(curl -s -o "$reg" -w '%{http_code}' -H 'content-type: application/json' -d "$body" "$FOUNTAIN_URL/api/auth/register" || true)"
    case "$code" in
      2*) log "registered $ADMIN_EMAIL" ;;
      409) log "$ADMIN_EMAIL is registered already" ;;
      # 422 is both "taken" and "password refused"; only the first is fine.
      422) grep -q 'already been taken' "$reg" || die "fountain refused the registration: $(cat "$reg")"
           log "$ADMIN_EMAIL is registered already" ;;
      *) die "fountain answered ${code:-nothing} to the registration: $(cat "$reg")" ;;
    esac
    rm -f "$reg"
    KEY="$(curl -fsS -H 'content-type: application/json' -d "$body" "$FOUNTAIN_URL/api/auth/token" | jq -r '.api_key // empty')"
    [ -n "$KEY" ] || die "fountain minted no API key for $ADMIN_EMAIL"
  fi

  log "starting the fountain runner…"
  ensure_stack_images
  TERRAGUCCI_FOUNTAIN_API_KEY="$KEY" "${COMPOSE[@]}" --profile fountain up -d fountain-runner >&2
  for i in $(seq 1 60); do
    curl -fsS -H "Authorization: Bearer $KEY" "$FOUNTAIN_URL/api/runners" 2>/dev/null \
      | jq -e '.data | map(select(.name == "terragucci" and .online)) | length > 0' >/dev/null 2>&1 \
      && { log "runner online after ~$((i * 2))s"; break; }
    sleep 2
    if [ "$i" = 60 ]; then "${COMPOSE[@]}" logs --tail=40 fountain-runner >&2 || true; die "the fountain runner did not come online"; fi
  done
  write_env fountain \
    "TERRAGUCCI_FOUNTAIN_URL=$FOUNTAIN_URL" \
    "TERRAGUCCI_FOUNTAIN_TOKEN=$KEY" \
    "TERRAGUCCI_FOUNTAIN_STEWARD_IMAGE=$STEWARD_IMAGE" \
    "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
  log "ready in $(( $(date +%s) - started ))s"
  exit 0
fi

started=$(date +%s)
log "starting the $PROFILE profile…"
ensure_stack_images
"${COMPOSE[@]}" --profile "$PROFILE" up -d >&2
wait_http "$FLOCI_URL/" "floci" 60

if [ "$PROFILE" = "aws" ]; then
  write_env aws "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
  log "ready in $(( $(date +%s) - started ))s"
  exit 0
fi

# ── github ─────────────────────────────────────────────────────────────────
if [ "$PROFILE" = "github" ]; then
  command -v act >/dev/null 2>&1 || die "act is not installed; the github profile runs workflows with it (brew install act)"
  GITHUB_URL="http://localhost:${GITHUB_PORT}"
  GITHUB_TOKEN="${TERRAGUCCI_GITHUB_TOKEN:-tg-mock-github-token}"
  GITHUB_USER="terragucci-admin"
  wait_http "$GITHUB_URL/__mock/health" "the mock GitHub" 60
  # An existing repo answers 422 and is kept.
  curl -s -o /dev/null -H "Authorization: Bearer $GITHUB_TOKEN" -H 'content-type: application/json' \
    -d "{\"name\":\"$REPO\",\"default_branch\":\"main\"}" "$GITHUB_URL/api/v3/user/repos"
  ensure_ci_image
  write_env github \
    "TERRAGUCCI_GITHUB_URL=$GITHUB_URL" \
    "TERRAGUCCI_GITHUB_TOKEN=$GITHUB_TOKEN" \
    "TERRAGUCCI_GITHUB_USER=$GITHUB_USER" \
    "TERRAGUCCI_GITHUB_REPO=$GITHUB_USER/$REPO" \
    "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
  log "ready in $(( $(date +%s) - started ))s"
  exit 0
fi

# ── gitlab ─────────────────────────────────────────────────────────────────
# stack/gitlab-boot.sh, which the GitLab lab (stack/gitlab/gitlab.sh) runs too.
if [ "$PROFILE" = "gitlab" ]; then
  ensure_ci_image
  # shellcheck source=gitlab-boot.sh
  . "$HERE/gitlab-boot.sh"
  GL_URL="http://localhost:${GITLAB_PORT}"
  GL_TOKEN="glpat-terragucci-local-0001"
  GL_CONTAINER=terragucci-gitlab GL_NETWORK="$NETWORK" GL_CACHE_VOLUME=terragucci-job-cache GL_RUNNER=terragucci-docker \
    gitlab_boot
  write_env gitlab \
    "TERRAGUCCI_GITLAB_URL=$GL_URL" \
    "TERRAGUCCI_GITLAB_TOKEN=$GL_TOKEN" \
    "TERRAGUCCI_GITLAB_USER=root" \
    "TERRAGUCCI_GITLAB_REPO=root/$REPO" \
    "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
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
# A token from an earlier run that still signs in as the admin is kept: claims
# running in parallel hold it, and replacing it would fail their next call.
# Every worktree of this repo shares the one stack, so a working token held by
# another worktree is reused too: minting would delete it under that
# worktree's claims.
token_works() {
  [ -n "$1" ] && [ "$(curl -fsS -H "Authorization: token $1" "$FORGEJO_URL/api/v1/user" 2>/dev/null | jq -r '.login // empty' 2>/dev/null)" = "$ADMIN_USER" ]
}
TOKEN=""
for env in "$STATE/forgejo.env" $(git -C "$HERE" worktree list --porcelain 2>/dev/null | sed -n 's|^worktree \(.*\)|\1/stack/.state/forgejo.env|p'); do
  [ -f "$env" ] || continue
  t="$(sed -n 's/^export TERRAGUCCI_FORGEJO_TOKEN=//p' "$env")"
  if token_works "$t"; then
    TOKEN="$t"
    [ "$env" = "$STATE/forgejo.env" ] || log "reusing the API token of $(dirname "$(dirname "$(dirname "$env")")")"
    break
  fi
done
if [ -n "$TOKEN" ]; then
  log "keeping the API token, which still works"
else
  log "minting an API token…"
  curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PW" -X DELETE \
    "$FORGEJO_URL/api/v1/users/$ADMIN_USER/tokens/terragucci" || true
  TOKEN="$(curl -fsS -u "$ADMIN_USER:$ADMIN_PW" -H 'content-type: application/json' \
    -d '{"name":"terragucci","scopes":["all"]}' \
    "$FORGEJO_URL/api/v1/users/$ADMIN_USER/tokens" | jq -r '.sha1')"
  [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || die "could not mint a token"
fi
api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }

# Pull the job image once, before any job runs. The runner (force_pull: false)
# pulls only an image the daemon lacks, so without this the first jobs, up to
# RUNNER_CAPACITY at once, each ask ECR Public for it, and its anonymous rate
# limit (per source IP, shared on hosted CI runners) answers
# "toomanyrequests: Rate exceeded" and fails the job before its first step.
# Retry with backoff; if ECR Public keeps refusing, take the same official
# image from Docker Hub (which CI reaches through its registry mirror) and tag
# it under JOB_IMAGE, the name the runner's labels ask for.
ensure_job_image

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

# A config written before the runner carried the AWS environment, or with
# another capacity, is replaced.
if "${COMPOSE[@]}" exec -T forgejo-runner grep -q AWS_ENDPOINT_URL /data/config.yml 2>/dev/null \
  && "${COMPOSE[@]}" exec -T forgejo-runner grep -qx "  capacity: ${RUNNER_CAPACITY}" /data/config.yml 2>/dev/null \
  && runner_online; then
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
  capacity: ${RUNNER_CAPACITY}
  timeout: 30m
  shutdown_timeout: 0s
  fetch_interval: 2s
  report_interval: 1s
  envs:
    # Read by the install steps and by tofu itself.
    TOFU_INSTALL_DIR: /cache/bin
    TF_PLUGIN_CACHE_DIR: /cache
    # Every job's AWS is floci, the way a CI runner in a real account carries
    # that account's credentials. Pipelines and roots name no endpoint.
    AWS_ENDPOINT_URL: http://floci:4566
    AWS_ACCESS_KEY_ID: test
    AWS_SECRET_ACCESS_KEY: test
    AWS_REGION: us-east-1
  labels:
    - "docker:docker://${JOB_IMAGE}"
    - "ubuntu-latest:docker://${JOB_IMAGE}"
cache:
  enabled: false
container:
  network: ${NETWORK}
  privileged: false
  # A job's workspace (workdir_parent, /workspace) is a named volume the
  # runner creates for the job and removes with its container when the job
  # ends: forgejo-runner never bind-mounts a host workdir. With valid_volumes
  # naming only the cache volume, no job mounts a host path either, so a
  # job's .terraform and providers never sit in host files that Docker
  # Desktop's VM could keep open after they are deleted.
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

# The generated pipelines' jobs run in terragucci's images, named by tag
# alone once the claims drop init's digest pins (validate-generated.sh), so
# the runner takes this tree's build.
ensure_ci_image

write_env forgejo \
  "TERRAGUCCI_FORGEJO_URL=$FORGEJO_URL" \
  "TERRAGUCCI_FORGEJO_TOKEN=$TOKEN" \
  "TERRAGUCCI_FORGEJO_USER=$ADMIN_USER" \
  "TERRAGUCCI_FORGEJO_REPO=$ADMIN_USER/$REPO" \
  "TERRAGUCCI_FLOCI_URL=$FLOCI_URL"
log "ready in $(( $(date +%s) - started ))s"
