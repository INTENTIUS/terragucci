// scripts/demo-asks.mjs: the prompt-driven demos read as one set (terragucci#1269). chant's composed-run demos have
// the choudoufu demo's moments and prompts; the rest may name its own subject.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REFERENCE, compareDir, differences, problems, subjectless } from "../scripts/demo-asks.mjs";

const root = join(__dirname, "..");
const ref = (act: string) => JSON.parse(readFileSync(join(root, REFERENCE, `choudoufu-compose-${act}`, "ask.json"), "utf8")) as Record<string, unknown>;

// chant's demos, from DEMO_CHANT_TREES or a chant checkout beside this one, as stack/demo.sh finds them.
const chant = process.env.DEMO_CHANT_TREES ?? join(root, "..", "chant");
const chantDirs = ["demo-composed-stacks", "demo-composed-roots"].map((d) => join(chant, "examples", d, "scenarios"));

describe("the demos' asks", () => {
  it("puts subject words as one word", () => {
    expect(subjectless("One plan across 3 estates.")).toBe(subjectless("One plan across 3 stacks."));
    expect(subjectless("choudoufu holds no lock")).toBe(subjectless("chant holds no lock"));
  });

  it("finds nothing when a scenario is the reference itself", () => {
    for (const act of ["edit", "create"]) {
      expect(problems(ref(act), ref(act))).toEqual([]);
      expect(differences(ref(act), ref(act))).toEqual([]);
    }
  });

  it("names a prompt or a moment that differs", () => {
    const a = ref("edit");
    const moved = { ...a, "pull-request": [{ ...(a["pull-request"] as object[])[0], prompt: "Something else." }, (a["pull-request"] as object[])[1]] };
    expect(problems(a, moved)).toEqual([expect.stringMatching(/^pull-request\[0\]: prompt "Something else\."/)]);
    const { closing: _c, ...short } = a;
    expect(problems(a, short)[0]).toMatch(/^moments /);
  });

  it("lets a reply differ only by its subject", () => {
    const a = ref("edit");
    const planned = a.planned as { reply: string };
    const b = { ...a, planned: { ...planned, reply: planned.reply.replace("estates", "stacks") } };
    expect(differences(a, b)).toEqual([]);
  });

  it.skipIf(!chantDirs.every(existsSync))("holds chant's composed-run demos to the choudoufu demo's moments and prompts", () => {
    for (const d of chantDirs) expect(compareDir(d, root).problems, d).toEqual([]);
  });
});
