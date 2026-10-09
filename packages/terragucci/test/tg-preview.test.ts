// Terragrunt previews: a unit of a later layer planned on its upstream's
// planned outputs (src/tg-preview.ts), and the gate's comparison with the
// preview (src/tg-preview-gate.ts). Terragrunt is stubbed, but the stub asks
// for a dependency's outputs the way 1.1.6 does: `TG_TF_PATH output -json`,
// in a directory holding only the upstream's backend file, so the real
// wrapper script answers it.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { buildReport } from "../src/report/build";
import { noteMarker, parseMarker } from "../src/report/marker";
import { runStage } from "../src/report/stage";
import { renderNote } from "../src/report/views";
import {
  backendStrings,
  ctyType,
  dependencyReads,
  missingOutput,
  notePreviews,
  previewDifferences,
  previewReads,
  readsOf,
  servedOutputs,
  servingWrapper,
} from "../src/tg-preview";
import { gatePreview } from "../src/tg-preview-gate";
import type { PlannedOutput } from "../src/planned-outputs";
import { rc, RUN } from "./report-fixtures";
import { git, tmp, write } from "./helpers";

const out = (value: unknown, unknown: unknown = false, sensitive = false): PlannedOutput => ({ value, unknown, sensitive });

describe("the outputs handed to Terragrunt", () => {
  it("types each value as output -json does, and leaves out an output any part of which is unknown, and a null", () => {
    expect(ctyType({ a: [1, "x"], b: true, c: null })).toEqual(["object", { a: ["tuple", ["number", "string"]], b: "bool", c: "string" }]);
    const served = servedOutputs(new Map([
      ["rev", out("r2")],
      ["ids", out(["a", null], [false, true])],
      ["out", out(null, true)],
      ["gone", out(null)],
      ["secret", out("s3cr3t", false, true)],
    ]));
    expect(served).toEqual({ rev: { sensitive: false, type: "string", value: "r2" }, secret: { sensitive: true, type: "string", value: "s3cr3t" } });
  });

  it("takes the strings of a unit's remote_state config, quoted, and none HCL would escape", () => {
    expect(backendStrings({ remote_state: { backend: "s3", config: { bucket: "state", key: "live/net/tf.tfstate", encrypt: true, odd: 'a"b', tmpl: "${x}" } } })).toEqual(['"live/net/tf.tfstate"', '"state"']);
    expect(backendStrings({ remote_state: null })).toEqual([]);
  });
});

