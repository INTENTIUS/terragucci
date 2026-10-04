/**
 * The terragucci command.
 *
 *   terragucci init [--forge f] [--binary b] [--force] [--dry-run]
 *   terragucci reconcile --config <file> [--mode dry-run|apply] [--project <key>]
 *   terragucci plan [--root <glob>] [--project <key>] [--config <file>]
 *   terragucci publish [--dry-run] [--config <file>]
 *   terragucci stage tf-plan [--root <glob>] [--project <key>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket s3://<b>] [--terragrunt] [--base <ref>]
 *   terragucci auth-provider   (Terragrunt's auth-provider-cmd, run by the generated pipeline)
 *   terragucci rollout <module> [<version>] [--from v] [--mode dry-run|apply] [--config <file>]
 *   terragucci rollout --provider <address> <version> [--from v] [--mode dry-run|apply]
 *   terragucci profiles --config <file>
 *   terragucci config check [--config <file>]
 *   terragucci respond <event> [--mode dry-run|apply] [event flags]
 *
 * `--json` on init, reconcile, plan, stage, rollout and config check prints one envelope
 * (see envelope.ts) instead of text.
 *
 * Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or
 * config error; 3 waiting on an approval.
 */
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BINARIES, ConfigError, FORGES, findConfig, forgeFromHost, loadConfig, parseProjectKey, resolveRepo, responseTo, type Binary, type ForgeName, type ProjectSettings, type TerragucciConfig } from "./config";
import { detectForge } from "./detect";
import { envelope, ENVELOPE_COMMANDS, type Envelope } from "./envelope";
import { describeInit, init, initJson } from "./init";
import { install, type Tool } from "./install";
import { plan } from "./plan";
import { describePublish, publish } from "./publish";
import { describeReconcile, reconcile } from "./reconcile";
import { RenderError } from "./render";
import { authProviderOutput } from "./terragrunt";
import { renderText } from "./report/views";
import { parseLayers, runStage } from "./report/stage";
import { S3Error } from "./report/s3";
import { describeRollout, rollout, rolloutArgs, rolloutExit } from "./rollout";
import { respond } from "./respond";
import { parseImport } from "./respond/drift";

const USAGE = `usage:
  terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform] [--force] [--dry-run]
  terragucci reconcile --config <file> [--mode dry-run|apply] [--project <host/path>]
  terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
  terragucci publish [--dry-run] [--config <file>]
  terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>] [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--bucket s3://<b>] [--terragrunt] [--base <ref>]
  terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
  terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
  terragucci install tofu|terraform|terragrunt <version>
  terragucci profiles --config <file>
  terragucci config check [--config <file>]
  terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|question [--mode dry-run|apply] [flags]

init, reconcile, plan, stage, rollout, respond and config check take --json: one envelope on stdout.

Docs: https://intentius.io/terragucci/`;

function parse(argv: string[]): { cmd: string; flags: Record<string, string | true>; args: string[] } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && !["force", "dry-run", "json", "terragrunt"].includes(k)) flags[k] = rest[++i];
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

