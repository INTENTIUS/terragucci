import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { renderPipeline, resumeCron, resumeScript } from "../src/render";
import { originOf, resumable, resumeAfterApproval, resumeStep, resumeWithChant } from "../src/resume";
import { appendLifecycle, type GateLedger } from "../src/apply";
import { git, tmp } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 8, 12, m)).toISOString();
const pending = (gate: string, digest: string, m: number, extra: Record<string, unknown> = {}) => ({ version: 1 as const, kind: "pending" as const, op: "tf-apply", gate, timestamp: T(m), expiresAt: T(m + 2880), planDigest: digest, ...extra });
const resolution = (gate: string, digest: string, m: number, by = "alice") => ({ version: 1 as const, kind: "resolution" as const, op: "tf-apply", gate, resolvedBy: by, timestamp: T(m), planDigest: digest });
const ledger = (l: Partial<GateLedger>): GateLedger => ({ pending: [], resolutions: [], ...l }) as GateLedger;

/** A forge that answers from `routes` (method and path, query dropped) and records every call. */
function forge(routes: Record<string, unknown>, base = "https://api.test/"): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.replace(base, "").split("?")[0]!;
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push(key);
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" } as never;
    return { ok: true, status: 200, json: async () => routes[key], text: async () => JSON.stringify(routes[key] ?? null) } as never;
  };
  return { fetch, calls };
}

describe("resumable", () => {
  it("names a wave whose newest pending digest an approval made after it names, until an apply used it", () => {
    const base = { pending: [pending("wave-1", "jcs1-sha256:aa", 0, { runId: "41", commit: "c".repeat(40) })], resolutions: [resolution("wave-1", "jcs1-sha256:aa", 5)] };
    expect(resumable(ledger(base), T(6))).toEqual([{ wave: 1, digest: "jcs1-sha256:aa", by: "alice", runId: "41", commit: "c".repeat(40) }]);
    // Used: an apply under that approval ran.
    expect(resumable(ledger({ ...base, applied: [{ version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "jcs1-sha256:aa", approvedAt: T(5), approvedBy: "alice", timestamp: T(7) }] as never }), T(8))).toEqual([]);
    // An approval of another digest, or one older than the pending fact, resumes nothing.
    expect(resumable(ledger({ pending: base.pending, resolutions: [resolution("wave-1", "jcs1-sha256:bb", 5)] }), T(6))).toEqual([]);
    expect(resumable(ledger({ pending: [pending("wave-1", "jcs1-sha256:aa", 10)], resolutions: [resolution("wave-1", "jcs1-sha256:aa", 5)] }), T(11))).toEqual([]);
    // Nothing pending: nothing waits.
    expect(resumable(ledger({ resolutions: [resolution("wave-1", "jcs1-sha256:aa", 5)] }), T(6))).toEqual([]);
  });
});

describe("resumable, a gate that asks a decision point", () => {
  const Q = "prod-apply-0123456789ab";
  const asking = (extra: Record<string, unknown> = {}) => pending("wave-1", "jcs1-sha256:aa", 0, { runId: "41", answer: { point: "prod-apply", id: Q, path: `answers/${Q}.md`, ...extra } });
  const question = (state: "escalated" | "answered", answer: string | boolean | null, by: string[] = []) => new Map([[Q, { id: Q, state, answer, answeredBy: by, answeredOn: state === "answered" ? "2026-10-08" : null }]]);

  it("names a wave whose question has an answer the gate passes on, before the wave records its resolution", () => {
    const l = ledger({ pending: [asking()] });
    expect(resumable(l, T(6), undefined, question("answered", true, ["alice@acme.com"]))).toEqual([{ wave: 1, digest: "jcs1-sha256:aa", by: "alice@acme.com", runId: "41" }]);
  });

  it("leaves a wave whose question is open, answered otherwise, or not read", () => {
    const l = ledger({ pending: [asking()] });
    expect(resumable(l, T(6), undefined, question("escalated", null))).toEqual([]);
    expect(resumable(l, T(6), undefined, question("answered", false, ["alice@acme.com"]))).toEqual([]);
    expect(resumable(l, T(6))).toEqual([]);
    expect(resumable(l, T(6), undefined, new Map())).toEqual([]);
  });

  it("once the wave recorded the resolution and applied under it, resumes nothing", () => {
    const l = ledger({ pending: [asking()], resolutions: [resolution("wave-1", "jcs1-sha256:aa", 5, "alice@acme.com")], applied: [{ version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "jcs1-sha256:aa", approvedAt: T(5), approvedBy: "alice@acme.com", timestamp: T(7) }] as never });
    expect(resumable(l, T(8), undefined, question("answered", true, ["alice@acme.com"]))).toEqual([]);
  });
});

