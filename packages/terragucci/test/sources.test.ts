import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { ConfigError, validateConfig } from "../src/config";
import { runStage } from "../src/report/stage";
import { loadHclParser } from "../src/rollout/parser";
import { checkSourcesResult } from "../src/check";
import { chantExitCodes, chantSourceForms } from "../src/chant-next";
import { main } from "../src/cli";
import { init } from "../src/init";
import { checkScript } from "../src/render";
import { checkLockedSources, checkRootSources, governingSources, lockedSources, moduleForms, providerForms, rootSources, sourceAllowed, sourceChecker, sourceGlob, sourceRefusalLines } from "../src/sources";
import { git, tmp, write } from "./helpers";

const parser = await loadHclParser();
// A usage error exits 1 under chant's exit-code table (chant#4553), 2 before it.
const USAGE = (await chantExitCodes()) ? 1 : 2;
// chant's used-sources read (chant#3924) says "project" where terragucci's own says "repo".
const OUTSIDE = (await chantSourceForms()) ? "outside the project" : "outside the repo";

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems ?? [e.message];
  }
};

const GIT_HOST = "git::https://git.example.com/platform";
const OTHER_HOST = "git::https://git.unlisted.example/acme";

describe("the sources key", () => {
  it("takes modules, providers or both, each a list of globs", () => {
    expect(problems({ sources: { modules: ["./**", `${GIT_HOST}/**`] } })).toEqual([]);
    expect(problems({ sources: { providers: ["hashicorp/*"] } })).toEqual([]);
    expect(problems({ sources: { modules: ["./**"], providers: ["registry.example.com/acme/*"] } })).toEqual([]);
  });

  it("refuses an empty map, an unknown key, an empty list and a glob with a space", () => {
    expect(problems({ sources: {} })[0]).toContain("config.sources must be a map with modules, providers or both");
    expect(problems({ sources: { module: ["./**"] } })[0]).toContain("config.sources.module is not a setting");
    expect(problems({ sources: { modules: [] } })[0]).toContain("config.sources.modules must be a list of source globs");
    expect(problems({ sources: { providers: ["hashicorp/ aws"] } })[0]).toContain("config.sources.providers must be a list of source globs");
  });
});

describe("matching a source against the list", () => {
  it("reads * within one part and ** across parts, everything else as written", () => {
    expect(sourceGlob("registry.example.com/acme/*").test("registry.example.com/acme/x")).toBe(true);
    expect(sourceGlob("registry.example.com/acme/*").test("registry.example.com/acme/x/y")).toBe(false);
    expect(sourceGlob(`${GIT_HOST}/**`).test(`${GIT_HOST}/vpc.git//modules/a`)).toBe(true);
    expect(sourceGlob("a.b/*").test("aXb/c")).toBe(false);
  });

  it("matches a module source without its query, and a hostless registry address at the default registries", () => {
    expect(moduleForms(`${GIT_HOST}/vpc.git//net?ref=v1.2.0`)).toEqual([`${GIT_HOST}/vpc.git//net`]);
    expect(moduleForms("terraform-aws-modules/vpc/aws")).toEqual(["terraform-aws-modules/vpc/aws", "registry.terraform.io/terraform-aws-modules/vpc/aws", "registry.opentofu.org/terraform-aws-modules/vpc/aws"]);
    expect(moduleForms("tfr:///terraform-aws-modules/vpc/aws?version=5.0.0")).toContain("registry.terraform.io/terraform-aws-modules/vpc/aws");
    expect(moduleForms("tfr://registry.example.com/acme/vpc/aws?version=1.0.0")).toContain("registry.example.com/acme/vpc/aws");
    expect(sourceAllowed("module", `${GIT_HOST}/vpc.git//net?ref=v1`, [`${GIT_HOST}/**`])).toBe(true);
    expect(sourceAllowed("module", `${OTHER_HOST}/vpc.git?ref=v1`, [`${GIT_HOST}/**`])).toBe(false);
    expect(sourceAllowed("module", "terraform-aws-modules/vpc/aws", ["registry.terraform.io/terraform-aws-modules/*/*"])).toBe(true);
  });

  it("matches a provider address in lower case, and a hostless one at the default registries", () => {
    expect(providerForms("HashiCorp/AWS")).toEqual(["hashicorp/aws", "registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/aws"]);
    expect(providerForms("registry.example.com/acme/x")).toEqual(["registry.example.com/acme/x"]);
    expect(sourceAllowed("provider", "hashicorp/aws", ["registry.opentofu.org/hashicorp/*"])).toBe(true);
    expect(sourceAllowed("provider", "registry.example.com/Acme/x", ["registry.example.com/acme/*"])).toBe(true);
    expect(sourceAllowed("provider", "evil/aws", ["hashicorp/*"])).toBe(false);
  });
});

