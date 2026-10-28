import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { chantTemplateRender, chantTemplateRequests, overrideChantNext, type ChantReleaseCatalogDoc } from "../src/chant-next";
import { publish } from "../src/publish";
import type { RegistryStore } from "../src/publish/registry";
import { AUDIT_KINDS, ledgerEntries, REQUESTS_FILE } from "../src/report/audit";
import { REQUEST_NEEDS_CHANT } from "../src/templates";
import { bareFrom, git, tmp, write } from "./helpers";

const CATALOG = readFileSync(join(__dirname, "fixtures/templates/catalog.json"), "utf-8");
const chantHas = Boolean((await chantTemplateRequests()) && (await chantTemplateRender()));

const CONFIG = `forge: forgejo
url: https://forge.test/acme/infra
token_env: FORGE_TOKEN
modules:
  registry:
    dir: registry
    url: https://modules.test
    namespace: acme
generate:
  backend:
    s3:
      bucket: state
      key: "{root}/terraform.tfstate"
      region: us-east-1
  providers:
    aws:
      source: hashicorp/aws
      version: "~> 5.0"
      region: us-east-1
  required_version: ">= 1.14.0"
templates: {}
`;

/** A clone of a bare origin whose default branch holds the config and a registry directory with the fixture catalog. */
function repo(config = CONFIG, extra: Record<string, string> = {}): { dir: string; bare: string } {
  const bare = bareFrom(write(tmp(), { "terragucci.yml": config, "registry/catalog/index.json": CATALOG, ...extra }));
  const dir = tmp();
  git(dir, "clone", "-q", bare, ".");
  return { dir, bare };
}

/** A forgejo answering what request asks: the default branch, the open pull requests, and a new one. */
function fakeForge() {
  const pulls: { number: number; html_url: string; title: string; body: string; head: { ref: string; repo: { full_name: string } }; base: { ref: string } }[] = [];
  const calls: { method: string; path: string; body?: string }[] = [];
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method, path, ...(init?.body !== undefined ? { body: init.body } : {}) });
    let out: unknown = [];
    if (path === "/repos/acme/infra") out = { default_branch: "main", full_name: "acme/infra" };
    else if (method === "GET" && path === "/repos/acme/infra/pulls") out = (u.searchParams.get("page") ?? "1") === "1" ? pulls : [];
    else if (method === "POST" && path === "/repos/acme/infra/pulls") {
      const b = JSON.parse(init!.body!) as { head: string; base: string; title: string; body: string };
      const pr = { number: 7 + pulls.length, html_url: `https://forge.test/acme/infra/pulls/${7 + pulls.length}`, title: b.title, body: b.body, head: { ref: b.head, repo: { full_name: "acme/infra" } }, base: { ref: b.base } };
      pulls.push(pr);
      out = pr;
    }
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { fetch, pulls, calls, opened: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls")) };
}

/** Run the CLI in `dir` and return its exit code and stdout. */
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

const requestBranches = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/request").split("\n").filter(Boolean);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("terragucci templates", () => {
  it("lists only active versions whose attestation is verified or signed, with the form fields of the newest", async () => {
    const { dir } = repo();
    const { code, out } = await run(dir, "templates", "list", "--json");
    expect(code).toBe(0);
    const rows = JSON.parse(out).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "acme/bucket/aws", name: "bucket", component: "modules/bucket", address: "modules.test/acme/bucket/aws", kind: "app", latest: "1.2.0" });
    expect(rows[0].versions.map((v: { version: string; attestation: string }) => `${v.version}:${v.attestation}`)).toEqual(["1.2.0:signed"]);
    expect(rows[0].fields.map((f: { name: string }) => f.name)).toEqual(["bucket_name", "readers", "tags", "api_key"]);
    expect(rows[0].fields[0]).toEqual({ name: "bucket_name", kind: "string", label: "Bucket name", description: "The bucket's globally unique name.", required: true, sensitive: false, type: "string" });
    expect(rows[0].fields[1]).toMatchObject({ name: "readers", kind: "list", of: "string", default: [], required: false, type: "list(string)" });
  });

  it("with templates.require: any lists an unsigned version too, and never a yanked one", async () => {
    const { dir } = repo(CONFIG.replace("templates: {}", "templates:\n  require: any"));
    const { code, out } = await run(dir, "templates", "list", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out).results[0].versions.map((v: { version: string; attestation: string }) => `${v.version}:${v.attestation}`)).toEqual(["1.2.0:signed", "1.0.0:unsigned"]);
  });

  it("show names one template by address, path or last segment, and lists on a chant without template requests", async () => {
    const { dir } = repo();
    for (const name of ["acme/bucket/aws", "modules.test/acme/bucket/aws", "modules/bucket", "bucket"]) {
      const { code, out } = await run(dir, "templates", "show", name, "--json");
      expect(code, name).toBe(0);
      expect(JSON.parse(out).results.template).toBe("acme/bucket/aws");
    }
    const restore = [overrideChantNext("templateRequest", null), overrideChantNext("templateRender", null)];
    try {
      const { code, out } = await run(dir, "templates", "show", "bucket");
      expect(code).toBe(0);
      expect(out).toContain("bucket_name  string  required");
    } finally {
      for (const r of restore) r();
    }
  });
});

