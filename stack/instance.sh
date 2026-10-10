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
