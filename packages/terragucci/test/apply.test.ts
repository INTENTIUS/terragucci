import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLIED_PATH, appliedPathFor, applyWave, applyWaves, approvedPath, decideGate, decidedPath, parseApplied as readApplied, waveShares, lockTimeoutArgs, movedMembers, parseApplied, parseLedger, type AppliedRecord, type GateLedger, type PendingRecord } from "../src/apply";
import type { Fetch } from "../src/forge";
import type { PolicyExec } from "../src/report/policy";
import type { CostRunner } from "../src/report/cost";
import { noteMarker } from "../src/review";
import { refusedDiff } from "../src/respond/refused";
import { gateSealPayload } from "../src/seal";
import { decideOverride, OVERRIDE_LEDGER, OVERRIDE_OP, overrideDigest, type OverrideRule } from "../src/override";
import { git, tmp, write } from "./helpers";
import { signerLine, sshsig, sshKey } from "./sshsig";

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
const pending = (gate: string, digest: string, at: number, hours = 48): PendingRecord => ({
  version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(at), expiresAt: T(at + hours), planDigest: digest,
});
const resolution = (gate: string, digest: string, at: number) => ({ version: 1 as const, op: "tf-apply", gate, resolvedBy: "alice", timestamp: T(at), planDigest: digest });

