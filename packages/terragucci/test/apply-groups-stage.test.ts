// stage tf-apply --groups (#948): the wave's job plans every root and decides under one gate, and each group's
// job applies its own roots alone, under that one approval.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, decidedPath } from "../src/apply";
import { git, tmp } from "./helpers";
import { T, FAKE } from "./apply-helpers";

describe("a wave split by identity", () => {
  afterEach(() => vi.restoreAllMocks());

  const roots = ["a", "b", "c"];
  const create = (v: string) => JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: v }, after_unknown: {} } }] });

  function setup(): { work: string; bin: string; log: string; plans: string } {
    const dir = tmp("tg-groups-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    for (const r of roots) mkdirSync(join(work, r), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    for (const r of roots) writeFileSync(join(plans, `${r}.json`), create(r));
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    return { work, bin, log: join(dir, "apply.log"), plans };
  }
  const applied = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").map((l) => l.replace("applied ", "")).sort() : []);
  const groups = { prod: ["a"], dev: ["b"] };
  const opts = (bin: string, extra: Record<string, unknown> = {}) => ({ wave: 1, layers: [roots], binary: bin, gate: "never" as const, env: {}, groups, ...extra });

  it("the wave's job decides and applies nothing; each group's job applies its own roots, and default the rest", async () => {
    const { work, bin, log } = setup();
    expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(0);
    expect(applied(log)).toEqual([]);
    const decision = JSON.parse(readFileSync(join(work, decidedPath(1)), "utf-8"));
    expect(decision.members.map((m: { member: string }) => m.member)).toEqual(roots);
    expect(await applyWave(work, { ...opts(bin), group: "dev", now: T(2) })).toBe(0);
    expect(applied(log)).toEqual(["b"]);
    expect(await applyWave(work, { ...opts(bin), group: "prod", now: T(3) })).toBe(0);
    expect(applied(log)).toEqual(["a", "b"]);
    expect(await applyWave(work, { ...opts(bin), group: "default", now: T(4) })).toBe(0);
    expect(applied(log)).toEqual(["a", "b", "c"]);
  });

  it("a group whose plans moved since its wave decided applies nothing and exits 4", async () => {
    const { work, bin, log, plans } = setup();
    expect(await applyWave(work, { ...opts(bin), now: T(1) })).toBe(0);
    writeFileSync(join(plans, "a.json"), create("moved"));
    const outcome = join(work, "..", "outcome");
    expect(await applyWave(work, { ...opts(bin, { env: { TG_OUTCOME: outcome } }), group: "prod", now: T(2) })).toBe(4);
    expect(applied(log)).toEqual([]);
    expect(readFileSync(outcome, "utf-8")).toBe("wave 1 group prod changed since the wave decided: a");
  });

  it("a group with no root in the wave applies nothing, and --group needs --groups", async () => {
    const { work, bin, log } = setup();
    expect(await applyWave(work, { ...opts(bin, { groups: { ...groups, stage: ["s/**"] } }), group: "stage" })).toBe(0);
    expect(applied(log)).toEqual([]);
    await expect(applyWave(work, { ...opts(bin, { groups: undefined }), group: "prod" })).rejects.toThrow("--group names one of --groups");
  });
});
