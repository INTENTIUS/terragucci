#!/usr/bin/env bash
# Pin: publish modules/service as 1.1.0 and roll it out one wave at a time.
# This scenario runs tf-publish and tf-rollout, which are not built yet; the
# status page at https://intentius.io/terragucci/status/ says when they are.
set -euo pipefail
echo "pin: tf-publish and tf-rollout are not built yet; see https://intentius.io/terragucci/status/" >&2
exit 3
