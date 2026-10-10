import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { resolveProject, resolveRepo, validateConfig, type ResolvedSettings } from "../src/config";
import { backendBootstrap, checkGenerated, combineGenerate, GENERATED_MARKER, includesGenerated, lineDiff, planGenerate, projectGenerate, renderRoot, rootSettings, type GenerateSettings } from "../src/generate";
import { init } from "../src/init";
import { checkScript } from "../src/render";
import { bareFrom, git, tmp, write } from "./helpers";

const resource = (name: string): string => `resource "terraform_data" "${name}" {\n  input = "${name}"\n}\n`;

/** Three roots under envs/, found by the roots glob, and a terragucci.yml. */
function repo(config: string): string {
  return write(tmp(), {
    "envs/dev/app/main.tf": resource("dev"),
    "envs/prod/app/main.tf": resource("app"),
    "envs/prod/network/main.tf": resource("network"),
    "terragucci.yml": config,
  });
}

const settingsOf = (dir: string): ResolvedSettings => resolveRepo(validateConfig(parseYAML(readFileSync(join(dir, "terragucci.yml"), "utf-8")), "t"));

/** Write what planGenerate says, as the command does. */
function generate(dir: string): ReturnType<typeof planGenerate> {
  const plan = planGenerate(dir, settingsOf(dir));
  for (const f of plan.files) if (f.status !== "unchanged" && f.status !== "removed") writeFileSync(f.path, f.content);
  return plan;
}

const HIERARCHY = `roots: ["envs/*/*"]
generate:
  backend:
    s3:
      bucket: acme-state
      key: "{root}/terraform.tfstate"
      region: us-east-1
  providers:
    aws:
      source: hashicorp/aws
      version: "6.67.0"
      region: us-east-1
  required_version: ">= 1.6"
  dirs:
    "envs/prod/*":
      backend: { s3: { bucket: acme-prod-state } }
      providers: { aws: { region: eu-west-1 } }
  roots:
    envs/prod/network:
      providers: { aws: { region: eu-central-1 } }
`;

