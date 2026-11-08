/**
 * A tf-apply wave's ledger records on chant's gate ledger writers (chant#4623):
 * chant's port and push stood in for with vi.mock, so each kind of line is
 * seen reaching its writer. The real writers on a real ledger are covered by
 * apply.test.ts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

type Push = { pushed: boolean; pushWarning?: string };
const fake: {
  push: Push;
  finished: boolean;
  calls: Array<{ method: string; cwd?: string; line: Record<string, unknown> }>;
  files: Array<{ path: string; content: string }>;
  pushes: number;
} = { push: { pushed: true }, finished: true, calls: [], files: [], pushes: 0 };

vi.mock("@intentius/chant/op/gate", async (real: () => Promise<Record<string, unknown>>) => ({
  ...(await real()),
  gitGateLedgerPort: (opts?: { cwd?: string }) => ({
    appendPending: async (line: Record<string, unknown>) => (fake.calls.push({ method: "appendPending", cwd: opts?.cwd, line }), fake.push),
    appendResolution: async (line: Record<string, unknown>) => (fake.calls.push({ method: "appendResolution", cwd: opts?.cwd, line }), fake.push),
    appendApplied: async (line: Record<string, unknown>) => (fake.calls.push({ method: "appendApplied", cwd: opts?.cwd, line }), fake.push),
    ...(fake.finished ? { appendFinished: async (line: Record<string, unknown>) => (fake.calls.push({ method: "appendFinished", cwd: opts?.cwd, line }), fake.push) } : {}),
  }),
}));
vi.mock("@intentius/chant/lifecycle/git", async (real: () => Promise<Record<string, unknown>>) => ({
  ...(await real()),
  requireLifecycleLedger: async () => {},
  readPathSha: async () => null,
  writeLedgerFiles: async (files: Array<{ path: string; content: string }>) => (fake.files.push(...files), "sha"),
  pushLifecycleRebasing: async () => (fake.pushes++, fake.push),
}));

const { writeWaveFiles, writeWaveRecord } = await import("../src/apply");

afterEach(() => {
  Object.assign(fake, { push: { pushed: true }, finished: true, calls: [], files: [], pushes: 0 });
});

const T = "2026-10-28T00:00:00.000Z";

describe("a tf-apply wave's records on chant's writers", () => {
  test("each kind goes to its writer at the repo: a pending fact and an approval without version and kind, the applied lines and the finished line as written", async () => {
    await writeWaveRecord("/repo", { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: T, expiresAt: T, planDigest: "sha256:a", neverOverMcp: true }, "pending");
    await writeWaveRecord("/repo", { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T, planDigest: "sha256:a", via: "pr-review" }, "approved");
    await writeWaveRecord("/repo", { version: 1, kind: "changes", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "changes");
    await writeWaveRecord("/repo", { version: 1, kind: "finished", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", applied: T, result: "applied", timestamp: T }, "finished");
    expect(fake.calls.map((c) => [c.method, c.cwd])).toEqual([["appendPending", "/repo"], ["appendResolution", "/repo"], ["appendApplied", "/repo"], ["appendFinished", "/repo"]]);
    expect(fake.calls[0]!.line).not.toHaveProperty("version");
    expect(fake.calls[0]!.line).not.toHaveProperty("kind");
    expect(fake.calls[1]!.line).toMatchObject({ kind: "resolution", resolvedBy: "alice", via: "pr-review" });
    expect(fake.calls[1]!.line).not.toHaveProperty("version");
    expect(fake.calls[2]!.line).toMatchObject({ version: 1, kind: "changes" });
    expect(fake.calls[3]!.line).toMatchObject({ version: 1, kind: "finished", result: "applied" });
  });

  test("a finished line goes through appendApplied when the port has no appendFinished", async () => {
    fake.finished = false;
    await writeWaveRecord("/repo", { version: 1, kind: "finished", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", applied: T, result: "failed", timestamp: T }, "finished");
    expect(fake.calls.map((c) => c.method)).toEqual(["appendApplied"]);
  });

  test("a line that does not reach the remote throws; one recorded locally with no remote does not", async () => {
    fake.push = { pushed: false, pushWarning: 'the push of chant/lifecycle to "origin" failed' };
    await expect(writeWaveRecord("/repo", { version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "Applied under wave-1")).rejects.toThrow(/could not push the ledger record \(Applied under wave-1\)/);
    fake.push = { pushed: false, pushWarning: "recorded locally (no remote for chant/lifecycle)" };
    await expect(writeWaveRecord("/repo", { version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: "sha256:a", approvedAt: T, approvedBy: "alice", timestamp: T }, "Applied under wave-1")).resolves.toBeUndefined();
  });

  test("the plans kept beside a pending fact are written in one commit at their full paths and pushed once", async () => {
    await writeWaveFiles("/repo", { "_gates/tf-apply/wave-2/sha256_abc.json": "{}\n" }, "The plans of tf-apply wave-2: sha256:abc");
    expect(fake.files).toEqual([{ path: "_gates/tf-apply/wave-2/sha256_abc.json", content: "{}\n" }]);
    expect(fake.pushes).toBe(1);
  });
});
