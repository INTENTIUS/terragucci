#!/usr/bin/env bash
# Drift: delete staging orders' jobs queue straight from floci, the way someone
# clicking in the AWS console would. Terraform still thinks it exists until the
# next plan looks.
set -euo pipefail
FLOCI="${TERRAGUCCI_FLOCI_URL:-http://localhost:4580}"
QUEUE="shop-staging-orders-jobs"
sqs() { curl -fsS -X POST "$FLOCI/" -H "X-Amz-Target: AmazonSQS.$1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }
url="$(sqs GetQueueUrl "{\"QueueName\":\"$QUEUE\"}" | sed -n 's/.*"QueueUrl":"\([^"]*\)".*/\1/p')"
[ -n "$url" ] || { echo "drift: $QUEUE is not in floci; boot the example first" >&2; exit 1; }
sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null
echo "deleted $QUEUE from floci, outside Terraform"
