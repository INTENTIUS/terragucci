// Atmos mode: detection, instances and their waves from `atmos describe
// stacks` (stubbed), the instance directories the jobs run, the workspace
// each runs in, and init's pipeline. The last block applies two instances
// with the real tofu, when it is on the path.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import {
  ATMOS_VERSION,
  ATMOS_WRITE,
  atmosInstances,
  atmosWrite,
  detectAtmos,
  effectiveSynth,
  generatedFiles,
  instanceWaves,
  rewriteSources,
  writeInstances,
  atmosDependencies,
  atmosEdges,
  EDGES_FILE,
  fillReads,
  instanceStates,
  parseRead,
  READS_VARFILE,
  readValue,
  SKIPPED_FUNCTIONS,
} from "../src/atmos";
import { rootDependencies } from "../src/detect";
import { checkScript } from "../src/render";
import { stateAccess } from "../src/roles";
import { runStage } from "../src/report/stage";
import { synthAffected } from "../src/synth";
import { validateConfig } from "../src/config";
import { workspaceEnv, workspaceInit, WORKSPACE_FILE } from "../src/backend";
import { applyWave } from "../src/apply";
import { ROOTS_NOT_ATMOS } from "../src/config";
import { init } from "../src/init";
import { release } from "../src/install";
import { git, tmp, write } from "./helpers";

type Obj = Record<string, unknown>;

/** One instance as `atmos describe stacks` prints it. */
const instance = (stack: string, component: string, extra: Obj = {}): Obj => ({
  atmos_component: component,
  atmos_stack: stack,
  backend_type: "s3",
  backend: { bucket: "state", key: "terraform.tfstate", region: "us-east-1", workspace_key_prefix: component },
  component,
  component_info: { component_path: `components/terraform/${component}`, component_type: "terraform" },
  env: {},
  generate: {},
  metadata: {},
  providers: {},
  settings: {},
  stack,
  vars: { stage: stack },
  workspace: stack,
  ...extra,
});

/** The describe output for two stacks, each with vpc and app, app depending on vpc. */
function twoStacks(app: Obj = { dependencies: { components: [{ component: "vpc" }] } }): Obj {
  const out: Obj = {};
  for (const s of ["dev", "prod"]) {
    out[s] = { components: { terraform: { vpc: instance(s, "vpc"), app: instance(s, "app", app) } } };
  }
  return out;
}

/** An `atmos` that prints `json` for describe stacks. */
function stubAtmos(json: Obj): string {
  const dir = tmp("atmos-stub-");
  writeFileSync(join(dir, "describe.json"), JSON.stringify(json));
  const bin = join(dir, "atmos");
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "describe stacks" ] || { echo "unexpected: $*" >&2; exit 2; }\ncat ${JSON.stringify(join(dir, "describe.json"))}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const COMPONENTS = {
  "atmos.yaml": "base_path: .\ncomponents:\n  terraform:\n    base_path: components/terraform\nstacks:\n  base_path: stacks\n",
  "components/terraform/vpc/main.tf": 'variable "stage" {\n  type = string\n}\n\nmodule "tags" {\n  source = "../../../modules/tags"\n}\n\nmodule "local" {\n  source = "./local"\n}\n',
  "components/terraform/vpc/local/main.tf": "",
  "components/terraform/app/main.tf": 'variable "stage" {\n  type = string\n}\n',
  "modules/tags/main.tf": "",
};

describe("detectAtmos", () => {
  it("finds atmos.yaml at the root, and the Atmos write is the synth unless terragucci.yml names one", () => {
    const repo = write(tmp(), { "atmos.yaml": "base_path: .\n" });
    expect(detectAtmos(repo)).toBe("atmos.yaml");
    expect(detectAtmos(tmp())).toBeUndefined();
    expect(effectiveSynth(repo, undefined)).toBe(ATMOS_WRITE);
    expect(effectiveSynth(repo, "make roots")).toBe("make roots");
    expect(effectiveSynth(tmp(), undefined)).toBeUndefined();
  });
});

