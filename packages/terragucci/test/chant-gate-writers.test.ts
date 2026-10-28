/**
 * terragucci#1282 (unit j): a tf-apply wave's ledger records on chant's gate
 * ledger writers (chant#4623), stood in for with overrideChantNext, so no
 * chant release is needed. Without them terragucci's own writer runs, which
 * apply.test.ts covers.
 */
import { afterEach, describe, expect, test } from "vitest";
import { overrideChantNext, type ChantGateWriters } from "../src/chant-next";
import { writeWaveFiles, writeWaveRecord } from "../src/apply";

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

function fakeWriters(push: { pushed: boolean; pushWarning?: string } = { pushed: true }, finished = true) {
  const calls: Array<{ method: string; cwd?: string; line: Record<string, unknown> }> = [];
  const blobs: Array<{ dir: string; file: string; content: string; cwd?: string }> = [];
  let pushes = 0;
  const writers: ChantGateWriters = {
    OP_WAVE_HOLD_RECORD_FLOOR: "0.125.0",
    gitGateLedgerPort: (opts) => ({
      appendPending: async (line) => (calls.push({ method: "appendPending", cwd: opts?.cwd, line }), push),
      appendResolution: async (line) => (calls.push({ method: "appendResolution", cwd: opts?.cwd, line }), push),
      appendApplied: async (line) => (calls.push({ method: "appendApplied", cwd: opts?.cwd, line }), push),
      ...(finished ? { appendFinished: async (line: Record<string, unknown>) => (calls.push({ method: "appendFinished", cwd: opts?.cwd, line }), push) } : {}),
    }),
    writeBlobToPath: async (dir, file, content, _message, opts) => {
      blobs.push({ dir, file, content, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return "sha";
    },
    pushLifecycleReport: async () => (pushes++, push),
    requireLifecycleLedger: async () => {},
    isLifecycleLocalNote: (w) => w === "recorded locally (no remote for chant/lifecycle)",
  };
  return { writers, calls, blobs, pushes: () => pushes };
}

const T = "2026-10-28T00:00:00.000Z";

describe("a tf-apply wave's records on chant's writers (terragucci#1282 part j)", () => {
  test("each kind goes to its writer at the repo: a pending fact and an approval without version and kind, the applied lines and the finished line as written", async () => {
    const f = fakeWriters();
    restore.push(overrideChantNext("gateWriters", f.writers));
    await writeWaveRecord("/repo", { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: T, expiresAt: T, planDigest: "sha256:a", neverOverMcp: true }, "pending");
    await writeWaveRecord("/repo", { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T, planDigest: "sha256:a", via: "pr-review" }, "approved");
    await writeWaveRecord("/repo", { version: 1, kind: "changes", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "changes");
    await writeWaveRecord("/repo", { version: 1, kind: "finished", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", applied: T, result: "applied", timestamp: T }, "finished");
    expect(f.calls.map((c) => [c.method, c.cwd])).toEqual([["appendPending", "/repo"], ["appendResolution", "/repo"], ["appendApplied", "/repo"], ["appendFinished", "/repo"]]);
    expect(f.calls[0]!.line).not.toHaveProperty("version");
    expect(f.calls[0]!.line).not.toHaveProperty("kind");
    expect(f.calls[1]!.line).toMatchObject({ kind: "resolution", resolvedBy: "alice", via: "pr-review" });
    expect(f.calls[1]!.line).not.toHaveProperty("version");
    expect(f.calls[2]!.line).toMatchObject({ version: 1, kind: "changes" });
    expect(f.calls[3]!.line).toMatchObject({ version: 1, kind: "finished", result: "applied" });
  });

  test("a finished line goes through appendApplied on a chant whose port has no appendFinished", async () => {
    const f = fakeWriters({ pushed: true }, false);
    restore.push(overrideChantNext("gateWriters", f.writers));
    await writeWaveRecord("/repo", { version: 1, kind: "finished", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", applied: T, result: "failed", timestamp: T }, "finished");
    expect(f.calls.map((c) => c.method)).toEqual(["appendApplied"]);
  });

  test("a line that does not reach the remote throws; one recorded locally with no remote does not", async () => {
    const refused = fakeWriters({ pushed: false, pushWarning: 'the push of chant/lifecycle to "origin" failed' });
    restore.push(overrideChantNext("gateWriters", refused.writers));
    await expect(writeWaveRecord("/repo", { version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "Applied under wave-1")).rejects.toThrow(/could not push the ledger record \(Applied under wave-1\)/);
    restore.pop()!();
    const local = fakeWriters({ pushed: false, pushWarning: "recorded locally (no remote for chant/lifecycle)" });
    restore.push(overrideChantNext("gateWriters", local.writers));
    await expect(writeWaveRecord("/repo", { version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "Applied under wave-1")).resolves.toBeUndefined();
  });

  test("the plans kept beside a pending fact are written with chant's writer, split into directory and file, and pushed once", async () => {
    const f = fakeWriters();
    restore.push(overrideChantNext("gateWriters", f.writers));
    await writeWaveFiles("/repo", { "_gates/tf-apply/wave-2/sha256_abc.json": "{}\n" }, "The plans of tf-apply wave-2: sha256:abc");
    expect(f.blobs).toEqual([{ dir: "_gates/tf-apply/wave-2", file: "sha256_abc.json", content: "{}\n", cwd: "/repo" }]);
    expect(f.pushes()).toBe(1);
  });
});
