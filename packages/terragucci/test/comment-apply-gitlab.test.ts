// Apply before merge on GitLab against a recorded GitLab API: the comments
// job's checks before it starts the default branch's pipeline, the mr-apply
// job's decision, which reads everything again and trusts no variable, the
// root locks it takes, and the merge after the last wave.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appliedMarker, decideGitLabApply, mergeGitLabMR } from "../src/comment-apply-gitlab";
import type { Git } from "../src/comment-apply";
import { DEVELOPER, pollGitLabComments } from "../src/comment-gitlab";
import type { Fetch } from "../src/forge";
import { readLocks, takeLocks } from "../src/locks";
import { backend, git, tmp, write } from "./helpers";

const layers = [["network"], ["app"]];
const API = "http://gitlab/api/v4";
const NOW = new Date("2026-10-07T12:00:00Z");
const BOT = 900;

interface Call { method: string; path: string; body?: any; token?: string }

interface World {
  mrs: any[];
  notes: Record<number, any[]>;
  members?: Record<number, number>;
  versions?: Record<number, any[]>;
  statuses?: Record<string, any[]>;
  diffs?: any[];
  /** GitLab's reads of a merge request after the first, by iid: fields that change. */
  later?: Record<number, Record<string, unknown>>;
}

function gitlab(w: World): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.slice(API.length);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, token: init?.headers?.["private-token"] });
    const ok = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    let m: RegExpExecArray | null;
    if (path === "/user") return ok({ id: BOT, username: "terragucci-bot" });
    if (path.startsWith("/projects/7/merge_requests?")) return ok(w.mrs);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes\/(\d+)$/.exec(path))) {
      const n = (w.notes[Number(m[1])] ?? []).find((x) => x.id === Number(m![2]));
      return n ? ok(n) : ok({ message: "404 Not found" }, 404);
    }
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes/.exec(path))) {
      const iid = Number(m[1]);
      if (method === "POST") {
        const note = { id: 5000 + calls.length, body: body.body, author: { id: BOT, username: "terragucci-bot" }, created_at: NOW.toISOString() };
        (w.notes[iid] ??= []).unshift(note);
        return ok(note, 201);
      }
      return ok(w.notes[iid] ?? []);
    }
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/versions$/.exec(path))) return ok(w.versions?.[Number(m[1])] ?? []);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/merge$/.exec(path)) && method === "PUT") return ok({ state: "merged" });
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)(\?.*)?$/.exec(path))) {
      const iid = Number(m[1]);
      const mr = w.mrs.find((x) => x.iid === iid);
      if (!mr) return ok({ message: "404 Not found" }, 404);
      return ok(m[2] ? { ...mr, ...(w.later?.[iid] ?? {}) } : mr);
    }
    if ((m = /^\/projects\/7\/members\/all\/(\d+)$/.exec(path))) {
      const level = w.members?.[Number(m[1])];
      return level === undefined ? ok({ message: "404 Not found" }, 404) : ok({ access_level: level });
    }
    if ((m = /^\/projects\/7\/repository\/commits\/([0-9a-f]+)\/statuses/.exec(path))) return ok(w.statuses?.[m[1]] ?? []);
    if (path.startsWith("/projects/7/repository/compare?")) return ok({ diffs: w.diffs ?? [] });
    if (path === "/projects/7/pipeline" && method === "POST") return ok({ id: 88, web_url: "http://gitlab/acme/infra/-/pipelines/88" }, 201);
    return ok({ message: `no route for ${method} ${path}` }, 404);
  };
  return { fetch, calls };
}

const dev = { id: 11, username: "dev" };
const rev = { id: 14, username: "rev" };
const author = { id: 15, username: "author" };
const reporter = { id: 12, username: "reader" };
const members = { [dev.id]: DEVELOPER, [rev.id]: DEVELOPER, [author.id]: DEVELOPER, [reporter.id]: 20 };
const note = (id: number, body: string, by = dev, created_at = "2026-10-07T11:58:00Z") => ({ id, body, author: by, created_at, system: false });
const approval = (id: number, by = rev, created_at = "2026-10-07T11:50:00Z") => ({ id, body: "approved this merge request", author: by, created_at, system: true });
const version = (head: string, created_at = "2026-10-07T11:40:00Z") => [{ id: 1, head_commit_sha: head, created_at }];
const green = (head: string) => ({ [head]: [{ id: 1, name: "terragucci/plan", status: "success" }, { id: 2, name: "check", status: "success" }] });
const openMr = (iid: number, sha: string, extra: Record<string, unknown> = {}) => ({
  iid, state: "opened", source_project_id: 7, target_project_id: 7, target_branch: "main", sha, author, detailed_merge_status: "mergeable", diverged_commits_count: 0, ...extra,
});
const posts = (calls: Call[], what: RegExp) => calls.filter((c) => c.method === "POST" && what.test(c.path));
const replies = (calls: Call[]) => posts(calls, /\/notes$/).map((c) => c.body.body as string);