describe("atmosInstances", () => {
  it("names each instance <stack>/<component>, with its directory, workspace and dependencies", () => {
    const got = atmosInstances(twoStacks());
    expect(got.map((i) => i.path)).toEqual(["dev/app", "dev/vpc", "prod/app", "prod/vpc"]);
    const app = got.find((i) => i.path === "prod/app")!;
    expect(app).toMatchObject({ stack: "prod", component: "app", componentPath: "components/terraform/app", workspace: "prod", backendType: "s3", dependencies: ["prod/vpc"] });
  });

  it("leaves out abstract and disabled instances, and an edge to a disabled one holds nothing back", () => {
    const json = twoStacks();
    const dev = (json.dev as { components: { terraform: Obj } }).components.terraform;
    dev.base = instance("dev", "base", { metadata: { type: "abstract" } });
    dev.vpc = instance("dev", "vpc", { metadata: { enabled: false } });
    const got = atmosInstances(json);
    expect(got.map((i) => i.path)).toEqual(["dev/app", "prod/app", "prod/vpc"]);
    expect(got[0].dependencies).toEqual([]);
  });

  it("reads another stack's instance, settings.depends_on, and a dependency named by context", () => {
    const json = twoStacks({
      dependencies: { components: [{ component: "vpc", stack: "dev" }] },
      settings: { depends_on: { "1": { component: "dns", stage: "dev" } } },
    });
    (json.dev as { components: { terraform: Obj } }).components.terraform.dns = instance("dev", "dns");
    const got = atmosInstances(json);
    expect(got.find((i) => i.path === "prod/app")!.dependencies).toEqual(["dev/dns", "dev/vpc"]);
  });

  it("refuses an edge to an instance no stack deploys, and env it does not carry", () => {
    expect(() => atmosInstances(twoStacks({ dependencies: { components: [{ component: "eks" }] } }))).toThrow("dev/app depends on dev/eks, which no stack deploys");
    expect(() => atmosInstances(twoStacks({ env: { TF_LOG: "debug" } }))).toThrow(/dev\/app sets env/);
  });
});

describe("instanceWaves", () => {
  it("cuts the dependency layers, canary first, and refuses a cycle", () => {
    const i = atmosInstances(twoStacks());
    expect(instanceWaves(i)).toEqual([["dev/vpc", "prod/vpc"], ["dev/app", "prod/app"]]);
    expect(instanceWaves(i, ["dev/*"])).toEqual([["dev/vpc"], ["dev/app"], ["prod/vpc"], ["prod/app"]]);
    const cyc = atmosInstances(twoStacks());
    cyc.find((x) => x.path === "dev/vpc")!.dependencies = ["dev/app"];
    expect(() => instanceWaves(cyc)).toThrow(/cycle/i);
  });

  it("puts every instance in one wave when no instance names a dependency", () => {
    expect(instanceWaves(atmosInstances(twoStacks({})))).toEqual([["dev/app", "dev/vpc", "prod/app", "prod/vpc"]]);
  });
});

