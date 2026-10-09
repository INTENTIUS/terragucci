import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validateConfig, type RegistrySettings } from "../src/config";
import { describePublish, publish, sourceUrl } from "../src/publish";
import { moduleTar } from "../src/publish/archive";
import type { Fetch } from "../src/publish/oci";
import {
  dirStore,
  namespaceFor,
  parseRegistrySource,
  registryAddress,
  registryLocation,
  registryVersions,
  type RegistryStore,
} from "../src/publish/registry";
import { checkedSources, checkRootPins, governingModules } from "../src/publish/require";
import { testFiles, testModule, type TestRunner } from "../src/publish/test";
import { newestPublished, registryAliases } from "../src/rollout/discover";
import { moduleCalls, movePins } from "../src/rollout/pins";
import { StoreConflict } from "../src/report/object-store";
import { init } from "../src/init";
import { git, tmp, write } from "./helpers";
import { keyPair, testSigner } from "./signer";

const parser = async () => (await import("@cdktn/hcl2json")) as never;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** A bucket in memory, with ETags and conditional writes, served over https at `url` by `fetch`. */
function memoryStore(url = "https://modules.test") {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  let n = 0;
  const store: RegistryStore = {
    location: "mem://registry",
    async put(key, body, _type, when) {
      const held = objects.get(key);
      if (when && "ifNoneMatch" in when && held) throw new StoreConflict(`${key} exists`);
      if (when && "ifMatch" in when && held?.etag !== when.ifMatch) throw new StoreConflict(`${key} changed`);
      const etag = `"${++n}"`;
      objects.set(key, { body: Buffer.from(body), etag });
      return { etag };
    },
    async read(key) {
      const o = objects.get(key);
      return o ? { body: o.body.toString("utf-8"), etag: o.etag } : {};
    },
  };
  const fetch: Fetch = async (u) => {
    const key = String(u).startsWith(`${url}/`) ? String(u).slice(url.length + 1) : "";
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o.body), { status: 200 }) : new Response("not found", { status: 404 });
  };
  const json = (key: string) => JSON.parse(objects.get(key)!.body.toString("utf-8"));
  return { store, fetch, objects, json };
}

const REG: RegistrySettings = { bucket: "s3://modules", url: "https://modules.test", namespace: "acme" };

function repoWithModules(files: Record<string, string> = {}): string {
  const dir = tmp("terragucci-registry-");
  write(dir, {
    "modules/net/main.tf": 'resource "terraform_data" "a" {}\n',
    "modules/net/tests/main.tftest.hcl": 'run "plan" {\n  command = plan\n}\n',
    "modules/db/main.tf": 'resource "terraform_data" "b" {}\n',
    "modules/db/tests/main.tftest.hcl": 'run "plan" {\n  command = plan\n}\n',
    ...files,
  });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: modules");
  return dir;
}

const passing: TestRunner & { calls: string[] } = Object.assign(((binary, args, dir) => {
  passing.calls.push(`${binary} ${args[0]} ${dir.split("/").pop()}`);
  return { status: 0, output: "Success! 1 passed, 0 failed." };
}) as TestRunner, { calls: [] as string[] });

