/**
 * `terragucci comment-apply`: the decision behind `/terragucci apply
 * [wave-<n>]` on a pull request.
 *
 * On a merged pull request the comment is a deploy button for an apply that
 * already has what it needs: it starts `tf-apply` again on the default
 * branch, at the pull request's merge commit, the way a re-run of the wave's
 * job does. It approves nothing. A wave whose gate has no verified, sealed
 * record still waits, and one whose plans changed since the approval is still
 * refused; `stage tf-apply` decides both, as it does for a push.
 *
 * With `apply.when: pull-request` the comment also applies an open pull
 * request, from its head, in the same waves and under the same gates. Before
 * anything runs, each requirement `apply.requires` lists (all four by
 * default) is checked and refused by name: `approved`, the head has an
 * approval from a reviewer other than its author, given on that head;
 * `checks`, its statuses and checks passed; `mergeable`, the forge says it
 * can merge (no conflicts, and on GitHub no branch protection blocking it);
 * `undiverged`, it contains the default branch. Whatever `apply.requires`
 * says, `terragucci/plan` passed on the head (a policy denial fails it, and
 * nothing waives a denial), the head did not move while the comment was
 * read, it does not change the pipeline file, which the comment's job runs
 * from the default branch, and no other open pull request holds a lock on a
 * root it reaches (locks.ts). The decision then takes those locks. In a
 * Terragrunt repo the locks are on units (reachedUnits). `/terragucci lock`
 * takes them without applying, and `/terragucci unlock` releases them. GitLab
 * applies before merge from a pipeline of the default branch instead
 * (comment-apply-gitlab.ts): its merge request pipelines come from the merge
 * request itself.
 *
 * The comment is untrusted input, read from the event file and parsed by the
 * one grammar in comment.ts. What leaves this file for the pipeline's shell is
 * a pull request number, a commit sha and a wave number, each checked against
 * a pattern with no shell syntax in it.
 *
 * Refused, with a reply, before any credential is asked for: a commenter
 * without write access, a pull request from a fork, one merged into another
 * branch, one closed without merging, an open one unless `apply.when` is
 * pull-request, a merge commit the default branch no longer reaches, one a
 * later apply superseded (the reply names that run), a wave the repo does not
 * have, and any other text.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
import { applyWaves } from "./apply";
import { apiOf, BRANCH, LOGIN, parseComment, parseOptions, SHA, type CommentDecision } from "./comment";
import { APPLY_REQUIRES, ConfigError, type ApplyRequire, type ApplyWhen } from "./config";
import { rootDependencies } from "./detect";
import type { Fetch } from "./forge";
import { describeHeld, releaseLocks, takeLocks } from "./locks";
import { literalDependencies } from "./terragrunt";

/** What the apply job does next: apply from the merge commit (`go`), or stop with a reason. */
export interface ApplyCommentDecision extends Omit<CommentDecision, "root"> {
  /** The last wave to run, when the comment named one. */
  wave?: number;
  /** Set when the pull request is open and applies from its head (`apply.when: pull-request`). */
  open?: boolean;
}

