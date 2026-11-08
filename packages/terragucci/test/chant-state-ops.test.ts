/**
 * terragucci#1282 (unit g): the switches onto chant behind chant-next.ts's
 * loaders. Each part is stood in for with overrideChantNext, so no chant
 * release is needed: the product tool hook (chant#4555), the gated-request helpers
 * (chant#4551, #4618), and the member-prefixed module ledgers.
 */
import { afterEach, describe, expect, test } from "vitest";
import { overrideChantNext } from "../src/chant-next";
import { ledgerPrefixes } from "../src/publish/ledger";
import { asyncExec, requestRules } from "../src/gated-request";
import { productHook, TOOLS } from "../src/mcp";

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
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
