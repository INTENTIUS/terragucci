/**
 * Who had a hand in a change, so that their approval of it does not count.
 *
 * An approval counts only from someone outside the set of people behind the
 * plans a wave applies:
 *
 *   - the pull request's author
 *   - each author, co-author and committer of the commits on the head being
 *     applied, from git (the commits after the base the gate is judged at,
 *     merge commits left out) and, when the forge can be asked, from the pull
 *     request's own commits, which keep the logins a squash merge loses
 *   - each login a `Requested-by:` trailer names on those commits: the person
 *     whose `/terragucci agent` comment produced the commit, or who started
 *     the drift run whose agent made it
 *   - each login a `Pushed-by:` trailer names: the user the agent's token
 *     (`agent.token_env`) acts as, which the push job writes on its commit
 *   - the users the pipeline's token and the agent's token act as, read from
 *     the forge's `GET /user` with each token the job holds. A token the forge
 *     does not name a user for is said in the log and left unknown: its user
 *     is judged as anyone, never assumed to be one of the people above.
 *
 * Logins compare case-insensitively. A commit's author is known by its email
 * address, by the login a forge's noreply address carries, and by the login
 * the forge gives for the commit.
 */
import { spawnSync } from "node:child_process";
import { findConfig, loadConfig } from "./config";
import type { Fetch } from "./forge";
import type { ForgeCalls, ReviewedPull } from "./review";

/** One commit of a change, as git or the forge gives it. */
export interface ChangeCommit {
  sha: string;
  message: string;
  authorEmail?: string;
  committerEmail?: string;
  authorLogin?: string;
  committerLogin?: string;
}

/** A person behind the change, and why: `bob asked for abc1234`. */
export interface Involvement {
  who: string;
  why: string;
}

/** The user a token acts as, or why it is unknown. */
export interface TokenUser {
  /** How the log names the token: `the pipeline's token`, `the agent's token (AGENT_TOKEN)`. */
  which: string;
  login?: string;
  unknown?: string;
}

export interface Involved {
  people: Involvement[];
  /** Lines for the log: tokens whose user is unknown, history that could not be read. */
  notes: string[];
}

/** A person left out of an approval, and why, as the log, the report and the audit trail name them. */
export interface Excluded {
  login: string;
  reason: string;
}

/** What the log and the plan note say when `agent.token_env` is set and `agent.login` is not. */
export const AGENT_NOT_EXCLUDED = "the agent's account isn't excluded: set agent.login to the login agent.token_env's token acts as";

/**
 * `agent.login` and `agent.token_env` from the config in `dir` (the job's
 * checkout of the default branch), for a job that judges an approval and has
 * no other way to read them. Empty when there is no config or it can't be read.
 */
export async function agentSettingsAt(dir: string): Promise<{ agentLogin?: string; agentTokenEnv?: string }> {
  try {
    const path = findConfig(dir);
    if (!path) return {};
    const agent = (await loadConfig(path)).agent;
    return { ...(typeof agent?.login === "string" && agent.login ? { agentLogin: agent.login } : {}), ...(typeof agent?.token_env === "string" && agent.token_env ? { agentTokenEnv: agent.token_env } : {}) };
  } catch {
    return {};
  }
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/** Whether two logins, principals or addresses name the same person. */
export const sameLogin = (a: string, b: string): boolean => norm(a) === norm(b);

const short = (sha: string): string => sha.slice(0, 7);

/** A login: what a forge allows in a user name, and the `[bot]` suffix of a GitHub App. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[bot\])?$/;

/** The values of a trailer (`Key: value` lines of the message's last paragraph, or any line of it: a squash merge keeps them in its body). */
export function trailerValues(message: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "i");
  const out: string[] = [];
  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    const m = re.exec(line.trim());
    if (m && LOGIN.test(m[1]!) && !out.some((o) => sameLogin(o, m[1]!))) out.push(m[1]!);
  }
  return out;
}

/** The logins `Requested-by:` trailers on a commit message name. */
export const requestedBy = (message: string): string[] => trailerValues(message, "Requested-by");

