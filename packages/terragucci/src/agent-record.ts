/**
 * The record of one agent run: who, which model, a digest of the prompt, what
 * it cost and the commit it made. `agent.comment` and `agent.drift` write one
 * when their push job finishes, whatever the outcome.
 *
 * It goes two places. Always, one line in `_gates/agent-runs.jsonl` on
 * chant/lifecycle, which the audit trail reads as an `agent-run` entry. And,
 * when the job's environment names an OTLP traces endpoint (the variables in
 * ./telemetry.ts), one span to the customer's collector, which a Langfuse
 * instance can be. A record that cannot be written is logged and never fails
 * the push.
 *
 * The model, the tokens and the cost are the agent job's own report
 * (`usage.json` or the output of Claude Code's `--output-format json`). That
 * job runs the model, so those fields are as trustworthy as it is. The actor
 * is not: it is the forge user the push token acts as, which the push job
 * asks the forge for.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../package.json";
import { send, telemetryFromEnv, Trace, tracesBody, type OtlpFetch } from "./telemetry";
import type { Actor } from "./actor";
import { AGENT_RUNS_FILE } from "./report/audit";
import type { Fetch } from "./forge";
import { apiBase, tokenUser } from "./involved";

export { AGENT_RUNS_FILE };
export const AGENT_FEATURES = ["agent.comment", "agent.drift"] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];

/** The files the agent job leaves beside `rc` and `change.patch`. */
export const AGENT_OUTPUT_FILE = "agent-output.json";
export const AGENT_PROMPT_DIGEST_FILE = "prompt.sha256";
/** An agent command may write its own usage here instead (`$TG_AGENT_USAGE`): `{model, cost_usd, input_tokens, output_tokens}`. */
export const AGENT_USAGE_FILE = "usage.json";

