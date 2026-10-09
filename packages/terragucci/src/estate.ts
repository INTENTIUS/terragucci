/**
 * `terragucci estate`: one page for every project, written to the reports
 * bucket as `<prefix>/estate.html` and `<prefix>/estate.json`, and a link to
 * the page (presigned on S3, a signed URL on GCS, a SAS on Azure Blob).
 * Nothing is hosted: a scheduled job runs the command and the page is an
 * object in the bucket.
 *
 * From a control repo the projects are its `projects:`, each read from its
 * own `reports` bucket (a project in another account names a bucket and a
 * `reports.role` of its own); the page goes to the bucket under `defaults`.
 * In a single repo the projects are the ones the top-of-prefix index lists.
 *
 * It reads each project's `index.json`, `inventory.json`, `changes.json`, `states.json` and `edges.json`,
 * and never a report, a plan's text or a root's plan JSON (see
 * report/estate.ts). Beside the page it reads `audit.json`, the summary
 * `terragucci audit` writes (./audit.ts), so the page can link the audit
 * trail, and, when an apply changed a resource, the record `audit.jsonl`,
 * for the approver of each apply in `history.html` (report/history.ts).
 * The same record and the index rows give the DORA metrics (report/dora.ts):
 * `dora.json` beside the page, a section on it, and, when an OTLP endpoint
 * is set, gauges beside the stages' metrics.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, resolveProject, resolveRepo, type TerragucciConfig } from "./config";
import { age, buildEstate, renderEstateHtml, type Estate, type ProjectIndex } from "./report/estate";
import { storeFromEnv } from "./report/bucket";
import { bucketUrl, parseReportsBucket, PRESIGN_MAX_SECONDS, StoreError, type ObjectStore, type StoreFetch } from "./report/object-store";
import { AUDIT_FILES, readRecord, type AuditEntry } from "./report/audit";
import { buildHistory, CHANGES_SCHEMA, historyId, renderHistoryHtml, type ChangeRow, type Changes, type History } from "./report/history";
import { INVENTORY_SCHEMA, type Inventory } from "./report/inventory";
import { readStateVersions, type StateVersions } from "./report/state-versions";
import { readStateEdges, type StateEdges } from "./report/state-edges";
import { changesKey, edgesKey, inventoryKey, statesKey, reportsBase, type IndexEntry, type ReportIndex } from "./report/store";
import { buildDora, DORA_FILE, doraGauges, duration, type Dora } from "./report/dora";
import { metricsBody, send, telemetryFromEnv, type OtlpFetch } from "./telemetry";
import { version as VERSION } from "../package.json";

type Reports = NonNullable<TerragucciConfig["reports"]>;

export interface EstateOptions {
  /** Where the page is written locally. Default `terragucci-estate` in the working directory. */
  out?: string;
  /** How long the presigned link to the page lives. Default 24 hours. */
  linkSeconds?: number;
  /** The bucket to read and write, in place of the config's `reports` (a single repo only). */
  reports?: Reports;
  fetch?: StoreFetch;
  /** Where the DORA gauges go, when an OTLP endpoint is set. */
  otlpFetch?: OtlpFetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface EstateResult {
  estate: Estate;
  /** The files written locally. */
  files: string[];
  /** The keys written to the bucket, with the bucket. */
  uploaded?: { bucket: string; keys: string[] };
  /** The presigned link to estate.html and when it stops working. */
  link?: { url: string; expires: string };
  /** Projects whose index could not be read. */
  unreadable: string[];
  /** The DORA metrics, also in dora.json. */
  dora: Dora;
  /** The DORA gauges: sent, or why not. Absent when no OTLP metrics endpoint is set. */
  metrics?: { sent: number } | { problem: string };
}

export const DEFAULT_LINK_SECONDS = 24 * 3600;

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const key = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** A bucket's name with its scheme, s3:// for a bare name. */
export const named = (bucket: string): string => {
  try {
    return bucketUrl(parseReportsBucket(bucket));
  } catch {
    return bucket;
  }
};

