/**
 * The versions report: which binary, provider and module versions each root
 * runs. A `tf-apply` wave reads them for each root that applied (or had
 * nothing to apply), from the checkout of the applied commit after `init`:
 * the providers `.terraform.lock.hcl` locks, and the remote module calls
 * `.terraform/modules/modules.json` records, nested calls included. The
 * report carries them as `roots[].versions` beside `roots[].binary`, and the
 * upload keeps each root's newest in `<prefix>/<project>/versions.json`,
 * which `terragucci estate` rolls up per module, provider and binary, and
 * `terragucci query` loads as its `versions` table.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readLock, LOCK_FILE } from "../rollout/lock";
import type { Report, ReportRootBinary, ReportRootVersions } from "./schema";

export const VERSIONS_SCHEMA = "terragucci.versions/v1";

/** One root's versions, as its newest applied wave left them. */
export interface VersionsRoot {
  root: string;
  commit: string;
  /** When the wave that recorded them finished. */
  finished: string;
  wave?: number;
  /** The run's directory, relative to the project's index. */
  path: string;
  /** The environment of `environments:` the root was in when the wave applied. Absent when it was in none. */
  environment?: string;
  /** The binary it ran, its version and where it pinned it, as `roots[].binary` names them. */
  binary?: ReportRootBinary;
  providers: ReportRootVersions["providers"];
  modules: ReportRootVersions["modules"];
}

export interface Versions {
  schema: typeof VERSIONS_SCHEMA;
  /** By root path. */
  roots: VersionsRoot[];
}

/** A source's query keys that pin a release, in the order one is taken. */
const PIN_KEYS = ["ref", "tag", "version"] as const;

/** A modules.json source without its query, and the release its query pins. */
export function splitSource(source: string): { source: string; version?: string } {
  const at = source.indexOf("?");
  if (at < 0) return { source };
  const query = new URLSearchParams(source.slice(at + 1));
  const pin = PIN_KEYS.map((k) => query.get(k)).find((v) => v);
  return { source: source.slice(0, at), ...(pin ? { version: pin } : {}) };
}

const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a root's lock file and modules.json hold after `init`: each locked
 * provider with its version, and each remote module call with its source and
 * the version init resolved or the source pins. `env` gives `TF_DATA_DIR`
 * when one is set. A file that is missing or unreadable adds nothing.
 */
export function rootVersions(dir: string, env: NodeJS.ProcessEnv = {}): ReportRootVersions {
  const providers: ReportRootVersions["providers"] = [];
  const lock = join(dir, LOCK_FILE);
  if (existsSync(lock)) {
    for (const [provider, version] of readLock(readFileSync(lock, "utf-8"))) providers.push({ provider, version });
  }
  const modules: ReportRootVersions["modules"] = [];
  const data = env.TF_DATA_DIR ? (isAbsolute(env.TF_DATA_DIR) ? env.TF_DATA_DIR : join(dir, env.TF_DATA_DIR)) : join(dir, ".terraform");
  const manifest = join(data, "modules", "modules.json");
  if (existsSync(manifest)) {
    let recorded: unknown[] = [];
    try {
      const doc = JSON.parse(readFileSync(manifest, "utf-8")) as { Modules?: unknown };
      if (Array.isArray(doc.Modules)) recorded = doc.Modules;
    } catch {
      // An unreadable modules.json names no call.
    }
    for (const m of recorded as { Key?: unknown; Source?: unknown; Version?: unknown }[]) {
      if (typeof m.Key !== "string" || m.Key === "" || typeof m.Source !== "string" || isLocal(m.Source)) continue;
      const { source, version } = splitSource(m.Source);
      const resolved = typeof m.Version === "string" && m.Version !== "" ? m.Version : version;
      modules.push({ call: m.Key.split(".").map((k) => `module.${k}`).join("."), source, ...(resolved ? { version: resolved } : {}) });
    }
  }
  return { providers: providers.sort((a, b) => byText(a.provider, b.provider)), modules: modules.sort((a, b) => byText(a.call, b.call)) };
}

/** The roots of a report that recorded their versions: a `tf-apply` wave's roots that applied. */
export function versionsRoots(report: Report, path: string): VersionsRoot[] {
  if (report.run.stage !== "tf-apply") return [];
  return report.roots
    .filter((r) => r.versions !== undefined)
    .map((r) => ({
      root: r.path,
      commit: report.run.commit,
      finished: report.run.finished,
      ...(report.run.wave !== undefined ? { wave: report.run.wave } : {}),
      path,
      ...(r.environment ? { environment: r.environment } : {}),
      ...(r.binary ? { binary: r.binary } : {}),
      providers: r.versions!.providers,
      modules: r.versions!.modules,
    }));
}

