/**
 * The control repo's storage: chant workspace records (terragucci#753, ws-074).
 *
 * A control repo's projects and its shared defaults are records of one kind,
 * `control-entry`, kept in the repo as files and read and written through
 * `chant workspace records`. The repo is the database: a change to a project
 * is a record written by `new` or `amend` and committed like any other, and
 * `reconcile` reads the active records the way it read terragucci.yml's
 * `projects:` and `defaults:`.
 *
 * One record per project (`entry: project`, `project: <host>/<owner>/<name>`,
 * `settings`: that project's ProjectSettings, `estates`: the choudoufu estates
 * the project owns) and one for the defaults (`entry: defaults`). A record is
 * `active` until it is `retired`, the closed state; a project that comes back
 * gets a new record. Two active records for one project, or two for the
 * defaults, are refused on read.
 *
 * chant is run as a command (`npx --no-install chant`, or `TERRAGUCCI_CHANT`),
 * so this file reads no record file itself and needs chant 0.124.47 or later,
 * which has `workspace records new|amend` and `--where`.
 *
 * chant core holds the control entries now (chant#4568): lines of
 * `_control/entries.jsonl` on the control repo's `chant/lifecycle`, with no
 * record files and no product git writes. When the installed chant has
 * `@intentius/chant/ci-control` and the control repo's ledger has entries,
 * the `*At` functions below read and write there, with terragucci's config
 * check as chant's `validate`. `migrateRecords` (`terragucci control records
 * migrate`) moves a repo's record files onto the ledger with chant's
 * `importControlConfig`. A repo that has not moved keeps its files, on any
 * chant.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chantCiControl, type ChantCiControl, type ChantControlEntry, type ChantControlLedgerPort } from "./chant-next";
import { ConfigError, parseProjectKey, validateConfig, type ProjectSettings, type TerragucciConfig } from "./config";

/** Where `control records init` puts the kind, from the control repo's root. */
export const RECORDS_DIR = "terragucci/records";
export const KIND_FILE = `${RECORDS_DIR}/control-entry.kind.mjs`;
export const SCHEMA_FILE = `${RECORDS_DIR}/control-entry.schema.json`;
export const KIND_NAME = "control-entry";
export const SCHEMA_ID = "urn:intentius:terragucci:control-entry:1";
/** The prefix of a record's id: ctl-001. */
export const ID_PREFIX = "ctl";
export const CHANT_FLOOR = "0.124.47";

