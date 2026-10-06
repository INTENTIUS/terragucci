import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideApplyComment, type Git } from "../src/comment-apply";
import { decideComment, parseComment } from "../src/comment";
import type { Fetch } from "../src/forge";
import { git, tmp } from "./helpers";

const layers = [["network"], ["envs/dev/app", "envs/prod/app"]];

describe("parseComment: apply", () => {
  it("reads apply, with or without one wave", () => {
    expect(parseComment("/terragucci apply")).toEqual({ kind: "apply" });
    expect(parseComment("  /terragucci\tapply  \n")).toEqual({ kind: "apply" });
    expect(parseComment("/terragucci apply wave-2")).toEqual({ kind: "apply", wave: 2 });
  });

  it("refuses anything else after apply", () => {
    for (const c of ["/terragucci apply wave-0", "/terragucci apply wave-01", "/terragucci apply 2", "/terragucci apply wave-2 wave-3", "/terragucci apply envs/dev/app", "/terragucci apply wave-$(id)", "/terragucci apply wave-2\n/terragucci approve", "/terragucci apply wave-1000"]) {
      expect(parseComment(c), c).toMatchObject({ kind: "refused" });
    }
  });

  it("approve and unlock stay refused by name", () => {
    for (const v of ["approve", "unlock", "force-unlock"]) expect((parseComment(`/terragucci ${v} wave-1`) as { reason: string }).reason).toContain(`never runs \`${v}\``);
  });
});

interface Sent { method: string; path: string; body?: any }

