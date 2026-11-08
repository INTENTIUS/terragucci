/**
 * The report's small views, each rendered from the JSON alone: the job-log
 * text (chant's grouped summary), the pull-request note, and GitLab's
 * `reports:terraform` counts.
 */
import {
  GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT, PLAN_SUMMARY_CONTRACT, PLAN_SUMMARY_SCHEMA_ID, renderPlanSummaryText,
  type PlanSummary,
} from "@intentius/chant/plan-summary";
import { groupAnchor, planFiles, rootAnchor } from "./build";
import { PR_PLAN_NOTE_CONTRACT, renderPlanNote, type PrPlanNote, type PrPlanNoteFact, type PrPlanNoteGroup, type PrPlanNoteOverride, type PrPlanNoteWave, type PrPlanNoteWords } from "@intentius/chant/pr-plan-note";
import { planTotals, unitBlocks } from "./plan-text";
import { WAVES_MARKER } from "./marker";
import { productWords } from "../ci-words";
import { ruleAsks } from "../approval";
import { notePreviews } from "../tg-preview";
import { signed } from "./cost";
import { actionWord, binaryText, type Report, type ReportCost, type ReportNamed, type ReportRoot, type ReportStep, type ReportWave } from "./schema";
import { perpetualChanges } from "./perpetual";
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

/** What a `ci.hooks` hook came to, in words. */
export function stepResult(s: ReportStep): string {
  const exit = s.exit === null ? "no exit code" : `exit ${s.exit}`;
  return s.status === "passed" ? "passed" : s.status === "failed" ? `failed, ${exit}` : `asks for an approval, ${exit}`;
}

/** Every `ci.hooks` hook that ran, by root, in the order each root ran them. */
export function stepsTable(report: Report, name: (root: string) => string = (r) => `\`${r}\``): string | undefined {
  const rows = report.roots.flatMap((r) => (r.steps ?? []).map((s) => ({ root: r.path, s })));
  if (rows.length === 0) return undefined;
  let t = `**Hooks (${rows.length}):**\n\n| Root | When | Hook | Result |\n|---|---|---|---|\n`;
  for (const { root, s } of rows) t += `| ${name(root)} | ${s.when} | ${s.name.split(/\s+/).join(" ").replace(/\|/g, "\\|")} | ${stepResult(s)} |\n`;
  return t;
}

/** GitLab's `reports:terraform` artifact: create, update and delete counts for the merge-request widget. */
/** How many downstream roots the note lists by name. */
export const BLAST_LISTED = 40;

/**
 * The note's blast radius, when a root reads the state of a root this change
 * changes: which roots change, and each root downstream with what it reads.
 * Undefined when nothing reads a changed root's state.
 */
