/**
 * The report's small views, each rendered from the JSON alone: the job-log
 * text (chant's grouped summary), the pull-request note, and GitLab's
 * `reports:terraform` counts.
 */
import {
  GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT, PLAN_SUMMARY_CONTRACT, PLAN_SUMMARY_SCHEMA_ID, renderPlanSummaryText,
  type PlanSummary, type PlanSummaryChange,
} from "@intentius/chant/plan-summary";
import { groupAnchor, planFiles, rootAnchor } from "./build";
import { diffFence, diffLines, planTotals, unitBlocks } from "./plan-text";
import { approveCommand, noteMarker } from "./marker";
import { overrideCommand } from "../override";
import { signed } from "./cost";
import { actionWord, binaryText, type Report, type ReportCost, type ReportNamed, type ReportStep, type ReportWave } from "./schema";
import { duration } from "./spans";
import { TACO_NOTE_URL } from "./taco";

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
      sideEffects: [],
    })),
    failed: report.named.filter((n) => n.action === "refused").map((n) => ({ member: n.root, reason: n.reason ?? "the root did not plan" })),
    destroys,
    // Newer chant summaries also carry imports, forgets and side effects.
    imports: report.named
      .filter((n) => n.action === "import" && n.address !== undefined)
      .map((n) => ({
        member: n.root, address: n.address!, type: n.type ?? "unknown",
        action: report.roots.find((r) => r.path === n.root)?.changes.find((c) => c.address === n.address)?.action ?? "no-op",
      })),
    forgets: report.named
      .filter((n) => n.action === "forget" && n.address !== undefined)
      .map((n) => ({ member: n.root, address: n.address!, type: n.type ?? "unknown", ...(n.deposed !== undefined ? { deposed: n.deposed } : {}) })),
    sideEffects: [],
    holes: report.holes.map((h) => ({ member: h.root, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })),
  } as PlanSummary;
}

/** The job-log view: chant's grouped summary. */
export function renderText(report: Report): string {
  return renderPlanSummaryText(planSummaryOf(report));
}

/** The note's line on cost: the monthly change over every root estimated, in the estimator's currency. */
export function costLine(cost: ReportCost): string {
  const estimated = cost.roots.filter((r) => r.monthly_delta !== null).length;
  const failed = cost.roots.filter((r) => r.error).length;
  const tail = failed > 0 ? `; ${failed} could not be estimated` : "";
  return cost.monthly_delta === null
    ? `Monthly cost: no estimate from ${cost.estimator}${tail}.`
    : `Monthly cost: **${signed(cost.monthly_delta)} ${cost.currency}** over ${estimated} of ${cost.roots.length} ${cost.roots.length === 1 ? "root" : "roots"}, from ${cost.estimator}${tail}.`;
}

/**
 * The note's line on `cost.approve_above`: each wave's monthly change against
 * the amount the config at base sets, and which waves it holds. Undefined
 * when no wave carries an amount.
 */
export function costGateLine(waves: readonly ReportWave[]): string | undefined {
  const priced = waves.filter((w) => w.cost?.approve_above !== undefined);
  if (priced.length === 0) return undefined;
  const c = priced[0].cost!;
  const each = priced.map((w) => {
    const change = w.cost!.unestimated?.length ? `not estimated for ${w.cost!.unestimated.join(", ")}` : w.cost!.monthly_delta === null ? "not estimated" : `${signed(w.cost!.monthly_delta)} ${w.cost!.currency}`;
    return `wave ${w.number} ${change}${w.cost!.over ? ", over it: it waits for an approval whatever the gate" : ", within it"}`;
  });
  return `Against \`cost.approve_above\` at base, ${c.approve_above!.toFixed(2)} ${c.currency} a month: ${each.join("; ")}.`;
}

