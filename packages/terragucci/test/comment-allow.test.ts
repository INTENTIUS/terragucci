// comment_allow: who may run each comment command beyond write access. Team
// membership goes through TeamReads, and the forge reads are tested against
// recorded answers, so nothing here touches a network.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependencies } from "../package.json";
import { CHANT_PIN, chantAtLeast, chantCarriesCommentAllow, chantCommentAllow, COMMENT_ALLOW_CHANT_FLOOR, commentAllowAt, commentAllowForgeProblems, commentAllowProblems, mayRun, TeamReadError, teamReads, type TeamReads } from "../src/comment-allow";
import { chantAgentFiles, chantAgentOptions } from "../src/render-chant-agent";
import { agentCommentInput } from "../src/agent-comment";
import { githubCommentJob, githubPlanJobs, type PlanJobsInput } from "../src/product-plan";
import { MARKER } from "../src/render";
import { decideComment } from "../src/comment";
import { pollGitLabComments } from "../src/comment-gitlab";
import { validateConfig } from "../src/config";
import { fetchForge } from "../src/rollout/forge";
import { targetAt, type Fetch } from "../src/forge";
import { memoryNoteLog } from "@intentius/chant/ci-note-commands";
import { tmp } from "./helpers";

/** A TeamReads over a table of team to members, counting its reads. */
const table = (t: Record<string, string[]>): TeamReads & { reads: string[] } => {
  const reads: string[] = [];
  return { reads, member: async (team, login) => { reads.push(`${team}:${login}`); if (!(team in t)) throw new TeamReadError(`team ${team} does not exist`); return t[team]!.includes(login); } };
};

describe("comment_allow in terragucci.yml", () => {
  it("takes logins and teams per command, and default", () => {
    expect(commentAllowProblems({ apply: ["team:acme/release", "alice"], default: ["team:acme/eng"], "skip-soak": ["bob"] }, "c")).toEqual([]);
  });

  it("names what is wrong, at the entry", () => {
    expect(commentAllowProblems({ deploy: ["a"] }, "c")[0]).toContain("c.deploy is not a comment command");
    expect(commentAllowProblems({ apply: [] }, "c")[0]).toContain("at least one entry");
    expect(commentAllowProblems({ apply: ["team:acme"] }, "c")[0]).toContain("c.apply[0]");
    expect(commentAllowProblems({ apply: ["a b"] }, "c")[0]).toContain("is not a login or a team");
    expect(commentAllowProblems({ apply: [3] }, "c")[0]).toContain("must be a login or team");
    expect(commentAllowProblems(["x"], "c")[0]).toContain("must be a map");
  });

  it("is a setting that config check accepts and refuses by the same rules", () => {
    expect(() => validateConfig({ forge: "gitlab", comment_allow: { apply: ["team:acme/release"], default: ["alice"] } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ comment_allow: { action: "alice" } }, "terragucci.yml")).toThrow(/comment_allow\.action must be a list/);
  });

  it("refuses, on GitHub and Forgejo, a list for a command no job of terragucci's reads, so no list looks like a limit and is none", () => {
    for (const forge of [undefined, "github", "forgejo"]) {
      const f = forge ? { forge } : {};
      expect(() => validateConfig({ ...f, comment_allow: { action: ["team:acme/ops"], "skip-soak": ["team:acme/release"] } }, "terragucci.yml")).not.toThrow();
      for (const k of ["plan", "apply", "agent", "default"]) expect(() => validateConfig({ ...f, comment_allow: { [k]: ["alice"] } }, "terragucci.yml"), `${forge} ${k}`).toThrow(/is not read here/);
      expect(() => validateConfig({ ...f, comment_allow: { unlock: ["alice"] } }, "terragucci.yml")).toThrow(/limited under locks: plan with apply.when: merge/);
      expect(() => validateConfig({ ...f, locks: "plan", comment_allow: { lock: ["alice"], unlock: ["alice"] } }, "terragucci.yml")).not.toThrow();
      expect(() => validateConfig({ ...f, locks: "plan", apply: { when: "pull-request" }, comment_allow: { unlock: ["alice"] } }, "terragucci.yml")).toThrow(/is not read here/);
    }
  });

  it("is read from the terragucci.yml in the job's checkout, and a broken file is an error, not no limit", async () => {
    const dir = tmp("tg-allow-");
    expect(await commentAllowAt(dir)).toBeUndefined();
    writeFileSync(join(dir, "terragucci.yml"), "comment_allow:\n  action: [team:acme/platform]\n");
    expect(await commentAllowAt(dir)).toEqual({ action: ["team:acme/platform"] });
    writeFileSync(join(dir, "terragucci.yml"), "comment_allow:\n  action: []\n");
    await expect(commentAllowAt(dir)).rejects.toThrow(/comment_allow/);
  });
});

