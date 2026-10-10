/**
 * The terragucci command.
 *
 *   terragucci init [--forge f] [--binary b] [--approval ledger|pr-review|sealed] [--signer <principal>] [--force] [--dry-run]
 *   terragucci import atlantis|digger|terrateam [<file>] [--forge f] [--apply-when merge|pull-request] [--force] [--dry-run]
 *   terragucci reconcile --config <file> [--mode dry-run|apply] [--project <key>]
 *   terragucci generate [--check] [--dry-run] [--config <file>]
 *   terragucci estate [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
 *   terragucci audit [--check] [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
 *   terragucci plan [--root <glob>] [--project <key>] [--config <file>]
 *   terragucci publish [--dry-run] [--config <file>]
  terragucci verify-release <module> <version> [--config <file>]
 *   terragucci verify-release <module> <version> [--config <file>]
 *   terragucci stage tf-plan|tf-drift [--root <glob>] [--project <key>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>] [--no-cost]
 *   terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>] [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>] [--shares <n> [--share <s>] [--decided <file>]] [--branches <branch>=<globs>[;...] [--branch <name>]] [--on-held wait|refuse] [--stand-down]
 *   terragucci check-root <dir> [--binary <b>] [--config <file>] [--base <ref>] [--config <file>] [--base <ref>]
 *   terragucci check-policy [--config <file>] [--base <ref>]
 *   terragucci check-pins [--config <file>] [--base <ref>]
 *   terragucci install tofu|terraform|terragrunt|choudoufu|infracost|cosign|atmos|terramate <version>   (Linux builds, for a CI job)
 *   terragucci atmos write   (write each Atmos instance to <stack>/<component> from atmos describe stacks; run by the generated pipeline)
 *   terragucci terramate generate   (fail on stale Terramate generated code, then write each stack's order and inputs beside it; run by the generated pipeline)
  terragucci binary <root> [--binary <b>] [--config <file>]   (internal: the binary a root runs, run by the generated pipeline)
 *   terragucci binary <root> [--binary <b>] [--config <file>]   (print the binary a root runs, installing the version it pins; run by the generated pipeline)
 *   terragucci auth-provider   (Terragrunt's auth-provider-cmd, run by the generated pipeline)
 *   terragucci rollout <module> [<version>] [--from v] [--mode dry-run|apply] [--config <file>]
 *   terragucci rollout --provider <address> <version> [--from v] [--mode dry-run|apply]
 *   terragucci profiles --config <file>
 *   terragucci config check [--config <file>]
  terragucci approve [wave-<k> | <migration>] [--plan <digest>] [--sign [<key>]] [--actor <name>] [--dry-run] [--no-resume]
  terragucci resume [--forge github|forgejo|gitlab] [--out <file>]
 *   terragucci approve [wave-<k> | <migration>] [--plan <digest>] [--sign [<key>]] [--actor <name>] [--dry-run] [--no-resume]   (approve a waiting wave's digest with chant approve, then start its apply again with your token)
 *   terragucci resume [--forge github|forgejo|gitlab] [--out <file>]   (find a waiting wave an approval now stands for, or an approved apply that was killed; run by the pipeline's resume job)
 *   terragucci migrate revert <migration>   (write the migration that puts back the states an applied migration wrote)
 *   terragucci unlock-state <root> [--binary <b>] [--config <file>] [--actor <name>]   (release a state lock no live run holds, once its approval stands; see unlock.ts)
 *   terragucci ephemeral up|down|sweep [--pr <n>] [--head <sha>] [--reason closed|expired] [--base <ref>]   (a pull request's copy of the ephemeral roots; see ephemeral.ts)
 *   terragucci state export <root> [--version <id>] [--out <file>] [--actor <name>]   (ask for one version of a root's state, and once someone else approved it, download it to this machine)
 *   terragucci override <root> --rule <id> [--rule <id>] --reason <text> [--sign [<key>]] [--actor <name>] [--dry-run]   (override a policy denial of one plan with chant approve)
 *   terragucci respond <event> [--mode dry-run|apply] [event flags]
 *   terragucci comment --layers <a,b;c> --out <file> [--forge forgejo] [--agent off|on]   (read a `/terragucci plan [root]` comment; run by the generated pipeline)
 *   terragucci comment --forge gitlab --poll --layers <a,b;c> [--when merge|pull-request] [--requires <list>|none] [--plan-notes] [--agent on] [--review]   (answer the `/terragucci` merge request notes since the last polls, and with --plan-notes post the plan notes first; run by the comments schedule's job)
 *   terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge forgejo|gitlab]   (read a `/terragucci agent <ask>` comment)
 *   terragucci comment --agent push --change <dir> [--policy-dir <dir>] [--forge gitlab]   (push the agent's change to the pull request's head branch)
 *   terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]   (locks: plan: lock the roots a pull request's head reaches, or release them; run by the generated pipeline)
 *   terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]
  terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo|gitlab] [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]   (read a `/terragucci apply [wave-<n>]`, `/terragucci lock` or `/terragucci unlock` comment; run by the generated pipeline)
 *   terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo|gitlab]   (merge a pull request applied before merge, with apply.merge: auto; run by the generated pipeline)
 *   terragucci approval-status [--forge github|forgejo] [--report <dir>]   (post terragucci/approval on a pull request's head, with approval: pr-review; run by the generated pipeline)
 *   terragucci plan-note --forge github|forgejo --report <dir> --plan-result <result> [--root <root>] [--approval-status]   (post the plan job's note and terragucci/plan from its report; run by the generated pipeline's plan-note job)
 *   terragucci review prompt --report <dir> [--instructions <path>] [--forge gitlab]   (fetch the plan report of the pull request's run and write the review's prompt from the pull request, its plan and the default branch's instructions; run by the review workflow's review job)
 *   terragucci review post --dir <dir> [--forge gitlab]   (post the review as a note on the pull request; run by the review-note job)
 *   terragucci notify waiting|refused|failed --wave <n> [--outcome <file>] [--outcome-json <file>] [--report <dir>]   (post a wave's outcome to the chat webhooks notify: names; run by the generated pipeline)
 *   terragucci notify drift [--report <dir>]   (post the drift job's findings to Slack and Teams, with a Re-plan button; run by the generated pipeline)
 *   terragucci relay [--port <n>]   (serve the Approve and Decline buttons of Slack and Teams messages, in your own cloud; settings from the environment)
 *   terragucci drift-agent prompt --report <dir> --out <file> [--policy-dir <dir>]   (write the drift agent's prompt from the drift job's report and issue.json; run by the generated pipeline)
 *   terragucci drift-agent push --change <dir> [--forge github|forgejo] [--policy-dir <dir>]   (open a pull request with the drift agent's change, unless it touches a guarded path, and say so on the drift issue; run by the generated pipeline)
 *   terragucci query "<sql>" [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--json]   (SQL over the inventory, changes, history, audit trail and state edges in the reports bucket, in process)
 *   terragucci mcp [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]   (a read-only MCP server on stdio over what terragucci wrote to the reports bucket and the repo; credentials from the environment)
 *
 * `--json` on init, reconcile, plan, stage, rollout, config check and query prints one envelope
 * (see envelope.ts) instead of text.
 *
 * Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or
 * config error; 3 waiting on an approval; 4 a wave's plans changed after
 * its approval, so it applied nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLY_REQUIRES, APPLY_WHEN, APPROVALS, BINARIES, checkMode, ConfigError, FORGES, findConfig, forgeFromHost, gitlabPrApplyProblems, loadConfig, parseProjectKey, resolveRepo, responseTo, type ApplyRequire, type ApplyWhen, type Approval, type Binary, type ForgeName, type Gate, type ProjectSettings, type TerragucciConfig } from "./config";
import { configSchemaProblems } from "./config-schema";
import { checkoutApproval, type ApprovalMode } from "./approval";
import { decideComment, writeDecision } from "./comment";
import { pollGitLabComments } from "./comment-gitlab";
import { gitlabApi } from "./comment-apply-gitlab";
import { postGitLabReview, pushGitLabAgentChange, readGitLabAgentAsk, writeGitLabReviewPrompt } from "./gitlab-agent";
import { approvalStatus, forgeCalls } from "./review";
import { postPlanNoteFromReport } from "./plan-note";
import { approve, overrideDenial } from "./approve";
import { decideApplyComment, decidePlanLock, mergePullRequest } from "./comment-apply";
import { decideGitLabApply, mergeGitLabMR } from "./comment-apply-gitlab";
import { pushAgentChange, writePrompt } from "./agent-comment";
import { artifactBytes, fetchPlanReport, postReview, reviewSubject, writeReviewPrompt, REVIEW_INSTRUCTIONS } from "./review-agent";
import { addressWarnings, detectForge, findRoots, type WavesAfter } from "./detect";
import { atmosInstances, atmosWrite, describeStacks, detectAtmos, instanceStates } from "./atmos";
import { terramateWrite } from "./terramate";
import { credentialWarnings, stateAccess, type StateAccess } from "./roles";
import { envelope, ENVELOPE_COMMANDS, type Envelope } from "./envelope";
import { describeInit, init, initJson } from "./init";
import { describeImport, importConfig, IMPORT_SOURCES, type ImportSource } from "./import";
import { checkGenerated, describeGenerate, planGenerate } from "./generate";
import { assertLinux, install, type Tool } from "./install";
import { describeBinary, RootBinaries } from "./pins";
import { plan } from "./plan";
import { describeChecks, describePublish, publish, verifyPublished } from "./publish";
import { describeReconcile, reconcile } from "./reconcile";
import { describeEstate, estate } from "./estate";
import { audit, describeAudit } from "./audit";
import { RenderError } from "./render";
import { applyWave, parseBranches, readLedger } from "./apply";
import { resumeStep } from "./resume";
import { checkPolicyTests, checkRoot, checkUnitPins, emitCheck, policyBase } from "./check";
import { pinChecker } from "./publish/require";
import { authProviderOutput, detectTerragrunt, walkUnits } from "./terragrunt";
import { detectShape } from "./shape";
import { renderText } from "./report/views";
import { parseLayers, runStage } from "./report/stage";
import { MIGRATE_LEDGER, migrationPipelineProblems, runMigrations, writeRevert } from "./migrate";
import { exportState } from "./export";
import { StoreError } from "./report/object-store";
import { describeRollout, rollout, rolloutArgs, rolloutExit } from "./rollout";
import { respond } from "./respond";
import { driftNotice, notify, notifyDrift, NOTIFY_EVENTS, readOutcome, waveNotice, type NotifyEvent } from "./notify";
import { startRelay } from "./relay";
import { mcp } from "./mcp";
import { describeQuery, query } from "./query";
import { pushDriftChange, writeDriftPrompt } from "./drift-agent";
import { parseImport } from "./respond/drift";
import { unlockState } from "./unlock";
import { ephemeralDown, ephemeralSweep, ephemeralUp } from "./ephemeral";

const USAGE = `usage:
  terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform|choudoufu] [--approval ledger|pr-review|sealed] [--signer <principal>] [--force] [--dry-run]
  terragucci import atlantis|digger|terrateam [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
  terragucci reconcile --config <file> [--mode dry-run|apply] [--project <host/path>]
  terragucci generate [--check] [--dry-run] [--config <file>]
  terragucci estate [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
  terragucci audit [--check] [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
  terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
  terragucci publish [--dry-run] [--config <file>]
  terragucci stage tf-plan|tf-drift [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>] [--no-cost]
  terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>] [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>] [--shares <n> [--share <s>] [--decided <file>]] [--branches <branch>=<globs>[;...] [--branch <name>]] [--on-held wait|refuse] [--stand-down]
  terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
  terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
  terragucci check-root <dir> [--binary <b>] [--config <file>] [--base <ref>]
  terragucci check-policy [--config <file>] [--base <ref>]
  terragucci check-pins [--config <file>] [--base <ref>]   (Terragrunt: each unit's module pin under modules.require)
  terragucci install tofu|terraform|terragrunt|choudoufu|infracost|cosign <version>   (Linux builds, for a CI job)
  terragucci binary <root> [--binary <b>] [--config <file>]   (internal: the binary a root runs, run by the generated pipeline)
  terragucci auth-provider   (internal: Terragrunt's auth-provider-cmd, run by the generated pipeline)
  terragucci profiles --config <file>
  terragucci config check [--config <file>]
  terragucci comment --layers <a,b;c> --out <file> [--forge github|forgejo] [--agent off|on]
  terragucci comment --forge gitlab --poll --layers <a,b;c> [--when merge|pull-request] [--requires <list>|none] [--plan-notes] [--agent on] [--review]
  terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge github|forgejo|gitlab]
  terragucci comment --agent push --change <dir> [--policy-dir <dir>] [--forge github|forgejo|gitlab]
  terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo|gitlab] [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]
  terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo|gitlab]
  terragucci approval-status [--forge github|forgejo] [--report <dir>]
  terragucci plan-note --forge github|forgejo --report <dir> --plan-result <result> [--root <root>] [--approval-status]
  terragucci review prompt --report <dir> [--instructions <path>] [--forge gitlab]
  terragucci review post --dir <dir> [--forge gitlab]
  terragucci notify waiting|refused|failed --wave <n> [--outcome <file>] [--outcome-json <file>] [--report <dir>]
  terragucci notify drift [--report <dir>]
  terragucci relay [--port <n>]   serve Slack and Teams Approve and Decline clicks; settings from TERRAGUCCI_RELAY_* in the environment
  terragucci drift-agent prompt --report <dir> --out <file> [--policy-dir <dir>]
  terragucci drift-agent push --change <dir> [--forge github|forgejo] [--policy-dir <dir>]
  terragucci query "<sql>" [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--json]   SQL over the inventory, changes, history, audit trail and state edges in the reports bucket, run in this process
  terragucci mcp [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]   a read-only MCP server on stdio: the estate, reports, state versions, audit trail and DORA figures; credentials from the environment
  terragucci approve [wave-<k> | <migration>] [--plan <digest>] [--sign [<key>]] [--actor <name>] [--dry-run]
  terragucci override <root> --rule <id> [--rule <id>] --reason <text> [--sign [<key>]] [--actor <name>] [--dry-run]
  terragucci migrate revert <migration>
  terragucci unlock-state <root> [--binary <b>] [--config <file>] [--actor <name>]
  terragucci ephemeral up --pr <n> [--head <sha>] [--base <ref>] [--binary <b>] [--config <file>]   (run by the generated pipeline)
  terragucci ephemeral down --pr <n> --reason closed|expired [--base <ref>] [--binary <b>] [--config <file>]
  terragucci ephemeral sweep [--base <ref>] [--binary <b>] [--config <file>]
  terragucci state export <root> [--version <id>] [--out <file>] [--actor <name>]
  terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|version-bump|description [--mode dry-run|apply] [flags]
  terragucci respond rollout [--mode dry-run|apply]   continue every rollout in flight

Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or config error; 3 waiting on an approval; 4 a wave's plans changed after its approval, so it applied nothing.

init, reconcile, plan, stage, rollout, respond, config check and query take --json: one envelope on stdout.

Docs: https://intentius.io/terragucci/`;

/** `--approval`: one of APPROVALS, or undefined when not given. */
/** The checkout's `waves.after`, for plain roots; undefined when there is none or the config cannot be read (the plan job says why). */
async function wavesAfterAt(cwd: string): Promise<WavesAfter | undefined> {
  try {
    const path = findConfig(cwd);
    return path ? detectShape(cwd, resolveRepo(await loadConfig(path))).after : undefined;
  } catch {
    return undefined;
  }
}

