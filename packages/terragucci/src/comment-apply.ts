/**
 * `terragucci pr-lock` under `locks: plan`, and what a change reaches: the
 * roots (or Terragrunt units, Atmos instances) a pull request's diff
 * reaches (reachedRoots, reached), and who counts as an approver of it
 * (approverFilter).
 *
 * `/terragucci apply` is chant's comment job (terragucci issue 1411): on a
 * merged pull request it re-runs the waves' jobs of the merge commit, and
 * with `apply.when: pull-request` it decides an open pull request's head and
 * dispatches the waves for it (`@intentius/chant/op/before-merge-decide`).
 */
import { terragucciStatus } from "./ci-words";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { posix } from "node:path";
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
import { apiOf, BRANCH, LOGIN, parseComment, parseOptions, SHA, type CommentDecision } from "./comment";
import type { PrApproverFilter } from "@intentius/chant/pr-forge";
import type { ApplyRequire, ApplyWhen } from "./config";
import { atmosDependencies, atmosEdges, detectAtmos } from "./atmos";
import { rootOrder, type WavesAfter } from "./detect";
import type { Involved } from "./involved";
import type { OpenPullRequest } from "@intentius/chant/pr-forge";
import { jobReads, poster, type Fetch } from "./forge";
import { describeHeld, releaseRootLocks, takeRootLocks } from "./root-locks";
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
  /** `waves.after` of plain roots: a root it puts after a reached root is reached too. */
  after?: WavesAfter;
  /** A repo whose roots a command writes (`synth`, CDK Terrain's stacks): the locks are on every root a change can reach (reachedSynthesized). */
  synth?: boolean;
  /** The decision made again once the apply lock is held (Forgejo): it does not repeat the note on a lock of every unit. */
  again?: boolean;
}

const short = (sha: string): string => sha.slice(0, 8);


const validBranch = (b: unknown): b is string => typeof b === "string" && BRANCH.test(b) && !b.split("/").some((s) => s === ".." || s === "") && !b.endsWith(".lock");

/**
 * The roots a change from `from` to `to` reaches: the roots whose files it
 * changes (chant's path rules, as the plan stage reads them), and every root
 * that reads the state of one of those or that `waves.after` puts after one,
 * followed through. Every root when
 * git cannot diff the range.
 */
export function reachedRoots(repo: string, git: Git, from: string, to: string, layers: string[][], after?: WavesAfter): string[] {
  const all = layers.flat();
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return [...all].sort();
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const selected = new Set(changedRoots(repo, Object.fromEntries(all.map((r) => [r, { dir: r }])), files));
  const deps = rootOrder(repo, all, after);
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

/** What a pull request reaches and locks: its roots, units or instances, and why it is every one, when it is. */
export interface Reach {
  units: string[];
  every?: string;
  /** What the units are called in a reply. */
  kind: "root" | "unit" | "instance";
}

/**
 * The Atmos instances a change from `from` to `to` reaches, read from git and
 * from the instances `terragucci atmos write` left in the checkout. A changed
 * file under an instance's component directory reaches the instances of that
 * component. Any other file (a stack manifest, a catalog, `atmos.yaml`) can
 * change any instance's vars or backend, and no Atmos runs on a pull request's
 * files before a review, so it reaches every instance, and `every` says why.
 * Markdown files reach nothing. Instances that depend on a reached one follow.
 */
export function reachedInstances(repo: string, git: Git, from: string, to: string, layers: string[][], after?: WavesAfter): Reach {
  const all = [...new Set(layers.flat())].sort();
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return { units: all, every: "git could not list the files it changes", kind: "instance" };
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter((f) => f && !READS_NOTHING.test(f));
  const component = new Map(all.map((r) => [r, atmosEdges(join(repo, r))?.component?.replace(/\/+$/, "")]));
  const selected = new Set<string>();
  for (const f of files) {
    const owners = all.filter((r) => { const c = component.get(r); return c !== undefined && f.startsWith(`${c}/`); });
    if (owners.length === 0) return { units: all, every: `it changes \`${f}\`, which can change any Atmos instance`, kind: "instance" };
    for (const r of owners) selected.add(r);
  }
  const deps = rootOrder(repo, all, after);
  for (const [r, ups] of atmosDependencies(repo, all)) for (const u of ups) (deps.get(r) ?? deps.set(r, new Set()).get(r)!).add(u);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [root, reads] of deps) {
      if (!selected.has(root) && [...reads].some((d) => selected.has(d))) {
        selected.add(root);
        grew = true;
      }
    }
  }
  return { units: [...selected].sort(), kind: "instance" };
}

