/**
 * `agent.comment` on chant's agent job (chant#4616, #4619, terragucci#1282
 * part i). When the installed chant has the job (`CI_AGENT_FLOOR`, loaded by
 * init through ./chant-next.ts `chantAgentJob`), the comment agent's jobs are
 * chant's: `productPipelineJobs(..., { agent })` gives the agent's Op spec,
 * which is written to `.chant/ops/terragucci-agent.spec.json`, and the forge
 * lexicon's Op generator writes its workflow in terragucci's words. Its
 * commands run as `npx --no-install terragucci agent prepare|run|land`,
 * which terragucci hands to chant (./cli.ts).
 *
 *   GitHub, Forgejo  .github/workflows/terragucci-agent.yml (or .forgejo/),
 *                    on issue_comment, beside the pipeline
 *   GitLab           .gitlab/terragucci-agent.yml, which the pipeline's file
 *                    includes. The comments schedule's job starts it on the
 *                    default branch with CHANT_AGENT_PR and CHANT_AGENT_ASK
 *                    (`terragucci comment --agent chant`).
 *
 * The keys map onto chant's: `key_secret` is keyEnv, `max_turns` maxTurns,
 * `timeout` timeout, `agent.token_env` tokenEnv. `max_cost_usd` is chant's
 * maxCostUsd, the most a day's runs may cost, and the default command still
 * passes Claude Code `--max-budget-usd` with the same figure, so one run is
 * held to it as before. A command of the repo's own gets no budget flag.
 *
 * Without the job, terragucci's own agent and agent-push jobs
 * (./render-agent.ts) are rendered as before.
 */
import { AGENT_COMMAND, CLAUDE_CODE_VERSION, type AgentCommentInput } from "./agent-comment";
import { chantAgentJobNow, type ChantAgentJob, type ChantScheduledOpSpec } from "./chant-next";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { CONFIG_NAMES, type ForgeName } from "./config";

/** The agent's Op name: its workflow, its jobs, and its runs on the ledger. */
export const CHANT_AGENT_OP = "terragucci-agent";

/** Where the agent's Op spec is written, for `chant run --generate <forge> --spec`. */
export const CHANT_AGENT_SPEC_FILE = ".chant/ops/terragucci-agent.spec.json";

/** The agent's workflow file per forge. */
export const CHANT_AGENT_PATHS: Record<ForgeName, string> = {
  github: ".github/workflows/terragucci-agent.yml",
  forgejo: ".forgejo/workflows/terragucci-agent.yml",
  gitlab: ".gitlab/terragucci-agent.yml",
};

/** GitLab's variables for the agent's pipeline (the pair chant's GitLab agent rule reads). */
export const CHANT_AGENT_PR_VAR = "CHANT_AGENT_PR";
export const CHANT_AGENT_ASK_VAR = "CHANT_AGENT_ASK";

/** The stage the GitLab agent jobs share: the comments job's, which terragucci's stages list already. */
const COMMENTS_STAGE = "comments";

/**
 * The default command on chant's job: terragucci's (./agent-comment.ts
 * AGENT_COMMAND), with chant's turn variable, and the money limit as a
 * literal `--max-budget-usd`, since chant hands the model's step the key and
 * the turn limit alone.
 */
export function chantAgentCommand(maxCostUsd?: number): string {
  return [
    `npx -y @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} -p`,
    "--output-format json",
    '--max-turns "$CHANT_AGENT_MAX_TURNS"',
    ...(maxCostUsd !== undefined ? [`--max-budget-usd ${String(maxCostUsd)}`] : []),
    "--permission-prompts none",
    "--setting-sources user",
    "--strict-mcp-config",
    "--no-session-persistence",
    '--tools "Read,Edit,Write,Glob,Grep,Bash"',
    '--allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(terragucci config check)" "Bash(terragucci init --dry-run)"',
    '--disallowedTools "WebFetch" "WebSearch" "mcp__*" "Edit(.git/**)" "Write(.git/**)"',
  ].join(" ");
}

/** Paths the agent may not change beside chant's own: terragucci's config, its components file and the policy directory. */
export function chantAgentGuarded(policyDir: string): string[] {
  return [...CONFIG_NAMES, "terragucci.components.json", `${policyDir.replace(/^\.\//, "").replace(/\/+$/, "")}/`];
}

/** chant's agent settings from `agent.comment` (chant `ProductAgentOptions`). terragucci's default command becomes {@link chantAgentCommand}. */
export function chantAgentOptions(agent: AgentCommentInput): Record<string, unknown> {
  return {
    name: CHANT_AGENT_OP,
    command: agent.command === AGENT_COMMAND ? chantAgentCommand(agent.maxCostUsd) : agent.command,
    keyEnv: agent.keySecret,
    timeout: agent.timeout,
    maxTurns: agent.maxTurns,
    ...(agent.maxCostUsd !== undefined ? { maxCostUsd: agent.maxCostUsd } : {}),
    tokenEnv: agent.tokenSecret,
    guarded: chantAgentGuarded(agent.policyDir),
  };
}

/** terragucci's words with the commands this spec has jobs for: the plan, which every pipeline has, and the agent. */
function agentWords(): object {
  const commands = Object.fromEntries(Object.entries(TERRAGUCCI_WORDS.commands).filter(([, c]) => c === "plan" || c === "agent"));
  return { ...TERRAGUCCI_WORDS, commands };
}

/** What {@link chantAgentFiles} writes: the spec, the agent's workflow, and the comment it answers. */
export interface ChantAgentFiles {
  comment: string;
  files: { path: string; content: string }[];
}

/**
 * The agent's files on chant's job, or undefined when the installed chant
 * has none. `image` is the pipeline's, which carries terragucci; `marker` is
 * the first line every file terragucci writes starts with.
 */
export function chantAgentFiles(forge: ForgeName, image: string, agent: AgentCommentInput, marker: string, chant: ChantAgentJob | undefined = chantAgentJobNow()): ChantAgentFiles | undefined {
  if (!chant) return undefined;
  const words = agentWords();
  const jobs = chant.productPipelineJobs(forge, "default", { words, agent: chantAgentOptions(agent) });
  if (!jobs.agent) return undefined;
  const spec: ChantScheduledOpSpec = jobs.agent.spec;
  const options = { image, ...(forge === "gitlab" ? { opsStage: COMMENTS_STAGE, opsFileName: "terragucci-agent.yml" } : {}) };
  const specText = JSON.stringify({ ops: [spec], options }, null, 2) + "\n";
  // The generator reads the active words for the bin and the product's name; put back what was active after.
  const was = chant.setActiveProductWords(words);
  let generated: { name: string; yaml: string }[];
  try {
    generated = chant.generate[forge]([spec], options).files;
  } finally {
    chant.setActiveProductWords(was as object | undefined);
  }
  const yaml = generated[0]?.yaml;
  if (!yaml) return undefined;
  const header = `${marker} The agent's jobs are chant's (chant#4616), from ${CHANT_AGENT_SPEC_FILE}: edit terragucci.yml's agent.comment and run terragucci init.\n`;
  return {
    comment: jobs.agent.comment,
    files: [
      { path: CHANT_AGENT_SPEC_FILE, content: specText },
      { path: CHANT_AGENT_PATHS[forge], content: header + yaml },
    ],
  };
}
