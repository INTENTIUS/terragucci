/**
 * `terragucci audit`: one audit trail for every project, written to the
 * reports bucket as `<prefix>/audit.jsonl` (the record), `audit.html` (its
 * page, which the estate page links) and `audit.json` (a summary), with a link
 * to the page (presigned on S3, a signed URL on GCS, a SAS on Azure Blob).
 *
 * The entries come from two records the customer already holds
 * (report/audit.ts): each project's `chant/lifecycle` history, for every
 * approval, approval request, policy override and revocation, state
 * migration, state export and ephemeral environment, and each
 * project's `tf-apply` wave reports in the bucket, for every apply and its
 * result and every refused wave. Nothing else is read, and nothing is kept
 * anywhere but the bucket.
 *
 * The record is append-only: the command reads it, keeps every line, and
 * appends the entries the sources hold that it lacks, with a conditional
 * write so two runs never drop each other's lines. `--check` writes nothing:
 * it builds the entries again and fails, naming each, when the record lacks
 * one, such as an approval on the ledger the record does not hold.
 *
 * From a control repo the projects are its `projects:`: each one's ledger is
 * fetched from its repo (its `url`, else `https://<key>`, with the forge token
 * when the job has one), and its reports read from its own bucket. In a
 * single repo the project is the checkout's own, and its ledger is origin's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError, forgeFromHost, parseProjectKey, resolveProject, resolveRepo, type ForgeName, type TerragucciConfig } from "./config";
import { clients, DEFAULT_LINK_SECONDS, named, parseIndex, sameBucket } from "./estate";
import { DEFAULT_TOKEN_ENV } from "./forge";
import { where, withToken } from "./reconcile";
import {
  APPLY_LEDGER,
  appendEntries,
  AUDIT_FILES,
  ledgerEntries,
  LEDGER_BRANCH,
  missingEntries,
  OVERRIDE_LEDGER_FILE,
  MIGRATE_LEDGER_FILE,
  MIGRATE_DONE_FILE,
  UNLOCK_LEDGER_FILE,
  UNLOCK_DONE_FILE,
  EXPORT_LEDGER_FILE,
  EXPORT_DONE_FILE,
  EPHEMERAL_LEDGER_FILE,
  EPHEMERAL_DONE_FILE,
  parseLedgerLog,
  readRecord,
  renderAuditHtml,
  reportEntry,
  reportEntryId,
  summarize,
  type AuditEntry,
  type AuditProject,
  type AuditSummary,
} from "./report/audit";
import { PRESIGN_MAX_SECONDS, StoreConflict, StoreError, type ObjectStore, type StoreFetch } from "./report/object-store";
import type { Report } from "./report/schema";
import { runFacts } from "./report/stage";
import { INDEX_TRIES, reportsBase } from "./report/store";

type Reports = NonNullable<TerragucciConfig["reports"]>;

export interface AuditOptions {
  /** Where the page is written locally. Default `terragucci-audit` in the working directory. */
  out?: string;
  /** How long the presigned link to the page lives. Default 24 hours. */
  linkSeconds?: number;
  /** The bucket to read and write, in place of the config's `reports` (a single repo only). */
  reports?: Reports;
  /** Build the entries and compare them with the record; write nothing. */
  check?: boolean;
  fetch?: StoreFetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface AuditResult {
  summary: AuditSummary;
  /** The entries this run appended, or with `check` the entries the record lacks. */
  added: AuditEntry[];
  /** The files written locally. None with `check`. */
  files: string[];
  uploaded?: { bucket: string; keys: string[] };
  link?: { url: string; expires: string };
  /** Projects whose ledger or index could not be read. */
  unreadable: string[];
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const key = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** Where a project's ledger is: the checkout's origin, or a repo to fetch it from. */
type LedgerSource = { kind: "checkout"; dir: string } | { kind: "remote"; url: string; token?: string };

interface Source {
  project: string;
  reports?: Reports;
  ledger: LedgerSource;
  /** The page of a commit on the project's forge, when the project names one. */
  commitUrl: (commit: string) => string | undefined;
}

/** A commit's page: GitHub and Forgejo at `/commit/<sha>`, GitLab at `/-/commit/<sha>`. */
function commitPage(project: string, origin: string | undefined, forge: ForgeName | undefined): (commit: string) => string | undefined {
  let path: string;
  let host: string;
  try {
    const pk = parseProjectKey(project);
    path = pk.path;
    host = pk.host;
  } catch {
    return () => undefined;
  }
  const f = forge ?? forgeFromHost(host);
  const web = origin && /^https?:\/\//.test(origin) ? origin.replace(/\/+$/, "") : `https://${host}`;
  if (!f) return () => undefined;
  return (commit) => `${web}/${path}/${f === "gitlab" ? "-/" : ""}commit/${commit}`;
}

function sources(cwd: string, config: TerragucciConfig, options: AuditOptions, env: NodeJS.ProcessEnv): { projects: Source[]; out?: Reports } {
  if (config.projects && Object.keys(config.projects).length > 0) {
    if (options.reports) throw new ConfigError("--bucket names one bucket; a control repo reads each project's reports and writes the audit trail under defaults.reports");
    const projects = Object.keys(config.projects).map((p): Source => {
      const settings = resolveProject(config, p);
      const forge = settings.forge ?? (() => {
        try {
          return forgeFromHost(parseProjectKey(p).host);
        } catch {
          return undefined;
        }
      })();
      const { cloneUrl, origin } = where(p, settings.url);
      const tokenEnv = settings.token_env ?? (forge ? DEFAULT_TOKEN_ENV[forge] : undefined);
      const token = tokenEnv ? env[tokenEnv] : undefined;
      return { project: p, ...(settings.reports ? { reports: settings.reports } : {}), ledger: { kind: "remote", url: cloneUrl, ...(token ? { token } : {}) }, commitUrl: commitPage(p, origin, forge) };
    });
    const out = config.defaults?.reports;
    return { projects, ...(out ? { out } : {}) };
  }
  const settings = resolveRepo(config);
  const out = options.reports ?? settings.reports;
  if (!out?.bucket) throw new ConfigError("audit writes to the reports bucket: set reports.bucket in terragucci.yml, or pass --bucket with s3://<bucket>, gs://<bucket> or az://<account>/<container>");
  const project = runFacts(cwd, env, settings.forge).project;
  return { projects: [{ project, reports: out, ledger: { kind: "checkout", dir: cwd }, commitUrl: commitPage(project, settings.url, settings.forge) }], out };
}

function git(dir: string, args: string[], secret?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const hide = (s: string): string => (secret ? s.split(secret).join("***") : s);
  return { ok: r.status === 0, out: r.stdout ?? "", err: hide((r.stderr ?? "").trim() || (r.error?.message ?? "")) };
}

/**
 * The project's ledger entries from its chant/lifecycle history. Returns
 * "none" when the repo has no such branch yet.
 */
function readLedger(source: Source): AuditEntry[] | "none" {
  let dir: string;
  let ref: string;
  let scratch: string | undefined;
  let secret: string | undefined;
  if (source.ledger.kind === "checkout") {
    dir = source.ledger.dir;
    ref = `refs/remotes/origin/${LEDGER_BRANCH}`;
    const heads = git(dir, ["ls-remote", "--heads", "origin", LEDGER_BRANCH]);
    if (!heads.ok) throw new Error(`cannot read ${LEDGER_BRANCH} from origin: ${heads.err}`);
    if (!heads.out.trim()) return "none";
    const f = git(dir, ["fetch", "-q", "origin", `+refs/heads/${LEDGER_BRANCH}:${ref}`]);
    if (!f.ok) throw new Error(`cannot fetch ${LEDGER_BRANCH}: ${f.err}`);
  } else {
    scratch = mkdtempSync(join(tmpdir(), "terragucci-audit-"));
    dir = scratch;
    ref = `refs/heads/${LEDGER_BRANCH}`;
    secret = source.ledger.token;
    const url = withToken(source.ledger.url, secret);
    git(dir, ["init", "-q", "--bare"]);
    const heads = git(dir, ["ls-remote", "--heads", url, LEDGER_BRANCH], secret);
    if (!heads.ok) {
      rmSync(scratch, { recursive: true, force: true });
      throw new Error(`cannot read ${LEDGER_BRANCH} from ${source.ledger.url}: ${heads.err}`);
    }
    if (!heads.out.trim()) {
      rmSync(scratch, { recursive: true, force: true });
      return "none";
    }
    const f = git(dir, ["fetch", "-q", url, `+refs/heads/${LEDGER_BRANCH}:${ref}`], secret);
    if (!f.ok) {
      rmSync(scratch, { recursive: true, force: true });
      throw new Error(`cannot fetch ${LEDGER_BRANCH} from ${source.ledger.url}: ${f.err}`);
    }
  }
  try {
    const entries: AuditEntry[] = [];
    for (const path of [APPLY_LEDGER, OVERRIDE_LEDGER_FILE, MIGRATE_LEDGER_FILE, MIGRATE_DONE_FILE, UNLOCK_LEDGER_FILE, UNLOCK_DONE_FILE, EXPORT_LEDGER_FILE, EXPORT_DONE_FILE, EPHEMERAL_LEDGER_FILE, EPHEMERAL_DONE_FILE]) {
      const log = git(dir, ["-c", "core.quotepath=off", "log", "--reverse", "--no-color", "--no-ext-diff", "--no-renames", "--format=%x1e%H%x1f%an%x1f%aI", "-p", "--unified=0", ref, "--", path]);
      if (!log.ok) throw new Error(`cannot read the history of ${path} on ${LEDGER_BRANCH}: ${log.err}`);
      entries.push(...ledgerEntries(source.project, path, parseLedgerLog(log.out), source.commitUrl));
    }
    return entries;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The project's wave reports the record does not hold yet, as entries. */
async function readReports(source: Source, out: Reports | undefined, client: (r: Reports) => ObjectStore, known: Set<string>, approvals: AuditEntry[]): Promise<{ entries: AuditEntry[]; read: number }> {
  const reports = source.reports;
  if (!reports?.bucket) throw new StoreError("the project names no reports bucket");
  const store = client(reports);
  const indexKey = key(reports.prefix ?? "", source.project, "index.json");
  const text = await store.get(indexKey);
  if (text === undefined) return { entries: [], read: 0 };
  const rows = parseIndex(text, indexKey).filter((r) => r.project === source.project && r.stage === "tf-apply");
  // From audit.html at the top of the output prefix, a run's directory is <project>/<path>/ in the same bucket, or on its own bucket's address.
  const served = reportsBase(reports);
  const base = sameBucket(reports, out) ? `${source.project}/` : served ? `${served}/${source.project}/` : undefined;
  const entries: AuditEntry[] = [];
  let read = 0;
  for (const row of rows) {
    if (known.has(reportEntryId(source.project, row.path, row.finished))) continue;
    const k = key(reports.prefix ?? "", source.project, row.path, "report.json");
    const body = await store.get(k);
    if (body === undefined) continue;
    let report: Report;
    try {
      report = JSON.parse(body) as Report;
    } catch {
      continue;
    }
    read++;
    const e = reportEntry(report, row.path, { source: "report", bucket: named(reports.bucket), key: k, ...(base !== undefined ? { url: `${base}${row.path}/report.html` } : {}) }, approvals);
    if (e) entries.push(e);
  }
  return { entries, read };
}

/** Append the entries the record at `at` lacks, conditional on the copy read; on a conflict read it again and append what it still lacks. */
async function writeRecord(store: ObjectStore, at: string, derived: AuditEntry[]): Promise<{ record: ReturnType<typeof readRecord>; added: AuditEntry[] }> {
  for (let attempt = 1; ; attempt++) {
    const read = await store.read(at);
    const record = readRecord(read.body);
    const added = missingEntries(record, derived);
    if (added.length === 0 && read.body !== undefined) return { record, added };
    const when = read.etag ? { ifMatch: read.etag } : read.body === undefined ? { ifNoneMatch: "*" as const } : undefined;
    try {
      const text = appendEntries(record, added);
      await store.put(at, text, "application/x-ndjson", when);
      return { record: readRecord(text), added };
    } catch (e) {
      if (!(e instanceof StoreConflict)) throw e;
      if (attempt >= INDEX_TRIES) throw new StoreError(`${at} changed under this run ${INDEX_TRIES} times in a row; nothing was appended`);
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

export async function audit(cwd: string, config: TerragucciConfig, options: AuditOptions = {}): Promise<AuditResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const seconds = options.linkSeconds ?? DEFAULT_LINK_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new ConfigError(`the link lives 1 second to 7 days (${PRESIGN_MAX_SECONDS} seconds); ${seconds} is out of range`);
  const client = clients(env, options.fetch);
  const { projects, out } = sources(cwd, config, options, env);
  if (!out?.bucket) throw new ConfigError("audit writes to the reports bucket: set defaults.reports.bucket in the control repo's terragucci.yml");
  const store = client(out);
  const recordKey = key(out.prefix ?? "", AUDIT_FILES.record);
  const before = readRecord((await store.read(recordKey)).body);

  // Every source, read once: the ledgers in full, and the wave reports the record does not hold yet.
  const states: AuditProject[] = [];
  const derived: AuditEntry[] = [];
  for (const p of projects) {
    const state: AuditProject = { project: p.project, ledger: "read", reports: 0 };
    let approvals: AuditEntry[] = [];
    try {
      const l = readLedger(p);
      if (l === "none") state.ledger = "none";
      else {
        approvals = l;
        derived.push(...l);
      }
    } catch (e) {
      state.ledger = "error";
      state.error = (e as Error).message;
    }
    // A report the record holds is not read again; one the record lacks is matched to the approvals the record and the ledger hold.
    const known = new Set(before.ids);
    try {
      const r = await readReports(p, out, client, known, [...before.entries, ...approvals]);
      derived.push(...r.entries);
      state.reports = r.read;
    } catch (e) {
      if (!(e instanceof StoreError) && !(e instanceof TypeError)) throw e;
      state.error = state.error ? `${state.error}; ${e.message}` : `the index could not be read: ${e.message}`;
    }
    states.push(state);
  }
  const unreadable = states.filter((s) => s.error !== undefined).map((s) => s.project);

  if (options.check) {
    const missing = missingEntries(before, derived);
    return { summary: summarize(before.entries, 0, states, now), added: missing, files: [], unreadable };
  }

  const { record, added } = await writeRecord(store, recordKey, derived);
  const summary = summarize(record.entries, added.length, states, now);
  const files: Record<string, string> = {
    [AUDIT_FILES.record]: appendEntries(record, []),
    [AUDIT_FILES.page]: renderAuditHtml(summary, record.entries),
    [AUDIT_FILES.summary]: JSON.stringify(summary, null, 2) + "\n",
  };
  const dir = resolve(cwd, options.out ?? "terragucci-audit");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const keys = [recordKey];
  for (const name of [AUDIT_FILES.page, AUDIT_FILES.summary]) {
    const k = key(out.prefix ?? "", name);
    await store.put(k, files[name], name.endsWith(".html") ? "text/html; charset=utf-8" : "application/json");
    keys.push(k);
  }
  const link = await store.presign(key(out.prefix ?? "", AUDIT_FILES.page), seconds, now);
  return { summary, added, files: Object.keys(files).map((f) => join(dir, f)), uploaded: { bucket: out.bucket, keys }, link: { url: link.url, expires: link.expires.toISOString() }, unreadable };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const line = (e: AuditEntry): string => `  ${e.at} ${e.project} ${e.kind} ${e.what}${e.who ? ` by ${e.who}` : ""}${e.digest ? ` ${e.digest}` : ""}: ${e.result}`;

/** What the command prints. */
export function describeAudit(r: AuditResult, cwd: string, check = false): string {
  const lines: string[] = [];
  if (check) {
    lines.push(r.added.length === 0 ? `audit: the record holds every entry the sources hold (${plural(r.summary.entries, "entry", "entries")})` : `audit: the record lacks ${plural(r.added.length, "entry", "entries")} the sources hold:`);
    for (const e of r.added) lines.push(line(e));
  } else {
    lines.push(`audit: ${plural(r.summary.entries, "entry", "entries")}, ${r.added.length} added`);
    for (const e of r.added) lines.push(line(e));
  }
  for (const p of r.summary.projects) {
    if (p.ledger === "error") lines.push(`  ${p.project}: the ledger could not be read: ${p.error}`);
    else if (p.error) lines.push(`  ${p.project}: ${p.error}`);
    else if (p.ledger === "none") lines.push(`  ${p.project}: no ${LEDGER_BRANCH} yet`);
  }
  if (r.files.length) lines.push(`wrote ${r.files.map((f) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)).join(", ")}`);
  if (r.uploaded) lines.push(`copied to ${named(r.uploaded.bucket)}/${r.uploaded.keys.join(", ")}`);
  if (r.link) lines.push(`link, until ${r.link.expires}:`, r.link.url);
  return lines.join("\n");
}
