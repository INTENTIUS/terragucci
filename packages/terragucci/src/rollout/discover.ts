/**
 * The newest published version of a module, for a rollout named without one.
 *
 * tf-publish releases a module as an annotated git tag `<path>/vX.Y.Z`, as an
 * OCI module package tagged `X.Y.Z`, or both. Each project the rollout reads
 * is asked for its tags under the module's path, without fetching them; each
 * OCI repository the config publishes to, and each one a root already pins,
 * is asked for its tags. The highest version wins.
 */
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { Registry, parseOci, type Fetch } from "../publish/oci";
import { compareSemver, formatSemver, parseSemver, type Semver } from "../publish/semver";

export interface DiscoverInput {
  /** The module as the rollout names it: a path such as `modules/network`, or a source. */
  module: string;
  /** Checkouts whose `origin` may carry the module's tags. */
  repos: string[];
  /** OCI repositories that may hold the module, as `oci://host/path`. */
  oci: string[];
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
}

export interface Discovered {
  version: string;
  /** Where it was found: a tag, or an OCI repository. */
  from: string;
}

function remoteTags(repo: string, prefix: string): string[] {
  for (const args of [["ls-remote", "--tags", "--refs", "origin", `refs/tags/${prefix}/v*`], ["tag", "--list", `${prefix}/v*`]]) {
    try {
      const out = execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const tags = out.split("\n").filter(Boolean).map((l) => l.split("\t").pop()!.replace(/^refs\/tags\//, ""));
      if (args[0] === "ls-remote" || tags.length > 0) return tags;
    } catch {
      /* no origin: read the local tags */
    }
  }
  return [];
}

export async function newestPublished(input: DiscoverInput): Promise<Discovered | undefined> {
  let best: { v: Semver; from: string } | undefined;
  const offer = (text: string, from: string) => {
    const v = parseSemver(text);
    if (v && (!best || compareSemver(v, best.v) > 0)) best = { v, from };
  };
  const path = input.module.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!/^[a-z]+:\/\/|::/.test(path)) {
    for (const repo of input.repos) for (const tag of remoteTags(repo, path)) offer(tag.slice(path.length + 1), `tag ${tag}`);
  }
  const env = input.env ?? process.env;
  const insecure = /^(1|true|yes)$/i.test(env.TERRAGUCCI_REGISTRY_INSECURE ?? "");
  for (const url of new Set(input.oci)) {
    const { host, repo } = parseOci(url);
    const registry = new Registry(host, {
      fetch: input.fetch,
      scheme: insecure ? "http" : "https",
      user: env.TERRAGUCCI_REGISTRY_USER,
      password: env.TERRAGUCCI_REGISTRY_PASSWORD,
    });
    for (const tag of await registry.tags(repo)) offer(tag, `${url}:${tag}`);
  }
  return best ? { version: formatSemver(best.v), from: best.from } : undefined;
}

/** The OCI repository a module lives at under a `modules.publish` registry address. */
export function ociRepoFor(publish: string, module: string): string {
  return `${publish.replace(/\/+$/, "")}/${posix.basename(module.replace(/\/+$/, ""))}`;
}
