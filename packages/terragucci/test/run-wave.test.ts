// terragucci issue 1411: `terragucci waves-spec`, the tf-apply spec chant's renderSpec runs, and `terragucci run wave`,
// chant's wave runner in terragucci's process with its hooks, in the one-job shape and in each job of a split wave.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpWavesSpec, ProductWaveHook } from "@intentius/chant/op";
import { CHANT_CONFIG, chantConfigText } from "../src/chant-config";
import { WAVE_CLIENT, waveCallArgv, WAVES_SPEC, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { flagValue, runWave } from "../src/run-wave";
import { printWavesSpec, wavesSpecAt } from "../src/waves-spec";
import { git, tmp, write } from "./helpers";
import { setup, STEP_FAKE } from "./apply-helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const commit = (dir: string, files: Record<string, string>, message = "change"): string => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
};

/** The shape init commits beside the pipeline. */
const shape = (waves: string[][], gate: "always" | "on-destructive" | "never" = "on-destructive"): string =>
  wavesSpecText(wavesStepSpec({ waves, gate, approval: "ledger", call: waveCallArgv, migrations: false }));

function repo(files: Record<string, string>): string {
  const dir = tmp("tg-waves-spec-");
  git(dir, "init", "-q", "-b", "main");
  commit(dir, files, "one");
  return dir;
}

const quiet = (): string[] => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
  vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
  return lines;
};

describe("terragucci waves-spec", () => {
  it("reads the shape and the rules at the commit it is handed, never the working tree", async () => {
    const dir = repo({ [WAVES_SPEC]: shape([["net"], ["app", "db"]]), "terragucci.yml": "gate: always\n" });
    // The change in the working tree loosens the gate: the spec still says the commit's.
    writeFileSync(join(dir, "terragucci.yml"), "gate: never\n");
    quiet();
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(spec.name).toBe("tf-apply");
    expect(spec.gateName).toBe("wave-{k}");
    expect(spec.waves.map((w) => [w.name, w.gate, w.runs.map((r) => r.target)])).toEqual([["wave-1", "always", ["net"]], ["wave-2", "always", ["app", "db"]]]);
    expect(spec.defaultBranch).toBe(true);
    expect(spec.standDown).toBe(true);
    expect(spec.branches).toBeUndefined();
    expect((spec as { step?: { kind: string } }).step?.kind).toBe("terraform-apply");
    // The gate's report, and wave 1's state migrations, are hooks terragucci's run wave serves in its own process.
    expect(spec.hooks?.after?.gate?.map((h) => h.name)).toEqual(["report"]);
    expect(spec.waves[0]!.hooks?.before?.plan?.map((h) => [h.name, h.onFailure])).toEqual([["migrations", undefined], ["migration gate", "approve"]]);
    expect(spec.waves[1]!.hooks).toBeUndefined();
    expect(spec.hooks?.after?.gate?.[0]!.command).toContain(WAVE_CLIENT);
  });

  it("takes each wave's gate from the environments of its roots at that commit", async () => {
    const dir = repo({
      [WAVES_SPEC]: shape([["envs/dev/app"], ["envs/prod/app"]]),
      "terragucci.yml": "gate: never\nenvironments:\n  dev:\n    roots: [\"envs/dev/*\"]\n  prod:\n    roots: [\"envs/prod/*\"]\n    gate: always\n",
    });
    quiet();
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    // The shape's on-destructive is stricter than the config's never; prod's always is stricter again.
    expect(spec.waves.map((w) => w.gate)).toEqual(["on-destructive", "always"]);
  });

  it("names the approval mode, the decision point, resume, notify and apply.branches", async () => {
    const dir = repo({
      [WAVES_SPEC]: shape([["envs/prod/app", "envs/dev/app"]]),
      "terragucci.yml": [
        "approval: pr-review",
        "apply:",
        "  resume: 15",
        "  branches:",
        "    release: [\"envs/prod/*\"]",
        "notify:",
        "  slack: SLACK_URL",
        "  webhook: HOOK_URL",
        "  webhook_key: HOOK_KEY",
        "  relay: terragucci",
        "  relay_key: RELAY_KEY",
        "",
      ].join("\n"),
    });
    quiet();
    const onMain = (await wavesSpecAt(dir, { at: "HEAD", env: { GITHUB_REF_NAME: "main" } }))!;
    expect(onMain.waves[0]!.approval).toBe("pr-review");
    expect(onMain.branches).toEqual(["release"]);
    expect(onMain.resume).toEqual({ schedule: "*/15 * * * *" });
    expect(onMain.notify).toEqual({ slack: "SLACK_URL", webhook: "HOOK_URL", key: "HOOK_KEY", relay: "RELAY_KEY", relayName: "terragucci" });
    expect(onMain.approvals).toMatchObject({ spend: true, reviewLedger: "tf-apply", involved: { exclude: true } });
    // The default branch applies what no glob routes elsewhere; release applies its own.
    expect(onMain.waves[0]!.runs.map((r) => r.target)).toEqual(["envs/dev/app"]);
    const onRelease = (await wavesSpecAt(dir, { at: "HEAD", env: { GITHUB_REF_NAME: "release" } }))!;
    expect(onRelease.waves[0]!.runs.map((r) => r.target)).toEqual(["envs/prod/app"]);
  });

  it("asks the decision point under apply.point, and refuses one beside another approval mode", async () => {
    const dir = repo({ [WAVES_SPEC]: shape([["a"]]), "terragucci.yml": "apply:\n  point: change-board\n" });
    quiet();
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(spec.point).toEqual({ name: "change-board", store: "ledger", timeout: "48h" });
    expect(spec.approvals).toEqual({ spend: true });
    commit(dir, { "terragucci.yml": "approval: pr-review\napply:\n  point: change-board\n" });
    await expect(wavesSpecAt(dir, { at: "HEAD", env: {} })).rejects.toThrow(/could not be read .*apply\.point is set/s);
  });

  it("prints nothing at a commit with no committed spec, and fails at one the checkout does not have", async () => {
    const dir = repo({ "terragucci.yml": "gate: always\n" });
    quiet();
    const out: string[] = [];
    expect(await printWavesSpec(dir, { env: { CHANT_WAVES_SPEC_AT: "HEAD" }, out: (t) => void out.push(t) })).toBe(0);
    expect(out).toEqual([]);
    await expect(wavesSpecAt(dir, { at: "0123456789abcdef0123456789abcdef01234567", env: {} })).rejects.toThrow(/does not have/);
  });

  it("prints the spec at CHANT_WAVES_SPEC_AT, from the file CHANT_WAVES_SPEC_FILE names", async () => {
    const dir = repo({ "ops/spec.json": shape([["a"]], "always"), "terragucci.yml": "gate: never\n" });
    const first = git(dir, "rev-parse", "HEAD").trim();
    commit(dir, { "ops/spec.json": shape([["a"], ["b"]], "never") });
    quiet();
    const out: string[] = [];
    await printWavesSpec(dir, { env: { CHANT_WAVES_SPEC_AT: first, CHANT_WAVES_SPEC_FILE: "ops/spec.json" }, out: (t) => void out.push(t) });
    const spec = JSON.parse(out.join("")) as OpWavesSpec;
    expect(spec.waves.map((w) => [w.gate, w.runs.map((r) => r.target)])).toEqual([["always", ["a"]]]);
  });
});

