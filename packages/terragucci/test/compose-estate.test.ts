// waves.compose over choudoufu estates (choudoufu#2059): the composed root is module calls only, no state is
// pulled, locked, split or written back, and the report says the run is composed as estates.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPOSE_DIR, ComposedRun, compositionFor, reportCompose, writeEstateRoot, type Composition } from "../src/compose";
import { tmp, write } from "./helpers";

// An estate run takes no lock and pulls no state: these throw if the run reaches for either.
const stateHandling = vi.hoisted(() => ({ pulled: [] as string[], locked: [] as string[] }));
vi.mock("../src/migrate", () => ({
  runBinary: async () => ({ code: 1, stdout: "", stderr: "", out: "" }),
  derivedLineage: () => "lineage",
  pullState: async (_e: unknown, _b: string, root: string) => {
    stateHandling.pulled.push(root);
    throw new Error("an estate run pulls no state");
  },
  takeLocks: async (files: Map<string, unknown>) => {
    stateHandling.locked.push(...files.keys());
    throw new Error("an estate run takes no lock");
  },
}));

const live = (estate: string, body = ""): string => `terraform {
  live {
    estate = "${estate}"
    record_store "s3" {
      bucket = "records"
    }
  }
}
${body}`;

const tree = (): string =>
  write(tmp(), {
    "network/main.tf": live("net", `output "subnet_id" {\n  value = "s-1"\n}\n`),
    "app/main.tf": live("app", `data "terraform_estate_outputs" "net" {\n  estate = "net"\n  names  = ["subnet_id"]\n}\noutput "where" {\n  value = data.terraform_estate_outputs.net.values.subnet_id\n}\n`),
    "edge/main.tf": live("edge", `data "terraform_estate_outputs" "app" {\n  estate = "app"\n  names  = ["x"]\n}\noutput "from" {\n  value = data.terraform_estate_outputs.app.values.x\n}\n`),
  });

const deps = new Map<string, Set<string>>([["app", new Set(["network"])], ["edge", new Set(["app"])]]);
const input = (binary: (r: string) => { name: string; version?: string }) => ({
  all: ["network", "app", "edge"],
  waves: [["network"], ["app"], ["edge"]],
  env: {} as NodeJS.ProcessEnv,
  binary,
  deps,
});

describe("compositionFor on choudoufu estates", () => {
  it("composes roots that all run choudoufu, in read order, as estates", () => {
    const c = compositionFor(tree(), input(() => ({ name: "choudoufu" })));
    expect(c.fallback).toBeUndefined();
    expect(c.estate).toBe(true);
    expect(c.order).toEqual(["network", "app", "edge"]);
    expect(c.wave).toBe(1);
    // A read of another estate in the run is a read of that member: choudoufu resolves it inside the run.
    expect(c.reads.get("app")).toEqual([{ name: "net", upstream: "network" }]);
    expect(c.reads.get("edge")).toEqual([{ name: "app", upstream: "app" }]);
    expect(c.reads.get("network")).toEqual([]);
  });

  it("does not fall back for roots in different apply groups or roles, which each take theirs from their own provider blocks", () => {
    const c = compositionFor(tree(), { ...input(() => ({ name: "choudoufu" })), groupOf: (r) => r });
    expect(c.fallback).toBeUndefined();
    const stock = compositionFor(tree(), { ...input(() => ({ name: "tofu" })), groupOf: (r) => r });
    expect(stock.fallback?.kind).toBe("identity");
  });

  it("still falls back for choudoufu mixed with another binary", () => {
    const c = compositionFor(tree(), input((r) => ({ name: r === "edge" ? "tofu" : "choudoufu" })));
    expect(c.fallback?.kind).toBe("binary");
    expect(c.estate).toBeUndefined();
  });

  it("falls back for a root with no live block", () => {
    const dir = tree();
    write(dir, { "edge/main.tf": `output "x" {\n  value = 1\n}\n` });
    const c = compositionFor(dir, input(() => ({ name: "choudoufu" })));
    expect(c.fallback).toMatchObject({ kind: "backend", root: "edge" });
  });
});