/** Two `reports` blocks name the same objects. */
export const sameBucket = (a: Reports | undefined, b: Reports | undefined): boolean =>
  !!a && !!b && named(a.bucket) === named(b.bucket) && (a.endpoint ?? "") === (b.endpoint ?? "") && trim(a.prefix ?? "") === trim(b.prefix ?? "");

export function parseIndex(text: string, at: string): IndexEntry[] {
  let parsed: Partial<ReportIndex>;
  try {
    parsed = JSON.parse(text) as Partial<ReportIndex>;
  } catch {
    throw new StoreError(`${at} is not JSON`);
  }
  if (!Array.isArray(parsed.reports)) throw new StoreError(`${at} is not a report index`);
  return parsed.reports;
}

/** One client per bucket, endpoint and role, so a role is assumed once. */
export function clients(env: NodeJS.ProcessEnv, fetchFn: StoreFetch | undefined): (r: Reports) => ObjectStore {
  const held = new Map<string, ObjectStore>();
  return (r) => {
    const id = [r.bucket, r.endpoint ?? "", r.role ?? ""].join("\n");
    let c = held.get(id);
    if (!c) {
      c = storeFromEnv(r, env, fetchFn);
      held.set(id, c);
    }
    return c;
  };
}

/** Read one project's index; a failure is the project's, never the whole page's. */
async function readProject(project: string, reports: Reports | undefined, out: Reports | undefined, client: (r: Reports) => ObjectStore): Promise<ProjectIndex> {
  if (!reports?.bucket) return { project, error: "the project names no reports bucket" };
  // From estate.html at the top of the output prefix, the project's directory is <project>/ in the same bucket, or on its own bucket's address.
  const served = reportsBase(reports);
  const base = sameBucket(reports, out) ? `${project}/` : served ? `${served}/${project}/` : undefined;
  const at = key(reports.prefix ?? "", project, "index.json");
  let rows: IndexEntry[] | undefined;
  try {
    const text = await client(reports).get(at);
    rows = text === undefined ? undefined : parseIndex(text, at);
  } catch (e) {
    if (!(e instanceof StoreError) && !(e instanceof TypeError)) throw e;
    return { project, error: e.message, ...(base !== undefined ? { base } : {}) };
  }
  const inventory = rows ? await readInventoryOf(client(reports), inventoryKey(project, reports.prefix ?? "")) : undefined;
  const changes = rows ? await readChangesOf(client(reports), changesKey(project, reports.prefix ?? "")) : undefined;
  const states = rows ? await readStatesOf(client(reports), statesKey(project, reports.prefix ?? "")) : undefined;
  const edges = rows ? await readEdgesOf(client(reports), edgesKey(project, reports.prefix ?? "")) : undefined;
  return { project, ...(rows ? { reports: rows } : {}), ...(inventory ? { inventory } : {}), ...(changes ? { changes } : {}), ...(states ? { states } : {}), ...(edges ? { edges } : {}), ...(base !== undefined ? { base } : {}) };
}

/** A project's state versions, when an apply recorded them; an unreadable file leaves the project without them, never without its runs. */
async function readStatesOf(store: ObjectStore, at: string): Promise<StateVersions | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = readStateVersions(text);
    return parsed.roots.length > 0 ? parsed : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError) return undefined;
    throw e;
  }
}

/** A project's cross-state edges; an unreadable file leaves the project without them, never without its runs. */
async function readEdgesOf(store: ObjectStore, at: string): Promise<StateEdges | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = readStateEdges(text);
    return parsed.roots.length > 0 ? parsed : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError) return undefined;
    throw e;
  }
}

/** A project's resource changes, when an apply wrote them; unreadable ones leave the project without a history. */
async function readChangesOf(store: ObjectStore, at: string): Promise<ChangeRow[] | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Partial<Changes>;
    return parsed.schema === CHANGES_SCHEMA && Array.isArray(parsed.changes) ? parsed.changes : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** The audit trail's entries, for the approver of each apply; undefined when there is no record or it cannot be read. */
