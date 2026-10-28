import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { chantModuleTargets, chantNextParts } from "../src/chant-next";
import { publish } from "../src/publish";
import { repositoryPlace } from "../src/publish/hosted";
import { proxyUpstream, sourceAllowed } from "../src/sources";
import { git, tmp, write } from "./helpers";

const parts = await chantNextParts();
const lib = await chantModuleTargets();
const withRepositories = typeof lib?.artifactoryModuleTarget === "function" && typeof lib?.nexusModuleTarget === "function";

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function repoWithModule(): string {
  const dir = tmp("terragucci-repository-");
  write(dir, { "modules/net/main.tf": 'resource "terraform_data" "a" {}\n' });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: net");
  return dir;
}

const problems = (raw: unknown): string => {
  try {
    validateConfig(raw, "t");
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

const noWait = { sleep: async () => {}, now: (() => {
  let t = 0;
  return () => (t += 1000);
})() };

describe("artifactory:// and nexus:// in modules.publish (terragucci#1302)", () => {
  it("takes a host, a repository and an optional namespace, and words the fix for anything else", () => {
    expect(problems({ modules: { publish: "artifactory://acme.jfrog.io/terraform-local" } })).toBe("");
    expect(problems({ modules: { publish: ["git-tags", "nexus://nexus.example.com/terraform-hosted/platform"] } })).toBe("");
    expect(problems({ modules: { publish: "artifactory://acme.jfrog.io" } })).toContain("artifactory://<host>/<repository>[/<namespace>] or nexus://<host>/<repository>[/<namespace>]");
    expect(repositoryPlace("nexus://Nexus.example.com/terraform-hosted/platform")).toEqual({ kind: "nexus", host: "nexus.example.com", repo: "terraform-hosted", namespace: "platform" });
    expect(repositoryPlace("artifactory://acme.jfrog.io/terraform-local")).toEqual({ kind: "artifactory", host: "acme.jfrog.io", repo: "terraform-local" });
  });
});

describe.skipIf(!withRepositories)("publishing to Artifactory and Nexus over the lexicon's fakes", () => {
  it("deploys the zip to Artifactory under <repo>__<namespace>, and is unchanged on a rerun", async () => {
    // @ts-ignore chant 0.124.54 has no registry/targets/fake-artifactory (chant#4605)
    const { createFakeArtifactory } = (await import("@intentius/chant-lexicon-terraform/registry/targets/fake-artifactory")) as {
      createFakeArtifactory(o: { host: string; repos: string[]; users: Record<string, string> }): { fetch: (url: string, init?: unknown) => Promise<Response>; requests: { method: string; url: string; headers: Record<string, string> }[] };
    };
    const af = createFakeArtifactory({ host: "acme.jfrog.io", repos: ["terraform-local"], users: { ci: "af-token-0123456789" } });
    const repo = repoWithModule();
    const settings = { modules: { publish: "artifactory://acme.jfrog.io/terraform-local/acme" } };
    const opts = { env: { JFROG_USER: "ci", JFROG_ACCESS_TOKEN: "af-token-0123456789" }, hostedFetch: af.fetch as never, ...noWait };
    const first = await publish(repo, settings, opts);
    expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    const put = af.requests.find((r) => r.method === "PUT")!;
    expect(new URL(put.url).pathname).toBe("/artifactory/terraform-local/acme/net/generic/0.1.0.zip");
    expect(JSON.stringify(first)).not.toContain("af-token-0123456789");
    expect((await publish(repo, settings, opts)).map((r) => r.status)).toEqual(["unchanged"]);
  });

  it("uploads to a Nexus hosted repository and reads it back through the in-memory host block", async () => {
    // @ts-ignore chant 0.124.54 has no registry/targets/fake-nexus (chant#4605)
    const { createFakeNexus } = (await import("@intentius/chant-lexicon-terraform/registry/targets/fake-nexus")) as {
      createFakeNexus(o: { host: string; repos: string[]; users: Record<string, string> }): { fetch: (url: string, init?: unknown) => Promise<Response>; requests: { method: string; url: string }[] };
    };
    const nx = createFakeNexus({ host: "nexus.example.com", repos: ["terraform-hosted"], users: { ci: "nx-pass-0123456789" } });
    const repo = repoWithModule();
    const rows = await publish(repo, { modules: { publish: "nexus://nexus.example.com/terraform-hosted/platform" } }, { env: { NEXUS_USER: "ci", NEXUS_TOKEN: "nx-pass-0123456789" }, hostedFetch: nx.fetch as never, ...noWait });
    expect(rows.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    expect(nx.requests.some((r) => r.method === "PUT" && new URL(r.url).pathname === "/repository/terraform-hosted/v1/modules/platform/net/generic/0.1.0/net-0.1.0.zip")).toBe(true);
  });

  it("refuses a target with no namespace when there is no modules.registry to take one from", async () => {
    const repo = repoWithModule();
    await expect(publish(repo, { modules: { publish: "nexus://nexus.example.com/terraform-hosted" } }, { env: {}, ...noWait })).rejects.toThrow("names no namespace");
  });
});

describe("sources.proxies (terragucci#1302)", () => {
  it("takes Artifactory and Nexus entries with a repo, and refuses one that names both or neither", () => {
    expect(problems({ sources: { modules: ["registry.terraform.io/terraform-aws-modules/*/*"], proxies: [{ artifactory: "acme.jfrog.io", repo: "tf-remote" }, { nexus: "https://nexus.example.com", repo: "terraform-proxy", host: "tfproxy" }] } })).toBe("");
    expect(problems({ sources: { proxies: [{ repo: "tf-remote" }] } })).toContain("set artifactory: <host> or nexus: <https url>");
    expect(problems({ sources: { proxies: [{ artifactory: "acme.jfrog.io", nexus: "https://n.example.com", repo: "x" }] } })).toContain("names one proxy");
    expect(problems({ sources: { proxies: [{ artifactory: "acme.jfrog.io", repo: "x", host: "label" }] } })).toContain("it needs nexus");
  });

  it.skipIf(!parts.registryProxies)("matches a source written through a proxy as its upstream", async () => {
    const through = await proxyUpstream([{ artifactory: "acme.jfrog.io", repo: "tf-remote" }]);
    const list = ["registry.terraform.io/terraform-aws-modules/*/*"];
    expect(sourceAllowed("module", "acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws", list, through)).toBe(true);
    expect(sourceAllowed("module", "acme.jfrog.io/tf-remote__other/vpc/aws", list, through)).toBe(false);
    expect(sourceAllowed("module", "acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws", list)).toBe(false);
    expect(sourceAllowed("provider", "acme.jfrog.io/tf-remote__hashicorp/aws", ["hashicorp/*"], through)).toBe(true);
  });
});
