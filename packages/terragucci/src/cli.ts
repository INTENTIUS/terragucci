/**
 * The terragucci command.
 *
 *   terragucci init [--forge f] [--binary b] [--approval ledger|pr-review|sealed] [--signer <principal>] [--force] [--dry-run]
 *   terragucci reconcile --config <file> [--mode dry-run|apply] [--project <key>]
 *   terragucci estate [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket s3://<b>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
 *   terragucci plan [--root <glob>] [--project <key>] [--config <file>]
 *   terragucci publish [--dry-run] [--config <file>]
 *   terragucci stage tf-plan|tf-drift [--root <glob>] [--project <key>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket s3://<b>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>]
 *   terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>] [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>]
 *   terragucci check-root <dir> [--binary <b>]
 *   terragucci check-policy [--config <file>] [--base <ref>]
 *   terragucci install tofu|terraform|terragrunt|choudoufu <version>   (Linux builds, for a CI job)
 *   terragucci auth-provider   (Terragrunt's auth-provider-cmd, run by the generated pipeline)
 *   terragucci rollout <module> [<version>] [--from v] [--mode dry-run|apply] [--config <file>]
 *   terragucci rollout --provider <address> <version> [--from v] [--mode dry-run|apply]
 *   terragucci profiles --config <file>
 *   terragucci config check [--config <file>]
  terragucci approve [wave-<k>] [--sign [<key>]] [--actor <name>] [--dry-run]
 *   terragucci approve [wave-<k>] [--sign [<key>]] [--actor <name>] [--dry-run]   (approve a waiting wave's digest with chant approve)
 *   terragucci respond <event> [--mode dry-run|apply] [event flags]
 *   terragucci comment --layers <a,b;c> --out <file> [--forge forgejo] [--agent off|on]   (read a `/terragucci plan [root]` comment; run by the generated pipeline)
 *   terragucci comment --forge gitlab --poll --layers <a,b;c>   (answer the `/terragucci` merge request notes since the last polls; run by the comments schedule's job)
 *   terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge forgejo]   (read a `/terragucci agent <ask>` comment)
 *   terragucci comment --agent push --change <dir> [--policy-dir <dir>]   (push the agent's change to the pull request's head branch)
 *   terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]   (locks: plan: lock the roots a pull request's head reaches, or release them; run by the generated pipeline)
 *   terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]
  terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo] [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]   (read a `/terragucci apply [wave-<n>]`, `/terragucci lock` or `/terragucci unlock` comment; run by the generated pipeline)
 *   terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo]   (merge a pull request applied before merge, with apply.merge: auto; run by the generated pipeline)
 *   terragucci approval-status [--forge github|forgejo] [--report <dir>]   (post terragucci/approval on a pull request's head, with approval: pr-review; run by the generated pipeline)
 *
 * `--json` on init, reconcile, plan, stage, rollout and config check prints one envelope
 * (see envelope.ts) instead of text.
 *
 * Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or
 * config error; 3 waiting on an approval; 4 a wave's plans changed after
 * its approval, so it applied nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLY_REQUIRES, APPROVALS, BINARIES, checkMode, ConfigError, FORGES, findConfig, forgeFromHost, NO_GITLAB_PR_APPLY, loadConfig, parseProjectKey, resolveRepo, responseTo, type ApplyRequire, type Approval, type Binary, type ForgeName, type Gate, type ProjectSettings, type TerragucciConfig } from "./config";
import { checkoutApproval, type ApprovalMode } from "./approval";
import { decideComment, writeDecision } from "./comment";
import { pollGitLabComments } from "./comment-gitlab";
import { approvalStatus } from "./review";
import { approve } from "./approve";
import { decideApplyComment, decidePlanLock, mergePullRequest } from "./comment-apply";
import { pushAgentChange, writePrompt } from "./agent-comment";
import { detectForge } from "./detect";
import { envelope, ENVELOPE_COMMANDS, type Envelope } from "./envelope";
import { describeInit, init, initJson } from "./init";
import { assertLinux, install, type Tool } from "./install";
import { plan } from "./plan";
import { describePublish, publish } from "./publish";
import { describeReconcile, reconcile } from "./reconcile";
import { describeEstate, estate } from "./estate";
import { RenderError } from "./render";
import { applyWave } from "./apply";
import { checkPolicyTests, checkRoot, emitCheck } from "./check";
import { authProviderOutput } from "./terragrunt";
import { renderText } from "./report/views";
import { parseLayers, runStage } from "./report/stage";
import { S3Error } from "./report/s3";
import { describeRollout, rollout, rolloutArgs, rolloutExit } from "./rollout";
import { respond } from "./respond";
import { parseImport } from "./respond/drift";

const USAGE = `usage:
  terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform|choudoufu] [--approval ledger|pr-review|sealed] [--signer <principal>] [--force] [--dry-run]
  terragucci reconcile --config <file> [--mode dry-run|apply] [--project <host/path>]
  terragucci estate [--config <file>] [--out <dir>] [--link-hours <n>] [--bucket s3://<b>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
  terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
  terragucci publish [--dry-run] [--config <file>]
  terragucci stage tf-plan|tf-drift [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket s3://<b>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>]
  terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>] [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>]
  terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
  terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
  terragucci check-root <dir> [--binary <b>]
  terragucci check-policy [--config <file>] [--base <ref>]
  terragucci install tofu|terraform|terragrunt|choudoufu <version>   (Linux builds, for a CI job)
  terragucci auth-provider   (internal: Terragrunt's auth-provider-cmd, run by the generated pipeline)
  terragucci profiles --config <file>
  terragucci config check [--config <file>]
  terragucci comment --layers <a,b;c> --out <file> [--forge github|forgejo] [--agent off|on]
  terragucci comment --forge gitlab --poll --layers <a,b;c>
  terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge github|forgejo]
  terragucci comment --agent push --change <dir> [--policy-dir <dir>]
  terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo] [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]
  terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo]
  terragucci approval-status [--forge github|forgejo] [--report <dir>]
  terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|version-bump|description [--mode dry-run|apply] [flags]

Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or config error; 3 waiting on an approval; 4 a wave's plans changed after its approval, so it applied nothing.

init, reconcile, plan, stage, rollout, respond and config check take --json: one envelope on stdout.

Docs: https://intentius.io/terragucci/`;

/** `--approval`: one of APPROVALS, or undefined when not given. */
function approvalFlag(v: string | undefined): Approval | undefined {
  if (v !== undefined && !(APPROVALS as readonly string[]).includes(v)) throw new ConfigError(`--approval must be one of ${APPROVALS.join(", ")}`);
  return v as Approval | undefined;
}

