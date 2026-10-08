/**
 * The plan note and the `terragucci/plan` status on GitLab with
 * `gitlab.token: protected`, posted by the comments job.
 *
 * GitLab builds a merge request's pipeline from the merge request's own
 * files, so its author can rewrite any job in it, and every project variable
 * that is not protected reaches that pipeline. A token that can post a note
 * can also push to `chant/lifecycle`. By default the plan job holds the token
 * and posts its note at once; with `gitlab.token: protected`, `GITLAB_TOKEN`
 * is a protected variable and no merge request pipeline holds it. The plan job writes the
 * note and the status into its report artifact instead (PLAN_NOTE_FILE,
 * PLAN_STATUS_FILE), and the comments job, which runs on the default branch
 * from the default branch's pipeline file and runs nothing it reads, posts
 * them with the token.
 *
 * For each open merge request from the project that the poll lists, the job
 * finds the newest pipeline at the merge request's head and its finished
 * `plan` job. When the plan note does not yet name that job, it posts the
 * status and then the note. The note's last line names the job
 * (`<!-- terragucci:plan-job=<id> -->`), so the cursor lives in the note and
 * the job keeps no state.
 *
 * Both files are the merge request's: its code can write anything into them,
 * just as its author can write any note. So the job reads them as data, takes
 * the status's state from a fixed set and the note's roots from a fixed
 * pattern, and drops every terragucci marker from the body but the waves
 * marker `approval: pr-review` reads (a writer's own note can carry one too)
 * and the description flag. A forged `applied` reply in a note the job posts
 * would otherwise read as the mr-apply job's to pr-merge.
 */
import type { Fetch } from "./forge";

/** The note body the plan job writes into its report directory, first line included. */
export const PLAN_NOTE_FILE = "plan-note.md";
/** The status the plan job writes into its report directory, one line: `success` or `failure`, then the counts. */
export const PLAN_STATUS_FILE = "plan-status.txt";

/** The status the plan note's counts go to. */
const PLAN_CONTEXT = "terragucci/plan";
/** How a plan note starts. */
const PLAN_MARK = "<!-- terragucci:plan";
/** The last line of a note the comments job posted: the plan job it came from. */
export const planJobMarker = (job: number): string => `<!-- terragucci:plan-job=${job} -->`;
/** GitLab keeps notes up to a million characters; a longer note is cut. */
const MAX_NOTE = 900_000;
/** GitLab keeps a status description to 255 characters. */
const MAX_DESCRIPTION = 255;
const SHA = /^[0-9a-f]{40}$/;
const ROOTS_LINE = /^<!-- terragucci:plan roots=([A-Za-z0-9_.\/,@+=-]*) -->$/;
/**
 * terragucci markers a note from the plan job may not carry: the replies the
 * comments job and pr-merge read (`note=`, `applied`), `stale`, and a second
 * `plan`. The waves marker and the description flag are the plan's own.
 */
const FORGED = /<!--\s*terragucci:(?!waves |description -->)/gi;

/** What the job did with one merge request's plan. */
export interface PlanNoteOutcome {
  mr: number;
  /** True when a note or a status was posted. */
  posted: boolean;
  /** True when a forge call failed. */
  fail?: boolean;
  reason: string;
}

export interface PlanNoteContext {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  /** The project id, encoded for a path. */
  id: string;
  /** The comments job's own user id: only its notes are plan notes. */
  me: number;
  /** The base URL of GitLab's API, for the artifact files, which are not JSON. */
  apiUrl: string;
  token: string;
  fetch: Fetch;
  /** The artifact directory the plan job keeps. */
  reportDir: string;
}