/** An approved, green, mergeable, up-to-date merge request 3 at HEAD, with NOTES on it. */
const ready = (head: string, notes: any[], extra: Partial<World> = {}): World => ({
  mrs: [openMr(3, head)],
  notes: { 3: [...notes, approval(50)] },
  members,
  versions: { 3: version(head) },
  statuses: green(head),
  ...extra,
});

const HEAD = "c".repeat(40);
const env = { CI_API_V4_URL: API, CI_PROJECT_ID: "7", CI_DEFAULT_BRANCH: "main", TG_TOKEN: "job-token", TG_MERGE_TOKEN: "merge-token", CI_SERVER_URL: "http://gitlab" };

describe("the comments job, with apply.when: pull-request", () => {
  const poll = (w: World, e: NodeJS.ProcessEnv = env) => {
    const api = gitlab(w);
    return { api, run: () => pollGitLabComments({ layers, env: e, fetch: api.fetch, now: NOW, when: "pull-request", wait: async () => {} }) };
  };

  it("starts a pipeline on the default branch for an approved, green, up-to-date merge request, with the merge token and the variables naming it", async () => {
    const { api, run } = poll(ready(HEAD, [note(101, "/terragucci apply")]));
    const r = await run();
    expect(r.outcomes).toEqual([expect.objectContaining({ mr: 3, note: 101, ran: true, replied: true })]);
    const started = posts(api.calls, /^\/projects\/7\/pipeline$/);
    expect(started).toHaveLength(1);
    expect(started[0].token).toBe("merge-token");
    expect(started[0].body).toEqual({
      ref: "main",
      variables: [
        { key: "TERRAGUCCI_MR", value: "3", variable_type: "env_var" },
        { key: "TERRAGUCCI_NOTE", value: "101", variable_type: "env_var" },
        { key: "TERRAGUCCI_HEAD", value: HEAD, variable_type: "env_var" },
      ],
    });
    expect(replies(api.calls)[0]).toMatch(/^terragucci: started pipeline http:\/\/gitlab\/acme\/infra\/-\/pipelines\/88 on main to apply !3's head cccccccc for dev/);
  });

  it.each([
    ["no approval", { notes: { 3: [note(101, "/terragucci apply")] } }, /!3 is not approved: no member other than its author/],
    ["an approval before the latest push", { versions: { 3: version(HEAD, "2026-10-07T11:55:00Z") } }, /!3 is not approved/],
    ["the author's own approval", { notes: { 3: [note(101, "/terragucci apply"), approval(50, author)] } }, /!3 is not approved/],
    ["a failed check", { statuses: { [HEAD]: [{ id: 1, name: "terragucci/plan", status: "success" }, { id: 2, name: "check", status: "failed" }] } }, /check failed on cccccccc/],
    ["no plan", { statuses: { [HEAD]: [{ id: 2, name: "check", status: "success" }] } }, /the plan of !3 has not passed/],
    ["a head behind main", { later: { 3: { diverged_commits_count: 2 } } }, /!3 is not up to date with main: its head cccccccc is 2 commits behind it/],
    ["conflicts", { later: { 3: { detailed_merge_status: "conflict" } } }, /GitLab reports conflicts with main/],
    ["a change to the pipeline file", { diffs: [{ old_path: ".gitlab/terragucci.yml", new_path: ".gitlab/terragucci.yml" }] }, /changes \.gitlab\/terragucci\.yml, and the apply runs the pipeline of main/],
  ] as [string, Partial<World>, RegExp][])("refuses %s by name, and starts nothing", async (_, over, says) => {
    const { api, run } = poll({ ...ready(HEAD, [note(101, "/terragucci apply")]), ...over });
    await run();
    expect(posts(api.calls, /^\/projects\/7\/pipeline$/)).toEqual([]);
    expect(replies(api.calls)[0]).toMatch(says);
  });

  it("lock and unlock on an open merge request start the same pipeline, with no requirement checked", async () => {
    const { api, run } = poll({ mrs: [openMr(3, HEAD)], notes: { 3: [note(101, "/terragucci lock")] }, members });
    await run();
    expect(posts(api.calls, /^\/projects\/7\/pipeline$/)).toHaveLength(1);
    expect(replies(api.calls)[0]).toContain("to lock the roots of !3 for dev");
  });

  it("a merged merge request has nothing left to apply, and with no merge token nothing starts", async () => {
    const merged = poll({ mrs: [{ ...openMr(4, HEAD), state: "merged" }], notes: { 4: [note(101, "/terragucci apply")] }, members });
    await merged.run();
    expect(replies(merged.api.calls)[0]).toMatch(/!4 is merged, and this project applies a merge request from its head before it merges/);
    const { TG_MERGE_TOKEN: _, ...noToken } = env;
    const bare = poll(ready(HEAD, [note(101, "/terragucci apply")]), noToken);
    const r = await bare.run();
    expect(r.outcomes[0]).toMatchObject({ fail: true, ran: false });
    expect(r.outcomes[0].reason).toMatch(/no TG_MERGE_TOKEN/);
  });

  it("with apply.when merge, lock stays unsupported and an open merge request is not applied", async () => {
    const api = gitlab({ mrs: [openMr(3, HEAD)], notes: { 3: [note(101, "/terragucci lock"), note(102, "/terragucci apply")] }, members });
    await pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW });
    expect(posts(api.calls, /^\/projects\/7\/pipeline$/)).toEqual([]);
    const said = replies(api.calls).join("\n");
    expect(said).toContain("this project applies after merge, so merge requests take no locks");
    expect(said).toContain("!3 is not merged");
  });
});

