/**
 * `terragucci relay`: the container's entrypoint for chant's relay
 * (`chant notify relay`, chant#4611), run in the customer's own cloud.
 * terragucci hosts nothing.
 *
 * A waiting wave's Slack message carries chant's Approve and Decline buttons,
 * and its Teams card the reply `@<relay> approve <reference>`, each signed
 * with the relay key (./notify.ts). chant's relay verifies the click, maps
 * the chat user to a principal through the signers file, and records the
 * approval as `chant approve tf-apply wave-<k>` does, relayed by the relay.
 * A gate that asks a decision point gets its question answered instead.
 *
 * What stays here is the host's setup, before chant serves:
 *
 *   1. the token is approve-only (`checkToken`): it neither administers the
 *      repo nor may push to its default branch, and on GitLab carries no api
 *      scope. The relay pushes chant/lifecycle with it and starts no job;
 *   2. the repo is cloned from `TERRAGUCCI_RELAY_REPO` into a checkout of
 *      its default branch, with the token as a git header for this process
 *      only, because chant's relay runs in a checkout;
 *   3. terragucci's names for the principal and the Slack response
 *      addresses map onto chant's, and the relay listens on every interface,
 *      as a container's port is reached.
 *
 * Moving the clone and the token check into chant is chant#4759.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_ENV as CHANT_RELAY_ENV } from "@intentius/chant/notify-relay";
import { runChantInProcess } from "@intentius/chant/ci-product";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { ConfigError } from "./config";
import type { Fetch } from "./forge";
import { originOf, type ForgeKind } from "./resume";

/** The host's settings, from its environment, beside chant's own (`CHANT_RELAY_KEY`, `SLACK_SIGNING_SECRET`, `TEAMS_WEBHOOK_SECRET`). */
export const RELAY_ENV = {
  /** The repo's https clone address. */
  repo: "TERRAGUCCI_RELAY_REPO",
  /** The approve-only token. */
  token: "TERRAGUCCI_RELAY_TOKEN",
  /** github, gitlab or forgejo, for a host other than github.com and gitlab.com. */
  forge: "TERRAGUCCI_RELAY_FORGE",
  /** The principal the relay records as `relayedBy`; chant's `CHANT_RELAY_PRINCIPAL`. */
  principal: "TERRAGUCCI_RELAY_PRINCIPAL",
  /** Comma-separated address prefixes a Slack response_url may have; chant's `CHANT_RELAY_SLACK_RESPONSE`. */
  slackResponse: "TERRAGUCCI_RELAY_SLACK_RESPONSE",
} as const;

export const DEFAULT_RELAY_PRINCIPAL = "terragucci-relay";

export interface RelayRepo {
  forge: ForgeKind;
  web: string;
  path: string;
  url: string;
}

