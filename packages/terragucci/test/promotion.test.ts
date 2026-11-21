// promotion in terragucci.yml, terragucci promote and terragucci rollback (terragucci#1492):
// the roots of each environment as chant components, and a release moved
// through the environments on chant's components promote and rollback.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chantConfigText } from "../src/chant-config";
import { ConfigError, validateConfig } from "../src/config";
import {
  componentName,
  PROMOTION_COMPONENTS,
  promotionComponentsText,
  promotionPlan,
  releaseArgv,
  releaseRefusal,
  releaseWords,
} from "../src/promotion";
import { TERRAGUCCI_WORDS } from "../src/ci-words";
import { renderPipeline } from "../src/render";
import { parseYAML } from "@intentius/chant/yaml";
import { git, tmp, write } from "./helpers";

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

  it("writes each environment's own roots, its order inside the environment, and a gate unless the environment's gate is never", () => {
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
      "terragucci.yml": "forge: github\nbinary: tofu\nenvironments:\n  dev: { roots: [\"envs/dev/**\"], gate: never }\n  staging: { roots: [\"envs/staging/**\"], gate: always }\n  prod: { roots: [\"envs/prod/**\"], gate: always }\npromotion: [dev, staging, prod]\n",
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

    // staging waits at its gate, and nothing applies until the release gate is approved.
    const waiting = run("node", "promote", "--to", "staging", "--release", "r1");
    expect(waiting.code, waiting.out).toBe(3);
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

    // Roll staging back to r1, behind the same gate.
    expect(run("node", "rollback", "staging", "--release", "r1").code).toBe(3);
    expect(value("staging")).toBe("net-staging-v2");
    expect(run("node", "approve", "release", "staging").code).toBe(0);
    const back = run("node", "rollback", "staging", "--release", "r1");
    expect(back.code, back.out).toBe(0);
    expect(value("staging")).toBe("net-staging-v1");
    expect(value("dev")).toBe("net-dev-v2");
  }, 300_000);
});
