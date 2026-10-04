/**
 * tf-publish: publish each module that changed since its last release.
 *
 * A module's last release is read from the target itself: the highest
 * `vX.Y.Z` git tag under `modules/<name>/`, or the highest tag in the OCI
 * repository. Each release records the commit it was cut from and a digest of
 * the module's content, so a run on a commit that changed nothing in a module
 * publishes nothing for it, and a version that exists is never written again.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { globMatch } from "../detect";
import { ConfigError, type ResolvedSettings } from "../config";
import { gzip, moduleTar, sha256 } from "./archive";
import { commitsSince, git, hasCommit, tryGit } from "./git";
import { CONTENT, REVISION, Registry, parseOci, type Fetch } from "./oci";
import { applyBump, bumpFor, compareSemver, formatSemver, parseSemver, type Semver } from "./semver";

export { bumpFor, parseSemver } from "./semver";

export interface Release {
  version: Semver;
  /** The commit the release was cut from. */
  revision: string;
  /** Digest of the module's content (the uncompressed archive). */
  content: string;
}

export interface Published {
  module: string;
  target: string;
  status: "published" | "unchanged" | "skipped";
  version?: string;
  /** The OCI manifest digest, or for a git tag the content digest. A pin can name it. */
  digest?: string;
  /** Why nothing was published, or what a dry run would publish. */
  detail?: string;
}

export interface PublishOptions {
  /** Plan only: write nothing. */
  dryRun?: boolean;
  /** Push git tags to `origin` when it exists. Default true. */
  push?: boolean;
  /** An HTTP client for the registry, for tests. */
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
}

interface Target {
  label: string;
  latest(name: string): Promise<Release | undefined>;
  publish(name: string, version: Semver, ctx: { dir: string; rel: string; revision: string; content: string; tar: Buffer }): Promise<string>;
}

export interface Module {
  name: string;
  /** Path relative to the repo. */
  rel: string;
}

export function findModules(repo: string, glob: string): Module[] {
  const out: Module[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(repo, rel)).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = rel ? `${rel}/${name}` : name;
      if (!statSync(join(repo, path)).isDirectory()) continue;
      if (globMatch(glob, path)) {
        if (readdirSync(join(repo, path)).some((f) => f.endsWith(".tf"))) out.push({ name: posix.basename(path), rel: path });
      } else if (glob.split("/").length > path.split("/").length || glob.includes("**")) walk(path);
    }
  };
  walk("");
  return out;
}

function readVersionFile(dir: string): Semver | undefined {
  const file = join(dir, "version");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8");
  const v = parseSemver(text);
  if (!v) throw new ConfigError(`${file} says ${JSON.stringify(text.trim())}; write a version such as 1.4.0`);
  return v;
}

const tagFor = (rel: string, v: Semver): string => `${rel}/v${formatSemver(v)}`;

