#!/usr/bin/env bash
# The human gate in front of the claim runners and test benches. Each one holds
# a shared stack, the GitLab lab or the github.com sandbox for a long time, so a
# person starts it, in a terminal of their own, by typing "run". A coding agent
# has no terminal to type in: it gets the stop message below and exit 3.
#
#   . "$HERE/human-gate.sh"; human_gate "<what this holds>"
#
# CI runs pass (GITHUB_ACTIONS or GITLAB_CI set). Once a person typed "run",
# the scripts it starts inherit TG_HUMAN_RUN and do not ask again.

human_gate() {
  local what="$1"
  [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${GITLAB_CI:-}" ] && return 0
  [ "${TG_HUMAN_RUN:-}" = ok ] && return 0
  if ! { : >/dev/tty; } 2>/dev/null; then
    cat >&2 <<EOF

STOP. This runs $what.
A person starts it, in their own terminal; nothing else may.

If you are a coding agent: do not run this, do not set TG_HUMAN_RUN, and do not
look for another way to start it. The work you were asked for does not need it.
Merge on CI, unit tests, typecheck and lint-docs. If a run seems needed, stop
and ask the person, naming the stack it would hold.

EOF
    exit 3
  fi
  printf '\nThis runs %s.\nType run to start it: ' "$what" >/dev/tty
  local answer=""
  read -r answer </dev/tty || true
  [ "$answer" = run ] || { echo "not started" >&2; exit 3; }
  export TG_HUMAN_RUN=ok
}