describe("the sources a root uses", () => {
  it("reads module calls and required_providers, follows local modules, and names a provider only a resource implies", async () => {
    const repo = write(tmp("tg-sources-"), {
      "app/main.tf": `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
module "net" {
  source = "../modules/net"
}
module "vpc" {
  source  = "${GIT_HOST}/vpc.git?ref=v1"
}
resource "terraform_data" "x" {}
resource "aws_s3_bucket" "b" {}
`,
      "modules/net/main.tf": `module "deep" {
  source = "./deep"
}
`,
      "modules/net/deep/main.tf": `terraform {
  required_providers {
    acme = { source = "registry.example.com/acme/acme" }
  }
}
resource "random_id" "r" {}
`,
      "modules/net/deep/extra.tf.json": JSON.stringify({ module: { j: { source: `${OTHER_HOST}/j.git` } } }),
    });
    const { used, unread } = await rootSources(repo, "app", parser);
    expect(unread).toEqual([]);
    expect(used).toEqual(
      expect.arrayContaining([
        { kind: "provider", file: "app/main.tf", block: "required_providers.aws", source: "hashicorp/aws" },
        { kind: "module", file: "app/main.tf", block: "module.net", source: "../modules/net" },
        { kind: "module", file: "app/main.tf", block: "module.vpc", source: `${GIT_HOST}/vpc.git?ref=v1` },
        { kind: "module", file: "modules/net/main.tf", block: "module.net > module.deep", source: "./deep" },
        { kind: "provider", file: "modules/net/deep/main.tf", block: "module.net > module.deep > required_providers.acme", source: "registry.example.com/acme/acme" },
        { kind: "provider", file: "modules/net/deep/main.tf", block: "module.net > module.deep > provider.random", source: "hashicorp/random", implied: 'resource "random_id" "r"' },
        { kind: "module", file: "modules/net/deep/extra.tf.json", block: "module.net > module.deep > module.j", source: `${OTHER_HOST}/j.git` },
      ]),
    );
    // terraform_data is the binary's own; aws has its entry.
    expect(used.filter((u) => u.block === "provider.terraform" || u.block === "provider.aws")).toEqual([]);
  });

  it("reads a Terragrunt unit's terraform source and follows a local one through its //", async () => {
    const repo = write(tmp("tg-sources-tg-"), {
      "live/dev/vpc/terragrunt.hcl": 'terraform {\n  source = "../../../modules//vpc"\n}\n',
      "modules/vpc/main.tf": 'terraform {\n  required_providers {\n    evil = { source = "evil/evil" }\n  }\n}\n',
    });
    const { used } = await rootSources(repo, "live/dev/vpc", parser);
    expect(used).toEqual([
      { kind: "module", file: "live/dev/vpc/terragrunt.hcl", block: "terraform", source: "../../../modules//vpc" },
      { kind: "provider", file: "modules/vpc/main.tf", block: "terraform > required_providers.evil", source: "evil/evil" },
    ]);
  });

  it("checks a unit's oci:// terraform source against globs that include the scheme", async () => {
    const repo = write(tmp("tg-sources-oci-"), {
      "live/dev/net/terragrunt.hcl": 'terraform {\n  source = "oci://ghcr.io/acme/modules/net//nested/inner?tag=0.1.0"\n}\n',
    });
    expect(await checkRootSources(repo, "live/dev/net", { modules: ["oci://ghcr.io/acme/**"] }, parser)).toEqual([]);
    const refused = await checkRootSources(repo, "live/dev/net", { modules: ["ghcr.io/acme/**"] }, parser);
    expect(sourceRefusalLines("live/dev/net", refused)).toEqual([
      "refused: live/dev/net: terraform (live/dev/net/terragrunt.hcl) uses module source oci://ghcr.io/acme/modules/net//nested/inner?tag=0.1.0, which no entry of sources.modules matches (sources.modules: ghcr.io/acme/**)",
    ]);
  });

  it("checks the source of the stack unit block that generates a unit, and leaves a template in the repo to the unit's own files", async () => {
    const stack = 'unit "net" {\n  source = "oci://ghcr.io/acme/modules/net-unit?tag=0.1.0"\n  path   = "net"\n}\n\nunit "app" {\n  source = "${get_repo_root()}/units/app"\n  path   = "app"\n}\n';
    const repo = write(tmp("tg-sources-stack-"), { "live/terragrunt.stack.hcl": stack, "units/app/terragrunt.hcl": "" });
    const { used } = await rootSources(repo, "live/.terragrunt-stack/net", parser);
    expect(used).toEqual([{ kind: "module", file: "live/terragrunt.stack.hcl", block: "unit.net", source: "oci://ghcr.io/acme/modules/net-unit?tag=0.1.0" }]);
    expect((await rootSources(repo, "live/.terragrunt-stack/app", parser)).used).toEqual([]);
    const refused = await checkRootSources(repo, "live/.terragrunt-stack/net", { modules: ["oci://registry.example.com/**"] }, parser);
    expect(sourceRefusalLines("live/.terragrunt-stack/net", refused)).toEqual([
      "refused: live/.terragrunt-stack/net: unit.net (live/terragrunt.stack.hcl) uses module source oci://ghcr.io/acme/modules/net-unit?tag=0.1.0, which no entry of sources.modules matches (sources.modules: oci://registry.example.com/**)",
    ]);
  });

  it("names a local module outside the repo as unread, since what it uses cannot be checked", async () => {
    const repo = write(tmp("tg-sources-out-"), { "app/main.tf": 'module "x" {\n  source = "../../elsewhere"\n}\n' });
    const refused = await checkRootSources(repo, "app", { modules: ["./**", "../**"] }, parser);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.why).toContain(OUTSIDE);
  });
});

