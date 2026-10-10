/**
 * The agent comment and the model review on GitLab.
 *
 * GitLab starts no pipeline for a merge request note, and a merge request's
 * own pipeline runs the merge request's own pipeline file. So the comments
 * schedule's job (comment-gitlab.ts), which runs from the default branch,
 * starts each of these as a pipeline of the default branch, with the job's own
 * CI_JOB_TOKEN and variables that name the merge request:
 *
 * agent       `/terragucci agent <ask>` on an open merge request of this
 *             project: TERRAGUCCI_AGENT_MR, _NOTE and _HEAD. Its `agent` job
 *             reads the merge request and the note again (readGitLabAgentAsk),
 *             checks out the head, and runs the agent with a cleared
 *             environment: the model's key, the prompt, and nothing else. The
 *             change leaves as a patch in the job's artifact. Its `agent-push`
 *             job, a fresh container with `agent.token_env`'s token, reads the
 *             merge request and the note again itself, applies the patch to
 *             the head, refuses a guarded path (agent-comment.ts), pushes to
 *             the source branch and replies.
 * review      each open merge request whose head's plan job has ended and has
 *             no review of that head: TERRAGUCCI_REVIEW_MR and _HEAD. Its
 *             `review` job reads the merge request, fetches the plan job's
 *             report from the merge request's pipeline of the head, writes the
 *             prompt from the default branch's instructions (review-agent.ts)
 *             and runs the review command with a cleared environment. Its
 *             `review-note` job posts the review as one note, whose marker
 *             names the review job.
 *
 * A `tf-apply` wave reads `input.review` from the review job's artifact, once
 * GitLab says that job is the `review` job of a pipeline of the default
 * branch (gitlabReviewOf). A note only points at the job: any token can post
 * one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landAgentChange, type PushResult } from "./agent-comment";
import { BRANCH, LOGIN, parseComment, parseOptions, SHA, type CommentDecision } from "./comment";
import { gitlabApi, type GitLabCall } from "./comment-apply-gitlab";
import { ConfigError } from "./config";
import type { Fetch } from "./forge";
import { PLAN_NOTE_FILE } from "./plan-note-gitlab";
import { noReview, parseReviewMarker, REVIEW_FILE, REVIEW_MARK, REVIEWED_FILE, reviewMarker, reviewNoteBody, verdictOf, writeReviewPrompt, type PolicyReview, type WrittenPrompt } from "./review-agent";

/** The variables of the agent's pipeline: the merge request, the note that asked, and the head it was asked on. */
export const AGENT_MR_VAR = "TERRAGUCCI_AGENT_MR";
export const AGENT_NOTE_VAR = "TERRAGUCCI_AGENT_NOTE";
export const AGENT_HEAD_VAR = "TERRAGUCCI_AGENT_HEAD";
/** The variables of the review's pipeline: the merge request and the head to review. */
export const REVIEW_MR_VAR = "TERRAGUCCI_REVIEW_MR";
export const REVIEW_HEAD_VAR = "TERRAGUCCI_REVIEW_HEAD";

/** Where the agent job keeps the change, and the review job the review, for the job after it: GitLab keeps artifacts from inside the project directory only. */
export const GL_AGENT_ARTIFACT = "terragucci-agent";
export const GL_REVIEW_ARTIFACT = "terragucci-review";

/** The job names a wave checks a review's pointer against, and the poll and the jobs agree on. */
export const REVIEW_JOB = "review";

/** GitLab's Developer access level: the least that may ask for the agent. */
const DEVELOPER = 30;

/** What a merge request's pipeline is still doing while its plan has not ended. */
const RUNNING = new Set(["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled", "manual"]);

const short = (sha: string): string => sha.slice(0, 8);

/** The project id of the job, encoded for a path. */
function projectOf(env: NodeJS.ProcessEnv): string {
  const id = env.CI_PROJECT_ID;
  if (!id) throw new ConfigError("this runs in a GitLab job, which sets CI_PROJECT_ID");
  return encodeURIComponent(id);
}

/** A git runner in the checkout: hooks and fsmonitor off, no prompt for credentials. */
export function gitIn(cwd: string, env: NodeJS.ProcessEnv): (args: string[], input?: string) => string {
  return (args, input) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
}

/**
 * Start a pipeline on the default branch with these variables, with the
 * comments job's own CI_JOB_TOKEN: the pipeline runs as the user the comments
 * schedule runs as, who may run the default branch's pipelines, so no other
 * token is needed.
 */
