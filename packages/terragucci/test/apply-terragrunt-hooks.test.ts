import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import type { CostRunner } from "../src/report/cost";
import { T, fakeTerragrunt, setupWith, approve, ledger, opts, runs } from "./apply-terragrunt-helpers";

describe("a Terragrunt wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("cost", () => {
    const priced = (delta: number): CostRunner => async () => ({ code: 0, stdout: JSON.stringify({ currency: "USD", totalMonthlyCost: String(delta), pastTotalMonthlyCost: "0", diffTotalMonthlyCost: String(delta) }), stderr: "" });
    const yml = "gate: never\ncost:\n  command: node cost.mjs\n  approve_above: 15\n";

    it("prices each unit's saved plan, and a wave over cost.approve_above waits under gate: never with its cost in the digest", async () => {
      const { work, origin } = setupWith({ "terragucci.yml": yml });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1), costRunner: priced(20) })).toBe(3);
      expect(tg.applied.size).toBe(0);
      expect(out.mock.calls.flat().join("\n")).toContain("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at ");
      const pending = ledger(origin).pending[0]!;
      expect(pending.members!.map((m) => m.member)).toEqual(["live/a", "(monthly cost)"]);
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      expect(report.waves[0]).toMatchObject({ approval: "waiting", cost: { monthly_delta: 20, approve_above: 15, over: true } });
      expect(report.cost).toMatchObject({ roots: [{ root: "live/a", monthly_delta: 20 }] });
      // The same plans priced higher are another digest: the approval of the first does not apply them.
      approve(origin, "wave-1", pending.planDigest!, T(2));
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(3), costRunner: priced(40) })).toBe(4);
      expect(tg.applied.size).toBe(0);
      // Within the amount, gate: never applies.
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(4), costRunner: priced(10) })).toBe(0);
      expect([...tg.applied]).toEqual(["live/a"]);
    });
  });

  describe("ci.hooks", () => {
    const decl = (hooks: unknown): string => `${JSON.stringify({ name: "t", schema: 1, minReader: "0.102.0", members: [], ci: { hooks } }, null, 2)}\n`;
    const sh = (run: string): string[] => ["sh", "-c", run];

    it("runs each moment once around the wave's run --all, in the dirs its targets match, and a hook after plan holds the gate", async () => {
      const hooks = {
        before: { plan: [{ name: "tfvars", command: sh('echo "$TG_STAGE" > step.txt'), perRun: true }] },
        after: {
          plan: [{ name: "verify", command: sh('test -f "$TG_PLAN_FILE" && echo "plan of $TG_ROOT" >> step.txt && exit 1'), perRun: true, targets: ["live/a"], onFailure: "approve" }],
          apply: [{ name: "done", command: sh("echo applied >> step.txt"), perRun: true }],
        },
      };
      const { work, origin } = setupWith({ "terragucci.yml": "gate: never\n", "chant.workspace.json": decl(hooks) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      // Under gate: never the hook after plan holds wave 1, and nothing applies.
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(3);
      expect(tg.applied.size).toBe(0);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\n");
      expect(existsSync(join(work, "live/b/step.txt"))).toBe(false);
      expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 2: live/a: hook verify asks for an approval, so the gate holds this wave");
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      expect(report.waves[0]).toMatchObject({ held_by_steps: ["live/a"] });
      expect(report.roots[0].steps.map((x: { name: string; status: string }) => `${x.name} ${x.status}`)).toEqual(["tfvars passed", "verify approval"]);
      // Approved, the wave applies its saved plan, and the hook after apply runs.
      approve(origin, "wave-1", ledger(origin).pending[0]!.planDigest!, T(2));
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(3) })).toBe(0);
      expect([...tg.applied]).toEqual(["live/a"]);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\napplied\n");
    });

    it("a hook before the apply that fails applies nothing", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n", "chant.workspace.json": decl({ before: { apply: [{ name: "stop", command: sh("exit 1"), perRun: true }] } }) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(1);
      expect(tg.applied.size).toBe(0);
      expect(runs(tg)).toEqual(["plan live/a"]);
      expect(out.mock.calls.flat().join("\n")).toContain("hook before-apply stop failed with exit 1");
    });
  });
});