/** Permissions that may ask for an apply: the same as may push to the repo. */
export const MAY_APPLY = new Set(["admin", "owner", "maintain", "write"]);

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
  /** `apply.when`. With `pull-request` an open pull request applies from its head. Default `merge`. */
  when?: ApplyWhen;
  /** The job's checkout, where the root locks are read and pushed. Default: the working directory. */
  repo?: string;
  /** `apply.requires`: what an open pull request needs before it applies. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  /** How the decision waits between reads of a pull request the forge has not finished checking. Default: a timer. */
  wait?: (ms: number) => Promise<void>;
  /** A Terragrunt repo: the layers are its waves of units, and the locks are on the units a pull request reaches (reachedUnits). */
  terragrunt?: boolean;
  /** The decision made again once the apply lock is held (Forgejo): it does not repeat the note on a lock of every unit. */
  again?: boolean;
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
  const parsed = parseComment(event.comment?.body, parseOptions(env));
  // A plan comment, or one not addressed to terragucci, belongs to the replan job.
  if (!parsed || parsed.kind === "plan" || parsed.kind === "agent") return stop("the comment does not ask for an apply");
  const prMode = o.when === "pull-request";
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
  if (parsed.kind === "unlock") {
    if (!prMode) return refuse("this repository applies after merge, so no pull request holds a lock and there is nothing to unlock");
    let released: string[];
    try {
      released = releaseLocks(o.repo ?? process.cwd(), number);
    } catch (e) {
      return broke(`could not release the locks of pull request ${number} (${(e as Error).message})`);
    }
    const text = released.length ? `released the locks pull request ${number} held on ${released.map((r) => `\`${r}\``).join(", ")}, for ${user}` : `pull request ${number} holds no lock`;
    await reply(text);
    return stop(text);
  }
  if (parsed.kind === "lock") {
    if (!prMode) return refuse("this repository applies after merge, so pull requests take no locks");
    let pr: any;
    try {
      pr = await call("GET", `repos/${repo}/pulls/${number}`);
    } catch (e) {
      return broke(`could not read pull request ${number} (${(e as Error).message})`);
    }
    return decideLock({ ...o, git, number, user, pr, base: event.repository?.default_branch, call, refuse, broke, reply });
  }

  const waves = applyWaves(o.layers, o.canary).length;
  if (parsed.wave !== undefined && parsed.wave > waves) return refuse(`this repository applies in ${waves} wave${waves === 1 ? "" : "s"}, so there is no wave-${parsed.wave}`);

  let pr: any;
  try {
    pr = await call("GET", `repos/${repo}/pulls/${number}`);
  } catch (e) {
    return broke(`could not read pull request ${number} (${(e as Error).message})`);
  }
  if (prMode && pr?.state === "open" && pr?.merged !== true) {
    return decideOpen({ ...o, git, number, user, pr, base: event.repository?.default_branch, wave: parsed.wave, call, refuse, broke, reply });
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


/** The statuses that never hold back an apply: the apply's own. */
const OWN_CONTEXTS = new Set([APPLY_CONTEXT]);
/** The status the plan job posts on the head it planned. */
const PLAN_CONTEXT = "terragucci/plan";

const validBranch = (b: unknown): b is string => typeof b === "string" && BRANCH.test(b) && !b.split("/").some((s) => s === ".." || s === "") && !b.endsWith(".lock");

/**
 * The roots a change from `from` to `to` reaches: the roots whose files it
 * changes (chant's path rules, as the plan stage reads them), and every root
 * that reads the state of one of those, followed through. Every root when
 * git cannot diff the range.
 */
export function reachedRoots(repo: string, git: Git, from: string, to: string, layers: string[][]): string[] {
  const all = layers.flat();
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return [...all].sort();
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const selected = new Set(changedRoots(repo, Object.fromEntries(all.map((r) => [r, { dir: r }])), files));
  const deps = rootDependencies(repo, all);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [root, reads] of deps) {
      if (!selected.has(root) && [...reads].some((d) => selected.has(d))) {
        selected.add(root);
        grew = true;
      }
    }
  }
  return [...selected].filter((r) => all.includes(r)).sort();
}

/** Changed files that reach no unit: documentation. */
const READS_NOTHING = /\.md$/i;

/**
 * The Terragrunt units a change from `from` to `to` reaches, read from git
 * alone. No Terragrunt runs: the files are the pull request's, and a lock can
 * come before anyone reviewed them. A unit is reached when a file under its
 * directory changes, and so is every unit that names a reached one in a
 * `dependency` or `dependencies` block with a plain path, at either end of
 * the range, followed through. A changed file under no unit's directory
 * (`root.hcl`, a module, a stack template) may change any unit, so it reaches
 * every unit, and so does a range git cannot diff; `every` then says why.
 * Markdown files reach nothing.
 */
export function reachedUnits(git: Git, from: string, to: string, layers: string[][]): { units: string[]; every?: string } {
  const all = [...new Set(layers.flat())].sort();
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return { units: all, every: "git could not list the files it changes" };
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter((f) => f && !READS_NOTHING.test(f));
  // The deepest unit holding a file is the one it belongs to.
  const deepest = [...all].sort((a, b) => b.length - a.length);
  const selected = new Set<string>();
  for (const f of files) {
    const u = deepest.find((d) => f.startsWith(`${d}/`));
    if (!u) return { units: all, every: `it changes \`${f}\`, which is in no unit's directory` };
    selected.add(u);
  }
  const reads = new Map<string, Set<string>>();
  for (const u of all) {
    const deps = new Set<string>();
    for (const ref of [from, to]) {
      const shown = git(["show", `${ref}:${u}/terragrunt.hcl`]);
      if (shown.status !== 0) continue;
      for (const p of literalDependencies(shown.stdout)) deps.add(posix.normalize(posix.join(u, p)).replace(/\/+$/, ""));
    }
    reads.set(u, deps);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [u, deps] of reads) {
      if (!selected.has(u) && [...deps].some((d) => selected.has(d))) {
        selected.add(u);
        grew = true;
      }
    }
  }
  return { units: [...selected].sort() };
}

/** One review as GitHub and Forgejo list them. */
export interface Review {
  user?: { login?: string };
  state?: string;
  commit_id?: string;
  dismissed?: boolean;
  official?: boolean;
}

