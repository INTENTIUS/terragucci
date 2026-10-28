import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { chantNextParts } from "../src/chant-next";
import { describePublish, publish } from "../src/publish";
import { gzip, moduleTar } from "../src/publish/archive";
import { gitlabPlace } from "../src/publish/hosted";
import { git, tmp, write } from "./helpers";

const parts = await chantNextParts();

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function repoWithModule(): string {
  const dir = tmp("terragucci-gitlab-");
  write(dir, { "modules/net/main.tf": 'resource "terraform_data" "a" {}\n' });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: net");
  return dir;
}

const TOKEN = "glpat-terragucci-test-token";
const TARGET = "gitlab://gitlab.test/platform/modules";
const settings = { modules: { publish: TARGET } };

/** The lexicon's GitLab fake: every call stays in the process. */
async function fakeGitlab() {
  // @ts-ignore chant 0.124.54 has no registry/targets/fake-gitlab (chant#4603)
  const { createFakeGitlab } = (await import("@intentius/chant-lexicon-terraform/registry/targets/fake-gitlab")) as {
    createFakeGitlab(o: { host: string; projects: Record<string, string>; tokens: Record<string, string[]> }): {
      fetch: (url: string, init?: unknown) => Promise<Response>;
      requests: { method: string; url: string; headers: Record<string, string> }[];
      modules: Map<string, { archive: Uint8Array }>;
      seed(project: string, name: string, system: string, version: string, archive: Uint8Array): void;
    };
  };
  return createFakeGitlab({ host: "gitlab.test", projects: { "7": "platform/modules" }, tokens: { [TOKEN]: ["7"] } });
}

describe.skipIf(!parts.moduleTargets)("modules.publish: gitlab (terragucci#1300)", () => {
  it("uploads a new version, reads it back, records it, and is unchanged on a rerun", async () => {
    const repo = repoWithModule();
    const gl = await fakeGitlab();
    const opts = { env: { GITLAB_TOKEN: TOKEN }, hostedFetch: gl.fetch as never };
    const first = await publish(repo, settings, opts);
    expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    expect(describePublish(first)).toContain(`net 0.1.0: published to ${TARGET}`);
    expect(describePublish(first)).not.toContain(TOKEN);
    const put = gl.requests.find((r) => r.method === "PUT")!;
    expect(put.url).toBe("https://gitlab.test/api/v4/projects/platform%2Fmodules/packages/terraform/modules/net/generic/0.1.0/file");
    expect(put.headers["private-token"]).toBe(TOKEN);
    expect(Buffer.from(gl.modules.get("platform/net/generic/0.1.0")!.archive).equals(gzip(moduleTar(`${repo}/modules/net`)))).toBe(true);
    expect(git(repo, "show", "chant/lifecycle:modules/releases.jsonl")).toContain('"releaseVersion":"0.1.0"');

    const puts = gl.requests.filter((r) => r.method === "PUT").length;
    const again = await publish(repo, settings, opts);
    expect(again.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:unchanged"]);
    expect(gl.requests.filter((r) => r.method === "PUT").length).toBe(puts);

    write(repo, { "modules/net/outputs.tf": 'output "id" {\n  value = terraform_data.a.id\n}\n' });
    commit(repo, "feat(net): an id output");
    expect((await publish(repo, settings, opts)).map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.2.0:published"]);
  });

  it("refuses a version GitLab holds with no release record, when no git tag names its commit", async () => {
    const repo = repoWithModule();
    const gl = await fakeGitlab();
    gl.seed("7", "net", "generic", "0.1.0", gzip(Buffer.from("other content")));
    // A hand upload with no record and no git-tags: publish cannot tell what changed since, and says so.
    await expect(publish(repo, settings, { env: { GITLAB_TOKEN: TOKEN }, hostedFetch: gl.fetch as never })).rejects.toThrow("the ledger has no release record of it");
  });

  it("writes nothing on a dry run", async () => {
    const repo = repoWithModule();
    const gl = await fakeGitlab();
    const rows = await publish(repo, settings, { dryRun: true, env: { GITLAB_TOKEN: TOKEN }, hostedFetch: gl.fetch as never });
    expect(rows.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["net@0.1.0:published"]);
    expect(rows[0].detail).toContain("dry run");
    expect(gl.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle")).toThrow();
  });

  it("names the variable of a refused token, never its value", async () => {
    const repo = repoWithModule();
    const gl = await fakeGitlab();
    // Reads go with the CLI token for the host; the upload goes with GITLAB_TOKEN, which GitLab refuses.
    const err = await publish(repo, settings, { env: { GITLAB_TOKEN: "glpat-not-a-known-token", TF_TOKEN_gitlab_test: TOKEN }, hostedFetch: gl.fetch as never }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/GITLAB_TOKEN/);
    expect(err?.message).not.toContain("glpat-not-a-known-token");
  });
});

describe("modules.publish: gitlab in the config", () => {
  const problems = (publish: unknown): string => {
    try {
      validateConfig({ modules: { publish } }, "t");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("takes gitlab and gitlab://<host>/<group>/<project>, and words the fix for anything else", () => {
    expect(problems("gitlab")).toBe("");
    expect(problems(["git-tags", "gitlab://gitlab.example.com/platform/modules"])).toBe("");
    expect(problems("gitlab://gitlab.example.com/platform/infra/modules")).toBe("");
    expect(problems("gitlab://gitlab.example.com/modules")).toContain("use an oci:// registry address, git-tags, gitlab (in GitLab CI), gitlab://<host>/<group>/<project>, hcp://<organization> or hcp://<host>/<organization>");
    expect(problems("gitlab:platform/modules")).toContain("gitlab://<host>/<group>/<project>");
  });

  it("reads the project from GitLab CI for gitlab, and from the address otherwise", () => {
    expect(gitlabPlace("gitlab", { CI_PROJECT_ID: "7", CI_PROJECT_ROOT_NAMESPACE: "platform", CI_API_V4_URL: "https://gitlab.example.com/api/v4" })).toEqual({ project: "7", namespace: "platform", host: "gitlab.example.com" });
    expect(() => gitlabPlace("gitlab", {})).toThrow("this is not a GitLab CI job");
    expect(gitlabPlace("gitlab://GitLab.example.com/platform/infra/modules", {})).toEqual({ api: "https://gitlab.example.com/api/v4", project: "platform/infra/modules", namespace: "platform", host: "gitlab.example.com" });
  });
});
