// The GitLab comments poll against a recorded GitLab API: who may ask, the
// reply marker that keeps a note from being answered twice, the merge request
// pipeline a plan starts, and the apply job an apply retries.
import { describe, expect, it } from "vitest";
import { DEVELOPER, noteMarker, pollGitLabComments } from "../src/comment-gitlab";
import { planJobMarker, planNoteBody, planStatus } from "../src/plan-note-gitlab";
import type { Fetch } from "../src/forge";

const layers = [["network"], ["envs/dev/app", "envs/prod/app"]];
const API = "http://gitlab/api/v4";
const NOW = new Date("2026-10-07T12:00:00Z");
const BOT = 900;
const MERGE = "a".repeat(40);
const LATER = "b".repeat(40);
const env = { CI_API_V4_URL: API, CI_PROJECT_ID: "7", CI_DEFAULT_BRANCH: "main", TG_TOKEN: "t", CI_SERVER_URL: "http://gitlab" };

interface Call { method: string; path: string; body?: any }

interface World {
  mrs: any[];
  notes: Record<number, any[]>;
  members?: Record<number, number>;
  pipelines?: readonly any[];
  jobs?: Record<number, readonly any[]>;
  statuses?: Record<string, any[]>;
  /** Each merge request's pipelines, as GET /merge_requests/:iid/pipelines answers. */
  mrPipelines?: Record<number, readonly any[]>;
  /** Each job's artifact files, by path. */
  artifacts?: Record<number, Record<string, string>>;
  fail?: RegExp;
}

/** A GitLab API holding WORLD; it records each call and keeps the notes it is sent. */
function gitlab(w: World): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.slice(API.length);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const ok = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (w.fail?.test(`${method} ${path}`)) return ok({ message: "boom" }, 500);
    const q = new URL(url).searchParams;
    let m: RegExpExecArray | null;
    if (path === "/user") return ok({ id: BOT, username: "terragucci-bot" });
    if (path.startsWith("/projects/7/merge_requests?")) return ok(w.mrs);
    if ((m = /^\/projects\/7\/jobs\/(\d+)\/artifacts\/(.+)$/.exec(path))) {
      const file = w.artifacts?.[Number(m[1])]?.[m[2]];
      return file === undefined ? ok({ message: "404 Not found" }, 404) : { ok: true, status: 200, json: async () => { throw new Error("not JSON"); }, text: async () => file };
    }
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes\/(\d+)$/.exec(path)) && method === "PUT") {
      const id = Number(m[2]);
      const n = (w.notes[Number(m[1])] ?? []).find((x) => x.id === id);
      if (n) n.body = body.body;
      return ok(n ?? {});
    }
    if ((m = /^\/projects\/7\/statuses\/([0-9a-f]{40})$/.exec(path)) && method === "POST") return ok({ id: 1, name: body.name, status: body.state }, 201);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/pipelines$/.exec(path)) && method === "GET") return ok(w.mrPipelines?.[Number(m[1])] ?? []);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes/.exec(path))) {
      const iid = Number(m[1]);
      if (method === "POST") {
        const note = { id: 5000 + calls.length, body: body.body, author: { id: BOT, username: "terragucci-bot" }, created_at: NOW.toISOString() };
        (w.notes[iid] ??= []).unshift(note);
        return ok(note, 201);
      }
      return ok(w.notes[iid] ?? []);
    }
    if ((m = /^\/projects\/7\/members\/all\/(\d+)$/.exec(path))) {
      const level = w.members?.[Number(m[1])];
      return level === undefined ? ok({ message: "404 Not found" }, 404) : ok({ access_level: level });
    }
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/pipelines$/.exec(path)) && method === "POST") return ok({ id: 77, web_url: `http://gitlab/acme/infra/-/pipelines/77` }, 201);
    if (path.startsWith("/projects/7/pipelines?")) {
      const all = w.pipelines ?? [];
      const sha = q.get("sha");
      return ok(sha ? all.filter((p) => p.sha === sha) : all);
    }
    if ((m = /^\/projects\/7\/pipelines\/(\d+)\/jobs/.exec(path))) return ok(w.jobs?.[Number(m[1])] ?? []);
    if ((m = /^\/projects\/7\/repository\/commits\/([0-9a-f]+)\/statuses/.exec(path))) return ok(w.statuses?.[m[1]] ?? []);
    if ((m = /^\/projects\/7\/jobs\/(\d+)\/retry$/.exec(path)) && method === "POST") return ok({ id: 9000 + Number(m[1]), web_url: `http://gitlab/acme/infra/-/jobs/${9000 + Number(m[1])}` }, 201);
    return ok({ message: `no route for ${method} ${path}` }, 404);
  };
  return { fetch, calls };
}

