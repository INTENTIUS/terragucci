// promotion in terragucci.yml, terragucci promote and terragucci rollback (terragucci#1492):
// the roots of each environment as chant components, and a release moved
// through the environments on chant's components promote and rollback.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chantConfigText } from "../src/chant-config";
import { ConfigError, resolveRepo, validateConfig } from "../src/config";
import {
  componentGateEnvironments,
  componentName,
  PROMOTION_COMPONENTS,
  promotionComponentsText,
  promotionPlan,
  releaseApproval,
  releaseArgv,
  releaseRefusal,
  releaseWords,
  stageRollbackArgv,
} from "../src/promotion";
import { committedPipeline, pipelineGatedStages, pipelineText, pipelineWrittenByTerragucci } from "../src/pipeline";
import { TERRAGUCCI_WORDS } from "../src/ci-words";
import { planEnv } from "../src/product-plan";
import { renderPipeline } from "../src/render";
import { renderProwJobs } from "../src/render-prow";
import { parseYAML } from "@intentius/chant/yaml";
import { git, tmp, twoRootRepo, write } from "./helpers";
import { init } from "../src/init";

/** The problems validateConfig finds in `raw`. */
function checkConfig(raw: unknown): { problems: string[] } {
  try {
    validateConfig(raw, "terragucci.yml");
    return { problems: [] };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { problems: e.problems ?? [e.message] };
  }
}

const DIST = join(import.meta.dirname, "../dist/terragucci.mjs");
/** A root init finds: a backend block. */
const TF = 'terraform {\n  backend "s3" {}\n}\n';
const CHANT = join(import.meta.dirname, "../../../node_modules/.bin/chant");
const hasTofu = spawnSync("tofu", ["version"], { encoding: "utf-8" }).status === 0;

