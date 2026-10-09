/**
 * The audit trail: one JSON line per event, `terragucci.audit/v1`, built
 * from the records terragucci already keeps and from nothing else.
 *
 *   the ledger on chant/lifecycle   every line added to `_gates/tf-apply.jsonl`
 *                                   and `_gates/policy-override.jsonl`, and every
 *                                   approval or override line a commit removed,
 *                                   read from the branch's git history
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
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { esc } from "./html";
import type { Report, ReportRefusal } from "./schema";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";

export const AUDIT_SCHEMA = "terragucci.audit/v1";
export const AUDIT_SUMMARY_SCHEMA = "terragucci.audit-summary/v1";

/** The record, its page and its summary, at the top of the reports prefix. */
export const AUDIT_FILES = { record: "audit.jsonl", page: "audit.html", summary: "audit.json" } as const;

export const AUDIT_KINDS = ["approval-requested", "approval", "approval-revoked", "override-requested", "override", "override-revoked", "apply", "refused"] as const;
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

/** One line a commit added to or removed from a ledger file. */
export interface LedgerChange {
  line: string;
  added: boolean;
  commit: string;
  author: string;
  date: string;
}

export const LEDGER_BRANCH = "chant/lifecycle";
export const APPLY_LEDGER = "_gates/tf-apply.jsonl";
export const OVERRIDE_LEDGER_FILE = "_gates/policy-override.jsonl";

