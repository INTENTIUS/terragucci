/**
 * tf-publish: publish each module that changed since its last release.
 *
 * A module's last release is read from the target itself: the highest
 * `vX.Y.Z` git tag under `modules/<name>/`, or the highest tag in the OCI
 * repository. Each release records the commit it was cut from and a digest of
 * the module's content, so a run on a commit that changed nothing in a module
 * publishes nothing for it, and a version that exists is never written again.
 *
 * With `modules.attest`, each release is also signed, given SLSA provenance
 * and an SBOM, and recorded in chant's release ledger on chant/lifecycle
 * (./attest.ts, ./ledger.ts). The record and the tag are written together: a
 * git tag in one atomic push with the ledger commit, an OCI tag only after the
 * ledger holds its record, so no tag stands without one.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { appendLifecycle } from "../apply";
import { loadHclParser } from "../rollout/parser";
import { globMatch } from "../detect";
import { ConfigError, type ResolvedSettings } from "../config";
import { gzip, moduleTar, moduleTarAt, sha256 } from "./archive";
import { commitsSince, git, hasCommit, tryGit } from "./git";
import { attestKey, attestRelease, cosignSigner, type Attested, type OciAccess, type Signer } from "./attest";
import { fetchLedger, LEDGER_PATH } from "./ledger";
import { AttestationError, publicKey, verifyRelease, type VerifiedRelease } from "./verify";
import { CONTENT, REVISION, Registry, moduleManifest, parseOci, type Fetch } from "./oci";
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
  /** Signs attested releases; cosign with the job's key by default. */
  signer?: Signer;
  /** The HCL parser an attested release's SBOM is read with. */
  parser?: Hcl2Json;
}

/** What publishing one release needs from the target, past the archive. */
interface PublishContext {
  dir: string;
  rel: string;
  revision: string;
  content: string;
  tar: Buffer;
  /** Attested: push these refs with the ledger record, in one atomic push, instead of pushing them alone. */
  pushWithRecord?: (refs: string[]) => void;
}

