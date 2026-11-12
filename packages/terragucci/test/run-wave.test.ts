// terragucci issue 1411: `terragucci waves-spec`, the tf-apply spec chant's renderSpec runs, and `terragucci run wave`,
// chant's wave runner in terragucci's process with its hooks, in the one-job shape and in each job of a split wave.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpWavesSpec, ProductWaveHook } from "@intentius/chant/op";
import { CHANT_CONFIG, chantConfigText } from "../src/chant-config";
import { WAVE_CLIENT, WAVES_APPROVALS, waveCallArgv, WAVES_SPEC, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { applyWave, parseLedger } from "../src/apply";
import { composeTarget } from "../src/compose";
import { flagValue, runWave } from "../src/run-wave";
import { printWavesSpec, wavesSpecAt, wavesSpecReach } from "../src/waves-spec";
import { git, tmp, write } from "./helpers";
import { setup, STEP_FAKE, T } from "./apply-helpers";

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
    // chant's spend rules (chant issue 5047), with who counts at the gate.
    expect(onMain.approvals).toMatchObject({ spend: true, remainder: true, spendStanding: true, reviewLedger: "tf-apply", involved: { exclude: true } });
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
    expect(spec.approvals).toEqual(WAVES_APPROVALS);
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

describe("terragucci waves-spec at the applied commit, with CHANT_WAVES_SPEC_BASE (chant issue 5046)", () => {
  const live = (estate: string, body = ""): string => `terraform {\n  live {\n    estate = "${estate}"\n    record_store "s3" {\n      bucket = "records"\n    }\n  }\n}\n${body}`;
  const runs = (spec: OpWavesSpec) => spec.waves.map((w) => w.runs.map((r) => r.target));

  it("runs the roots the change reaches as one composed run under waves.compose, and renders as before without the base", async () => {
    // network in wave 1, app reads it in wave 2, edge reads app in wave 3: all choudoufu estates.
    const dir = repo({
      [WAVES_SPEC]: shape([["network"], ["app"], ["edge"]]),
      "terragucci.yml": "binary: choudoufu\nwaves:\n  compose: true\n",
      "network/main.tf": live("net", `output "subnet_id" {\n  value = "s-1"\n}\n`),
      "app/main.tf": live("app", `data "terraform_estate_outputs" "net" {\n  estate = "net"\n  names  = ["subnet_id"]\n}\noutput "x" {\n  value = data.terraform_estate_outputs.net.values.subnet_id\n}\n`),
      "edge/main.tf": live("edge", `data "terraform_estate_outputs" "app" {\n  estate = "app"\n  names  = ["x"]\n}\n`),
    });
    const base = git(dir, "rev-parse", "HEAD").trim();
    commit(dir, { "app/main.tf": live("app", `data "terraform_estate_outputs" "net" {\n  estate = "net"\n  names  = ["subnet_id"]\n}\noutput "x" {\n  value = "changed"\n}\n`), "edge/main.tf": live("edge", "# changed\n") });
    quiet();
    const plain = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(runs(plain)).toEqual([["network"], ["app"], ["edge"]]);
    expect(plain.waves.some((w) => (w as { together?: boolean }).together)).toBe(false);
    const reach = (await wavesSpecReach(dir, { at: "HEAD", base, env: {} }))!;
    expect(reach.composition?.wave).toBe(1);
    // The composed wave lists the run's roots in the run's order, and plans them together; the waves it emptied keep the run's target.
    expect([...reach.composition!.order].sort()).toEqual(["app", "edge", "network"]);
    expect(runs(reach.spec)).toEqual([reach.composition!.order, [composeTarget(1)], [composeTarget(1)]]);
    expect(reach.spec.waves.map((w) => (w as { together?: boolean }).together === true)).toEqual([true, false, false]);
    expect([...reach.nothing.keys()]).toEqual([2, 3]);
    // printWavesSpec reads the base from chant's variable, and its stdout is the spec alone.
    const out: string[] = [];
    await printWavesSpec(dir, { env: { CHANT_WAVES_SPEC_AT: "HEAD", CHANT_WAVES_SPEC_BASE: base }, out: (t) => void out.push(t) });
    expect(runs(JSON.parse(out.join("")) as OpWavesSpec)).toEqual(runs(reach.spec));
  });

  it("leaves out of its wave a root a pending estate migration plans, with the member that stands for it", async () => {
    const dir = repo({
      [WAVES_SPEC]: shape([["app", "web"], ["db"]]),
      "terragucci.yml": "binary: choudoufu\n",
      "app/main.tf": live("app", 'resource "aws_sqs_queue" "a" {}\n'),
      "web/main.tf": live("web", 'resource "aws_sqs_queue" "w" {}\n'),
      "db/main.tf": live("db", 'resource "aws_sqs_queue" "d" {}\n'),
    });
    const base = git(dir, "rev-parse", "HEAD").trim();
    commit(dir, { "migrations/adopt.yml": "backends:\n  - root: app\n    from:\n      backend: local\n      config:\n        path: old.tfstate\n  - root: db\n    from:\n      backend: local\n      config:\n        path: old.tfstate\n" });
    quiet();
    expect(runs((await wavesSpecAt(dir, { at: "HEAD", env: {} }))!)).toEqual([["app", "web"], ["db"]]);
    const reach = (await wavesSpecReach(dir, { at: "HEAD", base, env: {} }))!;
    expect(runs(reach.spec)).toEqual([["web"], ["db"]]);
    expect(reach.migrationMembers.get(1)?.map((m) => m.member)).toEqual(["app"]);
    expect(reach.migrationMembers.get(1)?.[0]!.planDigest).toMatch(/^sha256:|^[0-9a-f]{64}$/);
    // Wave 2 has no root of its own left: it keeps its root, since a spec refuses a wave with no runs, and its job applies nothing.
    expect(reach.nothing.get(2)).toBe("every root in it is planned by its estate migration");
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

  it("with CHANT_WAVES_SPEC_RUNS=head renders the job's spec at HEAD with the base, and a wave a migration empties applies nothing", async () => {
    const live = (estate: string): string => `terraform {\n  live {\n    estate = "${estate}"\n  }\n}\n`;
    const dir = repo({ [WAVES_SPEC]: shape([["web"], ["db"]]), "terragucci.yml": "binary: choudoufu\n", "web/main.tf": live("web"), "db/main.tf": live("db") });
    commit(dir, { "migrations/adopt.yml": "backends:\n  - root: db\n    from:\n      backend: local\n      config:\n        path: old.tfstate\n" });
    const lines = quiet();
    const seen: number[] = [];
    const chant = async () => (seen.push(1), 0);
    const env = { CHANT_WAVES_SPEC_RUNS: "head" };
    // Wave 2's one root is the migration's: its job applies nothing, and chant never runs a wave for it.
    expect(await runWave(dir, ["--spec", WAVES_SPEC, "--wave", "2", "--base", "HEAD^1", "--render-spec"], { env, chant })).toBe(0);
    expect(seen).toEqual([]);
    expect(lines).toContain("wave 2: every root in it is planned by its estate migration, so it has nothing to apply");
    // Wave 1 is the change's own: chant runs it with terragucci's hook. Rendered at base, without the variable, wave 2 runs as before.
    expect(await runWave(dir, ["--spec", WAVES_SPEC, "--wave", "1", "--base", "HEAD^1", "--render-spec"], { env, chant })).toBe(0);
    expect(seen).toEqual([1]);
    expect(await runWave(dir, ["--spec", WAVES_SPEC, "--wave", "2", "--base", "HEAD^1", "--render-spec"], { env: {}, chant })).toBe(0);
    expect(seen).toEqual([1, 1]);
  });
});

describe("stage tf-apply's hooks, served in its own process", () => {
  it("runs the gate's report in process through chant's inProcessHooks, with no socket or client file", async () => {
    const { work, origin, log } = setup();
    const lines = quiet();
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: join(dirname(log), "tofu"), gate: "always", env: {}, now: T(1) })).toBe(3);
    // The report hook ran in this process: it printed how to approve, and the pending fact stands.
    expect(lines.some((l) => l.includes("terragucci approve"))).toBe(true);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending).toHaveLength(1);
    expect(existsSync(join(work, WAVE_CLIENT))).toBe(false);
    expect(existsSync(join(work, ".chant/op-waves/tf-apply/terragucci-socket"))).toBe(false);
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
