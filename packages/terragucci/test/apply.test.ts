import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, applyWaves, branchesArg, branchLayers, branchRootProblems, parseBranches, approvedPath, decideGate, lockTimeoutArgs, movedMembers, shareCount, parseApplied, parseLedger, spendStanding, type AppliedRecord, type GateLedger, type PendingRecord } from "../src/apply";
import type { PolicyExec } from "../src/report/policy";
import { refusedDiff } from "../src/respond/refused";
import { decideOverride, OVERRIDE_OP, overrideDigest, type OverrideRule } from "../src/override";
import { git, tmp, write } from "./helpers";
import { T, pending, resolution, FAKE, setup, approve } from "./apply-helpers";

describe("applyWaves", () => {
  it("is the layers, one wave each, when there is no canary", () => {
    expect(applyWaves([["network"], ["app", "cache"]])).toEqual([["network"], ["app", "cache"]]);
  });

  it("puts the canary roots first, still in dependency order, then the rest", () => {
    expect(applyWaves([["dev/net", "prod/net"], ["dev/app", "prod/app"]], ["dev/*"])).toEqual([["dev/net"], ["dev/app"], ["prod/net"], ["prod/app"]]);
  });
});

describe("apply.branches", () => {
  const branches = { release: ["prod/*"], "env/staging": ["staging/app"] };
  const layers = [["dev/net", "prod/net", "staging/net"], ["dev/app", "prod/app", "staging/app"]];

  it("cuts a named branch's layers to its own roots, and the default branch's to every other root", () => {
    expect(branchLayers(layers, branches, "release").layers).toEqual([["prod/net"], ["prod/app"]]);
    expect(branchLayers(layers, branches, "env/staging").layers).toEqual([[], ["staging/app"]]);
    expect(branchLayers(layers, branches, "main").layers).toEqual([["dev/net", "staging/net"], ["dev/app"]]);
    expect(branchLayers(layers, branches).layers).toEqual([["dev/net", "staging/net"], ["dev/app"]]);
    expect(applyWaves(branchLayers(layers, branches, "env/staging").layers)).toEqual([["staging/app"]]);
    expect(branchLayers(layers, branches, "main").note).toBe("apply.branches: prod/net, prod/app, staging/app apply from release, env/staging, not here");
    expect(branchLayers(layers, branches, "release").note).toBe("apply.branches: release applies prod/net, prod/app");
  });

  it("refuses a root two branches match, as chant's ci.branches refuses a member two branches route", () => {
    expect(() => branchLayers(layers, { release: ["prod/*"], hotfix: ["prod/app"] }, "release")).toThrow(/prod\/app matches release and hotfix; a root applies from one branch/);
    expect(branchRootProblems(layers.flat(), branches)).toEqual([]);
    expect(branchRootProblems(["prod/app", "dev/app"], { release: ["prod/**"], hotfix: ["*/app"] })).toEqual(["apply.branches: prod/app matches release and hotfix; a root applies from one branch"]);
  });

  it("goes to the stage as one argument and back", () => {
    expect(branchesArg(branches)).toBe("release=prod/*;env/staging=staging/app");
    expect(parseBranches(branchesArg(branches))).toEqual(branches);
    expect(() => parseBranches("release")).toThrow(/--branches takes/);
  });
});

