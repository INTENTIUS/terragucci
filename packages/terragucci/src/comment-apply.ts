/**
 * `terragucci comment-apply`: the decision behind `/terragucci apply
 * [wave-<n>]` on a merged pull request. The comment is a deploy button for an
 * apply that already has what it needs: it starts `tf-apply` again on the
 * default branch, at the pull request's merge commit, the way a re-run of the
 * wave's job does. It approves nothing. A wave whose gate has no verified,
 * sealed record still waits, and one whose plans changed since the approval
 * is still refused; `stage tf-apply` decides both, as it does for a push.
 *
 * The comment is untrusted input, read from the event file and parsed by the
 * one grammar in comment.ts. What leaves this file for the pipeline's shell is
 * a pull request number, a commit sha and a wave number, each checked against
 * a pattern with no shell syntax in it.
 *
 * Refused, with a reply, before any credential is asked for: a commenter
 * without write access, a pull request that is open or was closed without
 * merging, one from a fork, one merged into another branch, a merge commit
 * the default branch no longer reaches, one a later apply superseded (the
 * reply names that run), a wave the repo does not have, and any other text.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { applyWaves } from "./apply";
import { apiOf, BRANCH, LOGIN, parseComment, SHA, type CommentDecision } from "./comment";
import type { Fetch } from "./forge";

/** What the apply job does next: apply from the merge commit (`go`), or stop with a reason. */
export interface ApplyCommentDecision extends Omit<CommentDecision, "root"> {
  /** The last wave to run, when the comment named one. */
  wave?: number;
}

/** Permissions that may ask for an apply: the same as may push to the repo. */
const MAY_APPLY = new Set(["admin", "owner", "maintain", "write"]);

/** How many commits after the merge commit are read for a later apply; more than this and the merge commit counts as superseded. */
export const NEWER_LIMIT = 50;

/** The status every apply posts on the commit it applied. */
const APPLY_CONTEXT = "terragucci/apply";

export type Git = (args: string[]) => { status: number | null; stdout: string; stderr: string };

export interface ApplyCommentOptions {
  /** The roots the pipeline was written with, one array per layer. */
  layers: string[][];
  /** Globs for the canary wave, as the pipeline was written with them. */
  canary?: string[];
  forge?: "github" | "forgejo";
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** Git in the job's checkout. Default: git in the working directory. */
  git?: Git;
}

const short = (sha: string): string => sha.slice(0, 8);