describe("resumable, an approved apply that stopped", () => {
  const applied = (m: number, extra: Record<string, unknown> = {}) => ({ version: 1 as const, kind: "applied" as const, op: "tf-apply", gate: "wave-2", planDigest: "jcs1-sha256:aa", approvedAt: T(5), approvedBy: "alice", timestamp: T(m), runId: "41", holder: "41", changes: [], ...extra });
  const finished = (m: number, result: "applied" | "failed") => ({ version: 1 as const, kind: "finished" as const, op: "tf-apply", gate: "wave-2", planDigest: "jcs1-sha256:aa", applied: T(m), result, timestamp: T(m + 1) });
  const base = { pending: [pending("wave-2", "jcs1-sha256:aa", 0)], resolutions: [resolution("wave-2", "jcs1-sha256:aa", 5)] };

  it("names a wave whose apply under an approval recorded its changes and never how it ended", () => {
    expect(resumable(ledger({ ...base, applied: [applied(7)] }), T(8))).toEqual([{ wave: 2, digest: "jcs1-sha256:aa", by: "alice", runId: "41", stopped: { holder: "41", at: T(7) } }]);
  });

  it("leaves a wave whose apply ended, failed included, recorded no changes, or planned again since", () => {
    expect(resumable(ledger({ ...base, applied: [applied(7)], finished: [finished(7, "applied")] }), T(9))).toEqual([]);
    expect(resumable(ledger({ ...base, applied: [applied(7)], finished: [finished(7, "failed")] }), T(9))).toEqual([]);
    expect(resumable(ledger({ ...base, applied: [applied(7, { changes: undefined })] }), T(9))).toEqual([]);
    expect(resumable(ledger({ ...base, pending: [...base.pending, pending("wave-2", "jcs1-sha256:bb", 9)], applied: [applied(7)] }), T(10))).toEqual([]);
  });

  it("resumes it once the run that applied is gone, and not while it runs", async () => {
    const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.test", TG_TOKEN: "t" };
    const l = ledger({ ...base, applied: [applied(7)] });
    const none = forge({});
    const seen: string[] = [];
    const step = (state: "alive" | "dead") => resumeStep({ ledger: l, forge: "github", sha: "d".repeat(40), env, now: T(8), fetch: none.fetch, liveness: async (h) => (seen.push(h.run), state) });
    expect(await step("alive")).toMatchObject({ kind: "none" });
    expect(await step("dead")).toMatchObject({ kind: "apply", sha: "d".repeat(40), waves: [{ wave: 2, stopped: { holder: "41" } }] });
    expect(seen).toEqual(["41", "41"]);
  });
});

describe("resumable, a state migration", () => {
  const mig = (l: Partial<GateLedger>): GateLedger => ledger(l);
  it("resumes wave 1 for a migration whose newest digest an approval names, until wave 1 applied under it", () => {
    const pend = pending("split-b", "jcs1-sha256:mm", 0, { op: "tf-migrate", runId: "88", commit: "c".repeat(40) });
    const ok = resolution("split-b", "jcs1-sha256:mm", 5);
    expect(resumable(ledger({}), T(6), mig({ pending: [pend], resolutions: [ok] }))).toEqual([{ wave: 1, migration: "split-b", digest: "jcs1-sha256:mm", by: "alice", runId: "88", commit: "c".repeat(40) }]);
    expect(resumable(ledger({}), T(8), mig({ pending: [pend], resolutions: [ok], applied: [{ version: 1, kind: "applied", op: "tf-migrate", gate: "split-b", planDigest: "jcs1-sha256:mm", approvedAt: T(5), approvedBy: "alice", timestamp: T(7) }] }))).toEqual([]);
    expect(resumable(ledger({}), T(6), mig({ pending: [pend] }))).toEqual([]);
  });

  it("on GitLab leaves an approved migration to chant run resume, which retries the job that waited", async () => {
    const env = { CI_API_V4_URL: "https://api.test", CI_PROJECT_ID: "9", TG_TOKEN: "t", CI_DEFAULT_BRANCH: "main" };
    const { fetch, calls } = forge({});
    const migrations = mig({ pending: [pending("split-b", "jcs1-sha256:mm", 0, { op: "tf-migrate" })], resolutions: [resolution("split-b", "jcs1-sha256:mm", 5)] });
    expect(await resumeStep({ ledger: ledger({}), migrations, forge: "gitlab", sha: "d".repeat(40), env, now: T(6), fetch })).toEqual({ kind: "none", why: "no approved apply stopped before it finished" });
    expect(calls).toEqual([]);
  });
});

