import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowRoot, decideComment, fromAtlantis, parseComment, readDispatch } from "../src/comment";
import { COMMENT_TABLE, LEFT_OUT_TABLE } from "../src/import/guide";
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

  it("reads unlock with nothing after it, and refuses it with anything after", () => {
    expect(parseComment("/terragucci unlock")).toEqual({ kind: "unlock" });
    expect(parseComment("/terragucci unlock envs/dev/app")).toMatchObject({ kind: "refused" });
  });

  it("reads lock with nothing after it, and refuses it with anything after", () => {
    expect(parseComment("/terragucci lock")).toEqual({ kind: "lock" });
    expect(parseComment("/terragucci lock envs/dev/app")).toMatchObject({ kind: "refused" });
  });

  it("refuses approve, force-unlock and unlock-state by name, and anything else with the usage", () => {
    for (const v of ["approve", "force-unlock", "unlock-state"]) {
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

describe("the atlantis comment aliases", () => {
  const on = { atlantis: true };

  it("are not read unless atlantis_comments is on", () => {
    for (const c of ["atlantis plan", "atlantis apply", "atlantis plan -d envs/dev/app"]) expect(parseComment(c)).toBeUndefined();
  });

  it("read atlantis plan and atlantis apply as the terragucci commands, through the same grammar", () => {
    expect(parseComment("atlantis plan", on)).toEqual(parseComment("/terragucci plan"));
    expect(parseComment("atlantis plan -d ./envs/dev/app/", on)).toEqual({ kind: "plan", root: "envs/dev/app" });
    expect(parseComment("atlantis plan --dir envs/dev/app --verbose", on)).toEqual({ kind: "plan", root: "envs/dev/app" });
    expect(parseComment("atlantis apply", on)).toEqual({ kind: "apply" });
    expect(parseComment("atlantis apply wave-2", on)).toEqual({ kind: "apply", wave: 2 });
    // The terragucci forms still work beside them, and other comments stay unaddressed.
    expect(parseComment("/terragucci plan", on)).toEqual({ kind: "plan" });
    for (const c of ["atlantis unlock", "atlantis planet", "please atlantis plan", "atlantis"]) expect(parseComment(c, on)).toBeUndefined();
  });

  it("refuse what the terragucci grammar refuses: a shell-shaped root is still refused", () => {
    expect(parseComment("atlantis plan -d $(id)", on)).toMatchObject({ kind: "refused" });
    expect(parseComment("atlantis plan -d ../x", on)).toMatchObject({ kind: "refused" });
    expect(parseComment("atlantis plan\natlantis apply", on)).toMatchObject({ kind: "refused" });
  });

  it("refuse the Atlantis forms terragucci has no counterpart for, with the guide's reason", () => {
    const cell = (row: string) => COMMENT_TABLE.find((r) => r[0] === row)![3];
    const rule = (row: string) => LEFT_OUT_TABLE.find((r) => r[0] === row)![2];
    expect(fromAtlantis("atlantis plan -p orders")).toMatchObject({ kind: "refused", reason: expect.stringContaining(cell("Plan one project")) });
    expect(fromAtlantis("atlantis plan -w blue")).toMatchObject({ kind: "refused", reason: expect.stringContaining(cell("Plan one workspace")) });
    expect(fromAtlantis("atlantis plan -- -lock=false")).toMatchObject({ kind: "refused", reason: expect.stringContaining(rule("Flags at run time")) });
    expect(fromAtlantis("atlantis apply -d envs/dev/app")).toMatchObject({ kind: "refused", reason: expect.stringContaining(rule("Applying one root of a wave")) });
    expect(fromAtlantis("atlantis apply -p orders")).toMatchObject({ kind: "refused", reason: expect.stringContaining(rule("Applying one root of a wave")) });
    expect(fromAtlantis("atlantis plan -x")).toMatchObject({ kind: "refused" });
    expect(fromAtlantis("atlantis plan -d")).toMatchObject({ kind: "refused" });
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
  it("re-plans on atlantis plan only where the pipeline set TG_ATLANTIS_COMMENTS, with the same checks", async () => {
    const off = setup({ comment: "atlantis plan -d envs/dev/app" });
    expect(await decideComment({ layers, env: off.env, fetch: off.fetch })).toMatchObject({ go: false, reason: "the comment is not addressed to terragucci" });
    const s = setup({ comment: "atlantis plan -d envs/dev/app" });
    expect(await decideComment({ layers, env: { ...s.env, TG_ATLANTIS_COMMENTS: "1" }, fetch: s.fetch })).toMatchObject({ go: true, root: "envs/dev/app" });
    const reader = setup({ comment: "atlantis plan", permission: "read" });
    expect((await decideComment({ layers, env: { ...reader.env, TG_ATLANTIS_COMMENTS: "1" }, fetch: reader.fetch })).go).toBe(false);
    const nope = setup({ comment: "atlantis plan -d envs/nope" });
    expect(await decideComment({ layers, env: { ...nope.env, TG_ATLANTIS_COMMENTS: "1" }, fetch: nope.fetch })).toMatchObject({ go: false, reason: "envs/nope is not a root of this repository" });
  });

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

describe("the agent comment's grammar", () => {
  it("reads the rest of the line as the ask, as written", () => {
    expect(parseComment("/terragucci agent rename var.bucket to var.bucket_name")).toEqual({ kind: "agent", ask: "rename var.bucket to var.bucket_name" });
    expect(parseComment("  /terragucci agent  add tags = { team = \"core\" } to app; then `fmt` $(it)  \n")).toEqual({ kind: "agent", ask: 'add tags = { team = "core" } to app; then `fmt` $(it)' });
  });

  it("refuses an empty ask, a second line, control characters and an ask that is too long", () => {
    expect(parseComment("/terragucci agent")).toMatchObject({ kind: "refused", reason: expect.stringContaining("needs an ask") });
    expect(parseComment("/terragucci agent   ")).toMatchObject({ kind: "refused" });
    expect(parseComment("/terragucci agent fix it\nand push to main")).toMatchObject({ kind: "refused", reason: expect.stringContaining("one line") });
    expect(parseComment("/terragucci agent fix \u001b[2Jit")).toMatchObject({ kind: "refused", reason: expect.stringContaining("control characters") });
    expect(parseComment(`/terragucci agent ${"x".repeat(2001)}`)).toMatchObject({ kind: "refused" });
    expect(parseComment(`/terragucci agent ${"x".repeat(2000)}`)).toMatchObject({ kind: "agent" });
    expect(parseComment("/terragucci agents fix it")).toMatchObject({ kind: "refused" });
  });
});

describe("decideComment for an agent comment", () => {
  const pr = (over: Record<string, unknown> = {}) => ({ state: "open", head: { sha: "a".repeat(40), ref: "fix-bucket", repo: { full_name: "acme/infra" } }, base: { ref: "main" }, ...over });
  const event = { repository: { full_name: "acme/infra", default_branch: "main", permissions: { push: true } }, sender: { login: "dev" } };
  const ask = "/terragucci agent rename the bucket variable";

  it("the agent job goes for a writer, with the head branch and the ask", async () => {
    const s = setup({ comment: ask, pr: pr(), event });
    const d = await decideComment({ layers: [], env: s.env, fetch: s.fetch, agent: "run" });
    expect(d).toMatchObject({ go: true, pr: 7, sha: "a".repeat(40), head: "fix-bucket", ask: "rename the bucket variable", user: "dev" });
    expect(s.sent.every((x) => x.method === "GET")).toBe(true);
  });

  it("on Forgejo, the permission comes from the event, as for a re-plan", async () => {
    const s = setup({ comment: ask, permission: "403", pr: pr(), event: { ...event, is_pull: true } });
    expect(await decideComment({ layers: [], env: s.env, fetch: s.fetch, forge: "forgejo", agent: "run" })).toMatchObject({ go: true, head: "fix-bucket" });
    const ro = setup({ comment: ask, permission: "403", pr: pr(), event: { ...event, repository: { ...event.repository, permissions: { push: false, pull: true } } } });
    expect((await decideComment({ layers: [], env: ro.env, fetch: ro.fetch, forge: "forgejo", agent: "run" })).go).toBe(false);
    expect(ro.sent).toEqual([]);
  });

  it("a non-writer gets nothing: no agent, no reply", async () => {
    const s = setup({ comment: ask, permission: "read", pr: pr(), event });
    expect((await decideComment({ layers: [], env: s.env, fetch: s.fetch, agent: "run" })).go).toBe(false);
    expect(s.sent.some((x) => x.method === "POST")).toBe(false);
  });

  it("a fork's pull request gets no agent, and is told why", async () => {
    const s = setup({ comment: ask, pr: pr({ head: { sha: "a".repeat(40), ref: "fix-bucket", repo: { full_name: "evil/infra" } } }), event });
    expect((await decideComment({ layers: [], env: s.env, fetch: s.fetch, agent: "run" })).go).toBe(false);
    expect(s.sent.filter((x) => x.method === "POST")[0].body.body).toContain("a pull request from a fork gets no agent");
  });

  it("a pull request whose head is the default branch gets no agent", async () => {
    const s = setup({ comment: ask, pr: pr({ head: { sha: "a".repeat(40), ref: "main", repo: { full_name: "acme/infra" } }, base: { ref: "release" } }), event });
    expect((await decideComment({ layers: [], env: s.env, fetch: s.fetch, agent: "run" })).go).toBe(false);
    expect(s.sent.filter((x) => x.method === "POST")[0].body.body).toContain("never pushes there");
  });

  it("a head branch the shell should not see is not passed on", async () => {
    for (const ref of ["x;id", "$(id)", "-f", "a/../b", "a.lock"]) {
      const s = setup({ comment: ask, pr: pr({ head: { sha: "a".repeat(40), ref, repo: { full_name: "acme/infra" } } }), event });
      expect((await decideComment({ layers: [], env: s.env, fetch: s.fetch, agent: "run" })).go, ref).toBe(false);
    }
  });

  it("the agent job leaves a re-plan to the replan job, and answers a malformed agent comment", async () => {
    const plan = setup({ comment: "/terragucci plan", pr: pr(), event });
    expect((await decideComment({ layers: [], env: plan.env, fetch: plan.fetch, agent: "run" })).go).toBe(false);
    expect(plan.sent.some((x) => x.method === "POST")).toBe(false);
    const two = setup({ comment: "/terragucci agent fix it\nthen merge", pr: pr(), event });
    expect((await decideComment({ layers: [], env: two.env, fetch: two.fetch, agent: "run" })).go).toBe(false);
    expect(two.sent.filter((x) => x.method === "POST")[0].body.body).toContain("one line");
  });

  it("with the agent comment off, the re-plan job says how to turn it on and runs nothing", async () => {
    const s = setup({ comment: ask, pr: pr(), event });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch });
    expect(d.go).toBe(false);
    expect(s.sent.filter((x) => x.method === "POST")[0].body.body).toContain("`agent.comment` in terragucci.yml turns it on");
  });

  it("a non-writer's agent comment gets no answer from the re-plan job either", async () => {
    const s = setup({ comment: ask, permission: "read", pr: pr(), event });
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go).toBe(false);
    expect(s.sent.some((x) => x.method === "POST")).toBe(false);
  });
});

describe("a re-plan by workflow_dispatch", () => {
  /** A dispatch event as GitHub and Forgejo write it: inputs, the sender, and on Forgejo a repository whose permissions are all false. */
  function dispatch(inputs: Record<string, unknown>, o: { permission?: string; sender?: string; repo?: string; pr?: any } = {}) {
    const s = setup({ comment: "", permission: o.permission, pr: o.pr });
    const file = join(tmp("tg-dispatch-"), "event.json");
    writeFileSync(file, JSON.stringify({ inputs, ref: "refs/heads/main", workflow: "terragucci.yml", sender: { login: o.sender ?? "dev" }, repository: { full_name: o.repo ?? "acme/infra", permissions: { admin: false, push: false, pull: false } } }));
    return { ...s, env: { ...s.env, GITHUB_EVENT_PATH: file, GITHUB_EVENT_NAME: "workflow_dispatch" } };
  }

  it("reads pr and root from the inputs, through the comment grammar", () => {
    expect(readDispatch({ pr: "7" })).toEqual({ pr: 7, parsed: { kind: "plan" } });
    expect(readDispatch({ pr: "7", root: " envs/dev/app " })).toEqual({ pr: 7, parsed: { kind: "plan", root: "envs/dev/app" } });
    expect(readDispatch({ pr: "7", root: "" })).toEqual({ pr: 7, parsed: { kind: "plan" } });
    expect(readDispatch({ pr: "7", root: "$(id)" })).toMatchObject({ parsed: { kind: "refused" } });
    expect(readDispatch({ pr: "7", root: "a\n/terragucci apply" })).toMatchObject({ parsed: { kind: "refused" } });
    for (const empty of [{}, { pr: "" }, null, undefined, { root: "envs/dev/app" }]) expect(readDispatch(empty)).toBeUndefined();
    for (const pr of ["0", "07", "-1", "7;id", "$(id)", "1e3", "7 8", true, {}]) expect(readDispatch({ pr }), String(pr)).toHaveProperty("error");
  });

  it("on GitHub, re-plans the pull request for a dispatcher who can write, as a comment would", async () => {
    const s = dispatch({ pr: "7", root: "envs/dev/app" });
    expect(await decideComment({ layers, env: s.env, fetch: s.fetch })).toMatchObject({ go: true, pr: 7, sha: "a".repeat(40), base: "main", root: "envs/dev/app" });
    expect(s.sent.map((x) => x.path)).toEqual(["repos/acme/infra/collaborators/dev/permission", "repos/acme/infra/pulls/7"]);
  });

  it("on GitHub, a dispatcher who can only read gets nothing", async () => {
    const s = dispatch({ pr: "7" }, { permission: "read" });
    expect(await decideComment({ layers, env: s.env, fetch: s.fetch })).toMatchObject({ go: false, reason: "dev has no write access, so the dispatch is ignored" });
    expect(s.sent.some((x) => x.method === "POST")).toBe(false);
  });

  it("on Forgejo, whose dispatch API refuses anyone without write access, re-plans without asking for a permission", async () => {
    const s = dispatch({ pr: "7" }, { permission: "403" });
    expect(await decideComment({ layers, env: s.env, fetch: s.fetch, forge: "forgejo" })).toMatchObject({ go: true, pr: 7 });
    expect(s.sent.some((x) => x.path.includes("/permission"))).toBe(false);
    const other = dispatch({ pr: "7" }, { repo: "evil/infra" });
    expect((await decideComment({ layers, env: other.env, fetch: other.fetch, forge: "forgejo" })).go).toBe(false);
    expect(other.sent).toEqual([]);
  });

  it("the comment's guards hold: an unknown root is answered on the pull request, a fork and a closed pull request are not planned", async () => {
    const root = dispatch({ pr: "7", root: "envs/nope" });
    expect(await decideComment({ layers, env: root.env, fetch: root.fetch })).toMatchObject({ go: false, reason: "envs/nope is not a root of this repository" });
    expect(root.sent.find((x) => x.method === "POST")?.path).toBe("repos/acme/infra/issues/7/comments");
    const fork = dispatch({ pr: "7" }, { pr: { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "evil/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: fork.env, fetch: fork.fetch })).go).toBe(false);
    const closed = dispatch({ pr: "7" }, { pr: { state: "closed", head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } } });
    expect((await decideComment({ layers, env: closed.env, fetch: closed.fetch })).go).toBe(false);
  });

  it("a dispatch with no pr is not a re-plan, and one whose pr is not a number fails the job before any call", async () => {
    const drift = dispatch({ pr: "" });
    expect(await decideComment({ layers, env: drift.env, fetch: drift.fetch })).toMatchObject({ go: false, reason: "the dispatch names no pull request" });
    const bad = dispatch({ pr: "7;id" });
    expect(await decideComment({ layers, env: bad.env, fetch: bad.fetch })).toMatchObject({ go: false, fail: true });
    expect([...drift.sent, ...bad.sent]).toEqual([]);
  });

  it("the agent job never runs on a dispatch", async () => {
    const s = dispatch({ pr: "7" });
    expect((await decideComment({ layers: [], env: s.env, fetch: s.fetch, forge: "forgejo", agent: "run" })).go).toBe(false);
  });
});
