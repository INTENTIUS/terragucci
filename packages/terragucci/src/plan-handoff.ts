/**
 * `terragucci plan-handoff`: the plan verb's last line (terragucci issue
 * 1411). `terragucci stage tf-plan` wrote the plan report and the note's
 * data (`note.json`, chant's `PrPlanNote`); this writes chant's plan note
 * hand-off (`pr-plan-note.json`, `planNoteHandoff`) beside them, which the
 * note job's `pr-post` checks, renders with terragucci's note words and
 * posts with the `terragucci/plan` status:
 *
 * - the state: success when the plan exited 0, else failure;
 * - the description: the counts, as terragucci/plan always said them
 *   (`<n> failed: ` first when a root was refused);
 * - the marker: `roots=<the roots planned>`, which `pr-post` writes as
 *   `<!-- terragucci:plan roots=... -->` under chant's marker, so a push that
 *   moves those roots marks the note stale.
 *
 * The plan job runs the change's code, which can write anything here; chant
 * reads the hand-off as data, and refuses one whose marker is not plain
 * words, so a root with other characters is left out of the line.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PR_PLAN_NOTE_FILE, PRODUCT_MARKER_BODY, PRODUCT_MARKER_LIMIT, planNoteHandoff, type PrPlanNote } from "@intentius/chant/pr-plan-note";
import { NOTE_DATA_FILE } from "./report/store";

interface PlannedReport {
  roots: { path: string }[];
  groups: unknown[];
  named: { action: string }[];
}

/** The status's description: roots, groups, destroys and replacements, and refusals. */
export function planCounts(r: PlannedReport): string {
  const n = (actions: string[]): number => r.named.filter((x) => actions.includes(x.action)).length;
  const failed = n(["refused"]);
  return `${failed ? `${failed} failed: ` : ""}${r.roots.length} roots, ${r.groups.length} groups, ${n(["delete", "replace"])} destroys`;
}

/** The note's own line's body: the roots planned, or none when they do not fit chant's marker. */
export function rootsMarker(roots: readonly string[]): string {
  const line = `roots=${roots.join(",")}`;
  return line.length <= PRODUCT_MARKER_LIMIT && !/\s/.test(line) && PRODUCT_MARKER_BODY.test(line) ? line : "roots=";
}

/** Write the hand-off. The code is the step's: the plan's own exit, or 1 when there is no report to hand off. */
export function writePlanHandoff(o: { report: string; env: string; exit: number; vars?: NodeJS.ProcessEnv }): { code: number; said: string } {
  const vars = o.vars ?? process.env;
  const reportFile = join(o.report, "report.json");
  const noteFile = join(o.report, NOTE_DATA_FILE);
  if (!existsSync(reportFile) || !existsSync(noteFile)) return { code: 1, said: "terragucci: the plan report was not written" };
  let report: PlannedReport;
  let note: PrPlanNote;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf-8")) as PlannedReport;
    note = JSON.parse(readFileSync(noteFile, "utf-8")) as PrPlanNote;
  } catch (e) {
    return { code: 1, said: `terragucci: the plan report does not read: ${(e as Error).message}` };
  }
  const code = o.exit === 0 ? 0 : 1;
  const pr = Number((vars.TG_PR ?? "").trim());
  if (!Number.isInteger(pr) || pr < 1) return { code, said: "terragucci: no pull request, so no plan note hand-off" };
  const handoff = planNoteHandoff(note, {
    pr,
    env: o.env,
    state: code === 0 ? "success" : "failure",
    description: planCounts(report),
    marker: rootsMarker(report.roots.map((x) => x.path)),
  });
  writeFileSync(join(o.report, PR_PLAN_NOTE_FILE), JSON.stringify(handoff) + "\n");
  return { code, said: `terragucci: wrote the plan note hand-off for pull request ${pr}: ${handoff.state}, ${handoff.description}` };
}