describe("modules.registry config", () => {
  const problems = (modules: unknown, extra: Record<string, unknown> = {}): string => {
    try {
      validateConfig({ modules, ...extra }, "t");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  it("takes a bucket or a dir, an https url with no path, and a namespace", () => {
    expect(problems({ registry: REG })).toBe("");
    expect(problems({ registry: { dir: "public", url: "https://acme.github.io", namespace: "acme", namespaces: { "platform/": "platform" }, system: "aws" }, test: true })).toBe("");
    expect(problems({ registry: { url: "https://m.test", namespace: "acme" } })).toContain("set one of them");
    expect(problems({ registry: { ...REG, dir: "public" } })).toContain("set one of them");
    expect(problems({ registry: { ...REG, url: "https://m.test/modules" } })).toContain("with no path");
    expect(problems({ registry: { ...REG, url: "http://m.test" } })).toContain("over https");
    expect(problems({ registry: { ...REG, url: "https://localhost:8443" } })).toContain("only when it has a dot");
    expect(problems({ registry: { ...REG, namespace: "a b" } })).toContain("namespace must be a registry namespace");
    expect(problems({ registry: { ...REG, system: "AWS" } })).toContain("system must be lower-case");
    expect(problems({ registry: { ...REG, bucket: "ftp://x" } })).toContain("bucket must be");
    expect(problems({ registry: { ...REG, extra: 1 } })).toContain("registry.extra is not a setting");
  });
  it("points a download at a git tag or an OCI artifact only when publish writes one", () => {
    expect(problems({ publish: "git-tags", registry: { ...REG, download: "git-tags" } })).toBe("");
    expect(problems({ registry: { ...REG, download: "git-tags" } })).toContain("publish needs git-tags too");
    expect(problems({ publish: "git-tags", registry: { ...REG, download: "oci" } })).toContain("an oci:// target too");
    expect(problems({ registry: { ...REG, download: "zip" } })).toContain("use tarball, git-tags or oci");
  });
  it("lets attest sign what the registry writes, and test is a boolean the binary must support", () => {
    expect(problems({ registry: REG, attest: true })).toBe("");
    expect(problems({ attest: true })).toContain("set config.modules.publish or config.modules.registry too");
    expect(problems({ registry: REG, test: "yes" })).toContain("test must be true or false");
    expect(problems({ registry: REG, test: true }, { binary: "choudoufu" })).toContain("choudoufu has none");
  });
});

describe("the publish job for a registry", () => {
  it("init writes the publish job for modules.registry alone, with the bucket's key secrets", async () => {
    const dir = write(tmp(), {
      "envs/dev/main.tf": "# root\n",
      "terragucci.yml": "binary: tofu\nforge: github\nroots: [\"envs/*\"]\nmodules:\n  test: true\n  registry:\n    bucket: s3://acme-modules\n    url: https://modules.example.com\n    namespace: acme\n",
    });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.files[0].content).toContain("terragucci publish");
    expect(r.files[0].content).toMatch(/AWS_SECRET_ACCESS_KEY: ['"]?\$\{\{ secrets\.AWS_SECRET_ACCESS_KEY \}\}/);
  });
});

describe("registry addresses", () => {
  it("maps a monorepo's tag prefixes to namespaces, the longest prefix winning", () => {
    const reg = { ...REG, namespaces: { "platform/": "platform", "platform/data/": "data" } };
    expect(namespaceFor(reg, "modules/net")).toBe("acme");
    expect(namespaceFor(reg, "platform/modules/net")).toBe("platform");
    expect(namespaceFor(reg, "platform/data/modules/warehouse")).toBe("data");
    expect(namespaceFor(reg, "platformer/modules/x")).toBe("acme");
    expect(registryAddress(reg, "platform/modules/net")).toEqual({
      namespace: "platform",
      name: "net",
      system: "generic",
      source: "modules.test/platform/net/generic",
      path: "v1/modules/platform/net/generic",
    });
  });
  it("reads a registry source, with a host that has a dot or a port", () => {
    expect(parseRegistrySource("modules.test/acme/net/generic")).toEqual({ host: "modules.test", namespace: "acme", name: "net", system: "generic" });
    expect(parseRegistrySource("localhost:8443/acme/net/generic//sub")).toMatchObject({ host: "localhost:8443", name: "net" });
    expect(parseRegistrySource("hashicorp/consul/aws")).toBeUndefined();
    expect(parseRegistrySource("platform/modules/net/x")).toBeUndefined();
    expect(parseRegistrySource("git::https://h.test/a/b.git")).toBeUndefined();
  });
  it("writes an origin as a module source names it", () => {
    expect(sourceUrl("https://bot:tok@git.test/acme/infra.git")).toBe("https://git.test/acme/infra.git");
    expect(sourceUrl("git@github.com:acme/infra.git")).toBe("ssh://git@github.com/acme/infra.git");
  });
});

describe("publish to a module registry", () => {
  it("writes discovery, versions, download and a tarball, then a second version beside the first", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    const settings = { modules: { registry: REG } };
    const first = await publish(repo, settings, { registryStore: mem.store });
    expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.0:published", "net@0.1.0:published"]);
    expect(describePublish(first)).toContain("net 0.1.0: published to registry https://modules.test");
    expect(mem.json(".well-known/terraform.json")).toEqual({ "modules.v1": "/v1/modules/" });
    expect(mem.json("v1/modules/acme/net/generic/versions")).toEqual({ modules: [{ versions: [{ version: "0.1.0" }] }] });
    const location = mem.json("v1/modules/acme/net/generic/0.1.0/download").location;
    expect(location).toBe("https://modules.test/v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz");
    const tarball = mem.objects.get("v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz")!.body;
    expect(gunzipSync(tarball).equals(moduleTar(join(repo, "modules/net")))).toBe(true);
    expect(mem.json("v1/modules/acme/net/generic/0.1.0/release.json")).toMatchObject({ module: "modules/net", version: "0.1.0", revision: git(repo, "rev-parse", "HEAD").trim() });

    expect((await publish(repo, settings, { registryStore: mem.store })).every((r) => r.status === "unchanged")).toBe(true);

    write(repo, { "modules/net/outputs.tf": 'output "id" { value = terraform_data.a.id }\n' });
    commit(repo, "feat(net): an id output");
    const second = await publish(repo, settings, { registryStore: mem.store });
    expect(second.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.0:unchanged", "net@0.2.0:published"]);
    expect(mem.json("v1/modules/acme/net/generic/versions")).toEqual({ modules: [{ versions: [{ version: "0.1.0" }, { version: "0.2.0" }] }] });
  });

  it("is read back as Terraform reads it: discovery, versions, then the download's location", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    await publish(repo, { modules: { registry: REG } }, { registryStore: mem.store });
    expect(await registryVersions("modules.test/acme/net/generic", mem.fetch)).toEqual(["0.1.0"]);
    expect(await registryLocation("modules.test/acme/net/generic", "0.1.0", mem.fetch)).toBe("https://modules.test/v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz");
    await expect(registryLocation("modules.test/acme/net/generic", "9.0.0", mem.fetch)).rejects.toThrow("has no version 9.0.0");
  });

  it("writes the files under a prefix, and into a dir for a Pages site", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    await publish(repo, { modules: { registry: { ...REG, prefix: "registry/" } } }, { registryStore: mem.store });
    expect(mem.objects.has("registry/.well-known/terraform.json")).toBe(true);
    expect(mem.objects.has("registry/v1/modules/acme/db/generic/versions")).toBe(true);
    const site = tmp("terragucci-pages-");
    await publish(repo, { modules: { registry: { dir: "public", url: "https://acme.test", namespace: "acme" } } }, { registryStore: dirStore(site) });
    expect(JSON.parse(readFileSync(join(site, "v1/modules/acme/net/generic/versions"), "utf-8")).modules[0].versions).toEqual([{ version: "0.1.0" }]);
  });

  it("puts a monorepo's modules under the namespaces their paths map to, and refuses two at one address", async () => {
    const repo = repoWithModules({ "platform/modules/net/main.tf": "# platform net\n" });
    const mem = memoryStore();
    const reg = { ...REG, namespaces: { "platform/": "platform" } };
    await publish(repo, { modules: { path: "**/modules/*", registry: reg } }, { registryStore: mem.store });
    expect(mem.objects.has("v1/modules/platform/net/generic/versions")).toBe(true);
    expect(mem.objects.has("v1/modules/acme/net/generic/versions")).toBe(true);
    await expect(publish(repo, { modules: { path: "**/modules/*", registry: REG } }, { registryStore: mem.store })).rejects.toThrow(
      "modules/net and platform/modules/net are both modules.test/acme/net/generic",
    );
  });

  it("points a download at the git tag publish just pushed", async () => {
    const repo = repoWithModules();
    const origin = tmp("terragucci-registry-origin-");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(repo, "remote", "add", "origin", origin);
    const mem = memoryStore();
    const r = await publish(repo, { modules: { publish: "git-tags", registry: { ...REG, download: "git-tags" } } }, { registryStore: mem.store });
    expect(r.filter((x) => x.status === "published")).toHaveLength(4);
    expect(mem.json("v1/modules/acme/net/generic/0.1.0/download").location).toBe(`git::${origin}//modules/net?ref=modules/net/v0.1.0`);
    expect(mem.objects.has("v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz")).toBe(false);
  });

  it("refuses to point a download at a git tag that is not published", async () => {
    const repo = repoWithModules();
    git(repo, "remote", "add", "origin", tmp("terragucci-none-"));
    const mem = memoryStore();
    await expect(publish(repo, { modules: { registry: { ...REG, download: "git-tags" } } }, { registryStore: mem.store })).rejects.toThrow("at the git tag modules/db/v0.1.0, which is not published");
    expect(mem.objects.has("v1/modules/acme/db/generic/versions")).toBe(false);
  });

  it("writes nothing on a dry run", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    const r = await publish(repo, { modules: { registry: REG, test: true } }, { registryStore: mem.store, dryRun: true, testRunner: passing });
    expect(r.every((x) => x.detail === "dry run: would test, publish")).toBe(true);
    expect(mem.objects.size).toBe(0);
  });
});

