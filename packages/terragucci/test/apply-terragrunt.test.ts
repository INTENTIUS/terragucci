import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave, changesOutputs, heldUnits, parseLedger } from "../src/apply";
import { git, tmp, write } from "./helpers";

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

describe("heldUnits", () => {
  const deps = new Map([["b", ["a"]], ["c", ["b"]], ["d", []], ["e", ["x"]]]);
  it("holds a unit that reads a unit of the pass whose outputs change, and every unit after it", () => {
    expect([...heldUnits(["a", "b", "c", "d"], deps, new Set(), new Set(["a"]))].sort()).toEqual(["b", "c"]);
  });
  it("holds a unit after one that waits for its upstream, and none when nothing upstream changes its outputs", () => {
    expect([...heldUnits(["a", "b", "c"], deps, new Set(["a"]), new Set())].sort()).toEqual(["b", "c"]);
    expect([...heldUnits(["a", "b", "c", "d"], deps, new Set(), new Set())]).toEqual([]);
  });
  it("ignores a dependency outside the pass: it applied in an earlier wave", () => {
    expect([...heldUnits(["e"], deps, new Set(), new Set(["x"]))]).toEqual([]);
  });
});

describe("changesOutputs", () => {
  it("is true when an output is created, updated or deleted, and false for no-op outputs or none", () => {
    expect(changesOutputs({ output_changes: { bucket: { actions: ["create"] } } })).toBe(true);
    expect(changesOutputs({ output_changes: { bucket: { actions: ["no-op"] } } })).toBe(false);
    expect(changesOutputs({})).toBe(false);
  });
});

/**
 * A Terragrunt that knows two units: live/a, and live/b, which reads it. A
 * unit plans a create until it applied, and live/a's create makes its output.
 * `calls` keeps every `run --all` it was asked for.
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

  it("waits for an approval of the units that can apply now, applies their saved plans, then waits again for the unit that reads them", async () => {
    const { work, origin } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    const opts = { wave: 1, layers: [["live/a", "live/b"]], binary: "tofu", gate: "always" as const, env: {}, terragrunt: true, terragruntExec: tg.exec };

    // live/b reads live/a, whose plan creates its output: live/b sits the pass out, and live/a waits for its approval.
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    expect(tg.applied.size).toBe(0);
    expect(ledger(origin).pending.map((p) => p.members!.map((m) => m.member))).toEqual([["live/a"]]);
    expect(out.mock.calls.flat().join("\n")).toContain("live/b reads a unit whose outputs this pass changes");
    const first = ledger(origin).pending[0].planDigest!;

    // Approved, live/a applies from its saved plan; live/b plans again against the applied outputs and waits for its own approval.
    approve(origin, "wave-1", first, T(2));
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(3);
    expect([...tg.applied]).toEqual(["live/a"]);
    const pend = ledger(origin).pending;
    expect(pend.map((p) => p.members!.map((m) => m.member))).toEqual([["live/a"], ["live/b"]]);
    const second = pend[1].planDigest!;
    expect(second).not.toBe(first);

    // The digest a re-run takes covers the units that change, so the approval of live/b's plan lets it apply.
    approve(origin, "wave-1", second, T(4));
    expect(await applyWave(work, { ...opts, now: T(5) })).toBe(0);
    expect([...tg.applied].sort()).toEqual(["live/a", "live/b"]);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.waves[0]).toMatchObject({ number: 1, roots: ["live/a", "live/b"], approval: "approved" });

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
    const opts = { wave: 1, layers: [["live/a", "live/b"]], binary: "tofu", gate: "always" as const, env: {}, terragrunt: true, terragruntExec: tg.exec };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    approve(origin, "wave-1", "jcs1-sha256:" + "0".repeat(64), T(2));
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(4);
    expect(tg.applied.size).toBe(0);
  });

  it("with gate never, applies the wave pass by pass in one run", async () => {
    const { work } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { wave: 1, layers: [["live/a", "live/b"]], binary: "tofu", gate: "never", env: {}, terragrunt: true, terragruntExec: tg.exec, now: T(1) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a", "live/b"]);
  });
});