const sha = (...parts: string[]): string => `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;

/**
 * The lines each commit added and removed, from `git log -p --unified=0`
 * written with `--format=%x1e%H%x1f%an%x1f%aI`, oldest first. A line removed
 * and added again in one commit (a newline fixed at the end of the file) is
 * neither.
 */
export function parseLedgerLog(log: string): LedgerChange[] {
  const out: LedgerChange[] = [];
  for (const block of log.split("\x1e").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [commit = "", author = "", date = ""] = head.split("\x1f");
    const net = new Map<string, number>();
    const order: string[] = [];
    for (const l of rest) {
      const sign = l[0];
      if ((sign !== "+" && sign !== "-") || l[1] !== "{") continue;
      const text = l.slice(1).trim();
      if (!net.has(text)) order.push(text);
      net.set(text, (net.get(text) ?? 0) + (sign === "+" ? 1 : -1));
    }
    for (const text of order) {
      const n = net.get(text)!;
      const when = Date.parse(date.trim());
      for (let i = 0; i < Math.abs(n); i++) out.push({ line: text, added: n > 0, commit: commit.trim(), author, date: Number.isNaN(when) ? date.trim() : new Date(when).toISOString() });
    }
  }
  return out;
}

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

/** How a ledger line was signed: a pull request's review, a seal, or neither. */
function signed(r: Line): "review" | "sealed" | "unsigned" {
  if (r.via === "pr-review") return "review";
  const seal = r.seal as { signature?: unknown } | null | undefined;
  return seal && seal.signature ? "sealed" : "unsigned";
}

const drop = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>;

/**
 * The entries of one project's ledger file, from its history. `path` says
 * which file: the waves' gates or the policy overrides. `commitUrl` gives the
 * commit's page on the forge, when one is known.
 */
export function ledgerEntries(project: string, path: string, changes: LedgerChange[], commitUrl: (commit: string) => string | undefined = () => undefined): AuditEntry[] {
  const override = path === OVERRIDE_LEDGER_FILE;
  // An override line names its digest; the denial it answers (a pending line of that digest) holds the rules and the root's plan digest.
  const denials = new Map<string, Line>();
  for (const c of changes) {
    const r = c.added ? parse(c.line) : undefined;
    if (r && r.kind === "pending" && str(r.planDigest)) denials.set(`${String(r.gate)}\n${String(r.planDigest)}`, r);
  }
  const out: AuditEntry[] = [];
  for (const c of changes) {
    const r = parse(c.line);
    if (!r || r.version !== 1 || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const url = commitUrl(c.commit);
    const evidence: AuditEvidence = { source: "ledger", branch: LEDGER_BRANCH, path, commit: c.commit, ...(url ? { url } : {}) };
    const base = { schema: AUDIT_SCHEMA, project, what: r.gate, digest: str(r.planDigest) ?? null, evidence } as const;
    const pending = r.kind === "pending";
    if (!pending && typeof r.resolvedBy !== "string") continue;
    if (c.added && pending) {
      const members = Array.isArray(r.members) ? (r.members as { member?: string; planDigest?: string }[]) : [];
      out.push({
        ...base,
        id: sha("ledger", project, path, c.line),
        kind: override ? "override-requested" : "approval-requested",
        at: r.timestamp,
        who: null,
        result: override ? "denied" : "waiting",
        detail: drop({
          expires: str(r.expiresAt),
          run_id: str(r.runId),
          description: str(r.description),
          ...(override ? { rules: Array.isArray(r.rules) ? r.rules : [], plan_digest: members[0]?.planDigest } : { roots: members.map((m) => m.member).filter(Boolean) }),
        }),
      });
      continue;
    }
    if (pending) continue;
    const seal = r.seal as { signer?: unknown } | null | undefined;
    if (c.added) {
      const denial = override ? denials.get(`${r.gate}\n${String(r.planDigest)}`) : undefined;
      const denied = denial && Array.isArray(denial.members) ? (denial.members as { planDigest?: string }[])[0]?.planDigest : undefined;
      out.push({
        ...base,
        id: sha("ledger", project, path, c.line),
        kind: override ? "override" : "approval",
        at: r.timestamp,
        who: r.resolvedBy as string,
        result: signed(r),
        detail: drop({
          signer: seal && typeof seal.signer === "string" ? seal.signer : undefined,
          via: str(r.via),
          pr: typeof r.pr === "number" ? r.pr : undefined,
          head: str(r.head),
          reviewers: Array.isArray(r.reviewers) ? r.reviewers : undefined,
          reason: override ? str(r.note) : undefined,
          rules: denial && Array.isArray(denial.rules) ? denial.rules : undefined,
          plan_digest: denied,
          // A service that wrote the line on a person's behalf names itself in relayedBy.
          relayed_by: str(r.relayedBy),
          committed_by: c.author,
        }),
      });
    } else {
      out.push({
        ...base,
        id: sha("removed", project, path, c.commit, c.line),
        kind: override ? "override-revoked" : "approval-revoked",
        at: c.date,
        who: c.author || null,
        result: "revoked",
        detail: drop({ approved_by: r.resolvedBy as string, approved_at: r.timestamp, signer: seal && typeof seal.signer === "string" ? seal.signer : undefined }),
      });
    }
  }
  return out;
}

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
};

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
      detail: drop({ ...common, approved: refused.approved, moved: refused.reason === "policy" ? undefined : refused.roots, denied: refused.reason === "policy" ? refused.roots : undefined, rules }),
    };
  }
  const failed = report.roots.filter((r) => r.status === "failed" && !r.terragrunt?.provisional).map((r) => r.path);
  const result = failed.length > 0 ? "failed" : wave.approval === "waiting" ? "waiting" : "applied";
  const approval =
    wave.approval === "approved" && wave.set_digest
      ? approvals
          .filter((a) => a.project === project && a.kind === "approval" && a.what === gate && samePlanDigest(a.digest ?? undefined, wave.set_digest!) && at(a.at) <= at(report.run.finished))
          .sort((a, b) => at(b.at) - at(a.at))[0]
      : undefined;
  const overrides = report.roots
    .filter((r) => r.policy?.override)
    .map((r) => ({ root: r.path, by: r.policy!.override!.by, rules: r.policy!.override!.rules, reason: r.policy!.override!.reason, digest: r.policy!.override!.digest }));
  return {
    ...base,
    kind: "apply",
    who: approval?.who ?? (overrides.length > 0 ? overrides.map((o) => o.by).join(", ") : null),
    result,
    detail: drop({ ...common, gate: wave.approval, approval: approval?.id, changes: { create: report.totals.create, update: report.totals.update, replace: report.totals.replace, delete: report.totals.delete }, failed, overrides, state_versions: stateVersions(report) }),
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
