import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowRoot, decideComment, parseComment } from "../src/comment";
import type { Fetch } from "../src/forge";
import { tmp } from "./helpers";

const layers = [["network"], ["envs/dev/app", "envs/prod/app"]];

describe("parseComment", () => {
  it("reads plan, with or without a root", () => {
    expect(parseComment("/terragucci plan")).toEqual({ kind: "plan" });
    expect(parseComment("  /terragucci plan  \n")).toEqual({ kind: "plan" });
    expect(parseComment("/terragucci\tplan  envs/dev/app")).toEqual({ kind: "plan", root: "envs/dev/app" });
  });

  it("ignores a comment that is not addressed to terragucci", () => {
    for (const c of ["looks good", "please /terragucci plan", "/terragucci-plan", "/terraguccix plan", 5, undefined, null]) expect(parseComment(c)).toBeUndefined();
  });

  it("refuses approve and unlock by name, and anything else with the usage", () => {
    for (const v of ["approve", "unlock", "force-unlock"]) {
      const r = parseComment(`/terragucci ${v} envs/dev/app`);
      expect(r).toMatchObject({ kind: "refused" });
      expect((r as { reason: string }).reason).toContain("never runs");
    }
    expect(parseComment("/terragucci")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci replan")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci plan a b")).toMatchObject({ kind: "refused" });
  });

  it("refuses a comment that carries more than the command", () => {
    expect(parseComment("/terragucci plan\nand then apply")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci plan\r\n/terragucci apply")).toMatchObject({ kind: "refused" });
  });

  it("refuses a root with shell, glob or path syntax", () => {
    for (const root of ["$(id)", "`id`", "a;b", "a&&b", "a|b", "a>b", "a b/../c", "../x", "/abs", "a/../b", "a//b", "a/./b", "-rf", "--root", "*", "envs/*", "a'b", 'a"b', "a\\b", "x".repeat(201), "a\u0000b"]) {
      expect(parseComment(`/terragucci plan ${root}`), root).toMatchObject({ kind: expect.stringMatching(/refused|plan/) });
      const r = parseComment(`/terragucci plan ${root}`);
      if (r?.kind === "plan") expect(r.root).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/);
    }
    expect(parseComment("/terragucci plan $(id)")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci plan ../x")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci plan -rf")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci plan envs/*")).toMatchObject({ kind: "refused" });
  });
});

describe("allowRoot", () => {
  it("accepts a configured root exactly", () => {
    expect(allowRoot("network", layers)).toBe(true);
    expect(allowRoot("envs/dev/app", layers)).toBe(true);
    expect(allowRoot("envs/dev", layers)).toBe(false);
    expect(allowRoot("envs/dev/app/", layers)).toBe(false);
    expect(allowRoot("other", layers)).toBe(false);
  });
});

interface Sent { method: string; path: string; body?: any }

function setup(opts: { comment: string; user?: string; permission?: string; pr?: any; isPull?: boolean; action?: string; event?: Record<string, unknown> }): { env: NodeJS.ProcessEnv; fetch: Fetch; sent: Sent[] } {
  const dir = tmp("tg-comment-");
  const file = join(dir, "event.json");
  writeFileSync(file, JSON.stringify({
    action: opts.action ?? "created",
    comment: { body: opts.comment, user: { login: opts.user ?? "dev" } },
    issue: { number: 7, ...(opts.isPull === false ? {} : { pull_request: {} }) },
    ...opts.event,
  }));
  const sent: Sent[] = [];
  const pr = opts.pr ?? { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } };
  const f: Fetch = async (url, init) => {
    const path = url.replace("https://forge.test/api/v1/", "");
    sent.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (path.includes("/permission")) return (opts.permission === "403" ? answer(403, {}) : answer(200, { permission: opts.permission ?? "write" })) as never;
    if (path.includes("/pulls/")) return answer(200, pr) as never;
    return answer(201, {}) as never;
  };
  return { env: { GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://forge.test/api/v1", TG_TOKEN: "t" }, fetch: f, sent };
}

describe("decideComment", () => {
  it("re-plans the pull request's head for someone who can write", async () => {
    const s = setup({ comment: "/terragucci plan envs/dev/app" });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch });
    expect(d).toMatchObject({ go: true, pr: 7, sha: "a".repeat(40), base: "main", root: "envs/dev/app" });
    expect(s.sent.every((x) => x.method === "GET")).toBe(true);
  });

  it("a read-only commenter gets nothing: no plan, no reply", async () => {
    const s = setup({ comment: "/terragucci plan", permission: "read" });
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go).toBe(false);
    expect(s.sent.some((x) => x.method === "POST")).toBe(false);
  });

  it("apply by comment is not the re-plan job's: it is answered, and nothing runs", async () => {
    const s = setup({ comment: "/terragucci apply" });
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go).toBe(false);
    expect(s.sent.filter((x) => x.method === "POST")[0].body.body).toContain("does not apply on a comment");
  });

  it("a root outside the configured roots is refused, whatever it looks like", async () => {
    for (const root of ["envs/staging/app", "envs/dev", "$(id)"]) {
      const s = setup({ comment: `/terragucci plan ${root}` });
      expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go, root).toBe(false);
    }
  });

  it("a fork's pull request, a closed one and a comment on an issue are not re-planned", async () => {
    const fork = setup({ comment: "/terragucci plan", pr: { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "evil/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: fork.env, fetch: fork.fetch })).go).toBe(false);
    const closed = setup({ comment: "/terragucci plan", pr: { state: "closed", head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: closed.env, fetch: closed.fetch })).go).toBe(false);
    const issue = setup({ comment: "/terragucci plan", isPull: false });
    expect((await decideComment({ layers, env: issue.env, fetch: issue.fetch })).go).toBe(false);
  });

  it("a head or base the shell should not see is not passed on", async () => {
    const badSha = setup({ comment: "/terragucci plan", pr: { state: "open", head: { sha: "$(id)", repo: { full_name: "acme/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: badSha.env, fetch: badSha.fetch })).go).toBe(false);
    const badBase = setup({ comment: "/terragucci plan", pr: { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "x;id" } } });
    expect((await decideComment({ layers, env: badBase.env, fetch: badBase.fetch })).go).toBe(false);
  });

  it("an edited comment does not run again", async () => {
    const s = setup({ comment: "/terragucci plan", action: "edited" });
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go).toBe(false);
  });

  it("on GitHub, a permission the API will not give stops the re-plan", async () => {
    const s = setup({ comment: "/terragucci plan", permission: "403" });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch });
    expect(d.go).toBe(false);
    expect(d.reason).toContain("answered 403");
    expect(d.fail).toBe(true);
  });

  it("a pull request the API will not give fails the job, and one that is merely closed does not", async () => {
    const s = setup({ comment: "/terragucci plan" });
    const broken: Fetch = async (url, init) => (url.includes("/pulls/") ? ({ ok: false, status: 403, json: async () => ({}), text: async () => "" } as never) : s.fetch(url, init));
    const d = await decideComment({ layers, env: s.env, fetch: broken });
    expect(d).toMatchObject({ go: false, fail: true });
    expect(d.reason).toContain("answered 403");
    const closed = setup({ comment: "/terragucci plan", pr: { state: "closed", head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: closed.env, fetch: closed.fetch })).fail).toBeUndefined();
  });

  it("an event file that cannot be read fails the job with the cause", async () => {
    const s = setup({ comment: "/terragucci plan" });
    const bad = join(tmp("tg-comment-"), "event.json");
    writeFileSync(bad, "{not json");
    const d = await decideComment({ layers, env: { ...s.env, GITHUB_EVENT_PATH: bad }, fetch: s.fetch });
    expect(d).toMatchObject({ go: false, fail: true });
    expect(d.reason).toContain("could not read the event file");
  });

  it("a comment that asks for nothing is not a failure", async () => {
    for (const comment of ["/terragucci apply", "looks good"]) {
      const s = setup({ comment });
      expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).fail).toBeUndefined();
    }
  });
});

describe("decideComment on Forgejo", () => {
  // Forgejo answers 403 to a job token that asks for another user's permission,
  // and writes the commenter's permission into the issue_comment event instead.
  const forgejo = (permissions: unknown, extra: Record<string, unknown> = {}) =>
    setup({ comment: "/terragucci plan envs/dev/app", permission: "403", event: { repository: { full_name: "acme/infra", permissions }, sender: { login: "dev" }, is_pull: true, ...extra } });

  it("re-plans the pull request's head for a commenter the event says can push, without asking the API", async () => {
    const s = forgejo({ admin: false, push: true, pull: true });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch, forge: "forgejo" });
    expect(d).toMatchObject({ go: true, pr: 7, sha: "a".repeat(40), base: "main", root: "envs/dev/app" });
    expect(s.sent.some((x) => x.path.includes("/permission"))).toBe(false);
    expect(s.sent.map((x) => x.path)).toContain("repos/acme/infra/pulls/7");
  });

  it("the head comes from the pull request, not from the event", async () => {
    const s = forgejo({ admin: true, push: true, pull: true }, { after: "b".repeat(40), head_commit: { id: "b".repeat(40) } });
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch, forge: "forgejo" })).sha).toBe("a".repeat(40));
  });

  it("a commenter who can only read, or an event with no permissions, gets nothing: no plan, no reply", async () => {
    for (const p of [{ admin: false, push: false, pull: true }, undefined, { push: "true" }]) {
      const s = forgejo(p);
      expect((await decideComment({ layers, env: s.env, fetch: s.fetch, forge: "forgejo" })).go).toBe(false);
      expect(s.sent).toEqual([]);
    }
  });

  it("an event for another repository, or whose sender is not the comment's author, is not trusted", async () => {
    const other = setup({ comment: "/terragucci plan", event: { repository: { full_name: "evil/infra", permissions: { push: true } }, sender: { login: "dev" } } });
    expect((await decideComment({ layers, env: other.env, fetch: other.fetch, forge: "forgejo" })).go).toBe(false);
    const sender = setup({ comment: "/terragucci plan", event: { repository: { full_name: "acme/infra", permissions: { push: true } }, sender: { login: "admin" } } });
    expect((await decideComment({ layers, env: sender.env, fetch: sender.fetch, forge: "forgejo" })).go).toBe(false);
    expect([...other.sent, ...sender.sent]).toEqual([]);
  });

  it("the untrusted-input guards still hold: apply is not re-planned, an unknown root is refused, a fork is not planned", async () => {
    const apply = setup({ comment: "/terragucci apply", event: { repository: { full_name: "acme/infra", permissions: { push: true } }, sender: { login: "dev" } } });
    expect((await decideComment({ layers, env: apply.env, fetch: apply.fetch, forge: "forgejo" })).go).toBe(false);
    expect(apply.sent.filter((x) => x.method === "POST")[0].body.body).toContain("does not apply on a comment");
    const root = setup({ comment: "/terragucci plan $(id)", event: { repository: { full_name: "acme/infra", permissions: { push: true } }, sender: { login: "dev" } } });
    expect((await decideComment({ layers, env: root.env, fetch: root.fetch, forge: "forgejo" })).go).toBe(false);
    const fork = setup({ comment: "/terragucci plan", pr: { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "evil/infra" } }, base: { ref: "main" } }, event: { repository: { full_name: "acme/infra", permissions: { push: true } }, sender: { login: "dev" } } });
    expect((await decideComment({ layers, env: fork.env, fetch: fork.fetch, forge: "forgejo" })).go).toBe(false);
  });
});
