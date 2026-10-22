/**
 * Drift checks that stopped, by chant's check for scheduled Ops that stopped
 * running (`overdueVerdict` in `@intentius/chant/op/schedule-overdue`). A
 * schedule can stop with no error anywhere: GitHub turns a scheduled workflow
 * off after 60 days with no activity in the repo and drops scheduled runs
 * under load, and a GitLab schedule exists only once someone creates it. The
 * drift job cannot report its own absence, so the plan job, which runs on
 * every pull request, does. With `drift:` set it asks the forge when the
 * drift job last ran from its schedule or by hand. When the cron has fired
 * at least twice since, or since the pipeline file was added for a schedule
 * that never ran, the job log, the report's `overdue` and the plan note say
 * so.
 *
 * chant's forge client asks GitHub and Forgejo (`scheduledRuns`). A GitLab
 * drift schedule is one with no `TERRAGUCCI_SCHEDULE=comments`, which chant's
 * client does not select by, so terragucci asks GitLab itself.
 */
import { fileAdded, overdueVerdict, type OverdueOp } from "@intentius/chant/op/schedule-overdue";
import type { ScheduledRuns } from "@intentius/chant/pr-forge";
import type { ForgeName } from "../config";
import { call, prForgeOf, type Fetch, type ForgeTarget } from "../forge";
import { PIPELINE_PATHS, SCHEDULE_VAR } from "../render";

/** The name the drift job goes by in chant's verdict and the report. */
export const DRIFT_OP = "tf-drift";

/** What a plan job with no forge token leaves for the note job: the cron and the pipeline file's first commit. */
export const DRIFT_SCHEDULE_FILE = "drift-schedule.json";

type Json = Record<string, unknown>;

const newest = (dates: (string | undefined)[]): string | undefined =>
  dates.filter((d): d is string => typeof d === "string" && !Number.isNaN(Date.parse(d))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];

/** GitLab: the newest pipeline of an active schedule that is not the comments schedule. */
async function gitlabDriftRuns(fetch: Fetch, t: ForgeTarget): Promise<ScheduledRuns> {
  const id = encodeURIComponent(t.path);
  const pipelines = (await call(fetch, t, "GET", `/projects/${id}/pipelines?source=schedule&per_page=1&order_by=id&sort=desc`)) as Json[];
  const schedules = (await call(fetch, t, "GET", `/projects/${id}/pipeline_schedules?scope=active&per_page=100`)) as Json[];
  // The comments schedule runs no drift job. Its variables are on each schedule, not the list.
  const details = (await Promise.all(schedules.map((s) => call(fetch, t, "GET", `/projects/${id}/pipeline_schedules/${Number(s.id)}`)))) as Json[];
  const isComments = (d: Json): boolean => Array.isArray(d.variables) && d.variables.some((v: Json) => v?.key === SCHEDULE_VAR && v?.value === "comments");
  if (!details.some(isComments)) {
    const last = newest(pipelines.map((p) => p.created_at as string | undefined));
    return { ...(last ? { last } : {}), ...(schedules.length === 0 ? { noSchedule: true } : {}) };
  }
  const drift = details.filter((d) => !isComments(d));
  const lastIds = drift.map((d) => Number((d.last_pipeline as Json | undefined)?.id)).filter((n) => Number.isInteger(n) && n > 0);
  const lasts = (await Promise.all(lastIds.map((n) => call(fetch, t, "GET", `/projects/${id}/pipelines/${n}`)))) as Json[];
  const last = newest(lasts.map((p) => p.created_at as string | undefined));
  return { ...(last ? { last } : {}), ...(drift.length === 0 ? { noSchedule: true } : {}) };
}

/** Ask the forge when the drift job last ran. Throws when the forge will not say. */
export async function driftRuns(fetch: Fetch, t: ForgeTarget): Promise<ScheduledRuns> {
  if (t.forge === "gitlab") return gitlabDriftRuns(fetch, t);
  return prForgeOf(t, fetch).scheduledRuns!({ op: DRIFT_OP, workflow: PIPELINE_PATHS[t.forge].split("/").pop()! });
}

/** When the pipeline file first appeared in the checkout's history (ISO 8601), if the history has it. */
export const pipelineAdded = (repo: string, forge: ForgeName): string | undefined => fileAdded(repo, PIPELINE_PATHS[forge]);

/**
 * chant's verdict on the drift job. chant's GitLab line for a missing
 * schedule names its own Op selector, so a GitLab project with none gets the
 * general GitLab line, which points at CI/CD > Schedules.
 */
export function driftOverdue(cron: string, forge: ForgeName, runs: ScheduledRuns, added: string | undefined, now: Date): OverdueOp | undefined {
  const { noSchedule: _n, ...rest } = runs;
  return overdueVerdict({ op: DRIFT_OP, cron }, forge, forge === "gitlab" ? rest : runs, added, now);
}

/**
 * The plan job's check: ask the forge, fall back on the pipeline file's
 * history, and say whether the drift checks are overdue. A forge that will
 * not answer (no token with read access to the runs, an older forge) is a
 * line in the log and no verdict.
 */
export async function checkDriftSchedule(repo: string, cron: string, target: ForgeTarget, fetch: Fetch, now: Date, log: (line: string) => void): Promise<OverdueOp | undefined> {
  let runs: ScheduledRuns;
  try {
    runs = await driftRuns(fetch, target);
  } catch (e) {
    log(`drift schedule: the forge did not say when the drift job last ran, so it is not checked: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
  const found = driftOverdue(cron, target.forge, runs, runs.last ? undefined : pipelineAdded(repo, target.forge), now);
  if (found) log(found.message);
  return found;
}