describe("mayRun", () => {
  it("leaves a command with no list to every writer, and reads no team for it", async () => {
    const t = table({});
    expect(await mayRun(undefined, "apply", "dev", t)).toEqual({ ok: true });
    expect(await mayRun({ unlock: ["alice"] }, "apply", "dev", t)).toEqual({ ok: true });
    expect(t.reads).toEqual([]);
  });

  it("takes a listed login without a read, ignoring case", async () => {
    const t = table({});
    expect(await mayRun({ apply: ["Alice", "team:acme/x"] }, "apply", "alice", t)).toEqual({ ok: true });
    expect(t.reads).toEqual([]);
  });

  it("takes a team member and stops at the first team that holds them", async () => {
    const t = table({ "acme/a": ["x"], "acme/b": ["dev"], "acme/c": ["dev"] });
    expect(await mayRun({ apply: ["team:acme/a", "team:acme/b", "team:acme/c"] }, "apply", "dev", t)).toEqual({ ok: true });
    expect(t.reads).toEqual(["acme/a:dev", "acme/b:dev"]);
  });

  it("refuses a writer on no list and names the list", async () => {
    const d = await mayRun({ apply: ["alice", "team:acme/a"] }, "apply", "dev", table({ "acme/a": [] }));
    expect(d).toEqual({ ok: false, reason: "dev may not run `/terragucci apply` here: it is limited to `alice`, `team:acme/a` (comment_allow in terragucci.yml on the default branch)" });
  });

  it("applies default to a command that has no list of its own, and a command's own list over it", async () => {
    const allow = { default: ["team:acme/eng"], unlock: ["team:acme/ops"] };
    const t = table({ "acme/eng": ["dev"], "acme/ops": [] });
    expect(await mayRun(allow, "plan", "dev", t)).toEqual({ ok: true });
    expect((await mayRun(allow, "unlock", "dev", t)).ok).toBe(false);
  });

  it("fails, and says what to fix, when the forge cannot answer; a later team that holds the user still counts", async () => {
    const t = table({ "acme/b": ["dev"] });
    const lost = await mayRun({ apply: ["team:acme/missing"] }, "apply", "dev", t);
    expect(lost).toMatchObject({ ok: false, fail: true });
    expect((lost as { reason: string }).reason).toContain("team acme/missing does not exist");
    expect(await mayRun({ apply: ["team:acme/missing", "team:acme/b"] }, "apply", "dev", t)).toEqual({ ok: true });
  });
});

/** A forge's recorded answers by path; any other request fails the test. */
function recorded(base: string, answers: Record<string, { status: number; body?: unknown }>): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.slice(base.length);
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const a = answers[path];
    if (!a) throw new Error(`unexpected request ${path}`);
    return { ok: a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body ?? "") };
  };
  return { fetch, asked };
}

