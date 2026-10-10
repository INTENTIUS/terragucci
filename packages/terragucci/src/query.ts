/**
 * `terragucci query "<sql>"`: SQL over what runs already wrote to the reports
 * bucket, in this process, with no server and no database to run.
 *
 * It reads each project's `inventory.json`, `changes.json` and `edges.json`
 * and the audit trail (`audit.jsonl`) the way `terragucci estate` does
 * (./estate.ts), loads them into tables of an in-memory SQLite database, runs
 * the one statement it is given, and prints the rows. The history table is
 * the changes joined to the audit trail's apply entries, as `history.json`
 * holds them (report/history.ts): each apply of each resource with its
 * approver.
 *
 * The engine is `node:sqlite`, the SQLite that Node.js builds in (22.13 and
 * later need no flag), so the bundle carries no engine of its own: a WASM
 * build of SQLite or DuckDB would add from 0.6 MB to several MB to a bundle
 * held under 1.5 MB (scripts/bundle-check.mjs). It is loaded only by this
 * command, so no other command prints its experimental warning.
 *
 * Nothing is written: the database lives in memory, takes `PRAGMA
 * query_only`, and only a statement that begins with SELECT, WITH or VALUES
 * runs.
 */
import { ConfigError, type TerragucciConfig } from "./config";
import { auditEntries, clients, readChangesOf, readEdgesOf, readInventoryOf, sources } from "./estate";
import type { AuditEntry } from "./report/audit";
import { buildHistory, type ChangeRow } from "./report/history";
import type { Inventory } from "./report/inventory";
import type { ObjectStore, StoreFetch } from "./report/object-store";
import type { StateEdges } from "./report/state-edges";
import { changesKey, edgesKey, inventoryKey } from "./report/store";

type Reports = NonNullable<TerragucciConfig["reports"]>;
type Value = string | number | null;
type Row = Record<string, Value>;

/** Each table's columns, in order. Every column is TEXT but `wave`, an INTEGER; `attributes` and `detail` hold JSON, and `actions` joins a change's actions with +. */
export const QUERY_TABLES = {
  /** Each resource a root holds, as its newest applied wave left it. */
  inventory: ["project", "root", "address", "type", "provider", "commit", "wave", "finished"],
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
export function queryData(projects: { project: string; inventory?: Inventory; changes?: ChangeRow[]; edges?: StateEdges }[], audit: AuditEntry[] | undefined, now: Date): QueryData {
  const data: QueryData = { inventory: [], changes: [], history: [], audit: [], edges: [] };
  for (const p of projects) {
    for (const r of p.inventory?.roots ?? []) {
      for (const res of r.resources) data.inventory.push({ project: p.project, root: r.root, address: res.address, type: res.type, provider: res.provider, commit: r.commit, wave: r.wave ?? null, finished: r.finished });
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
  const read: { project: string; inventory?: Inventory; changes?: ChangeRow[]; edges?: StateEdges }[] = [];
  for (const p of projects) {
    if (!p.reports?.bucket) continue;
    const store = client(p.reports);
    const prefix = p.reports.prefix ?? "";
    const [inventory, changes, edges] = await Promise.all([readInventoryOf(store, inventoryKey(p.project, prefix)), readChangesOf(store, changesKey(p.project, prefix)), readEdgesOf(store, edgesKey(p.project, prefix))]);
    read.push({ project: p.project, ...(inventory ? { inventory } : {}), ...(changes ? { changes } : {}), ...(edges ? { edges } : {}) });
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

/** The first word of a statement, past whitespace and comments. */
function firstWord(sql: string): string {
  const s = sql.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? "").toLowerCase();
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

/** `terragucci query`: read the bucket, run the statement. */
export async function query(config: TerragucciConfig, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
  if (sql.trim() === "") throw new ConfigError('terragucci query needs a statement: terragucci query "SELECT * FROM inventory"');
  const data = await readQueryData(config, options);
  return runQuery(sql, data);
}

const cell = (v: Value | undefined): string => (v === null || v === undefined ? "" : String(v));

/** The rows as an aligned table, a header and a count. */
export function describeQuery(r: QueryResult): string {
  const widths = r.columns.map((c) => Math.max(c.length, ...r.rows.map((row) => cell(row[c]).length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(r.columns), line(widths.map((w) => "-".repeat(w))), ...r.rows.map((row) => line(r.columns.map((c) => cell(row[c]))))];
  out.push(`(${r.rows.length} ${r.rows.length === 1 ? "row" : "rows"})`);
  return out.join("\n");
}
