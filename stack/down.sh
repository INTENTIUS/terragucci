#!/usr/bin/env bash
#
# Remove everything the validation stack started, every profile: containers,
# the terragucci network and its volumes, plus any job container a runner
# (forgejo-runner, gitlab-runner, act) left on the network and stack/.state/.
# The job cache (terragucci-job-cache: the OpenTofu binary and the providers
# jobs fetched) stays, so the next boot does not download the AWS provider
# again; `just job-cache-prune` removes it. Touches nothing outside the
# terragucci compose project and the terragucci-* names.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker is not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP: the docker daemon is not reachable"; exit 0; }

# Job containers belong to the runner, not to compose. A job cut off mid-run
# can leave one attached to the network, which would block removing it.
if docker network inspect terragucci >/dev/null 2>&1; then
  for c in $(docker network inspect terragucci --format '{{range .Containers}}{{.Name}} {{end}}'); do
    case "$c" in
      FORGEJO-ACTIONS-TASK-*|GITEA-ACTIONS-TASK-*|runner-*|act-*) docker rm -f "$c" >/dev/null && echo "removed job container $c" ;;
    esac
  done
fi

docker compose -f "$HERE/docker-compose.yml" --project-name terragucci \
  --profile aws --profile forgejo --profile github --profile gitlab --profile fountain --profile registry --profile observability --profile blob --profile decide \
  down --remove-orphans

# Without -v, compose keeps volumes: remove the anonymous ones it made here.
docker volume prune -f --filter label=com.docker.compose.project=terragucci >/dev/null

# Belt and braces for anything created outside compose under our names.
for c in $(docker ps -aq --filter name=^terragucci-); do docker rm -f "$c" >/dev/null && echo "removed container $c"; done
for v in $(docker volume ls -q --filter name=terragucci-); do
  [ "$v" = terragucci-job-cache ] && continue
  docker volume rm "$v" >/dev/null && echo "removed volume $v"
done
docker network rm terragucci >/dev/null 2>&1 && echo "removed network terragucci" || true

rm -rf "$HERE/.state"
echo "terragucci stack removed"
