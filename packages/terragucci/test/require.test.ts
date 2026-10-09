import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig } from "../src/config";
import { checkRoot, checkUnitPins } from "../src/check";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { publish } from "../src/publish";
import { checkedSources, checkRootPins, governingModules, normalizeSource, pinChecker, splitGitSource } from "../src/publish/require";
import { runStage } from "../src/report/stage";
import { git, tmp, write } from "./helpers";
import { fakeRegistry } from "./registry";
import { keyPair, testSigner, type Pair } from "./signer";

const parser = async () => (await import("@cdktn/hcl2json")) as never;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

const CONFIG = "roots: [\"envs/*\"]\nmodules:\n  path: modules/*\n  publish: git-tags\n  attest: true\n  require: attested\n";
const settings = { publish: "git-tags", attest: true, require: "attested" as const };

/** A repo that publishes modules/service 0.1.0 attested, to a file:// origin, and a root that pins it. */
async function published(pair: Pair) {
  const repo = tmp("terragucci-require-");
  const origin = tmp("terragucci-require-origin-");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const url = `file://${origin}`;
  write(repo, { "modules/service/main.tf": 'resource "terraform_data" "s" {}\n', "cosign.pub": pair.pem, "terragucci.yml": CONFIG, "envs/dev/main.tf": "# no module yet\n" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", url);
  commit(repo, "feat: service");
  git(repo, "push", "-q", "origin", "main");
  await publish(repo, { modules: { publish: "git-tags", attest: true } }, { signer: testSigner(pair.privateKey), parser: await parser() });
  const pin = (version: string, root = "envs/dev") =>
    write(repo, { [`${root}/main.tf`]: `module "service" {\n  source = "git::${url}.git//modules/service?ref=modules/service/v${version}"\n}\n` });
  return { repo, origin, url, pin };
}

/** Push a tag for modules/service by hand, on a commit that changes the module. */
function handTag(repo: string, version: string, force = false): void {
  write(repo, { "modules/service/out.tf": `output "v" { value = "${version}" }\n` });
  commit(repo, `fix: ${version} by hand`);
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", ...(force ? ["-f"] : []), "-a", `modules/service/v${version}`, "-m", "by hand");
  git(repo, "push", "-q", ...(force ? ["-f"] : []), "origin", `refs/tags/modules/service/v${version}`);
}

async function check(repo: string, root = "envs/dev") {
  const sources = checkedSources(repo, await governingModules(repo, settings, undefined));
  return checkRootPins(repo, root, sources, await parser());
}

describe("modules.require config", () => {
  const problems = (modules: unknown): string => {
    try {
      validateConfig({ modules }, "t");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  it("checks this repo's attested releases, or the trusted sources it lists", () => {
    expect(problems(settings)).toBe("");
    expect(problems({ require: "attested", trusted: [{ source: "oci://registry.example.com/acme/modules", key: "keys/acme.pub", ledger: "https://git.example.com/acme/modules.git" }] })).toBe("");
    expect(problems({ require: "attested" })).toContain("set config.modules.attest or config.modules.trusted");
    expect(problems({ require: "signed", attest: true, publish: "git-tags" })).toContain("the one setting is attested");
    expect(problems({ trusted: [{ source: "registry.example.com/acme", key: "k.pub", ledger: "acme/modules" }] })).toMatch(/source must be an oci:\/\/ prefix or a git URL[\s\S]*ledger must be the URL/);
    expect(problems({ trusted: [{ source: "oci://r/a", key: "k.pub", ledger: "https://g/a.git", extra: 1 }] })).toContain("trusted[0].extra is not a setting");
  });
});

describe("source matching", () => {
  it("compares git URLs and oci prefixes without credentials, git::, .git or case of the host", () => {
    expect(normalizeSource("git::https://bot:secret@Git.Example.com/acme/infra.git")).toBe("https://git.example.com/acme/infra");
    expect(normalizeSource("oci://Registry.example.com/acme/modules/")).toBe("oci://registry.example.com/acme/modules");
    expect(splitGitSource("git::https://git.example.com/acme/infra.git//modules/net?ref=modules/net/v1.0.0")).toEqual({ url: "https://git.example.com/acme/infra.git", subdir: "modules/net" });
    expect(splitGitSource("./modules/net")).toBeUndefined();
  });
});

describe("checkRootPins", () => {
  const pair = keyPair();

  it("passes a root that pins an attested release, and leaves other sources alone", async () => {
    const { repo, pin } = await published(pair);
    pin("0.1.0");
    write(repo, { "envs/dev/other.tf": 'module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.1.0"\n}\n\nmodule "local" {\n  source = "../../modules/service"\n}\n' });
    const r = await check(repo);
    expect(r.refused).toEqual([]);
    expect(r.verified).toEqual([expect.stringMatching(/^module\.service .*\/\/modules\/service modules\/service\/v0\.1\.0$/)]);
  });

  it("refuses a version the ledger has no record of, naming the call, the module, the version and why", async () => {
    const { repo, pin } = await published(pair);
    handTag(repo, "0.1.1");
    pin("0.1.1");
    const r = await check(repo);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]).toMatchObject({ call: "module.service", file: "envs/dev/main.tf", version: "modules/service/v0.1.1" });
    expect(r.refused[0].why).toMatch(/is not in the release ledger .* none has these bytes/);
  });

  it("refuses a release whose tag was moved to other content", async () => {
    const { repo, pin } = await published(pair);
    handTag(repo, "0.1.0", true);
    pin("0.1.0");
    expect((await check(repo)).refused[0].why).toMatch(/is not in the release ledger/);
  });

  it("refuses a pin that names no release, and a tag that does not exist", async () => {
    const { repo, url } = await published(pair);
    write(repo, { "envs/dev/main.tf": `module "a" {\n  source = "git::${url}//modules/service"\n}\n\nmodule "b" {\n  source = "git::${url}//modules/service?ref=modules/service/v9.0.0"\n}\n` });
    const r = await check(repo);
    expect(r.refused.map((x) => [x.call, x.version])).toEqual([["module.a", "no version"], ["module.b", "modules/service/v9.0.0"]]);
    expect(r.refused[0].why).toContain("pins no release");
    expect(r.refused[1].why).toContain("is not a tag of");
  });

  it("refuses everything when the key does not match the publisher's", async () => {
    const { repo, pin } = await published(pair);
    pin("0.1.0");
    write(repo, { "cosign.pub": keyPair().pem });
    expect((await check(repo)).refused[0].why).toMatch(/signature does not verify against the trusted key/);
  });
});

describe("an OCI source", () => {
  it("passes a tag the ledger records, and refuses one pushed past the publish job", async () => {
    const pair = keyPair();
    const repo = tmp("terragucci-require-oci-");
    const origin = tmp("terragucci-require-oci-origin-");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const oci = { publish: "oci://registry.test/acme/modules", attest: true, require: "attested" as const };
    write(repo, { "modules/service/main.tf": 'resource "terraform_data" "s" {}\n', "cosign.pub": pair.pem });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", `file://${origin}`);
    commit(repo, "feat: service");
    const reg = fakeRegistry();
    await publish(repo, { modules: oci }, { signer: testSigner(pair.privateKey), parser: await parser(), fetch: reg.fetch });
    // A manifest pushed under 0.2.0 by hand: the ledger has no record of it.
    const held = reg.manifests.get("acme/modules/service:0.1.0")!;
    reg.manifests.set("acme/modules/service:0.2.0", { ...held, body: Buffer.from(held.body.toString().replace("0.1.0", "0.2.0")) });
    write(repo, { "envs/dev/main.tf": 'module "a" {\n  source = "oci://registry.test/acme/modules/service?tag=0.1.0"\n}\n\nmodule "b" {\n  source = "oci://registry.test/acme/modules/service?tag=0.2.0"\n}\n' });
    const pins = await pinChecker(repo, oci, undefined, {}, { parser: await parser(), fetch: reg.fetch, env: {} });
    const r = await pins!("envs/dev");
    expect(r.verified).toEqual(["module.a oci://registry.test/acme/modules/service 0.1.0"]);
    expect(r.refused).toEqual([expect.stringMatching(/^refused: envs\/dev: module.b .* at 0.2.0, which modules.require: attested refuses: sha256:[0-9a-f]+ is not in the release ledger/)]);
  });
});

describe("the base decides", () => {
  it("keeps the check on when a pull request drops it, and reads the key at the base", async () => {
    const pair = keyPair();
    const { repo, pin } = await published(pair);
    git(repo, "branch", "base");
    handTag(repo, "0.1.1");
    pin("0.1.1");
    // The pull request drops require and swaps the key for one of its own.
    write(repo, { "terragucci.yml": "roots: [\"envs/*\"]\nmodules:\n  path: modules/*\n  publish: git-tags\n", "cosign.pub": keyPair().pem });
    const governing = await governingModules(repo, { publish: "git-tags" }, "base");
    expect(governing.from).toBe("base");
    const sources = checkedSources(repo, governing);
    expect((await checkRootPins(repo, "envs/dev", sources, await parser())).refused).toHaveLength(1);
    // With no base, the checkout's settings govern, and they check nothing.
    expect(await pinChecker(repo, { publish: "git-tags" }, undefined)).toBeUndefined();
  });

  it("stops every root when the governing key is missing", async () => {
    const pair = keyPair();
    const { repo } = await published(pair);
    await expect(pinChecker(repo, { ...settings, attest: { key: "none.pub" } }, undefined)).rejects.toThrow(ConfigError);
  });
});

function fakeTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) exit 0 ;;
  validate) echo '{"valid":true,"diagnostics":[]}' ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; echo "No changes."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then echo '{"format_version":"1.2","resource_changes":[]}'; else echo "plan text"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-check and tf-plan", () => {
  const pair = keyPair();

  it("tf-plan refuses the root before it runs init, and plans one that pins an attested release", { timeout: 60_000 }, async () => {
    const { repo, pin } = await published(pair);
    handTag(repo, "0.1.1");
    pin("0.1.0", "envs/dev");
    pin("0.1.1", "envs/prod");
    commit(repo, "pins");
    const bin = tmp();
    const lines: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: fakeTofu(bin), env: { PATH: process.env.PATH }, noCost: true, out: join(bin, "out") }, (l) => lines.push(l));
    expect(result.failed).toBe(true);
    const byPath = Object.fromEntries(result.report.roots.map((r) => [r.path, r]));
    expect(byPath["envs/dev"].status).not.toBe("failed");
    expect(byPath["envs/prod"].status).toBe("failed");
    expect(JSON.stringify(byPath["envs/prod"])).toMatch(/refused: envs\/prod: module.service \(envs\/prod\/main.tf\) pins .* at modules\/service\/v0.1.1, which modules.require: attested refuses: .*not in the release ledger/);
    expect(lines.join("\n")).toContain("envs/prod: refused by modules.require: attested");
    const calls = readFileSync(join(bin, "calls.log"), "utf-8");
    expect(calls).toContain("envs/dev init");
    expect(calls).not.toContain("envs/prod init");
    expect(readFileSync(join(result.dir, "note.md"), "utf-8")).toContain("modules.require: attested refuses");
  });

  it("tf-check names the refused pin in the check report", async () => {
    const { repo, pin } = await published(pair);
    handTag(repo, "0.1.1");
    pin("0.1.1");
    const pins = await pinChecker(repo, settings, undefined, {}, { parser: await parser() });
    const r = await checkRoot(fakeTofu(tmp()), "envs/dev", repo, { pins });
    expect(r.ok).toBe(false);
    expect(r.log.join("\n")).toContain("FAILED envs/dev: modules.require: attested refused 1 module pin");
    expect(r.report.join("\n")).toMatch(/- refused: `envs\/dev`: module.service .* at modules\/service\/v0.1.1/);
  });
});

