#!/usr/bin/env bash
#
# Remove everything the validation stack started, every profile: containers,
# the terragucci network and its volumes, plus any job container a runner
# (forgejo-runner, gitlab-runner, act) left on the network and stack/.state/.
# The job cache (terragucci-job-cache: the OpenTofu binary and the providers
# jobs fetched) stays, so the next boot does not download the AWS provider
# again; `just job-cache-prune` removes it. Touches nothing outside the
# terragucci compose project and the terragucci-* names.
#
# TG_STACK=capture removes the capture stack instead (compose project
# terragucci-capture, its terragucci-capture-* names and stack/.state-capture/),
# and touches nothing of the shared stack's; see instance.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=instance.sh
. "$HERE/instance.sh"
P="$TG_PROJECT"

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker is not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP: the docker daemon is not reachable"; exit 0; }

# Job containers belong to the runner, not to compose. A job cut off mid-run
# can leave one attached to the network, which would block removing it.
if docker network inspect "$TG_NETWORK" >/dev/null 2>&1; then
  for c in $(docker network inspect "$TG_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}'); do
    case "$c" in
      FORGEJO-ACTIONS-TASK-*|GITEA-ACTIONS-TASK-*|runner-*|act-*) docker rm -f "$c" >/dev/null && echo "removed job container $c" ;;
    esac
  done
fi

docker compose -f "$HERE/docker-compose.yml" --project-name "$P" \
  --profile aws --profile forgejo --profile github --profile gitlab --profile fountain --profile registry --profile observability --profile blob --profile decide \
  down --remove-orphans

# Without -v, compose keeps volumes: remove the anonymous ones it made here.
docker volume prune -f --filter label=com.docker.compose.project="$P" >/dev/null

# Belt and braces for anything created outside compose under our names.
# The shared stack's names are a prefix of the capture stack's, so the shared
# stack's sweep leaves terragucci-capture-* alone.
for c in $(docker ps -a --filter "name=^$P-" --format '{{.Names}}'); do
  [ "$P" != terragucci ] || case "$c" in terragucci-capture-*) continue ;; esac
  docker rm -f "$c" >/dev/null && echo "removed container $c"
done
for v in $(docker volume ls -q --filter "name=^$P-"); do
  [ "$v" = terragucci-job-cache ] && continue
  [ "$P" != terragucci ] || case "$v" in terragucci-capture-*) continue ;; esac
  docker volume rm "$v" >/dev/null && echo "removed volume $v"
done
docker network rm "$TG_NETWORK" >/dev/null 2>&1 && echo "removed network $TG_NETWORK" || true

rm -rf "$TG_STATE"
echo "$P stack removed"
