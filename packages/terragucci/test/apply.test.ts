import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, applyWaves, approvedPath, decideGate, movedMembers, parseLedger, type GateLedger, type PendingRecord } from "../src/apply";
import { refusedDiff } from "../src/respond/refused";
import { gateSealPayload } from "../src/seal";
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
    expect(decideGate(l, "wave-1", "d1", T(3))).toEqual({ status: "approved", by: "alice" });
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

  it("an expired pending fact does not stand", () => {
    const l = ledger({ pending: [pending("wave-1", "d1", 1, 1)] });
    expect(decideGate(l, "wave-1", "d1", T(5))).toEqual({ status: "waiting" });
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

  it("records one pending fact with each root's digest, applies nothing, and records no second fact on a re-run", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = { wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} };
    expect(await applyWave(work, { ...opts, now: T(1) })).toBe(3);
    expect(existsSync(log)).toBe(false);
    const ledger = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    expect(ledger.resolutions).toEqual([]);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", members: [{ member: "a" }] });
    expect(ledger.pending[0].planDigest).toMatch(/\S/);

    expect(await applyWave(work, { ...opts, now: T(2) })).toBe(3);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending).toHaveLength(1);
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
  apply) echo "Apply complete! Resources: 0 added, 0 changed, 0 destroyed." ;;
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
  const most = (run: string): number => Math.max(...readFileSync(join(run, "counts"), "utf-8").split("\n").filter(Boolean).map(Number));
  const roots = ["r1", "r2", "r3", "r4", "r5", "r6"];

  it("never plans more roots at once than --parallelism", async () => {
    const { work, bin, run } = wave(roots);
    expect(await applyWave(work, { wave: 1, layers: [roots], binary: bin, gate: "never", env: process.env, parallelism: 2 })).toBe(0);
    expect(most(run)).toBeLessThanOrEqual(2);
    expect(most(run)).toBe(2);
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