describe("terragucci run wave: the line", () => {
  it("reads chant's flags in either form", () => {
    expect(flagValue(["--wave", "2", "--spec=s.json"], "--wave")).toBe("2");
    expect(flagValue(["--wave", "2", "--spec=s.json"], "--spec")).toBe("s.json");
    expect(flagValue(["--wave"], "--phase")).toBeUndefined();
  });

  it("passes the lines that run no wave job to chant with no hook", async () => {
    const seen: { argv: string[]; hook: ProductWaveHook | undefined }[] = [];
    const chant = async (argv: string[], hook: ProductWaveHook | undefined) => (seen.push({ argv, hook }), 0);
    const lines = [
      ["--op", "tf-apply", "--wave", "2", "--of", "2", "--apply-status", "terragucci/apply", "--at", "abc", "--forge", "github"],
      ["--op", "tf-apply", "--wave", "2", "--merge", "auto", "--forge", "github"],
      ["--spec", WAVES_SPEC, "--waves-outcome"],
      ["--spec", WAVES_SPEC, "--wave", "1", "--base", "HEAD^1", "--render-spec", "--phase", "record"],
    ];
    const dir = repo({ [WAVES_SPEC]: shape([["a"]]) });
    for (const argv of lines) expect(await runWave(dir, argv, { chant })).toBe(0);
    expect(seen.map((s) => s.argv)).toEqual(lines);
    expect(seen.every((s) => s.hook === undefined)).toBe(true);
  });

  it("hands a wave job chant's line as it is, with terragucci's hook, on the spec rendered at base", async () => {
    const dir = repo({ [WAVES_SPEC]: shape([["a"]]), "terragucci.yml": "gate: always\n" });
    commit(dir, { "terragucci.yml": "gate: never\n" });
    quiet();
    let got: { argv: string[]; hook?: ProductWaveHook } | undefined;
    const argv = ["--spec", WAVES_SPEC, "--wave", "1", "--base", "HEAD^1", "--render-spec", "--phase", "gate"];
    const code = await runWave(dir, argv, { env: {}, chant: async (a, hook) => ((got = { argv: a, ...(hook ? { hook } : {}) }), 3) });
    expect(code).toBe(3);
    expect(got!.argv).toEqual(argv);
    expect(Object.keys(got!.hook!.hooks ?? {}).sort()).toEqual(["migration gate", "migrations", "report"]);
    expect(got!.hook!.capabilities).toBeDefined();
    expect(got!.hook!.afterPlan).toBeDefined();
  });
});

