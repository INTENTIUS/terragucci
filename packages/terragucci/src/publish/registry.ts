/**
 * `modules.registry`: each release written as the Terraform module registry
 * protocol (https://opentofu.org/docs/internals/module-registry-protocol/),
 * as static files a bucket or a Pages site serves at `registry.url`:
 *
 *   .well-known/terraform.json                  {"modules.v1": "/v1/modules/"}
 *   v1/modules/<ns>/<name>/<system>/versions     every version, newest last
 *   v1/modules/<ns>/<name>/<system>/<v>/download {"location": ...}
 *   v1/modules/<ns>/<name>/<system>/<v>/<name>-<v>.tar.gz   with download: tarball
 *   v1/modules/<ns>/<name>/<system>/<v>/release.json        the commit and content digest
 *
 * A static server sends no X-Terraform-Get header, so the download answer is
 * the JSON body with `location`, which Terraform and OpenTofu read when the
 * header is absent. The location is a tarball beside it, the module's git tag,
 * or its OCI artifact.
 *
 * A module's namespace is `registry.namespace`, or the namespace
 * `registry.namespaces` maps the longest prefix of its path (its tag prefix)
 * to, so the modules of a monorepo's parts publish under namespaces of their
 * own. Its name is the last segment of its path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { ConfigError, REGISTRY_NAME, type RegistrySettings } from "../config";
import { storeFromEnv } from "../report/bucket";
import { StoreConflict, type ObjectStore, type StoreCondition } from "../report/object-store";
import type { Fetch } from "./oci";
import { compareSemver, formatSemver, parseSemver, type Semver } from "./semver";

export const DISCOVERY = ".well-known/terraform.json";
export const MODULES_V1 = "/v1/modules/";
export const DEFAULT_SYSTEM = "generic";

/** Where a module is in the registry. */
export interface RegistryAddress {
  namespace: string;
  name: string;
  system: string;
  /** `<host>/<namespace>/<name>/<system>`, the source a root writes. */
  source: string;
  /** The module's directory under the registry root: `v1/modules/<namespace>/<name>/<system>`. */
  path: string;
}

/** The host a registry's sources name: `registry.url` without its scheme. */
export const registryHost = (reg: Pick<RegistrySettings, "url">): string => new URL(reg.url).host.toLowerCase();

