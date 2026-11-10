/**
 * `review.agent`: a model reviews a pull request's intent against its plan.
 *
 * The review is a workflow of its own (REVIEW_PATHS) that the forge runs from
 * the default branch, never from the pull request: GitHub on `workflow_run`
 * once the pipeline's `pull_request` run completes, Forgejo on
 * `pull_request_target`. A pull request that edits the review workflow changes
 * nothing until it merges. Two jobs, so the model never shares a container
 * with a token that can write:
 *
 * review       its first step (`terragucci review prompt`) reads the pull
 *              request from the event (on GitHub, from the API by the number
 *              the event names), fetches the plan job's report from the
 *              pipeline's run of the head (on Forgejo it waits for the job
 *              that keeps it first) and writes the prompt: the title and
 *              description, the diff against the base, the plan note and the
 *              policy results,
 *              and the review instructions read from the default branch with
 *              `git show`, never from the checkout. The checkout is the head,
 *              without credentials, and nothing in it runs. The step also
 *              unpacks the default branch's tree, where the review command
 *              runs, so a script the command names is the default branch's
 *              copy. The command runs with the prompt on stdin, the model's
 *              key in its step alone and the runner's token variables
 *              cleared; what it prints is the review. The review, the
 *              command's exit code and the pull request it reviewed leave the
 *              job as the artifact `terragucci-review-<head>`.
 * review-note  a fresh container that checks nothing out. It reads the
 *              review as data and posts it as one note on the pull request
 *              (`terragucci review post`), with the job's token. It posts a
 *              comment and nothing else: no review, no approval, no status.
 *
 * The default command, the risks and the reading of the `risk:` line are
 * chant's reviewAgent activity's (chant#4299), imported from its module. The
 * prompt, the marker and the note are chant's product review
 * (`productReviewPrompt`, `productReviewMarker`, `productReviewNoteBody`,
 * chant#4811) in terragucci's words, TG_REVIEW_WORDS.
 *
 * The review ends with a `risk:` line (low, medium or high), which the note
 * carries in its marker for people to read. A `tf-apply` wave gives the
 * policy the risk of the merged pull request's head as `input.review`, read
 * from that artifact only when the forge says a run of the default branch's
 * review workflow kept it (reviewOfPull), never from a note.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiOf, BRANCH, SHA } from "./comment";
import { TOKEN_USERS } from "./comment-apply";
import { unzipEntry } from "@intentius/chant/ci-image";
import { ConfigError, type ProjectSettings } from "./config";
import { detectForge } from "@intentius/chant/pr-forge";
import { poster, type Fetch } from "./forge";
import { PLAN_NOTE_FILE } from "./plan-note-gitlab";
import { planNoteBodyOf } from "./plan-note";
import type { ReviewForge, ReviewedPull } from "./review";
import type { RunArtifact, WorkflowRun } from "@intentius/chant/pr-forge-reads";
import { productReviewMarker, productReviewNoteBody, productReviewPrompt, type ReviewWords } from "@intentius/chant/op/activities/review-product";
import { REVIEW_COMMAND, REVIEW_RISKS as RISKS, riskOf, type ReviewRisk as Risk } from "@intentius/chant/op/activities/review-agent";

/** Where the review instructions live on the default branch unless `review.instructions` names another file. */
export const REVIEW_INSTRUCTIONS = ".terragucci/review.md";

export interface ReviewInput {
  command: string;
  /** The secret holding the model's API key. */
  keySecret: string;
  /** The instructions file, read from the default branch. */
  instructions: string;
  /** Minutes. */
  timeout: number;
}

/** The review's settings with their defaults, or undefined when `review.agent` is not on. */
export function reviewInput(settings: ProjectSettings): ReviewInput | undefined {
  const r = settings.review;
  if (!r?.agent) return undefined;
  return {
    command: r.command ?? REVIEW_COMMAND,
    keySecret: r.key_secret ?? "ANTHROPIC_API_KEY",
    instructions: r.instructions ?? REVIEW_INSTRUCTIONS,
    timeout: r.timeout ?? 10,
  };
}