describe("decideGate", () => {
  const ledger = (l: Partial<GateLedger>): GateLedger => ({ pending: [], resolutions: [], ...l });

  it("waits, with nothing standing, when nothing was ever recorded", () => {
    expect(decideGate(ledger({}), "wave-1", "d1", T(1))).toEqual({ status: "waiting" });
  });

  it("an approval of this digest, newer than the pending fact, lets the wave apply", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d1", T(3))).toEqual({ status: "approved", by: "alice", at: T(2) });
  });

  it("an approval of another digest is the changed-set refusal, and the new digest is not yet standing", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(3))).toEqual({ status: "refused", approved: "d1", by: "alice" });
  });

  it("an approval of another wave's gate counts for nothing", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-2", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d1", T(3)).status).toBe("waiting");
  });

  it("an approval older than the newest pending fact does not answer it", () => {
    const p2 = pending("wave-1", "d2", 3);
    const l = ledger({ pending: [pending("wave-1", "d1", 1), p2], resolutions: [resolution("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(4))).toEqual({ status: "waiting", standing: p2 });
  });

  const applied = (gate: string, digest: string, approvedAt: number): AppliedRecord => ({
    version: 1, kind: "applied", op: "tf-apply", gate, planDigest: digest, approvedAt: T(approvedAt), approvedBy: "alice", timestamp: T(approvedAt + 1),
  });

  it("an approval of another digest that a wave applied under is spent: the wave waits, and nothing new is standing", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2)], applied: [applied("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(4))).toEqual({ status: "waiting", spent: { approved: "d1", by: "alice", at: T(2) } });
  });

  it("a spent approval still lets the wave apply its own digest again, as a re-run after a failed apply does", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2)], applied: [applied("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d1", T(4))).toEqual({ status: "approved", by: "alice", at: T(2) });
  });

  it("an approval made after the apply of its digest is stale again, and refuses", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2), resolution("wave-1", "d1", 5)], applied: [applied("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(6))).toEqual({ status: "refused", approved: "d1", by: "alice" });
  });

  it("an apply of another wave, or of another digest, spends nothing", () => {
    const base = { pending: [pending("wave-1", "d1", 1)], resolutions: [resolution("wave-1", "d1", 2)] };
    expect(decideGate(ledger({ ...base, applied: [applied("wave-2", "d1", 2)] }), "wave-1", "d2", T(4)).status).toBe("refused");
    expect(decideGate(ledger({ ...base, applied: [applied("wave-1", "d3", 2)] }), "wave-1", "d2", T(4)).status).toBe("refused");
  });

  it("an approval that names no digest is never spent", () => {
    const { planDigest: _d, ...bare } = resolution("wave-1", "d1", 2);
    const l = ledger({ resolutions: [bare], applied: [applied("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(4))).toMatchObject({ status: "refused", by: "alice" });
  });

  it("a spent approval and a stale one: the stale one refuses", () => {
    const l = ledger({ resolutions: [resolution("wave-1", "d1", 2), resolution("wave-1", "d3", 3)], applied: [applied("wave-1", "d1", 2)] });
    expect(decideGate(l, "wave-1", "d2", T(4))).toEqual({ status: "refused", approved: "d3", by: "alice" });
  });

  it("an expired pending fact does not stand", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1, 1)] });
    expect(decideGate(l, "wave-1", "d1", T(5))).toEqual({ status: "waiting" });
  });
});

describe("decideOverride", () => {
  const rule: OverrideRule = { mode: "ledger", overriders: ["alice"] };
  const d1 = overrideDigest("a", "sha256:1", ["main.r"]);
  const d2 = overrideDigest("a", "sha256:2", ["main.r"]);
  const fact = (digest: string, h: number): PendingRecord => ({ ...pending("a", digest, h), op: OVERRIDE_OP });
  const ov = (digest: string, h: number) => ({ ...resolution("a", digest, h), op: OVERRIDE_OP, note: "why" });
  const used = (digest: string, approvedAt: number, gate = "a"): AppliedRecord => ({ version: 1, kind: "applied", op: OVERRIDE_OP, gate, planDigest: digest, approvedAt: T(approvedAt), approvedBy: "alice", timestamp: T(approvedAt + 1) });
  const decide = (l: GateLedger) => decideOverride(l, rule, "a", "sha256:2", ["main.r"], T(5));

  it("an override of another plan that no wave applied is the moved refusal", () => {
    expect(decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 2)] })).toMatchObject({ status: "moved", by: "alice", was: d1 });
  });

  it("an override a wave applied under refuses nothing and is named as spent", () => {
    const r = decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 2)], applied: [used(d1, 2)] });
    expect(r).toMatchObject({ status: "none", spent: { digest: d1, by: "alice" } });
  });

  it("an applied record of another root or an earlier override does not spend it", () => {
    expect(decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 2)], applied: [used(d1, 2, "b")] }).status).toBe("moved");
    expect(decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 3)], applied: [used(d1, 2)] }).status).toBe("moved");
  });

  it("a spent override and a stale one: the stale one still refuses", () => {
    const d3 = overrideDigest("a", "sha256:3", ["main.r"]);
    expect(decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 2), ov(d3, 3)], applied: [used(d1, 2)] })).toMatchObject({ status: "moved", was: d3 });
  });

  it("an override of this digest still counts after an earlier one was spent", () => {
    expect(decide({ pending: [fact(d1, 1)], resolutions: [ov(d1, 2), ov(d2, 4)], applied: [used(d1, 2)] }).status).toBe("overridden");
  });
});