const commit = (dir: string, m: string): string => {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", m);
  return git(dir, "rev-parse", "HEAD").trim();
};

/** origin with main (two roots) and merge request 3's head, which changes network, at refs/merge-requests/3/head; and a checkout of main. */
function repos(): { work: string; head: string; git: Git } {
  const dir = tmp("tg-gl-pr-apply-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(dir, "work");
  git(dir, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  write(work, { "network/main.tf": backend("network"), "app/main.tf": backend("app") });
  commit(work, "base");
  git(work, "push", "-q", "origin", "main");
  git(work, "checkout", "-q", "-b", "feature");
  write(work, { "network/extra.tf": "# a change\n" });
  const head = commit(work, "change network");
  git(work, "push", "-q", "origin", "feature:refs/merge-requests/3/head");
  git(work, "checkout", "-q", "main");
  return { work, head, git: (args) => spawnSync("git", args, { cwd: work, encoding: "utf-8" }) as ReturnType<Git> };
}

describe("the mr-apply job's decision", () => {
  const job = (head: string, noteId = 101, named = head) => ({ ...env, TERRAGUCCI_MR: "3", TERRAGUCCI_NOTE: String(noteId), TERRAGUCCI_HEAD: named });
  const decide = (r: ReturnType<typeof repos>, w: World, e: NodeJS.ProcessEnv) => {
    const api = gitlab(w);
    return { api, run: () => decideGitLabApply({ layers, env: e, fetch: api.fetch, git: r.git, repo: r.work, wait: async () => {} }) };
  };

  it("reads the note and the merge request again, applies the head the variable names, and locks the roots it reaches", async () => {
    const r = repos();
    const { api, run } = decide(r, ready(r.head, [note(101, "/terragucci apply")]), job(r.head));
    const d = await run();
    expect(d).toMatchObject({ go: true, open: true, pr: 3, sha: r.head, base: "main" });
    expect(replies(api.calls)).toEqual([]);
    expect(readLocks(r.work).locks).toEqual({ network: expect.objectContaining({ pr: 3, by: "dev", head: r.head }) });
    // The job's own token reads; the merge token never leaves the comments and pr-merge jobs.
    expect(api.calls.every((c) => c.token === "job-token")).toBe(true);
  });

  it("refuses a variable that names another head than the merge request's, and takes no lock", async () => {
    const r = repos();
    const other = "e".repeat(40);
    const { api, run } = decide(r, ready(r.head, [note(101, "/terragucci apply")]), job(r.head, 101, other));
    const d = await run();
    expect(d.go).toBe(false);
    expect(replies(api.calls)[0]).toMatch(/this pipeline was started for the head eeeeeeee, and !3's head is .{8}, so nothing is applied/);
    expect(readLocks(r.work).locks).toEqual({});
  });

  it("runs nothing for a note that is not on the merge request, asks for no apply, or comes from below Developer", async () => {
    const r = repos();
    for (const [notes, id, says] of [
      [[note(101, "/terragucci apply")], 999, /note 999 is not a note on !3/],
      [[note(101, "/terragucci plan")], 101, /asks for no apply, lock or unlock/],
      [[note(101, "/terragucci apply", reporter)], 101, /reader is below Developer/],
    ] as [any[], number, RegExp][]) {
      const { api, run } = decide(r, ready(r.head, notes), job(r.head, id));
      const d = await run();
      expect(d.go).toBe(false);
      expect(d.reason).toMatch(says);
      expect(replies(api.calls)).toEqual([]);
    }
    expect(readLocks(r.work).locks).toEqual({});
  });

  it("checks the requirements again: a merge request that fell behind since the note is refused", async () => {
    const r = repos();
    const { api, run } = decide(r, { ...ready(r.head, [note(101, "/terragucci apply")]), later: { 3: { diverged_commits_count: 1 } } }, job(r.head));
    expect((await run()).go).toBe(false);
    expect(replies(api.calls)[0]).toMatch(/is not up to date with main/);
  });

  it("refuses a root another open merge request holds, naming it, and an unlock note releases the holder's locks", async () => {
    const r = repos();
    await takeLocks(r.work, ["network"], { pr: 5, by: "dev", at: NOW.toISOString(), head: "f".repeat(40) }, async () => true);
    const w = ready(r.head, [note(101, "/terragucci apply")]);
    w.mrs.push(openMr(5, "f".repeat(40)));
    const { api, run } = decide(r, w, job(r.head));
    expect((await run()).go).toBe(false);
    expect(replies(api.calls)[0]).toMatch(/`network` is locked by merge request !5 \(applied by dev\), so !3 is not applied/);
    // /terragucci unlock on !5 releases it.
    const unlock = gitlab({ mrs: w.mrs, notes: { 5: [note(201, "/terragucci unlock")] }, members });
    const d = await decideGitLabApply({ layers, env: { ...env, TERRAGUCCI_MR: "5", TERRAGUCCI_NOTE: "201", TERRAGUCCI_HEAD: "f".repeat(40) }, fetch: unlock.fetch, git: r.git, repo: r.work });
    expect(d.reason).toMatch(/released the locks !5 held on `network`, for dev/);
    expect(readLocks(r.work).locks).toEqual({});
  });

  it("a lock note locks the roots and applies nothing", async () => {
    const r = repos();
    const { api, run } = decide(r, { mrs: [openMr(3, r.head)], notes: { 3: [note(101, "/terragucci lock")] }, members }, job(r.head));
    const d = await run();
    expect(d.go).toBe(false);
    expect(replies(api.calls)[0]).toMatch(/locked `network` for !3 at .{8}, for dev; nothing was applied/);
    expect(readLocks(r.work).locks.network).toMatchObject({ pr: 3, via: "lock" });
  });
});

describe("the merge after the last wave (GitLab)", () => {
  const merging = (w: World, sha: string) => {
    const api = gitlab(w);
    const r = repos();
    return { api, run: () => mergeGitLabMR({ pr: 3, sha, env: { ...env, CI_PIPELINE_ID: "88" }, fetch: api.fetch, repo: r.work }) };
  };

  it("merges, with the merge token and the head as sha, once the job's own reply says every wave applied in this pipeline", async () => {
    const w = ready(HEAD, [{ id: 300, body: `terragucci: applied wave 1, 2 of !3 ${appliedMarker(HEAD, "88")}`, author: { id: BOT }, created_at: NOW.toISOString() }]);
    const { api, run } = merging(w, HEAD);
    expect(await run()).toBe("merged !3 at cccccccc");
    const merge = api.calls.find((c) => c.method === "PUT");
    expect(merge).toMatchObject({ path: "/projects/7/merge_requests/3/merge", body: { sha: HEAD }, token: "merge-token" });
  });

  it("merges nothing when no reply of the job's own says so: another pipeline's, or one written by someone else", async () => {
    for (const n of [
      { id: 300, body: appliedMarker(HEAD, "87"), author: { id: BOT } },
      { id: 301, body: appliedMarker(HEAD, "88"), author: { id: dev.id } },
    ]) {
      const { api, run } = merging(ready(HEAD, [n]), HEAD);
      expect(await run()).toMatch(/^nothing to merge/);
      expect(api.calls.find((c) => c.method === "PUT")).toBeUndefined();
    }
  });

  it("refuses a head that moved, and a merge request with no approval after its latest push", async () => {
    const marked = { id: 300, body: appliedMarker(HEAD, "88"), author: { id: BOT } };
    await expect(merging({ ...ready("d".repeat(40), [marked]) }, HEAD).run()).rejects.toThrow(/moved after it applied/);
    await expect(merging({ ...ready(HEAD, [marked]), notes: { 3: [marked] } }, HEAD).run()).rejects.toThrow(/no member other than its author approved it/);
  });
});