describe("the instance directories", () => {
  it("rewrites a local source that leaves the component, and keeps one inside it", () => {
    const text = 'module "a" {\n  source = "../../../modules/tags"\n}\nmodule "b" {\n  source = "./local"\n}\nmodule "c" {\n  source = "hashicorp/x/aws"\n}\n';
    const out = rewriteSources(text, "/r/components/terraform/vpc", "/r/dev/vpc", "/r/components/terraform/vpc");
    expect(out).toContain('source = "../../modules/tags"');
    expect(out).toContain('source = "./local"');
    expect(out).toContain('source = "hashicorp/x/aws"');
  });

  it("writes the component with the varfile, backend, provider override and workspace Atmos would generate", () => {
    const repo = write(tmp(), COMPONENTS);
    const [vpc] = atmosInstances({ dev: { components: { terraform: { vpc: instance("dev", "vpc", { providers: { aws: { region: "us-east-1" } } }) } } } });
    writeInstances(repo, [vpc]);
    const dir = join(repo, "dev/vpc");
    expect(readFileSync(join(dir, "main.tf"), "utf-8")).toContain('source = "../../modules/tags"');
    expect(existsSync(join(dir, "local/main.tf"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "terragucci-atmos.auto.tfvars.json"), "utf-8"))).toEqual({ stage: "dev" });
    expect(JSON.parse(readFileSync(join(dir, "backend.tf.json"), "utf-8"))).toEqual({ terraform: { backend: { s3: { bucket: "state", key: "terraform.tfstate", region: "us-east-1", workspace_key_prefix: "vpc" } } } });
    expect(JSON.parse(readFileSync(join(dir, "providers_override.tf.json"), "utf-8"))).toEqual({ provider: { aws: { region: "us-east-1" } } });
    expect(readFileSync(join(dir, WORKSPACE_FILE), "utf-8")).toBe("dev\n");
    expect(Object.keys(generatedFiles({ ...vpc, backendType: "cloud" }))).toContain("backend.tf.json");
  });

  it("writes an instance again over its own directory, keeping .terraform, and refuses a directory of the repo's", () => {
    const repo = write(tmp(), COMPONENTS);
    const [app] = atmosInstances({ dev: { components: { terraform: { app: instance("dev", "app") } } } });
    writeInstances(repo, [app]);
    write(repo, { "dev/app/.terraform/environment": "dev", "dev/app/stale.tf": "" });
    writeInstances(repo, [app]);
    expect(existsSync(join(repo, "dev/app/.terraform/environment"))).toBe(true);
    expect(existsSync(join(repo, "dev/app/stale.tf"))).toBe(false);
    const other = write(tmp(), { ...COMPONENTS, "dev/app/README.md": "mine" });
    expect(() => writeInstances(other, [app])).toThrow("dev/app is a directory of the repo");
  });

  it("atmos write describes the stacks and writes every instance", async () => {
    const repo = write(tmp(), COMPONENTS);
    const lines = await atmosWrite(repo, { atmos: stubAtmos(twoStacks()) });
    expect(lines).toContain("prod/app: components/terraform/app in workspace prod");
    for (const p of ["dev/vpc", "dev/app", "prod/vpc", "prod/app"]) expect(existsSync(join(repo, p, "main.tf")), p).toBe(true);
  });

  it("says how to get Atmos when it is not on the path", async () => {
    await expect(atmosWrite(write(tmp(), COMPONENTS), { atmos: "/nonexistent/atmos" })).rejects.toThrow(/put Atmos .* on the path, or set TERRAGUCCI_ATMOS/);
  });
});

describe("workspaceEnv", () => {
  it("sets TF_WORKSPACE to the workspace a root names, over the job's, and leaves a plain root alone", () => {
    const dir = write(tmp(), { [WORKSPACE_FILE]: "prod\n" });
    expect(workspaceEnv({ TF_WORKSPACE: "default", A: "1" }, dir)).toEqual({ TF_WORKSPACE: "prod", A: "1" });
    const plain = { A: "1" };
    expect(workspaceEnv(plain, tmp())).toBe(plain);
  });

  it("inits in default and then selects the root's workspace, creating it, with TF_WORKSPACE unset", () => {
    const dir = write(tmp(), { [WORKSPACE_FILE]: "prod\n" });
    expect(workspaceInit({ TF_WORKSPACE: "prod", A: "1" }, dir)).toEqual({
      init: { TF_WORKSPACE: "default", A: "1" },
      select: ["workspace", "select", "-or-create=true", "prod"],
      selectEnv: { A: "1" },
    });
    expect(workspaceInit({ A: "1" }, tmp())).toBeUndefined();
  });
});

