// A composed run that fails part way (terragucci#1268): chant's run applies a, then b's resource errors, and c never
// starts. What applied stays applied: a's and b's states are written with what applied to them, and c's is left as it
// was. The test drives chant's ComposedRun through terragucci's wrapper with a fake tofu (the one chant's own
// compose/run.test.ts uses), then asserts the shapes a reader sees: apply.ts's per-root lines and its FAILED line, the
// report's member rows, and the note's text from views.ts.
//
// chant's composed run is in no published chant yet (terragucci#1278): this runs when the installed chant has it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyComposedWave } from "../src/apply";
import { chantNextParts } from "../src/chant-next";
import { COMPOSE_DIR, ComposedRun, compositionFor } from "../src/compose";
import type { BinaryExec } from "../src/migrate";
import type { Report } from "../src/report/schema";
import { composeBlock } from "../src/report/views";
import { tmp, write } from "./helpers";

const parts = await chantNextParts();

const A = 'resource "terraform_data" "x" {\n  input = "a"\n}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n';
const reader = (up: string): string =>
  `data "terraform_remote_state" "${up}" {\n  backend = "local"\n  config = {\n    path = "../${up}/terraform.tfstate"\n  }\n}\n\nresource "terraform_data" "x" {\n  input = data.terraform_remote_state.${up}.outputs.id\n}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n`;
const MEMBERS = ["a", "b", "c"];

const change = (m: string) => ({
  address: `module.${m}.terraform_data.x`,
  module_address: `module.${m}`,
  mode: "managed",
  type: "terraform_data",
  name: "x",
  provider_name: "terraform.io/builtin/terraform",
  change: { actions: ["create"], before: null, after: {}, after_unknown: { id: true, input: m !== "a", output: true } },
});
const composedPlan = {
  format_version: "1.2",
  resource_changes: MEMBERS.map(change),
  output_changes: Object.fromEntries(MEMBERS.map((m) => [`${m}__id`, { actions: ["create"], before: null, after_unknown: true }])),
  planned_values: { outputs: {}, root_module: {} },
};

interface StateFile {
  serial: number;
  outputs?: Record<string, unknown>;
  resources: { module?: string; mode: string; type: string; name: string; provider: string; instances: unknown[] }[];
}

const resource = (m: string, id: string, input: string, status?: string) => ({
  module: `module.${m}`,
  mode: "managed",
  type: "terraform_data",
  name: "x",
  provider: 'provider["terraform.io/builtin/terraform"]',
  instances: [{ schema_version: 0, ...(status ? { status } : {}), attributes: { id, input, output: input } }],
});

