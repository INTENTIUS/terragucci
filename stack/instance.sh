# Which instance of the validation stack a script drives. Sourced by every
# script that names the stack's compose project, containers, network, ports,
# state or locks; safe to source more than once.
#
#   TG_STACK=shared   (the default) compose project terragucci: containers
#                     terragucci-*, network terragucci, Forgejo on 3300, floci
#                     on 4580, state in stack/.state, locks in the main
#                     checkout's stack/.state/locks. The smoke claims run here.
#   TG_STACK=capture  compose project terragucci-capture, from the same
#                     docker-compose.yml: containers terragucci-capture-*,
#                     network terragucci-capture, every host port 100 up
#                     (Forgejo 3400, floci 4680), state in stack/.state-capture,
#                     locks in the main checkout's stack/.state-capture/locks.
#                     stack/tutorial-capture.sh runs here, so a capture never
#                     holds the claims' stack lock.
#
# Inside either instance the forge is http://forgejo:3000 and floci
# http://floci:4566, so the pages a capture screenshots read the same. A
# TERRAGUCCI_*_PORT already set wins over the capture defaults.
#
# Sets and exports TG_STACK, TG_PROJECT (the compose project, the prefix of
# every container and volume name), TG_NETWORK and TG_STATE.

TG_INSTANCE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${TG_STACK:-shared}" in
  shared)
    TG_STACK=shared
    TG_PROJECT=terragucci
    TG_STATE="$TG_INSTANCE_HERE/.state"
    ;;
  capture)
    TG_PROJECT=terragucci-capture
    TG_STATE="$TG_INSTANCE_HERE/.state-capture"
    : "${TERRAGUCCI_FORGEJO_PORT:=3400}" "${TERRAGUCCI_FLOCI_PORT:=4680}" \
      "${TERRAGUCCI_GITHUB_PORT:=8298}" "${TERRAGUCCI_GITLAB_PORT:=9039}" \
      "${TERRAGUCCI_FOUNTAIN_PORT:=4110}" "${TERRAGUCCI_REGISTRY_PORT:=5150}" \
      "${TERRAGUCCI_AZURITE_PORT:=10110}" "${TERRAGUCCI_GCS_PORT:=4553}" \
      "${TERRAGUCCI_OTLP_PORT:=4428}" "${TERRAGUCCI_OTEL_HEALTH_PORT:=13243}" \
      "${TERRAGUCCI_PROMETHEUS_PORT:=9290}" "${TERRAGUCCI_TEMPO_PORT:=3420}" \
      "${TERRAGUCCI_GRAFANA_PORT:=3410}" "${TERRAGUCCI_DECIDE_PORT:=8890}"
    export TERRAGUCCI_FORGEJO_PORT TERRAGUCCI_FLOCI_PORT TERRAGUCCI_GITHUB_PORT \
      TERRAGUCCI_GITLAB_PORT TERRAGUCCI_FOUNTAIN_PORT TERRAGUCCI_REGISTRY_PORT \
      TERRAGUCCI_AZURITE_PORT TERRAGUCCI_GCS_PORT TERRAGUCCI_OTLP_PORT \
      TERRAGUCCI_OTEL_HEALTH_PORT TERRAGUCCI_PROMETHEUS_PORT TERRAGUCCI_TEMPO_PORT \
      TERRAGUCCI_GRAFANA_PORT TERRAGUCCI_DECIDE_PORT
    ;;
  *)
    echo "TG_STACK is '$TG_STACK'; it is shared (the default) or capture" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac
TG_NETWORK="$TG_PROJECT"
export TG_STACK TG_PROJECT TG_NETWORK TG_STATE

