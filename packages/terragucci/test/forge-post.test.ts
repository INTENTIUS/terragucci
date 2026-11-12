import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetch } from "../src/forge";
import { forgePost, staleNote, statusSent } from "../src/forge-post";

const SHA = "a".repeat(40);
const GH = { TG_TOKEN: "t", TG_SHA: SHA, TG_PR: "7", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://api", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "5" };
const GL = { TG_TOKEN: "t", TG_SHA: SHA, TG_PR: "3", CI_API_V4_URL: "http://gl/api/v4", CI_PROJECT_ID: "9", CI_SERVER_URL: "http://gl", CI_PIPELINE_URL: "http://gl/p/1", CI_COMMIT_SHA: SHA, CI_PIPELINE_ID: "61" };

/** A forge that records each call and answers from `answer`. */
function forge(answer: (method: string, url: string) => unknown = () => ({})) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const v = answer(method, url);
    return { ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) };
  };
  return { calls, fetch };
}

describe("terragucci post", () => {
  it("posts a status on the head through chant's client, linked to the run", async () => {
    const f = forge();
    expect(await forgePost("status", ["terragucci/apply", "success", "2 roots applied"], { forge: "github", env: GH, fetch: f.fetch })).toBeUndefined();
    expect(f.calls).toEqual([{ method: "POST", url: `http://api/repos/o/r/statuses/${SHA}`, body: { context: "terragucci/apply", state: "success", description: "2 roots applied", target_url: "http://forge/o/r/actions/runs/5" } }]);
    // GitHub has no running state: a status still going is pending there.
    await forgePost("status", ["terragucci/apply", "pending", "applying"], { forge: "github", env: GH, fetch: f.fetch });
    expect(f.calls[1].body.state).toBe("pending");
  });

  it("on GitLab names the job's pipeline, and a status still going is running", async () => {
    const f = forge();
    await forgePost("status", ["terragucci/plan", "failure", "1 failed"], { forge: "gitlab", env: GL, fetch: f.fetch });
    await forgePost("status", ["terragucci/plan", "pending", "planning"], { forge: "gitlab", env: GL, fetch: f.fetch });
    expect(f.calls.map((c) => c.body)).toEqual([
      { name: "terragucci/plan", state: "failed", description: "1 failed", target_url: "http://gl/p/1", pipeline_id: 61 },
      { name: "terragucci/plan", state: "running", description: "planning", target_url: "http://gl/p/1", pipeline_id: 61 },
    ]);
  });

  it("replies with a new comment, and posts no plan note: chant's note job does (terragucci issue 1411)", async () => {
    const f = forge(() => ({}));
    await forgePost("reply", ["applied wave 1"], { forge: "forgejo", env: GH, fetch: f.fetch });
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([{ method: "POST", url: "http://api/repos/o/r/issues/7/comments", body: { body: "terragucci: applied wave 1" } }]);
    await expect(forgePost("note", ["note.md"], { forge: "forgejo", env: GH, fetch: f.fetch })).rejects.toThrow(/post is status, reply, stale/);
  });

  it("marks stale chant's note, whose terragucci line is its second", async () => {
    const f = forge((m, u) => {
      if (u.includes("/pulls?")) return [{ number: 1, head: { ref: "b1", sha: "abc", repo: { full_name: "o/r" } }, base: { ref: "main" } }];
      return m === "GET" && u.includes("issues/1/comments") ? [{ id: 11, body: "<!-- chant-pr:default -->\n<!-- terragucci:plan roots=app -->\n### terragucci tf-plan" }] : {};
    });
    await forgePost("stale", ["app", "main"], { forge: "github", env: GH, fetch: f.fetch });
    const edit = f.calls.find((c) => c.method === "PATCH")!;
    expect(edit.url).toBe("http://api/repos/o/r/issues/comments/11");
    expect((edit.body as { body: string }).body.split("\n").slice(0, 3)).toEqual(["<!-- chant-pr:default -->", "<!-- terragucci:plan roots=app -->", "> This plan is stale: main moved under app. Push to this pull request to plan again. <!-- terragucci:stale -->"]);
  });

  it("marks stale only the plan notes that cover a moved root, once", async () => {
    const notes: Record<number, unknown[]> = {
      1: [{ id: 11, body: "<!-- terragucci:plan roots=app,net -->\nplan" }],
      2: [{ id: 12, body: "<!-- terragucci:plan roots=other -->\nplan" }],
      3: [{ id: 13, body: "<!-- terragucci:plan roots=app -->\n> This plan is stale <!-- terragucci:stale -->" }],
    };
    const f = forge((m, u) => {
      if (u.includes("/pulls?")) return [1, 2, 3].map((number) => ({ number, head: { ref: `b${number}`, sha: "abc", repo: { full_name: "o/r" } }, base: { ref: "main" } }));
      const n = /issues\/(\d+)\/comments/.exec(u);
      return m === "GET" && n ? notes[Number(n[1])] : {};
    });
    await forgePost("stale", ["app", "main"], { forge: "github", env: GH, fetch: f.fetch });
    const edits = f.calls.filter((c) => c.method === "PATCH");
    expect(edits.map((c) => c.url)).toEqual(["http://api/repos/o/r/issues/comments/11"]);
    expect(edits[0].body.body).toBe("<!-- terragucci:plan roots=app,net -->\n> This plan is stale: main moved under app. Push to this pull request to plan again. <!-- terragucci:stale -->\nplan");
    expect(f.calls[0].url).toContain("/pulls?state=open&base=main");
  });

  it("says a failure and posts nothing without a token, and never throws for a forge's answer", async () => {
    const quiet = forge();
    expect(await forgePost("reply", ["x"], { forge: "github", env: { ...GH, TG_TOKEN: "" }, fetch: quiet.fetch })).toBe("terragucci: no forge token, so no reply");
    expect(quiet.calls).toEqual([]);
    const broken: Fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
    expect(await forgePost("reply", ["x"], { forge: "github", env: GH, fetch: broken })).toMatch(/^terragucci: reply failed: POST .* answered 500/);
  });

  it("writes the stale line under the note's first line", () => {
    expect(staleNote("<!-- terragucci:plan roots=a -->\nbody", ["b"], "main")).toBeUndefined();
    expect(staleNote("<!-- terragucci:plan roots=a,b -->\nbody", ["b"], "main")).toContain("main moved under b.");
  });
});

