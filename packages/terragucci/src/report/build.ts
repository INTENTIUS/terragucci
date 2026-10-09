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
import type { Gate } from "../config";
import { changesSomething, destroysSomething } from "./changing";
import { costMember } from "./cost";
import { changeKind, foldChange } from "./highlight";
import { planAppliedChanges } from "./history";
import { planResources } from "./inventory";
import { isObject, scrubSecrets, sensitiveStrings } from "./redact";
import {
  REDACTED, REPORT_MINOR, REPORT_SCHEMA,
  type ReportUnit,
  type ReportMockRead,
  type ReportDeferred,
  type ReportPolicy,
  type ReportRootPolicy,
  type ReportStateVersion,
  type ReportRootBinary,
  type ReportStep,
  type ReportRead,
  type WaveState,
  type Highlight, type Report, type ReportChange, type ReportGroup, type ReportNamed, type ReportRoot, type ReportRun, type ReportTip, type ReportWave, type ReportWaveCost,
} from "./schema";

type Json = Record<string, unknown>;

export interface RootInput {
  /** The root's directory, relative to the repo. */
  path: string;
  /** `show -json` as the binary wrote it, unredacted. Absent when the root failed to plan. */
  plan?: unknown;
  /** Why the root failed to plan. */
  error?: string;
  planner?: ChangeSetPlanner;
  /** The binary the root ran. */
  binary?: ReportRootBinary;
  /** Where the root's full plan is kept, relative to the report. */
  files?: { text?: string; json?: string };
  job_url?: string;
  /** `type.name` of every resource declared with `prevent_destroy = true`. */
  preventDestroy?: ReadonlySet<string>;
  /** Set when the root is a Terragrunt unit. */
  terragrunt?: ReportUnit;
  /**
   * The policy's verdict on its plan. A root it denied (or could not check)
   * carries both `plan` and `error`: it fails, with no plan digest, and its
   * changes stay in the report.
   */
  policy?: ReportRootPolicy;
  /** A `tf-apply` wave applied the root, or it had nothing to apply: the report lists the resources its plan leaves. */
  applied?: boolean;
  /** The state version the root's backend holds after the apply. */
  state?: ReportStateVersion;
  /** The steps that ran for it. */
  steps?: ReportStep[];
  /** The roots whose state it reads, and which outputs it planned on. */
  reads?: ReportRead[];
  /** A Terragrunt unit's dependencies, by path. */
  dependencies?: string[];
}

export interface WaveInput {
  number: number;
  roots: string[];
  approval?: ReportWave["approval"];
  gate?: ReportWave["gate"];
  waitingSince?: string;
  /** A `tf-apply` wave's gate digest, which the report shows as its set digest: the digest over the roots that change. */
  setDigest?: string;
  /** Why a `tf-apply` wave applied nothing although it planned. */
  refused?: ReportWave["refused"];
  /** The pull request whose review would approve a waiting `tf-apply` wave. */
  review?: ReportWave["review"];
  /** The roots whose `on_failure: approve` step failed: the gate holds the wave. */
  heldBySteps?: string[];
  /** The wave's monthly cost. With `approve_above` it joins the wave's digests, and a change over it makes the wave wait. */
  cost?: ReportWaveCost;
  /** Where the wave stands. */
  state?: WaveState;
  /** The waves whose roots its roots read. */
  reads?: number[];
  /** A `tf-plan` wave that plans again once these waves apply: no review digest binds it. */
  replansAfter?: number[];
}

