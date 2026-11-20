import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeSetDigest } from "@intentius/chant/change-set";
import { costEnv } from "@intentius/chant/ci-product";
import { opWaveCostVerdict, OP_WAVE_COST_MEMBER } from "@intentius/chant/op";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig, type ProjectSettings } from "../src/config";
import { INFRACOST_VERSION } from "../src/install";
import { buildReport } from "../src/report/build";
import { costArgv, costCommand, costExec, costHold, costHoldEnv, costReason, costRule, estimateRoots, INFRACOST_COMMAND, noteCostOf, policyCostOf, reportCostOf, reportWaveCostOf, signed, waveCostVerdict, type CostRunner } from "../src/cost";
import { policyInput, type PolicyExec } from "../src/report/policy";
import { REDACTED } from "../src/report/schema";
import { runStage } from "../src/report/stage";
import { costGateLine, renderNote } from "../src/report/views";
import { confirmScript, renderPipeline } from "../src/render";
import { git, tmp, write } from "./helpers";
import { holdSecretValue } from "../src/secret-values";
import { waveCallArgv, wavesStepSpec } from "../src/chant-waves";
import { plan as planJson, rc, RUN } from "./report-fixtures";

const infracost = (diff: string, total: string, past: string): string => JSON.stringify({ version: "0.2", currency: "USD", totalMonthlyCost: total, pastTotalMonthlyCost: past, diffTotalMonthlyCost: diff, projects: [] });

/** A runner that answers by the root chant fills in for `{target}` (the argv's sixth element). */
const byRoot = (figures: Record<string, string>, seen: string[][] = []): CostRunner => (argv) => {
  seen.push(argv);
  const out = figures[argv[5]!];
  return out ? { status: 0, stdout: out, stderr: "" } : { status: 1, stdout: "", stderr: "Error: no API key\nNode.js v22.0.0\n" };
};

/** Plan documents for `roots`, each a plan that creates one resource, as chant's step writes them. */
function plans(roots: string[]): { root: string; planJson: string; empty: boolean }[] {
  const dir = tmp();
  return roots.map((root) => {
    const file = join(dir, `${root}.json`);
    write(dir, { [`${root}.json`]: JSON.stringify(planJson([rc("terraform_data.x", ["create"], null, { input: 1 })])) });
    return { root, planJson: file, empty: false };
  });
}

/** What the release before wrote for the same figures (fixtures/cost-from-chant/old.json, from its report/cost.ts and views.ts). */
const OLD = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/cost-from-chant/old.json"), "utf-8")) as {
  cost: { roots: { root: string; error?: string }[] } & Record<string, unknown>;
  outputs: Record<string, string>;
  waveCosts: Record<string, unknown>[];
  policy: Record<string, unknown>;
  gate: string;
};