/** Where the review job keeps its prompt, the default branch's tree and the review: outside the checkout. */
export const REVIEW_DIR = "/tmp/terragucci-review";
export const REVIEW_OUT = `${REVIEW_DIR}/out`;
export const REVIEW_WORK = `${REVIEW_DIR}/work`;
export const REVIEW_FILE = "review.md";

/** The note's first line, and the marker a wave reads the risk from. */
export const REVIEW_MARK = "<!-- terragucci:review ";

/** What `input.review` holds in a `tf-apply` wave. */
export interface PolicyReview {
  /** Whether the default branch's review workflow kept a review of the merged pull request's head. */
  found: boolean;
  /** The review's risk; `unknown` when no review was found or it gave none. */
  risk: Risk | "unknown";
  pull_request: number | null;
  head: string | null;
}

/** The longest plan note the prompt carries; the rest is cut and said so (chant cuts the description and the diff). */
const MAX_NOTE = 40_000;

/** terragucci's words in chant's review prompt, marker and note (chant#4811). */
export const TG_REVIEW_WORDS: ReviewWords = {
  product: "terragucci",
  plan: "plan",
  deletes: "destroys",
  from: "default branch",
  emptyTitle: "",
  diffLast: true,
  marker: "terragucci:review",
  heading: "### {product} review of `{head}`",
  compared: "the diff, the plan note and the policy results",
  approves: "This note approves nothing.",
  log: "the review job's log",
};

export interface PromptParts {
  pr: number;
  title: string;
  body: string;
  diff: string;
  /** The plan note, or undefined when the plan job wrote none. */
  planNote?: string;
  /** The policy results per root, as JSON. */
  policy: string;
  /** The default branch's instructions, or undefined when it has none. */
  instructions?: string;
  /** The default branch, as the prompt names it. */
  defaultBranch: string;
  instructionsPath: string;
}

/** The review's prompt, chant's productReviewPrompt in terragucci's words over the plan note and the policy results. */
export function reviewPrompt(p: PromptParts): string {
  return productReviewPrompt({
    pr: p.pr,
    title: p.title,
    description: p.body,
    diff: p.diff,
    ...(p.instructions !== undefined ? { instructions: p.instructions } : {}),
    instructionsPath: p.instructionsPath,
    base: p.defaultBranch,
    sections: [
      { tag: "plan_note", name: "the plan note", text: p.planNote ?? "(the plan job wrote no note)", max: MAX_NOTE, what: "plan note" },
      { tag: "policy", name: "the policy results", text: p.policy },
    ],
  }, TG_REVIEW_WORDS);
}

/** The policy results the prompt carries: each planned root's result, denials and warnings. */
export function policyResults(reportJson: string | undefined): string {
  if (reportJson === undefined) return "(the plan job wrote no report)";
  let report: { roots?: { root?: unknown; status?: unknown; policy?: { result?: unknown; denials?: unknown; warnings?: unknown; error?: unknown } }[] };
  try {
    report = JSON.parse(reportJson);
  } catch {
    return "(the plan report could not be read)";
  }
  const roots = (Array.isArray(report?.roots) ? report.roots : [])
    .filter((r) => r && typeof r.root === "string")
    .map((r) => ({
      root: r.root,
      status: r.status,
      policy: r.policy ? { result: r.policy.result, denials: r.policy.denials, warnings: r.policy.warnings, ...(r.policy.error ? { error: r.policy.error } : {}) } : "no policy ran",
    }));
  return roots.length ? JSON.stringify(roots, null, 2) : "(no root was planned)";
}

export interface WritePromptOptions {
  /** The plan job's report directory, as the artifact came down. */
  report: string;
  /** Where the prompt and the default branch's tree go. */
  dir?: string;
  instructions: string;
  /** The checkout, at the pull request's head. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  git?: (args: string[]) => string;
  /** The pull request, when the caller read it already (reviewSubject); else the event file's `pull_request`. */
  pull?: ReviewSubject;
}