describe("promotion in terragucci.yml", () => {
  const environments = { dev: { roots: ["envs/dev/**"] }, staging: { roots: ["envs/staging/**"] }, prod: { roots: ["envs/prod/**"] } };

  it("is a list of two or more environments, each once, each a key of environments", () => {
    expect(checkConfig({ environments, promotion: ["dev", "staging", "prod"] }).problems).toEqual([]);
    expect(checkConfig({ environments, promotion: ["dev"] }).problems.join("\n")).toMatch(/promotion must list two or more environment names/);
    expect(checkConfig({ environments, promotion: ["dev", "dev"] }).problems.join("\n")).toMatch(/lists dev twice/);
    expect(checkConfig({ environments, promotion: ["dev", "qa"] }).problems.join("\n")).toMatch(/lists qa, which is not one of environments \(dev, staging, prod\)/);
    expect(checkConfig({ promotion: ["dev", "prod"] }).problems.join("\n")).toMatch(/promotion needs environments/);
    expect(checkConfig({ environments, promotion: ["dev", "prod"], terragrunt: {} }).problems.join("\n")).toMatch(/plain roots/);
  });

  it("names a root's component by its path without the environment's segment", () => {
    expect(componentName("envs/dev/network", "dev")).toBe("envs-network");
    expect(componentName("live/prod/us-east-1/app", "prod")).toBe("live-us-east-1-app");
    expect(componentName("prod", "prod")).toBe("prod");
    expect(componentName("Stacks/QA_web", "dev")).toBe("stacks-qa-web");
  });

  it("with no pipeline, writes each environment's own roots, its order inside the environment, and a gate unless the environment's gate is never", () => {
    const roots = ["envs/dev/app", "envs/dev/net", "envs/staging/app", "envs/staging/net", "shared/dns"];
    const order = new Map([
      ["envs/dev/app", new Set(["envs/dev/net"])],
      ["envs/staging/app", new Set(["envs/staging/net", "shared/dns"])],
    ]);
    const plan = promotionPlan({ promotion: ["dev", "staging"], roots, settings: { environments: { dev: { roots: ["envs/dev/**"], gate: "never" }, staging: { roots: ["envs/staging/**"] } } }, order });
    expect(plan.problems).toEqual([]);
    expect(plan.gated).toEqual(["staging"]);
    expect(plan.components).toEqual([
      { name: "envs-app", byEnv: { dev: { root: "envs/dev/app", dependsOn: ["envs-net"] }, staging: { root: "envs/staging/app", dependsOn: ["envs-net"] } } },
      { name: "envs-net", byEnv: { dev: { root: "envs/dev/net", dependsOn: [] }, staging: { root: "envs/staging/net", dependsOn: [] } } },
    ]);
    const text = promotionComponentsText(plan, ["dev", "staging"]);
    expect(text).toContain('{ kind: "gate", gate: "release", environments: { "staging": { gate: "staging", description: "approve with terragucci approve release staging" } } }');
    expect(text).toContain('environments: { "dev": { root: "envs/dev/net" }, "staging": { root: "envs/staging/net" } }');
    expect(text).not.toContain("CHANT_ENV");
    expect(text).not.toContain("shared/dns");
    expect(text).toContain("chant-disable COMP004");
    expect(plan.componentGated).toEqual(["staging"]);
    expect(componentGateEnvironments(text)).toEqual(["staging"]);
  });

  // terragucci#1532: a stage the pipeline gates is approved once, at its stage gate.
  it("with the pipeline, writes no component gate for an environment the pipeline gates", () => {
    const settings = { gate: "on-destructive" as const, environments: { dev: { roots: ["envs/dev/**"], gate: "never" as const }, staging: { roots: ["envs/staging/**"], gate: "always" as const }, prod: { roots: ["envs/prod/**"] } } };
    const plan = promotionPlan({ promotion: ["dev", "staging", "prod"], roots: ["envs/dev/net", "envs/staging/net", "envs/prod/net"], settings, order: new Map(), pipeline: true });
    expect(plan.gated).toEqual(["staging", "prod"]);
    expect(pipelineGatedStages({ ...settings, promotion: ["dev", "staging", "prod"] })).toEqual(["staging", "prod"]);
    expect(plan.componentGated).toEqual([]);
    const text = promotionComponentsText(plan, ["dev", "staging", "prod"]);
    expect(text).not.toContain('kind: "gate"');
    expect(text).not.toContain("COMP004");
    expect(text).toContain("// Approved once, at the stage's gate in .chant/pipeline.ts: staging, prod; terragucci approve release <env>");
    expect(componentGateEnvironments(text)).toEqual([]);
  });

  it("refuses two roots of one environment that make one component, and an environment with no roots", () => {
    const plan = promotionPlan({ promotion: ["dev", "prod"], roots: ["dev/net", "net/dev"], settings: { environments: { dev: { roots: ["dev/**", "net/**"] }, prod: { roots: ["prod/**"] } } }, order: new Map() });
    expect(plan.problems.join("\n")).toMatch(/dev\/net and net\/dev of environment dev both make the component net/);
    expect(plan.problems.join("\n")).toMatch(/environment prod of promotion has no roots/);
  });

  it("lists the environments in promotion's order in chant.config.ts, with the terraform lexicon", () => {
    const text = chantConfigText(["envs/dev/net"], "tofu", ["dev", "staging", "prod"]);
    const config = JSON.parse(text.slice(text.indexOf("export default ") + 15).replace(/;\s*$/, ""));
    expect(config.environments).toEqual(["dev", "staging", "prod"]);
    expect(config.lexicons).toEqual(["terraform"]);
    expect(chantConfigText(["envs/dev/net"], "tofu")).not.toContain("environments");
  });

  it("sets the forge-checks release gate under promotion alone, after the environments", () => {
    const text = chantConfigText(["envs/dev/net"], "tofu", ["dev", "prod"]);
    const config = JSON.parse(text.slice(text.indexOf("export default ") + 15).replace(/;\s*$/, ""));
    expect(config.release).toEqual({ green: "forge-checks" });
    expect(Object.keys(config)).toEqual(["lexicons", "environments", "release", "terraform"]);
    expect(chantConfigText(["envs/dev/net"], "tofu")).not.toContain("release");
    expect(chantConfigText(["envs/dev/net"], "tofu", [])).not.toContain("forge-checks");
  });

  it("gives GitHub's wave jobs read on checks, statuses and actions when the merge cuts a release, and nothing more otherwise", () => {
    const jobs = (releaseCut: boolean): Record<string, any> =>
      (parseYAML(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["envs/dev/net"]], env: {}, ...(releaseCut ? { releaseCut } : {}) }).content.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>).jobs;
    expect(jobs(true)["apply-wave-1"].permissions).toMatchObject({ contents: "write", checks: "read", statuses: "read", actions: "read" });
    expect(jobs(false)["apply-wave-1"].permissions.checks).toBeUndefined();
    expect(jobs(false)["apply-wave-1"].permissions.actions).toBeUndefined();
  });
});

