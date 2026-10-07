/**
 * `terragucci plan`: plan roots on this machine, in apply order. `--root`
 * narrows to roots matching a glob; `--project` reads a control repo's
 * settings for the project this checkout belongs to. In a Terragrunt repo the
 * roots are its units, each planned with its own `terragrunt plan`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { binaryEnv } from "./binary-env";
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, type Binary } from "./config";
import { applyLayers, detectBinary, findRoots, globMatch } from "./detect";
import { detectTerragrunt, discoverUnits } from "./terragrunt";

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

/** The roots a plan covers, in apply order. */
export async function planTargets(repo: string, options: PlanOptions): Promise<{ binary: Binary; roots: string[]; terragrunt?: boolean }> {
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  const terragrunt = detectTerragrunt(repo) !== undefined;
  const binary = settings.binary ?? detectBinary(repo, []).value;
  const all = terragrunt ? (await discoverUnits(repo, { exclude: settings.terragrunt?.exclude, binary })).units.map((u) => u.path) : findRoots(repo, settings.roots);
  const ordered = terragrunt ? all : applyLayers(repo, all).flat();
  const roots = options.root ? ordered.filter((r) => globMatch(options.root!, r)) : ordered;
  if (roots.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  return { binary: terragrunt ? binary : settings.binary ?? detectBinary(repo, all).value, roots, ...(terragrunt ? { terragrunt } : {}) };
}

function run(binary: string, dir: string, terragrunt: boolean, ...args: string[]) {
  return terragrunt
    ? spawnSync(process.env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt", ["--working-dir", dir, "--non-interactive", "--no-color", ...args], { encoding: "utf-8", env: binaryEnv({ ...process.env, TG_TF_PATH: binary }) })
    : spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", env: binaryEnv(process.env) });
}

export async function plan(repo: string, options: PlanOptions, out: (line: string) => void = console.log): Promise<RootPlan[]> {
  const { binary, roots, terragrunt = false } = await planTargets(repo, options);
  const results: RootPlan[] = [];
  for (const root of roots) {
    const dir = join(repo, root);
    // Terragrunt runs init itself, with mock outputs where a unit allows them for plan.
    const init = terragrunt ? { status: 0, stderr: "", stdout: "" } : run(binary, dir, false, "init", "-input=false", "-no-color");
    if (init.status !== 0) {
      results.push({ root, ok: false, summary: `init failed: ${(init.stderr || init.stdout).trim().split("\n").pop()}` });
      out(`${root}: init failed`);
      out((init.stderr || init.stdout).trim());
      continue;
    }
    const p = run(binary, dir, terragrunt, "plan", "-input=false", "-no-color");
    const text = `${p.stdout}${p.stderr}`;
    const summary = text.match(/Plan: .*|No changes\..*/)?.[0] ?? (p.status === 0 ? "planned" : "failed");
    results.push({ root, ok: p.status === 0, summary });
    out(`${root}: ${summary}`);
    if (p.status !== 0) out(text.trim());
  }
  return results;
}
