// The agent comment and the model review on GitLab (gitlab-agent.ts): the
// comments poll starting their pipelines, the agent's ask read again, the push
// of its change, the review note, and the review a wave reads.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pollGitLabComments, noteMarker } from "../src/comment-gitlab";
import { validateConfig } from "../src/config";
import { AGENT_HEAD_VAR, AGENT_MR_VAR, AGENT_NOTE_VAR, gitlabReviewOf, postGitLabReview, pushGitLabAgentChange, readGitLabAgentAsk, REVIEW_HEAD_VAR, REVIEW_MR_VAR, type GitLabReviewCalls } from "../src/gitlab-agent";
import { gitlabApi } from "../src/comment-apply-gitlab";
import { gitlabCleanEnv } from "../src/render-agent";
import { reviewMarker } from "../src/review-agent";
import type { Fetch } from "../src/forge";
import { git, tmp } from "./helpers";

const layers = [["app"]];
const API = "http://gitlab/api/v4";
const NOW = new Date("2026-10-07T12:00:00Z");
const BOT = 900;
const HEAD = "c".repeat(40);
const env = { CI_API_V4_URL: API, CI_PROJECT_ID: "7", CI_DEFAULT_BRANCH: "main", TG_TOKEN: "t", CI_JOB_TOKEN: "job-token", CI_SERVER_URL: "http://gitlab", CI_PIPELINE_ID: "300" };

interface Call { method: string; path: string; body?: any }
interface World {
  mrs: any[];
  notes: Record<number, any[]>;
  members?: Record<number, number>;
  mrPipelines?: Record<number, any[]>;
  jobs?: Record<number, any[]>;
  job?: Record<number, any>;
  artifacts?: Record<number, Record<string, string>>;
  project?: any;
}

function gitlab(w: World): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.slice(API.length);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const ok = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => (typeof b === "string" ? b : JSON.stringify(b)) });
    let m: RegExpExecArray | null;
    if (path === "/user") return ok({ id: BOT, username: "terragucci-bot" });
    if (path === "/projects/7") return ok(w.project ?? { id: 7, default_branch: "main" });
    if (path === "/projects/7/trigger/pipeline" && method === "POST") return ok({ id: 88, web_url: "http://gitlab/acme/infra/-/pipelines/88" }, 201);
    if (path.startsWith("/projects/7/merge_requests?")) return ok(w.mrs);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)$/.exec(path))) return ok(w.mrs.find((x) => x.iid === Number(m![1])) ?? { message: "404" }, w.mrs.some((x) => x.iid === Number(m![1])) ? 200 : 404);
    if ((m = /^\/projects\/7\/jobs\/(\d+)\/artifacts\/(.+)$/.exec(path))) {
      const file = w.artifacts?.[Number(m[1])]?.[m[2]];
      return file === undefined ? ok({ message: "404 Not found" }, 404) : ok(file);
    }
    if ((m = /^\/projects\/7\/jobs\/(\d+)$/.exec(path))) return w.job?.[Number(m[1])] ? ok(w.job[Number(m[1])]) : ok({ message: "404" }, 404);
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes\/(\d+)$/.exec(path))) {
      const n = (w.notes[Number(m[1])] ?? []).find((x) => x.id === Number(m![2]));
      if (method === "PUT" && n) n.body = body.body;
      return n ? ok(n) : ok({ message: "404" }, 404);
    }
    if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/pipelines/.exec(path))) return ok(w.mrPipelines?.[Number(m[1])] ?? []);
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
    if ((m = /^\/projects\/7\/pipelines\/(\d+)\/jobs/.exec(path))) return ok(w.jobs?.[Number(m[1])] ?? []);
    return ok({ message: `no route for ${method} ${path}` }, 404);
  };
  return { fetch, calls };
}