describe("movedMembers", () => {
  it("names the roots whose plan digest changed, appeared or went", () => {
    const before = [{ member: "a", planDigest: "1" }, { member: "b", planDigest: "1" }, { member: "c", planDigest: "1" }];
    const after = [{ member: "a", planDigest: "1" }, { member: "b", planDigest: "2" }, { member: "d", planDigest: "1" }];
    expect(movedMembers(before, after)).toEqual(["b", "c", "d"]);
  });
});

describe("parseLedger", () => {
  it("reads both kinds of line and skips malformed ones", () => {
    const text = [JSON.stringify(pending("wave-1", "d1", 1)), "{not json", JSON.stringify({ version: 1, op: "tf-apply", gate: "wave-1", timestamp: T(2) }), JSON.stringify(resolution("wave-1", "d1", 2))].join("\n");
    const l = parseLedger(text);
    expect(l.pending).toHaveLength(1);
    expect(l.resolutions).toHaveLength(1);
  });
});

describe("a wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["on-destructive", "on-destroy"] as const)("under --gate %s a wave that replaces something waits, and one that only creates applies", async (gate) => {
    const { work, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate, env: {}, now: T(1) })).toBe(0);
    expect(existsSync(log)).toBe(true);
    const replace = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["delete", "create"], before: { input: "1" }, after: { input: "2" }, after_unknown: {} } }] };
    writeFileSync(join(process.env.PLANS!, "a.json"), JSON.stringify(replace));
    renameSync(log, `${log}.first`);
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate, env: {}, now: T(2) })).toBe(3);
    expect(existsSync(log)).toBe(false);
  });

  describe("the top-level gate at base", () => {
    const replace = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["delete", "create"], before: { input: "1" }, after: { input: "2" }, after_unknown: {} } }] };
    const commit = (work: string, msg: string) => git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-am", msg);
    const LINE = "wave 1: gate on-destructive, the top-level gate at base, which is stricter than the pipeline's --gate never; a looser gate takes effect from the merge after the change that sets it";

    it("gates a change that loosens it, on its own merge, and lets the merge after it through", async () => {
      const { work, bin, log } = setup({ "terragucci.yml": "gate: on-destructive\n" });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      writeFileSync(join(process.env.PLANS!, "a.json"), JSON.stringify(replace));
      // The change sets gate: never and renders its pipeline again, so its merge's pipeline passes --gate never.
      write(work, { "terragucci.yml": "gate: never\n" });
      commit(work, "gate: never");
      const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: {} };
      expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      expect(out.mock.calls.flat()).toContain(LINE);
      // The next merge's base has gate: never.
      commit(work, "next");
      out.mockClear();
      expect(await applyWave(work, { ...opts, now: T(2) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      expect(out.mock.calls.flat().join("\n")).not.toContain("the top-level gate at base");
    });

    it("lets a change that tightens it gate its own merge, by its own --gate", async () => {
      const { work, bin, log } = setup({ "terragucci.yml": "gate: never\n" });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      writeFileSync(join(process.env.PLANS!, "a.json"), JSON.stringify(replace));
      write(work, { "terragucci.yml": "gate: on-destructive\n" });
      commit(work, "gate: on-destructive");
      expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "on-destructive", env: {}, now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      expect(out.mock.calls.flat().join("\n")).not.toContain("the top-level gate at base");
    });

    it("takes on-destructive from a base that sets no gate, and on-destroy as on-destructive", async () => {
      for (const at of ["", "gate: on-destroy\n"]) {
        const { work, bin, log } = setup({ "terragucci.yml": `${at}parallelism: 2\n` });
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        writeFileSync(join(process.env.PLANS!, "a.json"), JSON.stringify(replace));
        write(work, { "terragucci.yml": "gate: never\n" });
        commit(work, "gate: never");
        expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {}, now: T(1) })).toBe(3);
        expect(existsSync(log)).toBe(false);
        expect(out.mock.calls.flat()).toContain(LINE);
        vi.restoreAllMocks();
      }
    });

    it("refuses to apply under --gate never when the config at base cannot be read, and names why", async () => {
      const { work, bin, log } = setup({ "terragucci.yml": "gate: sometimes\n" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      write(work, { "terragucci.yml": "gate: never\n" });
      commit(work, "gate: never");
      await expect(applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {}, now: T(1) })).rejects.toThrow(/^the top-level gate is read from the config at base, and it could not be read \(could not read the config at [0-9a-f]+: [\s\S]*config\.gate is "sometimes"[\s\S]*\), so the wave does not apply under --gate never$/);
      expect(existsSync(log)).toBe(false);
    });
  });

  it("refuses a --gate that names no policy, and lists the current names", async () => {
    const { work, bin } = setup();
    await expect(applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "on-delete" as never, env: {}, now: T(1) })).rejects.toThrow("--gate must be one of always, on-destructive, never");
  });

  it("refuses a wave the policy denies, before any gate fact or apply, and leaves the wave alone when policy is not set", async () => {
    const { work, origin, bin, log } = setup({ "terragucci.yml": "policy:\n  path: policy\n", "policy/p.rego": "package main\n" });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    const deny: PolicyExec = async (_f, args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: JSON.stringify([{ failures: [{ msg: "terraform_data.x is not allowed" }] }]), stderr: "" });
    expect(await applyWave(work, { ...opts, now: T(1), policy: { exec: deny } })).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(out.mock.calls.flat().join("\n")).toContain("terraform_data.x is not allowed");
    expect(() => git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).toThrow();
    const allow: PolicyExec = async (_f, args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: JSON.stringify([{ failures: [] }]), stderr: "" });
    expect(await applyWave(work, { ...opts, now: T(1), policy: { exec: allow } })).toBe(3);
  });

  it("runs the binary with no forge token in its environment, by name or by value, in plan, show and apply", async () => {
    const { work, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen = join(work, "..", "env.log");
    // The fake binary records its environment on every call, then does what FAKE does.
    writeFileSync(bin, FAKE.replace("#!/usr/bin/env bash\n", `#!/usr/bin/env bash\nenv >> ${JSON.stringify(seen)}\n`));
    const tokens = { TG_TOKEN: "job-token-1234", TG_MERGE_TOKEN: "merge-token-5678", GITHUB_TOKEN: "gh-1", GITLAB_TOKEN: "job-token-1234", CI_JOB_TOKEN: "ci-1", FORGEJO_TOKEN: "fj-1", MY_BOT_TOKEN: "merge-token-5678" };
    for (const [k, v] of Object.entries(tokens)) vi.stubEnv(k, v);
    vi.stubEnv("TF_HTTP_PASSWORD", "job-token-1234");
    try {
      expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: { ...process.env }, now: T(1) })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    const env = readFileSync(seen, "utf-8");
    expect(env).toContain("TF_PLUGIN_CACHE_DIR=");
    for (const k of Object.keys(tokens)) expect(env, k).not.toMatch(new RegExp(`^${k}=`, "m"));
    for (const v of ["job-token-1234", "merge-token-5678", "gh-1", "ci-1", "fj-1"]) expect(env.split("\n").filter((l) => l.includes(v) && !l.startsWith("TF_HTTP_PASSWORD="))).toEqual([]);
    // A TF_ variable is given to the binary on purpose, so it stays.
    expect(env).toMatch(/^TF_HTTP_PASSWORD=job-token-1234$/m);
  });

  it("with apply.branches applies a branch's roots on that branch alone, behind the same gate, and nothing of them on the default branch", async () => {
    const { work, origin, bin, log } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, env: {}, branches: { release: ["a"] } };
    // The default branch skips a, so the wave applies nothing and records no gate fact.
    expect(await applyWave(work, { ...opts, gate: "always", now: T(1) })).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(out.mock.calls.flat().join("\n")).toContain("no root applies from this branch, so there is nothing to apply");
    expect(() => git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).toThrow();
    // On release the wave plans a and waits at its gate, as on the default branch.
    expect(await applyWave(work, { ...opts, gate: "always", branch: "release", now: T(1) })).toBe(3);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]).toMatchObject({ gate: "wave-1", members: [{ member: "a" }] });
    expect(existsSync(log)).toBe(false);
    expect(await applyWave(work, { ...opts, gate: "never", branch: "release", now: T(2) })).toBe(0);
    expect(existsSync(log)).toBe(true);
  });

  it("records one pending fact with each root's digest, applies nothing, and records no second fact on a re-run", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    expect(existsSync(log)).toBe(false);
    const ledger = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    expect(ledger.resolutions).toEqual([]);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", members: [{ member: "a" }], commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(ledger.pending[0].planDigest).toMatch(/\S/);

    expect(await applyWave(work, { ...opts, now: T(2) })).toBe(3);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending).toHaveLength(1);
  });

  it("the wave's report says waiting with the ledger it is recorded in, then approved once an approval of the digest stands", async () => {
    const { work, origin, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    const wave = () => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).waves[0];
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    expect(wave()).toMatchObject({ approval: "waiting", state: "waiting", gate: { branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" } });
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(0);
    expect(wave()).toMatchObject({ approval: "approved", state: "applied", gate: { branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" } });
    expect(await applyWave(work, { ...opts, gate: "never", now: T(4) })).toBe(0);
    expect(wave().approval).toBe("not-required");
  });

  it("the wave's report lists the resources a root holds only once it applied, and never a value", async () => {
    const { work, origin, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "s3cr3t-in-the-plan";
    writeFileSync(join(work, "..", "plans", "a.json"), JSON.stringify({
      resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", provider_name: "terraform.io/builtin/terraform", change: { actions: ["create"], before: null, after: { input: secret }, after_unknown: {}, after_sensitive: { input: true } } }],
      planned_values: { root_module: { resources: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", provider_name: "terraform.io/builtin/terraform", values: { input: secret }, sensitive_values: { input: true } }] } },
    }));
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    const report = () => readFileSync(join(work, "terragucci-report", "report.json"), "utf-8");
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    expect(JSON.parse(report()).roots[0].resources).toBeUndefined();
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(0);
    expect(JSON.parse(report()).roots[0].resources).toEqual([{ address: "terraform_data.x", type: "terraform_data", provider: "terraform.io/builtin/terraform" }]);
    expect(report()).not.toContain(secret);
  });

  it("the wave's report names the state version a root's backend holds once it applied, and the log prints it", async () => {
    const { work, bin } = setup();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    // The root was initialised with a local backend whose file is under state/.
    mkdirSync(join(work, "a", ".terraform"), { recursive: true });
    writeFileSync(join(work, "a", ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "local", config: { path: "state/a.tfstate" } } }));
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {} })).toBe(0);
    const root = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).roots[0];
    expect(root.state).toEqual({ backend: "local", location: "state/a.tfstate", versioning: "off", note: "a local backend keeps only the latest state" });
    expect(lines).toContain("a: state state/a.tfstate, versions off (a local backend keeps only the latest state)");
  });

  it("the wave's report names the provider and module versions an applied root ran, from its lock file and modules.json", async () => {
    const { work, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(join(work, "a", ".terraform", "modules"), { recursive: true });
    writeFileSync(join(work, "a", ".terraform.lock.hcl"), 'provider "registry.opentofu.org/hashicorp/aws" {\n  version     = "5.80.0"\n  constraints = "~> 5.0"\n}\n');
    writeFileSync(join(work, "a", ".terraform", "modules", "modules.json"), JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, { Key: "vpc", Source: "registry.opentofu.org/acme/vpc/aws", Version: "1.2.0", Dir: ".terraform/modules/vpc" }] }));
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {} })).toBe(0);
    const root = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).roots[0];
    expect(root.versions).toEqual({
      providers: [{ provider: "registry.opentofu.org/hashicorp/aws", version: "5.80.0" }],
      modules: [{ call: "module.vpc", source: "registry.opentofu.org/acme/vpc/aws", version: "1.2.0" }],
    });
  });

  it("ends the ledger with a newline, so a line another writer appends stays its own record", async () => {
    const { work, origin, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "always", env: {}, now: T(1) })).toBe(3);
    const text = execFileSync("git", ["-C", origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"], { encoding: "utf-8" });
    expect(text.endsWith("}\n")).toBe(true);
    const appended = `${text}${JSON.stringify({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "someone", timestamp: T(2) })}\n`;
    expect(parseLedger(appended).resolutions).toHaveLength(1);
    expect(parseLedger(appended).pending).toHaveLength(1);
  });

  it("applied from an open pull request with --base, a pull request that changes reports.bucket uploads to the base's bucket", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { work, bin, log } = setup({ "terragucci.yml": "reports:\n  bucket: s3://base-reports\n  endpoint: http://s3.test\n" });
    git(work, "checkout", "-q", "-b", "pr");
    write(work, { "terragucci.yml": "reports:\n  bucket: s3://pr-reports\n  endpoint: http://s3.test\n" });
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "point reports elsewhere");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
      urls.push(url);
      return init.method === "GET" ? new Response(null, { status: 404 }) : new Response("", { status: 200 });
    });
    try {
      const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" } };
      expect(await applyWave(work, { ...opts, base: "main", now: T(1) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u.includes("base-reports"))).toBe(true);
      // Applied after the merge (no base), the merged config's bucket is the one in force.
      urls.length = 0;
      expect(await applyWave(work, { ...opts, now: T(2) })).toBe(0);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u.includes("pr-reports"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a wave refused for a moved plan writes the approved and current reports, and respond wave-refused names the root and attribute that moved", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    // The waiting run kept the report of the plans it asked approval for, beside the ledger.
    expect(JSON.parse(git(origin, "show", `chant/lifecycle:${approvedPath(1, digest)}`)).waves[0]).toMatchObject({ number: 1, set_digest: digest });
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    writeFileSync(join(work, "..", "plans", "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "2" }, after_unknown: {} } }] }));
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(4);
    expect(existsSync(log)).toBe(false);
    const read = (d: string) => JSON.parse(readFileSync(join(work, "terragucci-report", d, "report.json"), "utf-8"));
    const diff = refusedDiff(read("approved"), read("current"), 1);
    expect(diff.approved_set).toBe(digest);
    expect(diff.roots.map((r) => [r.root, r.changes.map((c) => [c.address, c.attributes])])).toEqual([["a", [["terraform_data.x", ["input"]]]]]);
    // The wave's own report says why it applied nothing, for the audit trail.
    expect(JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).waves[0].refused).toEqual({ reason: "approval", approved: digest, by: "alice", roots: ["a"] });
    expect(JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).waves[0].state).toBe("refused");
  });

  it("writes how the wave ended as terragucci.outcome/v1 to TG_OUTCOME_JSON: waiting, refused, applied and denied", async () => {
    const { work, origin, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const file = join(tmp("tg-outcome-"), "outcome.json");
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: { TG_OUTCOME_JSON: file } };
    const read = () => JSON.parse(readFileSync(file, "utf-8"));
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    expect(read()).toEqual({
      schema: "terragucci.outcome/v1", status: "waiting", exit: 3, wave: 1, roots: ["a"],
      line: `wave 1 waits: terragucci approve wave-1 --plan ${digest}`,
      set_digest: digest, gate: { name: "wave-1", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" },
      approval: "waiting", approval_mode: "ledger", approve_command: `terragucci approve wave-1 --plan ${digest}`,
      // When chant recorded the pending fact.
      waiting_since: parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.timestamp,
    });
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    const plans = join(work, "..", "plans", "a.json");
    const before = readFileSync(plans, "utf-8");
    writeFileSync(plans, before.replace('"input":"1"', '"input":"2"'));
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(4);
    const refused = read();
    expect(refused).toMatchObject({ status: "refused", exit: 4, line: "wave 1 changed after approval: a", refused: { reason: "approval", approved: digest, by: "alice", roots: ["a"] } });
    expect(refused.approve_command).toMatch(/^terragucci approve wave-1 --plan \S+$/);
    expect(refused.set_digest).not.toBe(digest);
    writeFileSync(plans, before);
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(4), planDigest: digest });
    expect(await applyWave(work, { ...opts, now: T(5) })).toBe(0);
    expect(read()).toMatchObject({ status: "applied", exit: 0, approval: "approved", set_digest: digest });
    expect(read()).not.toHaveProperty("approve_command");
    const deny: PolicyExec = async (_f, args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: JSON.stringify([{ failures: [{ msg: "no" }] }]), stderr: "" });
    write(work, { "terragucci.yml": "policy:\n  path: policy\n", "policy/p.rego": "package main\n" });
    expect(await applyWave(work, { ...opts, now: T(6), policy: { exec: deny } })).toBe(1);
    expect(read()).toMatchObject({ status: "failed", exit: 1, policy_denied: ["a"], refused: { reason: "policy", roots: ["a"] } });
    expect(read()).not.toHaveProperty("failed_roots");
  });

  const appliedLines = (origin: string) => parseApplied(git(origin, "show", "chant/lifecycle:_gates/tf-apply/applied.jsonl"));
  const pushAgain = (work: string, input: string) => {
    const plans = join(work, "..", "plans", "a.json");
    writeFileSync(plans, readFileSync(plans, "utf-8").replace(/"input":"\d+"/, `"input":"${input}"`));
    write(work, { [`push-${input}`]: input });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `push ${input}`);
  };

  it("a wave its policy lets through spends the approval of its plans, so the next push's other plans wait and are not refused (behold#571)", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, env: {} };
    expect(await applyWave(work, { ...opts, gate: "always", now: T(1) })).toBe(3);
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    // The comment's apply: nothing holds the wave this time, so it applies under no gate, and the approval of these plans is spent all the same.
    expect(await applyWave(work, { ...opts, gate: "on-destructive", now: T(3) })).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(appliedLines(origin)).toEqual([expect.objectContaining({ kind: "applied", gate: "wave-1", planDigest: digest, approvedAt: T(2), approvedBy: "alice" })]);
    // The next push plans something else and is held: it waits for an approval of its own plans.
    pushAgain(work, "2");
    expect(await applyWave(work, { ...opts, gate: "always", now: T(4) })).toBe(3);
    const ledger = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    expect(ledger.pending.at(-1)!.planDigest).not.toBe(digest);
    expect(JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).waves[0]).toMatchObject({ approval: "waiting", state: "waiting" });
  });

  it("an approval no wave applied still refuses another push's other plans: the stale plan", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    pushAgain(work, "2");
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(4);
    expect(existsSync(log)).toBe(false);
    expect(() => git(origin, "show", "chant/lifecycle:_gates/tf-apply/applied.jsonl")).toThrow();
    // chant decided on the ledger it read, then recorded this run's own pending fact, for the plans it refused.
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending.map((p) => p.planDigest === digest)).toEqual([true, false]);
  });

  it("an approved wave's spend is written once: chant's line stands, and spendStanding writes one only where none is", async () => {
    const { work, origin, bin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    // Nothing applied yet: spendStanding spends the standing approval, once.
    const fresh = setup();
    git(fresh.work, "remote", "set-url", "origin", origin);
    expect(spendStanding(fresh.work, "wave-1", digest, T(3), {})).toMatchObject({ kind: "applied", gate: "wave-1", planDigest: digest, approvedAt: T(2), approvedBy: "alice", timestamp: T(3) });
    expect(spendStanding(fresh.work, "wave-1", digest, T(3), {})).toBeUndefined();
    expect(spendStanding(fresh.work, "wave-1", "jcs1-sha256:other", T(3), {})).toBeUndefined();
    expect(appliedLines(origin)).toHaveLength(1);
    // A second approval of the same plans, applied through the gate: chant spends it, and the wave writes no second line for it.
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "bob", timestamp: T(4), planDigest: digest });
    expect(await applyWave(work, { ...opts, now: T(5) })).toBe(0);
    const lines = appliedLines(origin);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ gate: "wave-1", planDigest: digest, approvedAt: T(4), approvedBy: "bob" });
  });
});

describe("shareCount", () => {
  it("makes as many shares as there are jobs, never more than roots, and one job is the whole wave", () => {
    expect(shareCount(["a", "b", "c", "d", "e"], 2)).toBe(2);
    expect(shareCount(["a", "b"], 5)).toBe(2);
    expect(shareCount(["a", "b", "c"], 1)).toBe(1);
  });
});

describe("the default -lock-timeout", () => {
  it("is five minutes unless TF_CLI_ARGS or the command's own variable names one", () => {
    expect(lockTimeoutArgs("plan", {})).toEqual(["-lock-timeout=5m"]);
    expect(lockTimeoutArgs("apply", { TF_CLI_ARGS_plan: "-lock-timeout=1s" })).toEqual(["-lock-timeout=5m"]);
    expect(lockTimeoutArgs("plan", { TF_CLI_ARGS_plan: "-lock-timeout=150s" })).toEqual([]);
    expect(lockTimeoutArgs("apply", { TF_CLI_ARGS: "-no-color -lock-timeout=0s" })).toEqual([]);
    expect(lockTimeoutArgs("apply", { TF_CLI_ARGS_apply: "--lock-timeout 30s" })).toEqual([]);
  });
});