/** The validation stack's profiles a config needs: floci, one per forge it names, and fountain if a project runs there. */
export function profilesFor(config: TerragucciConfig, repo?: string): string[] {
  const out = new Set<string>(["aws"]);
  const projects = config.projects
    ? Object.entries(config.projects).map(([key, s]) => ({ host: parseProjectKey(key).host, s: { ...config.defaults, ...s } }))
    : [{ host: undefined, s: config as ProjectSettings }];
  for (const { host, s } of projects) {
    const forge = s.forge ?? (host ? forgeFromHost(host) : repo ? detectForge(repo)?.value : undefined);
    if (forge) out.add(forge);
    if (s.runtime === "fountain") out.add("fountain");
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
        const result = await init(cwd, { forge: forge as ForgeName, binary: binary as Binary, force: flags.force === true, dryRun: flags["dry-run"] === true });
        if (json) return emit(envelope("init", 0, initJson(cwd, result, flags["dry-run"] === true)));
        console.log(describeInit(cwd, result, flags["dry-run"] === true));
        if (flags["dry-run"] === true) console.log("dry run: nothing was written");
        return 0;
      }
      case "reconcile": {
        const path = str(flags, "config") ?? findConfig(cwd);
        if (!path) throw new ConfigError("reconcile needs --config <file>");
        const mode = (str(flags, "mode") ?? "dry-run") as "dry-run" | "apply";
        if (mode !== "dry-run" && mode !== "apply") throw new ConfigError("--mode must be dry-run or apply");
        const outcomes = await reconcile(await loadConfig(resolve(path)), { mode, project: str(flags, "project") });
        const code = outcomes.some((o) => o.status === "failed") ? 1 : 0;
        if (json) return emit(envelope("reconcile", code, { mode, projects: outcomes }));
        console.log(describeReconcile(outcomes, mode));
        return code;
      }
      case "plan": {
        const results = await plan(cwd, { root: str(flags, "root"), project: str(flags, "project"), config: str(flags, "config") }, json ? () => {} : console.log);
        const code = results.every((r) => r.ok) ? 0 : 1;
        return json ? emit(envelope("plan", code, { roots: results })) : code;
      }
      case "stage": {
        const result = await runStage(args[0] ?? "", cwd, {
          root: str(flags, "root"), project: str(flags, "project"), config: str(flags, "config"),
          out: str(flags, "out"), reportUrl: str(flags, "report-url"),
          ...(str(flags, "layers") ? { layers: parseLayers(str(flags, "layers")!) } : {}),
          ...(str(flags, "binary") ? { binary: str(flags, "binary") } : {}),
          ...(str(flags, "canary") ? { canary: str(flags, "canary")!.split(",").filter(Boolean) } : {}),
          ...(flags.terragrunt === true ? { terragrunt: true } : {}),
          ...(str(flags, "base") ? { base: str(flags, "base") } : {}),
          ...(str(flags, "bucket")
            ? { reports: { bucket: str(flags, "bucket")!, ...(str(flags, "bucket-endpoint") ? { endpoint: str(flags, "bucket-endpoint") } : {}), ...(str(flags, "bucket-prefix") ? { prefix: str(flags, "bucket-prefix") } : {}) } }
            : {}),
        }, json ? () => {} : console.error);
        const code = result.failed ? 1 : 0;
        const files = { html: `${result.dir}/report.html`, json: `${result.dir}/report.json`, note: `${result.dir}/note.md` };
        if (json) return emit(envelope("stage", code, { stage: args[0], change_set: result.report.change_set, files, uploaded: result.uploaded ?? null }));
        console.log(renderText(result.report));
        console.log(`report: ${relative(cwd, files.html) || files.html}`);
        if (result.uploaded) console.log(`copied to the bucket under ${result.uploaded.prefix}; index rewritten at ${result.uploaded.indexes.join(" and ")}`);
        return code;
      }
      case "auth-provider": {
        // Terragrunt runs this in each unit's directory and reads the credentials it prints.
        console.log(JSON.stringify(authProviderOutput(cwd, process.env)));
        return 0;
      }
      case "install": {
        const [tool, version] = args;
        if (!tool || !version || !["tofu", "terraform", "terragrunt"].includes(tool)) {
          throw new ConfigError("usage: terragucci install tofu|terraform|terragrunt <version>");
        }
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
          ...Object.fromEntries(["config", "project", "out", "report", "approved", "current", "root", "binary", "branch", "module", "version", "question"].map((k) => [k, s(k)])),
          mode: (s("mode") ?? "dry-run") as "dry-run",
          ...(s("wave") ? { wave: Number(s("wave")) } : {}),
          ...(log ? { log: readFileSync(log === "-" ? 0 : resolve(cwd, log), "utf-8") } : {}),
          ...(s("platform") ? { platforms: s("platform")!.split(",") } : {}),
          imports: argv.flatMap((a, i) => (a === "--import" ? [argv[i + 1] ?? ""] : a.startsWith("--import=") ? [a.slice(9)] : [])).map(parseImport),
        });
        if (json) return emit(envelope("respond", 0, result));
        console.log(result.text + (result.agent_input ? `\nagent input: ${relative(cwd, result.agent_input)}` : ""));
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
        try {
          await loadConfig(resolve(path), "check");
        } catch (e) {
          if (!(e instanceof ConfigError)) throw e;
          problems = e.problems ?? [e.message];
        }
        const file = relative(cwd, resolve(path)) || path;
        if (json) return emit(envelope("config check", problems.length ? 2 : 0, { file, ok: problems.length === 0, problems }));
        if (problems.length === 0) console.log(`${file}: ok`);
        else console.error(`${file}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
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
      if (json) return emit(envelope(cmd, 2, null, e.message));
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
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