describe("generate", () => {
  it("stacks the repo's settings, then each directory glob's, then the root's", () => {
    const g = validateConfig(parseYAML(HIERARCHY), "t").generate!;
    expect(rootSettings(g, "envs/dev/app")).toEqual({
      backend: { type: "s3", config: { bucket: "acme-state", key: "envs/dev/app/terraform.tfstate", region: "us-east-1" } },
      providers: { aws: { source: "hashicorp/aws", version: "6.67.0", region: "us-east-1" } },
      required_version: ">= 1.6",
    });
    expect(rootSettings(g, "envs/prod/app").backend?.config.bucket).toBe("acme-prod-state");
    expect(rootSettings(g, "envs/prod/app").providers.aws.region).toBe("eu-west-1");
    expect(rootSettings(g, "envs/prod/network").providers.aws.region).toBe("eu-central-1");
    expect(rootSettings(g, "envs/prod/network").backend?.config).toEqual({ bucket: "acme-prod-state", key: "envs/prod/network/terraform.tfstate", region: "us-east-1" });
  });

  it("null drops what an earlier level set, and a backend of another type replaces the one before", () => {
    const g: GenerateSettings = {
      backend: { s3: { bucket: "b", region: "r" } },
      providers: { aws: { region: "r" }, "aws.west": { region: "us-west-2" } },
      required_version: ">= 1.6",
      dirs: { "local/*": { backend: { local: { path: "x.tfstate" } }, providers: { "aws.west": null }, required_version: null } },
      roots: { "local/b": { backend: null } },
    };
    expect(rootSettings(g, "local/a")).toEqual({ backend: { type: "local", config: { path: "x.tfstate" } }, providers: { aws: { region: "r" } } });
    expect(rootSettings(g, "local/b").backend).toBeUndefined();
  });

  it("writes plain HCL marked as generated, in the layout fmt keeps", () => {
    const out = renderRoot({
      backend: { type: "s3", config: { bucket: "acme-state", use_lockfile: true, assume_role: { role_arn: "arn:aws:iam::1:role/x" } } },
      providers: { aws: { source: "hashicorp/aws", version: "6.67.0", region: "us-east-1", default_tags: { tags: { team: "platform", "x/y": "${not}" } } }, "aws.west": { region: "us-west-2" }, azurerm: { features: {} } },
      required_version: ">= 1.6",
    });
    expect(out.backend).toBe(`${GENERATED_MARKER}

terraform {
  backend "s3" {
    bucket       = "acme-state"
    use_lockfile = true
    assume_role  = { role_arn = "arn:aws:iam::1:role/x" }
  }
}
`);
    expect(out.providers).toBe(`${GENERATED_MARKER}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = { team = "platform", "x/y" = "$\${not}" }
  }
}

provider "aws" {
  alias  = "west"
  region = "us-west-2"
}

provider "azurerm" {
  features {}
}
`);
    expect(out.versions).toBe(`${GENERATED_MARKER}

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}
`);
  });

  it("the files tofu fmt would leave as they are, when tofu is on the path", () => {
    let has = true;
    try {
      execFileSync("tofu", ["version"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return;
    const dir = repo(HIERARCHY);
    generate(dir);
    execFileSync("tofu", ["fmt", "-check", "-recursive", dir], { stdio: "pipe" });
  });

  it("writes each root's files, and once written, --check passes and a second run changes nothing", () => {
    const dir = repo(HIERARCHY);
    const first = generate(dir);
    expect(first.roots).toEqual(["envs/dev/app", "envs/prod/app", "envs/prod/network"]);
    expect(first.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual(
      ["envs/dev/app", "envs/prod/app", "envs/prod/network"].flatMap((r) => ["backend.tf", "providers.tf", "versions.tf"].map((n) => [`${r}/${n}`, "created"])),
    );
    expect(planGenerate(dir, settingsOf(dir)).files.every((f) => f.status === "unchanged")).toBe(true);
    expect(checkGenerated(dir, settingsOf(dir))).toMatchObject({ ok: true, log: ["generated files match terragucci.yml: 9 files in 3 roots"] });
  });

  it("one global changed, every root's backend file follows", () => {
    const dir = repo(HIERARCHY.replace("      backend: { s3: { bucket: acme-prod-state } }\n", ""));
    generate(dir);
    write(dir, { "terragucci.yml": readFileSync(join(dir, "terragucci.yml"), "utf-8").replace("bucket: acme-state", "bucket: acme-state-2") });
    const plan = generate(dir);
    expect(plan.files.filter((f) => f.status === "updated").map((f) => f.path.slice(dir.length + 1))).toEqual(["envs/dev/app/backend.tf", "envs/prod/app/backend.tf", "envs/prod/network/backend.tf"]);
    for (const r of plan.roots) expect(readFileSync(join(dir, r, "backend.tf"), "utf-8")).toContain('bucket = "acme-state-2"');
  });

  it("--check refuses a hand-edited generated file, a missing one, and one the config no longer asks for, by name", () => {
    const dir = repo(HIERARCHY);
    generate(dir);
    const backend = join(dir, "envs/prod/app/backend.tf");
    writeFileSync(backend, readFileSync(backend, "utf-8").replace("acme-prod-state", "hand-edited"));
    let r = checkGenerated(dir, settingsOf(dir));
    expect(r.ok).toBe(false);
    expect(r.log).toEqual([
      "refused: envs/prod/app/backend.tf differs from what terragucci generate writes from terragucci.yml:",
      '    -    bucket = "hand-edited"',
      '    +    bucket = "acme-prod-state"',
      "FAILED generate: 1 generated file out of line with terragucci.yml; run terragucci generate and commit what it writes",
    ]);
    generate(dir);
    write(dir, { "terragucci.yml": HIERARCHY.replace("  required_version: \">= 1.6\"\n", "").replace(/  providers:\n    aws:\n      source: hashicorp\/aws\n      version: "6.67.0"\n      region: us-east-1\n/, "") });
    write(dir, { "envs/dev/app/backend.tf": "" });
    git(dir, "init", "-q");
    r = checkGenerated(dir, settingsOf(dir));
    expect(r.log.filter((l) => l.startsWith("refused"))).toEqual(
      expect.arrayContaining([
        "refused: envs/dev/app/backend.tf exists and terragucci did not write it; move what it declares into terragucci.yml's generate key and remove it, or drop backend from generate for envs/dev/app",
        "refused: envs/dev/app/providers.tf was generated, and terragucci.yml no longer asks for it",
        "refused: envs/dev/app/versions.tf was generated, and terragucci.yml no longer asks for it",
      ]),
    );
  });

  it("refuses a root whose own files declare a backend or required_version it would generate", () => {
    const dir = repo(HIERARCHY);
    write(dir, { "envs/dev/app/main.tf": `terraform {\n  backend "local" {}\n}\n` });
    expect(() => planGenerate(dir, settingsOf(dir))).toThrow(/envs\/dev\/app\/main\.tf declares a backend, and generate writes envs\/dev\/app\/backend\.tf/);
    write(dir, { "envs/dev/app/main.tf": `terraform {\n  required_version = ">= 1.5"\n}\n` });
    expect(() => planGenerate(dir, settingsOf(dir))).toThrow(/envs\/dev\/app\/main\.tf sets required_version/);
  });

  it("required_version comes from the version map when no level sets it, and an exact one that disagrees is refused", () => {
    const g: GenerateSettings = { backend: { local: {} } };
    const version = { "envs/prod/*": "1.10.6" };
    expect(rootSettings(g, "envs/prod/app", { version }).required_version).toBe("1.10.6");
    expect(rootSettings(g, "envs/dev/app", { version }).required_version).toBeUndefined();
    expect(rootSettings(g, "envs/dev/app", { version: "1.11.2" }).required_version).toBe("1.11.2");
    expect(rootSettings(g, "envs/dev/app", { version: "1.11.2", binary: "choudoufu" }).required_version).toBeUndefined();
    expect(rootSettings({ ...g, required_version: ">= 1.6" }, "envs/prod/app", { version }).required_version).toBe(">= 1.6");
    expect(() => rootSettings({ ...g, required_version: "= 1.9.0" }, "envs/prod/app", { version })).toThrow(/generate gives required_version = 1\.9\.0, and terragucci\.yml's version envs\/prod\/\* pins 1\.10\.6/);
    // The pin the job runs reads the generated required_version, so a root pinned there runs that version.
    const dir = repo(`binary: tofu\nroots: ["envs/*/*"]\ngenerate:\n  required_version: "1.10.6"\n`);
    generate(dir);
    expect(readFileSync(join(dir, "envs/dev/app/versions.tf"), "utf-8")).toContain('required_version = "1.10.6"');
  });

  it("a generate.roots path is a root even before it has a backend; one that is not a directory is refused", () => {
    const dir = write(tmp(), { "new/main.tf": resource("new"), "terragucci.yml": "generate:\n  backend: { local: {} }\n  roots:\n    new: {}\n" });
    expect(generate(dir).roots).toEqual(["new"]);
    expect(readFileSync(join(dir, "new/backend.tf"), "utf-8")).toContain('backend "local" {}');
    write(dir, { "terragucci.yml": "generate:\n  roots:\n    gone: {}\n" });
    expect(() => planGenerate(dir, settingsOf(dir))).toThrow(/generate\.roots names gone, which is not a directory/);
  });

  describe("in a Terragrunt repo", () => {
    const INCLUDE = 'include "terragucci" {\n  path = find_in_parent_folders("terragucci.hcl")\n}\n';
    const unitHcl = (extra = INCLUDE): string => `${extra}\nterraform {\n  source = "../../modules/thing"\n}\n`;
    const CONFIG = [
      "generate:",
      "  backend:",
      "    s3: { bucket: state, key: \"gen/{root}.tfstate\", region: us-east-1 }",
      "  providers:",
      "    aws: { source: hashicorp/aws, version: \"6.67.0\", region: us-east-1 }",
      "  dirs:",
      "    \"live/prod/*\":",
      "      providers: { aws: { region: eu-west-1 } }",
      "  roots:",
      "    live/dev/web:",
      "      required_version: \">= 1.6\"",
      "",
    ].join("\n");
    const tgRepo = (config = CONFIG, files: Record<string, string> = {}): string =>
      write(tmp(), {
        "root.hcl": "",
        "live/dev/app/terragrunt.hcl": unitHcl(),
        "live/dev/web/terragrunt.hcl": unitHcl(),
        "live/prod/app/terragrunt.hcl": unitHcl(),
        "modules/thing/main.tf": resource("thing"),
        "terragucci.yml": config,
        ...files,
      });

    it("writes one terragucci.hcl: each unit's settings by its path, through remote_state and generate blocks", () => {
      const dir = tgRepo();
      const plan = generate(dir);
      expect(plan.terragrunt).toBe(true);
      expect(plan.roots).toEqual(["live/dev/app", "live/dev/web", "live/prod/app"]);
      expect(plan.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual([["terragucci.hcl", "created"]]);
      const hcl = readFileSync(join(dir, "terragucci.hcl"), "utf-8");
      expect(hcl.startsWith(GENERATED_MARKER)).toBe(true);
      expect(hcl).toContain('    "live/dev/app" = {\n      backend   = "s3"\n      config    = { bucket = "state", key = "gen/live/dev/app${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}.tfstate", region = "us-east-1" }\n      providers = <<-EOT\n        provider "aws" {\n          region = "us-east-1"\n        }\n      EOT\n      versions  = <<-EOT\n        terraform {\n          required_providers {');
      // The prod unit takes its glob's region; web alone takes its own required_version.
      expect(hcl).toMatch(/"live\/prod\/app" = \{[\s\S]*?region = "eu-west-1"/);
      expect(hcl.match(/required_version = ">= 1\.6"/g)).toHaveLength(1);
      expect(hcl).toContain('  terragucci_unit = local.terragucci_units[path_relative_to_include("terragucci")]');
      expect(hcl).toContain('remote_state {\n  backend      = local.terragucci_unit.backend\n  disable_init = true\n\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n\n  config = local.terragucci_unit.config\n}');
      expect(hcl).toContain('generate "terragucci_providers" {\n  path      = "providers.tf"\n  if_exists = "overwrite_terragrunt"\n  disable   = local.terragucci_unit.providers == ""\n  contents  = local.terragucci_unit.providers\n}');
      // Once written, --check passes and a second run changes nothing.
      expect(checkGenerated(dir, settingsOf(dir))).toMatchObject({ ok: true, log: ["generated files match terragucci.yml: 1 file for 3 units"] });
      expect(generate(dir).files.map((f) => f.status)).toEqual(["unchanged"]);
    });

    it("gives each unit's key the ephemeral suffix, empty but in a copy's run, and a gcs prefix and a local path too", () => {
      const dir = tgRepo('generate:\n  backend:\n    gcs: { bucket: b, prefix: "p/{root}/" }\n  dirs:\n    "live/prod/*":\n      backend: { local: { path: "/s/{root}.tfstate" } }\n');
      generate(dir);
      const hcl = readFileSync(join(dir, "terragucci.hcl"), "utf-8");
      expect(hcl).toContain('config  = { bucket = "b", prefix = "p/live/dev/app${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}" }');
      expect(hcl).toContain('config  = { path = "/s/live/prod/app${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}.tfstate" }');
    });

    it("writes disable_init = false in remote_state when generate sets disable_init: false, and the apply job bootstraps the backend", () => {
      const dir = tgRepo('generate:\n  disable_init: false\n  backend:\n    s3: { bucket: state, key: "{root}.tfstate", region: us-east-1 }\n');
      generate(dir);
      const hcl = readFileSync(join(dir, "terragucci.hcl"), "utf-8");
      expect(hcl).toContain("remote_state {\n  backend      = local.terragucci_unit.backend\n  disable_init = false\n");
      expect(hcl).not.toContain("terragucci_unit.disable_init");
      expect(backendBootstrap(dir, settingsOf(dir))).toBe(true);
      expect(checkGenerated(dir, settingsOf(dir)).ok).toBe(true);
    });

    it("gives each unit its own disable_init when the levels differ, and bootstraps when any unit has false", () => {
      const dir = tgRepo('generate:\n  backend:\n    s3: { bucket: state, key: "{root}.tfstate", region: us-east-1 }\n  dirs:\n    "live/prod/*":\n      disable_init: false\n');
      generate(dir);
      const hcl = readFileSync(join(dir, "terragucci.hcl"), "utf-8");
      expect(hcl).toContain('    "live/dev/app" = {\n      backend      = "s3"\n      config       = { bucket = "state", key = "live/dev/app${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}.tfstate", region = "us-east-1" }\n      disable_init = true\n    }');
      expect(hcl).toMatch(/"live\/prod\/app" = \{[\s\S]*?disable_init = false\n    \}/);
      expect(hcl).toContain("  disable_init = local.terragucci_unit.disable_init\n");
      expect(backendBootstrap(dir, settingsOf(dir))).toBe(true);
      // A root's own true over its glob's false: no unit has false, so no bootstrap.
      const back = tgRepo('generate:\n  backend:\n    s3: { bucket: state, key: "{root}.tfstate", region: us-east-1 }\n  dirs:\n    "live/prod/*":\n      disable_init: false\n  roots:\n    live/prod/app:\n      disable_init: null\n');
      expect(backendBootstrap(back, settingsOf(back))).toBe(false);
      generate(back);
      expect(readFileSync(join(back, "terragucci.hcl"), "utf-8")).toContain("  disable_init = true\n");
    });

    it("refuses disable_init with no backend, for a plain root, and as anything but a boolean", () => {
      const none = tgRepo("generate:\n  disable_init: false\n  required_version: \">= 1.6\"\n");
      expect(() => planGenerate(none, settingsOf(none))).toThrow("generate sets disable_init for live/dev/app, live/dev/web, live/prod/app and gives no unit a backend, so terragucci.hcl writes no remote_state for it; give the units a backend, or remove disable_init");
      const plain = repo('roots: ["envs/*/*"]\ngenerate:\n  disable_init: false\n  backend:\n    s3: { bucket: b, key: k, region: us-east-1 }\n');
      expect(() => planGenerate(plain, settingsOf(plain))).toThrow("generate sets disable_init for envs/dev/app, which is a plain root; disable_init is the remote_state setting terragucci.hcl writes for Terragrunt units, so remove it");
      expect(() => validateConfig({ generate: { disable_init: "no" } }, "t")).toThrow(/config\.generate\.disable_init must be true, false or null/);
    });

    it("is refused with synth, naming the CDK Terrain constructs that set what it would write", () => {
      const dir = tgRepo();
      expect(() => planGenerate(dir, { ...settingsOf(dir), synth: "npx cdktn synth" })).toThrow(/^generate: with synth the roots are written by the synth command, and the app sets what generate would write through its constructs: the backend with a backend construct \(S3Backend, GcsBackend, AzurermBackend, LocalBackend/);
      expect(() => validateConfig({ synth: "npx cdktn synth", generate: { required_version: ">= 1.6" } }, "t")).toThrow(/config\.generate: with synth .*leave generate unset/);
    });

    it("takes an include of terragucci.hcl however its path is built", () => {
      expect(includesGenerated(INCLUDE)).toBe(true);
      expect(includesGenerated('include "terragucci" {\n  path = "${get_repo_root()}/terragucci.hcl"\n}\n')).toBe(true);
      expect(includesGenerated('# include "terragucci" { path = "terragucci.hcl" }\ninclude "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n')).toBe(false);
    });

    it("keeps an interpolation out of the files Terragrunt writes", () => {
      const dir = tgRepo('generate:\n  providers:\n    aws: { default_tags: { tags: { note: "${var.x}" } } }\n');
      generate(dir);
      // The .tf content escapes it once, and the heredoc once more, so Terragrunt writes "$${var.x}".
      expect(readFileSync(join(dir, "terragucci.hcl"), "utf-8")).toContain('note = "$$${var.x}"');
    });

    it("--check refuses a unit that does not include terragucci.hcl, another remote_state, and a generate block for the same file, by name", () => {
      const dir = tgRepo(CONFIG, {
        "live/dev/web/terragrunt.hcl": unitHcl('include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n'),
        "root.hcl": 'remote_state {\n  backend = "s3"\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite"\n  }\n  config = {}\n}\n\ngenerate "provider" {\n  path      = "providers.tf"\n  if_exists = "overwrite"\n  contents  = ""\n}\n',
      });
      const r = checkGenerated(dir, settingsOf(dir));
      expect(r.ok).toBe(false);
      expect(r.log).toEqual(expect.arrayContaining([
        expect.stringMatching(/^refused: live\/dev\/web\/terragrunt\.hcl does not include terragucci\.hcl, so generate's settings never reach it; add include "terragucci" \{ path = find_in_parent_folders\("terragucci\.hcl"\) \}$/),
        "refused: root.hcl declares remote_state, and terragucci.hcl gives each unit its backend from generate; remove one of them",
        "refused: root.hcl has a generate block that writes providers.tf, which terragucci.hcl writes from generate; remove one of them",
      ]));
      // remote_state's own generate = { } is not counted as a generate block.
      expect(r.log.filter((l) => l.includes("writes backend.tf"))).toEqual([]);
    });

    it("refuses a backend for some units and not others, and a generate.roots path that is no unit", () => {
      const dir = tgRepo('generate:\n  roots:\n    live/dev/app:\n      backend: { local: {} }\n');
      expect(() => planGenerate(dir, settingsOf(dir))).toThrow("generate gives live/dev/app a backend and not live/dev/web, live/prod/app");
      const other = tgRepo('generate:\n  roots:\n    modules/thing:\n      required_version: ">= 1.6"\n');
      expect(() => planGenerate(other, settingsOf(other))).toThrow("generate.roots names modules/thing, which is not a Terragrunt unit in the repo");
    });

    it("removes terragucci.hcl once the config no longer asks for it, and never overwrites one it did not write", () => {
      const dir = tgRepo();
      generate(dir);
      writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
      expect(planGenerate(dir, settingsOf(dir)).files.map((f) => f.status)).toEqual(["removed"]);
      const mine = tgRepo(CONFIG, { "terragucci.hcl": "locals {}\n" });
      expect(planGenerate(mine, settingsOf(mine)).foreign).toEqual([expect.stringMatching(/^terragucci\.hcl exists and terragucci did not write it/)]);
    });

    it("init adds generate --check to the Terragrunt check job, and config check takes generate beside a terragrunt block", async () => {
      const dir = tgRepo(`binary: tofu\nforge: github\nterragrunt:\n  version: 1.1.6\n${CONFIG}`);
      generate(dir);
      const result = await init(dir, { binary: "tofu", forge: "github", dryRun: true, terragrunt: "/nonexistent/terragrunt" });
      const wf = result.files.find((f) => f.path.endsWith(".github/workflows/terragucci.yml"))!.content;
      expect(wf).toContain("terragucci generate --check");
      expect(validateConfig({ terragrunt: {}, generate: { backend: { local: {} } } }, "t")).toEqual({ terragrunt: {}, generate: { backend: { local: {} } } });
    });
  });

  it("config check names each problem in a generate key", () => {
    const bad = {
      generate: {
        backend: { s3: { bucket: "a" }, gcs: {} },
        providers: { "AWS!": {}, aws: { alias: "west", source: 1 } },
        required_version: 3,
        dirs: { "envs/*": { dirs: {} } },
        other: true,
      },
    };
    let problems: string[] = [];
    try {
      validateConfig(bad, "t");
    } catch (e) {
      problems = (e as { problems: string[] }).problems;
    }
    expect(problems).toEqual([
      "config.generate.other is not a setting (settings: backend, providers, required_version, disable_init, dirs, roots)",
      "config.generate.backend must name one backend type and its arguments, such as backend: { s3: { bucket: acme-state } }, or be null",
      "config.generate.providers.AWS! is not a provider name; use its local name, such as aws, or aws.<alias> for an aliased configuration",
      "config.generate.providers.aws.alias: name an aliased configuration aws.west instead",
      "config.generate.providers.aws.source must be a string",
      'config.generate.required_version must be a version constraint, such as ">= 1.6", or null',
      'config.generate.dirs["envs/*"].dirs is not a setting (settings: backend, providers, required_version, disable_init)',
    ]);
  });

  it("init adds generate --check to the check job when generate is set, and only then", async () => {
    const dir = repo(HIERARCHY);
    generate(dir);
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.files[0].content).toContain("terragucci generate --check || failed=1");
    expect(checkScript("tofu", ["a"])).not.toContain("generate");
    expect(checkScript("tofu", ["a"], undefined, false, true).split("\n")).toContain("terragucci generate --check || failed=1");
  });

  it("a control repo's defaults and a project's own generate stack, defaults first", () => {
    const config = validateConfig(
      {
        defaults: { version: "1.10.6", generate: { backend: { s3: { bucket: "acme", region: "us-east-1" } }, dirs: { "envs/*": { providers: { aws: { region: "us-east-1" } } } } } },
        projects: { "github.com/acme/infra": { generate: { backend: { s3: { bucket: "infra" } }, dirs: { "envs/*": { providers: { aws: { region: "eu-west-1" } } } } } } },
      },
      "t",
    );
    const s = resolveProject(config, "github.com/acme/infra");
    expect(s.generate).toEqual({ backend: { s3: { bucket: "infra", region: "us-east-1" } }, dirs: { "envs/*": { providers: { aws: { region: "eu-west-1" } } } } });
    expect(projectGenerate(s)?.required_version).toBe("1.10.6");
    expect(combineGenerate(undefined, { required_version: "x" })).toEqual({ required_version: "x" });
  });

  it("reconcile writes the control repo's generated files into each project, and its generate key, so the project's check passes", async () => {
    const { reconcile } = await import("../src/reconcile");
    const project = write(tmp(), { "envs/dev/app/main.tf": `provider "aws" {}\n${resource("dev")}`, "envs/prod/app/main.tf": `provider "aws" {}\n${resource("prod")}` });
    const bare = bareFrom(project);
    const config = validateConfig(
      { defaults: { binary: "tofu", version: "1.10.6", generate: { backend: { s3: { bucket: "acme-state", key: "{root}.tfstate" } } } }, projects: { "github.com/acme/infra": { url: bare } } },
      "t",
    );
    const fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
    const [out] = await reconcile(config, { mode: "dry-run", fetch, env: {} });
    expect(out.status).toBe("would-change");
    const paths = out.changes.map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(["envs/dev/app/backend.tf", "envs/prod/app/backend.tf", "envs/dev/app/versions.tf", "terragucci.yml", ".github/workflows/terragucci.yml"]));
    expect(out.changes.find((c) => c.path === "envs/prod/app/backend.tf")?.content).toContain('key    = "envs/prod/app.tfstate"');
    expect(out.changes.find((c) => c.path === ".github/workflows/terragucci.yml")?.content).toContain("terragucci generate --check");
    // The project as reconcile would leave it: its own terragucci.yml gives the same files, so its tf-check passes.
    const clone = tmp();
    git(clone, "clone", "-q", bare, ".");
    for (const c of out.changes) write(clone, { [c.path]: c.content });
    const projectFile = parseYAML(readFileSync(join(clone, "terragucci.yml"), "utf-8")) as Record<string, unknown>;
    expect(projectFile.generate).toEqual({ backend: { s3: { bucket: "acme-state", key: "{root}.tfstate" } }, required_version: "1.10.6" });
    expect(checkGenerated(clone, settingsOf(clone)).ok).toBe(true);
    expect(existsSync(join(bare, "refs/heads/terragucci/pipeline"))).toBe(false);
  });

  it("lineDiff marks what the file holds with - and what generate writes with +", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual(["-b", "+B"]);
    expect(lineDiff("a", "a")).toEqual([]);
  });
});