/**
 * The users the run's own token acts as on GitHub and Forgejo. A review by one
 * of them is the pipeline's, never a reviewer's, so it never counts.
 */
export const TOKEN_USERS: ReadonlySet<string> = new Set(["github-actions[bot]", "gitea-actions", "forgejo-actions"]);

/**
 * Whether the head has an approval, by the forge's reviews: each reviewer's
 * latest review counts, the author's never does, and an approval counts only
 * on the commit it was given on, so a push after the review needs a fresh
 * one. A reviewer whose latest review asks for changes holds the apply back.
 * On GitHub an approver needs write access; on Forgejo the review is
 * official, which says the same. A review by the run's own token (TOKEN_USERS)
 * never counts.
 */
export async function approvalOf(reviews: Review[], author: string | undefined, head: string, mayWrite: (login: string) => Promise<boolean>): Promise<{ by: string[]; changes: string[] }> {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    const login = r?.user?.login;
    if (typeof login !== "string" || login === author || TOKEN_USERS.has(login) || r.dismissed === true) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "REQUEST_CHANGES") latest.set(login, r);
  }
  const by: string[] = [];
  const changes: string[] = [];
  for (const [login, r] of latest) {
    if (r.state !== "APPROVED") changes.push(login);
    else if (r.commit_id === head && r.official !== false && (await mayWrite(login))) by.push(login);
  }
  return { by: by.sort(), changes: changes.sort() };
}

interface OpenInput extends ApplyCommentOptions {
  git: Git;
  number: number;
  user: string;
  pr: any;
  base: unknown;
  wave?: number;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
  refuse: (reason: string) => Promise<ApplyCommentDecision>;
  broke: (reason: string) => ApplyCommentDecision;
  reply: (text: string) => Promise<void>;
}

/** An open pull request's head, read and fetched: the head commit and branch, the default branch, and the remote ref it was fetched to. */
interface OpenHead {
  sha: string;
  base: string;
  remote: string;
  repoName: string;
}

/**
 * What an apply and a lock both check first on an open pull request: it is
 * this repository's, it targets the default branch, and its head is a commit
 * on a branch whose name passes; then both are fetched, and the head must
 * still be the commit the forge named.
 */
async function openHead(i: OpenInput): Promise<OpenHead | ApplyCommentDecision> {
  const { git, number, pr, refuse, broke } = i;
  const repoName = apiOf(i.env ?? process.env).repo;
  if (pr?.state !== "open" || pr?.merged === true) return refuse(`pull request ${number} is not open, so nothing of it is locked`);
  if (pr?.head?.repo?.full_name !== repoName) return refuse("a pull request from a fork is never applied: its code would run with this repository's apply credentials");
  const base = i.base;
  if (!validBranch(base)) return broke("the event names no default branch this command passes on");
  if (pr?.base?.ref !== base) return refuse(`pull request ${number} targets ${String(pr?.base?.ref)}, not the default branch ${base}, so it is not applied`);
  const sha = pr?.head?.sha;
  const headRef = pr?.head?.ref;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke(`pull request ${number}'s head is not a commit`);
  if (!validBranch(headRef)) return broke(`pull request ${number}'s head branch has a name this command does not pass on`);
  const remote = `refs/remotes/origin/${base}`;
  const headRemote = "refs/remotes/terragucci/pull-request-head";
  const fetched = git(["fetch", "-q", "origin", `+refs/heads/${base}:${remote}`, `+refs/heads/${headRef}:${headRemote}`]);
  if (fetched.status !== 0) return broke(`could not fetch ${base} and ${headRef} (${fetched.stderr.trim()})`);
  const now = git(["rev-parse", headRemote]).stdout.trim();
  if (now !== sha) return refuse(`pull request ${number} moved while this comment was read (its head is now ${short(now)}); comment again once its checks pass`);
  return { sha, base, remote, repoName };
}

/**
 * Take the locks of the roots (in a Terragrunt repo, the units) a pull
 * request reaches. A refusal names every root another open pull request
 * holds. `every` is set when a Terragrunt change locks every unit, and says why.
 */