describe("init in an Atmos repo", () => {
  const body = (content: string): Record<string, { steps?: { run?: string; name?: string }[] }> =>
    (parseYAML(content.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as { jobs: Record<string, { steps?: { run?: string; name?: string }[] }> }).jobs;

  it("names one root per instance and one wave job per dependency layer, which install Atmos and write the instances", async () => {
    const repo = write(tmp(), { ...COMPONENTS, "terragucci.yml": "forge: forgejo\nbinary: tofu\ngate: always\n" });
    const r = await init(repo, { atmos: stubAtmos(twoStacks()) });
    expect(r.atmos).toEqual({ reason: "atmos.yaml", version: ATMOS_VERSION });
    expect(r.roots).toEqual(["dev/app", "dev/vpc", "prod/app", "prod/vpc"]);
    expect(r.layers).toEqual([["dev/vpc", "prod/vpc"], ["dev/app", "prod/app"]]);
    const jobs = body(r.files[0].content);
    for (const k of ["apply-wave-1", "apply-wave-2"]) {
      const runs = (jobs[k].steps ?? []).map((s) => s.run ?? "").join("\n");
      expect(runs, k).toContain(`terragucci install atmos ${ATMOS_VERSION}`);
      expect(runs, k).toContain(`( set -e; ${ATMOS_WRITE} )`);
      expect(runs, k).toContain("--layers 'dev/vpc,prod/vpc;dev/app,prod/app'");
    }
    expect(jobs["apply-wave-3"]).toBeUndefined();
  });

  it("refuses roots, synth, and a repo that is a Terragrunt repo too", async () => {
    const atmos = stubAtmos(twoStacks());
    await expect(init(write(tmp(), { ...COMPONENTS, "terragucci.yml": "forge: forgejo\nroots: [\"dev/*\"]\n" }), { atmos, dryRun: true })).rejects.toThrow(ROOTS_NOT_ATMOS);
    await expect(init(write(tmp(), { ...COMPONENTS, "terragucci.yml": "forge: forgejo\nsynth: make\n" }), { atmos, dryRun: true })).rejects.toThrow(/remove synth/);
    await expect(init(write(tmp(), { ...COMPONENTS, "root.hcl": "", "terragucci.yml": "forge: forgejo\n" }), { atmos, dryRun: true })).rejects.toThrow(/an Atmos repo or a Terragrunt repo, not both/);
  });
});

describe("install atmos", () => {
  it("fetches the release's Linux binary and checks it against its SHA256SUMS", () => {
    expect(release("atmos", "1.230.1", "arm64")).toEqual({
      url: "https://github.com/cloudposse/atmos/releases/download/v1.230.1/atmos_1.230.1_linux_arm64",
      sums: "https://github.com/cloudposse/atmos/releases/download/v1.230.1/atmos_1.230.1_SHA256SUMS",
      file: "atmos_1.230.1_linux_arm64",
      kind: "binary",
    });
  });
});

const hasTofu = spawnSync("tofu", ["version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasTofu)("two instances of one component, applied with the real tofu", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps each instance's state in its own workspace, never default, and plans no change after the apply", async () => {
    const dir = tmp("atmos-tofu-");
    const work = join(dir, "work");
    mkdirSync(work);
    write(work, {
      "atmos.yaml": "base_path: .\n",
      "components/terraform/vpc/main.tf": 'variable "stage" {\n  type = string\n}\n\nresource "terraform_data" "vpc" {\n  input = var.stage\n}\n',
    });
    // One workspace directory for both, as an S3 bucket is: the second instance's init sees the first's workspace.
    const shared = join(dir, "states");
    const local = (s: string): Obj => instance(s, "vpc", { backend_type: "local", backend: { path: join(shared, "terraform.tfstate"), workspace_dir: shared } });
    writeInstances(work, atmosInstances({ dev: { components: { terraform: { vpc: local("dev") } } }, prod: { components: { terraform: { vpc: local("prod") } } } }));
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { ...process.env, TF_IN_AUTOMATION: "1", TF_WORKSPACE: "default" };
    expect(await applyWave(work, { wave: 1, layers: [["dev/vpc", "prod/vpc"]], binary: "tofu", gate: "never", env })).toBe(0);
    for (const s of ["dev", "prod"]) {
      const state = join(shared, s, "terraform.tfstate");
      expect(existsSync(state), state).toBe(true);
      expect(JSON.parse(readFileSync(state, "utf-8")).resources[0].instances[0].attributes.input.value).toBe(s);
      const plan = execFileSync("tofu", [`-chdir=${join(work, s, "vpc")}`, "plan", "-detailed-exitcode", "-input=false", "-no-color"], { env: { ...process.env, TF_WORKSPACE: s }, encoding: "utf-8" });
      expect(plan).toContain("No changes.");
    }
    expect(existsSync(join(shared, "terraform.tfstate"))).toBe(false);
    expect(out.mock.calls.flat().join("\n")).toMatch(/applied dev\/vpc/);
  });
});