/** The pull request a review run reviews. */
export interface ReviewSubject {
  pr: number;
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Where the review job says which pull request, head and base it reviewed. */
export const REVIEWED_FILE = "reviewed.json";

function readEvent(env: NodeJS.ProcessEnv): any {
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf-8"));
  } catch (e) {
    throw new ConfigError(`review prompt reads the pull request from the event file, and could not (${(e as Error).message})`);
  }
}

/** The pull request of a `pull_request` or `pull_request_target` event. */
function subjectOfPullEvent(event: any): ReviewSubject {
  const pull = event?.pull_request;
  return checkedSubject({ pr: pull?.number, head: pull?.head?.sha, base: pull?.base?.ref, title: pull?.title, body: pull?.body });
}

function checkedSubject(p: { pr: unknown; head: unknown; base: unknown; title: unknown; body: unknown }): ReviewSubject {
  if (!Number.isInteger(p.pr) || typeof p.head !== "string" || !SHA.test(p.head)) throw new ConfigError("review prompt runs on a pull request event; the event names no pull request and head");
  if (typeof p.base !== "string" || !BRANCH.test(p.base)) throw new ConfigError("the pull request's base branch is not a branch name terragucci reads");
  return { pr: p.pr as number, head: p.head, base: p.base, title: typeof p.title === "string" ? p.title : "", body: typeof p.body === "string" ? p.body : "" };
}

export interface WrittenPrompt {
  pr: number;
  head: string;
  /** Whether the default branch has the instructions file, and whether the change edits it. */
  instructions: "default" | "none";
  changed: boolean;
}

/**
 * `terragucci review prompt`: write the prompt to `<dir>/prompt.md` and the
 * default branch's tree to `<dir>/work`, and say what the note should say
 * about the instructions in `<dir>/out/instructions`.
 */
export function writeReviewPrompt(o: WritePromptOptions): WrittenPrompt {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const dir = o.dir ?? REVIEW_DIR;
  // Hooks, fsmonitor, external diff drivers and textconv off: nothing here runs code from the change.
  const git = o.git ?? ((args: string[]): string =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_TERMINAL_PROMPT: "0" } }));
  // A caller that read the pull request already may still have the event: it names the default branch.
  const event = o.pull ? (() => { try { return readEvent(env); } catch { return undefined; } })() : readEvent(env);
  const { pr, head, base, title, body } = o.pull ?? subjectOfPullEvent(event);
  const defaultBranch = env.TG_DEFAULT_BRANCH || event?.repository?.default_branch;
  if (typeof defaultBranch !== "string" || !BRANCH.test(defaultBranch)) throw new ConfigError("review prompt needs the default branch: TG_DEFAULT_BRANCH, or repository.default_branch in the event");
  const path = o.instructions.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "") || !/^[A-Za-z0-9_.\/-]+$/.test(path)) {
    throw new ConfigError(`review.instructions must be a path inside the repository, such as ${REVIEW_INSTRUCTIONS}`);
  }
  const defaultRef = `refs/remotes/origin/${defaultBranch}`;
  try {
    git(["rev-parse", "--verify", "-q", `${defaultRef}^{commit}`]);
  } catch {
    throw new ConfigError(`the checkout has no ${defaultRef}; the review job checks out with the whole history`);
  }
  // The instructions come from the default branch alone. A change that edits them changes nothing until it merges.
  let instructions: string | undefined;
  try {
    instructions = git(["show", `${defaultRef}:${path}`]);
  } catch {
    instructions = undefined;
  }
  const diff = git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", `refs/remotes/origin/${base}...${head}`]);
  const changed = git(["diff", "--name-only", "--no-renames", `refs/remotes/origin/${base}...${head}`, "--", path]).trim() !== "";
  const read = (name: string): string | undefined => (existsSync(join(o.report, name)) ? readFileSync(join(o.report, name), "utf-8") : undefined);
  const noteFile = read(PLAN_NOTE_FILE);
  // The note without its markers: the model reads the note as a person does.
  const planNote = noteFile === undefined ? undefined : planNoteBodyOf(noteFile).replace(/<!--[\s\S]*?-->\n?/g, "");
  const prompt = reviewPrompt({
    pr,
    title,
    body,
    diff,
    ...(planNote !== undefined ? { planNote } : {}),
    policy: policyResults(read("report.json")),
    ...(instructions !== undefined ? { instructions } : {}),
    defaultBranch,
    instructionsPath: path,
  });
  mkdirSync(join(dir, "out"), { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "prompt.md"), prompt);
  // The command runs in the default branch's tree, so a script it names is reviewed code, not the change's.
  const tar = join(dir, "default.tar");
  git(["archive", "--format=tar", "-o", tar, defaultRef]);
  execFileSync("tar", ["-xf", tar, "-C", join(dir, "work")], { stdio: ["ignore", "ignore", "pipe"] });
  const written: WrittenPrompt = { pr, head, instructions: instructions !== undefined ? "default" : "none", changed };
  writeFileSync(join(dir, "out", "instructions"), `${written.instructions}${changed ? " changed" : ""}\n`);
  // What was reviewed, for the wave that reads the verdict: the pull request, its head, and the base the diff was taken against.
  writeFileSync(join(dir, "out", REVIEWED_FILE), `${JSON.stringify({ pr, head, base })}\n`);
  return written;
}