describe("resumeStep", () => {
  const approved = ledger({ pending: [pending("wave-2", "jcs1-sha256:aa", 0, { runId: "77" })], resolutions: [resolution("wave-2", "jcs1-sha256:aa", 5)] });
  const SHA = "d".repeat(40);

  it("on GitHub and Forgejo applies at the default branch's commit, naming the pull request that made it", async () => {
    const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.test", TG_TOKEN: "t" };
    const { fetch } = forge({ [`GET repos/acme/infra/commits/${SHA}/pulls`]: [{ number: 12, head: { sha: "e".repeat(40) }, merge_commit_sha: SHA, merged_at: T(0) }] });
    expect(await resumeStep({ ledger: approved, forge: "github", sha: SHA, env, now: T(6), fetch })).toMatchObject({ kind: "apply", sha: SHA, pr: 12, waves: [{ wave: 2 }] });
    // A direct push: no pull request, the apply still runs.
    const none = forge({});
    expect(await resumeStep({ ledger: approved, forge: "github", sha: SHA, env, now: T(6), fetch: none.fetch })).toMatchObject({ kind: "apply", sha: SHA });
    expect(await resumeStep({ ledger: ledger({}), forge: "github", sha: SHA, env, now: T(6), fetch: none.fetch })).toEqual({ kind: "none", why: "no wave waits with an approval that stands, and no approved apply stopped before it finished" });
  });

  it("on GitLab leaves a wave waiting at its gate to chant run resume, and retries the newest push pipeline's job of a stopped apply", async () => {
    const env = { CI_API_V4_URL: "https://api.test", CI_PROJECT_ID: "9", TG_TOKEN: "t", CI_DEFAULT_BRANCH: "main" };
    const routes = {
      "GET projects/9/pipelines": [{ id: 300, sha: SHA }],
      "GET projects/9/pipelines/300/jobs": [{ id: 1, name: "apply-wave-1", status: "success" }, { id: 2, name: "apply-wave-2", status: "failed" }, { id: 3, name: "apply-wave-3", status: "skipped" }],
      "POST projects/9/jobs/2/retry": { web_url: "https://gitlab.test/acme/infra/-/jobs/4" },
    };
    const waiting = forge(routes);
    expect(await resumeStep({ ledger: approved, forge: "gitlab", sha: SHA, env, now: T(6), fetch: waiting.fetch })).toEqual({ kind: "none", why: "no approved apply stopped before it finished" });
    expect(waiting.calls).toEqual([]);
    // An approved apply of wave 2 that recorded its changes and never how it ended, whose run is gone.
    const stopped = ledger({ applied: [{ version: 1, kind: "changes", op: "tf-apply", gate: "wave-2", planDigest: "jcs1-sha256:aa", approvedAt: T(5), approvedBy: "alice", timestamp: T(6), holder: "55", changes: [{ root: "a", address: "x.y", actions: "create", digest: "d" }] }] as never });
    const f = forge(routes);
    expect(await resumeStep({ ledger: stopped, forge: "gitlab", sha: SHA, env, now: T(7), fetch: f.fetch, liveness: async () => "dead" })).toMatchObject({ kind: "retried", job: "apply-wave-2", pipeline: 300, url: "https://gitlab.test/acme/infra/-/jobs/4" });
    expect(f.calls).toContain("POST projects/9/jobs/2/retry");
  });
});

