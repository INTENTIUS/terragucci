/**
 * The audit trail: one JSON line per event, `terragucci.audit/v1`, built
 * from the records terragucci already keeps and from nothing else.
 *
 *   the ledger on chant/lifecycle   every line added to `_gates/tf-apply.jsonl`
 *                                   and `_gates/policy-override.jsonl`, and every
 *                                   approval or override line a commit removed,
 *                                   read from the branch's git history
 *                                   through chant's gate audit reader
 *                                   (`@intentius/chant/lifecycle/gate-audit`)
 *   the reports in the bucket       every `tf-apply` wave report a project's
 *                                   index lists
 *
 * Each entry's `id` is a digest of where it came from (the ledger line, or
 * the report's path and finish time), so building the entries again from the
 * same records gives the same ids. The record is append-only: `terragucci
 * audit` (../audit.ts) keeps every line the record holds and appends the
 * entries whose id it lacks.
 */
import { createHash } from "node:crypto";
import { deriveGateAudit, type GateAuditEntry, type GateLedgerLine } from "@intentius/chant/lifecycle/gate-audit";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { esc } from "./html";
import { failedRoots, type Report, type ReportRefusal } from "./schema";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";

export const AUDIT_SCHEMA = "terragucci.audit/v1";
export const AUDIT_SUMMARY_SCHEMA = "terragucci.audit-summary/v1";

/** The record, its page and its summary, at the top of the reports prefix. */
export const AUDIT_FILES = { record: "audit.jsonl", page: "audit.html", summary: "audit.json" } as const;

