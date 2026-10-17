// On Forgejo every step of a job holds the run's token, so the jobs that run the change's code end with the step
// that runs it: the report goes on as the job's outputs, and a job in a fresh container keeps it and posts.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { renderPipeline, type PipelineInput } from "../src/render";
import { forgejoCheckoutScript, HANDOVER_CHUNK, HANDOVER_KEYS, HANDOVER_PARTS, handoverTrap, packJs, takeOverScript, UNPACK_JS } from "../src/forgejo-handover";
import { bareFrom, git, tmp, write } from "./helpers";

const layers = [["network"], ["app", "cache"]];
const OIDC = { plan_role: "arn:aws:iam::1:role/plan", apply_role: "arn:aws:iam::1:role/apply" };
const TG = { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }] };
const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const render = (forge: "github" | "forgejo", extra: Partial<PipelineInput> = {}): Record<string, any> =>
  body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ...extra } as PipelineInput).content);
type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const runsCode = (s: Step): boolean => typeof s.run === "string" && /terragucci stage tf-plan|check-root|terragrunt hcl validate/.test(s.run);

/** The outputs a step's GITHUB_OUTPUT file sets, as the runner reads them: key=value, one a line. */
const outputsOf = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

/** Pack `dir` as the step does; returns the outputs. */
const pack = (dir: string): { outputs: Record<string, string>; stderr: string } => {
  const out = join(tmp(), "output");
  writeFileSync(out, "");
  const r = spawnSync(process.execPath, ["-e", packJs(), dir, out], { encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
  return { outputs: outputsOf(out), stderr: r.stderr };
};

/** The take-over step's script with the runner's interpolation done: each output as toJSON writes it. */
const takeOver = (job: string, dir: string, outputs: Record<string, string>, cwd: string): { status: number | null; stdout: string; stderr: string } => {
  const script = takeOverScript(job, dir).replace(/\$\{\{ toJSON\(needs\.[a-z-]+\.outputs\.(report_\d+)\) \}\}/g, (_, k: string) => JSON.stringify(outputs[k] ?? ""));
  const file = join(tmp(), "take.sh");
  writeFileSync(file, script);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", file], { cwd, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("Forgejo: the jobs that run the change's code end with the step that runs it", () => {
  const cases: [string, Partial<PipelineInput>][] = [
    ["plain roots", {}],
    ["oidc", { oidc: OIDC }],
    ["terragrunt", { layers: [["live/dev/app"]], terragrunt: TG, oidc: OIDC } as never],
  ];

  it.each(cases)("%s: check, plan and replan have no step after the code's, and no action whose post step runs at the end", (_, extra) => {
    const doc = render("forgejo", extra);
    for (const name of ["check", "plan", "replan"]) {
      const steps = doc.jobs[name].steps as Step[];
      const code = steps.findIndex(runsCode);
      expect(code, name).toBeGreaterThan(0);
      expect(code, name).toBe(steps.length - 1);
      // A checkout or cache save would run its post step at the job's end; the cache is restored only.
      for (const s of steps) expect(String(s.uses ?? ""), name).not.toMatch(/actions\/(checkout|upload-artifact|cache@)/);
      expect(steps[code].id, name).toBe(name === "check" ? "check" : "plan");
      for (const k of HANDOVER_KEYS) expect(doc.jobs[name].outputs[k], name).toBe(`\${{ steps.${steps[code].id}.outputs.${k} }}`);
      expect(steps[code].run, name).toContain("trap ");
      expect(steps[code].run, name).toContain("tg_handover");
    }
  });

  it("the re-plan's step sweeps what the code left running before it hands the report on", () => {
    const run = (render("forgejo").jobs.replan.steps as Step[]).find(runsCode)!.run!;
    expect(run).toContain("trap 'tg_sweep; tg_handover' EXIT");
    expect(run.indexOf("trap 'tg_sweep; tg_handover' EXIT")).toBeGreaterThan(run.indexOf("trap tg_sweep EXIT"));
  });

  it("the note jobs and check-report take the report as data, keep it as the artifact it was, and post as before", () => {
    const doc = render("forgejo");
    for (const [job, needs, artifact] of [["plan-note", "plan", "terragucci-report"], ["replan-note", "replan", "terragucci-report-replan"], ["check-report", "check", "terragucci-check"]] as const) {
      const steps = doc.jobs[job].steps as Step[];
      expect(doc.jobs[job].needs, job).toBe(needs);
      expect(doc.jobs[job].if, job).toContain(`needs.${needs}.result == 'success' || needs.${needs}.result == 'failure'`);
      for (const k of HANDOVER_KEYS) expect(steps[0].run, job).toContain(`\${{ toJSON(needs.${needs}.outputs.${k}) }}`);
      // Each output is one line of a quoted heredoc; no JSON string is the line that ends it.
      expect(steps[0].run, job).toContain("<<'END_OF_REPORT'");
      const keep = steps.find((s) => s.name?.startsWith("Keep the"))!;
      expect(keep.uses, job).toMatch(/upload-artifact@v3$/);
      expect(keep.with, job).toMatchObject({ name: artifact, "if-no-files-found": "ignore" });
      expect(keep.if, job).toBe("always()");
      expect(JSON.stringify(steps), job).not.toMatch(/checkout|download-artifact/);
    }
    expect(doc.jobs["plan-note"].steps.at(-1).run).toContain("terragucci plan-note --forge forgejo --report terragucci-report");
    expect(doc.jobs["plan-note"].steps.at(-1).if).toBe("always()");
  });

  it("github keeps its jobs as they were: the checkout action, the upload in the job, and no check-report job", () => {
    const doc = render("github");
    expect(doc.jobs["check-report"]).toBeUndefined();
    for (const name of ["check", "plan", "replan"]) {
      const steps = doc.jobs[name].steps as Step[];
      expect(steps.some((s) => s.uses === "actions/checkout@v4"), name).toBe(true);
      expect(steps.at(-1)!.uses, name).toBe("actions/upload-artifact@v4");
      expect(JSON.stringify(steps), name).not.toContain("tg_handover");
    }
    expect((doc.jobs["plan-note"].steps as Step[])[0].uses).toBe("actions/download-artifact@v4");
  });
});

describe("the report's hand-over", () => {
  it("carries every regular file, nested ones too, and no link", () => {
    const dir = write(tmp(), { "terragucci-report/report.json": '{"roots":[]}', "terragucci-report/plan-note.md": "the note\n", "terragucci-report/plans/envs/dev/app.json": "{}", "terragucci-report/empty.txt": "" });
    const outside = write(tmp(), { "secret.txt": "not the report's" });
    symlinkSync(join(outside, "secret.txt"), join(dir, "terragucci-report", "link.txt"));
    const { outputs } = pack(join(dir, "terragucci-report"));
    expect(Object.keys(outputs)).toEqual(["report_0"]);
    const to = tmp();
    const r = takeOver("plan", "terragucci-report", outputs, to);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("took 4 report files");
    expect(readFileSync(join(to, "terragucci-report", "report.json"), "utf-8")).toBe('{"roots":[]}');
    expect(readFileSync(join(to, "terragucci-report", "plan-note.md"), "utf-8")).toBe("the note\n");
    expect(readFileSync(join(to, "terragucci-report", "plans", "envs", "dev", "app.json"), "utf-8")).toBe("{}");
    expect(readFileSync(join(to, "terragucci-report", "empty.txt"), "utf-8")).toBe("");
    expect(existsSync(join(to, "terragucci-report", "link.txt"))).toBe(false);
  });

  it("a missing directory hands on an empty set, and the job after it writes nothing", () => {
    const { outputs } = pack(join(tmp(), "terragucci-report"));
    const to = tmp();
    const r = takeOver("plan", "terragucci-report", outputs, to);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(to, "terragucci-report"))).toBe(false);
  });

  it("no outputs at all (the job stopped before its step) leaves nothing and exits 0, so the post still runs", () => {
    const to = tmp();
    const r = takeOver("plan", "terragucci-report", {}, to);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("handed on no report");
  });

  it("writes nothing outside the directory, whatever paths the change's outputs name", () => {
    const files = { "../escaped.txt": "x", "/abs.txt": "x", "a/../../b.txt": "x", "a\\b.txt": "x", "./dot.txt": "x", "a//b.txt": "x", "ok/kept.txt": Buffer.from("kept").toString("base64") };
    const forged = gzipSync(JSON.stringify({ ...files, "ok/kept.txt": Buffer.from("kept").toString("base64") })).toString("base64");
    const root = tmp();
    const to = join(root, "work");
    mkdirSync(to);
    const r = takeOver("plan", "terragucci-report", { report_0: forged }, to);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(to, "terragucci-report", "ok", "kept.txt"), "utf-8")).toBe("kept");
    expect(existsSync(join(to, "escaped.txt"))).toBe(false);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(existsSync("/abs.txt")).toBe(false);
    expect(r.stdout).toContain('left out "../escaped.txt"');
    expect(r.stdout).toContain("took 1 report files");
  });

  it("outputs that do not read are reported and leave nothing", () => {
    const to = tmp();
    const r = takeOver("plan", "terragucci-report", { report_0: "not base64 gzip" }, to);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("does not read");
    expect(existsSync(join(to, "terragucci-report"))).toBe(false);
  });

  it("a report too large to hand on whole is cut to the files the note job reads", () => {
    const dir = write(tmp(), { "plan-note.md": "the note\n", "plan-status.txt": "success 1 roots\n", "report.json": "{}" });
    // Random bytes do not compress: more than every part holds.
    writeFileSync(join(dir, "report.html"), randomBytes(Math.ceil((HANDOVER_CHUNK * HANDOVER_PARTS) / 1.3)).toString("base64"));
    const { outputs, stderr } = pack(dir);
    expect(stderr).toContain("too large to hand to the next job whole");
    expect(Object.keys(outputs).length).toBeLessThanOrEqual(HANDOVER_PARTS);
    for (const v of Object.values(outputs)) expect(v.length).toBeLessThanOrEqual(HANDOVER_CHUNK);
    const to = tmp();
    expect(takeOver("plan", "terragucci-report", outputs, to).status).toBe(0);
    expect(readFileSync(join(to, "terragucci-report", "plan-note.md"), "utf-8")).toBe("the note\n");
    expect(readFileSync(join(to, "terragucci-report", "plan-status.txt"), "utf-8")).toBe("success 1 roots\n");
    expect(existsSync(join(to, "terragucci-report", "report.html"))).toBe(false);
  });

  it("a report that needs several parts comes back whole", () => {
    const dir = write(tmp(), { "plan-note.md": "n" });
    const big = randomBytes(Math.ceil(HANDOVER_CHUNK * 1.5 * 0.7)).toString("base64");
    writeFileSync(join(dir, "report.html"), big);
    const { outputs } = pack(dir);
    expect(Object.keys(outputs).length).toBeGreaterThan(1);
    const to = tmp();
    expect(takeOver("plan", "terragucci-report", outputs, to).status).toBe(0);
    expect(readFileSync(join(to, "terragucci-report", "report.html"), "utf-8")).toBe(big);
  });

  it.each([["bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"]], ["sh", ["-e"]]] as const)("%s: the trap hands the report on however the step ends, and keeps its exit status", (shell, flags) => {
    const work = tmp();
    const out = join(work, "output");
    writeFileSync(out, "");
    const script = join(work, "step.sh");
    writeFileSync(script, [...handoverTrap("terragucci-report"), "mkdir -p terragucci-report", "echo failed > terragucci-report/plan-status.txt", "false", "echo not reached"].join("\n"));
    const r = spawnSync(shell, [...flags, script], { cwd: work, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out }, encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("not reached");
    const to = tmp();
    expect(takeOver("plan", "terragucci-report", outputsOf(out), to).status).toBe(0);
    expect(readFileSync(join(to, "terragucci-report", "plan-status.txt"), "utf-8")).toBe("failed\n");
  });
});

