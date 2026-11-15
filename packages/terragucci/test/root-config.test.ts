// Backend config and var files per root, and one directory run as several roots.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { describe, expect, it } from "vitest";
import { validateConfig, resolveRepo } from "../src/config";
import { planSettings, outsideWatch, settingsChanged } from "../src/affected";
import { applyLayers, findRoots, remoteStateReads, rootStates, stateOf } from "../src/detect";
import { configSchema, configSchemaProblems } from "../src/config-schema";
import { convert } from "../src/import";
import { plan } from "../src/plan";
import { rootConfigOf, rootDir, rootInputs, rootInputsEnv, rootPath, rootsInputProblems, splitRoot } from "../src/root-config";
import { detectShape } from "../src/shape";
import { wavesStepSpec } from "../src/chant-waves";
import { tmp, write } from "./helpers";

const s3 = (extra = ""): string => `terraform {\n  backend "s3" {\n    bucket = "code-bucket"\n    key    = "PLACEHOLDER"\n${extra}  }\n}\nresource "terraform_data" "x" {}\n`;

/** One directory, two instances with their own backend file and var file, and a second root that reads the canary's state. */
function estate(config: string): string {
  return write(tmp(), {
    "terragucci.yml": config,
    "prow/main.tf": s3(),
    "prow/tfbackends/canary.tfbackend": 'key = "prow/canary.tfstate"\n',
    "prow/tfbackends/prod.tfbackend": 'key = "prow/prod.tfstate"\nbucket = "prod-bucket"\n',
    "prow/canary.tfvars": 'size = "small"\n',
    "prow/prod.tfvars": 'size = "large"\n',
    "dash/main.tf": `terraform {\n  backend "s3" {\n    bucket = "code-bucket"\n    key = "dash.tfstate"\n  }\n}\ndata "terraform_remote_state" "prow" {\n  backend = "s3"\n  config = {\n    bucket = "code-bucket"\n    key = "prow/canary.tfstate"\n  }\n}\n`,
  });
}

const INSTANCES = `instances:
  prow: [canary, prod]
backend_config:
  "prow@canary": tfbackends/canary.tfbackend
  "prow@prod": tfbackends/prod.tfbackend
var_files:
  "prow@canary": [canary.tfvars]
  "prow@prod": prod.tfvars
`;

