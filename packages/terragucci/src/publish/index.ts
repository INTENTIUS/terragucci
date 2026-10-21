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
 *
 * With `modules.registry`, each release is also written as the module
 * registry protocol's static files (./registry.ts), after the other targets,
 * so its download can point at the git tag or OCI artifact just published.
 * With `modules.test`, a module is tested before any target writes a release
 * of it (./test.ts), and a module whose tests do not pass is refused.
 *
 * A module whose bump, from its commits or its `version` file, is smaller than
 * its interface change since the previous release calls for is refused too
 * (./interface.ts). The previous interface is read at the commit that release
 * was cut from.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { appendLifecycle } from "../apply";
import { loadHclParser } from "../rollout/parser";
import { globMatch } from "../detect";
import { ConfigError, type RegistrySettings, type ResolvedSettings } from "../config";
import { gunzip, gzip, moduleTar, moduleTarAt, moduleZip, sha256, tarEntries } from "./archive";
import { commitsSince, git, hasCommit, tryGit } from "./git";
import { attestKey, attestRelease, cosignSigner, type Attested, type OciAccess, type Signer } from "./attest";
import { fetchLedger, LEDGER_PATH } from "./ledger";
import { AttestationError, publicKey, verifyRelease, type VerifiedRelease } from "./verify";
import { CONTENT, REVISION, Registry, installable, legacyLayer, moduleManifest, notInstallable, parseOci, type Fetch, type Manifest } from "./oci";
import { describeChanges, interfaceAt, interfaceBump, interfaceChanges, interfaceOf, smallerThan, type InterfaceChange, type ModuleInterface } from "./interface";
import { applyBump, bumpBetween, bumpFor, compareSemver, formatSemver, parseSemver, type Bump, type Semver } from "./semver";
import { downloadDoc, keyFor, newest, readVersions, registryAddress, registryStore, tarballName, writeVersion, type RegistryAddress, type RegistryStore, type ReleaseMeta } from "./registry";
import { testModule, type TestBinary, type TestRunner } from "./test";

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
  /** `republished`: a version an earlier terragucci pushed as a tar, pushed again under its tag as the zip OpenTofu installs. */
  status: "published" | "republished" | "unchanged" | "skipped" | "refused";
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
  /** Runs `modules.test`'s commands, for tests. */
  testRunner?: TestRunner;
  /** Where `modules.registry` is written, for tests; the bucket or dir it names by default. */
  registryStore?: RegistryStore;
}

/** What publish reads from the settings: `modules`, and the binary `modules.test` runs. */
export type PublishSettings = Pick<ResolvedSettings, "modules"> & { binary?: string };

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
  latest(mod: Module): Promise<Release | undefined>;
  /** Called before a write: the content digest of a version the target already holds, when it does. */
  existing?(mod: Module, version: Semver): Promise<{ ref: string; content: string } | undefined>;
  publish(mod: Module, version: Semver, ctx: PublishContext): Promise<string>;
  /** The reference a release is published as and the bytes whose digest is signed: the archive of a git tag, the manifest of an OCI tag. */
  subject(mod: Module, version: Semver, ctx: PublishContext): { ref: string; bytes: Buffer };
  /** OCI: attach the signature and attestations to the pushed manifest. */
  attach?(mod: Module, digest: string, attested: Attested, signer: Signer): Promise<void>;
  /** False for a target that only points at a release another target wrote and attested. */
  attests?: boolean;
  /** OCI: the versions an earlier terragucci pushed as a gzipped tar, which OpenTofu cannot install. */
  legacy?(mod: Module): Promise<Legacy[]>;
  /** OCI: push a legacy version again under its tag, as the zip, with its own revision and content. */
  republish?(mod: Module, version: Semver, ctx: PublishContext): Promise<string>;
}

