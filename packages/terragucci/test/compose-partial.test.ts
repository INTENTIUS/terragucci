// Partial composition (terragucci#1276): chant composes part of a change and reports each root it leaves out with its
// reason (its composition's `fallbacks`, the left-out report). terragucci runs the roots chant kept as one run, applies
// each left-out root in its own wave, and places the run after every wave a left-out root it reads applies in. When
// that puts the run after a root outside it that reads it, the whole change applies in waves.
//
// chant's composition stands in here (src/chant-next.ts), so these run on any chant: each case hands terragucci the
// left-out report chant would give.
import { afterEach, describe, expect, it } from "vitest";
import { overrideChantNext, type ChantComposition, type ChantCompositionInput, type ChantFallback } from "../src/chant-next";
import { compositionFor, compositionLine, placeRun, reportCompose, specWavesWithRun, wavesWithRun, type CompositionInput } from "../src/compose";
import type { Report } from "../src/report/schema";
import { composeBlock } from "../src/report/views";
import { tmp } from "./helpers";

/** chant's composition of `members`, the other candidates left out with `left`'s reasons. */
function chantSays(members: string[], left: ChantFallback[], whole?: ChantFallback) {
  const seen: ChantCompositionInput[] = [];
  const candidates = [...members, ...left.map((f) => f.member!)].sort();
  const composition: ChantComposition = {
    candidates,
    members: whole ? [] : [...members].sort(),
    order: whole ? [] : members,
    max: 10,
    roots: new Map(candidates.map((r) => [r, r])),
    dirs: new Map(),
    modules: new Map(members.map((r) => [r, r])),
    reads: new Map(),
    fallbacks: left,
    ...(whole ? { fallback: whole } : {}),
  };
  restore.push(
    overrideChantNext("compose", {
      compositionFor: (i: ChantCompositionInput) => (seen.push(i), composition),
      moduleNames: (roots: readonly string[]) => new Map(roots.map((r) => [r, r])),
      readOrder: (set: readonly string[]) => [...set],
    }),
  );
  return seen;
}

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const input = (all: string[], waves: string[][], deps: Record<string, string[]>): CompositionInput => ({
  all,
  waves,
  env: {},
  binary: () => ({ name: "tofu" }),
  deps: new Map(Object.entries(deps).map(([k, v]) => [k, new Set(v)])),
});

