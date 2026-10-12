import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { ConfigError, validateConfig } from "../src/config";
import { runStage } from "../src/report/stage";
import { loadHclParser } from "../src/rollout/parser";
import { checkRootSources, governingSources, moduleForms, providerForms, rootSources, sourceAllowed, sourceChecker, sourceGlob, sourceRefusalLines } from "../src/sources";
import { git, tmp, write } from "./helpers";

const parser = await loadHclParser();

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

  it("names a local module outside the repo as unread, since what it uses cannot be checked", async () => {
    const repo = write(tmp("tg-sources-out-"), { "app/main.tf": 'module "x" {\n  source = "../../elsewhere"\n}\n' });
    const refused = await checkRootSources(repo, "app", { modules: ["./**", "../**"] }, parser);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.why).toContain("outside the repo");
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