describe("refusing a root", () => {
  const files = {
    "app/main.tf": `terraform {
  required_providers {
    aws  = { source = "hashicorp/aws" }
    evil = { source = "registry.evil.example/evil/evil" }
  }
}
module "ok" {
  source = "${GIT_HOST}/ok.git?ref=v1"
}
module "bad" {
  source = "${OTHER_HOST}/bad.git?ref=v1"
}
`,
  };

  it("refuses an unlisted module source, naming the root, the block, the file, the source and the list", async () => {
    const repo = write(tmp("tg-sources-mod-"), files);
    const refused = await checkRootSources(repo, "app", { modules: [`${GIT_HOST}/**`] }, parser);
    expect(sourceRefusalLines("app", refused)).toEqual([`refused: app: module.bad (app/main.tf) uses module source ${OTHER_HOST}/bad.git?ref=v1, which no entry of sources.modules matches (sources.modules: ${GIT_HOST}/**)`]);
  });

  it("refuses an unlisted provider, and checks no module when only providers is set", async () => {
    const repo = write(tmp("tg-sources-prov-"), files);
    const refused = await checkRootSources(repo, "app", { providers: ["hashicorp/*"] }, parser);
    expect(sourceRefusalLines("app", refused)).toEqual(["refused: app: required_providers.evil (app/main.tf) uses provider registry.evil.example/evil/evil, which no entry of sources.providers matches (sources.providers: hashicorp/*)"]);
  });

  it("passes a root whose every source is listed", async () => {
    const repo = write(tmp("tg-sources-ok-"), files);
    expect(await checkRootSources(repo, "app", { modules: ["git::https://git.*.example/**", `${GIT_HOST}/**`], providers: ["hashicorp/*", "registry.evil.example/evil/*"] }, parser)).toEqual([]);
  });
});

/** A repo whose main holds `base` and whose branch `change` holds `head` on top of it. */
function branched(base: Record<string, string>, head: Record<string, string>): { repo: string; baseSha: string } {
  const repo = tmp("tg-sources-git-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, base);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", "change");
  write(repo, head);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "change");
  return { repo, baseSha };
}

