// Terragrunt mode: detection, discovery, waves, the auth provider, init's
// pipeline and the tf-plan stage. Terragrunt itself is stubbed; the last block
// runs the real binary when TERRAGUCCI_TERRAGRUNT names one and tofu is on the path.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { ROOTS_NOT_TERRAGRUNT } from "../src/config";
import { init } from "../src/init";
import type { PolicyExec } from "../src/report/policy";
import { runStage } from "../src/report/stage";
import {
  authProviderOutput,
  detectTerragrunt,
  discoverUnits,
  parallelism,
  pinnedTerragrunt,
  literalDependencies,
  refineWaves,
  stackOfUnit,
  unitStack,
  unitWaves,
  walkUnits,
} from "../src/terragrunt";
import { explicitStacksLine } from "../src/report/views";
import type { Report } from "../src/report/schema";
import { rc } from "./report-fixtures";
import { git, tmp, write } from "./helpers";

const unit = (deps: string[] = []): string =>
  [
    'include "root" { path = find_in_parent_folders("root.hcl") }',
    'terraform { source = "../../../modules/thing" }',
    ...deps.map((d) => `dependency "${d}" {\n  config_path  = "../${d}"\n  mock_outputs = { id = "mock" }\n}`),
    "",
  ].join("\n");

const ROOT_HCL = 'remote_state {\n  backend = "s3"\n  config  = { bucket = "state", key = "${path_relative_to_include()}/tf.tfstate" }\n}\n';

/** A Gruntwork-style live repo: two environments, a vpc and an app reading it, a catalog template and a module. */
function liveRepo(extra: Record<string, string> = {}): string {
  const repo = write(tmp(), {
    "root.hcl": ROOT_HCL,
    "live/dev/vpc/terragrunt.hcl": unit(),
    "live/dev/app/terragrunt.hcl": unit(["vpc"]),
    "live/prod/vpc/terragrunt.hcl": unit(),
    "live/prod/app/terragrunt.hcl": unit(["vpc"]),
    "catalog/units/thing/terragrunt.hcl": unit(),
    "modules/thing/main.tf": 'variable "name" { default = "x" }\nresource "terraform_data" "this" { input = var.name }\n',
    ...extra,
  });
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "https://github.com/acme/live.git");
  return repo;
}

const FIND = JSON.stringify([
  { type: "unit", path: "live/dev/vpc" },
  { type: "unit", path: "live/prod/vpc" },
  { type: "unit", path: "live/dev/app", dependencies: ["live/dev/vpc"] },
  { type: "unit", path: "live/prod/app", dependencies: ["live/prod/vpc"] },
]);

const argOf = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

interface FakeOptions {
  fail?: string[];
  calls?: string[][];
  /** Units whose upstream has no outputs: each maps to the upstream it reads. */
  noOutputs?: Record<string, string>;
  /** What Terragrunt's git filter selects, and the files git says changed. */
  affected?: { selected: string[]; files: string[] };
  /** Each unit's `Started` and `Ended` in the run report, as Terragrunt writes them. */
  times?: Record<string, [string, string]>;
  /** Run `TG_TF_PATH plan ... -out=<out-dir>/<unit>/tfplan.tfplan` in each unit's directory, as Terragrunt does. */
  runBinary?: boolean;
}

/** Run a file and wait for it without blocking, so the stage's span receiver can answer it. */
const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((done, fail) => execFile(file, args, { cwd, env }, (err, _out, stderr) => (err ? fail(new Error(`${file}: ${stderr || err.message}`)) : done())));

/** A stand-in for terragrunt 1.1.6 and git: version, find, render, output, a plan that writes each unit's plan and report row, and diff. */
function fakeTerragrunt(opts: FakeOptions = {}): TerragruntExec {
  return async (file, args, options) => {
    opts.calls?.push([...args]);
    if (file === "git") return { code: 0, stdout: (opts.affected?.files ?? []).join("\n"), stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") {
      if (args.some((a) => a.startsWith("["))) return { code: 0, stdout: JSON.stringify((opts.affected?.selected ?? []).map((path) => ({ type: "unit", path }))), stderr: "" };
      return { code: 0, stdout: FIND, stderr: "" };
    }
    if (args[0] === "render") {
      const unit = argOf(args, "--working-dir")!;
      const up = opts.noOutputs?.[unit];
      const dependency = up ? { platform: { config_path: `../${up.split("/").pop()}`, mock_outputs: { id: "mock" }, mock_outputs_allowed_terraform_commands: ["validate", "plan"] } } : {};
      return { code: 0, stdout: JSON.stringify({ dependency }), stderr: "" };
    }
    if (args.includes("output")) {
      const unit = argOf(args, "--working-dir")!;
      const empty = Object.values(opts.noOutputs ?? {}).includes(unit);
      return { code: 0, stdout: empty ? "{}" : JSON.stringify({ id: { value: `${unit}-id` } }), stderr: "" };
    }
    const refresh = args.includes("-refresh-only");
    const units = args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith("{./") ? [a.slice(3, -1)] : []));
    const out = argOf(args, "--out-dir")!;
    const json = argOf(args, "--json-out-dir")!;
    if (opts.runBinary) {
      const tf = args.slice(args.indexOf("--") + 1);
      for (const u of units) await run(options.env.TG_TF_PATH, [...tf, "-input=false", `-out=${join(out, u, "tfplan.tfplan")}`], join(options.cwd, u), { ...process.env, ...options.env });
    }
    const rows = units.map((u) => {
      const at = opts.times?.[u] ? { Started: opts.times[u][0], Ended: opts.times[u][1] } : {};
      if (opts.fail?.includes(u)) return { Name: u, Result: "failed", Reason: "run error", Cause: "Error: boom", ...at };
      for (const [dir, f, body] of [
        [out, "tfplan.tfplan", "binary"],
        [json, "tfplan.json", JSON.stringify(refresh
          ? { format_version: "1.2", resource_changes: [], resource_drift: u === "live/dev/vpc" ? [rc("terraform_data.this", ["update"], { input: "a", name: "vpc-a" }, { input: "b", name: "vpc-a" })] : [] }
          : { format_version: "1.2", resource_changes: [rc("terraform_data.this", ["create"], null, { input: u })] })],
      ] as const) {
        mkdirSync(join(dir, u), { recursive: true });
        writeFileSync(join(dir, u, f), body);
      }
      return { Name: u, Result: "succeeded", ...at };
    });
    const report = argOf(args, "--report-file")!;
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(rows));
    return { code: opts.fail?.length ? 1 : 0, stdout: "", stderr: opts.fail?.length ? "ERROR boom" : "" };
  };
}