/** The note's marker: the head reviewed and the risk, and on GitLab the review job a wave checks the verdict in (chant's productReviewMarker). */
export function reviewMarker(head: string, risk: Risk | "unknown", job?: number): string {
  return productReviewMarker(TG_REVIEW_WORDS.marker!, head, risk, job);
}

/** A note's marker, or undefined: notes written before chant's marker read the same way. */
export function parseReviewMarker(body: unknown): { head: string; risk: Risk | "unknown"; job?: number } | undefined {
  if (typeof body !== "string" || !body.startsWith(REVIEW_MARK)) return undefined;
  const m = /^<!-- terragucci:review (\{[^\n]*?\}) -->/.exec(body);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1]!) as { head?: unknown; risk?: unknown; job?: unknown };
    if (typeof v.head !== "string" || !SHA.test(v.head)) return undefined;
    const risk = (RISKS as readonly string[]).includes(v.risk as string) ? (v.risk as Risk) : "unknown";
    return { head: v.head, risk, ...(Number.isInteger(v.job) && (v.job as number) > 0 ? { job: v.job as number } : {}) };
  } catch {
    return undefined;
  }
}

/** The note's body, chant's productReviewNoteBody in terragucci's words. The review is the model's text: it is shown, never trusted, and no marker of it survives. */
export function reviewNoteBody(o: { head: string; review: string; rc: string; instructions: string; job?: number; what?: string }): string {
  return productReviewNoteBody({ head: o.head, review: o.review, exitCode: o.rc, instructions: o.instructions, ...(o.job !== undefined ? { job: o.job } : {}), ...(o.what ? { what: o.what } : {}) }, TG_REVIEW_WORDS);
}

export interface PostReviewOptions {
  /** The review job's out directory, as the artifact came down. */
  dir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

/**
 * `terragucci review post`: post the review as one note on the pull request,
 * editing the note the job posted before. The pull request and its head come
 * from the job's environment, never from the artifact. Never a review, never
 * an approval.
 */
export async function postReview(o: PostReviewOptions): Promise<{ posted: boolean; risk: Risk | "unknown"; reason: string }> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const pr = (env.TG_PR ?? "").trim();
  const head = (env.TG_SHA ?? "").trim();
  if (!/^\d+$/.test(pr) || !SHA.test(head)) return { posted: false, risk: "unknown", reason: "TG_PR and TG_SHA must name the pull request and its head, so nothing was posted" };
  const read = (name: string): string => (existsSync(join(o.dir, name)) ? readFileSync(join(o.dir, name), "utf-8") : "");
  const rc = read("rc").trim();
  const body = reviewNoteBody({ head, review: read(REVIEW_FILE), rc, instructions: read("instructions") });
  const risk = parseReviewMarker(body)?.risk ?? "unknown";
  try {
    // Only a note the run's own token wrote is the review note: a pull request's author cannot plant one for the job to edit.
    await poster(detectForge(env) === "forgejo" ? "forgejo" : "github", env, doFetch).upsertComment(Number(pr), REVIEW_MARK, body, { author: [...TOKEN_USERS] });
  } catch (e) {
    return { posted: false, risk, reason: `the review note was not posted: ${(e as Error).message}` };
  }
  return { posted: true, risk, reason: `posted the review of ${head.slice(0, 8)} on pull request ${pr}: risk ${risk}` };
}

