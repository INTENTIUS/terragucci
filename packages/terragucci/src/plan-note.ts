/**
 * The plan note and the `terragucci/plan` status on GitHub and Forgejo,
 * posted by the `plan-note` job (and `replan-note` for a comment's re-plan).
 *
 * The plan job runs the pull request's code: its providers, modules, external
 * data sources, synth command and Terragrunt hooks. So it holds no forge
 * token. It writes the note and the status into its report directory
 * (PLAN_NOTE_FILE, PLAN_STATUS_FILE) and keeps the directory as an artifact.
 * The note job starts in a fresh container after it, checks nothing out, runs
 * none of the change's code, and posts the two with the job's token.
 *
 * Both files are the pull request's: its code can write anything into them.
 * So they are read as data, as the GitLab comments job reads them
 * (plan-note-gitlab.ts): the status's state from a fixed set and never a
 * success when the plan job failed, the note's roots from a fixed pattern,
 * and every terragucci marker dropped from the body but the waves marker and
 * the description flag.
 *
 * With `drift:` set, the plan job asks the forge whether the drift checks are
 * overdue. With no token it can ask only a public repo, so it leaves the cron
 * and the pipeline file's first commit in DRIFT_SCHEDULE_FILE, and this job
 * asks with its token and adds the line to the note when the plan job could
 * not.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiOf } from "./comment";
import type { Fetch } from "./forge";
import { FORGED, PLAN_MARK, PLAN_NOTE_FILE, PLAN_STATUS_FILE, planStatus, ROOTS_LINE } from "./plan-note-gitlab";
import { DRIFT_SCHEDULE_FILE, driftRuns, overdue } from "./report/drift-schedule";

export { DRIFT_SCHEDULE_FILE };
import { targetFromEnv } from "./report/drift";
import { approvalStatus } from "./review";

/** How the note says the drift checks are overdue (overdue() in drift-schedule.ts). */
const OVERDUE = "Drift checks are overdue:";
/** GitHub keeps a status description to 140 characters. */
const MAX_DESCRIPTION = 140;
/** GitHub keeps a comment to 65536 characters. */
const MAX_NOTE = 65_000;

export interface PlanNoteOptions {
  forge: "github" | "forgejo";
  /** The plan job's report directory, as the artifact came down. */
  report: string;
  /** The plan job's result: `success`, `failure`, or anything else the forge says. */
  planResult: string;
  /** A re-plan of one named root: when the change reaches no root, the job replies so and leaves the note and the status. */
  root?: string;
  /** `approval: pr-review`: also post `terragucci/approval` on the head from the report. */
  approval?: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  now?: Date;
  log?: (line: string) => void;
}

/** The note as the job posts it: its own first line, the plan job's body with no marker but the waves marker and the description flag. */
export function planNoteBodyOf(file: string): string {
  const lines = file.replace(/\r\n/g, "\n").split("\n");
  const roots = ROOTS_LINE.exec(lines[0] ?? "")?.[1];
  const rest = (roots !== undefined ? lines.slice(1) : lines).join("\n").replace(FORGED, "<!-- ").trimEnd();
  const body = rest.length > MAX_NOTE ? `${rest.slice(0, MAX_NOTE)}\n\nThe note was cut at ${MAX_NOTE} characters; the run's report has all of it.` : rest;
  return `${PLAN_MARK} roots=${roots ?? ""} -->\n${body}`;
}

/** The note with `> line` added under its counts, where the plan job puts its notices. */
export function withNotice(body: string, line: string): string {
  const lines = body.split("\n");
  const heading = lines.findIndex((l) => l.startsWith("### terragucci "));
  // The heading, a blank line, the counts, a blank line: the notice goes after them.
  const at = heading >= 0 && heading + 4 <= lines.length ? heading + 4 : lines.length;
  lines.splice(at, 0, `> ${line}`, "");
  return lines.join("\n");
}