const missing: TerragruntExec = async () => ({ code: null, stdout: "", stderr: "spawn terragrunt ENOENT" });

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("detection", () => {
  it.each([
    [{ "root.hcl": "" }, "root.hcl"],
    [{ "live/a/terragrunt.hcl": "" }, "live/a/terragrunt.hcl"],
    [{ "stacks/x/terragrunt.stack.hcl": "" }, "stacks/x/terragrunt.stack.hcl"],
    [{ "root.hcl": "", "live/a/terragrunt.hcl": "" }, "root.hcl"],
  ])("%j is a Terragrunt repo because of %s", (files, reason) => {
    expect(detectTerragrunt(write(tmp(), files))?.reason).toBe(reason);
  });

  it("plain roots and a module cache are not Terragrunt", () => {
    expect(detectTerragrunt(write(tmp(), { "net/main.tf": "", "net/.terragrunt-cache/x/terragrunt.hcl": "" }))).toBeUndefined();
  });

  it("names the explicit stack that generates a unit, and a unit's parent directory otherwise", () => {
    expect(stackOfUnit("live/stk/.terragrunt-stack/base")).toBe("live/stk");
    expect(stackOfUnit(".terragrunt-stack/base")).toBe(".");
    expect(stackOfUnit("live/dev/app")).toBe("live/dev");
    expect(unitStack("live/stk/.terragrunt-stack/base")).toEqual({ stack: "live/stk", stack_file: "live/stk/terragrunt.stack.hcl" });
    expect(unitStack("live/dev/app")).toEqual({ stack: "live/dev" });
  });

  it("walks into a stack's generated units, with their edges", () => {
    const repo = write(tmp(), {
      "root.hcl": "",
      "live/stk/terragrunt.stack.hcl": "",
      "live/stk/.terragrunt-stack/base/terragrunt.hcl": unit(),
      "live/stk/.terragrunt-stack/top/terragrunt.hcl": unit(["base"]),
    });
    expect(walkUnits(repo)).toEqual([
      { path: "live/stk/.terragrunt-stack/base", dependencies: [] },
      { path: "live/stk/.terragrunt-stack/top", dependencies: ["live/stk/.terragrunt-stack/base"] },
    ]);
  });

  it("the plan note names each explicit stack and the units it generates", () => {
    const roots = [
      { path: "live/stk/.terragrunt-stack/top", terragrunt: unitStack("live/stk/.terragrunt-stack/top") },
      { path: "live/stk/.terragrunt-stack/base", terragrunt: unitStack("live/stk/.terragrunt-stack/base") },
      { path: "live/dev/app", terragrunt: unitStack("live/dev/app") },
    ];
    expect(explicitStacksLine({ roots } as unknown as Report)).toBe("Explicit stacks: `live/stk/terragrunt.stack.hcl` generates `base`, `top`.");
    expect(explicitStacksLine({ roots: roots.slice(2) } as unknown as Report)).toBeUndefined();
  });

  it("names the explicit stacks", () => {
    expect(detectTerragrunt(write(tmp(), { "root.hcl": "", "live/st/terragrunt.stack.hcl": "" }))?.stacks).toEqual(["live/st"]);
  });
});

