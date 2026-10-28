import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { RegistrySettings } from "../src/config";
import { chantNextParts, chantReleaseCatalog, type ChantReleaseCatalogDoc } from "../src/chant-next";
import { publish } from "../src/publish";
import { CATALOG_DIR, describeCatalog, describeComponent, findComponent, publishCatalog, readCatalog } from "../src/publish/catalog";
import type { RegistryStore } from "../src/publish/registry";
import { git, tmp, write } from "./helpers";

const parts = await chantNextParts();
const withCatalog = parts.releaseCatalog && parts.registryCatalog;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** A bucket in memory that counts its writes. */
function memoryStore() {
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const store: RegistryStore = {
    location: "mem://registry",
    async put(key, body) {
      puts.push(key);
      objects.set(key, typeof body === "string" ? body : Buffer.from(body).toString("utf-8"));
      return {};
    },
    async read(key) {
      return objects.has(key) ? { body: objects.get(key)! } : {};
    },
  };
  return { store, objects, puts };
}

const REG: RegistrySettings = { bucket: "s3://modules", url: "https://modules.test", namespace: "acme" };

function repoWithModule(): string {
  const dir = tmp("terragucci-catalog-");
  write(dir, {
    "modules/net/main.tf": 'variable "name" {\n  type        = string\n  description = "The network name"\n}\n\nresource "terraform_data" "a" {}\n\noutput "id" {\n  value = terraform_data.a.id\n}\n',
    "modules/net/README.md": "# net\n",
    "modules/net/.terraform-docs.yml": "formatter: markdown table\n",
    "live/dev/main.tf": 'terraform {\n  backend "s3" {}\n}\n\nmodule "net" {\n  source  = "modules.test/acme/net/generic"\n  version = "0.1.0"\n  name    = "dev"\n}\n',
  });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: the net module");
  return dir;
}

