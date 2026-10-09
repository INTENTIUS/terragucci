import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave, changesOutputs, parseLedger, readDecision } from "../src/apply";
import type { CostRunner } from "../src/report/cost";
import { git, tmp, write } from "./helpers";

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

describe("changesOutputs", () => {
  it("is true when an output is created, updated or deleted, and false for no-op outputs or none", () => {
    expect(changesOutputs({ output_changes: { bucket: { actions: ["create"] } } })).toBe(true);
    expect(changesOutputs({ output_changes: { bucket: { actions: ["no-op"] } } })).toBe(false);
    expect(changesOutputs({})).toBe(false);
  });
});

/**
 * A Terragrunt that knows two units: live/a, and live/b, which reads it, so
 * two dependency layers. A unit plans a create until it applied, and live/a's
 * create makes its output. `calls` keeps every `run --all` it was asked for.
 */
function fakeTerragrunt(
  found: { path: string; dependencies: string[] }[] = [{ path: "live/a", dependencies: [] }, { path: "live/b", dependencies: ["live/a"] }],
  inputs: Record<string, string> = {},
): { exec: TerragruntExec; applied: Set<string>; calls: string[][]; inputs: Record<string, string> } {
  const applied = new Set<string>();
  const calls: string[][] = [];
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1];
  const exec: TerragruntExec = async (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") {
      return { code: 0, stdout: JSON.stringify(found.map((u) => ({ type: "unit", ...u }))), stderr: "" };
    }
    if (args[0] === "render") return { code: 0, stdout: "{}", stderr: "" };
    if (args[0] !== "run") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    calls.push([...args]);
    const units = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [/^\{\.\/(.+)\}$/.exec(a)![1]] : []));
    const command = args[args.indexOf("--") + 1];
    const out = flag(args, "--out-dir");
    for (const u of units) {
      if (command === "plan") {
        const done = applied.has(u);
        const input = inputs[u] ?? u;
        const plan = {
          resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: done ? { actions: ["no-op"], before: { input }, after: { input }, after_unknown: {} } : { actions: ["create"], before: null, after: { input }, after_unknown: {} } }],
          ...(u === "live/a" ? { output_changes: { bucket: { actions: done ? ["no-op"] : ["create"], before: done ? "a" : null, after: "a" } } } : {}),
        };
        for (const [dir, name, text] of [[out, "tfplan.tfplan", "plan"], [flag(args, "--json-out-dir"), "tfplan.json", JSON.stringify(plan)]]) {
          mkdirSync(join(dir, u), { recursive: true });
          writeFileSync(join(dir, u, name), text);
        }
      } else {
        if (!existsSync(join(out, u, "tfplan.tfplan"))) return { code: 1, stdout: "", stderr: `no saved plan for ${u}` };
        applied.add(u);
      }
    }
    const report = flag(args, "--report-file");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(units.map((u) => ({ Name: u, Result: "succeeded" }))));
    return { code: 0, stdout: "", stderr: units.map((u) => `[${u}] tofu: ${command} complete`).join("\n") };
  };
  return { exec, applied, calls, inputs };
}

