import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estateLinks, estateOutputsFromArg, estateRefusals, sensitiveWhy, unknownWhy } from "../src/estate-planned";
import { renderNote } from "../src/report/views";
import { runStage } from "../src/report/stage";
import { plansOnPlannedEstates } from "../src/shape";
import { tmp, validate, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

const REPORT_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

/** An upstream plan whose `name` output moves to a known value, whose `stamp` is known only once it applies, and whose `secret` is sensitive. */
const netPlan = planJson([rc("terraform_data.this", ["update"], { input: "1" }, { input: "2" })], {
  output_changes: {
    name: { actions: ["update"], before: "net-1", after: "net-2", after_unknown: false, before_sensitive: false, after_sensitive: false },
    stamp: { actions: ["update"], before: "1", after_unknown: true, before_sensitive: false, after_sensitive: false },
    secret: { actions: ["no-op"], before: "s", after: "s", after_unknown: false, before_sensitive: true, after_sensitive: true },
  },
});
const unchangedPlan = planJson([], { output_changes: { name: { actions: ["no-op"], before: "net-1", after: "net-1", after_unknown: false } } });

/** choudoufu's refusals as its plan prints them with -no-color: the detail word-wrapped at 78 columns. */
const UNKNOWN = `
Error: Another estate's planned output is known only after apply

Estate "shop-net"'s planned output "stamp" (in /tmp/terragucci-plan-x/0.tfplan.json)
is known only after "shop-net" applies. This plan is not made on an unknown or
a placeholder, because that would not be the plan that applies. Apply
"shop-net" first, then plan this estate on its recorded outputs, without
-estate-outputs-from shop-net=...
`;
const SENSITIVE = `
Error: Another estate's planned output is sensitive

Estate "shop-net"'s planned output "secret" (in /tmp/terragucci-plan-x/0.tfplan.json)
is sensitive. A sensitive output never crosses to another estate, planned or
recorded, so this plan cannot be made on it.
`;

describe("estate outputs from an upstream's plan", () => {
  it("is choudoufu's alone, by the binary's name", () => {
    expect(plansOnPlannedEstates("choudoufu")).toBe(true);
    expect(plansOnPlannedEstates("/opt/bin/choudoufu")).toBe(true);
    expect(plansOnPlannedEstates("tofu")).toBe(false);
    expect(plansOnPlannedEstates("terraform")).toBe(false);
  });

  it("hands a reader one flag per estate whose root planned with an output change, and says why each other read stands on the records", () => {
    const owner = new Map([["shop-net", "net"], ["shop-dns", "dns"], ["shop-db", "db"], ["shop-app", "app"], ["shop-q", "q"]]);
    const plans = new Map([
      ["net", { plan: netPlan, file: "/w/0.tfplan.json" }],
      ["dns", { plan: unchangedPlan, file: "/w/1.tfplan.json" }],
    ]);
    const got = estateLinks(
      "app",
      [
        { name: "net", estate: "shop-net" },
        { name: "net_again", estate: "shop-net" },
        { name: "dns", estate: "shop-dns" },
        { name: "db", estate: "shop-db" },
        { name: "q", estate: "shop-q" },
        { name: "self", estate: "shop-app" },
        { name: "other", estate: "another-project" },
      ],
      owner,
      (r) => r !== "q",
      (r) => plans.get(r),
    );
    expect(got.args).toEqual(["-estate-outputs-from=shop-net=/w/0.tfplan.json"]);
    expect([...got.upstreamOf]).toEqual([["shop-net", "net"]]);
    expect(got.reads).toEqual([
      { upstream: "net", data: "net", outputs: "planned" },
      { upstream: "net", data: "net_again", outputs: "planned" },
      { upstream: "dns", data: "dns", outputs: "applied", why: "its plan changes no output, so its records stand" },
      { upstream: "db", data: "db", outputs: "applied", why: "it did not plan in this run" },
      { upstream: "q", data: "q", outputs: "applied", why: "this change does not reach it, so its records stand" },
    ]);
    expect(estateOutputsFromArg("e", "/p.json")).toBe("-estate-outputs-from=e=/p.json");
  });

  it("reads choudoufu's refusals through the word wrap and the box drawing, each once", () => {
    expect(estateRefusals(UNKNOWN + UNKNOWN)).toEqual([{ kind: "unknown", estate: "shop-net", output: "stamp" }]);
    expect(estateRefusals(SENSITIVE)).toEqual([{ kind: "sensitive", estate: "shop-net", output: "secret" }]);
    const boxed = UNKNOWN.split("\n").map((l) => `│ ${l}`).join("\n");
    expect(estateRefusals(`╷\n${boxed}\n╵`)).toEqual([{ kind: "unknown", estate: "shop-net", output: "stamp" }]);
    expect(estateRefusals("Error: Invalid for_each argument")).toEqual([]);
  });

  it("names the outputs, the upstream roots and the waves that settle them", () => {
    const ups = new Map([["shop-net", "net"]]);
    const refused = [
      { kind: "unknown" as const, estate: "shop-net", output: "stamp" },
      { kind: "unknown" as const, estate: "shop-net", output: "id" },
    ];
    expect(unknownWhy(refused, ups, [1])).toBe("reads `id`, `stamp` of net, unknown until wave 1 applies");
    expect(unknownWhy(refused.slice(0, 1), ups, [])).toBe("reads `stamp` of net, unknown until it applies");
    expect(sensitiveWhy([{ kind: "sensitive", estate: "shop-net", output: "secret" }], ups)).toBe("reads sensitive output `secret` of net, which choudoufu never hands to another estate");
  });
});

/**
 * A stand-in choudoufu: init passes, `state pull` prints a state with an
 * output (so no root is held back), and plan saves the -estate-outputs-from
 * values it was given (to eof.seen) and the file the first names (to
 * eof.json), prints the root's `refuse` file and fails when it has one and
 * was given the flag, and otherwise copies the root's plan.json to the plan
 * file.
 */
function standIn(dir: string, name = "choudoufu"): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  state) echo '{"version":4,"resources":[],"outputs":{"a":{"value":1}}}'; exit 0 ;;
  plan)
    seen=""
    for a in "$@"; do case "$a" in -estate-outputs-from=*) v="\${a#-estate-outputs-from=}"; seen="$seen$v;"; [ -f "$chdir/eof.json" ] || cp "\${v#*=}" "$chdir/eof.json" ;; esac; done
    printf '%s' "$seen" > "$chdir/eof.seen"
    if [ -n "$seen" ] && [ -f "$chdir/refuse" ]; then cat "$chdir/refuse" >&2; exit 1; fi
    for a in "$@"; do case "$a" in -out=*) cp "$chdir/plan.json" "\${a#-out=}" ;; esac; done
    echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan plans a choudoufu root on the planned outputs of the estates it reads", () => {
  const live = (e: string): string => `terraform {\n  live {\n    estate = "${e}"\n  }\n}\n`;
  const appPlan = planJson([rc("terraform_data.name", ["update"], { input: "net-1" }, { input: "net-2" })]);
  const estate = (extra: Record<string, string> = {}) =>
    write(tmp(), {
      "terragucci.yml": "binary: choudoufu\ngate: always\n",
      "net/main.tf": live("shop-net"),
      "net/plan.json": JSON.stringify(netPlan),
      "app/main.tf": live("shop-app") + `data "terraform_estate_outputs" "net" {\n  estate = "shop-net"\n  names  = ["name"]\n}\nresource "terraform_data" "name" {\n  input = data.terraform_estate_outputs.net.values.name\n}\n`,
      "app/plan.json": JSON.stringify(appPlan),
      "web/main.tf": live("shop-web"),
      "web/plan.json": JSON.stringify(appPlan),
      ...extra,
    });
  const layers = [["net"], ["app", "web"]];

  it("plans app with -estate-outputs-from naming net's show -json from this run, and reports the read as planned", async () => {
    const repo = estate();
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: standIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(readFileSync(join(repo, "app/eof.seen"), "utf-8")).toMatch(/^shop-net=\/.+\.tfplan\.json;$/);
    expect(JSON.parse(readFileSync(join(repo, "app/eof.json"), "utf-8"))).toEqual(netPlan);
    // The upstream and a root that reads no estate plan as before.
    expect(readFileSync(join(repo, "net/eof.seen"), "utf-8")).toBe("");
    expect(readFileSync(join(repo, "web/eof.seen"), "utf-8")).toBe("");
    expect(logs).toContain("app: plans on the planned outputs of net");
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    expect(report.roots.find((r) => r.path === "app")).toMatchObject({ status: "planned", reads: [{ upstream: "net", data: "net", outputs: "planned" }] });
    expect(report.waves.map((w) => [w.number, w.replans_after])).toEqual([[1, undefined], [2, undefined]]);
  });

  it("leaves app unplanned when choudoufu refuses an output known only after apply, naming it and the wave that settles it", async () => {
    const repo = estate({ "app/refuse": UNKNOWN });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: standIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    const why = "reads `stamp` of net, unknown until wave 1 applies";
    expect(logs).toContain(`app: not planned: ${why}`);
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    expect(report.roots.map((r) => r.path)).toEqual(["net", "web"]);
    expect(report.deferred).toEqual([{ unit: "app", after: ["net"], why, previewed: false }]);
    // web's wave plans again with app once wave 1 applies, so the note gives it no digest.
    expect(report.waves[1]).toMatchObject({ number: 2, roots: ["web"], replans_after: [1], review_digest: null });
    expect(renderNote(report)).toContain(`- \`app\` after \`net\`: ${why}`);
  });

  it("fails app when choudoufu refuses a sensitive output, which never crosses to another estate", async () => {
    const repo = estate({ "app/refuse": SENSITIVE });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: standIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(logs).toContain("app: not planned, reads sensitive output `secret` of net, which choudoufu never hands to another estate");
    const app = report.roots.find((r) => r.path === "app")!;
    expect(app.status).toBe("failed");
    expect(app.error).toContain("reads sensitive output `secret` of net");
    expect(report.deferred).toBeUndefined();
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
  });

  it("plans on the records, with no flag, when the upstream's plan changes no output or the change does not reach it", async () => {
    const unchanged = estate({ "net/plan.json": JSON.stringify(unchangedPlan) });
    const a = await runStage("tf-plan", unchanged, { binary: standIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    expect(readFileSync(join(unchanged, "app/eof.seen"), "utf-8")).toBe("");
    expect(a.report.roots.find((r) => r.path === "app")!.reads).toEqual([{ upstream: "net", data: "net", outputs: "applied", why: "its plan changes no output, so its records stand" }]);

    const alone = estate();
    const b = await runStage("tf-plan", alone, { binary: standIn(tmp()), layers, root: "app", out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    expect(readFileSync(join(alone, "app/eof.seen"), "utf-8")).toBe("");
    expect(b.report.roots[0].reads).toEqual([{ upstream: "net", data: "net", outputs: "applied", why: "this change does not reach it, so its records stand" }]);
  });

  it("hands no flag to a binary other than choudoufu", async () => {
    const repo = estate({ "terragucci.yml": "binary: tofu\ngate: always\n" });
    await runStage("tf-plan", repo, { binary: standIn(tmp(), "tofu"), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    expect(readFileSync(join(repo, "app/eof.seen"), "utf-8")).toBe("");
    expect(existsSync(join(repo, "app/eof.json"))).toBe(false);
  });
});
