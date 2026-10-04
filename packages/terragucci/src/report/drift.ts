/**
 * Drift: what a refresh-only plan found changed in the real world, and the
 * one issue that tracks it. A refresh-only plan proposes no change to the
 * code's resources; what it reports is `resource_drift`, the objects whose
 * real state moved since the last apply. That list stands in for
 * `resource_changes` when the report is built, so the report is the same
 * JSON and HTML as a plan's, and code waiting on main never shows in it.
 */
import { closeIssue, findIssue, openIssue, updateIssue, type Fetch, type ForgeTarget, type Issue } from "../forge";
import type { ForgeName } from "../config";
import type { Report, ReportChange } from "./schema";

type Json = Record<string, unknown>;

/** The plan as the report reads it: the drift found, in place of the changes proposed. */
export function driftPlan(plan: unknown): unknown {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const p = plan as Json;
  return { ...p, resource_changes: Array.isArray(p.resource_drift) ? p.resource_drift : [] };
}

/** How many resources a refresh-only plan found drifted. */
export function driftCount(plan: unknown): number {
  const list = plan !== null && typeof plan === "object" ? (plan as Json).resource_drift : undefined;
  return Array.isArray(list) ? list.length : 0;
}

export const DRIFT_MARKER = "<!-- terragucci:drift -->";
export const DRIFT_TITLE = "terragucci: drift found";

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/**
 * The real name of each drifted object, by address, read from the plan's
 * `resource_drift`. A deleted object has no attributes in the report, so its
 * name has to come from here.
 */
export function driftNames(plan: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = plan !== null && typeof plan === "object" ? (plan as Json).resource_drift : undefined;
  if (!Array.isArray(list)) return out;
  for (const r of list as Json[]) {
    const ch = (r.change ?? {}) as Json;
    const values = [ch.after, ch.before].filter((v): v is Json => v !== null && typeof v === "object");
    for (const key of ["name", "id", "bucket", "function_name", "arn"]) {
      const v = values.map((x) => x[key]).find((x) => typeof x === "string" && x !== "");
      if (typeof v === "string") {
        out.set(String(r.address), v);
        break;
      }
    }
  }
  return out;
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
  /** Per root, the real names of its drifted objects by address (see driftNames). */
  names?: Map<string, Map<string, string>>;
}

/** The issue's body: drifted roots grouped, each with the resources that moved. */
export function renderDriftIssue(report: Report, options: IssueOptions = {}): string {
  const { run } = report;
  const d = drifted(report);
  const lines = [DRIFT_MARKER, ""];
  lines.push(
    `${d.roots} of ${report.roots.length} roots have drifted from what Terraform last applied, found at ${code(run.commit.slice(0, 12))} on ${run.finished.slice(0, 10)}.` +
      (options.reportUrl ? ` [Full report](${options.reportUrl})` : ""),
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

export type DriftIssueResult =
  | { action: "opened" | "updated" | "closed" | "left-open"; issue: Issue }
  | { action: "none" };

/**
 * Keep one issue for the project's drift: open it when a run finds drift,
 * update the open one, close it when a run finds none. A run in which a root
 * could not be planned and the rest are clean proves nothing, so it leaves
 * an open issue as it is.
 */
export async function trackDrift(fetch: Fetch, target: ForgeTarget, report: Report, options: IssueOptions = {}): Promise<DriftIssueResult> {
  const d = drifted(report);
  const open = await findIssue(fetch, target, DRIFT_MARKER);
  if (d.roots > 0 || (d.failed > 0 && open)) {
    if (d.roots === 0 && open) return { action: "left-open", issue: open };
    const body = renderDriftIssue(report, options);
    if (open) {
      await updateIssue(fetch, target, open.number, { title: DRIFT_TITLE, body });
      return { action: "updated", issue: open };
    }
    return { action: "opened", issue: await openIssue(fetch, target, { title: DRIFT_TITLE, body }) };
  }
  if (!open) return { action: "none" };
  await closeIssue(fetch, target, open.number, `No drift at ${code(report.run.commit.slice(0, 12))}: all ${report.roots.length} roots match what Terraform last applied. Closing.`);
  return { action: "closed", issue: open };
}

/** The forge a run is on, from the CI environment. */
export function targetFromEnv(forge: ForgeName | undefined, env: NodeJS.ProcessEnv, token: string | undefined): ForgeTarget | undefined {
  if (!token) return undefined;
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