describe("terragucci request on a chant without template requests", () => {
  it("refuses with exit 1, names the chant it needs, and writes nothing", async () => {
    const { dir, bare } = repo();
    const restore = overrideChantNext("templateRequest", null);
    try {
      const { code, out } = await run(dir, "request", "acme/bucket/aws", "--name", "orders", "--input", "bucket_name=orders-data", "--dry-run", "--json");
      expect(code).toBe(1);
      expect(JSON.parse(out).error).toBe(REQUEST_NEEDS_CHANT);
      expect(requestBranches(bare)).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe.runIf(chantHas)("terragucci request", () => {
  it("--dry-run --json prints the branch and the files, and writes nothing", async () => {
    const { dir, bare } = repo();
    const { code, out } = await run(dir, "request", "acme/bucket/aws", "--name", "orders", "--input", "bucket_name=orders-data", "--dry-run", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out).results).toEqual({ branch: "request/bucket/orders", files: ["apps/orders/main.tf", "apps/orders/backend.tf", "apps/orders/providers.tf", "apps/orders/versions.tf"] });
    expect(existsSync(join(dir, "apps"))).toBe(false);
    expect(requestBranches(bare)).toEqual([]);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("opens one pull request with the request's block, pushed without force, and a second run returns the same one", async () => {
    const { dir, bare } = repo();
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t");
    const argv = ["request", "acme/bucket/aws", "--name", "orders", "--input", "bucket_name=orders-data", "--input", 'readers=["svc-a"]', "--requested-by", "alice", "--json"];
    const first = await run(dir, ...argv);
    expect(first.code, first.err).toBe(0);
    const r = JSON.parse(first.out).results;
    expect(r).toMatchObject({ branch: "request/bucket/orders", title: "Request: orders from bucket 1.2.0", pull_request: 7, existing: false });
    const sent = JSON.parse(forge.opened()[0]!.body!);
    expect(sent).toMatchObject({ head: "request/bucket/orders", base: "main", title: "Request: orders from bucket 1.2.0" });
    expect(sent.body).toContain("```json https://intentius.io/chant/schemas/template-request/v1/template-request.schema.json");
    expect(sent.body).toContain('"bucket_name": "orders-data"');
    expect(sent.body).toContain('"requestedBy": "alice"');

    // The branch is the default branch's tip plus one commit adding the app's root.
    expect(git(bare, "rev-parse", "request/bucket/orders^").trim()).toBe(git(bare, "rev-parse", "main").trim());
    expect(git(bare, "diff", "--name-only", "main", "request/bucket/orders").split("\n").filter(Boolean).sort()).toEqual(["apps/orders/backend.tf", "apps/orders/main.tf", "apps/orders/providers.tf", "apps/orders/versions.tf"]);
    const main = git(bare, "show", "request/bucket/orders:apps/orders/main.tf");
    expect(main).toContain('source  = "modules.test/acme/bucket/aws"');
    expect(main).toContain('version = "1.2.0"');
    expect(main).toContain('variable "app_api_key"');
    expect(git(bare, "show", "request/bucket/orders:apps/orders/backend.tf")).toContain('key    = "apps/orders/terraform.tfstate"');

    const again = await run(dir, ...argv);
    expect(again.code, again.err).toBe(0);
    expect(JSON.parse(again.out).results).toMatchObject({ pull_request: 7, existing: true });
    expect(forge.opened()).toHaveLength(1);

    // The request's line on chant/lifecycle becomes a `request` audit entry.
    const ledger = git(bare, "show", `chant/lifecycle:${REQUESTS_FILE}`).trim().split("\n");
    expect(ledger).toHaveLength(1);
    const entries = ledgerEntries("forge.test/acme/infra", REQUESTS_FILE, [{ text: ledger[0]!, commit: "c0ffee", added: true } as never]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "request", who: "alice", what: "orders", result: "opened", detail: { template: "acme/bucket/aws", version: "1.2.0", app: "orders", via: "cli", pull_request: 7 } });
  });

  it.each([
    ["not-active", ["--version", "1.1.0", "--input", "bucket_name=x"]],
    ["unsigned", ["--version", "1.0.0", "--input", "bucket_name=x"]],
    ["unknown-input", ["--input", "bucket_name=x", "--input", "colour=blue"]],
    ["missing-input", []],
    ["sensitive-input", ["--input", "bucket_name=x", "--input", "api_key=s3cret"]],
    ["input-type", ["--input", "bucket_name=x", "--input", "readers=svc-a"]],
    ["bad-name", ["--input", "bucket_name=x"], "Orders"],
  ] as const)("refuses %s with exit 1, the code in --json, and no branch pushed", async (want, flags, name: string = "orders") => {
    const { dir, bare } = repo();
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t");
    const { code, out } = await run(dir, "request", "acme/bucket/aws", "--name", name, ...flags, "--json");
    expect(code).toBe(1);
    const j = JSON.parse(out);
    expect(j.results.code).toBe(want);
    expect(j.results.refusals.map((r: { code: string }) => r.code)).toContain(want);
    expect(requestBranches(bare)).toEqual([]);
    expect(forge.opened()).toHaveLength(0);
  });

  it("refuses app-exists when the app's directory is on the default branch", async () => {
    const { dir, bare } = repo(CONFIG, { "apps/orders/main.tf": "# mine\n" });
    const forge = fakeForge();
    vi.stubGlobal("fetch", forge.fetch);
    vi.stubEnv("FORGE_TOKEN", "t");
    const { code, out } = await run(dir, "request", "acme/bucket/aws", "--name", "orders", "--input", "bucket_name=x", "--json");
    expect(code).toBe(1);
    expect(JSON.parse(out).results.code).toBe("app-exists");
    expect(requestBranches(bare)).toEqual([]);
  });

  it("takes its inputs from --inputs-file, with --input over them", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "in.json"), JSON.stringify({ bucket_name: "from-file", tags: { team: "pay" } }));
    const { code, out } = await run(dir, "request", "bucket", "--name", "orders", "--inputs-file", "in.json", "--input", "bucket_name=over", "--dry-run", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out).results.branch).toBe("request/bucket/orders");
  });
});

describe("the request audit kind", () => {
  it("is in AUDIT_KINDS and audit.schema.json alike", () => {
    const schema = JSON.parse(readFileSync(join(__dirname, "../src/report/audit.schema.json"), "utf-8"));
    expect(AUDIT_KINDS).toContain("request");
    expect(schema.properties.kind.enum).toEqual([...AUDIT_KINDS]);
  });
});

describe("the request workflow", () => {
  const golden = (name: string, text: string): void => {
    const path = join(__dirname, "golden", name);
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, "utf-8"));
  };

  it.each([
    ["github", "https://github.com/acme/infra.git", ".github/workflows/terragucci-request.yml"],
    ["forgejo", "https://forge.test/acme/infra.git", ".forgejo/workflows/terragucci-request.yml"],
  ] as const)("%s: init --dry-run with templates writes a workflow_dispatch with template, version, name and inputs", async (forge, remote, file) => {
    const dir = write(tmp(), { "terragucci.yml": `forge: ${forge}\ntemplates: {}\n`, "live/net/main.tf": 'terraform {\n  backend "s3" {}\n}\n' });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", remote);
    const { code, out } = await run(dir, "init", "--dry-run", "--binary", "tofu", "--json");
    expect(code).toBe(0);
    const f = (JSON.parse(out).results.files as { path: string; status: string; content: string }[]).find((x) => x.path === file);
    expect(f?.status).toBe("created");
    expect(f!.content).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}template:/);
    for (const k of ["template", "version", "name", "inputs"]) expect(f!.content).toContain(`      ${k}:\n`);
    expect(f!.content).toContain("terragucci request");
    golden(`request-${forge}.yml`, f!.content);
    expect(existsSync(join(dir, file))).toBe(false);
  });

  it("is not written without templates", async () => {
    const dir = write(tmp(), { "terragucci.yml": "forge: github\n", "live/net/main.tf": 'terraform {\n  backend "s3" {}\n}\n' });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const { out } = await run(dir, "init", "--dry-run", "--binary", "tofu", "--json");
    expect((JSON.parse(out).results.files as { path: string }[]).some((x) => x.path.endsWith("terragucci-request.yml"))).toBe(false);
  });
});

describe("publish carries a module's template.yml into its catalog entry", () => {
  it("puts the release's template.yml under fields.terraform.template", async () => {
    const dir = tmp("terragucci-template-");
    write(dir, {
      "modules/bucket/main.tf": 'variable "bucket_name" {\n  type = string\n}\n\nresource "terraform_data" "b" {}\n',
      "modules/bucket/.terraform-docs.yml": "formatter: markdown table\n",
      "modules/bucket/template.yml": "contract: 1\ndescription: A bucket.\ninputs:\n  - name: bucket_name\n    kind: string\n",
    });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: the bucket module");
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
    const parser = (await import("@cdktn/hcl2json")) as never;
    await publish(dir, { modules: { registry: { bucket: "s3://modules", url: "https://modules.test", namespace: "acme" } } }, { registryStore: store, parser, terraformDocs: async () => "## Inputs\n" });
    const catalog = JSON.parse(objects.get("catalog/index.json")!) as ChantReleaseCatalogDoc;
    const v = catalog.components.find((c) => c.name === "modules/bucket")!.versions[0]!;
    expect(v.fields.terraform.template).toEqual({ contract: 1, description: "A bucket.", inputs: [{ name: "bucket_name", kind: "string" }] });
  });
});
