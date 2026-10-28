/**
 * The scheduled drift job as a chant drift Op, so `agent.drift` rides chant's
 * agent job (terragucci#1305, chant#4616). With a chant that has the job
 * (./chant-next.ts `chantAgentJob`), on GitHub and Forgejo, init writes:
 *
 *   .chant/ops/terragucci-drift.sh         the drift step's script, the one
 *                                          terragucci's own drift job runs
 *                                          (render.ts `driftScript`), so the
 *                                          drift report, the drift issue,
 *                                          respond.drift and notify keep
 *                                          their fields
 *   .chant/ops/terragucci-drift.spec.json  one scheduled Op on drift's cron,
 *                                          running that script, with chant's
 *                                          drift agent (`productDriftAgent`)
 *   .github/workflows/terragucci-drift.yml chant's Op generator's workflow
 *                                          (or .forgejo/workflows/): the drift
 *                                          job, then the agent job and the
 *                                          push job, which run when the drift
 *                                          job exits with chant's `drift` code
 *   ops/terragucci-drift.op.ts             a TerraformWatchOp per root of a
 *                                          plain repo, so `chant run
 *                                          terragucci-drift-<root>` reads one
 *                                          root by hand
 *
 * The Op runs every root in one job, as before, since the repo keeps one
 * drift issue. The script exits with chant's `drift` code (2) when the run
 * opened the drift issue, which is when terragucci's own drift agent ran.
 * The drift agent's runs go on the ledger under op `terragucci-drift`.
 *
 * Without the job, or where the Op cannot carry what the drift job needs
 * (GitLab, Forgejo with oidc, a Terragrunt repo's cache step, respond.drift
 * agent or attribute), terragucci's own drift job and its drift-agent jobs
 * (./render-agent.ts) are rendered as before.
 */
import type { AgentCommentInput } from "./agent-comment";
import { chantAgentJobNow, type ChantAgentJob, type ChantScheduledOpSpec } from "./chant-next";
import { TERRAGUCCI_WORDS } from "./ci-words";
import type { ForgeName } from "./config";
import { chantAgentOptions } from "./render-chant-agent";

/** The drift Op's name: its workflow, its jobs, and its agent's runs on the ledger. */
export const CHANT_DRIFT_OP = "terragucci-drift";
export const CHANT_DRIFT_SPEC_FILE = ".chant/ops/terragucci-drift.spec.json";
export const CHANT_DRIFT_SCRIPT_FILE = ".chant/ops/terragucci-drift.sh";
export const CHANT_DRIFT_OP_FILE = "ops/terragucci-drift.op.ts";
export const CHANT_DRIFT_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-drift.yml",
  forgejo: ".forgejo/workflows/terragucci-drift.yml",
};

/** chant's `drift` exit code (chant#4553), which starts the drift agent's jobs. */
export const CHANT_DRIFT_EXIT = 2;

/** The script's last lines on chant's Op: exit `drift` when this run opened the drift issue (DRIFT_ISSUE_JS's `agent=1`). */
export function chantDriftExitLines(issueJs: string, issueFile: string): string[] {
  return [`if [ "$rc" -eq 0 ] && node -e '${issueJs}' ${issueFile} | grep -qx 'agent=1'; then rc=${CHANT_DRIFT_EXIT}; fi`];
}

/** One root's Op name: `terragucci-drift-<root>`, the root's path in kebab case. */
export function rootDriftOpName(root: string): string {
  const slug = root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${CHANT_DRIFT_OP}-${slug || "root"}`;
}

/** The TerraformWatchOp file: one Op per root, keyed by the root's `terraform.roots` entry in chant.config.ts. */
export function chantDriftOpFile(roots: readonly string[], marker: string): string {
  const lines = [
    `${marker.replace(/^#/, "//")} From terragucci.yml's drift key; edit that and run terragucci init.`,
    "// One TerraformWatchOp per root, to read one root's drift by hand: chant run terragucci-drift-<root>. The scheduled job runs .chant/ops/terragucci-drift.sh over every root.",
    `import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";`,
    "",
  ];
  const seen = new Set<string>();
  for (const root of [...new Set(roots)].sort()) {
    const name = rootDriftOpName(root);
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`export const ${name.replace(/-/g, "_")} = TerraformWatchOp({ name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)} }).op;`);
  }
  return lines.join("\n") + "\n";
}

export interface ChantDriftInput {
  forge: Exclude<ForgeName, "gitlab">;
  image: string;
  schedule: string;
  /** The drift step's script, exiting `drift` when it opened the issue. */
  script: string;
  /** The drift job's environment: the workflow's and the job's own. */
  workflowEnv: Record<string, string>;
  jobEnv: Record<string, string>;
  /** respond.drift: pull-request opens a pull request from the drift job. */
  pullRequest: boolean;
  oidc: boolean;
  /** `agent.drift`'s settings. */
  agent: AgentCommentInput;
  /** The roots of a plain repo, for the TerraformWatchOp file; absent for another shape. */
  roots?: readonly string[];
  marker: string;
  runner?: unknown;
}

/** The drift Op's files, or undefined when the installed chant has no agent job. */
export function chantDriftFiles(i: ChantDriftInput, chant: ChantAgentJob | undefined = chantAgentJobNow()): { path: string; content: string }[] | undefined {
  if (!chant) return undefined;
  const { name: _name, ...settings } = chantAgentOptions(i.agent);
  const agent = chant.productDriftAgent(TERRAGUCCI_WORDS, CHANT_DRIFT_OP, settings);
  const spec: ChantScheduledOpSpec = {
    name: CHANT_DRIFT_OP,
    trigger: { kind: "cron", schedule: i.schedule },
    // The script keeps the drift issue itself; the mode names the token's scopes.
    findingMode: i.pullRequest ? "pull-request" : "issue",
    ...(Object.keys(i.jobEnv).length ? { variables: i.jobEnv } : {}),
    permissions: { ...(i.pullRequest ? { issues: "write" as const } : {}), ...(i.oidc ? { "id-token": "write" as const } : {}) },
    ...(i.runner !== undefined ? { runner: i.runner } : {}),
    agent,
  };
  const options = { image: i.image, runCommand: ["bash", CHANT_DRIFT_SCRIPT_FILE], ...(Object.keys(i.workflowEnv).length ? { variables: i.workflowEnv } : {}) };
  const was = chant.setActiveProductWords(TERRAGUCCI_WORDS);
  let yaml: string | undefined;
  try {
    yaml = chant.generate[i.forge]([spec], options).files[0]?.yaml;
  } finally {
    chant.setActiveProductWords(was as object | undefined);
  }
  if (!yaml) return undefined;
  const header = `${i.marker} The drift job is a chant drift Op (terragucci#1305), from ${CHANT_DRIFT_SPEC_FILE}: edit terragucci.yml's drift and agent.drift and run terragucci init.\n`;
  return [
    { path: CHANT_DRIFT_SCRIPT_FILE, content: `#!/usr/bin/env bash\n${i.marker}\n${i.script}\n` },
    { path: CHANT_DRIFT_SPEC_FILE, content: JSON.stringify({ ops: [spec], options }, null, 2) + "\n" },
    { path: CHANT_DRIFT_PATHS[i.forge], content: header + yaml },
    ...(i.roots && i.roots.length ? [{ path: CHANT_DRIFT_OP_FILE, content: chantDriftOpFile(i.roots, i.marker) }] : []),
  ];
}