describe("a change chant composes in part", () => {
  it("runs the roots chant kept, in the earliest wave they are in, and leaves the others to their waves", async () => {
    // net applies first and is left out; app and web read it and compose.
    chantSays(["app", "web"], [{ kind: "backend", member: "net", reason: "`net`'s backend is not one chant locks itself" }]);
    const waves = [["net"], ["app"], ["web"]];
    const c = await compositionFor(tmp(), input(["app", "net", "web"], waves, { app: ["net"], web: ["app"] }));
    expect(c.fallback).toBeUndefined();
    expect(c.roots).toEqual(["app", "web"]);
    expect(c.leftOut).toEqual([{ kind: "backend", root: "net", reason: "`net`'s backend is not one chant locks itself" }]);
    expect(c.wave).toBe(2);
    expect(wavesWithRun(waves, c, false)).toEqual([["net"], ["app", "web"], []]);
    expect(specWavesWithRun(waves, c)).toEqual([["net"], ["compose:wave-2"], ["compose:wave-2"]]);
  });

  it("puts the run after a left-out root it reads that applies later than the run's earliest root", async () => {
    // net (wave 1) and app (wave 3) compose; dns (wave 2) is left out, and app reads it.
    chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "`dns` runs terraform 1.9.8 where the others run tofu" }]);
    const waves = [["net"], ["dns"], ["app"]];
    const c = await compositionFor(tmp(), input(["app", "dns", "net"], waves, { app: ["net", "dns"] }));
    expect(c.fallback).toBeUndefined();
    expect(c.wave).toBe(3);
    expect(c.ownWave).toEqual(new Map([["net", 1], ["app", 3]]));
    expect(wavesWithRun(waves, c, false)).toEqual([[], ["dns"], ["net", "app"]]);
    // chant's spec keeps every wave in its place: the one the run emptied lists the run's target.
    expect(specWavesWithRun(waves, c)).toEqual([["compose:wave-3"], ["dns"], ["compose:wave-3"]]);
    expect(compositionLine(c)).toBe("compose: net, app apply as one composed run in wave 3 (compose:wave-3); dns applies in its own wave (`dns` runs terraform 1.9.8 where the others run tofu)");
  });

  it("follows the reads upstream through other left-out roots", async () => {
    // app reads cache, which reads dns: both are left out, and dns applies latest of them.
    chantSays(["net", "app"], [
      { kind: "binary", member: "cache", reason: "cache" },
      { kind: "binary", member: "dns", reason: "dns" },
    ]);
    const waves = [["net", "cache"], ["dns"], ["app"]];
    const c = await compositionFor(tmp(), input(["app", "cache", "dns", "net"], waves, { app: ["net", "cache"], cache: ["dns"] }));
    expect(c.wave).toBe(3);
  });

  it("applies wholly in waves when a root outside the run reads it and would apply before it", async () => {
    // The run must wait for dns (wave 2), but log reads net and applies in wave 2.
    chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "dns" }]);
    const waves = [["net"], ["dns", "log"], ["app"]];
    const c = await compositionFor(tmp(), input(["app", "dns", "log", "net"], waves, { app: ["net", "dns"], log: ["net"] }));
    expect(c.wave).toBeUndefined();
    expect(c.fallback).toEqual({ kind: "split", root: "log", reason: "`log` reads `net` of the composed run and applies in wave 2, before the run, which applies in wave 3, since it waits for `dns`, a root left out of it that it reads, in wave 2" });
    expect(wavesWithRun(waves, c, true)).toEqual(waves);
    expect(reportCompose(c)).toEqual({ roots: ["app", "net"], max: 10, fallback: c.fallback });
  });

  it("orders by waves.after as by a read", async () => {
    chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "dns" }]);
    const waves = [["net"], ["dns"], ["app"]];
    const c = await compositionFor(tmp(), { ...input(["app", "dns", "net"], waves, { app: ["net"] }), after: { app: ["dns"] } });
    expect(c.wave).toBe(3);
  });

  it("applies wholly in waves, with the first left-out root's reason, when fewer than two roots are kept", async () => {
    chantSays(["app"], [{ kind: "identity", member: "net", reason: "`net` applies under another cloud identity (`ci.identity.cloud`)" }], { kind: "one-root", reason: "one root composes" });
    const c = await compositionFor(tmp(), input(["app", "net"], [["net"], ["app"]], { app: ["net"] }));
    expect(c.wave).toBeUndefined();
    expect(c.leftOut).toBeUndefined();
    // chant's reason in terragucci's terms.
    expect(c.fallback).toEqual({ kind: "identity", root: "net", reason: "`net` runs under another role (`oidc.roles`) or apply group" });
  });

  it("keeps a whole-change reason chant gives", async () => {
    chantSays([], [], { kind: "cli-args", reason: "`TF_CLI_ARGS` carries `-target`" });
    const c = await compositionFor(tmp(), input(["app", "net"], [["net"], ["app"]], { app: ["net"] }));
    expect(c.fallback).toEqual({ kind: "cli-args", reason: "`TF_CLI_ARGS` carries `-target`" });
  });

  it("hands chant every root of the pipeline, each depending on what it reads and what waves.after puts first", async () => {
    const seen = chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "dns" }]);
    await compositionFor(tmp(), { ...input(["app", "dns", "net"], [["net"], ["dns"], ["app"]], { app: ["net"] }), after: { app: ["dns"] } });
    expect(seen[0]!.components.map((x) => [x.name, x.dependsOn ?? []])).toEqual([
      ["app", ["dns", "net"]],
      ["dns", []],
      ["net", []],
    ]);
  });
});