describe("the list is read at base", () => {
  it("a change that widens the list is checked against the base's", async () => {
    const { repo, baseSha } = branched({ "terragucci.yml": "sources:\n  modules: ['./**']\n" }, { "terragucci.yml": "sources:\n  modules: ['./**', '**']\n" });
    expect(await governingSources(repo, { modules: ["./**", "**"] }, baseSha)).toEqual({ sources: { modules: ["./**"] }, from: "base" });
  });

  it("a change that deletes the key is still checked against the base's", async () => {
    const { repo, baseSha } = branched({ "terragucci.yml": "sources:\n  providers: ['hashicorp/*']\n" }, { "terragucci.yml": "gate: never\n" });
    expect(await governingSources(repo, undefined, baseSha)).toEqual({ sources: { providers: ["hashicorp/*"] }, from: "base" });
  });

  it("a base with no key leaves the checkout's, and no base reads the checkout's", async () => {
    const { repo, baseSha } = branched({ "terragucci.yml": "gate: never\n" }, {});
    expect(await governingSources(repo, { modules: ["./**"] }, baseSha)).toEqual({ sources: { modules: ["./**"] }, from: "checkout" });
    expect(await governingSources(repo, { modules: ["./**"] }, undefined)).toEqual({ sources: { modules: ["./**"] }, from: "checkout" });
  });

  it("a base it cannot read fails a checkout with the key, and checks nothing for one without it", async () => {
    const { repo } = branched({ "terragucci.yml": "gate: never\n" }, {});
    await expect(governingSources(repo, { modules: ["./**"] }, "origin/nowhere")).rejects.toThrow(/sources is read from the config at origin\/nowhere/);
    expect(await governingSources(repo, undefined, "origin/nowhere")).toEqual({ from: "checkout" });
  });

  it("with no key at base or in the checkout there is no check and nothing is logged", async () => {
    const { repo, baseSha } = branched({ "terragucci.yml": "gate: never\n" }, {});
    const log = vi.fn();
    expect(await sourceChecker(repo, undefined, baseSha, {}, { log })).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});

/** A fake tofu for tf-plan that logs each call and plans one terraform_data. */
function planTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add"; exit 0 ;;
  show) if [ "$2" = "-json" ]; then echo '{"format_version":"1.2","resource_changes":[{"address":"terraform_data.x","mode":"managed","type":"terraform_data","name":"x","change":{"actions":["create"],"before":null,"after":{"input":"1"},"after_unknown":{}}}]}'; else echo "plan text"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan with sources", () => {
  const ROOT = 'terraform {\n  backend "local" {}\n}\n';
  const calls = (bin: string): string => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf-8") : "");

  it("fails a root calling an unlisted module before its init, and the report names the call and the source", { timeout: 60_000 }, async () => {
    const { repo } = branched(
      { "terragucci.yml": "sources:\n  modules: ['./**']\n", "app/main.tf": ROOT },
      { "terragucci.yml": `sources:\n  modules: ['./**', '${OTHER_HOST}/**']\n`, "app/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git?ref=v1"\n}\n` },
    );
    const bin = tmp();
    const lines: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, (l) => lines.push(l));
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].error).toContain(`refused: app: module.bad (app/mod.tf) uses module source ${OTHER_HOST}/bad.git?ref=v1, which no entry of sources.modules matches (sources.modules: ./**)`);
    expect(calls(bin)).not.toContain("init");
    expect(lines.join("\n")).toContain("against the list in the config at main");
  });

  it("fails a root whose required_providers names an unlisted provider", { timeout: 60_000 }, async () => {
    const { repo } = branched(
      { "terragucci.yml": "sources:\n  providers: ['hashicorp/*']\n", "app/main.tf": ROOT },
      { "app/prov.tf": 'terraform {\n  required_providers {\n    evil = { source = "evil/evil" }\n  }\n}\n' },
    );
    const bin = tmp();
    const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].error).toContain("refused: app: required_providers.evil (app/prov.tf) uses provider evil/evil");
    expect(calls(bin)).not.toContain("init");
  });

  it("with no sources key plans as before, and with a list every source matches plans too", { timeout: 60_000 }, async () => {
    const change = { "app/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git?ref=v1"\n}\n` };
    for (const config of ["gate: never\n", `sources:\n  modules: ['${OTHER_HOST}/**']\n`]) {
      const { repo } = branched({ "terragucci.yml": config, "app/main.tf": ROOT }, change);
      const bin = tmp();
      const lines: string[] = [];
      const result = await runStage("tf-plan", repo, { binary: planTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, (l) => lines.push(l));
      expect(result.failed, config).toBe(false);
      expect(calls(bin)).toContain("init");
      if (config.startsWith("gate")) expect(lines.join("\n")).not.toMatch(/\bsources[:.]|by sources/);
    }
  });

  it("checks a drift run against the checkout's list", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "terragucci.yml": "sources:\n  modules: ['./**']\n", "app/main.tf": ROOT, "app/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git"\n}\n` }, {});
    const bin = tmp();
    const result = await runStage("tf-drift", repo, { binary: planTofu(bin), env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, () => {});
    expect(result.report.roots[0].error).toContain("refused: app: module.bad");
    expect(calls(bin)).not.toContain("init");
  });
});

/** A fake tofu for a wave: plan writes the root into the plan file, show -json prints one create, apply logs the root. */
const FAKE = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
echo "$root $2" >> "$CALLS"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) echo '{"resource_changes":[{"address":"terraform_data.x","mode":"managed","type":"terraform_data","name":"x","change":{"actions":["create"],"before":null,"after":{"input":"1"},"after_unknown":{}}}]}' ;;
  apply) echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

describe("a tf-apply wave with sources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** A repo whose first commit holds `base` and whose second, the one applied, holds `head`. */
  function setup(base: Record<string, string>, head: Record<string, string>): { work: string; bin: string; calls: string } {
    const dir = tmp("tg-sources-wave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(join(work, "a"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, base);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    write(work, head);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("CALLS", join(dir, "calls.log"));
    return { work, bin, calls: join(dir, "calls.log") };
  }
  const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: { ...process.env } });

  it("refuses a root before its init, against the list at the applied commit's first parent", async () => {
    const { work, bin, calls } = setup(
      { "terragucci.yml": "sources:\n  modules: ['./**']\n", "a/main.tf": "# a\n" },
      { "terragucci.yml": "gate: never\n", "a/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git"\n}\n` },
    );
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(1);
    expect(existsSync(calls) ? readFileSync(calls, "utf-8") : "").not.toContain("init");
    expect(out.mock.calls.flat().join("\n")).toContain("refused: a: module.bad (a/mod.tf) uses module source");
  });

  it("applies as before with no sources key", async () => {
    const { work, bin, calls } = setup({ "terragucci.yml": "gate: never\n", "a/main.tf": "# a\n" }, { "a/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git"\n}\n` });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(0);
    expect(readFileSync(calls, "utf-8")).toContain("a apply");
    expect(out.mock.calls.flat().join("\n")).not.toMatch(/\bsources[:.]|by sources/);
  });
});

