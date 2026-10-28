import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { RegistrySettings } from "../src/config";
import { chantNextParts, chantReleaseCatalog, type ChantReleaseCatalogDoc } from "../src/chant-next";
import { publish } from "../src/publish";
import { parseLedger, type Ledger } from "../src/publish/ledger";
import type { RegistryStore } from "../src/publish/registry";
import { yankedPin } from "../src/publish/require";
import { describeStatus, setReleaseStatus } from "../src/publish/status";
import { DEPRECATED_VERSION_TIP, catalogHosts, repoTips } from "../src/tips";
import { git, tmp, write } from "./helpers";

const parts = await chantNextParts();
const withCatalog = parts.releaseCatalog && parts.registryCatalog;
const parser = async () => (await import("@cdktn/hcl2json")) as never;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function memoryStore() {
  const objects = new Map<string, string>();
  const store: RegistryStore = {
    location: "mem://registry",
    async put(key, body) {
      objects.set(key, typeof body === "string" ? body : Buffer.from(body).toString("utf-8"));
      return {};
    },
    async read(key) {
      return objects.has(key) ? { body: objects.get(key)! } : {};
    },
  };
  return { store, objects };
}

const REG: RegistrySettings = { bucket: "s3://modules", url: "https://modules.test", namespace: "acme" };
const settings = { modules: { registry: REG } };

/** A repo that publishes modules/net at 0.1.0 and 0.2.0, with a root pinned to 0.1.0. */
async function published() {
  const repo = tmp("terragucci-status-");
  write(repo, {
    "modules/net/main.tf": 'resource "terraform_data" "a" {}\n',
    "live/dev/main.tf": 'terraform {\n  backend "s3" {}\n}\n\nmodule "net" {\n  source  = "modules.test/acme/net/generic"\n  version = "0.1.0"\n}\n',
  });
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "feat: net");
  const mem = memoryStore();
  const opts = { registryStore: mem.store, parser: await parser(), terraformDocs: async () => null };
  await publish(repo, settings, opts);
  write(repo, { "modules/net/outputs.tf": 'output "id" {\n  value = terraform_data.a.id\n}\n' });
  commit(repo, "feat(net): an id output");
  await publish(repo, settings, opts);
  return { repo, mem };
}

const show = (repo: string, path: string): string => execFileSync("git", ["-C", repo, "show", `chant/lifecycle:${path}`], { encoding: "utf-8" });

describe.skipIf(!withCatalog)("deprecate, yank and restore (terragucci#1298)", () => {
  it("records a deprecation with actor and reason, and rewrites the catalog; a deprecated pin gets the tip and passes", async () => {
    const { repo, mem } = await published();
    const r = await setReleaseStatus(repo, settings, { word: "deprecate", module: "net", version: "0.1.0", reason: "no id output", use: "0.2.0" }, { registryStore: mem.store, env: { USER: "ana" } });
    expect(r.record).toMatchObject({ component: "modules/net", releaseVersion: "0.1.0", status: "deprecated", reason: "no id output", replacement: "0.2.0", actor: "ana" });
    expect(describeStatus(r)).toContain("modules/net 0.1.0: deprecated (no id output); move to 0.2.0");
    expect(show(repo, "modules/release-status.jsonl")).toContain('"status":"deprecated"');

    const catalog = JSON.parse(mem.objects.get("catalog/index.json")!) as ChantReleaseCatalogDoc;
    expect(catalog.components[0].versions.find((v) => v.version === "0.1.0")!.status).toMatchObject({ state: "deprecated", replacement: "0.2.0" });

    const tips = await repoTips(repo, ["live/dev"], { settings: { gate: "on-destructive" } as never, parser: await parser(), releaseCatalogs: [catalog] });
    const tip = tips.find((t) => t.rule === DEPRECATED_VERSION_TIP);
    expect(tip?.root).toBe("live/dev");
    expect(tip?.message).toContain("which is deprecated: no id output; move to 0.2.0");
  });

  it("refuses a yanked pin under require while the version stays in versions, and restore clears it", async () => {
    const { repo, mem } = await published();
    await setReleaseStatus(repo, settings, { word: "yank", module: "modules/net", version: "0.1.0", reason: "leaks the admin role" }, { registryStore: mem.store, env: { USER: "ana" } });
    expect(JSON.parse(mem.objects.get("v1/modules/acme/net/generic/versions")!).modules[0].versions).toEqual([{ version: "0.1.0" }, { version: "0.2.0" }]);

    const core = (await chantReleaseCatalog())!;
    const ledger = (): Ledger => ({ from: repo, records: parseLedger(show(repo, "modules/releases.jsonl")), file: () => undefined, status: show(repo, "modules/release-status.jsonl") });
    expect(yankedPin(ledger(), "net", "0.1.0", core)).toBe("modules/net 0.1.0 is yanked (leaks the admin role) by ana; move the pin to 0.2.0");
    expect(yankedPin(ledger(), "net", "0.2.0", core)).toBeUndefined();

    await setReleaseStatus(repo, settings, { word: "restore", module: "net", version: "0.1.0" }, { registryStore: mem.store, env: { USER: "ana" }, now: () => new Date(Date.now() + 1000) });
    expect(yankedPin(ledger(), "net", "0.1.0", core)).toBeUndefined();
  });

  it("needs a reason to deprecate or yank, and a recorded version", async () => {
    const { repo, mem } = await published();
    await expect(setReleaseStatus(repo, settings, { word: "yank", module: "net", version: "0.1.0" }, { registryStore: mem.store })).rejects.toThrow("needs --reason");
    await expect(setReleaseStatus(repo, settings, { word: "deprecate", module: "net", version: "9.9.9", reason: "x" }, { registryStore: mem.store })).rejects.toThrow("its recorded versions are 0.1.0, 0.2.0");
    await expect(setReleaseStatus(repo, settings, { word: "deprecate", module: "net", version: "0.1.0", reason: "x", use: "3.0.0" }, { registryStore: mem.store })).rejects.toThrow("--use 3.0.0 is not a recorded version");
  });
});

describe("the hosts the deprecated-version tip reads", () => {
  it("are the repo's own registry and the registry hosts sources.modules names, never a public registry or a git host", () => {
    expect(catalogHosts({ modules: { registry: { url: "https://Modules.Example.com" } }, sources: { modules: ["./**", "registry.terraform.io/terraform-aws-modules/*", "mods.acme.dev/acme/*", "git::https://github.com/acme/*"] } })).toEqual([
      "github.com",
      "mods.acme.dev",
      "modules.example.com",
    ]);
  });
});
