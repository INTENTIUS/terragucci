import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLIED_PATH, applyWave, parseApplied, parseLedger } from "../src/apply";
import type { PolicyExec } from "../src/report/policy";
import type { CostRunner } from "../src/report/cost";
import { git, write } from "./helpers";
import { T, FAKE, setup, approve } from "./apply-helpers";

describe("a wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("an approved choudoufu apply that stopped before it finished", () => {
    const opts = (bin: string) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {} });
    const ledgerOf = (origin: string) => parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));
    const appliedText = (origin: string) => git(origin, "show", `chant/lifecycle:${APPLIED_PATH}`);
    const create = (name: string, input: string) => ({ address: `terraform_data.${name}`, mode: "managed", type: "terraform_data", name, change: { actions: ["create"], before: null, after: { input }, after_unknown: {} } });
    /** Root a's plan: these changes, its records holding `recorded`. */
    const planA = (work: string, changes: unknown[], recorded: string[] = []) =>
      writeFileSync(join(work, "..", "plans", "a.json"), JSON.stringify({ resource_changes: changes, prior_state: { values: { root_module: { resources: recorded.map((address) => ({ address, mode: "managed", values: {} })) } } } }));
    /** A fake choudoufu: FAKE, whose apply fails while $FAIL exists. */
    function choudoufu(work: string): string {
      const bin = join(work, "..", "choudoufu");
      writeFileSync(bin, FAKE.replace('apply) echo', 'apply) [ -e "$FAIL" ] && { echo "Error: the apply of terraform_data.second failed"; exit 1; }; echo'));
      chmodSync(bin, 0o755);
      vi.stubEnv("FAIL", join(work, "..", "fail"));
      return bin;
    }
    /** Wave 1 plans first and second, waits, is approved, and its apply fails after first was recorded. */
    async function stopped(): Promise<{ work: string; origin: string; bin: string; log: string; digest: string }> {
      const { work, origin, log } = setup();
      const bin = choudoufu(work);
      planA(work, [create("first", "1"), create("second", "2")]);
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
      const digest = ledgerOf(origin).pending[0]!.planDigest!;
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
      writeFileSync(join(work, "..", "fail"), "");
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(1);
      renameSync(join(work, "..", "fail"), join(work, "..", "fail.off"));
      return { work, origin, bin, log, digest };
    }

    it("records each change it approved, and that the apply failed", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { origin, digest } = await stopped();
      const text = appliedText(origin);
      const [spent, applied] = parseApplied(text);
      expect(spent).toMatchObject({ kind: "applied", planDigest: digest, approvedAt: T(2) });
      expect(spent).not.toHaveProperty("changes");
      expect(applied).toMatchObject({ kind: "changes", planDigest: digest, approvedAt: T(2), changes: [{ root: "a", address: "terraform_data.first", actions: "create" }, { root: "a", address: "terraform_data.second", actions: "create" }] });
      expect(text).toContain(`"kind":"finished","op":"tf-apply","gate":"wave-1","planDigest":"${digest}","applied":"${T(3)}","result":"failed"`);
    });

    it("applies the rest under the same approval once first is in the records, and records that it resumed", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, digest } = await stopped();
      planA(work, [create("second", "2")], ["terraform_data.first"]);
      lines.length = 0;
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(0);
      expect(lines.join("\n")).toContain(`the apply of ${digest}, approved by alice, stopped before it finished; 1 of its 2 changes are done in the records, and these plans make the other 1, so that approval covers them`);
      expect(ledgerOf(origin).pending).toHaveLength(1);
      // The wave records that alice's approval covers the rest, and chant applies under that line.
      const [, covered] = ledgerOf(origin).resolutions;
      expect(covered).toMatchObject({ resolvedBy: "alice", note: `the rest of the apply of ${digest}, which alice approved at ${T(2)}` });
      const resumed = parseApplied(appliedText(origin)).at(-1)!;
      expect(resumed).toMatchObject({ kind: "changes", approvedAt: covered!.timestamp, approvedBy: "alice", resumes: digest, changes: [{ address: "terraform_data.second" }] });
      expect(resumed.planDigest).not.toBe(digest);
      expect(appliedText(origin)).toContain(`"applied":"${T(4)}","result":"applied"`);
    });

    it("waits for an approval of its own when a remaining change moved since the approval", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
      const { work, origin, bin, digest } = await stopped();
      planA(work, [create("second", "3")], ["terraform_data.first"]);
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(3);
      expect(lines.join("\n")).toContain(`the apply of ${digest}, approved by alice, stopped before it finished, but a terraform_data.second is a change the approved plans did not make, so these plans need an approval of their own`);
      expect(ledgerOf(origin).pending).toHaveLength(2);
    });

    it("leaves a stock binary's wave to wait for an approval of the plans it makes", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { work, origin, bin, log } = setup();
      planA(work, [create("first", "1"), create("second", "2")]);
      expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(3);
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: ledgerOf(origin).pending[0]!.planDigest! });
      expect(await applyWave(work, { ...opts(bin), now: T(3) })).toBe(0);
      expect(parseApplied(appliedText(origin)).filter((a) => a.changes)).toEqual([]);
      planA(work, [create("second", "2")], ["terraform_data.first"]);
      writeFileSync(log, "");
      expect(await applyWave(work, { ...opts(bin), now: T(4) })).toBe(3);
      expect(readFileSync(log, "utf-8")).toBe("");
    });
  });

  describe("cost.approve_above", () => {
    const yml = (amount: number) => `gate: never\ncost:\n  command: node cost.mjs\n  approve_above: ${amount}\n`;
    const priced = (delta: number): CostRunner => async () => ({ code: 0, stdout: JSON.stringify({ currency: "USD", totalMonthlyCost: String(delta), pastTotalMonthlyCost: "0", diffTotalMonthlyCost: String(delta) }), stderr: "" });
    const opts = (bin: string, delta: number) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: {}, costRunner: priced(delta) });
    const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));

    it("holds a wave whose change is over the amount under gate: never, names the amount, and applies one within it", async () => {
      const { work, origin, bin, log } = setup({ "terragucci.yml": yml(15) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      const text = out.mock.calls.flat().join("\n");
      expect(text).toContain("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at ");
      expect(text).toContain("so it waits for an approval although gate is never");
      const pending = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!;
      expect(pending.members!.map((m) => m.member)).toEqual(["a", "(monthly cost)"]);
      expect(report(work).waves[0]).toMatchObject({ approval: "waiting", cost: { monthly_delta: 20, approve_above: 15, over: true } });
      expect(report(work).cost).toMatchObject({ monthly_delta: 20, roots: [{ root: "a", output: "roots/a/cost.json" }] });
      expect(existsSync(join(work, "terragucci-report", "roots", "a", "cost.json"))).toBe(true);
      // Within the amount, gate: never applies it.
      expect(await applyWave(work, { ...opts(bin, 10), now: T(2) })).toBe(0);
      expect(readFileSync(log, "utf-8")).toContain("applied a");
      expect(report(work).waves[0]).toMatchObject({ approval: "not-required", cost: { monthly_delta: 10, over: false } });
    });

    it("binds the cost into the digest: an approval of the plans at one cost does not apply them at another", async () => {
      const { work, origin, bin, log } = setup({ "terragucci.yml": yml(15) });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      const digest = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending[0]!.planDigest!;
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(2), planDigest: digest });
      // The same plans, priced higher: the approval is of another digest, so nothing applies and the cost is named as what moved.
      expect(await applyWave(work, { ...opts(bin, 40), now: T(3) })).toBe(4);
      expect(existsSync(log)).toBe(false);
      expect(out.mock.calls.flat().join("\n")).toContain("these roots planned differently since: (monthly cost)");
      // The refusal asked for the new digest; approved again at the first cost, the plans at that cost apply.
      approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: T(4), planDigest: digest });
      expect(await applyWave(work, { ...opts(bin, 20), now: T(5) })).toBe(0);
      expect(readFileSync(log, "utf-8")).toContain("applied a");
    });

    it("reads the amount at the commit before the one applied, so a change that raises it still waits", async () => {
      const { work, bin, log } = setup({ "terragucci.yml": yml(15) });
      write(work, { "terragucci.yml": yml(1000) });
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "raise the amount");
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1) })).toBe(3);
      expect(existsSync(log)).toBe(false);
      const text = out.mock.calls.flat().join("\n");
      expect(text).toMatch(/approve_above is 1000 here and 15 at [0-9a-f]{40}; the amount at [0-9a-f]{40} counts/);
      expect(text).toContain("over cost.approve_above 15.00 USD");
    });

    it("gives the policy each root's cost and the wave's", async () => {
      const { work, bin } = setup({ "terragucci.yml": `${yml(15)}policy:\n  path: policy\n`, "policy/p.rego": "package main\n" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      const inputs: Record<string, unknown>[] = [];
      const deny: PolicyExec = async (_f, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
        inputs.push(JSON.parse(readFileSync(args[args.length - 1], "utf-8")));
        return { status: 1, stdout: JSON.stringify([{ failures: [{ msg: "the wave adds more than 15.00 a month" }] }]), stderr: "" };
      };
      expect(await applyWave(work, { ...opts(bin, 20), now: T(1), policy: { exec: deny } })).toBe(1);
      expect(inputs[0]).toMatchObject({ cost: { currency: "USD", root: { monthly_delta: 20 }, wave: { number: 1, monthly_delta: 20 }, approve_above: 15 } });
    });

    it("leaves a wave alone, and prices nothing, without cost", async () => {
      const { work, bin } = setup({ "terragucci.yml": "gate: never\n" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      let ran = 0;
      expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "never", env: {}, now: T(1), costRunner: async () => (ran++, { code: 1, stdout: "", stderr: "" }) })).toBe(0);
      expect(ran).toBe(0);
      expect(report(work).cost).toBeUndefined();
    });
  });
});