/** `--parallelism`: a whole number of 1 or more. */
function parallelismFlag(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`--parallelism is ${JSON.stringify(v)}; use a whole number of 1 or more`);
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
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && !["force", "dry-run", "json", "terragrunt", "rest", "again", "poll"].includes(k)) flags[k] = rest[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { cmd, flags, args };
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
          ...(str(flags, "base") ? { base: str(flags, "base") } : {}),
          ...(str(flags, "parallelism") ? { parallelism: parallelismFlag(str(flags, "parallelism")!) } : {}),
          ...(str(flags, "bucket")
            ? { reports: { bucket: str(flags, "bucket")!, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}), ...(str(flags, "bucket-url") ? { url: str(flags, "bucket-url") } : {}) } }
            : {}),
        }, json ? () => {} : console.error);
        const code = result.failed ? 1 : 0;
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
        if (!dir) throw new ConfigError("usage: terragucci check-root <dir> [--binary <b>]");
        const result = await checkRoot(str(flags, "binary") ?? "tofu", dir, cwd);
        emitCheck(cwd, result);
        return result.ok ? 0 : 1;
      }
      case "check-policy": {
        // tf-check's policy step: the policy's own tests, when `policy:` is set.
        const result = await checkPolicyTests(cwd, { ...(str(flags, "config") ? { config: str(flags, "config") } : {}), ...(str(flags, "base") ? { base: str(flags, "base") } : {}) });
        emitCheck(cwd, result);
        return result.ok ? 0 : 1;
      }
      case "auth-provider": {
        // Terragrunt runs this in each unit's directory and reads the credentials it prints.
        console.log(JSON.stringify(authProviderOutput(cwd, process.env)));
        return 0;
      }
      case "install": {
        const [tool, version] = args;
        if (!tool || !version || !["tofu", "terraform", "terragrunt", "choudoufu"].includes(tool)) {
          throw new ConfigError("usage: terragucci install tofu|terraform|terragrunt|choudoufu <version>");
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
        return 0;
      }
      case "respond": {
        const event = args[0] ?? "";
        const path = str(flags, "config") ?? findConfig(cwd);
        if (event === "rollout" && responseTo(resolveRepo(path ? await loadConfig(resolve(path)) : {}), "rollout") !== "off") return main(["rollout", ...argv.slice(argv.indexOf("rollout") + 1)]);
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
        if (json) return emit(envelope("respond", 0, result));
        console.log(result.text);
        return 0;
      }
      case "comment": {
        const layers = str(flags, "layers");
        const out = str(flags, "out");
        const forge = str(flags, "forge") ?? "github";
        const agent = str(flags, "agent") ?? "off";
        const policyDir = str(flags, "policy-dir") ?? "policy";
        if (!["off", "on", "run", "push"].includes(agent)) throw new ConfigError("comment's --agent is off, on, run or push");
        if (flags.poll === true || forge === "gitlab") {
          // GitLab: no event file, so the comments schedule's job polls the merge requests' notes.
          if (forge !== "gitlab" || flags.poll !== true) throw new ConfigError("comment --poll is GitLab's: run it as comment --forge gitlab --poll --layers <a,b;c>");
          if (!layers) throw new ConfigError("comment --forge gitlab --poll needs --layers <a,b;c>");
          const poll = await pollGitLabComments({ layers: parseLayers(layers) });
          for (const n of poll.outcomes) console.log(`terragucci comment: !${n.mr} note ${n.note}: ${n.ran ? "" : "nothing run: "}${n.reason}`);
          if (poll.outcomes.length === 0 && !poll.fail) console.log("terragucci comment: no new /terragucci notes");
          if (poll.fail) console.error(`terragucci comment: failed: ${poll.fail}`);
          return poll.fail || poll.outcomes.some((n) => n.fail) ? 1 : 0;
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
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("comment-apply's --forge is github or forgejo");
        if (when !== "merge" && when !== "pull-request") throw new ConfigError("comment-apply's --when is merge or pull-request");
        const requiresFlag = str(flags, "requires");
        const requires = requiresFlag === undefined ? undefined : requiresFlag === "none" ? [] : requiresFlag.split(",");
        if (requires?.some((r) => !(APPLY_REQUIRES as readonly string[]).includes(r))) throw new ConfigError(`comment-apply's --requires is a comma-separated list of ${APPLY_REQUIRES.join(", ")}, or none`);
        const decision = await decideApplyComment({ layers: parseLayers(layers), forge, when, ...(canary ? { canary: canary.split(",") } : {}), ...(requires ? { requires: requires as ApplyRequire[] } : {}), ...(flags.terragrunt === true ? { terragrunt: true } : {}), ...(flags.again === true ? { again: true } : {}) });
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
        if (forge !== "github" && forge !== "forgejo") throw new ConfigError("pr-merge's --forge is github or forgejo");
        try {
          console.log(`terragucci pr-merge: ${await mergePullRequest({ pr, sha, forge })}`);
          return 0;
        } catch (e) {
          if (e instanceof ConfigError) throw e;
          console.error(`terragucci pr-merge: not merged: ${(e as Error).message}`);
          return 1;
        }
      }
      case "approve": {
        const sign = flags.sign === true ? true : str(flags, "sign");
        const done = await approve(cwd, { ...(args[0] ? { wave: args[0] } : {}), ...(sign !== undefined ? { sign } : {}), ...(str(flags, "actor") ? { actor: str(flags, "actor") } : {}), dryRun: flags["dry-run"] === true });
        return done.code;
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
        let approval: ApprovalMode | undefined;
        try {
          const config = await loadConfig(resolve(path), "check");
          // The approval mode this checkout holds, and where it comes from; a wave reads it at base.
          approval = checkoutApproval(dirname(resolve(path)), config);
          // A repo's forge, when the config does not name it, is the one init would detect.
          if (config.apply?.when === "pull-request" && !config.forge && detectForge(dirname(resolve(path)))?.value === "gitlab") {
            problems.push(`apply.when: ${NO_GITLAB_PR_APPLY}`);
          }
        } catch (e) {
          if (!(e instanceof ConfigError)) throw e;
          problems = e.problems ?? [e.message];
        }
        const file = relative(cwd, resolve(path)) || path;
        if (json) return emit(envelope("config check", problems.length ? 2 : 0, { file, ok: problems.length === 0, problems, ...(approval && problems.length === 0 ? { approval } : {}) }));
        if (problems.length === 0) {
          console.log(`${file}: ok`);
          if (approval) console.log(`approval: ${approval.mode} (${approval.source})${approval.note ? `\nnote: ${approval.note}` : ""}`);
        } else console.error(`${file}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
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
    if (e instanceof ConfigError || e instanceof RenderError || e instanceof S3Error) {
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
