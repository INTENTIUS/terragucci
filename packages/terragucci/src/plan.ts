/**
 * `terragucci plan`: plan roots on this machine, in apply order. `--root`
 * narrows to roots matching a glob; `--project` reads a control repo's
 * settings for the project this checkout belongs to. In a Terragrunt repo the
 * roots are its units, each planned with its own `terragrunt plan`; in an
 * Atmos repo they are its written instances, each in its own workspace.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runBinary, terragruntExec } from "./binary-env";
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, type Binary } from "./config";
import { globMatch } from "./detect";
import { detectShape, type RootInit, type Shape } from "./shape";

export interface PlanOptions {
  root?: string;
  project?: string;
  config?: string;
}

export interface RootPlan {
  root: string;
  ok: boolean;
  summary: string;
}

/** The roots a plan covers, in apply order, and the repo's shape, which says how each runs. */
export async function planTargets(repo: string, options: PlanOptions): Promise<{ binary: Binary; roots: string[]; terragrunt?: boolean; shape: Shape }> {
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  const shape = detectShape(repo, settings);
  const terragrunt = shape.engine === "terragrunt";
  const binary = settings.binary ?? shape.binary().value;
  const found = await shape.discover({ binary });
  // A Terragrunt repo's units in discovery's order; Terragrunt plans each against its dependencies' mock outputs.
  const ordered = terragrunt ? found.roots.map((r) => r.root) : found.layers.flat();
  const roots = options.root ? ordered.filter((r) => globMatch(options.root!, r)) : ordered;
  if (roots.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  // The roots the shape's prepare writes are on disk only once it has run, as every job runs it.
  const unwritten = shape.prepare ? roots.filter((r) => !existsSync(join(repo, r))) : [];
  if (unwritten.length > 0) throw new ConfigError(`${unwritten.join(", ")} ${unwritten.length === 1 ? "is" : "are"} not on disk: ${shape.prepare} writes ${unwritten.length === 1 ? "it" : "them"}, so run it first`);
  return { binary: terragrunt ? binary : settings.binary ?? shape.binary(found.roots.map((r) => r.root)).value, roots, ...(terragrunt ? { terragrunt } : {}), shape };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The binary through the engine runner's `exec`, or Terragrunt through its Terragrunt runner, with the forge tokens left out. */
async function run(binary: string, dir: string, terragrunt: boolean, env: NodeJS.ProcessEnv, ...args: string[]): Promise<Run> {
  if (terragrunt) return terragruntExec(process.env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt", ["--working-dir", dir, "--non-interactive", "--no-color", ...args], { cwd: process.cwd(), env: { ...env, TG_TF_PATH: binary } });
  const r = await runBinary(binary, args, dir, env);
  return { code: r.code, stdout: r.stdout, stderr: `${r.stderr ?? ""}${r.error ?? ""}` };
}

/**
 * Init a root: in default, then its own workspace selected, when it names one
 * (an Atmos instance), so the plan reads that workspace's state.
 */
async function initRoot(binary: string, dir: string, ws: RootInit): Promise<Run> {
  const init = await run(binary, dir, false, ws?.init ?? process.env, "init", "-input=false", "-no-color");
  if (init.code !== 0 || !ws) return init;
  return run(binary, dir, false, ws.selectEnv, ...ws.select);
}

export async function plan(repo: string, options: PlanOptions, out: (line: string) => void = console.log): Promise<RootPlan[]> {
  const { binary, roots, terragrunt = false, shape } = await planTargets(repo, options);
  const results: RootPlan[] = [];
  for (const root of roots) {
    const dir = join(repo, root);
    // Terragrunt runs init itself, with mock outputs where a unit allows them for plan.
    const init = terragrunt ? { code: 0, stderr: "", stdout: "" } : await initRoot(binary, dir, shape.rootInit(root, process.env));
    if (init.code !== 0) {
      results.push({ root, ok: false, summary: `init failed: ${(init.stderr || init.stdout).trim().split("\n").pop()}` });
      out(`${root}: init failed`);
      out((init.stderr || init.stdout).trim());
      continue;
    }
    const p = await run(binary, dir, terragrunt, shape.rootEnv(root, process.env), "plan", "-input=false", "-no-color");
    const text = `${p.stdout}${p.stderr}`;
    const summary = text.match(/Plan: .*|No changes\..*/)?.[0] ?? (p.code === 0 ? "planned" : "failed");
    results.push({ root, ok: p.code === 0, summary });
    out(`${root}: ${summary}`);
    if (p.code !== 0) out(text.trim());
  }
  return results;
}