describe("forms of an address at a default registry", () => {
  it("matches a module or provider address that names registry.terraform.io or registry.opentofu.org against a glob without a host", () => {
    expect(moduleForms("registry.terraform.io/terraform-aws-modules/vpc/aws")).toEqual(["registry.terraform.io/terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws", "registry.opentofu.org/terraform-aws-modules/vpc/aws"]);
    expect(providerForms("registry.opentofu.org/HashiCorp/null")).toEqual(["registry.opentofu.org/hashicorp/null", "hashicorp/null", "registry.terraform.io/hashicorp/null"]);
    expect(sourceAllowed("provider", "registry.opentofu.org/hashicorp/aws", ["hashicorp/*"])).toBe(true);
    expect(sourceAllowed("provider", "registry.opentofu.org/hashicorp/null", ["hashicorp/aws"])).toBe(false);
    expect(sourceAllowed("module", "registry.terraform.io/terraform-aws-modules/vpc/aws", ["terraform-aws-modules/**"])).toBe(true);
    expect(providerForms("registry.example.com/acme/x")).toEqual(["registry.example.com/acme/x"]);
  });
});

/** A root as init leaves it: a remote module that calls an unlisted one and a local one, a registry module, and a lock file with providers from each. */
const ROOT_TF = `terraform {
  backend "local" {}
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
module "outer" {
  source = "${GIT_HOST}/outer.git?ref=v1"
}
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}
`;
const INITED = (data = ".terraform"): Record<string, string> => ({
  [`${data}/modules/modules.json`]: JSON.stringify({
    Modules: [
      { Key: "", Source: "", Dir: "." },
      { Key: "outer", Source: `${GIT_HOST}/outer.git?ref=v1`, Dir: `${data}/modules/outer` },
      { Key: "outer.inner", Source: `${OTHER_HOST}/inner.git?ref=v2`, Dir: `${data}/modules/outer.inner` },
      { Key: "outer.sub", Source: "./sub", Dir: `${data}/modules/outer/sub` },
      { Key: "vpc", Source: "registry.terraform.io/terraform-aws-modules/vpc/aws", Version: "5.0.0", Dir: `${data}/modules/vpc` },
    ],
  }),
  [`${data}/modules/outer/main.tf`]: `module "inner" {\n  source = "${OTHER_HOST}/inner.git?ref=v2"\n}\nmodule "sub" {\n  source = "./sub"\n}\n`,
  [`${data}/modules/outer/sub/main.tf`]: 'resource "null_resource" "n" {}\n',
  [`${data}/modules/outer.inner/main.tf`]: 'terraform {\n  required_providers {\n    acme = { source = "registry.evil.example/acme/acme" }\n  }\n}\n',
  [`${data}/modules/vpc/main.tf`]: 'resource "aws_vpc" "v" {}\n',
  ".terraform.lock.hcl": ["registry.opentofu.org/hashicorp/aws", "registry.opentofu.org/hashicorp/null", "registry.evil.example/acme/acme", "registry.opentofu.org/hashicorp/stray"]
    .map((p) => `provider "${p}" {\n  version = "1.0.0"\n}\n`)
    .join("\n"),
});
const LISTS = { modules: [`${GIT_HOST}/**`, "terraform-aws-modules/**"], providers: ["hashicorp/aws"] };
const INNER_LINE = `refused: app: module.outer > module.inner (app/.terraform/modules/outer/main.tf) uses module source ${OTHER_HOST}/inner.git?ref=v2, which no entry of sources.modules matches (sources.modules: ${GIT_HOST}/**, terraform-aws-modules/**)`;
const NULL_LINE =
  'refused: app: module.outer > module.sub > provider.null (app/.terraform/modules/outer/sub/main.tf) uses provider registry.opentofu.org/hashicorp/null (implied by resource "null_resource" "n", with no required_providers entry), which no entry of sources.providers matches (sources.providers: hashicorp/aws)';

