import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { renderPipeline, resumeCron, resumeScript } from "../src/render";
import { originOf, resumable, resumeAfterApproval, resumeStep } from "../src/resume";
import type { GateLedger } from "../src/apply";

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
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) } as never;
    return { ok: true, status: 200, json: async () => routes[key] } as never;
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

describe("resumable, a state migration", () => {
  const mig = (l: Partial<GateLedger>): GateLedger => ledger(l);
  it("resumes wave 1 for a migration whose newest digest an approval names, until wave 1 applied under it", () => {
    const pend = pending("split-b", "jcs1-sha256:mm", 0, { op: "tf-migrate", runId: "88", commit: "c".repeat(40) });
    const ok = resolution("split-b", "jcs1-sha256:mm", 5);
    expect(resumable(ledger({}), T(6), mig({ pending: [pend], resolutions: [ok] }))).toEqual([{ wave: 1, migration: "split-b", digest: "jcs1-sha256:mm", by: "alice", runId: "88", commit: "c".repeat(40) }]);
    expect(resumable(ledger({}), T(8), mig({ pending: [pend], resolutions: [ok], applied: [{ version: 1, kind: "applied", op: "tf-migrate", gate: "split-b", planDigest: "jcs1-sha256:mm", approvedAt: T(5), approvedBy: "alice", timestamp: T(7) }] }))).toEqual([]);
    expect(resumable(ledger({}), T(6), mig({ pending: [pend] }))).toEqual([]);
  });

  it("on GitLab retries apply-wave-1 for an approved migration, which waited there", async () => {
    const env = { CI_API_V4_URL: "https://api.test", CI_PROJECT_ID: "9", TG_TOKEN: "t", CI_DEFAULT_BRANCH: "main" };
    const { fetch, calls } = forge({
      "GET projects/9/pipelines": [{ id: 300 }],
      "GET projects/9/pipelines/300/jobs": [{ id: 1, name: "apply-wave-1", status: "failed" }, { id: 2, name: "apply-wave-2", status: "skipped" }],
      "POST projects/9/jobs/1/retry": {},
    });
    const migrations = mig({ pending: [pending("split-b", "jcs1-sha256:mm", 0, { op: "tf-migrate" })], resolutions: [resolution("split-b", "jcs1-sha256:mm", 5)] });
    expect(await resumeStep({ ledger: ledger({}), migrations, forge: "gitlab", sha: "d".repeat(40), env, now: T(6), fetch })).toMatchObject({ kind: "retried", job: "apply-wave-1", waves: [{ wave: 1, migration: "split-b" }] });
    expect(calls).toContain("POST projects/9/jobs/1/retry");
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
    expect(await resumeStep({ ledger: ledger({}), forge: "github", sha: SHA, env, now: T(6), fetch: none.fetch })).toEqual({ kind: "none", why: "no wave waits with an approval that stands" });
  });

  it("on GitLab retries the newest push pipeline's first unsuccessful apply job when its wave's approval stands", async () => {
    const env = { CI_API_V4_URL: "https://api.test", CI_PROJECT_ID: "9", TG_TOKEN: "t", CI_DEFAULT_BRANCH: "main" };
    const routes = {
      "GET projects/9/pipelines": [{ id: 300, sha: SHA }],
      "GET projects/9/pipelines/300/jobs": [{ id: 1, name: "apply-wave-1", status: "success" }, { id: 2, name: "apply-wave-2", status: "failed" }, { id: 3, name: "apply-wave-3", status: "skipped" }],
      "POST projects/9/jobs/2/retry": { web_url: "https://gitlab.test/acme/infra/-/jobs/4" },
    };
    const f = forge(routes);
    expect(await resumeStep({ ledger: approved, forge: "gitlab", sha: SHA, env, now: T(6), fetch: f.fetch })).toMatchObject({ kind: "retried", job: "apply-wave-2", pipeline: 300, url: "https://gitlab.test/acme/infra/-/jobs/4" });
    expect(f.calls).toContain("POST projects/9/jobs/2/retry");
    // The waiting job is another wave's: nothing is retried.
    const other = forge({ ...routes, "GET projects/9/pipelines/300/jobs": [{ id: 1, name: "apply-wave-1", status: "failed" }] });
    expect(await resumeStep({ ledger: approved, forge: "gitlab", sha: SHA, env, now: T(6), fetch: other.fetch })).toMatchObject({ kind: "none", why: expect.stringContaining("apply-wave-1 of pipeline 300 has no approval that stands") });
    expect(other.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });
});

describe("resumeAfterApproval", () => {
  it("re-runs the GitHub run's failed jobs with the approver's token", async () => {
    const f = forge({ "POST repos/acme/infra/actions/runs/41/rerun-failed-jobs": {} }, "https://api.github.com/");
    const line = await resumeAfterApproval({ origin: originOf("git@github.com:acme/infra.git")!, wave: { wave: 2, runId: "41" }, env: { GH_TOKEN: "me" }, fetch: f.fetch });
    expect(line).toBe("resumed: re-ran the failed jobs of run 41, so wave 2 runs again and its gate decides");
  });

  it("retries GitLab's job of the wave, and comments /terragucci apply on Forgejo's merged pull request", async () => {
    const gl = forge({ "GET projects/acme%2Finfra/pipelines/300/jobs": [{ id: 7, name: "apply-wave-2", status: "failed" }], "POST projects/acme%2Finfra/jobs/7/retry": {} }, "https://gitlab.com/api/v4/");
    expect(await resumeAfterApproval({ origin: originOf("https://gitlab.com/acme/infra.git")!, wave: { wave: 2, runId: "300" }, env: { GITLAB_TOKEN: "me" }, fetch: gl.fetch })).toBe("resumed: retried apply-wave-2 of pipeline 300, and the waves after it follow");
    const fj = forge({ [`GET repos/acme/infra/commits/${"c".repeat(40)}/pull`]: { number: 5 }, "POST repos/acme/infra/issues/5/comments": {} }, "https://code.test/api/v1/");
    expect(await resumeAfterApproval({ origin: originOf("https://code.test/acme/infra.git", "forgejo")!, wave: { wave: 2, commit: "c".repeat(40) }, env: { FORGEJO_TOKEN: "me" }, fetch: fj.fetch })).toBe("resumed: commented /terragucci apply on pull request 5, so its waves run again and each gate decides");
  });

  it("says what is missing instead of failing: no token, no run, a forge that answers an error", async () => {
    const origin = originOf("https://gitlab.com/acme/infra")!;
    expect(await resumeAfterApproval({ origin, wave: { wave: 1, runId: "1" }, env: {} })).toMatch(/^not resumed from here: no token in GITLAB_TOKEN; the pipeline's resume job/);
    expect(await resumeAfterApproval({ origin, wave: { wave: 1 }, env: { GITLAB_TOKEN: "x" } })).toMatch(/^not resumed from here: the pending fact names no pipeline/);
    expect(await resumeAfterApproval({ origin, wave: { wave: 1, runId: "1" }, env: { GITLAB_TOKEN: "x" }, fetch: forge({}).fetch })).toMatch(/^not resumed from here \(GET .* answered 404\)/);
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
    if (forge === "forgejo") expect(JSON.stringify(w.jobs.resume.steps)).toContain("terragucci-apply-lock");
    expect(JSON.stringify(w.jobs.resume.steps)).toContain(`terragucci resume --forge ${forge} --out terragucci-resume.env`);
    // The pipeline itself is unchanged, and without apply.resume, or with gate never, there is no resume workflow.
    expect(r.content).toBe(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, gate: "always" }).content);
    expect(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "always" }).extra).toBeUndefined();
    expect(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "never", resume: 10 }).extra).toBeUndefined();
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