const dev = { id: 11, username: "dev" };
const reporter = { id: 12, username: "reader" };
const members = { [dev.id]: 30, [reporter.id]: 20 };
const note = (id: number, body: string, author = dev, created_at = "2026-10-07T11:58:00Z") => ({ id, body, author, created_at, system: false });
const openMr = (iid = 3, extra: Record<string, unknown> = {}) => ({ iid, state: "opened", source_project_id: 7, target_project_id: 7, target_branch: "main", source_branch: "change", sha: HEAD, title: "Tidy app", description: "Tidies app.", ...extra });
const posts = (calls: Call[], what: RegExp) => calls.filter((c) => (c.method === "POST" || c.method === "PUT") && what.test(c.path));

describe("the comments poll starts the agent", () => {
  it("off: a /terragucci agent note is answered that agent.comment is off, and nothing starts", async () => {
    const api = gitlab({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci agent rename it")] }, members });
    const r = await pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW });
    expect(r.outcomes[0].reason).toMatch(/the agent command is off in this project/);
    expect(posts(api.calls, /trigger/)).toEqual([]);
  });

  it("on: a Developer's ask starts a default-branch pipeline with the job token and the merge request, note and head, and the reply carries the marker", async () => {
    const api = gitlab({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci agent rename it")] }, members });
    const r = await pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW, agent: true });
    expect(r.outcomes).toEqual([expect.objectContaining({ mr: 3, note: 101, ran: true, replied: true })]);
    const [start] = posts(api.calls, /\/trigger\/pipeline$/);
    expect(start.body).toEqual({ token: "job-token", ref: "main", variables: { [AGENT_MR_VAR]: "3", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: HEAD } });
    const reply = posts(api.calls, /\/notes$/)[0].body.body as string;
    expect(reply).toMatch(/^terragucci: started pipeline http:\/\/gitlab\/acme\/infra\/-\/pipelines\/88 on main to run the agent on !3's head cccccccc for dev/);
    expect(reply).toContain("pushes what the agent changes to `change`");
    expect(reply).toContain(noteMarker(101));
  });

  it("on: a Reporter gets no reply, and a fork's or closed merge request is refused, and nothing starts", async () => {
    const api = gitlab({
      mrs: [openMr(3), openMr(4, { source_project_id: 8 }), openMr(5, { state: "closed" })],
      notes: { 3: [note(101, "/terragucci agent rename it", reporter)], 4: [note(102, "/terragucci agent rename it")], 5: [note(103, "/terragucci agent rename it")] },
      members,
    });
    const r = await pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW, agent: true });
    expect(r.outcomes.map((o) => o.reason)).toEqual([
      expect.stringMatching(/reader is below Developer/),
      expect.stringMatching(/from a fork gets no agent/),
      expect.stringMatching(/!5 is not open/),
    ]);
    expect(posts(api.calls, /trigger/)).toEqual([]);
  });
});