describe("team reads", () => {
  const GH = "https://api.github.com";
  it("GitHub: an active membership is a member, a pending one and a 404 are not", async () => {
    const r = recorded(GH, {
      "/orgs/acme/teams/platform": { status: 200, body: { slug: "platform" } },
      "/orgs/acme/teams/platform/memberships/dev": { status: 200, body: { state: "active" } },
      "/orgs/acme/teams/platform/memberships/invited": { status: 200, body: { state: "pending" } },
      "/orgs/acme/teams/platform/memberships/other": { status: 404, body: { message: "Not Found" } },
    });
    const t = teamReads({ kind: "github", apiBase: GH, token: "tok" }, r.fetch);
    expect(await t.member("acme/platform", "dev")).toBe(true);
    expect(await t.member("acme/platform", "invited")).toBe(false);
    expect(await t.member("acme/platform", "other")).toBe(false);
    // The team is looked up once, however many people ask.
    expect(r.asked.filter((a) => a === "GET /orgs/acme/teams/platform")).toHaveLength(1);
  });

  it("GitHub: a team the token cannot see is an unreadable team, not a non-member", async () => {
    const r = recorded(GH, { "/orgs/acme/teams/platform": { status: 404 }, "/orgs/acme/teams/locked": { status: 403 } });
    const t = teamReads({ kind: "github", apiBase: GH, token: "tok" }, r.fetch);
    await expect(t.member("acme/platform", "dev")).rejects.toThrow(/does not exist, or the token cannot see it/);
    await expect(t.member("acme/locked", "dev")).rejects.toThrow(/answered 403/);
  });

  it("Forgejo: finds the team by name in the organisation, then asks its members", async () => {
    const F = "https://forge.test/api/v1";
    const r = recorded(F, {
      "/orgs/acme/teams/search?q=platform&limit=50": { status: 200, body: { ok: true, data: [{ id: 9, name: "Platform" }, { id: 10, name: "platform-x" }] } },
      "/teams/9/members/dev": { status: 200, body: {} },
      "/teams/9/members/other": { status: 404 },
      "/orgs/acme/teams/search?q=ghost&limit=50": { status: 200, body: { ok: true, data: [] } },
    });
    const t = teamReads({ kind: "forgejo", apiBase: F, token: "tok" }, r.fetch);
    expect(await t.member("acme/platform", "dev")).toBe(true);
    expect(await t.member("acme/platform", "other")).toBe(false);
    await expect(t.member("acme/ghost", "dev")).rejects.toThrow(/acme has no team named ghost/);
  });

  it("GitLab: a group's members, inherited ones included, found by the user's id", async () => {
    const G = "http://gitlab/api/v4";
    const r = recorded(G, {
      "/groups/acme%2Fplatform": { status: 200, body: { id: 3 } },
      "/users?username=dev": { status: 200, body: [{ id: 11, username: "dev" }] },
      "/users?username=other": { status: 200, body: [{ id: 12, username: "other" }] },
      "/users?username=nobody": { status: 200, body: [] },
      "/groups/acme%2Fplatform/members/all/11": { status: 200, body: { state: "active", access_level: 30 } },
      "/groups/acme%2Fplatform/members/all/12": { status: 404 },
    });
    const t = teamReads({ kind: "gitlab", apiBase: G, token: "tok" }, r.fetch);
    expect(await t.member("acme/platform", "dev")).toBe(true);
    expect(await t.member("acme/platform", "other")).toBe(false);
    expect(await t.member("acme/platform", "nobody")).toBe(false);
  });
});