describe("what a unit reads", () => {
  const app = (body: string): string => `include "root" { path = find_in_parent_folders("root.hcl") }\n${body}`;

  it("reads the outputs a dependency's references name, and every output when one takes the whole object", () => {
    expect([...dependencyReads(['inputs = { a = dependency.net.outputs.rev, b = dependency.net.outputs["id"] }'], "net")!]).toEqual(["rev", "id"]);
    expect(dependencyReads(["inputs = dependency.net.outputs"], "net")).toBeUndefined();
    expect(dependencyReads(["x = dependency.net"], "net")).toBeUndefined();
    expect([...dependencyReads(["x = dependency.net.config_path # dependency.net.outputs"], "net")!]).toEqual([]);
    expect([...dependencyReads(["x = dependency.network.outputs.a"], "net")!]).toEqual([]);
  });

  it("names a block's upstream from a plain config_path, and counts a dependencies edge as reading nothing", () => {
    const texts = { own: app('dependency "net" {\n  config_path = "../net"\n}\ndependencies {\n  paths = ["../db"]\n}\ninputs = { up = dependency.net.outputs.rev }\n'), others: [] };
    expect(readsOf("live/app", "live/net", texts)).toEqual({ labels: ["net"], outputs: new Set(["rev"]) });
    expect(readsOf("live/app", "live/db", texts)).toBeNull();
  });

  it("a block whose path is built, or one in an included file, may name any upstream: every output counts as read", () => {
    const built = { own: app('dependency "net" {\n  config_path = "${get_terragrunt_dir()}/../net"\n}\n'), others: [] };
    expect(readsOf("live/app", "live/net", built)).toEqual({ labels: [] });
    const included = { own: app('dependency "db" {\n  config_path = "../db"\n}\ninputs = { a = dependency.db.outputs.url }\n'), others: ['dependency "net" {\n  config_path = "../net"\n}\n'] };
    expect(readsOf("live/app", "live/db", included)).toEqual({ labels: ["db"] });
  });

  const texts = { own: 'dependency "net" {\n  config_path = "../net"\n}\ninputs = { up = dependency.net.outputs.rev }\n', others: [] };
  const plan = (outputs: Record<string, { after: unknown; after_unknown?: unknown; actions?: string[] }>) => ({
    output_changes: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, { actions: v.actions ?? ["update"], after: v.after, after_unknown: v.after_unknown ?? false }])),
  });

  it("previews a unit on an upstream's planned outputs when every value it reads is known", () => {
    const run = new Map([["live/net", { plan: plan({ rev: { after: "r2" }, id: { after: null, after_unknown: true } }), wave: 1 }]]);
    expect(previewReads("live/app", ["live/net"], texts, run)).toEqual({ reads: [{ upstream: "live/net", data: "net", outputs: "planned" }], served: ["live/net"] });
  });

  it("names a value known only once the upstream applies, and the wave that settles it", () => {
    const run = new Map([["live/net", { plan: plan({ rev: { after: null, after_unknown: true } }), wave: 1 }]]);
    expect(previewReads("live/app", ["live/net"], texts, run)).toEqual({ after: ["live/net"], why: "reads `rev` of live/net, unknown until wave 1 applies" });
  });

  it("an upstream whose plan changes no output keeps its state, and one that has no plan holds the unit back", () => {
    const same = new Map([["live/net", { plan: plan({ rev: { after: "r1", actions: ["no-op"] } }), wave: 1 }]]);
    expect(previewReads("live/app", ["live/net"], texts, same)).toEqual({ reads: [], served: [] });
    const none = new Map([["live/net", { wave: 1 }]]);
    expect(previewReads("live/app", ["live/net"], texts, none)).toEqual({ after: ["live/net"], why: "reads live/net, which has no plan in this run, so what it reads is known once wave 1 applies" });
    // An upstream outside the run: its applied state stands.
    expect(previewReads("live/app", ["live/net"], texts, new Map())).toEqual({ reads: [], served: [] });
  });

  it("reads a missing attribute out of Terragrunt's error", () => {
    expect(missingOutput('Error: Unsupported attribute\n  on terragrunt.hcl line 6:\nThis object does not have an attribute named "out".')).toBe("out");
    expect(missingOutput("Error: boom")).toBeUndefined();
  });
});

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> =>
  new Promise((done) => execFile(file, args, { cwd, env }, (err, stdout) => done({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout })));

/** A stand-in for the binary: `output` prints applied.json from where it runs (the state), and nothing else does anything. */
function fakeBinary(): string {
  const bin = join(tmp(), "tofu");
  writeFileSync(bin, '#!/bin/sh\ncase "$1" in output) if [ -f applied.json ]; then cat applied.json; else echo "{}"; fi ;; *) exit 0 ;; esac\n');
  chmodSync(bin, 0o755);
  return bin;
}

const backendFile = (unit: string): string => `# Generated by Terragrunt.\nterraform {\n  backend "s3" {\n    bucket = "state"\n    key    = "${unit}/tf.tfstate"\n  }\n}\n`;

describe("the wrapper", () => {
  it("records each unit's working directory, answers output -json for a served upstream by its directory or its backend file, and runs the binary otherwise", async () => {
    const bin = fakeBinary();
    const work = tmp();
    const rec = join(work, "rec");
    mkdirSync(rec, { recursive: true });
    const plans = join(work, "plans");
    const net = join(work, "cache/net");
    write(net, { "backend.tf": backendFile("live/net"), "main.tf": "", "applied.json": '{"rev":{"value":"r1"}}' });
    write(rec, { "net.json": '{"rev":{"sensitive":false,"type":"string","value":"r2"}}\n' });
    const wrapper = join(work, "tofu");
    const env = { PATH: process.env.PATH, TERRAGUCCI_TG_NEXT: bin };
    // The upstream's plan records its working directory.
    writeFileSync(wrapper, servingWrapper("tofu", [plans], rec, []));
    chmodSync(wrapper, 0o755);
    await run(wrapper, ["plan", `-out=${join(plans, "live/net/tfplan.tfplan")}`], net, env);
    const dir = readFileSync(join(rec, "dirs.tsv"), "utf-8").trim().split("\t");
    expect(dir[0]).toBe("live/net");
    // The next wave's wrapper serves it.
    writeFileSync(wrapper, servingWrapper("tofu", [plans], rec, [{ unit: "live/net", dir: dir[1], outputs: join(rec, "net.json"), backend: ['"live/net/tf.tfstate"', '"state"'] }]));
    expect((await run(wrapper, ["output", "-json"], net, env)).stdout).toContain('"r2"');
    const optimized = write(join(work, "dl/123"), { "backend.tf": backendFile("live/net") });
    expect((await run(wrapper, ["output", "-json", "-no-color"], optimized, env)).stdout).toContain('"r2"');
    // Another unit's backend file, a named output and a plan go to the binary.
    const other = write(join(work, "dl/456"), { "backend.tf": backendFile("live/db"), "applied.json": '{"url":{"value":"db"}}' });
    expect((await run(wrapper, ["output", "-json"], other, env)).stdout).toContain('"db"');
    expect((await run(wrapper, ["output", "-json", "rev"], net, env)).stdout).toContain('"r1"');
    expect(readFileSync(join(rec, "served.tsv"), "utf-8").trim().split("\n").map((l) => l.split("\t").slice(0, 2))).toEqual([["live/net", "dir"], ["live/net", "backend"]]);
  });
});

