import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig } from "../src/config";
import { findRootsWithReasons } from "../src/detect";
import { applyScript, commentApplyScript, driftScript, planFilesScript, planScript, renderPipeline, synthScript } from "../src/render";
import { runStage } from "../src/report/stage";
import { compareSynthesized, localModules, synthAffected, treeDigest } from "../src/synth";
import { git, tmp, write } from "./helpers";

const SYNTH = "npm ci && npx cdktn synth";
const layers = [["cdktf.out/stacks/dev", "cdktf.out/stacks/prod"]];
const stack = (backend: string): string => JSON.stringify({ terraform: { backend: { [backend]: { path: "x.tfstate" } } }, resource: { terraform_data: { cfg: { input: 1 } } } });

describe("synth: roots a command writes", () => {
  it("finds a CDK Terrain stack as a root by the backend in its cdk.tf.json", () => {
    const repo = write(tmp(), {
      "cdktf.out/stacks/dev/cdk.tf.json": stack("s3"),
      "cdktf.out/stacks/prod/cdk.tf.json": stack("local"),
      "cdktf.out/manifest.json": "{}",
      "node_modules/x/cdk.tf.json": stack("s3"),
    });
    expect(findRootsWithReasons(repo)).toEqual([
      { root: "cdktf.out/stacks/dev", reason: "backend s3" },
      { root: "cdktf.out/stacks/prod", reason: "backend local" },
    ]);
  });

  it("takes synth as a command, and refuses anything else", () => {
    expect(validateConfig({ synth: SYNTH }, "t").synth).toBe(SYNTH);
    expect(() => validateConfig({ synth: true }, "t")).toThrow(/synth must be the command that writes the roots/);
    expect(() => validateConfig({ synth: " " }, "t")).toThrow(ConfigError);
  });

  it("runs the command after the checkout and before any credential, in every job that reads the roots", () => {
    const step = synthScript(SYNTH);
    const oidc = { plan_role: "arn:aws:iam::1:role/plan", apply_role: "arn:aws:iam::1:role/apply" };
    const before = (script: string, what: string): void => {
      expect(script).toContain(`( set -e; ${SYNTH} )`);
      expect(script.indexOf(`( set -e; ${SYNTH} )`)).toBeLessThan(script.indexOf(what));
    };
    before(planScript("tofu", layers, "github", oidc, { synth: SYNTH }), "export AWS_ROLE_ARN");
    before(planScript("tofu", layers, "github", oidc, { synth: SYNTH }), "terragucci stage tf-plan");
    before(planFilesScript("tofu", layers, "github", undefined, { synth: SYNTH }, { replan: true }), "terragucci stage tf-plan");
    const replan = planFilesScript("tofu", layers, "github", undefined, { synth: SYNTH }, { replan: true });
    expect(replan.indexOf('git rev-parse HEAD')).toBeLessThan(replan.indexOf(SYNTH));
    expect(replan).toContain('echo "failure the synth command failed" >terragucci-report/plan-status.txt');
    before(applyScript("tofu", layers, "github", oidc, { wave: 1, synth: SYNTH }), "terragucci stage tf-apply");
    before(driftScript("tofu", layers, "github", oidc, { synth: SYNTH }), "terragucci stage tf-drift");
    const comment = commentApplyScript("tofu", layers, "github", oidc, { synth: SYNTH });
    expect(comment.indexOf('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(comment.indexOf(SYNTH));
    expect(planScript("tofu", layers, "github", undefined, { synth: SYNTH })).toContain('tg status terragucci/plan failure "the synth command failed"');
    expect(step).not.toContain("tg status");
    expect(planScript("tofu", layers)).not.toContain("synth");
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the check, plan and apply jobs run it", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, synth: SYNTH }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const script = (job: any): string => (forge === "gitlab" ? job.script.join("\n") : job.steps.map((s: { run?: string }) => s.run ?? "").join("\n"));
    for (const name of ["check", "plan", "apply-wave-1"]) expect(script(jobs[name]), name).toContain(`( set -e; ${SYNTH} )`);
  });

  it("finds no roots when the command has not run", async () => {
    const repo = write(tmp(), { "terragucci.yml": `binary: tofu\nsynth: ${SYNTH}\n`, "main.js": "" });
    await expect(runStage("tf-plan", repo, { layers, out: tmp() }, () => {})).rejects.toThrow(/found no roots: none of the 2 the pipeline names is on disk; the synth command/);
  });
});

describe("synth: plan only the stacks a change affects", () => {
  // A stand-in for cdktn synth: each app/<stack>.json becomes out/stacks/<stack>/cdk.tf.json.
  const SYNTH_SH = "for f in app/*.json; do s=$(basename \"$f\" .json); mkdir -p out/stacks/$s; cp \"$f\" out/stacks/$s/cdk.tf.json; done";
  const roots = ["out/stacks/dev", "out/stacks/prod"];
  const commit = (repo: string, message: string): void => {
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  };
  /** A repo whose main holds the app, and a branch `change` with `edit` applied, synthesized at its head. */
  const app = (edit: Record<string, string>): string => {
    const repo = write(tmp(), {
      "app/dev.json": JSON.stringify({ resource: { terraform_data: { cfg: { input: 1 } } } }),
      "app/prod.json": JSON.stringify({ resource: { terraform_data: { cfg: { input: 3 } } }, module: { queue: { source: "../../../modules/queue" } } }),
      "modules/queue/main.tf": 'variable "size" {}\n',
      ".gitignore": "out/\n",
    });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "base");
    git(repo, "checkout", "-q", "-b", "change");
    write(repo, edit);
    commit(repo, "head");
    execFileSync("sh", ["-c", SYNTH_SH], { cwd: repo });
    return repo;
  };
  const synthAt = (files: Record<string, string>): string => write(tmp(), files);

  it("compares each root's files and the local modules it calls, and ignores state and .terraform", () => {
    const base = synthAt({
      "out/stacks/dev/cdk.tf.json": "{}",
      "out/stacks/prod/cdk.tf.json": JSON.stringify({ module: { q: { source: "../../../modules/queue" } } }),
      "out/stacks/lock/cdk.tf.json": "{}",
      "out/stacks/lock/.terraform.lock.hcl": "a",
      "out/stacks/gone/cdk.tf.json": "{}",
      "modules/queue/main.tf": "a",
    });
    const head = synthAt({
      "out/stacks/dev/cdk.tf.json": "{}",
      "out/stacks/dev/terraform.tfstate": "{}",
      "out/stacks/dev/.terraform/providers/x": "x",
      "out/stacks/prod/cdk.tf.json": JSON.stringify({ module: { q: { source: "../../../modules/queue" } } }),
      "out/stacks/lock/cdk.tf.json": "{}",
      "out/stacks/lock/.terraform.lock.hcl": "b",
      "out/stacks/new/cdk.tf.json": "{}",
      "modules/queue/main.tf": "b",
    });
    const { changed, unchanged } = compareSynthesized(base, head, ["out/stacks/dev", "out/stacks/prod", "out/stacks/lock", "out/stacks/new", "out/stacks/gone"]);
    expect(unchanged).toEqual(["out/stacks/dev"]);
    expect(Object.fromEntries(changed)).toEqual({
      "out/stacks/prod": "module modules/queue: main.tf differs",
      "out/stacks/lock": ".terraform.lock.hcl differs",
      "out/stacks/new": "new: the base does not synthesize it",
      "out/stacks/gone": "removed: the head does not synthesize it",
    });
    expect([...treeDigest(join(head, "out/stacks/dev")).keys()]).toEqual(["cdk.tf.json"]);
  });

  it("takes each checkout's own directory out of its files, as CDK Terrain's default local backend writes it", () => {
    const local = (repo: string, stack: string): string => JSON.stringify({ terraform: { backend: { local: { path: `${repo}/terraform.${stack}.tfstate` } } } });
    const base = tmp();
    const head = tmp();
    write(base, { "out/stacks/dev/cdk.tf.json": local(base, "dev"), "out/stacks/prod/cdk.tf.json": local(base, "prod") });
    write(head, { "out/stacks/dev/cdk.tf.json": local(head, "dev"), "out/stacks/prod/cdk.tf.json": local(`${head}/other`, "prod") });
    const { changed, unchanged } = compareSynthesized(base, head, ["out/stacks/dev", "out/stacks/prod"]);
    expect(unchanged).toEqual(["out/stacks/dev"]);
    expect(Object.fromEntries(changed)).toEqual({ "out/stacks/prod": "cdk.tf.json differs" });
  });

  it("reads local module sources from Terraform JSON and HCL, and leaves out registry sources and paths outside the repo", () => {
    const repo = write(tmp(), {
      "stacks/a/cdk.tf.json": JSON.stringify({ module: [{ x: { source: "../../modules/x" } }, { r: { source: "terraform-aws-modules/vpc/aws" } }], terraform: {} }),
      "stacks/a/extra.tf": 'module "y" {\n  source = "./y"\n}\nmodule "far" {\n  source = "../../../outside"\n}\n',
    });
    expect(localModules(repo, "stacks/a")).toEqual(["modules/x", "stacks/a/y"]);
  });

  it("plans a changed stack and the roots that read its state, and the notice counts the unchanged ones", async () => {
    const repo = app({ "app/prod.json": JSON.stringify({ resource: { terraform_data: { cfg: { input: 5 } } }, module: { queue: { source: "../../../modules/queue" } } }) });
    const lines: string[] = [];
    const picked = await synthAffected(repo, "main", SYNTH_SH, roots, new Map(), process.env, (l) => lines.push(l));
    expect([...picked.selected!]).toEqual(["out/stacks/prod"]);
    expect(picked.notice).toMatch(/^The synth command ran on the base \([0-9a-f]{8}\) too: 1 synthesized root planned, 1 unchanged and not planned\.$/);
    expect(lines).toContain("affected: out/stacks/prod differs from the base (cdk.tf.json differs)");
    expect(lines).toContain("affected: 1 of 2 synthesized roots differ from main, 0 dependents after them, 1 unchanged and not planned");
    // The base's checkout is gone afterwards.
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);

    const reads = await synthAffected(repo, "main", SYNTH_SH, roots, new Map([["out/stacks/dev", new Set(["out/stacks/prod"])]]), process.env, () => {});
    expect([...reads.selected!].sort()).toEqual(roots);
    expect(reads.notice).toContain("2 synthesized roots planned, 0 unchanged");
  });

  it("follows a change to a local module the stack calls", async () => {
    const repo = app({ "modules/queue/main.tf": 'variable "size" { default = 1 }\n' });
    const picked = await synthAffected(repo, "main", SYNTH_SH, roots, new Map(), process.env, () => {});
    expect([...picked.selected!]).toEqual(["out/stacks/prod"]);
  });

  it("plans nothing when no stack's output changed", async () => {
    const repo = app({ "README.md": "docs only\n" });
    const picked = await synthAffected(repo, "main", SYNTH_SH, roots, new Map(), process.env, () => {});
    expect(picked.selected!.size).toBe(0);
    expect(picked.notice).toContain("0 synthesized roots planned, 2 unchanged and not planned");
  });

  it("plans every stack, and says why, when the base cannot be synthesized or has no merge base", async () => {
    const repo = app({ "app/prod.json": "{}" });
    const lines: string[] = [];
    const failed = await synthAffected(repo, "main", "echo cannot synthesize >&2; exit 3", roots, new Map(), process.env, (l) => lines.push(l));
    expect(failed.selected).toBeUndefined();
    expect(failed.notice).toMatch(/^Every synthesized root is planned: the synth command failed on the base [0-9a-f]{8}, so its stacks could not be compared\.$/);
    expect(lines).toContain("synth at the base: cannot synthesize");
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    const unknown = await synthAffected(repo, "no-such-branch", SYNTH_SH, roots, new Map(), process.env, () => {});
    expect(unknown.selected).toBeUndefined();
    expect(unknown.notice).toMatch(/^Every synthesized root is planned: no merge base of no-such-branch and HEAD/);
  });
});