const dev = { id: 11, username: "dev" };
const reporter = { id: 12, username: "reader" };
const note = (id: number, body: string, author = dev, created_at = "2026-10-07T11:58:00Z") => ({ id, body, author, created_at, system: false });
const openMr = (iid = 3, extra: Record<string, unknown> = {}) => ({ iid, state: "opened", source_project_id: 7, target_project_id: 7, target_branch: "main", sha: "c".repeat(40), ...extra });
const mergedMr = (iid = 4, extra: Record<string, unknown> = {}) => ({ iid, state: "merged", source_project_id: 7, target_project_id: 7, target_branch: "main", merge_commit_sha: MERGE, sha: "d".repeat(40), ...extra });
const members = { [dev.id]: DEVELOPER, [reporter.id]: 20 };
const poll = (w: World) => {
  const api = gitlab(w);
  return { api, run: () => pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW }) };
};
const posts = (calls: Call[], what: RegExp) => calls.filter((c) => c.method === "POST" && what.test(c.path));
const replies = (calls: Call[]) => posts(calls, /\/notes$/).map((c) => c.body.body as string);

describe("pollGitLabComments: plan", () => {
  it("a Developer's /terragucci plan on an open merge request starts its pipeline, and the reply carries the note's marker", async () => {
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan")] }, members });
    const r = await run();
    expect(r.fail).toBeUndefined();
    expect(r.outcomes).toEqual([expect.objectContaining({ mr: 3, note: 101, ran: true, replied: true })]);
    expect(posts(api.calls, /\/merge_requests\/3\/pipelines$/)).toHaveLength(1);
    expect(replies(api.calls)[0]).toMatch(/^terragucci: started pipeline http:\/\/gitlab\/acme\/infra\/-\/pipelines\/77 to re-plan !3 for dev/);
    expect(replies(api.calls)[0]).toContain(noteMarker(101));
  });

  it("answers a note once: a second poll finds the marker and starts nothing", async () => {
    const w: World = { mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan")] }, members };
    const first = poll(w);
    await first.run();
    const second = poll(w);
    const r = await second.run();
    expect(r.outcomes).toEqual([]);
    expect(posts(second.api.calls, /./)).toEqual([]);
  });

  it("counts only the job's own marker: one a person wrote answers nothing", async () => {
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(102, `nope ${noteMarker(101)}`), note(101, "/terragucci plan")] }, members });
    await run();
    expect(posts(api.calls, /\/pipelines$/)).toHaveLength(1);
  });

  it("a Reporter, or someone who is not a member, gets no reply and nothing runs", async () => {
    const stranger = { id: 13, username: "stranger" };
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan", reporter), note(102, "/terragucci plan", stranger)] }, members });
    const r = await run();
    expect(r.outcomes.map((o) => [o.ran, o.replied])).toEqual([[false, false], [false, false]]);
    expect(r.outcomes[0].reason).toMatch(/reader is below Developer/);
    expect(r.outcomes[1].reason).toMatch(/stranger is not a member/);
    expect(posts(api.calls, /./)).toEqual([]);
  });

  it("refuses a root that is not one of the pipeline's, and starts nothing", async () => {
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan envs/qa/app")] }, members });
    await run();
    expect(posts(api.calls, /\/pipelines$/)).toEqual([]);
    expect(replies(api.calls)[0]).toMatch(/envs\/qa\/app is not a root of this repository\. The roots are `envs\/dev\/app`, `envs\/prod\/app`, `network`/);
  });

  it("plans the whole merge request for a root that is one, and says so", async () => {
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan network")] }, members });
    await run();
    expect(posts(api.calls, /\/pipelines$/)).toHaveLength(1);
    expect(replies(api.calls)[0]).toMatch(/GitLab re-plans every root the merge request reaches, `network` among them/);
  });

  it("refuses a fork's merge request and a closed one", async () => {
    const { api, run } = poll({ mrs: [openMr(3, { source_project_id: 8 }), openMr(5, { state: "closed" })], notes: { 3: [note(101, "/terragucci plan")], 5: [note(102, "/terragucci plan")] }, members });
    await run();
    expect(posts(api.calls, /\/pipelines$/)).toEqual([]);
    expect(replies(api.calls)).toEqual([expect.stringMatching(/from a fork is not re-planned/), expect.stringMatching(/!5 is not open/)]);
  });

  it("leaves notes alone that are not commands, system notes, and notes older than the window", async () => {
    const old = note(103, "/terragucci plan", dev, "2026-10-05T00:00:00Z");
    const { api, run } = poll({ mrs: [openMr()], notes: { 3: [note(101, "looks good"), { ...note(102, "/terragucci plan"), system: true }, old] }, members });
    expect((await run()).outcomes).toEqual([]);
    expect(posts(api.calls, /./)).toEqual([]);
  });

  it("answers refused commands with the reason, and, applying after merge, unlock, lock and agent as unsupported", async () => {
    const { api, run } = poll({
      mrs: [openMr()],
      notes: { 3: [note(101, "/terragucci approve"), note(102, "/terragucci unlock", dev, "2026-10-07T11:58:01Z"), note(103, "/terragucci lock", dev, "2026-10-07T11:58:02Z"), note(104, "/terragucci agent rename it", dev, "2026-10-07T11:58:03Z")] },
      members,
    });
    await run();
    const r = replies(api.calls);
    expect(r[0]).toMatch(/a comment never runs `approve`/);
    expect(r[1]).toMatch(/`\/terragucci unlock` does not run here: this project applies after merge/);
    expect(r[2]).toMatch(/`\/terragucci lock` does not run here/);
    expect(r[3]).toMatch(/the agent command is off in this project; `agent\.comment` in terragucci\.yml turns it on/);
    expect(posts(api.calls, /\/pipelines$|\/retry$/)).toEqual([]);
  });

  it("fails the poll when GitLab will not list the merge requests, and a member check that breaks fails the note", async () => {
    expect((await poll({ mrs: [], notes: {}, fail: /merge_requests\?/ }).run()).fail).toMatch(/could not list the merge requests/);
    const r = await poll({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan")] }, members, fail: /members/ }).run();
    expect(r.outcomes[0]).toMatchObject({ fail: true, ran: false });
  });

  it("needs GitLab's job variables and the token", async () => {
    await expect(pollGitLabComments({ layers, env: {}, fetch: gitlab({ mrs: [], notes: {} }).fetch })).rejects.toThrow(/CI_API_V4_URL, CI_PROJECT_ID, CI_DEFAULT_BRANCH and TG_TOKEN/);
  });
});