// ── the stage ────────────────────────────────────────────────────────────

interface Unit {
  path: string;
  /** Dependency label to upstream path, and the output read through it. */
  deps?: { label: string; upstream: string; output: string }[];
  rev: string;
  /** The rev and upstream value it last applied. */
  applied?: { rev: string; up: string };
}

const UNITS: Unit[] = [
  { path: "live/net", rev: "2", applied: { rev: "1", up: "" } },
  { path: "live/app", deps: [{ label: "net", upstream: "live/net", output: "rev" }], rev: "1", applied: { rev: "1", up: "r1" } },
  { path: "live/edge", deps: [{ label: "app", upstream: "live/app", output: "out" }], rev: "1", applied: { rev: "1", up: "1-r1" } },
];

const unitHcl = (u: Unit): string => [
  'include "root" { path = find_in_parent_folders("root.hcl") }',
  'terraform { source = "../../modules/rev" }',
  ...(u.deps ?? []).map((d) => `dependency "${d.label}" {\n  config_path = "../${d.upstream.split("/").pop()}"\n}`),
  `inputs = {\n  rev = "${u.rev}"\n${(u.deps ?? []).map((d) => `  up  = dependency.${d.label}.outputs.${d.output}\n`).join("")}}`,
  "",
].join("\n");

function previewRepo(units: Unit[] = UNITS): string {
  const repo = write(tmp(), {
    "root.hcl": 'remote_state {\n  backend = "s3"\n  config  = { bucket = "state", key = "${path_relative_to_include()}/tf.tfstate" }\n}\n',
    "modules/rev/main.tf": "",
    ...Object.fromEntries(units.map((u) => [`${u.path}/terragrunt.hcl`, unitHcl(u)])),
  });
  git(repo, "init", "-q");
  return repo;
}

const argOf = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Terragrunt 1.1.6 as far as a preview sees it: each unit plans in its own
 * working directory through TG_TF_PATH, and reads a dependency's outputs with
 * `TG_TF_PATH output -json` in a directory holding the upstream's backend
 * file (or, with `fromState`, straight from the state, as
 * --dependency-fetch-output-from-state does).
 */
