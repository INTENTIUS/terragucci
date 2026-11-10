// chant's composed run (`/compose`, `/compose/run`, `/compose/root`, `/compose/estate`, `/compose/slice`), which
// `waves.compose` runs on.
import { describe, expect, it } from "vitest";
import { compositionFor, specWavesWithRun } from "../src/compose";
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
