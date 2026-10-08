import { describe, expect, it } from "vitest";
import type { Fetch } from "../src/forge";
import { buildReport } from "../src/report/build";
import { renderNote } from "../src/report/views";
import { approvalStatus, changesSomething, noteMarker, parseMarker, reviewDigest, reviewWave } from "../src/review";
import { tmp, write } from "./helpers";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.test", TG_TOKEN: "t" };
const create = (input: string) => ({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input }, after_unknown: {} } }] });
const noop = { resource_changes: [{ address: "terraform_data.y", mode: "managed", type: "terraform_data", name: "y", change: { actions: ["no-op"], before: {}, after: {}, after_unknown: {} } }] };

/** A forge that answers from `routes` (method and path, without the query) and records every call. */
function forge(routes: Record<string, unknown>): { fetch: Fetch; calls: { method: string; path: string; body?: string }[] } {
  const calls: { method: string; path: string; body?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://api.test/", "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, ...(init?.body ? { body: init.body } : {}) });
    const key = `${method} ${path}`;
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) } as never;
    return { ok: true, status: 200, json: async () => routes[key] } as never;
  };
  return { fetch, calls };
}

const pull = { number: 7, head: { sha: HEAD }, user: { login: "author" }, merge_commit_sha: MERGE, merged_at: "2026-10-01T00:00:00Z" };
const approve = (login: string, commit = HEAD) => ({ user: { login }, state: "APPROVED", commit_id: commit });

describe("changesSomething and reviewDigest", () => {
  it("counts a resource or output change and leaves out no-ops and reads", () => {
    expect(changesSomething(create("1"))).toBe(true);
    expect(changesSomething(noop)).toBe(false);
    expect(changesSomething({ output_changes: { o: { actions: ["update"] } } })).toBe(true);
    expect(changesSomething(undefined)).toBe(false);
  });

  it("digests only the members whose plan changes something, and is null when none does", () => {
    const a = { member: "a", planDigest: "jcs1-sha256:aa", plan: create("1") };
    const b = { member: "b", planDigest: "jcs1-sha256:bb", plan: noop };
    expect(reviewDigest([a, b])).toBe(reviewDigest([a]));
    expect(reviewDigest([b])).toBeNull();
  });
});

describe("the plan note's marker", () => {
  it("round-trips, and a body without one reads as nothing", () => {
    const w = { head: HEAD, waves: [{ number: 1, digest: "jcs1-sha256:aa", waits: true }, { number: 2, digest: null, waits: false }] };
    expect(parseMarker(`### note\n\n${noteMarker(w)}\n\nmore`)).toEqual(w);
    expect(parseMarker("no marker")).toBeUndefined();
    expect(parseMarker(undefined)).toBeUndefined();
  });

  it("a plan report built with a gate carries each wave's review digest and whether it waits, and its note carries both", () => {
    const run = { project: "p", commit: HEAD, stage: "tf-plan" as const, binary: "tofu", runtime: "forge" as const, started: "2026-10-01T00:00:00Z", finished: "2026-10-01T00:00:00Z" };
    const roots = [{ path: "a", plan: create("1"), planner: "terraform" as const }, { path: "b", plan: noop, planner: "terraform" as const }];
    const report = buildReport({ run, roots, waves: [{ number: 1, roots: ["a"] }, { number: 2, roots: ["b"] }], gate: "always" } as never);
    expect(report.waves[0]).toMatchObject({ number: 1, waits: true });
    expect(report.waves[0]!.review_digest).toMatch(/^jcs1-sha256:/);
    expect(report.waves[1]).toMatchObject({ number: 2, review_digest: null, waits: false });
    const marker = parseMarker(renderNote(report));
    expect(marker).toEqual({ head: HEAD, waves: [{ number: 1, digest: report.waves[0]!.review_digest, waits: true }, { number: 2, digest: null, waits: false }] });
    const d = report.waves[0]!.review_digest;
    expect(renderNote(report)).toContain(`| 1 | 1 | \`${d}\` | waits for an approval: \`chant approve tf-apply wave-1 --plan ${d}\` |`);
    expect(renderNote(report, { sealed: true })).toContain(`\`chant approve tf-apply wave-1 --plan ${d} --sign\``);
    expect(renderNote(report)).toContain("| 2 | 1 | no change | applies |");
    // Under on-destroy a create waits for nothing.
    expect(buildReport({ run, roots, waves: [{ number: 1, roots: ["a"] }], gate: "on-destroy" } as never).waves[0]!.waits).toBe(false);
  });
});

