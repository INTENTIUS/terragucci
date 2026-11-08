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
 * chant's forge client asks the forge (`scheduledRuns`). On GitLab it picks
 * the schedules the drift job's rule does: every active schedule whose
 * `TERRAGUCCI_SCHEDULE` names none of terragucci's other schedules.
 */
import { fileAdded, overdueVerdict, type OverdueOp } from "@intentius/chant/op/schedule-overdue";
import type { ScheduledRuns } from "@intentius/chant/pr-forge";
import type { ForgeName } from "../config";
import { prForgeOf, type Fetch, type ForgeTarget } from "../forge";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OTHER_SCHEDULES, PIPELINE_PATHS, SCHEDULE_VAR } from "../render";
import { CHANT_DRIFT_PATHS } from "../render-chant-drift";

/** The name the drift job goes by in chant's verdict and the report. */
export const DRIFT_OP = "tf-drift";

/** What a plan job with no forge token leaves for the note job: the cron and the pipeline file's first commit. */
export const DRIFT_SCHEDULE_FILE = "drift-schedule.json";

/**
 * The workflow file the drift job runs in: chant's drift Op workflow
 * (`terragucci-drift.yml`, chant issue 4622) when the checkout has it, else
 * the pipeline's, where a Forgejo repo with oidc keeps it.
 */
export function driftWorkflowPath(repo: string, forge: ForgeName): string {
  if (forge !== "gitlab" && existsSync(join(repo, CHANT_DRIFT_PATHS[forge]))) return CHANT_DRIFT_PATHS[forge];
  return PIPELINE_PATHS[forge];
}

/** Ask the forge when the drift job last ran, from `workflow` on GitHub and Forgejo (the pipeline's by default). Throws when the forge will not say. */
export async function driftRuns(fetch: Fetch, t: ForgeTarget, workflow: string = PIPELINE_PATHS[t.forge]): Promise<ScheduledRuns> {
  return prForgeOf(t, fetch).scheduledRuns!({ op: DRIFT_OP, workflow: workflow.split("/").pop()!, schedule: { variable: SCHEDULE_VAR, not: OTHER_SCHEDULES } });
}

/** When the drift job's workflow file first appeared in the checkout's history (ISO 8601), if the history has it. */
export const pipelineAdded = (repo: string, forge: ForgeName): string | undefined => fileAdded(repo, driftWorkflowPath(repo, forge));

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
    runs = await driftRuns(fetch, target, driftWorkflowPath(repo, target.forge));
  } catch (e) {
    log(`drift schedule: the forge did not say when the drift job last ran, so it is not checked: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
  const found = driftOverdue(cron, target.forge, runs, runs.last ? undefined : pipelineAdded(repo, target.forge), now);
  if (found) log(found.message);
  return found;
}