describe("reads: !terraform.state and !terraform.output", () => {
  it("parses a read of the instance's own stack and of another, by output name or a path of keys", () => {
    expect(parseRead("dev/app", "dev", "cidr", "!terraform.state vpc .cidr")).toEqual({ var: "cidr", component: "vpc", stack: "dev", output: ["cidr"], function: "!terraform.state vpc .cidr" });
    expect(parseRead("dev/app", "dev", "ids", '!terraform.output vpc prod ".subnets.private"')).toMatchObject({ component: "vpc", stack: "prod", output: ["subnets", "private"] });
    expect(parseRead("dev/app", "dev", "n", "plain")).toBeUndefined();
    expect(parseRead("dev/app", "dev", "n", { a: 1 })).toBeUndefined();
  });

  it("refuses a store, a function inside a map, and an expression it does not evaluate", () => {
    expect(() => parseRead("dev/app", "dev", "k", "!store ssm vpc cidr")).toThrow(/!store, which terragucci does not read in the job; output the value from an instance and read it with !terraform.state/);
    expect(() => parseRead("dev/app", "dev", "k", { a: ["!terraform.state vpc cidr"] })).toThrow(/inside a map or a list/);
    expect(() => parseRead("dev/app", "dev", "k", '!terraform.state vpc ".cidr // \\"x\\""')).toThrow(/does not evaluate/);
    expect(() => parseRead("dev/app", "dev", "k", "!terraform.state vpc")).toThrow(/<component> \[<stack>\] <output>/);
  });

  it("makes each read's upstream a dependency, and refuses a read of an instance no stack deploys or a disabled one", () => {
    const got = atmosInstances(twoStacks({ vars: { stage: "x", cidr: "!terraform.state vpc prod .cidr" } }));
    const app = got.find((i) => i.path === "dev/app")!;
    expect(app.dependencies).toEqual(["prod/vpc"]);
    expect(app.reads).toEqual([{ var: "cidr", upstream: "prod/vpc", output: ["cidr"], function: "!terraform.state vpc prod .cidr" }]);
    expect(instanceWaves(got)).toEqual([["dev/vpc", "prod/vpc"], ["dev/app", "prod/app"]]);
    expect(() => atmosInstances(twoStacks({ vars: { cidr: "!terraform.state eks .cidr" } }))).toThrow("dev/app reads cidr from dev/eks (!terraform.state eks .cidr), which no stack deploys");
    const off = twoStacks({ vars: { cidr: "!terraform.state vpc .cidr" } });
    (off.dev as { components: { terraform: Obj } }).components.terraform.vpc = instance("dev", "vpc", { metadata: { enabled: false } });
    expect(() => atmosInstances(off)).toThrow(/which is disabled/);
  });

  it("leaves a read's var out of the varfile and writes the edges beside the instance", () => {
    const repo = write(tmp(), COMPONENTS);
    const instances = atmosInstances(twoStacks({ dependencies: { components: [{ component: "vpc" }] }, vars: { stage: "dev", cidr: "!terraform.state vpc .cidr" } }));
    writeInstances(repo, instances);
    expect(JSON.parse(readFileSync(join(repo, "dev/app/terragucci-atmos.auto.tfvars.json"), "utf-8"))).toEqual({ stage: "dev" });
    expect(atmosEdges(join(repo, "dev/app"))).toEqual({ dependencies: ["dev/vpc"], reads: [{ var: "cidr", upstream: "dev/vpc", output: ["cidr"], function: "!terraform.state vpc .cidr" }] });
    expect(existsSync(join(repo, "dev/vpc", EDGES_FILE))).toBe(true);
    // A state read is a root dependency, as terraform_remote_state is; dependencies.components orders without reading state.
    expect([...rootDependencies(repo, ["dev/app", "dev/vpc"]).get("dev/app")!]).toEqual(["dev/vpc"]);
    expect([...atmosDependencies(repo, ["dev/app", "prod/app"]).get("prod/app")!]).toEqual(["prod/vpc"]);
  });

  it("asks describe to skip the functions that need a credential", async () => {
    const dir = tmp("atmos-args-");
    const bin = join(dir, "atmos");
    writeFileSync(join(dir, "describe.json"), JSON.stringify(twoStacks()));
    writeFileSync(bin, `#!/bin/sh\necho "$@" > ${JSON.stringify(join(dir, "args"))}\ncat ${JSON.stringify(join(dir, "describe.json"))}\n`);
    chmodSync(bin, 0o755);
    await atmosWrite(write(tmp(), COMPONENTS), { atmos: bin });
    const args = readFileSync(join(dir, "args"), "utf-8");
    for (const f of SKIPPED_FUNCTIONS) expect(args).toContain(`--skip ${f}`);
  });

  it("reads a value by output and keys", () => {
    expect(readValue({ cidr: "10.0.0.0/16" }, ["cidr"])).toEqual({ value: "10.0.0.0/16" });
    expect(readValue({ net: { private: ["a"] } }, ["net", "private"])).toEqual({ value: ["a"] });
    expect(readValue({}, ["cidr"])).toBeUndefined();
    expect(readValue({ net: "x" }, ["net", "private"])).toBeUndefined();
    expect(readValue({ cidr: null }, ["cidr"])).toEqual({ value: null });
  });

  it("fills the reads from the upstream's outputs, and waits, writing nothing, while it has none", async () => {
    const repo = write(tmp(), COMPONENTS);
    writeInstances(repo, atmosInstances(twoStacks({ vars: { stage: "dev", cidr: "!terraform.state vpc .cidr" } })));
    const none = await fillReads(repo, "dev/app", async () => ({ outputs: {} }));
    expect(none.waiting.map((w) => [w.read.upstream, w.why])).toEqual([["dev/vpc", "has no state yet"]]);
    expect(existsSync(join(repo, "dev/app", READS_VARFILE))).toBe(false);
    const other = await fillReads(repo, "dev/app", async () => ({ outputs: { id: "x" } }));
    expect(other.waiting[0].why).toBe("has no output cidr yet");
    const bad = await fillReads(repo, "dev/app", async () => ({ error: "init failed" }));
    expect(bad.errors[0]).toMatch(/dev\/app reads cidr from dev\/vpc, whose state could not be read: init failed/);
    const seen: string[] = [];
    const ok = await fillReads(repo, "dev/app", async (up) => (seen.push(up), { outputs: { cidr: "10.1.0.0/16" } }));
    expect(ok.filled).toEqual(["cidr"]);
    expect(seen).toEqual(["dev/vpc"]);
    expect(JSON.parse(readFileSync(join(repo, "dev/app", READS_VARFILE), "utf-8"))).toEqual({ cidr: "10.1.0.0/16" });
    expect(await fillReads(repo, "dev/vpc", async () => ({ outputs: {} }))).toEqual({ waiting: [], errors: [], filled: [] });
  });
});