function fakeTerragrunt(units: Unit[], opts: { fromState?: boolean; selected?: string[] } = {}): TerragruntExec {
  const byPath = new Map(units.map((u) => [u.path, u]));
  const applied = (u: Unit): Record<string, { value: string }> => (u.applied ? { rev: { value: `r${u.applied.rev}` }, out: { value: `${u.applied.rev}-${u.applied.up}` } } : {});
  const cache = mkdtempSync(join(tmp(), "cache-"));
  const workdir = (u: Unit): string => write(join(cache, u.path), { "backend.tf": backendFile(u.path), "main.tf": "", "applied.json": JSON.stringify(applied(u)) });
  return async (file, args, options) => {
    const env = { ...process.env, ...options.env };
    if (file === "git") return { code: 0, stdout: (opts.selected ?? []).map((u) => `${u}/terragrunt.hcl`).join("\n"), stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") {
      if (args.some((a) => a.startsWith("["))) return { code: 0, stdout: JSON.stringify((opts.selected ?? []).map((path) => ({ type: "unit", path }))), stderr: "" };
      return { code: 0, stdout: JSON.stringify(units.map((u) => ({ type: "unit", path: u.path, dependencies: (u.deps ?? []).map((d) => d.upstream) }))), stderr: "" };
    }
    if (args[0] === "render") {
      const u = byPath.get(argOf(args, "--working-dir")!)!;
      const dependency = Object.fromEntries((u.deps ?? []).map((d) => [d.label, { config_path: `../${d.upstream.split("/").pop()}` }]));
      return { code: 0, stdout: JSON.stringify({ dependency, remote_state: { backend: "s3", config: { bucket: "state", key: `${u.path}/tf.tfstate` } } }), stderr: "" };
    }
    if (args.includes("output")) {
      const u = byPath.get(argOf(args, "--working-dir")!)!;
      const r = await run(env.TG_TF_PATH!, ["output", "-json"], workdir(u), env);
      return { code: r.code, stdout: r.stdout, stderr: "" };
    }
    const filtered = args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith("{./") ? [a.slice(3, -1)] : []));
    const outDir = argOf(args, "--out-dir")!;
    const json = argOf(args, "--json-out-dir")!;
    const rows = [];
    for (const path of filtered) {
      const u = byPath.get(path)!;
      let up = "";
      let failed: string | undefined;
      for (const d of u.deps ?? []) {
        const upstream = byPath.get(d.upstream)!;
        let outputs: Record<string, { value?: unknown }>;
        if (opts.fromState) outputs = applied(upstream);
        else {
          const dir = write(mkdtempSync(join(cache, "dep-")), { "backend.tf": backendFile(upstream.path), "applied.json": JSON.stringify(applied(upstream)) });
          outputs = JSON.parse((await run(env.TG_TF_PATH!, ["output", "-json"], dir, env)).stdout || "{}");
        }
        const v = outputs[d.output]?.value;
        if (v === undefined) failed = `Error: Unsupported attribute\nThis object does not have an attribute named "${d.output}".`;
        else up = String(v);
      }
      if (failed) {
        rows.push({ Name: path, Result: "failed", Reason: "run error", Cause: failed });
        continue;
      }
      await run(env.TG_TF_PATH!, ["plan", "-input=false", `-out=${join(outDir, path, "tfplan.tfplan")}`], workdir(u), env);
      const before = u.applied ? `${u.applied.rev}-${u.applied.up}` : null;
      const after = `${u.rev}-${up}`;
      const moved = before !== after;
      const plan = {
        format_version: "1.2",
        resource_changes: [rc("terraform_data.this", moved ? (before === null ? ["create"] : ["update"]) : ["no-op"], before === null ? null : { input: before }, { input: after })],
        output_changes: {
          rev: { actions: u.applied?.rev === u.rev ? ["no-op"] : ["update"], after: `r${u.rev}`, after_unknown: false },
          out: moved ? { actions: ["update"], after: null, after_unknown: true } : { actions: ["no-op"], after: before, after_unknown: false },
        },
      };
      for (const [dir, f, body] of [[outDir, "tfplan.tfplan", "binary"], [json, "tfplan.json", JSON.stringify(plan)]] as const) {
        mkdirSync(join(dir, path), { recursive: true });
        writeFileSync(join(dir, path, f), body);
      }
      rows.push({ Name: path, Result: "succeeded" });
    }
    const report = argOf(args, "--report-file")!;
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(rows));
    return { code: rows.some((r) => r.Result === "failed") ? 1 : 0, stdout: "", stderr: "" };
  };
}

const input = (r: { roots: { path: string; changes: { attributes: { path: string; after?: unknown }[] }[] }[] }, unit: string): unknown =>
  r.roots.find((x) => x.path === unit)?.changes[0]?.attributes.find((a) => a.path === "input")?.after;