function approvalFlag(v: string | undefined): Approval | undefined {
  if (v !== undefined && !(APPROVALS as readonly string[]).includes(v)) throw new ConfigError(`--approval must be one of ${APPROVALS.join(", ")}`);
  return v as Approval | undefined;
}

/** `--requires`: a comma-separated list of APPLY_REQUIRES, or none; undefined when not given. */
function requiresOf(v: string | undefined, cmd: string): ApplyRequire[] | undefined {
  const list = v === undefined ? undefined : v === "none" ? [] : v.split(",");
  if (list?.some((r) => !(APPLY_REQUIRES as readonly string[]).includes(r))) throw new ConfigError(`${cmd}'s --requires is a comma-separated list of ${APPLY_REQUIRES.join(", ")}, or none`);
  return list as ApplyRequire[] | undefined;
}

/** `--parallelism`: a whole number of 1 or more. */
function parallelismFlag(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`--parallelism is ${JSON.stringify(v)}; use a whole number of 1 or more`);
  return n;
}

function wholeFlag(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`--${name} is ${JSON.stringify(v)}; use a whole number of 1 or more`);
  return n;
}

function parse(argv: string[]): { cmd: string; flags: Record<string, string | true>; args: string[] } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && !["force", "dry-run", "json", "terragrunt", "rest", "again", "poll", "plan-notes", "no-cost", "check", "approval-status", "review", "stand-down"].includes(k)) flags[k] = rest[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { cmd, flags, args };
}

