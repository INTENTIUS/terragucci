/**
 * The terragucci command.
 *
 *   terragucci init [--forge f] [--binary b] [--force] [--dry-run]
 *   terragucci reconcile --config <file> [--mode dry-run|apply] [--project <key>]
 *   terragucci plan [--root <glob>] [--project <key>] [--config <file>]
 *   terragucci rollout <module> <version>
 *   terragucci profiles --config <file>
 *
 * Exit codes: 0 done; 1 one or more projects or roots failed; 2 a usage or
 * config error; 3 waiting on an approval.
 */
import { resolve } from "node:path";
import { BINARIES, ConfigError, FORGES, findConfig, forgeFromHost, loadConfig, parseProjectKey, type Binary, type ForgeName, type ProjectSettings, type TerragucciConfig } from "./config";
import { detectForge } from "./detect";
import { describeInit, init } from "./init";
import { plan } from "./plan";
import { describeReconcile, reconcile } from "./reconcile";
import { RenderError } from "./render";

const USAGE = `usage:
  terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform] [--force] [--dry-run]
  terragucci reconcile --config <file> [--mode dry-run|apply] [--project <host/path>]
  terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
  terragucci rollout <module> <version>
  terragucci profiles --config <file>

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
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && !["force", "dry-run"].includes(k)) flags[k] = rest[++i];
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
  try {
    switch (cmd) {
      case "init": {
        const forge = str(flags, "forge");
        const binary = str(flags, "binary");
        if (forge && !FORGES.includes(forge as ForgeName)) throw new ConfigError(`--forge must be one of ${FORGES.join(", ")}`);
        if (binary && !BINARIES.includes(binary as Binary)) throw new ConfigError(`--binary must be one of ${BINARIES.join(", ")}`);
        const result = await init(cwd, { forge: forge as ForgeName, binary: binary as Binary, force: flags.force === true, dryRun: flags["dry-run"] === true });
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
        console.log(describeReconcile(outcomes, mode));
        return outcomes.some((o) => o.status === "failed") ? 1 : 0;
      }
      case "plan": {
        const results = await plan(cwd, { root: str(flags, "root"), project: str(flags, "project"), config: str(flags, "config") });
        return results.every((r) => r.ok) ? 0 : 1;
      }
      case "rollout":
        console.error("terragucci rollout is not available yet. https://intentius.io/terragucci/status/ says what is.");
        return 2;
      case "profiles": {
        const path = str(flags, "config") ?? findConfig(cwd);
        console.log(profilesFor(path ? await loadConfig(resolve(path)) : {}, path ? undefined : cwd).join(" "));
        return 0;
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
    if (e instanceof ConfigError || e instanceof RenderError) {
      console.error(`terragucci: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/src/cli.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