describe("the Forgejo checkout script", () => {
  /** A bare repo with main and a branch `feat` one commit ahead, and the pull request ref the forge keeps. */
  const repo = (): { bare: string; main: string; feat: string } => {
    const src = write(tmp(), { "a.txt": "a\n" });
    const bare = bareFrom(src);
    const main = git(src, "rev-parse", "HEAD").trim();
    git(src, "checkout", "-q", "-b", "feat");
    writeFileSync(join(src, "b.txt"), "b\n");
    git(src, "add", "-A");
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat");
    git(src, "push", "-q", bare, "feat");
    const feat = git(src, "rev-parse", "HEAD").trim();
    git(bare, "update-ref", "refs/pull/7/head", feat);
    return { bare, main, feat };
  };
  const checkout = (history: boolean, bare: string, env: Record<string, string>, cwd = tmp()): { cwd: string; status: number | null; stderr: string } => {
    const script = join(tmp(), "checkout.sh");
    writeFileSync(script, forgejoCheckoutScript(history));
    const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: tmp(), GITHUB_SERVER_URL: `file://${dirname(bare)}`, GITHUB_REPOSITORY: basename(bare), ...env },
      encoding: "utf-8",
    });
    return { cwd, status: r.status, stderr: r.stderr };
  };

  it("checks out a push's commit on its branch, shallow, and keeps no token in the git config", () => {
    const { bare, feat } = repo();
    const r = checkout(false, bare, { GITHUB_REF: "refs/heads/feat", GITHUB_SHA: feat, TG_TOKEN: "the-run-token" });
    expect(r.status, r.stderr).toBe(0);
    expect(git(r.cwd, "rev-parse", "HEAD").trim()).toBe(feat);
    expect(git(r.cwd, "branch", "--show-current").trim()).toBe("feat");
    expect(git(r.cwd, "rev-parse", "--is-shallow-repository").trim()).toBe("true");
    expect(readFileSync(join(r.cwd, ".git", "config"), "utf-8")).not.toMatch(/the-run-token|extraheader/i);
  });

  it("with the history, every branch comes too, for the plan's range", () => {
    const { bare, main, feat } = repo();
    const r = checkout(true, bare, { GITHUB_REF: "refs/pull/7/head", GITHUB_SHA: feat });
    expect(r.status, r.stderr).toBe(0);
    expect(git(r.cwd, "rev-parse", "HEAD").trim()).toBe(feat);
    expect(git(r.cwd, "rev-parse", "origin/main").trim()).toBe(main);
    expect(git(r.cwd, "rev-parse", "--is-shallow-repository").trim()).toBe("false");
  });

  it("a re-plan checks out the head by its ref over the default branch's checkout, which it cleans first", () => {
    const { bare, main, feat } = repo();
    const first = checkout(false, bare, { GITHUB_REF: "refs/heads/main", GITHUB_SHA: main });
    expect(first.status, first.stderr).toBe(0);
    writeFileSync(join(first.cwd, "left.json"), "{}");
    const r = checkout(true, bare, { GITHUB_REF: "refs/heads/main", GITHUB_SHA: main, TG_REF: "refs/pull/7/head" }, first.cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(git(r.cwd, "rev-parse", "HEAD").trim()).toBe(feat);
    expect(git(r.cwd, "rev-parse", "origin/main").trim()).toBe(main);
    expect(existsSync(join(r.cwd, "left.json"))).toBe(false);
  });
});
