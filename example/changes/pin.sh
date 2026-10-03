#!/usr/bin/env bash
# Pin: publish modules/service as 1.1.0 and roll it out one wave at a time.
# This scenario runs tf-publish and tf-rollout, which are tracked in
# chant#3353 and chant#3352.
set -euo pipefail
echo "pin: needs tf-publish (chant#3353) and tf-rollout (chant#3352)" >&2
exit 3