async function auditEntries(store: ObjectStore, prefix: string): Promise<AuditEntry[] | undefined> {
  try {
    const text = await store.get(key(prefix, AUDIT_FILES.record));
    return text === undefined ? undefined : readRecord(text).entries;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError) return undefined;
    throw e;
  }
}

/** A project's inventory, when an apply wrote one; one that cannot be read leaves the project without a resource list, never without its runs. */
async function readInventoryOf(store: ObjectStore, at: string): Promise<Inventory | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Partial<Inventory>;
    return parsed.schema === INVENTORY_SCHEMA && Array.isArray(parsed.roots) ? (parsed as Inventory) : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** Which projects, read from where, and where the page goes. */
async function sources(config: TerragucciConfig, options: EstateOptions, client: (r: Reports) => ObjectStore): Promise<{ projects: { project: string; reports?: Reports }[]; out?: Reports }> {
  if (config.projects && Object.keys(config.projects).length > 0) {
    if (options.reports) throw new ConfigError("--bucket names one bucket; a control repo reads each project's reports and writes the page under defaults.reports");
    const out = config.defaults?.reports;
    return { projects: Object.keys(config.projects).map((p) => ({ project: p, reports: resolveProject(config, p).reports })), ...(out ? { out } : {}) };
  }
  const out = options.reports ?? resolveRepo(config).reports;
  if (!out?.bucket) throw new ConfigError("estate reads the reports bucket: set reports.bucket in terragucci.yml, or pass --bucket with s3://<bucket>, gs://<bucket> or az://<account>/<container>");
  // The top-of-prefix index has a row for every project that copies its reports here.
  const top = key(out.prefix ?? "", "index.json");
  const text = await client(out).get(top);
  const rows = text === undefined ? [] : parseIndex(text, top);
  return { projects: [...new Set(rows.map((r) => r.project))].sort().map((project) => ({ project, reports: out })), out };
}

