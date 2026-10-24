/**
 * `terragucci query <table> [--where <field><op><value>]... [--since <time>]
 * [--at <rev>]`: the rows of one table, filtered with chant's typed filters
 * (@intentius/chant/read-filter), with no SQL engine (the ruling on
 * chant#4363, terragucci#1229).
 *
 * Two sources:
 *
 * - chant's ledger tables (resources, snapshots, runs, gates, deploys,
 *   releases, cuts) on the local `chant/lifecycle` branch. The read is chant's
 *   own (`readLedgerTable`, @intentius/chant/lifecycle/ledger-read) and prints
 *   its document, `workspace/ledger.schema.json`: what `chant ledger <table>
 *   --json` prints. The waves' gates and approvals are its `gates` rows under
 *   op `tf-apply`.
 * - the reports bucket's tables (inventory, versions, changes, history, audit,
 *   edges), which chant's ledgers do not hold. Each project's
 *   `inventory.json`, `versions.json`, `changes.json` and `edges.json` and the
 *   audit trail (`audit.jsonl`) are read the way `terragucci estate` reads
 *   them (./estate.ts). The history table is the changes joined to the audit
 *   trail's apply entries, as `history.json` holds them (report/history.ts).
 *   The same filters apply, and the document has the ledger read's fields.
 *
 * `terragucci query "<sql>"`, the SQL form over the bucket's tables, is
 * deprecated: it still runs on `node:sqlite`, loaded only by it, and says
 * which table read to use instead.
 *
 * Nothing is written by either form.
 */
import { gitLedgerReadPort } from "@intentius/chant/lifecycle/git";
import { LEDGER_TABLES, LedgerRevisionError, readLedgerTable, resolveLedgerRevision, revisionLedgerReadPort, type LedgerRow } from "@intentius/chant/lifecycle/ledger-read";
import { firstWord, formatQueryResult, QueryError, type QueryResult as ChantQueryResult } from "@intentius/chant/lifecycle/query";
import { FilterError, matchesWhere, parseSince, parseWhere, type FilterFields, type FilterFieldType } from "@intentius/chant/read-filter";
import { ConfigError, type TerragucciConfig } from "./config";
import { auditEntries, clients, readChangesOf, readEdgesOf, readInventoryOf, readVersionsOf, sources } from "./estate";
import type { AuditEntry } from "./report/audit";
import { buildHistory, type ChangeRow } from "./report/history";
import type { Inventory } from "./report/inventory";
import type { ObjectStore, StoreFetch } from "./report/object-store";
import type { StateEdges } from "./report/state-edges";
import { changesKey, edgesKey, inventoryKey, versionsKey } from "./report/store";
import type { Versions } from "./report/versions";

type Reports = NonNullable<TerragucciConfig["reports"]>;
type Value = string | number | null;
type Row = Record<string, Value>;

/** Each table's columns, in order. Every column is TEXT but `wave`, an INTEGER; `attributes` and `detail` hold JSON, and `actions` joins a change's actions with +. */
export const QUERY_TABLES = {
  /** Each resource a root holds, as its newest applied wave left it. */
  inventory: ["project", "root", "address", "type", "provider", "commit", "wave", "finished"],
  /** Each binary, provider and module version a root runs, as its newest applied wave left them: `kind` is binary, provider or module, `name` the binary, the provider's address or the module's source, `call` the module call. */
  versions: ["project", "root", "kind", "name", "call", "version", "commit", "wave", "finished"],
  /** One row per resource each applied wave changed. */
  changes: ["project", "root", "address", "type", "actions", "attributes", "previous_address", "commit", "wave", "finished", "plan_digest", "set_digest", "pull_request"],
  /** The changes, each with its wave's approver and approval entry from the audit trail. */
  history: ["project", "root", "address", "type", "actions", "attributes", "previous_address", "commit", "wave", "finished", "plan_digest", "set_digest", "approver", "approval", "pull_request"],
  /** Each entry of audit.jsonl. */
  audit: ["id", "kind", "project", "at", "who", "what", "digest", "result", "source", "detail"],
  /** One row per root whose state another root reads. */
  edges: ["project", "root", "reads", "via", "reads_seen"],
} as const;

export type QueryTable = keyof typeof QUERY_TABLES;

/** The rows of each table, as loaded. */
export type QueryData = Record<QueryTable, Row[]>;

export interface QueryOptions {
  /** The bucket to read, in place of the config's `reports` (a single repo only). */
  reports?: Reports;
  env?: NodeJS.ProcessEnv;
  fetch?: StoreFetch;
  /** The client of a bucket, in place of the one the environment gives (tests). */
  store?: (r: Reports) => ObjectStore;
  now?: Date;
}