# floci, Forgejo and forgejo-runner come from chant's e2e harness
# (terragucci#1295): stack/harness/harness.ts builds them under this
# instance's project into $TG_STATE/harness-compose.yml. On a chant without
# the harness, stack/forge-fallback.yml, the services as the stack ran them
# before, stands in, and a line on stderr says so. TG_HARNESS=fallback picks
# the fallback; TG_HARNESS=harness refuses to run without the harness.
# Worked out once per run and instance: TG_FORGE_COMPOSE is exported to
# every child, with TG_FORGE_COMPOSE_FOR naming the project it was built for.
tg_forge_compose() { # sets TG_FORGE_COMPOSE, the compose file that holds floci, Forgejo and forgejo-runner
  if [ -z "${TG_FORGE_COMPOSE:-}" ] || [ ! -f "$TG_FORGE_COMPOSE" ] || [ "${TG_FORGE_COMPOSE_FOR:-}" != "$TG_PROJECT" ]; then
    local out="$TG_STATE/harness-compose.yml" rc=0 tsx="$TG_INSTANCE_HERE/../node_modules/.bin/tsx"
    case "${TG_HARNESS:-auto}" in
      fallback) TG_FORGE_COMPOSE="$TG_INSTANCE_HERE/forge-fallback.yml" ;;
      auto|harness)
        mkdir -p "$TG_STATE"
        if [ -x "$tsx" ]; then
          TG_PROJECT="$TG_PROJECT" "$tsx" "$TG_INSTANCE_HERE/harness/harness.ts" compose --out "$out" >&2 || rc=$?
        else
          rc=3; echo "[stack] no tsx in node_modules (npm ci first), so the chant harness cannot be built" >&2
        fi
        if [ "$rc" = 0 ]; then
          TG_FORGE_COMPOSE="$out"
        elif [ "$rc" = 3 ] && [ "${TG_HARNESS:-auto}" = auto ]; then
          echo "[stack] using stack/forge-fallback.yml for floci, Forgejo and forgejo-runner" >&2
          TG_FORGE_COMPOSE="$TG_INSTANCE_HERE/forge-fallback.yml"
        else
          echo "[stack] TG_HARNESS=${TG_HARNESS:-auto}: the chant harness's compose was not built (exit $rc)" >&2
          return 1
        fi
        ;;
      *) echo "TG_HARNESS is '$TG_HARNESS'; it is auto (the default), harness or fallback" >&2; return 1 ;;
    esac
    TG_FORGE_COMPOSE_FOR="$TG_PROJECT"
    export TG_FORGE_COMPOSE TG_FORGE_COMPOSE_FOR
  fi
}

# docker compose on this instance's project: the forge services' file and
# stack/docker-compose.yml, one project and one network.
tg_compose() {
  tg_forge_compose || return 1
  docker compose -f "$TG_FORGE_COMPOSE" -f "$TG_INSTANCE_HERE/docker-compose.yml" --project-name "$TG_PROJECT" "$@"
}

# The image a forge service runs (floci, forgejo, forgejo-runner), as the file
# in use names it.
tg_forge_image() { # service
  tg_forge_compose || return 1
  awk -v s="  $1:" '$0 == s { f = 1; next } f && /^  [^ ]/ { exit } f && /^ +image:/ { sub(/^ +image: */, ""); gsub(/["'"'"']/, ""); print; exit }' "$TG_FORGE_COMPOSE"
}

# The Forgejo admin's and the demo people's passwords. The defaults are for a
# throwaway instance on localhost; a host that is reachable by others (the
# demo host) sets TERRAGUCCI_FORGEJO_ADMIN_PASSWORD and
# TERRAGUCCI_FORGEJO_PEOPLE_PASSWORD to its own values. Plain shell variables,
# not exported, and never printed. Every script that signs in with a password
# reads these two.
TG_FORGEJO_ADMIN_PW="${TERRAGUCCI_FORGEJO_ADMIN_PASSWORD:-Terragucci-local-pw-1234}"
TG_FORGEJO_PEOPLE_PW="${TERRAGUCCI_FORGEJO_PEOPLE_PASSWORD:-Terragucci-local-pw-5678}"