/** A fake tofu for a, b and c with local state, whose apply fails at `failing`'s resource. */
function fakeTofu(repo: string, failing: string) {
  const pushed: string[] = [];
  const composeDir = join(repo, COMPOSE_DIR);
  const exec: BinaryExec = async (_bin, args, dir) => {
    const who = dir === composeDir ? "compose" : basename(dir);
    const ok = (stdout = "") => ({ code: 0, stdout, out: stdout });
    const [cmd, sub] = args;
    if (cmd === "init") return ok();
    if (cmd === "state" && sub === "pull") return ok(existsSync(join(dir, "terraform.tfstate")) ? readFileSync(join(dir, "terraform.tfstate"), "utf-8") : "");
    if (cmd === "state" && sub === "push") {
      writeFileSync(join(dir, "terraform.tfstate"), readFileSync(args.at(-1)!, "utf-8"));
      pushed.push(who);
      return ok();
    }
    if (cmd === "plan") {
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), "plan");
      return ok("Plan: 3 to add, 0 to change, 0 to destroy.\n");
    }
    if (cmd === "show" && args.includes("-json") && args.at(-1)!.endsWith(".tfplan")) return ok(JSON.stringify(composedPlan));
    if (cmd === "show" && args.at(-1)!.endsWith(".tfplan")) return ok("");
    if (cmd === "apply") {
      const working = JSON.parse(readFileSync(join(composeDir, "terraform.tfstate"), "utf-8")) as StateFile;
      const lines: string[] = [];
      const ids: Record<string, string> = {};
      let stopped = false;
      for (const m of MEMBERS) {
        if (stopped) break;
        const addr = `module.${m}.terraform_data.x`;
        lines.push(JSON.stringify({ type: "apply_start", hook: { resource: { addr } } }));
        const input = m === "a" ? "a" : ids[m === "b" ? "a" : "b"]!;
        if (m === failing) {
          working.resources.push(resource(m, `${m}-1`, input, "tainted"));
          lines.push(JSON.stringify({ type: "apply_errored", hook: { resource: { addr }, error: "local-exec provisioner error" } }));
          stopped = true;
          continue;
        }
        ids[m] = `${m}-1`;
        working.resources.push(resource(m, ids[m]!, input));
        working.outputs = { ...working.outputs, [`${m}__id`]: { value: ids[m], type: "string" } };
        lines.push(JSON.stringify({ type: "apply_complete", hook: { resource: { addr } } }));
      }
      working.serial += 1;
      writeFileSync(join(composeDir, "terraform.tfstate"), JSON.stringify(working));
      return { code: stopped ? 1 : 0, stdout: lines.join("\n") + "\n", out: lines.join("\n") };
    }
    if (cmd === "show" && args.includes("-json")) {
      const working = JSON.parse(readFileSync(join(composeDir, "terraform.tfstate"), "utf-8")) as StateFile;
      const outputs = Object.fromEntries(Object.entries(working.outputs ?? {}).map(([k, v]) => [k, { value: (v as { value: unknown }).value, sensitive: false }]));
      const child_modules = MEMBERS.map((m) => ({ address: `module.${m}`, resources: working.resources.filter((r) => r.module === `module.${m}`).map(() => ({ address: `module.${m}.terraform_data.x`, type: "terraform_data", name: "x" })) }));
      return ok(JSON.stringify({ format_version: "1.0", values: { outputs, root_module: { child_modules } } }));
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, pushed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.runIf(parts.compose && parts.composeRun)("a composed run that fails on its second member", () => {
  it("says so in apply's lines, its FAILED line, the report's rows and the note, and keeps what applied", async () => {
    const repo = write(tmp(), { "a/main.tf": A, "b/main.tf": reader("a"), "c/main.tf": reader("b") });
    const c = await compositionFor(repo, {
      all: MEMBERS,
      waves: [["a"], ["b"], ["c"]],
      env: {},
      binary: () => ({ name: "tofu" }),
      deps: new Map([["b", new Set(["a"])], ["c", new Set(["b"])]]),
    });
    expect(c.fallback).toBeUndefined();
    expect(c.order).toEqual(MEMBERS);
    expect(c.wave).toBe(1);

    const fake = fakeTofu(repo, "b");
    const run = new ComposedRun({ repo, composition: c, binary: { path: "tofu", name: "tofu" }, env: {}, work: tmp(), lock: true, runId: "run-1", hooks: { log: () => {} }, exec: fake.exec, retryDelays: [0, 0] });
    const planned = await run.plan();
    expect(planned.error).toBeUndefined();

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const w: Parameters<typeof applyComposedWave>[2] = { composed: { target: "compose:wave-1", planDigest: planned.digest, members: [] } };
    const composed = { run, planned: { root: "compose:wave-1" } as unknown as Parameters<typeof applyComposedWave>[1]["planned"] };
    const ok = await applyComposedWave("wave 1", composed, w);
    const lines = out.mock.calls.map((x) => String(x[0]));

    // apply.ts: one line per root, upstreams first, then the FAILED line that says what applied stays applied.
    expect(ok).toBe(false);
    expect(lines[0]).toBe("wave 1: a (module.a): applied, 1 of 1 changes; its state written");
    expect(lines[1]).toMatch(/^wave 1: b \(module\.b\): failed, 0 of 1 changes; its state written: .*local-exec provisioner error/);
    expect(lines[2]).toMatch(/^wave 1: c \(module\.c\): not-started, 0 of \d+ changes; its state as it was$/);
    const failed = lines.filter((l) => l.startsWith("FAILED "));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^FAILED compose:wave-1: .+; what applied stays applied, and each state was written with what applied to it$/);

    // The report's rows: what came of each member, and the run's error.
    const rows = w.composed!.members;
    expect(rows).toEqual([
      { root: "a", module: "module.a", apply: "applied", changes: { done: 1, planned: 1 }, state: "written" },
      { root: "b", module: "module.b", apply: "failed", changes: { done: 0, planned: 1 }, state: "written", error: expect.stringContaining("local-exec provisioner error") },
      { root: "c", module: "module.c", apply: "not-started", changes: { done: 0, planned: expect.any(Number) }, state: "unchanged" },
    ]);
    expect(w.composed!.error).toMatch(/\S/);
    expect(composed).toMatchObject({ result: { ok: false, settled: MEMBERS } });

    // What applied stays applied: a's and b's states were written, c's was never touched, and no lock is left.
    expect(fake.pushed).toEqual(["a", "b"]);
    expect(existsSync(join(repo, "c/terraform.tfstate"))).toBe(false);
    expect(MEMBERS.filter((m) => existsSync(join(repo, m, "terraform.tfstate.tflock")))).toEqual([]);
    expect(existsSync(join(repo, COMPOSE_DIR))).toBe(false);

    // views.ts: the note's block for the composed run, on the wave's tf-apply report.
    const report = {
      run: { stage: "tf-apply" },
      compose: { roots: MEMBERS, max: 10, wave: 1 },
      waves: [{ number: 1, roots: MEMBERS, composed: { plan_digest: planned.digest, members: rows } }],
      roots: MEMBERS.map((path) => ({ path, counts: { create: 1 } })),
    } as unknown as Report;
    const text = composeBlock(report)!;
    expect(text).toContain("**One composed run, in wave 1** (`waves.compose`): `a`, `b` and `c` plan as one plan and apply as one apply.");
    expect(text).toContain("If the apply fails part way, what applied stays applied");
    expect(text).toContain("**The composed run failed part way.** What applied stays applied, and each state was written with what applied to it:");
    expect(text).toContain("| `a` | applied, 1 of 1 | written |");
    expect(text).toMatch(/\| `b` \| failed, 0 of 1: [^\n]*local-exec provisioner error[^\n]* \| written \|/);
    expect(text).toMatch(/\| `c` \| not-started, 0 of \d+ \| as it was, nothing to write \|/);
    expect(text).toContain("Running the wave again plans what is left against these states.");
    expect(text).not.toContain("**The composed run applied.**");
  });
});
