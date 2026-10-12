import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLIED_PATH, applyWave, decidedPath, parseApplied as readApplied, parseLedger } from "../src/apply";
import { git, tmp } from "./helpers";
import { T, FAKE } from "./apply-helpers";

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
    // chant reads the wave's rules at a commit.
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
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
    // Approved, the wave's job records the approval used once, hands chant's decision (every root's digest) to its shares and applies nothing.
    expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
    expect(applied(log)).toEqual([]);
    const decision = JSON.parse(readFileSync(join(work, decidedPath(1)), "utf-8"));
    expect(decision).toMatchObject({ wave: 1, gate: "wave-1", digest: pending[0].planDigest, status: "approved" });
    expect(decision.members.map((m: { member: string }) => m.member)).toEqual(roots);
    const used = () => readApplied(git(origin, "show", `chant/lifecycle:${APPLIED_PATH}`));
    expect(used()).toHaveLength(1);
    // Each share applies its roots alone (sorted, cut into contiguous shares), reads no gate and records nothing more.
    expect(await applyWave(work, { ...opts(bin), share: 1, now: T(4) })).toBe(0);
    expect(applied(log)).toEqual(["a", "b"]);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.run).toMatchObject({ wave: 1, share: 1 });
    expect(report.waves[0]).toMatchObject({ roots: ["a", "b"], set_digest: pending[0].planDigest, approval: "approved" });
    expect(await applyWave(work, { ...opts(bin), share: 2, now: T(5) })).toBe(0);
    expect(applied(log)).toEqual(["a", "b", "c"]);
    expect(used()).toHaveLength(1);
    expect(parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending).toHaveLength(1);
  });

  it("a share whose plans moved since its wave decided applies nothing, names the root and exits 4", async () => {
    const { work, bin, log, plans } = setup();
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), now: T(1) })).toBe(0);
    writeFileSync(join(plans, "b.json"), create("moved"));
    const outcome = join(work, "..", "outcome");
    expect(await applyWave(work, { ...opts(bin, { gate: "never", env: { TG_OUTCOME: outcome } }), share: 1, now: T(2) })).toBe(4);
    // chant applies the share's runs whose plans did not move, and refuses the one that did.
    expect(applied(log)).toEqual(["a"]);
    expect(readFileSync(outcome, "utf-8")).toBe("wave 1 share 1 changed since the wave decided: b");
    // The other share's plans did not move, so it applies.
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), share: 2, now: T(3) })).toBe(0);
    expect(applied(log)).toEqual(["a", "c"]);
  });

  it("a share applies nothing without its wave's decision", async () => {
    const { work, bin, log } = setup();
    await expect(applyWave(work, { ...opts(bin, { gate: "never" }), share: 1 })).rejects.toThrow(/the wave's own job writes it before its shares run/);
    expect(applied(log)).toEqual([]);
  });

  it("a share of a wave whose plans change nothing plans nothing and applies nothing", async () => {
    const { work, bin, log, plans } = setup();
    for (const r of roots) writeFileSync(join(plans, `${r}.json`), JSON.stringify({ resource_changes: [] }));
    expect(await applyWave(work, { ...opts(bin, { gate: "never" }), now: T(1) })).toBe(0);
    expect(JSON.parse(readFileSync(join(work, decidedPath(1)), "utf-8"))).toMatchObject({ status: "not-required" });
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