/** The addresses `Co-authored-by:` trailers name. */
function coAuthors(message: string): string[] {
  const out: string[] = [];
  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^co-authored-by:.*<([^<>\s]+@[^<>\s]+)>\s*$/i.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

/** The login a forge's noreply address carries: GitHub's `123+bob@users.noreply.github.com`, GitLab's `123-bob@users.noreply.gitlab.com`, Forgejo's `bob@noreply.<host>`. */
export function noreplyLogin(email: string): string | undefined {
  const m = /^(?:\d+[+-])?([^@\s]+)@users\.noreply\.(?:github|gitlab)\.com$/i.exec(email.trim()) ?? /^([^@\s]+)@noreply\.[^@\s]+$/i.exec(email.trim());
  return m && LOGIN.test(m[1]!) ? m[1] : undefined;
}

/**
 * The people behind a change: the pull request's author, the commits'
 * authors, co-authors and committers, the logins their trailers name, and
 * the tokens' users. `what` names the pull request as the forge does.
 */
export function involvedIn(o: { author?: string; pr?: number; what?: string; commits: readonly ChangeCommit[]; tokens?: readonly TokenUser[]; notes?: string[]; agentLogin?: string }): Involved {
  const people: Involvement[] = [];
  const add = (who: string | undefined, why: string): void => {
    if (!who || !who.trim()) return;
    if (!people.some((p) => sameLogin(p.who, who) && p.why === why)) people.push({ who, why });
  };
  for (const c of o.commits) {
    for (const login of requestedBy(c.message)) add(login, `${login} asked for ${short(c.sha)}`);
  }
  if (o.author) add(o.author, `${o.author} opened ${o.what ?? "pull request"}${o.pr !== undefined ? ` ${o.pr}` : ""}`);
  for (const c of o.commits) {
    const wrote = [c.authorLogin, c.authorEmail, c.authorEmail ? noreplyLogin(c.authorEmail) : undefined, ...coAuthors(c.message).flatMap((e) => [e, noreplyLogin(e)])];
    for (const who of wrote) if (who) add(who, `${who} wrote ${short(c.sha)}`);
    const committed = [c.committerLogin, c.committerEmail, c.committerEmail ? noreplyLogin(c.committerEmail) : undefined];
    for (const who of committed) if (who) add(who, `${who} committed ${short(c.sha)}`);
    for (const login of trailerValues(c.message, "Pushed-by")) add(login, `${login} is the user the agent's token acts as, and it pushed ${short(c.sha)}`);
  }
  // agent.login: a pull request's author can post a review as the agent's account with its secret, so it never approves.
  if (o.agentLogin) add(o.agentLogin, `${o.agentLogin} is the account the agent's token acts as (agent.login)`);
  const notes = [...(o.notes ?? [])];
  for (const t of o.tokens ?? []) {
    if (t.login) add(t.login, `${t.login} is the user ${t.which} acts as`);
    else notes.push(`${t.which}: ${t.unknown ?? "the forge did not say which user it acts as"}, so its user is unknown and an approval by it is judged as anyone's`);
  }
  return { people, notes };
}

/**
 * The names an approver goes by: the name itself, and for a principal with a
 * forge's prefix (`github:alice`, as `terragucci approve --actor` takes it)
 * the login after it.
 */
export function namesOf(approver: string): string[] {
  const m = /^(?:github|gitlab|forgejo|gitea|codeberg)[^:]*:(.+)$/i.exec(approver.trim());
  return m ? [approver, m[1]!] : [approver];
}

/** Why `login` had a hand in the change, or undefined when they had none. The first reason found: a request, then the pull request, then a commit, then a token. */
export function whyInvolved(inv: Involved, login: string): string | undefined {
  const names = namesOf(login);
  return inv.people.find((p) => names.some((n) => sameLogin(p.who, n)))?.why;
}

/** The log's line for an approval the rule left out: `bob asked for abc1234, so bob's review doesn't count`. */
export const notCounted = (e: Excluded, what: "review" | "approval" = "approval"): string => `${e.reason}, so ${e.login}'s ${what} doesn't count`;

/** Split approvers into those who count and those the rule leaves out. */
export function judge(approvers: readonly string[], inv: Involved): { by: string[]; excluded: Excluded[] } {
  const by: string[] = [];
  const excluded: Excluded[] = [];
  for (const a of approvers) {
    const why = whyInvolved(inv, a);
    if (why) excluded.push({ login: a, reason: why });
    else by.push(a);
  }
  return { by, excluded };
}

/** Merge lists of excluded people, one entry per login. */
export function mergeExcluded(...lists: readonly (readonly Excluded[])[]): Excluded[] {
  const out: Excluded[] = [];
  for (const e of lists.flat()) if (!out.some((o) => sameLogin(o.login, e.login))) out.push(e);
  return out;
}

const SEP = "\x1f";
const END = "\x1e";

/**
 * The commits after `base` up to `head`, from git, merge commits left out: a
 * merge commit's author is whoever merged, not someone who wrote the change.
 * A shallow checkout gives the commits it holds.
 */
export function gitChange(repo: string, base: string | undefined, head: string): { commits: ChangeCommit[]; note?: string } {
  const range = base && base !== head ? [`${base}..${head}`] : ["-1", head];
  const r = spawnSync("git", ["log", "--no-merges", `--format=%H${SEP}%ae${SEP}%ce${SEP}%B${END}`, ...range], { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) return { commits: [], note: `the commits of ${short(head)} could not be read from git (${(r.stderr ?? "").trim().split("\n")[0]})` };
  const commits: ChangeCommit[] = [];
  for (const rec of (r.stdout ?? "").split(END)) {
    const [sha, ae, ce, ...body] = rec.replace(/^\n+/, "").split(SEP);
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    commits.push({ sha, message: body.join(SEP), ...(ae ? { authorEmail: ae } : {}), ...(ce ? { committerEmail: ce } : {}) });
  }
  return { commits };
}

/** A pull request's commits as GitHub and Forgejo list them (`pulls/:n/commits`). */
export function forgeCommits(list: unknown): ChangeCommit[] {
  const out: ChangeCommit[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const sha = typeof c?.sha === "string" ? c.sha : undefined;
    if (!sha) continue;
    const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    const entry: ChangeCommit = { sha, message: s(c?.commit?.message) ?? "" };
    const ae = s(c?.commit?.author?.email);
    const ce = s(c?.commit?.committer?.email);
    const al = s(c?.author?.login);
    const cl = s(c?.committer?.login);
    if (ae) entry.authorEmail = ae;
    if (ce) entry.committerEmail = ce;
    if (al) entry.authorLogin = al;
    if (cl) entry.committerLogin = cl;
    out.push(entry);
  }
  return out;
}

/** A merge request's commits as GitLab lists them (`merge_requests/:iid/commits`). */
export function gitlabCommits(list: unknown): ChangeCommit[] {
  const out: ChangeCommit[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const sha = typeof c?.id === "string" ? c.id : undefined;
    if (!sha) continue;
    out.push({ sha, message: typeof c?.message === "string" ? c.message : "", ...(typeof c?.author_email === "string" ? { authorEmail: c.author_email } : {}), ...(typeof c?.committer_email === "string" ? { committerEmail: c.committer_email } : {}) });
  }
  return out;
}

/** The user a token acts as, from the forge's `GET /user`: GitHub's and Forgejo's `login`, GitLab's `username`. */
export async function tokenUser(o: { which: string; forge: "github" | "forgejo" | "gitlab"; api: string | undefined; token: string | undefined; fetch?: Fetch }): Promise<TokenUser> {
  if (!o.token) return { which: o.which, unknown: "this job does not hold it" };
  if (!o.api) return { which: o.which, unknown: "this job does not know the forge's API address" };
  try {
    const headers: Record<string, string> = o.forge === "gitlab" ? { "private-token": o.token } : { authorization: `token ${o.token}` };
    const r = await (o.fetch ?? (fetch as unknown as Fetch))(`${o.api.replace(/\/+$/, "")}/user`, { method: "GET", headers });
    if (!r.ok) return { which: o.which, unknown: `GET /user answered ${r.status}` };
    const u = (await r.json()) as { login?: unknown; username?: unknown };
    const login = o.forge === "gitlab" ? u?.username : u?.login;
    return typeof login === "string" && login ? { which: o.which, login } : { which: o.which, unknown: "GET /user named no user" };
  } catch (e) {
    return { which: o.which, unknown: `GET /user failed (${(e as Error).message})` };
  }
}

/** The forge's API address the jobs call, from the environment. */
export function apiBase(forge: "github" | "forgejo" | "gitlab", env: NodeJS.ProcessEnv): string | undefined {
  if (forge === "gitlab") return env.CI_API_V4_URL;
  return env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL.replace(/\/+$/, "")}/api/v1` : undefined);
}

/**
 * The users the pipeline's token (`TG_TOKEN`) and the agent's token act as.
 * The agent's token is read from the variable `agent.token_env` names, when
 * this job holds it.
 */
export async function tokenUsers(o: { forge: "github" | "forgejo" | "gitlab"; env: NodeJS.ProcessEnv; fetch?: Fetch; agentTokenEnv?: string }): Promise<TokenUser[]> {
  const api = apiBase(o.forge, o.env);
  const out = [await tokenUser({ which: "the pipeline's token", forge: o.forge, api, token: o.env.TG_TOKEN, ...(o.fetch ? { fetch: o.fetch } : {}) })];
  if (o.agentTokenEnv) {
    const which = `the agent's token (${o.agentTokenEnv})`;
    const token = o.env[o.agentTokenEnv];
    out.push(token ? await tokenUser({ which, forge: o.forge, api, token, ...(o.fetch ? { fetch: o.fetch } : {}) }) : { which, unknown: "this job does not hold it; a Pushed-by trailer on a commit it made names its user" });
  }
  return out;
}