describe("pollGitLabComments: apply", () => {
  const pipelines = [{ id: 40, sha: MERGE, ref: "main", source: "push" }];
  const jobs = (w1: string, w2: string) => ({ 40: [{ id: 401, name: "apply-wave-1", status: w1 }, { id: 402, name: "apply-wave-2", status: w2 }, { id: 400, name: "check", status: "success" }] });

  it("retries the first apply job of the merge commit's pipeline that did not succeed", async () => {
    const { api, run } = poll({ mrs: [mergedMr()], notes: { 4: [note(201, "/terragucci apply")] }, members, pipelines, jobs: jobs("success", "failed") });
    const r = await run();
    expect(r.outcomes[0]).toMatchObject({ ran: true, replied: true });
    expect(posts(api.calls, /\/retry$/).map((c) => c.path)).toEqual(["/projects/7/jobs/402/retry"]);
    expect(api.calls.some((c) => c.path.includes(`pipelines?sha=${MERGE}&ref=main&source=push`))).toBe(true);
    expect(replies(api.calls)[0]).toMatch(/retried apply-wave-2 of !4's merge commit aaaaaaaa \(http:\/\/gitlab\/acme\/infra\/-\/jobs\/9402\) for dev; its gate decides again/);
  });

  it("takes the squash commit, or the head of a fast-forward merge, when there is no merge commit", async () => {
    const { api, run } = poll({ mrs: [mergedMr(4, { merge_commit_sha: null, squash_commit_sha: MERGE })], notes: { 4: [note(201, "/terragucci apply")] }, members, pipelines, jobs: jobs("failed", "skipped") });
    await run();
    expect(posts(api.calls, /\/retry$/).map((c) => c.path)).toEqual(["/projects/7/jobs/401/retry"]);
  });

  it("refuses an open merge request, a closed one, a named wave and one merged elsewhere, and retries nothing", async () => {
    const { api, run } = poll({
      mrs: [openMr(3), mergedMr(4, { state: "closed" }), mergedMr(5), mergedMr(6, { target_branch: "release" })],
      notes: { 3: [note(201, "/terragucci apply")], 4: [note(202, "/terragucci apply")], 5: [note(203, "/terragucci apply wave-2")], 6: [note(204, "/terragucci apply")] },
      members, pipelines, jobs: jobs("failed", "skipped"),
    });
    await run();
    expect(posts(api.calls, /\/retry$/)).toEqual([]);
    expect(replies(api.calls)).toEqual([
      expect.stringMatching(/!3 is not merged/),
      expect.stringMatching(/!4 was closed without merging/),
      expect.stringMatching(/`wave-2` cannot stop them; write `\/terragucci apply`/),
      expect.stringMatching(/!6 was merged into release, not the default branch main/),
    ]);
  });

  it("refuses a merge commit a later apply superseded, naming that run", async () => {
    const { api, run } = poll({
      mrs: [mergedMr()], notes: { 4: [note(201, "/terragucci apply")] }, members,
      pipelines: [{ id: 41, sha: LATER, ref: "main" }, ...pipelines], jobs: jobs("success", "failed"),
      statuses: { [LATER]: [{ name: "terragucci/apply", status: "success", target_url: "http://gitlab/acme/infra/-/pipelines/41" }] },
    });
    await run();
    expect(posts(api.calls, /\/retry$/)).toEqual([]);
    expect(replies(api.calls)[0]).toMatch(/a later apply already ran on main at bbbbbbbb \(http:\/\/gitlab\/acme\/infra\/-\/pipelines\/41\), so the merge commit aaaaaaaa of !4 is not applied/);
  });

  it("says so when every wave applied, a wave is still running, or no pipeline ran at the merge commit", async () => {
    for (const [w, want] of [
      [{ pipelines, jobs: jobs("success", "success") }, /every wave of !4's merge commit aaaaaaaa already applied/],
      [{ pipelines, jobs: jobs("success", "running") }, /apply-wave-2 at aaaaaaaa is running already/],
      [{ pipelines: [] }, /no pipeline ran on main at the merge commit aaaaaaaa of !4/],
    ] as const) {
      const { api, run } = poll({ mrs: [mergedMr()], notes: { 4: [note(201, "/terragucci apply")] }, members, ...w });
      await run();
      expect(posts(api.calls, /\/retry$/)).toEqual([]);
      expect(replies(api.calls)[0]).toMatch(want);
    }
  });

  it("a Reporter's apply retries nothing and gets no reply", async () => {
    const { api, run } = poll({ mrs: [mergedMr()], notes: { 4: [note(201, "/terragucci apply", reporter)] }, members, pipelines, jobs: jobs("failed", "skipped") });
    await run();
    expect(posts(api.calls, /./)).toEqual([]);
  });
});

describe("pollGitLabComments: the plan note (gitlab.token: protected)", () => {
  const HEAD = "c".repeat(40);
  const poll = (w: World, planNotes = true) => {
    const api = gitlab(w);
    return { api, run: () => pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW, planNotes }) };
  };

  it("posts no plan note without --plan-notes: by default the plan job posts its own", async () => {
    const w = planned();
    const { api, run } = poll(w, false);
    const r = await run();
    expect(r.plans).toEqual([]);
    expect(posts(api.calls, /./)).toEqual([]);
    expect(api.calls.some((c) => /\/artifacts\//.test(c.path))).toBe(false);
  });
  const planned = (jobStatus = "success", files: Record<string, string> = {
    "terragucci-report/plan-note.md": "<!-- terragucci:plan roots=network -->\n## Plan\n1 to change\n",
    "terragucci-report/plan-status.txt": "success 1 roots, 1 groups, 0 destroys\n",
  }): World => ({
    mrs: [openMr()],
    notes: { 3: [] },
    members,
    mrPipelines: { 3: [{ id: 60, sha: "e".repeat(40) }, { id: 61, sha: HEAD }] },
    jobs: { 61: [{ id: 501, name: "check", status: "success" }, { id: 502, name: "plan", status: jobStatus, web_url: "http://gitlab/acme/infra/-/jobs/502" }] },
    artifacts: { 502: files },
  });

  it("posts the head's plan job's status and then its note, which names the job", async () => {
    const w = planned();
    const { api, run } = poll(w);
    const r = await run();
    expect(r.plans).toEqual([expect.objectContaining({ mr: 3, posted: true })]);
    const status = posts(api.calls, /\/statuses\//);
    expect(status.map((c) => [c.path, c.body])).toEqual([[`/projects/7/statuses/${HEAD}`, { name: "terragucci/plan", state: "success", description: "1 roots, 1 groups, 0 destroys", pipeline_id: 61, target_url: "http://gitlab/acme/infra/-/jobs/502" }]]);
    const note = w.notes[3][0].body as string;
    expect(note).toBe(`<!-- terragucci:plan roots=network -->\n## Plan\n1 to change\n\n${planJobMarker(502)}`);
    // The status before the note: the note is the cursor.
    expect(api.calls.findIndex((c) => /\/statuses\//.test(c.path))).toBeLessThan(api.calls.findIndex((c) => c.method === "POST" && /\/notes$/.test(c.path)));
  });

  it("posts once per plan job: the next poll finds the job in the note and posts nothing", async () => {
    const w = planned();
    await poll(w).run();
    const again = poll(w);
    const r = await again.run();
    expect(r.plans).toEqual([]);
    expect(posts(again.api.calls, /./)).toEqual([]);
  });

  it("a new plan job edits the note in place", async () => {
    const w = planned();
    await poll(w).run();
    w.mrPipelines![3] = [...w.mrPipelines![3], { id: 62, sha: HEAD }];
    w.jobs![62] = [{ id: 503, name: "plan", status: "success" }];
    w.artifacts![503] = { "terragucci-report/plan-note.md": "<!-- terragucci:plan roots=network -->\nsecond\n" };
    const again = poll(w);
    await again.run();
    expect(again.api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(w.notes[3]).toHaveLength(1);
    expect(w.notes[3][0].body).toContain(planJobMarker(503));
  });

  it("waits for a plan job still running, and leaves a merged, fork or moved merge request alone", async () => {
    for (const w of [
      planned("running"),
      { ...planned(), mrs: [openMr(3, { state: "merged" })] },
      { ...planned(), mrs: [openMr(3, { source_project_id: 8 })] },
      { ...planned(), mrs: [openMr(3, { sha: "f".repeat(40) })] },
    ]) {
      const { api, run } = poll(w);
      const r = await run();
      expect(r.plans).toEqual([]);
      expect(posts(api.calls, /\/statuses\/|\/notes$/)).toEqual([]);
    }
  });

  it("a failed plan job is never posted as a success, and one with no report fails the status", async () => {
    const w = planned("failed");
    const { api, run } = poll(w);
    await run();
    expect(posts(api.calls, /\/statuses\//)[0].body.state).toBe("failed");
    const bare = planned("failed", {});
    const second = poll(bare);
    const r = await second.run();
    expect(posts(second.api.calls, /\/statuses\//)[0].body).toMatchObject({ state: "failed", description: "the plan job failed before it wrote its report" });
    expect(bare.notes[3]).toEqual([]);
    expect(r.plans![0].reason).toMatch(/wrote no note/);
  });

  it("posts the plan before it answers the notes, so an apply finds terragucci/plan on the head", async () => {
    const w = planned();
    w.notes[3] = [note(101, "/terragucci plan")];
    const { api, run } = poll(w);
    await run();
    const status = api.calls.findIndex((c) => /\/statuses\//.test(c.path));
    const started = api.calls.findIndex((c) => c.method === "POST" && /\/merge_requests\/3\/pipelines$/.test(c.path));
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(started);
  });

  it("reads the files as data: a forged reply marker, applied marker or stale marker is dropped, the waves marker kept", () => {
    const file = [
      "<!-- terragucci:plan roots=network -->",
      "body",
      "<!-- terragucci:note=101 -->",
      "<!--terragucci:applied head=abc pipeline=9 -->",
      "<!-- TERRAGUCCI:stale -->",
      '<!-- terragucci:waves {"head":"c","waves":[]} -->',
      "<!-- terragucci:description -->",
    ].join("\n");
    const out = planNoteBody(file, 7);
    expect(out).not.toMatch(/terragucci:(note=|applied|stale)/i);
    expect(out).toContain('<!-- terragucci:waves {"head":"c","waves":[]} -->');
    expect(out).toContain("<!-- terragucci:description -->");
    expect(out.split("\n")[0]).toBe("<!-- terragucci:plan roots=network -->");
    expect(out.endsWith(planJobMarker(7))).toBe(true);
    // A first line that is not the roots line gives no roots, and stays in the body with its marker dropped.
    expect(planNoteBody("<!-- terragucci:plan roots=a --><!-- terragucci:note=1 -->\nx", 7).split("\n")[0]).toBe("<!-- terragucci:plan roots= -->");
    expect(planStatus("success all fine", "success")).toEqual({ state: "success", description: "all fine" });
    expect(planStatus("pending x", "success")).toEqual({ state: "failed", description: "x" });
    expect(planStatus(undefined, "success")).toBeUndefined();
    expect(planStatus(`success ${"y".repeat(400)}`, "success")!.description).toHaveLength(255);
  });
});