/**
 * The roots a change from `from` to `to` reaches in a repo whose roots a
 * command writes (`synth`, CDK Terrain's stacks). The roots are not in git,
 * so no diff names them, and the command is the pull request's own code,
 * which no lock runs before a review. So any changed file that is not
 * Markdown can change any root: it reaches every root, and `every` says why.
 */
export function reachedSynthesized(git: Git, from: string, to: string, layers: string[][]): Reach {
  const all = [...new Set(layers.flat())].sort();
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return { units: all, every: "git could not list the files it changes", kind: "root" };
  const file = diff.stdout.split("\n").map((l) => l.trim()).find((f) => f && !READS_NOTHING.test(f));
  if (file === undefined) return { units: [], kind: "root" };
  return { units: all, every: `it changes \`${file}\`, and the synth command writes every root from the repo's files`, kind: "root" };
}

/** The roots, units or instances a change reaches, by the repo's shape. */
export function reached(repo: string, git: Git, from: string, to: string, layers: string[][], o: { terragrunt?: boolean; after?: WavesAfter; synth?: boolean } = {}): Reach {
  if (o.terragrunt) return { ...reachedUnits(git, from, to, layers), kind: "unit" };
  if (detectAtmos(repo)) return reachedInstances(repo, git, from, to, layers, o.after);
  if (o.synth) return reachedSynthesized(git, from, to, layers);
  return { units: reachedRoots(repo, git, from, to, layers, o.after), kind: "root" };
}

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

/**
 * The users the run's own token acts as on GitHub and Forgejo. A review by one
 * of them is the pipeline's, never a reviewer's, so it never counts.
 */
export const TOKEN_USERS: ReadonlySet<string> = new Set(["github-actions[bot]", "gitea-actions", "forgejo-actions"]);

/**
 * Who counts for chant's `approved`: the forge's rule (on GitHub write
 * access, on Forgejo an official review, on GitLab Developer or more), and
 * never the run's own token (TOKEN_USERS) or someone with a hand in the
 * change (./involved.ts).
 */
export const approverFilter = (involved: Involved): PrApproverFilter => ({
  forgeRule: true,
  exclude: [...[...TOKEN_USERS].map((login) => ({ login, reason: `${login} is the pipeline's own token` })), ...involved.people.map((p) => ({ login: p.who, reason: p.why }))],
});

/** The reply's words for a change that locks every unit (Terragrunt) or instance (Atmos). */
const everyUnit = (number: number, why: string, kind: Reach["kind"] = "unit"): string => `pull request ${number} locks every ${kind}: ${why}`;

// ── locks: plan, the pr-lock job ─────────────────────────────────────────

