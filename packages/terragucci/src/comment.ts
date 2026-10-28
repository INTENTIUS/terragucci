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
 * `/terragucci action <root> <address>` asks for a day-2 action (./action.ts):
 * one Terraform `action` block of a root, run under a gated request. The
 * root must be one the pipeline was written with and the address must be an
 * action address; the action workflow reads the comment, and this job only
 * answers it where the pipeline has no action workflow.
 *
 * `/terragucci agent <ask>` is the other command, and only where
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
import { parseProductComment } from "@intentius/chant/ci-product-words";
import { commentProductWords, productWords } from "./ci-words";
import { ConfigError } from "./config";
import { poster, type Fetch } from "./forge";
import { commentCell, leftOut } from "./import/guide";

/** The commands. Everything else is refused, by name when it is a command people may expect. `agent` runs only where `agent.comment` is set. */
export const COMMENT_COMMANDS = ["plan", "apply", "action", "agent"] as const;

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
  /** `/terragucci action <root> <address>`: run one action block of the root under a gated request (./action.ts). */
  | { kind: "action"; root: string; address: string }
  | { kind: "refused"; reason: string };

/**
 * An action address as `-invoke` takes it, the pattern of the terraform
 * lexicon's `ACTION_ADDRESS` (chant#4653 action-ops.ts), written out so a
 * comment is read the same on a chant without it: `action.<type>.<label>`
 * after any number of `module.<name>.` steps, each with an optional instance
 * key (`[0]`, `["a"]`).
 */
const ACTION_KEY = String.raw`\[(?:[0-9]+|"[A-Za-z0-9_-]+")\]`;
export const ACTION_ADDRESS = new RegExp(String.raw`^(?:module\.[A-Za-z_][A-Za-z0-9_-]*(?:${ACTION_KEY})?\.)*action\.[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*(?:${ACTION_KEY})?$`);

/** A root as the action form names it: path segments, no leading dash, no shell or glob syntax (chant's member pattern). */
const ACTION_ROOT = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;

/**
 * The action form read by terragucci, for a chant whose comment grammar has
 * no `action` command (before chant#4653): the same words and checks.
 * Undefined when the comment is not `/terragucci action`.
 */
