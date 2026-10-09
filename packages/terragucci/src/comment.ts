/**
 * `terragucci comment`: the pull request comment command. A comment that reads
 * `/terragucci plan [root]` re-plans what the pull request changes, read-only.
 * Nothing here applies, approves or unlocks, and a re-plan changes nothing an
 * approval covers, since approvals bind digests. `/terragucci apply [wave-<n>]`,
 * `/terragucci lock` and `/terragucci unlock` parse here too, and are decided
 * by `terragucci comment-apply` (comment-apply.ts): it re-runs an already
 * approved apply after the merge, or, with `apply.when: pull-request`,
 * applies an open pull request, and takes and releases its root locks.
 *
 * The comment is untrusted input. It is read from the event file, never from
 * an expression in a script, and it is parsed against one strict grammar. The
 * only text that leaves this file for the pipeline's shell is a pull request
 * number, a commit sha, a branch name and a root, each checked against a
 * pattern that has no shell syntax in it, and the root is also an exact member
 * of the roots the pipeline was written with.
 *
 * `/terragucci agent <ask>` is the one other command, and only where
 * `agent.comment` is set in terragucci.yml. Its ask is data: it goes into the
 * agent's prompt file and its commit message, never into a shell, and the
 * agent job (agent-comment.ts) gets no cloud credentials.
 *
 * With `atlantis_comments: true` the pipeline sets TG_ATLANTIS_COMMENTS=1 on
 * every job, and `atlantis plan` and `atlantis apply` read as `/terragucci
 * plan` and `/terragucci apply` (fromAtlantis). The alias changes the words
 * and nothing else: the rewritten comment is parsed by the same grammar and
 * decided by the same checks, and a form terragucci has no counterpart for is
 * refused with the migration guide's reason.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ConfigError } from "./config";
import type { Fetch } from "./forge";
import { commentCell, leftOut } from "./import/guide";

/** The commands. Everything else is refused, by name when it is a command people may expect. `agent` runs only where `agent.comment` is set. */
export const COMMENT_COMMANDS = ["plan", "apply", "agent"] as const;

/** Commands a comment never runs, named in the reply so nobody waits on them. */
const NEVER = new Set(["approve", "force-unlock", "import", "state", "destroy", "merge"]);

/** A root as a comment may name it: path segments, no leading dash, no shell or glob syntax. */
const ROOT = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;
export const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;
export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;
/** The longest ask an agent comment may carry. */
export const ASK_MAX = 2000;

export type ParsedComment =
  | { kind: "plan"; root?: string }
  /** `/terragucci apply [wave-<n>]`: re-run the merged pull request's apply, through wave n when one is named. */
  | { kind: "apply"; wave?: number }
  /** `/terragucci lock`: take the root locks of the roots the pull request reaches, applying nothing (`apply.when: pull-request`). */
  | { kind: "lock" }
  /** `/terragucci unlock`: release the root locks the pull request holds (`apply.when: pull-request`). */
  | { kind: "unlock" }
  | { kind: "agent"; ask: string }
  | { kind: "refused"; reason: string };

/**
 * Read a comment. Undefined when it is not addressed to terragucci. A comment
 * that starts with `/terragucci` is a command or it is refused: the whole
 * comment is the command, one line, words separated by spaces or tabs.
 */