/** Each root's monthly cost before and after its plan, and the change, with a total row. */
export function costTable(cost: ReportCost, name: (root: string) => string = (r) => `\`${r}\``): string {
  const amount = (n: number | null): string => (n === null ? "" : n.toFixed(2));
  let t = `**Monthly cost (${cost.currency}, ${cost.estimator}):**\n\n| Root | Before | After | Change |\n|---|---|---|---|\n`;
  for (const r of cost.roots) {
    t += r.error ? `| ${name(r.root)} | | | not estimated: ${r.error.split(/\s+/).join(" ").replace(/\|/g, "\\|")} |\n` : `| ${name(r.root)} | ${amount(r.past_monthly_total)} | ${amount(r.monthly_total)} | ${r.monthly_delta === null ? "" : signed(r.monthly_delta)} |\n`;
  }
  t += `| **Total** | ${amount(cost.past_monthly_total)} | ${amount(cost.monthly_total)} | **${cost.monthly_delta === null ? "none" : signed(cost.monthly_delta)}** |\n`;
  return t;
}

/** What a step came to, in words. */
export function stepResult(s: ReportStep): string {
  const exit = s.exit === null ? "no exit code" : `exit ${s.exit}`;
  return s.status === "passed" ? "passed" : s.status === "failed" ? `failed, ${exit}` : `asks for an approval, ${exit}`;
}

/** Every step that ran, by root, in the order each root ran them. */
export function stepsTable(report: Report, name: (root: string) => string = (r) => `\`${r}\``): string | undefined {
  const rows = report.roots.flatMap((r) => (r.steps ?? []).map((s) => ({ root: r.path, s })));
  if (rows.length === 0) return undefined;
  let t = `**Steps (${rows.length}):**\n\n| Root | When | Step | Result |\n|---|---|---|---|\n`;
  for (const { root, s } of rows) t += `| ${name(root)} | ${s.when} | ${s.name.split(/\s+/).join(" ").replace(/\|/g, "\\|")} | ${stepResult(s)} |\n`;
  return t;
}

/** GitLab's `reports:terraform` artifact: create, update and delete counts for the merge-request widget. */
export function renderGitLabTerraform(report: Report): { create: number; update: number; delete: number } {
  const t = report.totals;
  // A replacement both deletes and creates.
  return { create: t.create + t.replace, update: t.update, delete: t.delete + t.replace };
}

/**
 * The note's last line: the small taco and a link to the docs. Every forge
 * (GitHub, GitLab, Forgejo) renders an inline <img> from an https URL and keeps
 * its width and height; the image is served by the docs site, so the note
 * stays plain text with no attachment.
 */
export const NOTE_FOOTER = `<sub><img src="${TACO_NOTE_URL}" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>`;

/**
 * The most characters a Forgejo comment holds as terragucci writes it.
 * Forgejo sets none (its API requires a body and stores it as LONGTEXT), so
 * the note keeps to GitLab's figure, which a reader can still scroll.
 */
export const NOTE_LIMIT_FORGEJO = 1_000_000;

/** The comment limits, by forge: GitHub's API refuses longer, GitLab documents its own, and Forgejo's is terragucci's. */
export const NOTE_LIMITS = { github: GITHUB_COMMENT_LIMIT, gitlab: GITLAB_NOTE_LIMIT, forgejo: NOTE_LIMIT_FORGEJO } as const;

/**
 * How long the note may be on `forge`: its limit, less what the pipeline adds
 * around the note, the first line naming the roots and the line an apply
 * adds when the plan goes stale, which can name them again.
 */
