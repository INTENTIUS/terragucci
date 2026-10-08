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
 * It reads `index.json` and nothing else: never a report, a plan's text or a
 * root's plan JSON (see report/estate.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, resolveProject, resolveRepo, type TerragucciConfig } from "./config";
import { age, buildEstate, renderEstateHtml, type Estate, type ProjectIndex } from "./report/estate";
import { storeFromEnv } from "./report/bucket";
import { bucketUrl, parseReportsBucket, PRESIGN_MAX_SECONDS, StoreError, type ObjectStore, type StoreFetch } from "./report/object-store";
import { reportsBase, type IndexEntry, type ReportIndex } from "./report/store";

type Reports = NonNullable<TerragucciConfig["reports"]>;

export interface EstateOptions {
  /** Where the page is written locally. Default `terragucci-estate` in the working directory. */
  out?: string;
  /** How long the presigned link to the page lives. Default 24 hours. */
  linkSeconds?: number;
  /** The bucket to read and write, in place of the config's `reports` (a single repo only). */
  reports?: Reports;
  fetch?: StoreFetch;
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
}

export const DEFAULT_LINK_SECONDS = 24 * 3600;

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const key = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** A bucket's name with its scheme, s3:// for a bare name. */
const named = (bucket: string): string => {
  try {
    return bucketUrl(parseReportsBucket(bucket));
  } catch {
    return bucket;
  }
};

/** Two `reports` blocks name the same objects. */
const sameBucket = (a: Reports | undefined, b: Reports | undefined): boolean =>
  !!a && !!b && named(a.bucket) === named(b.bucket) && (a.endpoint ?? "") === (b.endpoint ?? "") && trim(a.prefix ?? "") === trim(b.prefix ?? "");

function parseIndex(text: string, at: string): IndexEntry[] {
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
function clients(env: NodeJS.ProcessEnv, fetchFn: StoreFetch | undefined): (r: Reports) => ObjectStore {
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
  try {
    const text = await client(reports).get(at);
    return { project, ...(text === undefined ? {} : { reports: parseIndex(text, at) }), ...(base !== undefined ? { base } : {}) };
  } catch (e) {
    if (!(e instanceof StoreError) && !(e instanceof TypeError)) throw e;
    return { project, error: e.message, ...(base !== undefined ? { base } : {}) };
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
  const files = { "estate.json": JSON.stringify(page, null, 2) + "\n", "estate.html": renderEstateHtml(page) };
  const dir = resolve(cwd, options.out ?? "terragucci-estate");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result: EstateResult = { estate: page, files: Object.keys(files).map((f) => join(dir, f)), unreadable: indexes.filter((i) => i.error !== undefined).map((i) => i.project) };
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

/** What the command prints. */
export function describeEstate(r: EstateResult, cwd: string): string {
  const t = r.estate.totals;
  const lines = [`estate: ${plural(t.projects, "project", "projects")}, ${plural(t.waiting, "wave", "waves")} waiting, ${plural(t.drifted_projects, "project", "projects")} drifted, ${plural(t.failed_roots, "root", "roots")} failed`];
  for (const p of r.estate.projects) {
    for (const w of p.waiting) lines.push(`  ${p.project}: wave ${w.wave} waits, for ${age(w.age_seconds)}`);
    if (p.drifted > 0) lines.push(`  ${p.project}: ${plural(p.drifted, "root", "roots")} drifted`);
    if (p.status === "error") lines.push(`  ${p.project}: the index could not be read: ${p.error}`);
  }
  lines.push(`wrote ${r.files.map((f) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)).join(" and ")}`);
  if (r.uploaded) lines.push(`copied to ${named(r.uploaded.bucket)}/${r.uploaded.keys.join(" and ")}`);
  if (r.link) lines.push(`link, until ${r.link.expires}:`, r.link.url);
  return lines.join("\n");
}