export function parseComment(body: unknown, o: ParseOptions = {}): ParsedComment | undefined {
  if (typeof body !== "string") return undefined;
  const text = body.trim();
  if (o.atlantis) {
    const alias = fromAtlantis(text);
    if (alias !== undefined) return typeof alias === "string" ? parseComment(alias) : alias;
  }
  if (text !== "/terragucci" && !/^\/terragucci[ \t]/.test(text)) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const words = text.split(/[ \t]+/);
  const verb = words[1];
  if (verb === undefined) return { kind: "refused", reason: "the command is `/terragucci plan [root]`" };
  if (verb === "apply") return parseApply(words);
  if (verb === "lock") return words.length === 2 ? { kind: "lock" } : { kind: "refused", reason: "`/terragucci lock` takes nothing after it: it locks every root the pull request reaches" };
  if (verb === "unlock") return words.length === 2 ? { kind: "unlock" } : { kind: "refused", reason: "`/terragucci unlock` takes nothing after it: it releases every lock the pull request holds" };
  if (verb === "agent") {
    // The ask is the rest of the line, as written; it is never split or run.
    const ask = text.replace(/^\/terragucci[ \t]+agent/, "").trim();
    if (ask === "") return { kind: "refused", reason: "`/terragucci agent` needs an ask after it, on the same line, such as `/terragucci agent rename the bucket variable to bucket_name`" };
    if (ask.length > ASK_MAX) return { kind: "refused", reason: `an ask is at most ${ASK_MAX} characters` };
    // Control characters (escape sequences, NUL) have no place in an ask.
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ask)) return { kind: "refused", reason: "an ask is plain text, with no control characters" };
    return { kind: "agent", ask };
  }
  if (verb !== "plan") {
    return {
      kind: "refused",
      reason: NEVER.has(verb) ? `a comment never runs \`${verb}\`: terragucci re-plans, and re-runs an apply already approved, on request and nothing more` : "the commands are `/terragucci plan [root]` and `/terragucci apply [wave-<n>]`",
    };
  }
  if (words.length > 3) return { kind: "refused", reason: "`/terragucci plan` takes one root at most" };
  const root = words[2];
  if (root === undefined) return { kind: "plan" };
  if (!ROOT.test(root) || root.split("/").some((s) => s === "" || s === "." || s === "..")) return { kind: "refused", reason: "the root is a path from the repository root, like `envs/dev/orders`" };
  return { kind: "plan", root };
}

/** The variable the generated pipeline sets to 1 on every job when `atlantis_comments` is on. */
export const ATLANTIS_COMMENTS_ENV = "TG_ATLANTIS_COMMENTS";

export interface ParseOptions {
  /** Read `atlantis plan` and `atlantis apply` too. */
  atlantis?: boolean;
}

/** The parse options a job's environment sets. */
export function parseOptions(env: NodeJS.ProcessEnv): ParseOptions {
  return env[ATLANTIS_COMMENTS_ENV] === "1" ? { atlantis: true } : {};
}

/**
 * An `atlantis plan` or `atlantis apply` comment in terragucci's words:
 * `-d <dir>` names the root, and whatever else follows is passed on to the
 * same grammar. A form terragucci has no counterpart for is refused with the
 * guide's reason. Undefined for any other comment, which stays unaddressed.
 */
