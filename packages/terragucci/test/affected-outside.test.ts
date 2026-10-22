// Changes outside every root's directory that still change what a root plans:
// var files, symlinks, terragucci.yml settings and the synth command.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { argWords, envVarFiles, outsideWatch, planSettings, settingsChanged, symlinkTargets } from "../src/affected";
import { resolveRepo, validateConfig } from "../src/config";
import { parseYAML } from "@intentius/chant/yaml";
import { affectedRoots, runStage } from "../src/report/stage";
import { backend, tmp, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

const ROOTS = ["envs/dev/app", "envs/prod/app", "envs/prod/db"];

const settingsOf = (yaml: string) => resolveRepo(validateConfig(parseYAML(yaml), "terragucci.yml"));

/** A repo with the three roots committed on main, and `commit` to add a change on top. */
function repo(extra: Record<string, string> = {}): { dir: string; commit: (files: Record<string, string>) => void } {
  const dir = write(tmp(), { ...Object.fromEntries(ROOTS.map((r) => [`${r}/main.tf`, backend(`${r}.tfstate`)])), ...extra });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  return {
    dir,
    commit: (files) => {
      write(dir, files);
      git("add", "-A");
      git("commit", "-qm", "change");
    },
  };
}

describe("var files from TF_CLI_ARGS", () => {
  it("reads each -var-file in TF_CLI_ARGS and TF_CLI_ARGS_plan, in either spelling, quoted or not", () => {
    expect(argWords(`-var-file="../a b.tfvars" -lock=false 'x y'`)).toEqual(["-var-file=../a b.tfvars", "-lock=false", "x y"]);
    expect(envVarFiles({ TF_CLI_ARGS: "-var-file=../shared.tfvars", TF_CLI_ARGS_plan: "-lock-timeout=3s --var-file ../../common.tfvars -var-file=/abs.tfvars -var-file=$HOME/x" })).toEqual(["../shared.tfvars", "../../common.tfvars"]);
    expect(envVarFiles({ TF_CLI_ARGS_apply: "-var-file=../shared.tfvars" })).toEqual([]);
  });

  it("a change to a shared var file plans the roots that read it, and no others", () => {
    const { dir, commit } = repo({ "envs/prod/shared.tfvars": "size = 1\n", "envs/dev/shared.tfvars": "size = 1\n" });
    commit({ "envs/prod/shared.tfvars": "size = 2\n" });
    const watch = outsideWatch(dir, ROOTS, { TF_CLI_ARGS_plan: "-var-file=../shared.tfvars" });
    const lines: string[] = [];
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, (l) => lines.push(l), undefined, { watch })!].sort()).toEqual(["envs/prod/app", "envs/prod/db"]);
    expect(lines).toContain("affected: envs/prod/app reads envs/prod/shared.tfvars, which changed");
    // Without the variable nothing reads the file, and the change plans nothing, as before.
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, () => {}, undefined, { watch: outsideWatch(dir, ROOTS, {}) })!]).toEqual([]);
  });
});

