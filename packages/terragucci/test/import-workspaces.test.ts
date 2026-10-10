import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { readScalr } from "../src/import/scalr";
import { readTfe } from "../src/import/tfe";
import { convertWorkspaces, describeWorkspaceImport, importWorkspaces, repoOfRemote, type PlatformRead, type PlatformWorkspace } from "../src/import/workspaces";
import { CONCEPTS_TABLE } from "../src/import/platform-guide";
import type { StoreFetch } from "../src/report/object-store";
import { backend, remoteState, tmp, write } from "./helpers";

const GUIDE = join(__dirname, "../../../docs-site/src/content/docs/guides/coming-from-hcp-terraform-scalr-or-otf.mdx");
const FIXTURES = join(__dirname, "../../../stack/fixtures/tfe-api");
const TOKEN = "test-token";

describe("the guide and the import share one table", () => {
  it("Concepts: the page's rows are platform-guide.ts's, cell for cell", () => {
    const lines = readFileSync(GUIDE, "utf-8").split("\n");
    const at = lines.findIndex((l) => l.startsWith("| HCP Terraform, Scalr, OTF |"));
    const rows: string[][] = [];
    for (const l of lines.slice(at + 2)) {
      if (!l.startsWith("|")) break;
      rows.push(l.trim().slice(1, -1).split("|").map((c) => c.trim()));
    }
    expect(rows).toEqual(CONCEPTS_TABLE.map((r) => [...r]));
  });
});

/**
 * The smoke claims' API (stack/fixtures/tfe-api/tfe.mjs) in process: the
 * same files, the same keys, pages of at most 5, and the token checked.
 * `calls` records each request as the mock does.
 */
function fakeApi(file: "hcp.json" | "scalr.json", o: { pageMax?: number; notFound?: RegExp } = {}): { fetch: StoreFetch; calls: string[]; auth: (string | undefined)[] } {
  const api = JSON.parse(readFileSync(join(FIXTURES, file), "utf-8")) as Record<string, Record<string, unknown>>;
  const calls: string[] = [];
  const auth: (string | undefined)[] = [];
  const answer = (status: number, doc: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(doc) });
  const fetchFn: StoreFetch = async (raw, init) => {
    const url = new URL(raw);
    calls.push(`${init.method} ${decodeURIComponent(url.pathname + url.search)}`);
    auth.push(init.headers.authorization);
    if (url.pathname === "/.well-known/terraform.json") return answer(200, { "tfe.v2": "/api/tfe/v2/" });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, {});
    if (o.notFound?.test(url.pathname)) return answer(404, {});
    const doc = url.pathname.startsWith("/api/tfe/v2/") ? api.tfe : url.pathname.startsWith("/api/iacp/v3/") ? api.iacp : undefined;
    const params = [...url.searchParams].filter(([k]) => !k.startsWith("page[")).sort(([a], [b]) => a.localeCompare(b));
    const key = url.pathname.split("/").slice(4).join("/") + (params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "");
    const got = doc?.[key] as unknown;
    if (got === undefined) return answer(404, {});
    const list = Array.isArray(got) ? { data: got } : Array.isArray((got as { data?: unknown }).data) ? (got as { data: unknown[]; included?: unknown[] }) : undefined;
    if (!list) return answer(200, got);
    const size = Math.min(o.pageMax ?? 5, Number(url.searchParams.get("page[size]") ?? 20));
    const page = Number(url.searchParams.get("page[number]") ?? 1);
    const pages = Math.max(1, Math.ceil(list.data.length / size));
    return answer(200, { data: list.data.slice((page - 1) * size, page * size), ...("included" in list ? { included: list.included } : {}), meta: { pagination: { "next-page": page < pages ? page + 1 : null } } });
  };
  return { fetch: fetchFn, calls, auth };
}

const SERVICES = ["platform", "email", "orders", "payments", "search"];

/** The example's shape: dev, staging and prod, each service reading its environment's platform. */
function shop(): string {
  const files: Record<string, string> = {};
  for (const env of ["dev", "staging", "prod"]) {
    for (const s of SERVICES) files[`envs/${env}/${s}/main.tf`] = backend(`envs/${env}/${s}.tfstate`) + (s === "platform" ? "" : remoteState(`envs/${env}/platform.tfstate`));
  }
  files[".forgejo/workflows/keep.yml"] = "on: push\n";
  return write(tmp(), files);
}

const ENV = { HOME: "/nonexistent", TF_TOKEN_tfe_test: TOKEN, TF_TOKEN_acme_scalr_io: TOKEN };

