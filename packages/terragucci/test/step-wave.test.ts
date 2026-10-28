// terragucci#1303: a plain repo's wave on chant's terraform-apply step, run in terragucci's process with chant's
// after-plan hook (chant#4614). A stand-in for chant's op entry plans each root the way the step writes its plan
// file, calls the hook once per root, and applies; the wave's report comes from those plans.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { chantAfterPlan, chantNextParts, overrideChantNext, type ChantAfterPlanRun } from "../src/chant-next";
import { CHANT_CONFIG, CHANT_CONFIG_MARKER, chantConfigRoots, chantConfigText, chantConfigWrittenByTerragucci, declaredTerraformRoots } from "../src/chant-config";
import { committedSpecAt, waveCallArgv, WAVES_SPEC, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { renderPipeline } from "../src/render";
import { git, tmp, write } from "./helpers";
import { setup } from "./apply-helpers";

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PLAN = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] };

/** A stand-in for chant's op entry: the step's plan files, the after-plan hook per root, then the apply. */
function fakeChant(work: string, seen: ChantAfterPlanRun[], specs: object[]) {
  return {
    OP_WAVE_AFTER_PLAN_FLOOR: "0.0.0-next",
    opWavePlanPath: (spec: { name: string }, k: number, target: string) => `.chant/op-waves/${spec.name}/wave-${k}/${target.replaceAll("/", "__")}.plan.json`,
    spawnExecAsync: async () => 0,
    async runOpWave(o: { spec: { name: string; step?: unknown; waves: { runs: { target: string }[] }[] }; wave: number; afterPlan?: { run(r: ChantAfterPlanRun): unknown } }) {
      specs.push(o.spec);
      const runs = o.spec.waves[o.wave - 1]!.runs;
      for (const { target } of runs) {
        const planJson = join(work, target, "tfplan.json");
        writeFileSync(planJson, JSON.stringify(PLAN));
        const path = `.chant/op-waves/${o.spec.name}/wave-${o.wave}/${target}.plan.json`;
        mkdirSync(join(work, path, ".."), { recursive: true });
        writeFileSync(join(work, path), JSON.stringify({ planDigest: `sha256:${target}`, member: target, artifact: { planFile: "tfplan", planJson }, changeSet: { entries: [{ action: "create" }] } }));
      }
      for (const { target } of runs) {
        const r: ChantAfterPlanRun = { wave: o.wave, waveName: `wave-${o.wave}`, job: "wave", target, planDigest: `sha256:${target}`, plan: `.chant/op-waves/${o.spec.name}/wave-${o.wave}/${target}.plan.json`, planJson: join(work, target, "tfplan.json"), empty: false, destructive: false };
        seen.push(r);
        await o.afterPlan!.run(r);
      }
      return { exitCode: 0, applied: runs.map((r) => r.target), failed: [], moved: [], hooks: [], decision: { digest: "sha256:set", status: "not-required", members: [] } };
    },
  };
}

describe("chant.config.ts (terragucci#1303)", () => {
  it("names every root under terraform.roots, and reads them back", () => {
    const text = chantConfigText(["b", "a", "a"], "tofu");
    expect(text.startsWith(CHANT_CONFIG_MARKER)).toBe(true);
    expect(chantConfigWrittenByTerragucci(text)).toBe(true);
    expect([...chantConfigRoots(text)!]).toEqual(["a", "b"]);
    expect(chantConfigRoots("export default defineConfig({ terraform: {} });")).toBeUndefined();
  });

  it("says why when the file is missing", () => {
    const dir = tmp("tg-chant-config-");
    expect(declaredTerraformRoots(dir)).toEqual({ why: expect.stringContaining("terragucci init writes it") });
    writeFileSync(join(dir, CHANT_CONFIG), chantConfigText(["a"]));
    expect(declaredTerraformRoots(dir)).toEqual({ roots: new Set(["a"]) });
  });
});

describe("the spec, written once (terragucci#1303)", () => {
  it("is in the rendered pipeline's files when init gives it", () => {
    const spec = wavesSpecText(wavesStepSpec({ waves: [["a"]], gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false }));
    const out = renderPipeline({ forge: "github", binary: "tofu", image: "img", layers: [["a"]], gate: "on-destructive", wavesSpec: spec } as Parameters<typeof renderPipeline>[0]);
    expect(out.extra?.find((f) => f.path === WAVES_SPEC)?.content).toBe(spec);
  });

  it("is read at the base commit", () => {
    const dir = tmp("tg-spec-at-base-");
    git(dir, "init", "-q", "-b", "main");
    write(dir, { [WAVES_SPEC]: "{}\n" });
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    expect(committedSpecAt(dir, "HEAD")).toBe("{}\n");
    expect(committedSpecAt(dir, "HEAD:nothing")).toBeUndefined();
  });
});

describe("a wave on chant's step (terragucci#1303)", () => {
  it("is missing on a chant without the after-plan hook", async () => {
    restore.push(overrideChantNext("afterPlan", null));
    expect(await chantAfterPlan()).toBeUndefined();
    expect((await chantNextParts()).afterPlan).toBe(false);
  });

  it("plans through the step and builds the wave's report from chant's plans, once per root, in order", async () => {
    const { work, bin } = setup({ [CHANT_CONFIG]: chantConfigText(["a"]) });
    const seen: ChantAfterPlanRun[] = [];
    const specs: object[] = [];
    restore.push(overrideChantNext("afterPlan", fakeChant(work, seen, specs)));
    restore.push(overrideChantNext("waveCapabilities", { registry: { has: () => true } }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    const code = await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: { ...process.env } });
    expect(code).toBe(0);
    expect(seen.map((r) => r.target)).toEqual(["a"]);
    expect(specs[0]).toMatchObject({ step: { kind: "terraform-apply", root: "{target}" } });
    expect(lines).toContain("a: Plan: 1 to add, 0 to change, 0 to destroy.");
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.roots.map((r: { path: string }) => r.path)).toEqual(["a"]);
  });

  it("keeps terragucci's calls, and says why, when chant.config.ts names no root", async () => {
    const { work, bin } = setup();
    const seen: ChantAfterPlanRun[] = [];
    restore.push(overrideChantNext("afterPlan", fakeChant(work, seen, [])));
    restore.push(overrideChantNext("waveCapabilities", { registry: { has: () => true } }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: { ...process.env } });
    expect(seen).toEqual([]);
    expect(lines.find((l) => l.includes("not chant's terraform-apply step"))).toContain("chant.config.ts is missing");
    expect(existsSync(join(work, WAVES_SPEC))).toBe(true);
  });
});
