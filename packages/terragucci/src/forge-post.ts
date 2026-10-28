/**
 * `terragucci post status|note|reply|stale`: what the generated pipeline's
 * jobs say on the forge, posted through chant's forge client
 * (`@intentius/chant/pr-forge`) with the job's TG_TOKEN. The pipeline's `tg`
 * shell function (render.ts forgeApi) calls it. The words are the
 * pipeline's; the forge calls are chant's.
 *
 * - `status <context> pending|success|failure <description>`: a commit
 *   status on TG_SHA, linked to the run. On GitLab a status on the job's own
 *   commit names the job's pipeline: without it GitLab files the status
 *   under the newest pipeline of that commit, which may be another one.
 * - `note <file>`: the plan note on TG_PR, found again by its first line.
 * - `reply <text>`: a new comment on TG_PR, `terragucci: <text>`.
 * - `stale <roots> <branch>`: every open pull request into `<branch>` whose
 *   plan note covers one of `<roots>` (comma-separated) gets a line saying
 *   its plan is stale.
 *
 * A post that fails is said and never fails the job, and a job with no
 * token posts nothing.
 */
import { readFileSync } from "node:fs";
import { forgeTargetFromEnv, type PrForge } from "@intentius/chant/pr-forge";
import { gitlabApi } from "./comment-apply-gitlab";
import { ConfigError, type ForgeName } from "./config";
import { call, commitStatuses, poster, type Fetch } from "./forge";
import { PLAN_MARK } from "./plan-note-gitlab";

export const POST_COMMANDS = ["status", "note", "reply", "stale"] as const;
export type PostCommand = (typeof POST_COMMANDS)[number];

/**
 * `terragucci post sent <context>`: whether TG_SHA already carries a successful status of that context, as `1` or `0`.
 * The control dispatch uses it to send once per commit whichever path completed the apply. A read that fails answers
 * `0`: a dispatch twice is better than none.
 */
export async function statusSent(context: string, o: PostOptions): Promise<boolean> {
  const env = o.env ?? process.env;
  const sha = (env.TG_SHA ?? "").trim();
  if (!env.TG_TOKEN || !/^[0-9a-f]{7,64}$/.test(sha) || o.forge === "gitlab") return false;
  try {
    // chant's forge client reads each context's newest status (chant#4554).
    return (await commitStatuses(poster(o.forge, env, o.fetch), sha)).some((s) => s.context === context && s.state === "success");
  } catch {
    return false;
  }
}

/** The line a stale plan note carries, and how it is told apart. */
export const STALE_MARKER = "<!-- terragucci:stale -->";
const STATES = new Set(["pending", "success", "failure"]);

export interface PostOptions {
  forge: ForgeName;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

/** What the job's log says. Never throws for a forge's answer. */
export async function forgePost(cmd: string, args: string[], o: PostOptions): Promise<string | undefined> {
  const env = o.env ?? process.env;
  if (!(POST_COMMANDS as readonly string[]).includes(cmd)) throw new ConfigError(`post is ${POST_COMMANDS.join(", ")}`);
  if (!env.TG_TOKEN) return `terragucci: no forge token, so no ${cmd}`;
  try {
    const forge = poster(o.forge, env, o.fetch);
    if (cmd === "status") await status(forge, args, o, env);
    else if (cmd === "note") await forge.upsertComment(prOf(env), PLAN_MARK, readFileSync(need(args[0], "note <file>"), "utf-8"));
    else if (cmd === "reply") await forge.addComment(prOf(env), `terragucci: ${need(args[0], "reply <text>")}`);
    else await stale(forge, need(args[0], "stale <roots> <branch>").split(","), args[1] ?? "", o, env);
    return undefined;
  } catch (e) {
    return `terragucci: ${cmd} failed: ${(e as Error).message}`;
  }
}

function need(v: string | undefined, usage: string): string {
  if (v === undefined) throw new ConfigError(`post ${usage}`);
  return v;
}

function prOf(env: NodeJS.ProcessEnv): number {
  const pr = Number((env.TG_PR ?? "").trim());
  if (!Number.isInteger(pr) || pr < 1) throw new ConfigError("TG_PR names no pull request");
  return pr;
}

async function status(forge: PrForge, args: string[], o: PostOptions, env: NodeJS.ProcessEnv): Promise<void> {
  const [context, state, description = ""] = args;
  if (!context || !state || !STATES.has(state)) throw new ConfigError("post status <context> pending|success|failure <description>");
  const sha = (env.TG_SHA ?? "").trim();
  if (!sha) throw new ConfigError("TG_SHA names no commit");
  const pipeline = o.forge === "gitlab" && sha === env.CI_COMMIT_SHA && /^[0-9]+$/.test(env.CI_PIPELINE_ID ?? "") ? Number(env.CI_PIPELINE_ID) : undefined;
  await forge.setStatus(sha, {
    context,
    // A status still going is running: GitLab shows it so, and GitHub and Forgejo, which have no such state, as pending.
    state: state === "pending" ? "running" : (state as "success" | "failure"),
    description,
    ...(forge.runUrl ? { url: forge.runUrl } : {}),
    ...(pipeline !== undefined ? { pipelineId: pipeline } : {}),
  });
}

/** The open pull (or merge) requests into `branch`, by number (iid on GitLab). */
async function openInto(branch: string, o: PostOptions, env: NodeJS.ProcessEnv): Promise<number[]> {
  const doFetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const b = encodeURIComponent(branch);
  if (o.forge === "gitlab") {
    const list = await gitlabApi(env, env.TG_TOKEN, doFetch)("GET", `/projects/${encodeURIComponent(env.CI_PROJECT_ID ?? "")}/merge_requests?state=opened&target_branch=${b}&per_page=100`);
    return (Array.isArray(list) ? list : []).map((m: any) => m?.iid).filter((n: unknown): n is number => Number.isInteger(n));
  }
  // The repository and its API as chant's client reads them from the job's environment.
  const t = forgeTargetFromEnv(env, { kind: o.forge, tokenEnv: "TG_TOKEN" });
  const list = await call(doFetch, { forge: o.forge, origin: `https://${t.host}`, path: t.repo, token: t.token, api: t.apiBase }, "GET", `/repos/${t.repo}/pulls?state=open&base=${b}&per_page=100`);
  return (Array.isArray(list) ? list : []).map((p: any) => p?.number).filter((n: unknown): n is number => Number.isInteger(n));
}

/** The plan note with the stale line under its first line, or undefined when it covers none of `moved` or already says so. */
export function staleNote(body: string, moved: readonly string[], branch: string): string | undefined {
  if (body.includes(STALE_MARKER)) return undefined;
  const hit = (/roots=(\S*) -->/.exec(body)?.[1] ?? "").split(",").filter((r) => moved.includes(r));
  if (!hit.length) return undefined;
  const lines = body.split("\n");
  lines.splice(1, 0, `> This plan is stale: ${branch} moved under ${hit.join(", ")}. Push to this pull request to plan again. ${STALE_MARKER}`);
  return lines.join("\n");
}

async function stale(forge: PrForge, moved: string[], branch: string, o: PostOptions, env: NodeJS.ProcessEnv): Promise<void> {
  for (const n of await openInto(branch, o, env)) {
    const note = await forge.findComment(n, PLAN_MARK);
    const body = note ? staleNote(note.body, moved, branch) : undefined;
    if (body) await forge.upsertComment(n, PLAN_MARK, body);
  }
}
