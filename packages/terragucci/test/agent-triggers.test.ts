// terragucci#1495: agent.alert, agent.apply-failed and agent.schedule on chant's agent jobs (chant#5329, #5357).
import { parseYAML } from "@intentius/chant/yaml";
import { describe, expect, it } from "vitest";
import { agentTriggerInput } from "../src/agent-comment";
import { ConfigError, validateConfig } from "../src/config";
import { chantFactsFiles, chantFactsOptions, chantFactsPath, chantFactsSpecFile } from "../src/render-chant-agent-triggers";
import { MARKER, renderPipeline } from "../src/render";

const base = { via: "forge", token_env: "AGENT_FORGE_TOKEN" };
const settings = (agent: Record<string, unknown>) => validateConfig({ agent: { ...base, ...agent } }, "t");
const problems = (agent: Record<string, unknown>): string[] => {
  try {
    settings(agent);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems ?? [e.message];
    throw e;
  }
};

const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["a"]], env: {} };

describe("agent.alert, agent.apply-failed and agent.schedule settings", () => {
  it("take the comment's run shape, the join window and the relay key", () => {
    const s = settings({ alert: { max_turns: 8, max_cost_usd: 5, window: 30, relay_key_secret: "OPS_RELAY" }, "apply-failed": true, schedule: { cron: "0 7 * * 1", task: "Raise the provider pins.", timeout: 10 } });
    expect(agentTriggerInput(s, "alert")).toMatchObject({ maxTurns: 8, maxCostUsd: 5, window: 30, relayKeySecret: "OPS_RELAY", tokenSecret: "AGENT_FORGE_TOKEN" });
    expect(agentTriggerInput(s, "apply-failed")).toMatchObject({ maxTurns: 30, timeout: 30 });
    expect(agentTriggerInput(s, "schedule")).toMatchObject({ cron: "0 7 * * 1", task: "Raise the provider pins.", timeout: 10 });
    expect(chantFactsOptions("alert", agentTriggerInput(s, "alert")!)).toMatchObject({ name: "terragucci-alert-agent", maxCostUsd: 5, window: 30, relayKeyEnv: "OPS_RELAY", keyEnv: "ANTHROPIC_API_KEY" });
  });

  it("are off by default", () => {
    const s = settings({});
    for (const k of ["alert", "apply-failed", "schedule"] as const) expect(agentTriggerInput(s, k as never)).toBeUndefined();
    expect(agentTriggerInput(settings({ alert: false }), "alert")).toBeUndefined();
  });

  it("refuse a bad key, window, relay key and schedule", () => {
    expect(problems({ alert: { nope: 1 } })[0]).toContain("config.agent.alert.nope is not a setting");
    expect(problems({ alert: { window: 0 } })).toContain("config.agent.alert.window must be a whole number of minutes from 1 to 1440");
    expect(problems({ "apply-failed": { relay_key_secret: "ANTHROPIC_API_KEY" } })[0]).toContain("must not be the model's key");
    expect(problems({ schedule: true })[0]).toContain("must be a map with cron and task");
    expect(problems({ schedule: { cron: "daily", task: "x" } })[0]).toContain("five-field cron");
    expect(problems({ schedule: { cron: "0 7 * * 1" } })[0]).toContain("task must say what");
    expect(problems({ schedule: { cron: "0 7 * * 1", task: "x", relay_key_secret: "K" } })[0]).toContain("relay_key_secret is not a setting");
  });
});