describe("cost: chant's estimate, as terragucci maps it", () => {
  it("hands chant cost.command as sh -c with {planJson} and {target}, Infracost when no command is set", () => {
    expect(costArgv("node cost.mjs")).toEqual(["sh", "-c", 'TG_PLAN_JSON="$1" TG_ROOT="$2"; export TG_PLAN_JSON TG_ROOT; node cost.mjs', "sh", "{planJson}", "{target}"]);
    expect(costCommand(true)).toBe(INFRACOST_COMMAND);
    expect(costCommand({ command: "node cost.mjs" })).toBe("node cost.mjs");
    expect(signed(3)).toBe("+3.00");
    expect(signed(-0.5)).toBe("-0.50");
  });

  it("runs the command on chant's redacted plan with terragucci's secrets: values scrubbed and without TG_TOKEN, once per root that changes something", () => {
    const dir = tmp();
    // A value terragucci's secrets: fetched, in an attribute the plan does not mark: chant cannot know it, so terragucci scrubs it.
    holdSecretValue("held-store-value-6f2c", {}, { logs: false });
    write(dir, { "secret.json": JSON.stringify({ ...planJson([rc("aws_db_instance.db", ["create"], null, { password: "hunter2", tag: "held-store-value-6f2c" }, { after_sensitive: { password: true } })]) }) });
    const out = join(dir, "seen");
    mkdirSync(out);
    // A real shell: the command sees $TG_PLAN_JSON and $TG_ROOT as before.
    const command = `cp "$TG_PLAN_JSON" "${out}/$TG_ROOT.plan"; printf '%s' "\${TG_TOKEN:-none}" > "${out}/$TG_ROOT.token"; echo '${infracost("20", "20", "0")}'`;
    const run = costExec({ PATH: process.env.PATH, TG_TOKEN: "forge-secret" });
    const estimate = estimateRoots({ command }, [{ root: "db", planJson: join(dir, "secret.json"), empty: false }, { root: "same", planJson: join(dir, "secret.json"), empty: true }], dir, run.exec);
    expect(estimate.members.map((m) => m.member)).toEqual(["db"]);
    const seen = readFileSync(join(out, "db.plan"), "utf-8");
    // chant redacts what the plan marks (chant#5416); terragucci scrubs the held value.
    expect(seen).not.toContain("hunter2");
    expect(seen).not.toContain("held-store-value-6f2c");
    expect(seen).toContain(REDACTED);
    // The original plan document is left as it was.
    expect(readFileSync(join(dir, "secret.json"), "utf-8")).toContain("hunter2");
    expect(readFileSync(join(out, "db.token"), "utf-8")).toBe("none");
    expect(estimate).toMatchObject({ estimator: "cp", currency: "USD", monthlyDelta: 20, members: [{ member: "db", monthlyDelta: 20, monthlyTotal: 20, pastMonthlyTotal: 0 }] });
    expect([...run.outputs.keys()]).toEqual(["db"]);
  });

  // chant#5418: the hold names what its command loses, by name, so no secret's value sits in the spec.
  it("names terragucci's secrets: variables in the hold's redactEnv and its tokens in dropEnv", () => {
    // Two entries naming one variable for other roots: the name goes in once.
    const settings: Pick<ProjectSettings, "secrets"> = {
      secrets: [
        { roots: ["envs/prod/**"], from: "aws" as const, values: { TF_VAR_db_password: "prod/db#password" } },
        { roots: ["envs/dev/**"], from: "aws" as const, values: { TF_VAR_api_key: "shared/api", TF_VAR_db_password: "dev/db#password" } },
      ],
    };
    expect(costHoldEnv(settings)).toEqual({ redactEnv: ["TF_VAR_api_key", "TF_VAR_db_password"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] });
    expect(costHoldEnv({})).toEqual({ dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] });
    const hold = costHold({ command: "node cost.mjs" }, 10, costHoldEnv(settings)) as { redactEnv?: string[]; dropEnv?: string[]; command: string[] };
    expect(hold).toMatchObject({ approveAbove: 10, format: "infracost", redactEnv: ["TF_VAR_api_key", "TF_VAR_db_password"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] });
    expect(JSON.stringify(hold)).not.toContain("prod/db");
    expect(hold.command[2]).not.toContain("unset");
  });

  it("has chant run the hold's command without the named variables or their values", () => {
    const hold = costHold(true, 10, { redactEnv: ["TF_VAR_db_password"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] }) as unknown as { redactEnv: string[]; dropEnv: string[] };
    const env = costEnv({ PATH: "/bin", TG_TOKEN: "tg-secret", TG_MERGE_TOKEN: "merge-secret", TF_VAR_db_password: "hunter2-store", COPY: "hunter2-store", KEEP: "x" }, { redactEnv: hold.redactEnv, dropEnv: hold.dropEnv });
    expect(env).toEqual({ PATH: "/bin", KEEP: "x" });
  });

  it("gives the report, the waves, the note line and the policy the figures the release before gave, on the same estimates", () => {
    const seen: string[][] = [];
    const run = costExec({}, { run: byRoot({ app: infracost("20", "20", "0"), old: infracost("-5", "0", "5") }, seen) });
    const estimate = estimateRoots(true, plans(["app", "old", "broken"]), tmp(), run.exec, 15);
    expect(seen.map((a) => a[5])).toEqual(["app", "old", "broken"]);
    const cost = reportCostOf(estimate, run.outputs);
    // The same report body, but the reason a root has no estimate: chant names the argv's first word and the error's last lines.
    const reason = (c: { roots: { root: string; error?: string }[] }) => ({ ...c, roots: c.roots.map(({ error: _e, ...r }) => r) });
    expect(reason(cost)).toEqual(reason(OLD.cost));
    expect(cost.roots[2]!.error).toBe("sh exited 1: Error: no API key");
    expect(Object.fromEntries(run.outputs)).toEqual(OLD.outputs);
    const waves = [{ number: 1, roots: ["app", "old"] }, { number: 2, roots: ["broken"] }];
    const waveCosts = waves.map((w) => reportWaveCostOf(estimate, w.roots, 15));
    expect(waveCosts).toEqual(OLD.waveCosts);
    expect(costGateLine(waves.map((w, i) => ({ ...w, set_digest: null, approval: "not-requested" as const, cost: waveCosts[i] })))).toBe(OLD.gate);
    // input.cost: chant's record, with the release before's snake_case fields beside it.
    const policy = policyCostOf(estimate, "app", waves[0], 15);
    expect(policy).toMatchObject(OLD.policy);
    expect(policy).toMatchObject({ format: "infracost", monthlyDelta: 15, monthlyTotal: 20, pastMonthlyTotal: 5, approveAbove: 15, over: false, unestimated: [], member: { member: "app", monthlyDelta: 20 } });
    expect(policy.members.map((m) => m.member)).toEqual(["app", "old"]);
  });

  it("the note's estimate is chant's section, the wave's holds terragucci's line", () => {
    const run = costExec({}, { run: byRoot({ app: infracost("20", "20", "0") }) });
    const estimate = estimateRoots(true, plans(["app", "net"]), tmp(), run.exec);
    const roots = [{ path: "app", plan: planJson([rc("terraform_data.x", ["create"], null, { input: 1 })]) }];
    const report = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["app"], cost: reportWaveCostOf(estimate, ["app"], 15) }], gate: "never" });
    report.cost = reportCostOf(estimate, run.outputs);
    expect(noteCostOf(report.cost)).toMatchObject({ estimator: "infracost", monthlyDelta: 20, unestimated: ["net"], approveAbove: null });
    const note = renderNote(report);
    expect(note).toContain("**Cost (`infracost`):** +20.00 USD a month, 20.00 USD a month once it applies.");
    expect(note).toContain("| `app` | +20.00 USD | 20.00 USD |");
    expect(note).toContain("| `net` | not estimated | |");
    expect(note).toContain("Against `cost.approve_above` at base, 15.00 USD a month: wave 1 +20.00 USD, over it: it waits for an approval whatever the gate.");
  });

  it("takes true, a key secret and a command", () => {
    expect(validateConfig({ cost: true }, "t").cost).toBe(true);
    expect(validateConfig({ cost: { key_secret: "COST_KEY", command: "node cost.mjs" } }, "t").cost).toEqual({ key_secret: "COST_KEY", command: "node cost.mjs" });
    expect(() => validateConfig({ cost: { key_secret: "sk-123:abc" } }, "t")).toThrow(/must name the secret/);
    expect(() => validateConfig({ cost: { price: 1 } }, "t")).toThrow(/cost.price is not a setting/);
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the plan and apply jobs get the key and Infracost, and the confirm job leaves the estimate out", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, cost: { keySecret: "COST_KEY", install: true } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const plan = forge === "gitlab" ? doc.plan : doc.jobs.plan;
    expect(forge === "gitlab" ? plan.variables.INFRACOST_API_KEY : plan.env.INFRACOST_API_KEY).toBe(forge === "gitlab" ? "$COST_KEY" : "${{ secrets.COST_KEY }}");
    const script = forge === "gitlab" ? plan.script.join("\n") : plan.steps.map((s: { run?: string }) => s.run ?? "").join("\n");
    expect(script).toContain(`terragucci install infracost ${INFRACOST_VERSION}`);
    // A wave prices its plans for the policy and cost.approve_above, so its job gets the key and the estimator too.
    const apply = forge === "gitlab" ? doc["apply-wave-1"].variables : doc.jobs["apply-wave-1"].env;
    expect(apply.INFRACOST_API_KEY).toBe(forge === "gitlab" ? "$COST_KEY" : "${{ secrets.COST_KEY }}");
    const applyScript = forge === "gitlab" ? doc["apply-wave-1"].script.join("\n") : doc.jobs["apply-wave-1"].steps.map((s: { run?: string }) => s.run ?? "").join("\n");
    expect(applyScript).toContain(`terragucci install infracost ${INFRACOST_VERSION}`);
    // chant's comment job plans nothing (it re-runs the wave jobs), so it gets no key.
    if (forge !== "gitlab") expect(JSON.stringify(doc.jobs["apply-comment"])).not.toContain("COST_KEY");
    const without = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {} }).content;
    expect(without).not.toContain("INFRACOST_API_KEY");
    expect(confirmScript("tofu", [["a"]], forge, undefined, { cost: true })).toContain("--no-cost");
    const own = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, cost: { keySecret: "INFRACOST_API_KEY", install: false } }).content;
    expect(own).not.toContain("terragucci install infracost");
  });
});