export interface AgentCost {
  usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** One line of `_gates/agent-runs.jsonl`. */
export interface AgentRunRecord {
  version: 1;
  kind: "agent-run";
  feature: AgentFeature;
  /** The agent's forge identity. `kind` is `agent`: the run is the agent's, whoever asked for it. */
  actor: Actor;
  /** Who asked, when a person did: the commenter, or whoever started the drift run. */
  requestedBy?: string;
  model?: string;
  /** `sha256:` over the prompt the agent read. */
  promptDigest?: string;
  cost?: AgentCost;
  /** The commit the run made, when it made one. */
  commit?: string;
  /** The pull request or merge request, or the pull request the drift agent opened. */
  pullRequest?: string;
  /** `pushed`, `opened`, or why not: `refused` (a guard stopped the change) or `failed`. */
  result: "pushed" | "opened" | "refused" | "failed";
  reason: string;
  runUrl?: string;
  timestamp: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function readSmall(file: string): string | undefined {
  try {
    if (!existsSync(file) || statSync(file).size > 8 << 20) return undefined;
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** The model, tokens and cost an agent job reported: its `usage.json`, else Claude Code's JSON result. */
export function readAgentUsage(dir: string): { model?: string; cost?: AgentCost } {
  const parse = (text: string | undefined): any => {
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  };
  const own = parse(readSmall(join(dir, AGENT_USAGE_FILE)));
  // Claude Code prints one JSON object (`total_cost_usd`, `usage`, `modelUsage` keyed by model); a log line before it is skipped.
  const out = readSmall(join(dir, AGENT_OUTPUT_FILE));
  const claude = parse(out) ?? parse(out?.slice(Math.max(0, out.lastIndexOf("\n{"))));
  const model = typeof own?.model === "string" ? own.model : claude?.modelUsage && typeof claude.modelUsage === "object" ? Object.keys(claude.modelUsage)[0] : undefined;
  const usd = num(own?.cost_usd) ?? num(claude?.total_cost_usd);
  const input = num(own?.input_tokens) ?? num(claude?.usage?.input_tokens);
  const output = num(own?.output_tokens) ?? num(claude?.usage?.output_tokens);
  const cost: AgentCost = { ...(usd !== undefined ? { usd } : {}), ...(input !== undefined ? { input_tokens: input } : {}), ...(output !== undefined ? { output_tokens: output } : {}) };
  return { ...(model ? { model } : {}), ...(Object.keys(cost).length ? { cost } : {}) };
}

/** `sha256:<hex>` of the prompt, from the agent job's `prompt.sha256`; undefined when it left none or the file is not a digest. */
export function readPromptDigest(dir: string): string | undefined {
  const hex = readSmall(join(dir, AGENT_PROMPT_DIGEST_FILE))?.trim();
  return hex && /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : undefined;
}

export const digestOf = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export interface RecordAgentRunInput {
  feature: AgentFeature;
  /** The agent job's artifact directory: `rc`, `change.patch`, `agent-output.json`, `prompt.sha256`. */
  change: string;
  /** The forge user the push token acts as, when the forge said. */
  principal?: string;
  requestedBy?: string;
  result: AgentRunRecord["result"];
  reason: string;
  commit?: string;
  pullRequest?: string;
  env: NodeJS.ProcessEnv;
}

/** The record for one run. */
export function agentRunRecord(o: RecordAgentRunInput, timestamp = new Date().toISOString()): AgentRunRecord {
  const usage = readAgentUsage(o.change);
  const promptDigest = readPromptDigest(o.change);
  const principal = o.principal ?? "unknown";
  const runUrl = o.env.GITHUB_RUN_ID && o.env.GITHUB_REPOSITORY ? `${(o.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "")}/${o.env.GITHUB_REPOSITORY}/actions/runs/${o.env.GITHUB_RUN_ID}` : o.env.CI_JOB_URL;
  return {
    version: 1,
    kind: "agent-run",
    feature: o.feature,
    actor: { kind: "agent", principal, signals: { ...(o.principal ? { forgeIdentity: o.principal } : {}) } },
    ...(o.requestedBy ? { requestedBy: o.requestedBy } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(promptDigest ? { promptDigest } : {}),
    ...(usage.cost ? { cost: usage.cost } : {}),
    ...(o.commit ? { commit: o.commit } : {}),
    ...(o.pullRequest ? { pullRequest: o.pullRequest } : {}),
    result: o.result,
    reason: o.reason.slice(0, 300),
    ...(runUrl ? { runUrl } : {}),
    timestamp,
  };
}

/** The span a record becomes. Attribute names follow OpenTelemetry's `gen_ai.*` where one exists, which Langfuse reads. */
export function agentRunSpan(trace: Trace, r: AgentRunRecord): void {
  const span = trace.start(`terragucci.${r.feature}`, undefined, {
    "terragucci.agent.feature": r.feature,
    "terragucci.agent.actor": r.actor.principal,
    "terragucci.agent.actor_kind": r.actor.kind,
    "terragucci.agent.result": r.result,
    "terragucci.agent.prompt_digest": r.promptDigest,
    "terragucci.agent.commit": r.commit,
    "terragucci.agent.pull_request": r.pullRequest,
    "terragucci.agent.requested_by": r.requestedBy,
    "terragucci.agent.cost_usd": r.cost?.usd,
    "gen_ai.request.model": r.model,
    "gen_ai.usage.input_tokens": r.cost?.input_tokens,
    "gen_ai.usage.output_tokens": r.cost?.output_tokens,
  });
  trace.end(span, {}, r.result === "failed" ? r.reason : undefined);
}

/** Send a record's span to the collector the environment names. Returns the problem, undefined when sent or when none is configured. */
export async function sendAgentRun(r: AgentRunRecord, env: NodeJS.ProcessEnv, fetchFn?: OtlpFetch): Promise<string | undefined> {
  const t = telemetryFromEnv(env);
  if (!t?.traces) return undefined;
  const trace = new Trace(env.TRACEPARENT);
  agentRunSpan(trace, r);
  return send(t.traces, tracesBody(trace.spans, t.resource, VERSION), fetchFn);
}

export interface RecordDeps {
  /** Append the line to chant/lifecycle (appendLifecycle). */
  append?: (line: string, message: string) => void;
  fetch?: OtlpFetch;
  log?: (line: string) => void;
}

/** Write a run's record to the ledger and, when configured, send its span. Never throws. */
export async function recordAgentRun(repo: string, o: RecordAgentRunInput, deps: RecordDeps = {}): Promise<AgentRunRecord> {
  const record = agentRunRecord(o);
  const log = deps.log ?? ((l: string) => console.log(l));
  try {
    const append = deps.append ?? (async (line: string, message: string): Promise<void> => (await import("./apply")).appendLifecycle(repo, AGENT_RUNS_FILE, [line], {}, message));
    await append(JSON.stringify(record), `Agent run ${record.feature}: ${record.result}`);
    log(`terragucci: recorded the ${record.feature} run in ${AGENT_RUNS_FILE} on chant/lifecycle`);
  } catch (e) {
    log(`terragucci: could not record the agent run (${(e as Error).message})`);
  }
  const problem = await sendAgentRun(record, o.env, deps.fetch);
  if (problem) log(`terragucci: could not send the agent run's span (${problem})`);
  return record;
}

/**
 * Record the outcome of an agent-push job (`pushAgentChange`,
 * `pushGitLabAgentChange`, `pushDriftChange`): the forge user the push token
 * acts as is the actor.
 */
export async function recordPushOutcome(o: { feature: AgentFeature; cwd: string; change: string; forge: "github" | "forgejo" | "gitlab"; env: NodeJS.ProcessEnv; ok: boolean; fail?: boolean; reason: string; commit?: string; pullRequest?: string }, deps: RecordDeps & { fetchForge?: Fetch } = {}): Promise<AgentRunRecord> {
  const user = await tokenUser({ which: "the agent's token", forge: o.forge, api: apiBase(o.forge, o.env), token: o.env.TG_TOKEN, ...(deps.fetchForge ? { fetch: deps.fetchForge } : {}) });
  return recordAgentRun(
    o.cwd,
    {
      feature: o.feature,
      change: o.change,
      ...(user.login ? { principal: user.login } : {}),
      result: o.ok ? (o.feature === "agent.drift" ? "opened" : "pushed") : o.fail ? "failed" : "refused",
      reason: o.reason,
      ...(o.commit ? { commit: o.commit } : {}),
      ...(o.pullRequest ? { pullRequest: o.pullRequest } : {}),
      env: o.env,
    },
    deps,
  );
}
