/**
 * The report's small views, each rendered from the JSON alone: the job-log
 * text (chant's grouped summary), the pull-request note, and GitLab's
 * `reports:terraform` counts.
 */
import {
  GITHUB_COMMENT_LIMIT, PLAN_SUMMARY_CONTRACT, PLAN_SUMMARY_SCHEMA_ID, renderPlanSummaryText,
  type PlanSummary, type PlanSummaryChange,
} from "@intentius/chant/plan-summary";
import { groupAnchor, rootAnchor } from "./build";
import type { Report, ReportNamed } from "./schema";

/** chant's plan summary, rebuilt from the report. */
export function planSummaryOf(report: Report): PlanSummary {
  const destroys = report.named
    .filter((n): n is ReportNamed & { address: string; action: "delete" | "replace" } => n.address !== undefined && (n.action === "delete" || n.action === "replace"))
    .map((n) => ({ member: n.root, address: n.address, type: n.type ?? "unknown", action: n.action, ...(n.deposed !== undefined ? { deposed: n.deposed } : {}) }));
  const destroysOf = (units: string[]) => destroys.filter((d) => units.includes(d.member) || units.includes(d.address));
  return {
    $schema: PLAN_SUMMARY_SCHEMA_ID,
    contract: PLAN_SUMMARY_CONTRACT,
    changeSet: report.change_set,
    unit: report.unit,
    units: report.units,
    groups: report.groups.map((g) => ({
      id: g.id,
      ...(g.resource ? { resource: g.resource } : {}),
      units: g.units,
      outlier: g.outlier,
      noChanges: g.noChanges,
      changes: g.changes,
      ...(g.extends ? { extends: g.extends } : {}),
      ...(g.plus ? { plus: g.plus } : {}),
      destroys: destroysOf(g.units),
    })),
    failed: report.named.filter((n) => n.action === "refused").map((n) => ({ member: n.root, reason: n.reason ?? "the root did not plan" })),
    destroys,
    holes: report.holes.map((h) => ({ member: h.root, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })),
  };
}

/** The job-log view: chant's grouped summary. */
export function renderText(report: Report): string {
  return renderPlanSummaryText(planSummaryOf(report));
}

