import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import type { ChantReleaseCatalogDoc } from "../src/chant-next";
import { registryAliases } from "../src/rollout/discover";
import { planWaves } from "../src/rollout/waves";
import { backend, bareFrom, git, tmp, write } from "./helpers";

/** The fixture catalog, with bucket 1.3.0 published on top of 1.2.0 and two changelog entries for it. */
function catalog(): string {
  const doc = JSON.parse(readFileSync(join(__dirname, "fixtures/templates/catalog.json"), "utf-8")) as ChantReleaseCatalogDoc;
  const bucket = doc.components.find((c) => c.name === "modules/bucket")!;
  const v120 = bucket.versions.find((v) => v.version === "1.2.0")!;
  const v130 = structuredClone(v120);
  v130.version = "1.3.0";
  v130.digest = `sha256:${"4".repeat(64)}`;
  v130.commit = "4".repeat(40);
  v130.time = "2026-10-20T00:00:00Z";
  v130.changelog = {
    bump: "minor",
    entries: [
      { kind: "feat", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", subject: "add lifecycle rules for old objects", scope: "bucket" },
      { kind: "fix", sha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890", subject: "tag the bucket's replica too" },
    ],
  };
  v120.changelog = { bump: "minor", entries: [{ kind: "feat", sha: "c3d4e5f60718293a4b5c6d7e8f90123456789012", subject: "output the private subnets" }] };
  bucket.versions.unshift(v130);
  bucket.latest = "1.3.0";
  return JSON.stringify(doc, null, 2);
}

/** An app's root as chant's renderAppRoot writes it, in short: its backend and one `module "app"` calling the bucket template. */
const app = (name: string, version: string) => `${backend(`apps/${name}.tfstate`)}module "app" {
  source  = "modules.test/acme/bucket/aws"
  version = "${version}"

  bucket_name = "${name}-data"
}
`;

const CONFIG = `forge: forgejo
url: https://forge.test/acme/infra
token_env: FORGE_TOKEN
modules:
  registry:
    dir: registry
    url: https://modules.test
    namespace: acme
templates: {}
waves:
  canary: ["apps/orders"]
`;

const APPS = { "apps/orders/main.tf": app("orders", "1.2.0"), "apps/billing/main.tf": app("billing", "1.2.0"), "apps/search/main.tf": app("search", "1.2.0") };

/** A clone of a bare origin whose default branch holds the config, the three apps and the registry's catalog. */
function repo(extra: Record<string, string> = {}, config = CONFIG): { dir: string; bare: string } {
  const bare = bareFrom(write(tmp(), { "terragucci.yml": config, "registry/catalog/index.json": catalog(), ...APPS, ...extra }));
  const dir = tmp();
  git(dir, "clone", "-q", bare, ".");
  return { dir, bare };
}

/** A forgejo with no pull requests yet, which records the ones the rollout opens. */
function fakeForge() {
  const pulls: { number: number; html_url: string; title: string; body: string; state: string; head: { ref: string; repo: { full_name: string } }; base: { ref: string } }[] = [];
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    let out: unknown = [];
    if (path === "/repos/acme/infra") out = { default_branch: "main", full_name: "acme/infra" };
    else if (method === "GET" && path === "/repos/acme/infra/pulls") out = (u.searchParams.get("page") ?? "1") === "1" ? pulls : [];
    else if (method === "POST" && path === "/repos/acme/infra/pulls") {
      const b = JSON.parse(init!.body!) as { head: string; base: string; title: string; body: string };
      const pr = { number: 7 + pulls.length, html_url: `https://forge.test/acme/infra/pulls/${7 + pulls.length}`, title: b.title, body: b.body, state: "open", head: { ref: b.head, repo: { full_name: "acme/infra" } }, base: { ref: b.base } };
      pulls.push(pr);
      out = pr;
    }
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { fetch, pulls };
}

async function run(dir: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const errs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
  process.chdir(dir);
  try {
    return { code: await main(argv), out: lines.join("\n"), err: errs.join("\n") };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
  }
}

const golden = (name: string, text: string): void => {
  const path = join(__dirname, "golden", name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Rollout = { status: string; template?: { template: string; name: string }; waves: { wave: number; canary: boolean; parts: { roots: string[]; apps?: string[]; files?: string[]; branch: string }[] }[]; roots: { root: string; state: string; app?: string; yanked?: true; version?: string }[] };

describe("terragucci rollout <template> <version>", () => {
  it("takes a registry address without its host as the module, and plans the canary app first (dry run)", async () => {
    const { dir } = repo();
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    const { code, out } = await run(dir, "rollout", "acme/bucket/aws", "1.3.0", "--json");
    expect(code).toBe(0);
    const r = JSON.parse(out).results as Rollout;
    expect(r.status).toBe("would-open");
    expect(r.template).toEqual({ template: "acme/bucket/aws", name: "bucket" });
    expect(r.waves.map((w) => w.parts.flatMap((p) => p.roots))).toEqual([["apps/orders"], ["apps/billing", "apps/search"]]);
    expect(r.waves.map((w) => w.parts.flatMap((p) => p.apps))).toEqual([["orders"], ["billing", "search"]]);
    expect(r.waves[0]!.parts[0]!.files).toEqual(["apps/orders/main.tf"]);
    expect(r.waves[0]!.parts[0]!.branch).toBe("terragucci/rollout/acme-bucket-aws-1.3.0/wave-1");
    expect(forge.pulls).toHaveLength(0);
  }, 30_000);

  it("--mode apply opens wave 1 titled by the apps it upgrades, with the changelog between the versions (golden)", async () => {
    const { dir, bare } = repo();
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t0ken");
    const { code } = await run(dir, "rollout", "acme/bucket/aws", "1.3.0", "--mode", "apply", "--json");
    expect(code).toBe(0);
    expect(forge.pulls).toHaveLength(1);
    const pr = forge.pulls[0]!;
    expect(pr.title).toBe("Upgrade bucket to 1.3.0: orders (wave 1 of 2)");
    expect(pr.body).toContain("- feat(bucket): add lifecycle rules for old objects (a1b2c3d)");
    expect(pr.body).not.toContain("output the private subnets");
    golden("rollout-template-wave-1.md", `${pr.title}\n\n${pr.body}\n`);
    const branch = "terragucci/rollout/acme-bucket-aws-1.3.0/wave-1";
    expect(git(bare, "diff", "--name-only", `main...${branch}`).trim()).toBe("apps/orders/main.tf");
    expect(git(bare, "show", `${branch}:apps/orders/main.tf`)).toContain('version = "1.3.0"');
  }, 30_000);

  it("moves an app on a yanked version from that version, in the first wave after the canaries", async () => {
    const { dir } = repo({ "apps/legacy/main.tf": app("legacy", "1.1.0") });
    vi.stubGlobal("fetch", fakeForge().fetch);
    const { code, out } = await run(dir, "rollout", "acme/bucket/aws", "1.3.0", "--json");
    expect(code).toBe(0);
    const r = JSON.parse(out).results as Rollout & { from: string };
    expect(r.from).toBe("1.2.0");
    expect(r.waves.map((w) => w.parts.flatMap((p) => p.roots))).toEqual([["apps/orders"], ["apps/legacy"], ["apps/billing", "apps/search"]]);
    expect(r.roots.find((s) => s.root === "apps/legacy")).toMatchObject({ state: "from", version: "1.1.0", app: "legacy", yanked: true });
  }, 30_000);

  it("without templates set, the same rollout names roots and keeps the module title", async () => {
    const { dir } = repo({}, CONFIG.replace("templates: {}\n", ""));
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t0ken");
    const { code, out } = await run(dir, "rollout", "acme/bucket/aws", "1.3.0", "--mode", "apply", "--json");
    expect(code).toBe(0);
    expect((JSON.parse(out).results as Rollout).template).toBeUndefined();
    expect(forge.pulls[0]!.title).toBe("terragucci rollout: acme/bucket/aws 1.2.0 -> 1.3.0, wave 1 of 2");
  }, 30_000);
});

describe("terragucci templates apps: upgrade and yanked", () => {
  it("lists each app with its version, the newest active version above it, and whether its version is yanked", async () => {
    const { dir } = repo({ "apps/legacy/main.tf": app("legacy", "1.1.0") });
    const { code, out } = await run(dir, "templates", "apps", "--template", "acme/bucket/aws", "--json");
    expect(code).toBe(0);
    const rows = JSON.parse(out).results as { app: string; version: string; upgrade: string | null; yanked: boolean }[];
    expect(rows.map((r) => [r.app, r.version, r.upgrade, r.yanked])).toEqual([
      ["billing", "1.2.0", "1.3.0", false],
      ["legacy", "1.1.0", "1.3.0", true],
      ["orders", "1.2.0", "1.3.0", false],
      ["search", "1.2.0", "1.3.0", false],
    ]);
  });

  it("an app on the newest version has no upgrade", async () => {
    const { dir } = repo({ "apps/orders/main.tf": app("orders", "1.3.0") });
    const rows = JSON.parse((await run(dir, "templates", "apps", "--json")).out).results as { app: string; upgrade: string | null }[];
    expect(rows.find((r) => r.app === "orders")!.upgrade).toBeNull();
  });
});

/** The fixture catalog with 1.4.0 published on top, active but unsigned. */
function withUnsigned(): string {
  const doc = JSON.parse(catalog()) as ChantReleaseCatalogDoc;
  const bucket = doc.components.find((c) => c.name === "modules/bucket")!;
  const v140 = structuredClone(bucket.versions.find((v) => v.version === "1.3.0")!);
  v140.version = "1.4.0";
  v140.digest = `sha256:${"5".repeat(64)}`;
  v140.commit = "5".repeat(40);
  v140.time = "2026-10-25T00:00:00Z";
  v140.attestation = { state: "unsigned", verify: null, identity: null };
  bucket.versions.unshift(v140);
  bucket.latest = "1.4.0";
  return JSON.stringify(doc, null, 2);
}
const UNSIGNED = { "registry/catalog/index.json": withUnsigned() };
const REQUIRE_ANY = CONFIG.replace("templates: {}\n", "templates:\n  require: any\n");

describe("templates.require: signed keeps an unsigned version from being an upgrade", () => {
  it("templates apps offers the newest signed version, and the unsigned one only under require: any", async () => {
    const signed = JSON.parse((await run(repo(UNSIGNED).dir, "templates", "apps", "--json")).out).results as { app: string; upgrade: string | null }[];
    expect(signed.map((r) => r.upgrade)).toEqual(["1.3.0", "1.3.0", "1.3.0"]);
    const any = JSON.parse((await run(repo(UNSIGNED, REQUIRE_ANY).dir, "templates", "apps", "--json")).out).results as { app: string; upgrade: string | null }[];
    expect(any.map((r) => r.upgrade)).toEqual(["1.4.0", "1.4.0", "1.4.0"]);
  }, 30_000);

  it("a rollout with no version named moves to the newest signed version the catalog lists", async () => {
    const { dir } = repo(UNSIGNED);
    vi.stubGlobal("fetch", fakeForge().fetch);
    const { code, out } = await run(dir, "rollout", "acme/bucket/aws", "--json");
    expect(code).toBe(0);
    const r = JSON.parse(out).results as Rollout & { to: string; discovered?: string };
    expect(r.to).toBe("1.3.0");
    expect(r.discovered).toBe("the release catalog");
  }, 30_000);

  it("a rollout to an unsigned version is refused under require: signed and opens nothing", async () => {
    const { dir } = repo(UNSIGNED);
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t0ken");
    const { code, out, err } = await run(dir, "rollout", "acme/bucket/aws", "1.4.0", "--mode", "apply", "--json");
    expect(code).toBe(1);
    expect(`${out}\n${err}`).toContain("acme/bucket/aws 1.4.0 is unsigned");
    expect(forge.pulls).toHaveLength(0);
  }, 30_000);

  it("under require: any the same rollout plans 1.4.0", async () => {
    const { dir } = repo(UNSIGNED, REQUIRE_ANY);
    vi.stubGlobal("fetch", fakeForge().fetch);
    const { code, out } = await run(dir, "rollout", "acme/bucket/aws", "1.4.0", "--json");
    expect(code).toBe(0);
    expect((JSON.parse(out).results as { to: string }).to).toBe("1.4.0");
  }, 30_000);
});

describe("rollout planning pieces", () => {
  it("names a hostless registry address on modules.registry's host", () => {
    expect(registryAliases("acme/bucket/aws", [{ modules: { registry: { dir: "registry", url: "https://modules.test", namespace: "acme" } as never } }])).toContain("modules.test/acme/bucket/aws");
  });

  it("puts a yanked root after the canaries only when it depends on nothing else in the rollout", () => {
    const waves = planWaves([{ key: "p", roots: ["a", "b", "c", "d"], dependsOn: new Map([["d", new Set(["b"])]]), canary: ["a"], first: ["c", "d"] }]);
    expect(waves.map((w) => w.parts[0]!.roots)).toEqual([["a"], ["c"], ["b"], ["d"]]);
  });
});