/** Prefix each path with a directory. */
const under = (dir: string, files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v]));

describe("what init fetched and locked", () => {
  it("refuses a nested remote module and providers that came in through modules, naming the module path that brought each in", async () => {
    const repo = write(tmp("tg-sources-locked-"), { "app/main.tf": ROOT_TF, ...under("app", INITED()) });
    expect(sourceRefusalLines("app", await checkLockedSources(repo, "app", LISTS, parser))).toEqual([
      INNER_LINE,
      NULL_LINE,
      "refused: app: module.outer > module.inner > required_providers.acme (app/.terraform/modules/outer.inner/main.tf) uses provider registry.evil.example/acme/acme, which no entry of sources.providers matches (sources.providers: hashicorp/aws)",
      "refused: app: lock file (app/.terraform.lock.hcl) uses provider registry.opentofu.org/hashicorp/stray, which no entry of sources.providers matches (sources.providers: hashicorp/aws)",
    ]);
  });

  it("names a local call no more, checks only the kinds whose list is set, and passes what every list names", async () => {
    const repo = write(tmp("tg-sources-locked-kinds-"), { "app/main.tf": ROOT_TF, ...under("app", INITED()) });
    const used = await lockedSources(repo, "app", parser);
    expect(used.filter((u) => u.kind === "module").map((u) => u.block)).toEqual(["module.outer", "module.outer > module.inner", "module.vpc"]);
    expect(sourceRefusalLines("app", await checkLockedSources(repo, "app", { modules: LISTS.modules }, parser))).toEqual([INNER_LINE]);
    expect(sourceRefusalLines("app", await checkLockedSources(repo, "app", { providers: LISTS.providers }, parser))).toHaveLength(3);
    expect(await checkLockedSources(repo, "app", { modules: ["git::https://**", "terraform-aws-modules/**"], providers: ["hashicorp/*", "registry.evil.example/acme/*"] }, parser)).toEqual([]);
  });

  it("reads modules.json under TF_DATA_DIR, and finds nothing in a root init has not run in", async () => {
    const repo = write(tmp("tg-sources-locked-data-"), { "app/main.tf": ROOT_TF, ...under("app", INITED("data")), "fresh/main.tf": ROOT_TF });
    const lines = sourceRefusalLines("app", await checkLockedSources(repo, "app", { modules: LISTS.modules }, parser, { TF_DATA_DIR: "data" }));
    expect(lines).toEqual([INNER_LINE.replace("app/.terraform/modules/outer/main.tf", "app/data/modules/outer/main.tf")]);
    expect(await lockedSources(repo, "fresh", parser)).toEqual([]);
  });

  it("matches a call as written in the module that makes it, and as modules.json records it only when that module cannot be read", async () => {
    const recorded = (dir: string) =>
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          { Key: "net", Source: "git::https://github.com/acme/net.git", Dir: dir },
        ],
      });
    const repo = write(tmp("tg-sources-locked-written-"), {
      "app/main.tf": 'module "net" {\n  source = "github.com/acme/net"\n}\n',
      "app/.terraform/modules/modules.json": recorded(".terraform/modules/net"),
      "gone/main.tf": "# its files are gone\n",
      "gone/.terraform/modules/modules.json": recorded(".terraform/modules/net"),
    });
    expect(await checkLockedSources(repo, "app", { modules: ["github.com/acme/**"] }, parser)).toEqual([]);
    expect(sourceRefusalLines("gone", await checkLockedSources(repo, "gone", { modules: ["github.com/acme/**"] }, parser))).toEqual([
      "refused: gone: module.net (gone/.terraform/modules/modules.json) uses module source git::https://github.com/acme/net.git, which no entry of sources.modules matches (sources.modules: github.com/acme/**)",
    ]);
  });
});

