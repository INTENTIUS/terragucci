/**
 * The scheduled drift job as a chant drift Op (terragucci#1305, chant
 * issues 4616, 4622 and 4753). On every forge, init writes:
 *
 *   .chant/ops/terragucci-drift.sh         the drift step's script (render.ts
 *                                          `driftScript`, after the install
 *                                          lines), so the drift report, the
 *                                          drift issue, respond.drift and
 *                                          notify keep their fields
 *   .chant/ops/terragucci-drift.spec.json  one scheduled Op on drift's cron,
 *                                          running that script, keeping the
 *                                          drift report (and respond.drift:
 *                                          agent's input) as artifacts, with a
 *                                          Terragrunt repo's cache as a setup
 *                                          step, and with agent.drift chant's
 *                                          drift agent (`productDriftAgent`)
 *   .github/workflows/terragucci-drift.yml chant's Op generator's workflow
 *                                          (or .forgejo/workflows/, or
 *                                          .gitlab/terragucci-drift.yml, which
 *                                          .gitlab-ci.yml includes): the drift
 *                                          job, and with agent.drift the agent
 *                                          and push jobs, which run when the
 *                                          drift job's `drift` output is
 *                                          true, and terragucci's
 *                                          drift-found job
 *   ops/terragucci-drift.op.ts             a TerraformWatchOp per root of a
 *                                          plain repo, so `chant run
 *                                          terragucci-drift-<root>` reads one
 *                                          root by hand
 *
 * The Op runs every root in one job, as before, since the repo keeps one
 * drift issue. With agent.drift, when the run opened the drift issue, the
 * script writes `drift=true` to its step's outputs itself and exits 0, and
 * the drift-found job after it exits with chant's `drift` code (2), so the
 * run stays red on drift (terragucci#1528). Forgejo's runner publishes a
 * job's outputs only when the job succeeds, so a drift job that exited 2
 * handed the agent jobs no `drift` output and no drift, and they were
 * skipped. Without agent.drift the run stays green on drift as
 * terragucci's own job did. The drift agent's runs go on the ledger under
 * op `terragucci-drift`.
 *
 * On GitLab the Op's job carries the drift stage's id_tokens, a Terragrunt
 * repo's cache and terragucci's schedule rule (`gitlab` on the spec, chant
 * issue 4753), so no project adds a variable to its drift schedule. On
 * Forgejo with oidc chant's job sets enable-openid-connect itself.
 */
import type { AgentCommentInput } from "./agent-comment";
import { CHANT_AGENT_JOB, type ChantAgentJob, type ChantScheduledOpSpec } from "./chant-next";
import { TERRAGUCCI_WORDS } from "./ci-words";
import type { ForgeName } from "./config";
import { chantAgentOptions } from "./render-chant-agent";

/** The drift Op's name: its workflow, its jobs, and its agent's runs on the ledger. */
export const CHANT_DRIFT_OP = "terragucci-drift";
export const CHANT_DRIFT_SPEC_FILE = ".chant/ops/terragucci-drift.spec.json";
export const CHANT_DRIFT_SCRIPT_FILE = ".chant/ops/terragucci-drift.sh";
export const CHANT_DRIFT_OP_FILE = "ops/terragucci-drift.op.ts";
export const CHANT_DRIFT_PATHS: Record<ForgeName, string> = {
  github: ".github/workflows/terragucci-drift.yml",
  forgejo: ".forgejo/workflows/terragucci-drift.yml",
  gitlab: ".gitlab/terragucci-drift.yml",
};

/** The stage the drift Op's GitLab job runs in, which terragucci's own stages list keeps. */
export const CHANT_DRIFT_GITLAB_STAGE = "drift";

/** chant's `drift` exit code (chant#4553), which starts the drift agent's jobs. */
export const CHANT_DRIFT_EXIT = 2;

/** The script's lines on chant's Op that mark drift: rc becomes `drift` when this run opened the drift issue (DRIFT_ISSUE_JS's `agent=1`). */
export function chantDriftExitLines(issueJs: string, issueFile: string): string[] {
  return [`if [ "$rc" -eq 0 ] && node -e '${issueJs}' ${issueFile} | grep -qx 'agent=1'; then rc=${CHANT_DRIFT_EXIT}; fi`];
}

/**
 * The script's lines before its exit on chant's Op (terragucci#1528): on
 * `drift`, `drift=true` goes to the step's outputs, which chant's job maps
 * to its `drift` output, and the script exits 0, so the job succeeds and
 * Forgejo publishes its outputs. The drift-found job carries the red run.
 */
export function chantDriftHandOnLines(): string[] {
  return [`if [ "$rc" -eq ${CHANT_DRIFT_EXIT} ]; then echo "drift=true" >>"\${GITHUB_OUTPUT:-/dev/null}"; rc=0; fi`];
}

/** The job after the drift job that fails the run when the drift job found drift (terragucci#1528). */
export const CHANT_DRIFT_FOUND_JOB = `${CHANT_DRIFT_OP}-found`;

/**
 * The drift-found job, appended to chant's workflow: it needs the drift
 * job, runs when its `drift` output is true, on the drift job's runner,
 * and exits with chant's `drift` code, so a run that found drift is red
 * while the agent jobs run beside it. Undefined when the workflow's shape
 * is not the one it appends to: `jobs:` as the last top-level key, with
 * the drift job's `runs-on:` in it.
 */
