/**
 * The control repo's storage: chant's control entries (terragucci#753, chant#4568).
 *
 * A control repo's projects and its shared defaults are entries of chant
 * core's control ledger: lines of `_control/entries.jsonl` on the control
 * repo's `chant/lifecycle`, read and written through
 * `@intentius/chant/ci-control` with terragucci's config check as chant's
 * `validate`. `reconcile` reads the active entries the way it read
 * terragucci.yml's `projects:` and `defaults:`.
 *
 * One entry per project (`entry: project`, `project: <host>/<owner>/<name>`,
 * `settings`: that project's ProjectSettings, `estates`: the choudoufu estates
 * the project owns) and one for the defaults (`entry: defaults`).
 *
 * The record files of 0.4.54 and earlier (terragucci/records, read through
 * `chant workspace records`) are no longer read. 0.4.54 is the last release
 * whose `terragucci control records migrate` moves them onto the ledger.
 */
import * as ciControl from "@intentius/chant/ci-control";
import type { ChantCiControl, ChantControlEntry, ChantControlLedgerPort } from "./chant-next";
import { ConfigError, parseProjectKey, validateConfig, type ProjectSettings, type TerragucciConfig } from "./config";

export const ENTRY_KINDS = ["project", "defaults"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** One control-repo entry as chant read it. */
export interface ControlEntry {
  id: string;
  path: string;
  digest: string;
  entry: EntryKind;
  /** The project key; undefined for the defaults. */
  project?: string;
  settings: ProjectSettings;
  estates: string[];
}

/** The config the entries stand for: what a control repo's terragucci.yml held. */
export function configFromEntries(entries: ControlEntry[], where = "the control repo's entries"): TerragucciConfig {
  const defaults = entries.find((e) => e.entry === "defaults");
  const projects: Record<string, ProjectSettings> = {};
  for (const e of entries.filter((x) => x.entry === "project").sort((a, b) => a.project!.localeCompare(b.project!))) projects[e.project!] = e.settings;
  return validateConfig({ ...(defaults ? { defaults: defaults.settings } : {}), projects }, where);
}

export interface PutResult {
  id: string;
  path: string;
  /** created: a new entry. updated: an active entry amended. unchanged: it already held these settings. */
  status: "created" | "updated" | "unchanged";
}

/** Checks one entry's settings the way the config would, before chant sees them. */
function checkSettings(entry: EntryKind, project: string | undefined, settings: ProjectSettings): void {
  if (entry === "project") {
    parseProjectKey(project ?? "");
    validateConfig({ projects: { [project!]: settings } }, `project ${project}`);
  } else {
    validateConfig({ defaults: settings, projects: {} }, "defaults");
  }
}

// ── estate ownership ─────────────────────────────────────────────────────────

/** Who claims each estate in the active entries: estate name to project keys. */
export function estateClaims(entries: ControlEntry[]): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const e of entries) {
    if (e.entry !== "project") continue;
    for (const estate of e.estates) claims.set(estate, [...(claims.get(estate) ?? []), e.project!]);
  }
  return claims;
}

// ── the control repo's ledger (chant#4568) ───────────────────────────────────

/** Where an entry read from the ledger is: the file on the control repo's chant/lifecycle. */
export const LEDGER_PATH = "chant/lifecycle:_control/entries.jsonl";

/** The product the ledger's entries are written as. */
const PRODUCT = "terragucci";

/** chant's control repo and the ledger of the control repo at `dir`. */
export interface ControlLedger {
  chant: ChantCiControl;
  port: ChantControlLedgerPort;
}

/** The control repo's ledger at `dir`, through chant's `@intentius/chant/ci-control`. */
export async function controlLedger(dir: string): Promise<ControlLedger> {
  const chant: ChantCiControl = ciControl;
  return { chant, port: chant.gitControlLedger({ cwd: dir }) };
}

/** Does the control repo's ledger hold entries, so it is the store? */
export async function ledgerHasEntries(ledger: ControlLedger | undefined): Promise<boolean> {
  if (!ledger) return false;
  const text = await ledger.port.read();
  return text !== null && text.trim() !== "";
}

