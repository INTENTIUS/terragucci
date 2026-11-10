// Drift checks that stopped: the drift job's watch for chant's check, what
// each forge says about its runs, and the plan note that says it is overdue.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { opPipelineFile } from "@intentius/chant/op/schedule-overdue";
import { checkDriftSchedule, driftRuns, driftWatch } from "../src/report/overdue";
import type { Fetch, ForgeTarget } from "../src/forge";
import { OTHER_SCHEDULES } from "../src/render";
import { renderNote } from "../src/report/views";
import { buildReport } from "../src/report/build";
import { RUN } from "./report-fixtures";
import { git, tmp, write } from "./helpers";

const at = (s: string) => new Date(s);

/** A forge API answering `answers` by URL substring, recording each URL asked. */
function forge(answers: [string, unknown][], status = 200): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    const hit = answers.find(([k]) => url.includes(k));
    const body = hit ? hit[1] : {};
    return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, asked };
}

const target = (f: ForgeTarget["forge"]): ForgeTarget => ({ forge: f, origin: f === "github" ? "https://github.com" : "https://git.example.com", path: "acme/infra", token: "t" });

describe("driftRuns", () => {
  it("github: the newest scheduled or manual run of the terragucci workflow, and whether it is off", async () => {
    const { fetch, asked } = forge([
      ["runs?event=schedule", { workflow_runs: [{ created_at: "2026-07-01T06:01:00Z" }] }],
      ["runs?event=workflow_dispatch", { workflow_runs: [{ created_at: "2026-07-20T10:00:00Z" }] }],
      ["/actions/workflows/terragucci.yml", { state: "disabled_inactivity" }],
    ]);
    expect(await driftRuns(fetch, target("github"))).toEqual({ last: "2026-07-20T10:00:00Z", disabled: "disabled_inactivity" });
    expect(asked[0]).toBe("https://api.github.com/repos/acme/infra/actions/workflows/terragucci.yml");
  });

  it("asks about chant's drift Op workflow once the checkout has it (chant issue 4622)", async () => {
    const repo = tmp();
    const file = (f: "github" | "forgejo") => opPipelineFile(repo, f, driftWatch("0 6 * * *", f));
    write(repo, { ".github/workflows/terragucci.yml": "on: push\n", ".forgejo/workflows/terragucci.yml": "on: push\n" });
    expect(file("github")).toBe(".github/workflows/terragucci.yml");
    write(repo, { ".github/workflows/terragucci-drift.yml": "name: terragucci-drift\n" });
    expect(file("github")).toBe(".github/workflows/terragucci-drift.yml");
    expect(file("forgejo")).toBe(".forgejo/workflows/terragucci.yml");
    const { fetch, asked } = forge([["runs?event=schedule", { workflow_runs: [{ created_at: "2026-07-01T06:01:00Z" }] }]]);
    await driftRuns(fetch, target("github"), file("github"));
    expect(asked[0]).toBe("https://api.github.com/repos/acme/infra/actions/workflows/terragucci-drift.yml");
  });

  it("gitlab: a project with no active schedule has no drift schedule", async () => {
    const { fetch, asked } = forge([["pipeline_schedules", []]]);
    expect(await driftRuns(fetch, target("gitlab"))).toEqual({ noSchedule: true });
    expect(asked[0]).toContain("/api/v4/projects/acme%2Finfra/pipeline_schedules?scope=active");
  });

  it("gitlab: the comments schedule's pipelines are no drift runs, and a schedule without TERRAGUCCI_SCHEDULE is drift's", async () => {
    // Longer keys first: the fake answers the first key a URL contains.
    const { fetch } = forge([
      ["pipeline_schedules/1", { id: 1, variables: [{ key: "TERRAGUCCI_SCHEDULE", value: "comments" }], last_pipeline: { id: 90 } }],
      ["pipeline_schedules/2", { id: 2, variables: [], last_pipeline: { id: 50 } }],
      ["pipeline_schedules?", [{ id: 1 }, { id: 2 }]],
      ["pipelines?source=schedule", [{ created_at: "2026-10-07T11:55:00Z" }]],
      ["pipelines/50", { id: 50, created_at: "2026-09-01T06:00:00Z" }],
    ]);
    expect(await driftRuns(fetch, target("gitlab"))).toEqual({ last: "2026-09-01T06:00:00Z" });
    const only = forge([
      ["pipeline_schedules/1", { id: 1, variables: [{ key: "TERRAGUCCI_SCHEDULE", value: "comments" }], last_pipeline: { id: 90 } }],
      ["pipeline_schedules?", [{ id: 1 }]],
      ["pipelines?source=schedule", [{ created_at: "2026-10-07T11:55:00Z" }]],
    ]);
    expect(await driftRuns(only.fetch, target("gitlab"))).toEqual({ noSchedule: true });
  });

  it("forgejo: reads each run's event and workflow, whatever the query honours", async () => {
    const { fetch } = forge([
      ["/actions/runs", { workflow_runs: [
        { event: "pull_request", workflow_id: "terragucci.yml", created: "2026-09-30T00:00:00Z" },
        { event: "schedule", workflow_id: "other.yml", created: "2026-09-29T00:00:00Z" },
        { event: "schedule", workflow_id: "terragucci.yml", created: "2026-09-01T06:00:00Z" },
      ] }],
    ]);
    expect(await driftRuns(fetch, target("forgejo"))).toEqual({ last: "2026-09-01T06:00:00Z" });
  });
});