export function blastLines(report: Report, name: (root: string) => string = (r) => `\`${r}\``): string | undefined {
  const b = report.blast;
  if (!b || b.downstream.length === 0) return undefined;
  // A Terragrunt repo's units read each other through dependency blocks, not terraform_remote_state.
  const unit = report.roots.some((r) => r.terragrunt !== undefined);
  const what = unit ? "unit" : "root";
  const reads = (n: number): string => (unit ? (n === 1 ? "depends on" : "depend on") : n === 1 ? "reads" : "read");
  // A plain root that waves.after puts after another follows it without reading its state.
  const after = new Map(unit ? [] : report.roots.filter((r) => r.dependencies?.length).map((r) => [r.path, new Set(r.dependencies)]));
  const follows = (d: { root: string; reads: string[] }): string[] => d.reads.filter((u) => after.get(d.root)?.has(u) && !(report.roots.find((r) => r.path === d.root)?.reads ?? []).some((x) => x.upstream === u));
  const ordered = b.downstream.some((d) => follows(d).length > 0);
  let t = `**Blast radius:** ${plural(b.roots.length, what)} ${b.roots.length === 1 ? "changes" : "change"} (${b.roots.slice(0, 10).map(code).join(", ")}${b.roots.length > 10 ? `, and ${b.roots.length - 10} more` : ""}), and ${plural(b.downstream.length, what)} downstream ${reads(b.downstream.length)} ${unit ? "them" : ordered ? `their state or ${b.downstream.length === 1 ? "applies" : "apply"} after them` : "their state"}:\n\n`;
  for (const d of b.downstream.slice(0, BLAST_LISTED)) {
    const who = d.planned ? name(d.root) : code(d.root);
    const later = follows(d);
    const read = d.reads.filter((u) => !later.includes(u));
    const how = [...(read.length ? [`${reads(1)} ${read.map(code).join(", ")}`] : []), ...(later.length ? [`applies after ${later.map(code).join(", ")}`] : [])].join(" and ");
    t += `- ${who}${d.wave !== undefined ? ` (wave ${d.wave})` : ""} ${how}${d.planned ? "" : "; not planned in this run"}\n`;
  }
  if (b.downstream.length > BLAST_LISTED) t += `- and ${b.downstream.length - BLAST_LISTED} more in the report's JSON\n`;
  const by = b.resources ?? [];
  if (by.length > 0) {
    t += `\n**By resource:**\n\n`;
    for (const r of by.slice(0, BLAST_LISTED)) {
      t += `- ${code(r.address)} in ${code(r.root)} (${r.actions.join(", ")}) reaches:\n`;
      for (const x of r.reaches.slice(0, BLAST_LISTED)) {
        t += `  - ${code(x.address)}${x.root === r.root ? "" : ` in ${code(x.root)}`}${x.through ? `, through output ${code(x.through.output)} of ${code(x.through.root)}` : ""}\n`;
      }
      if (r.reaches.length > BLAST_LISTED) t += `  - and ${r.reaches.length - BLAST_LISTED} more in the report's JSON\n`;
    }
    if (by.length > BLAST_LISTED) t += `- and ${by.length - BLAST_LISTED} more changed resources in the report's JSON\n`;
  }
  return t;
}

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

/**
 * The run's total across its roots, as the binary's own `Plan:` line counts a
 * plan: a replacement adds one and destroys one. `3 to add, 2 to change, 0 to
 * destroy across 3 roots`, with the forgets when there are any. None when no
 * root's plan changes anything, or on a report older than minor 35.
 */
export function totalsLine(report: Pick<Report, "totals" | "totals_roots">): string | undefined {
  const n = report.totals_roots;
  if (n === undefined || n === 0) return undefined;
  const t = report.totals;
  const parts = [`${t.create + t.replace} to add`, `${t.update} to change`, `${t.delete + t.replace} to destroy`];
  if (t.forget > 0) parts.push(`${t.forget} to forget`);
  return `${parts.join(", ")} across ${plural(n, "root")}`;
}
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


/** Whether a report URL is a page that holds the report as a download rather than report.html itself: anything that is not an .html file. */
export function isArtifactPage(url: string): boolean {
  return !/\.html?$/i.test(url.split("#")[0].split("?")[0]);
}



/** The words chant's plan note is rendered with: terragucci's footer, artifact, marker, anchors and setting names. */
export const NOTE_WORDS: PrPlanNoteWords = {
  footer: NOTE_FOOTER,
  artifact: "terragucci-report",
  noReport: "Planned in [this run]({run}), which keeps no report artifact; with `reports` set, the note links the report in the bucket.",
  marker: WAVES_MARKER,
  anchors: { member: "root-{id}", group: "group-{id}" },
  overrideKey: "policy.override",
  approvalRulesKey: "approval_rules",
  applyStage: "tf-apply",
};

/**
 * The plan note chant renders (`renderPlanNote`), built from the report: the
 * counts and the lines only terragucci knows about (tips, binaries, cones,
 * stacks, redaction, cost, the slowest resources), the named changes, the
 * policy overrides and warnings, the deferred units, the wave table and its
 * marker, the previewed waves, the roots planned on another's planned
 * outputs, terragucci's own blocks (the composed run, the blast radius, the
 * steps, the cost table, the changes on every run), the groups with their
 * diffs, and each root's whole plan.
 */
