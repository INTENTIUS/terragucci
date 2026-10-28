// terragucci's words on chant's product pipeline (chant#4550, terragucci#1282 part c): the comment grammar, the
// approve line, the status contexts and the pipeline's comment conditions come from chant's `ci-product-words` and
// `ci-product` with terragucci's words. They give the names terragucci always gave, so branch protection, typed
// comments and the approvals already on `_gates/tf-apply.jsonl` keep working.
import { describe, expect, it } from "vitest";
import { terragucciStatus, TERRAGUCCI_WORDS } from "../src/ci-words";
import { parseComment, type ParsedComment } from "../src/comment";
import { approveCommand } from "../src/report/marker";

const COMMENTS: [string, boolean, ParsedComment | undefined][] = [
  ["/terragucci plan", false, { kind: "plan" }],
  ["/terragucci plan envs/dev/orders", false, { kind: "plan", root: "envs/dev/orders" }],
  ["/terragucci apply", false, { kind: "apply" }],
  ["/terragucci apply wave-2", false, { kind: "apply", wave: 2 }],
  ["/terragucci lock", false, { kind: "lock" }],
  ["/terragucci unlock", false, { kind: "unlock" }],
  ["/terragucci agent rename the bucket variable", false, { kind: "agent", ask: "rename the bucket variable" }],
  ["atlantis plan -d envs/dev/orders", true, { kind: "plan", root: "envs/dev/orders" }],
  ["atlantis apply", true, { kind: "apply" }],
  ["a comment for someone else", false, undefined],
];

describe("terragucci's words", () => {
  it("name every slot chant#4550 lists for terragucci", () => {
    expect(TERRAGUCCI_WORDS).toMatchObject({
      product: "terragucci",
      noun: ["root", "roots"],
      commands: { plan: "plan", apply: "apply", lock: "lock", unlock: "unlock", agent: "agent" },
      approve: "terragucci approve {gate} --plan {digest} {sign}",
      op: "tf-apply",
      gateName: "wave-{k}",
      approval: "per-wave",
      adoptMarkers: ["<!-- terragucci:waves -->"],
      bin: "npx --no-install terragucci",
    });
    expect(TERRAGUCCI_WORDS.aliases.map((a) => [a.from, a.command, a.when])).toEqual([
      ["atlantis plan", "plan", "TG_ATLANTIS_COMMENTS"],
      ["atlantis apply", "apply", "TG_ATLANTIS_COMMENTS"],
    ]);
  });

  it("give terragucci's contexts and approve line through chant", () => {
    expect(terragucciStatus("plan")).toBe("terragucci/plan");
    expect(terragucciStatus("apply")).toBe("terragucci/apply");
    expect(terragucciStatus("lock")).toBe("terragucci/lock");
    expect(approveCommand(2, "abc123")).toBe("terragucci approve wave-2 --plan abc123");
    expect(approveCommand(2, "abc123", true)).toBe("terragucci approve wave-2 --plan abc123 --sign");
  });

  it("read each comment in terragucci's grammar", () => {
    for (const [body, atlantis, want] of COMMENTS) expect(parseComment(body, atlantis ? { atlantis: true } : {}), body).toEqual(want);
  });

  it("keep the migration guide's reason for an atlantis form terragucci has no counterpart for", () => {
    expect(parseComment("atlantis apply -d envs/dev", { atlantis: true })).toMatchObject({ kind: "refused", reason: expect.stringContaining("applies one root") });
  });
});