/** GitLab's `reports:terraform` artifact: create, update and delete counts for the merge-request widget. */
export function renderGitLabTerraform(report: Report): { create: number; update: number; delete: number } {
  const t = report.totals;
  // A replacement both deletes and creates.
  return { create: t.create + t.replace, update: t.update, delete: t.delete + t.replace };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";
const codePoints = (s: string): number => [...s].length;

export interface NoteOptions {
  /** Where report.html is, as the note links it. Default `report.html`. */
  reportUrl?: string;
  /** The most characters the note may hold. Default GitHub's 65,536. */
  limit?: number;
}

function changeText(l: PlanSummaryChange): string {
  let t = l.count > 1 ? `${l.line} (x${l.count})` : l.line;
  if (l.differsFrom) t += l.differsIn?.length ? `  [differs from group ${l.differsFrom} in: ${l.differsIn.join(", ")}]` : `  [differs from group ${l.differsFrom}]`;
  return t;
}

const ACTION_WORD: Record<ReportNamed["action"], string> = { delete: "destroy", replace: "replace", refused: "refused to plan", forget: "forget", import: "import" };

/**
 * The pull-request note. Each group links to `report.html#group-<id>` and
 * each named change to `report.html#root-<path>`. Destroys, replacements and
 * refusals come first and are never dropped for space before a group is;
 * groups are dropped from the end, whole, with a line saying how many.
 */
export function renderNote(report: Report, options: NoteOptions = {}): string {
  const url = options.reportUrl ?? "report.html";
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  const { run } = report;
  const unitWord = report.unit === "instance" ? "instance" : "root";
  const destroys = report.named.filter((n) => n.action === "delete" || n.action === "replace").length;
  const refused = report.named.filter((n) => n.action === "refused").length;
  const head: string[] = [];
  head.push(`### terragucci ${run.stage}${run.wave !== undefined ? `, wave ${run.wave}` : ""}: ${code(run.commit.slice(0, 12))}`, "");
  const parts = [plural(report.groups.length, "group"), plural(destroys, "destroy or replacement", "destroys or replacements")];
  if (refused > 0) parts.push(`${refused} refused`);
  head.push(`${plural(report.units, unitWord)}: ${parts.join(", ")}. [Full report](${url})`, "");
  if (report.redaction.values > 0) head.push(`Sensitive values are redacted in the stored plans (${report.redaction.values}).`, "");

  const blocks: { text: string; group: boolean; units: number }[] = [];
  const named = report.named;
  if (named.length > 0) {
    blocks.push({ group: false, units: 0, text: `**Destroys, replacements, refusals, imports and forgets (${named.length}):**\n\n` });
    for (const n of named) {
      const what = n.address ? `${n.root}: ${n.address}${n.deposed !== undefined ? ` (deposed ${n.deposed})` : ""}` : n.root;
      const forced = n.replace_paths?.length ? `, forced by ${n.replace_paths.map((p) => code(p.join("."))).join(", ")}` : "";
      const reason = n.reason ? `: ${n.reason.split(/\s+/).join(" ")}` : "";
      blocks.push({ group: false, units: 0, text: `- [${code(what)}](${url}#${rootAnchor(n.root)}) (${ACTION_WORD[n.action]}${forced})${reason}\n` });
    }
    blocks.push({ group: false, units: 0, text: "\n" });
  }
  if (report.waves.length > 0) {
    let t = "| Wave | Roots | Set digest | Approval |\n|---|---|---|---|\n";
    for (const w of report.waves) t += `| ${w.number} | ${w.roots.length} | ${w.set_digest ? code(w.set_digest.slice(0, 19)) : "none"} | ${w.approval} |\n`;
    blocks.push({ group: false, units: 0, text: t + "\n" });
  }
  for (const g of report.groups) {
    let title = `[Group ${g.id}](${url}#${groupAnchor(g.id)}): ${plural(g.units.length, unitWord)}`;
    if (g.resource) title += ` of ${code(g.resource)}`;
    if (g.outlier) title += " (outlier)";
    title += g.noChanges ? ", no changes" : g.extends ? `, group ${g.extends}'s change plus` : g.units.length > 1 ? ", identical change" : ", change";
    let t = `#### ${title}\n\n`;
    const lines = g.extends ? (g.plus ?? []) : g.changes;
    if (lines.length > 0) t += "```\n" + lines.map(changeText).join("\n") + "\n```\n\n";
    const shown = g.units.slice(0, 20).map(code).join(", ");
    t += `${report.unit === "instance" ? "Instances" : "Roots"}: ${shown}${g.units.length > 20 ? `, and ${g.units.length - 20} more in the report` : ""}\n\n`;
    blocks.push({ group: true, units: g.units.length, text: t });
  }
  const top = head.join("\n") + "\n";
  const all = top + blocks.map((b) => b.text).join("");
  if (codePoints(all) <= limit) return all;

  const notice = (kept: number): string => {
    const cut = blocks.slice(kept);
    const groups = cut.filter((b) => b.group);
    const lines = cut.length - groups.length;
    const what = [groups.length > 0 ? `${plural(groups.length, "group")} (${plural(groups.reduce((n, b) => n + b.units, 0), unitWord)})` : "", lines > 0 ? plural(lines, "line") : ""].filter(Boolean).join(" and ");
    return `**Cut:** this note leaves out ${what} to stay within ${limit} characters. [The full report](${url}) has all of it.\n`;
  };
  let kept = blocks.length;
  let used = codePoints(all);
  while (kept > 0 && used + codePoints(notice(kept)) > limit) {
    kept--;
    used -= codePoints(blocks[kept].text);
  }
  return top + blocks.slice(0, kept).map((b) => b.text).join("") + notice(kept);
}