/** The audit trail `terragucci audit` wrote beside the page, from its summary; undefined when there is none or it cannot be read. */
async function auditTrail(store: ObjectStore, prefix: string): Promise<Estate["audit"]> {
  try {
    const text = await store.get(key(prefix, "audit.json"));
    if (text === undefined) return undefined;
    const s = JSON.parse(text) as { schema?: unknown; entries?: unknown; generated?: unknown };
    if (s.schema !== "terragucci.audit-summary/v1" || typeof s.entries !== "number" || typeof s.generated !== "string") return undefined;
    return { page: "audit.html", entries: s.entries, generated: s.generated };
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** The history's files, beside the estate page. */
export const HISTORY_FILES = { json: "history.json", page: "history.html" } as const;

/** Point the page at the history: its count, and each listed resource that has one at its section. */
function linkHistory(page: Estate, history: History): void {
  const ids = new Set(history.resources.map((r) => r.id));
  page.history = { page: HISTORY_FILES.page, resources: history.resources.length, generated: history.generated };
  for (const p of page.projects) {
    for (const root of p.inventory?.roots ?? []) {
      for (const r of root.resources) {
        const id = historyId(p.project, root.root, r.address);
        if (ids.has(id)) r.history = `${HISTORY_FILES.page}#${id}`;
      }
    }
  }
}

export async function estate(cwd: string, config: TerragucciConfig, options: EstateOptions = {}): Promise<EstateResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const seconds = options.linkSeconds ?? DEFAULT_LINK_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new ConfigError(`the link lives 1 second to 7 days (${PRESIGN_MAX_SECONDS} seconds); ${seconds} is out of range`);
  const client = clients(env, options.fetch);
  const { projects, out } = await sources(config, options, client);
  const indexes: ProjectIndex[] = [];
  for (const p of projects) indexes.push(await readProject(p.project, p.reports, out, client));
  const page = buildEstate(indexes, now);
  if (out?.bucket) {
    const trail = await auditTrail(client(out), out.prefix ?? "");
    if (trail) page.audit = trail;
  }
  const audit = out?.bucket ? await auditEntries(client(out), out.prefix ?? "") : undefined;
  // The DORA metrics from the audit trail and the index rows.
  const dora = buildDora(indexes.map((p) => ({ project: p.project, rows: p.reports ?? [] })), audit, now);
  page.dora = { file: DORA_FILE, generated: dora.generated, deployments: dora.estate.deployments };
  // The history of every address an apply changed, with each wave's approver from the audit trail, on a page of its own.
  let history: History | undefined;
  const changed = indexes.filter((p) => p.changes && p.changes.length > 0);
  if (changed.length > 0) {
    history = buildHistory(changed.map((p) => ({ project: p.project, changes: p.changes!, ...(p.base !== undefined ? { base: p.base } : {}) })), audit, now);
    linkHistory(page, history);
  }
  const files: Record<string, string> = { "estate.json": JSON.stringify(page, null, 2) + "\n", "estate.html": renderEstateHtml(page, dora), [DORA_FILE]: JSON.stringify(dora, null, 2) + "\n" };
  if (history) Object.assign(files, { [HISTORY_FILES.json]: JSON.stringify(history, null, 2) + "\n", [HISTORY_FILES.page]: renderHistoryHtml(history) });
  const dir = resolve(cwd, options.out ?? "terragucci-estate");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result: EstateResult = { estate: page, files: Object.keys(files).map((f) => join(dir, f)), unreadable: indexes.filter((i) => i.error !== undefined).map((i) => i.project), dora };
  const tel = telemetryFromEnv(env);
  if (tel?.metrics) {
    const gauges = doraGauges(dora);
    const problem = await send(tel.metrics, metricsBody(gauges, { ...tel.resource, "service.version": VERSION }, VERSION), options.otlpFetch);
    result.metrics = problem ? { problem } : { sent: gauges.length };
  }
  if (out?.bucket) {
    const store = client(out);
    const keys: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      const k = key(out.prefix ?? "", name);
      await store.put(k, text, name.endsWith(".html") ? "text/html; charset=utf-8" : "application/json");
      keys.push(k);
    }
    result.uploaded = { bucket: out.bucket, keys };
    const link = await store.presign(key(out.prefix ?? "", "estate.html"), seconds, now);
    result.link = { url: link.url, expires: link.expires.toISOString() };
  }
  return result;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "a and b", "a, b and c". */
const listed = (items: string[]): string => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** What the command prints. */
export function describeEstate(r: EstateResult, cwd: string): string {
  const t = r.estate.totals;
  const lines = [`estate: ${plural(t.projects, "project", "projects")}, ${plural(t.waiting, "wave", "waves")} waiting, ${plural(t.drifted_projects, "project", "projects")} drifted, ${plural(t.failed_roots, "root", "roots")} failed`];
  for (const p of r.estate.projects) {
    for (const w of p.waiting) lines.push(`  ${p.project}: wave ${w.wave} waits, for ${age(w.age_seconds)}`);
    if (p.drifted > 0) lines.push(`  ${p.project}: ${plural(p.drifted, "root", "roots")} drifted`);
    if (p.status === "error") lines.push(`  ${p.project}: the index could not be read: ${p.error}`);
  }
  const d = r.dora;
  const c = d.estate.change_failure.rate;
  lines.push(`dora: ${d.estate.per_week} deployments per week, lead time ${duration(d.estate.lead_time.median_seconds)}, change failure rate ${c === null ? "none" : `${Math.round(c * 1000) / 10}%`}, time to restore ${duration(d.estate.restore.median_seconds)}`);
  if (r.metrics) lines.push("sent" in r.metrics ? `sent ${plural(r.metrics.sent, "DORA gauge", "DORA gauges")}` : `the DORA gauges were not sent: ${r.metrics.problem}`);
  lines.push(`wrote ${listed(r.files.map((f) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)))}`);
  if (r.uploaded) lines.push(`copied to ${named(r.uploaded.bucket)}/${listed(r.uploaded.keys)}`);
  if (r.link) lines.push(`link, until ${r.link.expires}:`, r.link.url);
  return lines.join("\n");
}