describe("readGitLabAgentAsk: the agent's pipeline reads the ask again", () => {
  const vars = { ...env, [AGENT_MR_VAR]: "3", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: HEAD };
  const ask = (w: World, e: NodeJS.ProcessEnv = vars) => readGitLabAgentAsk(gitlabApi(e, "t", gitlab(w).fetch), e);

  it("goes for a Developer's ask on the head the note was answered on", async () => {
    const d = await ask({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci agent rename it")] }, members });
    expect(d).toEqual(expect.objectContaining({ go: true, pr: 3, sha: HEAD, head: "change", ask: "rename it", user: "dev" }));
  });

  it("stops when the merge request moved, the note is not an ask, or its author is below Developer", async () => {
    expect((await ask({ mrs: [openMr(3, { sha: "d".repeat(40) })], notes: { 3: [note(101, "/terragucci agent rename it")] }, members })).reason).toMatch(/!3 moved from cccccccc to dddddddd/);
    expect((await ask({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci plan")] }, members })).reason).toMatch(/is not a `\/terragucci agent <ask>`/);
    expect((await ask({ mrs: [openMr()], notes: { 3: [note(101, "/terragucci agent rename it", reporter)] }, members })).reason).toMatch(/reader is below Developer/);
    expect((await ask({ mrs: [openMr(3, { source_branch: "main" })], notes: { 3: [note(101, "/terragucci agent rename it")] }, members })).reason).toMatch(/source branch is the default branch/);
  });

  it("fails on variables that name nothing", async () => {
    const d = await ask({ mrs: [], notes: {} }, { ...env, [AGENT_MR_VAR]: "3; rm", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: HEAD });
    expect(d).toEqual(expect.objectContaining({ go: false, fail: true }));
  });
});

describe("pushGitLabAgentChange: the agent-push job", () => {
  /** A bare origin at <server>/acme/infra.git with main, and the merge request's head at refs/merge-requests/3/head on branch change. */
  function origin(): { server: string; bare: string; work: string; head: string } {
    const server = tmp("tg-gl-server-");
    const bare = join(server, "acme", "infra.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = tmp("tg-gl-seed-");
    git(seed, "init", "-q", "-b", "main");
    mkdirSync(join(seed, "app"));
    writeFileSync(join(seed, "app", "rev.txt"), "1\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "main");
    git(seed, "remote", "add", "origin", bare);
    git(seed, "push", "-q", "origin", "main");
    writeFileSync(join(seed, "app", "rev.txt"), "2\n");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "change");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/change", "HEAD:refs/merge-requests/3/head");
    const head = git(seed, "rev-parse", "HEAD").trim();
    // The job's checkout: the default branch.
    const work = tmp("tg-gl-work-");
    git(work, "clone", "-q", bare, ".");
    return { server, bare, work, head };
  }
  function change(patchFrom: (dir: string) => void, rc = "0"): string {
    const dir = tmp("tg-gl-change-");
    writeFileSync(join(dir, "rc"), `${rc}\n`);
    patchFrom(dir);
    return dir;
  }

  it("applies the agent's patch on the merge request's head, pushes it to the source branch and replies with the commit", async () => {
    const o = origin();
    const patch = change((dir) => {
      const scratch = tmp("tg-gl-agent-");
      git(scratch, "clone", "-q", o.bare, ".");
      git(scratch, "fetch", "-q", "origin", "refs/merge-requests/3/head");
      git(scratch, "checkout", "-q", "--detach", o.head);
      writeFileSync(join(scratch, "app", "rev.txt"), "3\n");
      git(scratch, "add", "-A");
      writeFileSync(join(dir, "change.patch"), git(scratch, "diff", "--cached", "--binary", o.head));
    });
    const w: World = { mrs: [openMr(3, { sha: o.head })], notes: { 3: [note(101, "/terragucci agent set rev to 3")] }, members };
    const api = gitlab(w);
    const e = { ...env, [AGENT_MR_VAR]: "3", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: o.head, CI_SERVER_URL: o.server, CI_PROJECT_PATH: "acme/infra", CI_PROJECT_URL: "http://gitlab/acme/infra", GIT_CONFIG_GLOBAL: "/dev/null" };
    const r = await pushGitLabAgentChange({ change: patch, cwd: o.work, env: e, fetch: api.fetch });
    expect(r.pushed, r.reason).toBe(true);
    const pushed = git(o.bare, "rev-parse", "refs/heads/change").trim();
    expect(pushed).toBe(r.commit);
    expect(git(o.bare, "show", `${pushed}:app/rev.txt`)).toBe("3\n");
    expect(git(o.bare, "log", "-1", "--format=%B", pushed)).toContain("Change asked for by dev on merge request !3");
    const reply = posts(api.calls, /\/notes$/)[0].body.body as string;
    expect(reply).toMatch(/^terragucci: pushed \[`[0-9a-f]{8}`\]\(http:\/\/gitlab\/acme\/infra\/-\/commit\/[0-9a-f]{40}\) to `change` for dev, changing `app\/rev\.txt`/);
    // main never moved.
    expect(git(o.bare, "rev-parse", "refs/heads/main").trim()).toBe(git(o.work, "rev-parse", "origin/main").trim());
  });

  it("refuses a change to the pipeline under .gitlab/, and the branch does not move", async () => {
    const o = origin();
    const patch = change((dir) => {
      const scratch = tmp("tg-gl-agent-");
      git(scratch, "clone", "-q", o.bare, ".");
      git(scratch, "fetch", "-q", "origin", "refs/merge-requests/3/head");
      git(scratch, "checkout", "-q", "--detach", o.head);
      mkdirSync(join(scratch, ".gitlab"));
      writeFileSync(join(scratch, ".gitlab", "terragucci.yml"), "# the agent was here\n");
      git(scratch, "add", "-A");
      writeFileSync(join(dir, "change.patch"), git(scratch, "diff", "--cached", "--binary", o.head));
    });
    const api = gitlab({ mrs: [openMr(3, { sha: o.head })], notes: { 3: [note(101, "/terragucci agent touch ci")] }, members });
    const e = { ...env, [AGENT_MR_VAR]: "3", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: o.head, CI_SERVER_URL: o.server, CI_PROJECT_PATH: "acme/infra", GIT_CONFIG_GLOBAL: "/dev/null" };
    const r = await pushGitLabAgentChange({ change: patch, cwd: o.work, env: e, fetch: api.fetch });
    expect(r.pushed).toBe(false);
    expect(r.reason).toMatch(/touches `\.gitlab\/terragucci\.yml`, which an agent may not change/);
    expect(git(o.bare, "rev-parse", "refs/heads/change").trim()).toBe(o.head);
  });

  it("reads the ask again with its own token: a note whose author lost access pushes nothing, and says why", async () => {
    const o = origin();
    const patch = change((dir) => writeFileSync(join(dir, "change.patch"), "x"));
    const api = gitlab({ mrs: [openMr(3, { sha: o.head })], notes: { 3: [note(101, "/terragucci agent set rev", reporter)] }, members });
    const e = { ...env, [AGENT_MR_VAR]: "3", [AGENT_NOTE_VAR]: "101", [AGENT_HEAD_VAR]: o.head, CI_SERVER_URL: o.server, CI_PROJECT_PATH: "acme/infra", GIT_CONFIG_GLOBAL: "/dev/null" };
    const r = await pushGitLabAgentChange({ change: patch, cwd: o.work, env: e, fetch: api.fetch });
    expect(r.pushed).toBe(false);
    expect(posts(api.calls, /\/notes$/)[0].body.body).toMatch(/reader is below Developer on the project, so the agent does not run; nothing was pushed\./);
    expect(git(o.bare, "rev-parse", "refs/heads/change").trim()).toBe(o.head);
  });
});

describe("the agent's and the review's command on GitLab run with a cleared environment", () => {
  it("keeps the model's key and the prompt, and drops the project's variables and the job token", () => {
    const out = spawnSync("bash", ["-c", `${gitlabCleanEnv("REVIEW_KEY")} bash -c 'env'`], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH, HOME: "/tmp", REVIEW_KEY: "k", GITLAB_TOKEN: "secret", CI_JOB_TOKEN: "job", TG_TOKEN: "tg", AWS_SECRET_ACCESS_KEY: "aws", TG_REVIEW_PROMPT: "/tmp/p.md" },
    }).stdout;
    expect(out).toContain("REVIEW_KEY=k");
    expect(out).toContain("TG_REVIEW_PROMPT=/tmp/p.md");
    for (const gone of ["GITLAB_TOKEN", "CI_JOB_TOKEN", "TG_TOKEN", "AWS_SECRET_ACCESS_KEY"]) expect(out).not.toContain(`${gone}=`);
  });
});

describe("the comments poll starts the review", () => {
  const ended = { 3: [{ id: 40, sha: HEAD }] };
  const planJobs = (status: string) => ({ 40: [{ id: 41, name: "plan", status }] });

  it("once the head's plan ended: starts the review's pipeline and says so in the review note; the next poll starts nothing", async () => {
    const w: World = { mrs: [openMr()], notes: { 3: [] }, mrPipelines: ended, jobs: planJobs("success") };
    const first = gitlab(w);
    const r = await pollGitLabComments({ layers, env, fetch: first.fetch, now: NOW, review: true });
    expect(r.reviews).toEqual([expect.objectContaining({ mr: 3, started: true })]);
    expect(posts(first.calls, /\/trigger\/pipeline$/)[0].body.variables).toEqual({ [REVIEW_MR_VAR]: "3", [REVIEW_HEAD_VAR]: HEAD });
    expect(w.notes[3][0].body.split("\n")[0]).toBe(reviewMarker(HEAD, "unknown"));
    const second = gitlab(w);
    const again = await pollGitLabComments({ layers, env, fetch: second.fetch, now: NOW, review: true });
    expect(again.reviews).toEqual([]);
    expect(posts(second.calls, /./)).toEqual([]);
  });

  it("waits while the plan runs, and leaves a fork's merge request alone", async () => {
    const running = gitlab({ mrs: [openMr()], notes: { 3: [] }, mrPipelines: ended, jobs: planJobs("running") });
    expect((await pollGitLabComments({ layers, env, fetch: running.fetch, now: NOW, review: true })).reviews).toEqual([]);
    const fork = gitlab({ mrs: [openMr(3, { source_project_id: 8 })], notes: { 3: [] }, mrPipelines: ended, jobs: planJobs("success") });
    await pollGitLabComments({ layers, env, fetch: fork.fetch, now: NOW, review: true });
    expect(posts(fork.calls, /trigger/)).toEqual([]);
  });

  it("a new head gets a new review, in the same note", async () => {
    const old = { id: 600, body: `${reviewMarker("e".repeat(40), "low", 9)}\nold review`, author: { id: BOT }, created_at: "2026-10-07T11:00:00Z" };
    const w: World = { mrs: [openMr()], notes: { 3: [old] }, mrPipelines: ended, jobs: planJobs("failed") };
    const api = gitlab(w);
    await pollGitLabComments({ layers, env, fetch: api.fetch, now: NOW, review: true });
    expect(posts(api.calls, /\/notes\/600$/)).toHaveLength(1);
    expect(w.notes[3]).toHaveLength(1);
  });
});

describe("postGitLabReview: the review-note job", () => {
  it("edits the job's own review note with the review, the risk and the review job of this pipeline", async () => {
    const placeholder = { id: 600, body: `${reviewMarker(HEAD, "unknown")}\nstarted`, author: { id: BOT }, created_at: "2026-10-07T11:00:00Z" };
    const w: World = { mrs: [openMr()], notes: { 3: [placeholder] }, jobs: { 300: [{ id: 301, name: "review" }, { id: 302, name: "review-note" }] } };
    const api = gitlab(w);
    const files: Record<string, string> = { "review.md": "Mismatch: it destroys old.\n\nrisk: high\n", rc: "0\n", instructions: "default\n" };
    const r = await postGitLabReview({ dir: "x", env: { ...env, [REVIEW_MR_VAR]: "3", [REVIEW_HEAD_VAR]: HEAD }, fetch: api.fetch, read: (n) => files[n] ?? "" });
    expect(r).toEqual(expect.objectContaining({ posted: true, risk: "high" }));
    expect(w.notes[3][0].body.split("\n")[0]).toBe(reviewMarker(HEAD, "high", 301));
    expect(w.notes[3][0].body).toContain("Mismatch: it destroys old.");
  });
});

describe("gitlabReviewOf: the review a wave reads", () => {
  const reviewed = (o: { pr?: number; head?: string; base?: string } = {}) => JSON.stringify({ pr: o.pr ?? 3, head: o.head ?? HEAD, base: o.base ?? "main" });
  const calls = (w: World): GitLabReviewCalls => {
    const f = gitlab(w).fetch;
    const api = gitlabApi(env, "t", f);
    return {
      get: (p) => api("GET", `/projects/7${p}`),
      artifact: async (job, path) => {
        const r = await f(`${API}/projects/7/jobs/${job}/artifacts/${path}`);
        return r.status === 404 ? undefined : r.text();
      },
    };
  };
  const files = (risk: string, r = reviewed()) => ({ "terragucci-review/reviewed.json": r, "terragucci-review/review.md": `risk: ${risk}\n`, "terragucci-review/rc": "0\n" });

  it("reads the verdict of the review job a note points at, once GitLab says it ran on the default branch", async () => {
    const w: World = {
      mrs: [],
      notes: { 3: [note(1, `${reviewMarker(HEAD, "low", 50)}\nforged`), note(2, `${reviewMarker(HEAD, "high", 51)}\nreal`)] },
      job: {
        50: { id: 50, name: "review", ref: "change", tag: false, status: "success" },
        51: { id: 51, name: "review", ref: "main", tag: false, status: "success" },
      },
      artifacts: { 50: files("low"), 51: files("high") },
    };
    const r = await gitlabReviewOf(calls(w), { number: 3, head: HEAD });
    expect(r).toEqual(expect.objectContaining({ found: true, risk: "high", pull_request: 3, head: HEAD, job: 51 }));
    expect(r.skipped).toEqual([{ job: 50, why: "it ran on change, not the default branch main" }]);
  });

  it("skips a job of another name, one that reviewed another head, and finds none", async () => {
    const w: World = {
      mrs: [],
      notes: { 3: [note(1, `${reviewMarker(HEAD, "low", 50)}`), note(2, `${reviewMarker(HEAD, "low", 51)}`), note(3, `${reviewMarker(HEAD, "low")}`)] },
      job: { 50: { id: 50, name: "plan", ref: "main", status: "success" }, 51: { id: 51, name: "review", ref: "main", tag: false, status: "success" } },
      artifacts: { 51: files("low", reviewed({ head: "e".repeat(40) })) },
    };
    const r = await gitlabReviewOf(calls(w), { number: 3, head: HEAD });
    expect(r.found).toBe(false);
    expect(r.risk).toBe("unknown");
    expect(r.skipped.map((s) => s.why)).toEqual(["it is job plan, not review", `it reviewed !3 at eeeeeeee against main, not !3 against main`]);
  });
});

describe("config: GitLab's agent comment, review and wave jobs", () => {
  it("agent.comment and review need comments on GitLab; waves.jobs is GitLab's too; locks: plan stays refused", () => {
    const agent = { via: "forge", token_env: "AGENT_TOKEN", comment: true };
    expect(() => validateConfig({ forge: "gitlab", agent }, "t")).toThrow(/config\.agent\.comment: agent\.comment on GitLab needs comments: <cron>/);
    expect(() => validateConfig({ forge: "gitlab", review: { agent: true } }, "t")).toThrow(/config\.review: review on GitLab needs comments: <cron>/);
    expect(validateConfig({ forge: "gitlab", comments: "*/5 * * * *", agent, review: { agent: true } }, "t")).toEqual(expect.objectContaining({ comments: "*/5 * * * *" }));
    expect(validateConfig({ forge: "gitlab", waves: { jobs: 2 } }, "t")).toEqual({ forge: "gitlab", waves: { jobs: 2 } });
    expect(() => validateConfig({ forge: "gitlab", locks: "plan" }, "t")).toThrow(/config\.locks: plan is not supported on GitLab/);
  });
});

