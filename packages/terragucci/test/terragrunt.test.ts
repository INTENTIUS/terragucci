// Terragrunt mode: detection, discovery, waves, the auth provider, init's
// pipeline and the tf-plan stage. Terragrunt itself is stubbed; the last block
// runs the real binary when TERRAGUCCI_TERRAGRUNT names one and tofu is on the path.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { init } from "../src/init";
import { runStage } from "../src/report/stage";
import {
  authProviderOutput,
  detectTerragrunt,
  discoverUnits,
  parallelism,
  pinnedTerragrunt,
  unitWaves,
  walkUnits,
} from "../src/terragrunt";
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
}

/** A stand-in for terragrunt 1.1.6 and git: version, find, render, output, a plan that writes each unit's plan and report row, and diff. */
function fakeTerragrunt(opts: FakeOptions = {}): TerragruntExec {
  return async (file, args) => {
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
    const rows = units.map((u) => {
      if (opts.fail?.includes(u)) return { Name: u, Result: "failed", Reason: "run error", Cause: "Error: boom" };
      for (const [dir, f, body] of [
        [out, "tfplan.tfplan", "binary"],
        [json, "tfplan.json", JSON.stringify(refresh
          ? { format_version: "1.2", resource_changes: [], resource_drift: u === "live/dev/vpc" ? [rc("terraform_data.this", ["update"], { input: "a", name: "vpc-a" }, { input: "b", name: "vpc-a" })] : [] }
          : { format_version: "1.2", resource_changes: [rc("terraform_data.this", ["create"], null, { input: u })] })],
      ] as const) {
        mkdirSync(join(dir, u), { recursive: true });
        writeFileSync(join(dir, u, f), body);
      }
      return { Name: u, Result: "succeeded" };
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

  it("without terragrunt, the units are the terragrunt.hcl directories, with no edges, and a note says why", async () => {
    const found = await discoverUnits(liveRepo(), { exec: missing });
    expect(found.source).toBe("terragrunt.hcl files");
    expect(found.units).toEqual(["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"].map((path) => ({ path, dependencies: [] })));
    expect(found.notes[0]).toMatch(/Terragrunt discovery did not run \(.*ENOENT/);
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

  it("one wave without canaries: Terragrunt orders the units inside the run", () => {
    expect(unitWaves(units)).toEqual([["live/dev/app", "live/dev/vpc", "live/prod/app", "live/prod/vpc"]]);
  });

  it("canaries first, then the rest", () => {
    expect(unitWaves(units, ["live/dev/**"])).toEqual([["live/dev/app", "live/dev/vpc"], ["live/prod/app", "live/prod/vpc"]]);
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

  it("writes a pipeline that checks with hcl fmt and validate, plans through the stage, and applies each wave with one run --all", async () => {
    const repo = liveRepo({ "terragucci.yml": "binary: tofu\nwaves:\n  canary: [\"live/dev/**\"]\n" });
    const r = await init(repo, { terragrunt: "/nonexistent/terragrunt" });
    const text = r.files[0].content;
    const doc = body(text);
    expect(doc.env).toMatchObject({ TG_TF_PATH: "tofu", TG_NON_INTERACTIVE: "true", TG_PARALLELISM: "16", TG_PROVIDER_CACHE: "1" });
    const check = doc.jobs.check.steps.at(-1).run as string;
    expect(check).toContain("terragrunt hcl fmt --check --diff");
    expect(check).toContain("terragrunt hcl validate --inputs --no-color --filter '!./catalog/**'");
    const plan = doc.jobs.plan.steps.at(-2).run as string;
    expect(plan).toMatch(/terragucci stage tf-plan .*--layers 'live\/dev\/app,live\/dev\/vpc;live\/prod\/app,live\/prod\/vpc' .*--terragrunt/);
    const apply = doc.jobs.apply.steps.at(-1).run as string;
    expect(apply.match(/^apply_wave /gm)).toHaveLength(2);
    expect(apply).toContain("apply_wave --filter '{./live/dev/app}' --filter '{./live/dev/vpc}' || failed");
    expect(apply).toContain("--no-filters-file");
    expect(apply).not.toContain("TG_IAM_ASSUME_ROLE=");
    for (const job of ["plan", "apply"]) {
      expect(doc.jobs[job].steps.find((s: { uses?: string }) => s.uses === "actions/cache@v4")?.with.path).toBe(".terragrunt-cache");
    }
    expect(text).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(r.notes.join("\n")).toMatch(/canary units apply first/);
  });

  it("credentials: the jobs ask for an OIDC token and run the generated auth-provider-cmd, plan roles in plan and apply roles in apply", async () => {
    const yml = 'terragrunt:\n  credentials:\n    "live/prod/**": { plan: "arn:aws:iam::1:role/p", apply: "arn:aws:iam::1:role/a" }\n';
    for (const forge of ["github", "gitlab"] as const) {
      const repo = liveRepo({ "terragucci.yml": `forge: ${forge}\n${yml}` });
      const doc = body((await init(repo, { binary: "tofu", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
      const plan = forge === "github" ? doc.jobs.plan : doc.plan;
      const apply = forge === "github" ? doc.jobs.apply : doc.apply;
      const script = (job: Record<string, any>): string => (forge === "github" ? job.steps.at(forge === "github" && job === plan ? -2 : -1).run : job.script.join("\n"));
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
    expect(install.name).toBe("Install terragrunt 1.2.0, terraform 1.14.0");
    expect(install.run).toContain("terragucci install terragrunt 1.2.0");
  });

  it("GitLab-managed state gets parallelism 3", async () => {
    const repo = liveRepo({ "root.hcl": 'remote_state {\n  backend = "http"\n  config = { address = "https://gitlab.com/api/v4/projects/7/terraform/state/x" }\n}\n' });
    const r = await init(repo, { binary: "tofu", forge: "gitlab", terragrunt: "/nonexistent/terragrunt" });
    expect(body(r.files[0].content).check.variables).toMatchObject({ TG_PARALLELISM: "3" });
  });

  it("explicit stacks and roots are named in the notes", async () => {
    const repo = liveRepo({ "live/st/terragrunt.stack.hcl": "", "terragucci.yml": 'roots: ["live/*"]\n' });
    const notes = (await init(repo, { binary: "tofu", dryRun: true, terragrunt: "/nonexistent/terragrunt" })).notes.join("\n");
    expect(notes).toMatch(/explicit stacks are not run yet, so live\/st is left out/);
    expect(notes).toMatch(/roots is ignored for a Terragrunt repo/);
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
    expect(r.report.minor).toBe(2);
    // Terragrunt runs the binary for each unit, so the report times none of them, and says so.
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

  it("with no --layers, discovery decides the units and the canary wave", async () => {
    const repo = liveRepo({ "terragucci.yml": 'waves:\n  canary: ["live/dev/**"]\n' });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragruntExec: fakeTerragrunt(), env: {} }, () => {});
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/app", "live/dev/vpc"], ["live/prod/app", "live/prod/vpc"]]);
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
    expect(readFileSync(join(repo, "out/note.md"), "utf-8")).toMatch(/Planned after what they wait for applies \(1\)/);
    expect(readFileSync(join(repo, "out/report.html"), "utf-8")).toContain('id="deferred"');
  });

  it("with dependents: plan, a waiting unit is previewed, marked provisional, and kept out of every digest", async () => {
    const repo = liveRepo({ "terragucci.yml": "terragrunt:\n  dependents: plan\n" });
    const exec = fakeTerragrunt({ noOutputs: { "live/dev/app": "live/dev/vpc" } });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/app", "live/dev/vpc"]], terragruntExec: exec, env: {} }, () => {});
    const app = r.report.roots.find((u) => u.path === "live/dev/app")!;
    expect(app.terragrunt?.provisional).toBe(true);
    expect(app.status).toBe("planned");
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/dev/vpc"]]);
    expect(r.report.deferred?.[0].previewed).toBe(true);
    const alone = await runStage("tf-plan", repo, { out: join(repo, "out2"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: exec, env: {} }, () => {});
    expect(r.report.change_set).toBe(alone.report.change_set);
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

  it("a plain tf-plan does not refresh-only", async () => {
    const repo = liveRepo();
    const calls: string[][] = [];
    await runStage("tf-plan", repo, { out: join(repo, "out"), binary: "tofu", terragrunt: true, layers: [["live/dev/vpc"]], terragruntExec: fakeTerragrunt({ calls }), env: {} }, () => {});
    expect(calls.flat()).not.toContain("-refresh-only");
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
    expect(r.layers.map((w) => w.length)).toEqual([5, 10]);
    expect(r.files[0].status).toBe("unchanged");
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