export function relayRepo(url: string, forge?: string): RelayRepo {
  if (!/^https?:\/\//.test(url)) throw new ConfigError(`${RELAY_ENV.repo} must be the repo's https clone address, such as https://github.com/acme/infra.git`);
  if (/^https?:\/\/[^/]*@/.test(url)) throw new ConfigError(`${RELAY_ENV.repo} must not carry a credential; the token goes in ${RELAY_ENV.token}`);
  const o = originOf(url, forge);
  if (!o) throw new ConfigError(`${RELAY_ENV.repo} is not on github.com or gitlab.com; set ${RELAY_ENV.forge} to github, gitlab or forgejo`);
  return { forge: o.forge, web: o.web, path: o.path, url };
}

const APPROVE_ONLY_SCOPES = new Set(["read_api", "read_repository", "write_repository"]);

/**
 * Why the token is more than approve-only, or the git user name it pushes
 * as. An approve-only token reads the repo and pushes chant/lifecycle: it
 * neither administers the repo nor may push to the default branch, and on
 * GitLab carries no api scope.
 */
export async function checkToken(repo: RelayRepo, token: string, defaultBranch: string, f: Fetch = fetch): Promise<{ user: string } | { error: string }> {
  const call = async (url: string, auth: Record<string, string>): Promise<{ body: any; scopes?: string }> => {
    const r = await f(url, { headers: { accept: "application/json", ...auth } });
    if (!r.ok) throw new Error(`${url.replace(/^https?:\/\/[^/]+/, "")} answered ${r.status}`);
    const scopes = (r as unknown as { headers?: { get?: (n: string) => string | null } }).headers?.get?.("x-oauth-scopes") ?? undefined;
    return { body: await r.json(), ...(scopes ? { scopes } : {}) };
  };
  const branch = encodeURIComponent(defaultBranch);
  try {
    if (repo.forge === "gitlab") {
      const api = `${repo.web}/api/v4`;
      const auth = { "private-token": token };
      const self = (await call(`${api}/personal_access_tokens/self`, auth)).body;
      const extra = (Array.isArray(self?.scopes) ? self.scopes : []).filter((s: string) => !APPROVE_ONLY_SCOPES.has(s));
      if (extra.length > 0) return { error: `the token has the scopes ${extra.join(", ")}; an approve-only token has write_repository and read_api only` };
      const project = (await call(`${api}/projects/${encodeURIComponent(repo.path)}`, auth)).body;
      const level = Math.max(project?.permissions?.project_access?.access_level ?? 0, project?.permissions?.group_access?.access_level ?? 0);
      if (level >= 40) return { error: `the token's user is a Maintainer or Owner of ${repo.path}; give the relay a Developer` };
      const pb = await f(`${api}/projects/${encodeURIComponent(repo.path)}/protected_branches/${branch}`, { headers: { accept: "application/json", ...auth } });
      if (!pb.ok) return { error: `${defaultBranch} is not a protected branch, so the token could push to it` };
      const push = ((await pb.json()) as any)?.push_access_levels ?? [];
      if (push.some((p: any) => typeof p?.access_level === "number" && p.access_level > 0 && p.access_level <= level)) return { error: `the token's user may push to ${defaultBranch}` };
      return { user: "oauth2" };
    }
    if (repo.forge === "github") {
      const api = repo.web === "https://github.com" ? "https://api.github.com" : `${repo.web}/api/v3`;
      const auth = { authorization: `Bearer ${token}` };
      const r = await call(`${api}/repos/${repo.path}`, auth);
      if (r.scopes !== undefined) return { error: "a classic token reaches every repo its account can; give the relay a fine-grained token for this repo with Contents: Read and write, and nothing else" };
      if (r.body?.permissions?.admin) return { error: `the token's account administers ${repo.path}` };
      const b = (await call(`${api}/repos/${repo.path}/branches/${branch}`, auth)).body;
      if (!b?.protected) return { error: `${defaultBranch} is not protected, so the token could push to it` };
      return { user: "x-access-token" };
    }
    const api = `${repo.web}/api/v1`;
    const auth = { authorization: `token ${token}` };
    const me = (await call(`${api}/user`, auth)).body;
    const r = (await call(`${api}/repos/${repo.path}`, auth)).body;
    if (r?.permissions?.admin) return { error: `the token's user administers ${repo.path}` };
    const b = (await call(`${api}/repos/${repo.path}/branches/${branch}`, auth)).body;
    if (b?.user_can_push !== false) return { error: `the token's user may push to ${defaultBranch}; protect it so only reviewed merges reach it` };
    return { user: String(me?.login ?? "terragucci-relay") };
  } catch (e) {
    return { error: `the forge could not be read with the token (${(e as Error).message})` };
  }
}

/** The git config every git call of the relay carries: the token as a header, never in a file or the remote's address. */
export function gitAuthEnv(user: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** A checkout of `branch` of the repo at `url`, with every commit, which chant's relay reads the signers, points and ledger in. */
export function relayCheckout(url: string, branch: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(join(tmpdir(), "terragucci-relay-"));
  const r = spawnSync("git", ["clone", "-q", "--branch", branch, url, dir], { encoding: "utf-8", env });
  if (r.status !== 0) throw new ConfigError(`cannot clone ${url}: ${(r.stderr ?? "").trim()}`);
  return dir;
}

/** chant's relay settings from terragucci's names, where chant's are not set. */
export function chantRelayEnv(env: NodeJS.ProcessEnv, port: number): Record<string, string> {
  const principal = env[CHANT_RELAY_ENV.principal]?.trim() || env[RELAY_ENV.principal]?.trim() || DEFAULT_RELAY_PRINCIPAL;
  if (/[\r\n]/.test(principal)) throw new ConfigError(`${RELAY_ENV.principal} is one principal on one line`);
  const slackResponse = env[CHANT_RELAY_ENV.slackResponse] || env[RELAY_ENV.slackResponse];
  return {
    [CHANT_RELAY_ENV.principal]: principal,
    [CHANT_RELAY_ENV.port]: String(port),
    [CHANT_RELAY_ENV.host]: env[CHANT_RELAY_ENV.host] || "0.0.0.0",
    ...(slackResponse ? { [CHANT_RELAY_ENV.slackResponse]: slackResponse } : {}),
  };
}

/**
 * Check the token, clone the repo, and serve chant's relay from the clone on
 * `port`. Runs until the process is stopped.
 */
export async function startRelay(o: { port: number; env?: NodeJS.ProcessEnv; fetch?: Fetch; log?: (line: string) => void }): Promise<number> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.log(`terragucci relay: ${l}`));
  const token = env[RELAY_ENV.token] ?? "";
  if (!token) throw new ConfigError(`${RELAY_ENV.token} is empty: the relay pushes approvals with an approve-only token`);
  if (!env[CHANT_RELAY_ENV.key]) throw new ConfigError(`${CHANT_RELAY_ENV.key} is empty: it holds the key the buttons are signed with, the secret notify.relay_key names in the pipeline`);
  const repo = relayRepo(env[RELAY_ENV.repo] ?? "", env[RELAY_ENV.forge]);
  const probeEnv = { ...process.env, ...gitAuthEnv(repo.forge === "github" ? "x-access-token" : "oauth2", token) };
  const ls = spawnSync("git", ["ls-remote", "--symref", repo.url, "HEAD"], { encoding: "utf-8", env: probeEnv });
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(ls.stdout ?? "")?.[1];
  if (!branch) throw new ConfigError(`cannot read ${repo.path} with the token: ${(ls.stderr ?? "").trim() || "no default branch"}`);
  const checked = await checkToken(repo, token, branch, o.fetch);
  if ("error" in checked) throw new ConfigError(`the relay holds only an approve-only token, and this one is more: ${checked.error}`);
  // The token as a git header, for this process's git calls only: chant's relay fetches and pushes chant/lifecycle with it.
  Object.assign(process.env, gitAuthEnv(checked.user, token), chantRelayEnv(env, o.port));
  const dir = relayCheckout(repo.url, branch);
  process.chdir(dir);
  log(`serving ${repo.path} (${repo.forge}, default branch ${branch}) through chant's relay on port ${o.port}, pushing as ${checked.user}`);
  return runChantInProcess(["notify", "relay"], TERRAGUCCI_WORDS);
}