/** The release records the checkout's ledger holds. */
function ledgerLines(repo: string): Record<string, unknown>[] {
  const text = execFileSync("git", ["-C", repo, "show", "chant/lifecycle:modules/releases.jsonl"], { encoding: "utf-8" });
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const parser = async () => (await import("@cdktn/hcl2json")) as never;

describe("every publish writes a release record (terragucci#1289 ruling A)", () => {
  it("records an unattested release on the ledger with its version, through chant's writer", async () => {
    const repo = repoWithModule();
    const mem = memoryStore();
    const rows = await publish(repo, { modules: { registry: { ...REG, catalog: "off" } } }, { registryStore: mem.store });
    expect(rows.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    const records = ledgerLines(repo);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ component: "modules/net", env: "modules", releaseVersion: "0.1.0", gitSha: git(repo, "rev-parse", "HEAD").trim() });
    expect(String(records[0].digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records a git-tags release too, and writes nothing on a dry run", async () => {
    const repo = repoWithModule();
    await publish(repo, { modules: { publish: "git-tags" } }, { dryRun: true });
    expect(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle")).toThrow();
    await publish(repo, { modules: { publish: "git-tags" } }, {});
    expect(ledgerLines(repo).map((r) => r.releaseVersion)).toEqual(["0.1.0"]);
  });
});

describe.skipIf(!withCatalog)("the release catalog beside the registry", () => {
  const settings = { modules: { registry: REG } };
  const docsRuns: string[] = [];
  const terraformDocs = async ({ config }: { dir: string; config: string }) => {
    docsRuns.push(config);
    return "## Inputs\n\n| name |\n|---|\n| name |\n";
  };

  it("writes the catalog once per version, nothing under _headers or providers/, and nothing again on a rerun", async () => {
    const repo = repoWithModule();
    const mem = memoryStore();
    const first = await publish(repo, settings, { registryStore: mem.store, parser: await parser(), terraformDocs });
    expect(first[0].detail).toContain(`release catalog under ${CATALOG_DIR}/`);
    const keys = [...mem.objects.keys()].filter((k) => k.startsWith(`${CATALOG_DIR}/`));
    expect(keys).toContain("catalog/index.html");
    expect(keys).toContain("catalog/index.json");
    expect(keys).toContain("catalog/modules/net/consumers.json");
    expect(keys.some((k) => k.includes("/0.1.0/index.html"))).toBe(true);
    expect([...mem.objects.keys()].some((k) => k === "_headers" || k.startsWith("providers/") || k.startsWith("catalog/_headers"))).toBe(false);
    expect(docsRuns).toEqual([".terraform-docs.yml"]);

    const catalog = JSON.parse(mem.objects.get("catalog/index.json")!) as ChantReleaseCatalogDoc;
    const net = catalog.components.find((c) => c.name === "modules/net")!;
    expect(net.fields.terraform).toMatchObject({ address: "modules.test/acme/net/generic" });
    expect(net.versions.map((v) => v.version)).toEqual(["0.1.0"]);
    expect(net.versions[0].changelog.entries.map((e) => e.subject)).toEqual(["the net module"]);
    expect(net.versions[0].consumers).toEqual([{ root: "live/dev", file: "live/dev/main.tf", address: "module.net" }]);

    // A rerun publishes nothing, so nothing is written.
    const before = mem.puts.length;
    expect((await publish(repo, settings, { registryStore: mem.store, parser: await parser(), terraformDocs })).every((r) => r.status === "unchanged")).toBe(true);
    expect(mem.puts.length).toBe(before);

    // The catalog step on its own over the same ledger writes the same bytes, so nothing again; the version's docs are not read again.
    const again = await publishCatalog(repo, REG, mem.store, { modules: [{ name: "net", rel: "modules/net" }], parser: await parser(), terraformDocs });
    expect(again.status).toBe("unchanged");
    expect(mem.puts.length).toBe(before);
    expect(docsRuns).toHaveLength(1);
  });

  it("adds the next version's pages beside the first, keeping the first's", async () => {
    const repo = repoWithModule();
    const mem = memoryStore();
    await publish(repo, settings, { registryStore: mem.store, parser: await parser(), terraformDocs });
    const firstPage = [...mem.objects.keys()].find((k) => k.includes("/0.1.0/index.html"))!;
    const firstBytes = mem.objects.get(firstPage);
    write(repo, { "modules/net/outputs.tf": 'output "name" {\n  value = "x"\n}\n' });
    commit(repo, "feat(net): a name output");
    const second = await publish(repo, settings, { registryStore: mem.store, parser: await parser(), terraformDocs });
    expect(second.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.2.0:published"]);
    const catalog = JSON.parse(mem.objects.get("catalog/index.json")!) as ChantReleaseCatalogDoc;
    expect(catalog.components[0].versions.map((v) => v.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(catalog.components[0].latest).toBe("0.2.0");
    expect(catalog.components[0].versions[0].changelog).toMatchObject({ bump: "minor", entries: [{ kind: "feat", subject: "a name output", scope: "net" }] });
    expect(mem.objects.get(firstPage)).toBe(firstBytes);
  });

  it("writes nothing on a dry run, and nothing with catalog: off", async () => {
    const repo = repoWithModule();
    const mem = memoryStore();
    await publish(repo, settings, { registryStore: mem.store, dryRun: true });
    expect(mem.puts).toEqual([]);
    await publish(repo, { modules: { registry: { ...REG, catalog: "off" } } }, { registryStore: mem.store });
    expect(mem.puts.some((k) => k.startsWith(`${CATALOG_DIR}/`))).toBe(false);
  });

  it("is read back by terragucci modules through the registry URL, with the host's token", async () => {
    const repo = repoWithModule();
    const mem = memoryStore();
    await publish(repo, settings, { registryStore: mem.store, parser: await parser(), terraformDocs });
    const sent: (string | undefined)[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? undefined);
      const key = url.replace("https://modules.test/", "");
      return mem.objects.has(key) ? new Response(mem.objects.get(key)!, { status: 200 }) : new Response("no", { status: 404 });
    };
    const before = process.env.TF_TOKEN_modules_test;
    process.env.TF_TOKEN_modules_test = "reader-token";
    try {
      const catalog = await readCatalog({ settings: REG, fetch: fetchFn });
      expect(catalog.components.map((c) => c.name)).toEqual(["modules/net"]);
      expect(sent).toEqual(["Bearer reader-token"]);
      expect(findComponent(catalog, "net")?.name).toBe("modules/net");
      expect(findComponent(catalog, "modules.test/acme/net/generic")?.name).toBe("modules/net");
    } finally {
      if (before === undefined) delete process.env.TF_TOKEN_modules_test;
      else process.env.TF_TOKEN_modules_test = before;
    }
  });
});

describe("terragucci modules over a catalog", () => {
  const version = (v: string, state: "active" | "deprecated" | "yanked", reason: string | null = null, replacement: string | null = null) => ({
    version: v,
    digest: `sha256:${v.replace(/\./g, "").padEnd(64, "0")}`,
    commit: "0123456789abcdef0123456789abcdef01234567",
    time: "2026-10-27T10:00:00.000Z",
    actor: "ana",
    envs: ["modules"],
    status: { state, reason, replacement, actor: state === "active" ? null : "ana", time: state === "active" ? null : "2026-10-28T10:00:00.000Z" },
    changelog: { bump: null, entries: [] },
    attestation: { state: "unsigned" as const, verify: null, identity: null },
    consumers: v === "1.0.0" ? [{ root: "live/dev", file: "live/dev/main.tf", address: "module.net" }] : [],
    fields: {},
  });
  const fixture: ChantReleaseCatalogDoc = {
    $schema: "https://intentius.io/chant/schemas/release-catalog.schema.json",
    contract: 1,
    chant: "0.124.55",
    generatedAt: "2026-10-28T10:00:00.000Z",
    components: [
      { name: "modules/db", latest: "0.3.0", fields: { terraform: { address: "modules.test/acme/db/generic" } }, versions: [version("0.3.0", "active")] },
      {
        name: "modules/net",
        latest: "1.1.0",
        fields: { terraform: { address: "modules.test/acme/net/generic" } },
        versions: [version("1.1.0", "active"), version("1.0.0", "deprecated", "drops the old subnet layout", "1.1.0"), version("0.9.0", "yanked", "leaks the admin role")],
      },
    ],
  };

  it("lists each module with its address, newest active version and marked versions", () => {
    expect(describeCatalog(fixture)).toBe(
      ["modules/db  modules.test/acme/db/generic  latest 0.3.0  (1 version)", "modules/net  modules.test/acme/net/generic  latest 1.1.0  (3 versions, 1 deprecated, 1 yanked)"].join("\n"),
    );
  });

  it("shows one module's versions with their status, reason and consumers", () => {
    const text = describeComponent(findComponent(fixture, "modules/net")!);
    expect(text).toContain("modules/net (modules.test/acme/net/generic), latest 1.1.0");
    expect(text).toContain("1.0.0  deprecated: drops the old subnet layout; move to 1.1.0  2026-10-27  0123456789ab  unsigned, 1 consumer");
    expect(text).toContain("0.9.0  yanked: leaks the admin role");
  });

  it("reads a catalog only on a chant that carries the reader", async () => {
    if (await chantReleaseCatalog()) return;
    await expect(readCatalog({ registry: "https://modules.test" })).rejects.toThrow("the installed chant has no release catalog reader");
  });
});