describe("the plan environment under promotion", () => {
  /** Every line of the rendered files that names an environment to `pr-post` or `plan-handoff`. */
  const envLines = (files: string[]): string[] => files.flatMap((f) => f.split("\n")).filter((l) => /(pr-post|plan-handoff)\b.*--env /.test(l));
  const envsOf = (files: string[]): string[] => [...new Set(envLines(files).map((l) => /--env (\S+)/.exec(l)![1]!))];
  const pipeline = (forge: "github" | "gitlab" | "forgejo", promotion?: string[]): string[] => {
    const r = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["envs/dev/net"]], env: {}, ...(promotion ? { planEnv: planEnv(promotion) } : {}) });
    return [r.content, ...(r.extra ?? []).map((e) => e.content)];
  };

  it("is the first stage of promotion, else default", () => {
    expect(planEnv(["dev", "staging", "prod"])).toBe("dev");
    expect(planEnv(undefined)).toBe("default");
    expect(planEnv([])).toBe("default");
  });

  it.each(["github", "gitlab", "forgejo"] as const)("names the first stage in every pr-post and plan-handoff on %s, the plan note and stale-notes among them", (forge) => {
    const files = pipeline(forge, ["dev", "staging", "prod"]);
    const lines = envLines(files);
    expect(lines.some((l) => l.includes("pr-post") && l.includes("--stale"))).toBe(true);
    expect(lines.some((l) => l.includes("plan-handoff"))).toBe(true);
    expect(envsOf(files)).toEqual(["dev"]);
  });

  it.each(["github", "gitlab", "forgejo"] as const)("names default with no promotion on %s", (forge) => {
    const files = pipeline(forge);
    expect(envLines(files).some((l) => l.includes("pr-post") && l.includes("--stale"))).toBe(true);
    expect(envsOf(files)).toEqual(["default"]);
  });

  it("is what init writes into the workflow: the first stage with promotion, default without", async () => {
    const workflow = async (config?: string): Promise<string[]> => {
      const dir = twoRootRepo();
      write(dir, { "terragucci.yml": `forge: forgejo\n${config ?? ""}` });
      git(dir, "init", "-q", "-b", "main");
      await init(dir, { binary: "tofu" });
      return [readFileSync(join(dir, ".forgejo/workflows/terragucci.yml"), "utf-8")];
    };
    const promoted = await workflow('environments:\n  dev:\n    roots: ["network"]\n  prod:\n    roots: ["app"]\npromotion: [dev, prod]\n');
    expect(envLines(promoted).some((l) => l.includes("pr-post") && l.includes("--stale"))).toBe(true);
    expect(envsOf(promoted)).toEqual(["dev"]);
    expect(envsOf(await workflow())).toEqual(["default"]);
  });

  it("is what init writes into the components and .chant/pipeline.ts: one gate per stage, the pipeline's", async () => {
    const dir = tmp();
    write(dir, {
      "terragucci.yml": 'forge: github\nenvironments:\n  dev: { roots: ["envs/dev/**"], gate: never }\n  staging: { roots: ["envs/staging/**"], gate: always }\n  prod: { roots: ["envs/prod/**"], gate: always }\npromotion: [dev, staging, prod]\n',
      "envs/dev/net/main.tf": TF, "envs/staging/net/main.tf": TF, "envs/prod/net/main.tf": TF,
    });
    git(dir, "init", "-q", "-b", "main");
    await init(dir, { binary: "tofu" });
    const components = readFileSync(join(dir, PROMOTION_COMPONENTS), "utf-8");
    expect(componentGateEnvironments(components)).toEqual([]);
    const pipeline = readFileSync(join(dir, ".chant/pipeline.ts"), "utf-8");
    expect(pipelineWrittenByTerragucci(pipeline)).toBe(true);
    // The pipeline init writes is the one terragucci ci writes, and it gates staging and prod.
    expect(pipeline).toBe(pipelineText(dir, resolveRepo(parseYAML(readFileSync(join(dir, "terragucci.yml"), "utf-8")) as never)));
    const stages = committedPipeline(dir)!.stages;
    expect(stages.map((s) => [s.name, s.gate?.policy])).toEqual([["dev", "never"], ["staging", "always"], ["prod", "always"]]);
  });

  it("keeps the components' gates beside a .chant/pipeline.ts the repo wrote itself", async () => {
    const dir = tmp();
    const own = "// the repo's own pipeline\nexport default {};\n";
    write(dir, {
      "terragucci.yml": 'forge: github\nenvironments:\n  dev: { roots: ["envs/dev/**"], gate: never }\n  prod: { roots: ["envs/prod/**"], gate: always }\npromotion: [dev, prod]\n',
      "envs/dev/net/main.tf": TF, "envs/prod/net/main.tf": TF,
      ".chant/pipeline.ts": own,
    });
    git(dir, "init", "-q", "-b", "main");
    const r = await init(dir, { binary: "tofu" });
    expect(readFileSync(join(dir, ".chant/pipeline.ts"), "utf-8")).toBe(own);
    expect(componentGateEnvironments(readFileSync(join(dir, PROMOTION_COMPONENTS), "utf-8"))).toEqual(["prod"]);
    expect(r.notes.join("\n")).toMatch(/\.chant\/pipeline\.ts is the repo's own, so terragucci left it/);
  });

  it("names the first stage in prow's plan note and stale mark", () => {
    const prow = (env?: string): string[] => [renderProwJobs({
      repo: "acme/infra",
      defaultBranch: "main",
      prow: { cluster: "untrusted", trusted_cluster: "trusted", service_accounts: { plan: "tf-plan", apply: "tf-apply" }, token_secret: { name: "t" }, plan_before_merge: true },
      binary: "tofu",
      image: "img:1",
      layers: [["envs/dev/net"]],
      env: {},
      check: {},
      report: {},
      ...(env ? { planEnv: env } : {}),
    }).content];
    expect(envLines(prow("dev")).filter((l) => l.includes("pr-post")).length).toBe(2);
    expect(envsOf(prow("dev"))).toEqual(["dev"]);
    expect(envsOf(prow())).toEqual(["default"]);
  });
});