/** Terragrunt with no dependencies: `render` finds none, and `run --all` gives each unit it is filtered to a plan and a succeeded row. */
function fakeRunAll(calls: string[][]): TerragruntExec {
  return async (_file, args) => {
    calls.push([...args]);
    if (args[0] === "render") return { code: 0, stdout: JSON.stringify({ dependency: {} }), stderr: "" };
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    const units = args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith("{./") ? [a.slice(3, -1)] : []));
    for (const u of units) {
      for (const [dir, f, body] of [[at("--out-dir"), "tfplan.tfplan", "binary"], [at("--json-out-dir"), "tfplan.json", JSON.stringify({ format_version: "1.2", resource_changes: [] })]] as const) {
        mkdirSync(join(dir, u), { recursive: true });
        writeFileSync(join(dir, u, f), body);
      }
    }
    mkdirSync(dirname(at("--report-file")), { recursive: true });
    writeFileSync(at("--report-file"), JSON.stringify(units.map((u) => ({ Name: u, Result: "succeeded" }))));
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("Terragrunt units", () => {
  const pair = keyPair();

  /** live/dev pins the attested 0.1.0 in its terraform source, live/prod a 0.1.1 tagged by hand. */
  async function units() {
    const { repo, url } = await published(pair);
    handTag(repo, "0.1.1");
    const unit = (version: string) => `terraform {\n  source = "git::${url}.git//modules/service?ref=modules/service/v${version}"\n}\n`;
    write(repo, { "root.hcl": "", "live/dev/terragrunt.hcl": unit("0.1.0"), "live/prod/terragrunt.hcl": unit("0.1.1") });
    commit(repo, "units");
    return repo;
  }

  it("tf-plan refuses a unit whose source pins an unattested release before its wave runs, and plans the attested one", { timeout: 60_000 }, async () => {
    const repo = await units();
    const calls: string[][] = [];
    const lines: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: "tofu", terragrunt: true, layers: [["live/dev", "live/prod"]], terragruntExec: fakeRunAll(calls), env: { PATH: process.env.PATH }, noCost: true, out: join(tmp(), "out") }, (l) => lines.push(l));
    expect(result.failed).toBe(true);
    const byPath = Object.fromEntries(result.report.roots.map((r) => [r.path, r]));
    expect(byPath["live/dev"].error).toBeUndefined();
    expect(byPath["live/dev"].status).toBe("planned");
    expect(byPath["live/prod"]).toMatchObject({ status: "failed", terragrunt: { run_result: "not run" } });
    expect(byPath["live/prod"].error).toMatch(/refused: live\/prod: terraform \(live\/prod\/terragrunt.hcl\) pins .* at modules\/service\/v0.1.1, which modules.require: attested refuses: .*not in the release ledger/);
    expect(lines.join("\n")).toContain("live/prod: refused by modules.require: attested");
    expect(lines.join("\n")).toMatch(/live\/dev: attested terraform .*modules\/service\/v0.1.0/);
    const runs = calls.filter((c) => c[0] === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("{./live/dev}");
    expect(runs[0]).not.toContain("{./live/prod}");
  });

  it("tf-check's pin step names the refused unit and passes the attested one", async () => {
    const repo = await units();
    const pins = (await pinChecker(repo, settings, undefined, {}, { parser: await parser() }))!;
    const r = await checkUnitPins(["live/dev", "live/prod"], pins);
    expect(r.ok).toBe(false);
    const log = r.log.join("\n");
    expect(log).toContain("FAILED live/prod: modules.require: attested refused 1 module pin");
    expect(log).toMatch(/attested live\/dev: terraform .*modules\/service\/v0.1.0/);
    expect(r.report.join("\n")).toMatch(/### live\/prod\n\n- refused: `live\/prod`: terraform .* at modules\/service\/v0.1.1/);
    expect((await checkUnitPins(["live/dev"], pins)).ok).toBe(true);
  });
});