function ownActionForm(text: string): ParsedComment | undefined {
  if (!/^\/terragucci[ \t]+action(?=[ \t]|$)/.test(text)) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const parts = text.split(/[ \t]+/);
  if (parts.length !== 4) return { kind: "refused", reason: "`/terragucci action` takes a root and an action: `/terragucci action <root> <action>`" };
  const [, , root, address] = parts as [string, string, string, string];
  if (!ACTION_ROOT.test(root) || root.split("/").some((x) => x === "" || x === "." || x === "..")) return { kind: "refused", reason: "the root is a name or a path from the repository root" };
  if (!/^[A-Za-z_][A-Za-z0-9_.\[\]"-]{0,299}$/.test(address)) return { kind: "refused", reason: "an action is an action address or name, with no spaces or shell characters" };
  return { kind: "action", root, address };
}

/** An action form checked against the address pattern and, when given, the pipeline's roots. */
function checkedAction(root: string, address: string, layers: readonly (readonly string[])[] | undefined): ParsedComment {
  if (!ACTION_ADDRESS.test(address)) return { kind: "refused", reason: `\`${address}\` is not an action address: give action.<type>.<label>, after module.<name>. for an action in a module` };
  if (layers && !allowRoot(root, layers)) return { kind: "refused", reason: `${root} is not a root of this repository. The roots are ${layers.flat().sort().map((r) => `\`${r}\``).join(", ")}.` };
  return { kind: "action", root, address };
}

/**
 * Read a comment. Undefined when it is not addressed to terragucci. A comment
 * that starts with `/terragucci` is a command or it is refused: the whole
 * comment is the command, one line, words separated by spaces or tabs.
 */
export function parseComment(body: unknown, o: ParseOptions = {}): ParsedComment | undefined {
  if (typeof body !== "string") return undefined;
  const text = body.trim();
  // An `atlantis` form terragucci has no counterpart for keeps the migration guide's reason, which is terragucci's text;
  // every other comment, the aliases included, is read by chant's `parseProductComment` (chant#4550) with terragucci's words.
  if (o.atlantis) {
    const refused = fromAtlantis(text);
    if (refused !== undefined) return refused;
  }
  // `action` is chant's command where the installed chant's grammar has it (chant#4653); before it, terragucci reads the form.
  const words = commentProductWords();
  if (!words) {
    const own = ownActionForm(text);
    if (own) return own.kind === "action" ? checkedAction(own.root, own.address, o.layers) : own;
  }
  const parsed = parseProductComment(words ?? productWords(), text, o.atlantis ? { [ATLANTIS_COMMENTS_ENV]: "1" } : {});
  if (parsed === undefined) return undefined;
  if (parsed.kind === "action") return checkedAction(parsed.member, parsed.address, o.layers);
  if (parsed.kind === "plan") {
    // chant's grammar reads `--target`, `--refresh` and `--target-dependents` after the plan word (chant#4626, #4627, on chant
    // main); a terragucci re-plan plans whole roots, so it refuses them by name rather than drop them.
    const flags = parsed as { targets?: string[]; refresh?: true; targetDependents?: true };
    if (flags.targets?.length || flags.refresh || flags.targetDependents) return { kind: "refused", reason: "`/terragucci plan` re-plans whole roots: it takes no `--target`, `--refresh` or `--target-dependents`" };
    return parsed.member !== undefined ? { kind: "plan", root: parsed.member } : { kind: "plan" };
  }
  return parsed;
}

/** The variable the generated pipeline sets to 1 on every job when `atlantis_comments` is on. */
export const ATLANTIS_COMMENTS_ENV = "TG_ATLANTIS_COMMENTS";

export interface ParseOptions {
  /** Read `atlantis plan` and `atlantis apply` too. */
  atlantis?: boolean;
  /** The roots the pipeline was written with: an action naming any other root is refused. */
  layers?: readonly (readonly string[])[];
}

/** The parse options a job's environment sets. */
export function parseOptions(env: NodeJS.ProcessEnv): ParseOptions {
  return env[ATLANTIS_COMMENTS_ENV] === "1" ? { atlantis: true } : {};
}

/**
 * The refusal for an `atlantis plan` or `atlantis apply` form terragucci has
 * no counterpart for, with the migration guide's reason. Undefined for every
 * other comment: chant's grammar reads the forms terragucci accepts
 * (`-d <dir>` names the root).
 */
export function fromAtlantis(text: string): ParsedComment | undefined {
  const m = /^atlantis[ \t]+(plan|apply)(?=\s|$)/.exec(text);
  if (!m) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const verb = m[1] as "plan" | "apply";
  const words = text.split(/[ \t]+/).slice(2);
  const refuse = (reason: string): ParsedComment => ({ kind: "refused", reason });
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-d" || w === "--dir" || w === "-p" || w === "--project") {
      if (verb === "apply") {
        const l = leftOut("Applying one root of a wave");
        return refuse(`\`atlantis apply ${w}\` applies one root, and terragucci does not: ${l.rule}. ${commentCell("Apply part of the change")}`);
      }
      if (w === "-p" || w === "--project") return refuse(`a root goes by its path, not a project name: write \`atlantis plan -d <dir>\` or ${commentCell("Plan one project")}`);
      if (words[++i] === undefined) return refuse("`-d` names the root's directory, like `atlantis plan -d envs/dev/orders`");
    } else if (w === "-w" || w === "--workspace") return refuse(`\`${w}\` picks a workspace, and terragucci has ${commentCell("Plan one workspace")}`);
    else if (w === "--") {
      const l = leftOut("Flags at run time");
      return refuse(`a comment passes no flags to the binary: ${l.rule}. Instead: ${l.instead}`);
    } else if (w === "--verbose") continue;
    else if (w.startsWith("-")) return refuse(`\`atlantis ${verb}\` takes ${verb === "plan" ? "`-d <dir>` and nothing else" : "nothing, or a wave like `wave-2`"} here`);
  }
  return undefined;
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
  /** An action (`action: "run"`): the action's address, with `root` and `user`. */
  address?: string;
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
  /** The reply to `/terragucci action` where the pipeline has no action workflow, such as the engine refusal of a root on OpenTofu. */
  noAction?: string;
  /**
   * `run`: this is the action workflow's job (./action.ts), which reads
   * `/terragucci action <root> <address>` comments and a dispatch's `root`
   * and `address` inputs, and nothing else.
   */
  action?: "run";
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

  // A workflow_dispatch with a pr input asks for the same re-plan as `/terragucci plan [root]` on that pull request.
  const dispatch = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  let parsed: ParsedComment;
  let number: number;
  let user: string;
  if (dispatch && o.action === "run") {
    // The action workflow's dispatch (behold's button): root and address, read by the comment grammar as `/terragucci action <root> <address>`.
    const ask = readActionDispatch(event.inputs, o.layers);
    if ("error" in ask) return broke(ask.error);
    const sender = event.sender?.login;
    if (typeof sender !== "string" || !LOGIN.test(sender)) return stop("the dispatch has no usable sender");
    parsed = ask.parsed;
    number = 0;
    user = sender;
  } else if (dispatch) {
    if (o.agent === "run") return stop("an agent runs on a comment, not on a dispatch");
    const ask = readDispatch(event.inputs);
    if (ask === undefined) return stop("the dispatch names no pull request");
    if ("error" in ask) return broke(ask.error);
    const sender = event.sender?.login;
    if (typeof sender !== "string" || !LOGIN.test(sender)) return stop("the dispatch has no usable sender");
    parsed = ask.parsed;
    number = ask.pr;
    user = sender;
  } else {
    if (event.action !== "created") return stop("not a new comment");
    const read = parseComment(event.comment?.body, { ...parseOptions(env), layers: o.layers });
    if (!read) return stop("the comment is not addressed to terragucci");
    const issue = event.issue?.number;
    if (!Number.isInteger(issue) || issue < 1) return stop("the comment has no issue number");
    if (!event.issue?.pull_request && event.issue?.is_pull !== true) return stop("the comment is not on a pull request");
    const author = event.comment?.user?.login;
    if (typeof author !== "string" || !LOGIN.test(author)) return stop("the comment has no usable author");
    parsed = read;
    number = issue;
    user = author;
  }

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
  const forge = poster(o.forge ?? "github", env, doFetch);
  const reply = async (text: string): Promise<void> => {
    // A dispatch names no pull request: its answer is the job's log.
    if (number === 0) return void console.log(`terragucci: ${text}`);
    try {
      await forge.addComment(number, `terragucci: ${text}`);
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
    if (dispatch) {
      // A dispatch's payload carries no permission (Forgejo writes them all false), and the job's token may
      // not ask for the sender's. Forgejo itself refuses a dispatch from anyone without write access ("user
      // should have a permission to write to a repo"), so a workflow_dispatch event is already a writer's.
    } else {
      if (event.sender?.login !== user) return stop("the comment's author is not the event's sender");
      const p = event.repository?.permissions;
      if (p?.push !== true && p?.admin !== true) return stop(`${user} has no write access, so the comment is ignored`);
    }
  } else {
    let permission: unknown;
    try {
      permission = (await call("GET", `repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`))?.permission;
    } catch (e) {
      return broke(`could not read ${user}'s permission, so nothing runs (${(e as Error).message})`);
    }
    if (typeof permission !== "string" || !MAY_PLAN.has(permission)) return stop(`${user} has no write access, so the ${dispatch ? "dispatch" : "comment"} is ignored`);
  }

  // The action workflow answers an action comment, a refused one included, and leaves every other comment to the pipeline's jobs.
  if (o.action === "run") {
    if (parsed.kind === "refused") {
      if (!dispatch && !/^\/terragucci[ \t]+action(?=\s|$)/.test(String(event.comment?.body ?? "").trim())) return stop("another job reads this comment");
      await reply(parsed.reason);
      return stop(parsed.reason);
    }
    if (parsed.kind !== "action") return stop("another job reads this comment");
    return { go: true, reason: `run ${parsed.address} on ${parsed.root} for ${user}`, ...(number > 0 ? { pr: number } : {}), root: parsed.root, address: parsed.address, user };
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
  // The action workflow reads `/terragucci action` (./action.ts); this job sees one only where the pipeline has none.
  if (parsed.kind === "action") {
    const reason = o.noAction ?? "this pipeline has no action workflow; run `terragucci init` again to write it";
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

/** A pull request number as a dispatch's pr input carries it: digits, no sign, no leading zero. */
const PR_INPUT = /^[1-9][0-9]{0,9}$/;

/**
 * The re-plan a workflow_dispatch asks for, from its inputs: `pr` names the
 * pull request and the optional `root` one root, read by the comment grammar
 * as `/terragucci plan <root>`. Undefined when `pr` is empty (a dispatch for
 * another job, such as drift); an error when `pr` is not a pull request number.
 */
export function readDispatch(inputs: unknown): { pr: number; parsed: ParsedComment } | { error: string } | undefined {
  const i = inputs !== null && typeof inputs === "object" ? (inputs as Record<string, unknown>) : {};
  const pr = typeof i.pr === "number" ? String(i.pr) : i.pr;
  if (pr === undefined || pr === null || pr === "") return undefined;
  if (typeof pr !== "string" || !PR_INPUT.test(pr.trim())) return { error: "the dispatch's pr input is a pull request number, like 42" };
  const root = i.root;
  if (root !== undefined && root !== null && typeof root !== "string") return { error: "the dispatch's root input is a root path, like envs/dev/orders" };
  const parsed = typeof root === "string" && root.trim() !== "" ? parseComment(`/terragucci plan ${root.trim()}`)! : ({ kind: "plan" } as const);
  return { pr: Number(pr.trim()), parsed };
}

/**
 * The action a dispatch of the action workflow asks for, from its `root` and
 * `address` inputs, read by the comment grammar as `/terragucci action <root>
 * <address>`, so a dispatch is checked as a comment is.
 */
export function readActionDispatch(inputs: unknown, layers?: readonly (readonly string[])[]): { parsed: ParsedComment } | { error: string } {
  const i = inputs !== null && typeof inputs === "object" ? (inputs as Record<string, unknown>) : {};
  const root = typeof i.root === "string" ? i.root.trim() : "";
  const address = typeof i.address === "string" ? i.address.trim() : "";
  if (root === "" || address === "") return { error: "the dispatch names a root and an action address: inputs root and address" };
  if (/\s/.test(root) || /\s/.test(address)) return { parsed: { kind: "refused", reason: "a root and an action address have no spaces in them" } };
  return { parsed: parseComment(`/terragucci action ${root} ${address}`, layers ? { layers } : {})! };
}

/** Write the decision where the job's script reads it. */
export function writeDecision(file: string, d: CommentDecision): void {
  writeFileSync(file, `${JSON.stringify(d)}\n`);
}