/** A repo whose main commit holds `main`, with HEAD on a branch whose one commit holds `head`. */
function based(main: Record<string, string>, head: Record<string, string>): string {
  const dir = write(tmp(), main);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "main");
  git(dir, "checkout", "-q", "-b", "change");
  write(dir, head);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "change");
  return dir;
}

/** chant's estimate of roots with these monthly changes (null: the estimator failed). */
function priced(changes: Record<string, number | null>, approveAbove?: number) {
  const figures = Object.fromEntries(Object.entries(changes).flatMap(([r, d]) => (d === null ? [] : [[r, infracost(String(d), String(d + 5), "5")]])));
  const run = costExec({}, { run: byRoot(figures) });
  return estimateRoots({ command: "cost.mjs" }, plans(Object.keys(changes)), tmp(), run.exec, approveAbove);
}

describe("cost.approve_above: a wave over the amount waits", () => {
  it.each(["github", "gitlab"] as const)("%s: under gate: never, the apply jobs can record a wave approve_above holds on chant/lifecycle", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "never", tokenEnv: "MY_TOKEN", cost: { keySecret: "COST_KEY", install: false, approveAbove: true } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    // GitLab's job token cannot push, so chant's wave job pushes the record with the project token, under chant's name.
    if (forge === "gitlab") expect(doc["apply-wave-1"].variables.CHANT_FORGE_TOKEN).toBe("$MY_TOKEN");
    else expect(doc.jobs["apply-wave-1"].permissions.contents).toBe("write");
  });

  it("takes an amount of 0 or more, and nothing else", () => {
    expect(validateConfig({ cost: { command: "node cost.mjs", approve_above: 100 } }, "t").cost).toEqual({ command: "node cost.mjs", approve_above: 100 });
    expect(validateConfig({ cost: { approve_above: 0 } }, "t").cost).toEqual({ approve_above: 0 });
    expect(() => validateConfig({ cost: { approve_above: -1 } }, "t")).toThrow(/approve_above must be an amount of 0 or more/);
    expect(() => validateConfig({ cost: { approve_above: "100" } }, "t")).toThrow(/approve_above must be an amount/);
  });

  it("sums a wave's roots, and counts a change over the amount, or one it cannot know, as over", () => {
    const cost = priced({ a: 12, b: 8, c: 100 });
    expect(reportWaveCostOf(cost, ["a", "b"], 15)).toEqual({ currency: "USD", monthly_delta: 20, monthly_total: 30, past_monthly_total: 10, approve_above: 15, over: true });
    expect(reportWaveCostOf(cost, ["a", "b"], 20)).toMatchObject({ monthly_delta: 20, over: false });
    expect(reportWaveCostOf(cost, ["a", "b"], undefined)).not.toHaveProperty("over");
    expect(reportWaveCostOf(priced({ a: -50 }), ["a"], 0)).toMatchObject({ over: false });
    const unknown = reportWaveCostOf(priced({ a: 1, b: null }), ["a", "b"], 15);
    expect(unknown).toMatchObject({ monthly_delta: 1, unestimated: ["b"], over: true });
    expect(costReason(unknown, "the config at main")).toBe("the monthly cost of b could not be estimated, and cost.approve_above is 15.00 USD in the config at main");
    expect(costReason(reportWaveCostOf(cost, ["a", "b"], 15), "the config at main")).toBe("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at main");
  });

  it("puts chant's holds.cost in the waves' spec with the amount at base, beside holds.policy, and nothing without an amount", () => {
    const base = { waves: [["a"]], gate: "never" as const, approval: "ledger" as const, call: waveCallArgv, migrations: false };
    const spec = wavesStepSpec({ ...base, policy: true, cost: costHold({ command: "node cost.mjs" }, 15) }) as { holds?: Record<string, unknown> };
    expect(spec.holds).toEqual({ policy: true, cost: { command: costArgv("node cost.mjs"), format: "infracost", approveAbove: 15 } });
    expect((wavesStepSpec({ ...base, cost: costHold(true, 0) }) as { holds?: { cost?: { command: string[] } } }).holds?.cost?.command).toEqual(costArgv(INFRACOST_COMMAND));
    expect((wavesStepSpec(base) as { holds?: unknown }).holds).toBeUndefined();
  });

  it("the wave's hold and digest member are chant's verdict on the wave's estimate", () => {
    const cost = priced({ a: 12, b: 8 });
    const v = waveCostVerdict(cost, ["a", "b"], 15);
    const chant = opWaveCostVerdict({ command: ["cost.mjs"], approveAbove: 15 }, [{ target: "a", monthlyDelta: 12, monthlyTotal: 17, pastMonthlyTotal: 5, currency: "USD" }, { target: "b", monthlyDelta: 8, monthlyTotal: 13, pastMonthlyTotal: 5, currency: "USD" }]);
    expect(v.member).toEqual(chant.member);
    expect(v.member.member).toBe(OP_WAVE_COST_MEMBER);
    expect(v.hold).toBe(chant.hold);
    expect(waveCostVerdict(cost, ["a", "b"], 16).member.planDigest).not.toBe(v.member.planDigest);
    expect(waveCostVerdict(priced({ a: 12, b: 9 }), ["a", "b"], 15).member.planDigest).not.toBe(v.member.planDigest);
    expect(waveCostVerdict(cost, ["a", "b"], 20).hold).toBeUndefined();
  });

  it("a plan's wave over the amount waits whatever the gate, and its digests take chant's cost member", () => {
    const roots = [{ path: "a", plan: planJson([rc("terraform_data.x", ["create"], null, { input: 1 })]) }];
    const plain = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"] }], gate: "never" });
    const estimate = priced({ a: 20 });
    const costMember = waveCostVerdict(estimate, ["a"], 15).member;
    const withCost = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost: reportWaveCostOf(estimate, ["a"], 15), costMember }], gate: "never" });
    expect(plain.waves[0].waits).toBe(false);
    expect(withCost.waves[0]).toMatchObject({ waits: true, cost: { approve_above: 15, over: true, monthly_delta: 20 } });
    expect(withCost.waves[0].review_digest).toBe(changeSetDigest([{ member: "a", planDigest: withCost.roots[0].plan_digest! }, costMember]));
    const within = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost: reportWaveCostOf(estimate, ["a"], 50), costMember: waveCostVerdict(estimate, ["a"], 50).member }], gate: "never" });
    expect(within.waves[0].waits).toBe(false);
    // Without an amount the digest is the one a repo had before.
    expect(buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost: reportWaveCostOf(estimate, ["a"], undefined) }], gate: "never" }).waves[0].review_digest).toBe(plain.waves[0].review_digest);
  });

  it("reads the amount at base: a change cannot raise it for its own apply, and a change that drops cost is still priced", async () => {
    const at = (amount: number) => `cost:\n  command: node cost.mjs\n  approve_above: ${amount}\n`;
    const raised = based({ "terragucci.yml": at(15) }, { "terragucci.yml": at(1000) });
    const r = await costRule(raised, { command: "node cost.mjs", approve_above: 1000 }, "main", { config: join(raised, "terragucci.yml") });
    expect(r).toMatchObject({ approveAbove: 15, source: "the config at main", setting: { approve_above: 1000 } });
    expect(r.note).toMatch(/approve_above is 1000 here and 15 at main; the amount at main counts/);
    const dropped = based({ "terragucci.yml": at(15) }, { "terragucci.yml": "gate: never\n" });
    expect(await costRule(dropped, undefined, "main", { config: join(dropped, "terragucci.yml") })).toMatchObject({ approveAbove: 15, setting: { command: "node cost.mjs", approve_above: 15 } });
    expect(await costRule(dropped, { approve_above: 5 }, undefined)).toMatchObject({ approveAbove: 5, source: "the config here" });
    // An unreadable base is an error only when the run's own config sets an amount.
    const broken = based({ "terragucci.yml": "cost: [\n" }, { "terragucci.yml": at(15) });
    expect((await costRule(broken, { approve_above: 15 }, "main", { config: join(broken, "terragucci.yml") })).error).toMatch(/cost.approve_above is read from the config at main, and it could not be read/);
    expect(await costRule(broken, true, "main", { config: join(broken, "terragucci.yml") })).toEqual({ setting: true });
  });
});

