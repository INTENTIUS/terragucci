/**
 * Drift attribution (terragucci#31): who changed a drifted attribute, so the
 * response can fit. Evidence is asked for in a fixed order, and the first
 * step that answers ends the question for that attribute:
 *
 *   1. KNOWN_WRITES, a table in this file of attributes that a controller or
 *      the cloud service writes by design, such as an autoscaling group's
 *      desired capacity or the `aws:` tags a service adds. Deterministic.
 *   2. The cloud audit log (AuditLog), which names the principal that last
 *      wrote the object outside Terraform. Deterministic when it is readable.
 *      An unreadable log is reported and skipped.
 *   3. A typed decision (DRIFT_ACTOR), asked only for an attribute neither
 *      step answered, and used only when its probability reaches the
 *      threshold. Below it, the attribute is reported unattributed and the
 *      default response runs.
 *
 * The answer routes a response and nothing more. A controller write suggests
 * `ignore_changes`, a human edit goes to the codify pull request with the
 * actor named, and a provider default change suggests pinning or setting the
 * value. No route applies, merges or edits state.
 */
import { spawnSync } from "node:child_process";
import { decide as askModel, isConfident, summarize } from "../decide";
import { DRIFT_ACTOR } from "../decide/questions";
import type { DecideOptions, DecideSettings } from "../decide";
import type { Drifted } from "./drift";

export type Actor = "controller" | "human" | "provider-default";
export type Source = "table" | "audit" | "model" | "unattributed";

export interface Attribution {
  root: string;
  address: string;
  path: string;
  /** Absent only when the source is `unattributed`. */
  actor?: Actor;
  source: Source;
  /** What the evidence says, in a sentence. */
  detail: string;
  /** The model's probability, when the model answered. */
  probability?: number;
}

type Value = { before: unknown; live: unknown };

// ── 1. the table ─────────────────────────────────────────────────────────────

export interface KnownWrite {
  /** The resource type. */
  type: string;
  /** The top-level attribute. */
  path: string;
  actor: Actor;
  /** Who writes it, shown in the report. */
  why: string;
  /** Narrows the entry to drift of the kind the writer produces. Default: any change. */
  when?: (v: Value) => boolean;
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number";

/** Tag keys that only a service writes. */
const SERVICE_TAG = /^(aws:|eks:|elasticbeanstalk:|kubernetes\.io\/|k8s\.io\/|karpenter\.sh\/)/;

/** True when the two tag maps differ only in keys a service adds, changes or removes. */
export function onlyServiceTags(v: Value): boolean {
  const before = isMap(v.before) ? v.before : {};
  const live = isMap(v.live) ? v.live : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(live)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(live[k] ?? null));
  return keys.length > 0 && keys.every((k) => SERVICE_TAG.test(k));
}

/** True when only `inner` differs in a one-block attribute such as `scaling_config`. */
const onlyInner =
  (inner: string) =>
  (v: Value): boolean => {
    const b = Array.isArray(v.before) ? v.before[0] : v.before;
    const l = Array.isArray(v.live) ? v.live[0] : v.live;
    if (!isMap(b) || !isMap(l)) return false;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(l)])].filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(l[k] ?? null));
    return keys.length > 0 && keys.every((k) => k === inner);
  };