const MERGED = (sha: string, extra: Record<string, unknown> = {}) => ({ state: "closed", merged: true, merge_commit_sha: sha, head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" }, ...extra });

/** origin with main at one commit (the merge commit), and a checkout of it; `later` adds commits on main after it. */
function repos(later = 0): { work: string; origin: string; merge: string; newer: string[]; git: Git } {
  const origin = tmp("tg-apply-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const work = tmp("tg-apply-work-");
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", origin);
  const commit = (m: string): string => {
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", m);
    return git(work, "rev-parse", "HEAD").trim();
  };
  commit("before");
  const merge = commit("merge pull request 7");
  const newer: string[] = [];
  for (let i = 0; i < later; i++) newer.unshift(commit(`later ${i}`));
  git(work, "push", "-q", "origin", "main");
  return { work, origin, merge, newer, git: (args) => spawnSync("git", args, { cwd: work, encoding: "utf-8" }) as ReturnType<Git> };
}

function setup(opts: { comment: string; user?: string; permission?: string; pr?: any; statuses?: Record<string, unknown[]>; event?: Record<string, unknown>; forgejo?: boolean }): { env: NodeJS.ProcessEnv; fetch: Fetch; sent: Sent[] } {
  const dir = tmp("tg-comment-apply-");
  const file = join(dir, "event.json");
  writeFileSync(file, JSON.stringify({
    action: "created",
    comment: { body: opts.comment, user: { login: opts.user ?? "dev" } },
    issue: { number: 7, pull_request: {} },
    repository: { full_name: "acme/infra", default_branch: "main", ...(opts.forgejo ? { permissions: { push: opts.permission !== "read", admin: false } } : {}) },
    ...(opts.forgejo ? { sender: { login: opts.user ?? "dev" } } : {}),
    ...opts.event,
  }));
  const sent: Sent[] = [];
  const f: Fetch = async (url, init) => {
    const path = url.replace("https://forge.test/api/v1/", "");
    sent.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (path.includes("/permission")) return (opts.permission === "403" ? answer(403, {}) : answer(200, { permission: opts.permission ?? "write" })) as never;
    if (path.includes("/pulls/")) return answer(200, opts.pr) as never;
    const st = /commits\/([0-9a-f]+)\/statuses/.exec(path);
    if (st) return answer(200, opts.statuses?.[st[1]] ?? []) as never;
    return answer(201, {}) as never;
  };
  return { env: { GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://forge.test/api/v1", TG_TOKEN: "t" }, fetch: f, sent };
}

const replies = (s: { sent: Sent[] }): string[] => s.sent.filter((x) => x.method === "POST").map((x) => x.body.body as string);

describe("decideApplyComment", () => {
  it("applies a merged pull request's merge commit for someone who can write, and replies nothing yet", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge) });
    const d = await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git });
    expect(d).toMatchObject({ go: true, pr: 7, sha: r.merge, base: "main" });
    expect(d.wave).toBeUndefined();
    expect(replies(s)).toEqual([]);
  });

  it("passes on the wave a comment names, and refuses a wave the repo does not have", async () => {
    const r = repos();
    const two = setup({ comment: "/terragucci apply wave-2", pr: MERGED(r.merge) });
    expect(await decideApplyComment({ layers, env: two.env, fetch: two.fetch, git: r.git })).toMatchObject({ go: true, wave: 2 });
    const nine = setup({ comment: "/terragucci apply wave-9", pr: MERGED(r.merge) });
    expect((await decideApplyComment({ layers, env: nine.env, fetch: nine.fetch, git: r.git })).go).toBe(false);
    expect(replies(nine)[0]).toContain("applies in 2 waves");
    // The canary wave is a wave of its own.
    const canary = setup({ comment: "/terragucci apply wave-3", pr: MERGED(r.merge) });
    expect((await decideApplyComment({ layers, canary: ["envs/dev/*"], env: canary.env, fetch: canary.fetch, git: r.git })).go).toBe(true);
  });

  it("an open pull request is refused with a reply, and its head is never passed on", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", pr: { state: "open", merged: false, merge_commit_sha: null, head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } } });
    const d = await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git });
    expect(d.go).toBe(false);
    expect(d.sha).toBeUndefined();
    expect(replies(s)[0]).toContain("pull request 7 is not merged");
  });

  it("a pull request closed without merging is refused with a reply", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", pr: { ...MERGED(r.merge), merged: false } });
    expect((await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).go).toBe(false);
    expect(replies(s)[0]).toContain("closed without merging");
  });

  it("a non-writer is refused with a reply, before the pull request is read", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", permission: "read", pr: MERGED(r.merge) });
    expect((await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).go).toBe(false);
    expect(replies(s)[0]).toContain("dev has no write access");
    expect(s.sent.some((x) => x.path.includes("/pulls/"))).toBe(false);
  });

  it("a fork's pull request, and one merged into another branch, are refused with a reply", async () => {
    const r = repos();
    const fork = setup({ comment: "/terragucci apply", pr: MERGED(r.merge, { head: { sha: "a".repeat(40), repo: { full_name: "evil/infra" } } }) });
    expect((await decideApplyComment({ layers, env: fork.env, fetch: fork.fetch, git: r.git })).go).toBe(false);
    expect(replies(fork)[0]).toContain("fork");
    const other = setup({ comment: "/terragucci apply", pr: MERGED(r.merge, { base: { ref: "release" } }) });
    expect((await decideApplyComment({ layers, env: other.env, fetch: other.fetch, git: r.git })).go).toBe(false);
    expect(replies(other)[0]).toContain("not the default branch main");
  });

  it("a merge commit the default branch no longer reaches is refused", async () => {
    const r = repos();
    // main is rewritten without the merge commit.
    git(r.work, "checkout", "-q", "--orphan", "rewritten");
    git(r.work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "rewritten");
    git(r.work, "push", "-q", "--force", "origin", "HEAD:refs/heads/main");
    const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge) });
    const d = await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git });
    expect(d.go).toBe(false);
    expect(d.fail).toBeUndefined();
    expect(replies(s)[0]).toContain("is no longer on main");
  });

  it("a merge commit a later apply superseded is refused, and the reply names the newer run", async () => {
    const r = repos(2);
    const run = "https://forge.test/acme/infra/actions/runs/41";
    const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), statuses: { [r.newer[1]]: [{ context: "terragucci/plan" }, { context: "terragucci/apply", state: "pending", target_url: run }] } });
    const d = await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git });
    expect(d.go).toBe(false);
    expect(replies(s)[0]).toContain(`a later apply already ran on main at ${r.newer[1].slice(0, 8)} (${run})`);
  });

  it("later commits with no apply of their own do not supersede it", async () => {
    const r = repos(2);
    const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), statuses: { [r.newer[0]]: [{ context: "terragucci/check" }] } });
    expect(await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).toMatchObject({ go: true, sha: r.merge });
  });

  it("any other text is refused with the reason, and plan comments are left to the replan job", async () => {
    const r = repos();
    const bad = setup({ comment: "/terragucci apply now please", pr: MERGED(r.merge) });
    expect((await decideApplyComment({ layers, env: bad.env, fetch: bad.fetch, git: r.git })).go).toBe(false);
    expect(replies(bad)).toHaveLength(1);
    const plan = setup({ comment: "/terragucci plan", pr: MERGED(r.merge) });
    expect((await decideApplyComment({ layers, env: plan.env, fetch: plan.fetch, git: r.git })).go).toBe(false);
    expect(plan.sent).toEqual([]);
  });

  it("an edited comment does not run again", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), event: { action: "edited" } });
    expect((await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).go).toBe(false);
    expect(s.sent).toEqual([]);
  });

  it("a merge commit that is not a commit sha is not passed on", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", pr: MERGED("$(id)") });
    expect(await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).toMatchObject({ go: false, fail: true });
  });

  it("on GitHub, a permission the API will not give fails the job and applies nothing", async () => {
    const r = repos();
    const s = setup({ comment: "/terragucci apply", permission: "403", pr: MERGED(r.merge) });
    expect(await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git })).toMatchObject({ go: false, fail: true });
  });

  describe("on Forgejo", () => {
    it("reads the commenter's permission from the event, without asking the API", async () => {
      const r = repos();
      const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), forgejo: true, permission: "403" });
      // permission "403" only breaks the API route; the event says push: true.
      const d = await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git, forge: "forgejo" });
      expect(d).toMatchObject({ go: true, sha: r.merge });
      expect(s.sent.some((x) => x.path.includes("/permission"))).toBe(false);
    });

    it("a commenter the event says cannot push is refused with a reply", async () => {
      const r = repos();
      const s = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), forgejo: true, permission: "read" });
      expect((await decideApplyComment({ layers, env: s.env, fetch: s.fetch, git: r.git, forge: "forgejo" })).go).toBe(false);
      expect(replies(s)[0]).toContain("has no write access");
    });

    it("an event for another repository, or whose sender is not the author, gets no answer", async () => {
      const r = repos();
      const other = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), forgejo: true, event: { repository: { full_name: "evil/infra", default_branch: "main", permissions: { push: true } } } });
      expect((await decideApplyComment({ layers, env: other.env, fetch: other.fetch, git: r.git, forge: "forgejo" })).go).toBe(false);
      const sender = setup({ comment: "/terragucci apply", pr: MERGED(r.merge), forgejo: true, event: { sender: { login: "admin" } } });
      expect((await decideApplyComment({ layers, env: sender.env, fetch: sender.fetch, git: r.git, forge: "forgejo" })).go).toBe(false);
      expect([...other.sent, ...sender.sent]).toEqual([]);
    });
  });
});

describe("decideComment and apply", () => {
  it("the re-plan job answers an apply comment it is given by saying this pipeline does not apply on a comment", async () => {
    const s = setup({ comment: "/terragucci apply", pr: MERGED("b".repeat(40)) });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch });
    expect(d.go).toBe(false);
    expect(replies(s)[0]).toContain("does not apply on a comment");
  });
});
