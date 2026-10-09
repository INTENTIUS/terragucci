import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteStateReads } from "../src/detect";
import { hclValue, LINKED_FILE, linkRoot, outputsRead } from "../src/linked";
import { plannedOutputs, plannedRead, unknownOutputs, unknownUpstreams, wavesOf } from "../src/planned-outputs";
import { renderNote } from "../src/report/views";
import { readInlineReport } from "../src/report/html";
import { parseMarker } from "../src/report/marker";
import { runStage } from "../src/report/stage";
import { tmp, validate, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

const REPORT_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

const backend = (key: string): string => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const reads = (name: string, key: string, extra = ""): string => `data "terraform_remote_state" "${name}" {\n  backend = "s3"\n${extra}  config = {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;

/** An upstream plan whose `name` output moves to a known value and whose `stamp` is known only once it applies. */
const netPlan = planJson([rc("terraform_data.this", ["update"], { input: "1" }, { input: "2" })], {
  output_changes: {
    name: { actions: ["update"], before: "net-1", after: "net-2", after_unknown: false, before_sensitive: false, after_sensitive: false },
    stamp: { actions: ["update"], before: "1", after_unknown: true, before_sensitive: false, after_sensitive: false },
    obj: { actions: ["update"], before: { a: 1, b: "1" }, after: { a: 1 }, after_unknown: { b: true }, after_sensitive: false },
    secret: { actions: ["no-op"], before: "s", after: "s", after_unknown: false, before_sensitive: true, after_sensitive: true },
    gone: { actions: ["delete"], before: "x", after: null, after_unknown: false },
  },
});

describe("planned outputs", () => {
  it("reads each output's planned value and its unknown parts from output_changes, leaving out deleted ones", () => {
    const p = plannedOutputs(netPlan)!;
    expect(p.changed).toBe(true);
    expect([...p.outputs.keys()].sort()).toEqual(["name", "obj", "secret", "stamp"]);
    expect(p.outputs.get("name")).toEqual({ value: "net-2", unknown: false, sensitive: false });
    expect(p.outputs.get("secret")!.sensitive).toBe(true);
    expect(unknownOutputs(p.outputs)).toEqual(["obj", "stamp"]);
    expect(unknownOutputs(p.outputs, new Set(["name"]))).toEqual([]);
    expect(plannedRead("net", "net", p.outputs, new Set(["stamp", "name"]))).toEqual({ upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"] });
  });

  it("says nothing changed when every output is a no-op, and falls back to planned_values without output_changes", () => {
    expect(plannedOutputs(planJson([], { output_changes: { a: { actions: ["no-op"], after: 1, after_unknown: false } } }))!.changed).toBe(false);
    const fallback = plannedOutputs({ planned_values: { outputs: { a: { value: 1, sensitive: false }, b: { sensitive: false } } } })!;
    expect(fallback.outputs.get("a")).toEqual({ value: 1, unknown: false, sensitive: false });
    expect(unknownOutputs(fallback.outputs)).toEqual(["b"]);
    expect(plannedOutputs({})).toBeUndefined();
  });

  it("names the upstreams read before they were known, and the waves they are in", () => {
    expect(unknownUpstreams([{ upstream: "b", data: "b", outputs: "planned", unknown: ["x"] }, { upstream: "a", data: "a", outputs: "planned" }, { upstream: "c", data: "c", outputs: "applied" }])).toEqual(["b"]);
    expect(wavesOf(new Map([["a", 1], ["b", 2], ["c", 3]]), ["b", "a", "b", "c"], 3)).toEqual([1, 2]);
  });
});

describe("a linked plan's rewrite", () => {
  it("writes planned values as HCL, unknown parts as the unknown local, and no string as a template", () => {
    expect(hclValue("a${b}%{c}\n", false, "U")).toBe('"a$${b}%%{c}\\n"');
    expect(hclValue(undefined, true, "U")).toBe("U");
    expect(hclValue({ a: 1 }, { b: true }, "U")).toBe('{ "a" = 1, "b" = U }');
    expect(hclValue(["x"], [false, true], "U")).toBe('["x", U]');
    expect(hclValue(null, false, "U")).toBe("null");
  });

  it("finds the outputs a root reads from a block, or none when it reads the whole object", () => {
    expect([...outputsRead(['x = data.terraform_remote_state.net.outputs.name\ny = data.terraform_remote_state.net.outputs["stamp"]\nz = data.terraform_remote_state.net2.outputs.other'], "net")!].sort()).toEqual(["name", "stamp"]);
    expect(outputsRead(["x = data.terraform_remote_state.net.outputs"], "net")).toBeUndefined();
  });

  it("rewrites the references to the block, not to a block whose label starts with it, and puts every file back", () => {
    const dir = write(tmp(), {
      "main.tf": `x = data.terraform_remote_state.net.outputs.name\ny = data.terraform_remote_state.net-b.outputs.name\nz = "\${data.terraform_remote_state.net.outputs.stamp}"\n`,
      "other.tf": "# nothing linked\n",
    });
    const before = readFileSync(join(dir, "main.tf"), "utf-8");
    const linked = linkRoot(dir, [{ name: "net", upstream: "net", outputs: plannedOutputs(netPlan)!.outputs }]);
    const during = readFileSync(join(dir, "main.tf"), "utf-8");
    expect(during).toContain("x = local.terragucci_linked_net.outputs.name");
    expect(during).toContain("y = data.terraform_remote_state.net-b.outputs.name");
    expect(during).toContain('z = "${local.terragucci_linked_net.outputs.stamp}"');
    const locals = readFileSync(join(dir, LINKED_FILE), "utf-8");
    expect(locals).toContain("terragucci_unknown = jsondecode(timestamp())");
    expect(locals).toContain('"name" = "net-2"');
    expect(locals).toContain('"stamp" = local.terragucci_unknown');
    expect(locals).toContain('"secret" = sensitive("s")');
    expect(locals).not.toContain('"gone"');
    expect(linked.provisional).toBe(true);
    expect(linked.reads).toEqual([{ upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"] }]);
    linked.restore();
    expect(readFileSync(join(dir, "main.tf"), "utf-8")).toBe(before);
    expect(existsSync(join(dir, LINKED_FILE))).toBe(false);
  });

  it("refuses a root that already has the linked file, changing nothing", () => {
    const dir = write(tmp(), { "main.tf": "x = data.terraform_remote_state.net.outputs.name\n", [LINKED_FILE]: "# mine\n" });
    expect(() => linkRoot(dir, [{ name: "net", upstream: "net", outputs: new Map() }])).toThrow(/already in the root/);
    expect(readFileSync(join(dir, LINKED_FILE), "utf-8")).toBe("# mine\n");
    expect(readFileSync(join(dir, "main.tf"), "utf-8")).toContain("data.terraform_remote_state.net");
  });

  it("names each remote state block, the root it reads, and whether it repeats", () => {
    const dir = write(tmp(), {
      "net/main.tf": backend("net.tfstate"),
      "app/main.tf": backend("app.tfstate") + reads("net", "net.tfstate") + reads("many", "net.tfstate", "  count = 2\n"),
    });
    expect(remoteStateReads(dir, ["app", "net"]).get("app")).toEqual([
      { name: "net", upstream: "net", repeated: false },
      { name: "many", upstream: "net", repeated: true },
    ]);
  });
});

/**
 * A stand-in binary: init passes, `state pull` prints a state with an output
 * (so no root is held back) unless the root has a `never-applied` file, and plan copies the root's plan.json to the plan
 * file, after saving the linked file it finds (to linked.seen) and failing
 * when the root has a `fail-linked` file and the linked file is there.
 */
function linkedTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  state) if [ -f "$chdir/never-applied" ]; then exit 0; fi; echo '{"version":4,"resources":[],"outputs":{"a":{"value":1}}}'; exit 0 ;;
  plan)
    if [ -f "$chdir/${LINKED_FILE}" ]; then
      cat "$chdir/${LINKED_FILE}" "$chdir/main.tf" > "$chdir/linked.seen"
      if [ -f "$chdir/fail-linked" ]; then echo "Error: Invalid for_each argument" >&2; exit 1; fi
    fi
    for a in "$@"; do case "$a" in -out=*) cp "$chdir/plan.json" "\${a#-out=}" ;; esac; done
    echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("tf-plan plans a root on the planned outputs of the roots it reads", () => {
  const appPlan = planJson([rc("terraform_data.name", ["update"], { input: "net-1" }, { input: "net-2" })]);
  const estate = (extra: Record<string, string> = {}) =>
    write(tmp(), {
      "terragucci.yml": "gate: always\n",
      "net/main.tf": backend("net.tfstate"),
      "net/plan.json": JSON.stringify(netPlan),
      "app/main.tf": backend("app.tfstate") + reads("net", "net.tfstate") + 'resource "terraform_data" "name" {\n  input = data.terraform_remote_state.net.outputs.name\n}\nresource "terraform_data" "stamp" {\n  input = data.terraform_remote_state.net.outputs.stamp\n}\n',
      "app/plan.json": JSON.stringify(appPlan),
      ...extra,
    });

  it("links app to net's plan, reports the unknown it read, and holds wave 2's approval for its re-plan", async () => {
    const repo = estate();
    const original = readFileSync(join(repo, "app/main.tf"), "utf-8");
    const logs: string[] = [];
    const result = await runStage("tf-plan", repo, { binary: linkedTofu(tmp()), layers: [["net"], ["app"]], out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    const seen = readFileSync(join(repo, "app/linked.seen"), "utf-8");
    expect(seen).toContain('"name" = "net-2"');
    expect(seen).toContain("input = local.terragucci_linked_net.outputs.stamp");
    // Put back as it was.
    expect(readFileSync(join(repo, "app/main.tf"), "utf-8")).toBe(original);
    expect(existsSync(join(repo, "app", LINKED_FILE))).toBe(false);
    expect(existsSync(join(repo, "net/linked.seen"))).toBe(false);
    expect(logs).toContain("app: plans on the planned outputs of net, stamp known once it applies");

    const { report } = result;
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    expect(report.roots.find((r) => r.path === "app")!.reads).toEqual([{ upstream: "net", data: "net", outputs: "planned", unknown: ["stamp"] }]);
    expect(report.roots.find((r) => r.path === "net")!.reads).toBeUndefined();
    const [w1, w2] = report.waves;
    expect(w1).toMatchObject({ number: 1, state: "planned" });
    expect(w1.review_digest).toEqual(expect.any(String));
    expect(w2).toMatchObject({ number: 2, state: "planned", reads: [1], replans_after: [1], review_digest: null, waits: true });

    const note = renderNote(report);
    expect(note).toContain("plans again once wave 1 applies, then waits for an approval of that plan");
    expect(note).toContain("[`app`](report.html#root-app) reads `net`; `stamp` known once it applies");
    expect(parseMarker(note)!.waves.find((w) => w.number === 2)!.digest).toBeNull();
    const html = readFileSync(join(result.dir, "report.html"), "utf-8");
    expect(readInlineReport(html).waves[1].replans_after).toEqual([1]);
    expect(html).toContain("plans again once wave 1 applies");
    expect(html).toContain('data-upstream="net"');
  });

  it("plans on the applied state, and says why, when the linked plan fails", async () => {
    const repo = estate({ "app/fail-linked": "" });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: linkedTofu(tmp()), layers: [["net"], ["app"]], out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    const app = report.roots.find((r) => r.path === "app")!;
    expect(app.status).toBe("planned");
    expect(app.reads).toEqual([{ upstream: "net", data: "net", outputs: "applied", why: "the plan on its planned outputs failed: Invalid for_each argument" }]);
    expect(report.waves[1].replans_after).toBeUndefined();
    expect(logs.some((l) => l.startsWith("app: the plan on the planned outputs of net failed (Invalid for_each argument)"))).toBe(true);
  });

  it("holds back a root whose upstream has never applied, even when that upstream planned in the run", async () => {
    const repo = estate({ "net/never-applied": "" });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: linkedTofu(tmp()), layers: [["net"], ["app"]], out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    // app never planned, linked or not: its remote state block would read a state that does not exist.
    expect(existsSync(join(repo, "app/linked.seen"))).toBe(false);
    expect(logs).toContain("app: held back, net has no state yet");
    expect(report.roots.map((r) => r.path)).toEqual(["net"]);
    expect(report.deferred).toEqual([expect.objectContaining({ unit: "app", after: ["net"], previewed: false })]);
    expect(report.waves.map((w) => w.number)).toEqual([1]);
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
  });

  it("plans on the applied state when the upstream is not planned in the run", async () => {
    const repo = estate();
    const { report } = await runStage("tf-plan", repo, { binary: linkedTofu(tmp()), layers: [["net"], ["app"]], root: "app", out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    expect(existsSync(join(repo, "app/linked.seen"))).toBe(false);
    expect(report.roots[0].reads).toEqual([{ upstream: "net", data: "net", outputs: "applied", why: "this change does not reach it, so its state stands" }]);
    expect(report.waves[0].replans_after).toBeUndefined();
  });
});