describe("affected instances", () => {
  it("plans a changed instance and the instances that depend on it, and leaves the other stack alone", async () => {
    const repo = write(tmp(), COMPONENTS);
    const instances = atmosInstances(twoStacks());
    // The synth: write the instances, prod/vpc's var as the commit's stacks/prod.txt says.
    write(repo, { "stacks/prod.txt": "10.0.0.0/16\n", "write.mjs": writer(instances) });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    write(repo, { "stacks/prod.txt": "10.9.0.0/16\n" });
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "change prod");
    execFileSync("node", ["write.mjs"], { cwd: repo });
    const roots = instances.map((i) => i.path);
    const logs: string[] = [];
    const got = await synthAffected(repo, "HEAD~1", "node write.mjs", roots, rootDependencies(repo, roots), process.env, (l) => logs.push(l), atmosDependencies(repo, roots));
    expect([...got.selected!].sort()).toEqual(["prod/app", "prod/vpc"]);
    expect(logs).toContain("affected: prod/app depends on prod/vpc");
    const without = await synthAffected(repo, "HEAD~1", "node write.mjs", roots, rootDependencies(repo, roots), process.env, () => {});
    expect([...without.selected!]).toEqual(["prod/vpc"]);
  });
});

/** A synth script that writes `instances` as terragucci atmos write would, prod/vpc's cidr read from stacks/prod.txt. */
function writer(instances: ReturnType<typeof atmosInstances>): string {
  const files = Object.fromEntries(instances.map((i) => [i.path, generatedFiles(i)]));
  return [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    `const files = ${JSON.stringify(files)};`,
    'files["prod/vpc"]["terragucci-atmos.auto.tfvars.json"] = JSON.stringify({ cidr: readFileSync("stacks/prod.txt", "utf-8").trim() });',
    "for (const [dir, f] of Object.entries(files)) { mkdirSync(dir, { recursive: true }); for (const [n, c] of Object.entries(f)) writeFileSync(`${dir}/${n}`, c); }",
  ].join("\n");
}