/** A version published as a tar: its tag, annotations and the tar its layer holds, or why it cannot be republished. */
interface Legacy {
  version: Semver;
  ref: string;
  revision: string;
  content: string;
  tar?: Buffer;
  refused?: string;
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

function gitTagTarget(repo: string, push: boolean): Target {
  const hasOrigin = (): boolean => push && tryGit(repo, ["remote", "get-url", "origin"]) !== undefined;
  const contentOf = (tag: string): string => /^content: (sha256:[0-9a-f]+)$/m.exec(git(repo, ["tag", "--list", "--format=%(contents)", tag]))?.[1] ?? "";
  return {
    label: "git-tags",
    async latest(mod) {
      const rel = mod.rel;
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
    async existing(mod, version) {
      const tag = tagFor(mod.rel, version);
      if (hasOrigin() && tryGit(repo, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
        tryGit(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
      }
      return tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) ? { ref: tag, content: contentOf(tag) } : undefined;
    },
    async publish(_mod, version, ctx) {
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
    subject(_mod, version, ctx) {
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
  /** Each semver tag of a module with its manifest, read once a run. */
  const scans = new Map<string, Promise<{ v: Semver; tag: string; manifest?: Manifest }[]>>();
  const scan = (name: string) => {
    if (!scans.has(name)) {
      scans.set(
        name,
        (async () => {
          const out: { v: Semver; tag: string; manifest?: Manifest }[] = [];
          for (const tag of await registry.tags(`${repo}/${name}`)) {
            const v = parseSemver(tag);
            if (v) out.push({ v, tag, manifest: (await registry.manifest(`${repo}/${name}`, tag))?.manifest });
          }
          return out.sort((a, b) => compareSemver(a.v, b.v));
        })(),
      );
    }
    return scans.get(name)!;
  };
  /** The manifest bytes for a release, and the zip they name. */
  const built = (version: Semver, ctx: PublishContext): { zip: Buffer; manifest: Buffer } => {
    const zip = moduleZip(ctx.tar);
    return { zip, manifest: moduleManifest(zip, annotations(version, ctx)) };
  };
  return {
    label: url,
    async latest({ name }) {
      const best = (await scan(name)).at(-1);
      if (!best) return undefined;
      const notes = best.manifest?.annotations ?? {};
      return { version: best.v, revision: notes[REVISION] ?? "", content: notes[CONTENT] ?? "" };
    },
    async legacy({ name }) {
      const out: Legacy[] = [];
      for (const { v, tag, manifest } of await scan(name)) {
        const layer = manifest && legacyLayer(manifest);
        if (!layer) continue;
        const notes = manifest.annotations ?? {};
        const row: Legacy = { version: v, ref: `${url}/${name}:${tag}`, revision: notes[REVISION] ?? "", content: notes[CONTENT] ?? "" };
        const gz = await registry.blob(`${repo}/${name}`, layer.digest);
        let tar: Buffer | undefined;
        try {
          tar = gz && gunzip(gz);
        } catch {
          tar = undefined;
        }
        if (!tar) row.refused = `its layer ${layer.digest} is ${gz ? "not a gzipped tar" : "not in the registry"}`;
        else if (sha256(tar) !== row.content) row.refused = `its layer holds other content than its ${CONTENT} annotation names`;
        else if (!row.revision) row.refused = `it names no ${REVISION}`;
        else row.tar = tar;
        out.push(row);
      }
      return out;
    },
    async publish({ name }, version, ctx) {
      const path = `${repo}/${name}`;
      const tag = formatSemver(version);
      if (await registry.manifest(path, tag)) throw new ConfigError(`${url}/${name}:${tag} exists already and a published version never changes`);
      // Attested: the record goes first, so a tag never stands without one; a record whose push then fails names a tag no root can pin.
      ctx.pushWithRecord?.([]);
      return registry.pushModule(path, tag, built(version, ctx).zip, annotations(version, ctx));
    },
    async republish({ name }, version, ctx) {
      const path = `${repo}/${name}`;
      const tag = formatSemver(version);
      const found = await registry.manifest(path, tag);
      if (!found || !legacyLayer(found.manifest) || found.manifest.annotations?.[CONTENT] !== ctx.content) {
        throw new ConfigError(`${url}/${name}:${tag} changed while it was being republished; run publish again`);
      }
      ctx.pushWithRecord?.([]);
      return registry.pushModule(path, tag, built(version, ctx).zip, annotations(version, ctx));
    },
    subject({ name }, version, ctx) {
      return { ref: `${host}/${repo}/${name}:${formatSemver(version)}`, bytes: built(version, ctx).manifest };
    },
    async attach({ name }, digest, attested, signer) {
      await signer.attachOci?.(`${host}/${repo}/${name}@${digest}`, attested.predicates, access);
    },
  };
}

/** A git remote's URL as a module source names it: no credentials, an scp-style address as ssh://. */
export function sourceUrl(url: string): string {
  const scp = /^([^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

function registryTarget(repo: string, reg: RegistrySettings, modules: Module[], publishTo: string[], opts: PublishOptions): Target {
  const env = opts.env ?? process.env;
  const store = opts.registryStore ?? registryStore(repo, reg, env as NodeJS.ProcessEnv);
  const download = reg.download ?? "tarball";
  const base = reg.url.replace(/\/+$/, "");
  const addrs = new Map<string, RegistryAddress>();
  const seen = new Map<string, string>();
  for (const m of modules) {
    const a = registryAddress(reg, m.rel);
    const other = seen.get(a.source);
    if (other) throw new ConfigError(`${other} and ${m.rel} are both ${a.source} in the registry; map one's path to another namespace in modules.registry.namespaces`);
    seen.set(a.source, m.rel);
    addrs.set(m.rel, a);
  }
  const addr = (mod: Module): RegistryAddress => addrs.get(mod.rel)!;
  const metaKey = (a: RegistryAddress, v: string): string => keyFor(reg, `${a.path}/${v}/release.json`);
  const meta = async (a: RegistryAddress, v: string): Promise<ReleaseMeta | undefined> => {
    const body = (await store.read(metaKey(a, v))).body;
    if (!body) return undefined;
    try {
      return JSON.parse(body) as ReleaseMeta;
    } catch {
      return undefined;
    }
  };
  const ociUrl = publishTo.find((t) => t.startsWith("oci://"));
  /** Where the download points, once the release it points at is checked to hold this content. */
  const locate = async (mod: Module, version: Semver, ctx: PublishContext): Promise<string> => {
    const name = mod.name;
    const v = formatSemver(version);
    if (download === "git-tags") {
      const tag = tagFor(ctx.rel, version);
      const message = tryGit(repo, ["tag", "--list", "--format=%(contents)", tag]);
      const content = message && /^content: (sha256:[0-9a-f]+)$/m.exec(message)?.[1];
      if (content !== ctx.content) throw new ConfigError(`the registry points ${addr(mod).source} ${v} at the git tag ${tag}, which ${content ? "holds other content" : "is not published"}; publish git-tags first`);
      const origin = tryGit(repo, ["remote", "get-url", "origin"]);
      if (!origin) throw new ConfigError(`the registry points each version at its git tag on origin, and this checkout has no origin`);
      return `git::${sourceUrl(origin)}//${ctx.rel}?ref=${tag}`;
    }
    if (download === "oci") {
      const { host, repo: path } = parseOci(ociUrl!);
      const insecure = /^(1|true|yes)$/i.test(env.TERRAGUCCI_REGISTRY_INSECURE ?? "");
      const registry = new Registry(host, { fetch: opts.fetch, scheme: insecure ? "http" : "https", user: env.TERRAGUCCI_REGISTRY_USER, password: env.TERRAGUCCI_REGISTRY_PASSWORD });
      const found = await registry.manifest(`${path}/${name}`, v);
      if (found?.manifest.annotations?.[CONTENT] !== ctx.content) throw new ConfigError(`the registry points ${addr(mod).source} ${v} at ${ociUrl}/${name}:${v}, which ${found ? "holds other content" : "is not published"}; publish to ${ociUrl} first`);
      if (!installable(found.manifest)) throw new ConfigError(`the registry points ${addr(mod).source} ${v} at ${notInstallable(`${ociUrl}/${name}:${v}`, found.manifest)}; publish to ${ociUrl} first`);
      return `${ociUrl}/${name}?tag=${v}`;
    }
    return `${base}/${addr(mod).path}/${v}/${tarballName(addr(mod), v)}`;
  };
  return {
    label: `registry ${base}`,
    attests: download === "tarball",
    async latest(mod) {
      const a = addr(mod);
      const best = newest(readVersions((await store.read(keyFor(reg, `${a.path}/versions`))).body));
      if (!best) return undefined;
      const m = await meta(a, formatSemver(best));
      return { version: best, revision: m?.revision ?? "", content: m?.content ?? "" };
    },
    async existing(mod, version) {
      const m = await meta(addr(mod), formatSemver(version));
      return m ? { ref: `${addr(mod).source} ${formatSemver(version)}`, content: m.content } : undefined;
    },
    async publish(mod, version, ctx) {
      const a = addr(mod);
      const v = formatSemver(version);
      const location = await locate(mod, version, ctx);
      // Attested: the record goes first, as for an OCI tag, so no version is listed without one.
      ctx.pushWithRecord?.([]);
      const record: ReleaseMeta = { module: ctx.rel, version: v, revision: ctx.revision, content: ctx.content, location };
      await writeVersion(store, reg, a, version, {
        ...(download === "tarball" ? { tarball: { key: keyFor(reg, `${a.path}/${v}/${tarballName(a, v)}`), body: gzip(ctx.tar) } } : {}),
        download: { key: keyFor(reg, `${a.path}/${v}/download`), body: downloadDoc(location) },
        meta: { key: metaKey(a, v), body: `${JSON.stringify(record, null, 2)}\n` },
      });
      return ctx.content;
    },
    subject(mod, version, ctx) {
      return { ref: `${addr(mod).source} ${formatSemver(version)}`, bytes: ctx.tar };
    },
  };
}

/** The `modules.publish` setting as a list of targets. */
function targets(repo: string, publish: string | string[] | undefined, registry: RegistrySettings | undefined, modules: Module[], opts: PublishOptions): Target[] {
  const list = publish === undefined ? [] : Array.isArray(publish) ? publish : [publish];
  const out = list.map((p) => {
    if (p === "git-tags") return gitTagTarget(repo, opts.push ?? true);
    if (p.startsWith("oci://")) return ociTarget(p, opts);
    throw new ConfigError(`modules.publish is ${JSON.stringify(p)}; use an oci:// registry address or git-tags`);
  });
  // Last, so a download that points at a git tag or an OCI artifact points at one this run has written.
  if (registry) out.push(registryTarget(repo, registry, modules, list, opts));
  return out;
}

/** Publish every module under `modules.path` that changed since its last release, to each target. */
export async function publish(repo: string, settings: PublishSettings, opts: PublishOptions = {}): Promise<Published[]> {
  const publishTo = settings.modules?.publish;
  const registry = settings.modules?.registry;
  if (!publishTo && !registry) throw new ConfigError("nothing to publish to; set modules.publish to an oci:// registry or git-tags, or set modules.registry");
  const modules = findModules(repo, settings.modules?.path ?? "modules/*");
  const head = git(repo, ["rev-parse", "HEAD"]);
  const results: Published[] = [];
  const list = targets(repo, publishTo, registry, modules, opts);
  const testBinary: TestBinary = settings.binary === "terraform" ? "terraform" : "tofu";
  const tested = new Map<string, string | undefined>();
  /** Why a module's release is refused by modules.test, tested once a run; undefined when it passes or the setting is off. */
  const refusedByTests = (mod: Module, dir: string): string | undefined => {
    if (settings.modules?.test !== true) return undefined;
    if (!tested.has(mod.rel)) tested.set(mod.rel, testModule(dir, mod.rel, testBinary, opts.testRunner));
    return tested.get(mod.rel);
  };
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
  /**
   * Push a version an earlier terragucci published as a tar again under its
   * tag, as the zip of the same tar, with its own revision and content. When
   * attested, the new manifest is signed and recorded as the original was,
   * from the version's own commit, with its SBOM read from the tar's files.
   */
  const republishLegacy = async (mod: Module, target: Target, old: Legacy): Promise<{ digest: string; detail?: string }> => {
    const ctx: PublishContext = { dir: join(repo, mod.rel), rel: mod.rel, revision: old.revision, content: old.content, tar: old.tar! };
    const deps = await attestDeps();
    if (!deps) return { digest: await target.republish!(mod, old.version, ctx) };
    const dir = mkdtempSync(join(tmpdir(), "terragucci-republish-"));
    try {
      for (const e of tarEntries(old.tar!)) {
        mkdirSync(dirname(join(dir, e.path)), { recursive: true });
        writeFileSync(join(dir, e.path), e.data);
      }
      const subject = target.subject(mod, old.version, ctx);
      const attested = await attestRelease(
        { module: mod.rel, dir, version: formatSemver(old.version), target: target.label, ref: subject.ref, bytes: subject.bytes, commit: old.revision },
        { ...deps, ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}) },
      );
      ctx.pushWithRecord = (refs) =>
        appendLifecycle(repo, LEDGER_PATH, [JSON.stringify(attested.record)], attested.files, `Release record: ${mod.rel} ${formatSemver(old.version)} ${attested.digest} (republished as archive/zip)`, refs);
      const digest = await target.republish!(mod, old.version, ctx);
      await target.attach?.(mod, attested.digest, attested, deps.signer);
      return { digest, detail: `signed and recorded in the release ledger as ${attested.digest}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const mod of modules) {
    const dir = join(repo, mod.rel);
    const tar = moduleTar(dir);
    const content = sha256(tar);
    const pinned = readVersionFile(dir);
    let current: ModuleInterface | undefined;
    const before = new Map<string, ModuleInterface | undefined>();
    /** The interface changes since the release cut from `revision`; undefined when that commit does not hold the module. */
    const changesSince = (revision: string): InterfaceChange[] | undefined => {
      if (!before.has(revision)) before.set(revision, interfaceAt(repo, revision, mod.rel));
      const prev = before.get(revision);
      if (!prev) return undefined;
      current ??= interfaceOf(dir);
      return interfaceChanges(prev, current);
    };
    for (const target of list) {
      const row = { module: mod.name, target: target.label };
      for (const old of (await target.legacy?.(mod)) ?? []) {
        const v = formatSemver(old.version);
        if (old.refused) {
          results.push({ ...row, status: "refused", version: v, detail: `${old.ref} is a tar OpenTofu cannot install, and it cannot be republished as archive/zip: ${old.refused}` });
          continue;
        }
        if (opts.dryRun) {
          results.push({ ...row, status: "republished", version: v, detail: "dry run: would republish it" });
          continue;
        }
        results.push({ ...row, status: "republished", version: v, ...(await republishLegacy(mod, target, old)) });
      }
      const last = await target.latest(mod);
      let version: Semver;
      let bumps: { commits: Bump; iface: Bump; changes: InterfaceChange[] } | undefined;
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
        const changes = last.revision ? changesSince(last.revision) : undefined;
        if (changes) bumps = { commits: pinned ? bumpBetween(last.version, pinned) : bumpFor(messages), iface: interfaceBump(changes), changes };
      } else {
        version = pinned ?? { major: 0, minor: 1, patch: 0 };
      }
      if (last && bumps && smallerThan(bumps.commits, bumps.iface)) {
        const { commits, iface } = bumps;
        const from = pinned ? `${mod.rel}/version says ${formatSemver(pinned)}, a ${commits} bump` : `the commits since ${formatSemver(last.version)} call for a ${commits}`;
        const fix = iface === "major" ? "a feat!: commit or a BREAKING CHANGE: footer" : "a feat: commit";
        results.push({
          ...row,
          status: "refused",
          version: formatSemver(version),
          detail: `${opts.dryRun ? "dry run: " : ""}${from}, and the interface needs a ${iface}: ${describeChanges(bumps.changes.filter((c) => smallerThan(commits, c.bump)))}; publish it with ${fix}, or ${mod.rel}/version at ${formatSemver(applyBump(last.version, iface))}`,
        });
        continue;
      }
      if (opts.dryRun) {
        const would = ["test", "publish", "sign and record"].filter((w) => (w === "test" ? settings.modules?.test === true : w === "sign and record" ? keyPath && target.attests !== false : true));
        const bumpNote = bumps ? `; commits: ${bumps.commits}, interface: ${bumps.iface}` : "";
        results.push({ ...row, status: "published", version: formatSemver(version), detail: `dry run: would ${would.join(", ")}${bumpNote}` });
        continue;
      }
      const held = await target.existing?.(mod, version);
      if (held) {
        if (held.content !== content) {
          throw new ConfigError(`${held.ref} already exists with different content; the version is taken, so change ${mod.rel}/version or remove the tag if it was a mistake`);
        }
        results.push({ ...row, status: "unchanged", version: formatSemver(version), detail: `${held.ref} is already published with this content` });
        continue;
      }
      const untested = refusedByTests(mod, dir);
      if (untested) {
        results.push({ ...row, status: "refused", version: formatSemver(version), detail: untested });
        continue;
      }
      const ctx: PublishContext = { dir, rel: mod.rel, revision: head, content, tar };
      const deps = target.attests === false ? undefined : await attestDeps();
      if (!deps) {
        const digest = await target.publish(mod, version, ctx);
        results.push({ ...row, status: "published", version: formatSemver(version), digest });
        continue;
      }
      const subject = target.subject(mod, version, ctx);
      const attested = await attestRelease(
        { module: mod.rel, dir, version: formatSemver(version), target: target.label, ref: subject.ref, bytes: subject.bytes, commit: head },
        { ...deps, ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}) },
      );
      ctx.pushWithRecord = (refs) =>
        appendLifecycle(repo, LEDGER_PATH, [JSON.stringify(attested.record)], attested.files, `Release record: ${mod.rel} ${formatSemver(version)} ${attested.digest}`, refs);
      const digest = await target.publish(mod, version, ctx);
      await target.attach?.(mod, attested.digest, attested, deps.signer);
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
      if (r.status === "refused") return `${r.module}${at}: refused, not published to ${r.target} (${r.detail})`;
      if (r.status === "republished") {
        return `${r.module}${at}: republished as archive/zip to ${r.target}${digest}; the earlier artifact was a tar OpenTofu cannot install${r.detail ? ` (${r.detail})` : ""}`;
      }
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
      const manifest = bytes && (JSON.parse(bytes.toString("utf-8")) as Manifest);
      if (manifest && !installable(manifest)) {
        out.push({ ...row, ref, refused: `${notInstallable(ref, manifest)}; publish republishes it as archive/zip` });
        continue;
      }
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
