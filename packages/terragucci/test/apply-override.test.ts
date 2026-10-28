import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLIED_PATH, appliedPathFor, applyWave, parseApplied, parseLedger, type PendingRecord } from "../src/apply";
import type { Fetch } from "../src/forge";
import type { PolicyExec } from "../src/report/policy";
import { noteMarker } from "../src/review";
import { gateSealPayload } from "../src/seal";
import { OVERRIDE_LEDGER, OVERRIDE_OP, overrideDigest } from "../src/override";
import { git, tmp, write } from "./helpers";
import { signerLine, sshsig, sshKey } from "./sshsig";
import { T, setup, approve } from "./apply-helpers";

describe("a wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("an approval a wave applied under", () => {
    const alice = sshKey();
    const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} });
    const pendingOf = (origin: string) => parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending;
    const appliedOf = (origin: string) => parseApplied(git(origin, "show", `chant/lifecycle:${APPLIED_PATH}`));
    const approval = (digest: string, at: number) => ({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(at), planDigest: digest });
    const sealedApproval = (digest: string, at: number) => {
      const a = approval(digest, at);
      return { ...a, seal: { signer: "alice", key: "SHA256:test", signature: sshsig(alice, gateSealPayload(a), "chant-gate") } };
    };
    /** The next merge: root a plans another value. */
    const moveA = (work: string) =>
      writeFileSync(join(work, "..", "plans", "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "2" }, after_unknown: {} } }] }));

    for (const mode of ["ledger", "sealed"] as const) {
      const files: Record<string, string> = mode === "sealed" ? { "terragucci.yml": "approval: sealed\n", ".chant/allowed_signers": `${signerLine("alice", alice)}\n` } : {};
      const approveAs = mode === "sealed" ? sealedApproval : approval;

      it(`under ${mode}, once the approved plans applied, the next plans of the wave wait with their approve command`, async () => {
        const lines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
        const { work, origin, bin, log } = setup(files);
        expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
        const first = pendingOf(origin)[0]!.planDigest!;
        approve(origin, approveAs(first, 2));
        expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
        expect(existsSync(log)).toBe(true);
        expect(appliedOf(origin)).toEqual([expect.objectContaining({ kind: "applied", gate: "wave-1", planDigest: first, approvedAt: T(2), approvedBy: "alice", wave: { number: 1, name: "wave-1" } })]);
        moveA(work);
        lines.length = 0;
        expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(3);
        const second = pendingOf(origin).at(-1)!.planDigest!;
        expect(second).not.toBe(first);
        expect(lines.join("\n")).toContain(`the approval of ${first} by alice was used by the apply of those plans`);
        expect(lines.join("\n")).not.toContain("planned differently since");
        expect(lines).toContain(`  terragucci approve wave-1 --plan ${second}${mode === "sealed" ? " --sign" : ""}`);
        // The approval of the new plans applies them, and is recorded as used in turn.
        approve(origin, approveAs(second, 5));
        expect(await applyWave(work, { ...opts(bin), now: T(6) })).toBe(0);
        expect(appliedOf(origin).map((a) => a.planDigest)).toEqual([first, second]);
      }, 60_000); // four waves: about 8s alone, past 20s under a full parallel run

      it(`under ${mode}, an approval of plans that never applied is stale: the moved plans are refused`, async () => {
        const lines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
        const { work, origin, bin, log } = setup(files);
        expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
        const first = pendingOf(origin)[0]!.planDigest!;
        approve(origin, approveAs(first, 2));
        moveA(work);
        expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(4);
        expect(existsSync(log)).toBe(false);
        expect(lines.join("\n")).toContain("approved by alice, but these roots planned differently since: a");
        expect(() => git(origin, "show", `chant/lifecycle:${APPLIED_PATH}`)).toThrow();
      });
    }

    it("under pr-review, after a reviewed wave applied, the next merge waits for its own review instead of being refused", async () => {
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
      // The first merge waits, then applies once its review covers these plans: the ledger records the review and its use.
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([], null), now: T(1) })).toBe(3);
      const first = pendingOf(origin)[0]!.planDigest!;
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([review], first), now: T(2) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      // The review's line on the ledger, made when the wave read the review, is the approval the wave applied under.
      const reviewed = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).resolutions.at(-1)!;
      expect(reviewed).toMatchObject({ via: "pr-review", planDigest: first });
      expect(appliedOf(origin)).toEqual([expect.objectContaining({ planDigest: first, approvedAt: reviewed.timestamp, approvedBy: "alice" })]);
      // The next merge, not reviewed yet, plans other values: it waits and asks for a review, and the reviewed approval refuses nothing.
      moveA(work);
      lines.length = 0;
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([], null), now: T(3) })).toBe(3);
      expect(lines.join("\n")).toMatch(/no review approves this wave/);
      expect(lines.join("\n")).not.toContain("planned differently since");
    });

    it("under pr-review, a chant approve of plans that never applied is stale: the moved plans are refused", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, bin, log } = setup({ "terragucci.yml": "approval: pr-review\n" });
      const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.test", TG_TOKEN: "t", TG_SHA: "b".repeat(40) };
      const none: Fetch = async () => ({ ok: true, status: 200, json: async () => [] }) as never;
      expect(await applyWave(work, { ...opts(bin), env, fetch: none, now: T(1) })).toBe(3);
      approve(origin, approval(pendingOf(origin)[0]!.planDigest!, 2));
      moveA(work);
      expect(await applyWave(work, { ...opts(bin), env, fetch: none, now: T(3) })).toBe(4);
      expect(existsSync(log)).toBe(false);
    });
  });

  describe("a policy override", () => {
    const alice = sshKey();
    const deny: PolicyExec = async (_f, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: JSON.stringify([{ namespace: "main", failures: [{ msg: "terraform_data.x is not allowed", metadata: { query: "data.main.deny_data" } }] }]), stderr: "" };
    const config = (extra = "") => `policy:\n  path: policy\n  override: [alice]\n${extra}`;
    const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: {}, policy: { exec: deny } });
    const ledger = (origin: string) => parseLedger(git(origin, "show", `chant/lifecycle:${OVERRIDE_LEDGER}`));
    const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    /** Append one line to origin's override ledger, as `chant approve policy-override` would. */
    function record(origin: string, line: Record<string, unknown>): void {
      const clone = join(tmp("tg-override-"), "l");
      execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
      const file = join(clone, OVERRIDE_LEDGER);
      writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify(line)}\n`);
      git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "override");
      git(clone, "push", "-q", "origin", "chant/lifecycle");
    }
    const override = (digest: string, by = "alice", at = 2, note: string | null = "the incident needs it") =>
      ({ version: 1, kind: "resolution", op: OVERRIDE_OP, gate: "a", resolvedBy: by, timestamp: T(at), planDigest: digest, ...(note !== null ? { note } : {}) });

    async function denied(files: Record<string, string> = { "terragucci.yml": config(), "policy/p.rego": "package main\n" }) {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const s = setup(files);
      expect(await applyWave(s.work, { ...opts(s.bin), now: T(1) })).toBe(1);
      const pendingFact = ledger(s.origin).pending[0] as PendingRecord & { rules?: string[] };
      return { ...s, lines, pendingFact };
    }

    it("records the denial with its plan and rules, and an override of that digest by a listed approver applies the root and is in the report", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied();
      expect(existsSync(log)).toBe(false);
      expect(pendingFact).toMatchObject({ op: OVERRIDE_OP, gate: "a", rules: ["main.deny_data"], neverOverMcp: true });
      expect(pendingFact.planDigest).toBe(overrideDigest("a", pendingFact.members![0]!.planDigest, ["main.deny_data"]));
      expect(lines.join("\n")).toContain('terragucci override a --rule main.deny_data --reason "<why>"');
      expect(report(work).roots[0].policy).toMatchObject({ result: "denied", rules: ["main.deny_data"] });
      expect(report(work).policy.overriders).toEqual(["alice"]);
      // A re-run of the same plan records no second fact.
      expect(await applyWave(work, { ...opts(bin), now: T(1.5) })).toBe(1);
      expect(ledger(origin).pending).toHaveLength(1);
      record(origin, override(pendingFact.planDigest!));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      const r = report(work);
      expect(r.roots[0]).toMatchObject({ path: "a", status: "planned", policy: { result: "denied", override: { by: "alice", at: T(2), rules: ["main.deny_data"], reason: "the incident needs it", plan_digest: pendingFact.members![0]!.planDigest, digest: pendingFact.planDigest, sealed: false } } });
      expect(r.policy).toMatchObject({ denied: ["a"], overridden: ["a"] });
      expect(readFileSync(join(work, "terragucci-report", "note.md"), "utf-8")).toContain("overridden by alice");
    });

    it("an override by someone policy.override at base does not list, or with no reason, or written by a job, counts for nothing", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied();
      record(origin, override(pendingFact.planDigest!, "mallory"));
      record(origin, override(pendingFact.planDigest!, "alice", 2, null));
      record(origin, { ...override(pendingFact.planDigest!), via: "pr-review" });
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(1);
      expect(existsSync(log)).toBe(false);
      const text = lines.join("\n");
      expect(text).toContain("mallory is not listed in policy.override at base (alice)");
      expect(text).toContain("the override by alice gives no reason");
      expect(text).toContain("written by a job");
    });

    it("an override of an earlier plan counts for nothing: the wave applies nothing and exits 4, then asks again for the new plan", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied();
      // Made now: older than the denial the next run records for the new plan.
      record(origin, { ...override(pendingFact.planDigest!), timestamp: new Date().toISOString() });
      const plans = process.env.PLANS!;
      writeFileSync(join(plans, "a.json"), readFileSync(join(plans, "a.json"), "utf-8").replace('"input":"1"', '"input":"2"'));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(4);
      expect(existsSync(log)).toBe(false);
      expect(lines.join("\n")).toContain("alice overrode an earlier plan or other rules");
      const facts = ledger(origin).pending;
      expect(facts).toHaveLength(2);
      expect(facts[1]!.planDigest).not.toBe(pendingFact.planDigest);
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(1);
    });

    it("an override a wave applied is spent: once the root plans again, the new denial is recorded and waits for its own override", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied();
      record(origin, override(pendingFact.planDigest!));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      const usedOf = () => parseApplied(git(origin, "show", `chant/lifecycle:${appliedPathFor(OVERRIDE_LEDGER)}`));
      expect(usedOf()).toEqual([expect.objectContaining({ op: OVERRIDE_OP, gate: "a", planDigest: pendingFact.planDigest, approvedAt: T(2), approvedBy: "alice" })]);
      const plans = process.env.PLANS!;
      writeFileSync(join(plans, "a.json"), readFileSync(join(plans, "a.json"), "utf-8").replace('"input":"1"', '"input":"2"'));
      lines.length = 0;
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(1);
      const text = lines.join("\n");
      expect(text).not.toContain("overrode an earlier plan or other rules");
      expect(text).toContain('terragucci override a --rule main.deny_data --reason "<why>"');
      const facts = ledger(origin).pending;
      expect(facts).toHaveLength(2);
      const fresh = facts[1]!.planDigest!;
      expect(fresh).not.toBe(pendingFact.planDigest);
      // The new denial's own override applies it, and is recorded as used in turn.
      record(origin, override(fresh, "alice", 5));
      expect(await applyWave(work, { ...opts(bin), now: T(6) })).toBe(0);
      expect(usedOf().map((u) => u.planDigest)).toEqual([pendingFact.planDigest, fresh]);
    });

    it("a commit that adds its author to policy.override is judged by the list at base, so nothing is recorded or counted", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, bin, log } = setup({ "terragucci.yml": "policy:\n  path: policy\n", "policy/p.rego": "package main\n" });
      write(work, { "terragucci.yml": config() });
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "add alice");
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(1);
      expect(existsSync(log)).toBe(false);
      expect(git(origin, "branch", "--list", "chant/lifecycle").trim()).toBe("");
    });

    it("under approval: sealed only an override sealed by a key the signers file at base lists for its approver counts", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied({ "terragucci.yml": config("approval: sealed\n"), "policy/p.rego": "package main\n", ".chant/allowed_signers": `${signerLine("alice", alice)}\n` });
      expect(lines.join("\n")).toContain('--reason "<why>" --sign');
      record(origin, override(pendingFact.planDigest!));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(1);
      expect(lines.join("\n")).toMatch(/carries no seal/);
      const o = override(pendingFact.planDigest!, "alice", 4);
      record(origin, { ...o, seal: { signer: "alice", key: "SHA256:test", signature: sshsig(alice, gateSealPayload(o as never), "chant-gate") } });
      expect(await applyWave(work, { ...opts(bin), now: T(5) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      expect(report(work).roots[0].policy.override).toMatchObject({ by: "alice", sealed: true });
    });
  });

  it("gate never applies the wave's plans without reading the ledger", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never" })).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(git(origin, "branch", "--list", "chant/lifecycle").trim()).toBe("");
  });
});
