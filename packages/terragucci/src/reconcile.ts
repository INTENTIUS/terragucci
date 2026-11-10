/**
 * `terragucci reconcile`: from a control repo, bring every project's pipeline
 * in line with the config. A dry run (the default) says what each project's
 * pipeline would become. `--mode apply` pushes a branch to each project that
 * changes and opens a pull request there; it never writes a default branch.
 * One project failing does not stop the others.
 *
 * chant core holds reconcile (chant#4568): its `reconcileProjects` clones
 * each project, pushes the branch and opens or edits the pull request, and
 * terragucci's generator (its generated files, then init) writes the
 * pipeline, with its tips on a dry run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { reconcileProjects } from "@intentius/chant/ci-control";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { ConfigError, forgeFromHost, parseProjectKey, resolveProject, type ResolvedSettings, type TerragucciConfig } from "./config";
import { DEFAULT_TOKEN_ENV, defaultBranch, openPullRequest, type Fetch } from "./forge";
import { findRoots } from "./detect";
import { init, type FileChange } from "./init";
import { planGenerate, projectGenerate } from "./generate";
import { loadHclParser } from "./rollout/parser";
import type { ReportTip } from "./report/schema";
import { describeTips, repoTips } from "./tips";

export const BRANCH = "terragucci/pipeline";

export interface ReconcileOptions {
  mode: "dry-run" | "apply";
  /** Only this project key. */
  project?: string;
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
}

export interface ProjectOutcome {
  key: string;
  status: "unchanged" | "would-change" | "pull-request" | "failed";
  changes: FileChange[];
  pullRequest?: string;
  error?: string;
  /** Advice on the project's setup. Present on a dry run with tips on. */
  tips?: ReportTip[];
}

/** The git identity terragucci commits as, with commit signing off. */
export const IDENTITY = ["-c", "user.name=terragucci", "-c", "user.email=terragucci@users.noreply.intentius.io", "-c", "commit.gpgsign=false"];

/** Where a project is cloned from, and the origin its forge API answers on. */
export function where(key: string, url: string | undefined): { cloneUrl: string; origin: string } {
  const pk = parseProjectKey(key);
  if (!url) return { cloneUrl: `https://${pk.host}/${pk.path}.git`, origin: `https://${pk.host}` };
  // A local path or file:// URL is cloned as it is; the API is still the host's.
  if (url.startsWith("/") || url.startsWith("file://")) return { cloneUrl: url, origin: `https://${pk.host}` };
  const u = new URL(url);
  return { cloneUrl: url.endsWith(".git") ? url : `${url}.git`, origin: `${u.protocol}//${u.host}` };
}

/** The clone URL with the token in it, for an http(s) remote. */
export function withToken(cloneUrl: string, token: string | undefined): string {
  if (!token || !/^https?:\/\//.test(cloneUrl)) return cloneUrl;
  return cloneUrl.replace(/^(https?:\/\/)/, `$1oauth2:${encodeURIComponent(token)}@`);
}

function git(dir: string, args: string[], token?: string): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    throw new Error(token ? msg.split(token).join("***") : msg);
  }
}

async function tipsOf(dir: string, settings: ResolvedSettings): Promise<ReportTip[]> {
  try {
    const parser = await loadHclParser().catch(() => undefined);
    return await repoTips(dir, findRoots(dir, settings.roots), { settings, ...(parser ? { parser } : {}) });
  } catch {
    return [];
  }
}

/** The project's generated files, written into its clone; a file at a generated path that terragucci did not write fails the project. */
function writeGenerated(dir: string, settings: ResolvedSettings): FileChange[] {
  const plan = planGenerate(dir, settings);
  if (plan.foreign.length) throw new ConfigError(plan.foreign.join("; "));
  for (const f of plan.files) {
    if (f.status === "removed") unlinkSync(f.path);
    else if (f.status !== "unchanged") writeFileSync(f.path, f.content);
  }
  return plan.files;
}

export async function reconcile(config: TerragucciConfig, options: ReconcileOptions): Promise<ProjectOutcome[]> {
  if (!config.projects || Object.keys(config.projects).length === 0) {
    throw new ConfigError("reconcile needs a control repo config with projects; in a single repo, run terragucci init");
  }
  return reconcileWithChant(config, options);
}

