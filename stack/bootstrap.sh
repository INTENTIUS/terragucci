#!/usr/bin/env bash
#
# Bring up one profile of the validation stack and print the env vars a
# validation run needs.
#
#   stack/bootstrap.sh forgejo        floci + Forgejo + forgejo-runner
#   stack/bootstrap.sh github         floci + the mock GitHub API (the runner is act, on the host)
#   stack/bootstrap.sh gitlab         floci + GitLab CE + gitlab-runner (GitLab runs under emulation on arm64)
#   stack/bootstrap.sh aws            floci alone
#   stack/bootstrap.sh observability  an OpenTelemetry collector and Prometheus
#   stack/bootstrap.sh fountain       floci + fountain + a fountain runner for a steward
#
# For each forge it also mints a token, registers the runner where there is
# one to register, and creates the repo the claims push to. Re-running it is
# safe: the admin is reused, the token is replaced, a runner that is already
# online is kept, and an existing repo is left alone.
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
  aws|forgejo|github|gitlab|fountain) ;;
  observability)
    log "starting the observability profile…"
    "${COMPOSE[@]}" --profile observability up -d >&2
    wait_http "http://localhost:${TERRAGUCCI_OTEL_HEALTH_PORT:-13143}/" "the collector" 30
    wait_http "http://localhost:${TERRAGUCCI_PROMETHEUS_PORT:-9190}/-/ready" "Prometheus" 30
    write_env observability "TERRAGUCCI_OTLP_URL=http://localhost:${TERRAGUCCI_OTLP_PORT:-4328}" "TERRAGUCCI_PROMETHEUS_URL=http://localhost:${TERRAGUCCI_PROMETHEUS_PORT:-9190}"
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
  want="$CI_IMAGE fountain=$fountain_version chant=$chant_version"
  have="$(docker image inspect -f '{{index .Config.Labels "terragucci.steward"}}' "$STEWARD_IMAGE" 2>/dev/null || true)"
  if [ "$have" != "$want" ]; then
    log "building $STEWARD_IMAGE (fountain $fountain_version, chant $chant_version)…"
    docker build -q --label "terragucci.steward=$want" \
      --build-arg "BASE=$CI_IMAGE" --build-arg "FOUNTAIN_VERSION=$fountain_version" --build-arg "CHANT_VERSION=$chant_version" \
      -t "$STEWARD_IMAGE" "$HERE/fountain" >&2 || die "the steward image did not build"
  fi

  log "starting floci, fountain and its database…"
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
if [ "$PROFILE" = "gitlab" ]; then
  GITLAB_URL="http://localhost:${GITLAB_PORT}"
  # A throwaway token on a throwaway instance, minted through gitlab-rails the
  # way gitlab-warden's e2e does.
  GITLAB_TOKEN="glpat-terragucci-local-0001"
  # Poll the sign-in page, not /-/health: the monitoring endpoints are
  # restricted by IP and a request from the host arrives from the bridge gateway.
  # Cold boot under emulation takes ten minutes or more.
  log "waiting for GitLab to serve (cold boot under emulation is slow)…"
  for i in $(seq 1 360); do
    curl -fsS -o /dev/null -m 5 "$GITLAB_URL/users/sign_in" 2>/dev/null && { log "serving after ~$((i * 5))s"; break; }
    sleep 5
    [ $((i % 24)) -eq 0 ] && log "still booting… ~$((i * 5))s"
    if [ "$i" = 360 ]; then "${COMPOSE[@]}" --profile gitlab logs --tail=60 gitlab >&2 || true; die "GitLab did not serve in 30 minutes"; fi
  done
  log "minting a root token with gitlab-rails…"
  for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T gitlab gitlab-rails runner "
      u = User.find_by_username('root')
      u.personal_access_tokens.where(name: 'terragucci').delete_all
      t = u.personal_access_tokens.create!(scopes: ['api'], name: 'terragucci', expires_at: 1.day.from_now)
      t.set_token('${GITLAB_TOKEN}'); t.save!
    " >/dev/null 2>&1; then break; fi
    sleep 10
    [ "$i" = 30 ] && die "could not mint a token with gitlab-rails"
  done
  glapi() { curl -fsS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$@"; }
  for i in $(seq 1 12); do glapi -o /dev/null "$GITLAB_URL/api/v4/version" 2>/dev/null && break; sleep 5; done
  glapi -o /dev/null "$GITLAB_URL/api/v4/version" || die "the token does not authenticate"
  log "GitLab $(glapi "$GITLAB_URL/api/v4/version" | jq -r .version)"

  ensure_ci_image
  runner_online() { glapi "$GITLAB_URL/api/v4/runners/all?status=online" | jq -e 'map(select(.description == "terragucci-docker")) | length > 0' >/dev/null 2>&1; }
  if runner_online; then
    log "the runner is already registered and online"
  else
    # Runners from an earlier registration that are no longer polling.
    for stale in $(glapi "$GITLAB_URL/api/v4/runners/all" | jq -r '.[] | select(.description == "terragucci-docker") | .id'); do
      glapi -o /dev/null -X DELETE "$GITLAB_URL/api/v4/runners/$stale" || true
    done
    log "registering gitlab-runner…"
    RUNNER_TOKEN="$(glapi -X POST "$GITLAB_URL/api/v4/user/runners" \
      --data-urlencode "runner_type=instance_type" --data-urlencode "description=terragucci-docker" \
      --data-urlencode "run_untagged=true" | jq -r .token)"
    [ -n "$RUNNER_TOKEN" ] && [ "$RUNNER_TOKEN" != null ] || die "runner creation returned no token"
    "${COMPOSE[@]}" exec -T gitlab-runner rm -f /etc/gitlab-runner/config.toml
    # network mode: job containers join the terragucci network. The cache
    # volume holds the provider plugin cache. Every job's AWS is floci.
    "${COMPOSE[@]}" exec -T gitlab-runner gitlab-runner register --non-interactive \
      --url http://gitlab:8929 --token "$RUNNER_TOKEN" --executor docker \
      --docker-image "$CI_IMAGE" --docker-pull-policy if-not-present \
      --docker-network-mode "$NETWORK" --docker-volumes "terragucci-job-cache:/cache" \
      --env TF_PLUGIN_CACHE_DIR=/cache \
      --env AWS_ENDPOINT_URL=http://floci:4566 --env AWS_ACCESS_KEY_ID=test \
      --env AWS_SECRET_ACCESS_KEY=test --env AWS_REGION=us-east-1 >&2
    # A reconcile run leaves a pipeline running on an untouched project; let
    # the one the claim waits on start beside it.
    "${COMPOSE[@]}" exec -T gitlab-runner sed -i 's/^concurrent = .*/concurrent = 4/' /etc/gitlab-runner/config.toml
    "${COMPOSE[@]}" restart gitlab-runner >&2
    log "waiting for the runner to come online…"
    for i in $(seq 1 60); do
      runner_online && { log "runner online after ~$((i * 2))s"; break; }
      sleep 2
      if [ "$i" = 60 ]; then "${COMPOSE[@]}" logs --tail=40 gitlab-runner >&2 || true; die "the runner did not come online"; fi
    done
  fi

  log "creating root/$REPO (an existing one is kept)…"
  if ! glapi -o /dev/null "$GITLAB_URL/api/v4/projects/root%2F$REPO" 2>/dev/null; then
    glapi -o /dev/null -X POST "$GITLAB_URL/api/v4/projects" \
      --data-urlencode "name=$REPO" --data-urlencode "visibility=public" --data-urlencode "initialize_with_readme=false" \
      --data-urlencode "default_branch=main"
  fi
  write_env gitlab \
    "TERRAGUCCI_GITLAB_URL=$GITLAB_URL" \
    "TERRAGUCCI_GITLAB_TOKEN=$GITLAB_TOKEN" \
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

# A config written before the runner carried the AWS environment is replaced.
if "${COMPOSE[@]}" exec -T forgejo-runner grep -q AWS_ENDPOINT_URL /data/config.yml 2>/dev/null && runner_online; then
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
  capacity: 4
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
