import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave, changesOutputs } from "../src/apply";
import { buildReport } from "../src/report/build";
import { noteMarker } from "../src/report/marker";
import { notePreviews } from "../src/tg-preview";
import { git, tmp, write } from "./helpers";
import { RUN } from "./report-fixtures";
import { T, fakeTerragrunt, setup, approve, ledger, opts, runs } from "./apply-terragrunt-helpers";

describe("changesOutputs", () => {
  it("is true when an output is created, updated or deleted, and false for no-op outputs or none", () => {
    expect(changesOutputs({ output_changes: { bucket: { actions: ["create"] } } })).toBe(true);
    expect(changesOutputs({ output_changes: { bucket: { actions: ["no-op"] } } })).toBe(false);
    expect(changesOutputs({})).toBe(false);
  });
});

describe("a Terragrunt wave behind its gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cuts a wave per dependency layer: each waits for an approval of its own set digest at its own gate and applies its saved plans", async () => {
    const { work, origin } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();

    // Wave 1 is live/a alone: live/b reads it, so it is the next layer and is not planned yet.
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(1) })).toBe(3);
    expect(tg.applied.size).toBe(0);
    expect(runs(tg)).toEqual(["plan live/a"]);
    expect(out.mock.calls.flat().join("\n")).toContain("wave 1 of 2: planning live/a");
    expect(ledger(origin).pending.map((p) => [p.gate, p.members!.map((m) => m.member)])).toEqual([["wave-1", ["live/a"]]]);

    // Approved, live/a applies from its saved plan.
    approve(origin, "wave-1", ledger(origin).pending[0].planDigest!, T(2));
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(3) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a"]);

    // Wave 2 plans live/b against what wave 1 applied and waits at its own gate.
    expect(await applyWave(work, { ...opts(tg), wave: 2, now: T(4) })).toBe(3);
    const pend = ledger(origin).pending;
    expect(pend.map((p) => [p.gate, p.members!.map((m) => m.member)])).toEqual([["wave-1", ["live/a"]], ["wave-2", ["live/b"]]]);
    approve(origin, "wave-2", pend[1].planDigest!, T(5));
    expect(await applyWave(work, { ...opts(tg), wave: 2, now: T(6) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a", "live/b"]);
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.waves[0]).toMatchObject({ number: 2, roots: ["live/b"], approval: "approved" });

    // Every apply ran saved plans: no -auto-approve, and the out dir the plan wrote.
    const applies = tg.calls.filter((c) => c[c.indexOf("--") + 1] === "apply");
    expect(applies).toHaveLength(2);
    for (const c of applies) {
      expect(c).not.toContain("-auto-approve");
      expect(c).toContain("--out-dir");
      expect(c.slice(c.indexOf("--") + 1)).toEqual(["apply", "-lock-timeout=5m"]);
    }
  });

  it("refuses the wave when the plans moved after their approval, and applies nothing", async () => {
    const { work, origin } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(1) })).toBe(3);
    approve(origin, "wave-1", "jcs1-sha256:" + "0".repeat(64), T(2));
    expect(await applyWave(work, { ...opts(tg), wave: 1, now: T(3) })).toBe(4);
    expect(tg.applied.size).toBe(0);
  });

  it("with --rest, runs every wave from its own in order, and stops at the first that waits", async () => {
    const { work } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const never = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(never, "never"), wave: 1, rest: true, now: T(1) })).toBe(0);
    expect(runs(never)).toEqual(["plan live/a", "apply live/a", "plan live/b", "apply live/b"]);

    const { work: work2, origin } = setup();
    const always = fakeTerragrunt();
    expect(await applyWave(work2, { ...opts(always), wave: 1, rest: true, now: T(1) })).toBe(3);
    expect(runs(always)).toEqual(["plan live/a"]);
    expect(ledger(origin).pending.map((p) => p.gate)).toEqual(["wave-1"]);
  });

  it("splits a pipeline wave by the edges terragrunt find gives: a pipeline that lists one wave still applies live/a before live/b", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg, "never"), layers: [["live/a", "live/b"]], wave: 1, rest: true, now: T(1) })).toBe(0);
    expect(runs(tg)).toEqual(["plan live/a", "apply live/a", "plan live/b", "apply live/b"]);
    expect(out.mock.calls.flat().join("\n")).toContain("Terragrunt's edges cut the pipeline's 1 wave into 2");
  });

  it("refuses a pipeline that applies a unit before what it reads, and applies nothing", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg, "never"), layers: [["live/b"], ["live/a"]], wave: 1, rest: true, now: T(1) })).toBe(1);
    expect(tg.calls).toHaveLength(0);
    expect(out.mock.calls.flat().join("\n")).toContain("live/b reads live/a, which the pipeline applies in a later wave; run terragucci init");
  });

  it("a wave past the last one has nothing to apply", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg), wave: 3, now: T(1) })).toBe(0);
    expect(tg.calls).toHaveLength(0);
    expect(out.mock.calls.flat().join("\n")).toContain("wave 3: this repo has 2 waves, so there is nothing to apply");
  });

  it("at its gate, a wave says how each unit's plan differs from the merged pull request's preview, before the approve command, and its report keeps it", async () => {
    const { work } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    expect(await applyWave(work, { ...opts(tg, "never"), wave: 1, now: T(1) })).toBe(0);
    // The pull request previewed live/b with another input than it plans now.
    const was = buildReport({ run: RUN, roots: [{ path: "live/b", plan: { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "live/b-old" }, after_unknown: {} } }] }, planner: "tofu" }] }).roots[0]!;
    const head = "c".repeat(40);
    const sha = "d".repeat(40);
    const note = noteMarker({ head, waves: [{ number: 2, digest: null, waits: true }], previews: notePreviews([{ ...was, terragrunt: { stack: "live", selection: "", provisional: true, run_result: "succeeded" }, reads: [{ upstream: "live/a", data: "a", outputs: "planned" }] }]) });
    const fetch = (async (url: string) => {
      const body = url.endsWith(`/commits/${sha}/pull`) ? { number: 9, head: { sha: head } } : url.includes("/issues/9/comments") ? [{ body: note }] : null;
      return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body, text: async () => "" };
    }) as never;
    const env = { GITHUB_REPOSITORY: "acme/live", GITHUB_SERVER_URL: "https://forgejo.example", TG_TOKEN: "t", TG_SHA: sha, FORGEJO_ACTIONS: "true" };
    expect(await applyWave(work, { ...opts(tg), env, fetch, wave: 2, now: T(2) })).toBe(3);
    const said = out.mock.calls.flat().join("\n");
    const diff = "wave 2 of 2:   live/b: terraform_data.x (create): input differs from the preview";
    expect(said).toContain("wave 2 of 2: pull request 9 previewed live/b on the planned outputs of the waves before; this unit plans differently now:");
    expect(said).toContain(diff);
    expect(said.indexOf(diff)).toBeLessThan(said.indexOf("terragucci approve wave-2"));
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.waves[0].preview).toEqual({ pull_request: 9, units: [{ unit: "live/b", differences: ["terraform_data.x (create): input differs from the preview"] }] });
    expect(readFileSync(join(work, "terragucci-report", "note.md"), "utf-8")).toContain("**Wave 2 plans differently from the preview in pull request 9 (1 of 1):**");
  });

  it("with apply.branches, a branch applies the units its globs match, in their own waves behind the gate, and the default branch leaves them alone", async () => {
    const { work, origin } = setup();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = fakeTerragrunt();
    const branches = { release: ["live/b"] };
    // The default branch applies live/a alone; live/b is release's, and no line says the pipeline does not list it.
    expect(await applyWave(work, { ...opts(tg, "never"), branches, wave: 1, rest: true, now: T(1) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a"]);
    expect(runs(tg)).toEqual(["plan live/a", "apply live/a"]);
    const said = out.mock.calls.flat().join("\n");
    expect(said).toContain("apply.branches: live/b applies from release, not here");
    expect(said).not.toContain("the pipeline does not list");
    // On release, live/b is the one wave: it plans against what live/a applied and waits at its gate.
    tg.calls.length = 0;
    expect(await applyWave(work, { ...opts(tg), branches, branch: "release", wave: 1, rest: true, now: T(2) })).toBe(3);
    expect(runs(tg)).toEqual(["plan live/b"]);
    expect(ledger(origin).pending.map((p) => [p.gate, p.members!.map((m) => m.member)])).toEqual([["wave-1", ["live/b"]]]);
    approve(origin, "wave-1", ledger(origin).pending[0].planDigest!, T(3));
    expect(await applyWave(work, { ...opts(tg), branches, branch: "release", wave: 1, rest: true, now: T(4) })).toBe(0);
    expect([...tg.applied]).toEqual(["live/a", "live/b"]);
    // A branch whose globs match no unit applies nothing.
    tg.calls.length = 0;
    expect(await applyWave(work, { ...opts(tg), branches: { release: ["live/b"], hotfix: ["live/z/*"] }, branch: "hotfix", wave: 1, now: T(5) })).toBe(0);
    expect(tg.calls).toEqual([]);
    expect(out.mock.calls.flat().join("\n")).toContain("no unit applies from hotfix, so there is nothing to apply");
  });

  it("lets Terragrunt bootstrap the backend (TG_BACKEND_BOOTSTRAP) when generate gives a unit disable_init: false, and only then", async () => {
    const seen = async (config: string | undefined): Promise<(string | undefined)[]> => {
      const { work } = setup();
      if (config !== undefined) {
        write(work, { "terragucci.yml": config });
        git(work, "add", "-A");
        git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config");
      }
      vi.spyOn(console, "log").mockImplementation(() => {});
      const tg = fakeTerragrunt();
      const envs: (string | undefined)[] = [];
      const exec: TerragruntExec = (file, args, options) => {
        if (args[0] === "run") envs.push(options.env.TG_BACKEND_BOOTSTRAP);
        return tg.exec(file, args, options);
      };
      expect(await applyWave(work, { ...opts({ ...tg, exec }, "never"), wave: 1, now: T(1) })).toBe(0);
      return envs;
    };
    const backend = 'generate:\n  backend:\n    s3: { bucket: state, key: "{root}.tfstate", region: us-east-1 }\n';
    // The wave's plan and its apply both bootstrap.
    expect(await seen(`${backend}  disable_init: false\n`)).toEqual(["true", "true"]);
    expect(await seen(backend)).toEqual([undefined, undefined]);
    expect(await seen(undefined)).toEqual([undefined, undefined]);
  });

  it("--rest needs --terragrunt", async () => {
    await expect(applyWave(tmp(), { wave: 1, layers: [["a"]], binary: "tofu", gate: "never", rest: true })).rejects.toThrow(/needs --terragrunt/);
  });
});
