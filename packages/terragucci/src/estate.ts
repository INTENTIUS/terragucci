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
 * It reads each project's `index.json`, `inventory.json`, `versions.json`, `changes.json`, `states.json`, `edges.json` and `ephemeral.json`,
 * and the run view (`runs/<commit>/run.json`) of its newest applied commit for the dependency graph,
 * and never a report, a plan's text or a root's plan JSON (see
 * report/estate.ts). Beside the page it reads `audit.json`, the summary
 * `terragucci audit` writes (./audit.ts), so the page can link the audit
 * trail, and, when an apply changed a resource, the record `audit.jsonl`,
 * for the approver of each apply in `history.html` (report/history.ts).
 * Its `unrecorded-write` entries go beside each root's state versions.
 * The same record and the index rows give the DORA metrics (report/dora.ts):
 * `dora.json` beside the page, a section on it, and, when an OTLP endpoint
 * is set, gauges beside the stages' metrics. The record and the drift rows
 * also give the policy metrics (report/policy-metrics.ts):
 * `policy-metrics.json` beside the page, and a section on it.
 *
 * With chant core's estate installed (`@intentius/chant/ci-estate`,
 * chant#4612) and a single repo whose ledger holds op wave run records,
 * `buildLedgerEstate` reads the waves, their gates, the drift checks and the
 * pull request environments from the ledger. Its sections go onto the same
 * project objects (the apply waves and what waits, the overdue drift
 * checks), `dora.json` and its gauges come from chant's `buildDelivery`, and
 * the bucket sections stay terragucci's (inventory, versions, states, edges,
 * secrets, graph, history, ephemeral environments), so `terragucci.estate/v1`
 * keeps every field. Without the module, or with no wave records on the
 * ledger yet, report/dora.ts and the bucket give the whole page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chantCiEstate, chantModuleCatalog, type ChantCiEstate, type ChantLedgerEstate } from "./chant-next";
import { productWords } from "./ci-words";
import { ConfigError, resolveProject, resolveRepo, type TerragucciConfig } from "./config";
import { age, buildEstate, linkUnrecorded, renderEstateHtml, type Estate, type EstateRun, type ProjectIndex } from "./report/estate";
import { storeFromEnv } from "./report/bucket";
import { bucketUrl, parseReportsBucket, PRESIGN_MAX_SECONDS, StoreError, type ObjectStore, type StoreFetch } from "./report/object-store";
import { AUDIT_FILES, readRecord, type AuditEntry } from "./report/audit";
import { buildHistory, CHANGES_SCHEMA, historyId, renderHistoryHtml, type ChangeRow, type Changes, type History } from "./report/history";
import { INVENTORY_SCHEMA, type Inventory } from "./report/inventory";
import { VERSIONS_SCHEMA, type Versions } from "./report/versions";
import { readStateVersions, type StateVersions } from "./report/state-versions";
import { readStateEdges, type StateEdges } from "./report/state-edges";
import { RUN_SCHEMA, runViewKey, type RunView } from "./report/run-view";
import { changesKey, edgesKey, inventoryKey, statesKey, versionsKey, reportsBase, type IndexEntry, type ReportIndex } from "./report/store";
import { buildDora, DORA_FILE, doraGauges, duration, spanLabel, type Dora } from "./report/dora";
import { buildPolicyMetrics, POLICY_METRICS_FILE, type PolicyMetrics } from "./report/policy-metrics";
import { metricsBody, send, telemetryFromEnv, type OtlpFetch } from "./telemetry";
import { EPHEMERAL_SCHEMA, ephemeralKey, type EphemeralList } from "./ephemeral";
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
  /** The policy metrics, also in policy-metrics.json. */
  policy: PolicyMetrics;
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
  const versions = rows ? await readVersionsOf(client(reports), versionsKey(project, reports.prefix ?? "")) : undefined;
  const changes = rows ? await readChangesOf(client(reports), changesKey(project, reports.prefix ?? "")) : undefined;
  const states = rows ? await readStatesOf(client(reports), statesKey(project, reports.prefix ?? "")) : undefined;
  const edges = rows ? await readEdgesOf(client(reports), edgesKey(project, reports.prefix ?? "")) : undefined;
  const run = rows ? await readRunOf(client(reports), project, rows, reports.prefix ?? "") : undefined;
  // A pull request's copy may apply before any wave has written the index.
  const ephemeral = await readEphemeralOf(client(reports), ephemeralKey(project, reports.prefix ?? ""));
  return { project, ...(rows ? { reports: rows } : {}), ...(ephemeral ? { ephemeral } : {}), ...(inventory ? { inventory } : {}), ...(versions ? { versions } : {}), ...(changes ? { changes } : {}), ...(states ? { states } : {}), ...(edges ? { edges } : {}), ...(run ? { run } : {}), ...(base !== undefined ? { base } : {}) };
}

