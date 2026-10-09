/**
 * `terragucci relay`: the approve and decline buttons of a chat message, run
 * in the customer's own cloud as a container or a function. terragucci hosts
 * nothing.
 *
 * A waiting wave's Slack message carries Approve and Decline buttons, and its
 * Teams card the reply `@<relay> approve wave-<k> <digest>` (./notify.ts).
 * Slack posts a click to the relay's `/slack`, signed with the app's signing
 * secret; a Teams outgoing webhook posts the reply to `/teams`, signed with
 * its HMAC key. The relay:
 *
 *   1. refuses a request whose signature does not verify (401), and a Slack
 *      request more than five minutes old;
 *   2. maps the chat user to a principal: the signers file on the default
 *      branch lists `slack:<team>/<user>` or `teams:<aad object id>` on that
 *      person's line, beside their principal. A user no line lists is
 *      refused in the thread, and nothing is recorded;
 *   3. for Approve, finds the wave waiting for exactly the digest the button
 *      carries, as `terragucci approve --plan <digest>` does, and records the
 *      approval on chant/lifecycle as that principal, `relayedBy` the relay.
 *      Plans that moved since the message approve nothing. Under
 *      `approval: sealed` it records nothing: only the approver's own key
 *      can seal an approval, and the relay holds none;
 *   4. for Decline, records nothing and says in the thread who declined; the
 *      wave keeps waiting and applies only on an approval.
 *
 * The relay holds an approve-only token: `checkToken` refuses to start with
 * one that administers the repo or may push to its default branch (and on
 * GitLab, one with the api scope). It uses the token only to fetch the repo
 * and push chant/lifecycle, and starts no job: the pipeline's resume job
 * (`apply.resume`) applies the wave once the approval stands.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { APPLY_OP, appendResolution, readLedger, waveGate, type GateLedger, type ResolutionRecord } from "./apply";
import { approvalRule } from "./approval";
import { waitingWaves } from "./approve";
import { ConfigError, type Approval } from "./config";
import type { Fetch } from "./forge";
import { APPROVE_ACTION, DECLINE_ACTION, REPLAN_ACTION, type ButtonValue } from "./notify";
import { configAtBase } from "./report/policy";
import { originOf, type ForgeKind } from "./resume";
import type { Signer } from "./seal";

/** The relay's settings, from its environment. */
export const RELAY_ENV = {
  /** The repo's https clone address. */
  repo: "TERRAGUCCI_RELAY_REPO",
  /** The approve-only token. */
  token: "TERRAGUCCI_RELAY_TOKEN",
  /** github, gitlab or forgejo, for a host other than github.com and gitlab.com. */
  forge: "TERRAGUCCI_RELAY_FORGE",
  /** The principal the relay records as `relayedBy`. */
  principal: "TERRAGUCCI_RELAY_PRINCIPAL",
  slackSecret: "SLACK_SIGNING_SECRET",
  teamsSecret: "TEAMS_WEBHOOK_SECRET",
  /** Comma-separated address prefixes a Slack response_url may have. */
  slackResponse: "TERRAGUCCI_RELAY_SLACK_RESPONSE",
} as const;

export const DEFAULT_RELAY_PRINCIPAL = "terragucci-relay";
/** Slack's own: hooks.slack.com, and GovSlack's. */
export const SLACK_RESPONSE_PREFIXES = ["https://hooks.slack.com/", "https://hooks.slack-gov.com/"];
/** How old a Slack request may be, as Slack's own verification advises. */
const SLACK_WINDOW_S = 5 * 60;

// ── signatures ───────────────────────────────────────────────────────────