describe("import hcp", () => {
  it("reads every page of workspaces, their variables, variable sets and inbound run triggers, with the token, and only GETs", async () => {
    const api = fakeApi("hcp.json");
    const read = await readTfe("hcp", "tfe.test", "acme", ENV, api.fetch);
    expect(read.workspaces.map((w) => w.name)).toHaveLength(14);
    expect(api.calls.filter((c) => c.includes("organizations/acme/workspaces"))).toHaveLength(3);
    expect(api.calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(api.auth.slice(1).every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    const orders = read.workspaces.find((w) => w.name === "dev-orders")!;
    expect(orders.vars.map((v) => v.at)).toEqual(["varsets[shared].vars.api_token", "varsets[shared].vars.AWS_REGION"]);
    expect(orders.upstream).toEqual(["ws-dev-platform"]);
  });

  it("never keeps a sensitive variable's value, even when the server sends one", async () => {
    const read = await readTfe("hcp", "tfe.test", "acme", ENV, fakeApi("hcp.json").fetch);
    const secret = read.workspaces.flatMap((w) => w.vars).filter((v) => v.sensitive);
    expect(secret.map((v) => v.key).sort()).toEqual(["api_token", "db_password"]);
    expect(JSON.stringify(read)).not.toContain("never-copy-this");
  });

  it("writes roots, versions per root, tfvars, env, secrets and run triggers as waves.after, and lists what it skipped", async () => {
    const repo = shop();
    const api = fakeApi("hcp.json");
    const r = await importWorkspaces(repo, () => readTfe("hcp", "tfe.test", "acme", ENV, api.fetch), { repo: "acme/shop" });
    const cfg = await loadConfig(join(repo, "terragucci.yml"));
    expect(cfg.roots).toEqual([...SERVICES.map((s) => `envs/dev/${s}`), ...SERVICES.map((s) => `envs/staging/${s}`)].sort());
    expect(cfg.binary).toBe("terraform");
    expect(cfg.version).toEqual(Object.fromEntries([...SERVICES.map((s) => [`envs/dev/${s}`, "1.13.1"]), ...SERVICES.map((s) => [`envs/staging/${s}`, "1.13.2"])].sort(([a], [b]) => a.localeCompare(b))));
    expect(cfg.env).toEqual({ TEAM: "shop", AWS_REGION: "us-east-1" });
    expect(cfg.pass).toEqual({ secrets: ["TF_VAR_api_token", "TF_VAR_db_password"] });
    // dev-orders after dev-platform is the reads' order already; staging-platform after dev-orders is not.
    expect(cfg.waves).toEqual({ after: { "envs/staging/platform": ["envs/dev/orders"] } });
    expect(readFileSync(join(repo, "envs/dev/platform/terraform.tfvars"), "utf-8")).toContain('region = "us-east-1"');
    expect(r.tfvarsFiles).toEqual(["envs/dev/platform/terraform.tfvars", "envs/staging/platform/terraform.tfvars"]);
    const text = describeWorkspaceImport(r);
    expect(text).not.toContain("never-copy-this");
    expect(readFileSync(join(repo, "terragucci.yml"), "utf-8")).not.toContain("never-copy-this");
    expect(text).toContain("workspaces[prod-orders, prod-orders-blue] (Several workspaces on one working directory): envs/prod/orders runs 2 workspaces");
    expect(text).toContain("workspaces[billing] (Workspace): it runs acme/billing, not acme/shop; skipped");
    expect(text).toContain("workspaces[scratch] (Workspace): no VCS connection");
    expect(text).toContain("workspaces[dev-orders].run-triggers (Run triggers, `tfe_outputs`): the terraform_remote_state reads already order envs/dev/orders after envs/dev/platform");
    expect(text).toContain("workspaces[dev-search].run-triggers (Run triggers, `tfe_outputs`): billing is not a root here");
    expect(text).toContain("workspaces[staging-platform].vars.TFC_AWS_PROVIDER_AUTH (Dynamic provider credentials)");
    expect(text).toContain("workspaces[].auto-apply (Confirm and apply, auto-apply): dev-email apply with no confirmation");
    expect(text).toContain("workspaces[].execution-mode (Agents, remote execution): staging-search run on an agent pool");
    expect(text).toContain("Secrets to create in the forge before the first plan, with the values from where they came from: TF_VAR_api_token, TF_VAR_db_password");
  });

  it("finds a CLI-driven workspace's directory from the cloud block that names it", async () => {
    const repo = write(tmp(), { "infra/main.tf": 'terraform {\n  cloud {\n    hostname = "tfe.test"\n    organization = "acme"\n    workspaces {\n      name = "scratch"\n    }\n  }\n}\n' });
    const r = await importWorkspaces(repo, () => readTfe("hcp", "tfe.test", "acme", ENV, fakeApi("hcp.json").fetch), { repo: "acme/shop", dryRun: true });
    expect(r.settings.roots).toContain("infra");
    expect(describeWorkspaceImport(r)).toContain("workspaces[scratch] (Workspace): roots: infra, from its cloud block or remote backend");
    // `latest` is not one release, so that root keeps its own pin.
    expect(describeWorkspaceImport(r)).toContain("workspaces[scratch].terraform-version (Terraform version per workspace): latest is not one release");
  });

  it("reads an OTF server, which has no variable sets or run triggers, as no order and no sets", async () => {
    const api = fakeApi("hcp.json", { notFound: /\/(varsets|run-triggers)$/ });
    const read = await readTfe("otf", "tfe.test", "acme", ENV, api.fetch);
    expect(read.workspaces.find((w) => w.name === "dev-orders")!.vars).toEqual([]);
    expect(read.workspaces.every((w) => w.upstream === undefined)).toBe(true);
  });

  it("names the token to set when the host refuses", async () => {
    await expect(readTfe("hcp", "tfe.test", "acme", { HOME: "/nonexistent" }, fakeApi("hcp.json").fetch)).rejects.toThrow(/answered 401; there is no token for tfe.test: set TF_TOKEN_tfe_test/);
  });

  it("refuses to replace a terragucci.yml without --force, before it reads anything, and writes nothing on a dry run", async () => {
    const repo = shop();
    write(repo, { "terragucci.yml": "binary: tofu\n" });
    const api = fakeApi("hcp.json");
    await expect(importWorkspaces(repo, () => readTfe("hcp", "tfe.test", "acme", ENV, api.fetch), {})).rejects.toThrow(/--force/);
    expect(api.calls).toEqual([]);
    const dry = await importWorkspaces(repo, () => readTfe("hcp", "tfe.test", "acme", ENV, api.fetch), { repo: "acme/shop", dryRun: true });
    expect(dry.wrote).toBeUndefined();
    expect(readFileSync(join(repo, "terragucci.yml"), "utf-8")).toBe("binary: tofu\n");
    expect(existsSync(join(repo, "envs/dev/platform/terraform.tfvars"))).toBe(false);
    expect(describeWorkspaceImport(dry)).toContain("dry run, nothing written");
  });
});

describe("import scalr", () => {
  it("reads every environment's workspaces and variables over Scalr's API, keeping each scope once", async () => {
    const api = fakeApi("scalr.json");
    const read = await readScalr("acme.scalr.io", undefined, ENV, api.fetch);
    expect(read.workspaces.map((w) => w.at)).toEqual(["workspaces[staging/staging-platform]", "workspaces[staging/staging-orders]", "workspaces[prod/prod-platform]", "workspaces[prod/prod-orders]", "workspaces[prod/prod-email]", "workspaces[prod/prod-legacy]"]);
    const platform = read.workspaces[0];
    expect(platform.binary).toBe("tofu");
    expect(platform.owners).toEqual(["env-staging", "staging"]);
    expect(platform.vars.map((v) => `${v.at}${v.sensitive ? " (sensitive)" : ""}`)).toEqual([
      "workspaces[staging/staging-platform].vars.region",
      "workspaces[staging/staging-platform].vars.db_password (sensitive)",
      "environments[staging].vars.DATADOG_API_KEY (sensitive)",
      "account.vars.TEAM",
    ]);
    expect(JSON.stringify(read.workspaces)).not.toContain("never-copy-this");
    expect(api.calls.every((c) => c.startsWith("GET /api/iacp/v3/"))).toBe(true);
  });

  it("writes roots, tofu, env and secrets, and lists each policy group with what its levels become", async () => {
    const repo = shop();
    const r = await importWorkspaces(repo, () => readScalr("acme.scalr.io", undefined, ENV, fakeApi("scalr.json").fetch), { repo: "acme/shop" });
    const cfg = await loadConfig(join(repo, "terragucci.yml"));
    expect(cfg.roots).toEqual(["envs/prod/email", "envs/prod/orders", "envs/prod/platform", "envs/staging/orders", "envs/staging/platform"]);
    expect([cfg.binary, cfg.version]).toEqual(["tofu", "1.10.6"]);
    expect(cfg.env).toEqual({ TEAM: "shop" });
    expect(cfg.pass).toEqual({ secrets: ["DATADOG_API_KEY", "TF_VAR_db_password"] });
    const text = describeWorkspaceImport(r);
    expect(text).toContain("policy-groups[cost-guard] (Scalr OPA policy group): on staging, prod, from acme/policies/cost at main");
    expect(text).toContain("max_monthly_cost (hard-mandatory): a deny rule; instance_types (soft-mandatory): a deny rule that a person in policy.override can let through; owner_tags (advisory): a warn rule");
    expect(text).toContain("run-triggers: Scalr's API lists no run triggers");
    expect(text).toContain("workspaces[prod/prod-legacy] (Workspace): no VCS connection");
  });

  it("reads one environment by name or ID, and names one it cannot see", async () => {
    expect((await readScalr("acme.scalr.io", "prod", ENV, fakeApi("scalr.json").fetch)).workspaces).toHaveLength(4);
    expect((await readScalr("acme.scalr.io", "env-staging", ENV, fakeApi("scalr.json").fetch)).workspaces).toHaveLength(2);
    await expect(readScalr("acme.scalr.io", "qa", ENV, fakeApi("scalr.json").fetch)).rejects.toThrow(/no environment the token sees is named qa/);
  });

  it("takes SCALR_TOKEN when no TF_TOKEN_<host> is set", async () => {
    const read = await readScalr("acme.scalr.io", "prod", { HOME: "/nonexistent", SCALR_TOKEN: TOKEN }, fakeApi("scalr.json").fetch);
    expect(read.workspaces).toHaveLength(4);
  });
});

describe("convertWorkspaces", () => {
  const ws = (name: string, extra: Partial<PlatformWorkspace> = {}): PlatformWorkspace => ({ id: `ws-${name}`, name, at: `workspaces[${name}]`, owners: ["acme"], workingDirectory: name, repo: "acme/shop", vars: [], ...extra });
  const read = (workspaces: PlatformWorkspace[]): PlatformRead => ({ source: "hcp", host: "app.terraform.io", from: "app.terraform.io/acme", workspaces });

  it("names an env variable two workspaces set to different values, and writes neither", () => {
    const c = convertWorkspaces(read([ws("a", { vars: [{ key: "TEAM", value: "x", category: "env", sensitive: false, hcl: false, at: "workspaces[a].vars.TEAM" }] }), ws("b", { vars: [{ key: "TEAM", value: "y", category: "env", sensitive: false, hcl: false, at: "workspaces[b].vars.TEAM" }] })]));
    expect(c.settings.env).toBeUndefined();
    expect(c.notes.find((n) => n.key === "workspaces[b].vars.TEAM")?.detail).toMatch(/set to two values/);
  });

  it("on GitLab lists the secrets as masked CI/CD variables and writes no pass", () => {
    const c = convertWorkspaces(read([ws("a", { vars: [{ key: "db_password", category: "terraform", sensitive: true, hcl: false, at: "workspaces[a].vars.db_password" }] })]), { forge: "gitlab" });
    expect(c.settings.pass).toBeUndefined();
    expect(c.notes.find((n) => n.key === "workspaces[a].vars.db_password")?.detail).toMatch(/masked CI\/CD variable TF_VAR_db_password/);
  });

  it("escapes templates in a string variable and keeps an HCL one as written", () => {
    const c = convertWorkspaces(read([ws("a", { vars: [{ key: "greeting", value: "hi ${name}", category: "terraform", sensitive: false, hcl: false, at: "x.greeting" }, { key: "tags", value: '{ team = "shop" }', category: "terraform", sensitive: false, hcl: true, at: "x.tags" }] })]));
    expect(c.tfvars.get("a")).toContain('greeting = "hi $${name}"\ntags = { team = "shop" }');
  });

  it("leaves a directory's tfvars alone when it has one", () => {
    const c = convertWorkspaces(read([ws("a", { vars: [{ key: "region", value: "x", category: "terraform", sensitive: false, hcl: false, at: "workspaces[a].vars.region" }] })]), { hasTfvars: () => true });
    expect(c.tfvars.size).toBe(0);
    expect(c.notes.find((n) => n.key === "workspaces[a].vars")?.detail).toBe("a/terraform.tfvars is already there; add region to it by hand");
  });

  it("names run triggers that make a cycle with the reads, and writes no order", () => {
    const c = convertWorkspaces(read([ws("a", { upstream: ["ws-b"] }), ws("b")]), { reads: new Map([["b", new Set(["a"])]]) });
    expect(c.settings.waves).toBeUndefined();
    expect(c.notes.find((n) => n.key === "workspaces[a].run-triggers")?.detail).toMatch(/cycle/);
  });

  it("writes no version when the workspaces mix OpenTofu and Terraform", () => {
    const c = convertWorkspaces(read([ws("a", { version: "1.10.6", binary: "tofu" }), ws("b", { version: "1.13.1", binary: "terraform" })]));
    expect([c.settings.binary, c.settings.version]).toEqual([undefined, undefined]);
  });
});

describe("repoOfRemote", () => {
  it("reads owner/name from https, ssh and scp remotes", () => {
    expect(repoOfRemote("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(repoOfRemote("ssh://git@forgejo.local:2222/acme/shop.git\n")).toBe("acme/shop");
    expect(repoOfRemote("git@gitlab.com:acme/infra/shop.git")).toBe("acme/infra/shop");
    expect(repoOfRemote("")).toBeUndefined();
  });
});
