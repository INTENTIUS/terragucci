/**
 * What `rollouts.watch` and the estate report read about releases: the
 * versions a module or provider has published, and when one was published.
 *
 * Both reads are injected (`ReleaseSources`), so a test answers them and
 * nothing here reaches a registry on its own. The default reads the module
 * registry protocol (a module's versions), the provider registry protocol (a
 * provider's versions), and an OCI repository's tags for an `oci://` module.
 * A release date is read from the registry's version document
 * (`published_at`), which the public registries serve; a static registry or
 * an OCI repository gives none, and a release with no date cannot meet a
 * `min_age`.
 */
import { modulesBase, parseRegistrySource, registryVersions } from "@intentius/chant-lexicon-terraform/registry";
import type { FollowBump } from "../config";
import type { Fetch } from "../publish/oci";
import { bumpBetween, compareSemver, formatSemver, parseSemver, type Bump, type Semver } from "../publish/semver";
import { publishedVersions } from "./discover";

export type SubjectKind = "module" | "provider";

/** A module (by its source without the pin) or a provider (by its address). */
export interface Subject {
  kind: SubjectKind;
  name: string;
}

export interface ReleaseSources {
  /** Every version the subject has published, or undefined for a kind of source this does not read (a git module). */
  versions(subject: Subject): Promise<string[] | undefined>;
  /** When one version was published, as an ISO time, when the source says. */
  published(subject: Subject, version: string): Promise<string | undefined>;
}

export const DEFAULT_REGISTRY_HOST = "registry.terraform.io";

/** A module or provider as its registry address: the short form `hashicorp/aws` is on the public registry. */
export function withHost(name: string, parts: number): string {
  const segments = name.split("/");
  return segments.length === parts && !segments[0]!.includes(".") && !segments[0]!.includes(":") ? `${DEFAULT_REGISTRY_HOST}/${name}` : name;
}

/** The names a glob may be matched against: the address as written, and without its host. */
export function namesOf(subject: Subject): string[] {
  const n = subject.name;
  if (/^oci:\/\//.test(n)) return [n, n.replace(/^oci:\/\//, "")];
  const full = withHost(n, subject.kind === "module" ? 3 : 2);
  const bare = full.replace(/^[^/]*[.:][^/]*\//, "");
  return [...new Set([n, full, bare])];
}

const globalFetch: Fetch = (url, init) => globalThis.fetch(url, init);

async function json(fetch: Fetch, url: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** A provider registry's base URL, from the host's discovery document. */
async function providersBase(fetch: Fetch, host: string): Promise<string> {
  const doc = (await json(fetch, `https://${host}/.well-known/terraform.json`)) as Record<string, unknown> | undefined;
  const base = typeof doc?.["providers.v1"] === "string" ? (doc["providers.v1"] as string) : "/v1/providers/";
  const url = new URL(base, `https://${host}/.well-known/terraform.json`).toString();
  return url.endsWith("/") ? url : `${url}/`;
}

/** The default sources: the registries a module call or a lock file names. */
export function registrySources(options: { fetch?: Fetch } = {}): ReleaseSources {
  const fetch = options.fetch ?? globalFetch;
  return {
    async versions(s) {
      if (s.kind === "module") {
        if (s.name.startsWith("oci://")) return (await publishedVersions({ module: s.name, repos: [], oci: [s.name], fetch })).map((f) => f.version);
        const source = withHost(s.name, 3);
        if (!parseRegistrySource(source)) return undefined;
        return registryVersions(source, fetch);
      }
      const [host, namespace, type] = withHost(s.name, 2).split("/");
      if (!host || !namespace || !type) return undefined;
      const doc = (await json(fetch, `${await providersBase(fetch, host)}${namespace}/${type}/versions`)) as { versions?: Array<{ version?: unknown }> } | undefined;
      if (!doc) throw new Error(`${host} did not list the versions of ${namespace}/${type}`);
      return (doc.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string");
    },
    async published(s, version) {
      let doc: unknown;
      if (s.kind === "module") {
        const source = parseRegistrySource(withHost(s.name, 3));
        if (!source) return undefined;
        try {
          doc = await json(fetch, `${await modulesBase(source.host, fetch)}${source.namespace}/${source.name}/${source.system}/${version}`);
        } catch {
          return undefined;
        }
      } else {
        const [host, namespace, type] = withHost(s.name, 2).split("/");
        doc = await json(fetch, `${await providersBase(fetch, host!)}${namespace}/${type}/${version}`);
      }
      const at = (doc as { published_at?: unknown } | undefined)?.published_at;
      return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : undefined;
    },
  };
}

/** The releases a list holds that are plain versions, newest first; a pre-release is not one. */
export function plainReleases(versions: string[]): Semver[] {
  const seen = new Map<string, Semver>();
  for (const v of versions) {
    const s = parseSemver(v);
    if (s) seen.set(formatSemver(s), s);
  }
  return [...seen.values()].sort((a, b) => compareSemver(b, a));
}

export interface Pick {
  /** The release to move to. */
  to?: string;
  /** Why a newer release was passed over, when `to` is absent or older than the newest. */
  held?: string;
}

/**
 * The release a rule moves `current` to: the newest one that is a bump the
 * rule follows and that is old enough. A newer release the rule does not
 * follow, or that is too young, does not stop an older one that qualifies.
 */
export async function pickRelease(
  current: string,
  releases: Semver[],
  rule: { follow: readonly FollowBump[]; minAgeMs?: number },
  published: (version: string) => Promise<string | undefined>,
  now: Date,
): Promise<Pick> {
  const at = parseSemver(current);
  if (!at) return {};
  // A release too young resolves by waiting, so it is the reason given before one the rule does not follow.
  let wrongBump: string | undefined;
  let tooYoung: string | undefined;
  for (const r of releases) {
    if (compareSemver(r, at) <= 0) break;
    const version = formatSemver(r);
    const bump = bumpBetween(at, r);
    if (!rule.follow.includes(bump)) {
      wrongBump ??= `${version} is a ${bump} release and the rule follows ${rule.follow.join(", ")}`;
      continue;
    }
    if (rule.minAgeMs !== undefined) {
      const date = await published(version);
      if (date === undefined) {
        tooYoung ??= `${version} has no release date, so it cannot meet min_age`;
        continue;
      }
      const age = now.getTime() - Date.parse(date);
      if (age < rule.minAgeMs) {
        tooYoung ??= `${version} was published ${days(age)} ago, under min_age`;
        continue;
      }
    }
    const held = tooYoung ?? wrongBump;
    return { to: version, ...(held ? { held } : {}) };
  }
  const held = tooYoung ?? wrongBump;
  return held ? { held } : {};
}

function days(ms: number): string {
  const h = Math.max(0, Math.floor(ms / 3_600_000));
  return h >= 48 ? `${Math.floor(h / 24)}d` : `${h}h`;
}

/** How far a version is behind a subject's releases. */
export interface Behind {
  /** The newest release. */
  latest: string;
  /** How many releases are newer than the version. */
  releases: number;
  /** The bump from the version to the newest release. */
  bump: Bump;
}

/** Undefined when the version is current, or is not a plain version. */
export function behindOf(version: string, releases: Semver[]): Behind | undefined {
  const at = parseSemver(version);
  const newest = releases[0];
  if (!at || !newest || compareSemver(newest, at) <= 0) return undefined;
  return { latest: formatSemver(newest), releases: releases.filter((r) => compareSemver(r, at) > 0).length, bump: bumpBetween(at, newest) };
}
