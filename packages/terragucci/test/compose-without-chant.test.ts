// chant's composed run (`/compose`, `/compose/run`, `/compose/root`, `/compose/estate`, `/compose/slice`), which
// `waves.compose` runs on, and its lock code (`/state`), which migrate takes its locks with when the installed chant
// has it (src/chant-next.ts). A lock case either makes the lock code missing, stands a module in for it, or runs only
// when the installed chant has it.
import { describe, expect, it } from "vitest";
import { compositionFor, specWavesWithRun } from "../src/compose";
import { MIGRATE_SOURCE_LOCK, takeLocks } from "../src/migrate";
import type { StateObject } from "../src/backend";
import { tmp, write } from "./helpers";

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


describe("migrate's locks on chant's lock code", () => {
  it("takes the source's lock with chant's code", async () => {
    const taken: string[] = [];
    const held = await takeLocks(new Map([["app", source(taken)]]) as unknown as Files, "2026-10-26T00:00:00Z");
    expect(taken).toEqual([`${MIGRATE_SOURCE_LOCK.operation}: ${MIGRATE_SOURCE_LOCK.info}`]);
    for (const h of held) await h.release();
  });
});