describe("applyWaves", () => {
  it("is the layers, one wave each, when there is no canary", () => {
    expect(applyWaves([["network"], ["app", "cache"]])).toEqual([["network"], ["app", "cache"]]);
  });

  it("puts the canary roots first, still in dependency order, then the rest", () => {
    expect(applyWaves([["dev/net", "prod/net"], ["dev/app", "prod/app"]], ["dev/*"])).toEqual([["dev/net"], ["dev/app"], ["prod/net"], ["prod/app"]]);
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
    expect(decideGate(l, "wave-1", "d2", T(4))).toEqual({ status: "waiting", spent: { approved: "d1", by: "alice" } });
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
  const rule: OverrideRule = { mode: "ledger", overriders: ["alice"], signers: null, signersPath: ".chant/allowed_signers" };
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

/** A fake tofu: plan writes the root into the plan file, show -json prints $PLANS/<root>.json, apply logs the root. */
const FAKE = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply) echo "applied $root" >> "$LOG"; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

describe("a wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  /** `files` are committed on main, the base the seal rule reads. */
  function setup(files: Record<string, string> = {}): { work: string; origin: string; bin: string; log: string } {
    const dir = tmp("tg-wave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(join(work, "a"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    write(work, files);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    writeFileSync(join(plans, "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] }));
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    return { work, origin, bin, log: join(dir, "apply.log") };
  }

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
    expect(wave()).toMatchObject({ approval: "waiting", gate: { branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" } });
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(0);
    expect(wave()).toMatchObject({ approval: "approved", gate: { branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" } });
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
      line: `wave 1 waits: chant approve tf-apply wave-1 --plan ${digest}`,
      set_digest: digest, gate: { name: "wave-1", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" },
      approval: "waiting", approval_mode: "ledger", approve_command: `chant approve tf-apply wave-1 --plan ${digest}`, waiting_since: T(1),
    });
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
    const plans = join(work, "..", "plans", "a.json");
    const before = readFileSync(plans, "utf-8");
    writeFileSync(plans, before.replace('"input":"1"', '"input":"2"'));
    expect(await applyWave(work, { ...opts, now: T(3) })).toBe(4);
    const refused = read();
    expect(refused).toMatchObject({ status: "refused", exit: 4, line: "wave 1 changed after approval: a", refused: { reason: "approval", approved: digest, by: "alice", roots: ["a"] } });
    expect(refused.approve_command).toMatch(/^chant approve tf-apply wave-1 --plan \S+$/);
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

  /** Append one resolution line to origin's ledger, as `chant approve` would from a person's machine. */
  function approve(origin: string, line: Record<string, unknown>): void {
    const clone = join(tmp("tg-approve-"), "l");
    execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
    const file = join(clone, "_gates/tf-apply.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify(line)}`);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
  }

  describe("cost.approve_above", () => {
    const yml = (amount: number) => `gate: never\ncost:\n  command: node cost.mjs\n  approve_above: ${amount}\n`;
    const priced = (delta: number): CostRunner => async () => ({ code: 0, stdout: JSON.stringify({ currency: "USD", totalMonthlyCost: String(delta), pastTotalMonthlyCost: "0", diffTotalMonthlyCost: String(delta) }), stderr: "" });
    const opts = (bin: string, delta: number) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: {}, costRunner: priced(delta) });
    const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));

    it("holds a wave whose change is over the amount under gate: never, names the amount, and applies one within it", async () => {
      const { work, origin, bin, log } = setup({ "terragucci.yml": yml(15) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      const text = out.mock.calls.flat().join("\n");
      expect(text).toContain("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at ");
      expect(text).toContain("so it waits for an approval although gate is never");
      const pending = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!;
      expect(pending.members!.map((m) => m.member)).toEqual(["a", "(monthly cost)"]);
      expect(report(work).waves[0]).toMatchObject({ approval: "waiting", cost: { monthly_delta: 20, approve_above: 15, over: true } });
      expect(report(work).cost).toMatchObject({ monthly_delta: 20, roots: [{ root: "a", output: "roots/a/cost.json" }] });
      expect(existsSync(join(work, "terragucci-report", "roots", "a", "cost.json"))).toBe(true);
      // Within the amount, gate: never applies it.
      expect(await applyWave(work, { ...opts(bin, 10), now: T(2) })).toBe(0);
      expect(readFileSync(log, "utf-8")).toContain("applied a");
      expect(report(work).waves[0]).toMatchObject({ approval: "not-required", cost: { monthly_delta: 10, over: false } });
    });

    it("binds the cost into the digest: an approval of the plans at one cost does not apply them at another", async () => {
      const { work, origin, bin, log } = setup({ "terragucci.yml": yml(15) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
      // The same plans, priced higher: the approval is of another digest, so nothing applies and the cost is named as what moved.
      expect(await applyWave(work, { ...opts(bin, 40), now: T(3) })).toBe(4);
      expect(existsSync(log)).toBe(false);
      expect(out.mock.calls.flat().join("\n")).toContain("these roots planned differently since: (monthly cost)");
      // The refusal asked for the new digest; approved again at the first cost, the plans at that cost apply.
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(4), planDigest: digest });
      expect(await applyWave(work, { ...opts(bin, 20), now: T(5) })).toBe(0);
      expect(readFileSync(log, "utf-8")).toContain("applied a");
    });

    it("reads the amount at the commit before the one applied, so a change that raises it still waits", async () => {
      const { work, bin, log } = setup({ "terragucci.yml": yml(15) });
      write(work, { "terragucci.yml": yml(1000) });
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "raise the amount");
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      const text = out.mock.calls.flat().join("\n");
      expect(text).toMatch(/approve_above is 1000 here and 15 at [0-9a-f]{40}; the amount at [0-9a-f]{40} counts/);
      expect(text).toContain("over cost.approve_above 15.00 USD");
    });

    it("gives the policy each root's cost and the wave's", async () => {
      const { work, bin } = setup({ "terragucci.yml": `${yml(15)}policy:\n  path: policy\n`, "policy/p.rego": "package main\n" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      const inputs: Record<string, unknown>[] = [];
      const deny: PolicyExec = async (_f, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
        inputs.push(JSON.parse(readFileSync(args[args.length - 1], "utf-8")));
        return { status: 1, stdout: JSON.stringify([{ failures: [{ msg: "the wave adds more than 15.00 a month" }] }]), stderr: "" };
      };
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1), policy: { exec: deny } })).toBe(1);
      expect(inputs[0]).toMatchObject({ cost: { currency: "USD", root: { monthly_delta: 20 }, wave: { number: 1, monthly_delta: 20 }, approve_above: 15 } });
    });

    it("leaves a wave alone, and prices nothing, without cost", async () => {
      const { work, bin } = setup({ "terragucci.yml": "gate: never\n" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      let ran = 0;
      expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {}, now: T(1), costRunner: async () => (ran++, { code: 1, stdout: "", stderr: "" }) })).toBe(0);
      expect(ran).toBe(0);
      expect(report(work).cost).toBeUndefined();
    });
  });

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
      expect(lines.join("\n")).toMatch(/not signed/);
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
      expect(lines.join("\n")).toMatch(/not signed/);
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
      expect(lines).toContain(`  chant approve tf-apply wave-1 --plan ${digest}`);
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
      expect(lines).toContain(`  chant approve tf-apply wave-1 --plan ${digest} --sign`);
      approve(origin, approval(digest, 2));
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(3);
      expect(lines.join("\n")).toMatch(/not signed/);
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
          "repos/acme/infra/pulls/7/reviews": reviews,
          "repos/acme/infra/collaborators/alice/permission": { permission: "write" },
          "repos/acme/infra/issues/7/comments": [{ body: noteMarker({ head, waves: [{ number: 1, digest, waits: true }] }) }],
        };
        return (path! in body ? { ok: true, status: 200, json: async () => body[path!] } : { ok: false, status: 404, json: async () => ({}) }) as never;
      };
      const review = { user: { login: "alice" }, state: "APPROVED", commit_id: head };
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([], null), now: T(1) })).toBe(3);
      const digest = digestOf(origin);
      expect(lines.join("\n")).toMatch(/no review approves this wave: no reviewer other than its author approved head aaaaaaaa of pull request 7/);
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
        expect(appliedOf(origin)).toEqual([expect.objectContaining({ gate: "wave-1", planDigest: first, approvedAt: T(2), approvedBy: "alice", timestamp: T(3) })]);
        moveA(work);
        lines.length = 0;
        expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(3);
        const second = pendingOf(origin).at(-1)!.planDigest!;
        expect(second).not.toBe(first);
        expect(lines.join("\n")).toContain(`the approval of ${first} by alice was used by the apply of those plans`);
        expect(lines.join("\n")).not.toContain("planned differently since");
        expect(lines).toContain(`  chant approve tf-apply wave-1 --plan ${second}${mode === "sealed" ? " --sign" : ""}`);
        // The approval of the new plans applies them, and is recorded as used in turn.
        approve(origin, approveAs(second, 5));
        expect(await applyWave(work, { ...opts(bin), now: T(6) })).toBe(0);
        expect(appliedOf(origin).map((a) => a.planDigest)).toEqual([first, second]);
      }, 20_000);

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
          "repos/acme/infra/pulls/7/reviews": reviews,
          "repos/acme/infra/collaborators/alice/permission": { permission: "write" },
          "repos/acme/infra/issues/7/comments": [{ body: noteMarker({ head, waves: [{ number: 1, digest, waits: true }] }) }],
        };
        return (path! in body ? { ok: true, status: 200, json: async () => body[path!] } : { ok: false, status: 404, json: async () => ({}) }) as never;
      };
      const review = { user: { login: "alice" }, state: "APPROVED", commit_id: head };
      // The first merge waits, then applies once its review covers these plans: the ledger records the review and its use.
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([], null), now: T(1) })).toBe(3);
      const first = pendingOf(origin)[0]!.planDigest!;
      expect(await applyWave(work, { ...opts(bin), env, fetch: forge([review], first), now: T(2) })).toBe(0);
      expect(existsSync(log)).toBe(true);
      expect(appliedOf(origin)).toEqual([expect.objectContaining({ planDigest: first, approvedAt: T(2), approvedBy: "alice" })]);
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
      expect(text).toContain("mallory is not listed under policy.override at base (alice)");
      expect(text).toContain("the override by alice gives no reason");
      expect(text).toContain("written by a job");
    });

    it("an override of an earlier plan counts for nothing: the wave applies nothing and exits 4, then asks again for the new plan", async () => {
      const { work, origin, bin, log, lines, pendingFact } = await denied();
      record(origin, override(pendingFact.planDigest!));
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
      expect(usedOf()).toEqual([expect.objectContaining({ op: OVERRIDE_OP, gate: "a", planDigest: pendingFact.planDigest, approvedAt: T(2), approvedBy: "alice", timestamp: T(3) })]);
      const plans = process.env.PLANS!;
      writeFileSync(join(plans, "a.json"), readFileSync(join(plans, "a.json"), "utf-8").replace('"input":"1"', '"input":"2"'));
      lines.length = 0;
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(1);
      const text = lines.join("\n");
      expect(text).toContain(`the override of ${pendingFact.planDigest} by alice was used by the apply of that plan`);
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
      expect(lines.join("\n")).toMatch(/not signed/);
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

describe("planning a wave's roots", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fake tofu whose plan counts the plans running together in $RUN and appends each count to $RUN/counts. */
  const COUNTING = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
case "$2" in
  plan)
    for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done
    touch "$RUN/running.$root"
    ls "$RUN" | grep -c '^running\\.' >> "$RUN/counts"
    sleep 0.3
    rm -f "$RUN/running.$root"
    echo "Plan: 1 to add" ;;
  show) echo '{"resource_changes":[]}' ;;
  apply)
    touch "$RUN/applying.$root"
    ls "$RUN" | grep -c '^applying\\.' >> "$RUN/applies"
    sleep 0.3
    mv "$RUN/applying.$root" "$RUN/applied.$root"
    echo "Apply complete! Resources: 0 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

  function wave(roots: string[]): { work: string; bin: string; run: string } {
    const dir = tmp("tg-bound-");
    const work = join(dir, "work");
    for (const r of roots) mkdirSync(join(work, r), { recursive: true });
    const run = join(dir, "run");
    mkdirSync(run);
    const bin = join(dir, "tofu");
    writeFileSync(bin, COUNTING);
    chmodSync(bin, 0o755);
    vi.stubEnv("RUN", run);
    vi.spyOn(console, "log").mockImplementation(() => {});
    return { work, bin, run };
  }
  const most = (run: string, file = "counts"): number => Math.max(...readFileSync(join(run, file), "utf-8").split("\n").filter(Boolean).map(Number));
  const roots = ["r1", "r2", "r3", "r4", "r5", "r6"];

  it("never plans more roots at once than --parallelism", async () => {
    const { work, bin, run } = wave(roots);
    expect(await applyWave(work, { wave: 1, layers: [roots], binary: bin, gate: "never", env: process.env, parallelism: 2 })).toBe(0);
    expect(most(run)).toBeLessThanOrEqual(2);
    expect(most(run)).toBe(2);
  });

  it("never applies more roots at once than it plans", async () => {
    const { work, bin, run } = wave(roots);
    expect(await applyWave(work, { wave: 1, layers: [roots], binary: bin, gate: "never", env: process.env, parallelism: 2 })).toBe(0);
    expect(readFileSync(join(run, "applies"), "utf-8").split("\n").filter(Boolean)).toHaveLength(roots.length);
    expect(most(run, "applies")).toBe(2);
  });

  it("plans one root at a time with a bound of 1", async () => {
    const { work, bin, run } = wave(roots);
    expect(await applyWave(work, { wave: 1, layers: [roots], binary: bin, gate: "never", env: process.env, parallelism: 1 })).toBe(0);
    expect(most(run)).toBe(1);
  });

  it("takes the bound from the config's parallelism key", async () => {
    const { work, bin, run } = wave(roots);
    writeFileSync(join(work, "terragucci.yml"), "parallelism: 3\n");
    expect(await applyWave(work, { wave: 1, layers: [roots], binary: bin, gate: "never", env: process.env })).toBe(0);
    expect(most(run)).toBe(3);
  });
});