interface Target {
  label: string;
  latest(name: string): Promise<Release | undefined>;
  /** Called before a write: the content digest of a version the target already holds, when it does. */
  existing?(name: string, version: Semver): Promise<{ ref: string; content: string } | undefined>;
  publish(name: string, version: Semver, ctx: PublishContext): Promise<string>;
  /** The reference a release is published as and the bytes whose digest is signed: the archive of a git tag, the manifest of an OCI tag. */
  subject(name: string, version: Semver, ctx: PublishContext): { ref: string; bytes: Buffer };
  /** OCI: attach the signature and attestations to the pushed manifest. */
  attach?(name: string, digest: string, attested: Attested, signer: Signer): Promise<void>;
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
  const hasOrigin = (): boolean => push && tryGit(repo, ["remote", "get-url", "origin"]) !== undefined;
  const contentOf = (tag: string): string => /^content: (sha256:[0-9a-f]+)$/m.exec(git(repo, ["tag", "--list", "--format=%(contents)", tag]))?.[1] ?? "";
  return {
    label: "git-tags",
    async latest(name) {
      const rel = byName.get(name)!;
      // A clone can lack the release tags (a fresh checkout, a shallow CI clone),
      // and a version chosen without them may already be on the remote.
      if (hasOrigin()) tryGit(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${rel}/v*:refs/tags/${rel}/v*`]);
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
    async existing(name, version) {
      const tag = tagFor(byName.get(name)!, version);
      if (hasOrigin() && tryGit(repo, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
        tryGit(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
      }
      return tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) ? { ref: tag, content: contentOf(tag) } : undefined;
    },
    async publish(name, version, ctx) {
      const tag = tagFor(ctx.rel, version);
      const env: Record<string, string> = {};
      if (!tryGit(repo, ["config", "user.name"])) Object.assign(env, { GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" });
      git(repo, ["tag", "-a", tag, "-m", `${ctx.rel} ${formatSemver(version)}\n\ncontent: ${ctx.content}`, ctx.revision], env);
      if (ctx.pushWithRecord) {
        try {
          ctx.pushWithRecord([`refs/tags/${tag}`]);
        } catch (e) {
          // The record did not land, so neither did the tag: drop it here too, and a rerun publishes the version again.
          tryGit(repo, ["tag", "-d", tag]);
          throw e;
        }
      } else if (push && tryGit(repo, ["remote", "get-url", "origin"]) !== undefined) git(repo, ["push", "origin", `refs/tags/${tag}`]);
      return ctx.content;
    },
    subject(_name, version, ctx) {
      return { ref: tagFor(ctx.rel, version), bytes: ctx.tar };
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
  const annotations = (version: Semver, ctx: PublishContext): Record<string, string> => ({
    [REVISION]: ctx.revision,
    [CONTENT]: ctx.content,
    "org.opencontainers.image.version": formatSemver(version),
  });
  const access: OciAccess = {
    ...(env.TERRAGUCCI_REGISTRY_USER ? { user: env.TERRAGUCCI_REGISTRY_USER, password: env.TERRAGUCCI_REGISTRY_PASSWORD ?? "" } : {}),
    ...(insecure ? { insecure } : {}),
    ...(env.NODE_EXTRA_CA_CERTS ? { ca: env.NODE_EXTRA_CA_CERTS } : {}),
  };
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
      // Attested: the record goes first, so a tag never stands without one; a record whose push then fails names a tag no root can pin.
      ctx.pushWithRecord?.([]);
      return registry.pushModule(path, tag, gzip(ctx.tar), annotations(version, ctx));
    },
    subject(name, version, ctx) {
      const bytes = moduleManifest(gzip(ctx.tar), annotations(version, ctx));
      return { ref: `${host}/${repo}/${name}:${formatSemver(version)}`, bytes };
    },
    async attach(name, digest, attested, signer) {
      await signer.attachOci?.(`${host}/${repo}/${name}@${digest}`, attested.predicates, access);
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
  const keyPath = attestKey(settings.modules?.attest);
  let attesting: { signer: Signer; parser: Hcl2Json; publicKey: string; keyPath: string } | undefined;
  const attestDeps = async () => {
    if (!keyPath) return undefined;
    if (!attesting) {
      if (tryGit(repo, ["remote", "get-url", "origin"]) === undefined) throw new ConfigError("modules.attest records each release on chant/lifecycle at origin, and this checkout has no origin");
      const file = join(repo, keyPath);
      if (!existsSync(file)) throw new ConfigError(`modules.attest verifies each release against the public key at ${keyPath}, which is not in the repo; commit the cosign.pub of the key pair the publish job signs with`);
      attesting = {
        publicKey: readFileSync(file, "utf-8"),
        keyPath,
        signer: opts.signer ?? cosignSigner(opts.env ?? process.env),
        parser: opts.parser ?? (await loadHclParser("modules.attest writes each release's SBOM from its HCL")),
      };
    }
    return attesting;
  };
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
        results.push({ ...row, status: "published", version: formatSemver(version), detail: keyPath ? "dry run: would publish, sign and record" : "dry run: would publish" });
        continue;
      }
      const held = await target.existing?.(mod.name, version);
      if (held) {
        if (held.content !== content) {
          throw new ConfigError(`${held.ref} already exists with different content; the version is taken, so change ${mod.rel}/version or remove the tag if it was a mistake`);
        }
        results.push({ ...row, status: "unchanged", version: formatSemver(version), detail: `${held.ref} is already published with this content` });
        continue;
      }
      const ctx: PublishContext = { dir, rel: mod.rel, revision: head, content, tar };
      const deps = await attestDeps();
      if (!deps) {
        const digest = await target.publish(mod.name, version, ctx);
        results.push({ ...row, status: "published", version: formatSemver(version), digest });
        continue;
      }
      const subject = target.subject(mod.name, version, ctx);
      const attested = await attestRelease(
        { module: mod.rel, dir, version: formatSemver(version), target: target.label, ref: subject.ref, bytes: subject.bytes, commit: head },
        { ...deps, ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}) },
      );
      ctx.pushWithRecord = (refs) =>
        appendLifecycle(repo, LEDGER_PATH, [JSON.stringify(attested.record)], attested.files, `Release record: ${mod.rel} ${formatSemver(version)} ${attested.digest}`, refs);
      const digest = await target.publish(mod.name, version, ctx);
      await target.attach?.(mod.name, attested.digest, attested, deps.signer);
      results.push({ ...row, status: "published", version: formatSemver(version), digest, detail: `signed and recorded in the release ledger as ${attested.digest}` });
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

export interface ReleaseCheck {
  module: string;
  target: string;
  version: string;
  ref: string;
  verified?: VerifiedRelease;
  /** Why the release does not verify. */
  refused?: string;
}

/**
 * Check one published version of a module in this repo, on every target
 * `modules.publish` names: the tag is there, and the bytes it names now are
 * signed, attested and recorded in the release ledger at origin.
 */
export async function verifyPublished(repo: string, settings: Pick<ResolvedSettings, "modules">, module: string, version: string, opts: PublishOptions = {}): Promise<ReleaseCheck[]> {
  const keyPath = attestKey(settings.modules?.attest);
  if (!keyPath) throw new ConfigError("modules.attest is not set, so no release of this repo is attested");
  const publishTo = settings.modules?.publish;
  if (!publishTo) throw new ConfigError("modules.publish is not set");
  const v = parseSemver(version);
  if (!v) throw new ConfigError(`${version} is not a version such as 1.4.0`);
  const modules = findModules(repo, settings.modules?.path ?? "modules/*");
  const mod = modules.find((m) => m.rel === module.replace(/\/+$/, "") || m.name === module);
  if (!mod) throw new ConfigError(`no module ${module} under ${settings.modules?.path ?? "modules/*"}`);
  const keyFile = join(repo, keyPath);
  if (!existsSync(keyFile)) throw new ConfigError(`the public key ${keyPath} is not in the repo`);
  const key = publicKey(readFileSync(keyFile, "utf-8"), keyPath);
  const ledger = fetchLedger(repo, "origin");
  const env = opts.env ?? process.env;
  const out: ReleaseCheck[] = [];
  for (const target of Array.isArray(publishTo) ? publishTo : [publishTo]) {
    const row = { module: mod.rel, target, version: formatSemver(v) };
    let subject: { ref: string; bytes?: Buffer; commit?: string };
    if (target === "git-tags") {
      const tag = tagFor(mod.rel, v);
      tryGit(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
      const commit = tryGit(repo, ["rev-list", "-n", "1", `refs/tags/${tag}`]);
      subject = { ref: tag, ...(commit ? { commit, bytes: moduleTarAt(repo, commit, mod.rel) } : {}) };
    } else {
      const { host, repo: path } = parseOci(target);
      const registry = new Registry(host, {
        fetch: opts.fetch,
        scheme: /^(1|true|yes)$/i.test(env.TERRAGUCCI_REGISTRY_INSECURE ?? "") ? "http" : "https",
        user: env.TERRAGUCCI_REGISTRY_USER,
        password: env.TERRAGUCCI_REGISTRY_PASSWORD,
      });
      const ref = `${host}/${path}/${mod.name}:${formatSemver(v)}`;
      const bytes = await registry.manifestBytes(`${path}/${mod.name}`, formatSemver(v));
      subject = { ref, ...(bytes ? { bytes } : {}) };
    }
    if (!subject.bytes) {
      out.push({ ...row, ref: subject.ref, refused: `${subject.ref} is not published` });
      continue;
    }
    if (!ledger) {
      out.push({ ...row, ref: subject.ref, refused: "origin has no chant/lifecycle branch, so no release is recorded" });
      continue;
    }
    try {
      out.push({ ...row, ref: subject.ref, verified: verifyRelease({ module: mod.rel, version: formatSemver(v), bytes: subject.bytes, ...(subject.commit ? { commit: subject.commit } : {}) }, ledger, key) });
    } catch (e) {
      if (!(e instanceof AttestationError)) throw e;
      out.push({ ...row, ref: subject.ref, refused: e.message });
    }
  }
  return out;
}

export function describeChecks(checks: ReleaseCheck[]): string {
  return checks
    .map((c) => (c.verified ? `${c.ref}: verified (${c.verified.checked.join(", ")}) ${c.verified.digest} from ${c.verified.commit.slice(0, 12)}` : `${c.ref}: refused: ${c.refused}`))
    .join("\n");
}
