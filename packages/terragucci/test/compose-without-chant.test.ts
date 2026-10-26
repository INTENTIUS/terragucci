// chant's composed run (`/compose`, `/compose/run`, `/compose/root`, `/compose/estate`, `/compose/slice`) and its lock
// code (`/state`) are in no published chant yet: chant 0.124.52 has none of them (terragucci#1278). terragucci loads
// them on first use (src/chant-next.ts). Without them `waves.compose` applies in waves with the `off` kind and migrate
// takes its locks with its own loop; with them, chant's run and chant's lock code do the work. Each case below either
// makes a part missing, stands a module in for it, or runs only when the installed chant has it.
import { afterEach, describe, expect, it } from "vitest";
import { chantNextParts, overrideChantNext, type ChantComposition } from "../src/chant-next";
import { ComposedRun, compositionFor, compositionLine, NO_CHANT_COMPOSE, NO_CHANT_RUN, reportCompose, specWavesWithRun, wavesWithRun, type Composition } from "../src/compose";
import { MIGRATE_LOCK, MIGRATE_SOURCE_LOCK, takeLocks, takeLocksHere } from "../src/migrate";
import type { StateObject, StateStore } from "../src/backend";
import { ConfigError } from "../src/config";
import { tmp, write } from "./helpers";

const parts = await chantNextParts();

const tree = (): string =>
  write(tmp(), {
    "network/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "net" {}\noutput "id" {\n  value = terraform_data.net.id\n}\n`,
    "app/main.tf": `terraform {\n  backend "local" {}\n}\ndata "terraform_remote_state" "net" {\n  backend = "local"\n  config = {\n    path = "../network/terraform.tfstate"\n  }\n}\nresource "terraform_data" "web" {\n  input = data.terraform_remote_state.net.outputs.id\n}\n`,
    "edge/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "edge" {}\n`,
  });

const input = {
  all: ["app", "edge", "network"],
  selected: new Set(["app"]),
  waves: [["network", "edge"], ["app"]],
  env: {} as NodeJS.ProcessEnv,
  binary: () => ({ name: "tofu" }),
  deps: new Map([["app", new Set(["network"])]]),
};

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});
const without = (...names: Parameters<typeof overrideChantNext>[0][]) => {
  for (const n of names) restore.push(overrideChantNext(n, null));
};

describe("waves.compose on a chant with no composed run", () => {
  it("applies in waves with the off kind, naming the roots the run would have covered", async () => {
    without("compose", "composeRun");
    const c = await compositionFor(tree(), input);
    expect(c.fallback).toEqual({ kind: "off", reason: NO_CHANT_COMPOSE });
    expect(c.wave).toBeUndefined();
    expect(c.chant).toBeUndefined();
    // app and the root it reads; edge is not reached.
    expect(c.roots).toEqual(["app", "network"]);
    expect(c.ownWave).toEqual(new Map([["network", 1], ["app", 2]]));
    expect(reportCompose(c)).toEqual({ roots: ["app", "network"], max: 10, fallback: { kind: "off", reason: NO_CHANT_COMPOSE } });
    expect(compositionLine(c)).toBe(`compose: ${NO_CHANT_COMPOSE}, so the change applies in waves`);
  });

  it("leaves the waves as they are, in the run view and in chant's spec", async () => {
    without("compose", "composeRun");
    const c = await compositionFor(tree(), input);
    expect(wavesWithRun(input.waves, c, true)).toEqual(input.waves);
    expect(wavesWithRun(input.waves, c, false)).toEqual(input.waves);
    expect(specWavesWithRun(input.waves, c)).toEqual(input.waves);
  });

  it("says why a run cannot plan when chant's run is missing, and applies nothing", async () => {
    without("composeRun");
    // A composition as chant's would make it, so only the missing run stops it.
    const chant: ChantComposition = { candidates: ["app", "network"], members: ["app", "network"], order: ["network", "app"], max: 10, roots: new Map(), dirs: new Map(), modules: new Map([["network", "network"], ["app", "app"]]), reads: new Map(), fallbacks: [] };
    const c: Composition = { roots: ["app", "network"], order: ["network", "app"], max: 10, wave: 1, modules: chant.modules, reads: new Map(), ownWave: new Map(), chant, terraform: { roots: {} } as unknown as NonNullable<Composition["terraform"]> };
    const run = new ComposedRun({ repo: tmp(), composition: c, binary: { path: "tofu", name: "tofu" }, env: {}, work: tmp(), lock: true, hooks: { log: () => {} } });
    const planned = await run.plan();
    expect(planned.error).toBe(NO_CHANT_RUN);
    expect(planned.digest).toBe("");
    const applied = await run.apply();
    expect(applied.ok).toBe(false);
    await run.release();
  });
});

