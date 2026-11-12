import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { renderPipeline, resumeCron } from "../src/render";
import { originOf, resumeAfterApproval } from "../src/resume";
import { driftOp } from "./helpers";

// Which waves resume, and the GitLab resume, are chant's resume job (`terragucci run resume`); terragucci keeps the approver's resume.

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

describe("resumeAfterApproval through chant's resumeGateRun", () => {
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

  it("re-runs the GitHub run that waited, with the approver's token", async () => {
    const f = await api({ "GET /repos/acme/infra/actions/runs/41": { status: "completed", conclusion: "failure", run_attempt: 1 }, "POST /repos/acme/infra/actions/runs/41/rerun-failed-jobs": {} });
    const resume = { forge: "github", api: f.base, repo: "acme/infra", run: "41", attempt: 1 };
    const line = await resumeAfterApproval({ origin: originOf("git@github.com:acme/infra.git")!, wave: { wave: 2, resume: resume as never }, env: { ...process.env, GH_TOKEN: "me" } });
    expect(line).toBe("resumed: re-ran the failed jobs of run 41, so wave 2 runs again and its gate decides");
    expect(f.calls).toContain("POST /repos/acme/infra/actions/runs/41/rerun-failed-jobs");
  });

  it("retries GitLab's waiting job of a migration, and comments /terragucci apply on Forgejo's merged pull request", async () => {
    const f = await api({ "GET /projects/9/jobs/7": { status: "failed", name: "apply-wave-1" }, "GET /projects/9/pipelines/300/jobs": [{ id: 7, name: "apply-wave-1" }], "POST /projects/9/jobs/7/retry": { id: 8 } });
    const resume = { forge: "gitlab", api: f.base, repo: "9", run: "300", job: "7", jobName: "apply-wave-1" };
    const line = await resumeAfterApproval({ origin: originOf("https://gitlab.com/acme/infra.git")!, wave: { wave: 1, resume: resume as never }, env: { ...process.env, GITLAB_TOKEN: "me" } });
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
    expect(await resumeAfterApproval({ origin: originOf("git@github.com:acme/infra.git")!, wave: { wave: 2, resume: resume as never }, env: { ...process.env, GH_TOKEN: "me" } })).toMatch(/^not resumed from here: run 41 succeeded;/);
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

  it.each(["github", "forgejo"] as const)("%s: a resume workflow of its own runs chant's resume on its schedule", (forge) => {
    const r = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, gate: "always", resume: 10 });
    expect(r.extra).toHaveLength(1);
    const extra = r.extra![0]!;
    expect(extra.path).toBe(forge === "github" ? ".github/workflows/terragucci-resume.yml" : ".forgejo/workflows/terragucci-resume.yml");
    const w = doc(extra.content);
    expect(w.on).toEqual({ schedule: [{ cron: "*/10 * * * *" }], workflow_dispatch: {} });
    expect(Object.keys(w.jobs)).toEqual(["resume"]);
    // chant's resume starts the waiting wave job again; nothing applies in the resume job itself.
    const steps = JSON.stringify(w.jobs.resume.steps);
    expect(steps).toContain("terragucci run resume --op tf-apply");
    expect(steps).not.toContain("terragucci stage tf-apply");
    expect(steps).not.toContain("terragucci-apply-lock");
    // The pipeline itself is unchanged, and without apply.resume there is no resume workflow.
    expect(r.content).toBe(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, gate: "always" }).content);
    expect(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "always" }).extra).toBeUndefined();
    // Under gate never too: a state migration waits in wave 1 whatever the gate.
    const never = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "never", resume: 10 });
    expect(never.extra?.map((e) => e.path)).toEqual([extra.path]);
  });

  it("gitlab: a resume job for the pipeline schedule TERRAGUCCI_SCHEDULE=resume, which drift's job sits out", () => {
    const out = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "always", resume: 15, drift: "0 6 * * *" });
    const d = doc(out.content);
    expect(d.resume.stage).toBe("resume");
    expect(d.resume.rules).toEqual([{ if: '(($CI_PIPELINE_SOURCE != "schedule" || $TERRAGUCCI_SCHEDULE == "resume") && $CHANT_PLAN_NOTES == null) && ($CI_PIPELINE_SOURCE == "schedule")' }]);
    expect(d.resume.script).toEqual(["terragucci run resume --op tf-apply"]);
    expect(driftOp(out, "gitlab")!.job.rules[0].if).toContain('$TERRAGUCCI_SCHEDULE != "resume"');
    // A wave job runs on a push to the default branch.
    expect(d["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it("the schedule's cron", () => {
    expect(resumeCron(5)).toBe("*/5 * * * *");
    expect(resumeCron(60)).toBe("0 * * * *");
  });

  it("takes 5 to 60 minutes", () => {
    expect(validateConfig({ apply: { resume: 10 } }, "t").apply).toEqual({ resume: 10 });
    for (const bad of [4, 61, 7.5, "10"]) expect(() => validateConfig({ apply: { resume: bad } }, "t")).toThrow(/apply.resume must be the minutes between the resume job's runs, from 5 to 60/);
  });
});
