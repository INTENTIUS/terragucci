#!/usr/bin/env python3
"""Count the AWS requests in an OpenTofu debug log (TF_LOG=debug), by service
and operation, and price them at the us-east-1 list prices the pilot's
research used (terragucci#116).

    stack/smoke-aws-count.py LOG...      or - for stdin
    stack/smoke-aws.sh count [LOG]       the last measured run's log, from the job cache volume

Every request the AWS SDK sends is one "HTTP Request Sent" line, from the
provider and from the S3 backend alike, retries included. The service and
operation come from the line's aws.service / rpc.service and aws.operation /
rpc.method fields; aws-sdk-go v1's "DEBUG: Request <service>/<operation>"
lines count too. Nothing else in the log is read or printed, so no header or
key reaches the output.
"""
import re
import sys
from collections import Counter

FIELD = r'(?:^|\s){name}=("(?:[^"\\]|\\.)*"|\S+)'


def field(line, *names):
    for name in names:
        m = re.search(FIELD.format(name=re.escape(name)), line)
        if m:
            return m.group(1).strip('"')
    return None


V1 = re.compile(r"DEBUG: (?:Retrying )?Request ([\w-]+)/(\w+)")


def request(line):
    if "HTTP Request Sent" in line:
        service = field(line, "aws.service", "rpc.service") or "?"
        op = field(line, "aws.operation", "rpc.method") or "?"
        return service, op.split(".")[-1]
    m = V1.search(line)
    if m:
        return m.group(1), m.group(2)
    return None


# us-east-1 list prices, USD per request. DynamoDB's control plane, IAM and
# STS do not bill per request; DELETE on S3 is free.
def price(service, op):
    s = service.lower().replace(" ", "")
    if s == "s3":
        if op.startswith("Delete"):
            return 0.0, "S3 delete (free)"
        if re.match(r"(Put|Copy|Post|List|Create|Complete|UploadPart|Restore)", op):
            return 0.005 / 1000, "S3 PUT, COPY, POST, LIST"
        return 0.0004 / 1000, "S3 GET and other"
    if s == "sqs":
        return 0.40 / 1_000_000, "SQS request"
    if s == "dynamodb":
        if re.match(r"(Put|Update|Delete|BatchWrite|TransactWrite)Item", op):
            return 0.625 / 1_000_000, "DynamoDB write unit"
        if re.match(r"(Get|BatchGet|TransactGet)Item|Query|Scan", op):
            return 0.125 / 1_000_000, "DynamoDB read unit"
        return 0.0, "DynamoDB control plane (free)"
    if s in ("sts", "iam"):
        return 0.0, f"{service} (free)"
    return 0.0, "not priced"


def main(paths):
    counts = Counter()
    for path in paths or ["-"]:
        stream = sys.stdin if path == "-" else open(path, errors="replace")
        for line in stream:
            r = request(line)
            if r:
                counts[r] += 1
    if not counts:
        print("no AWS requests in the log (was it written with TF_LOG=debug?)")
        return 1
    width = max(len(f"{s} {o}") for s, o in counts) + 2
    total_n, total_usd = 0, 0.0
    by_service = Counter()
    print(f"{'service operation':<{width}}{'requests':>9}  {'est. USD':>10}  price class")
    for (s, o), n in sorted(counts.items(), key=lambda kv: (kv[0][0], -kv[1], kv[0][1])):
        each, cls = price(s, o)
        usd = each * n
        total_n += n
        total_usd += usd
        by_service[s] += n
        print(f"{s + ' ' + o:<{width}}{n:>9}  {usd:>10.6f}  {cls}")
    print()
    for s, n in sorted(by_service.items()):
        print(f"{s:<{width}}{n:>9}")
    print(f"{'total':<{width}}{total_n:>9}  {total_usd:>10.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