/** The review workflow: a file of its own, beside the pipeline, which the forge runs from the default branch. */
export const REVIEW_PATHS = {
  github: ".github/workflows/terragucci-review.yml",
  forgejo: ".forgejo/workflows/terragucci-review.yml",
} as const;

/** The event each forge runs the review workflow on, from the default branch's copy of it. */
export const REVIEW_EVENTS = { github: "workflow_run", forgejo: "pull_request_target" } as const;

/** The pipeline's workflow file and the artifact its run keeps the plan report in (render.ts PIPELINE_PATHS and REPORT_DIR). */
export const PIPELINE_WORKFLOW = "terragucci.yml";
export const PLAN_REPORT_ARTIFACT = "terragucci-report";
/** The job that keeps that artifact: the plan job hands its report on, and plan-note keeps it (handover.ts). Forgejo waits for it. */
export const REPORT_KEEPER_JOB = "plan-note";

/** The artifact the review job keeps the review of a head in, and a wave reads the verdict from. */
export const REVIEW_ARTIFACT = "terragucci-review";
export const reviewArtifactName = (head: string): string => `${REVIEW_ARTIFACT}-${head}`;

/** The verdict of a review job's output: the review's risk, or unknown when the command failed. */
export function verdictOf(o: { review: string; rc: string }): Risk | "unknown" {
  return o.rc.trim() === "0" ? riskOf(o.review) : "unknown";
}

/** An artifact's zip by its API path, or undefined when the forge has none. */
export type ArtifactFiles = (path: string) => Promise<Buffer | undefined>;