/**
 * The people behind a pull request (./involved.ts): its author, its commits'
 * authors, committers and trailers as the forge lists them, with `git` the
 * commits git holds after `base` up to `head` too, and the users the
 * pipeline's and the agent's tokens act as. Never throws: what cannot be read
 * is a note for the log.
 */
export async function pullInvolvement(o: {
  forge: "github" | "forgejo" | "gitlab";
  calls?: ForgeCalls;
  pr?: ReviewedPull;
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
  git?: { repo: string; base?: string; head: string };
  agentTokenEnv?: string;
  /** `agent.login`: the account the agent's token acts as, never an approver. */
  agentLogin?: string;
}): Promise<Involved> {
  const notes: string[] = [];
  const commits: ChangeCommit[] = [];
  if (o.pr && o.calls) {
    try {
      commits.push(...(o.forge === "gitlab" ? gitlabCommits(await o.calls.get(`${o.calls.repo}/merge_requests/${o.pr.number}/commits?per_page=100`)) : forgeCommits(await o.calls.get(`repos/${o.calls.repo}/pulls/${o.pr.number}/commits?per_page=100&limit=50`))));
    } catch (e) {
      notes.push(`the commits of ${o.forge === "gitlab" ? "merge request" : "pull request"} ${o.pr.number} could not be read from the forge (${(e as Error).message})`);
    }
  }
  if (o.git) {
    const got = gitChange(o.git.repo, o.git.base, o.git.head);
    commits.push(...got.commits);
    if (got.note) notes.push(got.note);
  }
  const tokens = await tokenUsers({ forge: o.forge, env: o.env, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.agentTokenEnv ? { agentTokenEnv: o.agentTokenEnv } : {}) });
  if (o.agentTokenEnv && !o.agentLogin) notes.push(AGENT_NOT_EXCLUDED);
  return involvedIn({ ...(o.pr?.author ? { author: o.pr.author } : {}), ...(o.pr ? { pr: o.pr.number } : {}), what: o.forge === "gitlab" ? "merge request" : "pull request", commits, tokens, notes, ...(o.agentLogin ? { agentLogin: o.agentLogin } : {}) });
}

/** Approvers with those the rule leaves out taken away, and the people left out. With no involvement, every approver counts. */
export function countable(by: readonly string[], involved: Involved | undefined): { by: string[]; excluded: Excluded[] } {
  return involved ? judge(by, involved) : { by: [...by], excluded: [] };
}