function gitTagTarget(repo: string, push: boolean, modules: Module[]): Target {
  const byName = new Map(modules.map((m) => [m.name, m.rel]));
  return {
    label: "git-tags",
    async latest(name) {
      const rel = byName.get(name)!;
      const tags = git(repo, ["tag", "--list", `${rel}/v*`]).split("\n").filter(Boolean);
      let best: { v: Semver; tag: string } | undefined;
      for (const tag of tags) {
        const v = parseSemver(tag.slice(rel.length + 1));
        if (v && (!best || compareSemver(v, best.v) > 0)) best = { v, tag };
      }
      if (!best) return undefined;
      const message = git(repo, ["tag", "--list", "--format=%(contents)", best.tag]);
      const content = /^content: (sha256:[0-9a-f]+)$/m.exec(message)?.[1] ?? "";
      return { version: best.v, revision: git(repo, ["rev-list", "-n", "1", best.tag]), content };
    },
    async publish(name, version, ctx) {
      const tag = tagFor(ctx.rel, version);
      const env: Record<string, string> = {};
      if (!tryGit(repo, ["config", "user.name"])) Object.assign(env, { GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" });
      git(repo, ["tag", "-a", tag, "-m", `${ctx.rel} ${formatSemver(version)}\n\ncontent: ${ctx.content}`, ctx.revision], env);
      if (push && tryGit(repo, ["remote", "get-url", "origin"]) !== undefined) git(repo, ["push", "origin", `refs/tags/${tag}`]);
      return ctx.content;
    },
  };
}

function ociTarget(url: string, opts: PublishOptions): Target {
  const { host, repo } = parseOci(url);
  const env = opts.env ?? process.env;
  const insecure = /^(1|true|yes)$/i.test(env.TERRAGUCCI_REGISTRY_INSECURE ?? "");
  const registry = new Registry(host, {
    fetch: opts.fetch,
    scheme: insecure ? "http" : "https",
    user: env.TERRAGUCCI_REGISTRY_USER,
    password: env.TERRAGUCCI_REGISTRY_PASSWORD,
  });
  return {
    label: url,
    async latest(name) {
      const tags = await registry.tags(`${repo}/${name}`);
      let best: { v: Semver; tag: string } | undefined;
      for (const tag of tags) {
        const v = parseSemver(tag);
        if (v && (!best || compareSemver(v, best.v) > 0)) best = { v, tag };
      }
      if (!best) return undefined;
      const found = await registry.manifest(`${repo}/${name}`, best.tag);
      const notes = found?.manifest.annotations ?? {};
      return { version: best.v, revision: notes[REVISION] ?? "", content: notes[CONTENT] ?? "" };
    },
    async publish(name, version, ctx) {
      const path = `${repo}/${name}`;
      const tag = formatSemver(version);
      if (await registry.manifest(path, tag)) throw new ConfigError(`${url}/${name}:${tag} exists already and a published version never changes`);
      return registry.pushModule(path, tag, gzip(ctx.tar), {
        [REVISION]: ctx.revision,
        [CONTENT]: ctx.content,
        "org.opencontainers.image.version": tag,
      });
    },
  };
}

/** The `modules.publish` setting as a list of targets. */
function targets(repo: string, publish: string | string[], modules: Module[], opts: PublishOptions): Target[] {
  return (Array.isArray(publish) ? publish : [publish]).map((p) => {
    if (p === "git-tags") return gitTagTarget(repo, opts.push ?? true, modules);
    if (p.startsWith("oci://")) return ociTarget(p, opts);
    throw new ConfigError(`modules.publish is ${JSON.stringify(p)}; use an oci:// registry address or git-tags`);
  });
}

/** Publish every module under `modules.path` that changed since its last release, to each target. */
export async function publish(repo: string, settings: Pick<ResolvedSettings, "modules">, opts: PublishOptions = {}): Promise<Published[]> {
  const publishTo = settings.modules?.publish;
  if (!publishTo) throw new ConfigError("nothing to publish to; set modules.publish to an oci:// registry or git-tags");
  const modules = findModules(repo, settings.modules?.path ?? "modules/*");
  const head = git(repo, ["rev-parse", "HEAD"]);
  const results: Published[] = [];
  const list = targets(repo, publishTo, modules, opts);
  for (const mod of modules) {
    const dir = join(repo, mod.rel);
    const tar = moduleTar(dir);
    const content = sha256(tar);
    const pinned = readVersionFile(dir);
    for (const target of list) {
      const row = { module: mod.name, target: target.label };
      const last = await target.latest(mod.name);
      let version: Semver;
      if (last) {
        if (last.content === content) {
          results.push({ ...row, status: "unchanged", version: formatSemver(last.version), detail: "content matches the last release" });
          continue;
        }
        if (last.revision && !hasCommit(repo, last.revision)) {
          throw new ConfigError(`${mod.rel}: its last release was cut from ${last.revision.slice(0, 8)}, which this checkout does not have; fetch the full history and tags`);
        }
        const messages = commitsSince(repo, last.revision || undefined, mod.rel);
        if (messages.length === 0 && !pinned) {
          results.push({ ...row, status: "unchanged", version: formatSemver(last.version), detail: "no commits since the last release" });
          continue;
        }
        if (pinned) {
          const cmp = compareSemver(pinned, last.version);
          if (cmp < 0) throw new ConfigError(`${mod.rel}/version is ${formatSemver(pinned)}, behind the last release ${formatSemver(last.version)}`);
          if (cmp === 0) {
            results.push({
              ...row,
              status: "skipped",
              version: formatSemver(last.version),
              detail: `${mod.rel}/version still says ${formatSemver(pinned)}, which is published; change it to publish the new content`,
            });
            continue;
          }
          version = pinned;
        } else version = applyBump(last.version, bumpFor(messages));
      } else {
        version = pinned ?? { major: 0, minor: 1, patch: 0 };
      }
      if (opts.dryRun) {
        results.push({ ...row, status: "published", version: formatSemver(version), detail: "dry run: would publish" });
        continue;
      }
      const digest = await target.publish(mod.name, version, { dir, rel: mod.rel, revision: head, content, tar });
      results.push({ ...row, status: "published", version: formatSemver(version), digest });
    }
  }
  return results;
}

export function describePublish(results: Published[]): string {
  if (results.length === 0) return "no modules found";
  return results
    .map((r) => {
      const at = r.version ? ` ${r.version}` : "";
      const digest = r.digest ? ` ${r.digest}` : "";
      return `${r.module}${at}: ${r.status} to ${r.target}${digest}${r.detail ? ` (${r.detail})` : ""}`;
    })
    .join("\n");
}