async function lockRoots(i: OpenInput, h: OpenHead, how: "apply" | "lock"): Promise<{ roots: string[]; every?: string } | ApplyCommentDecision> {
  const repo = i.repo ?? process.cwd();
  const reach = i.terragrunt ? reachedUnits(i.git, h.remote, h.sha, i.layers) : { units: reachedRoots(repo, i.git, h.remote, h.sha, i.layers) };
  const roots = reach.units;
  let locked;
  try {
    locked = await takeLocks(repo, roots, { pr: i.number, by: i.user, at: new Date().toISOString(), head: h.sha, ...(how === "lock" ? { via: "lock" as const } : {}) }, async (n) => {
      const other = await i.call("GET", `repos/${h.repoName}/pulls/${n}`);
      return other?.state === "open";
    });
  } catch (e) {
    return i.broke(`could not take the root locks (${(e as Error).message})`);
  }
  if (!locked.ok) {
    const what = how === "lock" ? "locked" : "applied";
    return i.refuse(`${describeHeld(locked.held)}, so pull request ${i.number} is not ${what}. It ${how === "lock" ? "locks" : "applies"} once that pull request merges or closes, or someone with write access comments \`/terragucci unlock\` on it`);
  }
  return { roots, ...(reach.every ? { every: reach.every } : {}) };
}

/** The reply's words for a Terragrunt change that locks every unit. */
const everyUnit = (number: number, why: string): string => `pull request ${number} locks every unit: ${why}`;

const isDecision = (x: object): x is ApplyCommentDecision => "go" in x;

/** `/terragucci lock` on an open pull request under `apply.when: pull-request`: lock the roots it reaches, apply nothing. */
async function decideLock(i: OpenInput): Promise<ApplyCommentDecision> {
  const h = await openHead(i);
  if (isDecision(h)) return h;
  const l = await lockRoots(i, h, "lock");
  if (isDecision(l)) return l;
  const text = l.roots.length
    ? `${l.every ? `${everyUnit(i.number, l.every)}. ` : ""}locked ${l.roots.map((r) => `\`${r}\``).join(", ")} for pull request ${i.number} at ${short(h.sha)}, for ${i.user}; nothing was applied. The locks hold until it merges or closes, or someone with write access comments \`/terragucci unlock\``
    : `pull request ${i.number} reaches no ${i.terragrunt ? "unit" : "root"}, so nothing is locked`;
  await i.reply(text);
  return { go: false, reason: text };
}

// ── locks: plan, the pr-lock job ─────────────────────────────────────────

/** The status the pr-lock job posts on the head it locked, or could not lock. */
export const LOCK_CONTEXT = "terragucci/lock";

/**
 * `terragucci pr-lock`, the decision of the `pr-lock` job under `locks:
 * plan`. The job runs the default branch's workflow on `pull_request_target`
 * and on comments, and checks out none of the pull request's code: it reads
 * the change's diff, and its `terragrunt.hcl` files in a Terragrunt repo, as
 * data from git (reachedRoots, reachedUnits).
 *
 * A pull request of this repository that is opened, reopened or pushed to,
 * or that a writer comments `/terragucci plan` on, takes the locks of the
 * roots its head reaches, as a plan lock, and drops its plan locks on roots
 * the head no longer reaches. It posts `terragucci/lock` on the head:
 * success naming what it holds, or failure, with a reply naming each root
 * another open pull request holds and the hint to plan again once that one
 * merges, closes or is unlocked. A closed pull request, merged or not,
 * releases its locks. Under `apply.when: merge` the job also reads
 * `/terragucci lock` (the same as a plan) and `/terragucci unlock`; under
 * `pull-request` those are the apply-comment job's. A fork's pull request
 * takes no lock.
 */