export interface QueryResult {
  columns: string[];
  rows: Row[];
  /** How many rows each table held. */
  tables: Record<QueryTable, number>;
}

const joined = (a: readonly string[]): string => a.join("+");

/** The tables' rows from what the bucket holds. */
export function queryData(projects: { project: string; inventory?: Inventory; versions?: Versions; changes?: ChangeRow[]; edges?: StateEdges }[], audit: AuditEntry[] | undefined, now: Date): QueryData {
  const data: QueryData = { inventory: [], versions: [], changes: [], history: [], audit: [], edges: [] };
  for (const p of projects) {
    for (const r of p.inventory?.roots ?? []) {
      for (const res of r.resources) data.inventory.push({ project: p.project, root: r.root, address: res.address, type: res.type, provider: res.provider, commit: r.commit, wave: r.wave ?? null, finished: r.finished });
    }
    for (const r of p.versions?.roots ?? []) {
      const at = { commit: r.commit, wave: r.wave ?? null, finished: r.finished };
      if (r.binary) data.versions.push({ project: p.project, root: r.root, kind: "binary", name: r.binary.name, call: null, version: r.binary.version ?? null, ...at });
      for (const v of r.providers) data.versions.push({ project: p.project, root: r.root, kind: "provider", name: v.provider, call: null, version: v.version, ...at });
      for (const m of r.modules) data.versions.push({ project: p.project, root: r.root, kind: "module", name: m.source, call: m.call, version: m.version ?? null, ...at });
    }
    for (const c of p.changes ?? []) {
      data.changes.push({ project: p.project, root: c.root, address: c.address, type: c.type, actions: joined(c.actions), attributes: JSON.stringify(c.attributes), previous_address: c.previous_address ?? null, commit: c.commit, wave: c.wave ?? null, finished: c.finished, plan_digest: c.plan_digest, set_digest: c.set_digest, pull_request: c.pull_request ?? null });
    }
    for (const r of p.edges?.roots ?? []) {
      for (const read of r.reads) data.edges.push({ project: p.project, root: r.root, reads: read.root, via: read.via, reads_seen: r.reads_seen ?? null });
    }
  }
  const changed = projects.filter((p) => p.changes && p.changes.length > 0).map((p) => ({ project: p.project, changes: p.changes! }));
  data.history = historyRows(buildHistory(changed, audit, now));
  for (const e of audit ?? []) {
    data.audit.push({ id: e.id, kind: e.kind, project: e.project, at: e.at, who: e.who, what: e.what, digest: e.digest, result: e.result, source: e.evidence?.source ?? null, detail: e.detail ? JSON.stringify(e.detail) : null });
  }
  return data;
}

/** One row per apply of each resource in the history. */
function historyRows(history: ReturnType<typeof buildHistory>): Row[] {
  return history.resources.flatMap((r) =>
    r.applies.map((a) => ({ project: r.project, root: r.root, address: r.address, type: r.type, actions: joined(a.actions), attributes: JSON.stringify(a.attributes), previous_address: a.previous_address ?? null, commit: a.commit, wave: a.wave ?? null, finished: a.finished, plan_digest: a.plan_digest, set_digest: a.set_digest, approver: a.approver ?? null, approval: a.approval ?? null, pull_request: a.pull_request ?? null })),
  );
}

/** What the bucket holds for the tables: every project's files and the audit trail. */
export async function readQueryData(config: TerragucciConfig, options: QueryOptions = {}): Promise<QueryData> {
  const client = options.store ?? clients(options.env ?? process.env, options.fetch);
  const { projects, out } = await sources(config, options, client, "query");
  const read: { project: string; inventory?: Inventory; versions?: Versions; changes?: ChangeRow[]; edges?: StateEdges }[] = [];
  for (const p of projects) {
    if (!p.reports?.bucket) continue;
    const store = client(p.reports);
    const prefix = p.reports.prefix ?? "";
    const [inventory, versions, changes, edges] = await Promise.all([readInventoryOf(store, inventoryKey(p.project, prefix)), readVersionsOf(store, versionsKey(p.project, prefix)), readChangesOf(store, changesKey(p.project, prefix)), readEdgesOf(store, edgesKey(p.project, prefix))]);
    read.push({ project: p.project, ...(inventory ? { inventory } : {}), ...(versions ? { versions } : {}), ...(changes ? { changes } : {}), ...(edges ? { edges } : {}) });
  }
  const audit = out?.bucket ? await auditEntries(client(out), out.prefix ?? "") : undefined;
  return queryData(read, audit, options.now ?? new Date());
}