/** The status the pr-lock job posts on the head it locked, or could not lock. */
export const LOCK_CONTEXT = (): string => terragucciStatus("lock");

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
  const forge = poster(o.forge ?? "github", env, doFetch);
  const replyOn = (number: number) => async (text: string): Promise<void> => {
    try {
      await forge.addComment(number, `terragucci: ${text}`);
    } catch (e) {
      console.error(`terragucci: could not reply: ${(e as Error).message}`);
    }
  };
  const status = async (sha: string, state: "success" | "failure", description: string): Promise<void> => {
    try {
      await forge.setStatus(sha, { state, context: LOCK_CONTEXT(), description: description.length > 140 ? `${description.slice(0, 137)}...` : description, ...(forge.runUrl ? { url: forge.runUrl } : {}) });
    } catch (e) {
      console.error(`terragucci: could not post ${LOCK_CONTEXT()}: ${(e as Error).message}`);
    }
  };
  const base = event.repository?.default_branch;
  const what = o.terragrunt ? "unit" : "root";

  /** Lock what the head of an open pull request of this repository reaches, as a plan lock. */
  const lockHead = async (pr: any, number: number, reply: (text: string) => Promise<void>, reread = false): Promise<ApplyCommentDecision> => {
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
    // A head that moved since the event is locked as the forge has it now: a push made with the job's own token,
    // such as the check job's format fix on GitHub, starts no run, so no later event would lock it.
    const now = git(["rev-parse", headRemote]).stdout.trim();
    if (now !== sha) {
      if (reread) return stop(`pull request ${number} moved again while it was read; its next run locks the new head`);
      // The forge can take a few seconds to move the pull request's head after the push.
      const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let fresh: any;
      for (let read = 1; read <= HEAD_READS; read++) {
        try {
          fresh = await call("GET", `repos/${repo}/pulls/${number}`);
        } catch (e) {
          return broke(`pull request ${number} moved since this event, and could not be read again (${(e as Error).message})`);
        }
        if (fresh?.head?.sha === now) return lockHead(fresh, number, reply, true);
        if (read < HEAD_READS) await wait(HEAD_WAIT_MS);
      }
      return stop(`pull request ${number} moved since this event; its next run locks the new head`);
    }
    const reach = reached(repoDir, git, remote, sha, o.layers, { ...(o.terragrunt ? { terragrunt: true } : {}), ...(o.after ? { after: o.after } : {}), ...(o.synth ? { synth: true } : {}) });
    const author = typeof pr?.user?.login === "string" && LOGIN.test(pr.user.login) ? pr.user.login : "its author";
    let locked;
    try {
      locked = await takeRootLocks(repoDir, reach.units, { pr: number, by: author, at: new Date().toISOString(), head: sha, stage: "plan" as const }, async (n) => (await call("GET", `repos/${repo}/pulls/${n}`))?.state === "open", { release: true });
    } catch (e) {
      return broke(`could not take the ${what} locks (${(e as Error).message})`);
    }
    if (!locked.ok) {
      const text = `${describeHeld(locked.held)}, so pull request ${number} is not locked. Comment \`/terragucci plan\` on it once that pull request merges or closes, or someone with write access comments \`/terragucci unlock\` on it`;
      await status(sha, "failure", `locked by pull request ${[...new Set(locked.held.map((h) => h.pr))].join(", ")}: ${locked.held.map((h) => h.target).join(", ")}`);
      await reply(text);
      return stop(text);
    }
    const holds = locked.taken.length ? `holds ${locked.taken.join(", ")}` : `reaches no ${what}`;
    await status(sha, "success", reach.every ? `${holds}: every ${reach.kind}` : holds);
    const freed = locked.released.length ? `; released ${locked.released.join(", ")}, which its head no longer reaches` : "";
    return stop(`pull request ${number} at ${short(sha)} ${holds}${freed}${reach.every ? ` (${everyUnit(number, reach.every, reach.kind)})` : ""}`);
  };

  // A push to a branch: the fmt job, once it has committed the formatting with the job's own token (a push that
  // starts no run), answers the lock of the branch's open pull request on its new head.
  if (typeof event.ref === "string" && event.ref.startsWith("refs/heads/") && !event.pull_request && !event.comment) {
    const branch = event.ref.slice("refs/heads/".length);
    let open: OpenPullRequest[];
    try {
      open = await jobReads(o.forge ?? "github", env, doFetch).openPullRequests();
    } catch (e) {
      return broke(`could not list the open pull requests (${(e as Error).message})`);
    }
    const from = open.filter((p) => p.head === branch && !p.fork);
    if (from.length === 0) return stop(`no open pull request comes from ${branch}`);
    const said: string[] = [];
    // lockHead reads a pull request as the event gives it.
    const asEvent = (p: OpenPullRequest) => ({ number: p.number, state: "open", head: { ref: p.head, sha: p.headSha, repo: { full_name: repo } }, base: { ref: p.base }, ...(p.author ? { user: { login: p.author } } : {}) });
    for (const p of from) said.push((await lockHead(asEvent(p), p.number, replyOn(p.number))).reason);
    return stop(said.join("; "));
  }

  if (event.pull_request && typeof event.pull_request === "object") {
    const number = event.pull_request.number ?? event.number;
    if (!Number.isInteger(number) || number < 1) return stop("the event has no pull request number");
    if (event.action === "closed") {
      let released: string[];
      try {
        released = await releaseRootLocks(repoDir, number);
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
      permission = await jobReads("github", env, doFetch).permission(user);
    } catch (e) {
      return broke(`could not read ${user}'s permission, so no lock moves (${(e as Error).message})`);
    }
    if (typeof permission !== "string" || !MAY_APPLY.has(permission)) return stop(`${user} has no write access, so no lock moves`);
  }
  if (parsed.kind === "unlock") {
    let released: string[];
    try {
      released = await releaseRootLocks(repoDir, number);
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

/** How many times pr-lock reads a pull request whose head moved since the event, and how long between reads. */
const HEAD_READS = 4;
const HEAD_WAIT_MS = 3000;

