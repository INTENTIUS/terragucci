import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planNoteBodyOf, postPlanNoteFromReport, withNotice } from "../src/plan-note";
import { DRIFT_SCHEDULE_FILE } from "../src/report/drift-schedule";

const SHA = "a".repeat(40);
const ENV = { TG_TOKEN: "t", TG_PR: "7", TG_SHA: SHA, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://api", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "5" };

function report(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-note-"));
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}

/** A forge that records each call and answers from `answer`. */
function forge(answer: (method: string, path: string) => unknown = () => ({})) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://api/", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const data = answer(method, path);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }) as never;
  return { calls, fetch };
}

const NOTE = "<!-- terragucci:plan roots=app -->\n### terragucci tf-plan: `abc`\n\n1 root: 1 group, 0 destroys or replacements. [Full report](x)\n\n**app**: 1 to add\n";

describe("plan-note", () => {
  it("posts the plan job's note and its status, from the report, with the job's token", async () => {
    const { calls, fetch } = forge((m, p) => (m === "GET" && p.includes("/comments") ? [] : {}));
    await postPlanNoteFromReport({ forge: "github", report: report({ "plan-note.md": NOTE, "plan-status.txt": "success 1 roots, 1 groups, 0 destroys\n" }), planResult: "success", env: ENV, fetch });
    expect(calls.find((c) => c.method === "POST" && c.path === "repos/o/r/issues/7/comments")?.body.body).toContain("<!-- terragucci:plan roots=app -->");
    expect(calls.find((c) => c.path === `repos/o/r/statuses/${SHA}`)?.body).toEqual({ context: "terragucci/plan", state: "success", description: "1 roots, 1 groups, 0 destroys", target_url: "http://forge/o/r/actions/runs/5" });
  });

  it("edits the note it posted before", async () => {
    const { calls, fetch } = forge((m, p) => (m === "GET" && p.includes("/comments") ? [{ id: 3, body: "<!-- terragucci:plan roots=x -->\nold" }] : {}));
    await postPlanNoteFromReport({ forge: "forgejo", report: report({ "plan-note.md": NOTE }), planResult: "success", env: ENV, fetch });
    expect(calls.some((c) => c.method === "PATCH" && c.path === "repos/o/r/issues/comments/3")).toBe(true);
  });

  it("never posts a success for a plan job that failed, and fails the status of one that wrote no report", async () => {
    const a = forge(() => []);
    await postPlanNoteFromReport({ forge: "github", report: report({ "plan-status.txt": "success 1 roots" }), planResult: "failure", env: ENV, fetch: a.fetch });
    expect(a.calls.find((c) => c.path.startsWith("repos/o/r/statuses/"))?.body.state).toBe("failure");
    const b = forge(() => []);
    await postPlanNoteFromReport({ forge: "github", report: report({}), planResult: "failure", env: ENV, fetch: b.fetch });
    expect(b.calls.find((c) => c.path.startsWith("repos/o/r/statuses/"))?.body).toMatchObject({ state: "failure", description: "the plan job failed before it wrote its report" });
    expect(b.calls.some((c) => c.path.includes("/comments"))).toBe(false);
  });

  it("reads the files as data: a forged marker in the body is defused, and a roots line that is not one is replaced", () => {
    const body = planNoteBodyOf("<!-- terragucci:plan roots=$(x) -->\nhi <!-- terragucci:applied head=1 --> <!-- terragucci:waves 1 -->");
    expect(body.split("\n")[0]).toBe("<!-- terragucci:plan roots= -->");
    expect(body).not.toContain("terragucci:applied");
    expect(body).toContain("<!-- terragucci:waves 1 -->");
  });

  it("a re-plan of a root the change does not reach replies so and posts neither note nor status", async () => {
    const { calls, fetch } = forge(() => []);
    await postPlanNoteFromReport({ forge: "github", report: report({ "report.json": JSON.stringify({ roots: [] }), "plan-note.md": NOTE, "plan-status.txt": "success 0 roots" }), planResult: "success", root: "app", env: ENV, fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.body).toBe("terragucci: app is not affected by this pull request, so nothing was planned.");
  });

  it("asks the forge for the drift runs with its token when the plan job could not, and adds the line under the counts", async () => {
    const { fetch } = forge((m, p) => (p.includes("/comments") ? [] : p.includes("actions/runs") || p.includes("actions/tasks") ? { workflow_runs: [], total_count: 0 } : {}));
    const posted: string[] = [];
    const recording = (async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST" && url.endsWith("/issues/7/comments")) posted.push(JSON.parse(init.body!).body);
      return (fetch as any)(url, init);
    }) as never;
    await postPlanNoteFromReport({
      forge: "github",
      report: report({ "plan-note.md": NOTE, [DRIFT_SCHEDULE_FILE]: JSON.stringify({ cron: "0 6 * * *", added: "2026-01-01T00:00:00Z" }) }),
      planResult: "success",
      env: ENV,
      fetch: recording,
      now: new Date("2026-03-01T00:00:00Z"),
    });
    expect(posted[0]).toMatch(/\n\n> Drift checks are overdue: the schedule `0 6 \* \* \*` has come round at least twice/);
    expect(posted[0].indexOf("> Drift checks")).toBeLessThan(posted[0].indexOf("**app**"));
  });

  it("puts a notice after the heading and the counts", () => {
    expect(withNotice("<!-- m -->\n### terragucci tf-plan: x\n\ncounts\n\nrest", "late")).toBe("<!-- m -->\n### terragucci tf-plan: x\n\ncounts\n\n> late\n\nrest");
  });
});