describe("modules.test", () => {
  it("finds the binary's test files in the module and its tests directory", () => {
    const dir = write(tmp(), { "a.tftest.hcl": "", "tests/b.tftest.json": "", "tests/c.tofutest.hcl": "", "main.tf": "" });
    expect(testFiles(dir, "tofu")).toEqual(["a.tftest.hcl", "tests/b.tftest.json", "tests/c.tofutest.hcl"]);
    expect(testFiles(dir, "terraform")).toEqual(["a.tftest.hcl", "tests/b.tftest.json"]);
  });

  it("initialises and tests each module once before it publishes", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    passing.calls.length = 0;
    const r = await publish(repo, { binary: "terraform", modules: { registry: REG, test: true } }, { registryStore: mem.store, testRunner: passing });
    expect(r.map((x) => x.status)).toEqual(["published", "published"]);
    expect(passing.calls).toEqual(["terraform init db", "terraform test db", "terraform init net", "terraform test net"]);
    passing.calls.length = 0;
    await publish(repo, { modules: { registry: REG, test: true } }, { registryStore: mem.store, testRunner: passing });
    expect(passing.calls).toEqual([]);
  });

  it("refuses an untested release, and one whose tests fail, while the rest publish", async () => {
    const repo = repoWithModules({ "modules/queue/main.tf": "# no tests\n" });
    const mem = memoryStore();
    const runner: TestRunner = (_b, args, dir) => (args[0] === "test" && dir.endsWith("/db") ? { status: 1, output: "run \"plan\"... fail\nError: Test assertion failed" } : { status: 0, output: "" });
    const r = await publish(repo, { modules: { registry: REG, publish: "git-tags", test: true } }, { registryStore: mem.store, testRunner: runner, push: false });
    expect(r.map((x) => `${x.module}:${x.status}`)).toEqual(["db:refused", "db:refused", "net:published", "net:published", "queue:refused", "queue:refused"]);
    expect(r[0].detail).toMatch(/^tofu test failed in modules\/db:\n[\s\S]*Test assertion failed/);
    expect(r[4].detail).toContain("modules/queue has no tests");
    expect(git(repo, "tag", "--list").trim()).toBe("modules/net/v0.1.0");
    expect(mem.objects.has("v1/modules/acme/queue/generic/versions")).toBe(false);
    expect(describePublish(r)).toContain("queue 0.1.0: refused, not published to git-tags (modules/queue has no tests");
  });

  it("refuses a module whose init fails", () => {
    const dir = write(tmp(), { "main.tf": "", "x.tftest.hcl": "" });
    expect(testModule(dir, "modules/x", "tofu", () => ({ status: 1, output: "Error: no provider" }))).toMatch(/^tofu init failed in modules\/x, so its tests could not run:\nError: no provider/);
  });
});