export function noteLimit(forge: keyof typeof NOTE_LIMITS, report: Report): number {
  const roots = codePoints(report.roots.map((r) => r.path).join(","));
  return NOTE_LIMITS[forge] - 2 * roots - 400;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";
const codePoints = (s: string): number => [...s].length;

export interface NoteOptions {
  /** Where report.html is, as the note links it. Default `report.html`. */
  reportUrl?: string;
  /**
   * `reportUrl` is the CI run's page, where the report is a download in the
   * run's artifacts (GitHub and Forgejo with no `reports.url`): the note says
   * so, and links no anchor, since the run's page has none.
   */
  artifacts?: boolean;
  /** The most characters the note may hold. Default GitHub's 65,536. */
  limit?: number;
  /** Lines about the pipeline itself, such as overdue drift checks, shown under the summary. */
  notices?: string[];
  /** `approval: sealed`: a waiting wave's command asks for `--sign`. */
  sealed?: boolean;
  /**
   * The CI run's page when the run keeps no report the note can link (a
   * runner that keeps no forge artifact, and no `reports` bucket): the note
   * names the run and links no report.
   */
  runUrl?: string;
  /** Each root's rendered plan (`show`'s text, as plan.txt keeps it): a group shows its diff, and each root its whole plan. */
  plans?: ReadonlyMap<string, string>;
  /** Where each root's plan.txt is, when not beside report.html: a presigned link. */
  planUrls?: ReadonlyMap<string, string>;
  /** When the presigned links stop working, as an ISO time. */
  expires?: string;
}

function changeText(l: PlanSummaryChange): string {
  let t = l.count > 1 ? `${l.line} (x${l.count})` : l.line;
  if (l.differsFrom) t += l.differsIn?.length ? `  [differs from group ${l.differsFrom} in: ${l.differsIn.join(", ")}]` : `  [differs from group ${l.differsFrom}]`;
  return t;
}

/** Whether a report URL is a page that holds the report as a download rather than report.html itself: anything that is not an .html file. */
export function isArtifactPage(url: string): boolean {
  return !/\.html?$/i.test(url.split("#")[0].split("?")[0]);
}

/** A time as the note shows it: `2026-10-15 10:03 UTC`. */
const utc = (iso: string): string => iso.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, " UTC");

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Where a root's plan.txt is: the link given for it, else beside report.html
 * when the note links report.html itself. None when the report is a download
 * on the run's page or is not linked at all.
 */
function planLink(report: Report, root: string, url: string | undefined, options: NoteOptions): string | undefined {
  const given = options.planUrls?.get(root);
  if (given) return given;
  if (url === undefined || options.artifacts) return undefined;
  const bare = url.split("#")[0];
  if (bare.includes("?") || !/(^|\/)report\.html$/.test(bare)) return undefined;
  const rel = report.roots.find((r) => r.path === root)?.plan.text ?? planFiles(root).text;
  return bare.replace(/report\.html$/, "") + rel.split("/").map(encodeURIComponent).join("/");
}

/**
 * The pull-request note. Each group links to `report.html#group-<id>` and
 * each named change to `report.html#root-<path>`. With the roots' rendered
 * plans, each group shows the diff of its first unit as the binary printed
 * it, and each root's whole plan follows in a collapsed block, as Atlantis
 * comments a plan. Destroys, replacements and refusals come first and are
 * never dropped for space before a group is. Over the limit, the roots'
 * whole plans go, and groups' diffs shrink to their attribute names,
 * whichever saves the most first; then groups are dropped, whole, from the
 * end. A Cut line names what went.
 */
