/**
 * Drift: what a refresh-only plan found changed in the real world, and the
 * one issue that tracks it. A refresh-only plan proposes no change to the
 * code's resources; what it reports is `resource_drift`, the objects whose
 * real state moved since the last apply. The terraform lexicon's
 * `terraformDriftPlan` puts that list in place of `resource_changes` when the
 * report is built, so the report is the same JSON and HTML as a plan's, and
 * code waiting on main never shows in it; `terraformLivePlanDrift` reads a
 * live root's full plan as drift.
 */
import { driftIssueBody, keepDriftIssue, type DriftIssueInput, type DriftIssueRecord, type DriftIssueWords } from "@intentius/chant/drift-issue";
import type { PrForge } from "@intentius/chant/pr-forge";
import { terraformPlanDriftCount, terraformPlanDriftNames } from "@intentius/chant-lexicon-terraform/drift-rows";
import type { ForgeTarget } from "../forge";
import type { ForgeName } from "../config";
import type { Attributed } from "../respond/attribute";
import type { Report } from "./schema";

type Json = Record<string, unknown>;

/** How many resources a refresh-only plan found drifted: every resource_drift entry, by the terraform lexicon's drift rows (chant#4580). */
export function driftCount(plan: unknown): number {
  return terraformPlanDriftCount(plan);
}

export const DRIFT_MARKER = "<!-- terragucci:drift -->";
export const DRIFT_TITLE = "terragucci: drift found";

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/**
 * The real name of each drifted object, by address, read from the plan's
 * `resource_drift` by the terraform lexicon's drift rows (chant#4580). A
 * deleted object has no attributes in the report, so its name has to come
 * from here.
 */
export function driftNames(plan: unknown): Map<string, string> {
  return terraformPlanDriftNames(plan);
}

/** Whether a report has anything for the tracking issue to say. */
export function drifted(report: Report): { roots: number; failed: number } {
  return {
    roots: report.roots.filter((r) => r.status === "planned" && r.changes.length > 0).length,
    failed: report.roots.filter((r) => r.status === "failed").length,
  };
}

export interface IssueOptions {
  /** Where the full report is, when the run has a page for it. */
  reportUrl?: string;
  /** `reportUrl` is the CI run's page, which holds the report in its artifacts. */
  artifacts?: boolean;
  /** Per root, the real names of its drifted objects by address (see driftNames). */
  names?: Map<string, Map<string, string>>;
  /** Per root, who changed each drifted attribute, when the run attributed them (`respond.drift: attribute`). */
  attributions?: Map<string, Attributed>;
}

const SOURCE_WORD = { table: "known write", audit: "audit log", model: "model", unattributed: "unattributed" } as const;

/** One line per attributed attribute: who changed it, from what evidence. */
function attributionLines(root: string, a: Attributed | undefined): string[] {
  if (!a) return [];
  const lines = a.attributions.map((x) => {
    const who = x.actor === "human" ? "a person" : x.actor === "controller" ? "a controller" : x.actor === "provider-default" ? "a provider default" : "not attributed";
    return `- ${code(root)} ${code(x.address)} ${code(x.path)}: ${who} (${SOURCE_WORD[x.source]}: ${x.detail})`;
  });
  return [...lines, ...a.notes.map((n) => `- ${code(root)} note: ${n}`)];
}

/**
 * The report's drift as chant's drift records (`@intentius/chant/drift-issue`):
 * one per changed resource of each planned root, the root as the member. An
 * object that no longer exists is `missing`, one outside the state
 * `undeclared`, and a change `drifted` with the paths that moved.
 */
export function driftRecords(report: Report): DriftIssueRecord[] {
  return report.roots
    .filter((r) => r.status === "planned")
    .flatMap((r) =>
      r.changes.map((c): DriftIssueRecord => ({
        member: r.path,
        address: c.address,
        resourceType: c.type,
        status: c.action === "delete" ? "missing" : c.action === "create" ? "undeclared" : "drifted",
        ...(c.action === "update" ? { attributes: c.attributes.map((x) => (x.sensitive ? { path: x.path, sensitive: true as const } : { path: x.path })) } : {}),
      })),
    );
}

/** The statuses that are drift for terragucci's issue: chant's, and an object outside the state. */
const DRIFT_STATUSES = ["drifted", "missing", "undeclared"] as const;

