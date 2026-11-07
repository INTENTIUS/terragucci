/**
 * `terragucci relay` (./src/relay-host.ts): the host's approve-only token
 * check and checkout, and chant's relay (chant#4611) deciding a click over a
 * repo laid out as terragucci lays it out.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relayToken } from "@intentius/chant/notify";
import { decideRelayClick } from "@intentius/chant/notify-relay";
import { checkoutRelayDeps } from "@intentius/chant/cli/handlers/notify-relay";
import { parseLedger } from "../src/apply";
import { TERRAGUCCI_WORDS } from "../src/ci-words";
import { chantRelayEnv, checkToken, gitAuthEnv, relayCheckout, relayRepo } from "../src/relay-host";
import { git, tmp, write } from "./helpers";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1,teams:0000-aaaa ssh-ed25519 ${KEY}\nbob@acme.com ssh-ed25519 ${KEY}\n`;
// Hours from an hour ago: chant counts a pending fact only until it expires.
const T = (h: number): string => new Date(Date.now() - 3600_000 + h * 3600_000).toISOString();
const pending = (gate: string, digest: string, h: number) => ({ version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(h), expiresAt: T(h + 48), planDigest: digest });
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const D = "jcs1-sha256:" + "a".repeat(64);
const RELAY_KEY = "relay-key-for-tests";

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

describe("relay: the host's settings", () => {
  it("maps terragucci's principal and Slack response names onto chant's, and listens on every interface", () => {
    expect(chantRelayEnv({ TERRAGUCCI_RELAY_PRINCIPAL: "acme-relay", TERRAGUCCI_RELAY_SLACK_RESPONSE: "https://hooks.slack.com/" }, 8080)).toEqual({ CHANT_RELAY_PRINCIPAL: "acme-relay", CHANT_RELAY_PORT: "8080", CHANT_RELAY_HOST: "0.0.0.0", CHANT_RELAY_SLACK_RESPONSE: "https://hooks.slack.com/" });
    expect(chantRelayEnv({}, 9000)).toMatchObject({ CHANT_RELAY_PRINCIPAL: "terragucci-relay", CHANT_RELAY_PORT: "9000" });
    expect(() => chantRelayEnv({ TERRAGUCCI_RELAY_PRINCIPAL: "a\nb" }, 1)).toThrow(/one principal on one line/);
  });
});

describe("relay: chant's relay over terragucci's repo", () => {
  it("approves exactly the wave waiting for the signed digest, as the mapped principal, relayed by the relay, and nothing twice", async () => {
    const dir = tmp("tg-relay-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const main = join(dir, "main");
    git(dir, "init", "-q", "-b", "main", main);
    write(main, { "terragucci.yml": "binary: tofu\n", ".chant/allowed_signers": SIGNERS });
    git(main, "add", "-A");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main");
    git(main, "push", "-q", origin, "main");
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { "_gates/tf-apply.jsonl": jsonl(pending("wave-1", D, 1)) });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");

    const checkout = relayCheckout(origin, "main");
    const deps = checkoutRelayDeps(checkout, "terragucci-relay");
    const click = (user: string) => ({
      app: "slack" as const,
      chatUser: user,
      display: user,
      action: "approve" as const,
      token: relayToken(RELAY_KEY, { id: "e1", source: TERRAGUCCI_WORDS.notify.source, at: new Date().toISOString(), gate: "wave-1", digest: D }),
    });
    const prev = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL, cwd: process.cwd() };
    Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    // As relay-host.ts runs it: in the checkout. chant's approve writes and pushes the ledger of the process's directory (chant#4760).
    process.chdir(checkout);
    try {
      // A chat user no signers line lists is refused, and nothing is recorded.
      expect((await decideRelayClick(click("slack:T1/U9"), { key: RELAY_KEY }, deps)).ok).toBe(false);
      const a = await decideRelayClick(click("slack:T1/U1"), { key: RELAY_KEY }, deps);
      expect(a).toMatchObject({ ok: true });
      const lines = parseLedger(git(dir, "--git-dir", origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
      expect(lines.resolutions).toMatchObject([{ gate: "wave-1", resolvedBy: "alice@acme.com", relayedBy: "terragucci-relay", planDigest: D }]);
      // A button not signed with the relay key approves nothing.
      expect((await decideRelayClick(click("slack:T1/U1"), { key: "another-key" }, deps)).ok).toBe(false);
    } finally {
      process.chdir(prev.cwd);
      process.env.GIT_AUTHOR_NAME = prev.name;
      process.env.GIT_AUTHOR_EMAIL = prev.email;
    }
  });
});