describe("rollouts of a registry module", () => {
  it("names a module by its path or its registry address, and moves its version", async () => {
    const repo = write(tmp(), {
      "envs/dev/main.tf": 'module "net" {\n  source  = "modules.test/acme/net/generic"\n  version = "0.1.0"\n}\n\nmodule "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.1.0"\n}\n',
    });
    const aliases = registryAliases("modules/net", [{ modules: { registry: REG } }, {}]);
    expect(aliases).toEqual(["modules.test/acme/net/generic"]);
    expect(registryAliases("modules.test/acme/net/generic", [])).toEqual(["modules.test/acme/net/generic"]);
    const p = await parser();
    expect(await moduleCalls(repo, "envs/dev", "modules/net", p)).toEqual([]);
    const calls = await moduleCalls(repo, "envs/dev", "modules/net", p, aliases);
    expect(calls.map((c) => [c.call, c.version])).toEqual([["module.net", "0.1.0"]]);
    const moved = await movePins(repo, calls, "0.1.0", "0.2.0", p);
    expect("edits" in moved && moved.edits.get("envs/dev/main.tf")).toContain('version = "0.2.0"');
  });

  it("finds the newest version a registry lists", async () => {
    const repo = repoWithModules();
    const mem = memoryStore();
    const settings = { modules: { registry: REG } };
    await publish(repo, settings, { registryStore: mem.store });
    write(repo, { "modules/net/x.tf": "# x\n" });
    commit(repo, "feat: x");
    await publish(repo, settings, { registryStore: mem.store });
    const found = await newestPublished({ module: "modules/net", repos: [], oci: [], registries: ["modules.test/acme/net/generic"], fetch: mem.fetch });
    expect(found).toEqual({ version: "0.2.0", from: "modules.test/acme/net/generic 0.2.0" });
  });
});