describe("symlinks under a root", () => {
  it("watches what a link points at outside the root, and leaves out links inside it or out of the repo", () => {
    const { dir } = repo({ "shared/.terraform.lock.hcl": "lock\n", "shared/providers/aws.tf": "", "envs/prod/app/local.tf": "" });
    symlinkSync("../../../shared/.terraform.lock.hcl", join(dir, "envs/prod/app/.terraform.lock.hcl"));
    symlinkSync("../../../shared/providers", join(dir, "envs/prod/app/providers"));
    symlinkSync("local.tf", join(dir, "envs/prod/app/again.tf"));
    symlinkSync("/etc/hosts", join(dir, "envs/prod/app/hosts"));
    mkdirSync(join(dir, "envs/prod/app/.terraform"), { recursive: true });
    symlinkSync("../../../../shared/providers/aws.tf", join(dir, "envs/prod/app/.terraform/cached.tf"));
    expect(symlinkTargets(dir, "envs/prod/app")).toEqual(["../../../shared/.terraform.lock.hcl", "../../../shared/providers"]);
    expect(symlinkTargets(dir, "envs/dev/app")).toEqual([]);
    expect(symlinkTargets(dir, ".")).toEqual([]);
  });

  it("a change to a lock file or provider config shared by symlink plans the roots that link it", () => {
    const { dir, commit } = repo({ "shared/.terraform.lock.hcl": "lock 1\n", "shared/providers/aws.tf": "# 1\n" });
    symlinkSync("../../../shared/.terraform.lock.hcl", join(dir, "envs/prod/app/.terraform.lock.hcl"));
    symlinkSync("../../../shared/providers", join(dir, "envs/dev/app/providers"));
    commit({});
    commit({ "shared/.terraform.lock.hcl": "lock 2\n" });
    const watch = outsideWatch(dir, ROOTS, {});
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, () => {}, undefined, { watch })!]).toEqual(["envs/prod/app"]);
    commit({ "shared/providers/aws.tf": "# 2\n" });
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, () => {}, undefined, { watch })!]).toEqual(["envs/dev/app"]);
  });
});

describe("terragucci.yml settings that change a plan", () => {
  const base = settingsOf('binary: tofu\nversion:\n  "envs/prod/**": 1.8.0\n  "**": 1.7.0\n');

  it("selects the roots a version glob reaches, and no other", () => {
    const head = settingsOf('binary: tofu\nversion:\n  "envs/prod/**": 1.8.1\n  "**": 1.7.0\n');
    expect(Object.fromEntries(settingsChanged(base, head, ROOTS))).toEqual({ "envs/prod/app": ["version"], "envs/prod/db": ["version"] });
  });

  it("selects the roots generate, an oidc role by glob, pass or env changes for", () => {
    expect([...settingsChanged(base, settingsOf(`${'binary: tofu\nversion:\n  "envs/prod/**": 1.8.0\n  "**": 1.7.0\n'}generate:\n  dirs:\n    "envs/dev/*":\n      required_version: ">= 1.7"\n`), ROOTS)]).toEqual([["envs/dev/app", ["generate"]]]);
    const roles = (db: string) => settingsOf(`oidc:\n  plan_role: arn:aws:iam::1:role/plan\n  apply_role: arn:aws:iam::1:role/apply\n  roles:\n    "envs/prod/db":\n      plan: ${db}\n      apply: arn:aws:iam::2:role/apply\n`);
    expect([...settingsChanged(roles("arn:aws:iam::2:role/plan"), roles("arn:aws:iam::3:role/plan"), ROOTS).keys()]).toEqual(["envs/prod/db"]);
    expect([...settingsChanged(settingsOf("{}"), settingsOf("pass:\n  secrets: [TF_VAR_pw]\n"), ROOTS).keys()]).toEqual(ROOTS);
    expect(Object.fromEntries(settingsChanged(settingsOf("{}"), settingsOf("env:\n  TF_LOG: info\n"), ROOTS))).toEqual(Object.fromEntries(ROOTS.map((r) => [r, ["env"]])));
  });

  it("selects nothing for policy, approval or gate, which are read at the base", () => {
    const head = settingsOf('binary: tofu\nversion:\n  "envs/prod/**": 1.8.0\n  "**": 1.7.0\napproval: pr-review\ngate: always\npolicy:\n  path: policy\n');
    expect(settingsChanged(base, head, ROOTS).size).toBe(0);
  });

  it("reads a role pair the way the root takes it: its glob's, else plan_role and apply_role", () => {
    const s = settingsOf('oidc:\n  plan_role: p\n  apply_role: a\n  roles:\n    "envs/prod/*":\n      plan: pp\n      apply: pa\n');
    expect((planSettings(s, "envs/prod/app").oidc as { aws: unknown }).aws).toEqual({ plan: "pp", apply: "pa" });
    expect((planSettings(s, "envs/dev/app").oidc as { aws: unknown }).aws).toEqual({ plan: "p", apply: "a" });
  });
});

