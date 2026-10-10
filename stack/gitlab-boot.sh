#!/usr/bin/env bash
# GitLab's boot, shared by the validation stack's gitlab profile
# (stack/bootstrap.sh) and the GitLab lab (stack/gitlab/gitlab.sh). Source it
# and call gitlab_boot once the compose project's gitlab, gitlab-runner and
# floci are started. It waits for GitLab to serve, mints the root token with
# gitlab-rails, registers the runner (one already online is kept) and creates
# root/$REPO. Re-running it is safe.
#
# The caller sets:
#   COMPOSE          the docker compose command of its project, as an array
#   GL_URL           GitLab on the host, http://localhost:<port>
#   GL_TOKEN         the root token to mint
#   GL_CONTAINER     the gitlab container, for its log when boot fails
#   GL_NETWORK       the network job containers join (floci and gitlab are on it)
#   GL_CACHE_VOLUME  the volume mounted at /cache in every job
#   GL_RUNNER        the runner's description
#   CI_IMAGE         the default image of a job
#   REPO             the project to create under root
# and defines log and die.

glapi() { curl -fsS -H "PRIVATE-TOKEN: $GL_TOKEN" "$@"; }

gitlab_boot() {
  local i stale runner_token
  # Poll the sign-in page, not /-/health: the monitoring endpoints are
  # restricted by IP and a request from the host arrives from the bridge gateway.
  # Cold boot under emulation takes ten minutes or more.
  log "waiting for GitLab to serve (cold boot under emulation is slow)…"
  for i in $(seq 1 360); do
    curl -fsS -o /dev/null -m 5 "$GL_URL/users/sign_in" 2>/dev/null && { log "serving after ~$((i * 5))s"; break; }
    sleep 5
    [ $((i % 24)) -eq 0 ] && log "still booting… ~$((i * 5))s"
    if [ "$i" = 360 ]; then docker logs --tail=60 "$GL_CONTAINER" >&2 || true; die "GitLab did not serve in 30 minutes"; fi
  done
  # A throwaway token on a throwaway instance, minted through gitlab-rails the
  # way gitlab-warden's e2e does. One that still works is kept, so a claim run
  # in progress keeps working.
  if glapi -o /dev/null "$GL_URL/api/v4/user" 2>/dev/null; then
    log "the root token still works"
  else
    log "minting a root token with gitlab-rails…"
    for i in $(seq 1 30); do
      if "${COMPOSE[@]}" exec -T gitlab gitlab-rails runner "
        u = User.find_by_username('root')
        u.personal_access_tokens.where(name: 'terragucci').delete_all
        t = u.personal_access_tokens.create!(scopes: ['api'], name: 'terragucci', expires_at: 30.days.from_now)
        t.set_token('${GL_TOKEN}'); t.save!
      " >/dev/null 2>&1; then break; fi
      sleep 10
      [ "$i" = 30 ] && die "could not mint a token with gitlab-rails"
    done
  fi
  for i in $(seq 1 12); do glapi -o /dev/null "$GL_URL/api/v4/version" 2>/dev/null && break; sleep 5; done
  glapi -o /dev/null "$GL_URL/api/v4/version" || die "the token does not authenticate"
  log "GitLab $(glapi "$GL_URL/api/v4/version" | jq -r .version)"
  # The claims force-push main over a seed commit, so no project's default
  # branch is protected. Unprotecting each project after its first push is
  # not enough: until Sidekiq has processed that push, GitLab still counts the
  # repository as empty, and an empty repository's default branch is treated
  # as protected whatever the project's protected branches say. Developers can
  # push and merge and force pushes are allowed: GitLab's "not protected".
  glapi -o /dev/null -X PUT -H 'content-type: application/json' "$GL_URL/api/v4/application/settings" \
    -d '{"default_branch_protection_defaults":{"allowed_to_push":[{"access_level":30}],"allowed_to_merge":[{"access_level":30}],"allow_force_push":true,"developer_can_initial_push":false}}' \
    || die "could not turn off default branch protection"
  glapi "$GL_URL/api/v4/application/settings" | jq -e '.default_branch_protection_defaults.allow_force_push == true' >/dev/null \
    || die "default branch protection is still on"
  log "default branches are not protected"

  runner_online() { glapi "$GL_URL/api/v4/runners/all?status=online" | jq -e --arg d "$GL_RUNNER" 'map(select(.description == $d)) | length > 0' >/dev/null 2>&1; }
  if runner_online; then
    log "the runner is already registered and online"
  else
    # Runners from an earlier registration that are no longer polling.
    for stale in $(glapi "$GL_URL/api/v4/runners/all" | jq -r --arg d "$GL_RUNNER" '.[] | select(.description == $d) | .id'); do
      glapi -o /dev/null -X DELETE "$GL_URL/api/v4/runners/$stale" || true
    done
    log "registering gitlab-runner…"
    # GitLab 17 has no registration tokens: the runner is created over the API
    # and its glrt- token handed to `gitlab-runner register --token`.
    runner_token="$(glapi -X POST "$GL_URL/api/v4/user/runners" \
      --data-urlencode "runner_type=instance_type" --data-urlencode "description=$GL_RUNNER" \
      --data-urlencode "run_untagged=true" | jq -r .token)"
    [ -n "$runner_token" ] && [ "$runner_token" != null ] || die "runner creation returned no token"
    "${COMPOSE[@]}" exec -T gitlab-runner rm -f /etc/gitlab-runner/config.toml
    # network mode: job containers join the network floci and gitlab are on.
    # The cache volume holds the provider plugin cache. Every job's AWS is floci.
    "${COMPOSE[@]}" exec -T gitlab-runner gitlab-runner register --non-interactive \
      --url http://gitlab:8929 --token "$runner_token" --executor docker \
      --docker-image "$CI_IMAGE" --docker-pull-policy if-not-present \
      --docker-network-mode "$GL_NETWORK" --docker-volumes "$GL_CACHE_VOLUME:/cache" \
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
  if ! glapi -o /dev/null "$GL_URL/api/v4/projects/root%2F$REPO" 2>/dev/null; then
    glapi -o /dev/null -X POST "$GL_URL/api/v4/projects" \
      --data-urlencode "name=$REPO" --data-urlencode "visibility=public" --data-urlencode "initialize_with_readme=false" \
      --data-urlencode "default_branch=main"
  fi
}