describe("modules.require: attested for registry sources", () => {
  const pair = keyPair();

  async function attested(download: RegistrySettings["download"] = "tarball") {
    const repo = repoWithModules({ "cosign.pub": pair.pem, "envs/dev/main.tf": "# none\n" });
    const origin = tmp("terragucci-registry-origin-");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(repo, "remote", "add", "origin", `file://${origin}`);
    git(repo, "push", "-q", "origin", "main");
    const mem = memoryStore();
    const modules = { ...(download === "git-tags" ? { publish: "git-tags" } : {}), registry: { ...REG, download }, attest: true, require: "attested" as const };
    const r = await publish(repo, { modules }, { registryStore: mem.store, signer: testSigner(pair.privateKey), parser: await parser() });
    const pin = (version: string) => write(repo, { "envs/dev/main.tf": `module "net" {\n  source  = "modules.test/acme/net/generic"\n  version = "${version}"\n}\n` });
    const check = async () => checkRootPins(repo, "envs/dev", checkedSources(repo, await governingModules(repo, modules, undefined)), await parser(), { fetch: mem.fetch });
    return { repo, mem, pin, check, r };
  }

  it("records the tarball's release in the ledger, and passes a root that pins it", async () => {
    const { pin, check, r } = await attested();
    expect(r.find((x) => x.module === "net")?.detail).toMatch(/signed and recorded in the release ledger as sha256:/);
    pin("0.1.0");
    expect(await check()).toEqual({ refused: [], verified: ["module.net modules.test/acme/net/generic 0.1.0"] });
  });

  it("refuses a tarball changed in the bucket, a version the registry lacks, and a constraint", async () => {
    const { mem, pin, check } = await attested();
    const key = "v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz";
    const swapped = gunzipSync(mem.objects.get(key)!.body);
    swapped.write("x", 600);
    await mem.store.put(key, (await import("node:zlib")).gzipSync(swapped), "application/gzip");
    pin("0.1.0");
    const tampered = await check();
    expect(tampered.refused[0]).toMatchObject({ call: "module.net", version: "0.1.0" });
    expect(tampered.refused[0].why).toMatch(/is not in the release ledger/);
    pin("0.9.0");
    expect((await check()).refused[0].why).toContain("has no version 0.9.0");
    pin("~> 0.1");
    expect((await check()).refused[0].why).toContain("is a constraint, not a pin");
  });

  it("follows a download that points at a git tag, and checks the tag's release", async () => {
    const { pin, check } = await attested("git-tags");
    pin("0.1.0");
    expect((await check()).verified).toEqual(["module.net modules.test/acme/net/generic 0.1.0"]);
  });

  it("checks only the registry host this repo publishes to", async () => {
    const { repo, check } = await attested();
    write(repo, { "envs/dev/main.tf": 'module "net" {\n  source  = "other.test/acme/net/generic"\n  version = "0.1.0"\n}\n' });
    expect(await check()).toEqual({ refused: [], verified: [] });
  });
});