export interface BuildInput {
  run: ReportRun;
  roots: RootInput[];
  waves?: WaveInput[];
  /** How many sensitive values were redacted from the stored plans. */
  redacted?: number;
  /** Advice to carry. Not part of any digest. Leave out with `tips: false`. */
  tips?: ReportTip[];
  /** Terragrunt dependencies that would have planned on mock_outputs. */
  mockReads?: ReportMockRead[];
  /** Terragrunt units that plan after other units apply. */
  deferred?: ReportDeferred[];
  /** The run's policy check, when `policy` is on. */
  policy?: ReportPolicy;
  /** A `tf-plan` run's gate policy: each wave then carries its review digest and whether the gate will hold it. */
  gate?: Gate;
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

/** A root the policy refused: it planned, so its changes are known, but it fails and no gate may bind its digest. */
const policyRefused = (r: RootInput): boolean => r.plan !== undefined && r.error !== undefined && r.policy !== undefined && r.policy.result !== "passed";

function plannedPart(r: RootInput): ChangeSetPart {
  const part = terraformChangeSetPart({ member: r.path, plan: r.plan, planner: r.planner ?? "terraform", ...(r.terragrunt ? { scope: r.terragrunt.stack } : {}) });
  if (!policyRefused(r)) return part;
  return { ...part, member: { ...part.member, status: "failed", error: r.error, planDigest: null } };
}

export function buildReport(input: BuildInput): Report {
  const inputRun = input.run;
  const byPath = new Map(input.roots.map((r) => [r.path, r]));
  const parts = input.roots.map((r) =>
    r.plan !== undefined && (r.error === undefined || policyRefused(r)) ? plannedPart(r) : failedPart(r),
  ).map((p, i) =>
    // A provisional plan stays out of the change set's digest and out of every group of real plans.
    input.roots[i].terragrunt?.provisional ? { ...p, member: { ...p.member, provisional: true as const } } : p,
  );
  const doc = composeChangeSet(parts);
  const summary = groupChangeSet(doc);
  const memberGroup = new Map<string, string>();
  if (summary.unit === "member") for (const g of summary.groups) for (const u of g.units) memberGroup.set(u, g.id);
  const outliers = new Set(summary.groups.filter((g) => g.outlier).flatMap((g) => g.units));

  // A root the policy refused keeps its changes in the report, but they cannot apply, so the totals leave them out.
  const totals = { ...doc.summary.actions };
  for (const e of doc.entries) if (policyRefused(byPath.get(e.member)!) && totals[e.action] > 0) totals[e.action]--;

  const named: ReportNamed[] = [];
  const roots: ReportRoot[] = doc.members.map((m) => {
    const src = byPath.get(m.member)!;
    const raw = rawChanges(src.plan);
    // A value the plan marks sensitive in one attribute can sit unmarked in another, so it is cut from every attribute.
    const secrets = src.plan !== undefined ? sensitiveStrings(src.plan) : [];
    const counts: ReportRoot["counts"] = {};
    const changes: ReportChange[] = [];
    for (const e of doc.entries) {
      if (e.member !== m.member) continue;
      const r = raw.get(`${e.address}\u0000${e.deposed ?? ""}`);
      // Ephemeral values exist only while one run lasts; they are not changes.
      if (r?.mode === "ephemeral" || e.address.startsWith("ephemeral.")) continue;
      counts[e.action] = (counts[e.action] ?? 0) + 1;
      if (e.action === "no-op" && r?.importing === undefined) continue;
      const c = reportChange({ ...e, attributes: scrubSecrets(e.attributes, secrets) }, r, src.preventDestroy ?? new Set());
      changes.push(c);
      // An import is named whether it leaves the object as found or also
      // updates it; a destroy, replace or forget of it is named as that.
      const action = c.action === "delete" || c.action === "replace" || c.action === "forget" ? c.action : c.importing !== undefined ? "import" : undefined;
      if (action !== undefined) {
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
    if (m.status === "failed") why.push(policyRefused(src) ? "refused by policy" : "refused to plan");
    if (src.policy?.override) why.push(`policy overridden by ${src.policy.override.by}`);
    const holding = (src.steps ?? []).filter((x) => x.status === "approval").map((x) => x.name);
    if (holding.length) why.push(`step ${holding.join(", ")} asks for an approval`);
    if (src.policy?.warnings.length) why.push(`${src.policy.warnings.length} policy warning${src.policy.warnings.length === 1 ? "" : "s"}`);
    if (inputRun.stage === "tf-drift" && changes.length > 0) why.push("drifted");
    if (outliers.has(m.member)) why.push("outlier: its change matches no other root's");
    if (highlights.length > 0) why.push(...new Set(highlights.map((h) => h.why)));
    const group = memberGroup.get(m.member);
    return {
      path: m.member,
      ...(src.binary ? { binary: src.binary } : {}),
      ...(src.terragrunt ? { terragrunt: src.terragrunt } : {}),
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
      ...(src.policy ? { policy: src.policy } : {}),
      ...(src.applied && m.status === "planned" && src.plan !== undefined ? { resources: planResources(src.plan), applied_changes: planAppliedChanges(src.plan) } : {}),
      ...(src.applied && src.state ? { state: src.state } : {}),
      ...(src.steps?.length ? { steps: src.steps } : {}),
      ...(src.reads?.length ? { reads: src.reads } : {}),
      ...(src.dependencies?.length ? { dependencies: src.dependencies } : {}),
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
    if (inputRun.stage === "tf-drift" && !g.noChanges) why.push("drifted");
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
    // A provisional member is a preview: no wave's set digest covers it.
    const members = doc.members.filter((m) => w.roots.includes(m.member) && !m.provisional);
    const failed = members.some((m) => m.planDigest === null);
    // With cost.approve_above the wave's cost is one more member of its digests, as the wave's gate takes it.
    const cost = costMember(w.cost);
    const extra = cost ? [cost] : [];
    let review: Pick<ReportWave, "review_digest" | "waits"> = {};
    if (input.gate) {
      const plans = new Map(input.roots.map((r) => [r.path, r.plan]));
      const changing = members.filter((m) => changesSomething(plans.get(m.member)));
      const destroys = changing.some((m) => destroysSomething(plans.get(m.member)));
      review = {
        // A wave that plans again once the waves it reads apply has no digest a review can bind: that plan is not made yet.
        review_digest: failed || changing.length === 0 || (w.replansAfter?.length ?? 0) > 0 ? null : changeSetDigest([...changing, ...extra]),
        waits: changing.length > 0 && (input.gate === "always" || (input.gate === "on-destroy" && destroys) || w.cost?.over === true || (w.heldBySteps?.length ?? 0) > 0),
      };
    }
    return {
      number: w.number,
      roots: w.roots,
      set_digest: w.setDigest ?? (failed || members.length === 0 ? null : changeSetDigest([...members, ...extra])),
      approval: w.approval ?? "not-requested",
      ...review,
      ...(w.gate ? { gate: w.gate } : {}),
      ...(w.waitingSince && w.approval === "waiting" ? { waiting_since: w.waitingSince } : {}),
      ...(w.refused ? { refused: w.refused } : {}),
      ...(w.review && w.approval === "waiting" ? { review: w.review } : {}),
      ...(w.heldBySteps?.length ? { held_by_steps: [...w.heldBySteps].sort() } : {}),
      ...(w.cost ? { cost: w.cost } : {}),
      ...(w.state ? { state: w.state } : {}),
      ...(w.reads?.length ? { reads: w.reads } : {}),
      ...(w.replansAfter?.length ? { replans_after: w.replansAfter } : {}),
    };
  });

  return {
    schema: REPORT_SCHEMA,
    minor: REPORT_MINOR,
    run: input.run,
    change_set: doc.digest,
    unit: summary.unit,
    units: summary.units,
    totals,
    groups,
    roots,
    waves,
    named,
    holes: summary.holes.map((h) => ({ root: h.member, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })),
    redaction: { marker: REDACTED, values: input.redacted ?? 0 },
    ...(input.mockReads?.length ? { mock_reads: input.mockReads } : {}),
    ...(input.deferred?.length ? { deferred: input.deferred } : {}),
    ...(input.tips ? { tips: input.tips } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
  };
}