const header = (h: Record<string, string | undefined>, name: string): string | undefined => h[name] ?? h[name.toLowerCase()];

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `v0=<hex>`: Slack's signature of a request, HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's signing secret. */
export const slackSignature = (secret: string, timestamp: string, raw: string): string => `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;

/** Why a Slack request is refused, or null when its signature verifies and it is recent. */
export function verifySlack(headers: Record<string, string | undefined>, raw: string, secret: string, now: number = Date.now()): string | null {
  if (!secret) return `${RELAY_ENV.slackSecret} is empty, so no Slack request can be verified`;
  const ts = header(headers, "x-slack-request-timestamp") ?? "";
  const sig = header(headers, "x-slack-signature") ?? "";
  if (!/^\d+$/.test(ts) || !sig) return "the request is not signed";
  if (Math.abs(now / 1000 - Number(ts)) > SLACK_WINDOW_S) return "the request is more than five minutes old";
  return same(sig, slackSignature(secret, ts, raw)) ? null : "the signature does not verify";
}

/** `HMAC <base64>`: a Teams outgoing webhook's signature, HMAC-SHA256 of the raw body with the key Teams gave (base64). */
export const teamsSignature = (secret: string, raw: string): string => `HMAC ${createHmac("sha256", Buffer.from(secret, "base64")).update(raw).digest("base64")}`;

/** Why a Teams request is refused, or null when its signature verifies. */
export function verifyTeams(headers: Record<string, string | undefined>, raw: string, secret: string): string | null {
  if (!secret) return `${RELAY_ENV.teamsSecret} is empty, so no Teams request can be verified`;
  const auth = header(headers, "authorization") ?? "";
  if (!auth.startsWith("HMAC ")) return "the request is not signed";
  return same(auth, teamsSignature(secret, raw)) ? null : "the signature does not verify";
}

// ── clicks ───────────────────────────────────────────────────────────────

/** One click or reply, read from a verified request. */
export interface Click {
  app: "slack" | "teams";
  /** `slack:<team>/<user>` or `teams:<aad object id>`: what the signers file lists. */
  chatUser: string;
  /** The name chat shows, for the reply. */
  display: string;
  action: "approve" | "decline" | "replan";
  wave?: number;
  plan?: string;
  /** Slack: where the reply goes, and the message it answers. */
  responseUrl?: string;
  thread?: string;
}

const parseValue = (v: unknown): ButtonValue | undefined => {
  try {
    const o = JSON.parse(String(v)) as ButtonValue;
    return Number.isInteger(o?.wave) && o.wave > 0 && typeof o.plan === "string" && /^\S+$/.test(o.plan) ? o : undefined;
  } catch {
    return undefined;
  }
};

/** A Slack `block_actions` payload (the form field `payload`), or why it is not one the relay reads. */
export function slackClick(raw: string): Click | { error: string } {
  let p: any;
  try {
    p = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return { error: "the request carries no Slack payload" };
  }
  if (p?.type !== "block_actions") return { error: `a Slack ${String(p?.type)} payload is not a button click` };
  const team = p.user?.team_id ?? p.team?.id;
  const user = p.user?.id;
  if (typeof team !== "string" || typeof user !== "string") return { error: "the click names no Slack user" };
  const a = Array.isArray(p.actions) ? p.actions[0] : undefined;
  const action = a?.action_id === APPROVE_ACTION ? "approve" : a?.action_id === DECLINE_ACTION ? "decline" : a?.action_id === REPLAN_ACTION ? "replan" : undefined;
  if (!action) return { error: `the button ${String(a?.action_id)} is not terragucci's` };
  const value = action === "replan" ? undefined : parseValue(a.value);
  if (action !== "replan" && !value) return { error: "the button names no wave and digest" };
  const thread = p.container?.message_ts ?? p.message?.ts;
  return {
    app: "slack",
    chatUser: `slack:${team}/${user}`,
    display: String(p.user?.username ?? p.user?.name ?? user),
    action,
    ...(value ? { wave: value.wave, plan: value.plan } : {}),
    ...(typeof p.response_url === "string" ? { responseUrl: p.response_url } : {}),
    ...(typeof thread === "string" ? { thread } : {}),
  };
}

