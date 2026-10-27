// The registry edge preset (terragucci#1287): the _headers file publish writes for a Pages site, and the
// files `terragucci registry edge` writes for a Cloudflare Worker or Lambda@Edge. chant's lexicon is stood
// in for, so these run on any chant; the real binaries against the real function are in registry-cli-e2e.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistrySettings } from "../src/config";
import { overrideChantNext, type ChantRegistry } from "../src/chant-next";
import { publish } from "../src/publish";
import { bucketOrigin, describeEdge, LAMBDA_BUNDLE, planEdge, TOKENS_VARIABLE, WORKER_BUNDLE } from "../src/publish/edge";
import { dirStore, HEADERS_FILE } from "../src/publish/registry";
import { git, tmp, write } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** The lexicon's /registry with only headersFile, so publish's own copies write the rest. */
function headersOnly(limit = 100): void {
  const stub: Partial<ChantRegistry> = {
    headersFile: (rules, existing) => {
      const held = (existing ?? "").split("\n\n").filter((b) => b.trim());
      const lines = rules.map((r) => `${r.path}\n  X-Terraform-Get: ${r.location}`);
      return `${[...held.map((b) => b.trim()), ...lines].join("\n\n")}\n`;
    },
    PAGES_HEADER_RULES: limit,
  };
  // chantRegistry() hands the stub out; with no writeVersion in it, publish writes the version with its own copy.
  restores.push(overrideChantNext("registry", stub));
}

function repo(): string {
  const dir = tmp("terragucci-edge-");
  write(dir, { "modules/net/main.tf": 'resource "terraform_data" "a" {}\n' });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: net");
  return dir;
}

const PAGES: RegistrySettings = { dir: "public", url: "https://modules.test", namespace: "acme" };

describe("edge: pages", () => {
  it("writes a _headers rule for each version's download, keeping the rules already there", async () => {
    headersOnly();
    const r = repo();
    const site = tmp("terragucci-edge-site-");
    write(site, { [HEADERS_FILE]: "/*\n  X-Frame-Options: DENY\n" });
    await publish(r, { modules: { registry: PAGES } }, { registryStore: dirStore(site) });
    const text = readFileSync(join(site, HEADERS_FILE), "utf-8");
    expect(text).toContain("X-Frame-Options: DENY");
    expect(text).toContain("/v1/modules/acme/net/generic/0.1.0/download\n  X-Terraform-Get: https://modules.test/v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz");
  });

  it("says so on the row when the rules pass what Cloudflare Pages reads", async () => {
    headersOnly(0);
    const rows = await publish(repo(), { modules: { registry: PAGES } }, { registryStore: dirStore(tmp("terragucci-edge-site-")) });
    expect(rows.find((x) => x.status === "published")?.detail).toContain("Cloudflare Pages reads only 0");
  });

  it("leaves _headers out, and says so, on a chant without the writer", async () => {
    restores.push(overrideChantNext("registry", null));
    const site = tmp("terragucci-edge-site-");
    const rows = await publish(repo(), { modules: { registry: PAGES } }, { registryStore: dirStore(site) });
    expect(rows.find((x) => x.status === "published")?.detail).toContain("_headers not written");
  });

  it("writes no _headers for a bucket", async () => {
    headersOnly();
    const site = tmp("terragucci-edge-bucket-");
    await publish(repo(), { modules: { registry: { ...PAGES, dir: undefined, bucket: "s3://modules" } } }, { registryStore: dirStore(site) });
    expect(() => readFileSync(join(site, HEADERS_FILE))).toThrow();
  });
});

describe("terragucci registry edge", () => {
  const bundles = () => write(tmp("terragucci-edge-dist-"), { [WORKER_BUNDLE]: "export default {};\n", [LAMBDA_BUNDLE]: "export const handler = 1;\n" });
  const S3: RegistrySettings = { bucket: "s3://acme-modules", url: "https://modules.example.com", namespace: "acme" };

  it("derives the bucket's address from bucket and endpoint", () => {
    expect(bucketOrigin(S3)).toBe("https://acme-modules.s3.amazonaws.com");
    expect(bucketOrigin({ bucket: "s3://m", endpoint: "https://s3.local:9000/" })).toBe("https://s3.local:9000/m");
    expect(bucketOrigin({ bucket: "gs://m" })).toBe("https://storage.googleapis.com/m");
    expect(bucketOrigin({ bucket: "az://acct/mods" })).toBe("https://acct.blob.core.windows.net/mods");
  });

  it("writes a Worker with an R2 binding, auth off by default", () => {
    const plan = planEdge({ ...S3, endpoint: "https://acct.r2.cloudflarestorage.com", prefix: "/registry/" }, { bundleDir: bundles() });
    expect(plan.edge).toBe("cloudflare");
    const toml = String(plan.files.find((f) => f.path === "wrangler.toml")!.content);
    expect(toml).toContain('REGISTRY_AUTH = "off"');
    expect(toml).toContain('REGISTRY_PREFIX = "registry"');
    expect(toml).toContain('binding = "REGISTRY_BUCKET"\nbucket_name = "acme-modules"');
    expect(toml).toContain('pattern = "modules.example.com"');
    expect(toml).not.toContain("REGISTRY_ORIGIN");
    expect(String(plan.files.find((f) => f.path === "worker.mjs")!.content)).toBe("export default {};\n");
  });

  it("with auth: token, prints how to make, store and rotate the Worker's token", () => {
    const plan = planEdge({ ...S3, bucket: "gs://m", auth: "token" }, { bundleDir: bundles() });
    expect(String(plan.files[1]!.content)).toContain('REGISTRY_AUTH = "token"');
    expect(String(plan.files[1]!.content)).toContain('REGISTRY_ORIGIN = "https://storage.googleapis.com/m"');
    const text = describeEdge(plan, "registry-edge");
    expect(text).toContain("npx wrangler secret put REGISTRY_TOKENS");
    expect(text).toContain("TF_TOKEN_modules_example_com");
    expect(text).toContain("to rotate");
  });

  it("writes Lambda@Edge's options with the tokens from the environment, and refuses auth without them", () => {
    const dir = bundles();
    const off = planEdge(S3, { bundleDir: dir });
    expect(JSON.parse(String(off.files.find((f) => f.path === "registry-edge.json")!.content))).toEqual({ origin: "https://acme-modules.s3.amazonaws.com" });
    const on = planEdge({ ...S3, auth: "token" }, { bundleDir: dir, env: { [TOKENS_VARIABLE]: "old, new" } });
    expect(JSON.parse(String(on.files.find((f) => f.path === "registry-edge.json")!.content)).auth).toEqual({ tokens: ["old", "new"] });
    expect(() => planEdge({ ...S3, auth: "token" }, { bundleDir: dir, env: {} })).toThrow(TOKENS_VARIABLE);
  });

  it("writes nothing for pages and none, and says when the build carries no function", () => {
    expect(planEdge(PAGES).files).toEqual([]);
    expect(planEdge({ ...S3, edge: "none" }).steps.join("\n")).toContain("Terraform does not");
    expect(() => planEdge(S3, { bundleDir: tmp("terragucci-edge-empty-") })).toThrow("carries no registry edge function");
  });
});
