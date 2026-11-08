// chant's composed run (`/compose`, `/compose/run`, `/compose/root`, `/compose/estate`, `/compose/slice`), which
// `waves.compose` runs on, and its lock code (`/state`), which migrate takes its locks with when the installed chant
// has it (src/chant-next.ts). A lock case either makes the lock code missing, stands a module in for it, or runs only
// when the installed chant has it.
import { afterEach, describe, expect, it } from "vitest";
import { chantNextParts, overrideChantNext } from "../src/chant-next";
import { compositionFor, specWavesWithRun } from "../src/compose";
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

describe("waves.compose on chant's composed run", () => {
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