export const AUDIT_KINDS = ["approval-requested", "approval", "approval-revoked", "override-requested", "override", "override-revoked", "apply", "refused", "migration", "unlock", "state-export", "ephemeral-apply", "ephemeral-destroy"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Where an entry was read: a ledger line and the commit that added or removed it, or a report in the bucket. */
export interface AuditEvidence {
  source: "ledger" | "report";
  /** Ledger: the branch, the file and the commit. */
  branch?: string;
  path?: string;
  commit?: string;
  /** Report: the bucket and the key of its report.json. */
  bucket?: string;
  key?: string;
  /** A page that shows it: the commit on the forge, or the report's report.html. */
  url?: string;
  /** Report: the CI job that ran the wave. */
  job_url?: string;
}

export interface AuditEntry {
  schema: typeof AUDIT_SCHEMA;
  /** `sha256:` over where the entry came from; the same records give the same id. */
  id: string;
  kind: AuditKind;
  project: string;
  /** When it happened: the ledger line's timestamp, the commit that removed a line, or the run's finish. */
  at: string;
  /** Who: the approver, the overrider, whoever removed the line, or for an apply the approver its wave applied under. Null when nobody did (a job's request, a wave no gate held). */
  who: string | null;
  /** The gate (`wave-<k>`) or, for an override, the root. */
  what: string;
  /** The plan digest: a wave's set digest, or the digest an override binds. Null when the wave has none (a root failed to plan). */
  digest: string | null;
  result: string;
  evidence: AuditEvidence;
  /** What else the source says, by kind. */
  detail?: Record<string, unknown>;
}

export const LEDGER_BRANCH = "chant/lifecycle";
export const APPLY_LEDGER = "_gates/tf-apply.jsonl";
export const OVERRIDE_LEDGER_FILE = "_gates/policy-override.jsonl";
/** The state migrations' gates, and the record of each migration's writes beside them (../migrate.ts). */
export const MIGRATE_LEDGER_FILE = "_gates/tf-migrate.jsonl";
export const MIGRATE_DONE_FILE = "_gates/tf-migrate/done.jsonl";
/** The state locks' release gates, and the record of each lock released beside them (../unlock.ts). */
export const UNLOCK_LEDGER_FILE = "_gates/tf-unlock.jsonl";
export const UNLOCK_DONE_FILE = "_gates/tf-unlock/done.jsonl";
/** State exports: the requests and their approvals, and the record of each export written (../export.ts). */
export const EXPORT_LEDGER_FILE = "_gates/tf-state-export.jsonl";
export const EXPORT_DONE_FILE = "_gates/tf-state-export/done.jsonl";
/** Ephemeral environments: the gate of each pull request's copy, and the record of each apply and destroy of it (../ephemeral.ts). */
export const EPHEMERAL_LEDGER_FILE = "_gates/tf-ephemeral.jsonl";
export const EPHEMERAL_DONE_FILE = "_gates/tf-ephemeral/done.jsonl";

const sha = (...parts: string[]): string => `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;

type Line = Record<string, unknown>;

const parse = (text: string): Line | undefined => {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Line) : undefined;
  } catch {
    return undefined;
  }
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const drop = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>;

/** The op a gate-ledger file belongs to: `_gates/<op>.jsonl`. */
const opOf = (path: string): string => path.replace(/^_gates\//, "").replace(/\.jsonl$/, "");

const membersOf = (e: GateAuditEntry): { member?: string; planDigest?: string }[] => (Array.isArray(e.detail.members) ? (e.detail.members as { member?: string; planDigest?: string }[]) : []);

/**
 * The entries of one project's ledger file, from its history
 * (`gateLedgerLinesFromLog`). A gate ledger is read through chant's gate
 * audit reader; the `done.jsonl` records beside them are terragucci's own.
 * `commitUrl` gives the commit's page on the forge, when one is known.
 */
export function ledgerEntries(project: string, path: string, lines: readonly GateLedgerLine[], commitUrl: (commit: string) => string | undefined = () => undefined): AuditEntry[] {
  if (path === MIGRATE_DONE_FILE) return migrationEntries(project, lines, commitUrl);
  if (path === UNLOCK_DONE_FILE) return unlockEntries(project, lines, commitUrl);
  if (path === EXPORT_DONE_FILE) return exportEntries(project, lines, commitUrl);
  if (path === EPHEMERAL_DONE_FILE) return ephemeralEntries(project, lines, commitUrl);
  const override = path === OVERRIDE_LEDGER_FILE;
  const { entries } = deriveGateAudit({
    ledgers: [{ op: opOf(path), path, lines }],
    isOverride: () => override,
    // The ids the record already holds: over the line's text, and for a revocation also the commit that removed it.
    id: (e) => (e.kind === "revoked" ? sha("removed", project, path, e.source.commit ?? "", e.source.text ?? "") : e.source.text !== undefined ? sha("ledger", project, path, e.source.text) : e.id),
  });
  // In the order the history wrote them.
  const ordered = [...entries].sort((a, b) => (a.source.line ?? 0) - (b.source.line ?? 0));
  // An override answers the newest denial of its root and digest; that denial's member holds the root's plan digest.
  const denials = new Map<string, GateAuditEntry>();
  for (const e of ordered) if (e.kind === "override-requested" && e.digest) denials.set(`${e.gate}\n${e.digest}`, e);
  const out: AuditEntry[] = [];
  for (const e of ordered) {
    const commit = e.source.commit ?? "";
    const url = commitUrl(commit);
    const evidence: AuditEvidence = { source: "ledger", branch: LEDGER_BRANCH, path, commit, ...(url ? { url } : {}) };
    const base = { schema: AUDIT_SCHEMA, id: e.id, project, at: e.at, what: e.gate, digest: e.digest ?? null, evidence } as const;
    if (e.kind === "approval-requested" || e.kind === "override-requested") {
      out.push({
        ...base,
        kind: e.kind,
        who: null,
        result: override ? "denied" : "waiting",
        detail: drop({
          expires: e.expiresAt,
          run_id: e.runId,
          description: e.description,
          excluded: excludedOf(e.detail.excluded),
          ...(override ? { rules: e.rules ?? [], plan_digest: membersOf(e)[0]?.planDigest } : { roots: membersOf(e).map((m) => m.member).filter(Boolean) }),
        }),
      });
    } else if (e.kind === "approved" || e.kind === "override-recorded") {
      const denial = override && e.digest ? denials.get(`${e.gate}\n${e.digest}`) : undefined;
      out.push({
        ...base,
        kind: override ? "override" : "approval",
        who: e.by ?? null,
        result: e.seal ?? "unsigned",
        detail: drop({
          signer: e.signer,
          via: str(e.detail.via),
          pr: e.review?.pr,
          head: e.review?.head,
          reviewers: e.review?.approvers,
          reason: override ? e.note : undefined,
          rules: e.rules,
          plan_digest: denial ? membersOf(denial)[0]?.planDigest : undefined,
          // A service that wrote the line on a person's behalf names itself in relayedBy.
          relayed_by: e.relayedBy,
          committed_by: e.committedBy,
          excluded: excludedOf(e.detail.excluded),
        }),
      });
    } else if (e.kind === "revoked") {
      out.push({
        ...base,
        kind: e.subject === "override" ? "override-revoked" : "approval-revoked",
        who: e.by ?? null,
        result: "revoked",
        detail: drop({ approved_by: str(e.detail.approvedBy), approved_at: str(e.detail.approvedAt), signer: str(e.detail.signer) }),
      });
    }
  }
  return out;
}

/** The people an approval left out because they had a hand in the change (../involved.ts), as a ledger line or a report carries them. */
function excludedOf(v: unknown): { login: string; reason: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((e): e is { login: string; reason: string } => typeof e?.login === "string" && typeof e?.reason === "string").map((e) => ({ login: e.login, reason: e.reason }));
  return out.length ? out : undefined;
}

/** The lines commits added to one of terragucci's own records, with their text and commit. */
const addedLines = (lines: readonly GateLedgerLine[]): { text: string; commit: string }[] =>
  lines.flatMap((l) => (l.removed || l.text === undefined ? [] : [{ text: l.text, commit: l.commit ?? "" }]));

/** The id a wave report's entry gets: its project, its path in the bucket and when it finished. Known from an index row before the report is read. */
export const reportEntryId = (project: string, path: string, finished: string): string => sha("report", project, path, finished);

const at = (iso: string): number => Date.parse(iso) || 0;

/** A refusal a report from before minor 11 does not name: roots the policy denied that no override let through. */
function inferredRefusal(report: Report): ReportRefusal | undefined {
  const denied = report.roots.filter((r) => r.policy && r.policy.result !== "passed" && !r.policy.override && r.status === "failed").map((r) => r.path);
  return denied.length > 0 ? { reason: "policy", roots: denied.sort() } : undefined;
}

const REFUSED: Record<ReportRefusal["reason"], string> = {
  approval: "changed-after-approval",
  review: "changed-after-review",
  override: "changed-after-override",
  policy: "denied-by-policy",
  held: "held-by-another-apply",
  superseded: "superseded-by-a-newer-push",
};

/**
 * The entries of `_gates/tf-migrate/done.jsonl`: one per migration that ran
 * its writes, with who approved it, its digest, and each root's state
 * version before and after. Never a state's contents: the line holds none.
 */
function migrationEntries(project: string, lines: readonly GateLedgerLine[], commitUrl: (commit: string) => string | undefined): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const c of addedLines(lines)) {
    const r = parse(c.text);
    if (!r || r.version !== 1 || r.kind !== "migration" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const url = commitUrl(c.commit);
    out.push({
      schema: AUDIT_SCHEMA,
      id: sha("ledger", project, MIGRATE_DONE_FILE, c.text),
      kind: "migration",
      project,
      at: r.timestamp,
      who: str(r.approvedBy) ?? null,
      what: r.gate,
      digest: str(r.planDigest) ?? null,
      result: str(r.result) ?? "applied",
      evidence: { source: "ledger", branch: LEDGER_BRANCH, path: MIGRATE_DONE_FILE, commit: c.commit, ...(url ? { url } : {}) },
      detail: drop({ roots: Array.isArray(r.roots) ? r.roots : undefined, change: str(r.change), retags: Array.isArray(r.retags) ? r.retags : undefined, file_digest: str(r.file_digest), error: str(r.error), commit: str(r.commit), run_id: str(r.runId) }),
    });
  }
  return out;
}

/**
 * The entries of `_gates/tf-unlock/done.jsonl`: one per state lock released,
 * with who released it, who approved it, and the lock it was: its ID, who
 * took it and when.
 */
function unlockEntries(project: string, lines: readonly GateLedgerLine[], commitUrl: (commit: string) => string | undefined): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const c of addedLines(lines)) {
    const r = parse(c.text);
    if (!r || r.version !== 1 || r.kind !== "unlock" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const url = commitUrl(c.commit);
    const lock = r.lock && typeof r.lock === "object" ? (r.lock as Line) : {};
    out.push({
      schema: AUDIT_SCHEMA,
      id: sha("ledger", project, UNLOCK_DONE_FILE, c.text),
      kind: "unlock",
      project,
      at: r.timestamp,
      who: str(r.releasedBy) ?? null,
      what: r.gate,
      digest: str(r.planDigest) ?? null,
      result: "released",
      evidence: { source: "ledger", branch: LEDGER_BRANCH, path: UNLOCK_DONE_FILE, commit: c.commit, ...(url ? { url } : {}) },
      detail: drop({
        location: str(r.location),
        lock_id: str(lock.ID),
        operation: str(lock.Operation),
        locked_by: str(lock.Who),
        locked_at: str(lock.Created),
        approved_by: str(r.approvedBy),
        approved_at: str(r.approvedAt),
        commit: str(r.commit),
      }),
    });
  }
  return out;
}

/**
 * The entries of `_gates/tf-state-export/done.jsonl`: one per state version
 * exported, naming who exported it, the root and version, who approved it,
 * and the digest of the bytes written. Never the state's contents.
 */
function exportEntries(project: string, lines: readonly GateLedgerLine[], commitUrl: (commit: string) => string | undefined): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const c of addedLines(lines)) {
    const r = parse(c.text);
    if (!r || r.version !== 1 || r.kind !== "state-export" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const url = commitUrl(c.commit);
    out.push({
      schema: AUDIT_SCHEMA,
      id: sha("ledger", project, EXPORT_DONE_FILE, c.text),
      kind: "state-export",
      project,
      at: r.timestamp,
      who: str(r.exportedBy) ?? null,
      what: r.gate,
      digest: str(r.planDigest) ?? null,
      result: "exported",
      evidence: { source: "ledger", branch: LEDGER_BRANCH, path: EXPORT_DONE_FILE, commit: c.commit, ...(url ? { url } : {}) },
      detail: drop({ location: str(r.location), version_id: str(r.version_id), approved_by: str(r.approvedBy), approved_at: str(r.approvedAt), content_digest: str(r.content_digest) }),
    });
  }
  return out;
}

/**
 * The entries of `_gates/tf-ephemeral/done.jsonl`: one per apply of a pull
 * request's ephemeral copy, and one per destroy of it, with why it was
 * destroyed (its pull request closed, or its TTL passed), the digest of the
 * destroy's plans and each root's state. Never a state's contents.
 */
function ephemeralEntries(project: string, lines: readonly GateLedgerLine[], commitUrl: (commit: string) => string | undefined): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const c of addedLines(lines)) {
    const r = parse(c.text);
    if (!r || r.version !== 1 || (r.kind !== "ephemeral-apply" && r.kind !== "ephemeral-destroy") || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const url = commitUrl(c.commit);
    const roots = Array.isArray(r.roots) ? (r.roots as Line[]).map((x) => drop({ root: str(x.root), location: str(x.location), result: str(x.result) })) : undefined;
    out.push({
      schema: AUDIT_SCHEMA,
      id: sha("ledger", project, EPHEMERAL_DONE_FILE, c.text),
      kind: r.kind,
      project,
      at: r.timestamp,
      who: str(r.by) ?? null,
      what: r.gate,
      digest: str(r.planDigest) ?? null,
      result: str(r.result) ?? (r.kind === "ephemeral-apply" ? "applied" : "destroyed"),
      evidence: { source: "ledger", branch: LEDGER_BRANCH, path: EPHEMERAL_DONE_FILE, commit: c.commit, ...(url ? { url } : {}) },
      detail: drop({
        pull_request: typeof r.pr === "number" ? r.pr : undefined,
        suffix: str(r.suffix),
        roots,
        reason: str(r.reason),
        expires: str(r.expiresAt),
        approved_by: str(r.approvedBy),
        commit: str(r.commit),
        run_id: str(r.runId),
      }),
    });
  }
  return out;
}

/** The state version each root of an apply report recorded, by root: the version id, never the contents. Undefined when none recorded one. */
function stateVersions(report: Report): { root: string; location?: string; version_id?: string; versioning: string }[] | undefined {
  const rows = report.roots.filter((r) => r.state).map((r) => ({ root: r.path, ...(r.state!.location ? { location: r.state!.location } : {}), ...(r.state!.version_id ? { version_id: r.state!.version_id } : {}), versioning: r.state!.versioning }));
  return rows.length > 0 ? rows : undefined;
}

/**
 * The entry of one `tf-apply` wave report. An applied wave names the
 * approval it applied under: the newest approval entry of its gate and
 * digest written before it finished.
 */
export function reportEntry(report: Report, path: string, evidence: AuditEvidence, approvals: AuditEntry[]): AuditEntry | undefined {
  const wave = report.waves[0];
  if (report.run.stage !== "tf-apply" || !wave) return undefined;
  const project = report.run.project;
  const gate = `wave-${report.run.wave ?? wave.number}`;
  const base = {
    schema: AUDIT_SCHEMA,
    id: reportEntryId(project, path, report.run.finished),
    project,
    at: report.run.finished,
    what: gate,
    digest: wave.set_digest,
    evidence: { ...evidence, ...(report.run.job_url ? { job_url: report.run.job_url } : {}) },
  } as const;
  const common = {
    wave: wave.number,
    commit: report.run.commit,
    roots: wave.roots,
    pull_request: report.run.pull_request,
  };
  const refused = wave.refused ?? inferredRefusal(report);
  if (refused) {
    const rules = refused.reason === "policy" ? Object.fromEntries(report.roots.filter((r) => refused.roots.includes(r.path)).map((r) => [r.path, r.policy?.rules ?? []])) : undefined;
    return {
      ...base,
      kind: "refused",
      who: refused.by ?? null,
      result: REFUSED[refused.reason],
      detail: drop({ ...common, approved: refused.approved, moved: refused.reason === "policy" ? undefined : refused.roots, denied: refused.reason === "policy" ? refused.roots : undefined, rules, holder: refused.holder }),
    };
  }
  const failed = failedRoots(report);
  const result = failed.length > 0 ? "failed" : wave.approval === "waiting" ? "waiting" : "applied";
  const standing =
    wave.approval === "approved" && wave.set_digest
      ? approvals
          .filter((a) => a.project === project && a.kind === "approval" && a.what === gate && samePlanDigest(a.digest ?? undefined, wave.set_digest!) && at(a.at) <= at(report.run.finished))
          // An approval the rule left out (../involved.ts) is not the one the wave applied under.
          .filter((a) => !(wave.excluded_approvers ?? []).some((e) => a.who !== null && e.login.toLowerCase() === a.who.toLowerCase()))
          .sort((a, b) => at(b.at) - at(a.at))
      : [];
  const approval = standing[0];
  // approval_rules (../approval-rules.ts): every approval the rules counted, newest first, each approver's newest.
  const ruled = new Set((wave.approval_rules ?? []).flatMap((r) => r.approvers.map((who) => who.toLowerCase())));
  const counted = ruled.size > 0 ? standing.filter((a, i) => a.who !== null && ruled.has(a.who.toLowerCase()) && standing.findIndex((b) => b.who?.toLowerCase() === a.who!.toLowerCase()) === i) : [];
  const overrides = report.roots
    .filter((r) => r.policy?.override)
    .map((r) => ({ root: r.path, by: r.policy!.override!.by, rules: r.policy!.override!.rules, reason: r.policy!.override!.reason, digest: r.policy!.override!.digest }));
  return {
    ...base,
    kind: "apply",
    who: approval?.who ?? (overrides.length > 0 ? overrides.map((o) => o.by).join(", ") : null),
    result,
    detail: drop({ ...common, gate: wave.approval, approval: approval?.id, approvals: counted.length > 0 ? counted.map((a) => a.id) : undefined, approvers: ruled.size > 0 ? [...new Set((wave.approval_rules ?? []).flatMap((r) => r.approvers))] : undefined, policy: wave.policy_gate ? { outcome: wave.policy_gate.outcome, rules: wave.policy_gate.rules, commit: wave.policy_gate.commit } : undefined, excluded: excludedOf(wave.excluded_approvers), changes: { create: report.totals.create, update: report.totals.update, replace: report.totals.replace, delete: report.totals.delete }, failed, overrides, state_versions: stateVersions(report) }),
  };
}

/** The record's lines: each entry it holds, and the ids. A line that is not an entry is kept as it is and counts for nothing. */
export function readRecord(text: string | undefined): { lines: string[]; entries: AuditEntry[]; ids: Set<string> } {
  const lines = (text ?? "").split("\n").filter((l) => l.trim() !== "");
  const entries: AuditEntry[] = [];
  for (const l of lines) {
    const e = parse(l) as AuditEntry | undefined;
    if (e && e.schema === AUDIT_SCHEMA && typeof e.id === "string") entries.push(e);
  }
  return { lines, entries, ids: new Set(entries.map((e) => e.id)) };
}

const order = (a: AuditEntry, b: AuditEntry): number => at(a.at) - at(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The entries `derived` holds that the record does not, oldest first, each once. */
export function missingEntries(record: ReturnType<typeof readRecord>, derived: AuditEntry[]): AuditEntry[] {
  const seen = new Set(record.ids);
  const out: AuditEntry[] = [];
  for (const e of derived) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort(order);
}

/** An entry's line: its fields in the schema's order, so every line reads the same way. */
export function entryLine(e: AuditEntry): string {
  const { schema, id, kind, project, at: when, who, what, digest, result, evidence, detail } = e;
  return JSON.stringify({ schema, id, kind, project, at: when, who, what, digest, result, evidence, ...(detail && Object.keys(detail).length ? { detail } : {}) });
}

/** The record with the missing entries appended: every line it held stays, in its place. */
export function appendEntries(record: ReturnType<typeof readRecord>, added: AuditEntry[]): string {
  const lines = [...record.lines, ...added.map(entryLine)];
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** One project's sources, as the command read them. */
export interface AuditProject {
  project: string;
  /** read: its chant/lifecycle history was read; none: it has no chant/lifecycle yet; error: it could not be read. */
  ledger: "read" | "none" | "error";
  /** Wave reports read for this run (reports already in the record are not read again). */
  reports: number;
  /** Why the ledger or the index could not be read. */
  error?: string;
}

export interface AuditSummary {
  schema: typeof AUDIT_SUMMARY_SCHEMA;
  generated: string;
  /** The record, beside this summary. */
  record: typeof AUDIT_FILES.record;
  /** Entries in the record now, and how many this run appended. */
  entries: number;
  added: number;
  kinds: Partial<Record<AuditKind, number>>;
  projects: AuditProject[];
}

export function summarize(entries: AuditEntry[], added: number, projects: AuditProject[], now: Date): AuditSummary {
  const kinds: Partial<Record<AuditKind, number>> = {};
  for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  return { schema: AUDIT_SUMMARY_SCHEMA, generated: now.toISOString(), record: AUDIT_FILES.record, entries: entries.length, added, kinds, projects };
}

/** How many of the newest entries the page lists; the record holds them all. */
export const AUDIT_PAGE_ROWS = 1000;

const short = (d: string | null): string => (d ? `<code title="${esc(d)}">${esc(d.replace(/^(jcs1-)?sha256:/, "").slice(0, 12))}</code>` : "");

/**
 * The page: counts by kind, the projects and whether their ledger was read,
 * and the newest entries, each with a link to its evidence. It reads with
 * scripts off; the summary rides inline as JSON.
 */
export function renderAuditHtml(summary: AuditSummary, entries: AuditEntry[]): string {
  const newest = [...entries].sort((a, b) => order(b, a)).slice(0, AUDIT_PAGE_ROWS);
  const tiles = AUDIT_KINDS.filter((k) => summary.kinds[k]).map((k) => `<div class="tile"><b>${summary.kinds[k]}</b><span>${esc(k)}</span></div>`);
  const projects = summary.projects.map((p) => {
    const ledger = p.ledger === "error" ? `<span class="bad">could not be read: ${esc(p.error ?? "")}</span>` : p.ledger === "none" ? `<span class="none">no ${LEDGER_BRANCH} yet</span>` : "read";
    return `<tr><td>${esc(p.project)}</td><td>${ledger}</td><td>${p.reports}${p.ledger !== "error" && p.error ? ` <span class="bad">${esc(p.error)}</span>` : ""}</td></tr>`;
  });
  const rows = newest.map((e) => {
    const link = e.evidence.url ? `<a href="${esc(e.evidence.url)}">${e.evidence.source}</a>` : esc(e.evidence.source);
    const cls = e.kind === "refused" || e.result === "failed" || e.kind.endsWith("-revoked") ? ` class="warn"` : "";
    return `<tr${cls}><td><time datetime="${esc(e.at)}">${esc(e.at)}</time></td><td>${esc(e.project)}</td><td>${esc(e.kind)}</td><td>${esc(e.what)}</td><td>${esc(e.who ?? "")}</td><td>${short(e.digest)}</td><td>${esc(e.result)}</td><td>${link}</td></tr>`;
  });
  const json = JSON.stringify(summary).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>terragucci audit trail</title>
${TACO_ICON}
<style>${TACO_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--dim:#6b6b64;--line:#deded8;--link:#1f5fbf;--warn:#9a5b00;--bad:#b3261e;--tile:#f0f0ec}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--dim:#a3a39a;--line:#34342f;--link:#8ab4ff;--warn:#f0b35a;--bad:#ff8a80;--tile:#1f1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:16px}a{color:var(--link)}h2{font-size:16px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.tile{background:var(--tile);border-radius:6px;padding:10px 12px}.tile b{display:block;font-size:24px}.tile span{color:var(--dim)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 12px 6px 0;text-align:left;vertical-align:top}th{color:var(--dim);font-weight:600}.none{color:var(--dim)}tr.warn td{color:var(--warn)}.bad{color:var(--bad)}code{font:12.5px ui-monospace,Menlo,monospace}</style>
</head><body><main><h1 class="brand">${TACO_IMG}Audit trail</h1>
<p>${summary.entries} entries in <a href="${AUDIT_FILES.record}">${AUDIT_FILES.record}</a>, ${summary.added} added by the run of <time datetime="${esc(summary.generated)}">${esc(summary.generated)}</time>. Built from each project's ${LEDGER_BRANCH} history and its wave reports.</p>
<div class="tiles">${tiles.join("")}</div>
<h2>Projects</h2>
<div class="scroll"><table><tr><th>Project</th><th>Ledger</th><th>Wave reports read</th></tr>
${projects.join("\n")}
</table></div>
<h2>${newest.length < entries.length ? `The newest ${newest.length} entries` : "Entries"}</h2>
${rows.length ? `<div class="scroll"><table><tr><th>When</th><th>Project</th><th>Kind</th><th>What</th><th>Who</th><th>Digest</th><th>Result</th><th>Evidence</th></tr>\n${rows.join("\n")}\n</table></div>` : `<p class="none">No entries yet.</p>`}
</main>
<script type="application/json" id="terragucci-audit">${json}</script>
</body></html>
`;
}