describe("terragucci run wave: a wave on chant's step", () => {
  /** A repo on chant's step whose tofu is the step's fake, on PATH, with the spec committed and written as the job renders it. */
  async function onStep(gate: "always" | "never" = "never") {
    const s = setup({ [CHANT_CONFIG]: chantConfigText(["a"], "tofu"), [WAVES_SPEC]: shape([["a"]], gate), "terragucci.yml": `binary: tofu\ngate: ${gate}\n` });
    writeFileSync(s.bin, STEP_FAKE);
    vi.stubEnv("PATH", `${dirname(s.bin)}:${process.env.PATH}`);
    const head = commit(s.work, { "a/main.tf": "# a\n" });
    git(s.work, "push", "-q", "origin", "main");
    // chant reads the spec file at --spec; --render-spec would have it write the one terragucci waves-spec prints at base.
    const spec = (await wavesSpecAt(s.work, { at: "HEAD^1", env: {} }))!;
    writeFileSync(join(s.work, WAVES_SPEC), wavesSpecText(spec));
    // chant's run wave runs in the job's directory, as the bin does.
    process.chdir(s.work);
    return { ...s, head };
  }
  const was = process.cwd();
  afterEach(() => process.chdir(was));
  const line = (phase?: string): string[] => ["--spec", WAVES_SPEC, "--wave", "1", "--base", "HEAD^1", ...(phase ? ["--phase", phase] : [])];
  const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")) as { roots: { path: string; applied_changes?: unknown[] }[]; waves: { state?: string; set_digest?: string; approval?: string }[] };
  /** Each root of the report, and whether it names the changes its apply made. */
  const appliedRoots = (work: string) => report(work).roots.map((x) => [x.path, x.applied_changes !== undefined]);

  it("plans, gates and applies in one job, with the hooks served in this process", async () => {
    const { work, log } = await onStep();
    const lines = quiet();
    expect(await runWave(work, line(), { env: { ...process.env } })).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("applied a");
    expect(lines).toContain("a: Plan: 1 to add, 0 to change, 0 to destroy.");
    // No hook called back over a socket: nothing wrote the client.
    expect(existsSync(join(work, WAVE_CLIENT))).toBe(false);
    expect(appliedRoots(work)).toEqual([["a", true]]);
    expect(report(work).waves[0]).toMatchObject({ state: "applied", approval: "not-required", set_digest: expect.stringContaining("sha256:") });
  });

  it("runs each job of a split wave: the plan job reports its plans, the applying job what applied", async () => {
    const { work, log } = await onStep();
    quiet();
    const env = { ...process.env };
    expect(await runWave(work, line("plan"), { env })).toBe(0);
    expect(existsSync(log) ? readFileSync(log, "utf-8") : "").not.toContain("applied a");
    expect(appliedRoots(work)).toEqual([["a", false]]);
    expect(report(work).waves[0]!.state).toBe("applying");
    expect(await runWave(work, line("gate"), { env })).toBe(0);
    // The gate job writes no report of its own.
    expect(report(work).waves[0]!.state).toBe("applying");
    expect(await runWave(work, line("apply"), { env })).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("applied a");
    // The applying job's report: its plans as chant handed them to apply, what applied, and the gate from chant's decision file.
    expect(appliedRoots(work)).toEqual([["a", true]]);
    expect(report(work).waves[0]).toMatchObject({ state: "applied", approval: "not-required", set_digest: expect.stringContaining("sha256:") });
    expect(await runWave(work, line("record"), { env })).toBe(0);
  });

  it("waits at a gate that needs an approval, in the gate job, and says how to approve", async () => {
    const { work, log } = await onStep("always");
    const lines = quiet();
    const env = { ...process.env };
    expect(await runWave(work, line("plan"), { env })).toBe(0);
    expect(await runWave(work, line("gate"), { env })).toBe(3);
    expect(lines.some((l) => l.includes("waits for an approval of digest"))).toBe(true);
    expect(lines.some((l) => l.includes("terragucci approve"))).toBe(true);
    expect(existsSync(log) ? readFileSync(log, "utf-8") : "").not.toContain("applied a");
  });
});