export async function decidePlanLock(o: ApplyCommentOptions): Promise<ApplyCommentDecision> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const git: Git = o.git ?? ((args) => spawnSync("git", args, { encoding: "utf-8" }) as ReturnType<Git>);
  const repoDir = o.repo ?? process.cwd();
  const stop = (reason: string): ApplyCommentDecision => ({ go: false, reason });
  const broke = (reason: string): ApplyCommentDecision => ({ go: false, fail: true, reason });
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return broke("pr-lock reads the event file; GITHUB_EVENT_PATH is not set");
  let event: any;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (e) {
    return broke(`could not read the event file ${eventPath} (${(e as Error).message})`);
  }
  if (event === null || typeof event !== "object") return broke(`the event file ${eventPath} is not a JSON object`);
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
  const replyOn = (number: number) => async (text: string): Promise<void> => {
    try {
      await call("POST", `repos/${repo}/issues/${number}/comments`, { body: `terragucci: ${text}` });
    } catch (e) {
      console.error(`terragucci: could not reply: ${(e as Error).message}`);
    }
  };
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const status = async (sha: string, state: "success" | "failure", description: string): Promise<void> => {
    try {
      await call("POST", `repos/${repo}/statuses/${sha}`, { state, context: LOCK_CONTEXT, description: description.length > 140 ? `${description.slice(0, 137)}...` : description, ...(runUrl ? { target_url: runUrl } : {}) });
    } catch (e) {
      console.error(`terragucci: could not post ${LOCK_CONTEXT}: ${(e as Error).message}`);
    }
  };
  const base = event.repository?.default_branch;
  const what = o.terragrunt ? "unit" : "root";

  /** Lock what the head of an open pull request of this repository reaches, as a plan lock. */
  const lockHead = async (pr: any, number: number, reply: (text: string) => Promise<void>): Promise<ApplyCommentDecision> => {
    if (pr?.state !== "open" || pr?.merged === true) return stop(`pull request ${number} is not open, so it takes no lock`);
    if (pr?.head?.repo?.full_name !== repo) return stop(`pull request ${number} comes from a fork, so it takes no lock`);
    if (!validBranch(base)) return broke("the event names no default branch this command passes on");
    if (pr?.base?.ref !== base) return stop(`pull request ${number} targets ${String(pr?.base?.ref)}, not ${base}, so it takes no lock`);
    const sha = pr?.head?.sha;
    const headRef = pr?.head?.ref;
    if (typeof sha !== "string" || !SHA.test(sha)) return broke(`pull request ${number}'s head is not a commit`);
    if (!validBranch(headRef)) return broke(`pull request ${number}'s head branch has a name this command does not pass on`);
    const remote = `refs/remotes/origin/${base}`;
    const headRemote = "refs/remotes/terragucci/pull-request-head";
    const fetched = git(["fetch", "-q", "origin", `+refs/heads/${base}:${remote}`, `+refs/heads/${headRef}:${headRemote}`]);
    if (fetched.status !== 0) return broke(`could not fetch ${base} and ${headRef} (${fetched.stderr.trim()})`);
    // A head that moved since the event is the next event's to lock.
    if (git(["rev-parse", headRemote]).stdout.trim() !== sha) return stop(`pull request ${number} moved since this event; its next run locks the new head`);
    const reach = o.terragrunt ? reachedUnits(git, remote, sha, o.layers) : { units: reachedRoots(repoDir, git, remote, sha, o.layers) };
    const author = typeof pr?.user?.login === "string" && LOGIN.test(pr.user.login) ? pr.user.login : "its author";
    let locked;
    try {
      locked = await takeLocks(repoDir, reach.units, { pr: number, by: author, at: new Date().toISOString(), head: sha, stage: "plan" }, async (n) => (await call("GET", `repos/${repo}/pulls/${n}`))?.state === "open", { release: true });
    } catch (e) {
      return broke(`could not take the ${what} locks (${(e as Error).message})`);
    }
    if (!locked.ok) {
      const text = `${describeHeld(locked.held)}, so pull request ${number} is not locked. Comment \`/terragucci plan\` on it once that pull request merges or closes, or someone with write access comments \`/terragucci unlock\` on it`;
      await status(sha, "failure", `locked by pull request ${[...new Set(locked.held.map((h) => h.pr))].join(", ")}: ${locked.held.map((h) => h.root).join(", ")}`);
      await reply(text);
      return stop(text);
    }
    const holds = locked.taken.length ? `holds ${locked.taken.join(", ")}` : `reaches no ${what}`;
    await status(sha, "success", reach.every ? `${holds}: every ${what}` : holds);
    const freed = locked.released?.length ? `; released ${locked.released.join(", ")}, which its head no longer reaches` : "";
    return stop(`pull request ${number} at ${short(sha)} ${holds}${freed}${reach.every ? ` (${everyUnit(number, reach.every)})` : ""}`);
  };

  if (event.pull_request && typeof event.pull_request === "object") {
    const number = event.pull_request.number ?? event.number;
    if (!Number.isInteger(number) || number < 1) return stop("the event has no pull request number");
    if (event.action === "closed") {
      let released: string[];
      try {
        released = releaseLocks(repoDir, number);
      } catch (e) {
        return broke(`could not release the locks of pull request ${number} (${(e as Error).message})`);
      }
      return stop(released.length ? `pull request ${number} closed, so its locks on ${released.join(", ")} are released` : `pull request ${number} closed and held no lock`);
    }
    if (!["opened", "reopened", "synchronize"].includes(event.action)) return stop(`a pull request ${String(event.action)} event takes no lock`);
    return lockHead(event.pull_request, number, replyOn(number));
  }

  if (event.action !== "created") return stop("not a new comment");
  const parsed = parseComment(event.comment?.body, parseOptions(env));
  const prMode = o.when === "pull-request";
  // Under apply.when: pull-request the apply-comment job holds /terragucci lock and unlock.
  if (!parsed || !(parsed.kind === "plan" || (!prMode && (parsed.kind === "lock" || parsed.kind === "unlock")))) return stop("another job reads this comment");
  const number = event.issue?.number;
  if (!Number.isInteger(number) || number < 1) return stop("the comment has no issue number");
  if (!event.issue?.pull_request && event.issue?.is_pull !== true) return stop("the comment is not on a pull request");
  const user = event.comment?.user?.login;
  if (typeof user !== "string" || !LOGIN.test(user)) return stop("the comment has no usable author");
  const reply = replyOn(number);
  // Only a writer moves a lock; a plan comment from anyone else is the replan job's to ignore.
  if (o.forge === "forgejo") {
    if (event.repository?.full_name !== repo) return stop("the event is not for this repository");
    if (event.sender?.login !== user) return stop("the comment's author is not the event's sender");
    const p = event.repository?.permissions;
    if (p?.push !== true && p?.admin !== true) return stop(`${user} has no write access, so no lock moves`);
  } else {
    let permission: unknown;
    try {
      permission = (await call("GET", `repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`))?.permission;
    } catch (e) {
      return broke(`could not read ${user}'s permission, so no lock moves (${(e as Error).message})`);
    }
    if (typeof permission !== "string" || !MAY_APPLY.has(permission)) return stop(`${user} has no write access, so no lock moves`);
  }
  if (parsed.kind === "unlock") {
    let released: string[];
    try {
      released = releaseLocks(repoDir, number);
    } catch (e) {
      return broke(`could not release the locks of pull request ${number} (${(e as Error).message})`);
    }
    const text = released.length ? `released the locks pull request ${number} held on ${released.map((r) => `\`${r}\``).join(", ")}, for ${user}` : `pull request ${number} holds no lock`;
    await reply(text);
    return stop(text);
  }
  let pr: any;
  try {
    pr = await call("GET", `repos/${repo}/pulls/${number}`);
  } catch (e) {
    return broke(`could not read pull request ${number} (${(e as Error).message})`);
  }
  return lockHead(pr, number, reply);
}

/** How many times a pull request the forge has not finished checking is read again, and how long between reads. */
const MERGEABLE_READS = 5;
const MERGEABLE_WAIT_MS = 3000;

/**
 * Whether the forge says the pull request can merge. GitHub answers
 * `mergeable: null` while it works it out, and Forgejo `false` while it
 * checks for conflicts, so a pull request that is not mergeable is read again
 * a few times before it is refused. On GitHub `mergeable_state: blocked` is
 * branch protection holding the merge; `behind` and `unstable` are left to
 * `undiverged` and `checks`.
 */
async function mergeableOf(i: OpenInput, h: OpenHead): Promise<ApplyCommentDecision | undefined> {
  const wait = i.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pr = i.pr;
  for (let read = 1; pr?.mergeable !== true && read < MERGEABLE_READS; read++) {
    await wait(MERGEABLE_WAIT_MS);
    try {
      pr = await i.call("GET", `repos/${h.repoName}/pulls/${i.number}`);
    } catch (e) {
      return i.broke(`could not read pull request ${i.number} (${(e as Error).message})`);
    }
    if (pr?.head?.sha !== h.sha) return i.refuse(`pull request ${i.number} moved while this comment was read (its head is now ${short(String(pr?.head?.sha))}); comment again once its checks pass`);
  }
  if (pr?.mergeable === false || pr?.mergeable_state === "dirty") return i.refuse(`pull request ${i.number} is not mergeable: the forge reports conflicts with ${h.base}, so nothing is applied. Resolve them, and comment again once its plan passes`);
  if (pr?.mergeable !== true) return i.refuse(`the forge has not worked out whether pull request ${i.number} can merge, so nothing is applied; comment again in a minute`);
  if (i.forge !== "forgejo" && pr?.mergeable_state === "blocked") return i.refuse(`pull request ${i.number} is not mergeable: branch protection on ${h.base} blocks its merge, so nothing is applied`);
  return undefined;
}

/** An open pull request under `apply.when: pull-request`: every requirement, then its locks. */
async function decideOpen(i: OpenInput): Promise<ApplyCommentDecision> {
  const { git, number, user, pr, call, refuse, broke } = i;
  const requires = new Set<ApplyRequire>(i.requires ?? APPLY_REQUIRES);
  const h = await openHead(i);
  if (isDecision(h)) return h;
  const { sha, base, remote, repoName } = h;

  // approved: an approval of this head, and nobody asking for changes.
  if (requires.has("approved")) {
    let reviews: Review[];
    try {
      reviews = await call("GET", `repos/${repoName}/pulls/${number}/reviews?per_page=100&limit=50`);
    } catch (e) {
      return broke(`could not read the reviews of pull request ${number} (${(e as Error).message})`);
    }
    const mayWrite = async (login: string): Promise<boolean> => {
      if (i.forge === "forgejo") return true;
      try {
        const p = (await call("GET", `repos/${repoName}/collaborators/${encodeURIComponent(login)}/permission`))?.permission;
        return typeof p === "string" && MAY_APPLY.has(p);
      } catch {
        return false;
      }
    };
    const approval = await approvalOf(Array.isArray(reviews) ? reviews : [], pr?.user?.login, sha, mayWrite);
    if (approval.changes.length > 0) return refuse(`pull request ${number} is not approved: ${approval.changes.join(", ")} asked for changes, so nothing is applied`);
    if (approval.by.length === 0) return refuse(`pull request ${number} is not approved: no reviewer other than its author approved its head ${short(sha)}, so nothing is applied`);
  }

  // checks: every status and check on the head passed. The plan's own status counts whatever requires says.
  let combined: any;
  try {
    combined = await call("GET", `repos/${repoName}/commits/${sha}/status`);
  } catch (e) {
    return broke(`could not read the statuses of ${short(sha)} (${(e as Error).message})`);
  }
  const byContext = new Map<string, any>();
  for (const st of Array.isArray(combined?.statuses) ? combined.statuses : []) {
    if (typeof st?.context !== "string" || OWN_CONTEXTS.has(st.context)) continue;
    const had = byContext.get(st.context);
    if (!had || Number(st.id) > Number(had.id)) byContext.set(st.context, st);
  }
  const state = (st: any): string => String(st?.state ?? st?.status ?? "");
  if (requires.has("checks")) {
    const failing: string[] = [];
    const waiting: string[] = [];
    for (const [context, st] of byContext) {
      if (state(st) === "failure" || state(st) === "error") failing.push(context);
      else if (state(st) === "pending") waiting.push(context);
    }
    if (i.forge !== "forgejo") {
      let runs: any;
      try {
        runs = await call("GET", `repos/${repoName}/commits/${sha}/check-runs?per_page=100`);
      } catch (e) {
        return broke(`could not read the checks of ${short(sha)} (${(e as Error).message})`);
      }
      for (const run of Array.isArray(runs?.check_runs) ? runs.check_runs : []) {
        const name = String(run?.name ?? "a check");
        if (run?.status !== "completed") waiting.push(name);
        else if (!["success", "neutral", "skipped"].includes(run?.conclusion)) failing.push(name);
      }
    }
    if (failing.length > 0) return refuse(`the checks of pull request ${number} are not green: ${[...new Set(failing)].sort().join(", ")} failed on ${short(sha)}, so nothing is applied`);
    if (waiting.length > 0) return refuse(`the checks of pull request ${number} are not green yet: ${[...new Set(waiting)].sort().join(", ")} still running on ${short(sha)}; comment again once they pass`);
  }
  if (state(byContext.get(PLAN_CONTEXT)) !== "success") return refuse(`the plan of pull request ${number} has not passed on its head ${short(sha)}, so nothing is applied; push to it or comment \`/terragucci plan\`, then comment again`);

  // mergeable: the forge says it merges as it stands.
  if (requires.has("mergeable")) {
    const no = await mergeableOf(i, h);
    if (no) return no;
  }

  // undiverged: the head contains the default branch as origin has it now.
  if (requires.has("undiverged")) {
    const tip = git(["rev-parse", remote]).stdout.trim();
    const upToDate = git(["merge-base", "--is-ancestor", remote, sha]);
    if (upToDate.status === 1) return refuse(`pull request ${number} is not up to date with ${base}: its head ${short(sha)} does not contain ${short(tip)}. Merge ${base} into it or rebase it, and comment again once its plan passes`);
    if (upToDate.status !== 0) return broke(`could not tell whether ${short(sha)} contains ${base} (${upToDate.stderr.trim()})`);
  }

  // The comment's job runs the default branch's pipeline, so a change to it applies after it merges.
  const pipeline = PIPELINE_FILES[i.forge ?? "github"];
  const touched = git(["diff", "--name-only", `${remote}...${sha}`, "--", pipeline]);
  if (touched.status === 0 && touched.stdout.trim()) {
    return refuse(`pull request ${number} changes ${pipeline}, and the apply runs the pipeline of ${base}, so it is not applied before merge. Merge it, then comment \`/terragucci apply\` on it to apply from the merge commit`);
  }

  // No other open pull request holds a root this one reaches.
  const l = await lockRoots(i, h, "apply");
  if (isDecision(l)) return l;
  // The apply's own reply comes at the end of its run; a lock on every unit is said before it starts.
  if (l.every && !i.again) await i.reply(`${everyUnit(number, l.every)}. Applying its head ${short(sha)}`);

  const through = i.wave !== undefined ? ` through wave ${i.wave}` : "";
  const what = l.roots.length ? `, locking ${l.roots.join(", ")}` : "";
  return { go: true, open: true, reason: `apply pull request ${number}'s head ${short(sha)}${through} for ${user}${what}`, pr: number, sha, base, ...(i.wave !== undefined ? { wave: i.wave } : {}) };
}