describe("checkDriftSchedule", () => {
  it("falls back on the pipeline file's first commit, and logs the verdict", async () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    write(repo, { ".forgejo/workflows/terragucci.yml": "on: push\n" });
    git(repo, "add", "-A");
    execGit(repo, "2026-01-01T00:00:00Z", "pipeline");
    const log: string[] = [];
    const found = await checkDriftSchedule(repo, "0 6 * * *", target("forgejo"), forge([["/actions/runs", []]]).fetch, at("2026-10-07T00:00:00Z"), (l) => log.push(l));
    expect(found?.message).toMatch(/since its pipeline was added on 2026-01-01/);
    expect(log).toEqual([found!.message]);
  });

  it("gitlab: a project with no drift schedule is told the job's selector", async () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    const rule = OTHER_SCHEDULES.map((n) => `$TERRAGUCCI_SCHEDULE != "${n}"`).join(" && ");
    write(repo, { ".gitlab/terragucci.yml": `drift:\n  rules:\n    - if: '${rule}'\n` });
    git(repo, "add", "-A");
    execGit(repo, "2026-01-01T00:00:00Z", "pipeline");
    const found = await checkDriftSchedule(repo, "0 6 * * *", target("gitlab"), forge([["pipeline_schedules", []]]).fetch, at("2026-10-07T00:00:00Z"), () => {});
    expect(found?.message).toMatch(/No active pipeline schedule is picked by the Op's rule, one whose TERRAGUCCI_SCHEDULE is none of /);
    expect(found?.message).toMatch(/under CI\/CD > Schedules/);
  });

  it("checks nothing, with a line in the log, when the forge will not say", async () => {
    const log: string[] = [];
    const repo = tmp();
    write(repo, { ".github/workflows/terragucci.yml": "on: push\n" });
    expect(await checkDriftSchedule(repo, "0 6 * * *", target("github"), forge([], 403).fetch, at("2026-10-07T00:00:00Z"), (l) => log.push(l))).toBeUndefined();
    expect(log[0]).toMatch(/^schedule check: github did not say when Op tf-drift last ran, so it is not checked: GET .* answered 403/);
  });

  it("puts the verdict in the plan note, under the summary", () => {
    const report = buildReport({ run: RUN, roots: [] });
    expect(renderNote(report, { notices: ["Op `tf-drift` is overdue: test."] })).toContain("> Op `tf-drift` is overdue: test.\n");
    expect(renderNote(report)).not.toContain("is overdue");
  });
});

/** Commit with both dates set, so the history says when the file was added. */
function execGit(repo: string, date: string, message: string): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env });
}
