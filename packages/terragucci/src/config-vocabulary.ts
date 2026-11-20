/**
 * terragucci.yml against chant's product vocabulary (the page "CI Product
 * Config Keys"): each setting has one key there, and terragucci keeps reading
 * the spelling it used before. chant's `productConfigProblems` does the
 * checking: an earlier spelling is a warning that names the key, and a
 * spelling set beside its key is an error. This file moves each key onto the
 * spelling the rest of terragucci reads, so one shape reaches the checks, the
 * pipeline and the jobs.
 *
 * | Key | Earlier spelling, still read |
 * |---|---|
 * | `gate: on-destructive` | `gate: on-destroy` |
 * | `branches.<branch>` | `apply.branches` |
 * | `locks.when` | `locks: <when>` |
 * | `drift.schedule` | `drift: <cron>` |
 * | `identity` | `oidc` |
 * | `forge_url` | `url` |
 * | `notify.relay_name` | `notify.relay` |
 */

import { productConfigProblems, type ProductConfigProblem } from "@intentius/chant/ci-product";

/** The product name in chant's vocabulary. */
const PRODUCT = "terragucci";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The keys of the vocabulary that terragucci spelled another way, as terragucci reads them. */
export const VOCABULARY_KEYS = ["identity", "forge_url", "branches"] as const;

/** One settings map's findings from chant's check, each path under `where`. */
function problemsOf(settings: unknown, where: string): ProductConfigProblem[] {
  return productConfigProblems(settings, { product: PRODUCT }).map((p) => ({ ...p, path: where === "" ? p.path : `${where}.${p.path}` }));
}

/** The maps of settings in a parsed config, each with the name its problems are reported under. */
function settingsMaps(raw: Record<string, unknown>): { where: string; settings: Record<string, unknown> }[] {
  const out: { where: string; settings: Record<string, unknown> }[] = [];
  const { defaults, projects, ...rest } = raw;
  if (isObject(projects)) {
    for (const [key, s] of Object.entries(projects)) if (isObject(s)) out.push({ where: `projects["${key}"]`, settings: s });
  } else out.push({ where: "", settings: rest });
  if (isObject(defaults)) out.push({ where: "defaults", settings: defaults });
  return out;
}

/** chant's findings for a parsed config: a warning for each earlier spelling, an error for one set beside its key. */
export function vocabularyProblems(raw: unknown): ProductConfigProblem[] {
  if (!isObject(raw)) return [];
  return settingsMaps(raw).flatMap(({ where, settings }) => problemsOf(settings, where));
}

/** A finding as a line: where it is, what it says. The key is the one the line names. */
export function describeProblem(p: ProductConfigProblem): string {
  return `${p.path} ${p.message}`;
}

/**
 * The warnings for a parsed config's earlier spellings, one line each, naming
 * the key. The errors chant reports for values are terragucci's own checks'
 * to word, so only the earlier spellings and the pairs are read here.
 */
export function vocabularyWarnings(raw: unknown): string[] {
  return vocabularyProblems(raw).filter((p) => p.level === "warning").map(describeProblem);
}

/** The errors chant reports for a key set beside its earlier spelling, as lines. */
export function vocabularyPairErrors(raw: unknown): string[] {
  return vocabularyProblems(raw).filter((p) => p.level === "error" && p.message.includes("are both set")).map(describeProblem);
}

/** One map of settings with each vocabulary key moved onto the spelling the rest of terragucci reads. */
function readSettings(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  const move = (key: string, to: string): void => {
    if (!(key in out)) return;
    out[to] = out[key];
    delete out[key];
  };
  move("identity", "oidc");
  move("forge_url", "url");
  if (isObject(out.branches)) {
    out.apply = { ...(isObject(out.apply) ? out.apply : {}), branches: out.branches };
    delete out.branches;
  }
  // `locks` and `drift` take a map of one key, where an earlier file wrote the value alone.
  if (isObject(out.locks) && Object.keys(out.locks).length === 1 && "when" in out.locks) out.locks = out.locks.when;
  if (isObject(out.drift) && Object.keys(out.drift).length === 1 && "schedule" in out.drift) out.drift = out.drift.schedule;
  if (isObject(out.notify) && "relay_name" in out.notify) {
    const { relay_name: name, ...rest } = out.notify;
    out.notify = { ...rest, relay: name };
  }
  return out;
}

/**
 * The config with each vocabulary key moved onto the spelling the rest of
 * terragucci reads: `identity` as `oidc`, `forge_url` as `url`,
 * `branches` as `apply.branches`, `locks.when` as `locks`, `drift.schedule`
 * as `drift` and `notify.relay_name` as `notify.relay`. A key set beside its
 * earlier spelling is refused by {@link vocabularyPairErrors} before this runs.
 */
export function readVocabulary(raw: Record<string, unknown>): Record<string, unknown> {
  const { defaults, projects, ...rest } = raw;
  if (!isObject(projects)) return { ...readSettings(rest), ...(isObject(defaults) ? { defaults: readSettings(defaults) } : defaults !== undefined ? { defaults } : {}) };
  return {
    ...rest,
    projects: Object.fromEntries(Object.entries(projects).map(([k, s]) => [k, isObject(s) ? readSettings(s) : s])),
    ...(isObject(defaults) ? { defaults: readSettings(defaults) } : defaults !== undefined ? { defaults } : {}),
  };
}
