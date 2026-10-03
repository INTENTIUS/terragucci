/**
 * `terragucci plan`: plan roots on this machine, in apply order. `--root`
 * narrows to roots matching a glob; `--project` reads a control repo's
 * settings for the project this checkout belongs to.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, type Binary } from "./config";
import { applyLayers, detectBinary, findRoots, globMatch } from "./detect";

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
export async function planTargets(repo: string, options: PlanOptions): Promise<{ binary: Binary; roots: string[] }> {
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  const all = findRoots(repo, settings.roots);
  const ordered = applyLayers(repo, all).flat();
  const roots = options.root ? ordered.filter((r) => globMatch(options.root!, r)) : ordered;
  if (roots.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  return { binary: settings.binary ?? detectBinary(repo, all).value, roots };
}

export async function plan(repo: string, options: PlanOptions, out: (line: string) => void = console.log): Promise<RootPlan[]> {
  const { binary, roots } = await planTargets(repo, options);
  const results: RootPlan[] = [];
  for (const root of roots) {
    const dir = join(repo, root);
    const init = spawnSync(binary, [`-chdir=${dir}`, "init", "-input=false", "-no-color"], { encoding: "utf-8" });
    if (init.status !== 0) {
      results.push({ root, ok: false, summary: `init failed: ${(init.stderr || init.stdout).trim().split("\n").pop()}` });
      out(`${root}: init failed`);
      out((init.stderr || init.stdout).trim());
      continue;
    }
    const p = spawnSync(binary, [`-chdir=${dir}`, "plan", "-input=false", "-no-color"], { encoding: "utf-8" });
    const text = `${p.stdout}${p.stderr}`;
    const summary = text.match(/Plan: .*|No changes\..*/)?.[0] ?? (p.status === 0 ? "planned" : "failed");
    results.push({ root, ok: p.status === 0, summary });
    out(`${root}: ${summary}`);
    if (p.status !== 0) out(text.trim());
  }
  return results;
}
