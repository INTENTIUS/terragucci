/**
 * A tf-apply wave gate reached on forge CI is never resolved over MCP
 * (chant#3447, #3485): terragucci's pending record says `neverOverMcp`, and
 * chant's `op-approve` tool refuses it and records nothing.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, parseLedger, runOf } from "../src/apply";
import { STEP_FAKE as FAKE } from "./apply-helpers";
import { git, tmp } from "./helpers";

// No Op is discovered: tf-apply is a terragucci stage, not a chant Op, so the rule can only come from the record.
vi.mock("@intentius/chant/op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { createOpApproveTool } = await import("@intentius/chant/cli/mcp/op-tools");


describe("a tf-apply wave gate reached on forge CI", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("carries neverOverMcp, and op-approve over MCP refuses it and records nothing", async () => {
    const dir = tmp("tg-mcp-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(join(work, "a"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    writeFileSync(join(plans, "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] }));
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    // The wave job on forge CI reaches the gate and records the pending fact. chant's step reads the run from the process's own environment.
    const ci = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42" };
    for (const [k, v] of Object.entries(ci)) vi.stubEnv(k, v);
    expect(await applyWave(work, { wave: 1, layers: [["a"]], binary: bin, gate: "always", env: ci })).toBe(3);
    const ledger = () => git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl");
    const before = ledger();
    const [pending] = parseLedger(before).pending;
    // chant records the run that waits, so an approval can start it again, and the channel it was recorded from: the job's command line.
    expect(pending).toMatchObject({ op: "tf-apply", gate: "wave-1", resume: { forge: "github", run: "42" }, origin: "cli", neverOverMcp: true });
    expect(runOf(pending)).toBe("42");

    // An agent with the repo checked out asks chant's MCP server to approve it.
    const checkout = join(dir, "agent");
    git(dir, "clone", "-q", origin, checkout);
    git(checkout, "branch", "chant/lifecycle", "origin/chant/lifecycle");
    process.chdir(checkout);
    await expect(createOpApproveTool().handler({ name: "tf-apply", gate: "wave-1" })).rejects.toThrow(/neverOverMcp.*whichever channel/s);

    expect(git(checkout, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).toBe(before);
    expect(ledger()).toBe(before);
  });
});