describe("terragucci post sent", () => {
  it("is true when the commit carries a successful status of that context, and false otherwise or when the read fails", async () => {
    const f = forge(() => [{ context: "terragucci/control", state: "success" }]);
    expect(await statusSent("terragucci/control", { forge: "github", env: GH, fetch: f.fetch })).toBe(true);
    expect(f.calls[0].url).toBe(`http://api/repos/o/r/commits/${SHA}/statuses?per_page=100&page=1`);
    const pending = forge(() => [{ context: "terragucci/control", state: "pending" }, { context: "other", state: "success" }]);
    expect(await statusSent("terragucci/control", { forge: "github", env: GH, fetch: pending.fetch })).toBe(false);
    const broken: Fetch = async () => {
      throw new Error("down");
    };
    expect(await statusSent("terragucci/control", { forge: "github", env: GH, fetch: broken })).toBe(false);
  });
});

describe("terragucci post in chant's control step (sentCheck, markSent)", () => {
  // The step has the job's token as GITHUB_TOKEN and the commit as CHANT_CONTROL_SHA, and no TG_TOKEN or TG_SHA.
  const CONTROL = "b".repeat(40);
  const STEP = { GITHUB_TOKEN: "job", CHANT_CONTROL_SHA: CONTROL, GITHUB_SHA: "c".repeat(40), GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://api", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "5" };

  it("posts the status on CHANT_CONTROL_SHA with GITHUB_TOKEN", async () => {
    const seen: (string | undefined)[] = [];
    const f = forge();
    const fetch: Fetch = (url, init) => (seen.push(init?.headers?.authorization ?? init?.headers?.Authorization), f.fetch(url, init));
    expect(await forgePost("status", ["terragucci/control", "success", "told o/c"], { forge: "github", env: STEP, fetch })).toBeUndefined();
    expect(f.calls.map((c) => c.url)).toEqual([`http://api/repos/o/r/statuses/${CONTROL}`]);
    expect(seen[0]).toContain("job");
  });

  it("asks whether CHANT_CONTROL_SHA was told already with GITHUB_TOKEN, on Forgejo too", async () => {
    const f = forge(() => [{ context: "terragucci/control", state: "success" }]);
    expect(await statusSent("terragucci/control", { forge: "forgejo", env: STEP, fetch: f.fetch })).toBe(true);
    expect(f.calls[0]!.url).toContain(`/commits/${CONTROL}/statuses`);
  });

  it("takes TG_TOKEN and TG_SHA first where a job still passes them, and posts nothing with no token at all", async () => {
    const f = forge();
    await forgePost("status", ["terragucci/apply", "success", "x"], { forge: "github", env: { ...STEP, TG_TOKEN: "t", TG_SHA: SHA }, fetch: f.fetch });
    expect(f.calls[0]!.url).toBe(`http://api/repos/o/r/statuses/${SHA}`);
    const none = forge();
    expect(await forgePost("status", ["terragucci/control", "success", "x"], { forge: "github", env: { ...STEP, GITHUB_TOKEN: "" }, fetch: none.fetch })).toBe("terragucci: no forge token, so no status");
    expect(await statusSent("terragucci/control", { forge: "github", env: { ...STEP, GITHUB_TOKEN: "" }, fetch: none.fetch })).toBe(false);
    expect(none.calls).toEqual([]);
  });
});
