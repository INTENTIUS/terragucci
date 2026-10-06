/**
 * `terragucci comment`: the pull request comment command. A comment that reads
 * `/terragucci plan [root]` re-plans what the pull request changes, read-only.
 * Nothing here applies, approves or unlocks: the only command is `plan`, and a
 * re-plan changes nothing an approval covers, since approvals bind digests.
 *
 * The comment is untrusted input. It is read from the event file, never from
 * an expression in a script, and it is parsed against one strict grammar. The
 * only text that leaves this file for the pipeline's shell is a pull request
 * number, a commit sha, a branch name and a root, each checked against a
 * pattern that has no shell syntax in it, and the root is also an exact member
 * of the roots the pipeline was written with.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ConfigError } from "./config";
import type { Fetch } from "./forge";

/** The one command. Everything else is refused, by name when it is a command people may expect. */
export const COMMENT_COMMANDS = ["plan"] as const;

/** Commands a comment never runs, named in the reply so nobody waits on them. */
const NEVER = new Set(["apply", "approve", "unlock", "force-unlock", "import", "state", "destroy", "merge"]);

/** A root as a comment may name it: path segments, no leading dash, no shell or glob syntax. */
const ROOT = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;

export type ParsedComment =
  | { kind: "plan"; root?: string }
  | { kind: "refused"; reason: string };

/**
 * Read a comment. Undefined when it is not addressed to terragucci. A comment
 * that starts with `/terragucci` is a command or it is refused: the whole
 * comment is the command, one line, words separated by spaces or tabs.
 */
export function parseComment(body: unknown): ParsedComment | undefined {
  if (typeof body !== "string") return undefined;
  const text = body.trim();
  if (text !== "/terragucci" && !/^\/terragucci[ \t]/.test(text)) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const words = text.split(/[ \t]+/);
  const verb = words[1];
  if (verb === undefined) return { kind: "refused", reason: "the command is `/terragucci plan [root]`" };
  if (verb !== "plan") {
    return {
      kind: "refused",
      reason: NEVER.has(verb) ? `a comment never runs \`${verb}\`: terragucci re-plans on request and nothing more` : "the only command is `/terragucci plan [root]`",
    };
  }
  if (words.length > 3) return { kind: "refused", reason: "`/terragucci plan` takes one root at most" };
  const root = words[2];
  if (root === undefined) return { kind: "plan" };
  if (!ROOT.test(root) || root.split("/").some((s) => s === "" || s === "." || s === "..")) return { kind: "refused", reason: "the root is a path from the repository root, like `envs/dev/orders`" };
  return { kind: "plan", root };
}

/** The root a comment named, when it is one of the roots the pipeline was written with. */
export function allowRoot(root: string, layers: readonly (readonly string[])[]): boolean {
  return layers.some((l) => l.includes(root));
}

/** What the job does next: re-plan the pull request (`go`), or stop with a reason. */
export interface CommentDecision {
  go: boolean;
  reason: string;
  /** True when the job stopped because something broke (a forge answer, an unreadable event), not because the comment asked for nothing. The command exits non-zero on it. */
  fail?: boolean;
  pr?: number;
  sha?: string;
  base?: string;
  root?: string;
}

/** Permissions that may ask for a re-plan. A read-only collaborator or a stranger may not. */
const MAY_PLAN = new Set(["admin", "owner", "maintain", "write"]);

export interface CommentOptions {
  /** The roots the pipeline was written with, one array per layer. */
  layers: string[][];
  /** Where the job runs, which decides how the commenter's permission is read. GitHub when unset. */
  forge?: "github" | "forgejo";
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

/** The forge's API root and the repository, from the job's environment (GitHub's variables, which Forgejo sets too). */
function apiOf(env: NodeJS.ProcessEnv): { api: string; repo: string; token: string } {
  const repo = env.GITHUB_REPOSITORY;
  const api = env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/api/v1` : undefined);
  const token = env.TG_TOKEN;
  if (!repo || !api || !token) throw new ConfigError("comment needs GITHUB_REPOSITORY, GITHUB_API_URL or GITHUB_SERVER_URL, and TG_TOKEN in the environment");
  return { api, repo, token };
}

export async function decideComment(o: CommentOptions): Promise<CommentDecision> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new ConfigError("comment reads the event file; GITHUB_EVENT_PATH is not set");
  const stop = (reason: string): CommentDecision => ({ go: false, reason });
  /** An infrastructure error: no re-plan, and the job fails with the cause. */
  const broke = (reason: string): CommentDecision => ({ go: false, fail: true, reason });
  let event: any;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (e) {
    return broke(`could not read the event file ${eventPath} (${(e as Error).message})`);
  }
  if (event === null || typeof event !== "object") return broke(`the event file ${eventPath} is not a JSON object`);

  if (event.action !== "created") return stop("not a new comment");
  const parsed = parseComment(event.comment?.body);
  if (!parsed) return stop("the comment is not addressed to terragucci");
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

  // Who asked comes first: a stranger's comment gets no reply, no plan and no credentials.
  if (o.forge === "forgejo") {
    // Forgejo answers 403 when a job's token asks for another user's permission
    // (only an admin, a repository admin or the user may). The forge writes the
    // commenter's permission into the event instead: the issue_comment payload's
    // repository.permissions is computed for the comment's author when the
    // comment is created, and the comment's text cannot change it.
    if (event.repository?.full_name !== repo) return stop("the event is not for this repository");
    if (event.sender?.login !== user) return stop("the comment's author is not the event's sender");
    const p = event.repository?.permissions;
    if (p?.push !== true && p?.admin !== true) return stop(`${user} has no write access, so the comment is ignored`);
  } else {
    let permission: unknown;
    try {
      permission = (await call("GET", `repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`))?.permission;
    } catch (e) {
      return broke(`could not read ${user}'s permission, so nothing runs (${(e as Error).message})`);
    }
    if (typeof permission !== "string" || !MAY_PLAN.has(permission)) return stop(`${user} has no write access, so the comment is ignored`);
  }

  if (parsed.kind === "refused") {
    await reply(parsed.reason);
    return stop(parsed.reason);
  }
  if (parsed.root !== undefined && !allowRoot(parsed.root, o.layers)) {
    const reason = `${parsed.root} is not a root of this repository`;
    await reply(`${reason}. The roots are ${o.layers.flat().sort().map((r) => `\`${r}\``).join(", ")}.`);
    return stop(reason);
  }

  let pr: any;
  try {
    pr = await call("GET", `repos/${repo}/pulls/${number}`);
  } catch (e) {
    return broke(`could not read pull request ${number} (${(e as Error).message})`);
  }
  if (pr?.state !== "open") return stop(`pull request ${number} is not open`);
  // A fork's code never meets the read-only plan role, here or in the plan job.
  if (pr?.head?.repo?.full_name !== repo) {
    const reason = "a pull request from a fork is not re-planned: its code never runs with this repository's credentials";
    await reply(reason);
    return stop(reason);
  }
  const sha = pr?.head?.sha;
  const base = pr?.base?.ref;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke("the pull request's head is not a commit");
  if (typeof base !== "string" || !BRANCH.test(base) || base.split("/").some((s) => s === ".." || s === "")) return broke("the pull request's base branch has a name this command does not pass on");
  return { go: true, reason: `re-plan pull request ${number}${parsed.root ? ` at ${parsed.root}` : ""} for ${user}`, pr: number, sha, base, ...(parsed.root ? { root: parsed.root } : {}) };
}

/** Write the decision where the job's script reads it. */
export function writeDecision(file: string, d: CommentDecision): void {
  writeFileSync(file, `${JSON.stringify(d)}\n`);
}
