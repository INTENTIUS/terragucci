import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeSetDigest } from "@intentius/chant/change-set";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { INFRACOST_VERSION, release } from "../src/install";
import { buildReport } from "../src/report/build";
import { COST_MEMBER, costCommand, costMember, costReason, costRule, estimateCosts, INFRACOST_COMMAND, parseInfracost, policyCost, signed, waveCost, type CostRunner } from "../src/report/cost";
import { policyInput, type PolicyExec } from "../src/report/policy";
import type { ReportCost } from "../src/report/schema";
import { runStage } from "../src/report/stage";
import { costGateLine, costLine, costTable, renderNote } from "../src/report/views";
import { confirmScript, renderPipeline } from "../src/render";
import { git, tmp, write } from "./helpers";
import { plan as planJson, rc, RUN } from "./report-fixtures";

const infracost = (diff: string, total: string, past: string): string => JSON.stringify({ version: "0.2", currency: "USD", totalMonthlyCost: total, pastTotalMonthlyCost: past, diffTotalMonthlyCost: diff, projects: [] });

describe("cost: an estimate per root", () => {
  it("reads Infracost's JSON, and works out the change when it has no diff", () => {
    expect(parseInfracost(infracost("12.5", "40", "27.5"))).toEqual({ currency: "USD", monthly_delta: 12.5, monthly_total: 40, past_monthly_total: 27.5 });
    expect(parseInfracost(JSON.stringify({ currency: "EUR", totalMonthlyCost: "10", pastTotalMonthlyCost: "4" }))).toMatchObject({ currency: "EUR", monthly_delta: 6 });
    expect(() => parseInfracost("{}")).toThrow(/no totalMonthlyCost/);
    expect(signed(3)).toBe("+3.00");
    expect(signed(-0.5)).toBe("-0.50");
    expect(signed(0)).toBe("0.00");
  });

  it("runs the command once per root with its plan, sums the roots estimated, and names a root that failed", async () => {
    const seen: { root?: string; plan?: string; token?: string; cwd: string }[] = [];
    const run: CostRunner = async (_command, env, cwd) => {
      seen.push({ root: env.TG_ROOT, plan: env.TG_PLAN_JSON, token: env.TG_TOKEN, cwd });
      if (env.TG_ROOT === "broken") return { code: 1, stdout: "", stderr: "Error: no API key\nNode.js v22.0.0\n" };
      return { code: 0, stdout: env.TG_ROOT === "app" ? infracost("20", "20", "0") : infracost("-5", "0", "5"), stderr: "" };
    };
    const lines: string[] = [];
    const repo = tmp();
    const { cost, outputs } = await estimateCosts(
      [{ root: "app", json: "{}" }, { root: "old", json: "{}" }, { root: "broken", json: "{}" }],
      costCommand(true),
      { TG_TOKEN: "secret", INFRACOST_API_KEY: "k" },
      tmp(),
      repo,
      (l) => lines.push(l),
      run,
    );
    expect(seen.map((s) => s.root)).toEqual(["app", "old", "broken"]);
    expect(seen.every((s) => s.token === undefined && s.cwd === repo && s.plan?.endsWith(".json"))).toBe(true);
    expect(cost).toMatchObject({ estimator: "infracost", currency: "USD", monthly_delta: 15, monthly_total: 20, past_monthly_total: 5 });
    expect(cost.roots[0]).toMatchObject({ root: "app", monthly_delta: 20, output: "roots/app/cost.json" });
    expect(cost.roots[2]).toMatchObject({ root: "broken", monthly_delta: null, error: "the estimator exited 1: Error: no API key" });
    expect([...outputs.keys()]).toEqual(["app", "old"]);
    expect(lines).toContain("cost: +15.00 USD a month over 2 of 3 roots");
    expect(costCommand(true).command).toBe(INFRACOST_COMMAND);
    expect(costCommand({ command: "node cost.mjs" }).command).toBe("node cost.mjs");
  });

  it("puts a line and a table in the note", () => {
    const cost = {
      estimator: "infracost",
      currency: "USD",
      monthly_delta: 20,
      monthly_total: 20,
      past_monthly_total: 0,
      roots: [
        { root: "app", monthly_delta: 20, monthly_total: 20, past_monthly_total: 0, output: "roots/app/cost.json" },
        { root: "net", monthly_delta: null, monthly_total: null, past_monthly_total: null, error: "the estimator exited 1" },
      ],
    };
    expect(costLine(cost)).toBe("Monthly cost: **+20.00 USD** over 1 of 2 roots, from infracost; 1 could not be estimated.");
    const table = costTable(cost);
    expect(table).toContain("| `app` | 0.00 | 20.00 | +20.00 |");
    expect(table).toContain("| `net` | | | not estimated: the estimator exited 1 |");
    expect(table).toContain("| **Total** | 0.00 | 20.00 | **+20.00** |");
  });

  it("takes true, a key secret and a command", () => {
    expect(validateConfig({ cost: true }, "t").cost).toBe(true);
    expect(validateConfig({ cost: { key_secret: "COST_KEY", command: "node cost.mjs" } }, "t").cost).toEqual({ key_secret: "COST_KEY", command: "node cost.mjs" });
    expect(() => validateConfig({ cost: { key_secret: "sk-123:abc" } }, "t")).toThrow(/must name the secret/);
    expect(() => validateConfig({ cost: { price: 1 } }, "t")).toThrow(/cost.price is not a setting/);
  });

  it("installs Infracost by its release checksum", () => {
    expect(release("infracost", INFRACOST_VERSION, "amd64")).toEqual({
      url: `https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-amd64.tar.gz`,
      sums: `https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-amd64.tar.gz.sha256`,
      file: "infracost-linux-amd64.tar.gz",
      kind: "tar.gz",
      member: "infracost-linux-amd64",
    });
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
    if (forge !== "gitlab") expect(doc.jobs["apply-comment"].env.INFRACOST_API_KEY).toBe("${{ secrets.COST_KEY }}");
    const without = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {} }).content;
    expect(without).not.toContain("INFRACOST_API_KEY");
    expect(confirmScript("tofu", [["a"]], forge, undefined, { cost: true })).toContain("--no-cost");
    const own = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, cost: { keySecret: "INFRACOST_API_KEY", install: false } }).content;
    expect(own).not.toContain("terragucci install infracost");
  });
});