/** The comment event and forge of comment.test.ts, reduced to what a team limit needs. */
function github(comment: string, user = "dev", extra: Record<string, unknown> = {}): { env: NodeJS.ProcessEnv; fetch: Fetch; posts: string[] } {
  const file = join(tmp("tg-allow-event-"), "event.json");
  writeFileSync(file, JSON.stringify({ action: "created", comment: { body: comment, user: { login: user } }, issue: { number: 7, pull_request: {} }, ...extra }));
  const posts: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://forge.test/api/v1/", "");
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (init?.method === "POST") { posts.push(JSON.parse(init.body!).body); return answer(201, {}) as never; }
    if (path.includes("/permission")) return answer(200, { permission: "write" }) as never;
    if (path.includes("/pulls/")) return answer(200, { state: "open", head: { sha: "a".repeat(40), ref: "fix", repo: { full_name: "acme/infra" } }, base: { ref: "main" } }) as never;
    return answer(404, {}) as never;
  };
  return { env: { GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://forge.test/api/v1", TG_TOKEN: "t" }, fetch, posts };
}

describe("decideComment with comment_allow", () => {
  const layers = [["envs/dev/app"]];
  const event = { repository: { full_name: "acme/infra", default_branch: "main", permissions: { push: true } }, sender: { login: "dev" } };

  it("the re-plan goes for a team member and stops, with a reply, for a writer outside the team", async () => {
    const allow = { plan: ["team:acme/platform"] };
    const yes = github("/terragucci plan");
    expect((await decideComment({ layers, env: yes.env, fetch: yes.fetch, allow, teams: table({ "acme/platform": ["dev"] }) })).go).toBe(true);
    const no = github("/terragucci plan");
    const d = await decideComment({ layers, env: no.env, fetch: no.fetch, allow, teams: table({ "acme/platform": ["x"] }) });
    expect(d).toMatchObject({ go: false, reason: expect.stringContaining("dev may not run `/terragucci plan` here") });
    expect(d.fail).toBeUndefined();
    expect(no.posts).toEqual([`terragucci: ${d.reason}`]);
  });

  it("a team the token cannot read fails the job and says what to give the token", async () => {
    const s = github("/terragucci plan");
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch, allow: { plan: ["team:acme/platform"] }, teams: table({}) });
    expect(d).toMatchObject({ go: false, fail: true });
    expect(s.posts[0]).toContain("TG_TOKEN must hold a token that can read the team's members");
  });

  it("without a comment_allow the decision is what it was", async () => {
    const s = github("/terragucci plan");
    expect((await decideComment({ layers, env: s.env, fetch: s.fetch })).go).toBe(true);
  });

  it("the agent job limits `agent`; the re-plan job leaves an agent comment to it", async () => {
    const allow = { agent: ["team:acme/ml"] };
    const ask = "/terragucci agent rename the bucket";
    const no = github(ask, "dev", event);
    expect((await decideComment({ layers: [], env: no.env, fetch: no.fetch, agent: "run", allow, teams: table({ "acme/ml": [] }) })).go).toBe(false);
    expect(no.posts[0]).toContain("may not run `/terragucci agent`");
    const yes = github(ask, "dev", event);
    expect((await decideComment({ layers: [], env: yes.env, fetch: yes.fetch, agent: "run", allow, teams: table({ "acme/ml": ["dev"] }) })).go).toBe(true);
    const replan = github(ask, "dev", event);
    await decideComment({ layers, env: replan.env, fetch: replan.fetch, agent: "on", allow, teams: table({ "acme/ml": [] }) });
    expect(replan.posts.every((p) => !p.includes("may not run"))).toBe(true);
  });

  it("the action workflow limits `action`, for a comment and for a dispatch", async () => {
    const allow = { action: ["team:acme/ops"] };
    const address = "action.aws_lambda_invoke.warm";
    const no = github(`/terragucci action envs/dev/app ${address}`, "dev", event);
    expect((await decideComment({ layers, env: no.env, fetch: no.fetch, action: "run", allow, teams: table({ "acme/ops": [] }) })).go).toBe(false);
    expect(no.posts[0]).toContain("may not run `/terragucci action`");
    const yes = github(`/terragucci action envs/dev/app ${address}`, "dev", event);
    expect(await decideComment({ layers, env: yes.env, fetch: yes.fetch, action: "run", allow, teams: table({ "acme/ops": ["dev"] }) })).toMatchObject({ go: true, root: "envs/dev/app", address });
    const dispatch = github("", "dev", { ...event, inputs: { root: "envs/dev/app", address } });
    expect((await decideComment({ layers, env: { ...dispatch.env, GITHUB_EVENT_NAME: "workflow_dispatch" }, fetch: dispatch.fetch, action: "run", allow, teams: table({ "acme/ops": [] }) })).go).toBe(false);
  });

  it("Forgejo takes the same limit after its event-borne permission check", async () => {
    const s = github("/terragucci plan", "dev", { ...event, is_pull: true });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch, forge: "forgejo", allow: { plan: ["alice"] }, teams: table({}) });
    expect(d).toMatchObject({ go: false, reason: expect.stringContaining("limited to `alice`") });
  });
});

describe("the rollouts' skip-soak with comment_allow", () => {
  const answers: Record<string, unknown> = {
    "https://api.github.com/repos/acme/infra/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1": [
      { html_url: "g/7", number: 7, title: "t", state: "closed", merged_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T10:05:00Z", merge_commit_sha: "abc", body: "b", head: { ref: "terragucci/rollout/x-1.4.0/wave-1" } },
    ],
    "https://api.github.com/repos/acme/infra/issues/7/comments?per_page=100&page=1": [
      { id: 1, body: "/terragucci skip-soak", user: { login: "dana" }, created_at: "2026-03-01T11:00:00Z" },
      { id: 2, body: "/terragucci skip-soak", user: { login: "erin" }, created_at: "2026-03-01T12:00:00Z" },
    ],
    "https://api.github.com/repos/acme/infra/collaborators/dana/permission": { permission: "write" },
    "https://api.github.com/repos/acme/infra/collaborators/erin/permission": { permission: "write" },
  };
  const fetch: Fetch = async (url) => {
    const key = url.includes("/pulls?state=all&head=") ? Object.keys(answers)[0]! : url;
    return { ok: key in answers, status: key in answers ? 200 : 404, json: async () => answers[key], text: async () => JSON.stringify(answers[key] ?? []) };
  };
  const target = targetAt("github", "https://github.com", "acme/infra", "");
  const branch = "terragucci/rollout/x-1.4.0/wave-1";

  it("counts a skip only from someone on the skip-soak list or in its team", async () => {
    const forge = fetchForge(fetch, target, { allow: { "skip-soak": ["team:acme/release"] }, teams: table({ "acme/release": ["erin"] }) });
    expect(await forge.soakSkips!(branch)).toEqual([{ by: "erin", url: "g/7" }]);
  });

  it("counts none when the forge cannot read the team, and says so in the log", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void logged.push(m);
    try {
      const forge = fetchForge(fetch, target, { allow: { "skip-soak": ["team:acme/release"] }, teams: table({}) });
      expect(await forge.soakSkips!(branch)).toEqual([]);
    } finally {
      console.error = orig;
    }
    expect(logged[0]).toContain("skip-soak by dana not counted");
  });

  it("is unchanged without a list", async () => {
    expect((await fetchForge(fetch, target).soakSkips!(branch)).map((s) => s.by)).toEqual(["dana", "erin"]);
  });
});