export async function startDefaultPipeline(env: NodeJS.ProcessEnv, doFetch: Fetch, variables: Record<string, string>): Promise<{ id?: number; web_url?: string }> {
  const api = env.CI_API_V4_URL;
  const token = env.CI_JOB_TOKEN;
  const base = env.CI_DEFAULT_BRANCH;
  if (!api || !token || !base) throw new ConfigError("starting a pipeline needs CI_API_V4_URL, CI_JOB_TOKEN and CI_DEFAULT_BRANCH in the environment");
  const r = await doFetch(`${api}/projects/${projectOf(env)}/trigger/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ref: base, variables }),
  });
  if (!r.ok) throw new Error(`POST trigger/pipeline answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { id?: number; web_url?: string };
}

/** A raw file from GitLab's API (a job's artifact), or undefined when there is none. */
async function rawFile(env: NodeJS.ProcessEnv, token: string, doFetch: Fetch, path: string): Promise<string | undefined> {
  const r = await doFetch(`${env.CI_API_V4_URL}/projects/${projectOf(env)}/${path}`, { method: "GET", headers: { "private-token": token } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
  return r.text();
}

/** A whole positive number from a variable, or undefined. */
function idOf(v: string | undefined): number | undefined {
  const t = (v ?? "").trim();
  return /^[1-9][0-9]{0,9}$/.test(t) ? Number(t) : undefined;
}

// ── the agent comment ─────────────────────────────────────────────────────

/**
 * The agent's pipeline's ask, read again from GitLab: the merge request and
 * the note the variables name. It runs when the merge request is open, from
 * this project, not from the default branch, still at the head the note was
 * answered on, and the note is a `/terragucci agent <ask>` by a Developer or
 * above. The agent job reads it before the agent runs, and the push job again
 * with its own token before it pushes: neither takes the other's word.
 */
export async function readGitLabAgentAsk(api: GitLabCall, env: NodeJS.ProcessEnv): Promise<CommentDecision> {
  const iid = idOf(env[AGENT_MR_VAR]);
  const noteId = idOf(env[AGENT_NOTE_VAR]);
  const sha = (env[AGENT_HEAD_VAR] ?? "").trim();
  if (iid === undefined || noteId === undefined || !SHA.test(sha)) {
    return { go: false, fail: true, reason: `${AGENT_MR_VAR}, ${AGENT_NOTE_VAR} and ${AGENT_HEAD_VAR} must name the merge request, the note and the head` };
  }
  const id = projectOf(env);
  const base = env.CI_DEFAULT_BRANCH;
  let mr: any;
  let note: any;
  try {
    mr = await api("GET", `/projects/${id}/merge_requests/${iid}`);
    note = await api("GET", `/projects/${id}/merge_requests/${iid}/notes/${noteId}`);
  } catch (e) {
    return { go: false, fail: true, pr: iid, reason: `could not read !${iid} and its note (${(e as Error).message})` };
  }
  if (mr?.state !== "opened") return { go: false, pr: iid, reason: `!${iid} is not open, so the agent does not run` };
  const project = Number(env.CI_PROJECT_ID);
  if (mr.source_project_id !== mr.target_project_id || mr.target_project_id !== project) {
    return { go: false, pr: iid, reason: "a merge request from a fork gets no agent: its branch is not this project's to push to" };
  }
  const head = mr.source_branch;
  if (typeof head !== "string" || !BRANCH.test(head) || head.split("/").some((s: string) => s === ".." || s === "")) return { go: false, fail: true, pr: iid, reason: `!${iid}'s source branch is not a branch name terragucci reads` };
  if (head === base) return { go: false, pr: iid, reason: `!${iid}'s source branch is the default branch, and an agent never pushes there` };
  if (mr.sha !== sha) return { go: false, pr: iid, reason: `!${iid} moved from ${short(sha)} to ${typeof mr.sha === "string" ? short(mr.sha) : "another head"} since the note was read, so the agent does not run. Ask again.` };
  const parsed = parseComment(note?.body, parseOptions(env));
  if (parsed?.kind !== "agent") return { go: false, pr: iid, reason: `note ${noteId} on !${iid} is not a \`/terragucci agent <ask>\`` };
  const user = note?.author?.username;
  const uid = note?.author?.id;
  if (typeof user !== "string" || !LOGIN.test(user) || !Number.isInteger(uid)) return { go: false, pr: iid, reason: "the note has no usable author" };
  let level: unknown;
  try {
    level = (await api("GET", `/projects/${id}/members/all/${uid}`))?.access_level;
  } catch (e) {
    if (/ answered 404/.test((e as Error).message)) return { go: false, pr: iid, reason: `${user} is not a member of the project, so the agent does not run` };
    return { go: false, fail: true, pr: iid, reason: `could not read ${user}'s access (${(e as Error).message})` };
  }
  if (typeof level !== "number" || level < DEVELOPER) return { go: false, pr: iid, reason: `${user} is below Developer on the project, so the agent does not run` };
  return { go: true, reason: `run the agent on !${iid} (${head}) for ${user}`, pr: iid, sha, ...(base ? { base } : {}), head, ask: parsed.ask, user };
}

export interface GitLabAgentPushOptions {
  /** The directory with the agent job's change.patch and rc. */
  change: string;
  policyDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  git?: (args: string[], input?: string) => string;
}

/**
 * The agent-push job on GitLab: read the ask again with the push token, check
 * out the merge request's head, and land the agent's change on its source
 * branch (landAgentChange). Every outcome is a reply on the merge request.
 */
export async function pushGitLabAgentChange(o: GitLabAgentPushOptions): Promise<PushResult> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const git = o.git ?? gitIn(o.cwd ?? process.cwd(), env);
  const token = env.TG_TOKEN ?? "";
  if (!token) return { pushed: false, fail: true, reason: "the agent-push job has no TG_TOKEN, the token agent.token_env names" };
  const api = gitlabApi(env, token, doFetch);
  const ask = await readGitLabAgentAsk(api, env);
  const reply = async (text: string): Promise<void> => {
    if (ask.pr === undefined) return;
    try {
      await api("POST", `/projects/${projectOf(env)}/merge_requests/${ask.pr}/notes`, { body: `terragucci: ${text}` });
    } catch (e) {
      console.error(`terragucci: could not reply: ${(e as Error).message}`);
    }
  };
  if (!ask.go) {
    await reply(`${ask.reason}; nothing was pushed.`);
    return { pushed: false, reason: ask.reason, ...(ask.fail ? { fail: true } : {}) };
  }
  const { pr, sha, head, user, ask: text } = ask as Required<Pick<CommentDecision, "pr" | "sha" | "head" | "user" | "ask">>;
  try {
    // The job's checkout is the default branch; the head comes from GitLab's ref of the merge request.
    git(["fetch", "-q", "origin", `+refs/merge-requests/${pr}/head:refs/terragucci/agent-head`]);
    git(["checkout", "-q", "--detach", sha]);
  } catch (e) {
    const why = ((e as Error & { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0];
    await reply(`could not check out !${pr}'s head ${short(sha)} (${why}), so nothing was pushed.`);
    return { pushed: false, fail: true, reason: `could not check out ${sha} (${why})` };
  }
  const server = (env.CI_SERVER_URL ?? "").replace(/\/+$/, "");
  const path = env.CI_PROJECT_PATH ?? "";
  const auth = Buffer.from(`oauth2:${token}`).toString("base64");
  const project = (env.CI_PROJECT_URL ?? (server && path ? `${server}/${path}` : "")).replace(/\/+$/, "");
  return landAgentChange({
    change: o.change,
    ...(o.policyDir ? { policyDir: o.policyDir } : {}),
    git,
    sha,
    head,
    user,
    ask: text,
    where: `merge request !${pr}`,
    token,
    reply,
    // A URL without the job token the checkout's remote carries, and the push token in a header of this one command.
    push: () => git(["-c", `http.extraHeader=Authorization: Basic ${auth}`, "push", "-q", `${server}/${path}.git`, `HEAD:refs/heads/${head}`]),
    link: (commit) => (project ? `[\`${short(commit)}\`](${project}/-/commit/${commit})` : `\`${short(commit)}\``),
    what: "merge request",
  });
}

// ── the review ────────────────────────────────────────────────────────────

/** The merge request's pipeline of a head, newest first, and its plan job. */
async function planJobOf(api: GitLabCall, id: string, iid: number, head: string): Promise<{ pipeline?: any; plan?: any }> {
  const pipelines = (await api("GET", `/projects/${id}/merge_requests/${iid}/pipelines?per_page=100`)) as any[];
  const pipeline = (Array.isArray(pipelines) ? pipelines : []).filter((p) => p?.sha === head && Number.isInteger(p?.id)).sort((a, b) => b.id - a.id)[0];
  if (!pipeline) return {};
  const jobs = (await api("GET", `/projects/${id}/pipelines/${pipeline.id}/jobs?per_page=100&include_retried=false`)) as any[];
  const plan = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.name === "plan").sort((a, b) => b.id - a.id)[0];
  return { pipeline, ...(plan ? { plan } : {}) };
}

export interface GitLabReviewPromptOptions {
  /** Where the plan job's report goes. */
  report: string;
  instructions: string;
  dir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  git?: (args: string[], input?: string) => string;
}

/**
 * `terragucci review prompt --forge gitlab`: the merge request and head the
 * review pipeline names, its plan job's report, the head checked out, then
 * the prompt as on the other forges (writeReviewPrompt), with the default
 * branch's instructions.
 */
export async function writeGitLabReviewPrompt(o: GitLabReviewPromptOptions): Promise<{ written: WrittenPrompt; report: string }> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const cwd = o.cwd ?? process.cwd();
  const git = o.git ?? gitIn(cwd, env);
  const iid = idOf(env[REVIEW_MR_VAR]);
  const head = (env[REVIEW_HEAD_VAR] ?? "").trim();
  if (iid === undefined || !SHA.test(head)) throw new ConfigError(`${REVIEW_MR_VAR} and ${REVIEW_HEAD_VAR} must name the merge request and the head to review`);
  const token = env.TG_TOKEN;
  if (!token) throw new ConfigError("the review job reads the merge request with TG_TOKEN, and has none");
  const api = gitlabApi(env, token, doFetch);
  const id = projectOf(env);
  const mr = await api("GET", `/projects/${id}/merge_requests/${iid}`);
  const base = mr?.target_branch;
  if (typeof base !== "string" || !BRANCH.test(base)) throw new ConfigError(`!${iid}'s target branch is not a branch name terragucci reads`);
  if (mr.source_project_id !== mr.target_project_id) throw new ConfigError(`!${iid} is from a fork, and a fork's merge request is not reviewed`);
  // The head as data, and the base the diff is taken against; nothing in either runs.
  git(["fetch", "-q", "origin", `+refs/merge-requests/${iid}/head:refs/terragucci/review-head`, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  git(["checkout", "-q", "--detach", head]);
  // The report of the merge request's pipeline of this head: data, like the diff.
  let said: string;
  const { pipeline, plan } = await planJobOf(api, id, iid, head);
  if (!pipeline) said = `no plan report: !${iid} has no pipeline of ${short(head)}`;
  else if (!plan) said = `no plan report: pipeline ${pipeline.id} has no plan job`;
  else {
    mkdirSync(o.report, { recursive: true });
    const kept: string[] = [];
    // The plan job keeps its note as note.md, and with gitlab.token: protected as plan-note.md with its markers.
    for (const [name, from] of [[PLAN_NOTE_FILE, [PLAN_NOTE_FILE, "note.md"]], ["report.json", ["report.json"]]] as const) {
      for (const f of from) {
        const text = await rawFile(env, token, doFetch, `jobs/${plan.id}/artifacts/terragucci-report/${f}`);
        if (text === undefined) continue;
        writeFileSync(join(o.report, name), text);
        kept.push(f);
        break;
      }
    }
    said = `the plan report of job ${plan.id} in pipeline ${pipeline.id}: ${kept.length ? kept.join(", ") : "no plan note and no report in it"}`;
  }
  const written = writeReviewPrompt({
    report: o.report,
    instructions: o.instructions,
    ...(o.dir ? { dir: o.dir } : {}),
    cwd,
    env: { ...env, TG_DEFAULT_BRANCH: env.TG_DEFAULT_BRANCH || env.CI_DEFAULT_BRANCH },
    git: (args) => git(args),
    pull: { pr: iid, head, base, title: typeof mr.title === "string" ? mr.title : "", body: typeof mr.description === "string" ? mr.description : "" },
  });
  return { written, report: said };
}

/** My newest note on a merge request that starts with the review's marker, or undefined. */
function myReviewNote(notes: any[], me: number): any | undefined {
  return (Array.isArray(notes) ? notes : [])
    .filter((n) => n?.author?.id === me && typeof n?.body === "string" && n.body.startsWith(REVIEW_MARK))
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
}

export interface GitLabPostReviewOptions {
  /** The review job's artifact directory. */
  dir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  read: (name: string) => string;
}

/**
 * `terragucci review post --forge gitlab`: post the review as one note on the
 * merge request, editing the job's own review note when there is one. The
 * merge request and head come from the pipeline's variables, the review job
 * from GitLab's list of this pipeline's jobs; only the review's text, its
 * exit code and what it says of the instructions come from the artifact.
 */
export async function postGitLabReview(o: GitLabPostReviewOptions): Promise<{ posted: boolean; risk: string; reason: string }> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const iid = idOf(env[REVIEW_MR_VAR]);
  const head = (env[REVIEW_HEAD_VAR] ?? "").trim();
  if (iid === undefined || !SHA.test(head)) return { posted: false, risk: "unknown", reason: `${REVIEW_MR_VAR} and ${REVIEW_HEAD_VAR} must name the merge request and its head, so nothing was posted` };
  const api = gitlabApi(env, env.TG_TOKEN, doFetch);
  const id = projectOf(env);
  try {
    const jobs = (await api("GET", `/projects/${id}/pipelines/${env.CI_PIPELINE_ID}/jobs?per_page=100`)) as any[];
    const job = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.name === REVIEW_JOB && Number.isInteger(j?.id)).sort((a, b) => b.id - a.id)[0];
    const body = reviewNoteBody({ head, review: o.read(REVIEW_FILE), rc: o.read("rc").trim(), instructions: o.read("instructions"), what: "merge request", ...(job ? { job: job.id } : {}) });
    const risk = parseReviewMarker(body)?.risk ?? "unknown";
    const me = Number((await api("GET", "/user"))?.id);
    const notes = (await api("GET", `/projects/${id}/merge_requests/${iid}/notes?per_page=100&sort=desc&order_by=created_at`)) as any[];
    const old = myReviewNote(notes, me);
    if (old) await api("PUT", `/projects/${id}/merge_requests/${iid}/notes/${old.id}`, { body });
    else await api("POST", `/projects/${id}/merge_requests/${iid}/notes`, { body });
    return { posted: true, risk, reason: `posted the review of ${short(head)} on !${iid}: risk ${risk}` };
  } catch (e) {
    return { posted: false, risk: "unknown", reason: `the review note was not posted: ${(e as Error).message}` };
  }
}

/** What the poll did about one merge request's review. */
export interface ReviewStart {
  mr: number;
  started: boolean;
  fail?: boolean;
  reason: string;
}

/**
 * The comments poll's review of one merge request: once the merge request's
 * pipeline of its head has ended its plan job, and the job's own review note
 * names no review of that head, start the review's pipeline and say so in the
 * review note. Undefined when there is nothing to do yet.
 */
export async function startReview(c: { api: GitLabCall; id: string; me: number; base: string; env: NodeJS.ProcessEnv; fetch: Fetch }, mr: any, notes: any[]): Promise<ReviewStart | undefined> {
  const iid: number = mr?.iid;
  if (mr?.state !== "opened" || !Number.isInteger(iid)) return undefined;
  if (mr.source_project_id !== mr.target_project_id || mr.target_branch !== c.base) return undefined;
  const head = mr.sha;
  if (typeof head !== "string" || !SHA.test(head)) return undefined;
  const old = myReviewNote(notes, c.me);
  if (old && parseReviewMarker(old.body)?.head === head) return undefined;
  let plan: any;
  try {
    ({ plan } = await planJobOf(c.api, c.id, iid, head));
  } catch (e) {
    return { mr: iid, started: false, fail: true, reason: `could not read the pipelines of !${iid} (${(e as Error).message})` };
  }
  // No plan yet, or one still running: the next poll looks again.
  if (!plan || RUNNING.has(plan.status)) return undefined;
  let pipeline: { id?: number; web_url?: string };
  try {
    pipeline = await startDefaultPipeline(c.env, c.fetch, { [REVIEW_MR_VAR]: String(iid), [REVIEW_HEAD_VAR]: head });
  } catch (e) {
    return { mr: iid, started: false, fail: true, reason: `could not start the review's pipeline for !${iid} (${(e as Error).message})` };
  }
  const link = typeof pipeline?.web_url === "string" && /^https?:\/\//.test(pipeline.web_url) ? ` ${pipeline.web_url}` : "";
  const body = [reviewMarker(head, "unknown"), `### terragucci review of \`${short(head)}\``, "", `A model reviews this head in pipeline${link}; this note shows its review once that pipeline ends. This note approves nothing.`, ""].join("\n");
  try {
    if (old) await c.api("PUT", `/projects/${c.id}/merge_requests/${iid}/notes/${old.id}`, { body });
    else await c.api("POST", `/projects/${c.id}/merge_requests/${iid}/notes`, { body });
  } catch (e) {
    return { mr: iid, started: true, fail: true, reason: `started the review's pipeline${link}, and the note failed (${(e as Error).message})` };
  }
  return { mr: iid, started: true, reason: `started the review of ${short(head)} in pipeline${link}` };
}

/** The calls a wave reads a GitLab review with: the API with the job's token, and an artifact's file. */
export interface GitLabReviewCalls {
  get: (path: string) => Promise<any>;
  /** A file from a job's artifacts, or undefined when the job kept none. */
  artifact: (job: number, path: string) => Promise<string | undefined>;
}

export function gitlabReviewCalls(env: NodeJS.ProcessEnv, doFetch: Fetch = fetch): GitLabReviewCalls {
  const token = env.TG_TOKEN;
  if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !token) throw new ConfigError("the review on GitLab needs CI_API_V4_URL, CI_PROJECT_ID and TG_TOKEN in the environment");
  const api = gitlabApi(env, token, doFetch);
  return {
    get: (path) => api("GET", `/projects/${projectOf(env)}${path}`),
    artifact: (job, path) => rawFile(env, token, doFetch, `jobs/${job}/artifacts/${path}`),
  };
}

/**
 * The review a wave's policy reads on GitLab: the verdict in the artifact of
 * a review job a note on the merge request points at, once GitLab says that
 * job is the `review` job of a pipeline of the default branch, which ran the
 * default branch's pipeline file, and its reviewed.json names this merge
 * request's head against the default branch. A note is a pointer only: any
 * token can post one, and a merge request's own pipeline can keep a job named
 * review, never on the default branch.
 */
export async function gitlabReviewOf(c: GitLabReviewCalls, mr: { number: number; head: string }): Promise<PolicyReview & { job?: number; skipped: { job: number | null; why: string }[] }> {
  const skipped: { job: number | null; why: string }[] = [];
  const project = await c.get("");
  const defaultBranch = project?.default_branch;
  if (typeof defaultBranch !== "string" || !BRANCH.test(defaultBranch)) throw new Error("GitLab did not say the project's default branch");
  const notes = await c.get(`/merge_requests/${mr.number}/notes?per_page=100&sort=desc&order_by=created_at`);
  const pointers = (Array.isArray(notes) ? notes : [])
    .map((n: any) => parseReviewMarker(n?.body))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && m.head === mr.head && m.job !== undefined);
  const seen = new Set<number>();
  for (const p of pointers) {
    const jobId = p.job!;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    let job: any;
    try {
      job = await c.get(`/jobs/${jobId}`);
    } catch {
      skipped.push({ job: jobId, why: "GitLab has no such job in this project" });
      continue;
    }
    if (job?.name !== REVIEW_JOB) { skipped.push({ job: jobId, why: `it is job ${String(job?.name)}, not ${REVIEW_JOB}` }); continue; }
    if (job?.tag === true || job?.ref !== defaultBranch) { skipped.push({ job: jobId, why: `it ran on ${String(job?.ref)}, not the default branch ${defaultBranch}` }); continue; }
    if (job?.status !== "success") { skipped.push({ job: jobId, why: `it ended ${String(job?.status)}` }); continue; }
    let reviewed: any;
    try {
      reviewed = JSON.parse((await c.artifact(jobId, `${GL_REVIEW_ARTIFACT}/${REVIEWED_FILE}`)) ?? "");
    } catch {
      reviewed = undefined;
    }
    if (reviewed?.pr !== mr.number || reviewed?.head !== mr.head || reviewed?.base !== defaultBranch) {
      skipped.push({ job: jobId, why: `it reviewed ${reviewed ? `!${String(reviewed.pr)} at ${short(String(reviewed.head))} against ${String(reviewed.base)}` : "no merge request it names"}, not !${mr.number} against ${defaultBranch}` });
      continue;
    }
    const review = (await c.artifact(jobId, `${GL_REVIEW_ARTIFACT}/${REVIEW_FILE}`)) ?? "";
    const rc = (await c.artifact(jobId, `${GL_REVIEW_ARTIFACT}/rc`)) ?? "";
    return { found: true, risk: verdictOf({ review, rc }), pull_request: mr.number, head: mr.head, job: jobId, skipped };
  }
  return { ...noReview(mr), skipped };
}
