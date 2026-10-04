/**
 * Build a `terragucci.report/v1` document from each root's plan. The roots'
 * plans become chant change-set parts (`terraformChangeSetPart`), composed
 * into one document whose digest is the set digest, and grouped by chant's
 * plan summary. The report adds what a reader needs on top: links to every
 * root's full plan, every destroy by name, and what is open or folded.
 */
import { changeSetDigest, composeChangeSet, type ChangeSetEntry, type ChangeSetPart, type ChangeSetPlanner } from "@intentius/chant/change-set";
import { groupChangeSet } from "@intentius/chant/plan-summary";
import { terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { changeKind, foldChange } from "./highlight";
import {
  REDACTED, REPORT_MINOR, REPORT_SCHEMA,
  type Highlight, type Report, type ReportChange, type ReportGroup, type ReportNamed, type ReportRoot, type ReportRun, type ReportWave,
} from "./schema";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export interface RootInput {
  /** The root's directory, relative to the repo. */
  path: string;
  /** `show -json` as the binary wrote it, unredacted. Absent when the root failed to plan. */
  plan?: unknown;
  /** Why the root failed to plan. */
  error?: string;
  planner?: ChangeSetPlanner;
  /** Where the root's full plan is kept, relative to the report. */
  files?: { text?: string; json?: string };
  job_url?: string;
  /** `type.name` of every resource declared with `prevent_destroy = true`. */
  preventDestroy?: ReadonlySet<string>;
}

export interface WaveInput {
  number: number;
  roots: string[];
  approval?: ReportWave["approval"];
  gate?: ReportWave["gate"];
}

export interface BuildInput {
  run: ReportRun;
  roots: RootInput[];
  waves?: WaveInput[];
  /** How many sensitive values were redacted from the stored plans. */
  redacted?: number;
}

/** The files a root's full plan is kept in, relative to the report: `roots/<root>/plan.{txt,json}`. */
export function planFiles(root: string): { text: string; json: string } {
  return { text: `roots/${root}/plan.txt`, json: `roots/${root}/plan.json` };
}

/** The HTML anchor of a root: `root-` and its path. */
export const rootAnchor = (root: string): string => `root-${root}`;
export const groupAnchor = (id: string): string => `group-${id}`;

interface Raw {
  mode?: string;
  replace_paths?: (string | number)[][];
  importing?: string;
}

function rawChanges(plan: unknown): Map<string, Raw> {
  const out = new Map<string, Raw>();
  const list = isObject(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  for (const r of list) {
    if (!isObject(r)) continue;
    const change = isObject(r.change) ? r.change : {};
    const paths = Array.isArray(change.replace_paths) ? (change.replace_paths.filter(Array.isArray) as (string | number)[][]) : [];
    const importing = isObject(change.importing) ? String(change.importing.id ?? change.importing.identity ?? "") : undefined;
    out.set(`${r.address}\u0000${r.deposed ?? ""}`, {
      ...(typeof r.mode === "string" ? { mode: r.mode } : {}),
      ...(paths.length > 0 ? { replace_paths: paths } : {}),
      ...(importing !== undefined ? { importing } : {}),
    });
  }
  return out;
}

function failedPart(r: RootInput): ChangeSetPart {
  return {
    member: {
      member: r.path, lexicon: "terraform", planner: r.planner ?? "terraform", status: "failed",
      error: r.error ?? "the root did not plan", planDigest: null, holes: [],
    },
    entries: [],
  };
}

function reportChange(e: ChangeSetEntry, raw: Raw | undefined, preventDestroy: ReadonlySet<string>): ReportChange {
  const writeOnly = e.attributes.map((a) => a.path).filter((p) => p.endsWith("_wo_version"));
  const base = {
    address: e.address,
    type: e.type,
    action: e.action,
    ...(e.disruption ? { disruption: e.disruption } : {}),
    ...(e.deposed !== undefined ? { deposed: e.deposed } : {}),
    ...(e.module ? { module: e.module } : {}),
    ...(e.index !== undefined ? { index: e.index } : {}),
    attributes: e.attributes,
    ...(raw?.replace_paths ? { replace_paths: raw.replace_paths } : {}),
    ...(raw?.importing !== undefined ? { importing: raw.importing } : {}),
    ...(writeOnly.length > 0 ? { write_only: writeOnly } : {}),
  };
  const kind = changeKind(e.action, e.attributes);
  const { fold, why } = foldChange({ ...base, kind }, preventDestroy.has(`${e.type}.${e.name ?? ""}`));
  return { ...base, ...(kind ? { kind } : {}), fold, ...(why ? { why } : {}) };
}

/** Per address, the attribute paths whose values differ between the group's roots. */
function varies(roots: ReportRoot[]): ReportGroup["varies"] {
  if (roots.length < 2) return [];
  const seen = new Map<string, Map<string, Set<string>>>();
  for (const r of roots) {
    for (const c of r.changes) {
      const byPath = seen.get(c.address) ?? new Map<string, Set<string>>();
      seen.set(c.address, byPath);
      for (const a of c.attributes) {
        const vals = byPath.get(a.path) ?? new Set<string>();
        byPath.set(a.path, vals);
        vals.add(JSON.stringify(a.sensitive ? REDACTED : a.unknown ? "(known after apply)" : (a.after ?? a.before ?? null)));
      }
    }
  }
  const out: ReportGroup["varies"] = [];
  for (const [address, byPath] of [...seen].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const paths = [...byPath].filter(([, v]) => v.size > 1).map(([p]) => p).sort();
    if (paths.length > 0) out.push({ address, paths });
  }
  return out;
}

export function buildReport(input: BuildInput): Report {
  const inputRun = input.run;
  const byPath = new Map(input.roots.map((r) => [r.path, r]));
  const parts = input.roots.map((r) =>
    r.plan !== undefined && r.error === undefined
      ? terraformChangeSetPart({ member: r.path, plan: r.plan, planner: r.planner ?? "terraform" })
      : failedPart(r),
  );
  const doc = composeChangeSet(parts);
  const summary = groupChangeSet(doc);
  const memberGroup = new Map<string, string>();
  if (summary.unit === "member") for (const g of summary.groups) for (const u of g.units) memberGroup.set(u, g.id);
  const outliers = new Set(summary.groups.filter((g) => g.outlier).flatMap((g) => g.units));

  const named: ReportNamed[] = [];
  const roots: ReportRoot[] = doc.members.map((m) => {
    const src = byPath.get(m.member)!;
    const raw = rawChanges(src.plan);
    const counts: ReportRoot["counts"] = {};
    const changes: ReportChange[] = [];
    for (const e of doc.entries) {
      if (e.member !== m.member) continue;
      const r = raw.get(`${e.address}\u0000${e.deposed ?? ""}`);
      // Ephemeral values exist only while one run lasts; they are not changes.
      if (r?.mode === "ephemeral" || e.address.startsWith("ephemeral.")) continue;
      counts[e.action] = (counts[e.action] ?? 0) + 1;
      if (e.action === "no-op" && r?.importing === undefined) continue;
      const c = reportChange(e, r, src.preventDestroy ?? new Set());
      changes.push(c);
      const action = c.importing !== undefined && c.action === "no-op" ? "import" : c.action;
      if (action === "delete" || action === "replace" || action === "forget" || action === "import") {
        named.push({
          root: m.member, address: c.address, type: c.type, action,
          ...(c.deposed !== undefined ? { deposed: c.deposed } : {}),
          ...(c.replace_paths ? { replace_paths: c.replace_paths } : {}),
        });
      }
    }
    if (m.status === "failed") named.push({ root: m.member, action: "refused", reason: m.error ?? "the root did not plan" });
    const highlights: Highlight[] = changes.filter((c) => c.why !== undefined).map((c) => ({ address: c.address, type: c.type, action: c.action, why: c.why! }));
    const why: string[] = [];
    if (m.status === "failed") why.push("refused to plan");
    if (outliers.has(m.member)) why.push("outlier: its change matches no other root's");
    if (highlights.length > 0) why.push(...new Set(highlights.map((h) => h.why)));
    const group = memberGroup.get(m.member);
    return {
      path: m.member,
      status: m.status,
      ...(m.error ? { error: m.error } : {}),
      plan_digest: m.planDigest,
      counts,
      ...(group ? { group } : {}),
      plan: src.files ?? (m.status === "planned" ? planFiles(m.member) : {}),
      // A root with no job of its own was planned by the run's job.
      ...(src.job_url ?? inputRun.job_url ? { job_url: src.job_url ?? inputRun.job_url } : {}),
      changes,
      highlights,
      fold: why.length > 0 ? "open" : "folded",
      why,
    };
  });

  const rootsByPath = new Map(roots.map((r) => [r.path, r]));
  const groups: ReportGroup[] = summary.groups.map((g) => {
    const members = summary.unit === "member" ? g.units.map((u) => rootsByPath.get(u)!).filter(Boolean) : [];
    const destroys = g.destroys.length;
    const why: string[] = [];
    if (g.outlier) why.push("outlier: read it on its own");
    if (destroys > 0) why.push(`${destroys} ${destroys === 1 ? "destroy or replacement" : "destroys or replacements"}`);
    const highlighted = [...new Set(members.flatMap((r) => r.highlights.filter((h) => h.action !== "delete" && h.action !== "replace").map((h) => h.why)))];
    why.push(...highlighted);
    return {
      id: g.id,
      ...(g.resource ? { resource: g.resource } : {}),
      units: g.units,
      outlier: g.outlier,
      noChanges: g.noChanges,
      changes: g.changes,
      ...(g.extends ? { extends: g.extends } : {}),
      ...(g.plus ? { plus: g.plus } : {}),
      destroys,
      varies: varies(members),
      fold: why.length > 0 ? "open" : "folded",
      why,
    };
  });

  const order: Record<ReportNamed["action"], number> = { refused: 0, delete: 1, replace: 2, forget: 3, import: 4 };
  named.sort((a, b) => order[a.action] - order[b.action] || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0) || ((a.address ?? "") < (b.address ?? "") ? -1 : 1));

  const waves: ReportWave[] = (input.waves ?? []).map((w) => {
    const members = doc.members.filter((m) => w.roots.includes(m.member));
    const failed = members.some((m) => m.planDigest === null);
    return {
      number: w.number,
      roots: w.roots,
      set_digest: failed || members.length === 0 ? null : changeSetDigest(members),
      approval: w.approval ?? "not-requested",
      ...(w.gate ? { gate: w.gate } : {}),
    };
  });

  return {
    schema: REPORT_SCHEMA,
    minor: REPORT_MINOR,
    run: input.run,
    change_set: doc.digest,
    unit: summary.unit,
    units: summary.units,
    totals: doc.summary.actions,
    groups,
    roots,
    waves,
    named,
    holes: summary.holes.map((h) => ({ root: h.member, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })),
    redaction: { marker: REDACTED, values: input.redacted ?? 0 },
  };
}