/** One file of a job's artifact, or undefined when the job kept none of that name. */
async function artifactFile(c: PlanNoteContext, job: number, path: string): Promise<string | undefined> {
  const url = `${c.apiUrl.replace(/\/+$/, "")}/projects/${c.id}/jobs/${job}/artifacts/${path}`;
  const res = await c.fetch(url, { method: "GET", headers: { "private-token": c.token } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${path} of job ${job} answered ${res.status}`);
  return res.text();
}

/** The note as the comments job posts it: its own first and last lines, the plan job's body between them with no marker but the waves'. */
export function planNoteBody(file: string, job: number): string {
  const lines = file.replace(/\r\n/g, "\n").split("\n");
  const roots = ROOTS_LINE.exec(lines[0] ?? "")?.[1];
  const rest = (roots !== undefined ? lines.slice(1) : lines).join("\n").replace(FORGED, "<!-- ").trimEnd();
  const body = rest.length > MAX_NOTE ? `${rest.slice(0, MAX_NOTE)}\n\nThe note was cut at ${MAX_NOTE} characters; the job's report has all of it.` : rest;
  return `${PLAN_MARK} roots=${roots ?? ""} -->\n${body}\n\n${planJobMarker(job)}`;
}

/** The status from the plan job's file: a state from a fixed set and a one-line description. */
export function planStatus(file: string | undefined, jobStatus: string): { state: "success" | "failed"; description: string } | undefined {
  if (file === undefined) {
    // A plan job that failed before it wrote its report still fails the status; one that passed without a file posts nothing.
    return jobStatus === "failed" ? { state: "failed", description: "the plan job failed before it wrote its report" } : undefined;
  }
  const line = file.replace(/\s+/g, " ").trim();
  const state = line.split(" ")[0];
  const description = line.slice(state.length).trim().slice(0, MAX_DESCRIPTION);
  if (state === "success" && jobStatus === "success") return { state: "success", description };
  // A job that failed is never posted as a success, whatever its file says.
  return { state: "failed", description: description || "the plan failed" };
}

/**
 * Posts the plan note and status of merge request `mr` from its head's
 * finished plan job, when the note does not name that job yet. `notes` are
 * the merge request's notes, as the poll read them.
 */
export async function postPlanNote(c: PlanNoteContext, mr: any, notes: any[]): Promise<PlanNoteOutcome | undefined> {
  const iid: number = mr.iid;
  if (mr.state !== "opened") return undefined;
  // A fork's merge request gets no plan job.
  if (mr.source_project_id !== undefined && mr.target_project_id !== undefined && mr.source_project_id !== mr.target_project_id) return undefined;
  const head = mr.sha;
  if (typeof head !== "string" || !SHA.test(head)) return undefined;
  const at = { mr: iid };
  let pipeline: any;
  let job: any;
  try {
    const pipelines = (await c.api("GET", `/projects/${c.id}/merge_requests/${iid}/pipelines`)) as any[];
    pipeline = (Array.isArray(pipelines) ? pipelines : []).filter((p) => p?.sha === head && Number.isInteger(p?.id)).sort((a, b) => b.id - a.id)[0];
    if (!pipeline) return undefined;
    const jobs = (await c.api("GET", `/projects/${c.id}/pipelines/${pipeline.id}/jobs?per_page=100`)) as any[];
    job = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.name === "plan" && Number.isInteger(j?.id)).sort((a, b) => b.id - a.id)[0];
  } catch (e) {
    return { ...at, posted: false, fail: true, reason: `could not read the pipelines of !${iid} (${(e as Error).message})` };
  }
  // Still running, or never ran: the next poll looks again.
  if (!job || (job.status !== "success" && job.status !== "failed")) return undefined;
  const old = notes.find((n) => n?.author?.id === c.me && typeof n?.body === "string" && n.body.startsWith(PLAN_MARK));
  if (old && old.body.includes(planJobMarker(job.id))) return undefined;

  let noteFile: string | undefined;
  let statusFile: string | undefined;
  try {
    noteFile = await artifactFile(c, job.id, `${c.reportDir}/${PLAN_NOTE_FILE}`);
    statusFile = await artifactFile(c, job.id, `${c.reportDir}/${PLAN_STATUS_FILE}`);
  } catch (e) {
    return { ...at, posted: false, fail: true, reason: `could not read the report of plan job ${job.id} (${(e as Error).message})` };
  }
  const status = planStatus(statusFile, job.status);
  // The status goes first: the note is the cursor, so a status that failed is posted again on the next poll.
  if (status) {
    try {
      await c.api("POST", `/projects/${c.id}/statuses/${head}`, {
        name: PLAN_CONTEXT,
        state: status.state,
        description: status.description,
        pipeline_id: pipeline.id,
        ...(typeof job.web_url === "string" && /^https?:\/\//.test(job.web_url) ? { target_url: job.web_url } : {}),
      });
    } catch (e) {
      // GitLab answers 400 to a status set again to the state it has, which a poll after a failed note does.
      if (!/ answered 400/.test((e as Error).message)) return { ...at, posted: false, fail: true, reason: `could not post ${PLAN_CONTEXT} on ${head.slice(0, 8)} (${(e as Error).message})` };
    }
  }
  if (noteFile === undefined) return { ...at, posted: Boolean(status), reason: `plan job ${job.id} wrote no note${status ? `; ${PLAN_CONTEXT} is ${status.state}` : ""}` };
  const body = planNoteBody(noteFile, job.id);
  try {
    if (old) await c.api("PUT", `/projects/${c.id}/merge_requests/${iid}/notes/${old.id}`, { body });
    else await c.api("POST", `/projects/${c.id}/merge_requests/${iid}/notes`, { body });
  } catch (e) {
    return { ...at, posted: Boolean(status), fail: true, reason: `could not post the plan note of plan job ${job.id} (${(e as Error).message})` };
  }
  return { ...at, posted: true, reason: `posted the plan note of plan job ${job.id} at ${head.slice(0, 8)}${status ? `; ${PLAN_CONTEXT} is ${status.state}` : ""}` };
}
