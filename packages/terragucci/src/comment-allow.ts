/**
 * `comment_allow`: who may run each comment command, beyond write access.
 *
 * Every comment command already needs write access to the repository. A
 * `comment_allow` entry narrows one command (or `default`, every command it
 * does not name) to a list of people and teams:
 *
 *     comment_allow:
 *       apply: ["team:acme/release", alice]
 *       unlock: ["team:acme/platform"]
 *       default: ["team:acme/engineering"]
 *
 * An entry is a login, or `team:<where>`: on GitHub and Forgejo
 * `team:<org>/<team>`, on GitLab `team:<group path>` (the group's members,
 * inherited ones included). A command no entry and no `default` names keeps
 * the write-access rule alone.
 *
 * The list is read from terragucci.yml in the job's checkout, which for every
 * job that reads comments is the default branch, so a pull request cannot add
 * its author. Team membership is read from the forge with the job's token;
 * the reads go through `TeamReads`, which a caller can replace, so a test
 * touches no network. When the forge cannot answer (a token without the
 * permission to read a team, a team that does not exist) nothing runs and
 * the reply says what to fix.
 */
import type { ForgeName } from "./config";
import type { Fetch } from "./forge";

/** The commands `comment_allow` names, besides `default`. `skip-soak` is the rollouts' comment. */
export const COMMENT_ALLOW_COMMANDS = ["plan", "apply", "lock", "unlock", "agent", "action", "skip-soak"] as const;
export type AllowCommand = (typeof COMMENT_ALLOW_COMMANDS)[number];

/** What `comment_allow` takes: a list of logins and `team:` entries per command, and `default`. */
export type CommentAllow = Partial<Record<AllowCommand | "default", string[]>>;

const LOGIN_ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;
const TEAM_ENTRY = /^team:([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99})+)$/;

/** One entry as JSON Schema writes it: a login, or team: and a path. */
export const COMMENT_ALLOW_PATTERN = `^(${LOGIN_ENTRY.source.slice(1, -1)}|team:[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99})+)$`;

/** Why an entry is not a login or a team, or undefined when it is one. */
export function allowEntryProblem(entry: unknown): string | undefined {
  if (typeof entry !== "string") return "must be a login or team:<org>/<team>";
  if (entry.startsWith("team:")) return TEAM_ENTRY.test(entry) ? undefined : `${JSON.stringify(entry)} is not a team: write team:<org>/<team>, or team:<group path> on GitLab`;
  return LOGIN_ENTRY.test(entry) ? undefined : `${JSON.stringify(entry)} is not a login or a team: write a login, or team:<org>/<team>`;
}

/** The problems with a `comment_allow` value, each naming its path under `where`. */
export function commentAllowProblems(v: unknown, where: string): string[] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [`${where} must be a map of command to a list of logins and teams (commands: ${[...COMMENT_ALLOW_COMMANDS, "default"].join(", ")})`];
  const problems: string[] = [];
  for (const [k, list] of Object.entries(v)) {
    if (k !== "default" && !(COMMENT_ALLOW_COMMANDS as readonly string[]).includes(k)) {
      problems.push(`${where}.${k} is not a comment command (commands: ${[...COMMENT_ALLOW_COMMANDS, "default"].join(", ")})`);
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`${where}.${k} must be a list of logins and teams with at least one entry, since an empty list would let nobody run it`);
      continue;
    }
    list.forEach((e, i) => {
      const p = allowEntryProblem(e);
      if (p) problems.push(`${where}.${k}[${i}] ${p}`);
    });
  }
  return problems;
}

/**
 * The commands whose jobs read `comment_allow` on each forge. On GitLab the
 * comments job is terragucci's for every command. On GitHub and Forgejo the
 * action workflow, the rollouts' skip-soak and, with `locks: plan` and
 * `apply.when: merge`, the pr-lock job's `lock` and `unlock` are terragucci's;
 * the re-plan, the apply comment and the agent are chant's jobs, which check
 * write access alone. A list for a command no job reads would look like a
 * limit and be none, so `config check` refuses it.
 */