describe("a Terragrunt wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(): { work: string; origin: string } {
    const dir = tmp("tg-tgwave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, { "root.hcl": "", "live/a/terragrunt.hcl": "", "live/b/terragrunt.hcl": "" });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    return { work, origin };
  }

  function approve(origin: string, gate: string, digest: string, at: string): void {
    const clone = join(tmp("tg-approve-"), "l");
    execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
    const file = join(clone, "_gates/tf-apply.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify({ version: 1, kind: "resolution", op: "tf-apply", gate, resolvedBy: "alice", timestamp: at, planDigest: digest })}\n`);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
  }

  const ledger = (origin: string) => parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));

  const opts = (tg: ReturnType<typeof fakeTerragrunt>, gate: "always" | "never" = "always") =>
    ({ layers: [["live/a"], ["live/b"]], binary: "tofu", gate, env: {}, terragrunt: true, terragruntExec: tg.exec });
  /** The units each `run --all` was asked to plan or apply, in order. */
  const runs = (tg: ReturnType<typeof fakeTerragrunt>): string[] =>
    tg.calls.map((c) => `${c[c.indexOf("--") + 1]} ${c.flatMap((a, i) => (c[i - 1] === "--filter" ? [/^\{\.\/(.+)\}$/.exec(a)![1]] : [])).join(",")}`);

  it("cuts a wave per dependency layer: each waits for an approval of its own set digest at its own gate and applies its saved plans", async () => {
    const { work, origin } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();

    // Wave 1 is live/a alone: live/b reads it, so it is the next layer and is not planned yet.
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(1) })).toBe(3);
    expect(tg.applied.size).toBe(0);
    expect(runs(tg)).toEqual(["plan live/a"]);
    expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 2: planning live/a");
    expect(ledger(origin).pending.map((p) => [p.gate, p.members!.map((m) => m.member)])).toEqual([["wave-1", ["live/a"]]]);

    // Approved, live/a applies from its saved plan.
    approve(origin, "wave-1", ledger(origin).pending[0].planDigest!, T(2));
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(3) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a"]);

    // Wave 2 plans live/b against what wave 1 applied and waits at its own gate.
    expect(await applyWave(work, { ...opts(tg), wave: 2, now: T(4) })).toBe(3);
    const pend = ledger(origin).pending;
    expect(pend.map((p) => [p.gate, p.members!.map((m) => m.member)])).toEqual([["wave-1", ["live/a"]], ["wave-2", ["live/b"]]]);
    approve(origin, "wave-2", pend[1].planDigest!, T(5));
    expect(await applyWave(work, { ...opts(tg), wave: 2, now: T(6) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a", "live/b"]);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.waves[0]).toMatchObject({ number: 2, roots: ["live/b"], approval: "approved" });

    // Every apply ran saved plans: no -auto-approve, and the out dir the plan wrote.
    const applies = tg.calls.filter((c) => c[c.indexOf("--") + 1] === "apply");
    expect(applies).toHaveLength(2);
    for (const c of applies) {
      expect(c).not.toContain("-auto-approve");
      expect(c).toContain("--out-dir");
      expect(c.slice(c.indexOf("--") + 1)).toEqual(["apply", "-lock-timeout=5m"]);
    }
  });

  it("refuses the wave when the plans moved after their approval, and applies nothing", async () => {
    const { work, origin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(1) })).toBe(3);
    approve(origin, "wave-1", "jcs1-sha256:" + "0".repeat(64), T(2));
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(3) })).toBe(4);
    expect(tg.applied.size).toBe(0);
  });

  it("with --rest, runs every wave from its own in order, and stops at the first that waits", async () => {
    const { work } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const never = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(never, "never"), wave: 1, rest: true, now: T(1) })).toBe(0);
    expect(runs(never)).toEqual(["plan live/a", "apply live/a", "plan live/b", "apply live/b"]);

    const { work: work2, origin } = setup();
    const always = fakeTerragrunt();
    expect(await applyWave(work2, { ...opts(always), wave: 1, rest: true, now: T(1) })).toBe(3);
    expect(runs(always)).toEqual(["plan live/a"]);
    expect(ledger(origin).pending.map((p) => p.gate)).toEqual(["wave-1"]);
  });

  it("splits a pipeline wave by the edges terragrunt find gives: a pipeline that lists one wave still applies live/a before live/b", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg, "never"), layers: [["live/a", "live/b"]], wave: 1, rest: true, now: T(1) })).toBe(0);
    expect(runs(tg)).toEqual(["plan live/a", "apply live/a", "plan live/b", "apply live/b"]);
    expect(out.mock.calls.flat().join("\n")).toContain("Terragrunt's edges cut the pipeline's 1 wave into 2");
  });

  it("refuses a pipeline that applies a unit before what it reads, and applies nothing", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg, "never"), layers: [["live/b"], ["live/a"]], wave: 1, rest: true, now: T(1) })).toBe(1);
    expect(tg.calls).toHaveLength(0);
    expect(out.mock.calls.flat().join("\n")).toContain("live/b reads live/a, which the pipeline applies in a later wave; run terragucci init");
  });

  it("a wave past the last one has nothing to apply", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg), wave: 3, now: T(1) })).toBe(0);
    expect(tg.calls).toHaveLength(0);
    expect(out.mock.calls.flat().join("\n")).toContain("wave 3: this repo has 2 waves, so there is nothing to apply");
  });

  it("--rest needs --terragrunt", async () => {
    await expect(applyWave(tmp(), { wave: 1, layers: [["a"]], binary: "tofu", gate: "never", rest: true })).rejects.toThrow(/needs --terragrunt/);
  });

  /** setup, with files at the base commit and the commit applied on top of it, so settings read at base are these. */
  function setupWith(files: Record<string, string>, units = ["live/a", "live/b"]): { work: string; origin: string } {
    const dir = tmp("tg-tgwave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, { "root.hcl": "", ...Object.fromEntries(units.map((u) => [`${u}/terragrunt.hcl`, ""])), ...files });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    write(work, { "live/README": "the change\n" });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the change");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    return { work, origin };
  }

  describe("cost", () => {
    const priced = (delta: number): CostRunner => async () => ({ code: 0, stdout: JSON.stringify({ currency: "USD", totalMonthlyCost: String(delta), pastTotalMonthlyCost: "0", diffTotalMonthlyCost: String(delta) }), stderr: "" });
    const yml = "gate: never\ncost:\n  command: node cost.mjs\n  approve_above: 15\n";

    it("prices each unit's saved plan, and a wave over cost.approve_above waits under gate: never with its cost in the digest", async () => {
      const { work, origin } = setupWith({ "terragucci.yml": yml });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1), costRunner: priced(20) })).toBe(3);
      expect(tg.applied.size).toBe(0);
      expect(out.mock.calls.flat().join("\n")).toContain("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at ");
      const pending = ledger(origin).pending[0]!;
      expect(pending.members!.map((m) => m.member)).toEqual(["live/a", "(monthly cost)"]);
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      expect(report.waves[0]).toMatchObject({ approval: "waiting", cost: { monthly_delta: 20, approve_above: 15, over: true } });
      expect(report.cost).toMatchObject({ roots: [{ root: "live/a", monthly_delta: 20 }] });
      // The same plans priced higher are another digest: the approval of the first does not apply them.
      approve(origin, "wave-1", pending.planDigest!, T(2));
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(3), costRunner: priced(40) })).toBe(4);
      expect(tg.applied.size).toBe(0);
      // Within the amount, gate: never applies.
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(4), costRunner: priced(10) })).toBe(0);
      expect([...tg.applied]).toEqual(["live/a"]);
    });
  });

  describe("steps", () => {
    it("runs each moment once around the wave's run --all, in the dirs its globs match, and a step after plan holds the gate", async () => {
      const steps = [
        "steps:",
        "  - name: tfvars",
        '    run: echo "$TG_STAGE" > step.txt',
        "    before: plan",
        "  - name: verify",
        '    run: test -f "$TG_PLAN_FILE" && echo "plan of $TG_ROOT" >> step.txt && exit 1',
        "    after: plan",
        '    roots: ["live/a"]',
        "    on_failure: approve",
        "  - name: done",
        "    run: echo applied >> step.txt",
        "    after: apply",
      ].join("\n");
      const { work, origin } = setupWith({ "terragucci.yml": `gate: never\n${steps}\n` });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      // Under gate: never the step after plan holds wave 1, and nothing applies.
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(3);
      expect(tg.applied.size).toBe(0);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\n");
      expect(existsSync(join(work, "live/b/step.txt"))).toBe(false);
      expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 2: live/a: step verify asks for an approval, so the gate holds this wave");
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      expect(report.waves[0]).toMatchObject({ held_by_steps: ["live/a"] });
      expect(report.roots[0].steps.map((x: { name: string; status: string }) => `${x.name} ${x.status}`)).toEqual(["tfvars passed", "verify approval"]);
      // Approved, the wave applies its saved plan, and the step after apply runs.
      approve(origin, "wave-1", ledger(origin).pending[0]!.planDigest!, T(2));
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(3) })).toBe(0);
      expect([...tg.applied]).toEqual(["live/a"]);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\napplied\n");
    });

    it("a step before the apply that fails applies nothing; after: init is refused", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\nsteps:\n  - name: stop\n    run: exit 1\n    before: apply\n" });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(1);
      expect(tg.applied.size).toBe(0);
      expect(runs(tg)).toEqual(["plan live/a"]);
      expect(out.mock.calls.flat().join("\n")).toContain("live/a: before-apply step stop failed (exit 1)");
      const late = setupWith({ "terragucci.yml": "gate: never\nsteps:\n  - name: late\n    run: echo late\n    after: init\n" });
      const tg2 = fakeTerragrunt();
      expect(await applyWave(late.work, { ...opts(tg2, "never"), wave: 1, now: T(1) })).toBe(1);
      expect(tg2.calls).toHaveLength(0);
      expect(out.mock.calls.flat().join("\n")).toContain("steps late: a Terragrunt repo inits each unit inside the wave's run --all plan");
    });
  });

  describe("waves.jobs", () => {
    const three = [{ path: "live/c", dependencies: [] }, { path: "live/d", dependencies: [] }, { path: "live/e", dependencies: [] }];
    const split = (tg: ReturnType<typeof fakeTerragrunt>, decided: string) => ({ layers: [["live/c", "live/d", "live/e"]], binary: "tofu", gate: "never" as const, env: {}, terragrunt: true, terragruntExec: tg.exec, shares: 2, decided });

    it("the wave's job plans every unit and decides; each share plans its units with --filter and applies the plans decided on", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e"]);
      expect(tg.applied.size).toBe(0);
      const d = readDecision(decided);
      expect(d).toMatchObject({ wave: 1, shares: 2, approval: "not-required", changes: 3 });
      expect(d.members.map((m) => m.member)).toEqual(["live/c", "live/d", "live/e"]);
      expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 1: share 1 of 2 applies live/c, live/e");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 1, now: T(2) })).toBe(0);
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 2, now: T(3) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e", "plan live/c,live/e", "apply live/c,live/e", "plan live/d", "apply live/d"]);
      expect([...tg.applied].sort()).toEqual(["live/c", "live/d", "live/e"]);
    });

    it("a share whose plans moved since the wave decided applies nothing", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      tg.inputs["live/d"] = "moved";
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 2, now: T(2) })).toBe(4);
      expect(tg.applied.size).toBe(0);
      expect(out.mock.calls.flat().join("\n")).toContain("these units planned differently since wave 1 decided on");
    });

    it("a wave with nothing to change still hands its shares a decision, and they apply nothing", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      for (const u of ["live/c", "live/d", "live/e"]) tg.applied.add(u);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      expect(readDecision(decided)).toMatchObject({ changes: 0 });
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 1, now: T(2) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e"]);
    });
  });
});
