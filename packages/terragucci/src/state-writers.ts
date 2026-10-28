/**
 * Who wrote a state version that no wave or migration recorded, for
 * `terragucci audit` (./audit.ts, ./report/unrecorded.ts). The answer comes
 * from a log of the state bucket's object writes, never from the state.
 *
 * On S3 that log is CloudTrail's data events for the bucket, delivered to a
 * CloudWatch Logs group (`audit_log_group`): the `aws` CLI drift attribution
 * runs (./respond/attribute.ts) filters the group for writes of the state's
 * key around the version's time, and the write whose `x-amz-version-id` is
 * the version's names the principal, read as drift attribution reads one
 * (chant's classifyEvent, `@intentius/chant/ci-audit`), else by its ARN. CloudTrail's event history, which drift
 * attribution reads, keeps no object writes, so without a log group there
 * is nothing to read. terragucci reads no log of a gcs or azurerm state's
 * writes. Every answer that names nobody says why.
 */
import { classifyEvent, spawnAws, type AwsRun, type TrailEvent } from "@intentius/chant/ci-audit";

/** What the log says of one version's writer: who and how that was found, or why nobody is named. */
export type WriterAnswer = { status: "found"; who: string; how: string } | { status: "none"; why: string };

/** One version to find the writer of. */
export interface WriterQuery {
  location: string;
  version_id: string;
  written_at: string;
  /** An S3 delete marker. */
  deleted?: boolean;
}

/** Where the audit asks who wrote a version. Tests use a fake; awsStateWriters reads CloudTrail's data events. */
export interface StateWriters {
  writer(q: WriterQuery): Promise<WriterAnswer>;
}

export interface AwsStateWriterOptions {
  /** The CloudWatch Logs group a trail delivers the state buckets' data events to (`audit_log_group`). */
  logGroup?: string;
  /** `audit_region`, else the CLI's. */
  region?: string;
  run?: AwsRun;
  /** How far either side of the version's time the log is read. Default 10 minutes. */
  windowSeconds?: number;
}

/** A CloudTrail data event on an S3 object. */
interface ObjectEvent extends TrailEvent {
  eventSource?: string;
  requestParameters?: { bucketName?: string; key?: string };
  responseElements?: Record<string, unknown> | null;
}

/** The S3 calls that write a version of an object, or a delete marker. */
const WRITES = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "RestoreObject", "DeleteObject", "DeleteObjects"]);

const principal = (e: ObjectEvent): string | undefined => classifyEvent(e)?.who ?? e.userIdentity?.arn ?? undefined;

export function awsStateWriters(o: AwsStateWriterOptions = {}): StateWriters {
  const run = o.run ?? spawnAws;
  const window = (o.windowSeconds ?? 600) * 1000;
  return {
    async writer(q) {
      const m = /^(s3|gs|az):\/\/([^/]+)\/(.+)$/.exec(q.location);
      if (!m) return { status: "none", why: "terragucci reads no log of this backend's writes" };
      if (m[1] === "gs") return { status: "none", why: "terragucci reads no log of a gcs bucket's object writes" };
      if (m[1] === "az") return { status: "none", why: "terragucci reads no log of an azurerm container's blob writes" };
      if (!o.logGroup) return { status: "none", why: "audit_log_group is not set, and CloudTrail's event history keeps no S3 object writes" };
      const [, , bucket, key] = m as unknown as [string, string, string, string];
      const at = Date.parse(q.written_at);
      const quote = (v: string): string => JSON.stringify(v);
      const p = run([
        "logs", "filter-log-events", "--output", "json", "--log-group-name", o.logGroup,
        "--start-time", String(at - window), "--end-time", String(at + window),
        "--filter-pattern", `{ ($.eventSource = "s3.amazonaws.com") && ($.requestParameters.bucketName = ${quote(bucket)}) && ($.requestParameters.key = ${quote(key)}) }`,
        ...(o.region ? ["--region", o.region] : []),
      ]);
      if ((p.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: "none", why: "the aws CLI is not installed" };
      if (p.error || p.status !== 0) return { status: "none", why: `${o.logGroup} could not be read: ${(p.error?.message ?? (p.stderr.trim() || `aws exited ${p.status}`)).split("\n")[0]}` };
      let doc: { events?: { message?: string }[] };
      try {
        doc = JSON.parse(p.stdout) as typeof doc;
      } catch {
        return { status: "none", why: "aws printed no JSON" };
      }
      const writes: ObjectEvent[] = [];
      for (const e of doc.events ?? []) {
        try {
          const r = JSON.parse(e.message ?? "{}") as ObjectEvent;
          if (WRITES.has(r.eventName ?? "")) writes.push(r);
        } catch {
          // a record that does not parse says nothing
        }
      }
      const exact = writes.find((e) => e.responseElements?.["x-amz-version-id"] === q.version_id);
      const who = exact && principal(exact);
      if (exact && who) return { status: "found", who, how: `${exact.eventName} in ${o.logGroup} at ${exact.eventTime ?? q.written_at}, with this version id` };
      return { status: "none", why: writes.length === 0 ? `${o.logGroup} holds no write of the object within ${window / 60_000} minutes of the version` : `no write in ${o.logGroup} names this version id` };
    },
  };
}
