import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateLedgerLinesFromLog } from "@intentius/chant/lifecycle/gate-audit";
import { describe, expect, it } from "vitest";
import { agentRunRecord, AGENT_RUNS_FILE, digestOf, readAgentUsage, readPromptDigest, recordAgentRun, sendAgentRun } from "../src/agent-record";
import { agentRunScript, gitlabAgentRunScript } from "../src/render-agent";
import { ledgerEntries } from "../src/report/audit";
import { tmp } from "./helpers";

const CLAUDE = JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.42, usage: { input_tokens: 1200, output_tokens: 300 }, modelUsage: { "claude-sonnet-5-5": { costUSD: 0.42 } } });

function change(files: Record<string, string>): string {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  return dir;
}

const base = (dir: string) => ({ feature: "agent.comment" as const, change: dir, principal: "my-agent[bot]", result: "pushed" as const, reason: "pushed abc", commit: "abc", env: {} as NodeJS.ProcessEnv });

describe("agent usage", () => {
  it("reads Claude Code's JSON result, with a log line before it", () => {
    expect(readAgentUsage(change({ "agent-output.json": CLAUDE }))).toEqual({ model: "claude-sonnet-5-5", cost: { usd: 0.42, input_tokens: 1200, output_tokens: 300 } });
    expect(readAgentUsage(change({ "agent-output.json": `starting\n${CLAUDE}` })).cost?.usd).toBe(0.42);
  });

  it("prefers the command's own usage.json, and reads nothing from text", () => {
    expect(readAgentUsage(change({ "usage.json": '{"model":"m","cost_usd":1.5}', "agent-output.json": CLAUDE }))).toEqual({ model: "m", cost: { usd: 1.5, input_tokens: 1200, output_tokens: 300 } });
    expect(readAgentUsage(change({ "agent-output.json": "I changed the file." }))).toEqual({});
    expect(readAgentUsage(change({}))).toEqual({});
  });

  it("takes the prompt digest only from a sha-256 hex line", () => {
    expect(readPromptDigest(change({ "prompt.sha256": `${"a".repeat(64)}\n` }))).toBe(`sha256:${"a".repeat(64)}`);
    expect(readPromptDigest(change({ "prompt.sha256": "not a digest" }))).toBeUndefined();
    expect(digestOf("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("the record", () => {
  it("names the actor, model, prompt digest, cost and commit", () => {
    const r = agentRunRecord(base(change({ "agent-output.json": CLAUDE, "prompt.sha256": "b".repeat(64) })), "2026-10-23T10:00:00.000Z");
    expect(r).toMatchObject({
      version: 1,
      kind: "agent-run",
      feature: "agent.comment",
      actor: { kind: "agent", principal: "my-agent[bot]", signals: { forgeIdentity: "my-agent[bot]" } },
      model: "claude-sonnet-5-5",
      promptDigest: `sha256:${"b".repeat(64)}`,
      cost: { usd: 0.42 },
      commit: "abc",
      result: "pushed",
    });
  });

  it("writes one ledger line, and goes on when the ledger cannot be written", async () => {
    const lines: string[] = [];
    await recordAgentRun("/x", base(change({})), { append: (l) => void lines.push(l), log: () => {} });
    expect(JSON.parse(lines[0]).kind).toBe("agent-run");
    const logged: string[] = [];
    const r = await recordAgentRun("/x", base(change({})), { append: () => { throw new Error("no push"); }, log: (l) => void logged.push(l) });
    expect(r.kind).toBe("agent-run");
    expect(logged.join("\n")).toContain("could not record the agent run (no push)");
  });
});

describe("the span", () => {
  const record = agentRunRecord(base(change({ "agent-output.json": CLAUDE })));

  it("is not sent when no collector is configured", async () => {
    let called = false;
    expect(await sendAgentRun(record, {}, async () => { called = true; return { ok: true, status: 200, text: async () => "" }; })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("goes to the traces endpoint with gen_ai attributes", async () => {
    const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://langfuse.example.com/api/public/otel", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc" };
    const problem = await sendAgentRun(record, env, async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "" };
    });
    expect(problem).toBeUndefined();
    expect(sent[0].url).toBe("https://langfuse.example.com/api/public/otel/v1/traces");
    expect(sent[0].headers.Authorization).toBe("Basic abc");
    const span = sent[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("terragucci.agent.comment");
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue]));
    expect(attrs).toMatchObject({ "gen_ai.request.model": "claude-sonnet-5-5", "gen_ai.usage.input_tokens": "1200", "terragucci.agent.cost_usd": 0.42, "terragucci.agent.actor": "my-agent[bot]" });
  });

  it("reports a collector that refuses it, and stays off with OTEL_SDK_DISABLED", async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com" };
    expect(await sendAgentRun(record, env, async () => ({ ok: false, status: 401, text: async () => "no" }))).toContain("answered 401");
    expect(await sendAgentRun(record, { ...env, OTEL_SDK_DISABLED: "true" }, async () => { throw new Error("sent"); })).toBeUndefined();
  });
});

describe("the audit trail", () => {
  it("reads a run as an agent-run entry", () => {
    const record = agentRunRecord(base(change({ "agent-output.json": CLAUDE, "prompt.sha256": "b".repeat(64) })), "2026-10-23T10:00:00.000Z");
    const log = `\x1ec1\x1fci\x1f2026-10-23T10:00:00Z\n\ndiff --git a/${AGENT_RUNS_FILE} b/${AGENT_RUNS_FILE}\n--- /dev/null\n+++ b/${AGENT_RUNS_FILE}\n@@ -0,0 +1 @@\n+${JSON.stringify(record)}\n`;
    const [e] = ledgerEntries("github.com/acme/infra", AGENT_RUNS_FILE, gateLedgerLinesFromLog(log));
    expect(e).toMatchObject({ kind: "agent-run", who: "my-agent[bot]", what: "agent.comment", digest: `sha256:${"b".repeat(64)}`, result: "pushed", detail: { model: "claude-sonnet-5-5", cost: { usd: 0.42 }, commit: "abc", actor: { kind: "agent" } } });
  });
});

describe("the agent job's script", () => {
  it("keeps the output and the prompt digest, takes the agent's exit code, and is valid bash", () => {
    for (const script of [agentRunScript("my-agent"), gitlabAgentRunScript({ command: "my-agent", keySecret: "KEY", policyDir: "policy", tokenSecret: "T", maxTurns: 3, timeout: 5 }, "art")]) {
      expect(script).toContain("agent-output.json");
      expect(script).toContain("prompt.sha256");
      expect(script).toContain("${PIPESTATUS[0]}");
      expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    }
  });
});
