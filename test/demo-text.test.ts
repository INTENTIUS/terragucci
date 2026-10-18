// scripts/demo-text.mjs: the kiosk's top pane stays within its length budgets (behold#571).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGETS, cardProblems, demoProblems, demoStrings, fill } from "../scripts/demo-text.mjs";

const root = join(__dirname, "..");
const demo = readFileSync(join(root, "stack/demo.sh"), "utf8");

describe("the kiosk's top pane", () => {
  it("holds the intro and every card field to its budget", () => {
    expect(cardProblems(root)).toEqual([]);
  });

  it("has the delivery line the metrics pane shows over the DORA numbers, within its budget", () => {
    const intro = JSON.parse(readFileSync(join(root, "example-demo/scenarios/intro.json"), "utf8")) as { delivery?: string };
    expect(intro.delivery).toMatch(/demo loop's own/);
    expect(intro.delivery!.length).toBeLessThanOrEqual(BUDGETS.delivery);
    // demo.sh writes it into every demo.json as delivery.
    expect(demo).toContain(`DELIVERY="$(jq -r '.delivery // empty' "$DEMO/scenarios/intro.json"`);
    expect(demo).toContain("delivery: (if $delivery");
  });

  it("holds every title, name, step line and next action in demo.sh to its budget, placeholders filled", () => {
    expect(demoProblems(demo)).toEqual([]);
  });

  it("reads the step lines of every scenario and the driver's own labels", () => {
    const strings = demoStrings(demo);
    const where = strings.map((s) => s.where);
    for (const scenario of ["a-known", "a-output", "b-waves", "b-composed", "failure", "stale-plan", "tg-planned-outputs", "chant-pr-loop", "fan-out-tofu"]) {
      expect(where.some((w) => w.startsWith(`say ${scenario}:pull-request `))).toBe(true);
      expect(where.some((w) => w.startsWith(`scenario_title ${scenario} `))).toBe(true);
      expect(where.some((w) => w.startsWith(`scenario_name ${scenario} `))).toBe(true);
    }
    for (const key of ["b-waves:2", "failure:2", "b-composed:1"]) expect(where.some((w) => w.startsWith(`waiting_label ${key} `))).toBe(true);
    const literal = strings.filter((s) => s.kind === "step" && !s.where.startsWith("say") && !s.where.startsWith("waiting_label") && !s.where.startsWith("base_label"));
    expect(literal.map((s) => s.raw)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Wave 2 failed/), expect.stringMatching(/^Outside the pipeline/), expect.stringMatching(/^Stalled after/)]),
    );
    expect(strings.filter((s) => s.kind === "action").map((s) => s.raw)).toEqual(expect.arrayContaining(["reset", "remove the duplicate and run the pipeline again"]));
  });

  it("names the string, its length and its budget when a label runs over, and a placeholder with no sample", () => {
    const long = "x".repeat(BUDGETS.step);
    const src = [
      "say() { # step",
      '  case "$SCENARIO:$1" in',
      `    b-waves:applied)  echo "Subnet $(state_id network subnet). ${long}" ;;`,
      `    b-waves:merged)   echo "Merged at $UNHEARD_OF" ;;`,
      "  esac",
      "}",
      `  demo_hold planned "Short" "${"y".repeat(BUDGETS.action + 1)}"`,
      "",
    ].join("\n");
    const problems = demoProblems(src);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain(`step at say b-waves:applied (demo.sh:3) is ${fill(`Subnet $(state_id network subnet). ${long}`).text.length} characters, over its budget of ${BUDGETS.step}`);
    expect(problems[1]).toContain("uses $UNHEARD_OF, which has no sample");
    expect(problems[2]).toContain(`action at demo.sh:7 is ${BUDGETS.action + 1} characters, over its budget of ${BUDGETS.action}`);
  });

  it("fills a terraform_data id at its real length", () => {
    expect(fill("$(state_id network subnet)").text).toHaveLength(36);
  });
});
