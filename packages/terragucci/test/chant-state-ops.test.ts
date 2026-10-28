/**
 * terragucci#1282 (unit g): the switches onto chant behind chant-next.ts's
 * loaders. Each part is stood in for with overrideChantNext, so no chant
 * release is needed: row leases (chant#4552, #4594), the changelog bump
 * (chant#4597), the product tool hook (chant#4555), the gated-request helpers
 * (chant#4551, #4618), and the member-prefixed module ledgers.
 */
import { afterEach, describe, expect, test } from "vitest";
import { overrideChantNext, type ChantLockRow, type ChantLockRows } from "../src/chant-next";
import { CHANT_ROWS_GATE, planRows, planRowsVia, releaseRowsVia, takeRowsVia } from "../src/apply-rows";
import { bumpFor, ownBumpFor } from "../src/publish/semver";
import { ledgerPrefixes } from "../src/publish/ledger";
import { asyncExec, requestRules } from "../src/gated-request";
import { productHook, TOOLS } from "../src/mcp";

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

const PLAN = { resource_changes: [{ address: "aws_s3_bucket.logs", mode: "managed", change: { actions: ["update"], before: { id: "logs-1" } } }] };

function fakeRows(): ChantLockRows & { taken: Array<{ gate: string; rows: readonly ChantLockRow[] }>; released: string[][] } {
  const taken: Array<{ gate: string; rows: readonly ChantLockRow[] }> = [];
  const released: string[][] = [];
  return {
    taken,
    released,
    terraformLockRows: (root, estate, plan) => planRows(root, estate, plan).map((r) => ({ key: r.key, target: r.root, address: r.address })),
    async takeLockRows(gate, rows) {
      taken.push({ gate, rows });
      if (rows.some((r) => r.key === "object held-1")) return { ok: false, held: [{ key: "object held-1", wanted: "object held-1", holder: { run: "77", at: "2026-10-27T10:00:00Z" } }] };
      return { ok: true, tookOver: [], pushed: true };
    },
    async releaseLockRows(_gate, keys) {
      released.push([...keys]);
      return true;
    },
    async readLockRows() {
      return { version: 1, holders: {}, rows: {} };
    },
    lockRowsPath: (gate) => `_locks/rows/${gate}.json`,
  };
}

describe("row leases through chant", () => {
  test("the rows are the lexicon's, with the same keys as planRows", async () => {
    restore.push(overrideChantNext("lockRows", fakeRows()));
    expect(await planRowsVia("net", "e01", PLAN)).toEqual(planRows("net", "e01", PLAN));
  });

  test("a take and a release go to the pull-request loop's rows file", async () => {
    const chant = fakeRows();
    restore.push(overrideChantNext("lockRows", chant));
    const rows = planRows("net", "e01", PLAN);
    const me = { run: "100", at: "2026-10-27T11:00:00Z" };
    expect(await takeRowsVia("/repo", rows, me, async () => "alive")).toEqual({ ok: true, tookOver: [] });
    expect(chant.taken[0]!.gate).toBe(CHANT_ROWS_GATE);
    expect(await releaseRowsVia("/repo", rows.map((r) => r.key), me.run)).toBe(true);
    expect(chant.released).toEqual([rows.map((r) => r.key)]);
  });

  test("a row another run holds names the row this take wanted", async () => {
    restore.push(overrideChantNext("lockRows", fakeRows()));
    const held = await takeRowsVia("/repo", [{ key: "object held-1", root: "net", address: "aws_s3_bucket.logs" }], { run: "100", at: "" }, async () => "alive");
    expect(held).toEqual({ ok: false, held: [{ key: "object held-1", holder: { run: "77", at: "2026-10-27T10:00:00Z" } }] });
  });
});

describe("bumpFor", () => {
  test("chant's changelogBump decides when it is loaded, and the fallback keeps the same rules", () => {
    restore.push(overrideChantNext("changelog", { changelogBump: () => "minor" }));
    expect(bumpFor(["fix: a"])).toBe("minor");
    restore.pop()!();
    restore.push(overrideChantNext("changelog", null));
    expect(bumpFor(["feat!: b"])).toBe("major");
    expect(ownBumpFor(["fix: a", "feat: b"])).toBe("minor");
  });
});

describe("module ledgers under a member prefix", () => {
  test("the flat ledger and every member's, nested too, and nothing else", () => {
    expect(
      ledgerPrefixes([
        "modules/releases.jsonl",
        "_members/net/modules/releases.jsonl",
        "_members/platform/_members/dns/modules/releases.jsonl",
        "_members/net/modules/attest/sha256_ab/signature.bundle",
        "other/releases.jsonl",
      ]),
    ).toEqual(["", "_members/net/", "_members/platform/_members/dns/"]);
  });
});

describe("gated-request helpers", () => {
  test("the rules carry the mode and approval_rules as the quorum", () => {
    expect(requestRules({ mode: "ledger" })).toEqual({ mode: "ledger" });
    const quorum = [{ targets: ["net"], count: 2 }] as never;
    expect(requestRules({ mode: "sealed", approvalRules: quorum })).toEqual({ mode: "sealed", quorum });
  });

  test("a synchronous exec is handed to the lexicon as an async one", async () => {
    const exec = asyncExec(() => ({ status: 2, stdout: "x", out: "x and y" }));
    expect(await exec("terraform", ["plan"], "/r", {})).toEqual({ code: 2, stdout: "x", out: "x and y" });
  });
});

describe("terragucci mcp on chant's product tool hook", () => {
  test("every tool is offered read-only under terragucci, with its own schema", () => {
    const hook = productHook({ cwd: "/repo", config: {} });
    expect(hook.product).toBe("terragucci");
    expect(hook.readOnly).toBe(true);
    const tools = hook.tools({ cwd: "/repo", readOnly: true });
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.readOnly === true)).toBe(true);
  });

  test("a tool still refuses an argument it does not list", async () => {
    const [tool] = productHook({ cwd: "/repo", config: {} }).tools({ cwd: "/repo", readOnly: true });
    await expect(tool!.handler({ token: "x" })).rejects.toThrow(/credentials from its own environment/);
  });
});