describe("the check job, the Atmos version and per-stack roles", () => {
  it("validates the stacks before the instances are written", () => {
    const script = checkScript("tofu", ["dev/vpc"], ATMOS_WRITE, false, false, true);
    expect(script.indexOf("atmos validate stacks")).toBeGreaterThan(-1);
    expect(script.indexOf("atmos validate stacks")).toBeLessThan(script.indexOf(ATMOS_WRITE));
    expect(checkScript("tofu", ["a"], undefined)).not.toContain("atmos validate");
  });

  it("installs the release terragucci.yml names, refuses one that is no release, and an atmos block outside an Atmos repo", async () => {
    const repo = write(tmp(), { ...COMPONENTS, "terragucci.yml": "forge: forgejo\nbinary: tofu\natmos:\n  version: 1.229.0\n" });
    const r = await init(repo, { atmos: stubAtmos(twoStacks()), dryRun: true });
    expect(r.atmos?.version).toBe("1.229.0");
    expect(r.files[0].content).toContain("terragucci install atmos 1.229.0");
    expect(() => validateConfig({ atmos: { version: "latest" } }, "terragucci.yml")).toThrow(/atmos.version must be a release version/);
    expect(() => validateConfig({ atmos: { image: "x" } }, "terragucci.yml")).toThrow(/atmos.image is not a setting/);
    expect(() => validateConfig({ atmos: {}, terragrunt: {} }, "terragucci.yml")).toThrow(/an Atmos repo or a Terragrunt repo, not both/);
    await expect(init(write(tmp(), { "main.tf": "", "terragucci.yml": "forge: forgejo\natmos:\n  version: 1.229.0\n" }), { dryRun: true })).rejects.toThrow("terragucci.yml has an atmos block, but the repo has no atmos.yaml at its root");
  });

  it("gives each stack its roles by glob, and lists each role's states as Atmos lays them out", () => {
    const instances = atmosInstances(twoStacks({ vars: { cidr: "!terraform.state vpc prod .cidr" } }));
    const oidc = { roles: { "dev/*": { plan: "dev-plan", apply: "dev-apply" }, "prod/*": { plan: "prod-plan", apply: "prod-apply" } } };
    const access = stateAccess(tmp(), instances.map((i) => i.path), oidc, { ...instanceStates(instances), via: "!terraform.state" });
    const devApply = access.roles.find((r) => r.role === "dev-apply")!;
    expect(devApply.roots).toEqual(["dev/app", "dev/vpc"]);
    expect(devApply.states).toEqual(["s3://state/app/dev/terraform.tfstate", "s3://state/vpc/dev/terraform.tfstate"]);
    expect(access.warnings.join("\n")).toContain("oidc: dev/app (dev/*) reads the state of prod/vpc (prod/*) through !terraform.state");
  });
});