export function chantDriftFoundJob(yaml: string): string | undefined {
  const lines = yaml.replace(/\n+$/, "").split("\n");
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt < 0 || lines.slice(jobsAt + 1).some((l) => /^\S/.test(l))) return undefined;
  const start = lines.indexOf(`  ${CHANT_DRIFT_OP}:`, jobsAt);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]!)) end++;
  const job = lines.slice(start + 1, end);
  const at = job.findIndex((l) => /^ {4}runs-on:/.test(l));
  if (at < 0) return undefined;
  let stop = at + 1;
  while (stop < job.length && /^ {5,}\S/.test(job[stop]!)) stop++;
  const runsOn = job.slice(at, stop);
  return [
    `  ${CHANT_DRIFT_FOUND_JOB}:`,
    `    needs: ${CHANT_DRIFT_OP}`,
    `    if: needs.${CHANT_DRIFT_OP}.outputs.drift == 'true'`,
    ...runsOn,
    "    steps:",
    "      - name: Fail the run on drift",
    "        run: |-",
    `          echo "terragucci: the drift run found drift; the drift issue lists it, and the drift agent's jobs answer it"`,
    `          exit ${CHANT_DRIFT_EXIT}`,
  ].join("\n");
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
  forge: ForgeName;
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
  /** `agent.drift`'s settings, when it is set. */
  agent?: AgentCommentInput;
  /** What the job keeps after its run: the drift report, and respond.drift: agent's input (chant issue 4622). */
  artifacts: { name: string; paths: string[] }[];
  /** Steps before the script, such as a Terragrunt repo's cache. */
  setup?: Record<string, unknown>[];
  /** The roots of a plain repo, for the TerraformWatchOp file; absent for another shape. */
  roots?: readonly string[];
  marker: string;
  runner?: unknown;
  /** GitLab: the drift stage's id_tokens, a Terragrunt repo's cache, and the rule that picks drift's schedule (chant issue 4753). */
  gitlab?: { idTokens?: Record<string, unknown>; cache?: unknown; scheduleRule: string };
}

/** The drift Op's files, or undefined when the installed chant has no Op generator. */
export function chantDriftFiles(i: ChantDriftInput, chant: ChantAgentJob = CHANT_AGENT_JOB): { path: string; content: string }[] | undefined {
  let agent: object | undefined;
  if (i.agent) {
    const { name: _name, ...settings } = chantAgentOptions(i.agent);
    agent = chant.productDriftAgent(TERRAGUCCI_WORDS, CHANT_DRIFT_OP, settings);
  }
  const gitlab = i.forge === "gitlab";
  // GitLab has no permissions block: the script keeps the drift issue with the project's token, and the id_tokens are the spec's own.
  const variables = gitlab ? { ...i.workflowEnv, ...i.jobEnv } : i.jobEnv;
  const spec: ChantScheduledOpSpec = {
    name: CHANT_DRIFT_OP,
    trigger: { kind: "cron", schedule: i.schedule },
    // The script keeps the drift issue itself; the mode names the token's scopes.
    findingMode: gitlab ? "report" : i.pullRequest ? "pull-request" : "issue",
    ...(Object.keys(variables).length ? { variables } : {}),
    ...(gitlab ? {} : { permissions: { ...(i.pullRequest ? { issues: "write" as const } : {}), ...(i.oidc ? { "id-token": "write" as const } : {}) } }),
    ...(i.runner !== undefined ? { runner: i.runner } : {}),
    ...(i.setup && i.setup.length ? { setup: i.setup } : {}),
    artifacts: i.artifacts,
    ...(agent ? { agent } : {}),
    ...(gitlab && i.gitlab ? { gitlab: { ...(i.gitlab.idTokens && Object.keys(i.gitlab.idTokens).length ? { idTokens: i.gitlab.idTokens } : {}), ...(i.gitlab.cache !== undefined ? { cache: i.gitlab.cache } : {}), scheduleRule: i.gitlab.scheduleRule } } : {}),
  };
  // On GitLab a file-level variables block would reach every job of the including pipeline, so the job carries them all.
  const options = { image: i.image, runCommand: ["bash", CHANT_DRIFT_SCRIPT_FILE], ...(gitlab ? { opsStage: CHANT_DRIFT_GITLAB_STAGE } : Object.keys(i.workflowEnv).length ? { variables: i.workflowEnv } : {}) };
  const was = chant.setActiveProductWords(TERRAGUCCI_WORDS);
  let yaml: string | undefined;
  try {
    yaml = chant.generate[i.forge]([spec], options).files[0]?.yaml;
  } finally {
    chant.setActiveProductWords(was as object | undefined);
  }
  if (!yaml) return undefined;
  // With the drift agent, the drift job succeeds on drift so its outputs reach the agent jobs, and this job keeps the run red (terragucci#1528).
  if (agent) {
    const found = chantDriftFoundJob(yaml);
    if (!found) throw new Error(`chant's drift workflow has no ${CHANT_DRIFT_OP} job with runs-on under a last jobs key, so terragucci cannot add ${CHANT_DRIFT_FOUND_JOB} after it`);
    yaml = `${yaml.replace(/\n+$/, "")}\n${found}\n`;
  }
  const header = `${i.marker} The drift job is a chant drift Op (terragucci#1305), from ${CHANT_DRIFT_SPEC_FILE}: edit terragucci.yml's drift${i.agent ? " and agent.drift" : ""} and run terragucci init.\n`;
  return [
    { path: CHANT_DRIFT_SCRIPT_FILE, content: `#!/usr/bin/env bash\n${i.marker}\n${i.script}\n` },
    { path: CHANT_DRIFT_SPEC_FILE, content: JSON.stringify({ ops: [spec], options }, null, 2) + "\n" },
    { path: CHANT_DRIFT_PATHS[i.forge], content: header + yaml },
    ...(i.roots && i.roots.length ? [{ path: CHANT_DRIFT_OP_FILE, content: chantDriftOpFile(i.roots, i.marker) }] : []),
  ];
}
