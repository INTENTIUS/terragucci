import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { describePublish, publish } from "../src/publish";
import { gzip, moduleTar } from "../src/publish/archive";
import { hcpPlace } from "../src/publish/hosted";
import { git, tmp, write } from "./helpers";


function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function repoWithModule(): string {
  const dir = tmp("terragucci-hcp-");
  write(dir, { "modules/net/main.tf": 'resource "terraform_data" "a" {}\n' });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: net");
  return dir;
}

const TOKEN = "hcp-terragucci-test-token.atlasv1.0123456789";
const settings = { modules: { publish: "hcp://acme" } };

/** The lexicon's HCP fake: every call stays in the process, and no HCP account is used. */
async function fakeHcp(o: { manageModules?: boolean; entitled?: boolean } = {}) {
  const { createFakeHcp } = (await import("@intentius/chant-lexicon-terraform/registry/targets/fake-hcp")) as {
    createFakeHcp(o: { organization: string; tokens: Record<string, { manageModules: boolean }>; entitled?: boolean }): {
      fetch: (url: string, init?: unknown) => Promise<Response>;
      requests: { method: string; url: string; headers: Record<string, string> }[];
      modules: Map<string, Map<string, unknown>>;
      seed(name: string, provider: string, version?: { version: string; archive: Uint8Array; status?: string }): void;
      throttle(n: number, retryAfter?: string): void;
    };
  };
  return createFakeHcp({ organization: "acme", tokens: { [TOKEN]: { manageModules: o.manageModules ?? true } }, ...(o.entitled === false ? { entitled: false } : {}) });
}

const noWait = { sleep: async () => {}, now: (() => {
  let t = 0;
  return () => (t += 1000);
})() };

describe("modules.publish: hcp://<org> (terragucci#1301)", () => {
  it("creates the module and the version, uploads the archive, and is unchanged on a rerun", async () => {
    const repo = repoWithModule();
    const hcp = await fakeHcp();
    const opts = { env: { TFE_TOKEN: TOKEN }, hostedFetch: hcp.fetch as never, ...noWait };
    const first = await publish(repo, settings, opts);
    expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    expect(describePublish(first)).toContain("net 0.1.0: published to hcp://acme");
    expect(describePublish(first)).not.toContain(TOKEN);
    const calls = hcp.requests.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`);
    expect(calls).toContain("POST app.terraform.io/api/v2/organizations/acme/registry-modules");
    expect(calls).toContain("POST app.terraform.io/api/v2/organizations/acme/registry-modules/private/acme/net/generic/versions");
    const upload = hcp.requests.find((r) => r.method === "PUT")!;
    expect(new URL(upload.url).host).toBe("archivist.terraform.io");
    expect(upload.headers.authorization).toBeUndefined();
    expect(git(repo, "show", "chant/lifecycle:modules/releases.jsonl")).toContain('"releaseVersion":"0.1.0"');

    const puts = hcp.requests.filter((r) => r.method === "PUT").length;
    expect((await publish(repo, settings, opts)).map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:unchanged"]);
    expect(hcp.requests.filter((r) => r.method === "PUT").length).toBe(puts);
  });

  it("refuses a hand-uploaded version when neither the ledger nor HCP names its commit", async () => {
    const repo = repoWithModule();
    const hcp = await fakeHcp();
    hcp.seed("net", "generic", { version: "0.1.0", archive: gzip(moduleTar(`${repo}/modules/net`)) });
    // The fake keeps no commit-sha for a seeded version, so with no record and no tag publish stops and says why.
    await expect(publish(repo, settings, { env: { TFE_TOKEN: TOKEN }, hostedFetch: hcp.fetch as never, ...noWait })).rejects.toThrow("the ledger has no release record of it");
  });

  it("names the two causes of a 404, and retries a 429", async () => {
    const repo = repoWithModule();
    const denied = await fakeHcp({ manageModules: false });
    await expect(publish(repo, settings, { env: { TFE_TOKEN: TOKEN }, hostedFetch: denied.fetch as never, ...noWait })).rejects.toThrow("Manage modules");
    const busy = await fakeHcp();
    busy.throttle(2, "0");
    const rows = await publish(repoWithModule(), settings, { env: { TFE_TOKEN: TOKEN }, hostedFetch: busy.fetch as never, ...noWait });
    expect(rows.map((r) => r.status)).toEqual(["published"]);
  });

  it("writes nothing on a dry run", async () => {
    const repo = repoWithModule();
    const hcp = await fakeHcp();
    await publish(repo, settings, { dryRun: true, env: { TFE_TOKEN: TOKEN }, hostedFetch: hcp.fetch as never, ...noWait });
    expect(hcp.requests.some((r) => r.method !== "GET")).toBe(false);
  });
});

describe("modules.publish: hcp:// in the config", () => {
  const problems = (publish: unknown): string => {
    try {
      validateConfig({ modules: { publish } }, "t");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("takes hcp://<org> and hcp://<host>/<org>, and words the fix for anything else", () => {
    expect(problems("hcp://acme")).toBe("");
    expect(problems(["git-tags", "hcp://tfe.example.com/acme"])).toBe("");
    expect(problems("hcp://acme/modules")).toContain("hcp://<organization> or hcp://<host>/<organization>");
    expect(problems("hcp://")).toContain("hcp://<organization>");
  });

  it("reads the host and organization", () => {
    expect(hcpPlace("hcp://acme")).toEqual({ host: "app.terraform.io", organization: "acme" });
    expect(hcpPlace("hcp://TFE.example.com/acme")).toEqual({ host: "tfe.example.com", organization: "acme" });
    expect(() => hcpPlace("hcp://a/b/c")).toThrow("hcp://<host>/<organization>");
  });
});