describe("terragucci promote and rollback's command lines", () => {
  it("map onto chant's components promote and rollback", () => {
    expect(releaseArgv("promote", { args: [], flags: { to: "staging", release: "v1.2.0", "dry-run": true } })).toEqual(["components", "promote", "--to", "staging", "--release", "v1.2.0", "--dry-run"]);
    expect(releaseArgv("promote", { args: [], flags: { to: "prod", from: "dev", "allow-skip": true } })).toEqual(["components", "promote", "--to", "prod", "--from", "dev", "--allow-skip"]);
    expect(releaseArgv("rollback", { args: ["prod"], flags: { release: "v1.1.0", json: true } })).toEqual(["components", "rollback", "prod", "--release", "v1.1.0", "--json"]);
  });

  it("refuse what chant's commands would read otherwise", () => {
    expect(() => releaseArgv("promote", { args: [], flags: {} })).toThrow(/promote needs --to <env>/);
    expect(() => releaseArgv("promote", { args: ["prod"], flags: { to: "prod" } })).toThrow(/names its environment with --to/);
    expect(() => releaseArgv("rollback", { args: ["prod"], flags: {} })).toThrow(/rollback needs --release <label>/);
    expect(() => releaseArgv("rollback", { args: ["prod"], flags: { release: "v1", "allow-skip": true } })).toThrow(/does not take --allow-skip/);
    expect(() => releaseArgv("promote", { args: [], flags: { to: "prod", component: "x" } })).toThrow(/does not take --component/);
  });

  it("refuse a repo with no components file, and say how to install the terraform lexicon", () => {
    const repo = tmp();
    expect(releaseRefusal(repo)).toMatch(/terragucci.component.ts is missing: set promotion/);
    write(repo, { [PROMOTION_COMPONENTS]: "" });
    expect(releaseRefusal(repo, [join(repo, "package.json")])).toMatch(/npm i -D @intentius\/chant-lexicon-terraform@\d/);
    expect(releaseRefusal(repo)).toBeUndefined();
  });

  it("take a stage's one approval at its pipeline gate, and refuse when the pipeline chant reads does not gate it", () => {
    const settings = { environments: { dev: { roots: ["envs/dev/**"], gate: "never" as const }, prod: { roots: ["envs/prod/**"], gate: "always" as const } } };
    const plan = promotionPlan({ promotion: ["dev", "prod"], roots: ["envs/dev/net", "envs/prod/net"], settings, order: new Map(), pipeline: true });
    const repo = tmp();
    write(repo, { [PROMOTION_COMPONENTS]: promotionComponentsText(plan, ["dev", "prod"]) });
    git(repo, "init", "-q", "-b", "main");
    const commit = () => git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-am", "c");
    git(repo, "add", "-A");
    commit();
    // No pipeline on the default branch: prod waits for nobody, so the promote is refused.
    expect(releaseApproval(repo, "prod", settings)).toEqual({ refused: expect.stringMatching(/prod's approval is its stage gate in \.chant\/pipeline\.ts.*there is no \.chant\/pipeline\.ts at [0-9a-f]{12}/) });
    // dev's gate is never: it deploys as it did, with no approval.
    expect(releaseApproval(repo, "dev", settings)).toEqual({ via: "component" });
    // A pipeline whose prod gate is never is refused too.
    const pipeline = (gate: string, extra = "") => `import { pipeline } from "@intentius/chant/pipeline";\nexport default pipeline({ name: "tf-apply", stages: [{ name: "dev", waves: [{ name: "wave-1", runs: [{ target: "envs/dev/net" }] }], gate: { policy: "never" } }, { name: "prod", waves: [{ name: "wave-1", runs: [{ target: "envs/prod/net" }] }], gate: { policy: "${gate}" }${extra} }] });\n`;
    write(repo, { ".chant/pipeline.ts": pipeline("never") });
    git(repo, "add", "-A");
    commit();
    expect(releaseApproval(repo, "prod", settings)).toEqual({ refused: expect.stringMatching(/sets prod's gate to never/) });
    write(repo, { ".chant/pipeline.ts": pipeline("always", ", pauseAfterRollback: true") });
    git(repo, "add", "-A");
    commit();
    expect(releaseApproval(repo, "prod", settings)).toEqual({ via: "stage", pauseAfterRollback: true });
    // Components that carry prod's gate take it there, pipeline or not.
    write(repo, { [PROMOTION_COMPONENTS]: promotionComponentsText({ ...plan, componentGated: ["prod"] }, ["dev", "prod"]) });
    expect(releaseApproval(repo, "prod", settings)).toEqual({ via: "component" });
  });

  it("roll back into a stage the pipeline gates as a promote of the earlier release, through the stage's gate", () => {
    expect(stageRollbackArgv(releaseArgv("rollback", { args: ["prod"], flags: { release: "r1", "dry-run": true } }))).toEqual(["components", "promote", "--to", "prod", "--release", "r1", "--dry-run"]);
  });

  it("print the release gate's approve line", () => {
    expect(releaseWords(TERRAGUCCI_WORDS).approve).toBe("terragucci approve release {target} {sign}");
  });
});

/**
 * A repo with one root per environment, each keeping its state behind an
 * HTTP backend this test serves: a release cut, deployed to dev, promoted to
 * staging behind staging's gate, and rolled back there.
 */
describe.skipIf(!hasTofu || !existsSync(DIST))("a release through dev and staging, with the real tofu", () => {
  // The backend runs in a process of its own: the steps below run with spawnSync, which holds this one.
  let server: ChildProcess;
  let port = 0;
  const stateDir = tmp("terragucci-promote-state-");
  beforeAll(async () => {
    const script = [
      'const { createServer } = require("node:http"); const { readFileSync, writeFileSync, existsSync } = require("node:fs");',
      "const dir = process.argv[1];",
      'const file = (u) => dir + "/" + u.replace(/[^a-z0-9-]/gi, "_");',
      "const s = createServer((req, res) => {",
      '  if (req.method === "GET") { const f = file(req.url); if (!existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(readFileSync(f)); }',
      '  if (req.method === "POST") { const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => { writeFileSync(file(req.url), Buffer.concat(b)); res.writeHead(200); res.end(); }); return; }',
      "  res.writeHead(200); res.end();",
      '}).listen(0, "127.0.0.1", () => console.log(s.address().port));',
    ].join("\n");
    server = spawn(process.execPath, ["-e", script, stateDir], { stdio: ["ignore", "pipe", "inherit"] });
    port = await new Promise<number>((done) => server.stdout!.once("data", (d: Buffer) => done(Number(d.toString().trim()))));
  });
  afterAll(() => {
    server.kill();
  });

  const value = (env: string): string | undefined => {
    const f = join(stateDir, `_${env}`);
    return existsSync(f) ? /"(net-[a-z]+-v\d)"/.exec(readFileSync(f, "utf-8"))?.[1] : undefined;
  };
  const root = (env: string, v: string) => `terraform {\n  backend "http" { address = "http://127.0.0.1:${port}/${env}" }\n}\nresource "terraform_data" "net" { input = "net-${env}-${v}" }\n`;

  it("promote --to staging applies the staging root behind its gate, refuses a skip, and rollback restores an earlier release", () => {
    const repo = tmp("terragucci-promote-");
    const origin = tmp("terragucci-promote-origin-");
    const env = { ...process.env, CHANT_ACTOR: "tester", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", NO_COLOR: "1" };
    const run = (bin: string, ...args: string[]) => {
      const r = spawnSync(bin === "chant" ? CHANT : process.execPath, bin === "chant" ? args : [DIST, ...args], { cwd: repo, encoding: "utf-8", env });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const commitGreen = (message: string) => {
      git(repo, "add", "-A");
      git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
      git(repo, "push", "-q", "origin", "main");
      git(repo, "tag", `ci/green/${git(repo, "rev-parse", "HEAD").trim()}`);
    };
    const cut = (label: string) => {
      const r = run("chant", "release", "cut", label, "--yes");
      expect(r.code, r.out).toBe(0);
      git(repo, "push", "-q", "origin", `release/${label}`);
    };

    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    write(repo, {
      "terragucci.yml": "forge: github\nbinary: tofu\nenvironments:\n  dev: { roots: [\"envs/dev/**\"], gate: never }\n  staging: { roots: [\"envs/staging/**\"], gate: always, pause_after_rollback: true }\n  prod: { roots: [\"envs/prod/**\"], gate: always }\npromotion: [dev, staging, prod]\n",
      "envs/dev/net/main.tf": root("dev", "v1"),
      "envs/staging/net/main.tf": root("staging", "v1"),
      "envs/prod/net/main.tf": root("prod", "v1"),
      ".gitignore": ".terraform/\n.terraform.lock.hcl\n*.tfplan\nchant.tfplan*\n.chant/release-templates/\n.chant/promote/\n",
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    // A CI runner has no git identity; the test's own commits need one.
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    const init = run("node", "init", "--no-bucket-check");
    expect(init.code, init.out).toBe(0);
    expect(readFileSync(join(repo, PROMOTION_COMPONENTS), "utf-8")).toContain('root: "envs/staging/net"');
    // init wrote the forge-checks gate; this origin is a bare directory with no forge, so the cuts here read the ci/green tags commitGreen writes.
    const configFile = join(repo, "chant.config.ts");
    expect(readFileSync(configFile, "utf-8")).toContain('"green": "forge-checks"');
    writeFileSync(configFile, readFileSync(configFile, "utf-8").replace('"green": "forge-checks"', '"green": "chant"'));
    commitGreen("init");
    cut("r1");

    // dev, the first environment, deploys the release with chant's run; its gate is never.
    const dev = run("chant", "run", "--components", "all", "--env", "dev", "--release", "r1");
    expect(dev.code, dev.out).toBe(0);
    expect(value("dev")).toBe("net-dev-v1");

    // Skipping staging is refused.
    const skip = run("node", "promote", "--to", "prod", "--release", "r1");
    expect(skip.code).not.toBe(0);
    expect(skip.out).toMatch(/--allow-skip/);
    expect(value("prod")).toBeUndefined();

    // init wrote .chant/pipeline.ts beside the components: staging waits once, at its stage gate, and nothing applies until it is approved.
    expect(existsSync(join(repo, ".chant/pipeline.ts"))).toBe(true);
    const waiting = run("node", "promote", "--to", "staging", "--release", "r1");
    expect(waiting.code, waiting.out).toBe(3);
    expect(waiting.out).toContain("tf-apply staging waits for an approval of");
    expect(waiting.out).toContain("terragucci approve release staging");
    expect(value("staging")).toBeUndefined();
    expect(run("node", "approve", "release", "staging").code).toBe(0);
    const promoted = run("node", "promote", "--to", "staging", "--release", "r1");
    expect(promoted.code, promoted.out).toBe(0);
    // The staging root applied, with its own files; dev's state is as dev left it.
    expect(value("staging")).toBe("net-staging-v1");
    expect(value("dev")).toBe("net-dev-v1");
    // The promote recorded the release staging runs.
    const ledger = git(repo, "show", "chant/lifecycle:staging/releases.jsonl");
    expect(ledger).toMatch(/"releaseDigest":"jcs1-sha256:/);

    // A second release, through dev and staging.
    write(repo, { "envs/dev/net/main.tf": root("dev", "v2"), "envs/staging/net/main.tf": root("staging", "v2"), "envs/prod/net/main.tf": root("prod", "v2") });
    commitGreen("v2");
    cut("r2");
    expect(run("chant", "run", "--components", "all", "--env", "dev", "--release", "r2").code).toBe(0);
    expect(run("node", "promote", "--to", "staging", "--release", "r2").code).toBe(3);
    expect(run("node", "approve", "release", "staging").code).toBe(0);
    expect(run("node", "promote", "--to", "staging", "--release", "r2").code).toBe(0);
    expect(value("staging")).toBe("net-staging-v2");

    // Roll staging back to r1, behind the same gate: the stage's, once.
    const rollbackWaits = run("node", "rollback", "staging", "--release", "r1");
    expect(rollbackWaits.code, rollbackWaits.out).toBe(3);
    expect(rollbackWaits.out).toContain("tf-apply staging waits for an approval of");
    expect(value("staging")).toBe("net-staging-v2");
    expect(run("node", "approve", "release", "staging").code).toBe(0);
    const back = run("node", "rollback", "staging", "--release", "r1");
    expect(back.code, back.out).toBe(0);
    expect(value("staging")).toBe("net-staging-v1");
    expect(value("dev")).toBe("net-dev-v2");
    // pause_after_rollback: the rollback paused staging, so a promote into it waits until the stage is resumed.
    expect(back.out).toContain("paused stage staging");
    const paused = run("node", "promote", "--to", "staging", "--release", "r2");
    expect(paused.code, paused.out).toBe(3);
    expect(paused.out).toMatch(/paused/);
    expect(value("staging")).toBe("net-staging-v1");
  }, 300_000);

  // terragucci#1532: with .chant/pipeline.ts a stage is approved once, at its gate, which `terragucci approve release <env>` answers.
  it("with the pipeline terragucci ci writes, a promote into staging and then prod waits once, at the stage's gate", () => {
    const repo = tmp("terragucci-promote-pipeline-");
    const origin = tmp("terragucci-promote-pipeline-origin-");
    const env = { ...process.env, CHANT_ACTOR: "tester", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", NO_COLOR: "1" };
    const run = (bin: string, ...args: string[]) => {
      const r = spawnSync(bin === "chant" ? CHANT : process.execPath, bin === "chant" ? args : [DIST, ...args], { cwd: repo, encoding: "utf-8", env });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    write(repo, {
      "terragucci.yml": "forge: github\nbinary: tofu\nenvironments:\n  dev: { roots: [\"envs/dev/**\"], gate: never }\n  staging: { roots: [\"envs/staging/**\"], gate: always }\n  prod: { roots: [\"envs/prod/**\"], gate: always }\npromotion: [dev, staging, prod]\nrelease:\n  cut: false\n",
      // Each root keeps its state at a path of its own, beside the test above's.
      "envs/dev/net/main.tf": root("dev", "v1").replace("/dev", "/pdev"),
      "envs/staging/net/main.tf": root("staging", "v1").replace("/staging", "/pstaging"),
      "envs/prod/net/main.tf": root("prod", "v1").replace("/prod", "/pprod"),
      ".gitignore": ".terraform/\n.terraform.lock.hcl\n*.tfplan\nchant.tfplan*\n.chant/release-templates/\n.chant/promote/\n",
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    const init = run("node", "init", "--no-bucket-check");
    expect(init.code, init.out).toBe(0);
    const ci = run("node", "ci");
    expect(ci.code, ci.out).toBe(0);
    expect(existsSync(join(repo, ".chant/pipeline.ts"))).toBe(true);
    const configFile = join(repo, "chant.config.ts");
    writeFileSync(configFile, readFileSync(configFile, "utf-8").replace('"green": "forge-checks"', '"green": "chant"'));
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "tag", `ci/green/${git(repo, "rev-parse", "HEAD").trim()}`);
    const cut = run("chant", "release", "cut", "r1", "--yes");
    expect(cut.code, cut.out).toBe(0);
    git(repo, "push", "-q", "origin", "release/r1");
    const dev = run("chant", "run", "--components", "all", "--env", "dev", "--release", "r1");
    expect(dev.code, dev.out).toBe(0);

    // One approval per stage: the promote stops at the stage's gate, tf-apply staging, and names approve release for it.
    const waiting = run("node", "promote", "--to", "staging", "--release", "r1");
    expect(waiting.code, waiting.out).toBe(3);
    expect(waiting.out).toContain("tf-apply staging waits for an approval of");
    expect(waiting.out).toContain("terragucci approve release staging");
    expect(value("pstaging")).toBeUndefined();
    const stage = run("node", "approve", "release", "staging");
    expect(stage.code, stage.out).toBe(0);
    expect(stage.out).toContain("running: chant approve tf-apply staging --env staging");
    // That one approval lets the same promote through: the components carry no gate of their own.
    const promoted = run("node", "promote", "--to", "staging", "--release", "r1");
    expect(promoted.code, promoted.out).toBe(0);
    expect(promoted.out).toContain("stage staging: tf-apply staging approved by");
    expect(value("pstaging")).toBe("net-staging-v1");

    // prod does the same.
    const prodWaits = run("node", "promote", "--to", "prod", "--release", "r1");
    expect(prodWaits.code, prodWaits.out).toBe(3);
    expect(prodWaits.out).toContain("tf-apply prod waits for an approval of");
    expect(value("pprod")).toBeUndefined();
    const prodStage = run("node", "approve", "release", "prod");
    expect(prodStage.code, prodStage.out).toBe(0);
    expect(prodStage.out).toContain("running: chant approve tf-apply prod --env prod");
    const prod = run("node", "promote", "--to", "prod", "--release", "r1");
    expect(prod.code, prod.out).toBe(0);
    expect(value("pprod")).toBe("net-prod-v1");
  }, 300_000);
});