export function fromAtlantis(text: string): string | ParsedComment | undefined {
  const m = /^atlantis[ \t]+(plan|apply)(?=\s|$)/.exec(text);
  if (!m) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const verb = m[1] as "plan" | "apply";
  const words = text.split(/[ \t]+/).slice(2);
  const refuse = (reason: string): ParsedComment => ({ kind: "refused", reason });
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-d" || w === "--dir" || w === "-p" || w === "--project") {
      if (verb === "apply") {
        const l = leftOut("Applying one root of a wave");
        return refuse(`\`atlantis apply ${w}\` applies one root, and terragucci does not: ${l.rule}. ${commentCell("Apply part of the change")}`);
      }
      if (w === "-p" || w === "--project") return refuse(`a root goes by its path, not a project name: write \`atlantis plan -d <dir>\` or ${commentCell("Plan one project")}`);
      const dir = words[++i];
      if (dir === undefined) return refuse("`-d` names the root's directory, like `atlantis plan -d envs/dev/orders`");
      rest.push(dir.replace(/^\.\/+/, "").replace(/\/+$/, ""));
    } else if (w === "-w" || w === "--workspace") return refuse(`\`${w}\` picks a workspace, and terragucci has ${commentCell("Plan one workspace")}`);
    else if (w === "--") {
      const l = leftOut("Flags at run time");
      return refuse(`a comment passes no flags to the binary: ${l.rule}. Instead: ${l.instead}`);
    } else if (w === "--verbose") continue;
    else if (w.startsWith("-")) return refuse(`\`atlantis ${verb}\` takes ${verb === "plan" ? "`-d <dir>` and nothing else" : "nothing, or a wave like `wave-2`"} here`);
    else rest.push(w);
  }
  return `/terragucci ${verb}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

/** `/terragucci apply` with nothing after it, or with one wave: `wave-<n>`, n from 1. */
function parseApply(words: string[]): ParsedComment {
  if (words.length > 3) return { kind: "refused", reason: "`/terragucci apply` takes one wave at most, like `wave-2`" };
  const wave = words[2];
  if (wave === undefined) return { kind: "apply" };
  const m = /^wave-([1-9][0-9]{0,2})$/.exec(wave);
  if (!m) return { kind: "refused", reason: "the wave is written `wave-<n>`, like `wave-2`" };
  return { kind: "apply", wave: Number(m[1]) };
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
  /** An agent comment: the pull request's head branch, the ask and who asked. */
  head?: string;
  ask?: string;
  user?: string;
}

/** Permissions that may ask for a re-plan. A read-only collaborator or a stranger may not. */
const MAY_PLAN = new Set(["admin", "owner", "maintain", "write"]);

export interface CommentOptions {
  /** The roots the pipeline was written with, one array per layer. */
  layers: string[][];
  /** Where the job runs, which decides how the commenter's permission is read. GitHub when unset. */
  forge?: "github" | "forgejo";
  /**
   * The agent comment. `off` (default): the re-plan job answers an agent
   * comment that `agent.comment` is not set. `on`: it is set, and the agent job
   * reads agent comments, so the re-plan job leaves them alone. `run`: this is
   * the agent job, which reads agent comments only.
   */
  agent?: "off" | "on" | "run";
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

/** The forge's API root and the repository, from the job's environment (GitHub's variables, which Forgejo sets too). */
export function apiOf(env: NodeJS.ProcessEnv): { api: string; repo: string; token: string } {
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
  const parsed = parseComment(event.comment?.body, parseOptions(env));
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

  const agent = o.agent ?? "off";
  if (agent === "run") {
    // The agent job starts only for `/terragucci agent ` comments; a re-plan is the replan job's.
    if (parsed.kind !== "agent" && parsed.kind !== "refused") return stop("another job reads this comment");
  } else if (parsed.kind === "agent") {
    const reason = agent === "on"
      ? "write an agent comment as `/terragucci agent <ask>`, with one space after agent"
      : "the agent command is off in this repository; `agent.comment` in terragucci.yml turns it on";
    await reply(reason);
    return stop(reason);
  }
  if (parsed.kind === "refused") {
    await reply(parsed.reason);
    return stop(parsed.reason);
  }
  // A pipeline with the comment-apply job sends `/terragucci apply` there and never here; one written before it had the job says so.
  if (parsed.kind === "apply") {
    const reason = "this pipeline does not apply on a comment: re-run the apply job on the forge, or push to the default branch again";
    await reply(reason);
    return stop(reason);
  }
  // With `apply.when: pull-request` the comment-apply job reads `/terragucci lock` and `/terragucci unlock`; any other pipeline takes no locks.
  if (parsed.kind === "lock") {
    const reason = "this repository applies after merge, so pull requests take no locks";
    await reply(reason);
    return stop(reason);
  }
  if (parsed.kind === "unlock") {
    const reason = "this repository applies after merge, so no pull request holds a lock and there is nothing to unlock";
    await reply(reason);
    return stop(reason);
  }
  if (parsed.kind === "plan" && parsed.root !== undefined && !allowRoot(parsed.root, o.layers)) {
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
  if (parsed.kind === "agent" && pr?.head?.repo?.full_name !== repo) {
    const reason = "a pull request from a fork gets no agent: its branch is not this repository's to push to";
    await reply(reason);
    return stop(reason);
  }
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
  if (parsed.kind === "agent") {
    const head = pr?.head?.ref;
    if (typeof head !== "string" || !BRANCH.test(head) || head.split("/").some((s) => s === ".." || s === "") || head.endsWith(".lock")) {
      return broke("the pull request's head branch has a name this command does not pass on");
    }
    // The agent pushes to the head branch, so a pull request from the default branch gets none.
    const main = event.repository?.default_branch ?? pr?.base?.repo?.default_branch;
    if (typeof main !== "string" || head === main) {
      const reason = "the pull request's head is the default branch, and an agent never pushes there";
      await reply(reason);
      return stop(reason);
    }
    return { go: true, reason: `run the agent on pull request ${number} (${head}) for ${user}`, pr: number, sha, base, head, ask: parsed.ask, user };
  }
  return { go: true, reason: `re-plan pull request ${number}${parsed.root ? ` at ${parsed.root}` : ""} for ${user}`, pr: number, sha, base, ...(parsed.root ? { root: parsed.root } : {}) };
}

/** Write the decision where the job's script reads it. */
export function writeDecision(file: string, d: CommentDecision): void {
  writeFileSync(file, `${JSON.stringify(d)}\n`);
}
