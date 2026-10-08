/**
 * A root's plan as the binary renders it (`show -no-color`, kept as
 * `roots/<root>/plan.txt`), cut into what the pull-request note shows: each
 * resource's block, and the whole plan, as a `diff` fenced block. Nothing
 * here runs the binary; the text is the one the stage already kept.
 *
 * The binary masks the values the plan marks sensitive. A value can still
 * reach the text unmasked when the provider copies it into an attribute the
 * plan does not mark (`terraform_data`'s `output` does), so before the text
 * is kept, every value the JSON marks sensitive anywhere is masked wherever
 * it appears (`scrubPlanText`).
 */
import { isObject, redactPlan } from "./redact";
import { REDACTED } from "./schema";

/** What the binary prints in place of a sensitive value, and what the scrub writes. */
export const SENSITIVE_TEXT = "(sensitive value)";

/** One resource's block: its `  # <address> ...` line and every line up to the next. */
export interface PlanBlock {
  /** The line after `  # `, such as `aws_s3_bucket.b will be updated in-place`. */
  header: string;
  lines: string[];
  /** `drift` for the "Objects have changed outside" section, `actions` for the plan's own. */
  section: "drift" | "actions";
}

const DRIFT = /^(?:Note: )?Objects have changed outside of /;
const ACTIONS = /will perform the following actions:\s*$/;
/** A line that ends the resource blocks: the totals, the outputs, a warning, a rule. */
const END = /^(?:Plan: |Changes to Outputs:|No changes\.|Warning:|Error:|─|Unless you have made equivalent changes|This is a refresh-only plan|You can apply this plan|Note: You didn't use)/;

/** Every resource block in a rendered plan, in the order the binary printed them. */
export function planBlocks(text: string): PlanBlock[] {
  const out: PlanBlock[] = [];
  let section: PlanBlock["section"] | undefined;
  let cur: PlanBlock | undefined;
  const close = () => {
    if (!cur) return;
    while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1].trim() === "") cur.lines.pop();
    out.push(cur);
    cur = undefined;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (DRIFT.test(line)) {
      close();
      section = "drift";
      continue;
    }
    if (ACTIONS.test(line)) {
      close();
      section = "actions";
      continue;
    }
    if (!section) continue;
    if (END.test(line)) {
      close();
      if (/^(?:Plan: |Changes to Outputs:|No changes\.)/.test(line)) section = undefined;
      continue;
    }
    if (line.startsWith("  # ")) {
      close();
      cur = { header: line.slice(4), lines: [line], section };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

/** Whether a block is the one of `address` (and of its deposed object, when `deposed` is given). */
export function blockIs(b: PlanBlock, address: string, deposed?: string): boolean {
  if (!b.header.startsWith(`${address} `)) return false;
  const rest = b.header.slice(address.length + 1);
  return deposed !== undefined ? rest.startsWith(`(deposed object ${deposed})`) : !rest.startsWith("(deposed object");
}

/**
 * The blocks a note shows for one unit: the plan's own actions, or on a
 * refresh-only plan (which has none) what changed outside it. With
 * `address`, only that resource instance's block.
 */
export function unitBlocks(text: string, address?: string): PlanBlock[] {
  const all = planBlocks(text);
  const actions = all.filter((b) => b.section === "actions");
  const chosen = actions.length > 0 ? actions : all;
  return address === undefined ? chosen : chosen.filter((b) => blockIs(b, address));
}

/**
 * Lines as a `diff` block wants them, as Atlantis comments a plan: each
 * line's change symbol (`+`, `-`, `~`, `-/+`, `+/-`) moves to the first
 * column, so the forge colours additions and removals. The rest of the line
 * is the binary's.
 */
export function diffLines(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^(\s+)(-\/\+|\+\/-|[-+~])(?= )/, "$2$1"));
}

/** A fenced `diff` block whose fence is longer than any run of backticks in the text. */
export function diffFence(lines: string[]): string {
  const body = lines.join("\n");
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${body}\n${fence}\n`;
}

/** The plan's one-line total: `Plan: 1 to add, ...`, `No changes. ...`, or the outputs line. */
export function planTotals(text: string): string | undefined {
  return /^Plan: .*$/m.exec(text)?.[0] ?? /^No changes\..*$/m.exec(text)?.[0] ?? (/^Changes to Outputs:/m.test(text) ? "Changes to Outputs only." : undefined);
}

/** Every leaf the redaction covered: the raw values at each place the redacted copy holds REDACTED. */
function covered(raw: unknown, safe: unknown, out: Set<string>): void {
  if (safe === REDACTED && raw !== REDACTED) {
    leaves(raw, out);
    return;
  }
  if (Array.isArray(raw) && Array.isArray(safe)) raw.forEach((v, i) => covered(v, safe[i], out));
  else if (isObject(raw) && isObject(safe)) for (const k of Object.keys(raw)) covered(raw[k], safe[k], out);
}

function leaves(v: unknown, out: Set<string>): void {
  if (typeof v === "string") out.add(v);
  else if (typeof v === "number" && String(v).length >= 6) out.add(String(v));
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (isObject(v)) Object.values(v).forEach((x) => leaves(x, out));
}

/** The values a plan (`show -json`, unredacted) marks sensitive anywhere: in a change, a state, an output or a variable. */
export function sensitiveValues(plan: unknown): string[] {
  const out = new Set<string>();
  covered(plan, redactPlan(plan).plan, out);
  return [...out].filter((v) => v !== "");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The rendered plan with every value the plan marks sensitive masked as the
 * binary masks it. A string the binary quoted is masked with its quotes, at
 * any length; one long enough not to be an everyday word (eight characters
 * and more, each line of a multi-line string alike) is masked wherever it
 * appears, such as in a heredoc. `values` is how many places were masked.
 */
export function scrubPlanText(text: string, plan: unknown): { text: string; values: number } {
  let values = 0;
  let out = text;
  // Longest first, so a secret that contains another is masked whole.
  for (const v of sensitiveValues(plan).sort((a, b) => b.length - a.length)) {
    const forms = new Set<string>([JSON.stringify(v)]);
    for (const line of v.split("\n")) if (line.trim().length >= 8) forms.add(line.trim());
    for (const f of forms) {
      out = out.replace(new RegExp(escapeRe(f), "g"), () => {
        values++;
        return SENSITIVE_TEXT;
      });
    }
  }
  return { text: out, values };
}