describe("the agents' workflows on chant's agent jobs", () => {
  const alert = agentTriggerInput(settings({ alert: { max_cost_usd: 5, window: 20 } }), "alert")!;
  it("write a spec and a workflow for each, with the trigger on the spec", () => {
    const out = chantFactsFiles("alert", "github", "img:1", alert, MARKER)!;
    expect(out.files.map((f) => f.path)).toEqual([chantFactsSpecFile("alert"), chantFactsPath("alert", "github")]);
    const spec = JSON.parse(out.files[0]!.content).ops[0];
    expect(spec.agent).toMatchObject({ on: "alert", maxCostUsd: 5, window: 20 });
    expect(out.files[1]!.content.startsWith(MARKER)).toBe(true);
    expect(out.files[1]!.content).toContain("workflow_dispatch");
    expect(out.files[1]!.content).toContain("terragucci agent prepare");
    expect(chantFactsPath("alert", "forgejo")).toBe(".forgejo/workflows/terragucci-alert-agent.yml");
  });

  it("render with the pipeline, and only when set", () => {
    const s = settings({ alert: true, "apply-failed": true, schedule: { cron: "0 7 * * 1", task: "Check pins." } });
    const on = renderPipeline({ ...input, forge: "github", agentAlert: agentTriggerInput(s, "alert"), agentApplyFailed: agentTriggerInput(s, "apply-failed"), agentSchedule: agentTriggerInput(s, "schedule") });
    const paths = on.extra!.map((f) => f.path);
    for (const k of ["alert", "apply-failed", "schedule"] as const) expect(paths).toContain(chantFactsPath(k, "github"));
    const sched = on.extra!.find((f) => f.path === chantFactsPath("schedule", "github"))!.content;
    expect(sched).toContain("0 7 * * 1");
    const off = renderPipeline({ ...input, forge: "github" });
    expect((off.extra ?? []).map((f) => f.path).filter((p) => p.includes("agent"))).toEqual([]);
    expect(off.content).not.toContain("CHANT_AGENT_FACTS");
  });

  it("turn on the wave jobs' facts for agent.apply-failed with the relay key secret", () => {
    const on = renderPipeline({ ...input, forge: "github", agentApplyFailed: agentTriggerInput(settings({ "apply-failed": { relay_key_secret: "OPS_RELAY" } }), "apply-failed") });
    expect(on.content).toContain("CHANT_AGENT_FACTS: apply-failed");
    expect(on.content).toContain("secrets.OPS_RELAY");
    expect(renderPipeline({ ...input, forge: "github", agentApplyFailed: agentTriggerInput(settings({ "apply-failed": true }), "apply-failed") }).content).toContain("secrets.CHANT_RELAY_KEY");
  });

  it("records a failed apply's facts on the gate and record jobs of the split waves of apply.when: pull-request, and on neither the plan nor the apply job", () => {
    expect(() => validateConfig({ apply: { when: "pull-request" }, agent: { ...base, "apply-failed": { relay_key_secret: "OPS_RELAY" } } }, "t")).not.toThrow();
    const on = renderPipeline({ ...input, forge: "github", applyWhen: "pull-request", agentApplyFailed: agentTriggerInput(settings({ "apply-failed": { relay_key_secret: "OPS_RELAY" } }), "apply-failed") } as never);
    const jobs = (parseYAML(on.content) as { jobs: Record<string, unknown> }).jobs;
    const holds = (name: string): boolean => JSON.stringify(jobs[name]).includes("CHANT_AGENT_FACTS");
    for (const name of ["apply-wave-1-plan", "apply-wave-1-gate", "apply-wave-1", "apply-wave-1-record"]) expect(jobs[name], name).toBeDefined();
    expect(holds("apply-wave-1-gate")).toBe(true);
    expect(holds("apply-wave-1-record")).toBe(true);
    expect(JSON.stringify(jobs["apply-wave-1-record"])).toContain("secrets.OPS_RELAY");
    expect(holds("apply-wave-1-plan")).toBe(false);
    expect(holds("apply-wave-1")).toBe(false);
    const off = renderPipeline({ ...input, forge: "github", applyWhen: "pull-request" } as never);
    expect(off.content).not.toContain("CHANT_AGENT_FACTS");
  });

  it("keep the failed-apply triage comment", () => {
    const on = renderPipeline({ ...input, forge: "github", respond: { "apply-failed": "triage" } as never, agentApplyFailed: agentTriggerInput(settings({ "apply-failed": true }), "apply-failed") });
    expect(on.content).toContain("apply-failed");
  });

  it("are refused on GitLab", () => {
    expect(() => renderPipeline({ ...input, forge: "gitlab", agentAlert: alert })).toThrow("agent.alert runs on GitHub and Forgejo");
  });
});