export function planNoteOf(report: Report, options: NoteOptions = {}): PrPlanNote {
  const url = options.reportUrl ?? (options.runUrl ? undefined : "report.html");
  const artifacts = options.artifacts === true;
  const to = (text: string, anchor?: string): string => (url === undefined ? text : `[${text}](${url}${anchor && !artifacts ? `#${anchor}` : ""})`);
  const rootLink = (root: string): string => to(code(root), rootAnchor(root));
  const { run } = report;
  const facts: PrPlanNoteFact[] = [];
  const fact = (text: string | undefined): void => void (text && facts.push({ text }));
  if (report.tips && report.tips.length > 0) facts.push({ text: `${plural(report.tips.length, "tip")} on how the roots are set up, in the `, link: { text: "full report", anchor: "tips" }, after: "." });
  fact(binariesLine(report));
  fact(coneLine(report));
  fact(explicitStacksLine(report));
  if (report.redaction.values > 0) fact(`Sensitive values are redacted in the stored plans (${report.redaction.values}).`);
  if (report.cost) fact(costLine(report.cost));
  if (report.cost) fact(costGateLine(report.waves));
  // Only when a binary sent per-resource spans: a note on a binary without them stays as it was, and the report says why.
  const slow = report.timings?.resources.slice(0, 3) ?? [];
  if (slow.length > 0) facts.push({ text: `Slowest: ${slow.map((r) => `${code(`${r.root}: ${r.address}`)} ${duration(r.ms)}`).join(", ")}. `, link: { text: "Where the time went", anchor: "timings", plain: "Where the time went is in the full report." } });

  const sections: NonNullable<PrPlanNote["sections"]> = [];
  const composed = composeBlock(report, rootLink);
  if (composed) sections.push({ at: "start", text: composed + "\n" });
  for (const text of [blastLines(report, rootLink), stepsTable(report, rootLink)]) if (text) sections.push({ at: "groups", text: text + "\n" });
  if (report.cost && report.cost.roots.length > 0) sections.push({ at: "groups", text: costTable(report.cost, rootLink) + "\n" });
  const recurring = recurringBlock(report, rootLink);
  if (recurring) sections.push({ at: "end", text: recurring });

  // A denial a listed approver may override: the override that stands, or the command that writes one.
  const overridable = report.policy?.overriders?.length ? report.roots.filter((r) => r.policy?.result === "denied" && !r.policy.hard_mandatory?.length) : report.roots.filter((r) => r.policy?.override);
  const overrides: PrPlanNoteOverride[] = overridable.map((r) => {
    const o = r.policy!.override;
    const nobody = r.policy!.overriders?.length === 0 || (r.policy!.overriders === undefined && !report.policy?.overriders?.length);
    return {
      member: r.path,
      rules: o?.rules ?? r.policy!.rules ?? [],
      ...(o ? { override: { by: o.by, at: o.at, ...(o.sealed ? { sealed: true } : {}), plan: o.plan_digest, reason: o.reason } } : {}),
      overriders: o || nobody ? [] : (r.policy!.overriders ?? report.policy!.overriders!),
    };
  });
  // With environments, each wave's row names the environments its roots are in; without them the table is as it was.
  const envs = report.waves.some((w) => w.environments?.length) || report.roots.some((r) => r.environment);
  const review = report.waves.some((w) => w.review_digest !== undefined);
  const waves: PrPlanNoteWave[] = report.waves.map((w) => ({
    number: w.number,
    units: w.roots.length,
    ...(w.composed ? { composed: true } : {}),
    ...(envs ? { environments: w.environments ?? [] } : {}),
    ...(review ? { digest: w.review_digest ?? null } : {}),
    ...(w.waits ? { waits: true } : {}),
    ...(w.replans_after?.length ? { replansAfter: w.replans_after } : {}),
    ...(w.composed?.held_by_unknown?.length ? { unknownBy: w.composed.held_by_unknown } : {}),
    ...(w.held_by_steps?.length ? { heldByHooks: w.held_by_steps } : {}),
    ...(w.policy_gate ? { policy: { outcome: w.policy_gate.outcome, rules: w.policy_gate.rules ?? [] } } : {}),
    // approval_rules at base: what the approval takes, rule by rule.
    ...(w.approval_rules?.length ? { approvalRules: w.approval_rules.map((r) => ({ units: r.roots, asks: ruleAsks(r) })) } : {}),
    ...(w.set_digest ? { setDigest: w.set_digest } : {}),
    ...(w.approval !== undefined ? { approval: w.approval } : {}),
  }));
  const previews = review ? notePreviews(report.roots) : [];

  const groups: PrPlanNoteGroup[] = report.groups.map((g) => {
    // A group whose every change is one on every run shows its attribute names alone; the section after the groups has them.
    const recurringOnly = !g.noChanges && g.units.every((u) => {
      // A unit is a root, or in a one-root report an instance address.
      const of = report.unit === "instance" ? report.roots.flatMap((r) => r.changes.filter((c) => c.address === u)) : (report.roots.find((r) => r.path === u)?.changes ?? []);
      const changes = of.filter((c) => c.action !== "no-op" && c.action !== "read");
      return changes.length > 0 && changes.every((c) => c.perpetual);
    });
    const diff = g.noChanges || recurringOnly ? undefined : groupDiff(report, g.units, options.plans);
    return {
      id: g.id,
      units: g.units,
      ...(g.resource ? { resource: g.resource } : {}),
      ...(g.outlier ? { outlier: true } : {}),
      ...(g.noChanges ? { noChanges: true } : {}),
      ...(g.extends ? { extends: g.extends } : {}),
      ...(recurringOnly ? { recurring: true } : {}),
      changes: g.extends ? (g.plus ?? []) : g.changes,
      ...(diff ? { diff } : {}),
      ...(g.varies.length ? { varies: g.varies.flatMap((v) => v.paths.map((p) => `${v.address}.${p}`)) } : {}),
    };
  });

  // Each root's whole plan, collapsed, as Atlantis comments it.
  const plans = options.plans
    ? report.roots.flatMap((r) => {
        const text = options.plans!.get(r.path);
        if (text === undefined || (r.changes.length === 0 && !/^Changes to Outputs:/m.test(text))) return [];
        const totals = planTotals(text);
        const given = options.planUrls?.get(r.path);
        return [{ member: r.path, text, ...(totals ? { totals } : {}), file: r.plan.text ?? planFiles(r.path).text, ...(given ? { url: given } : {}) }];
      })
    : undefined;

  const t = report.totals;
  return {
    kind: "plan-note",
    contract: PR_PLAN_NOTE_CONTRACT,
    stage: run.stage,
    planning: run.stage === "tf-plan",
    ...(run.wave !== undefined ? { wave: run.wave } : {}),
    head: run.commit,
    ...(report.unit === "instance" ? { unit: "instance" as const } : {}),
    units: report.units,
    ...(report.totals_roots ? { totals: { add: t.create + t.replace, change: t.update, destroy: t.delete + t.replace, forget: t.forget, members: report.totals_roots } } : {}),
    ...(report.roots.length === 0 && run.stage === "tf-plan" ? { nothing: true } : {}),
    ...(options.notices?.length ? { notices: options.notices } : {}),
    facts,
    named: report.named.map((n) => ({
      member: n.root,
      ...(n.address !== undefined ? { address: n.address } : {}),
      ...(n.deposed !== undefined ? { deposed: n.deposed } : {}),
      action: n.action,
      word: actionWord(run.stage, n.action),
      ...(n.replace_paths?.length ? { forcedBy: n.replace_paths.map((p) => p.join(".")) } : {}),
      ...(n.reason ? { reason: n.reason } : {}),
    })),
    overrides,
    warnings: report.roots.flatMap((r) => (r.policy?.warnings ?? []).map((text) => ({ member: r.path, text }))),
    ...(report.deferred?.length ? { deferred: report.deferred } : {}),
    waves,
    ...(previews.length ? { previews } : {}),
    previewed: report.waves.filter((w) => w.preview).map((w) => ({ wave: w.number, pullRequest: w.preview!.pull_request, units: w.preview!.units.length, moved: w.preview!.units.map((u) => ({ unit: u.unit, differences: u.differences ?? [] })) })),
    linked: report.roots.flatMap((r) => (r.reads ?? []).filter((x) => x.outputs === "planned").map((x) => ({ member: r.path, upstream: x.upstream, ...(x.composed ? { composed: true } : {}), ...(x.unknown?.length ? { unknown: x.unknown } : {}) }))),
    sections,
    groups,
    ...(plans ? { plans } : {}),
    links: { ...(options.reportUrl ? { report: options.reportUrl } : {}), ...(artifacts ? { artifacts: true } : {}), ...(options.runUrl ? { run: options.runUrl } : {}), ...(options.expires ? { expires: options.expires } : {}) },
    ...(options.sealed ? { sealed: true } : {}),
  };
}

/**
 * The pull-request note, rendered by chant's plan note (`renderPlanNote`)
 * with terragucci's words. Each group links to `report.html#group-<id>` and
 * each named change to `report.html#root-<path>`. With the roots' rendered
 * plans, each group shows the diff of its first unit as the binary printed
 * it, and each root's whole plan follows in a collapsed block, as Atlantis
 * comments a plan. Over the limit chant cuts it: the whole plans and the
 * groups' diffs first, then groups from the end, and a Cut line names what
 * went.
 */
export function renderNote(report: Report, options: NoteOptions = {}): string {
  return renderPlanNote(planNoteOf(report, options), { words: productWords(), note: NOTE_WORDS, limit: options.limit ?? GITHUB_COMMENT_LIMIT });
}

/** The usual fix of a change on every run, under the note's table of them. */
export const RECURRING_TIP = "These changes are in every plan, whatever the pull request changes: an archive hash a build rebuilds each time (build the artifact reproducibly), a timestamp or a value set outside the config (`lifecycle { ignore_changes }`), or a value the provider normalises differently from the config (pin the provider version that normalises it).";

/**
 * The note's folded section of changes on every run (./perpetual.ts): each
 * with its attributes and the applied waves in a row that made it, after
 * the groups. Nothing when no change is marked.
 */
export function recurringBlock(report: Pick<Report, "roots">, name: (root: string) => string = (r) => `\`${r}\``): string | undefined {
  const found = perpetualChanges(report);
  if (found.length === 0) return undefined;
  let t = `<details><summary>Changes on every run (${found.length})</summary>\n\n| Resource | Attribute | Applied waves in a row |\n|---|---|---|\n`;
  // A pipe in an address or a key would end the cell, code span or not.
  const cell = (s: string): string => s.replaceAll("|", "\\|");
  for (const f of found) t += `| ${cell(`${name(f.root)}: ${code(f.change.address)}`)}${f.change.action === "replace" ? " (replace)" : ""} | ${cell(f.attributes.map(code).join(", "))} | ${f.change.streak ?? ""} |\n`;
  return `${t}\n${RECURRING_TIP}\n\n</details>\n\n`;
}

/**
 * The explicit stacks the run's units come from, each stack file with the
 * units it generates, since a generated unit's own files are not in the repo:
 * a change to one is made in the stack file or its unit template. Nothing
 * when no unit is generated.
 */
/** `a`, `a and b`, `a, b and c`. */
const joinAnd = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A root's counts as the binary's `Plan:` line gives them: a replacement is one to add and one to destroy. */
function planLineCounts(r: ReportRoot): { add: number; change: number; destroy: number } {
  const c = r.counts;
  return { add: (c.create ?? 0) + (c.replace ?? 0), change: c.update ?? 0, destroy: (c.delete ?? 0) + (c.replace ?? 0) };
}

/**
 * What `waves.compose` came to, for the note (and the report page): the
 * composed run, each root's changes under its own name and the values read
 * before they were known; on a tf-apply wave, what came of each root; or the
 * one line that says why the change applies in waves.
 */
export function composeBlock(report: Report, name: (root: string) => string = (r) => `\`${r}\``): string | undefined {
  const c = report.compose;
  if (!c) return undefined;
  if (c.fallback || c.wave === undefined) return `**Applies in waves** (\`waves.compose\`): ${c.fallback?.reason ?? "no wave runs the composed run"}.\n`;
  const w = report.waves.find((x) => x.number === c.wave && x.composed);
  if (!w?.composed) return undefined;
  const members = w.composed.members;
  const roots = members.map((m) => name(m.root));
  let t = `**One composed run, in wave ${c.wave}** (\`waves.compose\`): ${joinAnd(roots)} plan as one plan and apply as one apply. Each root keeps its own state: the run locks each state, applies, and writes each state back with what applied to it. If the apply fails part way, what applied stays applied, and wave ${c.wave}'s report names which roots applied and each state as written.\n\n`;
  if (c.left_out?.length) {
    t += `**Left out of the run (${c.left_out.length}).** Each applies in its own wave, as without \`waves.compose\`:\n\n`;
    for (const f of c.left_out) t += `- ${f.root ? name(f.root) : "a root"}: ${f.reason} (\`${f.kind}\`)\n`;
    t += "\n";
  }
  t += "| Root | In the run as | To add | To change | To destroy |\n|---|---|---|---|---|\n";
  for (const m of members) {
    const r = report.roots.find((x) => x.path === m.root);
    const n = r ? planLineCounts(r) : undefined;
    t += `| ${name(m.root)} | ${code(m.module)} | ${n ? n.add : "failed"} | ${n ? n.change : ""} | ${n ? n.destroy : ""} |\n`;
  }
  const unknown = report.roots.flatMap((r) => (r.reads ?? []).filter((x) => x.composed && x.unknown?.length).map((x) => ({ root: r.path, ...x })));
  if (unknown.length > 0) {
    t += `\n**Read before they were known (${unknown.length}).** The run applies these after the root that makes them, so no plan shows their values, and the run waits for an approval under any gate but \`never\`:\n\n`;
    for (const x of unknown) t += `- ${name(x.root)} reads ${x.unknown!.map(code).join(", ")} from ${code(x.upstream)} (\`data.${report.compose?.estate ? "terraform_estate_outputs" : "terraform_remote_state"}.${x.data}\`)\n`;
  }
  if (report.run.stage === "tf-apply" && members.some((m) => m.state !== undefined)) {
    const ok = members.every((m) => (m.apply === "applied" || m.apply === "no-changes") && m.state !== "not-written" && !m.error);
    t += ok
      ? "\n**The composed run applied.** Each state was written with what applied to it:\n\n"
      : "\n**The composed run failed part way.** What applied stays applied, and each state was written with what applied to it:\n\n";
    t += "| Root | Its changes | State |\n|---|---|---|\n";
    for (const m of members) {
      const changes = m.changes ? `${m.apply === "no-changes" ? "no changes" : m.apply}, ${m.changes.done} of ${m.changes.planned}` : (m.apply ?? "not applied");
      const err = m.error && m.state !== "not-written" ? `: ${m.error.split("\n")[0]!.replaceAll("|", "\\|")}` : "";
      const version = report.roots.find((x) => x.path === m.root)?.state;
      const id = version?.version_id ? `, version ${code(version.version_id)}` : "";
      const state = m.state === "written" ? `written${id}` : m.state === "unchanged" ? "as it was, nothing to write" : `not written: kept at ${m.kept ?? "the job's artifacts"}, ${m.lock_held ? "its lock still held" : "its lock released"}`;
      t += `| ${name(m.root)} | ${changes}${err} | ${state} |\n`;
    }
    if (!ok) {
      t += `\nRunning the wave again plans what is left against these states.`;
      if (members.some((m) => m.state === "not-written")) t += " A state the run could not write is written first, before anything plans.";
      t += "\n";
    }
  }
  return t;
}

export function explicitStacksLine(report: Report): string | undefined {
  const by = new Map<string, string[]>();
  for (const r of report.roots) {
    const f = r.terragrunt?.stack_file;
    if (f) by.set(f, [...(by.get(f) ?? []), r.path.slice(r.path.lastIndexOf(".terragrunt-stack/") + ".terragrunt-stack/".length)]);
  }
  if (by.size === 0) return undefined;
  const each = [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, units]) => `${code(f)} generates ${units.sort().map(code).join(", ")}`);
  return `Explicit stacks: ${each.join("; ")}.`;
}

/**
 * The roots choudoufu planned with `-cone=<base>` (../cone.ts): each cone's
 * size, or why the guard planned the whole estate. Nothing when no root
 * planned with `-cone`.
 */
export function coneLine(report: Report): string | undefined {
  const coned = report.roots.filter((r) => r.cone);
  if (coned.length === 0) return undefined;
  const each = coned.slice(0, 20).map((r) => {
    const c = r.cone!;
    if (c.fallback) return `${code(r.path)} the whole estate, since ${c.fallback.reason.replace(/\s+/g, " ")} (guard ${code(c.fallback.kind)})`;
    if (c.blocks !== undefined && c.of !== undefined) return `${code(r.path)} ${c.blocks} of its ${c.of} blocks`;
    return `${code(r.path)} ${plural(c.targets ?? 0, "address", "addresses")}`;
  });
  const more = coned.length > 20 ? `; and ${coned.length - 20} more in the report` : "";
  return `Cone plans of the change since ${code(coned[0].cone!.base)}: ${each.join("; ")}${more}.`;
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
