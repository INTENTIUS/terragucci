/**
 * Drift checks that stopped, by chant's check for scheduled Ops that stopped
 * running (`checkOverdueOps` in `@intentius/chant/op/schedule-overdue`). A
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
import { checkOverdueOps, type OverdueOp, type ScheduledWatch } from "@intentius/chant/op/schedule-overdue";
import { forgeClient, type ForgeTarget, type ScheduledRuns } from "@intentius/chant/pr-forge";
import type { ForgeName } from "../config";
import type { Fetch } from "../forge";
import { OTHER_SCHEDULES, PIPELINE_PATHS, SCHEDULE_VAR } from "../render";
import { CHANT_DRIFT_PATHS } from "../render-chant-drift";

/** The name the drift job goes by in chant's verdict and the report. */
export const DRIFT_OP = "tf-drift";

/** Ask the forge when the drift job last ran, from `workflow` on GitHub and Forgejo (the pipeline's by default). Throws when the forge will not say. */
export async function driftRuns(fetch: Fetch, t: ForgeTarget, workflow: string = PIPELINE_PATHS[t.kind]): Promise<ScheduledRuns> {
  return forgeClient(t, fetch).scheduledRuns!({ op: DRIFT_OP, workflow: workflow.split("/").pop()!, schedule: driftSchedule() });
}

/** GitLab: the drift job's schedule selector, every schedule whose TERRAGUCCI_SCHEDULE names none of terragucci's others. A function, since ../render.ts reads this file while it loads. */
const driftSchedule = (): { variable: string; not: readonly string[] } => ({ variable: SCHEDULE_VAR, not: OTHER_SCHEDULES });

/**
 * The drift job's watch for chant's check: the files it runs in, chant's
 * drift Op file (chant issue 4622) first, then the pipeline's, where a
 * Forgejo repo with oidc keeps it; on GitLab, the schedule selector.
 */
export function driftWatch(cron: string, forge: ForgeName): ScheduledWatch {
  return { op: DRIFT_OP, cron, files: [CHANT_DRIFT_PATHS[forge], PIPELINE_PATHS[forge]], ...(forge === "gitlab" ? { schedule: driftSchedule() } : {}) };
}

/**
 * The plan job's check, chant's `checkOverdueOps`: ask the forge, fall back
 * on the pipeline file's history, and say whether the drift checks are
 * overdue. A forge that will not answer (no token with read access to the
 * runs, an older forge) is a line in the log and no verdict.
 */
export async function checkDriftSchedule(repo: string, cron: string, target: ForgeTarget, fetch: Fetch, now: Date, log: (line: string) => void): Promise<OverdueOp | undefined> {
  const [found] = await checkOverdueOps({ watches: [driftWatch(cron, target.kind)], forge: forgeClient(target, fetch), repoRoot: repo, now, log });
  return found;
}
