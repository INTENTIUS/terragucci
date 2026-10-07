import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave, changesOutputs, parseLedger } from "../src/apply";
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
function fakeTerragrunt(): { exec: TerragruntExec; applied: Set<string>; calls: string[][] } {
  const applied = new Set<string>();
  const calls: string[][] = [];
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1];
  const exec: TerragruntExec = async (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") {
      return { code: 0, stdout: JSON.stringify([{ type: "unit", path: "live/a", dependencies: [] }, { type: "unit", path: "live/b", dependencies: ["live/a"] }]), stderr: "" };
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
        const plan = {
          resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: done ? { actions: ["no-op"], before: { input: u }, after: { input: u }, after_unknown: {} } : { actions: ["create"], before: null, after: { input: u }, after_unknown: {} } }],
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
  return { exec, applied, calls };
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
});