export const KNOWN_WRITES: KnownWrite[] = [
  { type: "aws_ecs_service", path: "desired_count", actor: "controller", why: "Application Auto Scaling sets an ECS service's task count", when: (v) => num(v.live) },
  { type: "aws_autoscaling_group", path: "desired_capacity", actor: "controller", why: "the group's scaling policies and scheduled actions set its desired capacity", when: (v) => num(v.live) },
  { type: "aws_eks_node_group", path: "scaling_config", actor: "controller", why: "Cluster Autoscaler or Karpenter sets a node group's desired size", when: onlyInner("desired_size") },
  { type: "aws_dynamodb_table", path: "read_capacity", actor: "controller", why: "Application Auto Scaling adjusts a provisioned table's read capacity", when: (v) => num(v.live) },
  { type: "aws_dynamodb_table", path: "write_capacity", actor: "controller", why: "Application Auto Scaling adjusts a provisioned table's write capacity", when: (v) => num(v.live) },
  { type: "aws_appautoscaling_target", path: "min_capacity", actor: "controller", why: "a scheduled action on the scalable target moves its minimum", when: (v) => num(v.live) },
  { type: "aws_appautoscaling_target", path: "max_capacity", actor: "controller", why: "a scheduled action on the scalable target moves its maximum", when: (v) => num(v.live) },
  { type: "aws_db_instance", path: "engine_version", actor: "controller", why: "RDS applies minor engine upgrades itself when auto_minor_version_upgrade is on", when: (v) => typeof v.live === "string" && typeof v.before === "string" },
  { type: "aws_launch_template", path: "latest_version", actor: "controller", why: "a service that publishes a launch template version (EC2 Image Builder, Karpenter) moves latest_version", when: (v) => num(v.live) },
  { type: "aws_elasticache_replication_group", path: "engine_version_actual", actor: "controller", why: "ElastiCache applies minor engine upgrades itself" },
  // Any type: tags a service adds for itself.
  ...["tags", "tags_all"].map((path): KnownWrite => ({ type: "*", path, actor: "controller", why: "a service adds tags in its own namespace (aws:, eks:, karpenter.sh/ and the like)", when: onlyServiceTags })),
];

/** The table's entry for a drifted attribute, if it has one. */
export function knownWrite(type: string, path: string, v: Value): KnownWrite | undefined {
  return KNOWN_WRITES.find((k) => (k.type === type || k.type === "*") && k.path === path && (k.when?.(v) ?? true));
}

// ── 2. the audit log ─────────────────────────────────────────────────────────

export interface AuditQuery {
  type: string;
  address: string;
  /** The object's real name or id. */
  ref: string;
}

export type AuditAnswer =
  | { status: "found"; actor: "controller" | "human"; who: string; event: string; at: string }
  /** The log was read and holds no write outside Terraform that tells a person from a controller. */
  | { status: "silent" }
  | { status: "unavailable"; reason: string };

/** What attribution needs from a cloud's audit log. Tests use a fake; `awsAuditLog` reads CloudTrail. */
export interface AuditLog {
  lookup(q: AuditQuery): Promise<AuditAnswer>;
}

interface TrailEvent {
  eventName?: string;
  eventTime?: string;
  readOnly?: boolean | string;
  userAgent?: string;
  invokedBy?: string;
  userIdentity?: { type?: string; userName?: string; arn?: string; invokedBy?: string; sessionContext?: { sessionIssuer?: { userName?: string } } };
}

const TERRAFORM_AGENT = /terraform|opentofu|tofu/i;

/**
 * A CloudTrail record read as a person or a controller, or neither. A write
 * by an AWS service principal (autoscaling, a service-linked role) is a
 * controller; an IAM user, the root user, an Identity Center session and a
 * role session named for an email address are people. A role session with a
 * machine name could be a pipeline or a controller running as a role, so it
 * answers nothing.
 */
export function classifyEvent(e: TrailEvent): { actor: "controller" | "human"; who: string } | undefined {
  const id = e.userIdentity ?? {};
  const by = id.invokedBy ?? e.invokedBy;
  if (id.type === "AWSService" || (by && /\.amazonaws\.com$/.test(by))) return { actor: "controller", who: by ?? "an AWS service" };
  const arn = id.arn ?? "";
  const session = arn.split("/").at(-1) ?? "";
  if (id.type === "IAMUser") return { actor: "human", who: id.userName ?? session };
  if (id.type === "Root") return { actor: "human", who: "the root user" };
  if (id.type === "IdentityCenterUser" || id.type === "FederatedUser") return { actor: "human", who: id.userName ?? session };
  if (id.type === "AssumedRole") {
    const issuer = id.sessionContext?.sessionIssuer?.userName ?? "";
    if (/^AWSReservedSSO_/.test(issuer) || session.includes("@")) return { actor: "human", who: session || issuer };
  }
  return undefined;
}