/** terragucci's config check of one entry's settings, as chant's `validate`: the problems, none when it passes. */
export function validateSettings(entry: EntryKind, project: string | undefined, settings: Record<string, unknown>): string[] {
  try {
    checkSettings(entry, project, settings as ProjectSettings);
    return [];
  } catch (e) {
    const problems = (e as ConfigError & { problems?: string[] }).problems;
    return problems && problems.length > 0 ? problems : [(e as Error).message];
  }
}

const fromLedger = (e: ChantControlEntry): ControlEntry => ({
  id: e.id,
  path: LEDGER_PATH,
  digest: e.digest,
  entry: e.entry,
  ...(e.project !== undefined ? { project: e.project } : {}),
  settings: e.settings as ProjectSettings,
  estates: e.estates,
});

/** chant's errors as terragucci's, so the CLI reports them as config errors. */
async function asConfig<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const problems = (e as { problems?: string[] }).problems;
    throw new ConfigError(`${what}: ${(e as Error).message}`, problems);
  }
}

/** Does the control repo at `dir` keep entries on its ledger? */
export async function hasControlEntries(dir: string): Promise<boolean> {
  return ledgerHasEntries(await controlLedger(dir));
}

/** The active entries on the control repo's ledger, each checked. */
export async function readEntriesAt(dir: string): Promise<ControlEntry[]> {
  const ledger = await controlLedger(dir);
  const entries = await asConfig("reading the control repo's entries", () => ledger.chant.readControlEntries(ledger.port, { validate: validateSettings }));
  return entries.map(fromLedger);
}

/**
 * Creates the project's (or the defaults') entry on the ledger, or amends the
 * active one. `estates` left out keeps the entry's. The ledger commit is
 * local: push chant/lifecycle after.
 */
export async function putEntryAt(dir: string, want: { entry: EntryKind; project?: string; settings: ProjectSettings; estates?: string[] }, dryRun = false): Promise<PutResult> {
  const ledger = await controlLedger(dir);
  const r = await asConfig(`writing ${want.project ?? "defaults"}`, () =>
    ledger.chant.putControlEntry(ledger.port, { entry: want.entry, ...(want.project ? { project: want.project } : {}), settings: want.settings as Record<string, unknown>, ...(want.estates ? { estates: want.estates } : {}) }, { product: PRODUCT, validate: validateSettings, dryRun }),
  );
  return { id: r.id, path: LEDGER_PATH, status: r.status === "retired" ? "updated" : r.status };
}

/** Retires a project's active entry, so the project is no longer read. */
export async function retireEntryAt(dir: string, project: string, dryRun = false): Promise<PutResult> {
  const ledger = await controlLedger(dir);
  const r = await asConfig(`retiring ${project}`, () => ledger.chant.retireControlEntry(ledger.port, project, { product: PRODUCT, dryRun }));
  return { id: r.id, path: LEDGER_PATH, status: "updated" };
}

/** Writes a terragucci.yml-shaped config onto the ledger, one entry per project and one for the defaults. Moves a control repo off its file. */
export async function importControlConfigAt(dir: string, config: TerragucciConfig, dryRun = false): Promise<(PutResult & { entry: string })[]> {
  if (!config.projects || Object.keys(config.projects).length === 0) throw new ConfigError("only a control repo's config, which lists projects, becomes entries");
  const ledger = await controlLedger(dir);
  const projects = config.projects as Record<string, Record<string, unknown>>;
  const out = await asConfig("importing the control repo's config", () =>
    ledger.chant.importControlConfig(ledger.port, { ...(config.defaults ? { defaults: config.defaults as Record<string, unknown> } : {}), projects }, { product: PRODUCT, validate: validateSettings, dryRun }),
  );
  return out.map((r) => ({ entry: r.entry, id: r.id, path: LEDGER_PATH, status: r.status === "retired" ? "updated" : r.status }));
}

/** The estates' claims on the control repo's ledger, read now. Called at every plan; nothing is kept between plans. */
export async function readClaimsAt(dir: string): Promise<Map<string, string[]>> {
  return estateClaims(await readEntriesAt(dir));
}