/** The drift line the note lacks, when the plan job left the schedule and the forge says the checks are overdue. */
async function driftNotice(o: PlanNoteOptions, env: NodeJS.ProcessEnv, doFetch: Fetch, log: (l: string) => void): Promise<string | undefined> {
  const file = join(o.report, DRIFT_SCHEDULE_FILE);
  if (!existsSync(file)) return undefined;
  let left: { cron?: unknown; added?: unknown };
  try {
    left = JSON.parse(readFileSync(file, "utf-8")) as { cron?: unknown; added?: unknown };
  } catch {
    return undefined;
  }
  if (typeof left.cron !== "string") return undefined;
  const added = typeof left.added === "string" && !Number.isNaN(Date.parse(left.added)) ? left.added : undefined;
  const target = targetFromEnv(o.forge, env, env.TG_TOKEN);
  if (!target) return undefined;
  try {
    const found = overdue(left.cron, o.forge, await driftRuns(doFetch, target), added, o.now ?? new Date());
    if (found) log(found.message);
    return found?.message;
  } catch (e) {
    log(`drift schedule: the forge did not say when the drift job last ran, so it is not checked: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

/** Post the plan job's note and status; a forge call that fails is said and never fails the job. */
export async function postPlanNoteFromReport(o: PlanNoteOptions): Promise<string[]> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const said: string[] = [];
  const log = o.log ?? ((l: string) => said.push(l));
  const pr = (env.TG_PR ?? "").trim();
  const sha = (env.TG_SHA ?? "").trim();
  if (!/^\d+$/.test(pr) || !/^[0-9a-f]{40}$/.test(sha)) {
    log("terragucci plan-note: TG_PR and TG_SHA must name the pull request and its head, so nothing is posted");
    return said;
  }
  const { api, repo, token } = apiOf(env);
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await doFetch(`${api}/${path}`, { method, headers: { "content-type": "application/json", authorization: `token ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  const read = (name: string): string | undefined => (existsSync(join(o.report, name)) ? readFileSync(join(o.report, name), "utf-8") : undefined);

  if (o.root) {
    // A named root the change does not reach: the plan planned nothing and held nothing back.
    let unreached = false;
    try {
      const report = JSON.parse(read("report.json") ?? "null") as { roots?: unknown[]; deferred?: unknown[] } | null;
      unreached = Boolean(report && Array.isArray(report.roots) && report.roots.length === 0 && !(report.deferred ?? []).length);
    } catch {
      unreached = false;
    }
    if (unreached) {
      try {
        await call("POST", `repos/${repo}/issues/${pr}/comments`, { body: `terragucci: ${o.root} is not affected by this pull request, so nothing was planned.` });
        log(`terragucci plan-note: ${o.root} is not affected by pull request ${pr}; replied so`);
      } catch (e) {
        log(`terragucci: reply failed: ${(e as Error).message}`);
      }
      return said;
    }
  }

  const noteFile = read(PLAN_NOTE_FILE);
  if (noteFile !== undefined) {
    let body = planNoteBodyOf(noteFile);
    if (!body.includes(OVERDUE)) {
      const late = await driftNotice(o, env, doFetch, log);
      if (late) body = withNotice(body, late);
    }
    try {
      const comments = (await call("GET", `repos/${repo}/issues/${pr}/comments?per_page=100`)) as any[];
      const old = (Array.isArray(comments) ? comments : []).find((c) => typeof c?.body === "string" && c.body.startsWith(PLAN_MARK));
      if (old) await call("PATCH", `repos/${repo}/issues/comments/${old.id}`, { body });
      else await call("POST", `repos/${repo}/issues/${pr}/comments`, { body });
      log(`terragucci plan-note: posted the plan note on pull request ${pr}`);
    } catch (e) {
      log(`terragucci: note failed: ${(e as Error).message}`);
    }
  }

  const status = planStatus(read(PLAN_STATUS_FILE), o.planResult === "success" ? "success" : "failed");
  if (status) {
    const url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    const state = status.state === "success" ? "success" : "failure";
    try {
      await call("POST", `repos/${repo}/statuses/${sha}`, { context: "terragucci/plan", state, description: status.description.slice(0, MAX_DESCRIPTION), target_url: url });
      log(`terragucci plan-note: terragucci/plan is ${state} on ${sha.slice(0, 8)}: ${status.description}`);
    } catch (e) {
      log(`terragucci: status failed: ${(e as Error).message}`);
    }
  }
  // Under pr-review the head says whether a wave the gate will hold has an approving review of it, so branch protection can require one.
  if (o.approval && noteFile !== undefined && existsSync(join(o.report, "report.json"))) {
    try {
      const posted = await approvalStatus({ forge: o.forge, report: o.report, env, fetch: doFetch });
      log(`terragucci approval-status: ${posted.state}: ${posted.description}`);
    } catch (e) {
      log(`terragucci/approval was not posted: ${(e as Error).message}`);
    }
  }
  return said;
}