describe("the composed root of an estate run", () => {
  it("holds one module call per estate and nothing else, and changes no estate file", () => {
    const dir = tree();
    const before = Object.fromEntries(["network", "app", "edge"].map((r) => [r, readFileSync(join(dir, r, "main.tf"), "utf-8")]));
    const c = compositionFor(dir, input(() => ({ name: "choudoufu" })));
    const root = writeEstateRoot(dir, c);
    const main = readFileSync(join(dir, COMPOSE_DIR, "main.tf"), "utf-8");
    expect(main.match(/^module "/gm)).toHaveLength(3);
    expect(main).toContain('module "network" {\n  source = "../network"\n}');
    expect(main).toContain('module "edge" {\n  source = "../edge"\n}');
    expect(main).toContain('output "network__subnet_id" {\n  value = module.network.subnet_id\n}');
    expect(main).not.toMatch(/^(resource|data|provider|backend|variable)\b/m);
    expect(root.generated.map(([f]) => f)).toEqual([`${COMPOSE_DIR}/main.tf`]);
    for (const r of Object.keys(before)) expect(readFileSync(join(dir, r, "main.tf"), "utf-8")).toBe(before[r]);
    root.restore();
    expect(existsSync(join(dir, COMPOSE_DIR, "main.tf"))).toBe(false);
  });
});

const change = (address: string, actions: string[]) => ({ address, module_address: address.split(".").slice(0, 2).join("."), change: { actions } });
const plan = {
  format_version: "1.2",
  output_changes: { network__subnet_id: { actions: ["create"], after_unknown: true } },
  resource_changes: [
    change("module.network.aws_subnet.main", ["create"]),
    change("module.app.aws_instance.web", ["create"]),
    change("module.edge.aws_route.r", ["no-op"]),
  ],
};

describe("a composed run of estates", () => {
  it("plans and applies from the composed root with no state handling, and reports each estate", async () => {
    const dir = tree();
    const c = compositionFor(dir, input(() => ({ name: "choudoufu" })));
    const calls: { args: string[]; dir: string }[] = [];
    const exec = async (_bin: string, args: string[], at: string) => {
      calls.push({ args, dir: at });
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", out: stdout });
      if (args[0] === "plan") {
        const out = args.find((a) => a.startsWith("-out="))!.slice(5);
        writeFileSync(out, "plan");
        return ok("Plan: 2 to add, 0 to change, 0 to destroy.");
      }
      if (args[0] === "show" && args.includes("-json") && args.length === 3) return ok(JSON.stringify(plan));
      if (args[0] === "apply") {
        return ok(
          [
            { type: "apply_start", hook: { resource: { addr: "module.network.aws_subnet.main" } } },
            { type: "apply_complete", hook: { resource: { addr: "module.network.aws_subnet.main" } } },
            { type: "apply_start", hook: { resource: { addr: "module.app.aws_instance.web" } } },
            { type: "apply_complete", hook: { resource: { addr: "module.app.aws_instance.web" } } },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n"),
        );
      }
      return ok(args.includes("-json") ? "{}" : "");
    };
    const work = tmp();
    const run = new ComposedRun({ repo: dir, composition: c as Composition, binary: { path: "choudoufu", name: "choudoufu" }, env: {}, work, lock: true, hooks: { log: () => {} }, exec });
    const planned = await run.plan();
    expect(planned.error).toBeUndefined();
    expect(planned.digest).not.toBe("");
    expect(planned.generated.map(([f]) => f)).toEqual([`${COMPOSE_DIR}/main.tf`]);
    expect(planned.slices.size).toBe(3);
    // app reads network's subnet_id, which the plan leaves unknown: the run holds for it as a stock composed run does.
    expect(planned.unknown).toEqual(["app"]);
    expect(planned.reads.get("app")).toEqual([{ upstream: "network", data: "net", outputs: "planned", unknown: ["subnet_id"], composed: true }]);
    const applied = await run.apply();
    await run.release();
    // No state is pulled, pushed or locked, and the plan and apply run in the composed root.
    expect(calls.some((x) => x.args[0] === "state")).toBe(false);
    expect(stateHandling).toEqual({ pulled: [], locked: [] });
    expect(calls.filter((x) => x.args[0] === "plan" || x.args[0] === "apply").every((x) => x.dir === join(dir, COMPOSE_DIR))).toBe(true);
    expect(calls.filter((x) => x.args[0] === "init").map((x) => x.dir)).toEqual([join(dir, "network"), join(dir, "app"), join(dir, "edge"), join(dir, COMPOSE_DIR)]);
    expect(applied.ok).toBe(true);
    expect(applied.members.map((m) => [m.root, m.apply, m.state])).toEqual([
      ["network", "applied", "written"],
      ["app", "applied", "written"],
      ["edge", "no-changes", "unchanged"],
    ]);
    expect(applied.settled).toEqual(["network", "app", "edge"]);
    expect(existsSync(join(dir, COMPOSE_DIR))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["app", "edge", "network"]);
    expect(reportCompose(c as Composition)).toMatchObject({ roots: ["app", "edge", "network"], wave: 1, estate: true });
  });
});