describe.skipIf(!hasTofu)("a read of an unapplied upstream, with the real tofu", () => {
  afterEach(() => vi.restoreAllMocks());

  it("holds the reader back until the upstream applies, then plans and applies it on the upstream's output", async () => {
    const dir = tmp("atmos-read-");
    const work = join(dir, "work");
    mkdirSync(work);
    write(work, {
      "atmos.yaml": "base_path: .\n",
      "components/terraform/vpc/main.tf": 'variable "cidr" {\n  type = string\n}\n\nresource "terraform_data" "vpc" {\n  input = var.cidr\n}\n\noutput "cidr" {\n  value = var.cidr\n}\n',
      "components/terraform/app/main.tf": 'variable "vpc_cidr" {\n  type     = string\n  nullable = true\n}\n\nresource "terraform_data" "app" {\n  input = { vpc = var.vpc_cidr }\n}\n',
    });
    const shared = join(dir, "states");
    const local = (c: string, vars: Obj): Obj => instance("dev", c, { backend_type: "local", backend: { path: join(shared, `${c}.tfstate`), workspace_dir: join(shared, c) }, vars });
    writeInstances(work, atmosInstances({ dev: { components: { terraform: { vpc: local("vpc", { cidr: "10.4.0.0/16" }), app: local("app", { vpc_cidr: "!terraform.state vpc .cidr" }) } } } }));
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    const env = { ...process.env, TF_IN_AUTOMATION: "1" } as Record<string, string>;
    const layers = [["dev/vpc"], ["dev/app"]];
    const logs: string[] = [];
    const first = await runStage("tf-plan", work, { binary: "tofu", layers, out: join(dir, "plan1"), env }, (l) => logs.push(l));
    expect(logs.join("\n")).toMatch(/dev\/app: held back, dev\/vpc has no state yet/);
    expect(first.report.deferred?.map((d) => [d.unit, d.after])).toEqual([["dev/app", ["dev/vpc"]]]);
    expect(first.report.roots.map((r) => r.path)).toEqual(["dev/vpc"]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { wave: 1, layers, binary: "tofu", gate: "never", env })).toBe(0);
    expect(await applyWave(work, { wave: 2, layers, binary: "tofu", gate: "never", env })).toBe(0);
    const file = (readdirSync(join(shared, "app"), { recursive: true }) as string[]).find((f) => f.startsWith("dev") && f.endsWith(".tfstate"));
    expect(file, "dev/app's state in its workspace").toBeDefined();
    const app = JSON.parse(readFileSync(join(shared, "app", file!), "utf-8"));
    expect(app.resources[0].instances[0].attributes.input.value).toEqual({ vpc: "10.4.0.0/16" });
  });
});
