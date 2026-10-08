import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { INFRACOST_VERSION, release } from "../src/install";
import { costCommand, estimateCosts, INFRACOST_COMMAND, parseInfracost, signed, type CostRunner } from "../src/report/cost";
import { costLine, costTable } from "../src/report/views";
import { confirmScript, renderPipeline } from "../src/render";
import { tmp } from "./helpers";

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

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the plan job gets the key and Infracost, and the confirm job leaves the estimate out", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, cost: { keySecret: "COST_KEY", install: true } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const plan = forge === "gitlab" ? doc.plan : doc.jobs.plan;
    expect(forge === "gitlab" ? plan.variables.INFRACOST_API_KEY : plan.env.INFRACOST_API_KEY).toBe(forge === "gitlab" ? "$COST_KEY" : "${{ secrets.COST_KEY }}");
    const script = forge === "gitlab" ? plan.script.join("\n") : plan.steps.map((s: { run?: string }) => s.run ?? "").join("\n");
    expect(script).toContain(`terragucci install infracost ${INFRACOST_VERSION}`);
    const apply = forge === "gitlab" ? doc["apply-wave-1"].variables : doc.jobs["apply-wave-1"].env;
    expect(apply.INFRACOST_API_KEY).toBeUndefined();
    expect(confirmScript("tofu", [["a"]], forge, undefined, { cost: true })).toContain("--no-cost");
    const own = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, cost: { keySecret: "INFRACOST_API_KEY", install: false } }).content;
    expect(own).not.toContain("terragucci install infracost");
  });
});
