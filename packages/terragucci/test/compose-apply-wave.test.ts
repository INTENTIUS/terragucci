// waves.compose on the apply's wave jobs: the spec chant gets when the composed
// run empties later waves, and the set the merge's wave composes.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertOpWavesSpec } from "@intentius/chant/op";
import { waveCallArgv, wavesSpec } from "../src/chant-waves";
import { composeSet, composeTarget, specWavesWithRun, wavesWithRun, type Composition } from "../src/compose";
import { affectedRoots } from "../src/report/stage";
import { baseCommit } from "../src/seal";
import { tmp, write } from "./helpers";

const composition = (wave: number, order: string[]): Composition => ({
  roots: [...order].sort(),
  order,
  max: 10,
  wave,
  modules: new Map(order.map((r) => [r, r])),
  reads: new Map(),
  ownWave: new Map(),
});

describe("the spec chant gets when the composed run empties later waves", () => {
  // The demo's scenario B: network in wave 1, app and other in wave 2, edge in wave 3; app, edge and network compose.
  const waves = [["network"], ["app", "other"], ["edge"]];

  it("keeps every wave in its place, each with a run, so chant takes the spec", () => {
    const c = composition(1, ["network", "app", "edge"]);
    const runs = specWavesWithRun(waves, c);
    expect(runs).toEqual([[composeTarget(1)], ["other"], [composeTarget(1)]]);
    const spec = wavesSpec({ waves: runs, gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false });
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    expect(spec.waves.map((w) => w.name)).toEqual(["wave-1", "wave-2", "wave-3"]);
  });

  it("is what chant refused before: a wave left with no runs", () => {
    const c = composition(1, ["network", "app", "other", "edge"]);
    const empty = wavesWithRun(waves, c, true);
    expect(empty[1]).toEqual([]);
    expect(() => assertOpWavesSpec(wavesSpec({ waves: empty, gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false }))).toThrow(/wave "wave-2" has no runs/);
    const runs = specWavesWithRun(waves, c);
    expect(runs).toEqual([[composeTarget(1)], [composeTarget(1)], [composeTarget(1)]]);
    expect(() => assertOpWavesSpec(wavesSpec({ waves: runs, gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false }))).not.toThrow();
  });

  it("is the waves as they are with no composed run, or one that falls back", () => {
    expect(specWavesWithRun(waves, undefined)).toEqual(waves);
    expect(specWavesWithRun(waves, { ...composition(1, ["network", "app"]), fallback: { reason: "x" } as never })).toEqual(waves);
  });
});

describe("the set a merge's wave composes", () => {
  const ROOTS = ["network", "app", "edge", "other"];
  // app and edge read network's state; other reads nothing and nothing reads it.
  const deps = new Map<string, Set<string>>([["app", new Set(["network"])], ["edge", new Set(["network"])]]);

  it("is the set the pull request's plan composed, from the wave's shallow checkout of the merge commit", () => {
    const dir = write(tmp(), Object.fromEntries(ROOTS.map((r) => [`${r}/main.tf`, `# ${r}\n`])));
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf-8" }).trim();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const main = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-qb", "change");
    write(dir, { "app/main.tf": "# app, changed\n", "edge/main.tf": "# edge, changed\n" });
    git(dir, "commit", "-qam", "change app and edge");
    // tf-plan in the pull request: the head against its base, from a checkout with history.
    const planned = composeSet(ROOTS, affectedRoots(dir, main, ROOTS, ROOTS, () => {}), deps);
    expect(planned).toEqual(["app", "edge", "network"]);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "change");
    // The wave job checks the merge commit out one commit deep; its base is the merge's first parent.
    const wave = join(tmp(), "wave");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, wave]);
    const base = baseCommit(wave);
    expect(base).toBe(main);
    const lines: string[] = [];
    // Before: base...HEAD needs a merge base the shallow checkout lacks, so every root counted, other included.
    expect(affectedRoots(wave, base, ROOTS, ROOTS, (l) => lines.push(l))).toBeUndefined();
    expect(lines.join("\n")).toMatch(/affected selection failed/);
    expect(composeSet(ROOTS, undefined, deps)).toContain("other");
    // After: the diff from the merge's parent, the set the plan composed.
    expect(composeSet(ROOTS, affectedRoots(wave, base, ROOTS, ROOTS, () => {}, undefined, {}, true), deps)).toEqual(planned);
  });
});
