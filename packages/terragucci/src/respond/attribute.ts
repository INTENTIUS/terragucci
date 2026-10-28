/**
 * Drift attribution (terragucci#31): who changed a drifted attribute, so the
 * response can fit. Evidence is asked for in a fixed order, and the first
 * step that answers ends the question for that attribute:
 *
 *   1. KNOWN_WRITES, chant's table of attributes that a controller or
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
 *
 * The known-writes table and the CloudTrail reader are chant core's
 * (`@intentius/chant/ci-audit`, chant#4632, moved there from this file).
 */
import { awsAuditLog as chantAwsAuditLog, knownWrite, type AuditAnswer, type AuditQuery, type AwsAuditOptions } from "@intentius/chant/ci-audit";
import { decide as askModel, isConfident, summarize } from "../decide";
import { DRIFT_ACTOR } from "../decide/questions";
import type { DecideOptions, DecideSettings } from "../decide";
import type { Drifted } from "./drift";

export type { AuditAnswer, AuditQuery, AwsAuditOptions };

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

// ── 1. the table, and 2. the audit log ───────────────────────────────────────

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What attribution needs from a cloud's audit log. Tests use a fake; `awsAuditLog` reads CloudTrail. */
export interface AuditLog {
  lookup(q: AuditQuery): Promise<AuditAnswer>;
}

/**
 * CloudTrail's LookupEvents through the `aws` CLI when the job has installed it (the images do not carry it),
 * with the credentials it already has: chant's reader (chant#4632).
 */
export function awsAuditLog(o: AwsAuditOptions = {}): AuditLog {
  return chantAwsAuditLog(o);
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