describe("pollGitLabComments with comment_allow", () => {
  const API = "http://gitlab/api/v4";
  const NOW = new Date("2026-10-07T12:00:00Z");
  const env = { CI_API_V4_URL: API, CI_PROJECT_ID: "7", CI_DEFAULT_BRANCH: "main", TG_TOKEN: "t", CI_SERVER_URL: "http://gitlab" };
  const users: Record<string, number> = { dev: 11, ops: 14 };
  const notes: any[] = [];
  const posted: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.slice(API.length);
    const method = init?.method ?? "GET";
    const ok = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) }) as never;
    let m: RegExpExecArray | null;
    if (path === "/user") return ok({ id: 900, username: "terragucci-bot" });
    if (path.startsWith("/users?")) { const n = new URL(url).searchParams.get("username")!; return ok(users[n] ? [{ id: users[n], username: n }] : []); }
    if (path.startsWith("/projects/7/merge_requests?")) return ok([{ iid: 3, state: "opened", source_project_id: 7, target_project_id: 7, target_branch: "main", sha: "c".repeat(40) }]);
    if ((m = /^\/projects\/7\/members\/all\/(\d+)$/.exec(path))) return ok({ access_level: 30 });
    if (/^\/projects\/7\/merge_requests\/3\/notes/.test(path)) {
      if (method === "POST") { posted.push(JSON.parse(init!.body!).body); return ok({ id: 5001, body: "x", author: { id: 900, username: "terragucci-bot" } }, 201); }
      return ok(notes);
    }
    if (path === "/projects/7/merge_requests/3/pipelines" && method === "POST") return ok({ id: 77, web_url: "http://gitlab/p/77" }, 201);
    return ok({ message: `no route ${method} ${path}` }, 404);
  };
  const note = (id: number, body: string, username: string) => ({ id, body, author: { id: users[username], username }, created_at: "2026-10-07T11:58:00Z", system: false });
  const run = (allow: any, teams: TeamReads) => { posted.length = 0; return pollGitLabComments({ layers: [["envs/dev/app"]], env, fetch, now: NOW, log: memoryNoteLog(), allow, teams }); };

  it("a Developer outside the group gets the reason and no pipeline; a member of it plans", async () => {
    notes.splice(0, notes.length, note(101, "/terragucci plan", "dev"), note(102, "/terragucci plan", "ops"));
    const r = await run({ plan: ["team:acme/platform"] }, table({ "acme/platform": ["ops"] }));
    expect(r.outcomes.map((o) => [o.note, o.ran])).toEqual(expect.arrayContaining([[101, false], [102, true]]));
    expect(posted.some((p) => p.includes("dev may not run `/terragucci plan` here"))).toBe(true);
    expect(posted.filter((p) => p.includes("started pipeline"))).toHaveLength(1);
  });

  it("fails the note when the group cannot be read", async () => {
    notes.splice(0, notes.length, note(103, "/terragucci apply", "dev"));
    const r = await run({ apply: ["team:acme/platform"] }, table({}));
    expect(r.outcomes[0]).toMatchObject({ ran: false, fail: true });
    expect(r.outcomes[0]!.reason).toContain("could not read team membership");
  });
});

