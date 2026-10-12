import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { tmp } from "./helpers";
import { T, fakeTerragrunt, setupWith, runs } from "./apply-terragrunt-helpers";

describe("a Terragrunt wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("waves.jobs", () => {
    const three = [{ path: "live/c", dependencies: [] }, { path: "live/d", dependencies: [] }, { path: "live/e", dependencies: [] }];
    const split = (tg: ReturnType<typeof fakeTerragrunt>, decided: string) => ({ layers: [["live/c", "live/d", "live/e"]], binary: "tofu", gate: "never" as const, env: {}, terragrunt: true, terragruntExec: tg.exec, shares: 2, decided });

    it("the wave's job plans every unit and decides; each share plans its units with --filter and applies the plans decided on", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e"]);
      expect(tg.applied.size).toBe(0);
      // chant's decision, which the pipeline hands the share jobs.
      const d = JSON.parse(readFileSync(decided, "utf-8")) as { wave: number; status: string; members: { member: string }[] };
      expect(d).toMatchObject({ wave: 1, status: "not-required" });
      expect(d.members.map((m) => m.member)).toEqual(["live/c", "live/d", "live/e"]);
      expect(out.mock.calls.flat().join("\n")).toContain("its 2 share jobs apply these plans");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 1, now: T(2) })).toBe(0);
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 2, now: T(3) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e", "plan live/c,live/d", "apply live/c,live/d", "plan live/e", "apply live/e"]);
      expect([...tg.applied].sort()).toEqual(["live/c", "live/d", "live/e"]);
    });

    it("a share whose plans moved since the wave decided applies nothing", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      // chant cuts the units sorted into contiguous shares: share 2 is live/e.
      tg.inputs["live/e"] = "moved";
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 2, now: T(2) })).toBe(4);
      expect(tg.applied.size).toBe(0);
      expect(out.mock.calls.flat().join("\n")).toContain("live/e: its plan moved since wave 1 was decided, so it was not applied");
    });

    it("a wave with nothing to change still hands its shares a decision, and they apply nothing", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt(three);
      for (const u of ["live/c", "live/d", "live/e"]) tg.applied.add(u);
      const decided = join(tmp("tg-decided-"), "wave-1.json");
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, now: T(1) })).toBe(0);
      expect(JSON.parse(readFileSync(decided, "utf-8"))).toMatchObject({ status: "not-required" });
      // The share plans its units again, as chant checks each against the decision, and applies nothing.
      expect(await applyWave(work, { ...split(tg, decided), wave: 1, share: 1, now: T(2) })).toBe(0);
      expect(runs(tg)).toEqual(["plan live/c,live/d,live/e", "plan live/c,live/d"]);
    });
  });

  describe("state versions", () => {
    it("records each applied unit's state version from its evaluated remote_state, and names a unit whose backend cannot be read", async () => {
      const { work } = setupWith({ "terragucci.yml": "gate: never\n" }, ["live/c", "live/d", "live/e"]);
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const three = [{ path: "live/c", dependencies: [] }, { path: "live/d", dependencies: [] }, { path: "live/e", dependencies: [] }];
      const tg = fakeTerragrunt(three, {}, {
        "live/c": { remote_state: { backend: "local", config: { path: "c.tfstate" } }, terraform: { source: "../../modules/x" } },
        "live/d": { remote_state: { backend: "gcs", config: { bucket: "b", prefix: "d" } } },
        "live/e": { remote_state: null, terraform: { source: "../../modules/x" } },
      });
      expect(await applyWave(work, { layers: [["live/c", "live/d", "live/e"]], binary: "tofu", gate: "never", env: {}, terragrunt: true, terragruntExec: tg.exec, wave: 1, now: T(1) })).toBe(0);
      const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
      const state = Object.fromEntries(report.roots.map((r: { path: string; state?: unknown }) => [r.path, r.state]));
      expect(state["live/c"]).toEqual({ backend: "local", location: "c.tfstate", versioning: "off", note: "a local backend keeps only the latest state" });
      expect(state["live/d"]).toMatchObject({ backend: "gcs", versioning: "unknown" });
      expect(state["live/e"]).toMatchObject({ backend: "unknown", versioning: "unknown", note: expect.stringContaining("names no remote_state block") });
      expect(out.mock.calls.flat().join("\n")).toContain("live/c: state c.tfstate, versions off");
    });
  });
});
