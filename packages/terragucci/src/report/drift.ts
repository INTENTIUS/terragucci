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
import type { IssueResult, PrForge } from "@intentius/chant/pr-forge";
import { terraformPlanDriftCount, terraformPlanDriftNames } from "@intentius/chant-lexicon-terraform/drift-rows";
import type { ForgeTarget } from "../forge";
import type { ForgeName } from "../config";
import type { Attributed } from "../respond/attribute";
import type { Report, ReportChange } from "./schema";

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

function changeLine(c: ReportChange, name: string | undefined): string {
  const what = c.action === "delete" ? "no longer exists" : c.action === "create" ? "exists outside the state" : "changed";
  let line = `- ${code(c.address)}${name ? ` (${code(name)})` : ""}: ${what}`;
  if (c.action === "update") {
    const paths = c.attributes.filter((a) => !a.sensitive).map((a) => a.path);
    if (paths.length > 0) line += `, in ${paths.slice(0, 8).map(code).join(", ")}${paths.length > 8 ? `, and ${paths.length - 8} more` : ""}`;
  }
  return line;
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
function attributionLines(a: Attributed | undefined): string[] {
  if (!a) return [];
  const lines = a.attributions.map((x) => {
    const who = x.actor === "human" ? "a person" : x.actor === "controller" ? "a controller" : x.actor === "provider-default" ? "a provider default" : "not attributed";
    return `  - ${code(x.address)} ${code(x.path)}: ${who} (${SOURCE_WORD[x.source]}: ${x.detail})`;
  });
  return [...lines, ...a.notes.map((n) => `  - note: ${n}`)];
}

/** The issue's body: drifted roots grouped, each with the resources that moved. */
export function renderDriftIssue(report: Report, options: IssueOptions = {}): string {
  const { run } = report;
  const d = drifted(report);
  const lines = [DRIFT_MARKER, ""];
  lines.push(
    `${d.roots} of ${report.roots.length} roots have drifted from what Terraform last applied, found at ${code(run.commit.slice(0, 12))} on ${run.finished.slice(0, 10)}.` +
      (options.reportUrl ? (options.artifacts ? ` The full report is in the artifacts of [this run](${options.reportUrl}).` : ` [Full report](${options.reportUrl})`) : ""),
    "",
    "A drift run only reads. Correct drift with a pull request, or by applying the code as it is.",
    "",
  );
  const byId = new Map(report.groups.map((g) => [g.id, g]));
  const done = new Set<string>();
  for (const r of report.roots) {
    if (r.status !== "planned" || r.changes.length === 0 || done.has(r.path)) continue;
    const g = r.group ? byId.get(r.group) : undefined;
    const members = (g ? g.units : [r.path]).filter((u) => !done.has(u));
    members.forEach((u) => done.add(u));
    lines.push(`#### ${members.map(code).join(", ")}`, "");
    for (const c of r.changes) lines.push(changeLine(c, options.names?.get(r.path)?.get(c.address)));
    const who = members.flatMap((u) => attributionLines(options.attributions?.get(u)));
    if (who.length > 0) lines.push("- Who changed it:", ...who);
    lines.push("");
  }
  const failed = report.roots.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    lines.push(`#### Roots that could not be planned (${failed.length})`, "");
    for (const r of failed) lines.push(`- ${code(r.path)}: ${(r.error ?? "did not plan").split("\n")[0]}`);
    lines.push("");
  }
  return lines.join("\n");
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
 * Keep one issue for the project's drift through chant's tracking issue:
 * open it when a run finds drift, update the open one, close it when a run
 * finds none. A run in which a root could not be planned and the rest are
 * clean proves nothing, so it leaves an open issue as it is.
 */
export async function trackDrift(forge: PrForge, report: Report, options: IssueOptions = {}): Promise<DriftIssueResult> {
  const d = drifted(report);
  const kept = (r: IssueResult): DriftIssue => ({ number: r.number ?? 0, url: r.url ?? "", ...(r.created ? { created: r.created } : {}) });
  const match = { match: "anywhere" as const };
  if (d.roots > 0) {
    const r = await forge.trackIssue(DRIFT_MARKER, { title: DRIFT_TITLE, body: renderDriftIssue(report, options) }, match);
    return { action: r.action === "opened" ? "opened" : "updated", issue: kept(r) };
  }
  if (d.failed > 0) {
    const r = await forge.trackIssue(DRIFT_MARKER, null, match);
    return r.action === "left" ? { action: "left-open", issue: kept(r) } : { action: "none" };
  }
  const r = await forge.trackIssue(DRIFT_MARKER, null, {
    ...match,
    closeOnClear: true,
    clearComment: `No drift at ${code(report.run.commit.slice(0, 12))}: all ${report.roots.length} roots match what Terraform last applied. Closing.`,
  });
  return r.action === "closed" ? { action: "closed", issue: kept(r) } : { action: "none" };
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