/** The run view of the project's newest applied commit, for the dependency graph; one that cannot be read leaves the project out of the graph, never off the page. */
async function readRunOf(store: ObjectStore, project: string, rows: IndexEntry[], prefix: string): Promise<RunView | undefined> {
  const applies = rows.filter((r) => r.project === project && r.stage === "tf-apply");
  if (applies.length === 0) return undefined;
  const last = applies.reduce((a, r) => ((Date.parse(r.finished) || 0) > (Date.parse(a.finished) || 0) ? r : a));
  try {
    const text = await store.get(`${runViewKey(project, last.commit, prefix)}/run.json`);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Partial<RunView>;
    return parsed.schema === RUN_SCHEMA && Array.isArray(parsed.roots) && Array.isArray(parsed.waves) ? (parsed as RunView) : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** A project's live ephemeral environments; an unreadable file leaves the project without them, never without its runs. */
async function readEphemeralOf(store: ObjectStore, at: string): Promise<EphemeralList | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Partial<EphemeralList>;
    return parsed.schema === EPHEMERAL_SCHEMA && Array.isArray(parsed.environments) ? (parsed as EphemeralList) : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
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
export async function readEdgesOf(store: ObjectStore, at: string): Promise<StateEdges | undefined> {
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
export async function readChangesOf(store: ObjectStore, at: string): Promise<ChangeRow[] | undefined> {
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
export async function auditEntries(store: ObjectStore, prefix: string): Promise<AuditEntry[] | undefined> {
  try {
    const text = await store.get(key(prefix, AUDIT_FILES.record));
    return text === undefined ? undefined : readRecord(text).entries;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError) return undefined;
    throw e;
  }
}

/** A project's inventory, when an apply wrote one; one that cannot be read leaves the project without a resource list, never without its runs. */
export async function readInventoryOf(store: ObjectStore, at: string): Promise<Inventory | undefined> {
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

/** A project's versions report, when an apply wrote one; one that cannot be read leaves the project out of the versions table, never off the page. */
export async function readVersionsOf(store: ObjectStore, at: string): Promise<Versions | undefined> {
  try {
    const text = await store.get(at);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Partial<Versions>;
    return parsed.schema === VERSIONS_SCHEMA && Array.isArray(parsed.roots) ? (parsed as Versions) : undefined;
  } catch (e) {
    if (e instanceof StoreError || e instanceof TypeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** Which projects, read from where, and where the page goes. */
export async function sources(config: TerragucciConfig, options: Pick<EstateOptions, "reports">, client: (r: Reports) => ObjectStore, command = "estate"): Promise<{ projects: { project: string; reports?: Reports }[]; out?: Reports }> {
  if (config.projects && Object.keys(config.projects).length > 0) {
    if (options.reports) throw new ConfigError(`--bucket names one bucket; a control repo reads each project's reports and ${command === "estate" ? "writes the page" : "reads the audit trail"} under defaults.reports`);
    const out = config.defaults?.reports;
    return { projects: Object.keys(config.projects).map((p) => ({ project: p, reports: resolveProject(config, p).reports })), ...(out ? { out } : {}) };
  }
  const out = options.reports ?? resolveRepo(config).reports;
  if (!out?.bucket) throw new ConfigError(`${command} reads the reports bucket: set reports.bucket in terragucci.yml, or pass --bucket with s3://<bucket>, gs://<bucket> or az://<account>/<container>`);
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
  const ids = new Map(history.resources.map((r) => [r.id, r]));
  page.history = { page: HISTORY_FILES.page, resources: history.resources.length, generated: history.generated };
  for (const p of page.projects) {
    for (const root of p.inventory?.roots ?? []) {
      for (const r of root.resources) {
        const id = historyId(p.project, root.root, r.address);
        const h = ids.get(id);
        if (!h) continue;
        r.history = `${HISTORY_FILES.page}#${id}`;
        const v = h.record_versions;
        if (v) r.record_versions = v.error !== undefined ? { kept: false, error: v.error } : v.kept ? { kept: true, count: v.versions?.length ?? 0 } : { kept: false };
      }
    }
  }
}

/**
 * chant's ledger estate for a single repo's project, when the installed chant
 * has it and the ledger holds op wave run records (`dora.audit`); undefined
 * otherwise. A control repo's projects keep their ledgers in their own repos,
 * so it reads none here.
 */
export async function ledgerEstate(cwd: string, projects: readonly string[], now: Date, chant?: ChantCiEstate): Promise<{ chant: ChantCiEstate; ledger: ChantLedgerEstate; words: object } | undefined> {
  const ci = chant ?? (await chantCiEstate());
  if (!ci || projects.length !== 1) return undefined;
  const words = productWords();
  try {
    const load = await ci.readEstateLedger(cwd);
    const ledger = ci.buildLedgerEstate({ load, words, now, project: projects[0]!, members: projects });
    return ledger.dora.audit ? { chant: ci, ledger, words } : undefined;
  } catch {
    // A checkout with no ledger to read keeps the bucket's page.
    return undefined;
  }
}

/** A ledger run as the page's EstateRun: the bucket's run of the same commit and wave gives its totals and report link. */
function ledgerRun(r: Record<string, unknown>, bucket: readonly EstateRun[]): EstateRun {
  const same = bucket.find((b) => b.commit === r.commit && b.wave === r.wave && b.share === r.share);
  const { run: _run, status: _status, ...rest } = r;
  return { ...(same ?? {}), ...(rest as unknown as EstateRun), totals: same?.totals ?? { create: 0, update: 0, replace: 0, delete: 0 }, destroys: same?.destroys ?? 0 };
}

/** Put the ledger's sections onto the bucket's project objects, and its totals beside them. */
export function mergeLedgerEstate(page: Estate, ledger: ChantLedgerEstate): void {
  page.source = "ledger";
  for (const p of page.projects) {
    const m = ledger.estate.projects.find((x) => x.project === p.project);
    if (!m) continue;
    if (m.apply) p.apply = { commit: m.apply.commit, waves: m.apply.waves.map((w) => ledgerRun(w as Record<string, unknown>, p.apply?.waves ?? [])) };
    p.waiting = m.waiting.map((w) => ({ project: w.project, wave: w.wave, commit: w.commit, since: w.since, age_seconds: w.age_seconds, ...(p.waiting.find((b) => b.wave === w.wave && b.commit === w.commit)?.report ? { report: p.waiting.find((b) => b.wave === w.wave && b.commit === w.commit)!.report } : {}) }));
    if (m.apply) p.failed = m.failed;
    if (m.drift) {
      p.drift = ledgerRun(m.drift as Record<string, unknown>, p.drift ? [p.drift] : []);
      p.drifted = m.drifted;
    }
    if (m.overdue?.length) p.overdue = m.overdue;
  }
  const t = page.totals;
  t.waiting = page.projects.reduce((n, p) => n + p.waiting.length, 0);
  t.drifted_projects = page.projects.filter((p) => p.drifted > 0).length;
  t.drifted_roots = page.projects.reduce((n, p) => n + p.drifted, 0);
  t.failed_roots = page.projects.reduce((n, p) => n + p.failed, 0);
  t.overdue = ledger.estate.totals.overdue;
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
  // The known-module catalog beside each module version a choudoufu root runs, when the installed chant has it (chant#4560).
  const page = buildEstate(indexes, now, await chantModuleCatalog());
  if (out?.bucket) {
    const trail = await auditTrail(client(out), out.prefix ?? "");
    if (trail) page.audit = trail;
  }
  const audit = out?.bucket ? await auditEntries(client(out), out.prefix ?? "") : undefined;
  // The state versions no wave or migration recorded, beside each root's.
  if (audit) linkUnrecorded(page, audit);
  // The waves, their gates and the drift checks from the ledger, when chant reads it and it holds wave records (chant#4612).
  const fromLedger = await ledgerEstate(cwd, projects.map((p) => p.project), now);
  if (fromLedger) mergeLedgerEstate(page, fromLedger.ledger);
  // The DORA metrics from the ledger through chant's buildDelivery, else from the audit trail and the index rows.
  const dora = fromLedger ? (fromLedger.ledger.dora as unknown as Dora) : buildDora(indexes.map((p) => ({ project: p.project, rows: p.reports ?? [] })), audit, now);
  page.dora = { file: DORA_FILE, generated: dora.generated, deployments: dora.estate.deployments };
  // The policy metrics from the audit trail, with the drift the same rows found.
  const policy = buildPolicyMetrics(indexes.map((p) => ({ project: p.project, rows: p.reports ?? [] })), audit, now);
  // The history of every address an apply changed, with each wave's approver from the audit trail, on a page of its own.
  let history: History | undefined;
  const changed = indexes.filter((p) => p.changes && p.changes.length > 0);
  if (changed.length > 0) {
    history = buildHistory(changed.map((p) => ({ project: p.project, changes: p.changes!, ...(p.base !== undefined ? { base: p.base } : {}) })), audit, now);
    linkHistory(page, history);
  }
  const files: Record<string, string> = { "estate.json": JSON.stringify(page, null, 2) + "\n", "estate.html": renderEstateHtml(page, dora, policy), [DORA_FILE]: JSON.stringify(dora, null, 2) + "\n", [POLICY_METRICS_FILE]: JSON.stringify(policy, null, 2) + "\n" };
  if (history) Object.assign(files, { [HISTORY_FILES.json]: JSON.stringify(history, null, 2) + "\n", [HISTORY_FILES.page]: renderHistoryHtml(history) });
  const dir = resolve(cwd, options.out ?? "terragucci-estate");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result: EstateResult = { estate: page, files: Object.keys(files).map((f) => join(dir, f)), unreadable: indexes.filter((i) => i.error !== undefined).map((i) => i.project), dora, policy };
  const tel = telemetryFromEnv(env);
  if (tel?.metrics) {
    const gauges = fromLedger ? fromLedger.chant.deliveryGauges(fromLedger.ledger.dora, fromLedger.words) : doraGauges(dora);
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
  lines.push(`dora: ${d.estate.per_week} deployments per week (${d.estate.deployments} in ${spanLabel(d.estate.span_seconds)}), lead time ${duration(d.estate.lead_time.median_seconds)}, change failure rate ${c === null ? "none" : `${Math.round(c * 1000) / 10}%`}, time to restore ${duration(d.estate.restore.median_seconds)}`);
  const pm = r.policy.estate;
  lines.push(`policy: ${plural(pm.denials, "denial", "denials")}, override rate ${pm.override_rate === null ? "none" : `${Math.round(pm.override_rate * 1000) / 10}%`}, override turnaround ${duration(pm.requests.turnaround_median_seconds)}, ${plural(pm.requests.open, "override request", "override requests")} open, ${pm.blocked.waves} blocked before deploy against ${pm.found_after.total} found after`);
  if (r.metrics) lines.push("sent" in r.metrics ? `sent ${plural(r.metrics.sent, "DORA gauge", "DORA gauges")}` : `the DORA gauges were not sent: ${r.metrics.problem}`);
  lines.push(`wrote ${listed(r.files.map((f) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)))}`);
  if (r.uploaded) lines.push(`copied to ${named(r.uploaded.bucket)}/${listed(r.uploaded.keys)}`);
  if (r.link) lines.push(`link, until ${r.link.expires}:`, r.link.url);
  return lines.join("\n");
}
