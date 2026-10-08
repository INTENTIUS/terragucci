import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { PROJECT_CONFIG_HEADER } from "../src/init";
import { BRANCH, reconcile } from "../src/reconcile";
import { bareFrom, git, tmp, twoRootRepo, write } from "./helpers";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A forge API that records every call and answers the few terragucci makes. */
function recordingFetch(existing: Record<string, boolean> = {}): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const call: Call = { method: init.method ?? "GET", url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
    const has = Object.entries(existing).some(([k, v]) => v && url.includes(k));
    if (call.method === "GET" && /\/projects\/[^/]+$/.test(url)) return json({ default_branch: "main" });
    if (call.method === "GET" && /\/repos\/[^/]+\/[^/?]+$/.test(url)) return json({ default_branch: "main" });
    if (call.method === "GET" && url.includes("merge_requests")) return json(has ? [{ web_url: "https://gl/mr/1", iid: 1 }] : []);
    if (call.method === "GET" && url.includes("/pulls")) return json(has ? [{ html_url: "https://x/pull/1", number: 1, head: { ref: BRANCH } }] : []);
    if (call.method === "POST" && url.includes("merge_requests")) return json({ web_url: "https://gl/mr/7", iid: 7 });
    if (call.method === "POST" && url.includes("/pulls")) return json({ html_url: "https://x/pull/7", number: 7 });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  return { fetch, calls };
}

function controlRepo(): { config: ReturnType<typeof validateConfig>; bares: Record<string, string> } {
  const bares = {
    github: bareFrom(twoRootRepo()),
    gitlab: bareFrom(twoRootRepo()),
    forgejo: bareFrom(twoRootRepo()),
  };
  const config = validateConfig(
    {
      defaults: { binary: "tofu" },
      projects: {
        "github.com/acme/infra": { url: bares.github },
        "gitlab.example.com/platform/network": { url: bares.gitlab },
        "codeberg.org/acme/edge": { url: bares.forgejo },
      },
    },
    "t",
  );
  return { config, bares };
}

const env = { GITHUB_TOKEN: "gh", GITLAB_TOKEN: "gl", FORGEJO_TOKEN: "fj" };