describe("cost in the policy input", () => {
  const estimate = priced({ a: 20, b: 3 }, 15);
  const cost = policyCostOf(estimate, "a", { number: 1, roots: ["a", "b"] }, 15);

  it("carries chant's record and, beside it, the root's figures, its wave's and the amount as the release before named them", () => {
    expect(cost).toMatchObject({
      estimator: "cost.mjs",
      currency: "USD",
      root: { monthly_delta: 20, monthly_total: 25, past_monthly_total: 5 },
      wave: { number: 1, monthly_delta: 23, monthly_total: 33, past_monthly_total: 10 },
      approve_above: 15,
      monthlyDelta: 23,
      approveAbove: 15,
      over: true,
      member: { member: "a", monthlyDelta: 20 },
    });
  });

  it("input: plan puts it beside the plan's keys as input.cost; input: hcp also fills run.cost_estimate as HCP Terraform does", () => {
    const plan = JSON.stringify({ format_version: "1.2", resource_changes: [] });
    expect(JSON.parse(policyInput({}, plan, { root: "a", cost }))).toEqual({ format_version: "1.2", resource_changes: [], cost: JSON.parse(JSON.stringify(cost)) });
    expect(policyInput({}, plan, { root: "a" })).toBe(plan);
    const hcp = JSON.parse(policyInput({ engine: "opa", input: "hcp" }, plan, { root: "a", cost }));
    expect(hcp.cost).toEqual(JSON.parse(JSON.stringify(cost)));
    expect(hcp.run.cost_estimate).toEqual({ prior_monthly_cost: "5.00", proposed_monthly_cost: "25.00", delta_monthly_cost: "20.00" });
    expect(JSON.parse(policyInput({ engine: "opa", input: "hcp" }, plan, { root: "a" })).run.cost_estimate).toBeUndefined();
  });

  it("tf-plan prices the plans before the policy, which reads input.cost, and the note and the report give the amount at base", async () => {
    const bin = join(tmp(), "tofu");
    write(join(bin, ".."), {
      tofu: `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add, 0 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$chdir/plan.json"; else echo "plan text for $chdir"; fi ;;
esac
`,
    });
    chmodSync(bin, 0o755);
    const yml = (amount: number) => `roots: ["app"]\ngate: never\npolicy:\n  path: policy\ncost:\n  command: node cost.mjs\n  approve_above: ${amount}\n`;
    const plan = JSON.stringify(planJson([rc("terraform_data.x", ["create"], null, { input: 1 })]));
    const repo = based(
      { "terragucci.yml": yml(15), "app/main.tf": "# app\n", "app/plan.json": plan, "policy/p.rego": "package main\n\ndeny contains \"x\" if { false }\n" },
      { "terragucci.yml": yml(1000), "app/main.tf": "# app, changed\n" },
    );
    const inputs: unknown[] = [];
    const exec: PolicyExec = async (_f, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
      inputs.push(JSON.parse(readFileSync(args[args.length - 1], "utf-8")));
      return { status: 0, stdout: JSON.stringify([{ failures: [] }]), stderr: "" };
    };
    const run: CostRunner = () => ({ status: 0, stdout: infracost("20", "20", "0"), stderr: "" });
    const logs: string[] = [];
    const out = join(tmp(), "report");
    const { report, dir } = await runStage("tf-plan", repo, { binary: bin, layers: [["app"]], base: "main", out, env: { PATH: process.env.PATH }, costRunner: run, policy: { exec } }, (l) => logs.push(l));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ cost: { root: { monthly_delta: 20 }, wave: { number: 1, monthly_delta: 20 }, approve_above: 15, monthlyDelta: 20, approveAbove: 15, member: { member: "app" } } });
    expect(report.waves[0]).toMatchObject({ waits: true, cost: { approve_above: 15, over: true } });
    expect(logs.join("\n")).toContain("cost: wave 1: the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at main, so it waits for an approval when it applies");
    const note = readFileSync(join(dir, "note.md"), "utf-8");
    expect(note).toContain("Against `cost.approve_above` at base, 15.00 USD a month: wave 1 +20.00 USD, over it: it waits for an approval whatever the gate.");
    expect(note).toContain("**Cost (`node`):** +20.00 USD a month");
    expect(renderNote(report)).toContain("waits for an approval");
    expect(readFileSync(join(dir, "roots", "app", "cost.json"), "utf-8")).toBe(infracost("20", "20", "0") + "\n");
  });
});