describe("comment_allow for chant's jobs, from the chant release that carries it", () => {
  const allow = { plan: ["team:acme/release"], apply: ["alice"], agent: ["bob"], default: ["carol"] };

  it("names the chant floor, which the pin does not yet meet, and reads versions as chant numbers them", () => {
    expect(COMMENT_ALLOW_CHANT_FLOOR).toBe("0.124.98");
    expect(CHANT_PIN).toBe(dependencies["@intentius/chant"]);
    expect(chantAtLeast("0.124.98", "0.124.98")).toBe(true);
    expect(chantAtLeast("0.124.99", "0.124.98")).toBe(true);
    expect(chantAtLeast("0.125.0", "0.124.98")).toBe(true);
    expect(chantAtLeast("1.0.0", "0.124.98")).toBe(true);
    expect(chantAtLeast("0.124.97", "0.124.98")).toBe(false);
    expect(chantAtLeast("0.124.9", "0.124.98")).toBe(false);
    expect(chantAtLeast("^0.124.98", "0.124.98")).toBe(true);
    expect(chantAtLeast("next", "0.124.98")).toBe(false);
    expect(chantCarriesCommentAllow("0.124.97")).toBe(false);
    expect(chantCarriesCommentAllow("0.124.98")).toBe(true);
  });

  it("config check accepts plan, apply, agent and default on GitHub and Forgejo at the floor, and still refuses them below it", () => {
    for (const forge of [undefined, "github", "forgejo"]) {
      const s = forge ? { forge } : {};
      expect(commentAllowForgeProblems(allow, s, "c", "0.124.98"), `${forge} at the floor`).toEqual([]);
      expect(commentAllowForgeProblems(allow, s, "c", "0.125.2"), `${forge} above`).toEqual([]);
      const below = commentAllowForgeProblems(allow, s, "c", "0.124.97");
      expect(below.map((p) => p.split(" ")[0]), `${forge} below`).toEqual(["c.plan", "c.apply", "c.agent", "c.default"]);
      expect(below[0]).toContain("chant 0.124.97 here checks write access alone for it, and chant 0.124.98 and later limit it");
    }
    expect(commentAllowForgeProblems({ apply: ["a"] }, { forge: "gitlab" }, "c", "0.124.50")).toEqual([]);
  });

  it("lock and unlock stay refused where no job reads them, and are read under apply.when: pull-request at the floor", () => {
    const lock = { lock: ["alice"], unlock: ["alice"] };
    expect(commentAllowForgeProblems(lock, {}, "c", "0.124.98")).toHaveLength(2);
    expect(commentAllowForgeProblems(lock, { locks: "plan" }, "c", "0.124.98")).toEqual([]);
    expect(commentAllowForgeProblems(lock, { apply: { when: "pull-request" } }, "c", "0.124.98")).toEqual([]);
    expect(commentAllowForgeProblems(lock, { locks: "plan", apply: { when: "pull-request" } }, "c", "0.124.98")).toEqual([]);
    expect(commentAllowForgeProblems(lock, { apply: { when: "pull-request" } }, "c", "0.124.97")).toHaveLength(2);
    expect(commentAllowForgeProblems(lock, {}, "c", "0.124.98")[0]).toContain("pr-lock job");
  });

  it("validateConfig uses the pin: a list for apply is refused today, with the version named", () => {
    expect(chantCarriesCommentAllow()).toBe(chantAtLeast(CHANT_PIN, COMMENT_ALLOW_CHANT_FLOOR));
    const run = () => validateConfig({ comment_allow: { apply: ["alice"] } }, "terragucci.yml");
    if (chantCarriesCommentAllow()) expect(run).not.toThrow();
    else expect(run).toThrow(new RegExp(`chant ${CHANT_PIN.replace(/\./g, "\\.")} here checks write access alone`));
  });

  it("hands chant the commands it answers, the team secret only when a team is named, and nothing below the floor or on GitLab", () => {
    expect(chantCommentAllow({ plan: ["team:acme/release"], apply: ["alice"], action: ["bob"], "skip-soak": ["bob"], lock: ["x"] }, {}, "0.124.98")).toEqual({ allow: { plan: ["team:acme/release"], apply: ["alice"] }, tokenSecret: "TG_TEAM_TOKEN" });
    expect(chantCommentAllow({ apply: ["alice"], lock: ["x"], unlock: ["y"] }, { apply: { when: "pull-request" } }, "0.124.98")).toEqual({ allow: { apply: ["alice"], lock: ["x"], unlock: ["y"] } });
    expect(chantCommentAllow({ default: ["carol"] }, {}, "0.124.98")).toEqual({ allow: { default: ["carol"] } });
    expect(chantCommentAllow({ action: ["bob"] }, {}, "0.124.98")).toBeUndefined();
    expect(chantCommentAllow({ apply: ["alice"] }, {}, "0.124.97")).toBeUndefined();
    expect(chantCommentAllow({ apply: ["alice"] }, { forge: "gitlab" }, "0.124.98")).toBeUndefined();
    expect(chantCommentAllow(undefined, {}, "0.124.98")).toBeUndefined();
  });

  it("passes the agent's list and the team secret to chant's agent job, and none without a list for agent", () => {
    const agent = agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", comment: {} } }, "t"))!;
    expect(chantAgentOptions(agent, { allow: { agent: ["team:acme/ai"], apply: ["x"] }, tokenSecret: "TG_TEAM_TOKEN" })).toMatchObject({ commentAllow: { agent: ["team:acme/ai"] }, commentAllowTokenEnv: "TG_TEAM_TOKEN" });
    expect(chantAgentOptions(agent, { allow: { default: ["carol"] } })).toMatchObject({ commentAllow: { default: ["carol"] } });
    expect(chantAgentOptions(agent, { allow: { default: ["carol"] } })).not.toHaveProperty("commentAllowTokenEnv");
    expect(chantAgentOptions(agent, { allow: { apply: ["x"] } })).not.toHaveProperty("commentAllow");
    expect(chantAgentOptions(agent)).not.toHaveProperty("commentAllow");
    const seen: unknown[] = [];
    const chant = {
      CI_AGENT_FLOOR: "0.124.55",
      productPipelineJobs: (_f: string, _e: string, o: { agent: Record<string, unknown> }) => (seen.push(o.agent), { agent: { comment: "/terragucci agent", name: "terragucci-agent", spec: { name: "terragucci-agent", agent: { on: "comment" } } } }),
      productDriftAgent: () => ({}),
      setActiveProductWords: () => undefined,
      generate: { github: () => ({ files: [{ name: "a.yml", yaml: "x: 1\n" }] }), gitlab: () => ({ files: [] }), forgejo: () => ({ files: [{ name: "a.yml", yaml: "x: 1\n" }] }) },
    };
    chantAgentFiles("github", "img", agent, MARKER, chant as never, { allow: { agent: ["bob"] }, tokenSecret: "TG_TEAM_TOKEN" });
    expect(seen[0]).toMatchObject({ commentAllow: { agent: ["bob"] }, commentAllowTokenEnv: "TG_TEAM_TOKEN" });
  });

  const planInput = (extra: Partial<PlanJobsInput> = {}): PlanJobsInput => ({ forge: "github", image: "img", command: "terragucci plan", env: {}, setup: [], others: [], ...extra });

  it("leaves the re-plan and the apply comment as chant wrote them without a list", () => {
    const replan = Object.fromEntries(githubPlanJobs(planInput()));
    const decide = (replan.replan!.steps as Array<{ id?: string; env?: Record<string, string> }>).find((s) => s.id === "decide")!;
    expect(decide.env).not.toHaveProperty("CHANT_COMMENT_ALLOW");
  });

  it("gives the jobs the list when chant carries it: the decision's variables in the re-plan, the comment job's in apply-comment", () => {
    const input = planInput({ commentAllow: { allow: { plan: ["team:acme/release"], apply: ["alice"] }, tokenSecret: "TG_TEAM_TOKEN" } });
    const decide = (Object.fromEntries(githubPlanJobs(input)).replan!.steps as Array<{ id?: string; env?: Record<string, string> }>).find((s) => s.id === "decide")!;
    // An installed chant older than the floor leaves the option out; the variables are there once it carries it.
    if (chantCarriesCommentAllow()) {
      expect(JSON.parse(decide.env!.CHANT_COMMENT_ALLOW!)).toEqual({ plan: ["team:acme/release"], apply: ["alice"] });
      expect(decide.env!.CHANT_COMMENT_ALLOW_TOKEN).toBe("${{ secrets.TG_TEAM_TOKEN }}");
    } else {
      expect(decide.env).not.toHaveProperty("CHANT_COMMENT_ALLOW");
    }
    expect(githubCommentJob).toBeTypeOf("function");
  });
});
