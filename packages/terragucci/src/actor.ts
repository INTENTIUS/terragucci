/**
 * Who, or what, proposed a change: a person or an agent.
 *
 * The forge app or bot identity is authoritative. An agent acts through its
 * own forge identity, and `policy.agents` lists those identities; the change
 * is an agent's when the identity that proposed it is on the list. A commit
 * trailer and the OIDC subject are recorded in `signals` beside it and never
 * change `kind` on their own: a trailer with no matching identity leaves the
 * change a person's, and a listed identity with no trailer is still an
 * agent's. The commit author is not a signal.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ActorSignals {
  /** The forge login that proposed the change: the pull request's author, else the job's actor. Absent when the environment names none. */
  forgeIdentity?: string;
  /** The value of an agent trailer (`Assisted-by`, `Generated-by`, `Agent` or an agent's `Co-authored-by`) on the head commit. */
  trailer?: string;
  /** The job's OIDC `sub`: `TG_OIDC_SUBJECT`, else the forge's default subject for the event. */
  oidcSubject?: string;
}

export interface Actor {
  kind: "person" | "agent";
  /** The forge identity when there is one, else `unknown`. */
  principal: string;
  signals: ActorSignals;
}

/** A login as it is compared: lower case, without GitHub's `[bot]` suffix, `app/` prefix or a `github:` style forge prefix. */
export function normalizeIdentity(login: string): string {
  return login.trim().toLowerCase().replace(/^(?:github|gitlab|forgejo):/, "").replace(/^app\//, "").replace(/\[bot\]$/, "");
}

const TRAILER_KEYS = /^(assisted-by|generated-by|agent|co-authored-by):\s*(.+)$/i;
const AGENT_NAME = /\b(claude|copilot|codex|gemini|kiro|devin|cursor|aider|agent|bot)\b/i;

/** The first agent trailer in a commit message's last paragraph. A `Co-authored-by` counts only when its name looks like an agent's or is listed. */
export function agentTrailer(message: string, agents: readonly string[] = []): string | undefined {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const listed = new Set(agents.map(normalizeIdentity));
  for (const line of last.split("\n")) {
    const m = TRAILER_KEYS.exec(line.trim());
    if (!m) continue;
    const value = m[2].trim();
    if (m[1].toLowerCase() !== "co-authored-by" || AGENT_NAME.test(value) || listed.has(normalizeIdentity(value.replace(/\s*<.*>$/, "")))) return value;
  }
  return undefined;
}

function readEvent(env: NodeJS.ProcessEnv): any {
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf-8"));
  } catch {
    return undefined;
  }
}

function oidcSubject(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TG_OIDC_SUBJECT?.trim()) return env.TG_OIDC_SUBJECT.trim();
  if (!env.GITHUB_REPOSITORY) return undefined;
  const repo = `repo:${env.GITHUB_REPOSITORY}`;
  if (env.GITHUB_EVENT_NAME === "pull_request" || env.GITHUB_EVENT_NAME === "pull_request_target") return `${repo}:pull_request`;
  return env.GITHUB_REF ? `${repo}:ref:${env.GITHUB_REF}` : undefined;
}

function commitMessage(repo: string, sha: string | undefined): string | undefined {
  try {
    return execFileSync("git", ["-C", repo, "log", "-1", "--format=%B", ...(sha ? [sha] : [])], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/**
 * The actor of a run. `agents` is `policy.agents` at base: the forge
 * identities that are agents. With none listed every change is a person's.
 */
export function detectActor(repo: string, env: NodeJS.ProcessEnv, agents: readonly string[] = []): Actor {
  const event = readEvent(env);
  const pull = event?.pull_request;
  const identity = [pull?.user?.login, env.GITHUB_TRIGGERING_ACTOR, env.GITHUB_ACTOR, env.GITLAB_USER_LOGIN].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim();
  const message = commitMessage(repo, typeof pull?.head?.sha === "string" ? pull.head.sha : undefined);
  const trailer = message === undefined ? undefined : agentTrailer(message, agents);
  const subject = oidcSubject(env);
  const listed = new Set(agents.map(normalizeIdentity));
  return {
    kind: identity !== undefined && listed.has(normalizeIdentity(identity)) ? "agent" : "person",
    principal: identity ?? "unknown",
    signals: { ...(identity !== undefined ? { forgeIdentity: identity } : {}), ...(trailer ? { trailer } : {}), ...(subject ? { oidcSubject: subject } : {}) },
  };
}