describe("reconcile", () => {
  it("a dry run says what each project's pipeline would become and writes nothing", async () => {
    const { config, bares } = controlRepo();
    const { fetch, calls } = recordingFetch();
    const out = await reconcile(config, { mode: "dry-run", fetch, env: {} });
    expect(out.map((o) => [o.key, o.status, o.changes.map((c) => c.path)])).toEqual([
      ["github.com/acme/infra", "would-change", [".github/workflows/terragucci.yml"]],
      ["gitlab.example.com/platform/network", "would-change", [".gitlab/terragucci.yml", ".gitlab-ci.yml"]],
      ["codeberg.org/acme/edge", "would-change", [".forgejo/workflows/terragucci.yml"]],
    ]);
    expect(calls).toEqual([]);
    expect(() => git(bares.github, "rev-parse", "--verify", BRANCH)).toThrow();
  });

  it("apply pushes a branch to each project and opens one pull or merge request per project", async () => {
    const { config, bares } = controlRepo();
    const { fetch, calls } = recordingFetch();
    const out = await reconcile(config, { mode: "apply", fetch, env });
    expect(out.map((o) => [o.status, o.pullRequest])).toEqual([
      ["pull-request", "https://x/pull/7"],
      ["pull-request", "https://gl/mr/7"],
      ["pull-request", "https://x/pull/7"],
    ]);
    for (const bare of Object.values(bares)) {
      expect(git(bare, "rev-parse", "--verify", BRANCH).trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(git(bare, "rev-parse", "main")).not.toBe(git(bare, "rev-parse", BRANCH));
    }
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [c.url, (c.body as Record<string, string>).head ?? (c.body as Record<string, string>).source_branch])).toEqual([
      ["https://api.github.com/repos/acme/infra/pulls", BRANCH],
      ["https://gitlab.example.com/api/v4/projects/platform%2Fnetwork/merge_requests", BRANCH],
      ["https://codeberg.org/api/v1/repos/acme/edge/pulls", BRANCH],
    ]);
    expect(posts.map((c) => c.headers.authorization ?? c.headers["private-token"])).toEqual(["Bearer gh", "gl", "token fj"]);
  });

  it("an open pull request from the branch is reused, not duplicated", async () => {
    const { config } = controlRepo();
    const { fetch, calls } = recordingFetch({ "acme/infra": true, "platform%2Fnetwork": true, "acme/edge": true });
    const out = await reconcile(config, { mode: "apply", fetch, env });
    expect(out.every((o) => o.status === "pull-request")).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a project already in line is unchanged, and makes no API call", async () => {
    const { config } = controlRepo();
    const first = recordingFetch();
    await reconcile(config, { mode: "apply", fetch: first.fetch, env, project: "github.com/acme/infra" });
    // Merge the branch, as a reviewer would, then reconcile again.
    const bare = config.projects!["github.com/acme/infra"].url!;
    git(bare, "update-ref", "refs/heads/main", `refs/heads/${BRANCH}`);
    const second = recordingFetch();
    const out = await reconcile(config, { mode: "apply", fetch: second.fetch, env, project: "github.com/acme/infra" });
    expect(out[0].status).toBe("unchanged");
    expect(second.calls).toEqual([]);
  });

  it("a GitLab project's own .gitlab-ci.yml gains the include and keeps its jobs, and once merged is in line", async () => {
    const own = "unit-tests:\n  script:\n    - echo own\n";
    const bare = bareFrom(write(twoRootRepo(), { ".gitlab-ci.yml": own }));
    const config = validateConfig({ defaults: { binary: "tofu" }, projects: { "gitlab.example.com/platform/network": { url: bare } } }, "t");
    const out = await reconcile(config, { mode: "apply", fetch: recordingFetch().fetch, env });
    expect(out[0].changes.map((c) => [c.path, c.status])).toEqual([[".gitlab/terragucci.yml", "created"], [".gitlab-ci.yml", "updated"]]);
    expect(git(bare, "show", `${BRANCH}:.gitlab-ci.yml`)).toBe(`include:\n  - local: .gitlab/terragucci.yml\n\n${own}`);
    git(bare, "update-ref", "refs/heads/main", `refs/heads/${BRANCH}`);
    const again = recordingFetch();
    expect((await reconcile(config, { mode: "apply", fetch: again.fetch, env }))[0].status).toBe("unchanged");
    expect(again.calls).toEqual([]);
  });

  it("a GitLab project whose own stages leave out terragucci's fails alone, and says what to add", async () => {
    const bare = bareFrom(write(twoRootRepo(), { ".gitlab-ci.yml": "stages: [lint]\nlint:\n  stage: lint\n  script: [echo]\n" }));
    const config = validateConfig({ defaults: { binary: "tofu" }, projects: { "gitlab.example.com/platform/network": { url: bare } } }, "t");
    const out = await reconcile(config, { mode: "dry-run", fetch: recordingFetch().fetch, env: {} });
    expect(out[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/lists its own stages.*add check, plan, apply, tips to them, in that order/) });
  });

  it("one project failing does not stop the others", async () => {
    const { config } = controlRepo();
    config.projects!["github.com/acme/infra"].url = "/nonexistent/repo.git";
    const { fetch } = recordingFetch();
    const out = await reconcile(config, { mode: "apply", fetch, env });
    expect(out.map((o) => o.status)).toEqual(["failed", "pull-request", "pull-request"]);
  });

  it("apply without the forge token fails that project and names the variable", async () => {
    const { config } = controlRepo();
    const { fetch } = recordingFetch();
    const out = await reconcile(config, { mode: "apply", fetch, env: { GITHUB_TOKEN: "gh" } });
    expect(out[1]).toMatchObject({ status: "failed", error: expect.stringMatching(/GITLAB_TOKEN is not set/) });
  });

  it("writes the control repo's policy key into each project's terragucci.yml, where its jobs read it at the base", async () => {
    const source = "git+https://git.example.com/acme/policy.git@v1";
    const own = twoRootRepo();
    write(own, { "terragucci.yml": "binary: tofu\n" });
    const config = validateConfig(
      {
        defaults: { binary: "tofu", policy: { source, engine: "opa" } },
        projects: { "github.com/acme/infra": { url: bareFrom(twoRootRepo()) }, "github.com/acme/own": { url: bareFrom(own) } },
      },
      "t",
    );
    const out = await reconcile(config, { mode: "dry-run", fetch: recordingFetch().fetch, env: {} });
    const file = out[0].changes.find((c) => c.path === "terragucci.yml");
    expect(file?.status).toBe("created");
    expect(file?.content).toBe(`${PROJECT_CONFIG_HEADER}\npolicy:\n  source: ${source}\n  engine: opa\n`);
    expect(validateConfig((await import("@intentius/chant/yaml")).parseYAML(file!.content), "t").policy).toEqual({ source, engine: "opa" });
    // A terragucci.yml the project wrote itself is never overwritten: the project fails and says what to set.
    expect(out[1]).toMatchObject({ status: "failed", error: expect.stringMatching(/terragucci.yml exists and terragucci did not write it.*policy/) });
  });

  it("writes the control repo's reports key into each project's terragucci.yml, where its apply waves read it", async () => {
    const own = twoRootRepo();
    write(own, { "terragucci.yml": "binary: tofu\nreports:\n  bucket: s3://acme-reports\n  prefix: own\n" });
    const other = twoRootRepo();
    write(other, { "terragucci.yml": "binary: tofu\n" });
    const config = validateConfig(
      {
        defaults: { binary: "tofu", reports: { bucket: "s3://acme-reports" } },
        projects: {
          "github.com/acme/infra": { url: bareFrom(twoRootRepo()), reports: { bucket: "s3://acme-reports", prefix: "infra" } },
          "github.com/acme/own": { url: bareFrom(own), reports: { bucket: "s3://acme-reports", prefix: "own" } },
          "github.com/acme/other": { url: bareFrom(other) },
        },
      },
      "t",
    );
    const out = await reconcile(config, { mode: "dry-run", fetch: recordingFetch().fetch, env: {} });
    const file = out[0].changes.find((c) => c.path === "terragucci.yml");
    expect(file?.status).toBe("created");
    expect(validateConfig((await import("@intentius/chant/yaml")).parseYAML(file!.content), "t").reports).toEqual({ bucket: "s3://acme-reports", prefix: "infra" });
    expect(file!.content.startsWith(PROJECT_CONFIG_HEADER)).toBe(true);
    // A project's own terragucci.yml that already names the same reports is left alone.
    expect(out[1].status).not.toBe("failed");
    expect(out[1].changes.map((c) => c.path)).not.toContain("terragucci.yml");
    // One that names none fails and says what to set.
    expect(out[2]).toMatchObject({ status: "failed", error: expect.stringMatching(/jobs read reports from it; set its reports key to the control repo's/) });
  });

  it("writes policy and reports together into a project's terragucci.yml", async () => {
    const config = validateConfig(
      { defaults: { binary: "tofu", policy: { path: "policy" }, reports: { bucket: "s3://acme-reports" } }, projects: { "github.com/acme/infra": { url: bareFrom(twoRootRepo()) } } },
      "t",
    );
    const out = await reconcile(config, { mode: "dry-run", fetch: recordingFetch().fetch, env: {} });
    const file = out[0].changes.find((c) => c.path === "terragucci.yml");
    expect(validateConfig((await import("@intentius/chant/yaml")).parseYAML(file!.content), "t")).toMatchObject({ policy: { path: "policy" }, reports: { bucket: "s3://acme-reports" } });
  });

  it("writes no terragucci.yml into a project when the control repo sets no policy and no reports", async () => {
    const { config } = controlRepo();
    const out = await reconcile(config, { mode: "dry-run", fetch: recordingFetch().fetch, env: {} });
    expect(out.flatMap((o) => o.changes.map((c) => c.path))).not.toContain("terragucci.yml");
  });

  it("refuses a config with no projects", async () => {
    await expect(reconcile({}, { mode: "dry-run" })).rejects.toThrow(/control repo config with projects/);
  });
});

describe("tmp", () => {
  it("is writable", () => {
    expect(tmp()).toMatch(/terragucci-test-/);
  });
});