describe("terragucci stage tf-plan previews a Terragrunt repo's later layers", () => {
  it("plans live/app on live/net's planned outputs, and names the value live/edge reads before live/app applies", async () => {
    const repo = previewRepo();
    const logs: string[] = [];
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: fakeBinary(), terragrunt: true, terragruntExec: fakeTerragrunt(UNITS), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(input(r.report, "live/net")).toBe("2-");
    expect(input(r.report, "live/app")).toBe("1-r2");
    const app = r.report.roots.find((u) => u.path === "live/app")!;
    expect(app.reads).toEqual([{ upstream: "live/net", data: "net", outputs: "planned" }]);
    expect(app.terragrunt?.provisional).toBe(false);
    expect(r.report.roots.map((u) => u.path).sort()).toEqual(["live/app", "live/net"]);
    expect(r.report.deferred).toEqual([{ unit: "live/edge", after: ["live/app"], why: "reads `out` of live/app, unknown until wave 2 applies", previewed: false }]);
    // Wave 3 has no plan yet: it plans once wave 2 applies.
    expect(r.report.waves.map((w) => [w.number, w.roots, w.reads ?? []])).toEqual([[1, ["live/net"], []], [2, ["live/app"], [1]]]);
    expect(r.report.waves[1].review_digest).toMatch(/sha256/);
    expect(logs).toContain("live/app: plans on the planned outputs of live/net");
    const note = readFileSync(join(repo, "out/note.md"), "utf-8");
    expect(note).toContain("`live/edge` after `live/app`: reads `out` of live/app, unknown until wave 2 applies");
    const marker = parseMarker(note)!;
    expect(marker.previews?.map((p) => p.unit)).toEqual(["live/app"]);
    expect(marker.previews?.[0].plan).toBe(app.plan_digest);
  });

  it("a unit planned alone reads its upstream's applied state", async () => {
    const repo = previewRepo();
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: fakeBinary(), terragrunt: true, root: "live/app", terragruntExec: fakeTerragrunt(UNITS), env: { PATH: process.env.PATH } }, () => {});
    // On r1, live/net's applied rev: no change.
    expect(r.report.roots.map((u) => [u.path, u.changes.length])).toEqual([["live/app", 0]]);
    expect(r.report.roots[0].reads).toBeUndefined();
  });

  it("a unit whose plan read its upstream straight from state is not shown as a preview", async () => {
    const repo = previewRepo();
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: fakeBinary(), terragrunt: true, terragruntExec: fakeTerragrunt(UNITS, { fromState: true }), env: { PATH: process.env.PATH } }, () => {});
    expect(r.report.roots.map((u) => u.path)).not.toContain("live/app");
    expect(r.report.deferred?.find((d) => d.unit === "live/app")?.why).toBe("Terragrunt did not ask the binary for the outputs of live/net, so its plan is not on their planned outputs");
  });

  it("with dependents: plan, the dependents of a changed unit are previewed layer by layer, provisional, and the one that reads an unknown is named", async () => {
    const repo = previewRepo();
    write(repo, { "terragucci.yml": "terragrunt:\n  dependents: plan\n" });
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: fakeBinary(), terragrunt: true, base: "origin/main", terragruntExec: fakeTerragrunt(UNITS, { selected: ["live/net"] }), env: { PATH: process.env.PATH } }, () => {});
    expect(input(r.report, "live/app")).toBe("1-r2");
    expect(r.report.roots.find((u) => u.path === "live/app")?.terragrunt?.provisional).toBe(true);
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/net"]]);
    expect(r.report.deferred).toEqual([
      { unit: "live/app", after: ["live/net"], why: "depends on a changed unit", previewed: true },
      { unit: "live/edge", after: ["live/app", "live/net"], why: "depends on a changed unit; reads `out` of live/app, unknown until wave 2 applies", previewed: false },
    ]);
    expect(parseMarker(readFileSync(join(repo, "out/note.md"), "utf-8"))?.previews?.map((p) => p.unit)).toEqual(["live/app"]);
  });

  it("a later unit that reads an unknown is not planned, and its wave plans again once the upstream's wave applies", async () => {
    const units: Unit[] = [UNITS[0]!, UNITS[1]!, { ...UNITS[2]!, path: "live/edge" }, { path: "live/side", deps: [{ label: "net", upstream: "live/net", output: "rev" }], rev: "2", applied: { rev: "1", up: "r1" } }];
    // live/side sits in live/edge's layer by reading live/app too.
    units[3]!.deps!.push({ label: "app", upstream: "live/app", output: "rev" });
    const repo = previewRepo(units);
    const r = await runStage("tf-plan", repo, { out: join(repo, "out"), binary: fakeBinary(), terragrunt: true, terragruntExec: fakeTerragrunt(units), env: { PATH: process.env.PATH } }, () => {});
    // live/app's rev is known: it does not change.
    expect(input(r.report, "live/side")).toBe("2-r1");
    const three = r.report.waves.find((w) => w.number === 3)!;
    expect(three.roots).toEqual(["live/side"]);
    expect(three.replans_after).toEqual([2]);
    expect(three.review_digest).toBeNull();
  });
});

