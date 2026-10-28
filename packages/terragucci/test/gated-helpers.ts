/**
 * For the tests of a lock release, a state export and a standalone
 * migration, which run on either chant: with the terraform lexicon's
 * state operations (chant#4618) they are chant's gated requests, whose
 * digest chant computes and whose record is a `finished` line in
 * `_gates/<op>/applied.jsonl`; without them terragucci's own gate runs and
 * writes `_gates/<op>/done.jsonl`.
 */
import { readLedger } from "../src/apply";
import { chantStateOps } from "../src/chant-next";
import { MIGRATE_LEDGER, migrationHistory } from "../src/migrate";

/** Whether the installed chant runs these operations as gated requests. */
export const chantGated = async (): Promise<boolean> => !!(await chantStateOps());

/** chant's request, as its pending line carries it. */
export interface GatedRequest {
  kind: string;
  subject: string;
  by: string;
  at: string;
  fields: Record<string, string>;
}

/** The digest chant binds a request to (`gatedRequestDigest`); only called on a chant with state operations. */
export async function chantRequestDigest(op: string, request: GatedRequest): Promise<string> {
  const m = (await chantStateOps()) as unknown as { gatedRequestDigest(op: string, r: GatedRequest): string };
  return m.gatedRequestDigest(op, request);
}

/** One `finished` line of `_gates/<op>/applied.jsonl`. */
export interface FinishedLine {
  kind: "finished";
  op: string;
  gate: string;
  planDigest: string;
  applied: string;
  result: "applied" | "failed";
  timestamp: string;
  detail?: Record<string, string | number | boolean>;
}

/** The lines of an applied.jsonl text, by kind. */
export function appliedLines(text: string): { applied: Array<Record<string, unknown>>; finished: FinishedLine[] } {
  const applied: Array<Record<string, unknown>> = [];
  const finished: FinishedLine[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.kind === "applied") applied.push(r);
      else if (r.kind === "finished") finished.push(r as unknown as FinishedLine);
    } catch {
      continue;
    }
  }
  return { applied, finished };
}

/** Where chant records a gated request's spend and its end. */
export const appliedFile = (op: string): string => `_gates/${op}/applied.jsonl`;

/**
 * An export request as a pending line carries it, flat on either path:
 * chant's `{ kind, subject, by, at, fields }` or terragucci's
 * `{ root, location, version_id, by, at }`.
 */
export function exportRequest(pending: { request?: Record<string, unknown> }): { root?: string; location?: string; version_id?: string; by?: string; at?: string } {
  const r = pending.request ?? {};
  if (r.fields && typeof r.fields === "object") {
    const f = r.fields as Record<string, string>;
    return { root: r.subject as string, location: f.location, version_id: f.version_id, by: r.by as string, at: r.at as string };
  }
  return r as { root?: string; location?: string; version_id?: string; by?: string; at?: string };
}

/** The exports recorded, flat, from the file the path records them in: `show` reads a path on chant/lifecycle (empty when it is not there). */
export function exportRecords(chantOps: boolean, show: (path: string) => string): Array<{ kind: string; root: string; planDigest: string; location?: string; version_id?: string; exportedBy?: string; approvedBy?: string; content_digest?: string }> {
  const text = show(chantOps ? appliedFile("tf-state-export") : "_gates/tf-state-export/done.jsonl");
  if (!chantOps) {
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "state-export");
  }
  return appliedLines(text).finished.map((f) => ({
    kind: "state-export",
    root: f.gate,
    planDigest: f.planDigest,
    location: f.detail?.location as string,
    version_id: f.detail?.version_id as string,
    exportedBy: f.detail?.by as string,
    approvedBy: f.detail?.approved_by as string,
    content_digest: f.detail?.content_digest as string,
  }));
}

/** The lock releases recorded, flat, from the file the path records them in. */
export function unlockRecords(chantOps: boolean, show: (path: string) => string): Array<{ root: string; planDigest: string; location?: string; lockId?: string; approvedBy?: string; releasedBy?: string }> {
  const text = show(chantOps ? appliedFile("tf-unlock") : "_gates/tf-unlock/done.jsonl");
  if (!chantOps) {
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "unlock")
      .map((r) => ({ root: r.root, planDigest: r.planDigest, location: r.location, lockId: r.lock?.ID, approvedBy: r.approvedBy, releasedBy: r.releasedBy }));
  }
  return appliedLines(text).finished.map((f) => ({
    root: f.gate,
    planDigest: f.planDigest,
    location: f.detail?.location as string,
    lockId: f.detail?.lock_id as string,
    approvedBy: f.detail?.approved_by as string,
    releasedBy: f.detail?.by as string,
  }));
}

/**
 * A migration's newest record on origin's chant/lifecycle, in done.jsonl's
 * line form on either path (../src/migrate.ts migrationHistory: a done.jsonl
 * line, or chant's finished line read back), with the text it came from.
 */
export function migrationRecord(work: string, name: string): { line: Record<string, unknown>; text: string } {
  readLedger(work, MIGRATE_LEDGER);
  const text = migrationHistory(work);
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.gate === name);
  const line = lines.at(-1);
  if (!line) throw new Error(`chant/lifecycle records no migration ${name}`);
  return { line, text };
}
