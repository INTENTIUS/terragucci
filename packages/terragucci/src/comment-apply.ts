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
 * anything runs, each of these is checked and refused by name: the head has
 * an approval from a reviewer other than its author, given on that head; its
 * statuses and checks passed, `terragucci/plan` among them; it is up to date
 * with the default branch; it does not change the pipeline file, which the
 * comment's job runs from the default branch; and no other open pull request
 * holds a lock on a root it reaches (locks.ts). The decision then takes those
 * locks. `/terragucci unlock` releases them. GitLab has no apply before
 * merge: its merge request pipelines come from the merge request itself.
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
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
import { applyWaves } from "./apply";
import { apiOf, BRANCH, LOGIN, parseComment, SHA, type CommentDecision } from "./comment";
import { ConfigError, type ApplyWhen } from "./config";
import { rootDependencies } from "./detect";
import type { Fetch } from "./forge";
import { describeHeld, releaseLocks, takeLocks } from "./locks";

/** What the apply job does next: apply from the merge commit (`go`), or stop with a reason. */
export interface ApplyCommentDecision extends Omit<CommentDecision, "root"> {
  /** The last wave to run, when the comment named one. */
  wave?: number;
  /** Set when the pull request is open and applies from its head (`apply.when: pull-request`). */
  open?: boolean;
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
  /** `apply.when`. With `pull-request` an open pull request applies from its head. Default `merge`. */
  when?: ApplyWhen;
  /** The job's checkout, where the root locks are read and pushed. Default: the working directory. */
  repo?: string;
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

  const waves = applyWaves(o.layers, o.canary).length;
  if (parsed.wave !== undefined && parsed.wave > waves) return refuse(`this repository applies in ${waves} wave${waves === 1 ? "" : "s"}, so there is no wave-${parsed.wave}`);

  let pr: any;
  try {
    pr = await call("GET", `repos/${repo}/pulls/${number}`);
  } catch (e) {
    return broke(`could not read pull request ${number} (${(e as Error).message})`);
  }
  if (prMode && pr?.state === "open" && pr?.merged !== true) {
    return decideOpen({ ...o, git, number, user, pr, base: event.repository?.default_branch, wave: parsed.wave, call, refuse, broke });
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

/** One review as GitHub and Forgejo list them. */
interface Review {
  user?: { login?: string };
  state?: string;
  commit_id?: string;
  dismissed?: boolean;
  official?: boolean;
}

/**
 * Whether the head has an approval, by the forge's reviews: each reviewer's
 * latest review counts, the author's never does, and an approval counts only
 * on the commit it was given on, so a push after the review needs a fresh
 * one. A reviewer whose latest review asks for changes holds the apply back.
 * On GitHub an approver needs write access; on Forgejo the review is
 * official, which says the same.
 */
async function approvalOf(reviews: Review[], author: string | undefined, head: string, mayWrite: (login: string) => Promise<boolean>): Promise<{ by: string[]; changes: string[] }> {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    const login = r?.user?.login;
    if (typeof login !== "string" || login === author || r.dismissed === true) continue;
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
}

/** An open pull request under `apply.when: pull-request`: every precondition, then its locks. */
async function decideOpen(i: OpenInput): Promise<ApplyCommentDecision> {
  const { git, number, user, pr, call, refuse, broke } = i;
  const repoName = apiOf(i.env ?? process.env).repo;
  if (pr?.head?.repo?.full_name !== repoName) return refuse("a pull request from a fork is never applied: its code would run with this repository's apply credentials");
  const base = i.base;
  if (!validBranch(base)) return broke("the event names no default branch this command passes on");
  if (pr?.base?.ref !== base) return refuse(`pull request ${number} targets ${String(pr?.base?.ref)}, not the default branch ${base}, so it is not applied`);
  const sha = pr?.head?.sha;
  const headRef = pr?.head?.ref;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke(`pull request ${number}'s head is not a commit`);
  if (!validBranch(headRef)) return broke(`pull request ${number}'s head branch has a name this command does not pass on`);

  // Reviewed: an approval of this head, and nobody asking for changes.
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

  // Checks green: every status and check on the head passed, the plan's among them.
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
  if (state(byContext.get(PLAN_CONTEXT)) !== "success") return refuse(`the plan of pull request ${number} has not passed on its head ${short(sha)}, so nothing is applied; push to it or comment \`/terragucci plan\`, then comment again`);

  // Up to date: the head contains the default branch as origin has it now.
  const repo = i.repo ?? process.cwd();
  const remote = `refs/remotes/origin/${base}`;
  const headRemote = "refs/remotes/terragucci/pull-request-head";
  const fetched = git(["fetch", "-q", "origin", `+refs/heads/${base}:${remote}`, `+refs/heads/${headRef}:${headRemote}`]);
  if (fetched.status !== 0) return broke(`could not fetch ${base} and ${headRef} (${fetched.stderr.trim()})`);
  const now = git(["rev-parse", headRemote]).stdout.trim();
  if (now !== sha) return refuse(`pull request ${number} moved while this comment was read (its head is now ${short(now)}); comment again once its checks pass`);
  const tip = git(["rev-parse", remote]).stdout.trim();
  const upToDate = git(["merge-base", "--is-ancestor", remote, sha]);
  if (upToDate.status === 1) return refuse(`pull request ${number} is not up to date with ${base}: its head ${short(sha)} does not contain ${short(tip)}. Merge ${base} into it or rebase it, and comment again once its plan passes`);
  if (upToDate.status !== 0) return broke(`could not tell whether ${short(sha)} contains ${base} (${upToDate.stderr.trim()})`);

  // The comment's job runs the default branch's pipeline, so a change to it applies after it merges.
  const pipeline = PIPELINE_FILES[i.forge ?? "github"];
  const touched = git(["diff", "--name-only", `${remote}...${sha}`, "--", pipeline]);
  if (touched.status === 0 && touched.stdout.trim()) {
    return refuse(`pull request ${number} changes ${pipeline}, and the apply runs the pipeline of ${base}, so it is not applied before merge. Merge it, then comment \`/terragucci apply\` on it to apply from the merge commit`);
  }

  // No other open pull request holds a root this one reaches.
  const roots = reachedRoots(repo, git, remote, sha, i.layers);
  let locked;
  try {
    locked = await takeLocks(repo, roots, { pr: number, by: user, at: new Date().toISOString(), head: sha }, async (n) => {
      const other = await call("GET", `repos/${repoName}/pulls/${n}`);
      return other?.state === "open";
    });
  } catch (e) {
    return broke(`could not take the root locks (${(e as Error).message})`);
  }
  if (!locked.ok) return refuse(`${describeHeld(locked.held)}, so pull request ${number} is not applied. It applies once that pull request merges or closes, or someone with write access comments \`/terragucci unlock\` on it`);

  const through = i.wave !== undefined ? ` through wave ${i.wave}` : "";
  const what = roots.length ? `, locking ${roots.join(", ")}` : "";
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
