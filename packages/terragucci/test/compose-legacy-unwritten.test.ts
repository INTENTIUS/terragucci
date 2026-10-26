// A state the composed run before chant's (terragucci 0.4.45 and earlier) could not write was kept beside the
// root's state as `<key>.terragucci-unwritten`, its lock held under the operation `terragucci compose`. The next
// run, on chant's composed run (terragucci#1268), takes that lock over and writes the kept state before it
// plans anything, then removes it; chant writes only `.chant-unwritten` from then on.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPOSE_DIR, ComposedRun, compositionFor } from "../src/compose";
import { tmp, write } from "./helpers";

const state = (serial: number, id: string) => ({
  version: 4,
  terraform_version: "1.10.0",
  serial,
  lineage: "app-lineage",
  outputs: {},
  resources: [{ mode: "managed", type: "terraform_data", name: "web", provider: 'provider["registry.opentofu.org/hashicorp/terraform"]', instances: [{ schema_version: 0, attributes: { id } }] }],
});

const tree = (): string =>
  write(tmp(), {
    "network/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "net" {}\noutput "id" {\n  value = terraform_data.net.id\n}\n`,
    "app/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "web" {}\n`,
  });

describe("a state the old composed run kept unwritten", () => {
  it("is written first by the next composed run, under the lock it took over, and then removed", async () => {
    const dir = tree();
    const kept = state(7, "kept-by-0.4.45");
    writeFileSync(join(dir, "app/terraform.tfstate.terragucci-unwritten"), JSON.stringify(kept, null, 2) + "\n");
    // The old run's lock, still held for the state it kept.
    writeFileSync(join(dir, "app/terraform.tfstate.tflock"), JSON.stringify({ ID: "old-lock", Operation: "terragucci compose", Info: "a composed run (waves.compose) holds this state while it plans, applies and writes it" }));

    const c = compositionFor(dir, {
      all: ["network", "app"],
      waves: [["network"], ["app"]],
      env: {},
      binary: () => ({ name: "tofu" }),
      deps: new Map(),
    });
    expect(c.fallback).toBeUndefined();

    const calls: { args: string[]; dir: string; pushed?: unknown }[] = [];
    const exec = async (_bin: string, args: string[], at: string) => {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", out: stdout });
      const call: { args: string[]; dir: string; pushed?: unknown } = { args, dir: at };
      calls.push(call);
      if (args[0] === "state" && args[1] === "push") {
        call.pushed = JSON.parse(readFileSync(args[args.length - 1]!, "utf-8"));
        return ok("");
      }
      if (args[0] === "state" && args[1] === "pull") return ok(at.endsWith("app") ? JSON.stringify(kept) : "");
      if (args[0] === "plan") {
        writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), "plan");
        return ok("No changes. Your infrastructure matches the configuration.");
      }
      if (args[0] === "show" && args.includes("-json")) return ok(JSON.stringify({ format_version: "1.2", resource_changes: [] }));
      return ok("");
    };

    const run = new ComposedRun({ repo: dir, composition: c, binary: { path: "tofu", name: "tofu" }, env: {}, work: tmp(), lock: true, hooks: { log: () => {} }, exec });
    const planned = await run.plan();
    await run.release();
    expect(planned.error).toBeUndefined();

    // The kept state went to app's backend before anything planned, as it was kept.
    const push = calls.findIndex((x) => x.args[0] === "state" && x.args[1] === "push");
    const plan = calls.findIndex((x) => x.args[0] === "plan");
    expect(push).toBeGreaterThanOrEqual(0);
    expect(push).toBeLessThan(plan);
    expect(calls[push]!.dir).toBe(join(dir, "app"));
    expect(calls[push]!.pushed).toEqual(kept);
    // The old name is removed and never written again; the composed root is chant's.
    expect(existsSync(join(dir, "app/terraform.tfstate.terragucci-unwritten"))).toBe(false);
    expect(existsSync(join(dir, "app/terraform.tfstate.chant-unwritten"))).toBe(false);
    expect(calls.filter((x) => x.args[0] === "plan").every((x) => x.dir === join(dir, COMPOSE_DIR))).toBe(true);
    expect(COMPOSE_DIR).toBe(".chant-compose");
    // Every lock is let go once the run is released.
    expect(existsSync(join(dir, "app/terraform.tfstate.tflock"))).toBe(false);
  });
});