const estimate = (roots: Record<string, number | null>): ReportCost => ({
  estimator: "cost.mjs",
  currency: "USD",
  monthly_delta: null,
  monthly_total: null,
  past_monthly_total: null,
  roots: Object.entries(roots).map(([root, d]) => (d === null
    ? { root, monthly_delta: null, monthly_total: null, past_monthly_total: null, error: "the estimator exited 1" }
    : { root, monthly_delta: d, monthly_total: d + 5, past_monthly_total: 5 })),
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

describe("cost.approve_above: a wave over the amount waits", () => {
  it.each(["github", "gitlab"] as const)("%s: under gate: never, approve_above lets the apply jobs record a waiting wave on chant/lifecycle", (forge) => {
    const render = (approveAbove: boolean) => renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, gate: "never", cost: { keySecret: "COST_KEY", install: false, ...(approveAbove ? { approveAbove } : {}) } }).content;
    const doc = (text: string) => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    if (forge === "gitlab") {
      expect(doc(render(true))["apply-wave-1"].script.join("\n")).toContain("git remote set-url");
      expect(doc(render(false))["apply-wave-1"].script.join("\n")).not.toContain("git remote set-url");
    } else {
      expect(doc(render(true)).jobs["apply-wave-1"].permissions.contents).toBe("write");
      expect(doc(render(false)).jobs["apply-wave-1"].permissions.contents).toBe("read");
    }
  });


  it("takes an amount of 0 or more, and nothing else", () => {
    expect(validateConfig({ cost: { command: "node cost.mjs", approve_above: 100 } }, "t").cost).toEqual({ command: "node cost.mjs", approve_above: 100 });
    expect(validateConfig({ cost: { approve_above: 0 } }, "t").cost).toEqual({ approve_above: 0 });
    expect(() => validateConfig({ cost: { approve_above: -1 } }, "t")).toThrow(/approve_above must be an amount of 0 or more/);
    expect(() => validateConfig({ cost: { approve_above: "100" } }, "t")).toThrow(/approve_above must be an amount/);
  });

  it("sums a wave's roots, and counts a change over the amount, or one it cannot know, as over", () => {
    const cost = estimate({ a: 12, b: 8, c: 100 });
    expect(waveCost(cost, ["a", "b"], 15)).toEqual({ currency: "USD", monthly_delta: 20, monthly_total: 30, past_monthly_total: 10, approve_above: 15, over: true });
    expect(waveCost(cost, ["a", "b"], 20)).toMatchObject({ monthly_delta: 20, over: false });
    expect(waveCost(cost, ["a", "b"], undefined)).not.toHaveProperty("over");
    expect(waveCost(estimate({ a: -50 }), ["a"], 0)).toMatchObject({ over: false });
    const unknown = waveCost(estimate({ a: 1, b: null }), ["a", "b"], 15);
    expect(unknown).toMatchObject({ monthly_delta: 1, unestimated: ["b"], over: true });
    expect(costReason(unknown, "the config at main")).toBe("the monthly cost of b could not be estimated, and cost.approve_above is 15.00 USD in the config at main");
    expect(costReason(waveCost(cost, ["a", "b"], 15), "the config at main")).toBe("the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at main");
  });

  it("binds the amount, the currency and the wave's change into a member of the digest, and nothing without an amount", () => {
    const cost = estimate({ a: 12, b: 8 });
    expect(costMember(waveCost(cost, ["a", "b"], undefined))).toBeUndefined();
    const m = costMember(waveCost(cost, ["a", "b"], 15))!;
    expect(m.member).toBe(COST_MEMBER);
    expect(costMember(waveCost(cost, ["a", "b"], 15))).toEqual(m);
    expect(costMember(waveCost(cost, ["a", "b"], 16))!.planDigest).not.toBe(m.planDigest);
    expect(costMember(waveCost(estimate({ a: 12, b: 9 }), ["a", "b"], 15))!.planDigest).not.toBe(m.planDigest);
  });

  it("a plan's wave over the amount waits whatever the gate, and its digests take the cost", () => {
    const roots = [{ path: "a", plan: planJson([rc("terraform_data.x", ["create"], null, { input: 1 })]) }];
    const plain = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"] }], gate: "never" });
    const cost = waveCost(estimate({ a: 20 }), ["a"], 15);
    const priced = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost }], gate: "never" });
    expect(plain.waves[0].waits).toBe(false);
    expect(priced.waves[0]).toMatchObject({ waits: true, cost: { approve_above: 15, over: true, monthly_delta: 20 } });
    expect(priced.waves[0].review_digest).toBe(changeSetDigest([{ member: "a", planDigest: priced.roots[0].plan_digest! }, costMember(cost)!]));
    expect(priced.waves[0].review_digest).not.toBe(plain.waves[0].review_digest);
    const within = buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost: waveCost(estimate({ a: 20 }), ["a"], 50) }], gate: "never" });
    expect(within.waves[0].waits).toBe(false);
    // Without an amount the digest is the one a repo had before.
    expect(buildReport({ run: RUN, roots, waves: [{ number: 1, roots: ["a"], cost: waveCost(estimate({ a: 20 }), ["a"], undefined) }], gate: "never" }).waves[0].review_digest).toBe(plain.waves[0].review_digest);
  });

  it("the note gives each wave's change against the amount at base", () => {
    const cost = estimate({ a: 20, b: 3 });
    const waves = [
      { number: 1, roots: ["a"], set_digest: null, approval: "not-requested" as const, cost: waveCost(cost, ["a"], 15) },
      { number: 2, roots: ["b"], set_digest: null, approval: "not-requested" as const, cost: waveCost(cost, ["b"], 15) },
    ];
    expect(costGateLine(waves)).toBe("Against `cost.approve_above` at base, 15.00 USD a month: wave 1 +20.00 USD, over it: it waits for an approval whatever the gate; wave 2 +3.00 USD, within it.");
    expect(costGateLine([{ ...waves[0], cost: waveCost(cost, ["a"], undefined) }])).toBeUndefined();
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
  const cost = policyCost(estimate({ a: 20, b: 3 }), "a", { number: 1, cost: waveCost(estimate({ a: 20, b: 3 }), ["a", "b"], 15) }, 15);

  it("carries the root's figures, its wave's and the amount", () => {
    expect(cost).toEqual({
      estimator: "cost.mjs",
      currency: "USD",
      root: { monthly_delta: 20, monthly_total: 25, past_monthly_total: 5 },
      wave: { number: 1, monthly_delta: 23, monthly_total: 33, past_monthly_total: 10 },
      approve_above: 15,
    });
  });

  it("input: plan puts it beside the plan's keys as input.cost; input: hcp also fills run.cost_estimate as HCP Terraform does", () => {
    const plan = JSON.stringify({ format_version: "1.2", resource_changes: [] });
    expect(JSON.parse(policyInput({}, plan, { root: "a", cost }))).toEqual({ format_version: "1.2", resource_changes: [], cost });
    expect(policyInput({}, plan, { root: "a" })).toBe(plan);
    const hcp = JSON.parse(policyInput({ engine: "opa", input: "hcp" }, plan, { root: "a", cost }));
    expect(hcp.cost).toEqual(cost);
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
    const run: CostRunner = async () => ({ code: 0, stdout: infracost("20", "20", "0"), stderr: "" });
    const logs: string[] = [];
    const out = join(tmp(), "report");
    const { report, dir } = await runStage("tf-plan", repo, { binary: bin, layers: [["app"]], base: "main", out, env: { PATH: process.env.PATH }, costRunner: run, policy: { exec } }, (l) => logs.push(l));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ cost: { root: { monthly_delta: 20 }, wave: { number: 1, monthly_delta: 20 }, approve_above: 15 } });
    expect(report.waves[0]).toMatchObject({ waits: true, cost: { approve_above: 15, over: true } });
    expect(logs.join("\n")).toContain("cost: wave 1: the monthly cost changes by +20.00 USD, over cost.approve_above 15.00 USD in the config at main, so it waits for an approval when it applies");
    const note = readFileSync(join(dir, "note.md"), "utf-8");
    expect(note).toContain("Against `cost.approve_above` at base, 15.00 USD a month: wave 1 +20.00 USD, over it: it waits for an approval whatever the gate.");
    expect(renderNote(report)).toContain("waits for an approval");
  });
});