describe("the gate against the preview", () => {
  const changes = (input: string, before = "1-r1") =>
    buildReport({ run: RUN, roots: [{ path: "live/app", plan: { resource_changes: [rc("terraform_data.this", ["update"], { input: before }, { input })] }, planner: "tofu" }] }).roots[0]!;

  it("says nothing when the digests match, and names each attribute, address and action that moved", () => {
    const was = notePreviews([{ ...changes("1-r2"), terragrunt: { stack: "live", selection: "", provisional: false, run_result: "succeeded" }, reads: [{ upstream: "live/net", data: "net", outputs: "planned" }] }]);
    expect(was).toHaveLength(1);
    const same = changes("1-r2");
    expect(previewDifferences(was[0]!, same.plan_digest, same.changes)).toEqual([]);
    const moved = changes("1-r3");
    expect(previewDifferences(was[0]!, moved.plan_digest, moved.changes)).toEqual(["terraform_data.this (update): input differs from the preview"]);
    const none = buildReport({ run: RUN, roots: [{ path: "live/app", plan: { resource_changes: [rc("terraform_data.other", ["create"], null, { input: "x" })] }, planner: "tofu" }] }).roots[0]!;
    expect(previewDifferences(was[0]!, none.plan_digest, none.changes)).toEqual([
      "terraform_data.other (create) was not in the preview",
      "terraform_data.this (update) was in the preview and is not planned now",
    ]);
    expect(previewDifferences({ ...was[0]!, changes: undefined }, moved.plan_digest, moved.changes)).toEqual(["its plan differs from the preview; the note had no room for the preview's changes"]);
  });

  it("only previewed Terragrunt units go into the marker, and over its room the changes go and the digests stay", () => {
    const root = { ...changes("1-r2"), terragrunt: { stack: "live", selection: "", provisional: false, run_result: "succeeded" }, reads: [{ upstream: "live/net", data: "net", outputs: "planned" as const }] };
    expect(notePreviews([{ ...root, reads: undefined }, { ...root, terragrunt: undefined }])).toEqual([]);
    expect(notePreviews([root], 10)).toEqual([{ unit: "live/app", plan: root.plan_digest }]);
    // Nothing in the marker ends the HTML comment it sits in.
    const marker = noteMarker({ head: "abc", waves: [], previews: [{ unit: "a-->b", plan: null }] });
    expect(marker).not.toMatch(/-->.*-->/);
    expect(parseMarker(marker)?.previews?.[0]?.unit).toBe("a-->b");
  });

  it("reads the merged pull request's note and compares each unit it previewed", async () => {
    const was = changes("1-r2");
    const note = renderNote(buildReport({
      run: { ...RUN, stage: "tf-plan", commit: "f".repeat(40) },
      roots: [{ path: "live/app", plan: { resource_changes: [rc("terraform_data.this", ["update"], { input: "1-r1" }, { input: "1-r2" })] }, planner: "tofu", terragrunt: { stack: "live", selection: "", provisional: false, run_result: "succeeded" }, reads: [{ upstream: "live/net", data: "net", outputs: "planned" }] }],
      waves: [{ number: 2, roots: ["live/app"] }],
      gate: "always",
    }));
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = url.endsWith(`/commits/${"a".repeat(40)}/pull`) ? { number: 7, head: { sha: "f".repeat(40) } } : url.includes("/issues/7/comments") ? [{ body: note }] : null;
      return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body, text: async () => "" } as Response;
    };
    const env = { GITHUB_REPOSITORY: "acme/live", GITHUB_SERVER_URL: "https://forgejo.example", TG_TOKEN: "t" };
    const now = changes("5-r2", "5-r1");
    const found = await gatePreview({ env, fetch: fetch as never, forge: "forgejo", sha: "a".repeat(40), units: [{ unit: "live/app", plan: now.plan_digest, changes: now.changes }] });
    expect(found.preview).toEqual({ pull_request: 7, units: [{ unit: "live/app", differences: ["terraform_data.this (update): input differs from the preview"] }] });
    expect(found.lines).toEqual([
      "pull request 7 previewed live/app on the planned outputs of the waves before; this unit plans differently now:",
      "  live/app: terraform_data.this (update): input differs from the preview",
    ]);
    const held = await gatePreview({ env, fetch: fetch as never, forge: "forgejo", sha: "a".repeat(40), units: [{ unit: "live/app", plan: was.plan_digest, changes: was.changes }] });
    expect(held.lines).toEqual(["live/app plans as pull request 7 previewed it, on the planned outputs of the waves before"]);
    // A direct push: no pull request, nothing said.
    expect(await gatePreview({ env, fetch: fetch as never, forge: "forgejo", sha: "b".repeat(40), units: [] })).toEqual({ lines: [] });
  });
});
