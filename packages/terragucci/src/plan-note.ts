/**
 * The plan note and the `terragucci/plan` status on GitHub and Forgejo,
 * posted by the `plan-note` job (and `replan-note` for a comment's re-plan).
 *
 * The plan job runs the pull request's code: its providers, modules, external
 * data sources, synth command and Terragrunt hooks. So it holds no forge
 * token. It writes the note and the status into its report directory
 * (PLAN_NOTE_FILE, PLAN_STATUS_FILE). A later step of the plan job would hold
 * a token beside what that code left running, so the plan step is the job's
 * last and hands the directory on as the job's outputs, and the note job
 * keeps it as the run's artifact (handover.ts). The note job starts in a fresh
 * container after it, checks nothing out, runs none of the change's code, and
 * posts the two with the job's token.
 *
 * Both files are the pull request's: its code can write anything into them.
 * So they are read as data, as the GitLab comments job reads them
 * (plan-note-gitlab.ts): the status's state from a fixed set and never a
 * success when the plan job failed, the note's roots from a fixed pattern,
 * and every terragucci marker dropped from the body but the waves marker and
 * the description flag.
 *
 * chant's forge client (`@intentius/chant/pr-forge`) posts the two: the note
 * found again by its first line, and the status. What the note says is
 * terragucci's.
 *
 * With `drift:` set, the plan job asks the forge whether the drift checks are
 * overdue. With no token it can ask only a public repo, so it leaves the cron
 * and the pipeline file's first commit in DRIFT_SCHEDULE_FILE, and this job
 * asks with its token and adds the line to the note when the plan job could
 * not.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poster, type Fetch } from "./forge";
import { FORGED, PLAN_MARK, PLAN_NOTE_FILE, PLAN_STATUS_FILE, planStatus, ROOTS_LINE } from "./plan-note-gitlab";
import { DRIFT_SCHEDULE_FILE, driftOverdue, driftRuns } from "./report/overdue";

export { DRIFT_SCHEDULE_FILE };
import { targetFromEnv } from "./report/drift";
import { pullInvolvement, sameLogin } from "./involved";
import { approvalStatus, forgeCalls } from "./review";

/** How the note says the drift job is overdue (chant's overdueVerdict, report/overdue.ts). */
const OVERDUE = "Op `tf-drift` is overdue:";
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
  /** `agent.login`, as the pipeline was written with it: the agent's account, whose review never counts. */
  agentLogin?: string;
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
    const found = driftOverdue(left.cron, o.forge, await driftRuns(doFetch, target), added, o.now ?? new Date());
    if (found) log(found.message);
    return found?.message;
  } catch (e) {
    log(`drift schedule: the forge did not say when the drift job last ran, so it is not checked: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

/**
 * The note's line naming whose review of this pull request would not count,
 * when a wave of it will wait for an approval: the people who had a hand in
 * the change (./involved.ts). Undefined when no wave waits or nobody is named.
 */
export async function notCountingNotice(reportText: string | undefined, pr: number, sha: string, forge: "github" | "forgejo", env: NodeJS.ProcessEnv, doFetch: Fetch, log: (l: string) => void, agentLogin?: string): Promise<string | undefined> {
  let waits = false;
  try {
    waits = ((JSON.parse(reportText ?? "null") as { waves?: { waits?: boolean }[] } | null)?.waves ?? []).some((w) => w.waits === true);
  } catch {
    waits = false;
  }
  if (!waits) return undefined;
  try {
    const calls = forgeCalls(env, doFetch);
    const raw = await calls.get(`repos/${calls.repo}/pulls/${pr}`);
    const inv = await pullInvolvement({ forge, calls, pr: { number: pr, head: sha, ...(typeof raw?.user?.login === "string" ? { author: raw.user.login } : {}) }, env, fetch: doFetch, ...(agentLogin ? { agentLogin } : {}) });
    // Logins only: an address from a commit is not repeated on the pull request.
    const named: { who: string; why: string }[] = [];
    for (const p of inv.people) if (!p.who.includes("@") && !named.some((n) => sameLogin(n.who, p.who))) named.push(p);
    if (named.length === 0) return undefined;
    return `A review by ${named.map((n) => n.who).join(", ")} doesn't count toward the gate, because ${named.length === 1 ? "they" : "each"} had a hand in this change: ${named.map((n) => n.why).join("; ")}.`;
  } catch (e) {
    log(`terragucci plan-note: the people behind the change could not be read (${(e as Error).message})`);
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
  const forge = poster(o.forge, env, doFetch);
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
        await forge.addComment(Number(pr), `terragucci: ${o.root} is not affected by this pull request, so nothing was planned.`);
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
    const who = await notCountingNotice(read("report.json"), Number(pr), sha, o.forge, env, doFetch, log, o.agentLogin);
    if (who) body = withNotice(body, who);
    try {
      await forge.upsertComment(Number(pr), PLAN_MARK, body);
      log(`terragucci plan-note: posted the plan note on pull request ${pr}`);
    } catch (e) {
      log(`terragucci: note failed: ${(e as Error).message}`);
    }
  }

  const status = planStatus(read(PLAN_STATUS_FILE), o.planResult === "success" ? "success" : "failed");
  if (status) {
    const state = status.state === "success" ? "success" : "failure";
    try {
      await forge.setStatus(sha, { context: "terragucci/plan", state, description: status.description, ...(forge.runUrl ? { url: forge.runUrl } : {}) });
      log(`terragucci plan-note: terragucci/plan is ${state} on ${sha.slice(0, 8)}: ${status.description}`);
    } catch (e) {
      log(`terragucci: status failed: ${(e as Error).message}`);
    }
  }
  // Under pr-review the head says whether a wave the gate will hold has an approving review of it, so branch protection can require one.
  if (o.approval && noteFile !== undefined && existsSync(join(o.report, "report.json"))) {
    try {
      const posted = await approvalStatus({ forge: o.forge, report: o.report, env, fetch: doFetch, ...(o.agentLogin ? { agentLogin: o.agentLogin } : {}), log: (l) => log(`terragucci approval-status: ${l}`) });
      log(`terragucci approval-status: ${posted.state}: ${posted.description}`);
    } catch (e) {
      log(`terragucci/approval was not posted: ${(e as Error).message}`);
    }
  }
  return said;
}