describe("the report and note of a run that left roots out", () => {
  it("names each left-out root with its reason, in the report's compose and in the note", async () => {
    chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "`dns` runs terraform 1.9.8 where the others run tofu" }]);
    const c = await compositionFor(tmp(), input(["app", "dns", "net"], [["net"], ["dns"], ["app"]], { app: ["net", "dns"] }));
    const compose = reportCompose(c);
    expect(compose).toEqual({ roots: ["app", "net"], max: 10, wave: 3, left_out: [{ kind: "binary", root: "dns", reason: "`dns` runs terraform 1.9.8 where the others run tofu" }] });
    const report = {
      run: { stage: "tf-plan" },
      compose,
      waves: [{ number: 3, roots: ["net", "app"], composed: { plan_digest: "sha256:d", members: [{ root: "net", module: "module.net" }, { root: "app", module: "module.app" }] } }],
      roots: [
        { path: "net", counts: { create: 1 } },
        { path: "app", counts: { create: 1 } },
      ],
    } as unknown as Report;
    const text = composeBlock(report)!;
    expect(text).toContain("**One composed run, in wave 3** (`waves.compose`): `net` and `app` plan as one plan and apply as one apply.");
    expect(text).toContain("**Left out of the run (1).** Each applies in its own wave, as without `waves.compose`:\n\n- `dns`: `dns` runs terraform 1.9.8 where the others run tofu (`binary`)\n");
  });

  it("has no left_out when the change applies in waves", async () => {
    chantSays(["net", "app"], [{ kind: "binary", member: "dns", reason: "dns" }]);
    const waves = [["net"], ["dns", "log"], ["app"]];
    const c = await compositionFor(tmp(), input(["app", "dns", "log", "net"], waves, { app: ["net", "dns"], log: ["net"] }));
    expect(reportCompose(c)).not.toHaveProperty("left_out");
    expect(composeBlock({ run: { stage: "tf-plan" }, compose: reportCompose(c), waves: [], roots: [] } as unknown as Report)).toBe(`**Applies in waves** (\`waves.compose\`): ${c.fallback!.reason}.\n`);
  });
});

describe("placeRun", () => {
  const ups = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

  it("is the earliest wave of the run's roots when nothing outside it pushes it later", () => {
    expect(placeRun(["a", "b"], [["a"], ["b"]], ups({ b: ["a"] }))).toEqual({ wave: 1 });
  });

  it("is the wave after the last left-out root its roots read", () => {
    expect(placeRun(["a", "b"], [["a"], ["x"], ["y"], ["b"]], ups({ b: ["a", "x", "y"] }))).toEqual({ wave: 4 });
  });

  it("ignores a left-out root this apply does not run", () => {
    expect(placeRun(["a", "b"], [["a"], ["b"]], ups({ b: ["a", "gone"] }))).toEqual({ wave: 1 });
  });

  it("lets a root outside the run read it from a later wave", () => {
    expect(placeRun(["a", "b"], [["a", "x"], ["b"], ["c"]], ups({ b: ["a", "x"], c: ["b"] }))).toEqual({ wave: 2 });
  });

  it("follows a root outside the run that reads it through another one", () => {
    // c reads a and d reads c, both outside the run; c applies before the run, which waits for y.
    const p = placeRun(["a", "b"], [["a"], ["x", "c"], ["d"], ["y"], ["b"]], ups({ b: ["a", "y"], c: ["a"], d: ["c"] }));
    expect(p.wave).toBeUndefined();
    expect(p.fallback).toMatchObject({ kind: "split", root: "c" });
  });

  it("has no wave when none of its roots is in this apply", () => {
    expect(placeRun(["a", "b"], [["c"]], ups({}))).toEqual({ fallback: { kind: "one-root", reason: "none of its roots is in a wave of this apply" } });
  });
});