/** The generated pipeline's path on each forge (render.ts's PIPELINE_PATHS). */
const PIPELINE_FILES: Record<"github" | "forgejo", string> = {
  github: ".github/workflows/terragucci.yml",
  forgejo: ".forgejo/workflows/terragucci.yml",
};

// ── the merge after the last wave ────────────────────────────────────────

export interface MergeOptions {
  pr: number;
  sha: string;
  forge?: "github" | "forgejo";
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  repo?: string;
}

/**
 * Merge a pull request whose every wave applied from its head
 * (`apply.merge: auto`), then release its locks. The `pr-merge` job runs it
 * with a sha a job that ran the pull request's code handed on, so before the
 * merge it checks, with the job's own token, that the pull request is open,
 * its head is still `sha`, and a reviewer other than its author approved
 * that head, as the apply's decision did; the forge then merges only while
 * the head is `sha`. It merges with TG_MERGE_TOKEN (apply.merge_token_env's
 * secret) when the job has it, else with TG_TOKEN. Returns what to reply;
 * throws with the reason when it does not merge.
 */
export async function mergePullRequest(o: MergeOptions): Promise<string> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  if (!SHA.test(o.sha)) throw new ConfigError("--sha must be a commit sha");
  const { api, repo } = apiOf(env);
  const read = env.TG_TOKEN;
  // apply.merge_token_env's secret, when set: Forgejo refuses a merge made with the job's own token.
  const token = env.TG_MERGE_TOKEN || read;
  if (!token || !read) throw new ConfigError("pr-merge needs TG_TOKEN in the environment");
  const get = async (path: string): Promise<any> => {
    const r = await doFetch(`${api}/repos/${repo}/${path}`, { method: "GET", headers: { "content-type": "application/json", authorization: `token ${read}` } });
    if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
    return r.json();
  };
  const pr = await get(`pulls/${o.pr}`);
  if (pr?.state !== "open" || pr?.merged === true) throw new Error(`pull request ${o.pr} is not open`);
  if (pr?.head?.sha !== o.sha) throw new Error(`pull request ${o.pr} moved after it applied (its head is now ${short(String(pr?.head?.sha))})`);
  if (pr?.head?.repo?.full_name !== repo) throw new Error(`pull request ${o.pr} comes from a fork`);
  const reviews = await get(`pulls/${o.pr}/reviews?per_page=100&limit=50`);
  const mayWrite = async (login: string): Promise<boolean> => {
    if (o.forge === "forgejo") return true;
    try {
      const p = (await get(`collaborators/${encodeURIComponent(login)}/permission`))?.permission;
      return typeof p === "string" && MAY_APPLY.has(p);
    } catch {
      return false;
    }
  };
  const approval = await approvalOf(Array.isArray(reviews) ? reviews : [], pr?.user?.login, o.sha, mayWrite);
  if (approval.changes.length > 0 || approval.by.length === 0) throw new Error(`no reviewer other than its author approved its head ${short(o.sha)}`);
  const [url, method, body] = o.forge === "forgejo"
    ? [`${api}/repos/${repo}/pulls/${o.pr}/merge`, "POST", { Do: "merge", head_commit_id: o.sha }]
    : [`${api}/repos/${repo}/pulls/${o.pr}/merge`, "PUT", { sha: o.sha, merge_method: "merge" }];
  const r = await doFetch(url, {
    method,
    headers: { "content-type": "application/json", authorization: `token ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`the forge refused the merge (${method} answered ${r.status}${await refusal(r)})`);
  const released = releaseLocks(o.repo ?? process.cwd(), o.pr);
  return `merged pull request ${o.pr} at ${short(o.sha)}${released.length ? ` and released its locks on ${released.join(", ")}` : ""}`;
}

/** The forge's own words for a refused merge, as ": <message>", or nothing when its answer has none. */
async function refusal(r: { text(): Promise<string> }): Promise<string> {
  let said = "";
  try {
    const raw = await r.text();
    try {
      const m = (JSON.parse(raw) as { message?: unknown })?.message;
      said = typeof m === "string" ? m : raw;
    } catch {
      said = raw;
    }
  } catch {
    return "";
  }
  said = said.replace(/\s+/g, " ").trim().slice(0, 300);
  return said ? `: ${said}` : "";
}