/** node:sqlite, without the experimental warning Node prints when it loads. */
async function sqlite(): Promise<typeof import("node:sqlite")> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (/SQLite/.test(typeof warning === "string" ? warning : warning.message)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } catch {
    throw new ConfigError(`terragucci query runs on the SQLite built into Node.js 22.13 or later; this is Node.js ${process.versions.node}`);
  } finally {
    process.emitWarning = emit;
  }
}

/** Run one read-only statement over the tables. */
export async function runQuery(sql: string, data: QueryData): Promise<QueryResult> {
  if (!["select", "with", "values"].includes(firstWord(sql))) throw new ConfigError("terragucci query runs one SELECT (or WITH, or VALUES) statement; it changes nothing");
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(":memory:");
  try {
    for (const [table, cols] of Object.entries(QUERY_TABLES) as [QueryTable, readonly string[]][]) {
      db.exec(`CREATE TABLE ${table} (${cols.map((c) => `"${c}" ${c === "wave" ? "INTEGER" : "TEXT"}`).join(", ")})`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => "?").join(", ")})`);
      for (const row of data[table]) insert.run(...cols.map((c) => row[c] ?? null));
    }
    db.exec("PRAGMA query_only = ON");
    let stmt;
    try {
      stmt = db.prepare(sql);
    } catch (e) {
      const m = (e as Error).message;
      // commit is an SQL keyword, so the column is named in quotes.
      throw new ConfigError(`the query does not run: ${m}${/near "commit"/i.test(m) ? '; quote the column: "commit"' : ""}`);
    }
    let rows: Row[];
    try {
      rows = stmt.all() as Row[];
    } catch (e) {
      throw new ConfigError(`the query does not run: ${(e as Error).message}`);
    }
    const columns = typeof stmt.columns === "function" ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] ?? {});
    const tables = Object.fromEntries(Object.keys(QUERY_TABLES).map((t) => [t, data[t as QueryTable].length])) as Record<QueryTable, number>;
    return { columns, rows: rows.map((r) => ({ ...r })), tables };
  } finally {
    db.close();
  }
}

/** `terragucci query "<sql>"` (deprecated): read the bucket, run the statement. */
export async function query(config: TerragucciConfig, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
  if (sql.trim() === "") throw new ConfigError('terragucci query needs a statement: terragucci query "SELECT * FROM inventory"');
  const data = await readQueryData(config, options);
  return runQuery(sql, data);
}

/** The rows as an aligned table, a header and a count: chant query's own layout, which reads only the columns and rows. */
export function describeQuery(r: QueryResult): string {
  return formatQueryResult({ columns: r.columns, rows: r.rows } as ChantQueryResult);
}

/** The SQL form's notice: what to run instead. */
export const SQL_DEPRECATED = "terragucci query \"<sql>\" is deprecated and will be removed; read one table with terragucci query <table> --where <field><op><value> [--since <time>] (tables: " + [...LEDGER_TABLES, ...Object.keys(QUERY_TABLES)].join(", ") + ")";

/** Whether `text` is an SQL statement rather than a table name: the SQL form, deprecated. */
export function isSql(text: string): boolean {
  return /\s/.test(text.trim()) || ["select", "with", "values"].includes(firstWord(text));
}

/** The column `--since` compares on each bucket table, or null for one with no time. */
export const BUCKET_TIME_COLUMN: Record<QueryTable, string | null> = { inventory: "finished", versions: "finished", changes: "finished", history: "finished", audit: "at", edges: null };

/** The bucket columns that hold JSON text: filtered as JSON (a key under them), printed parsed. */
const BUCKET_JSON = new Set(["detail"]);

/** The fields `--where` takes on a bucket table, typed. `attributes` holds a JSON array of names, so it is text, for `~`. */
export function bucketFields(table: QueryTable): FilterFields {
  const out: Record<string, FilterFieldType> = {};
  for (const c of QUERY_TABLES[table]) out[c] = c === "wave" ? "number" : c === "finished" || c === "at" || c === "reads_seen" ? "time" : BUCKET_JSON.has(c) ? "json" : "text";
  return out;
}

export interface TableReadOptions extends QueryOptions {
  where?: readonly string[];
  /** An ISO date or time, or a span back from now such as `7d`. */
  since?: string;
  /** A commit of `chant/lifecycle` (ledger tables only). */
  at?: string;
  /** The repository whose `chant/lifecycle` branch is read; the working directory by default. */
  cwd?: string;
}

/** One table's rows: chant's ledger document for a ledger table, the same fields for a bucket table. */
export interface TableRead {
  /** chant's ledger read contract, for a ledger table. */
  $schema?: string;
  contract?: number;
  /** Where the rows came from. */
  source: "ledger" | "bucket";
  table: string;
  columns: string[];
  at: string | null;
  filter: { where: string[]; since: string | null };
  /** Rows in the table before the filter. */
  total: number;
  rows: LedgerRow[];
  /** What could not be read as its kind, left out (ledger tables). */
  malformed: number;
}

const ALL_TABLES = (): string => [...LEDGER_TABLES, ...Object.keys(QUERY_TABLES)].join(", ");

/** `terragucci query <table>`: one table, filtered. A bad table, filter or revision is a ConfigError, before anything is read. */
export async function readTable(config: TerragucciConfig, table: string, options: TableReadOptions = {}): Promise<TableRead> {
  if ((LEDGER_TABLES as string[]).includes(table)) return readLedger(table, options);
  if (!(table in QUERY_TABLES)) throw new ConfigError(`table-unknown: terragucci query reads one table: no table ${JSON.stringify(table)}; the tables are ${ALL_TABLES()}`);
  const t = table as QueryTable;
  if (options.at !== undefined) throw new ConfigError(`filter-invalid: --at reads a commit of chant/lifecycle; ${t} is read from the reports bucket, which has no revisions`);
  const now = options.now ?? new Date();
  let clauses;
  let since: string | null = null;
  try {
    clauses = parseWhere(options.where ?? [], bucketFields(t), now);
    if (options.since !== undefined) {
      if (BUCKET_TIME_COLUMN[t] === null) throw new FilterError(`--since: ${t} has no time column; filter it with --where`);
      since = parseSince(options.since, now);
    }
  } catch (e) {
    if (e instanceof FilterError) throw new ConfigError(`filter-invalid: ${e.message}`);
    throw e;
  }
  const all = (await readQueryData(config, options))[t];
  const timeCol = BUCKET_TIME_COLUMN[t];
  const sinceMs = since === null ? null : Date.parse(since);
  const rows = all
    .filter((r) => {
      if (sinceMs !== null && timeCol !== null) {
        const v = r[timeCol];
        if (typeof v !== "string" || !(Date.parse(v) >= sinceMs)) return false;
      }
      return matchesWhere(r, clauses);
    })
    .map((r) => {
      const out: LedgerRow = {};
      for (const c of QUERY_TABLES[t]) {
        const v = r[c] ?? null;
        out[c] = typeof v === "string" && (BUCKET_JSON.has(c) || c === "attributes") ? (JSON.parse(v) as LedgerRow[string]) : v;
      }
      return out;
    });
  return { source: "bucket", table: t, columns: [...QUERY_TABLES[t]], at: null, filter: { where: [...(options.where ?? [])], since }, total: all.length, rows, malformed: 0 };
}

/** A ledger table, through chant's read: the branch tip, or the commit `--at` names. */
async function readLedger(table: string, options: TableReadOptions): Promise<TableRead> {
  const cwd = options.cwd ?? process.cwd();
  const ledgers = async () => {
    if (options.at === undefined) return [{ member: null, port: gitLedgerReadPort({ cwd }) }];
    return [{ member: null, port: revisionLedgerReadPort(cwd, resolveLedgerRevision(cwd, options.at), "") }];
  };
  let doc;
  try {
    doc = await readLedgerTable(table, ledgers, { ...(options.where ? { where: options.where } : {}), ...(options.since !== undefined ? { since: options.since } : {}), at: options.at ?? null, ...(options.now ? { now: options.now } : {}) });
  } catch (e) {
    if (e instanceof LedgerRevisionError) throw new ConfigError(`revision-unknown: ${e.message}`);
    if (e instanceof QueryError) throw new ConfigError(`ledger-unreadable: ${e.message}`);
    throw e;
  }
  if ("error" in doc) throw new ConfigError(`${doc.error.code}: ${doc.error.message}`);
  return { ...doc, source: "ledger" };
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** The rows as an aligned table and a count of those kept: `chant ledger`'s layout. */
export function describeTable(r: TableRead): string {
  const widths = r.columns.map((c) => Math.max(c.length, ...r.rows.map((row) => cell(row[c]).length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(r.columns), line(widths.map((w) => "-".repeat(w))), ...r.rows.map((row) => line(r.columns.map((c) => cell(row[c])))), `(${r.rows.length} of ${r.total} ${r.total === 1 ? "row" : "rows"})`].join("\n");
}
