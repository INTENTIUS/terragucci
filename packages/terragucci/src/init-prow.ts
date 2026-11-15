/**
 * What `terragucci init` needs for `runtime: prow` beyond the settings: the
 * repository's owner/name, which keys its jobs in Prow's config, and its
 * default branch, which the postsubmits and the drift periodic run on.
 */
import { execFileSync } from "node:child_process";
import { ConfigError, type ForgeName, type ResolvedSettings } from "./config";
import { pathOfRemote } from "./identities";
import { renderProwJobs, type ProwJobsInput, type RenderedProwJobs } from "./render-prow";

const git = (repo: string, ...args: string[]): string => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** owner/name on GitHub: from `url` in terragucci.yml, else the origin remote. */
export function prowRepository(repo: string, settings: Pick<ResolvedSettings, "url">): string | undefined {
  const from = settings.url ?? git(repo, "remote", "get-url", "origin");
  const path = from ? pathOfRemote(from) : undefined;
  return path && /^[^/]+\/[^/]+$/.test(path) ? path : undefined;
}

/** The default branch the origin remote names (`origin/HEAD`), else main. */
export function prowDefaultBranch(repo: string): string {
  const head = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  return head.startsWith("origin/") && head.length > "origin/".length ? head.slice("origin/".length) : "main";
}

export function prowPipeline(
  repo: string,
  settings: ResolvedSettings,
  o: Omit<ProwJobsInput, "repo" | "defaultBranch" | "prow" | "env" | "drift"> & { forge: ForgeName; plain: boolean },
): RenderedProwJobs {
  if (o.forge !== "github") throw new ConfigError(`runtime: prow serves GitHub repositories, and this one is on ${o.forge}`);
  if (!o.plain) throw new ConfigError("runtime: prow runs plain Terraform and OpenTofu roots; a Terragrunt, Atmos or Terramate repository keeps runtime: forge");
  if (!settings.prow) throw new ConfigError("runtime: prow needs the prow key: trusted_cluster, service_accounts and token_secret");
  const path = prowRepository(repo, settings);
  if (!path) throw new ConfigError("runtime: prow keys the jobs by the repository's owner/name, and neither url in terragucci.yml nor the origin remote names it; add an origin remote on GitHub, or set url");
  const { forge: _forge, plain: _plain, ...input } = o;
  return renderProwJobs({
    ...input,
    repo: path,
    defaultBranch: prowDefaultBranch(repo),
    prow: settings.prow,
    env: settings.env,
    ...(settings.drift ? { drift: settings.drift } : {}),
  });
}