/** A fake tofu for tf-plan whose init leaves the root as INITED does. */
function initingTofu(dir: string): string {
  const fixture = write(join(dir, "fixture"), INITED());
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) cp -R "${fixture}/." "$chdir/"; exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add"; exit 0 ;;
  show) if [ "$2" = "-json" ]; then echo '{"format_version":"1.2","resource_changes":[]}'; else echo "plan text"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan checks what init fetched before plan", () => {
  const calls = (bin: string): string => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf-8") : "");
  const yml = `sources:\n  modules: ['${GIT_HOST}/**', 'terraform-aws-modules/**']\n`;

  it("fails a root whose remote module calls an unlisted one after its init, and never plans it", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "terragucci.yml": yml }, { "app/main.tf": ROOT_TF });
    const bin = tmp();
    const lines: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: initingTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, (l) => lines.push(l));
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].error).toContain(INNER_LINE);
    expect(calls(bin)).toContain("init");
    expect(calls(bin)).not.toContain(" plan");
    expect(lines.join("\n")).toContain("app: refused by sources after init, so it was not planned");
  });

  it("with no sources key inits and plans the same root as before", { timeout: 60_000 }, async () => {
    const { repo } = branched({ "terragucci.yml": "gate: never\n" }, { "app/main.tf": ROOT_TF });
    const bin = tmp();
    const lines: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: initingTofu(bin), base: "main", env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, (l) => lines.push(l));
    expect(result.failed).toBe(false);
    expect(calls(bin)).toContain(" plan");
    expect(lines.join("\n")).not.toMatch(/\bsources[:.]|by sources/);
  });
});

/** FAKE, whose init also leaves the root as INITED does. */
const INITING_FAKE = FAKE.replace('case "$2" in\n', 'case "$2" in\n  init) cp -R "$FIXTURE/." "$dir/" ;;\n');