/** A fetch that reads bytes, as the artifact's zip comes. */
export type FetchBytes = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Artifact zips through the forge's API with the job's token. GitHub answers with a redirect to storage, which fetch follows without the token. */
export function artifactBytes(env: NodeJS.ProcessEnv, doFetch: FetchBytes = fetch): ArtifactFiles {
  const { api, token } = apiOf(env);
  return async (path) => {
    const r = await doFetch(`${api}/${path}`, { headers: { authorization: `token ${token}` } });
    if (r.status === 404 || r.status === 410) return undefined;
    if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
}

/** The artifacts of `name` chant's reads list (unexpired), newest first. */
function newestFirst(artifacts: readonly RunArtifact[], name: string): RunArtifact[] {
  return artifacts.filter((a) => a.name === name).sort((a, b) => b.id - a.id);
}

function entryOf(zip: Buffer, name: string): string | undefined {
  try {
    const entry = unzipEntry(zip, name);
    return entry && Buffer.from(entry).toString("utf-8");
  } catch {
    return undefined;
  }
}

/**
 * The pull request a review run reviews. On Forgejo the event is the
 * `pull_request_target` event, which names it. On GitHub it is the
 * `workflow_run` event of the pipeline's run: the run's head, the pull
 * request among those the event names that has that head, and its title,
 * description and base read from the API. `run` is the pipeline's run, whose
 * plan report the prompt reads.
 */
export async function reviewSubject(event: any, f: ReviewForge): Promise<{ subject: ReviewSubject; run?: number }> {
  const wr = event?.workflow_run;
  if (!wr) return { subject: subjectOfPullEvent(event) };
  if (wr.event !== "pull_request") throw new ConfigError(`the review runs after a pull_request run of the pipeline; this one was started by ${String(wr.event)}`);
  const head = wr.head_sha;
  const prs = (Array.isArray(wr.pull_requests) ? wr.pull_requests : []).filter((p: any) => Number.isInteger(p?.number) && p?.head?.sha === head);
  if (prs.length !== 1 || !Number.isInteger(wr.id)) throw new ConfigError(`the pipeline's run names ${prs.length} pull requests of its head, not one, so there is nothing to review`);
  const pull = await f.reads.pullRequest(prs[0].number);
  return { subject: checkedSubject({ pr: prs[0].number, head, base: pull?.base, title: pull?.title, body: pull?.body }), run: wr.id };
}

export interface FetchReportOptions {
  /** How long to wait for the pipeline's plan on Forgejo, in ms. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}


/**
 * The plan job's report, from the pipeline's run of the head, into `dir`: the
 * plan note and report.json, read out of the artifact by name. On GitHub the
 * run is the one that started the review, and it has finished. On Forgejo
 * `pull_request_target` starts the review with the pipeline, so this waits
 * for the newest `pull_request` run of the head to finish its plan-note job,
 * which keeps the plan job's report there. What
 * it returns is said in the log. The report is the change's own run's, so it
 * is data like the diff, never trusted.
 */
export async function fetchPlanReport(f: ReviewForge, bytes: ArtifactFiles, subject: ReviewSubject, run: number | undefined, dir: string, o: FetchReportOptions = {}): Promise<string> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let id = run;
  if (id === undefined) {
    const deadline = now() + (o.waitMs ?? 30 * 60_000);
    for (;;) {
      // chant's reads give Forgejo's own trigger as `event`, so a pull_request_target run of the head is not taken for the pipeline's.
      const pipeline = (await f.reads.headRuns(subject.head, { event: "pull_request", limit: 50 }))
        .filter((r) => r.event === "pull_request" && r.workflow === PIPELINE_WORKFLOW && r.headSha === subject.head)
        .sort((a, b) => b.id - a.id)[0];
      if (pipeline) {
        const plan = (await f.reads.runJobs(pipeline.id)).find((j) => j.name === REPORT_KEEPER_JOB);
        if (plan?.done || pipeline.done) {
          id = pipeline.id;
          break;
        }
      }
      if (now() >= deadline) {
        const minutes = Math.round((o.waitMs ?? 30 * 60_000) / 60_000);
        return `no plan report: the pipeline's run of ${subject.head.slice(0, 8)} did not finish its plan in ${minutes} minute${minutes === 1 ? "" : "s"}`;
      }
      await sleep(o.pollMs ?? 10_000);
    }
  }
  const artifact = newestFirst(await f.reads.artifacts(PLAN_REPORT_ARTIFACT, { run: id, limit: 50 }), PLAN_REPORT_ARTIFACT)[0];
  const zip = artifact ? await bytes(`repos/${f.repo}/actions/artifacts/${artifact.id}/zip`) : undefined;
  if (!zip) return `no plan report: run ${id} kept none`;
  mkdirSync(dir, { recursive: true });
  const kept: string[] = [];
  for (const name of [PLAN_NOTE_FILE, "report.json"]) {
    const text = entryOf(zip, name);
    if (text !== undefined) {
      writeFileSync(join(dir, name), text);
      kept.push(name);
    }
  }
  return `the plan report of run ${id}: ${kept.length ? kept.join(", ") : "no plan note and no report in it"}`;
}

/**
 * Why a run is not the default branch's review workflow reviewing this pull
 * request, or undefined when it is. GitHub runs a `workflow_run` workflow from
 * the default branch alone, whatever branch's run started it, so the event
 * and the file say it all. Forgejo runs a `pull_request_target` workflow from
 * the pull request's base, so the base the event named must be the default
 * branch, and the event's pull request and head this one. Forgejo lists such a
 * run with event `pull_request`; `trigger_event` is the workflow's own.
 */
export function untrustedRun(run: WorkflowRun | undefined, forge: "github" | "forgejo", pr: ReviewedPull, defaultBranch: string): string | undefined {
  if (!run) return "the forge has no such run";
  if (forge === "github") {
    if (run.event !== REVIEW_EVENTS.github) return `it ran on ${run.event}, not workflow_run`;
    const path = (run.path ?? "").replace(/@.*$/, "");
    if (path !== REVIEW_PATHS.github) return `it ran ${run.path ?? "no workflow file"}, not ${REVIEW_PATHS.github}`;
    return undefined;
  }
  // chant's reads give Forgejo's trigger_event as `event`, its workflow_id as `workflow`, and the event payload's pull request.
  if (run.event !== REVIEW_EVENTS.forgejo) return `it ran on ${run.event}, not pull_request_target`;
  if (run.workflow !== REVIEW_PATHS.forgejo.split("/").pop()) return `it ran ${run.workflow ?? "no workflow file"}, not ${REVIEW_PATHS.forgejo}`;
  const pull = run.pullRequests[0];
  if (pull?.base !== defaultBranch) return `it ran the review workflow of ${String(pull?.base)}, not of the default branch ${defaultBranch}`;
  if (pull.number !== pr.number || pull.headSha !== pr.head) return `it reviewed pull request ${pull.number} at ${String(pull.headSha).slice(0, 8)}`;
  return undefined;
}

/**
 * The review a wave's policy reads: the verdict in the newest
 * `terragucci-review-<head>` artifact that the forge says a run of the
 * default branch's review workflow kept (untrustedRun), and that says it
 * reviewed this pull request's head against the default branch. Any run of the
 * repo can keep an artifact of that name, the pull request's own pipeline
 * included, and any run's token can post a note, so neither counts by itself.
 * `skipped` says which artifacts were passed over, and why.
 */
export async function reviewOfPull(f: ReviewForge, pr: ReviewedPull, bytes: ArtifactFiles, forge: "github" | "forgejo"): Promise<PolicyReview & { run?: number; skipped: { run: number | null; why: string }[] }> {
  const skipped: { run: number | null; why: string }[] = [];
  const name = reviewArtifactName(pr.head);
  const artifacts = newestFirst(await f.reads.artifacts(name, { limit: 50 }), name);
  if (!artifacts.length) return { ...noReview(pr), skipped };
  const defaultBranch = f.client.defaultBranch ? await f.client.defaultBranch() : undefined;
  if (typeof defaultBranch !== "string" || !BRANCH.test(defaultBranch)) throw new Error("the forge did not say the repository's default branch");
  for (const artifact of artifacts) {
    const runId = artifact.run;
    if (runId === undefined || !Number.isInteger(runId)) {
      skipped.push({ run: null, why: "the forge names no run that kept it" });
      continue;
    }
    const why = untrustedRun(await f.reads.run(runId), forge, pr, defaultBranch);
    if (why) {
      skipped.push({ run: runId, why });
      continue;
    }
    const zip = await bytes(`repos/${f.repo}/actions/artifacts/${artifact.id}/zip`);
    if (!zip) continue;
    let reviewed: any;
    try {
      reviewed = JSON.parse(entryOf(zip, REVIEWED_FILE) ?? "");
    } catch {
      reviewed = undefined;
    }
    if (reviewed?.pr !== pr.number || reviewed?.head !== pr.head || reviewed?.base !== defaultBranch) {
      skipped.push({ run: runId, why: `it reviewed ${reviewed ? `pull request ${String(reviewed.pr)} at ${String(reviewed.head).slice(0, 8)} against ${String(reviewed.base)}` : "no pull request it names"}, not pull request ${pr.number} against ${defaultBranch}` });
      continue;
    }
    return { found: true, risk: verdictOf({ review: entryOf(zip, REVIEW_FILE) ?? "", rc: entryOf(zip, "rc") ?? "" }), pull_request: pr.number, head: pr.head, run: runId, skipped };
  }
  return { ...noReview(pr), skipped };
}

/** `input.review` when no pull request or no review could be read. */
export function noReview(pr?: ReviewedPull): PolicyReview {
  return { found: false, risk: "unknown", pull_request: pr?.number ?? null, head: pr?.head ?? null };
}
