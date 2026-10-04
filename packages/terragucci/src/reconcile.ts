/**
 * `terragucci reconcile`: from a control repo, bring every project's pipeline
 * in line with the config. A dry run (the default) says what each project's
 * pipeline would become. `--mode apply` pushes a branch to each project that
 * changes and opens a pull request there; it never writes a default branch.
 * One project failing does not stop the others.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ConfigError, forgeFromHost, parseProjectKey, resolveProject, type ResolvedSettings, type TerragucciConfig } from "./config";
import { DEFAULT_TOKEN_ENV, defaultBranch, openPullRequest, type Fetch, type ForgeTarget } from "./forge";
import { findRoots } from "./detect";
import { init, type FileChange } from "./init";
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

export async function reconcile(config: TerragucciConfig, options: ReconcileOptions): Promise<ProjectOutcome[]> {
  if (!config.projects || Object.keys(config.projects).length === 0) {
    throw new ConfigError("reconcile needs a control repo config with projects; in a single repo, run terragucci init");
  }
  const keys = options.project ? [options.project] : Object.keys(config.projects);
  const env = options.env ?? process.env;
  const fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const outcomes: ProjectOutcome[] = [];

  for (const key of keys) {
    const work = mkdtempSync(join(tmpdir(), "terragucci-reconcile-"));
    try {
      const settings = resolveProject(config, key);
      const pk = parseProjectKey(key);
      const forge = settings.forge ?? forgeFromHost(pk.host);
      if (!forge) throw new ConfigError(`cannot tell which forge ${pk.host} is; set forge for this project`);
      const tokenEnv = settings.token_env ?? DEFAULT_TOKEN_ENV[forge];
      const token = env[tokenEnv];
      if (options.mode === "apply" && !token) throw new ConfigError(`${tokenEnv} is not set; it holds the token for ${pk.host}`);
      const { cloneUrl, origin } = where(key, settings.url);

      const dir = join(work, "repo");
      git(work, ["clone", "-q", "--depth", "1", withToken(cloneUrl, token), dir], token);
      const result = await init(dir, { settings: { ...settings, forge }, name: pk.name, dryRun: options.mode === "dry-run" });
      const changes = result.files.map((f) => ({ ...f, path: relative(dir, f.path) }));
      const changed = changes.filter((f) => f.status !== "unchanged");

      // A dry run also says what the project's setup could do better.
      const tips = options.mode === "dry-run" && settings.tips ? await tipsOf(dir, settings) : undefined;
      const extra = tips ? { tips } : {};

      if (changed.length === 0) {
        outcomes.push({ key, status: "unchanged", changes, ...extra });
        continue;
      }
      if (options.mode === "dry-run") {
        outcomes.push({ key, status: "would-change", changes, ...extra });
        continue;
      }

      const target: ForgeTarget = { forge, origin, path: pk.path, token: token! };
      const base = await defaultBranch(fetch, target);
      git(dir, ["checkout", "-q", "-B", BRANCH]);
      git(dir, ["add", "-A"]);
      git(dir, [...IDENTITY, "commit", "-q", "-m", "terragucci: update the pipeline from the control repo"]);
      git(dir, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${BRANCH}`], token);
      const pr = await openPullRequest(fetch, target, {
        head: BRANCH,
        base,
        title: "terragucci: update the pipeline",
        body: [
          "The control repo's terragucci config changed what this repo's pipeline should be.",
          "",
          ...changed.map((f) => `- ${f.status === "created" ? "adds" : "updates"} \`${f.path}\``),
          "",
          "Review and merge it here; terragucci never writes this repo's default branch.",
        ].join("\n"),
      });
      outcomes.push({ key, status: "pull-request", changes, pullRequest: pr.url });
    } catch (e) {
      outcomes.push({ key, status: "failed", changes: [], error: (e as Error).message });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return outcomes;
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
