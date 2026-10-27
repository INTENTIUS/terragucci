// terragucci's words on chant's product pipeline (chant#4550, terragucci#1282 part c). With chant's
// `ci-product-words` and `ci-product` loaded, the comment grammar, the approve line, the status contexts and the
// pipeline's comment conditions come from chant; without them, terragucci's own code. Both give the same names, so
// branch protection, typed comments and the approvals already on `_gates/tf-apply.jsonl` keep working.
import { afterEach, describe, expect, it } from "vitest";
import { chantCiProduct, chantCiProductWords, overrideChantNext } from "../src/chant-next";
import { terragucciStatus, TERRAGUCCI_WORDS } from "../src/ci-words";
import { parseComment, type ParsedComment } from "../src/comment";
import { approveCommand } from "../src/report/marker";
import { renderPipeline, type PipelineInput } from "../src/render";

const words = await chantCiProductWords();
const product = await chantCiProduct();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});
const without = (): void => {
  restore.push(overrideChantNext("ciProductWords", null), overrideChantNext("ciProduct", null));
};

const COMMENTS: [string, boolean][] = [
  ["/terragucci plan", false],
  ["/terragucci plan envs/dev/orders", false],
  ["/terragucci apply", false],
  ["/terragucci apply wave-2", false],
  ["/terragucci lock", false],
  ["/terragucci unlock", false],
  ["/terragucci agent rename the bucket variable", false],
  ["atlantis plan -d envs/dev/orders", true],
  ["atlantis apply", true],
  ["a comment for someone else", false],
];

const kindOf = (p: ParsedComment | undefined): unknown => (p === undefined ? undefined : p.kind === "refused" ? "refused" : p);

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

  it("give terragucci's contexts and approve line without chant's module", () => {
    without();
    expect(terragucciStatus("plan")).toBe("terragucci/plan");
    expect(terragucciStatus("apply")).toBe("terragucci/apply");
    expect(terragucciStatus("lock")).toBe("terragucci/lock");
    expect(approveCommand(2, "abc123")).toBe("terragucci approve wave-2 --plan abc123");
    expect(approveCommand(2, "abc123", true)).toBe("terragucci approve wave-2 --plan abc123 --sign");
  });

  it.runIf(words)("give the same contexts and approve line through chant", () => {
    expect(terragucciStatus("plan")).toBe("terragucci/plan");
    expect(terragucciStatus("apply")).toBe("terragucci/apply");
    expect(terragucciStatus("lock")).toBe("terragucci/lock");
    expect(approveCommand(2, "abc123")).toBe("terragucci approve wave-2 --plan abc123");
    expect(approveCommand(2, "abc123", true)).toBe("terragucci approve wave-2 --plan abc123 --sign");
  });

  it.runIf(words)("read each comment as terragucci's own grammar does", () => {
    for (const [body, atlantis] of COMMENTS) {
      const o = atlantis ? { atlantis: true } : {};
      const chant = parseComment(body, o);
      without();
      const own = parseComment(body, o);
      for (const r of restore) r();
      restore = [];
      expect(kindOf(chant), body).toEqual(kindOf(own));
    }
  });

  it.runIf(words)("keep the migration guide's reason for an atlantis form terragucci has no counterpart for", () => {
    const chant = parseComment("atlantis apply -d envs/dev", { atlantis: true });
    without();
    expect(chant).toEqual(parseComment("atlantis apply -d envs/dev", { atlantis: true }));
  });
});

describe("the pipeline's comment conditions", () => {
  const input = (more: Partial<PipelineInput> = {}): PipelineInput =>
    ({ forge: "github", binary: "tofu", version: "1.10.0", image: "ghcr.io/intentius/terragucci:test", layers: [["network"], ["app"]], env: {}, ...more }) as PipelineInput;

  it.runIf(product)("render the same workflow through chant's product pipeline", () => {
    for (const more of [{}, { atlantisComments: true }, { locksPlan: true }, { applyWhen: "pull-request" as const }]) {
      const own = renderPipeline(input(more));
      const chant = renderPipeline(input({ ...more, ciProduct: product! }));
      expect(JSON.stringify(chant)).toBe(JSON.stringify(own));
    }
  });
});
