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

  describe("steps", () => {
    it("runs each moment once around the wave's run --all, in the dirs its globs match, and a step after plan holds the gate", async () => {
      const steps = [
        "steps:",
        "  - name: tfvars",
        '    run: echo "$TG_STAGE" > step.txt',
        "    before: plan",
        "  - name: verify",
        '    run: test -f "$TG_PLAN_FILE" && echo "plan of $TG_ROOT" >> step.txt && exit 1',
        "    after: plan",
        '    roots: ["live/a"]',
        "    on_failure: approve",
        "  - name: done",
        "    run: echo applied >> step.txt",
        "    after: apply",
      ].join("\n");
      const { work, origin } = setupWith({ "terragucci.yml": `gate: never\n${steps}\n` });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      // Under gate: never the step after plan holds wave 1, and nothing applies.
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(3);
      expect(tg.applied.size).toBe(0);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\n");
      expect(existsSync(join(work, "live/b/step.txt"))).toBe(false);
      expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 2: live/a: step verify asks for an approval, so the gate holds this wave");
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      expect(report.waves[0]).toMatchObject({ held_by_steps: ["live/a"] });
      expect(report.roots[0].steps.map((x: { name: string; status: string }) => `${x.name} ${x.status}`)).toEqual(["tfvars passed", "verify approval"]);
      // Approved, the wave applies its saved plan, and the step after apply runs.
      approve(origin, "wave-1", ledger(origin).pending[0]!.planDigest!, T(2));
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(3) })).toBe(0);
      expect([...tg.applied]).toEqual(["live/a"]);
      expect(readFileSync(join(work, "live/a/step.txt"), "utf-8")).toBe("tf-apply\nplan of live/a\napplied\n");
    });

    it("a step before the apply that fails applies nothing; after: init is refused", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\nsteps:\n  - name: stop\n    run: exit 1\n    before: apply\n" });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(1);
      expect(tg.applied.size).toBe(0);
      expect(runs(tg)).toEqual(["plan live/a"]);
      expect(out.mock.calls.flat().join("\n")).toContain("live/a: before-apply step stop failed (exit 1)");
      const late = setupWith({ "terragucci.yml": "gate: never\nsteps:\n  - name: late\n    run: echo late\n    after: init\n" });
      const tg2 = fakeTerragrunt();
      expect(await applyWave(late.work, { ...opts(tg2, "never"), wave: 1, now: T(1) })).toBe(1);
      expect(tg2.calls).toHaveLength(0);
      expect(out.mock.calls.flat().join("\n")).toContain("steps late: a Terragrunt repo inits each unit inside the wave's run --all plan");
    });
  });
});
