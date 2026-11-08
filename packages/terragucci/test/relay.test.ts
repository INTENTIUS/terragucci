/**
 * `terragucci relay` (./src/relay-host.ts): terragucci's settings as chant's
 * relay flags, and chant's relay (chant#4611) deciding a click over a repo
 * laid out as terragucci lays it out.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relayToken } from "@intentius/chant/notify";
import { decideRelayClick } from "@intentius/chant/notify-relay";
import { checkoutRelayDeps } from "@intentius/chant/cli/handlers/notify-relay";
import { parseLedger } from "../src/apply";
import { TERRAGUCCI_WORDS } from "../src/ci-words";
import { relayCheckout } from "@intentius/chant/notify-relay-repo";
import { chantRelayEnv, relayArgv } from "../src/relay-host";
import { git, tmp, write } from "./helpers";

/** chant's checkout of the default branch, as `terragucci relay` gets it. */
async function checkedOut(url: string): Promise<string> {
  const r = await relayCheckout(url, "main", process.env);
  if ("error" in r) throw new Error(r.error);
  return r.dir;
}

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1,teams:0000-aaaa ssh-ed25519 ${KEY}\nbob@acme.com ssh-ed25519 ${KEY}\n`;
// Hours from an hour ago: chant counts a pending fact only until it expires.
const T = (h: number): string => new Date(Date.now() - 3600_000 + h * 3600_000).toISOString();
const pending = (gate: string, digest: string, h: number) => ({ version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(h), expiresAt: T(h + 48), planDigest: digest });
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const D = "jcs1-sha256:" + "a".repeat(64);
const RELAY_KEY = "relay-key-for-tests";

describe("relay: the host's settings", () => {
  it("hands chant terragucci's repo, token variable and forge, and listens on every interface", () => {
    expect(relayArgv({ TERRAGUCCI_RELAY_REPO: "https://github.com/acme/infra.git", TERRAGUCCI_RELAY_TOKEN: "t" }, 8080)).toEqual(["notify", "relay", "--repo", "https://github.com/acme/infra.git", "--token-env", "TERRAGUCCI_RELAY_TOKEN", "--host", "0.0.0.0", "--port", "8080"]);
    expect(relayArgv({ TERRAGUCCI_RELAY_REPO: "https://git.acme.test/o/r.git", TERRAGUCCI_RELAY_FORGE: "forgejo", CHANT_RELAY_HOST: "127.0.0.1" }, 9000)).toEqual(["notify", "relay", "--repo", "https://git.acme.test/o/r.git", "--token-env", "TERRAGUCCI_RELAY_TOKEN", "--forge", "forgejo", "--host", "127.0.0.1", "--port", "9000"]);
    expect(() => relayArgv({}, 1)).toThrow(/TERRAGUCCI_RELAY_REPO is empty/);
  });

  it("maps terragucci's principal and Slack response names onto chant's", () => {
    expect(chantRelayEnv({ TERRAGUCCI_RELAY_PRINCIPAL: "acme-relay", TERRAGUCCI_RELAY_SLACK_RESPONSE: "https://hooks.slack.com/" })).toEqual({ CHANT_RELAY_PRINCIPAL: "acme-relay", CHANT_RELAY_SLACK_RESPONSE: "https://hooks.slack.com/" });
    expect(chantRelayEnv({})).toEqual({});
    expect(() => chantRelayEnv({ TERRAGUCCI_RELAY_PRINCIPAL: "a\nb" })).toThrow(/one principal on one line/);
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

    const checkout = await checkedOut(origin);
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