describe("waveShares", () => {
  it("deals a wave's roots out to as many shares as there are jobs, in wave order", () => {
    expect(waveShares(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "c", "e"], ["b", "d"]]);
  });

  it("never makes more shares than roots, and one job is the whole wave", () => {
    expect(waveShares(["a", "b"], 5)).toEqual([["a"], ["b"]]);
    expect(waveShares(["a", "b", "c"], 1)).toEqual([["a", "b", "c"]]);
  });
});

describe("a wave split across jobs", () => {
  afterEach(() => vi.restoreAllMocks());

  const roots = ["a", "b", "c"];
  const create = (v: string) => JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: v }, after_unknown: {} } }] });

  function setup(): { work: string; origin: string; bin: string; log: string; plans: string } {
    const dir = tmp("tg-split-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    for (const r of roots) mkdirSync(join(work, r), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    for (const r of roots) writeFileSync(join(plans, `${r}.json`), create(r));
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    return { work, origin, bin, log: join(dir, "apply.log"), plans };
  }
  const applied = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").map((l) => l.replace("applied ", "")).sort() : []);
  const opts = (bin: string, extra: Record<string, unknown> = {}) => ({ wave: 1, layers: [roots], binary: bin, gate: "always" as const, env: {}, shares: 2, ...extra });

  function approveWave(origin: string, at: number): void {
    const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
    const clone = join(tmp("tg-approve-"), "l");
    execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
    const file = join(clone, "_gates/tf-apply.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(at), planDigest: digest })}`);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
  }

  it("decides the wave under one gate in its own job, and each share applies only its own roots, under that one approval", async () => {
    const { work, origin, bin, log } = setup();
    // The wave waits at its gate: one pending fact for the whole wave, no decision, nothing applied.
    expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
    expect(existsSync(join(work, decidedPath(1)))).toBe(false);
    const pending = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].members!.map((m) => m.member)).toEqual(roots);
    approveWave(origin, 2);
    // Approved, the wave's job records the approval used once, writes every root's digest for its shares and applies nothing.
    expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
    expect(applied(log)).toEqual([]);
    const decision = JSON.parse(readFileSync(join(work, decidedPath(1)), "utf-8"));
    expect(decision).toMatchObject({ version: 1, wave: 1, shares: 2, digest: pending[0].planDigest, approval: "approved", changes: 3, commit: git(work, "rev-parse", "HEAD").trim() });
    expect(decision.members.map((m: { member: string }) => m.member)).toEqual(roots);
    const used = () => readApplied(git(origin, "show", `chant/lifecycle:${APPLIED_PATH}`));
    expect(used()).toHaveLength(1);
    // Each share applies its roots alone, reads no gate and records nothing more.
    expect(await applyWave(work, { ...opts(bin), share: 1, now: T(4) })).toBe(0);
    expect(applied(log)).toEqual(["a", "c"]);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.run).toMatchObject({ wave: 1, share: 1 });
    expect(report.waves[0]).toMatchObject({ roots: ["a", "c"], set_digest: pending[0].planDigest, approval: "approved" });
    expect(await applyWave(work, { ...opts(bin), share: 2, now: T(5) })).toBe(0);
    expect(applied(log)).toEqual(["a", "b", "c"]);
    expect(used()).toHaveLength(1);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending).toHaveLength(1);
  });

  it("a share whose plans moved since its wave decided applies nothing, names the root and exits 4", async () => {
    const { work, bin, log, plans } = setup();
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), now: T(1) })).toBe(0);
    writeFileSync(join(plans, "c.json"), create("moved"));
    const outcome = join(work, "..", "outcome");
    expect(await applyWave(work, { ...opts(bin, { gate: "never", env: { TG_OUTCOME: outcome } }), share: 1, now: T(2) })).toBe(4);
    expect(applied(log)).toEqual([]);
    expect(readFileSync(outcome, "utf-8")).toBe("wave 1 share 1 changed since the wave decided: c");
    // The other share's plans did not move, so it applies.
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), share: 2, now: T(3) })).toBe(0);
    expect(applied(log)).toEqual(["b"]);
  });

  it("a share applies nothing without its wave's decision, or with one for another split or commit", async () => {
    const { work, bin, log } = setup();
    await expect(applyWave(work, { ...opts(bin, { gate: "never" }), share: 1 })).rejects.toThrow(/the wave's own job writes it before its shares run/);
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), now: T(1) })).toBe(0);
    const file = join(work, decidedPath(1));
    const decision = JSON.parse(readFileSync(file, "utf-8"));
    writeFileSync(file, JSON.stringify({ ...decision, commit: "f".repeat(40) }));
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), share: 1 })).toBe(1);
    expect(await applyWave(work, { ...opts(bin, { gate: "never", shares: 3 }), share: 1 })).toBe(1);
    expect(applied(log)).toEqual([]);
  });

  it("a share of a wave whose plans change nothing plans nothing and applies nothing", async () => {
    const { work, bin, log, plans } = setup();
    for (const r of roots) writeFileSync(join(plans, `${r}.json`), JSON.stringify({ resource_changes: [] }));
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), now: T(1) })).toBe(0);
    expect(JSON.parse(readFileSync(join(work, decidedPath(1)), "utf-8"))).toMatchObject({ changes: 0, approval: "not-required" });
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), share: 2 })).toBe(0);
    expect(applied(log)).toEqual([]);
  });

  it("a wave of one root, or one job, applies in its own job as before", async () => {
    const { work, bin, log } = setup();
    expect(await applyWave(work, { ...opts(bin, { gate: "never", shares: 1 }), now: T(1) })).toBe(0);
    expect(applied(log)).toEqual(roots);
    expect(existsSync(join(work, decidedPath(1)))).toBe(false);
  });

  it("refuses --share without --shares, and a share past --shares", async () => {
    const { work, bin } = setup();
    await expect(applyWave(work, { ...opts(bin), shares: undefined, share: 1 })).rejects.toThrow("--share must be a share number from 1 to --shares");
    await expect(applyWave(work, { ...opts(bin), share: 3 })).rejects.toThrow("--share must be a share number from 1 to --shares");
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
