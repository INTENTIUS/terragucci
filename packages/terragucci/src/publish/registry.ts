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
 * The stored download answer is the JSON body with `location`. OpenTofu reads
 * that body; Terraform reads only the X-Terraform-Get header, which a static
 * bucket or Pages site cannot send (terragucci#1287), so whatever serves the
 * files has to add it. The location is a tarball beside it, the module's git
 * tag, or its OCI artifact.
 *
 * A module's namespace is `registry.namespace`, or the namespace
 * `registry.namespaces` maps the longest prefix of its path (its tag prefix)
 * to, so the modules of a monorepo's parts publish under namespaces of their
 * own. Its name is the last segment of its path.
 *
 * The protocol code is chant's terraform lexicon's
 * (`@intentius/chant-lexicon-terraform/registry`, chant#4565): the writer and
 * the reader below call it. This file keeps the config mapping
 * (registryStore, keyFor and the settings shapes).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import {
  fetchTarball as lexiconFetchTarball,
  headersFile,
  PAGES_HEADER_RULES,
  registryLocation as lexiconRegistryLocation,
  registryVersions as lexiconRegistryVersions,
  writeVersion as lexiconWriteVersion,
  type RegistryFetch,
} from "@intentius/chant-lexicon-terraform/registry";
import { ConfigError, REGISTRY_NAME, type RegistrySettings } from "../config";
import { storeFromEnv } from "../report/bucket";
import { StoreConflict, type ObjectStore } from "../report/object-store";
import type { Fetch } from "./oci";
import type { Semver } from "./semver";

export { downloadDoc, newest, parseRegistrySource, readVersions, RegistryError, tarballName, versionsDoc } from "@intentius/chant-lexicon-terraform/registry";

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
  return lexiconWriteVersion(store, addr, version, files, { prefix: reg.prefix, isConflict: (e) => e instanceof StoreConflict });
}

/** The file Cloudflare Pages and Netlify read their response headers from, at the site's root. */
export const HEADERS_FILE = "_headers";

/**
 * `edge: pages`: add a version's X-Terraform-Get rule to the site's
 * `_headers` file, keeping every rule already there (chant#4566's
 * `headersFile`). Returns a note for the publish row when the file holds more
 * rules than Cloudflare Pages reads.
 */
export async function writeHeadersFile(store: RegistryStore, reg: Pick<RegistrySettings, "prefix">, rule: { path: string; location: string }): Promise<string | undefined> {
  const key = keyFor(reg, HEADERS_FILE);
  const text = headersFile([{ path: `/${rule.path}`, location: rule.location }], (await store.read(key)).body);
  await store.put(key, text, "text/plain");
  const limit = PAGES_HEADER_RULES;
  const rules = text.split("\n").filter((l) => /^\s+X-Terraform-Get:/i.test(l)).length;
  return rules > limit ? `${HEADERS_FILE} has ${rules} download rules, and Cloudflare Pages reads only ${limit}; serve the registry through edge: cloudflare, or on Netlify` : undefined;
}

// ---- reading a registry, as Terraform and OpenTofu do ------------------------

const asRegistryFetch = (fetchFn: Fetch): RegistryFetch => fetchFn as unknown as RegistryFetch;

/** Every version a registry lists for a module. */
export async function registryVersions(source: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string[]> {
  return lexiconRegistryVersions(source, { fetch: asRegistryFetch(fetchFn) });
}

/** Where a registry says one version is: the download answer's header or JSON `location`, resolved against its URL. */
export async function registryLocation(source: string, version: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string> {
  return lexiconRegistryLocation(source, version, { fetch: asRegistryFetch(fetchFn) });
}

/** The module archive a tarball location holds, uncompressed: the bytes a release's digest is of. */
export async function fetchTarball(location: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Buffer> {
  return lexiconFetchTarball(location, { fetch: asRegistryFetch(fetchFn) });
}
