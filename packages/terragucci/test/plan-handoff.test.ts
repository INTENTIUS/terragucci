/**
 * The plan verb's hand-off (terragucci issue 1411): `terragucci plan-handoff`
 * writes chant's plan note hand-off from the report the stage wrote, and
 * chant's `pr-post` renders it with terragucci's note words into the note
 * terragucci always posted, under chant's marker and the `terragucci:plan
 * roots=` line.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planNoteHandoffNote, readPlanNoteHandoff } from "@intentius/chant/pr-post";
import { PR_PLAN_NOTE_FILE } from "@intentius/chant/pr-plan-note";
import { prNoteMarker } from "@intentius/chant/pr-loop";
import { planCounts, rootsMarker, writePlanHandoff } from "../src/plan-handoff";
import { PLAN_ENV, PLAN_PRODUCT_MARKER } from "../src/product-plan";
import { NOTE_DATA_FILE } from "../src/report/store";
import { NOTE_WORDS, planNoteOf } from "../src/report/views";
import { STALE_MARKER, staleNote } from "../src/forge-post";
import { flagNoteData } from "../src/respond/intent";
import { parseMarker } from "../src/report/marker";
import type { Report } from "../src/report/schema";

const REPORT = JSON.parse(readFileSync(join(__dirname, "__golden__/report.small.json"), "utf-8")) as Report;

function reportDir(report: Report = REPORT): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-handoff-"));
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  writeFileSync(join(dir, NOTE_DATA_FILE), JSON.stringify(planNoteOf(report)));
  return dir;
}

describe("terragucci plan-handoff", () => {
  it("writes chant's hand-off: the note, the counts as the status, the roots as the note's line", () => {
    const dir = reportDir();
    const r = writePlanHandoff({ report: dir, env: PLAN_ENV, exit: 0, vars: { TG_PR: "7" } });
    expect(r.code).toBe(0);
    const read = readPlanNoteHandoff({ dir, pr: 7, head: REPORT.run.commit, env: PLAN_ENV });
    if (!("handoff" in read)) throw new Error(read.refused);
    expect(read.handoff).toMatchObject({ kind: "plan-note-handoff", pr: 7, head: REPORT.run.commit, env: "default", state: "success", description: planCounts(REPORT as never), marker: "roots=envs/dev/orders,envs/dev/search,envs/prod/orders,envs/prod/search" });
    expect(planCounts(REPORT as never)).toMatch(/^1 failed: 4 roots, 2 groups, \d+ destroys$/);
  });

  it("a plan that failed hands off a failure and keeps the step's exit", () => {
    const dir = reportDir();
    expect(writePlanHandoff({ report: dir, env: PLAN_ENV, exit: 4, vars: { TG_PR: "7" } }).code).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, PR_PLAN_NOTE_FILE), "utf-8")).state).toBe("failure");
  });

  it("no report: no hand-off, and the step fails, so chant's note job fails terragucci/plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-handoff-"));
    const r = writePlanHandoff({ report: dir, env: PLAN_ENV, exit: 0, vars: { TG_PR: "7" } });
    expect(r).toEqual({ code: 1, said: "terragucci: the plan report was not written" });
    expect(existsSync(join(dir, PR_PLAN_NOTE_FILE))).toBe(false);
  });

  it("no pull request: no hand-off, and the plan's exit", () => {
    const dir = reportDir();
    expect(writePlanHandoff({ report: dir, env: PLAN_ENV, exit: 0, vars: {} }).code).toBe(0);
    expect(existsSync(join(dir, PR_PLAN_NOTE_FILE))).toBe(false);
  });

  it("a root chant's marker cannot carry leaves the line empty rather than refuse the note", () => {
    expect(rootsMarker(["app", "a b"])).toBe("roots=");
    expect(rootsMarker(["app", "envs/dev/orders"])).toBe("roots=app,envs/dev/orders");
    expect(rootsMarker(Array.from({ length: 1000 }, (_, i) => `root-${i}`))).toBe("roots=");
  });

  it("pr-post renders it as terragucci's note: chant's marker, the roots line, the waves marker kept, and a stale mark finds it", () => {
    // A wave with a review digest: the note carries the waves marker `approval: pr-review` reads back.
    const reviewed = { ...REPORT, waves: REPORT.waves.map((w, i) => ({ ...w, review_digest: `sha256:${String(i).repeat(64)}`, waits: i === 0 })) } as Report;
    const dir = reportDir(reviewed);
    writePlanHandoff({ report: dir, env: PLAN_ENV, exit: 0, vars: { TG_PR: "7" } });
    const read = readPlanNoteHandoff({ dir, pr: 7, head: REPORT.run.commit, env: PLAN_ENV });
    if (!("handoff" in read) || !("note" in read.handoff)) throw new Error("no note hand-off");
    const body = planNoteHandoffNote(read.handoff, { kind: "github" }, prNoteMarker(PLAN_ENV), { ...NOTE_WORDS, productMarker: PLAN_PRODUCT_MARKER });
    const lines = body.split("\n");
    expect(lines[0]).toBe("<!-- chant-pr:default -->");
    expect(lines[1]).toBe("<!-- terragucci:plan roots=envs/dev/orders,envs/dev/search,envs/prod/orders,envs/prod/search -->");
    const waves = /<!-- terragucci:waves \{.*?\} -->/.exec(body)?.[0];
    expect(waves).toBeDefined();
    expect(parseMarker(body)).toEqual({ head: REPORT.run.commit, waves: [{ number: 1, digest: `sha256:${"0".repeat(64)}`, waits: true }, { number: 2, digest: `sha256:${"1".repeat(64)}`, waits: false }] });
    const stale = staleNote(body, ["envs/dev/orders"], "main")!;
    expect(stale.split("\n")[2]).toContain(STALE_MARKER);
    expect(stale.split("\n").slice(0, 2)).toEqual(lines.slice(0, 2));
  });

  it("the description check's flag is the note's first section, with no hidden marker for chant to defuse", () => {
    const note = flagNoteData(planNoteOf(REPORT), "> Check the description of this pull request. It says x. (y) This flag never blocks a merge. <!-- terragucci:description -->");
    expect(note.sections?.[0]).toEqual({ at: "start", text: "> Check the description of this pull request. It says x. (y) This flag never blocks a merge.\n" });
    expect(flagNoteData(note, "> Check the description of this pull request. Again.").sections?.filter((s) => s.text.startsWith("> Check the description")).length).toBe(1);
  });
});
