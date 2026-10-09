import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLedger, type GateLedger, type ResolutionRecord } from "../src/apply";
import { checkToken, decideClick, gitAuthEnv, handleRelay, principalFor, relayRepo, slackClick, slackSignature, teamsClick, teamsSignature, verifySlack, verifyTeams, workspaceDeps, type Click, type RelayDeps } from "../src/relay";
import { parseSigners } from "../src/seal";
import { git, tmp, write } from "./helpers";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1,teams:0000-aaaa ssh-ed25519 ${KEY}\nbob@acme.com ssh-ed25519 ${KEY}\n`;
const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
const pending = (gate: string, digest: string, h: number) => ({ version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(h), expiresAt: T(h + 48), planDigest: digest });
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const D = "jcs1-sha256:" + "a".repeat(64);
const D2 = "jcs1-sha256:" + "b".repeat(64);

function deps(o: { mode?: "ledger" | "pr-review" | "sealed"; ledger?: GateLedger; resume?: number } = {}): RelayDeps & { recorded: ResolutionRecord[] } {
  const recorded: ResolutionRecord[] = [];
  return {
    recorded,
    principal: "terragucci-relay",
    rule: async () => ({ mode: o.mode ?? "ledger", signers: parseSigners(SIGNERS), signersPath: ".chant/allowed_signers", ...(o.resume ? { resume: o.resume } : {}) }),
    ledger: () => o.ledger ?? parseLedger(jsonl(pending("wave-1", D, 1))),
    record: (r) => void recorded.push(r),
    now: () => new Date(T(5)),
  };
}

const slackBody = (user: string, action: string, value: unknown = { wave: 1, plan: D }): string =>
  new URLSearchParams({
    payload: JSON.stringify({ type: "block_actions", user: { id: user, username: "alice", team_id: "T1" }, team: { id: "T1" }, actions: [{ action_id: action, value: JSON.stringify(value) }], response_url: "https://hooks.slack.com/actions/T1/1/x", container: { message_ts: "1700000000.0001" } }),
  }).toString();

describe("relay: signatures", () => {
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  it("verifies Slack's v0 signature over the timestamp and the raw body, within five minutes", () => {
    const body = "payload=%7B%7D";
    const sig = slackSignature("s3cret", ts, body);
    expect(sig).toBe(`v0=${createHmac("sha256", "s3cret").update(`v0:${ts}:${body}`).digest("hex")}`);
    expect(verifySlack({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body, "s3cret", now)).toBeNull();
    expect(verifySlack({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body + "x", "s3cret", now)).toMatch(/does not verify/);
    expect(verifySlack({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body, "s3cret", now + 301_000)).toMatch(/five minutes/);
    expect(verifySlack({}, body, "s3cret", now)).toMatch(/not signed/);
    expect(verifySlack({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body, "", now)).toMatch(/SLACK_SIGNING_SECRET is empty/);
  });

  it("verifies a Teams outgoing webhook's HMAC with the base64 key Teams gave", () => {
    const secret = Buffer.from("teams-key-32-bytes-long-enough!!").toString("base64");
    const body = JSON.stringify({ text: "hi" });
    const auth = teamsSignature(secret, body);
    expect(auth).toBe(`HMAC ${createHmac("sha256", Buffer.from(secret, "base64")).update(body).digest("base64")}`);
    expect(verifyTeams({ authorization: auth }, body, secret)).toBeNull();
    expect(verifyTeams({ authorization: auth }, body.replace("hi", "ho"), secret)).toMatch(/does not verify/);
    expect(verifyTeams({}, body, secret)).toMatch(/not signed/);
  });
});

describe("relay: clicks", () => {
  it("reads a Slack button click: the user, the action, the wave and digest, and where to reply", () => {
    expect(slackClick(slackBody("U1", "terragucci-approve"))).toEqual({ app: "slack", chatUser: "slack:T1/U1", display: "alice", action: "approve", wave: 1, plan: D, responseUrl: "https://hooks.slack.com/actions/T1/1/x", thread: "1700000000.0001" });
    expect(slackClick(slackBody("U1", "terragucci-decline"))).toMatchObject({ action: "decline" });
    expect(slackClick(slackBody("U1", "someone-else"))).toEqual({ error: "the button someone-else is not terragucci's" });
    expect(slackClick(slackBody("U1", "terragucci-approve", { wave: 0, plan: D }))).toEqual({ error: "the button names no wave and digest" });
    expect(slackClick("payload=" + encodeURIComponent(JSON.stringify({ type: "view_submission" })))).toEqual({ error: "a Slack view_submission payload is not a button click" });
  });

  it("reads a Teams reply, its mention and markup dropped", () => {
    const body = JSON.stringify({ type: "message", text: `<at>terragucci</at>&nbsp;approve wave-2 ${D}`, from: { id: "29:x", name: "Alice", aadObjectId: "0000-aaaa" } });
    expect(teamsClick(body)).toEqual({ app: "teams", chatUser: "teams:0000-aaaa", display: "Alice", action: "approve", wave: 2, plan: D });
    expect(teamsClick(JSON.stringify({ text: "<at>terragucci</at> please approve", from: { aadObjectId: "x" } }))).toMatchObject({ error: expect.stringMatching(/approve wave-<k> <digest>/) });
  });

  it("maps a chat user to the principal on the signers file line that lists them, and nobody else", () => {
    const signers = parseSigners(SIGNERS);
    expect(principalFor(signers, "slack:T1/U1")).toBe("alice@acme.com");
    expect(principalFor(signers, "teams:0000-AAAA")).toBe("alice@acme.com");
    expect(principalFor(signers, "slack:T1/U2")).toBeUndefined();
    expect(principalFor(null, "slack:T1/U1")).toBeUndefined();
    // One chat id on two people's lines maps to neither.
    expect(principalFor(parseSigners(SIGNERS + `carol@acme.com,slack:T1/U1 ssh-ed25519 ${KEY}\n`), "slack:T1/U1")).toBeUndefined();
  });
});

describe("relay: deciding a click", () => {
  const approveClick: Click = { app: "slack", chatUser: "slack:T1/U1", display: "alice", action: "approve", wave: 1, plan: D };

  it("records an approval of exactly the digest waiting, as the mapped principal, relayed by the relay", async () => {
    const d = deps({ resume: 5 });
    const a = await decideClick(approveClick, d);
    expect(a.ok).toBe(true);
    expect(d.recorded).toEqual([{ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice@acme.com", relayedBy: "terragucci-relay", timestamp: T(5), planDigest: D, via: "slack" }]);
    expect(a.text).toBe(`wave-1 approved by alice@acme.com, relayed by terragucci-relay, for ${D} and no other plans. The resume job applies it within 5 minutes.`);
  });

  it("refuses an unmapped user, and records nothing", async () => {
    const d = deps();
    const a = await decideClick({ ...approveClick, chatUser: "slack:T1/U9", display: "mallory" }, d);
    expect(a.ok).toBe(false);
    expect(a.text).toMatch(/^Refused: mallory \(slack:T1\/U9\) is not mapped to a principal in \.chant\/allowed_signers/);
    expect(d.recorded).toEqual([]);
  });

  it("approves nothing when the plans moved past the digest the message showed", async () => {
    const d = deps({ ledger: parseLedger(jsonl(pending("wave-1", D, 1), pending("wave-1", D2, 2))) });
    const a = await decideClick(approveClick, d);
    expect(a).toEqual({ ok: false, text: `Not approved: wave-1 does not wait for ${D}; it waits for ${D2}. The plans moved since this message, or they were approved already. Read the plans waiting, then approve their digest.` });
    expect(d.recorded).toEqual([]);
  });

  it("under approval: sealed, records nothing: only the approver's own key seals", async () => {
    const d = deps({ mode: "sealed" });
    const a = await decideClick(approveClick, d);
    expect(a.ok).toBe(false);
    expect(a.text).toContain(`terragucci approve wave-1 --plan ${D} --sign`);
    expect(d.recorded).toEqual([]);
  });

  it("a decline records nothing and names who declined", async () => {
    const d = deps();
    const a = await decideClick({ ...approveClick, action: "decline" }, d);
    expect(a).toEqual({ ok: true, text: `wave-1 declined by alice@acme.com for ${D}. Nothing was approved; the wave keeps waiting, and applies only once someone approves its plans.` });
    expect(d.recorded).toEqual([]);
  });
});

describe("relay: HTTP", () => {
  const secret = "slack-secret";
  const signed = (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { "x-slack-request-timestamp": ts, "x-slack-signature": slackSignature(secret, ts, body) };
  };
  const recorder = () => {
    const posts: { url: string; body: any }[] = [];
    const f = (async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: JSON.parse(init?.body ?? "null") });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }) as any;
    return { posts, f };
  };

  it("refuses a request it cannot verify with 401, and records nothing", async () => {
    const d = deps();
    const body = slackBody("U1", "terragucci-approve");
    const r = await handleRelay({ method: "POST", path: "/slack", headers: { ...signed(body), "x-slack-signature": "v0=00" }, body }, { slackSecret: secret }, d);
    expect(r.status).toBe(401);
    expect(d.recorded).toEqual([]);
  });

  it("answers a Slack click in the message's thread, through Slack's response_url", async () => {
    const d = deps();
    const { posts, f } = recorder();
    const body = slackBody("U9", "terragucci-approve");
    const r = await handleRelay({ method: "POST", path: "/slack", headers: signed(body), body }, { slackSecret: secret }, d, f);
    expect(r.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://hooks.slack.com/actions/T1/1/x");
    expect(posts[0]!.body).toMatchObject({ response_type: "in_channel", replace_original: false, thread_ts: "1700000000.0001" });
    expect(posts[0]!.body.text).toMatch(/^Refused: alice \(slack:T1\/U9\)/);
    expect(d.recorded).toEqual([]);
  });

  it("posts no reply to a response_url that is not Slack's", async () => {
    const { posts, f } = recorder();
    const body = slackBody("U1", "terragucci-decline");
    const lines: string[] = [];
    await handleRelay({ method: "POST", path: "/slack", headers: signed(body), body }, { slackSecret: secret, slackResponse: ["https://elsewhere/"] }, deps(), f, (l) => void lines.push(l));
    expect(posts).toEqual([]);
    expect(lines.at(-1)).toMatch(/not Slack's/);
  });

  it("answers a Teams reply in the reply Teams posts", async () => {
    const key = Buffer.from("k".repeat(32)).toString("base64");
    const d = deps();
    const body = JSON.stringify({ type: "message", text: `<at>terragucci</at> approve wave-1 ${D}`, from: { name: "Alice", aadObjectId: "0000-aaaa" } });
    const r = await handleRelay({ method: "POST", path: "/teams", headers: { authorization: teamsSignature(key, body) }, body }, { teamsSecret: key }, d);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ type: "message", text: expect.stringMatching(/^wave-1 approved by alice@acme\.com, relayed by terragucci-relay/) });
    expect(d.recorded[0]).toMatchObject({ resolvedBy: "alice@acme.com", via: "teams" });
  });
});

describe("relay: the token", () => {
  const forge = (routes: Record<string, unknown>, headers: Record<string, string> = {}) =>
    (async (url: string) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const hit = Object.entries(routes).find(([p]) => path === p);
      return { ok: Boolean(hit), status: hit ? 200 : 404, json: async () => hit?.[1], text: async () => "", headers: { get: (n: string) => headers[n] ?? null } };
    }) as any;

  it("on Forgejo, takes a token whose user neither administers the repo nor may push to the default branch, and pushes as that user", async () => {
    const repo = relayRepo("http://forgejo:3000/acme/infra.git", "forgejo");
    const ok = forge({ "/api/v1/user": { login: "relay-bot" }, "/api/v1/repos/acme/infra": { permissions: { admin: false, push: true } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: false } });
    expect(await checkToken(repo, "t", "main", ok)).toEqual({ user: "relay-bot" });
    const admin = forge({ "/api/v1/user": { login: "root" }, "/api/v1/repos/acme/infra": { permissions: { admin: true } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: true } });
    expect(await checkToken(repo, "t", "main", admin)).toEqual({ error: "the token's user administers acme/infra" });
    const pusher = forge({ "/api/v1/user": { login: "dev" }, "/api/v1/repos/acme/infra": { permissions: { admin: false } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: true } });
    expect(await checkToken(repo, "t", "main", pusher)).toMatchObject({ error: expect.stringMatching(/may push to main/) });
  });

  it("on GitHub, refuses a classic token and an unprotected default branch", async () => {
    const repo = relayRepo("https://github.com/acme/infra.git");
    const routes = { "/repos/acme/infra": { permissions: { admin: false, push: true } }, "/repos/acme/infra/branches/main": { protected: true } };
    expect(await checkToken(repo, "t", "main", forge(routes))).toEqual({ user: "x-access-token" });
    expect(await checkToken(repo, "t", "main", forge(routes, { "x-oauth-scopes": "repo" }))).toMatchObject({ error: expect.stringMatching(/classic token/) });
    expect(await checkToken(repo, "t", "main", forge({ ...routes, "/repos/acme/infra/branches/main": { protected: false } }))).toMatchObject({ error: expect.stringMatching(/not protected/) });
  });

  it("on GitLab, refuses the api scope, a Maintainer, and a push level the user holds", async () => {
    const repo = relayRepo("https://gitlab.com/acme/infra.git");
    const base = { "/api/v4/personal_access_tokens/self": { scopes: ["write_repository", "read_api"] }, "/api/v4/projects/acme%2Finfra": { permissions: { project_access: { access_level: 30 } } }, "/api/v4/projects/acme%2Finfra/protected_branches/main": { push_access_levels: [{ access_level: 40 }] } };
    expect(await checkToken(repo, "t", "main", forge(base))).toEqual({ user: "oauth2" });
    expect(await checkToken(repo, "t", "main", forge({ ...base, "/api/v4/personal_access_tokens/self": { scopes: ["api"] } }))).toMatchObject({ error: expect.stringMatching(/scopes api/) });
    expect(await checkToken(repo, "t", "main", forge({ ...base, "/api/v4/projects/acme%2Finfra": { permissions: { project_access: { access_level: 40 } } } }))).toMatchObject({ error: expect.stringMatching(/Maintainer/) });
    expect(await checkToken(repo, "t", "main", forge({ ...base, "/api/v4/projects/acme%2Finfra/protected_branches/main": { push_access_levels: [{ access_level: 30 }] } }))).toMatchObject({ error: expect.stringMatching(/may push to main/) });
  });

  it("refuses a clone address that carries a credential, and keeps the token out of every file", () => {
    expect(() => relayRepo("https://bot:t@github.com/acme/infra.git")).toThrow(/must not carry a credential/);
    expect(gitAuthEnv("relay-bot", "tok")).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("relay-bot:tok").toString("base64")}`, GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("relay: over a repo", () => {
  it("reads the signers and the mode from the default branch, and pushes the approval to chant/lifecycle", async () => {
    const dir = tmp("tg-relay-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const main = join(dir, "main");
    git(dir, "init", "-q", "-b", "main", main);
    write(main, { "terragucci.yml": "binary: tofu\napply:\n  resume: 5\n", ".chant/allowed_signers": SIGNERS });
    git(main, "add", "-A");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main");
    git(main, "push", "-q", origin, "main");
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { "_gates/tf-apply.jsonl": jsonl(pending("wave-1", D, 1)) });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const ws = join(dir, "ws");
    git(dir, "init", "-q", ws);
    git(ws, "remote", "add", "origin", origin);

    const d = workspaceDeps(ws, "main", "terragucci-relay");
    expect(await d.rule()).toMatchObject({ mode: "ledger", signersPath: ".chant/allowed_signers", resume: 5 });
    const a = await decideClick({ app: "slack", chatUser: "slack:T1/U1", display: "alice", action: "approve", wave: 1, plan: D }, d);
    expect(a.ok).toBe(true);
    const lines = parseLedger(git(dir, "--git-dir", origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    expect(lines.resolutions).toMatchObject([{ gate: "wave-1", resolvedBy: "alice@acme.com", relayedBy: "terragucci-relay", planDigest: D, via: "slack" }]);
    // The wave no longer waits, so a second click approves nothing.
    expect((await decideClick({ app: "slack", chatUser: "slack:T1/U1", display: "alice", action: "approve", wave: 1, plan: D }, d)).ok).toBe(false);
  });
});