export async function decideApplyComment(o: ApplyCommentOptions): Promise<ApplyCommentDecision> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const git: Git = o.git ?? ((args) => spawnSync("git", args, { encoding: "utf-8" }) as ReturnType<Git>);
  const stop = (reason: string): ApplyCommentDecision => ({ go: false, reason });
  const broke = (reason: string): ApplyCommentDecision => ({ go: false, fail: true, reason });
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return broke("comment-apply reads the event file; GITHUB_EVENT_PATH is not set");
  let event: any;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (e) {
    return broke(`could not read the event file ${eventPath} (${(e as Error).message})`);
  }
  if (event === null || typeof event !== "object") return broke(`the event file ${eventPath} is not a JSON object`);

  if (event.action !== "created") return stop("not a new comment");
  const parsed = parseComment(event.comment?.body);
  // A plan comment, or one not addressed to terragucci, belongs to the replan job.
  if (!parsed || parsed.kind === "plan" || parsed.kind === "agent") return stop("the comment does not ask for an apply");
  const number = event.issue?.number;
  if (!Number.isInteger(number) || number < 1) return stop("the comment has no issue number");
  if (!event.issue?.pull_request && event.issue?.is_pull !== true) return stop("the comment is not on a pull request");
  const user = event.comment?.user?.login;
  if (typeof user !== "string" || !LOGIN.test(user)) return stop("the comment has no usable author");

  const { api, repo, token } = apiOf(env);
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await doFetch(`${api}/${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `token ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  const reply = async (text: string): Promise<void> => {
    try {
      await call("POST", `repos/${repo}/issues/${number}/comments`, { body: `terragucci: ${text}` });
    } catch (e) {
      console.error(`terragucci: could not reply: ${(e as Error).message}`);
    }
  };
  const refuse = async (reason: string): Promise<ApplyCommentDecision> => {
    await reply(reason);
    return stop(reason);
  };

  // Who asked comes first, and nothing runs for someone who cannot push.
  const noWrite = `${user} has no write access to this repository, so nothing is applied`;
  if (o.forge === "forgejo") {
    // The commenter's permission comes from the event (see comment.ts); an event that does not hold together gets no answer.
    if (event.repository?.full_name !== repo) return stop("the event is not for this repository");
    if (event.sender?.login !== user) return stop("the comment's author is not the event's sender");
    const p = event.repository?.permissions;
    if (p?.push !== true && p?.admin !== true) return refuse(noWrite);
  } else {
    let permission: unknown;
    try {
      permission = (await call("GET", `repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`))?.permission;
    } catch (e) {
      return broke(`could not read ${user}'s permission, so nothing is applied (${(e as Error).message})`);
    }
    if (typeof permission !== "string" || !MAY_APPLY.has(permission)) return refuse(noWrite);
  }

  if (parsed.kind === "refused") return refuse(parsed.reason);

  const waves = applyWaves(o.layers, o.canary).length;
  if (parsed.wave !== undefined && parsed.wave > waves) return refuse(`this repository applies in ${waves} wave${waves === 1 ? "" : "s"}, so there is no wave-${parsed.wave}`);

  let pr: any;
  try {
    pr = await call("GET", `repos/${repo}/pulls/${number}`);
  } catch (e) {
    return broke(`could not read pull request ${number} (${(e as Error).message})`);
  }
  // Only merged code applies: never an open pull request's head, never a closed one's.
  if (pr?.merged !== true) {
    return refuse(pr?.state === "open"
      ? `pull request ${number} is not merged: \`/terragucci apply\` re-runs the apply of a merged pull request, from the default branch, and never applies a pull request's branch`
      : `pull request ${number} was closed without merging, so there is nothing of it to apply`);
  }
  if (pr?.head?.repo?.full_name !== repo) return refuse("a pull request from a fork is not applied on a comment: its apply runs when it is pushed to the default branch");
  const base = event.repository?.default_branch;
  if (typeof base !== "string" || !BRANCH.test(base) || base.split("/").some((s: string) => s === ".." || s === "")) return broke("the event names no default branch this command passes on");
  if (pr?.base?.ref !== base) return refuse(`pull request ${number} was merged into ${String(pr?.base?.ref)}, not the default branch ${base}, so nothing applies from it`);
  const sha = pr?.merge_commit_sha;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke(`pull request ${number} has no merge commit`);

  // The merge commit must still be on the default branch, as origin has it now.
  const remote = `refs/remotes/origin/${base}`;
  const fetched = git(["fetch", "-q", "origin", `+refs/heads/${base}:${remote}`]);
  if (fetched.status !== 0) return broke(`could not fetch ${base} (${fetched.stderr.trim()})`);
  const reach = git(["merge-base", "--is-ancestor", sha, remote]);
  if (reach.status === 1 || (reach.status !== 0 && /not a valid|bad object|no such|unknown/i.test(reach.stderr))) {
    return refuse(`the merge commit ${short(sha)} of pull request ${number} is no longer on ${base}, so it is not applied`);
  }
  if (reach.status !== 0) return broke(`could not tell whether ${short(sha)} is on ${base} (${reach.stderr.trim()})`);

  // A later commit whose apply started applied a newer tree: going back to this one would undo it.
  const newer = git(["rev-list", `--max-count=${NEWER_LIMIT + 1}`, `${sha}..${remote}`]);
  if (newer.status !== 0) return broke(`could not list the commits on ${base} after ${short(sha)} (${newer.stderr.trim()})`);
  const later = newer.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (later.length > NEWER_LIMIT) return refuse(`more than ${NEWER_LIMIT} commits reached ${base} after the merge commit ${short(sha)}; the apply of the newest one applies them, so this one is not applied`);
  for (const c of later) {
    if (!SHA.test(c)) return broke(`git listed ${c} as a commit`);
    let statuses: any;
    try {
      statuses = await call("GET", `repos/${repo}/commits/${c}/statuses?per_page=100&limit=50`);
    } catch (e) {
      return broke(`could not read the statuses of ${short(c)} (${(e as Error).message})`);
    }
    const applied = Array.isArray(statuses) ? statuses.find((s: any) => s?.context === APPLY_CONTEXT) : undefined;
    if (applied) {
      const run = typeof applied.target_url === "string" && /^https?:\/\//.test(applied.target_url) ? ` (${applied.target_url})` : "";
      return refuse(`a later apply already ran on ${base} at ${short(c)}${run}, so the merge commit ${short(sha)} of pull request ${number} is not applied: comment on the pull request that commit came from, or push again`);
    }
  }

  const through = parsed.wave !== undefined ? ` through wave ${parsed.wave}` : "";
  return { go: true, reason: `apply pull request ${number}'s merge commit ${short(sha)}${through} for ${user}`, pr: number, sha, base, ...(parsed.wave !== undefined ? { wave: parsed.wave } : {}) };
}