/** A tofu that prints a plan with one change for every root. */
function fakeTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  state) echo '{"version":4,"resources":[],"outputs":{}}'; exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) cp "$chdir/plan.json" "\${a#-out=}" ;; esac; done; echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
  version) echo '{"terraform_version":"1.8.0"}' ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan on a change to terragucci.yml", () => {
  const PLAN = JSON.stringify(planJson([rc("terraform_data.this", ["update"], { input: "1" }, { input: "2" })]));
  const planned = async (yaml: { base: string; head: string }, extra: Record<string, string> = {}): Promise<{ roots: string[]; logs: string[] }> => {
    const { dir, commit } = repo({ "terragucci.yml": yaml.base, ...Object.fromEntries(ROOTS.map((r) => [`${r}/plan.json`, PLAN])), ...extra });
    commit({ "terragucci.yml": yaml.head });
    const bin = tmp();
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", dir, { binary: fakeTofu(bin), base: "main~1", out: join(tmp(), "r"), env: { PATH: process.env.PATH }, installer: async () => bin }, (l) => logs.push(l));
    return { roots: report.roots.filter((r) => r.status === "planned").map((r) => r.path).sort(), logs };
  };

  it("changing version for envs/prod/** plans those roots only", { timeout: 60_000 }, async () => {
    const got = await planned({ base: 'binary: tofu\nroots: ["envs/*/*"]\nversion:\n  "envs/prod/**": 1.8.0\n', head: 'binary: tofu\nroots: ["envs/*/*"]\nversion:\n  "envs/prod/**": 1.8.1\n' });
    expect(got.roots).toEqual(["envs/prod/app", "envs/prod/db"]);
    expect(got.logs).toContain("affected: envs/prod/app: its terragucci.yml settings changed (version)");
  });

  it("a change to policy at head plans nothing extra", { timeout: 60_000 }, async () => {
    const got = await planned({ base: 'binary: tofu\nroots: ["envs/*/*"]\n', head: 'binary: tofu\nroots: ["envs/*/*"]\npolicy:\n  path: policy\napproval: pr-review\n' });
    expect(got.roots).toEqual([]);
    expect(got.logs).toContain("this change reaches no root, so nothing is planned");
  });

  it("a change to the synth command plans every synthesized root", { timeout: 60_000 }, async () => {
    // The roots are written by the command, and git holds none of them.
    const SYNTH = (n: number) => `mkdir -p out/a out/b && cp app.tf out/a/main.tf && cp app.tf out/b/main.tf && echo ${n} > out/n`;
    const { dir, commit } = repo({ "terragucci.yml": `binary: tofu\nsynth: ${SYNTH(1)}\n`, "app.tf": backend("x.tfstate"), ".gitignore": "out/\n" });
    commit({ "terragucci.yml": `binary: tofu\nsynth: ${SYNTH(2)}\n` });
    execFileSync("sh", ["-c", SYNTH(2)], { cwd: dir });
    for (const r of ["out/a", "out/b"]) writeFileSync(join(dir, r, "plan.json"), PLAN);
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", dir, { binary: fakeTofu(tmp()), base: "main~1", out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(report.roots.filter((r) => r.status === "planned").map((r) => r.path).sort()).toEqual(["out/a", "out/b"]);
    expect(logs.some((l) => l.startsWith("every root: the synth command changed"))).toBe(true);
  });

  it("an edit to terragucci.yml that leaves every plan setting as it was plans nothing", { timeout: 60_000 }, async () => {
    const yaml = 'binary: tofu\nroots: ["envs/*/*"]\nversion:\n  "envs/prod/**": 1.8.0\n';
    const got = await planned({ base: yaml, head: `# the roots by environment\n${yaml}drift: "0 6 * * *"\n` });
    expect(got.roots).toEqual([]);
  });
});