export function renderNote(report: Report, options: NoteOptions = {}): string {
  // No report link when the run kept the report nowhere a link reaches.
  const url = options.reportUrl ?? (options.runUrl ? undefined : "report.html");
  const artifacts = options.artifacts === true;
  // A link into the report; to the run's page, with no anchor, when the report is a download there; plain text with no report to link.
  const to = (text: string, anchor?: string): string => (url === undefined ? text : `[${text}](${url}${anchor && !artifacts ? `#${anchor}` : ""})`);
  const until = options.expires ? ` The links to the bucket work until ${utc(options.expires)}.` : "";
  const full = url === undefined
    ? `Planned in [this run](${options.runUrl}), which keeps no report artifact; with \`reports\` set, the note links the report in the bucket.`
    : artifacts ? `The full report is \`report.html\` in the \`terragucci-report\` artifact of [this run](${url}).` : `[Full report](${url})${until}`;
  const fullReport = url === undefined ? "The full report" : artifacts ? `The full report, in the artifacts of [this run](${url}),` : `[The full report](${url})`;
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  const { run } = report;
  const unitWord = report.unit === "instance" ? "instance" : "root";
  const destroys = report.named.filter((n) => n.action === "delete" || n.action === "replace").length;
  const refused = report.named.filter((n) => n.action === "refused").length;
  const head: string[] = [];
  head.push(`### terragucci ${run.stage}${run.wave !== undefined ? `, wave ${run.wave}` : ""}: ${code(run.commit.slice(0, 12))}`, "");
  const parts = [plural(report.groups.length, "group"), plural(destroys, "destroy or replacement", "destroys or replacements")];
  if (refused > 0) parts.push(`${refused} refused`);
  head.push(`${plural(report.units, unitWord)}: ${parts.join(", ")}. ${full}`, "");
  if (report.roots.length === 0 && run.stage === "tf-plan") head.push("This change reaches no root, so nothing was planned.", "");
  for (const n of options.notices ?? []) head.push(`> ${n}`, "");
  if (report.tips && report.tips.length > 0) head.push(`${plural(report.tips.length, "tip")} on how the roots are set up, in the ${artifacts || url === undefined ? "full report" : to("full report", "tips")}.`, "");
  const binaries = binariesLine(report);
  if (binaries) head.push(binaries, "");
  if (report.redaction.values > 0) head.push(`Sensitive values are redacted in the stored plans (${report.redaction.values}).`, "");
  if (report.cost) head.push(costLine(report.cost), "");
  const gateLine = report.cost ? costGateLine(report.waves) : undefined;
  if (gateLine) head.push(gateLine, "");
  // Only when a binary sent per-resource spans: a note on a binary without them stays as it was, and the report says why.
  const slow = report.timings?.resources.slice(0, 3) ?? [];
  if (slow.length > 0) {
    head.push(`Slowest: ${slow.map((r) => `${code(`${r.root}: ${r.address}`)} ${duration(r.ms)}`).join(", ")}. ${artifacts || url === undefined ? "Where the time went is in the full report." : to("Where the time went", "timings")}`, "");
  }

  const blocks: NoteBlock[] = [];
  const named = report.named;
  if (named.length > 0) {
    blocks.push({ kind: "line", units: 0, text: `**Destroys, replacements, refusals, imports and forgets (${named.length}):**\n\n` });
    for (const n of named) {
      const what = n.address ? `${n.root}: ${n.address}${n.deposed !== undefined ? ` (deposed ${n.deposed})` : ""}` : n.root;
      const forced = n.replace_paths?.length ? `, forced by ${n.replace_paths.map((p) => code(p.join("."))).join(", ")}` : "";
      const reason = n.reason ? `: ${n.reason.split(/\s+/).join(" ")}` : "";
      blocks.push({ kind: "line", units: 0, text: `- ${to(code(what), rootAnchor(n.root))} (${actionWord(run.stage, n.action)}${forced})${reason}\n` });
    }
    blocks.push({ kind: "line", units: 0, text: "\n" });
  }
  // A denial a listed approver may override: the override that stands, or the command that writes one.
  const overridable = report.policy?.overriders?.length ? report.roots.filter((r) => r.policy?.result === "denied") : report.roots.filter((r) => r.policy?.override);
  if (overridable.length > 0) {
    let t = `**Policy overrides (${report.roots.filter((r) => r.policy?.override).length} of ${overridable.length} denied):**\n\n`;
    for (const r of overridable) {
      const o = r.policy!.override;
      const rules = (o?.rules ?? r.policy!.rules ?? []).map(code).join(", ") || "its rules";
      t += o
        ? `- ${to(code(r.path), rootAnchor(r.path))}: ${rules} overridden by ${o.by} at ${o.at}${o.sealed ? ", sealed" : ""}, for plan ${code(o.plan_digest)}: ${o.reason.split(/\s+/).join(" ")}${run.stage === "tf-plan" ? ". tf-apply applies this plan; this run still fails it" : ""}\n`
        : `- ${to(code(r.path), rootAnchor(r.path))}: denied by ${rules}. ${report.policy!.overriders!.join(", ")} may override it once a tf-apply wave records the denial: ${code(overrideCommand(r.path, r.policy!.rules ?? [], options.sealed))}\n`;
    }
    blocks.push({ kind: "line", units: 0, text: t + "\n" });
  }
  const warned = report.roots.filter((r) => r.policy?.warnings.length);
  if (warned.length > 0) {
    const count = warned.reduce((n, r) => n + r.policy!.warnings.length, 0);
    let t = `**Policy warnings (${count}), which fail nothing:**\n\n`;
    for (const r of warned) for (const w of r.policy!.warnings) t += `- ${to(code(r.path), rootAnchor(r.path))}: ${w.split(/\s+/).join(" ")}\n`;
    blocks.push({ kind: "line", units: 0, text: t + "\n" });
  }
  if (report.deferred?.length) {
    let t = `**Planned once what they wait for applies (${report.deferred.length}):**\n\n`;
    for (const d of report.deferred) t += `- ${code(d.unit)} after ${d.after.map(code).join(", ")}: ${d.why}${d.previewed ? " (previewed)" : ""}\n`;
    blocks.push({ kind: "line", units: 0, text: t + "\n" });
  }
  if (report.waves.some((w) => w.review_digest !== undefined)) {
    // A plan's waves: the digest of what each changes, which approval: pr-review binds a review to, and whether the gate will hold it.
    let t = "| Wave | Roots | Digest of its changes | When it applies |\n|---|---|---|---|\n";
    for (const w of report.waves) {
      const when = w.waits && w.review_digest ? `waits for an approval: ${code(approveCommand(w.number, w.review_digest, options.sealed))}` : w.waits ? "waits for an approval" : "applies";
      const by = w.waits && w.held_by_steps?.length ? ` (a step of ${w.held_by_steps.map(code).join(", ")} asks for one)` : "";
      t += `| ${w.number} | ${w.roots.length} | ${w.review_digest ? code(w.review_digest) : "no change"} | ${when}${by} |\n`;
    }
    blocks.push({ kind: "line", units: 0, text: t + "\n" });
    head.push(noteMarker({ head: run.commit, waves: report.waves.map((w) => ({ number: w.number, digest: w.review_digest ?? null, waits: w.waits === true })) }), "");
  } else if (report.waves.length > 0) {
    let t = "| Wave | Roots | Set digest | Approval |\n|---|---|---|---|\n";
    for (const w of report.waves) t += `| ${w.number} | ${w.roots.length} | ${w.set_digest ? code(w.set_digest.slice(0, 19)) : "none"} | ${w.approval} |\n`;
    blocks.push({ kind: "line", units: 0, text: t + "\n" });
  }
  const steps = stepsTable(report, (root) => to(code(root), rootAnchor(root)));
  if (steps) blocks.push({ kind: "line", units: 0, text: steps + "\n" });
  if (report.cost && report.cost.roots.length > 0) blocks.push({ kind: "line", units: 0, text: costTable(report.cost, (root) => to(code(root), rootAnchor(root))) + "\n" });
  const unitsWord = report.unit === "instance" ? "Instances" : "Roots";
  for (const g of report.groups) {
    let title = `${to(`Group ${g.id}`, groupAnchor(g.id))}: ${plural(g.units.length, unitWord)}`;
    if (g.resource) title += ` of ${code(g.resource)}`;
    if (g.outlier) title += " (outlier)";
    title += g.noChanges ? ", no changes" : g.extends ? `, group ${g.extends}'s change plus` : g.units.length > 1 ? ", identical change" : ", change";
    const heading = `#### ${title}\n\n`;
    const lines = g.extends ? (g.plus ?? []) : g.changes;
    const names = lines.length > 0 ? "```\n" + lines.map(changeText).join("\n") + "\n```\n\n" : "";
    const shown = g.units.slice(0, 20).map(code).join(", ");
    const members = `${unitsWord}: ${shown}${g.units.length > 20 ? `, and ${g.units.length - 20} more in the report` : ""}\n\n`;
    const diff = g.noChanges ? undefined : groupDiff(report, g.units, options.plans);
    if (!diff) {
      blocks.push({ kind: "group", units: g.units.length, text: heading + names + members });
      continue;
    }
    let t = heading;
    if (g.units.length > 1) t += `As ${code(diff.unit)} plans it:\n\n`;
    t += diffFence(diffLines(diff.lines)) + "\n";
    const differs = lines.filter((l) => l.differsFrom);
    for (const l of differs) t += `- ${code(l.line)} differs from group ${l.differsFrom}${l.differsIn?.length ? ` in ${l.differsIn.map(code).join(", ")}` : ""}.\n`;
    if (g.varies.length > 0) t += `${differs.length > 0 ? "- " : ""}Values differ between its ${unitWord}s in ${g.varies.flatMap((v) => v.paths.map((p) => code(`${v.address}.${p}`))).join(", ")}.\n`;
    if (differs.length > 0 || g.varies.length > 0) t += "\n";
    blocks.push({ kind: "group", units: g.units.length, text: t + members, short: heading + names + members });
  }
  // Each root's whole plan, collapsed, as Atlantis comments it.
  let first = true;
  for (const r of report.roots) {
    const text = options.plans?.get(r.path);
    if (text === undefined || (r.changes.length === 0 && !/^Changes to Outputs:/m.test(text))) continue;
    const link = planLink(report, r.path, url, options);
    const totals = planTotals(text);
    let t = first ? "**Each root's plan:**\n\n" : "";
    first = false;
    t += `<details><summary><code>${esc(r.path)}</code>${totals ? `: ${esc(totals)}` : ""}</summary>\n\n`;
    t += diffFence(diffLines(text.replace(/\r\n/g, "\n").replace(/^(\s*\n)+/, "").replace(/\s+$/, "").split("\n"))) + "\n";
    if (link) t += `[plan.txt](${link})\n\n`;
    t += "</details>\n\n";
    blocks.push({ kind: "plan", units: 0, root: r.path, text: t });
  }
  const top = head.join("\n") + "\n";
  const foot = `\n${NOTE_FOOTER}\n`;
  const all = top + blocks.map((b) => b.text).join("") + foot;
  if (codePoints(all) <= limit) return all;

  const cut = { plans: [] as string[], diffs: 0, groups: 0, units: 0, lines: 0 };
  const notice = (): string => {
    const out: string[] = [];
    if (cut.plans.length > 0) {
      const named = cut.plans.slice(0, 20).map((root) => {
        const link = planLink(report, root, url, options);
        return link ? `[${code(root)}](${link})` : code(root);
      });
      const more = cut.plans.length - named.length;
      out.push(`the whole plans of ${plural(cut.plans.length, "root")} (${named.join(", ")}${more > 0 ? `, and ${more} more` : ""})`);
    }
    if (cut.groups > 0) out.push(`${plural(cut.groups, "group")} (${plural(cut.units, unitWord)})`);
    if (cut.lines > 0) out.push(plural(cut.lines, "line"));
    const clauses: string[] = [];
    if (out.length > 0) clauses.push(`leaves out ${out.length > 1 ? `${out.slice(0, -1).join(", ")} and ${out[out.length - 1]}` : out[0]}`);
    if (cut.diffs > 0) clauses.push(`shows ${cut.diffs === 1 ? "one group" : `${cut.diffs} groups`} by attribute name, without the diff`);
    return `**Cut:** this note ${clauses.join(" and ")}, to stay within ${limit} characters. ${fullReport} has all of it${options.plans ? ", and each root's plan.txt the whole plan" : ""}.\n`;
  };
  const size = (b: NoteBlock): number => codePoints(b.text);
  let used = codePoints(all);
  const over = (): boolean => used + codePoints(notice()) > limit;
  // The roots' whole plans and the groups' diffs, whichever saves the most first: a whole plan before a diff that saves as much, the later of two alike first.
  const candidates = blocks
    .map((b, i) => ({ i, plan: b.kind === "plan", saves: b.kind === "plan" ? size(b) : b.short !== undefined ? size(b) - codePoints(b.short) : 0 }))
    .filter((c) => c.saves > 0)
    .sort((a, b) => b.saves - a.saves || Number(b.plan) - Number(a.plan) || b.i - a.i);
  const gone = new Set<number>();
  for (const c of candidates) {
    if (!over()) break;
    const b = blocks[c.i];
    if (c.plan) {
      used -= size(b);
      gone.add(c.i);
    } else {
      used += codePoints(b.short!) - size(b);
      b.text = b.short!;
      b.short = undefined;
      cut.diffs++;
    }
  }
  cut.plans.push(...blocks.filter((_, i) => gone.has(i)).map((b) => b.root!));
  for (let i = blocks.length - 1; i >= 0; i--) if (gone.has(i)) blocks.splice(i, 1);
  // Then whole blocks from the end: groups, and last the destroys.
  while (blocks.length > 0 && over()) {
    const b = blocks.pop()!;
    used -= size(b);
    if (b.kind === "group") {
      cut.groups++;
      cut.units += b.units;
    } else if (b.kind === "plan") cut.plans.unshift(b.root!);
    else cut.lines++;
  }
  return top + blocks.map((b) => b.text).join("") + notice() + foot;
}

/**
 * When a root pinned its own version: the binary each root ran, pinned roots
 * by name with where each pinned it, the rest counted, the pinned binaries
 * first. Nothing when no root pinned, since every root then ran the job's
 * binary.
 */
export function binariesLine(report: Report): string | undefined {
  const pinOf = (b: NonNullable<Report["roots"][number]["binary"]>): string | undefined =>
    [b.pin, b.terragrunt?.pin ? `Terragrunt ${b.terragrunt.version}, ${b.terragrunt.pin}` : undefined].filter(Boolean).join("; ") || undefined;
  if (!report.roots.some((r) => r.binary && pinOf(r.binary))) return undefined;
  const byBinary = new Map<string, { pinned: string[]; others: number }>();
  for (const r of report.roots) {
    if (!r.binary) continue;
    const key = binaryText({ name: r.binary.name, ...(r.binary.version ? { version: r.binary.version } : {}) });
    const g = byBinary.get(key) ?? { pinned: [], others: 0 };
    byBinary.set(key, g);
    const pin = pinOf(r.binary);
    if (pin) g.pinned.push(`${code(r.path)} (${pin})`);
    else g.others++;
  }
  // The binaries roots pinned first, then the job's.
  const parts = [...byBinary].sort(([, a], [, b]) => Number(a.pinned.length === 0) - Number(b.pinned.length === 0)).map(([bin, g]) => {
    const named = g.pinned.slice(0, 10);
    const rest = g.pinned.length - named.length + g.others;
    const who = [...named, ...(rest > 0 ? [named.length > 0 ? `${plural(rest, "other root")}` : plural(rest, "root")] : [])];
    return `${bin} for ${who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : who[0]}`;
  });
  return `Binaries: ${parts.join("; ")}.`;
}

interface NoteBlock {
  text: string;
  /** `line`: destroys, policy and wave lines; `group`: a group; `plan`: a root's whole plan. */
  kind: "line" | "group" | "plan";
  units: number;
  /** A group's text with its attribute names in place of its diff. */
  short?: string;
  root?: string;
}

/**
 * The diff a group shows: the blocks of its first unit with a rendered plan.
 * A root group's unit is a root, and its diff every resource the root
 * changes; an instance group's unit is an instance of the one root, and its
 * diff that instance's block.
 */
function groupDiff(report: Report, units: string[], plans: ReadonlyMap<string, string> | undefined): { unit: string; lines: string[] } | undefined {
  if (!plans) return undefined;
  for (const unit of units) {
    const text = report.unit === "instance" ? plans.get(report.roots[0]?.path ?? "") : plans.get(unit);
    if (text === undefined) continue;
    const blocks = report.unit === "instance" ? unitBlocks(text, unit) : unitBlocks(text);
    if (blocks.length > 0) return { unit, lines: blocks.flatMap((b, i) => (i > 0 ? ["", ...b.lines] : b.lines)) };
  }
  return undefined;
}