/**
 * Reconcile through chant's `reconcileProjects` (chant#4568), with
 * terragucci's generator and words. Each project's settings are resolved
 * here, the defaults applied, and a project whose settings do not resolve
 * fails alone. The branch is `terragucci/pipeline` and
 * the token the one `token_env` names, else terragucci's default for the
 * forge.
 */
async function reconcileWithChant(config: TerragucciConfig, options: ReconcileOptions): Promise<ProjectOutcome[]> {
  const keys = options.project ? [options.project] : Object.keys(config.projects!);
  const failed = new Map<string, string>();
  const resolved = new Map<string, ResolvedSettings>();
  const projects: Parameters<typeof reconcileProjects>[0][number][] = [];
  for (const key of keys) {
    try {
      const settings = resolveProject(config, key);
      const pk = parseProjectKey(key);
      const forge = settings.forge ?? forgeFromHost(pk.host);
      if (!forge) throw new ConfigError(`cannot tell which forge ${pk.host} is; set forge for this project`);
      const projectSettings: ResolvedSettings = { ...settings, forge, ...(settings.generate ? { generate: projectGenerate(settings) } : {}) };
      resolved.set(key, projectSettings);
      projects.push({ key, settings: projectSettings as unknown as Record<string, unknown>, forge, ...(settings.url ? { url: settings.url } : {}), tokenEnv: settings.token_env ?? DEFAULT_TOKEN_ENV[forge] });
    } catch (e) {
      failed.set(key, (e as Error).message);
    }
  }
  const tips = new Map<string, ReportTip[]>();
  // What the generator wrote for each project, contents included.
  const written = new Map<string, FileChange[]>();
  const generate = async (dir: string, target: { key: string; name: string; dryRun: boolean }) => {
    const settings = resolved.get(target.key)!;
    // generate: each root's backend, provider and version files, written into the clone first, so init finds the roots they make.
    const generated = settings.generate ? writeGenerated(dir, settings) : [];
    const result = await init(dir, { settings, name: target.name, dryRun: target.dryRun });
    if (target.dryRun && settings.tips) tips.set(target.key, await tipsOf(dir, settings));
    const changes = [...generated, ...result.files].map((f) => ({ ...f, path: relative(dir, f.path) }));
    written.set(target.key, changes);
    return changes.map((f) => ({ path: f.path, status: f.status }));
  };
  const outcomes = projects.length
    ? await reconcileProjects(projects, {
        mode: options.mode,
        words: TERRAGUCCI_WORDS,
        generate,
        env: options.env ?? process.env,
        ...(options.fetch ? { fetch: options.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response> } : {}),
      })
    : [];
  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  return keys.map((key): ProjectOutcome => {
    const why = failed.get(key);
    if (why !== undefined) return { key, status: "failed", changes: [], error: why };
    const o = byKey.get(key)!;
    const t = tips.get(key);
    return { key, status: o.status, changes: o.status === "failed" ? [] : (written.get(key) ?? []), ...(o.pullRequest ? { pullRequest: o.pullRequest } : {}), ...(o.error ? { error: o.error } : {}), ...(t ? { tips: t } : {}) };
  });
}

export function describeReconcile(outcomes: ProjectOutcome[], mode: "dry-run" | "apply"): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const files = o.changes.filter((f) => f.status !== "unchanged").map((f) => `${f.status === "created" ? "new" : "changed"} ${f.path}`);
    if (o.status === "unchanged") lines.push(`${o.key}: unchanged`);
    else if (o.status === "would-change") lines.push(`${o.key}: would write ${files.join(", ")}`);
    else if (o.status === "pull-request") lines.push(`${o.key}: ${files.join(", ")} -> ${o.pullRequest}`);
    else lines.push(`${o.key}: FAILED ${o.error}`);
    for (const line of describeTips(o.tips ?? [])) lines.push(`  ${line}`);
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  lines.push(
    mode === "dry-run"
      ? `dry run: ${outcomes.filter((o) => o.status === "would-change").length} of ${outcomes.length} would change; nothing was written`
      : `${outcomes.filter((o) => o.status === "pull-request").length} pull request(s) opened or updated`,
  );
  if (failed) lines.push(`${failed} project(s) failed`);
  return lines.join("\n");
}
