import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, applyWaves, decideGate, movedMembers, parseLedger, type GateLedger, type PendingRecord } from "../src/apply";
import { git, tmp } from "./helpers";

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

  function setup(): { work: string; origin: string; bin: string; log: string } {
    const dir = tmp("tg-wave-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(join(work, "a"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
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

  it("gate never applies the wave's plans without reading the ledger", async () => {
    const { work, origin, bin, log } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never" })).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(git(origin, "branch", "--list", "chant/lifecycle").trim()).toBe("");
  });
});
