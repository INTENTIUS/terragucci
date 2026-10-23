import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, parseLedger } from "../src/apply";
import type { Fetch } from "../src/forge";
import { noteMarker } from "../src/review";
import { gateSealPayload } from "../src/seal";
import { git, write } from "./helpers";
import { signerLine, sshsig, sshKey } from "./sshsig";
import { T, setup, approve } from "./apply-helpers";

describe("a wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("when chant.workspace.json names the gate under identity.gates", () => {
    const alice = sshKey();
    const agent = sshKey();
    const base = {
      "chant.workspace.json": JSON.stringify({ name: "x", schema: 1, minReader: "0.102.0", members: [], identity: { gates: { "wave-1": {} } } }),
      // The agent's key is not here: agent keys never go in the signers file.
      ".chant/allowed_signers": `${signerLine("alice", alice)}\n`,
    };

    async function waiting(): Promise<{ work: string; origin: string; bin: string; log: string; digest: string; opts: Parameters<typeof applyWave>[1] }> {
      const s = setup(base);
      const opts = { wave: 1, layers: [["a"]], binary: s.bin, gate: "always" as const, env: {} };
      expect(await applyWave(s.work, { ...opts, now: T(1) })).toBe(3);
      const digest = parseLedger(git(s.origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
      return { ...s, digest, opts };
    }

    const approval = (digest: string, by: string) => ({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: by, timestamp: T(2), planDigest: digest });
    const sealed = (digest: string, by: string, key: ReturnType<typeof sshKey>) => {
      const a = approval(digest, by);
      return { ...a, seal: { signer: by, key: "SHA256:test", signature: sshsig(key, gateSealPayload(a), "chant-gate") } };
    };

    it("an unsealed approval of the digest does not let the wave proceed, and the wave says why", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, log, digest, opts } = await waiting();
      approve(origin, approval(digest, "alice"));
      expect(await applyWave(work, { ...opts, now: T(3) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      expect(lines.join("\n")).toMatch(/carries no seal \(terragucci approve --sign\)/);
      expect(lines.join("\n")).toContain(`--plan ${digest} --sign`);
    });

    it("an approval sealed by a key the signers file does not list does not let the wave proceed", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, log, digest, opts } = await waiting();
      approve(origin, sealed(digest, "agent", agent));
      expect(await applyWave(work, { ...opts, now: T(3) })).toBe(3);
      // Nor does the agent's key pass for alice.
      approve(origin, sealed(digest, "alice", agent));
      expect(await applyWave(work, { ...opts, now: T(3) })).toBe(3);
      expect(existsSync(log)).toBe(false);
    });

    it("an approval sealed by alice's key, which the signers file at base lists, lets the wave apply", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, log, digest, opts } = await waiting();
      approve(origin, sealed(digest, "alice", alice));
      expect(await applyWave(work, { ...opts, now: T(3) })).toBe(0);
      expect(existsSync(log)).toBe(true);
    });

    it("a sealed approval whose digest was edited after sealing does not count", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, log, digest, opts } = await waiting();
      const s = sealed("sha256:other", "alice", alice);
      approve(origin, { ...s, planDigest: digest });
      expect(await applyWave(work, { ...opts, now: T(3) })).toBe(3);
      expect(existsSync(log)).toBe(false);
    });

    it("applied from an open pull request with --base, a signer the pull request adds does not count", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const mallory = sshKey();
      const s = setup(base);
      // The pull request adds mallory's key in one commit and goes on in another, so its head's first parent has the key.
      git(s.work, "checkout", "-q", "-b", "pr");
      write(s.work, { ".chant/allowed_signers": `${signerLine("alice", alice)}\n${signerLine("mallory", mallory)}\n` });
      git(s.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "add a signer");
      git(s.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more");
      const opts = { wave: 1, layers: [["a"]], binary: s.bin, gate: "always" as const, env: {}, base: "main" };
      expect(await applyWave(s.work, { ...opts, now: T(1) })).toBe(3);
      const digest = parseLedger(git(s.origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
      approve(s.origin, sealed(digest, "mallory", mallory));
      expect(await applyWave(s.work, { ...opts, now: T(3) })).toBe(3);
      expect(existsSync(s.log)).toBe(false);
      // Read from the pull request's own history instead, the rule would take mallory's key.
      const { base: _base, ...fromHead } = opts;
      expect(await applyWave(s.work, { ...fromHead, now: T(3) })).toBe(0);
    });

    it("a wave added after init, which identity.gates does not list, counts only a sealed approval too", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const s = setup({ ...base, "chant.workspace.json": JSON.stringify({ name: "x", schema: 1, minReader: "0.102.0", members: [], identity: { gates: { "wave-2": {} } } }) });
      const opts = { wave: 1, layers: [["a"]], binary: s.bin, gate: "always" as const, env: {} };
      expect(await applyWave(s.work, { ...opts, now: T(1) })).toBe(3);
      const digest = parseLedger(git(s.origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
      approve(s.origin, approval(digest, "alice"));
      expect(await applyWave(s.work, { ...opts, now: T(3) })).toBe(3);
      expect(existsSync(s.log)).toBe(false);
      expect(lines.join("\n")).toContain("does not list wave-1 under identity.gates");
      expect(lines.join("\n")).toMatch(/carries no seal \(terragucci approve --sign\)/);
      approve(s.origin, sealed(digest, "alice", alice));
      expect(await applyWave(s.work, { ...opts, now: T(5) })).toBe(0);
      expect(existsSync(s.log)).toBe(true);
    });
  });

  describe("the approval mode", () => {
    const alice = sshKey();
    const approval = (digest: string, at: number) => ({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(at), planDigest: digest });
    const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} });
    const digestOf = (origin: string) => parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;

    it("under ledger, the default, the wave says so, prints the command without --sign, and an unsigned approval applies it", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, log } = setup();
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
      const digest = digestOf(origin);
      expect(lines.join("\n")).toContain("approval ledger (the default)");
      expect(lines).toContain(`  terragucci approve wave-1 --plan ${digest}`);
      approve(origin, approval(digest, 2));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
      expect(existsSync(log)).toBe(true);
    });

    it("approval: sealed in the config at base seals the wave with no identity.gates", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, log } = setup({ "terragucci.yml": "approval: sealed\n", ".chant/allowed_signers": `${signerLine("alice", alice)}\n` });
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
      const digest = digestOf(origin);
      expect(lines).toContain(`  terragucci approve wave-1 --plan ${digest} --sign`);
      approve(origin, approval(digest, 2));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(3);
      expect(lines.join("\n")).toMatch(/carries no seal \(terragucci approve --sign\)/);
      const a = approval(digest, 4);
      approve(origin, { ...a, seal: { signer: "alice", key: "SHA256:test", signature: sshsig(alice, gateSealPayload(a), "chant-gate") } });
      expect(await applyWave(work, { ...opts(bin), now: T(5) })).toBe(0);
      expect(existsSync(log)).toBe(true);
    });

    it("a merge that switches approval: sealed to ledger is judged by the sealed rule at base, and the next commit by ledger", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, log } = setup({ "terragucci.yml": "approval: sealed\n", ".chant/allowed_signers": `${signerLine("alice", alice)}\n` });
      write(work, { "terragucci.yml": "approval: ledger\n" });
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "switch to ledger");
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
      expect(lines.join("\n")).toContain("approval sealed (approval: sealed in the config at base)");
      approve(origin, approval(digestOf(origin), 2));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "the next merge");
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(0);
      expect(existsSync(log)).toBe(true);
    });

    it("under pr-review, the merged pull request's approval of its head applies the wave when it reviewed these plans, and is refused when they moved", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, log } = setup({ "terragucci.yml": "approval: pr-review\n" });
      const head = "a".repeat(40);
      const merge = "b".repeat(40);
      const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.test", TG_TOKEN: "t", TG_SHA: merge };
      const forge = (reviews: unknown[], digest: string | null): Fetch => async (url) => {
        const path = url.replace("https://api.test/", "").split("?")[0];
        const body: Record<string, unknown> = {
          [`repos/acme/infra/commits/${merge}/pulls`]: [{ number: 7, head: { sha: head }, user: { login: "author" }, merge_commit_sha: merge, merged_at: "x" }],
          "repos/acme/infra/pulls/7": { number: 7, head: { sha: head }, user: { login: "author" } },
          "repos/acme/infra/pulls/7/commits": [],
          "repos/acme/infra/pulls/7/reviews": reviews,
          "repos/acme/infra/collaborators/alice/permission": { permission: "write" },
          "repos/acme/infra/issues/7/comments": [{ body: noteMarker({ head, waves: [{ number: 1, digest, waits: true }] }) }],
        };
        return (path! in body ? { ok: true, status: 200, json: async () => body[path!], text: async () => JSON.stringify(body[path!]) } : { ok: false, status: 404, json: async () => ({}), text: async () => "{}" }) as never;
      };
      const review = { user: { login: "alice" }, state: "APPROVED", commit_id: head };
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([], null), now: T(1) })).toBe(3);
      const digest = digestOf(origin);
      expect(lines.join("\n")).toMatch(/no review approves this wave: pull request 7 is not approved: no reviewer other than its authors approved its head aaaaaaaa/);
      // The review saw other plans: nothing applies.
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([review], "jcs1-sha256:other"), now: T(2) })).toBe(4);
      expect(existsSync(log)).toBe(false);
      expect(lines.join("\n")).toContain("but the plans changed since that review");
      // The wave plans what the review saw: in this fixture every root of the wave changes, so the review digest is the wave's digest.
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([review], digest), now: T(3) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      const recorded = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).resolutions;
      expect(recorded.at(-1)).toMatchObject({ gate: "wave-1", planDigest: digest, resolvedBy: "alice", via: "pr-review", pr: 7, head, reviewers: ["alice"] });
    });

    it("the pipeline's --approval sealed holds when the config names no mode", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, bin, log } = setup({ ".chant/allowed_signers": `${signerLine("alice", alice)}\n` });
      expect(await applyWave(work, { ...opts(bin), approval: "sealed", now: T(1) })).toBe(3);
      approve(origin, approval(digestOf(origin), 2));
      expect(await applyWave(work, { ...opts(bin), approval: "sealed", now: T(3) })).toBe(3);
      expect(existsSync(log)).toBe(false);
    });
  });
});