export const ENTRY_KINDS = ["project", "defaults"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** The kind file written into the control repo: data only, no imports, as chant loads kinds. */
export const KIND_SOURCE = `// The control repo's record kind (terragucci#753): one record per project and one for the defaults.
// Written by \`npx terragucci control records init\`; read with \`npx terragucci control records list\`.
export const recordKind = {
  name: "${KIND_NAME}",
  location: { dir: ".", match: "^${ID_PREFIX}-[0-9]{3,}-.+\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "${SCHEMA_ID}", path: "control-entry.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["active", "retired"],
  closedStates: ["retired"],
};
`;

/** The kind's JSON Schema. `settings` is checked by terragucci's own schema when the records are read. */
export const KIND_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: SCHEMA_ID,
  title: "A control repo entry",
  description: "The front matter of one file in the control repo's terragucci/records: a project's settings, or the defaults every project gets.",
  type: "object",
  additionalProperties: false,
  patternProperties: { "^x-": {} },
  required: ["schema", "id", "title", "state", "entry", "project", "settings", "estates"],
  properties: {
    schema: { const: 1 },
    id: { type: "string", pattern: `^${ID_PREFIX}-[0-9]{3,}$` },
    title: { description: "The project's key, or defaults.", type: "string", minLength: 1 },
    state: { description: "active until retired. A retired entry is not read.", enum: ["active", "retired"] },
    entry: { enum: [...ENTRY_KINDS] },
    project: { description: "The project's <host>/<owner>/<name> key; null for the defaults.", type: ["string", "null"] },
    settings: { description: "The project's settings, or the defaults, as terragucci.yml holds them.", type: "object" },
    estates: { description: "The choudoufu estates this project owns. Read at each plan to resolve who owns an estate another project reads.", type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
  },
  allOf: [
    { if: { properties: { entry: { const: "project" } } }, then: { properties: { project: { type: "string", minLength: 1 } } } },
    { if: { properties: { entry: { const: "defaults" } } }, then: { properties: { project: { type: "null" }, estates: { maxItems: 0 } } } },
  ],
} as const;

/** One chant call's outcome. */
export interface ChantResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `chant <args>` in `cwd`, with `input` on stdin. Tests pass a fake. */
export type ChantRunner = (args: string[], options: { cwd: string; input?: string }) => ChantResult;

/** The real chant: `TERRAGUCCI_CHANT` (a command, split on spaces), else the repo's own `npx --no-install chant`. */
export const chantRunner: ChantRunner = (args, { cwd, input }) => {
  const cmd = (process.env.TERRAGUCCI_CHANT ?? "npx --no-install chant").split(/\s+/).filter(Boolean);
  const r = spawnSync(cmd[0]!, [...cmd.slice(1), ...args], { cwd, input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new ConfigError(`could not run chant (${cmd.join(" ")}): ${r.error.message}; the control repo needs @intentius/chant ${CHANT_FLOOR} or later installed`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** One control-repo record as chant read it. */
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

/** Does `dir` hold the control repo's record kind? */
export function hasControlRecords(dir: string): boolean {
  return existsSync(join(dir, KIND_FILE));
}

function chantJson(run: ChantRunner, dir: string, args: string[], what: string, input?: string): Record<string, any> {
  const r = run(args, { cwd: dir, ...(input !== undefined ? { input } : {}) });
  let doc: Record<string, any> | undefined;
  try {
    doc = JSON.parse(r.stdout) as Record<string, any>;
  } catch {}
  if (r.status !== 0 || !doc || doc.error) {
    const why = doc?.error ? `${doc.error.code}: ${doc.error.message}` : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`;
    throw new ConfigError(`${what}: chant ${args.slice(0, 3).join(" ")} failed (${why})`);
  }
  return doc;
}

/** Entries of the active records, each checked. Two active records for one project, or for the defaults, are refused. */
export function readEntries(dir: string, run: ChantRunner = chantRunner): ControlEntry[] {
  if (!hasControlRecords(dir)) throw new ConfigError(`${dir} has no ${KIND_FILE}; run \`npx terragucci control records init\``);
  const doc = chantJson(run, dir, ["workspace", "records", "--kind", KIND_FILE, "--current", "--where", "state=active", "--json"], "reading the control repo's records");
  const out: ControlEntry[] = [];
  const problems: string[] = [];
  for (const r of (doc.records ?? []) as any[]) {
    if (r.state === "retired") continue;
    if (!r.valid) {
      problems.push(`${r.path}: ${(r.reasons ?? []).map((x: any) => x.code ?? x).join(", ") || "invalid"}`);
      continue;
    }
    const d = r.data ?? {};
    out.push({ id: r.id, path: r.path, digest: r.digest, entry: d.entry, ...(typeof d.project === "string" ? { project: d.project } : {}), settings: d.settings ?? {}, estates: d.estates ?? [] });
  }
  const seen = new Map<string, string>();
  for (const e of out) {
    const key = e.entry === "defaults" ? "defaults" : e.project!;
    if (e.entry === "project") {
      try {
        parseProjectKey(key);
      } catch (err) {
        problems.push(`${e.path}: ${(err as Error).message}`);
      }
    }
    const prior = seen.get(key);
    if (prior) problems.push(`${key} has two active records, ${prior} and ${e.id}; retire one`);
    else seen.set(key, e.id);
  }
  if (problems.length) throw new ConfigError(`the control repo's records have ${problems.length} problem(s):\n  ${problems.join("\n  ")}`, problems);
  return out;
}

/** The config the records stand for: what a control repo's terragucci.yml held. */
export function configFromEntries(entries: ControlEntry[], where = "the control repo's records"): TerragucciConfig {
  const defaults = entries.find((e) => e.entry === "defaults");
  const projects: Record<string, ProjectSettings> = {};
  for (const e of entries.filter((x) => x.entry === "project").sort((a, b) => a.project!.localeCompare(b.project!))) projects[e.project!] = e.settings;
  return validateConfig({ ...(defaults ? { defaults: defaults.settings } : {}), projects }, where);
}

/** The control repo's config from its records. */
export function loadControlConfig(dir: string, run: ChantRunner = chantRunner): TerragucciConfig {
  return configFromEntries(readEntries(dir, run));
}

/** Writes the kind and its schema into the control repo and declares the kind to chant. Existing files are kept. */
export function initRecords(dir: string): { written: string[]; notes: string[] } {
  const written: string[] = [];
  const put = (rel: string, text: string): void => {
    const abs = join(dir, rel);
    if (existsSync(abs)) return;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(rel);
  };
  put(KIND_FILE, KIND_SOURCE);
  put(SCHEMA_FILE, JSON.stringify(KIND_SCHEMA, null, 2) + "\n");
  const wsPath = join(dir, "chant.workspace.json");
  if (!existsSync(wsPath)) {
    writeFileSync(wsPath, JSON.stringify({ name: "control", schema: 1, minReader: "0.108.0", members: [], records: [{ kind: KIND_FILE }] }, null, 2) + "\n");
    written.push("chant.workspace.json");
  } else {
    const ws = JSON.parse(readFileSync(wsPath, "utf-8")) as { records?: { kind: string }[] };
    if (!ws.records?.some((r) => r.kind === KIND_FILE)) {
      ws.records = [...(ws.records ?? []), { kind: KIND_FILE }];
      writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n");
      written.push("chant.workspace.json");
    }
  }
  return { written, notes: [`the repo's package.json must pin @intentius/chant at ${CHANT_FLOOR} or later, which has \`chant workspace records new|amend\``] };
}

export interface PutResult {
  id: string;
  path: string;
  /** created: a new record. updated: an active record amended. unchanged: it already held these settings. */
  status: "created" | "updated" | "unchanged";
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** Checks one entry's settings the way the config would, before chant sees them. */
function checkSettings(entry: EntryKind, project: string | undefined, settings: ProjectSettings): void {
  if (entry === "project") {
    parseProjectKey(project ?? "");
    validateConfig({ projects: { [project!]: settings } }, `project ${project}`);
  } else {
    validateConfig({ defaults: settings, projects: {} }, "defaults");
  }
}

/**
 * Creates the project's (or the defaults') record, or amends the active one
 * with `--expect` set to the digest it was read at, so a write that raced
 * another is refused rather than lost. `estates` left out keeps the record's.
 */
export function putEntry(
  dir: string,
  want: { entry: EntryKind; project?: string; settings: ProjectSettings; estates?: string[] },
  run: ChantRunner = chantRunner,
  dryRun = false,
): PutResult {
  if (want.entry === "project" && !want.project) throw new ConfigError("a project entry needs the project's key");
  if (want.entry === "defaults" && (want.project || want.estates?.length)) throw new ConfigError("the defaults take no project key and own no estates");
  checkSettings(want.entry, want.project, want.settings);
  const current = readEntries(dir, run).find((e) => (want.entry === "defaults" ? e.entry === "defaults" : e.project === want.project));
  const title = want.entry === "defaults" ? "defaults" : want.project!;
  const dry = dryRun ? ["--dry-run"] : [];
  if (!current) {
    const fields = { schema: 1, title, state: "active", entry: want.entry, project: want.project ?? null, settings: want.settings, estates: want.estates ?? [] };
    const doc = chantJson(run, dir, ["workspace", "records", "new", KIND_FILE, "--from", "-", "--prefix", ID_PREFIX, ...dry], `writing ${title}`, JSON.stringify(fields));
    return { id: String(doc.id ?? ""), path: String(doc.path ?? ""), status: "created" };
  }
  const estates = want.estates ?? current.estates;
  if (same(current.settings, want.settings) && same(current.estates, estates)) return { id: current.id, path: current.path, status: "unchanged" };
  const doc = chantJson(run, dir, ["workspace", "records", "amend", current.id, "--kind", KIND_FILE, "--set", "-", "--expect", current.digest, ...dry], `amending ${title}`, JSON.stringify({ settings: want.settings, estates }));
  return { id: current.id, path: current.path || String(doc.path ?? ""), status: "updated" };
}

/** Retires a project's active record: the closed state, so the project is no longer read. */
export function retireEntry(dir: string, project: string, run: ChantRunner = chantRunner, dryRun = false): PutResult {
  const current = readEntries(dir, run).find((e) => e.project === project);
  if (!current) throw new ConfigError(`no active record for ${project} in the control repo`);
  chantJson(run, dir, ["workspace", "records", "amend", current.id, "--kind", KIND_FILE, "--set", "-", "--expect", current.digest, ...(dryRun ? ["--dry-run"] : [])], `retiring ${project}`, JSON.stringify({ state: "retired" }));
  return { id: current.id, path: current.path, status: "updated" };
}

/** Writes a terragucci.yml-shaped config into records, one per project and one for the defaults. Migrates a control repo off its file. */
export function importControlConfig(dir: string, config: TerragucciConfig, run: ChantRunner = chantRunner, dryRun = false): (PutResult & { entry: string })[] {
  if (!config.projects || Object.keys(config.projects).length === 0) throw new ConfigError("only a control repo's config, which lists projects, becomes records");
  const out: (PutResult & { entry: string })[] = [];
  if (config.defaults) out.push({ entry: "defaults", ...putEntry(dir, { entry: "defaults", settings: config.defaults }, run, dryRun) });
  for (const [project, settings] of Object.entries(config.projects)) out.push({ entry: project, ...putEntry(dir, { entry: "project", project, settings }, run, dryRun) });
  return out;
}

// ── estate ownership ─────────────────────────────────────────────────────────

/** Who claims each estate in the active records: estate name to project keys. */
export function estateClaims(entries: ControlEntry[]): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const e of entries) {
    if (e.entry !== "project") continue;
    for (const estate of e.estates) claims.set(estate, [...(claims.get(estate) ?? []), e.project!]);
  }
  return claims;
}

/** The estates' claims read now, from the control repo's checkout at `dir`. Called at every plan; nothing is kept between plans. */
export function readClaims(dir: string, run: ChantRunner = chantRunner): Map<string, string[]> {
  return estateClaims(readEntries(dir, run));
}

// ── the control repo's ledger (chant#4568) ───────────────────────────────────

/** Where an entry read from the ledger is: the file on the control repo's chant/lifecycle. */
export const LEDGER_PATH = "chant/lifecycle:_control/entries.jsonl";

/** The product the ledger's entries are written as. */
const PRODUCT = "terragucci";

/** chant's control repo and the ledger of the control repo at `dir`, when the installed chant has it. */
export interface ControlLedger {
  chant: ChantCiControl;
  port: ChantControlLedgerPort;
}

/** The control repo's ledger at `dir`, or undefined on a chant without `@intentius/chant/ci-control`. */
export async function controlLedger(dir: string): Promise<ControlLedger | undefined> {
  const chant = await chantCiControl();
  return chant ? { chant, port: chant.gitControlLedger({ cwd: dir }) } : undefined;
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

/** The store the control repo at `dir` keeps its entries in: the ledger once it has entries there, else its record files. */
async function storeOf(dir: string): Promise<ControlLedger | undefined> {
  const ledger = await controlLedger(dir);
  return (await ledgerHasEntries(ledger)) ? ledger : undefined;
}

/** Does the control repo at `dir` keep entries anywhere: on its ledger, or in its record files? */
export async function hasControlEntries(dir: string): Promise<boolean> {
  return (await storeOf(dir)) !== undefined || hasControlRecords(dir);
}

/** {@link readEntries}, from the ledger when the control repo's entries are there. */
export async function readEntriesAt(dir: string, run: ChantRunner = chantRunner): Promise<ControlEntry[]> {
  const ledger = await storeOf(dir);
  if (!ledger) return readEntries(dir, run);
  const entries = await asConfig("reading the control repo's entries", () => ledger.chant.readControlEntries(ledger.port, { validate: validateSettings }));
  return entries.map(fromLedger);
}

/** {@link putEntry}, on the ledger when the control repo's entries are there. The ledger commit is local: push chant/lifecycle after. */
export async function putEntryAt(
  dir: string,
  want: { entry: EntryKind; project?: string; settings: ProjectSettings; estates?: string[] },
  run: ChantRunner = chantRunner,
  dryRun = false,
): Promise<PutResult> {
  const ledger = await storeOf(dir);
  if (!ledger) return putEntry(dir, want, run, dryRun);
  const r = await asConfig(`writing ${want.project ?? "defaults"}`, () =>
    ledger.chant.putControlEntry(ledger.port, { entry: want.entry, ...(want.project ? { project: want.project } : {}), settings: want.settings as Record<string, unknown>, ...(want.estates ? { estates: want.estates } : {}) }, { product: PRODUCT, validate: validateSettings, dryRun }),
  );
  return { id: r.id, path: LEDGER_PATH, status: r.status === "retired" ? "updated" : r.status };
}

/** {@link retireEntry}, on the ledger when the control repo's entries are there. */
export async function retireEntryAt(dir: string, project: string, run: ChantRunner = chantRunner, dryRun = false): Promise<PutResult> {
  const ledger = await storeOf(dir);
  if (!ledger) return retireEntry(dir, project, run, dryRun);
  const r = await asConfig(`retiring ${project}`, () => ledger.chant.retireControlEntry(ledger.port, project, { product: PRODUCT, dryRun }));
  return { id: r.id, path: LEDGER_PATH, status: "updated" };
}

/** {@link importControlConfig}, onto the ledger when the control repo's entries are there. */
export async function importControlConfigAt(dir: string, config: TerragucciConfig, run: ChantRunner = chantRunner, dryRun = false): Promise<(PutResult & { entry: string })[]> {
  const ledger = await storeOf(dir);
  if (!ledger) return importControlConfig(dir, config, run, dryRun);
  if (!config.projects || Object.keys(config.projects).length === 0) throw new ConfigError("only a control repo's config, which lists projects, becomes records");
  const projects = config.projects as Record<string, Record<string, unknown>>;
  const out = await asConfig("importing the control repo's config", () =>
    ledger.chant.importControlConfig(ledger.port, { ...(config.defaults ? { defaults: config.defaults as Record<string, unknown> } : {}), projects }, { product: PRODUCT, validate: validateSettings, dryRun }),
  );
  return out.map((r) => ({ entry: r.entry, id: r.id, path: LEDGER_PATH, status: r.status === "retired" ? "updated" : r.status }));
}

/** {@link readClaims}, from the ledger when the control repo's entries are there. */
export async function readClaimsAt(dir: string, run: ChantRunner = chantRunner): Promise<Map<string, string[]>> {
  return estateClaims(await readEntriesAt(dir, run));
}

/** What `control records migrate` did: each entry written to the ledger, and the record files it read them from. */
export interface MigrateResult {
  results: (PutResult & { entry: string })[];
  /** The record files read, which the repo can delete once the ledger is pushed. */
  files: string[];
}

/**
 * `terragucci control records migrate`: the control repo's record files
 * (terragucci/records) written onto its ledger with chant's
 * `importControlConfig`, each project with its estates. Writing again is
 * safe: an entry that already holds the settings is left as it is. The files
 * stay where they are; the ledger is the store once it has entries, so the
 * repo deletes them after it pushes chant/lifecycle.
 */
export async function migrateRecords(dir: string, run: ChantRunner = chantRunner, dryRun = false): Promise<MigrateResult> {
  const ledger = await controlLedger(dir);
  if (!ledger) throw new ConfigError("moving the records onto the ledger needs a chant with the control repo (@intentius/chant/ci-control); this one has none, so the record files stay the store");
  const entries = readEntries(dir, run);
  const defaults = entries.find((e) => e.entry === "defaults");
  const projects: Record<string, Record<string, unknown>> = {};
  const estates: Record<string, string[]> = {};
  for (const e of entries.filter((x) => x.entry === "project")) {
    projects[e.project!] = e.settings as Record<string, unknown>;
    estates[e.project!] = e.estates;
  }
  if (Object.keys(projects).length === 0) throw new ConfigError("the control repo's records list no project, so there is nothing to move");
  const out = await asConfig("moving the records onto the ledger", () =>
    ledger.chant.importControlConfig(ledger.port, { ...(defaults ? { defaults: defaults.settings as Record<string, unknown> } : {}), projects, estates }, { product: PRODUCT, validate: validateSettings, dryRun }),
  );
  return {
    results: out.map((r) => ({ entry: r.entry, id: r.id, path: LEDGER_PATH, status: r.status === "retired" ? "updated" : r.status })),
    files: entries.map((e) => e.path),
  };
}