/** Read a versions report; anything unreadable is an empty one, rebuilt from the next apply on. */
export function readVersions(text: string | undefined): Versions {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<Versions>;
      if (parsed.schema === VERSIONS_SCHEMA && Array.isArray(parsed.roots)) return { schema: VERSIONS_SCHEMA, roots: parsed.roots };
    } catch {
      // An unreadable versions.json is rebuilt.
    }
  }
  return { schema: VERSIONS_SCHEMA, roots: [] };
}

/** The versions with each root's entry replaced by the one given, unless the file holds a newer one for that root. */
export function addToVersions(existing: string | undefined, roots: VersionsRoot[]): Versions {
  const held = new Map(readVersions(existing).roots.map((r) => [r.root, r]));
  for (const r of roots) {
    const old = held.get(r.root);
    if (!old || !(Date.parse(old.finished) > Date.parse(r.finished))) held.set(r.root, r);
  }
  return { schema: VERSIONS_SCHEMA, roots: [...held.values()].sort((a, b) => byText(a.root, b.root)) };
}

/** A root that runs a version, by project; for a module, the call that names it. */
export interface EstateVersionRoot {
  project: string;
  root: string;
  call?: string;
}

/** One version in use and the roots on it. An absent version: the root's binary did not say, or the module's source names none. */
export interface EstateVersionRow {
  version?: string;
  roots: EstateVersionRoot[];
}

/** The estate's versions: per binary, provider and module source, each version in use, newest first, and the roots on it. */
export interface EstateVersions {
  binaries: { binary: string; versions: EstateVersionRow[] }[];
  providers: { provider: string; versions: EstateVersionRow[] }[];
  modules: { source: string; versions: EstateVersionRow[] }[];
}

/** Newest first, comparing the numbers in a version as numbers; an absent version last. */
const newestFirst = (a: EstateVersionRow, b: EstateVersionRow): number =>
  a.version === undefined ? (b.version === undefined ? 0 : 1) : b.version === undefined ? -1 : b.version.localeCompare(a.version, "en", { numeric: true });

const byRoot = (a: EstateVersionRoot, b: EstateVersionRoot): number => byText(a.project, b.project) || byText(a.root, b.root) || byText(a.call ?? "", b.call ?? "");

function rollUp<K extends string>(key: K, rows: { name: string; version?: string; root: EstateVersionRoot }[]): ({ [P in K]: string } & { versions: EstateVersionRow[] })[] {
  const by = new Map<string, Map<string, EstateVersionRow>>();
  for (const r of rows) {
    const versions = by.get(r.name) ?? new Map<string, EstateVersionRow>();
    by.set(r.name, versions);
    const v = r.version ?? "\u0000";
    const row = versions.get(v) ?? { ...(r.version !== undefined ? { version: r.version } : {}), roots: [] };
    versions.set(v, row);
    row.roots.push(r.root);
  }
  return [...by]
    .sort(([a], [b]) => byText(a, b))
    .map(([name, versions]) => ({ [key]: name, versions: [...versions.values()].map((v) => ({ ...v, roots: v.roots.sort(byRoot) })).sort(newestFirst) }) as { [P in K]: string } & { versions: EstateVersionRow[] });
}

/** Every project's versions rolled up: per binary, provider and module source, which roots run which version. */
export function estateVersions(projects: { project: string; versions?: Versions }[]): EstateVersions | undefined {
  const roots = projects.flatMap((p) => (p.versions?.roots ?? []).map((r) => ({ project: p.project, r })));
  if (roots.length === 0) return undefined;
  return {
    binaries: rollUp("binary", roots.filter(({ r }) => r.binary).map(({ project, r }) => ({ name: r.binary!.name, ...(r.binary!.version ? { version: r.binary!.version } : {}), root: { project, root: r.root } }))),
    providers: rollUp("provider", roots.flatMap(({ project, r }) => r.providers.map((p) => ({ name: p.provider, version: p.version, root: { project, root: r.root } })))),
    modules: rollUp("source", roots.flatMap(({ project, r }) => r.modules.map((m) => ({ name: m.source, ...(m.version ? { version: m.version } : {}), root: { project, root: r.root, call: m.call } })))),
  };
}