function onHeldFlag(v: string): "wait" | "refuse" {
  if (v !== "wait" && v !== "refuse") throw new ConfigError("--on-held must be wait or refuse");
  return v;
}

function str(flags: Record<string, string | true>, k: string): string | undefined {
  const v = flags[k];
  if (v === true) throw new ConfigError(`--${k} needs a value`);
  return v;
}

/** The validation stack's profiles a config needs: floci and one per forge it names. */
export function profilesFor(config: TerragucciConfig, repo?: string): string[] {
  const out = new Set<string>(["aws"]);
  const projects = config.projects
    ? Object.entries(config.projects).map(([key, s]) => ({ host: parseProjectKey(key).host, s: { ...config.defaults, ...s } }))
    : [{ host: undefined, s: config as ProjectSettings }];
  for (const { host, s } of projects) {
    const forge = s.forge ?? (host ? forgeFromHost(host) : repo ? detectForge(repo)?.value : undefined);
    if (forge) out.add(forge);
  }
  return [...out];
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags, args } = parse(argv);
  const cwd = process.cwd();
  const json = flags.json === true;
  const emit = (e: Envelope): number => {
    console.log(JSON.stringify(e, null, 2));
    return e.exit;
  };
  try {
    if (json && !ENVELOPE_COMMANDS.includes(cmd)) throw new ConfigError(`--json is not available on ${cmd || "help"}`);
    switch (cmd) {
      case "init": {
        const forge = str(flags, "forge");
        const binary = str(flags, "binary");
        if (forge && !FORGES.includes(forge as ForgeName)) throw new ConfigError(`--forge must be one of ${FORGES.join(", ")}`);
        if (binary && !BINARIES.includes(binary as Binary)) throw new ConfigError(`--binary must be one of ${BINARIES.join(", ")}`);
        const approval = approvalFlag(str(flags, "approval"));
        const signer = str(flags, "signer");
        const result = await init(cwd, { forge: forge as ForgeName, binary: binary as Binary, ...(approval ? { approval } : {}), ...(signer ? { signer } : {}), force: flags.force === true, dryRun: flags["dry-run"] === true });
        if (json) return emit(envelope("init", 0, initJson(cwd, result, flags["dry-run"] === true)));
        console.log(describeInit(cwd, result, flags["dry-run"] === true));
        if (flags["dry-run"] === true) console.log("dry run: nothing was written");
        return 0;
      }
      case "import": {
        const [source, file, extra] = args;
        if (!IMPORT_SOURCES.includes(source as ImportSource)) throw new ConfigError(`import reads ${IMPORT_SOURCES.join(", ")}: \`terragucci import atlantis [atlantis.yaml]\`, \`terragucci import digger [digger.yml]\` or \`terragucci import terrateam [.terrateam/config.yml]\``);
        if (extra !== undefined) throw new ConfigError("import reads one file");
        const forge = str(flags, "forge");
        if (forge && !FORGES.includes(forge as ForgeName)) throw new ConfigError(`--forge must be one of ${FORGES.join(", ")}`);
        const when = str(flags, "apply-when");
        if (when && !APPLY_WHEN.includes(when as ApplyWhen)) throw new ConfigError(`--apply-when must be one of ${APPLY_WHEN.join(", ")}`);
        const result = importConfig(cwd, source as ImportSource, {
          ...(file ? { file } : {}),
          ...(forge ? { forge: forge as ForgeName } : {}),
          ...(when ? { applyWhen: when as ApplyWhen } : {}),
          force: flags.force === true,
          dryRun: flags["dry-run"] === true,
        });
        console.log(describeImport(result));
        return 0;
      }
      case "reconcile": {
        const path = str(flags, "config") ?? findConfig(cwd);
        if (!path) throw new ConfigError("reconcile needs --config <file>");
        const mode = checkMode(str(flags, "mode") ?? "dry-run");
        const outcomes = await reconcile(await loadConfig(resolve(path)), { mode, project: str(flags, "project") });
        const code = outcomes.some((o) => o.status === "failed") ? 1 : 0;
        if (json) return emit(envelope("reconcile", code, { mode, projects: outcomes }));
        console.log(describeReconcile(outcomes, mode));
        return code;
      }
      case "generate": {
        // Each root's backend, provider and version files from terragucci.yml's generate key; --check is tf-check's step.
        const path = str(flags, "config") ?? findConfig(cwd);
        const settings = resolveRepo(path ? await loadConfig(resolve(path)) : {});
        if (flags.check === true) {
          const result = checkGenerated(cwd, settings);
          emitCheck(cwd, result);
          return result.ok ? 0 : 1;
        }
        const plan = planGenerate(cwd, settings);
        if (plan.foreign.length) throw new ConfigError(plan.foreign.join("; "));
        const dryRun = flags["dry-run"] === true;
        if (!dryRun) {
          for (const f of plan.files) {
            if (f.status === "unchanged") continue;
            if (f.status === "removed") unlinkSync(f.path);
            else writeFileSync(f.path, f.content);
          }
        }
        console.log(describeGenerate(cwd, plan, dryRun));
        return 0;
      }
      case "estate": {
        const path = str(flags, "config") ?? findConfig(cwd);
        const hours = str(flags, "link-hours");
        const linkSeconds = hours === undefined ? undefined : Math.round(Number(hours) * 3600);
        if (hours !== undefined && !(Number(hours) > 0)) throw new ConfigError(`--link-hours is ${JSON.stringify(hours)}; use a number of hours, up to 168`);
        const bucket = str(flags, "bucket");
        const result = await estate(cwd, path ? await loadConfig(resolve(path)) : {}, {
          ...(str(flags, "out") ? { out: str(flags, "out") } : {}),
          ...(linkSeconds !== undefined ? { linkSeconds } : {}),
          ...(bucket ? { reports: { bucket, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}) } } : {}),
        });
        console.log(describeEstate(result, cwd));
        return result.unreadable.length ? 1 : 0;
      }
      case "audit": {
        const path = str(flags, "config") ?? findConfig(cwd);
        const hours = str(flags, "link-hours");
        const linkSeconds = hours === undefined ? undefined : Math.round(Number(hours) * 3600);
        if (hours !== undefined && !(Number(hours) > 0)) throw new ConfigError(`--link-hours is ${JSON.stringify(hours)}; use a number of hours, up to 168`);
        const bucket = str(flags, "bucket");
        const check = flags.check === true;
        const result = await audit(cwd, path ? await loadConfig(resolve(path)) : {}, {
          ...(check ? { check } : {}),
          ...(str(flags, "out") ? { out: str(flags, "out") } : {}),
          ...(linkSeconds !== undefined ? { linkSeconds } : {}),
          ...(bucket ? { reports: { bucket, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}) } } : {}),
        });
        console.log(describeAudit(result, cwd, check));
        return result.unreadable.length || (check && result.added.length) ? 1 : 0;
      }
      case "plan": {
        const results = await plan(cwd, { root: str(flags, "root"), project: str(flags, "project"), config: str(flags, "config") }, json ? () => {} : console.log);
        const code = results.every((r) => r.ok) ? 0 : 1;
        return json ? emit(envelope("plan", code, { roots: results })) : code;
      }
      case "stage": {
        if (args[0] === "tf-apply") {
          if (json) throw new ConfigError("--json is not available on stage tf-apply");
          const layers = str(flags, "layers");
          if (!layers || !str(flags, "wave")) throw new ConfigError("stage tf-apply needs --wave <n> and --layers <a,b;c>");
          return await applyWave(cwd, {
            wave: Number(str(flags, "wave")),
            layers: parseLayers(layers),
            canary: (str(flags, "canary") ?? "").split(",").filter(Boolean),
            binary: str(flags, "binary") ?? "tofu",
            gate: (str(flags, "gate") ?? "on-destroy") as Gate,
            ...(str(flags, "approval") ? { approval: approvalFlag(str(flags, "approval")) } : {}),
            ...(str(flags, "config") ? { config: str(flags, "config") } : {}),
            ...(str(flags, "parallelism") ? { parallelism: parallelismFlag(str(flags, "parallelism")!) } : {}),
            ...(flags.terragrunt === true ? { terragrunt: true } : {}),
            ...(flags.rest === true ? { rest: true } : {}),
            ...(str(flags, "base") ? { base: str(flags, "base") } : {}),
            ...(str(flags, "shares") ? { shares: wholeFlag("shares", str(flags, "shares")!) } : {}),
            ...(str(flags, "share") ? { share: wholeFlag("share", str(flags, "share")!) } : {}),
            ...(str(flags, "decided") ? { decided: str(flags, "decided") } : {}),
            ...(str(flags, "branches") ? { branches: parseBranches(str(flags, "branches")!) } : {}),
            ...(str(flags, "branch") ? { branch: str(flags, "branch") } : {}),
            ...(str(flags, "on-held") ? { onHeld: onHeldFlag(str(flags, "on-held")!) } : {}),
            ...(flags["stand-down"] === true ? { standDown: true } : {}),
          });
        }
        const result = await runStage(args[0] ?? "", cwd, {
          root: str(flags, "root"), project: str(flags, "project"), config: str(flags, "config"),
          out: str(flags, "out"), reportUrl: str(flags, "report-url"),
          ...(str(flags, "layers") ? { layers: parseLayers(str(flags, "layers")!) } : {}),
          ...(str(flags, "binary") ? { binary: str(flags, "binary") } : {}),
          ...(str(flags, "forge") ? { forge: str(flags, "forge") as ForgeName } : {}),
          ...(str(flags, "canary") ? { canary: str(flags, "canary")!.split(",").filter(Boolean) } : {}),
          ...(flags.terragrunt === true ? { terragrunt: true } : {}),
          ...(flags["no-cost"] === true ? { noCost: true } : {}),
          ...(str(flags, "base") ? { base: str(flags, "base") } : {}),
          ...(str(flags, "parallelism") ? { parallelism: parallelismFlag(str(flags, "parallelism")!) } : {}),
          ...(str(flags, "bucket")
            ? { reports: { bucket: str(flags, "bucket")!, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}), ...(str(flags, "bucket-url") ? { url: str(flags, "bucket-url") } : {}) } }
            : {}),
        }, json ? () => {} : console.error);
        let code = result.failed ? 1 : 0;
        // A pull request's plan proves each state migration it carries, read only (./migrate.ts).
        if (args[0] === "tf-plan") {
          const migrations = await runMigrations(cwd, { binary: str(flags, "binary") ?? result.report.run.binary ?? "tofu", planOnly: true, log: json ? console.error : console.log });
          if (migrations.code !== 0) code = 1;
        }
        const files = { html: `${result.dir}/report.html`, json: `${result.dir}/report.json`, note: `${result.dir}/note.md` };
        if (json) return emit(envelope("stage", code, { stage: args[0], change_set: result.report.change_set, files, uploaded: result.uploaded ?? null, ...(result.issue ? { issue: result.issue } : {}) }));
        console.log(renderText(result.report));
        console.log(`report: ${relative(cwd, files.html) || files.html}`);
        if (result.uploaded) console.log(`copied to the bucket under ${result.uploaded.prefix}; index rewritten at ${result.uploaded.indexes.join(" and ")}`);
        if (result.report.run.report_url) console.log(`served at ${result.report.run.report_url}`);
        if (result.report.run.trace_id) console.log(`trace: ${result.report.run.trace_url ?? result.report.run.trace_id}`);
        return code;
      }
      case "check-root": {
        // tf-check's per-root step: validate's diagnostics, and choudoufu's live-check for a choudoufu root.
        const dir = args[0];
        if (!dir) throw new ConfigError("usage: terragucci check-root <dir> [--binary <b>] [--config <file>] [--base <ref>]");
        const path = str(flags, "config") ?? findConfig(cwd);
        const settings = resolveRepo(path ? await loadConfig(resolve(path)) : {});
        const pins = await pinChecker(cwd, settings.modules, str(flags, "base") ?? policyBase(process.env), path ? { config: resolve(path) } : {});
        const result = await checkRoot(str(flags, "binary") ?? "tofu", dir, cwd, pins ? { pins } : {});
        emitCheck(cwd, result);
        return result.ok ? 0 : 1;
      }
      case "check-pins": {
        // tf-check's pin step in a Terragrunt repo: each unit's terraform source, as check-root checks a root's module calls.
        const path = str(flags, "config") ?? findConfig(cwd);
        const settings = resolveRepo(path ? await loadConfig(resolve(path)) : {});
        const pins = await pinChecker(cwd, settings.modules, str(flags, "base") ?? policyBase(process.env), path ? { config: resolve(path) } : {});
        if (!pins) return 0;
        const result = await checkUnitPins(walkUnits(cwd, settings.terragrunt?.exclude).map((u) => u.path), pins);
        emitCheck(cwd, result);
        return result.ok ? 0 : 1;
      }
      case "check-policy": {
        // tf-check's policy step: the policy's own tests, when `policy:` is set.
        const result = await checkPolicyTests(cwd, { ...(str(flags, "config") ? { config: str(flags, "config") } : {}), ...(str(flags, "base") ? { base: str(flags, "base") } : {}) });
        emitCheck(cwd, result);
        return result.ok ? 0 : 1;
      }
      case "atmos": {
        // An Atmos repo's synth: every job writes the instances before it reads them.
        if (args[0] !== "write") throw new ConfigError("usage: terragucci atmos write");
        for (const line of await atmosWrite(cwd)) console.log(line);
        return 0;
      }
      case "terramate": {
        // A Terramate repo's prepare (../shape.ts): every job checks the generated code and writes each stack's edges.
        if (args[0] !== "generate") throw new ConfigError("usage: terragucci terramate generate");
        for (const line of await terramateWrite(cwd)) console.log(line);
        return 0;
      }
      case "auth-provider": {
        // Terragrunt runs this in each unit's directory and reads the credentials it prints.
        console.log(JSON.stringify(authProviderOutput(cwd, process.env)));
        return 0;
      }
      case "binary": {
        // tf-check's per-root step, when roots pin their own version: the binary the root runs, installed when the job's is not it.
        const root = args[0];
        if (!root) throw new ConfigError("usage: terragucci binary <root> [--binary <b>] [--config <file>]");
        const path = str(flags, "config") ?? findConfig(cwd);
        const settings = resolveRepo(path ? await loadConfig(resolve(path)) : {});
        const binaries = new RootBinaries(cwd, str(flags, "binary") ?? settings.binary ?? "tofu", settings.version);
        const b = await binaries.resolve(root);
        console.error(`${root}: ${describeBinary(b)}`);
        console.log(b.path);
        return 0;
      }
      case "install": {
        const [tool, version] = args;
        if (!tool || !version || !["tofu", "terraform", "terragrunt", "choudoufu", "infracost", "cosign", "atmos", "terramate"].includes(tool)) {
          throw new ConfigError("usage: terragucci install tofu|terraform|terragrunt|choudoufu|infracost|cosign|atmos|terramate <version>");
        }
        assertLinux();
        console.log(await install(tool as Tool, version));
        return 0;
      }
      case "publish": {
        const path = str(flags, "config") ?? findConfig(cwd);
        const settings = resolveRepo(path ? await loadConfig(resolve(path)) : {});
        const results = await publish(cwd, settings, { dryRun: flags["dry-run"] === true });
        console.log(describePublish(results));
        // A release modules.test refused fails the job, once every other module has published.
        return results.some((r) => r.status === "refused") ? 1 : 0;
      }
      case "verify-release": {
        const [module, version] = args;
        if (!module || !version) throw new ConfigError("usage: terragucci verify-release <module> <version> [--config <file>]");
        const path = str(flags, "config") ?? findConfig(cwd);
        const checks = await verifyPublished(cwd, resolveRepo(path ? await loadConfig(resolve(path)) : {}), module, version);
        console.log(describeChecks(checks));
        return checks.every((c) => c.verified) ? 0 : 1;
      }
      case "respond": {
        const event = args[0] ?? "";
        const path = str(flags, "config") ?? findConfig(cwd);
        // With a module named, the response is that rollout's next step; with none, respond() continues every rollout in flight.
        if (event === "rollout" && (args.length > 1 || flags.provider !== undefined)) {
          const config = path ? await loadConfig(resolve(path)) : {};
          if (responseTo(config.projects ? resolveRepo(config.defaults ?? {}) : resolveRepo(config), "rollout") !== "off") return main(["rollout", ...argv.slice(argv.indexOf("rollout") + 1)]);
        }
        const s = (k: string) => str(flags, k);
        const log = s("log");
        const result = await respond(event, cwd, {
          ...Object.fromEntries(["config", "project", "base", "out", "report", "approved", "current", "root", "binary", "branch", "module", "version", "title", "description", "since", "attributions"].map((k) => [k, s(k)])),
          mode: (s("mode") ?? "dry-run") as "dry-run",
          ...(s("wave") ? { wave: Number(s("wave")) } : {}),
          ...(log ? { log: readFileSync(log === "-" ? 0 : resolve(cwd, log), "utf-8") } : {}),
          ...(s("platform") ? { platforms: s("platform")!.split(",") } : {}),
          imports: argv.flatMap((a, i) => (a === "--import" ? [argv[i + 1] ?? ""] : a.startsWith("--import=") ? [a.slice(9)] : [])).map(parseImport),
        });
        if (json) return emit(envelope("respond", result.exit ?? 0, result));
        console.log(result.text);
        return result.exit ?? 0;
      }
      case "comment": {
        const layers = str(flags, "layers");
        const out = str(flags, "out");
        const forge = str(flags, "forge") ?? "github";
        const agent = str(flags, "agent") ?? "off";
        const policyDir = str(flags, "policy-dir") ?? "policy";
        if (!["off", "on", "run", "push"].includes(agent)) throw new ConfigError("comment's --agent is off, on, run or push");
        // GitLab's agent pipeline: the agent job reads the ask, and agent-push lands the change (gitlab-agent.ts).
        if (forge === "gitlab" && agent === "run" && flags.poll !== true) {
          const out = str(flags, "out");
          const prompt = str(flags, "prompt");
          if (!out || !prompt) throw new ConfigError("comment --forge gitlab --agent run needs --out <file> and --prompt <file>");
          const decision = await readGitLabAgentAsk(gitlabApi(process.env, process.env.TG_TOKEN, fetch), process.env);
          writeDecision(resolve(cwd, out), decision);
          if (decision.go && decision.ask) writePrompt(resolve(cwd, prompt), { ask: decision.ask, pr: decision.pr!, head: decision.head!, user: decision.user!, policyDir, what: `merge request !${decision.pr}` });
          if (decision.fail) {
            console.error(`terragucci comment: failed, no agent: ${decision.reason}`);
            return 1;
          }
          console.log(`terragucci comment: ${decision.go ? "" : "no agent: "}${decision.reason}`);
          return 0;
        }
        if (forge === "gitlab" && agent === "push" && flags.poll !== true) {
          const change = str(flags, "change");
          if (!change) throw new ConfigError("comment --agent push needs --change <dir>");
          const pushed = await pushGitLabAgentChange({ change: resolve(cwd, change), policyDir });
          console.log(`terragucci comment: ${pushed.pushed ? "" : "nothing pushed: "}${pushed.reason}`);
          return pushed.fail ? 1 : 0;
        }
        if (flags.poll === true || forge === "gitlab") {
          // GitLab: no event file, so the comments schedule's job polls the merge requests' notes.
          if (forge !== "gitlab" || flags.poll !== true) throw new ConfigError("comment --poll is GitLab's: run it as comment --forge gitlab --poll --layers <a,b;c>");
          if (!layers) throw new ConfigError("comment --forge gitlab --poll needs --layers <a,b;c>");
          const when = str(flags, "when") ?? "merge";
          if (when !== "merge" && when !== "pull-request") throw new ConfigError("comment's --when is merge or pull-request");
          const requires = requiresOf(str(flags, "requires"), "comment");
          if (agent !== "off" && agent !== "on") throw new ConfigError("comment --forge gitlab --poll's --agent is off or on");
          const poll = await pollGitLabComments({ layers: parseLayers(layers), when, ...(requires ? { requires } : {}), ...(flags["plan-notes"] === true ? { planNotes: true } : {}), ...(agent === "on" ? { agent: true } : {}), ...(flags.review === true ? { review: true } : {}) });
          for (const p of poll.plans ?? []) console.log(`terragucci comment: !${p.mr} plan: ${p.reason}`);
          for (const r of poll.reviews ?? []) console.log(`terragucci comment: !${r.mr} review: ${r.reason}`);
          for (const n of poll.outcomes) console.log(`terragucci comment: !${n.mr} note ${n.note}: ${n.ran ? "" : "nothing run: "}${n.reason}`);
          if (poll.outcomes.length === 0 && !poll.fail) console.log("terragucci comment: no new /terragucci notes");
          if (poll.fail) console.error(`terragucci comment: failed: ${poll.fail}`);
          return poll.fail || poll.outcomes.some((n) => n.fail) || (poll.plans ?? []).some((p) => p.fail) || (poll.reviews ?? []).some((r) => r.fail) ? 1 : 0;
        }
        if (agent === "push") {
          const change = str(flags, "change");
          if (!change) throw new ConfigError("comment --agent push needs --change <dir>");
          const pushed = await pushAgentChange({ change: resolve(cwd, change), policyDir });
          console.log(`terragucci comment: ${pushed.pushed ? "" : "nothing pushed: "}${pushed.reason}`);
          return pushed.fail ? 1 : 0;
        }
        const prompt = str(flags, "prompt");
        if (agent === "run" ? !out || !prompt : !layers || !out) throw new ConfigError(agent === "run" ? "comment --agent run needs --out <file> and --prompt <file>" : "comment needs --layers <a,b;c> and --out <file>");
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("comment's --forge is github or forgejo");
        const decision = await decideComment({ layers: layers ? parseLayers(layers) : [], forge, agent: agent as "off" | "on" | "run" });
        writeDecision(resolve(cwd, out!), decision);
        if (decision.go && decision.ask && prompt) writePrompt(resolve(cwd, prompt), { ask: decision.ask, pr: decision.pr!, head: decision.head!, user: decision.user!, policyDir });
        if (decision.fail) {
          console.error(`terragucci comment: failed, no re-plan: ${decision.reason}`);
          return 1;
        }
        console.log(`terragucci comment: ${decision.go ? "" : agent === "run" ? "no agent: " : "no re-plan: "}${decision.reason}`);
        return 0;
      }
      case "comment-apply": {
        const layers = str(flags, "layers");
        const out = str(flags, "out");
        const forge = str(flags, "forge") ?? "github";
        const canary = str(flags, "canary");
        const when = str(flags, "when") ?? "merge";
        if (!layers || !out) throw new ConfigError("comment-apply needs --layers <a,b;c> and --out <file>");
        if (forge !== "github" && forge !== "forgejo" && forge !== "gitlab") throw new ConfigError("comment-apply's --forge is github, forgejo or gitlab");
        if (when !== "merge" && when !== "pull-request") throw new ConfigError("comment-apply's --when is merge or pull-request");
        const requires = requiresOf(str(flags, "requires"), "comment-apply");
        // waves.after: a root it puts after a root the change reaches is locked with it.
        const after = flags.terragrunt === true ? undefined : await wavesAfterAt(cwd);
        if (forge === "gitlab") {
          // GitLab: the mr-apply job of the pipeline the comments job started; the merge request, the note and the head come from its variables, read again from the API.
          if (when !== "pull-request") throw new ConfigError("comment-apply --forge gitlab is apply before merge's: pass --when pull-request");
          const decision = await decideGitLabApply({ layers: parseLayers(layers), ...(canary ? { canary: canary.split(",") } : {}), ...(after ? { after } : {}), ...(requires ? { requires } : {}), ...(flags.terragrunt === true ? { terragrunt: true } : {}) });
          writeDecision(resolve(cwd, out), decision);
          if (decision.fail) {
            console.error(`terragucci comment-apply: failed, nothing applied: ${decision.reason}`);
            return 1;
          }
          console.log(`terragucci comment-apply: ${decision.go ? "" : "nothing applied: "}${decision.reason}`);
          return 0;
        }
        const decision = await decideApplyComment({ layers: parseLayers(layers), forge, when, ...(canary ? { canary: canary.split(",") } : {}), ...(after ? { after } : {}), ...(requires ? { requires } : {}), ...(flags.terragrunt === true ? { terragrunt: true } : {}), ...(flags.again === true ? { again: true } : {}) });
        writeDecision(resolve(cwd, out), decision);
        if (decision.fail) {
          console.error(`terragucci comment-apply: failed, nothing applied: ${decision.reason}`);
          return 1;
        }
        console.log(`terragucci comment-apply: ${decision.go ? "" : "nothing applied: "}${decision.reason}`);
        return 0;
      }
      case "pr-lock": {
        const layers = str(flags, "layers");
        const forge = str(flags, "forge") ?? "github";
        const when = str(flags, "when") ?? "merge";
        if (!layers) throw new ConfigError("pr-lock needs --layers <a,b;c>");
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("pr-lock's --forge is github or forgejo");
        if (when !== "merge" && when !== "pull-request") throw new ConfigError("pr-lock's --when is merge or pull-request");
        const decision = await decidePlanLock({ layers: parseLayers(layers), forge, when, ...(flags.terragrunt === true ? { terragrunt: true } : {}) });
        if (decision.fail) {
          console.error(`terragucci pr-lock: failed: ${decision.reason}`);
          return 1;
        }
        console.log(`terragucci pr-lock: ${decision.reason}`);
        return 0;
      }
      case "pr-merge": {
        const pr = Number(str(flags, "pr"));
        const sha = str(flags, "sha");
        const forge = str(flags, "forge") ?? "github";
        if (!Number.isInteger(pr) || pr < 1 || !sha) throw new ConfigError("pr-merge needs --pr <n> and --sha <sha>");
        if (forge !== "github" && forge !== "forgejo" && forge !== "gitlab") throw new ConfigError("pr-merge's --forge is github, forgejo or gitlab");
        try {
          console.log(`terragucci pr-merge: ${forge === "gitlab" ? await mergeGitLabMR({ pr, sha }) : await mergePullRequest({ pr, sha, forge })}`);
          return 0;
        } catch (e) {
          if (e instanceof ConfigError) throw e;
          console.error(`terragucci pr-merge: not merged: ${(e as Error).message}`);
          return 1;
        }
      }
      case "approve": {
        const sign = flags.sign === true ? true : str(flags, "sign");
        const plan = flags.plan === true ? "" : str(flags, "plan");
        const done = await approve(cwd, { ...(flags["no-resume"] === true ? { resume: false } : {}), ...(args[0] ? { wave: args[0] } : {}), ...(plan !== undefined ? { plan } : {}), ...(sign !== undefined ? { sign } : {}), ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}), dryRun: flags["dry-run"] === true });
        return done.code;
      }
      case "override": {
        const sign = flags.sign === true ? true : str(flags, "sign");
        // --rule may be given more than once, or as a comma-separated list.
        const rules = argv.flatMap((a, i) => (a === "--rule" ? [argv[i + 1] ?? ""] : a.startsWith("--rule=") ? [a.slice(7)] : [])).flatMap((r) => r.split(","));
        if (rules.some((r) => r === "" || r.startsWith("--"))) throw new ConfigError("--rule needs a rule id, such as main.deny_public_bucket");
        const done = await overrideDenial(cwd, { root: args[0] ?? "", rules, reason: str(flags, "reason") ?? "", ...(sign !== undefined ? { sign } : {}), ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}), dryRun: flags["dry-run"] === true });
        return done.code;
      }
      case "state": {
        if (args[0] !== "export" || !args[1]) throw new ConfigError("state takes: state export <root> [--version <id>] [--out <file>] [--actor <name>]");
        const done = await exportState(cwd, {
          root: args[1],
          ...(str(flags, "version") ? { version: str(flags, "version") } : {}),
          ...(str(flags, "out") ? { out: str(flags, "out") } : {}),
          ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}),
          ...(str(flags, "binary") ? { binary: str(flags, "binary") } : {}),
          ...(str(flags, "config") ? { config: str(flags, "config") } : {}),
        });
        return done.code;
      }
      case "migrate": {
        if (args[0] !== "revert" || !args[1]) throw new ConfigError("migrate takes: migrate revert <migration>");
        const file = writeRevert(cwd, args[1]);
        console.log(`wrote ${file}: it puts back each state ${args[1]} wrote, to the version it recorded before`);
        console.log(`revert the code of ${args[1]} in the same change; the plan job proves the revert and wave 1 waits for its approval`);
        return 0;
      }
      case "unlock-state": {
        if (!args[0] || args.length > 1) throw new ConfigError("unlock-state takes one root: unlock-state <root>");
        const done = await unlockState(cwd, args[0], { ...(str(flags, "binary") ? { binary: str(flags, "binary") } : {}), ...(str(flags, "config") ? { config: str(flags, "config") } : {}), ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}), log: (l) => console.log(`terragucci unlock-state: ${l}`) });
        return done.code;
      }
      case "ephemeral": {
        const sub = args[0];
        const common = { ...(str(flags, "binary") ? { binary: str(flags, "binary") } : {}), ...(str(flags, "config") ? { config: str(flags, "config") } : {}), ...(str(flags, "base") ? { base: str(flags, "base") } : {}), ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}), log: (l: string) => console.log(`terragucci ephemeral: ${l}`) };
        if (sub === "sweep") return await ephemeralSweep(cwd, common);
        if (sub !== "up" && sub !== "down") throw new ConfigError("ephemeral takes up, down or sweep");
        const pr = wholeFlag("pr", str(flags, "pr") ?? "");
        if (sub === "up") return await ephemeralUp(cwd, { ...common, pr, ...(str(flags, "head") ? { head: str(flags, "head") } : {}) });
        const reason = str(flags, "reason");
        if (reason !== "closed" && reason !== "expired") throw new ConfigError("ephemeral down takes --reason closed or --reason expired");
        return await ephemeralDown(cwd, { ...common, pr, reason });
      }
      case "resume": {
        const forge = str(flags, "forge") ?? (process.env.GITLAB_CI === "true" ? "gitlab" : process.env.GITEA_ACTIONS === "true" || process.env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github");
        if (forge !== "github" && forge !== "forgejo" && forge !== "gitlab") throw new ConfigError("resume's --forge is github, forgejo or gitlab");
        const out = str(flags, "out");
        const sha = process.env.TG_SHA || spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).stdout.trim();
        const step = await resumeStep({ ledger: readLedger(cwd), migrations: readLedger(cwd, MIGRATE_LEDGER), forge, sha, env: process.env });
        if (out) writeFileSync(resolve(cwd, out), step.kind === "apply" ? `TG_SHA=${step.sha}\nTG_PR=${step.pr ?? ""}\n` : "");
        if (step.kind === "none") console.log(`terragucci resume: nothing to resume: ${step.why}`);
        else {
          for (const w of step.waves) console.log(w.migration ? `terragucci resume: migration ${w.migration}, which wave 1 runs, was approved by ${w.by} for ${w.digest}` : w.stopped ? `terragucci resume: the apply of wave ${w.wave}, approved by ${w.by} for ${w.digest}, stopped before it finished; the wave applies the rest` : `terragucci resume: wave ${w.wave} was approved by ${w.by} for ${w.digest}`);
          console.log(step.kind === "apply" ? `terragucci resume: applying the waves again at ${step.sha.slice(0, 8)}; each gate decides` : `terragucci resume: retried ${step.job} of pipeline ${step.pipeline}${step.url ? ` (${step.url})` : ""}; the waves after it follow`);
        }
        return 0;
      }
      case "notify": {
        if (args[0] === "drift") {
          for (const line of await notifyDrift(driftNotice(resolve(cwd, str(flags, "report") ?? "terragucci-report")))) console.log(`terragucci notify: ${line}`);
          return 0;
        }
        const event = args[0] as NotifyEvent;
        if (!(NOTIFY_EVENTS as readonly string[]).includes(event)) throw new ConfigError(`terragucci notify takes one of ${[...NOTIFY_EVENTS, "drift"].join(", ")}`);
        const wave = Number(str(flags, "wave"));
        if (!Number.isInteger(wave) || wave < 1) throw new ConfigError("terragucci notify needs --wave <n>");
        const file = str(flags, "outcome");
        const outcome = file && existsSync(resolve(cwd, file)) ? readFileSync(resolve(cwd, file), "utf-8") : undefined;
        const jsonFile = str(flags, "outcome-json");
        const result = jsonFile ? readOutcome(resolve(cwd, jsonFile)) : undefined;
        const report = str(flags, "report");
        for (const line of await notify(waveNotice(event, wave, { ...(outcome ? { outcome } : {}), ...(result ? { result } : {}), reportDir: resolve(cwd, report ?? "terragucci-report") }))) console.log(`terragucci notify: ${line}`);
        return 0;
      }
      case "drift-agent": {
        const sub = args[0];
        const policyDir = str(flags, "policy-dir") ?? "policy";
        if (sub === "prompt") {
          const report = str(flags, "report");
          const out = str(flags, "out");
          if (!report || !out) throw new ConfigError("drift-agent prompt needs --report <dir> and --out <file>");
          const w = writeDriftPrompt({ report: resolve(cwd, report), out: resolve(cwd, out), policyDir });
          console.log(`terragucci drift-agent: wrote the prompt for drift issue #${w.issue}, ${w.roots} root${w.roots === 1 ? "" : "s"} drifted`);
          return 0;
        }
        if (sub === "push") {
          const change = str(flags, "change");
          if (!change) throw new ConfigError("drift-agent push needs --change <dir>");
          const forge = str(flags, "forge") ?? "github";
          if (forge !== "github" && forge !== "forgejo") throw new ConfigError("drift-agent push's --forge is github or forgejo");
          const r = await pushDriftChange({ change: resolve(cwd, change), policyDir, forge });
          console.log(`terragucci drift-agent: ${r.reason}`);
          return r.fail ? 1 : 0;
        }
        throw new ConfigError("drift-agent is drift-agent prompt or drift-agent push");
      }
      case "query": {
        const [sql, extra] = args;
        if (sql === undefined || extra !== undefined) throw new ConfigError('query takes one statement, quoted: terragucci query "SELECT * FROM inventory"');
        const path = str(flags, "config") ?? findConfig(cwd);
        const bucket = str(flags, "bucket");
        const result = await query(path ? await loadConfig(resolve(path)) : {}, sql, {
          ...(bucket ? { reports: { bucket, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}) } } : {}),
        });
        if (json) return emit(envelope("query", 0, result));
        console.log(describeQuery(result));
        return 0;
      }
      case "mcp": {
        // stdout is the protocol's: nothing else is printed there.
        const path = str(flags, "config") ?? findConfig(cwd);
        const bucket = str(flags, "bucket");
        await mcp({
          cwd,
          config: path ? await loadConfig(resolve(path)) : {},
          ...(bucket ? { reports: { bucket, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}) } } : {}),
        });
        return 0;
      }
      case "relay": {
        const port = Number(str(flags, "port") ?? process.env.PORT ?? 8080);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("terragucci relay --port takes a port number");
        await startRelay({ port });
        // Serves until the process is stopped.
        return await new Promise<number>(() => {});
      }
      case "plan-note": {
        const forge = str(flags, "forge") ?? "github";
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("plan-note's --forge is github or forgejo");
        const report = str(flags, "report") ?? "terragucci-report";
        const root = str(flags, "root");
        const said = await postPlanNoteFromReport({ forge, report: resolve(cwd, report), planResult: str(flags, "plan-result") ?? "", ...(root ? { root } : {}), ...(flags["approval-status"] === true ? { approval: true } : {}) });
        for (const line of said) console.log(line);
        return 0;
      }
      case "review": {
        const sub = args[0];
        const reviewForge = str(flags, "forge");
        if (reviewForge !== undefined && !["github", "forgejo", "gitlab"].includes(reviewForge)) throw new ConfigError("review's --forge is github, forgejo or gitlab");
        if (sub === "prompt" && reviewForge === "gitlab") {
          // GitLab's review pipeline names the merge request and head in its variables (gitlab-agent.ts).
          const report = resolve(cwd, str(flags, "report") ?? "terragucci-report");
          const { written: w, report: said } = await writeGitLabReviewPrompt({ report, instructions: str(flags, "instructions") ?? REVIEW_INSTRUCTIONS });
          console.log(`terragucci review: ${said}`);
          console.log(`terragucci review: wrote the prompt for merge request !${w.pr} at ${w.head.slice(0, 8)}; instructions: ${w.instructions === "default" ? "the default branch's" : "none on the default branch"}${w.changed ? ", which this merge request changes" : ""}`);
          return 0;
        }
        if (sub === "post" && reviewForge === "gitlab") {
          const dir = str(flags, "dir");
          if (!dir) throw new ConfigError("review post needs --dir <dir>");
          const at = resolve(cwd, dir);
          const posted = await postGitLabReview({ dir: at, read: (name) => (existsSync(join(at, name)) ? readFileSync(join(at, name), "utf-8") : "") });
          console.log(`terragucci review: ${posted.reason}`);
          return posted.posted ? 0 : 1;
        }
        if (sub === "prompt") {
          const report = resolve(cwd, str(flags, "report") ?? "terragucci-report");
          // The review workflow's event names the pull request; its plan report comes from the pipeline's run of the head.
          let event: unknown;
          try {
            event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf-8"));
          } catch (e) {
            throw new ConfigError(`review prompt reads the pull request from the event file, and could not (${(e as Error).message})`);
          }
          const f = forgeCalls(process.env);
          const { subject, run } = await reviewSubject(event, f);
          console.log(`terragucci review: ${await fetchPlanReport(f, artifactBytes(process.env), subject, run, report)}`);
          const w = writeReviewPrompt({ report, instructions: str(flags, "instructions") ?? REVIEW_INSTRUCTIONS, pull: subject });
          console.log(`terragucci review: wrote the prompt for pull request ${w.pr} at ${w.head.slice(0, 8)}; instructions: ${w.instructions === "default" ? "the default branch's" : "none on the default branch"}${w.changed ? ", which this pull request changes" : ""}`);
          return 0;
        }
        if (sub === "post") {
          const dir = str(flags, "dir");
          if (!dir) throw new ConfigError("review post needs --dir <dir>");
          const posted = await postReview({ dir: resolve(cwd, dir) });
          console.log(`terragucci review: ${posted.reason}`);
          return 0;
        }
        throw new ConfigError("review is review prompt --report <dir> [--instructions <path>] or review post --dir <dir>");
      }
      case "approval-status": {
        const forge = str(flags, "forge") ?? "github";
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("approval-status's --forge is github or forgejo");
        const report = str(flags, "report");
        const posted = await approvalStatus({ forge, ...(report ? { report: resolve(cwd, report) } : {}) });
        console.log(`terragucci approval-status: ${posted.state}: ${posted.description}`);
        return 0;
      }
      case "rollout": {
        const result = await rollout(cwd, rolloutArgs(args, flags));
        const code = rolloutExit(result);
        if (json) return emit(envelope("rollout", code, result));
        console.log(describeRollout(result));
        return code;
      }
      case "profiles": {
        const path = str(flags, "config") ?? findConfig(cwd);
        console.log(profilesFor(path ? await loadConfig(resolve(path)) : {}, path ? undefined : cwd).join(" "));
        return 0;
      }
      case "config": {
        if (args[0] !== "check") throw new ConfigError("usage: terragucci config check [--config <file>] [--json]");
        const path = str(flags, "config") ?? findConfig(cwd);
        if (!path) throw new ConfigError("no terragucci config here; pass --config <file>");
        let problems: string[] = [];
        let warnings: string[] = [];
        let access: StateAccess | undefined;
        let approval: ApprovalMode | undefined;
        try {
          const config = await loadConfig(resolve(path), "check");
          // What passed config.ts must pass the published schema too, so an editor never flags a config that checks.
          const schema = configSchemaProblems(config);
          if (schema.length) throw new ConfigError(`${path} does not match terragucci.schema.json`, schema.map((p) => `${p} (terragucci.schema.json)`));
          // Which state each role reaches, read from the roots' code, and a warning for each that reaches another environment's.
          const repoDir = dirname(resolve(path));
          // The shape detection finds in the repo refuses what init would: the same table, worded for that shape.
          const shape = config.projects ? undefined : detectShape(repoDir, resolveRepo(config));
          if (shape) problems.push(...shape.problems("config"));
          // Each cloud whose identities are given by root glob: AWS roles, GCP service accounts, Azure clients.
          const oidc = config.oidc;
          const clouds = !oidc ? [] : (["aws", "gcp", "azure"] as const).filter((c) => (c === "aws" ? oidc.roles : oidc[c]?.roles));
          if (shape && problems.length === 0 && oidc && clouds.length > 0 && (shape.kind === "atmos" || shape.engine === "per-root")) {
            // An Atmos repo's roots are its instances, <stack>/<component>, so a glob such as prod/* gives a stack its roles.
            const instances = shape.kind === "atmos" ? atmosInstances(await describeStacks(repoDir)) : undefined;
            const roots = instances ? instances.map((i) => i.path) : findRoots(repoDir, config.roots);
            const known = instances ? { ...instanceStates(instances), via: "!terraform.state" } : undefined;
            const each = clouds.map((c) => stateAccess(repoDir, roots, oidc, known, c));
            access = { roles: each.flatMap((a) => a.roles), warnings: each.flatMap((a) => a.warnings) };
            warnings = access.warnings;
          }
          // A state the roots' code does not address can't order a reader after its writer: say which.
          if (shape && problems.length === 0 && shape.engine === "per-root" && shape.kind !== "atmos") warnings.push(...addressWarnings(repoDir, findRoots(repoDir, config.roots)));
          if (!config.projects && config.terragrunt?.credentials) warnings.push(...credentialWarnings(config.terragrunt.credentials));
          // The approval mode this checkout holds, and where it comes from; a wave reads it at base.
          approval = checkoutApproval(dirname(resolve(path)), config);
          // A repo's forge, when the config does not name it, is the one init would detect.
          // Migrations need a generated pipeline whose apply jobs may write chant/lifecycle.
          problems.push(...migrationPipelineProblems(dirname(resolve(path))));
          if (!config.forge && (config.apply?.when === "pull-request" || config.agent?.comment || config.review?.agent) && detectForge(dirname(resolve(path)))?.value === "gitlab") {
            problems.push(...gitlabPrApplyProblems(config as Record<string, unknown>, "config"));
          }
        } catch (e) {
          if (!(e instanceof ConfigError)) throw e;
          problems = e.problems ?? [e.message];
        }
        const file = relative(cwd, resolve(path)) || path;
        if (json) return emit(envelope("config check", problems.length ? 2 : 0, { file, ok: problems.length === 0, problems, ...(warnings.length ? { warnings } : {}), ...(access && problems.length === 0 ? { state_access: access.roles } : {}), ...(approval && problems.length === 0 ? { approval } : {}) }));
        if (problems.length === 0) {
          console.log(`${file}: ok`);
          if (approval) console.log(`approval: ${approval.mode} (${approval.source})${approval.note ? `\nnote: ${approval.note}` : ""}`);
          if (access) {
            console.log("state access:");
            for (const r of access.roles) console.log(`  ${r.role} (${r.cloud ? `${r.cloud}, ` : ""}${r.stage}, ${r.environment}): ${r.states.length ? r.states.join(", ") : "no state named in code"}${r.reads.length ? `; reads ${r.reads.join(", ")}` : ""}`);
          }
        } else console.error(`${file}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
        if (warnings.length) console.error(`${file}: ${warnings.length} warning(s)\n  ${warnings.join("\n  ")}`);
        return problems.length ? 2 : 0;
      }
      case "":
      case "help":
      case "--help":
        console.log(USAGE);
        return cmd === "" ? 2 : 0;
      default:
        console.error(`unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof RenderError || e instanceof StoreError) {
      if (json) return emit(envelope(cmd === "config" ? "config check" : cmd, 2, null, e.message));
      console.error(`terragucci: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

/** Run when this file is the program, however it was reached (npm links bins through symlinks). */
function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  // Exit once stdout and stderr have flushed: on a pipe, writes are queued, and
  // exiting straight away cuts the output off at 64 KB.
  main(process.argv.slice(2)).then((code) => {
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
}
