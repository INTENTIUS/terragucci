/**
 * `respond description` (terragucci#30): does the pull request's title and
 * description describe what its plan does? A typed decision (a Noul) answers
 * over the title, the description and the redacted report's summary. Above the
 * threshold, a "yes" puts a flag at the top of the plan note and in the HTML
 * report, naming the destroys and replacements the text does not mention.
 * Below it, with `decide:` unset or with the service unreachable, nothing the
 * pipeline wrote changes. The flag is advice: it never blocks a merge or
 * changes a gate.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, isConfident, summarize, type DecideFetch, type DecideSettings, type DecisionRecord } from "../decide";
import { PR_INTENT } from "../decide/questions";
import type { Report, ReportNamed } from "../report/schema";

/** What the model reads: the pull request's text and the report's summary. No plan values. */
export type IntentState = {
  title: string;
  description: string;
  plan: {
    counts: { add: number; change: number; destroy: number; replace: number };
    destroys: string[];
    replacements: string[];
    groups: string[];
  };
};

const MAX_TEXT = 4000;
const MAX_LISTED = 50;

const where = (n: ReportNamed): string => (n.address ? `${n.root}: ${n.address}` : n.root);

/** The destroys and replacements the report names. */
export function destructive(report: Report): { destroys: ReportNamed[]; replacements: ReportNamed[] } {
  return {
    destroys: report.named.filter((n) => n.action === "delete"),
    replacements: report.named.filter((n) => n.action === "replace"),
  };
}

export function intentState(report: Report, title: string, description: string): IntentState {
  const { destroys, replacements } = destructive(report);
  const t = report.totals;
  return {
    title: title.slice(0, MAX_TEXT),
    description: description.slice(0, MAX_TEXT),
    plan: {
      counts: { add: t.create, change: t.update, destroy: t.delete, replace: t.replace },
      destroys: destroys.slice(0, MAX_LISTED).map(where),
      replacements: replacements.slice(0, MAX_LISTED).map(where),
      groups: report.groups
        .filter((g) => !g.noChanges)
        .slice(0, MAX_LISTED)
        .map((g) => `${g.units.length} ${report.unit === "instance" ? "instance" : "root"}${g.units.length === 1 ? "" : "s"}${g.resource ? ` of ${g.resource}` : ""}: ${g.changes.map((c) => c.line).slice(0, 5).join("; ")}`),
    },
  };
}

/** Whether the pull request's text names a change, by its address, its resource type or its root. */
function mentions(text: string, n: ReportNamed): boolean {
  const hay = text.toLowerCase();
  const terms = [n.address, n.address?.replace(/\[.*$/, ""), n.type, n.root].filter((s): s is string => !!s && s.length > 2);
  return terms.some((s) => hay.includes(s.toLowerCase()));
}

/** The destroys and replacements the text does not mention; when it names them all, every one, since the model found the text contradicts them. */
export function unmentioned(report: Report, text: string): ReportNamed[] {
  const { destroys, replacements } = destructive(report);
  const all = [...destroys, ...replacements];
  const left = all.filter((n) => !mentions(text, n));
  return left.length > 0 ? left : all;
}

export interface IntentRecord {
  schema: "terragucci.intent/v1";
  /** confident, not-confident, off or unavailable. */
  status: string;
  /** Whether the flag was raised. */
  flagged: boolean;
  decision: string;
  probability?: number;
  threshold?: number;
  model?: string;
  state_digest: string;
  unmentioned: string[];
}

const FLAG_MARK = "<!-- terragucci:description -->";

export function flagLine(names: ReportNamed[], decision: string): string {
  const list = names.slice(0, 10).map((n) => `\`${where(n).replaceAll("`", "'")}\` (${n.action === "replace" ? "replace" : "destroy"})`);
  const more = names.length > 10 ? `, and ${names.length - 10} more in the report` : "";
  const what = names.length > 0 ? `The plan makes changes the description does not mention: ${list.join(", ")}${more}.` : "The plan destroys or replaces resources the description does not describe.";
  return `> Check the description of this pull request. ${what} (${decision}) This flag never blocks a merge. ${FLAG_MARK}`;
}

/** The note with the flag as its first line, replacing an earlier flag. */
export function flagNote(note: string, line: string): string {
  const kept = note.split("\n").filter((l) => !l.includes(FLAG_MARK));
  while (kept[0] === "") kept.shift();
  return `${line}\n\n${kept.join("\n")}`;
}

function flagHtml(html: string, line: string): string {
  const text = line.replace(/^> /, "").replace(` ${FLAG_MARK}`, "").replaceAll("`", "");
  const esc = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const banner = `<p class="notice" id="description-flag" style="border-left:4px solid #b45309;padding-left:.6em">${esc}</p>\n`;
  const withoutOld = html.replace(/<p class="notice" id="description-flag"[^\n]*<\/p>\n/, "");
  return withoutOld.replace("<main>\n", `<main>\n${banner}`);
}

export interface IntentInput {
  /** The report directory `stage tf-plan` wrote. */
  dir: string;
  title: string;
  description: string;
  decide: DecideSettings | undefined;
  write: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: DecideFetch;
}

export interface IntentResult {
  text: string;
  record: IntentRecord;
  decisions: DecisionRecord;
  /** The files changed, when `write` is set and the flag was raised or the decision recorded. */
  files: string[];
}

/** Ask the question and, on a confident "yes", write the flag into note.md and report.html. Never throws for the service. */
export async function checkDescription(i: IntentInput): Promise<IntentResult> {
  const reportFile = join(i.dir, "report.json");
  const report = JSON.parse(readFileSync(reportFile, "utf-8")) as Report;
  const state = intentState(report, i.title, i.description);
  const decisions = await decide(i.decide, state, { description: PR_INTENT }, { env: i.env, fetch: i.fetch });
  const d = decisions.decisions.description!;
  const confident = isConfident(d) && d.answer === "true";
  const names = confident ? unmentioned(report, `${i.title}\n${i.description}`) : [];
  const line = summarize(d, decisions);
  const record: IntentRecord = {
    schema: "terragucci.intent/v1",
    status: d.status,
    flagged: confident,
    decision: line,
    ...(d.probability !== undefined ? { probability: d.probability } : {}),
    threshold: d.threshold,
    ...(decisions.model ? { model: decisions.model } : {}),
    state_digest: decisions.stateDigest,
    unmentioned: names.map(where),
  };
  const files: string[] = [];
  if (i.write && d.status !== "off") {
    // The record is written for a decision that answered or failed to, so the report says why nothing was flagged.
    writeFileSync(join(i.dir, "intent.json"), JSON.stringify(record, null, 2) + "\n");
    files.push("intent.json");
  }
  if (i.write && confident) {
    const flag = flagLine(names, line);
    const note = join(i.dir, "note.md");
    if (existsSync(note)) {
      writeFileSync(note, flagNote(readFileSync(note, "utf-8"), flag));
      files.push("note.md");
    }
    const html = join(i.dir, "report.html");
    if (existsSync(html)) {
      writeFileSync(html, flagHtml(readFileSync(html, "utf-8"), flag));
      files.push("report.html");
    }
  }
  const text = confident ? flagLine(names, line) : `no flag: ${line}`;
  return { text, record, decisions, files };
}