describe("reviewWave", () => {
  const note = (digest: string | null, head = HEAD) => ({ body: `### terragucci tf-plan\n${noteMarker({ head, waves: [{ number: 1, digest, waits: true }] })}` });
  const base = (reviews: unknown[], comments: unknown[]) => ({
    [`GET repos/acme/infra/commits/${MERGE}/pulls`]: [pull],
    "GET repos/acme/infra/pulls/7/reviews": reviews,
    "GET repos/acme/infra/collaborators/alice/permission": { permission: "write" },
    "GET repos/acme/infra/collaborators/reader/permission": { permission: "read" },
    "GET repos/acme/infra/issues/7/comments": comments,
  });

  it("an approval of the head by a writer other than the author, with the reviewed digest planned now, approves the wave", async () => {
    const { fetch } = forge(base([approve("alice"), approve("author")], [note("jcs1-sha256:aa")]));
    expect(await reviewWave({ env, fetch, forge: "github", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" })).toEqual({ kind: "approved", pr: 7, head: HEAD, by: ["alice"] });
  });

  it("plans that moved since the review are the changed-wave refusal", async () => {
    const { fetch } = forge(base([approve("alice")], [note("jcs1-sha256:aa")]));
    expect(await reviewWave({ env, fetch, forge: "github", sha: MERGE, wave: 1, digest: "jcs1-sha256:bb" })).toMatchObject({ kind: "moved", reviewed: "jcs1-sha256:aa" });
  });

  it("counts nothing for the author, a reader, an approval of an older head, a request for changes, or a note of another head", async () => {
    const cases: [unknown[], unknown[], RegExp][] = [
      [[approve("author")], [note("jcs1-sha256:aa")], /no reviewer other than its author/],
      [[approve("reader")], [note("jcs1-sha256:aa")], /no reviewer other than its author/],
      [[approve("alice", "c".repeat(40))], [note("jcs1-sha256:aa")], /no reviewer other than its author/],
      [[approve("alice"), { user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: HEAD }], [note("jcs1-sha256:aa")], /bob asked for changes/],
      [[approve("alice")], [note("jcs1-sha256:aa", "c".repeat(40))], /has no digest for wave 1/],
    ];
    for (const [reviews, comments, why] of cases) {
      const { fetch } = forge(base(reviews, comments));
      const r = await reviewWave({ env, fetch, forge: "github", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" });
      expect(r.kind).toBe("none");
      expect((r as { why: string }).why).toMatch(why);
    }
  });

  it("on Forgejo finds the pull request a merge commit made by its own endpoint", async () => {
    const { fetch } = forge({
      [`GET repos/acme/infra/commits/${MERGE}/pull`]: pull,
      "GET repos/acme/infra/pulls/7/reviews": [{ ...approve("alice"), official: true }],
      "GET repos/acme/infra/issues/7/comments": [note("jcs1-sha256:aa")],
    });
    expect(await reviewWave({ env, fetch, forge: "forgejo", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" })).toMatchObject({ kind: "approved", by: ["alice"] });
  });

  it("a direct push, with no pull request, leaves the wave to chant approve", async () => {
    const { fetch } = forge({ [`GET repos/acme/infra/commits/${MERGE}/pulls`]: [] });
    expect(await reviewWave({ env, fetch, forge: "github", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" })).toMatchObject({ kind: "none", why: expect.stringMatching(/no merged pull request/) });
  });
});

describe("approvalStatus", () => {
  const prEnv = { ...env, TG_PR: "7", TG_SHA: HEAD };
  const report = (waits: boolean) => write(tmp(), { "report.json": JSON.stringify({ waves: [{ number: 1, waits }, { number: 2, waits: false }] }) });
  const posted = (calls: { method: string; path: string; body?: string }[]) => calls.filter((c) => c.method === "POST").map((c) => [c.path, JSON.parse(c.body!)]);

  it("is pending while a wave the gate will hold has no approving review, and success once it has", async () => {
    let f = forge({ "GET repos/acme/infra/pulls/7": pull, "GET repos/acme/infra/pulls/7/reviews": [], [`POST repos/acme/infra/statuses/${HEAD}`]: {} });
    expect(await approvalStatus({ env: prEnv, fetch: f.fetch, forge: "github", report: report(true) })).toMatchObject({ state: "pending" });
    expect(posted(f.calls)).toEqual([[`repos/acme/infra/statuses/${HEAD}`, { state: "pending", context: "terragucci/approval", description: `wave 1 waits: approve this pull request on ${HEAD.slice(0, 8)}` }]]);
    f = forge({ "GET repos/acme/infra/pulls/7": pull, "GET repos/acme/infra/pulls/7/reviews": [approve("alice")], "GET repos/acme/infra/collaborators/alice/permission": { permission: "admin" }, [`POST repos/acme/infra/statuses/${HEAD}`]: {} });
    expect(await approvalStatus({ env: prEnv, fetch: f.fetch, forge: "github", report: report(true) })).toMatchObject({ state: "success", description: expect.stringContaining("by alice") });
  });

  it("is success when no wave waits, and reads the waves from the head's note when no report is given", async () => {
    const f = forge({
      "GET repos/acme/infra/pulls/7": pull,
      "GET repos/acme/infra/issues/7/comments": [{ body: noteMarker({ head: HEAD, waves: [{ number: 1, digest: "jcs1-sha256:aa", waits: false }] }) }],
      [`POST repos/acme/infra/statuses/${HEAD}`]: {},
    });
    expect(await approvalStatus({ env: prEnv, fetch: f.fetch, forge: "forgejo" })).toEqual({ state: "success", description: "no wave waits for an approval" });
    expect(await approvalStatus({ env: prEnv, fetch: f.fetch, forge: "forgejo", report: report(false) })).toMatchObject({ state: "success" });
  });
});

describe("pr-review on GitLab", () => {
  const glEnv = { CI_API_V4_URL: "https://api.test", CI_PROJECT_ID: "9", TG_TOKEN: "t" };
  const mr = { iid: 3, state: "merged", merge_commit_sha: MERGE, sha: HEAD, author: { username: "author" } };
  const system = (who: string, id: number, body: string, at: string) => ({ system: true, author: { username: who, id }, body, created_at: at });
  const routes = (notes: unknown[]) => ({
    [`GET projects/9/repository/commits/${MERGE}/merge_requests`]: [mr],
    "GET projects/9/merge_requests/3/versions": [{ id: 2, head_commit_sha: HEAD, created_at: "2026-10-01T10:00:00Z" }, { id: 1, head_commit_sha: "c".repeat(40), created_at: "2026-10-01T09:00:00Z" }],
    "GET projects/9/merge_requests/3/notes": [{ system: false, body: noteMarker({ head: HEAD, waves: [{ number: 1, digest: "jcs1-sha256:aa", waits: true }] }) }, ...notes],
    "GET projects/9/members/all/1": { access_level: 30 },
    "GET projects/9/members/all/2": { access_level: 20 },
    "GET projects/9/members/all/3": { access_level: 40 },
  });

  it("an approval after the latest push by a developer other than the author approves the wave", async () => {
    const { fetch } = forge(routes([system("alice", 1, "approved this merge request", "2026-10-01T11:00:00Z"), system("author", 3, "approved this merge request", "2026-10-01T11:00:00Z")]));
    expect(await reviewWave({ env: glEnv, fetch, forge: "gitlab", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" })).toEqual({ kind: "approved", pr: 3, head: HEAD, by: ["alice"] });
  });

  it("an approval before the latest push, one withdrawn, or one by a reporter counts for nothing", async () => {
    for (const notes of [
      [system("alice", 1, "approved this merge request", "2026-10-01T09:30:00Z")],
      [system("alice", 1, "approved this merge request", "2026-10-01T11:00:00Z"), system("alice", 1, "unapproved this merge request", "2026-10-01T12:00:00Z")],
      [system("rita", 2, "approved this merge request", "2026-10-01T11:00:00Z")],
    ]) {
      const { fetch } = forge(routes(notes));
      expect((await reviewWave({ env: glEnv, fetch, forge: "gitlab", sha: MERGE, wave: 1, digest: "jcs1-sha256:aa" })).kind).toBe("none");
    }
  });

  it("plans that moved after the approval are refused, as on the other forges", async () => {
    const { fetch } = forge(routes([system("alice", 1, "approved this merge request", "2026-10-01T11:00:00Z")]));
    expect(await reviewWave({ env: glEnv, fetch, forge: "gitlab", sha: MERGE, wave: 1, digest: "jcs1-sha256:bb" })).toMatchObject({ kind: "moved", reviewed: "jcs1-sha256:aa" });
  });
});