describe("discovery", () => {
  it("takes the units and their edges from terragrunt find, with catalog and the cache excluded", async () => {
    const calls: string[][] = [];
    const found = await discoverUnits(liveRepo(), { exclude: ["live/sandbox/**"], binary: "tofu", exec: fakeTerragrunt({ calls }) });
    expect(found.source).toBe("terragrunt find");
    expect(found.units.map((u) => u.path)).toEqual(["live/dev/vpc", "live/prod/vpc", "live/dev/app", "live/prod/app"]);
    expect(found.units.find((u) => u.path === "live/dev/app")?.dependencies).toEqual(["live/dev/vpc"]);
    const find = calls.find((c) => c[0] === "find")!;
    expect(find).toEqual(expect.arrayContaining(["--dag", "--dependencies", "!./catalog/**", "!./live/sandbox/**"]));
  });

  it("without terragrunt, the units are the terragrunt.hcl directories, with the edges their files name, and a note says why", async () => {
    const found = await discoverUnits(liveRepo(), { exec: missing });
    expect(found.source).toBe("terragrunt.hcl files");
    expect(found.units).toEqual([
      { path: "live/dev/app", dependencies: ["live/dev/vpc"] },
      { path: "live/dev/vpc", dependencies: [] },
      { path: "live/prod/app", dependencies: ["live/prod/vpc"] },
      { path: "live/prod/vpc", dependencies: [] },
    ]);
    expect(found.notes[0]).toMatch(/Terragrunt discovery did not run \(.*ENOENT/);
  });

  it("reads plain-string dependency paths only: a path built with a function, a comment and a non-unit are left out", () => {
    expect(literalDependencies([
      'dependency "vpc" {',
      '  config_path  = "../vpc"',
      '  mock_outputs = { id = "mock" }',
      "}",
      'dependency "dns" {',
      '  config_path = find_in_parent_folders("dns")',
      "}",
      '# dependency "old" { config_path = "../old" }',
      "dependencies {",
      '  paths = ["../iam", "${get_terragrunt_dir()}/../kms"]',
      "}",
    ].join("\n"))).toEqual(["../vpc", "../iam"]);
    const repo = liveRepo({ "live/dev/app/terragrunt.hcl": unit(["vpc", "gone"]) });
    expect(walkUnits(repo).find((u) => u.path === "live/dev/app")?.dependencies).toEqual(["live/dev/vpc"]);
  });

  it("a Terragrunt older than 1.1 falls back too", async () => {
    const old: TerragruntExec = async () => ({ code: 0, stdout: "terragrunt version v0.99.1", stderr: "" });
    expect((await discoverUnits(liveRepo(), { exec: old })).notes[0]).toMatch(/older than 1\.1\.0/);
  });

  it("the file walk honours exclude", () => {
    expect(walkUnits(liveRepo(), ["live/prod/**"]).map((u) => u.path)).toEqual(["live/dev/app", "live/dev/vpc"]);
  });
});

describe("waves", () => {
  const units = [
    { path: "live/dev/vpc", dependencies: [] },
    { path: "live/dev/app", dependencies: ["live/dev/vpc"] },
    { path: "live/prod/vpc", dependencies: [] },
    { path: "live/prod/app", dependencies: ["live/prod/vpc"] },
  ];

  it("a wave per dependency layer: no unit of a wave reads another unit of it", () => {
    expect(unitWaves(units)).toEqual([["live/dev/vpc", "live/prod/vpc"], ["live/dev/app", "live/prod/app"]]);
  });

  it("the canaries' layers first, then the layers of the rest", () => {
    expect(unitWaves(units, ["live/dev/**"])).toEqual([["live/dev/vpc"], ["live/dev/app"], ["live/prod/vpc"], ["live/prod/app"]]);
  });

  it("a pipeline's waves are split by the edges discovery gives, kept in order, and refused when one reads a later wave", () => {
    expect(refineWaves([["live/dev/vpc"], ["live/dev/app"]], units)).toEqual([["live/dev/vpc"], ["live/dev/app"]]);
    expect(refineWaves([["live/dev/app", "live/dev/vpc"], ["live/prod/app", "live/prod/vpc"]], units)).toEqual([["live/dev/vpc"], ["live/dev/app"], ["live/prod/vpc"], ["live/prod/app"]]);
    expect(() => refineWaves([["live/dev/app"], ["live/dev/vpc"]], units)).toThrow(/live\/dev\/app reads live\/dev\/vpc, which the pipeline applies in a later wave; run terragucci init/);
  });

  it("a canary that reads a unit outside the canary wave is refused", () => {
    expect(() => unitWaves(units, ["live/dev/app"])).toThrow(/canary live\/dev\/app depends on live\/dev\/vpc/);
  });
});

describe("settings from the repo", () => {
  it.each([
    [ROOT_HCL, 16, "the s3 backend"],
    ['remote_state {\n  backend = "http"\n  config = { address = "https://gitlab.com/api/v4/projects/7/terraform/state/x" }\n}\n', 3, "GitLab-managed state rate-limits concurrent inits"],
    ["", 16, "the default"],
  ])("parallelism for %j is %i", (rootHcl, value, reason) => {
    expect(parallelism(write(tmp(), { "root.hcl": rootHcl }))).toEqual({ value, reason });
  });

  it("the setting wins", () => {
    expect(parallelism(write(tmp(), { "root.hcl": ROOT_HCL }), { parallelism: 4 })).toEqual({ value: 4, reason: "terragucci.yml" });
  });

  it("an exact terragrunt_version_constraint pins the version; a range does not", () => {
    expect(pinnedTerragrunt(write(tmp(), { "root.hcl": 'terragrunt_version_constraint = "= 1.1.4"\n' }))).toBe("1.1.4");
    expect(pinnedTerragrunt(write(tmp(), { "root.hcl": 'terragrunt_version_constraint = ">= 1.1"\n' }))).toBeUndefined();
  });
});

describe("the auth provider", () => {
  const repo = liveRepo({ "live/prod/db/terragrunt.hcl": 'iam_role = "arn:aws:iam::222:role/own"\n' + unit() });
  const token = join(repo, "token");
  writeFileSync(token, "the-oidc-token\n");
  const env = {
    TERRAGUCCI_REPO: repo,
    TERRAGUCCI_PHASE: "apply",
    TERRAGUCCI_TG_ROLES: JSON.stringify([["live/prod/**", "arn:prod-apply"], ["live/**", "arn:any-apply"]]),
    AWS_WEB_IDENTITY_TOKEN_FILE: token,
  };

  it("gives a unit the role of the first glob its path matches, with the job's token", () => {
    expect(authProviderOutput(join(repo, "live/prod/app"), env)).toEqual({
      awsRole: { roleARN: "arn:prod-apply", roleSessionName: "terragucci-apply", webIdentityToken: "the-oidc-token" },
    });
    expect((authProviderOutput(join(repo, "live/dev/app"), env).awsRole as { roleARN: string }).roleARN).toBe("arn:any-apply");
  });

  it("a unit with its own iam_role keeps it", () => {
    expect(authProviderOutput(join(repo, "live/prod/db"), env)).toEqual({});
  });

  it("an iam_role in a file above the unit counts as the unit's own", () => {
    const r = liveRepo({ "live/prod/env.hcl": 'iam_role = "arn:aws:iam::222:role/env"\n' });
    expect(authProviderOutput(join(r, "live/prod/app"), { ...env, TERRAGUCCI_REPO: r })).toEqual({});
  });

  it("a unit no glob matches gets nothing", () => {
    expect(authProviderOutput(join(repo, "modules/thing"), env)).toEqual({});
  });

  it("a mapped unit with no token file is an error", () => {
    expect(() => authProviderOutput(join(repo, "live/prod/app"), { ...env, AWS_WEB_IDENTITY_TOKEN_FILE: join(repo, "nope") })).toThrow(/no OIDC token file/);
  });
});

describe("init in a Terragrunt repo", () => {
  it("turns the plain root rule off: units come from discovery, modules are not roots", async () => {
    const repo = liveRepo();
    const r = await init(repo, { binary: "tofu", dryRun: true, terragrunt: "/nonexistent/terragrunt" });
    expect(r.terragrunt).toMatchObject({ reason: "root.hcl", version: { value: "1.1.6" }, parallelism: { value: 16 }, source: "terragrunt.hcl files" });
    expect(r.roots).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]);
    expect(r.image).toMatch(/terragucci-terragrunt:.*-tg1\.1\.6-tofu/);
    expect(r.notes.join("\n")).toMatch(/Terragrunt discovery did not run/);
  });

  it("writes a pipeline that checks with hcl fmt and validate, plans through the stage, and applies each dependency layer in its own job behind the gate", async () => {
    const repo = liveRepo({ "terragucci.yml": "binary: tofu\nwaves:\n  canary: [\"live/dev/**\"]\n" });
    const r = await init(repo, { terragrunt: "/nonexistent/terragrunt" });
    const text = r.files[0].content;
    const doc = body(text);
    expect(doc.env).toMatchObject({ TG_TF_PATH: "tofu", TG_NON_INTERACTIVE: "true", TG_PARALLELISM: "16", TG_PROVIDER_CACHE: "1" });
    const check = doc.jobs.check.steps.at(-2).run as string;
    expect(check).toContain("terragrunt hcl fmt --check --diff");
    expect(check).toContain("terragrunt hcl validate --inputs --no-color --filter '!./catalog/**'");
    expect(check).toContain("terragucci check-pins");
    expect(check).toContain("terragucci check-policy");
    const plan = doc.jobs.plan.steps.at(-2).run as string;
    const layers = "'live/dev/vpc;live/dev/app;live/prod/vpc;live/prod/app'";
    expect(plan).toContain(`--layers ${layers}`);
    expect(Object.keys(doc.jobs).filter((j) => j.startsWith("apply"))).toEqual(["apply-comment", "apply-wave-1", "apply-wave-2", "apply-wave-3", "apply-wave-4"]);
    const applyRun = (job: string): string => doc.jobs[job].steps.find((s: { run?: string }) => s.run?.includes("terragucci stage tf-apply")).run as string;
    const apply = applyRun("apply-wave-1");
    expect(apply).toContain(`terragucci stage tf-apply --wave 1 --layers ${layers} --binary tofu --gate on-destroy --terragrunt 2>&1`);
    expect(apply).not.toContain("--rest");
    // The last job also runs any wave past the ones init found.
    expect(applyRun("apply-wave-4")).toContain(`terragucci stage tf-apply --wave 4 --layers ${layers} --binary tofu --gate on-destroy --terragrunt --rest`);
    expect(apply).not.toContain("-auto-approve");
    expect(apply).not.toContain("TG_IAM_ASSUME_ROLE=");
    // approval: ledger is the default, so no gate is declared for a seal.
    expect(r.files.find((f) => f.path.endsWith("chant.workspace.json"))).toBeUndefined();
    for (const job of ["plan", "apply-wave-1", "apply-wave-4", "apply-comment"]) {
      expect(doc.jobs[job].steps.find((s: { uses?: string }) => s.uses === "actions/cache@v4")?.with.path).toBe(".terragrunt-cache");
    }
    expect(text).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(r.notes.join("\n")).toMatch(/canary units' layers apply first/);
  });

  it("credentials: the jobs ask for an OIDC token and run the generated auth-provider-cmd, plan roles in plan and apply roles in apply", async () => {
    const yml = 'terragrunt:\n  credentials:\n    "live/prod/**": { plan: "arn:aws:iam::1:role/p", apply: "arn:aws:iam::1:role/a" }\n';
    for (const forge of ["github", "gitlab"] as const) {
      const repo = liveRepo({ "terragucci.yml": `forge: ${forge}\n${yml}` });
      const doc = body((await init(repo, { binary: "tofu", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
      const plan = forge === "github" ? doc.jobs.plan : doc.plan;
      const apply = forge === "github" ? doc.jobs["apply-wave-1"] : doc["apply-wave-1"];
      const script = (job: Record<string, any>): string => (forge === "github" ? (job === plan ? job.steps.at(-2) : job.steps.find((s: { run?: string }) => s.run?.includes("TERRAGUCCI_PHASE=apply"))).run : job.script.join("\n"));
      if (forge === "github") {
        expect(plan.permissions["id-token"]).toBe("write");
        expect(apply.permissions["id-token"]).toBe("write");
      } else {
        expect(plan.id_tokens.TERRAGUCCI_OIDC.aud).toBe("sts.amazonaws.com");
        expect(plan.cache[0].paths).toEqual([".terragrunt-cache/"]);
      }
      expect(script(plan)).toContain('export TG_AUTH_PROVIDER_CMD="terragucci auth-provider"');
      expect(script(plan)).toContain(`TERRAGUCCI_TG_ROLES='[["live/prod/**","arn:aws:iam::1:role/p"]]'`);
      expect(script(apply)).toContain(`TERRAGUCCI_TG_ROLES='[["live/prod/**","arn:aws:iam::1:role/a"]]'`);
      expect(script(apply)).toContain("TERRAGUCCI_PHASE=apply");
    }
  });

  it("a pinned Terragrunt and terraform as the binary are installed in the job", async () => {
    const repo = liveRepo({ "terragucci.yml": "binary: terraform\nterragrunt:\n  version: 1.2.0\n" });
    const r = await init(repo, { terragrunt: "/nonexistent/terragrunt" });
    const install = body(r.files[0].content).jobs.check.steps[1];
    expect(install.name).toBe("Install terragrunt 1.2.0, terraform 1.14.9");
    expect(install.run).toContain("terragucci install terragrunt 1.2.0");
  });

  it("GitLab-managed state gets parallelism 3", async () => {
    const repo = liveRepo({ "root.hcl": 'remote_state {\n  backend = "http"\n  config = { address = "https://gitlab.com/api/v4/projects/7/terraform/state/x" }\n}\n' });
    const r = await init(repo, { binary: "tofu", forge: "gitlab", terragrunt: "/nonexistent/terragrunt" });
    expect(body(r.files[0].content).check.variables).toMatchObject({ TG_PARALLELISM: "3" });
  });

  it("an explicit stack without Terragrunt to generate its units is a config error naming the stack, never a stack left out", async () => {
    const repo = liveRepo({ "live/st/terragrunt.stack.hcl": "" });
    await expect(init(repo, { binary: "tofu", dryRun: true, terragrunt: "/nonexistent/terragrunt" })).rejects.toThrow(/live\/st\/terragrunt.stack.hcl: an explicit stack's units are generated by terragrunt stack generate/);
  });

  it("generates an explicit stack's units before discovery, and its units are waves like any other", async () => {
    const repo = liveRepo({ "live/st/terragrunt.stack.hcl": 'unit "web" {\n  source = "../../catalog/units/thing"\n  path   = "web"\n}\n' });
    const calls: string[][] = [];
    const generated = JSON.stringify([...JSON.parse(FIND), { type: "unit", path: "live/st/.terragrunt-stack/web", dependencies: ["live/dev/vpc"] }]);
    const exec: TerragruntExec = async (file, args, options) => {
      calls.push([...args]);
      if (args[0] === "stack") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "find") return { code: 0, stdout: calls.some((c) => c[0] === "stack") ? generated : FIND, stderr: "" };
      return fakeTerragrunt()(file, args, options);
    };
    const found = await discoverUnits(repo, { binary: "tofu", exec });
    const order = calls.map((c) => c.slice(0, 2).join(" "));
    expect(order.indexOf("stack generate")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("stack generate")).toBeLessThan(order.findIndex((c) => c.startsWith("find")));
    expect(found.units.map((u) => u.path)).toContain("live/st/.terragrunt-stack/web");
    expect(unitWaves(found.units)).toEqual([["live/dev/vpc", "live/prod/vpc"], ["live/dev/app", "live/prod/app", "live/st/.terragrunt-stack/web"]]);
    expect(found.notes.join("\n")).not.toMatch(/stack/);
  });

  it("a failed terragrunt stack generate is a config error with its log", async () => {
    const repo = liveRepo({ "live/st/terragrunt.stack.hcl": "" });
    const exec: TerragruntExec = async (file, args, options) => (args[0] === "stack" ? { code: 1, stdout: "", stderr: "ERROR unit web: source not found" } : fakeTerragrunt()(file, args, options));
    await expect(discoverUnits(repo, { binary: "tofu", exec })).rejects.toThrow(/terragrunt stack generate failed \(exit 1\):\nERROR unit web: source not found/);
  });

  it("init notes the explicit stacks it generated", async () => {
    const repo = liveRepo({ "live/st/terragrunt.stack.hcl": "" });
    const bin = join(tmp(), "terragrunt");
    // A Terragrunt that answers --version, generates nothing and finds the four units.
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo 'terragrunt version v1.1.6' ;; stack) exit 0 ;; find) echo '${FIND}' ;; *) exit 1 ;; esac\n`);
    chmodSync(bin, 0o755);
    const r = await init(repo, { binary: "tofu", dryRun: true, terragrunt: bin });
    expect(r.notes.join("\n")).toMatch(/explicit stacks: live\/st; terragrunt stack generate wrote their units, and every job generates them again before discovery/);
    expect(r.files[0].content).toContain("terragrunt stack generate --non-interactive --no-color");
  });

  it("runs choudoufu through TG_TF_PATH in the choudoufu image, installing Terragrunt beside it", async () => {
    const doc = body((await init(liveRepo(), { binary: "choudoufu", forge: "github", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    const plan = doc.jobs.plan;
    expect(plan.container?.image ?? plan["runs-on"]).toBeDefined();
    expect(JSON.stringify(doc)).toContain("terragucci-choudoufu:");
    expect(JSON.stringify(doc)).not.toContain("terragucci-terragrunt:");
    expect(doc.env?.TG_TF_PATH ?? plan.env?.TG_TF_PATH).toBe("choudoufu");
    const steps = plan.steps.map((s: any) => s.name ?? "");
    expect(steps).toContain("Install terragrunt 1.1.6");
    expect(steps.some((n: string) => n.startsWith("Install") && n.includes("choudoufu"))).toBe(false);
    expect(plan.steps.map((s: any) => s.run ?? "").join("\n")).toContain("terragucci stage tf-plan");
  });

  it("roots is a config error naming terragrunt.exclude", async () => {
    const repo = liveRepo({ "terragucci.yml": 'roots: ["live/*"]\n' });
    await expect(init(repo, { binary: "tofu", dryRun: true, terragrunt: "/nonexistent/terragrunt" })).rejects.toThrow(ROOTS_NOT_TERRAGRUNT);
    expect(ROOTS_NOT_TERRAGRUNT).toContain("terragrunt.exclude");
  });

  it("a terragrunt block in a repo with no Terragrunt files is an error", async () => {
    const repo = write(tmp(), { "net/main.tf": 'terraform {\n  backend "s3" {}\n}\n', "terragucci.yml": "terragrunt:\n  parallelism: 4\n" });
    await expect(init(repo, { binary: "tofu", forge: "github" })).rejects.toThrow(/has a terragrunt block, but the repo has no root\.hcl/);
  });

  it("running it twice changes nothing", async () => {
    const repo = liveRepo();
    await init(repo, { binary: "tofu", terragrunt: "/nonexistent/terragrunt" });
    expect((await init(repo, { binary: "tofu", terragrunt: "/nonexistent/terragrunt" })).files.map((f) => f.status)).toEqual(["unchanged"]);
  });
});

describe("terragucci plan in a Terragrunt repo", () => {
  it("targets the units, not the module", async () => {
    const { planTargets } = await import("../src/plan");
    const t = await planTargets(liveRepo(), { root: "live/dev/**" });
    expect(t.terragrunt).toBe(true);
    expect([...t.roots].sort()).toEqual(["live/dev/app", "live/dev/vpc"]);
  });
});

describe("terragucci stage tf-plan in a Terragrunt repo", () => {
  it("a unit's plan waits five minutes for the state lock, unless TF_CLI_ARGS_plan sets a timeout", async () => {
    const plans = async (env: NodeJS.ProcessEnv): Promise<string[][]> => {
      const repo = liveRepo();
      const calls: string[][] = [];
      await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: fakeTerragrunt({ calls }), env }, () => {});
      return calls.filter((c) => c[0] === "run").map((c) => c.slice(c.indexOf("--")));
    };
    expect(await plans({})).toEqual([["--", "plan", "-lock-timeout=5m"]]);
    expect(await plans({ TF_CLI_ARGS_plan: "-lock-timeout=30s" })).toEqual([["--", "plan"]]);
  });

  it("a unit's plan spans reach the report through the TG_TF_PATH wrapper", { timeout: 60_000 }, async () => {
    const span = (address: string, ms: number) => ({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "00f067aa0ba902b7", name: "Plan resource instance changes", kind: 1,
        startTimeUnixNano: "1700000000000000000", endTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(ms) * 1_000_000n),
        attributes: [{ key: "opentofu.resource_instance.address", value: { stringValue: address } }, { key: "opentofu.resource.type", value: { stringValue: "terraform_data" } }],
      }] }] }],
    });
    const repo = liveRepo({
      "live/dev/vpc/spans.json": JSON.stringify(span("terraform_data.vpc", 1500)),
      "live/dev/app/spans.json": JSON.stringify(span("terraform_data.app", 400)),
    });
    // A stand-in for the binary: on a plan with -out, it posts spans.json from its directory, as an OTLP exporter would.
    const bin = join(tmp(), "tofu");
    writeFileSync(bin, `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
(async () => {
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (process.argv[2] !== "plan" || !url || !existsSync("spans.json")) return;
  const headers = { "content-type": "application/json" };
  for (const p of (process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || "").split(",")) {
    const i = p.indexOf("=");
    if (i > 0) headers[p.slice(0, i)] = p.slice(i + 1);
  }
  const res = await fetch(url, { method: "POST", headers, body: readFileSync("spans.json") });
  if (!res.ok) process.exit(3);
})();
`);
    chmodSync(bin, 0o755);
    const calls: string[][] = [];
    const r = await runStage("tf-plan", repo, {
      out: join(repo, "out"), binary: bin, terragrunt: true,
      layers: [["live/dev/vpc", "live/dev/app"]],
      terragruntExec: fakeTerragrunt({
        calls, runBinary: true,
        times: { "live/dev/vpc": ["2026-10-05T10:00:00Z", "2026-10-05T10:00:03Z"], "live/dev/app": ["2026-10-05T10:00:00Z", "2026-10-05T10:00:01Z"] },
      }),
      env: { PATH: process.env.PATH },
    }, () => {});
    const unit = (p: string) => r.report.roots.find((u) => u.path === p)!.timings!;
    expect(unit("live/dev/vpc")).toMatchObject({ seconds: 3, source: "terragrunt", spans: 1, detail: "resources", resources: [{ address: "terraform_data.vpc", ms: 1500 }] });
    expect(unit("live/dev/vpc").note).toBeUndefined();
    expect(unit("live/dev/app").resources.map((x) => x.address)).toEqual(["terraform_data.app"]);
    expect(r.report.timings!.resources.map((x) => [x.root, x.address])).toEqual([["live/dev/vpc", "terraform_data.vpc"], ["live/dev/app", "terraform_data.app"]]);
  });

  it("lists each unit's time from Terragrunt's run report, the slowest first, and says when its plan sent no spans", async () => {
    const repo = liveRepo();
    const r = await runStage("tf-plan", repo, {
      out: join(repo, "out"), binary: "tofu", terragrunt: true,
      layers: [["live/dev/vpc", "live/dev/app"], ["live/prod/vpc"]],
      terragruntExec: fakeTerragrunt({
        times: {
          "live/dev/vpc": ["2026-10-05T10:00:00.000000000Z", "2026-10-05T10:00:02.500000000Z"],
          "live/dev/app": ["2026-10-05T10:00:00.250Z", "2026-10-05T10:00:09.750Z"],
          // Terragrunt's own offset and nanoseconds.
          "live/prod/vpc": ["2026-10-05T12:00:10.123456789+02:00", "2026-10-05T12:00:14.623456789+02:00"],
        },
      }),
      env: {},
    }, () => {});
    expect(r.report.timings!.roots).toEqual([
      { root: "live/dev/app", seconds: 9.5, plan_seconds: 9.5, source: "terragrunt", detail: "none" },
      { root: "live/prod/vpc", seconds: 4.5, plan_seconds: 4.5, source: "terragrunt", detail: "none" },
      { root: "live/dev/vpc", seconds: 2.5, plan_seconds: 2.5, source: "terragrunt", detail: "none" },
    ]);
    expect(r.report.timings!.note).toBeUndefined();
    const unit = r.report.roots.find((u) => u.path === "live/dev/app")!.timings!;
    expect(unit).toMatchObject({ seconds: 9.5, source: "terragrunt", spans: 0, detail: "none", resources: [], lock_waits: [] });
    expect(unit.note).toMatch(/^Terragrunt ran the binary for this unit/);
  });

  it("plans each wave with one run --all and reports each unit's stack, selection, provisional flag and run result", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    const r = await runStage("tf-plan", repo, {
      out: join(repo, "out"), binary: "tofu", terragrunt: true,
      layers: [["live/dev/vpc", "live/dev/app"], ["live/prod/vpc", "live/prod/app"]],
      terragruntExec: fakeTerragrunt({ calls, fail: ["live/prod/app"] }),
      env: {},
    }, () => {});
    const runs = calls.filter((c) => c[0] === "run" && c[1] === "--all");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(expect.arrayContaining(["--all", "--no-filters-file", "{./live/dev/app}", "{./live/dev/vpc}", "--json-out-dir"]));
    expect(runs[0]).not.toContain("{./live/prod/vpc}");
    expect(r.report.minor).toBe(29);
    // A run report with no Started and Ended times no unit, and the report says so.
    expect(r.report.timings).toEqual({ roots: [], resources: [], note: expect.stringMatching(/^Terragrunt ran the binary/) });
    const units = Object.fromEntries(r.report.roots.map((u) => [u.path, u]));
    expect(units["live/dev/app"].terragrunt).toEqual({ stack: "live/dev", selection: expect.stringMatching(/^every unit/), provisional: false, run_result: "succeeded" });
    expect(units["live/dev/app"].status).toBe("planned");
    expect(units["live/prod/app"]).toMatchObject({ status: "failed", terragrunt: { run_result: "failed" } });
    expect(units["live/prod/app"].error).toMatch(/run error: Error: boom/);
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc", "live/dev/app"], ["live/prod/vpc", "live/prod/app"]]);
    expect(r.report.waves[1].set_digest).toBeNull();
    expect(r.failed).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, "out/roots/live/dev/app/plan.json"), "utf-8")).resource_changes).toHaveLength(1);
  });

  it("runs the policy over each unit's plan JSON and fails only the unit it denies", async () => {
    const repo = liveRepo({ "terragucci.yml": "policy:\n  path: policy\n", "policy/p.rego": "package main\n" });
    const seen: string[] = [];
    const exec: PolicyExec = async (_f, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
      const plan = JSON.parse(readFileSync(args[args.length - 1], "utf-8"));
      const unit = plan.resource_changes[0].change.after.input as string;
      seen.push(unit);
      const failures = unit === "live/prod/vpc" ? [{ msg: "prod vpc is not allowed" }] : [];
      return { status: failures.length ? 1 : 0, stdout: JSON.stringify([{ filename: "plan.json", namespace: "main", successes: 1, failures }]), stderr: "" };
    };
    const r = await runStage("tf-plan", repo, {
      out: join(repo, "out"), binary: "tofu", terragrunt: true,
      layers: [["live/dev/vpc", "live/dev/app"], ["live/prod/vpc"]],
      terragruntExec: fakeTerragrunt(), policy: { exec }, env: {},
    }, () => {});
    expect([...seen].sort()).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/vpc"]);
    const units = Object.fromEntries(r.report.roots.map((u) => [u.path, u]));
    expect(units["live/prod/vpc"].status).toBe("failed");
    expect(units["live/prod/vpc"].error).toContain("prod vpc is not allowed");
    expect(units["live/dev/vpc"].status).toBe("planned");
    expect(units["live/dev/app"].status).toBe("planned");
    expect(r.failed).toBe(true);
  });

  it("runs steps around each wave's run --all, in the units their globs match: a step after plan holds the wave or fails its unit", async () => {
    const steps = [
      "steps:",
      "  - name: mark",
      '    run: echo "$TG_STAGE $TG_ROOT" > step.txt',
      "    before: plan",
      '    roots: ["live/dev/*"]',
      "  - name: verify",
      '    run: test -f "$TG_PLAN_FILE" && exit 1',
      "    after: plan",
      '    roots: ["live/dev/vpc"]',
      "    on_failure: approve",
      "  - name: lint",
      "    run: exit 3",
      "    after: plan",
      '    roots: ["live/prod/vpc"]',
    ].join("\n");
    const repo = liveRepo({ "terragucci.yml": `${steps}\n` });
    const lines: string[] = [];
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc", "live/prod/vpc"], ["live/dev/app", "live/prod/app"]], terragruntExec: fakeTerragrunt(), env: {} }, (l) => lines.push(l));
    expect(readFileSync(join(repo, "live/dev/vpc/step.txt"), "utf-8")).toBe("tf-plan live/dev/vpc\n");
    expect(readFileSync(join(repo, "live/dev/app/step.txt"), "utf-8")).toBe("tf-plan live/dev/app\n");
    const units = Object.fromEntries(r.report.roots.map((u) => [u.path, u]));
    expect(units["live/dev/vpc"].steps!.map((x) => `${x.when} ${x.name} ${x.status}`)).toEqual(["before-plan mark passed", "after-plan verify approval"]);
    expect(units["live/dev/vpc"].status).toBe("planned");
    expect(units["live/prod/vpc"].status).toBe("failed");
    expect(units["live/prod/vpc"].error).toContain("step after-plan lint failed with exit 3");
    expect(r.report.waves[0]).toMatchObject({ number: 1, held_by_steps: ["live/dev/vpc"] });
    expect(lines).toContain("live/dev/vpc: after-plan step verify exited 1, so its wave waits for an approval");
    expect(r.failed).toBe(true);
  });

  it("refuses a step after init in a Terragrunt repo: the units init inside run --all plan", async () => {
    const repo = liveRepo({ "terragucci.yml": "steps:\n  - name: late\n    run: echo late\n    after: init\n" });
    await expect(runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: fakeTerragrunt(), env: {} }, () => {})).rejects.toThrow(/steps late: a Terragrunt repo inits each unit inside the wave's run --all plan/);
  });

  it("with no --layers, discovery decides the units and the waves, the canary layers first", async () => {
    const repo = liveRepo({ "terragucci.yml": 'waves:\n  canary: ["live/dev/**"]\n' });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragruntExec: fakeTerragrunt(), env: {} }, () => {});
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc"], ["live/dev/app"], ["live/prod/vpc"], ["live/prod/app"]]);
    expect(r.failed).toBe(false);
  });

  it("a unit whose upstream has no outputs yet is not planned on its mocks: it waits, and the rest of the wave plans", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    const exec = fakeTerragrunt({ calls, noOutputs: { "live/dev/app": "live/dev/vpc" } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/app", "live/dev/vpc"]], terragruntExec: exec, env: {} }, () => {});
    expect(r.report.roots.map((u) => u.path)).toEqual(["live/dev/vpc"]);
    expect(r.report.mock_reads).toEqual([{ unit: "live/dev/app", dependency: "platform", upstream: "live/dev/vpc", reason: "no-outputs" }]);
    expect(r.report.deferred).toEqual([{ unit: "live/dev/app", after: ["live/dev/vpc"], why: "would read mock_outputs", previewed: false }]);
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc"]]);
    expect(r.failed).toBe(false);
    expect(readFileSync(join(repo, "out/note.md"), "utf-8")).toMatch(/Planned once what they wait for applies \(1\)/);
    expect(readFileSync(join(repo, "out/report.html"), "utf-8")).toContain('id="deferred"');
  });

  it("with dependents: plan, a waiting unit is still not previewed on its mocks", async () => {
    const repo = liveRepo({ "terragucci.yml": "terragrunt:\n  dependents: plan\n" });
    const calls: string[][] = [];
    const exec = fakeTerragrunt({ calls, noOutputs: { "live/dev/app": "live/dev/vpc" } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/app", "live/dev/vpc"]], terragruntExec: exec, env: {} }, () => {});
    expect(r.report.roots.map((u) => u.path)).toEqual(["live/dev/vpc"]);
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc"]]);
    expect(r.report.deferred).toEqual([{ unit: "live/dev/app", after: ["live/dev/vpc"], why: "would read mock_outputs", previewed: false }]);
    // No plan skipped the mock check.
    expect(calls.filter((c) => c[0] === "run" && c[1] === "--all").every((c) => calls.some((d) => d[0] === "render" && c.includes(`{./${argOf(d, "--working-dir")}}`)))).toBe(true);
  });

  it("against a base, only the affected units plan, each with its reason, and their dependents wait", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    const exec = fakeTerragrunt({ calls, affected: { selected: ["live/dev/vpc"], files: ["live/dev/vpc/terragrunt.hcl"] } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, base: "origin/main", layers: [["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]], terragruntExec: exec, env: {} }, () => {});
    expect(calls.find((c) => c[0] === "find" && c.includes("[origin/main...HEAD]"))).toBeDefined();
    expect(r.report.roots.map((u) => u.path)).toEqual(["live/dev/vpc"]);
    expect(r.report.roots[0].terragrunt?.selection).toMatch(/live\/dev\/vpc\/terragrunt\.hcl/);
    expect(r.report.deferred).toEqual([{ unit: "live/dev/app", after: ["live/dev/vpc"], why: "depends on a changed unit", previewed: false }]);
  });

  it("the blast radius holds the changed unit and every unit that depends on it, and the note lists them", async () => {
    const repo = liveRepo();
    const exec = fakeTerragrunt({ affected: { selected: ["live/dev/vpc"], files: ["live/dev/vpc/terragrunt.hcl"] } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, base: "origin/main", terragruntExec: exec, env: {} }, () => {});
    expect(r.report.blast).toEqual({ roots: ["live/dev/vpc"], downstream: [{ root: "live/dev/app", reads: ["live/dev/vpc"], depth: 1, wave: 2, planned: false }] });
    const note = readFileSync(join(repo, "out/note.md"), "utf-8");
    expect(note).toContain("**Blast radius:** 1 unit changes (`live/dev/vpc`), and 1 unit downstream depends on them:");
    expect(note).toContain("- `live/dev/app` (wave 2) depends on `live/dev/vpc`; not planned in this run");
  });

  it("a blast radius follows the edges through: a unit that depends on a dependent is depth 2", async () => {
    const repo = liveRepo({ "live/dev/web/terragrunt.hcl": unit(["app"]) });
    const find = JSON.stringify([...JSON.parse(FIND), { type: "unit", path: "live/dev/web", dependencies: ["live/dev/app"] }]);
    const base = fakeTerragrunt();
    const exec: TerragruntExec = async (file, args, options) => (args[0] === "find" && !args.some((a) => a.startsWith("[")) ? { code: 0, stdout: find, stderr: "" } : base(file, args, options));
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, root: "live/dev/vpc", terragruntExec: exec, env: {} }, () => {});
    expect(r.report.blast?.downstream).toEqual([
      { root: "live/dev/app", reads: ["live/dev/vpc"], depth: 1, wave: 2, planned: false },
      { root: "live/dev/web", reads: ["live/dev/app"], depth: 2, wave: 3, planned: false },
    ]);
  });

  it("against a base, the pipeline's waves are split by the edges discovery gives, as the apply jobs split them", async () => {
    const repo = liveRepo();
    const all = ["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"];
    const exec = fakeTerragrunt({ affected: { selected: all, files: all.map((u) => `${u}/terragrunt.hcl`) } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, base: "origin/main", layers: [all], terragruntExec: exec, env: {} }, () => {});
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc", "live/prod/vpc"], ["live/dev/app", "live/prod/app"]]);
  });
});

describe("terragucci stage tf-drift in a Terragrunt repo", () => {
  it("refresh-plans every unit, one run --all per wave, and reports drift by unit", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    const r = await runStage("tf-drift", repo, {
      out: join(repo, "out"), binary: "tofu", terragrunt: true, base: "origin/main",
      layers: [["live/dev/vpc", "live/dev/app"], ["live/prod/vpc", "live/prod/app"]],
      terragruntExec: fakeTerragrunt({ calls }), env: {},
    }, () => {});
    const runs = calls.filter((c) => c[0] === "run" && c[1] === "--all");
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.slice(run.indexOf("--"), run.indexOf("--") + 3)).toEqual(["--", "plan", "-refresh-only"]);
    expect(calls.filter((c) => c[0] === "render").every((c) => !c.includes("-refresh-only"))).toBe(true);
    expect(r.report.run.stage).toBe("tf-drift");
    expect(r.report.waves).toEqual([]);
    const units = Object.fromEntries(r.report.roots.map((u) => [u.path, u]));
    expect(units["live/dev/vpc"].changes).toHaveLength(1);
    expect(units["live/dev/app"].changes).toHaveLength(0);
    expect(r.report.roots).toHaveLength(4);
    expect(r.failed).toBe(false);
    expect(readFileSync(join(repo, "out/issue.md"), "utf-8")).toContain("live/dev/vpc");
  });

  it("with apply.branches, a unit another branch applies is refresh-planned in a checkout of that branch, and the rest in the repo", async () => {
    const repo = liveRepo({ "terragucci.yml": 'apply:\n  branches:\n    release: ["live/prod/**"]\n' });
    const bare = tmp("tg-bare-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(repo, "remote", "set-url", "origin", bare);
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "main");
    git(repo, "push", "-q", "origin", "HEAD:main", "HEAD:release");
    const where: [string, string][] = [];
    const base = fakeTerragrunt();
    const exec: TerragruntExec = async (file, args, options) => {
      if (args[0] === "run") where.push([args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith("{./") ? [a.slice(3, -1)] : [])).join(","), options.cwd]);
      return base(file, args, options);
    };
    const lines: string[] = [];
    const r = await runStage("tf-drift", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc", "live/prod/vpc"], ["live/dev/app", "live/prod/app"]], terragruntExec: exec, env: {} }, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/apply\.branches: live\/prod\/app, live\/prod\/vpc plan from release at [0-9a-f]{8}, the branch that applies them/);
    for (const [units, cwd] of where) expect(cwd === repo, units).toBe(!units.includes("live/prod"));
    expect(where.map(([u]) => u).sort()).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]);
    expect(r.report.roots.map((u) => u.path).sort()).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]);
    expect(r.failed).toBe(false);
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("a plain tf-plan does not refresh-only", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: fakeTerragrunt({ calls }), env: {} }, () => {});
    expect(calls.flat()).not.toContain("-refresh-only");
  });

  it("a drift plan takes no lock, so it gets no lock timeout", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    await runStage("tf-drift", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: fakeTerragrunt({ calls }), env: {} }, () => {});
    expect(calls.flat().filter((a) => a.includes("lock-timeout"))).toEqual([]);
  });

  it("a unit whose upstream has no outputs fails the run instead of waiting", async () => {
    const repo = liveRepo();
    const exec = fakeTerragrunt({ noOutputs: { "live/dev/app": "live/dev/vpc" } });
    const r = await runStage("tf-drift", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/app", "live/dev/vpc"]], terragruntExec: exec, env: {} }, () => {});
    expect(r.report.roots.find((u) => u.path === "live/dev/app")).toMatchObject({ status: "failed" });
    expect(r.failed).toBe(true);
  });
});

describe("the pipeline's drift job in a Terragrunt repo", () => {
  it.each(["github", "gitlab"] as const)("%s: drift runs tf-drift --terragrunt with the cache, and nothing else changes", async (forge) => {
    const repo = liveRepo({ "terragucci.yml": `drift: "0 6 * * *"\n${forge === "gitlab" ? "forge: gitlab\n" : ""}` });
    const doc = body((await init(repo, { binary: "tofu", forge, terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    const job = forge === "github" ? doc.jobs.drift : doc.drift;
    const script = forge === "github" ? job.steps.map((s: any) => s.run).filter(Boolean).join("\n") : job.script.join("\n");
    expect(script).toContain("terragucci stage tf-drift");
    expect(script).toContain("--terragrunt");
    expect(script).toContain("TG_DOWNLOAD_DIR");
    expect(forge === "github" ? job.steps.some((s: any) => s.uses === "actions/cache@v4") : job.cache[0].paths).toBeTruthy();
  });

  it("without drift there is no drift job", async () => {
    const doc = body((await init(liveRepo(), { binary: "tofu", forge: "github", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    expect(doc.jobs.drift).toBeUndefined();
  });
});

const TG = process.env.TERRAGUCCI_TERRAGRUNT;
const TOFU = spawnSync("tofu", ["version"]).status === 0;

describe.skipIf(!TG || !TOFU)("with the real terragrunt and tofu", () => {
  it("init discovers the units, and the stage plans the upstreams and holds back their never-applied dependents", { timeout: 120_000 }, async () => {
    const repo = liveRepo({ "root.hcl": 'remote_state {\n  backend = "local"\n  generate = { path = "backend.tf", if_exists = "overwrite" }\n  config = { path = "${get_parent_terragrunt_dir()}/.state/${path_relative_to_include()}/terraform.tfstate" }\n}\n' });
    const r = await init(repo, { binary: "tofu", dryRun: true });
    expect(r.terragrunt?.source).toBe("terragrunt find");
    expect(r.layers.flat().sort()).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]);
    const stage = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", layers: r.layers }, () => {});
    expect(stage.report.roots.map((u) => [u.path, u.status])).toEqual([["live/dev/vpc", "planned"], ["live/prod/vpc", "planned"]]);
    expect(stage.report.deferred?.map((d) => [d.unit, d.after])).toEqual([["live/dev/app", ["live/dev/vpc"]], ["live/prod/app", ["live/prod/vpc"]]]);
  });
});

describe("tips in a Terragrunt repo", () => {
  it("TF041 names a unit whose mocks may stand in for apply, and TF044 a root.hcl with local state", async () => {
    const { repoTips } = await import("../src/tips");
    const { loadHclParser } = await import("../src/rollout/parser");
    const repo = liveRepo({
      "root.hcl": 'remote_state {\n  backend = "local"\n  config = { path = "x.tfstate" }\n}\n',
      "live/dev/app/terragrunt.hcl": unit(["vpc"]).replace('mock_outputs = { id = "mock" }', 'mock_outputs = { id = "mock" }\n  mock_outputs_allowed_terraform_commands = ["validate", "plan"]'),
    });
    const tips = await repoTips(repo, ["live/dev/app", "live/prod/app"], { settings: { gate: "on-destroy", tips: true }, parser: await loadHclParser(), configDirs: ["."] });
    const tf041 = tips.filter((t) => t.rule === "TF041").map((t) => t.root);
    expect(tf041).toEqual(["live/prod/app"]);
    expect(tips.some((t) => t.rule === "TF044" && t.root === ".")).toBe(true);
  });
});

describe("the Terragrunt example", () => {
  const EXAMPLE = join(import.meta.dirname, "../../../example-terragrunt");

  it("init finds its 15 units and writes the pipeline it commits", async () => {
    const repo = tmp();
    cpSync(EXAMPLE, repo, { recursive: true });
    const r = await init(repo, { dryRun: true });
    expect(r.roots).toHaveLength(15);
    expect(r.layers.map((w) => w.length)).toEqual([1, 4, 2, 7, 1]);
    expect(r.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("every scenario applies to the example as committed", () => {
    const repo = tmp();
    cpSync(EXAMPLE, repo, { recursive: true });
    git(repo, "init", "-q");
    for (const p of readdirSync(join(EXAMPLE, "changes")).filter((n) => n.endsWith(".patch"))) {
      git(repo, "apply", "--check", join(EXAMPLE, "changes", p));
    }
  });
});

describe("TF042 as a tip", () => {
  const skipUnit = (extra: string): string =>
    unit().replace(/$/, `dependency "vpc" {\n  config_path  = "../vpc"\n  mock_outputs = { id = "mock" }\n${extra}}\n`);

  it("names a unit whose dependency sets skip_outputs with mock_outputs, and leaves the others", async () => {
    const { repoTips } = await import("../src/tips");
    const { loadHclParser } = await import("../src/rollout/parser");
    const repo = liveRepo({
      "root.hcl": ROOT_HCL,
      "live/dev/app/terragrunt.hcl": skipUnit("  skip_outputs = true\n"),
      "live/prod/app/terragrunt.hcl": skipUnit(""),
    });
    const tips = await repoTips(repo, ["live/dev/app", "live/prod/app"], { settings: { gate: "on-destroy", tips: true }, parser: await loadHclParser() });
    expect(tips.filter((t) => t.rule === "TF042").map((t) => t.root)).toEqual(["live/dev/app"]);
  });
});