/** The namespace a module's path goes under: the longest `namespaces` prefix it starts with, else `namespace`. */
export function namespaceFor(reg: Pick<RegistrySettings, "namespace" | "namespaces">, rel: string): string {
  let best: { prefix: string; ns: string } | undefined;
  for (const [prefix, ns] of Object.entries(reg.namespaces ?? {})) {
    const p = prefix.replace(/^\.\//, "");
    const dir = p.endsWith("/") ? p : `${p}/`;
    if ((rel.startsWith(dir) || rel === p.replace(/\/+$/, "")) && (!best || p.length > best.prefix.length)) best = { prefix: p, ns };
  }
  return best?.ns ?? reg.namespace;
}

export function registryAddress(reg: Pick<RegistrySettings, "url" | "namespace" | "namespaces" | "system">, rel: string): RegistryAddress {
  const namespace = namespaceFor(reg, rel);
  const name = posix.basename(rel);
  const system = reg.system ?? DEFAULT_SYSTEM;
  if (!REGISTRY_NAME.test(name)) throw new ConfigError(`${rel}: a registry module's name is letters, digits, - and _, and ${JSON.stringify(name)} is not; rename the directory`);
  return { namespace, name, system, source: `${registryHost(reg)}/${namespace}/${name}/${system}`, path: `v1/modules/${namespace}/${name}/${system}` };
}

/** The protocol's versions answer. */
export function versionsDoc(versions: string[]): string {
  const sorted = [...new Set(versions)].map((v) => parseSemver(v)!).filter(Boolean).sort(compareSemver).map(formatSemver);
  return `${JSON.stringify({ modules: [{ versions: sorted.map((version) => ({ version })) }] }, null, 2)}\n`;
}

export function readVersions(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as { modules?: { versions?: { version?: unknown }[] }[] };
    return (doc.modules?.[0]?.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** What the registry keeps beside a version, so the next publish knows what it holds. */
export interface ReleaseMeta {
  module: string;
  version: string;
  revision: string;
  content: string;
  location: string;
}

/** The files the registry is written to: a bucket, or a directory for a Pages site. */
export type RegistryStore = Pick<ObjectStore, "location" | "put" | "read">;

/** A directory in the repo, written as a bucket is. */
export function dirStore(root: string): RegistryStore {
  return {
    location: root,
    async put(key, body) {
      const file = join(root, key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return {};
    },
    async read(key) {
      const file = join(root, key);
      return existsSync(file) ? { body: readFileSync(file, "utf-8") } : {};
    },
  };
}

export function registryStore(repo: string, reg: RegistrySettings, env: NodeJS.ProcessEnv = process.env, fetchFn?: Parameters<typeof storeFromEnv>[2]): RegistryStore {
  if (reg.dir) return dirStore(join(repo, reg.dir));
  return storeFromEnv({ bucket: reg.bucket!, ...(reg.endpoint ? { endpoint: reg.endpoint } : {}) }, env, fetchFn);
}

/** A key under `registry.prefix`. */
export const keyFor = (reg: Pick<RegistrySettings, "prefix">, path: string): string => {
  const prefix = (reg.prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${path}` : path;
};

/** The registry's files for one version, in the order they are written: the version is listed last, once all it points at is there. */
export interface VersionFiles {
  tarball?: { key: string; body: Buffer };
  download: { key: string; body: string };
  meta: { key: string; body: string };
}

export async function writeVersion(store: RegistryStore, reg: RegistrySettings, addr: RegistryAddress, version: Semver, files: VersionFiles): Promise<void> {
  const discovery = `${JSON.stringify({ "modules.v1": MODULES_V1 })}\n`;
  const disco = await store.read(keyFor(reg, DISCOVERY));
  if (disco.body !== discovery) await store.put(keyFor(reg, DISCOVERY), discovery, "application/json");
  if (files.tarball) await store.put(files.tarball.key, files.tarball.body, "application/gzip");
  await store.put(files.download.key, files.download.body, "application/json");
  await store.put(files.meta.key, files.meta.body, "application/json");
  const key = keyFor(reg, `${addr.path}/versions`);
  // Read, add, write only over the copy read: two publishes at once cannot drop each other's version.
  for (let attempt = 0; ; attempt++) {
    const held = await store.read(key);
    const when: StoreCondition | undefined = held.body === undefined ? { ifNoneMatch: "*" } : held.etag ? { ifMatch: held.etag } : undefined;
    try {
      await store.put(key, versionsDoc([...readVersions(held.body), formatSemver(version)]), "application/json", when);
      return;
    } catch (e) {
      if (!(e instanceof StoreConflict) || attempt >= 3) throw e;
    }
  }
}

/** The location a version's download answer gives. */
export function downloadDoc(location: string): string {
  return `${JSON.stringify({ location })}\n`;
}

/** The tarball's name beside its version. */
export const tarballName = (addr: RegistryAddress, version: string): string => `${addr.name}-${version}.tar.gz`;

// ---- reading a registry, as Terraform and OpenTofu do ------------------------

const httpGet = async (fetchFn: Fetch, url: string): Promise<Response> => {
  try {
    return await fetchFn(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    throw new RegistryError(`${url}: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
  }
};

/** A registry source split into its host and module, or undefined when the source is not one: `host/ns/name/system`, with an optional `//subdir`. */
export function parseRegistrySource(source: string): { host: string; namespace: string; name: string; system: string } | undefined {
  const base = source.split("?")[0]!.split("//")[0]!;
  const m = /^([a-z0-9.-]+(?::\d+)?)\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(base);
  if (!m || !m[1]!.includes(".") && !m[1]!.includes(":") && m[1] !== "localhost") return undefined;
  return { host: m[1]!.toLowerCase(), namespace: m[2]!, name: m[3]!, system: m[4]! };
}

/** The modules.v1 base a host's service discovery names. */
export async function modulesBase(host: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string> {
  const disco = `https://${host}/${DISCOVERY}`;
  const res = await httpGet(fetchFn, disco);
  if (!res.ok) throw new RegistryError(`${disco} answered ${res.status}`);
  let base: unknown;
  try {
    base = ((await res.json()) as Record<string, unknown>)["modules.v1"];
  } catch {
    throw new RegistryError(`${disco} is not JSON`);
  }
  if (typeof base !== "string") throw new RegistryError(`${disco} names no modules.v1`);
  const url = new URL(base, disco).toString();
  return url.endsWith("/") ? url : `${url}/`;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Every version a registry lists for a module. */
export async function registryVersions(source: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string[]> {
  const s = parseRegistrySource(source);
  if (!s) throw new RegistryError(`${source} is not a registry source`);
  const url = `${await modulesBase(s.host, fetchFn)}${s.namespace}/${s.name}/${s.system}/versions`;
  const res = await httpGet(fetchFn, url);
  if (res.status === 404) return [];
  if (!res.ok) throw new RegistryError(`${url} answered ${res.status}`);
  return readVersions(await res.text());
}

/** Where a registry says one version is: the download answer's header or JSON `location`, resolved against its URL. */
export async function registryLocation(source: string, version: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string> {
  const s = parseRegistrySource(source);
  if (!s) throw new RegistryError(`${source} is not a registry source`);
  const url = `${await modulesBase(s.host, fetchFn)}${s.namespace}/${s.name}/${s.system}/${version}/download`;
  const res = await httpGet(fetchFn, url);
  if (res.status === 404) throw new RegistryError(`${s.host}/${s.namespace}/${s.name}/${s.system} has no version ${version}`);
  if (!res.ok) throw new RegistryError(`${url} answered ${res.status}`);
  let location = res.headers.get("x-terraform-get") ?? undefined;
  if (!location) {
    try {
      const body = (await res.json()) as { location?: unknown };
      if (typeof body.location === "string") location = body.location;
    } catch {
      /* no body */
    }
  }
  if (!location) throw new RegistryError(`${url} names no location`);
  if (/^(\.{0,2}\/)/.test(location)) location = new URL(location, url).toString();
  return location;
}

/** The module archive a tarball location holds, uncompressed: the bytes a release's digest is of. */
export async function fetchTarball(location: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Buffer> {
  const res = await httpGet(fetchFn, location);
  if (!res.ok) throw new RegistryError(`${location} answered ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(body);
  } catch {
    throw new RegistryError(`${location} is not a gzip archive`);
  }
}

/** The newest of a list of versions. */
export function newest(versions: string[]): Semver | undefined {
  let best: Semver | undefined;
  for (const v of versions) {
    const p = parseSemver(v);
    if (p && (!best || compareSemver(p, best) > 0)) best = p;
  }
  return best;
}