describe.runIf(parts.compose && parts.composeRun)("waves.compose on a chant with its composed run", () => {
  // Two plain roots that read nothing of each other compose (as in compose-legacy-unwritten.test.ts).
  const plain = { all: ["app", "network"], waves: [["network"], ["app"]], env: {} as NodeJS.ProcessEnv, binary: () => ({ name: "tofu" }), deps: new Map<string, Set<string>>() };
  const twoRoots = (): string =>
    write(tmp(), {
      "network/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "net" {}\n`,
      "app/main.tf": `terraform {\n  backend "local" {}\n}\nresource "terraform_data" "web" {}\n`,
    });

  it("composes the change into one run in the earliest wave its roots are in", async () => {
    const c = await compositionFor(twoRoots(), plain);
    expect(c.fallback).toBeUndefined();
    expect(c.chant).toBeDefined();
    expect(c.roots).toEqual(["app", "network"]);
    expect(c.wave).toBe(1);
    expect(specWavesWithRun(plain.waves, c)).toEqual([["compose:wave-1"], ["compose:wave-1"]]);
  });

  it("falls back with the off kind for the same change only once chant's composition is taken away", async () => {
    const dir = twoRoots();
    expect((await compositionFor(dir, plain)).fallback).toBeUndefined();
    without("compose");
    const c = await compositionFor(dir, plain);
    expect(c.fallback).toEqual({ kind: "off", reason: NO_CHANT_COMPOSE });
    expect(c.roots).toEqual(["app", "network"]);
  });
});

// ── migrate's locks ─────────────────────────────────────────────────────────

const local: StateObject = { backend: "local", path: "terraform.tfstate" };

/** A workspace a state moves from, with its own lock. */
const source = (taken: string[], held = false) => ({
  object: local,
  source: {
    external: {
      backend: "remote",
      location: "app.terraform.io/acme/app",
      read: async () => null,
      lock: async (reason: string) => {
        if (held) throw new Error("the workspace is locked by another run");
        taken.push(reason);
        return async () => {
          taken.push("released");
        };
      },
    },
  },
});

type Files = Parameters<typeof takeLocks>[0];

/** A store whose lock is free or held, recording what it was asked. */
const store = (location: string, log: string[], held = false) =>
  ({
    backend: "s3",
    location: `s3://acme/${location}`,
    lockLocation: `s3://acme/${location}.tflock`,
    lock: async (info: string) => {
      log.push(`lock ${location} ${JSON.parse(info).Operation}`);
      return !held;
    },
    heldLock: async () => (held ? { id: "other", info: "tofu apply by ci" } : undefined),
    unlock: async () => {
      log.push(`unlock ${location}`);
    },
  }) as unknown as StateStore;

describe("migrate's locks on a chant with no lock code", () => {
  it("takes the source's lock through its own API, with the reason chant's code gives", async () => {
    without("state");
    const taken: string[] = [];
    const held = await takeLocks(new Map([["app", source(taken)]]) as unknown as Files, "2026-10-26T00:00:00Z");
    expect(taken).toEqual([`${MIGRATE_SOURCE_LOCK.operation}: ${MIGRATE_SOURCE_LOCK.info}`]);
    expect(held.map((h) => h.root)).toEqual(["app"]);
    for (const h of held) await h.release();
    expect(taken.at(-1)).toBe("released");
  });

  it("refuses with the root when a source is locked", async () => {
    without("state");
    await expect(takeLocks(new Map([["app", source([], true)]]) as unknown as Files, "2026-10-26T00:00:00Z")).rejects.toThrow(new ConfigError("app: the workspace is locked by another run"));
  });

  it("takes each store's lock as a migration, and lets go of what it took when one is held", async () => {
    const log: string[] = [];
    const stores = [
      { root: "network", object: local, store: store("network", log) },
      { root: "app", object: local, store: store("app", log, true) },
    ];
    await expect(takeLocksHere([], stores, "2026-10-26T00:00:00Z")).rejects.toThrow(/^app: its state is locked \(s3:\/\/acme\/app\.tflock: tofu apply by ci\), so nothing was written$/);
    expect(log).toEqual([`lock network ${MIGRATE_LOCK.operation}`, `lock app ${MIGRATE_LOCK.operation}`, "unlock network"]);
  });

  it("holds every lock it took, each released on its own", async () => {
    const log: string[] = [];
    const held = await takeLocksHere([], [{ root: "network", object: local, store: store("network", log) }], "2026-10-26T00:00:00Z");
    expect(held.map((h) => [h.root, h.object])).toEqual([["network", local]]);
    await held[0]!.release();
    expect(log).toEqual([`lock network ${MIGRATE_LOCK.operation}`, "unlock network"]);
  });
});

describe("migrate's locks on a chant with its lock code", () => {
  it("hands chant's takeLocksWithSources the sources and the migration's operations", async () => {
    let got: { op?: unknown; sourceOp?: unknown; sources?: unknown[] } = {};
    class Locked extends Error {}
    restore.push(
      overrideChantNext("state", {
        takeLocksWithSources: async (i: { op: unknown; sourceOp: unknown; sources: unknown[] }) => {
          got = i;
          return { sources: [], locks: [] };
        },
        SourceLockedError: Locked,
        StateLockedError: Locked,
      }),
    );
    await takeLocks(new Map([["app", source([])]]) as unknown as Files, "2026-10-26T00:00:00Z");
    expect(got.op).toEqual(MIGRATE_LOCK);
    expect(got.sourceOp).toEqual(MIGRATE_SOURCE_LOCK);
    expect(got.sources).toHaveLength(1);
  });

  it.runIf(parts.state)("takes the same source lock with the installed chant's code", async () => {
    const taken: string[] = [];
    const held = await takeLocks(new Map([["app", source(taken)]]) as unknown as Files, "2026-10-26T00:00:00Z");
    expect(taken).toEqual([`${MIGRATE_SOURCE_LOCK.operation}: ${MIGRATE_SOURCE_LOCK.info}`]);
    for (const h of held) await h.release();
  });
});