describe("resumeAfterApproval, and the GitLab resume job, through chant run resume", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => { if (!server) return done(); server.closeAllConnections(); server.close(() => done()); server = undefined; }));

  /** A forge's API on localhost: answers `routes` by method and path, and records each call. */
  async function api(routes: Record<string, unknown>): Promise<{ base: string; calls: string[] }> {
    const calls: string[] = [];
    server = createServer((req, res) => {
      const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      calls.push(key);
      if (!(key in routes)) {
        res.writeHead(404).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(routes[key] ?? {}));
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
  }

  /** A checkout whose origin's chant/lifecycle holds `lines` in `_gates/<op>.jsonl`. */
  function repoWith(op: string, lines: unknown[]): string {
    const dir = tmp("tg-resume-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    appendLifecycle(work, `_gates/${op}.jsonl`, lines.map((l) => JSON.stringify(l)), {}, "ledger");
    return work;
  }

  const now = Date.now();
  const at = (m: number): string => new Date(now - 60_000 * (10 - m)).toISOString();
  const waiting = (gate: string, resume: Record<string, unknown>, op = "tf-apply") => [
    { version: 1, kind: "pending", op, gate, timestamp: at(0), expiresAt: new Date(now + 86_400_000).toISOString(), planDigest: "jcs1-sha256:aa", resume },
    { version: 1, kind: "resolution", op, gate, resolvedBy: "alice", timestamp: at(5), planDigest: "jcs1-sha256:aa" },
  ];

  it("re-runs the GitHub run that waited, with the approver's token", async () => {
    const f = await api({ "GET /repos/acme/infra/actions/runs/41": { status: "completed", conclusion: "failure", run_attempt: 1 }, "POST /repos/acme/infra/actions/runs/41/rerun-failed-jobs": {} });
    const resume = { forge: "github", api: f.base, repo: "acme/infra", run: "41", attempt: 1 };
    const repo = repoWith("tf-apply", waiting("wave-2", resume));
    const line = await resumeAfterApproval({ origin: originOf("git@github.com:acme/infra.git")!, wave: { wave: 2, resume: resume as never }, env: { ...process.env, GH_TOKEN: "me" }, repo, gate: "wave-2" });
    expect(line).toBe("resumed: re-ran the failed jobs of run 41, so wave 2 runs again and its gate decides");
    expect(f.calls).toContain("POST /repos/acme/infra/actions/runs/41/rerun-failed-jobs");
  });

  it("retries GitLab's waiting job of a migration, and comments /terragucci apply on Forgejo's merged pull request", async () => {
    const f = await api({ "GET /projects/9/jobs/7": { status: "failed", name: "apply-wave-1" }, "GET /projects/9/pipelines/300/jobs": [{ id: 7, name: "apply-wave-1" }], "POST /projects/9/jobs/7/retry": { id: 8 } });
    const resume = { forge: "gitlab", api: f.base, repo: "9", run: "300", job: "7", jobName: "apply-wave-1" };
    const repo = repoWith("tf-migrate", waiting("split-b", resume, "tf-migrate"));
    const line = await resumeAfterApproval({ origin: originOf("https://gitlab.com/acme/infra.git")!, wave: { wave: 1, resume: resume as never }, env: { ...process.env, GITLAB_TOKEN: "me" }, repo, op: "tf-migrate", gate: "split-b" });
    expect(line).toBe("resumed: retried job 7 as job 8, so wave 1 runs again and its gate decides");
    const fj = forge({ [`GET repos/acme/infra/commits/${"c".repeat(40)}/pull`]: { number: 5 }, "POST repos/acme/infra/issues/5/comments": {} }, "https://code.test/api/v1/");
    expect(await resumeAfterApproval({ origin: originOf("https://code.test/acme/infra.git", "forgejo")!, wave: { wave: 2, commit: "c".repeat(40) }, env: { FORGEJO_TOKEN: "me" }, fetch: fj.fetch })).toBe("resumed: commented /terragucci apply on pull request 5, so its waves run again and each gate decides");
  });

  it("says what is missing instead of failing: no token, no CI job on the pending fact, a run that already succeeded", async () => {
    const origin = originOf("https://gitlab.com/acme/infra")!;
    expect(await resumeAfterApproval({ origin, wave: { wave: 1, resume: {} as never }, env: {} })).toMatch(/^not resumed from here: no token in GITLAB_TOKEN; the pipeline's resume job/);
    expect(await resumeAfterApproval({ origin, wave: { wave: 1 }, env: { GITLAB_TOKEN: "x" } })).toMatch(/^not resumed from here: the pending fact names no CI job/);
    const f = await api({ "GET /repos/acme/infra/actions/runs/41": { status: "completed", conclusion: "success" } });
    const resume = { forge: "github", api: f.base, repo: "acme/infra", run: "41" };
    const repo = repoWith("tf-apply", waiting("wave-2", resume));
    expect(await resumeAfterApproval({ origin: originOf("git@github.com:acme/infra.git")!, wave: { wave: 2, resume: resume as never }, env: { ...process.env, GH_TOKEN: "me" }, repo, gate: "wave-2" })).toMatch(/^not resumed from here: run 41 succeeded;/);
  });

  it("the GitLab resume job runs chant run resume for the waves' and the migrations' gates, with the project token", async () => {
    const f = await api({ "GET /projects/9/jobs/7": { status: "failed", name: "apply-wave-2" }, "GET /projects/9/pipelines/300/jobs": [{ id: 7, name: "apply-wave-2" }], "POST /projects/9/jobs/7/retry": { id: 8 } });
    const repo = repoWith("tf-apply", waiting("wave-2", { forge: "gitlab", api: f.base, repo: "9", run: "300", job: "7", jobName: "apply-wave-2" }));
    const lines: string[] = [];
    expect(await resumeWithChant(repo, { ...process.env, TG_TOKEN: "project" }, { log: (l) => void lines.push(l) })).toBe(0);
    expect(lines).toEqual(["terragucci resume: chant run resume --op tf-apply", "terragucci resume: chant run resume --op tf-migrate"]);
    expect(f.calls).toContain("POST /projects/9/jobs/7/retry");
  });
  it("reads the forge from the origin, or from the config for any other host", () => {
    expect(originOf("git@github.com:acme/infra.git")).toEqual({ forge: "github", host: "github.com", web: "https://github.com", path: "acme/infra" });
    expect(originOf("https://gitlab.com/group/sub/infra.git")).toEqual({ forge: "gitlab", host: "gitlab.com", web: "https://gitlab.com", path: "group/sub/infra" });
    expect(originOf("https://code.test/acme/infra")).toBeUndefined();
    expect(originOf("http://admin:tok@code.test:3000/acme/infra.git", "forgejo")).toEqual({ forge: "forgejo", host: "code.test", web: "http://code.test:3000", path: "acme/infra" });
  });
});

describe("apply.resume in the pipeline", () => {
  const doc = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

  it.each(["github", "forgejo"] as const)("%s: a resume workflow of its own runs the waves on its schedule", (forge) => {
    const r = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, gate: "always", resume: 10 });
    expect(r.extra).toHaveLength(1);
    const extra = r.extra![0]!;
    expect(extra.path).toBe(forge === "github" ? ".github/workflows/terragucci-resume.yml" : ".forgejo/workflows/terragucci-resume.yml");
    const w = doc(extra.content);
    expect(w.on).toEqual({ schedule: [{ cron: "*/10 * * * *" }], workflow_dispatch: {} });
    if (forge === "github") expect(w.jobs.resume.permissions.contents).toBe("write");
    // It applies beside any other run; a wave of it waits for what another run is applying.
    expect(JSON.stringify(w.jobs.resume.steps)).not.toContain("terragucci-apply-lock");
    expect(w.jobs.resume.concurrency).toBeUndefined();
    expect(JSON.stringify(w.jobs.resume.steps)).not.toContain("--on-held refuse");
    expect(JSON.stringify(w.jobs.resume.steps)).toContain(`terragucci resume --forge ${forge} --out terragucci-resume.env`);
    // The pipeline itself is unchanged, and without apply.resume there is no resume workflow.
    expect(r.content).toBe(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, gate: "always" }).content);
    expect(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "always" }).extra).toBeUndefined();
    // Under gate never too: a state migration waits in wave 1 whatever the gate, and an approved one resumes.
    const never = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "never", resume: 10 });
    expect(never.extra?.map((e) => e.path)).toEqual([extra.path]);
  });

  it("gitlab: a resume job for the pipeline schedule TERRAGUCCI_SCHEDULE=resume, which drift's job sits out", () => {
    const d = doc(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "always", resume: 15, drift: "0 6 * * *" }).content);
    expect(d.resume.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE == "resume"' }]);
    expect(JSON.stringify(d.resume.script)).toContain("terragucci resume --forge gitlab");
    expect(d.drift.rules[0].if).toContain('$TERRAGUCCI_SCHEDULE != "resume"');
    expect(d["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
  });

  it("the script stops before any credential when nothing resumes, and replies only where a pull request made the commit", () => {
    const s = resumeScript("tofu", [["a"]], "github");
    expect(s.indexOf("[ -s terragucci-resume.env ] || exit 0")).toBeLessThan(s.indexOf("terragucci stage tf-apply"));
    expect(s).toContain('tg() { if [ "$1" = reply ] && [ -z "$TG_PR" ]; then echo "terragucci: $2"; else tg_forge "$@"; fi; }');
    expect(resumeCron(5)).toBe("*/5 * * * *");
    expect(resumeCron(60)).toBe("0 * * * *");
  });

  it("takes 5 to 60 minutes", () => {
    expect(validateConfig({ apply: { resume: 10 } }, "t").apply).toEqual({ resume: 10 });
    for (const bad of [4, 61, 7.5, "10"]) expect(() => validateConfig({ apply: { resume: bad } }, "t")).toThrow(/apply.resume must be the minutes between the resume job's runs, from 5 to 60/);
  });
});
