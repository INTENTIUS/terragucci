// Drift checks that stopped: chant's verdict on the drift job, what each forge
// says about its runs, and the plan note that says it is overdue.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkDriftSchedule, driftOverdue as overdue, driftRuns, pipelineAdded } from "../src/report/overdue";
import type { Fetch, ForgeTarget } from "../src/forge";
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

describe("overdue", () => {
  const now = at("2026-10-07T12:00:00Z");

  it("counts the scheduled times since the last run: one missed is on time, two are overdue", () => {
    // One late or dropped run (October 7th's) is not enough.
    expect(overdue("0 6 * * *", "github", { last: "2026-10-06T06:03:00Z" }, undefined, now)).toBeUndefined();
    // Two are: October 6th's and 7th's.
    expect(overdue("0 6 * * *", "github", { last: "2026-10-05T06:03:00Z" }, undefined, now)).toBeDefined();
  });

  it("is overdue once the schedule came round twice with no run, and names the last one", () => {
    const o = overdue("0 6 * * *", "github", { last: "2026-08-01T06:03:00Z" }, undefined, now);
    expect(o?.since).toBe("2026-08-01T06:03:00Z");
    expect(o).toMatchObject({ op: "tf-drift", cron: "0 6 * * *" });
    expect(o?.message).toMatch(/Op `tf-drift` is overdue: its schedule `0 6 \* \* \*` has fired at least twice and its last run was on 2026-08-01/);
    expect(o?.message).toMatch(/GitHub turns a scheduled workflow off after 60 days/);
  });

  it("counts from the pipeline file's commit when the drift job never ran", () => {
    expect(overdue("0 6 * * *", "forgejo", {}, "2026-10-07T00:00:00Z", now)).toBeUndefined();
    const o = overdue("0 6 * * *", "forgejo", {}, "2026-01-01T00:00:00Z", now);
    expect(o?.neverRan).toBe(true);
    expect(o?.message).toMatch(/no run is on record since its pipeline was added on 2026-01-01/);
  });

  it("says why when the forge does: a workflow GitHub turned off; a GitLab project with no schedule gets the Schedules line", () => {
    expect(overdue("0 6 * * *", "github", { last: "2026-01-01T06:00:00Z", disabled: "disabled_inactivity" }, undefined, now)?.message).toMatch(/GitHub has turned the workflow off \(disabled_inactivity\)/);
    const gitlab = overdue("17 4 * * *", "gitlab", { noSchedule: true }, "2026-01-01T00:00:00Z", now)?.message;
    expect(gitlab).toMatch(/Check its schedule under CI\/CD > Schedules/);
    expect(gitlab).not.toContain("CHANT_SCHEDULED_OP");
  });

  it("says nothing for a schedule it cannot read, or with nothing to count from", () => {
    expect(overdue("@daily", "github", { last: "2026-01-01T00:00:00Z" }, undefined, now)).toBeUndefined();
    expect(overdue("0 6 * * *", "github", {}, undefined, now)).toBeUndefined();
  });
});

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

  it("gitlab: the newest scheduled pipeline, and whether the project has an active schedule", async () => {
    const { fetch, asked } = forge([
      ["pipelines?source=schedule", []],
      ["pipeline_schedules", []],
    ]);
    expect(await driftRuns(fetch, target("gitlab"))).toEqual({ noSchedule: true });
    expect(asked[0]).toContain("/api/v4/projects/acme%2Finfra/pipelines?source=schedule");
  });

  it("gitlab: the comments schedule's pipelines are no drift runs", async () => {
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
    expect(pipelineAdded(repo, "forgejo")?.slice(0, 10)).toBe("2026-01-01");
    const log: string[] = [];
    const found = await checkDriftSchedule(repo, "0 6 * * *", target("forgejo"), forge([["/actions/runs", []]]).fetch, at("2026-10-07T00:00:00Z"), (l) => log.push(l));
    expect(found?.message).toMatch(/since its pipeline was added on 2026-01-01/);
    expect(log).toEqual([found!.message]);
  });

  it("checks nothing, with a line in the log, when the forge will not say", async () => {
    const log: string[] = [];
    expect(await checkDriftSchedule(tmp(), "0 6 * * *", target("github"), forge([], 403).fetch, at("2026-10-07T00:00:00Z"), (l) => log.push(l))).toBeUndefined();
    expect(log[0]).toMatch(/^drift schedule: the forge did not say when the drift job last ran, so it is not checked: GET .* answered 403/);
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
