/**
 * `agent.alert`, `agent.apply-failed` and `agent.schedule` on chant's agent
 * jobs (terragucci#1495; chant#5329 and #5357). Each is a workflow of its own
 * from an Op spec chant builds (`productAlertAgent`, `productApplyFailedAgent`,
 * `productScheduleAgent`), written beside the agent comment's:
 *
 *   .chant/ops/terragucci-alert-agent.spec.json         the spec
 *   .github/workflows/terragucci-alert-agent.yml        chant's agent and push
 *   (or .forgejo/workflows/)                            jobs, which the relay
 *                                                       starts after it records
 *                                                       an alert, and which run
 *                                                       on a schedule too
 *   .chant/ops/terragucci-apply-failed-agent.spec.json  the same for failed
 *   .github/workflows/terragucci-apply-failed-agent.yml applies, which the wave
 *                                                       jobs record as facts
 *   .chant/ops/terragucci-schedule-agent.spec.json      a task on a cron
 *   .github/workflows/terragucci-schedule-agent.yml
 *
 * terragucci maps its keys onto chant's: `key_secret` is keyEnv, `max_turns`
 * maxTurns, `max_cost_usd` maxCostUsd, `timeout` timeout, `agent.token_env`
 * tokenEnv, `window` window and `relay_key_secret` relayKeyEnv. The default
 * command is the comment agent's. Chant reads each agent's settings from the
 * default branch and refuses a job whose settings differ from the digest on
 * its command line, so a pull request cannot raise a limit.
 *
 * `agent.apply-failed` also turns on the wave jobs' facts: the waves pipeline
 * takes `agentFacts` (see ./render-waves.ts), and a failed wave records one
 * fact per member that did not apply. The failed-apply triage comment is
 * unchanged. Nothing here applies, approves or merges.
 */
import { type AgentScheduleInput, type AgentTriggerInput } from "./agent-comment";
import { CHANT_AGENT_JOB, type ChantAgentJob, type ChantScheduledOpSpec } from "./chant-next";
import type { ForgeName } from "./config";
import { agentWords, chantAgentOptions } from "./render-chant-agent";

/** What starts an agent besides a comment and a drift check. */
export type ChantFactsKind = "alert" | "apply-failed" | "schedule";

/** The Op name of each agent: its workflow, its jobs and its runs on the ledger. Chant's default for the product. */
export const CHANT_FACTS_OPS: Record<ChantFactsKind, string> = {
  alert: "terragucci-alert-agent",
  "apply-failed": "terragucci-apply-failed-agent",
  schedule: "terragucci-schedule-agent",
};

/** Where each agent's Op spec is written, for `chant run --generate <forge> --spec`. */
export const chantFactsSpecFile = (kind: ChantFactsKind): string => `.chant/ops/${CHANT_FACTS_OPS[kind]}.spec.json`;

/** Each agent's workflow file. GitLab has none: the agents run on GitHub and Forgejo. */
export const chantFactsPath = (kind: ChantFactsKind, forge: Exclude<ForgeName, "gitlab">): string => `${forge === "github" ? ".github" : ".forgejo"}/workflows/${CHANT_FACTS_OPS[kind]}.yml`;

/** The secret the waves' failed-apply facts are signed with when `relay_key_secret` is not set (chant's default). */
export const RELAY_KEY_SECRET = "CHANT_RELAY_KEY";

/** chant's settings for one of these agents (chant `ProductAgentOptions`). */
export function chantFactsOptions(kind: ChantFactsKind, input: AgentTriggerInput | AgentScheduleInput): Record<string, unknown> {
  const { name: _comment, ...base } = chantAgentOptions(input);
  return {
    ...base,
    name: CHANT_FACTS_OPS[kind],
    ...(input.window !== undefined ? { window: input.window } : {}),
    ...(kind !== "schedule" && input.relayKeySecret !== undefined ? { relayKeyEnv: input.relayKeySecret } : {}),
    ...(kind === "schedule" ? { schedule: (input as AgentScheduleInput).cron, task: (input as AgentScheduleInput).task } : {}),
  };
}

/** The secret the failed-apply facts are signed with: `agent.apply-failed.relay_key_secret`, else chant's default. */
export const applyFailedRelayKey = (input: AgentTriggerInput): string => input.relayKeySecret ?? RELAY_KEY_SECRET;

/** The files of one agent: its spec and its workflow. */
export interface ChantFactsFiles {
  files: { path: string; content: string }[];
}

/**
 * The files of one agent on chant's agent job, or undefined when the installed chant has no such agent. `image` is the
 * pipeline's, which carries terragucci; `marker` is the first line every file terragucci writes starts with.
 */
export function chantFactsFiles(kind: ChantFactsKind, forge: Exclude<ForgeName, "gitlab">, image: string, input: AgentTriggerInput | AgentScheduleInput, marker: string, chant: ChantAgentJob = CHANT_AGENT_JOB): ChantFactsFiles | undefined {
  const words = agentWords();
  const options = chantFactsOptions(kind, input);
  const make = kind === "alert" ? chant.productAlertAgent : kind === "apply-failed" ? chant.productApplyFailedAgent : chant.productScheduleAgent;
  if (!make) return undefined;
  const spec: ChantScheduledOpSpec = make.call(chant, words, options);
  const specOptions = { image };
  // The generator reads the active words for the bin and the product's name; put back what was active after.
  const was = chant.setActiveProductWords(words);
  let yaml: string | undefined;
  try {
    yaml = chant.generate[forge]([spec], specOptions).files[0]?.yaml;
  } finally {
    chant.setActiveProductWords(was as object | undefined);
  }
  if (!yaml) return undefined;
  const key = `agent.${kind}`;
  const header = `${marker} The ${kind} agent's jobs are chant's (terragucci#1495), from ${chantFactsSpecFile(kind)}: edit terragucci.yml's ${key} and run terragucci init.\n`;
  return {
    files: [
      { path: chantFactsSpecFile(kind), content: JSON.stringify({ ops: [spec], options: specOptions }, null, 2) + "\n" },
      { path: chantFactsPath(kind, forge), content: header + yaml },
    ],
  };
}