export function commentAllowForgeProblems(allow: CommentAllow, s: { forge?: string; locks?: unknown; apply?: { when?: unknown } }, where: string): string[] {
  if (s.forge === "gitlab") return [];
  const own = new Set<string>(["action", "skip-soak", ...(s.locks === "plan" && s.apply?.when !== "pull-request" ? ["lock", "unlock"] : [])]);
  const out: string[] = [];
  for (const k of Object.keys(allow)) {
    if (own.has(k)) continue;
    out.push(`${where}.${k} is not read here: ${
      k === "lock" || k === "unlock"
        ? `on GitHub and Forgejo \`${k}\` is limited under locks: plan with apply.when: merge, where the pr-lock job answers it`
        : k === "default"
          ? "default would cover commands that chant's comment jobs answer on GitHub and Forgejo, and they check write access alone, so name action, skip-soak, lock or unlock instead"
          : `on GitHub and Forgejo chant's comment jobs answer \`${k}\` and check write access alone; on GitLab (forge: gitlab) the comments job limits it`
    }`);
  }
  return out;
}

/** The teams a `comment_allow` names. */
export function allowTeams(allow: CommentAllow | undefined): string[] {
  return [...new Set(Object.values(allow ?? {}).flat().filter((e) => e.startsWith("team:")).map((e) => e.slice(5)))];
}

/** A read that could not answer: the message says what to fix. */
export class TeamReadError extends Error {}

/** Whether a login is in a team. Throws TeamReadError when the forge cannot say. */
export interface TeamReads {
  member(team: string, login: string): Promise<boolean>;
}

export type AllowDecision = { ok: true } | { ok: false; reason: string; fail?: true };

/** The environment variable the team reads take their token from, before the job's own token. */
export const TEAM_TOKEN_ENV = "TG_TEAM_TOKEN";

/**
 * Whether `user` may run `command`. A command with no list (and no
 * `default`) is open to every writer, who already passed the permission check.
 * A listed login needs no read; a team is read one at a time, stopping at the
 * first that holds the user.
 */
export async function mayRun(allow: CommentAllow | undefined, command: AllowCommand, user: string, teams: TeamReads | undefined, token = "TG_TOKEN"): Promise<AllowDecision> {
  const list = allow?.[command] ?? allow?.default;
  if (!list || list.length === 0) return { ok: true };
  const me = user.toLowerCase();
  if (list.some((e) => !e.startsWith("team:") && e.toLowerCase() === me)) return { ok: true };
  const wanted = list.filter((e) => e.startsWith("team:")).map((e) => e.slice(5));
  const refused = (): AllowDecision => ({ ok: false, reason: `${user} may not run \`/terragucci ${command}\` here: it is limited to ${list.map((e) => `\`${e}\``).join(", ")} (comment_allow in terragucci.yml on the default branch)` });
  if (wanted.length === 0) return refused();
  if (!teams) return { ok: false, fail: true, reason: `could not read team membership, so nothing runs: no forge reads for ${user}'s teams were given` };
  let unreadable: string | undefined;
  for (const team of wanted) {
    try {
      if (await teams.member(team, user)) return { ok: true };
    } catch (e) {
      if (!(e instanceof TeamReadError)) throw e;
      unreadable ??= e.message;
    }
  }
  if (unreadable) return { ok: false, fail: true, reason: `could not read team membership for ${user}, so nothing runs (${unreadable}). ${token} must hold a token that can read the team's members` };
  return refused();
}

/**
 * The comment_allow of the terragucci.yml in `cwd`, which is the default
 * branch in every job that reads comments. Undefined when there is no file or
 * it sets none. A config that does not load is an error, so a broken file
 * never turns the limit off.
 */
export async function commentAllowAt(cwd: string): Promise<CommentAllow | undefined> {
  // config.ts imports this file for the validation, so it is read here when called.
  const { findConfig, loadConfig } = await import("./config");
  const path = findConfig(cwd);
  if (!path) return undefined;
  const config = await loadConfig(path);
  return (config as { comment_allow?: CommentAllow }).comment_allow;
}

interface ReadTarget {
  kind: ForgeName;
  apiBase: string;
  token: string;
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
}

/**
 * Team reads against a forge's REST API. A team the token cannot see and a
 * team that does not exist both answer 404 on GitHub, so each team is looked
 * up once first: if that fails the read says so, and a 404 on the membership
 * afterwards means the user is not in the team.
 *
 * GitHub needs a token that can read the organization's members (a classic
 * token with `read:org`, or a fine-grained token or app with the
 * organization permission Members: read); the workflow's own token cannot.
 * Forgejo needs `read:organization`. GitLab needs `read_api` for a user who
 * can see the group's members.
 */