describe("a tf-apply wave checks what init fetched before plan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function setup(config: string): { work: string; bin: string; calls: string } {
    const dir = tmp("tg-sources-wave-locked-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, { "terragucci.yml": config, "a/main.tf": ROOT_TF });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const bin = join(dir, "tofu");
    writeFileSync(bin, INITING_FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("CALLS", join(dir, "calls.log"));
    vi.stubEnv("FIXTURE", write(join(dir, "fixture"), INITED()));
    return { work, bin, calls: join(dir, "calls.log") };
  }
  const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: { ...process.env } });

  it("refuses a root after its init and before its plan, naming the module path", async () => {
    const { work, bin, calls } = setup(`gate: never\nsources:\n  modules: ['${GIT_HOST}/**', 'terraform-aws-modules/**']\n`);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(1);
    const ran = readFileSync(calls, "utf-8");
    expect(ran).toContain("a init");
    expect(ran).not.toContain("a plan");
    expect(out.mock.calls.flat().join("\n")).toContain(`refused: a: module.outer > module.inner (a/.terraform/modules/outer/main.tf) uses module source ${OTHER_HOST}/inner.git?ref=v2`);
  });

  it("applies as before with no sources key", async () => {
    const { work, bin, calls } = setup("gate: never\n");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, opts(bin))).toBe(0);
    expect(readFileSync(calls, "utf-8")).toContain("a apply");
    expect(out.mock.calls.flat().join("\n")).not.toMatch(/\bsources[:.]|by sources/);
  });
});

describe("tf-check with sources", () => {
  afterEach(() => vi.restoreAllMocks());
  const CHECK_LINE = '  terragucci check-sources "$dir" || { failed=1; continue; }';
  const PLAIN_ROOT = 'terraform {\n  backend "local" {}\n}\n';

  it("runs check-sources on each root before its init when the key is set, and renders the job as before without it", async () => {
    for (const rootPins of [false, true]) {
      const lines = checkScript("tofu", ["a"], undefined, rootPins, false, false, true).split("\n");
      const at = lines.indexOf(CHECK_LINE);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(lines.findIndex((l) => l.includes('-chdir="$dir" init')));
    }
    expect(checkScript("tofu", ["a"])).toBe(checkScript("tofu", ["a"], undefined, false, false, false, false));
    expect(checkScript("tofu", ["a"])).not.toContain("check-sources");
    const withKey = await init(write(tmp(), { "terragucci.yml": "forge: github\nbinary: tofu\nsources:\n  modules: ['./**']\n", "envs/a/main.tf": PLAIN_ROOT }), { dryRun: true });
    expect(withKey.files[0]!.content).toContain('terragucci check-sources "$dir"');
    const without = await init(write(tmp(), { "terragucci.yml": "forge: github\nbinary: tofu\n", "envs/a/main.tf": PLAIN_ROOT }), { dryRun: true });
    expect(without.files[0]!.content).not.toContain("check-sources");
  });

  it("refuses a root outside the list at base before its init, and prints nothing with no key", async () => {
    const { repo, baseSha } = branched(
      { "terragucci.yml": "sources:\n  modules: ['./**']\n", "app/main.tf": PLAIN_ROOT },
      { "terragucci.yml": `sources:\n  modules: ['./**', '${OTHER_HOST}/**']\n`, "app/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git?ref=v1"\n}\n` },
    );
    const cwd = process.cwd();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(repo);
      expect(await main(["check-sources", "app", "--base", baseSha])).toBe(1);
      expect(await main(["check-sources"])).toBe(USAGE);
    } finally {
      process.chdir(cwd);
    }
    const logged = out.mock.calls.flat().join("\n");
    expect(logged).toContain(`refused: app: module.bad (app/mod.tf) uses module source ${OTHER_HOST}/bad.git?ref=v1, which no entry of sources.modules matches (sources.modules: ./**)`);
    expect(logged).toContain("FAILED app: refused by sources, so it was not initialised");
    expect(readFileSync(join(repo, "terragucci-check", "report.md"), "utf-8")).toContain("refused: `app`: module.bad");

    const plain = branched({ "terragucci.yml": "gate: never\n", "app/main.tf": PLAIN_ROOT }, { "app/mod.tf": `module "bad" {\n  source = "${OTHER_HOST}/bad.git"\n}\n` });
    out.mockClear();
    try {
      process.chdir(plain.repo);
      expect(await main(["check-sources", "app", "--base", plain.baseSha])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(out).not.toHaveBeenCalled();
    expect(existsSync(join(plain.repo, "terragucci-check"))).toBe(false);
  });

  it("names a passing root nowhere, and a refused one in the log and the report", () => {
    expect(checkSourcesResult("a", [])).toEqual({ ok: true, log: [], report: [] });
    const r = checkSourcesResult("a", ["refused: a: module.x (a/main.tf) uses module source y"]);
    expect(r.ok).toBe(false);
    expect(r.report).toContain("- refused: `a`: module.x (a/main.tf) uses module source y");
  });
});
