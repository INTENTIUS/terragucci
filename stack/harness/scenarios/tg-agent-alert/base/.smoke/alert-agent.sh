#!/bin/sh
# A stand-in alert agent: the prompt comes on stdin, and it edits one file when the alert names the checkout service.
prompt="$(cat)"
held=""
for v in GITHUB_TOKEN FORGEJO_TOKEN GITEA_TOKEN TG_TOKEN ACTIONS_RUNTIME_TOKEN CHANT_RELAY_KEY; do
  eval "x=\${$v:-}"
  [ -n "$x" ] && held="$held $v"
done
echo "stand-in alert agent: forge tokens and the relay key in its step:${held:- none}"
if printf '%s\n' "$prompt" | grep -q 'checkout 5xx'; then
  sed -i 's/version-1/version-2/' app/main.tf
  echo "stand-in alert agent: set the service's version to 2"
fi