export function teamReads(t: ReadTarget, fetch: Fetch): TeamReads {
  const cache = new Map<string, Promise<unknown>>();
  const headers: Record<string, string> =
    t.kind === "gitlab" ? { [t.tokenHeader ?? "PRIVATE-TOKEN"]: t.token } : { authorization: `token ${t.token}`, accept: "application/json" };
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${t.apiBase.replace(/\/+$/, "")}${path}`, { method: "GET", headers });
    let body: unknown;
    try {
      body = r.ok ? await r.json() : undefined;
    } catch {
      body = undefined;
    }
    return { status: r.status, body };
  };
  const once = <T>(key: string, make: () => Promise<T>): Promise<T> => (cache.get(key) as Promise<T> | undefined) ?? (cache.set(key, make()), cache.get(key) as Promise<T>);
  const split = (team: string): [string, string] => {
    const i = team.lastIndexOf("/");
    return [team.slice(0, i), team.slice(i + 1)];
  };
  const unreadable = (what: string, status: number): TeamReadError => new TeamReadError(`${what} answered ${status}${status === 404 ? ": the team does not exist, or the token cannot see it" : ""}`);

  return {
    async member(team, login) {
      if (t.kind === "gitlab") {
        const group = encodeURIComponent(team);
        const found = await once(`g:${team}`, () => get(`/groups/${group}`));
        if (found.status !== 200) throw unreadable(`GitLab group ${team}`, found.status);
        const id = await once(`u:${login}`, async () => {
          const users = await get(`/users?username=${encodeURIComponent(login)}`);
          if (users.status !== 200) throw unreadable("the user lookup", users.status);
          return Array.isArray(users.body) ? users.body.find((u: any) => u?.username === login)?.id : undefined;
        });
        if (typeof id !== "number") return false;
        const m = await get(`/groups/${group}/members/all/${id}`);
        if (m.status === 404) return false;
        if (m.status !== 200) throw unreadable(`group ${team}'s member list`, m.status);
        return m.body?.state === undefined || m.body.state === "active";
      }
      const [org, slug] = split(team);
      if (t.kind === "forgejo") {
        const id = await once(`t:${team}`, async () => {
          const s = await get(`/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(slug)}&limit=50`);
          if (s.status !== 200) throw unreadable(`searching ${org}'s teams`, s.status);
          const hit = (Array.isArray(s.body?.data) ? s.body.data : []).find((x: any) => String(x?.name).toLowerCase() === slug.toLowerCase());
          if (!hit || typeof hit.id !== "number") throw new TeamReadError(`${org} has no team named ${slug}, or the token cannot see it`);
          return hit.id as number;
        });
        const m = await get(`/teams/${id}/members/${encodeURIComponent(login)}`);
        if (m.status === 404) return false;
        if (m.status !== 200) throw unreadable(`team ${team}'s member list`, m.status);
        return true;
      }
      const found = await once(`t:${team}`, () => get(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`));
      if (found.status !== 200) throw unreadable(`GitHub team ${team}`, found.status);
      const m = await get(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`);
      if (m.status === 404) return false;
      if (m.status !== 200) throw unreadable(`team ${team}'s membership of ${login}`, m.status);
      // A pending invitation is not membership.
      return m.body?.state === "active";
    },
  };
}

/** A job's team reads: the forge's API and the team token (TG_TEAM_TOKEN), else the job's own (TG_TOKEN). */
export function jobTeamReads(kind: ForgeName, env: NodeJS.ProcessEnv, fetch: Fetch): TeamReads {
  const token = env[TEAM_TOKEN_ENV] || env.TG_TOKEN;
  const apiBase = kind === "gitlab" ? env.CI_API_V4_URL : env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/api/v1` : undefined);
  if (!token || !apiBase) {
    const missing = new TeamReadError(`reading team membership needs ${kind === "gitlab" ? "CI_API_V4_URL" : "GITHUB_API_URL or GITHUB_SERVER_URL"} and ${TEAM_TOKEN_ENV} or TG_TOKEN in the environment`);
    return { member: () => Promise.reject(missing) };
  }
  return teamReads({ kind, apiBase, token }, fetch);
}