/** Choose the newest write outside Terraform that classifies, from CloudTrail's event records. */
export function newestActor(events: TrailEvent[]): AuditAnswer {
  const writes = events
    .filter((e) => e.readOnly !== true && e.readOnly !== "true" && !TERRAFORM_AGENT.test(e.userAgent ?? ""))
    .sort((a, b) => String(b.eventTime ?? "").localeCompare(String(a.eventTime ?? "")));
  // The newest write decides: an older one by someone else is not who last changed it.
  const e = writes[0];
  const c = e && classifyEvent(e);
  return e && c ? { status: "found", ...c, event: e.eventName ?? "an event", at: e.eventTime ?? "" } : { status: "silent" };
}

export interface AwsAuditOptions {
  /** How far back to read. Default 14 days. */
  days?: number;
  region?: string;
  /** Runs `aws`; the default spawns the CLI. */
  run?: (args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
  now?: () => Date;
}

/**
 * CloudTrail's LookupEvents through the `aws` CLI the job already carries,
 * with the credentials it already has. Only `aws_` resources are searched.
 */
export function awsAuditLog(o: AwsAuditOptions = {}): AuditLog {
  const run =
    o.run ??
    ((args: string[]) => {
      const p = spawnSync("aws", args, { encoding: "utf-8", maxBuffer: 1 << 26 });
      return { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "", error: p.error };
    });
  return {
    async lookup(q) {
      if (!q.type.startsWith("aws_")) return { status: "unavailable", reason: `no audit log reader for ${q.type}` };
      const start = new Date((o.now?.() ?? new Date()).getTime() - (o.days ?? 14) * 86_400_000).toISOString();
      const p = run([
        "cloudtrail", "lookup-events", "--output", "json", "--max-results", "50", "--start-time", start,
        "--lookup-attributes", `AttributeKey=ResourceName,AttributeValue=${q.ref}`,
        ...(o.region ? ["--region", o.region] : []),
      ]);
      if (p.error || p.status !== 0) return { status: "unavailable", reason: (p.error?.message ?? (p.stderr.trim() || `aws exited ${p.status}`)).split("\n")[0]! };
      let doc: { Events?: { CloudTrailEvent?: string; EventName?: string; EventTime?: string }[] };
      try {
        doc = JSON.parse(p.stdout);
      } catch {
        return { status: "unavailable", reason: "aws printed no JSON" };
      }
      const events: TrailEvent[] = [];
      for (const e of doc.Events ?? []) {
        try {
          events.push({ eventName: e.EventName, eventTime: e.EventTime, ...(JSON.parse(e.CloudTrailEvent ?? "{}") as TrailEvent) });
        } catch {
          // a record that does not parse says nothing
        }
      }
      return newestActor(events);
    },
  };
}

// ── 3. the model, and the order ──────────────────────────────────────────────

/** A value as the model may read it: a number or a boolean as it is, anything else by its shape. A raw plan value never leaves the run. */
export function shown(value: unknown, sensitive?: boolean): unknown {
  if (sensitive) return "(sensitive)";
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return `(a string of ${value.length} characters)`;
  if (Array.isArray(value)) return `(a list of ${value.length})`;
  if (isMap(value)) return `(a map with keys ${Object.keys(value).slice(0, 12).join(", ")})`;
  return "(a value)";
}

export interface AttributeOptions {
  audit?: AuditLog;
  decide?: DecideSettings;
  options?: DecideOptions;
}

/** Where `tf-drift` leaves its attributions, in the report directory, for `respond drift` to read. */
export const ATTRIBUTIONS_FILE = "attributions.json";

export interface Attributed {
  attributions: Attribution[];
  /** Notes for the report: an unreadable log, a decision that was not used. */
  notes: string[];
}

/**
 * Attribute every drifted attribute of one root, in the order above. The
 * model is asked only for those neither the table nor the audit log answered,
 * and never when `decide` is absent.
 */
export async function attribute(root: string, found: Drifted[], o: AttributeOptions = {}): Promise<Attributed> {
  const attributions: Attribution[] = [];
  const notes: string[] = [];
  const auditCache = new Map<string, AuditAnswer>();
  let unavailable: string | undefined;
  for (const d of found) {
    for (const a of d.attributes) {
      const at = { root, address: d.address, path: a.path };
      const hit = a.sensitive ? undefined : knownWrite(d.type, a.path, a);
      if (hit) {
        attributions.push({ ...at, actor: hit.actor, source: "table", detail: hit.why });
        continue;
      }
      if (o.audit && d.ref && unavailable === undefined) {
        const key = `${d.type}\0${d.ref}`;
        let ans = auditCache.get(key);
        if (!ans) {
          ans = await o.audit.lookup({ type: d.type, address: d.address, ref: d.ref });
          auditCache.set(key, ans);
        }
        if (ans.status === "found") {
          attributions.push({ ...at, actor: ans.actor, source: "audit", detail: `${ans.event} by ${ans.who}${ans.at ? ` at ${ans.at}` : ""}` });
          continue;
        }
        if (ans.status === "unavailable") {
          unavailable = ans.reason;
          notes.push(`audit log unavailable: ${ans.reason}`);
        }
      }
      if (o.decide) {
        const state = { resource_type: d.type, attribute: a.path, value_in_code: shown(a.before, a.sensitive), live_value: shown(a.live, a.sensitive) };
        const record = await askModel(o.decide, state, { actor: DRIFT_ACTOR }, o.options);
        const decision = record.decisions.actor!;
        if (isConfident(decision)) {
          attributions.push({ ...at, actor: decision.answer as Actor, source: "model", detail: summarize(decision, record), probability: decision.probability });
          continue;
        }
        notes.push(`${d.address} ${a.path}: ${summarize(decision, record)}`);
      }
      attributions.push({ ...at, source: "unattributed", detail: "neither the known-writes table nor the audit log answered" + (o.decide ? ", and the decision was not used" : "") });
    }
  }
  return { attributions, notes };
}

// ── the route ────────────────────────────────────────────────────────────────

const SOURCE = { table: "known write", audit: "audit log", model: "model", unattributed: "unattributed" } as const;

export interface Routed {
  /** `address` -> the attributes the codify pull request leaves alone. */
  leave: Map<string, Set<string>>;
  /** Lines for the report, one per attribute. */
  lines: string[];
}

/**
 * The deterministic response each actor takes. A controller write and a
 * provider default change are suggestions in the report, so the codify pull
 * request leaves those attributes out; a person confirms what to write. A
 * human edit and an unattributed attribute keep the default response, the
 * codify pull request, which the owner reviews.
 */
export function route(attributions: Attribution[]): Routed {
  const leave = new Map<string, Set<string>>();
  const lines: string[] = [];
  for (const a of attributions) {
    const where = `\`${a.address}\` \`${a.path}\``;
    if (a.source === "unattributed") {
      lines.push(`- unattributed: ${where}: ${a.detail}; the default response runs`);
      continue;
    }
    const how = `${SOURCE[a.source]}: ${a.detail}`;
    if (a.actor === "human") {
      lines.push(`- human edit: ${where} (${how}); the pull request codifies it for the owner to accept or revert`);
      continue;
    }
    const set = leave.get(a.address) ?? new Set<string>();
    set.add(a.path);
    leave.set(a.address, set);
    if (a.actor === "controller") {
      lines.push(`- controller write: ${where} (${how}); add \`lifecycle { ignore_changes = [${a.path}] }\` to the resource, and leave it out of the code`);
    } else {
      lines.push(`- provider default change: ${where} (${how}); pin the version that kept the old value, or set \`${a.path}\` to the value you want`);
    }
  }
  return { leave, lines };
}

/** The drift with the attributes a route leaves out removed; an entry left with none is dropped. */
export function withoutLeft(found: Drifted[], leave: Map<string, Set<string>>): Drifted[] {
  return found
    .map((d) => ({ ...d, attributes: d.attributes.filter((a) => !leave.get(d.address)?.has(a.path)) }))
    .filter((d, i) => d.attributes.length > 0 || found[i]!.attributes.length === 0);
}