describe("the three keys in terragucci.yml", () => {
  it("are settings, and the schema agrees with config check", () => {
    const config = validateConfig(parseYAML(INSTANCES), "terragucci.yml");
    expect(config.instances).toEqual({ prow: ["canary", "prod"] });
    expect(configSchemaProblems(config)).toEqual([]);
    expect(Object.keys((configSchema().properties as object))).toEqual(expect.arrayContaining(["backend_config", "var_files", "instances"]));
  });

  it("refuse a value that is not a glob map of files, and an instances entry that is not a directory with two names", () => {
    const bad = (doc: object): string => {
      try {
        validateConfig(doc, "terragucci.yml");
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(bad({ backend_config: ["a"] })).toContain("backend_config must map a root glob to a file");
    expect(bad({ var_files: { "a/*": [] } })).toContain("var_files");
    expect(bad({ var_files: { "a/*": 3 } })).toContain("must be a file or a list of files");
    expect(bad({ instances: { prow: ["only"] } })).toContain("at least two different names");
    expect(bad({ instances: { prow: ["a", "a"] } })).toContain("at least two different names");
    expect(bad({ instances: { "prow/*": ["a", "b"] } })).toContain("one root directory");
    expect(bad({ instances: { prow: ["a b", "c"] } })).toContain("at least two different names");
  });

  it("are refused beside waves.compose and ephemeral, and instances beside generate and rollouts", () => {
    const msg = (doc: object): string => {
      try {
        validateConfig(doc, "terragucci.yml");
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(msg({ var_files: { a: "x.tfvars" }, waves: { compose: true } })).toContain("a composed run");
    expect(msg({ backend_config: { a: "x.hcl" }, ephemeral: { roots: ["a"] } })).toContain("ephemeral copy");
    expect(msg({ instances: { a: ["x", "y"] }, rollouts: "0 4 * * *" })).toContain("a rollout");
    expect(msg({ instances: { a: ["x", "y"] }, generate: { backend: { type: "s3", config: { bucket: "b" } } } })).toContain("generate writes");
  });

  it("are refused in a Terragrunt repo and an Atmos repo, worded for each", () => {
    const repo = write(tmp(), { "root.hcl": "", "live/a/terragrunt.hcl": "" });
    const settings = resolveRepo({ var_files: { "live/*": "x.tfvars" }, instances: { "live/a": ["x", "y"] } });
    const problems = detectShape(repo, settings).problems("config");
    expect(problems.some((p) => p.startsWith("config.backend_config") || p.includes("remote_state"))).toBe(true);
    expect(problems.some((p) => p.startsWith("config.instances"))).toBe(true);
  });
});

describe("a root's files and its directory", () => {
  it("a glob matches a root, a directory's glob reaches its instances, and files collect in the file's order", () => {
    const repo = estate(INSTANCES);
    expect(rootInputs(repo, "prow@canary")).toEqual({ backendConfig: ["tfbackends/canary.tfbackend"], varFiles: ["canary.tfvars"] });
    expect(rootInputs(repo, "prow@prod").varFiles).toEqual(["prod.tfvars"]);
    expect(rootInputs(repo, "dash")).toEqual({ backendConfig: [], varFiles: [] });
    const shared = write(tmp(), { "terragucci.yml": "instances:\n  prow: [a, b]\nvar_files:\n  prow: base.tfvars\n  prow@b: more.tfvars\n  '*': any.tfvars\n", "prow/main.tf": s3() });
    expect(rootInputs(shared, "prow@a").varFiles).toEqual(["base.tfvars", "any.tfvars"]);
    expect(rootInputs(shared, "prow@b").varFiles).toEqual(["base.tfvars", "more.tfvars", "any.tfvars"]);
  });

  it("an instance runs in its directory, and a name that is not declared is a directory", () => {
    const repo = estate(INSTANCES);
    expect(splitRoot(repo, "prow@canary")).toEqual({ dir: "prow", instance: "canary" });
    expect(rootDir(repo, "prow@other")).toBe("prow@other");
    expect(rootDir(repo, "dash")).toBe("dash");
    expect(rootPath(repo, "prow@prod")).toBe(join(repo, "prow"));
    expect(rootConfigOf(repo).instances).toEqual({ prow: ["canary", "prod"] });
  });

  it("the roots found are the instances, not their directory", () => {
    const repo = estate(INSTANCES);
    expect(findRoots(repo)).toEqual(["dash", "prow@canary", "prow@prod"]);
    expect(findRoots(repo, ["prow"])).toEqual(["prow@canary", "prow@prod"]);
  });
});

describe("the environment a root's binary runs with", () => {
  it("init takes the backend files with -reconfigure and plan the var files, after what env already set", () => {
    const repo = estate(INSTANCES);
    const env = rootInputsEnv(repo, "prow@canary", { TF_CLI_ARGS_init: "-no-color", PATH: "/bin" });
    expect(env.TF_CLI_ARGS_init).toBe("-no-color -reconfigure -backend-config=tfbackends/canary.tfbackend");
    expect(env.TF_CLI_ARGS_plan).toBe("-var-file=canary.tfvars");
    expect(env.PATH).toBe("/bin");
  });

  it("an instance has a data directory of its own, and a plain root with no settings is left as it is", () => {
    const repo = estate(INSTANCES);
    expect(rootInputsEnv(repo, "prow@prod", {}).TF_DATA_DIR).toBe(join(".terraform", "instances", "prod"));
    const env = { A: "1" };
    expect(rootInputsEnv(repo, "dash", env)).toBe(env);
  });

  it("a path with a space is one word", () => {
    const repo = write(tmp(), { "terragucci.yml": 'var_files:\n  a: "my vars.tfvars"\n', "a/main.tf": s3() });
    expect(rootInputsEnv(repo, "a", {}).TF_CLI_ARGS_plan).toBe('-var-file="my vars.tfvars"');
  });

  it("asks for the data directory alone when the run passes the files itself", () => {
    const repo = estate(INSTANCES);
    const env = rootInputsEnv(repo, "prow@canary", {}, false);
    expect(env.TF_CLI_ARGS_init).toBeUndefined();
    expect(env.TF_CLI_ARGS_plan).toBeUndefined();
    expect(env.TF_DATA_DIR).toBeDefined();
  });

  it("the shape hands the same values to init, to plan and to a root that names a workspace", () => {
    const repo = estate(INSTANCES);
    const shape = detectShape(repo, resolveRepo({ instances: { prow: ["canary", "prod"] } }));
    expect(shape.rootEnv("prow@prod", {}).TF_CLI_ARGS_plan).toBe("-var-file=prod.tfvars");
    expect(shape.initEnv("prow@prod", {}).TF_CLI_ARGS_init).toContain("-backend-config=tfbackends/prod.tfbackend");
    expect(shape.rootInit("prow@prod", {})).toBeUndefined();
    write(repo, { "prow/.terragucci-workspace": "blue\n" });
    const ws = shape.rootInit("prow@prod", {})!;
    expect(ws.init.TF_WORKSPACE).toBe("default");
    expect(ws.init.TF_CLI_ARGS_init).toContain("-backend-config=tfbackends/prod.tfbackend");
    expect(ws.selectEnv.TF_CLI_ARGS_init).toBeUndefined();
    expect(shape.initEnv("prow@prod", {}).TF_CLI_ARGS_init).toContain("-reconfigure");
  });
});

describe("where each root keeps its state", () => {
  it("the files give a placeholder backend its key, and each instance has a state of its own", () => {
    const repo = estate(INSTANCES);
    expect(stateOf(repo, "prow@canary").own).toEqual({ bucket: "code-bucket", key: "prow/canary.tfstate" });
    expect(stateOf(repo, "prow@prod").own).toEqual({ bucket: "prod-bucket", key: "prow/prod.tfstate" });
    const states = rootStates(repo, ["prow@canary", "prow@prod", "dash"]);
    expect(states.get("prow@canary")?.state).toEqual({ bucket: "code-bucket", key: "prow/canary.tfstate" });
    expect(states.get("prow@prod")?.state?.bucket).toBe("prod-bucket");
  });

  it("a root that reads one instance's state is ordered after that instance and not the other", () => {
    const repo = estate(INSTANCES);
    const roots = ["prow@canary", "prow@prod", "dash"];
    expect(remoteStateReads(repo, roots).get("dash")).toEqual([{ name: "prow", upstream: "prow@canary", repeated: false }]);
    expect(applyLayers(repo, roots)).toEqual([["prow@canary", "prow@prod"], ["dash"]]);
  });

  it("a root with a placeholder key and no file has the placeholder's state, as before", () => {
    const repo = write(tmp(), { "a/main.tf": s3() });
    expect(stateOf(repo, "a").own).toEqual({ bucket: "code-bucket", key: "PLACEHOLDER" });
  });

  it("a backend_config file on a plain root is read as init reads it", () => {
    const repo = write(tmp(), { "terragucci.yml": "backend_config:\n  'envs/*': atlantis.config\n", "envs/a/main.tf": s3(), "envs/a/atlantis.config": 'key = "envs/a.tfstate"\n' });
    expect(stateOf(repo, "envs/a").own).toEqual({ bucket: "code-bucket", key: "envs/a.tfstate" });
  });
});

describe("discovery", () => {
  it("lists the instances, orders them by waves.canary and waves.after, and refuses a directory that is no root", async () => {
    const repo = estate(INSTANCES);
    const found = await detectShape(repo, resolveRepo({ waves: { canary: ["prow@canary"], after: { "prow@prod": ["prow@canary"] } } })).discover();
    expect(found.roots.map((r) => r.root)).toEqual(["dash", "prow@canary", "prow@prod"]);
    expect(found.layers).toEqual([["prow@canary"], ["dash", "prow@prod"]]);
    expect(found.roots.find((r) => r.root === "prow@prod")?.reason).toContain("instance prod of prow");
    const missing = write(tmp(), { "terragucci.yml": "instances:\n  nowhere: [a, b]\n", "x/main.tf": s3() });
    await expect(detectShape(missing, resolveRepo({})).discover()).rejects.toThrow("instances names nowhere");
  });

  it("config check's reading of the roots names a glob that matches nothing and a file that is not there", () => {
    const repo = estate(INSTANCES);
    expect(rootsInputProblems(repo, rootConfigOf(repo), findRoots(repo))).toEqual([]);
    const bad = write(tmp(), { "terragucci.yml": "var_files:\n  'nope/*': a.tfvars\n  prow: missing.tfvars\nbackend_config:\n  prow: tfbackends/none.tfbackend\n", "prow/main.tf": s3() });
    const problems = rootsInputProblems(bad, rootConfigOf(bad), findRoots(bad));
    expect(problems).toContain('var_files: "nope/*" matches no root');
    expect(problems.join("\n")).toContain("var_files: prow names missing.tfvars, which is not a file relative to prow");
    expect(problems.join("\n")).toContain("backend_config: prow names tfbackends/none.tfbackend");
  });
});

describe("what a change reaches", () => {
  it("a plan setting that changes which files a root names reaches that root alone", () => {
    const head = resolveRepo(parseYAML(INSTANCES) as never);
    const base = resolveRepo({ ...(parseYAML(INSTANCES) as object), var_files: { "prow@canary": ["canary.tfvars"], "prow@prod": ["old.tfvars"] } } as never);
    expect([...settingsChanged(base, head, ["prow@canary", "prow@prod", "dash"])]).toEqual([["prow@prod", ["inputs"]]]);
    expect(planSettings(head, "dash").inputs).toBeUndefined();
  });

  it("a file a root names is watched, and the instance's code is its directory's", () => {
    const repo = estate(INSTANCES);
    const watch = outsideWatch(repo, ["prow@canary", "prow@prod", "dash"], {});
    expect(watch["prow@canary"]).toEqual(["tfbackends/canary.tfbackend", "canary.tfvars"]);
    expect(watch["prow@prod"]).toEqual(["tfbackends/prod.tfbackend", "prod.tfvars"]);
    expect(watch.dash).toBeUndefined();
  });
});

describe("the apply's step", () => {
  it("an instance's run names its directory, so the step plans there", () => {
    const spec = wavesStepSpec({ waves: [["prow@canary", "dash"]], gate: "always", approval: "ledger", call: () => ["x"], migrations: false, dirs: { "prow@canary": "prow" } } as never) as { waves: { runs: { target: string; input?: { dir?: string } }[] }[] };
    const runs = spec.waves[0]!.runs;
    expect(runs.find((r) => r.target === "prow@canary")?.input).toEqual({ dir: "prow" });
    expect(runs.find((r) => r.target === "dash")?.input).toBeUndefined();
  });

});

describe("terragucci plan", () => {
  /** A binary that records the directory, the data directory and the init and plan arguments it was given. */
  function recorder(): { dir: string; log: string } {
    const dir = tmp("recorder-");
    const log = join(dir, "log");
    // The engine runner puts the directory in -chdir, so the subcommand is the second word.
    writeFileSync(join(dir, "tofu"), `#!/bin/sh\nd=\${1#-chdir=}\necho "$2 dir=$(basename "$d") data=$TF_DATA_DIR init=$TF_CLI_ARGS_init plan=$TF_CLI_ARGS_plan" >> ${JSON.stringify(log)}\n[ "$2" = plan ] && echo "No changes. Your infrastructure matches the configuration."\nexit 0\n`);
    chmodSync(join(dir, "tofu"), 0o755);
    return { dir, log };
  }

  it("inits and plans each instance in the directory with its own files and data directory", async () => {
    const repo = estate(`binary: tofu\n${INSTANCES}`);
    const { dir, log } = recorder();
    const was = process.env.PATH;
    process.env.PATH = `${dir}:${was}`;
    try {
      const results = await plan(repo, { root: "prow@*" }, () => {});
      expect(results.map((r) => [r.root, r.ok, r.summary])).toEqual([["prow@canary", true, "No changes. Your infrastructure matches the configuration."], ["prow@prod", true, "No changes. Your infrastructure matches the configuration."]]);
    } finally {
      process.env.PATH = was;
    }
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toEqual([
      "init dir=prow data=.terraform/instances/canary init=-reconfigure -backend-config=tfbackends/canary.tfbackend plan=-var-file=canary.tfvars",
      "plan dir=prow data=.terraform/instances/canary init=-reconfigure -backend-config=tfbackends/canary.tfbackend plan=-var-file=canary.tfvars",
      "init dir=prow data=.terraform/instances/prod init=-reconfigure -backend-config=tfbackends/prod.tfbackend plan=-var-file=prod.tfvars",
      "plan dir=prow data=.terraform/instances/prod init=-reconfigure -backend-config=tfbackends/prod.tfbackend plan=-var-file=prod.tfvars",
    ]);
  });
});

describe("terragucci import atlantis", () => {
  const doc = (extra: string): unknown =>
    parseYAML(`version: 3
projects:
- name: net
  dir: envs/net
  workflow: wf
- name: shared
  dir: envs/shared
  workflow: wf
${extra}
workflows:
  wf:
    plan:
      steps:
      - init:
          extra_args: ["-backend-config=atlantis.config"]
      - plan:
          extra_args: ["-var-file=atlantis.tfvars", "-lock=false"]
`);

  it("writes backend_config and var_files from the workflow's init and plan extra_args, and keeps the other flags left out", () => {
    const { settings, notes } = convert("atlantis", doc(""));
    expect(settings.backend_config).toEqual({ "envs/net": ["atlantis.config"], "envs/shared": ["atlantis.config"] });
    expect(settings.var_files).toEqual({ "envs/net": ["atlantis.tfvars"], "envs/shared": ["atlantis.tfvars"] });
    expect(settings.instances).toBeUndefined();
    expect(notes.find((n) => n.key === "workflows.wf.plan.steps[0].init.extra_args")).toMatchObject({ kind: "mapped", row: "Backend config and var files" });
    expect(notes.find((n) => n.key === "workflows.wf.plan.steps[1].plan.extra_args" && n.kind === "left-out")).toMatchObject({ row: "Flags at run time" });
  });

  it("takes the two-word form, and leaves a key=value pair, an absolute path and a variable out", () => {
    const parsed = parseYAML(`projects:
- dir: a
  workflow: wf
workflows:
  wf:
    plan:
      steps:
      - init:
          extra_args: ["-backend-config", "x.hcl", "-backend-config=bucket=b", "-backend-config=/etc/x.hcl", "-backend-config=$DIR/y.hcl"]
`);
    const { settings, notes } = convert("atlantis", parsed);
    expect(settings.backend_config).toEqual({ a: ["x.hcl"] });
    expect(notes.find((n) => n.kind === "left-out")?.row).toBe("Flags at run time");
  });

  it("projects that share a directory, each with a name and different files, become instances", () => {
    const parsed = parseYAML(`projects:
- name: canary
  dir: prow
  workflow: canary
- name: prod
  dir: prow
  workflow: prod
workflows:
  canary:
    plan:
      steps:
      - init:
          extra_args: ["-backend-config=tfbackends/canary.tfbackend"]
      - plan:
          extra_args: ["-var-file=canary.tfvars"]
  prod:
    plan:
      steps:
      - init:
          extra_args: ["-backend-config=tfbackends/prod.tfbackend"]
      - plan:
          extra_args: ["-var-file=prod.tfvars"]
`);
    const { settings } = convert("atlantis", parsed);
    expect(settings.instances).toEqual({ prow: ["canary", "prod"] });
    expect(settings.backend_config).toEqual({ "prow@canary": ["tfbackends/canary.tfbackend"], "prow@prod": ["tfbackends/prod.tfbackend"] });
    expect(settings.var_files).toEqual({ "prow@canary": ["canary.tfvars"], "prow@prod": ["prod.tfvars"] });
    expect(settings.roots).toEqual(["prow"]);
  });

  it("projects that share a directory and pass the same files stay one root, and a workspace keeps its note", () => {
    const { settings, notes } = convert("atlantis", doc("- name: blue\n  dir: envs/net\n  workspace: blue\n  workflow: wf"));
    expect(settings.instances).toBeUndefined();
    expect(settings.backend_config?.["envs/net"]).toEqual(["atlantis.config"]);
    expect(notes.find((n) => n.key === "projects[blue].workspace")).toMatchObject({ kind: "unmapped", row: "Workspace" });
  });

  it("what an import writes passes config check", () => {
    const { settings } = convert("atlantis", doc(""));
    expect(() => validateConfig(settings, "terragucci.yml")).not.toThrow();
    expect(readFileSync(new URL("../src/import/guide.ts", import.meta.url), "utf-8")).toContain("Backend config and var files");
  });
});