/** chant's drift issue input for a report: terragucci's words, the records, and the lines below the table. */
export function driftIssueInput(report: Report, options: IssueOptions = {}): DriftIssueInput {
  const { run } = report;
  const d = drifted(report);
  const at = `${code(run.commit.slice(0, 12))} on ${run.finished.slice(0, 10)}`;
  const link = options.reportUrl ? (options.artifacts ? ` The full report is in the artifacts of [this run](${options.reportUrl}).` : ` [Full report](${options.reportUrl})`) : "";
  const roots = report.roots.filter((r) => r.status === "planned" && r.changes.length > 0).map((r) => code(r.path));
  const failed = report.roots.filter((r) => r.status === "failed");
  const words: DriftIssueWords = {
    product: "terragucci",
    title: () => DRIFT_TITLE,
    intro: () => `${d.roots} of ${report.roots.length} roots have drifted from what Terraform last applied, found at ${at}: ${roots.join(", ")}.${link}`,
    advice: () => "A drift run only reads. Correct drift with a pull request, or by applying the code as it is.",
    cleared: () => `No drift at ${code(run.commit.slice(0, 12))}: all ${report.roots.length} roots match what Terraform last applied. Closing.`,
  };
  const named = report.roots.flatMap((r) => [...(options.names?.get(r.path) ?? [])].map(([address, name]) => `- ${code(r.path)} ${code(address)} is ${code(name)}`));
  const who = report.roots.flatMap((r) => attributionLines(r.path, options.attributions?.get(r.path)));
  const notes = [
    ...(named.length ? ["Real names:", "", ...named, ""] : []),
    ...(who.length ? ["Who changed it:", "", ...who, ""] : []),
    ...(failed.length ? [`Roots that could not be planned (${failed.length}):`, "", ...failed.map((r) => `- ${code(r.path)}: ${(r.error ?? "did not plan").split("\n")[0]}`), ""] : []),
  ];
  while (notes.at(-1) === "") notes.pop();
  return {
    words,
    environment: "the project",
    records: driftRecords(report),
    marker: DRIFT_MARKER,
    match: { match: "anywhere" },
    statuses: DRIFT_STATUSES,
    observedAt: run.finished,
    ...(d.roots === 0 && d.failed > 0 ? { unknown: `${d.failed} root${d.failed === 1 ? "" : "s"} could not be planned` } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** The issue's body, as chant writes it from the report's records. */
export function renderDriftIssue(report: Report, options: IssueOptions = {}): string {
  return driftIssueBody(driftIssueInput(report, options));
}

/** The drift issue a run kept: its number, its page, and when it was opened. */
export interface DriftIssue {
  number: number;
  url: string;
  /** When it was opened (ISO 8601), when the forge said. */
  created?: string;
}

export type DriftIssueResult =
  | { action: "opened" | "updated" | "closed" | "left-open"; issue: DriftIssue }
  | { action: "none" };

/**
 * Keep one issue for the project's drift through chant's drift issue
 * (`keepDriftIssue`, chant issue 4790): open it when a run finds drift,
 * update the open one when the drift moved, close it when a run finds none.
 * A run in which a root could not be planned and the rest are clean proves
 * nothing, so it leaves an open issue as it is.
 */
export async function trackDrift(forge: PrForge, report: Report, options: IssueOptions = {}): Promise<DriftIssueResult> {
  const r = await keepDriftIssue(forge, driftIssueInput(report, options));
  const issue: DriftIssue = { number: r.number ?? 0, url: r.url ?? "", ...(r.created ? { created: r.created } : {}) };
  if (r.action === "opened") return { action: "opened", issue };
  if (r.action === "updated" || r.action === "unchanged") return { action: "updated", issue };
  if (r.action === "left" && r.number !== undefined) return { action: "left-open", issue };
  if (r.action === "closed") return { action: "closed", issue };
  return { action: "none" };
}

/** The forge a run is on, from the CI environment. */
export function targetFromEnv(forge: ForgeName | undefined, env: NodeJS.ProcessEnv, token: string | undefined, readOnly = false): ForgeTarget | undefined {
  // Without a token the target can only read, which a public repo answers.
  if (!token && !readOnly) return undefined;
  token ??= "";
  if (env.GITHUB_REPOSITORY && env.GITHUB_SERVER_URL) {
    return {
      forge: forge === "forgejo" ? "forgejo" : "github",
      origin: env.GITHUB_SERVER_URL,
      path: env.GITHUB_REPOSITORY,
      token,
      ...(env.GITHUB_API_URL ? { api: env.GITHUB_API_URL } : {}),
    };
  }
  if (env.CI_PROJECT_PATH && env.CI_SERVER_URL) {
    return { forge: "gitlab", origin: env.CI_SERVER_URL, path: env.CI_PROJECT_PATH, token };
  }
  return undefined;
}