/** The words of a Teams message: its mention and markup dropped. */
const teamsWords = (text: string): string[] =>
  text
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** A Teams outgoing webhook's message, `@<relay> approve|decline wave-<k> <digest>`, or why it is not one. */
export function teamsClick(raw: string): Click | { error: string } {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return { error: "the request is not a Teams message" };
  }
  const user = m?.from?.aadObjectId;
  if (typeof user !== "string" || !user) return { error: "the message names no Teams user" };
  const [verb, wave, plan] = teamsWords(String(m.text ?? ""));
  const k = Number(/^wave-(\d+)$/.exec(wave ?? "")?.[1]);
  if ((verb !== "approve" && verb !== "decline") || !Number.isInteger(k) || k < 1 || !plan) return { error: "say approve or decline, the wave and its digest: approve wave-<k> <digest>" };
  return { app: "teams", chatUser: `teams:${user}`, display: String(m.from?.name ?? user), action: verb, wave: k, plan };
}

// ── who clicked ──────────────────────────────────────────────────────────

const CHAT_ID = /^(slack|teams):/;
const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/**
 * The principal a chat user maps to: the signers file line that lists the
 * chat id gives the line's first principal that is not a chat id. Undefined
 * when no line lists it, or lines listing it name different principals.
 */
export function principalFor(signers: Signer[] | null, chatUser: string): string | undefined {
  const id = norm(chatUser);
  const found = new Set<string>();
  for (const s of signers ?? []) {
    if (!s.principals.includes(id)) continue;
    const p = s.principals.find((x) => !CHAT_ID.test(x));
    if (p) found.add(p);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// ── deciding ─────────────────────────────────────────────────────────────

/** What the relay reads and writes, so a test can stand in for the repo. */
export interface RelayDeps {
  /** The rule on the default branch: the approval mode, the signers file, and `apply.resume`. */
  rule(): Promise<{ mode: Approval; signers: Signer[] | null; signersPath: string; resume?: number }>;
  ledger(): GateLedger;
  record(r: ResolutionRecord): void;
  now?: () => Date;
  principal: string;
}

/** The relay's answer to a click: whether it was done, and the line for the thread. */
export interface Answer {
  ok: boolean;
  text: string;
}

/** Decide a click and record what it approves. Never throws: an error is the answer's text. */
export async function decideClick(click: Click, deps: RelayDeps): Promise<Answer> {
  // A Re-plan button is a link; Slack still tells the relay it was clicked.
  if (click.action === "replan") return { ok: true, text: "" };
  const gate = waveGate(click.wave!);
  try {
    const rule = await deps.rule();
    const principal = principalFor(rule.signers, click.chatUser);
    if (!principal) {
      return { ok: false, text: `Refused: ${click.display} (${click.chatUser}) is not mapped to a principal in ${rule.signersPath} on the default branch, so nothing was ${click.action === "approve" ? "approved" : "declined"}. A maintainer adds ${click.chatUser} to that person's line.` };
    }
    if (click.action === "decline") {
      return { ok: true, text: `${gate} declined by ${principal} for ${click.plan}. Nothing was approved; the wave keeps waiting, and applies only once someone approves its plans.` };
    }
    if (rule.mode === "sealed") {
      return { ok: false, text: `Refused: approval is sealed, so ${gate} counts only an approval sealed by ${principal}'s own key, which the relay never holds. Run: terragucci approve ${gate} --plan ${click.plan} --sign` };
    }
    const waiting = waitingWaves(deps.ledger()).filter((w) => w.wave === click.wave);
    const wave = waiting.find((w) => samePlanDigest(w.digest, click.plan!));
    if (!wave) {
      const now = waiting.length > 0 ? `it waits for ${waiting.map((w) => w.digest).join(", ")}` : "it is not waiting";
      return { ok: false, text: `Not approved: ${gate} does not wait for ${click.plan}; ${now}. The plans moved since this message, or they were approved already. Read the plans waiting, then approve their digest.` };
    }
    const timestamp = (deps.now?.() ?? new Date()).toISOString();
    deps.record({ version: 1, kind: "resolution", op: APPLY_OP, gate, resolvedBy: principal, relayedBy: deps.principal, timestamp, planDigest: wave.digest, via: click.app });
    const next = rule.resume ? `The resume job applies it within ${rule.resume} minutes.` : "Run its job again, or comment /terragucci apply on its pull request, to apply it.";
    return { ok: true, text: `${gate} approved by ${principal}, relayed by ${deps.principal}, for ${wave.digest} and no other plans. ${next}` };
  } catch (e) {
    return { ok: false, text: `Not recorded: ${(e as Error).message}` };
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────

export interface RelayRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RelaySettings {
  slackSecret?: string;
  teamsSecret?: string;
  /** The prefixes a Slack response_url may have. Default Slack's own. */
  slackResponse?: string[];
}

const json = (status: number, body: unknown): RelayResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const plain = (status: number, body: string): RelayResponse => ({ status, headers: { "content-type": "text/plain" }, body });

/**
 * One request to the relay: `POST /slack`, `POST /teams`, `GET /healthz`.
 * A Slack answer goes to the click's response_url, in the message's thread;
 * a Teams answer is the reply Teams posts under the message.
 */
export async function handleRelay(req: RelayRequest, settings: RelaySettings, deps: RelayDeps, post: Fetch = fetch, log: (line: string) => void = () => {}): Promise<RelayResponse> {
  const path = req.path.split("?")[0]!;
  if (req.method === "GET" && path === "/healthz") return plain(200, "ok");
  if (req.method !== "POST" || (path !== "/slack" && path !== "/teams")) return plain(404, "not found");
  if (path === "/slack") {
    const refused = verifySlack(req.headers, req.body, settings.slackSecret ?? "");
    if (refused) {
      log(`slack: refused a request: ${refused}`);
      return plain(401, refused);
    }
    const click = slackClick(req.body);
    if ("error" in click) return plain(400, click.error);
    const answer = await decideClick(click, deps);
    log(`slack: ${click.chatUser} ${click.action}${click.wave ? ` wave-${click.wave}` : ""}: ${answer.text || "a link"}`);
    if (answer.text && click.responseUrl) {
      const allowed = settings.slackResponse ?? SLACK_RESPONSE_PREFIXES;
      if (!allowed.some((p) => click.responseUrl!.startsWith(p))) log(`slack: the response_url is not Slack's (${allowed.join(", ")}); no reply was posted`);
      else {
        try {
          const r = await post(click.responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "in_channel", replace_original: false, ...(click.thread ? { thread_ts: click.thread } : {}), text: answer.text }) });
          if (!r.ok) log(`slack: the reply answered ${r.status}`);
        } catch (e) {
          log(`slack: the reply did not land (${(e as Error).message})`);
        }
      }
    }
    return plain(200, "");
  }
  const refused = verifyTeams(req.headers, req.body, settings.teamsSecret ?? "");
  if (refused) {
    log(`teams: refused a request: ${refused}`);
    return plain(401, refused);
  }
  const click = teamsClick(req.body);
  if ("error" in click) return json(200, { type: "message", text: click.error });
  const answer = await decideClick(click, deps);
  log(`teams: ${click.chatUser} ${click.action} wave-${click.wave}: ${answer.text}`);
  return json(200, { type: "message", text: answer.text });
}

// ── the token ────────────────────────────────────────────────────────────

/** The forge, its API and the repo's path, from the clone address. */
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

// ── the workspace ────────────────────────────────────────────────────────

/** The git config every git call of the relay carries: the token as a header, never in a file or the remote's address. */
export function gitAuthEnv(user: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The default branch the remote names. */
export function defaultBranchOf(dir: string): string {
  const r = spawnSync("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: dir, encoding: "utf-8" });
  const b = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout ?? "")?.[1];
  if (r.status !== 0 || !b) throw new ConfigError(`cannot read the repo's default branch: ${(r.stderr ?? "").trim() || "no HEAD"}`);
  return b;
}

/** The relay's own git directory, with origin set to the repo. */
export function workspace(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "terragucci-relay-"));
  for (const args of [["init", "-q"], ["remote", "add", "origin", url]]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new ConfigError(`git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return dir;
}

/** The deps over a workspace: the rule read from the default branch's tip, fetched for each click. */
export function workspaceDeps(dir: string, branch: string, principal: string): RelayDeps {
  const ref = `refs/remotes/origin/${branch}`;
  return {
    principal,
    async rule() {
      const f = spawnSync("git", ["fetch", "-q", "--depth=1", "origin", `+refs/heads/${branch}:${ref}`], { cwd: dir, encoding: "utf-8" });
      if (f.status !== 0) throw new ConfigError(`cannot fetch ${branch}: ${f.stderr.trim()}`);
      const rule = await approvalRule(dir, { at: ref });
      const config = await configAtBase(dir, ref);
      const resume = "config" in config ? (config.config as { apply?: { resume?: unknown } }).apply?.resume : undefined;
      return { mode: rule.mode, signers: rule.signers, signersPath: rule.signersPath, ...(typeof resume === "number" ? { resume } : {}) };
    },
    ledger: () => readLedger(dir),
    record: (r) => appendResolution(dir, r),
  };
}

const readBody = (req: IncomingMessage, limit = 256 * 1024): Promise<string> =>
  new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("the request is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", fail);
  });

/**
 * Start the relay from its environment: check the token, make the
 * workspace, and serve on `port`. One click is decided at a time, so two
 * never race on chant/lifecycle.
 */
export async function startRelay(o: { port: number; env?: NodeJS.ProcessEnv; log?: (line: string) => void; fetch?: Fetch }): Promise<Server> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.log(`terragucci relay: ${l}`));
  const token = env[RELAY_ENV.token] ?? "";
  if (!token) throw new ConfigError(`${RELAY_ENV.token} is empty: the relay pushes approvals with an approve-only token`);
  if (!env[RELAY_ENV.slackSecret] && !env[RELAY_ENV.teamsSecret]) throw new ConfigError(`set ${RELAY_ENV.slackSecret}, ${RELAY_ENV.teamsSecret} or both: the relay verifies every request`);
  const repo = relayRepo(env[RELAY_ENV.repo] ?? "", env[RELAY_ENV.forge]);
  const dir = workspace(repo.url);
  // The token as a git header, for this process's git calls only.
  const probe = { ...process.env, ...gitAuthEnv(repo.forge === "github" ? "x-access-token" : "oauth2", token) };
  const ls = spawnSync("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: dir, encoding: "utf-8", env: probe });
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(ls.stdout ?? "")?.[1];
  if (!branch) throw new ConfigError(`cannot read ${repo.path} with the token: ${(ls.stderr ?? "").trim() || "no default branch"}`);
  const checked = await checkToken(repo, token, branch, o.fetch);
  if ("error" in checked) throw new ConfigError(`the relay holds only an approve-only token, and this one is more: ${checked.error}`);
  Object.assign(process.env, gitAuthEnv(checked.user, token));
  const principal = env[RELAY_ENV.principal]?.trim() || DEFAULT_RELAY_PRINCIPAL;
  if (/[\r\n]/.test(principal)) throw new ConfigError(`${RELAY_ENV.principal} is one principal on one line`);
  const deps = workspaceDeps(dir, branch, principal);
  const settings: RelaySettings = {
    ...(env[RELAY_ENV.slackSecret] ? { slackSecret: env[RELAY_ENV.slackSecret] } : {}),
    ...(env[RELAY_ENV.teamsSecret] ? { teamsSecret: env[RELAY_ENV.teamsSecret] } : {}),
    ...(env[RELAY_ENV.slackResponse] ? { slackResponse: env[RELAY_ENV.slackResponse]!.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
  let turn: Promise<unknown> = Promise.resolve();
  const server = createServer((req, res) => {
    const next = turn.then(async () => {
      let out: RelayResponse;
      try {
        const body = await readBody(req);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : v]));
        out = await handleRelay({ method: req.method ?? "GET", path: req.url ?? "/", headers, body }, settings, deps, o.fetch, log);
      } catch (e) {
        out = plain(400, (e as Error).message);
      }
      res.writeHead(out.status, out.headers).end(out.body);
    });
    turn = next.catch(() => undefined);
  });
  await new Promise<void>((ok) => server.listen(o.port, ok));
  log(`serving ${repo.path} (${repo.forge}, default branch ${branch}) on port ${o.port}, as ${principal}, pushing as ${checked.user}`);
  return server;
}
