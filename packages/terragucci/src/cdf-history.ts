/**
 * The past versions of a choudoufu record, from `choudoufu live-history -json
 * [-estate=<name>] <address>` (choudoufu 0.25.0): each version's id, when it
 * was written, and whether it is the current one or a delete marker. Never
 * what a version holds.
 *
 * An `s3` record store keeps them as the bucket's noncurrent versions; a
 * `local` or `kubernetes` store replaces a record in place and keeps none,
 * which live-history reports as `kept: false`. Listing them takes
 * s3:ListBucketVersions on the record store bucket. A `tf-apply` wave runs it
 * in each choudoufu root it applied, for each resource the apply changed,
 * under the identity it reads that root's records with; when that identity
 * cannot list them, the error is kept as live-history printed it.
 */
import { spawn } from "node:child_process";
import { binaryEnv } from "./binary-env";
import type { ReportRecordVersions } from "./report/schema";

/** live-history's -json document, cut to what the report keeps; undefined when the text is not one. */
export function parseLiveHistory(text: string): Omit<ReportRecordVersions, "read"> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as { kept?: unknown; store?: unknown; versions?: unknown };
  if (typeof d.kept !== "boolean" || typeof d.store !== "string") return undefined;
  const versions = (Array.isArray(d.versions) ? d.versions : []).flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const x = v as { version_id?: unknown; last_modified?: unknown; current?: unknown; deleted?: unknown };
    if (typeof x.version_id !== "string" || typeof x.last_modified !== "string") return [];
    return [{ version_id: x.version_id, last_modified: x.last_modified, current: x.current === true, deleted: x.deleted === true }];
  });
  return { kept: d.kept, store: d.store, versions };
}

/** The command line live-history runs with. */
export const liveHistoryArgs = (address: string, estate?: string): string[] => ["live-history", "-json", ...(estate ? [`-estate=${estate}`] : []), address];

export type HistoryRun = (binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

const run: HistoryRun = (binary, args, cwd, env) =>
  new Promise((done) => {
    const child = spawn(binary, args, { cwd, env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (e) => done({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

/** At most this much of an error is kept. */
const ERROR_CHARS = 2000;

/**
 * One record's versions, read in the root's directory (`dir`) with `env`.
 * A run that fails keeps its error as printed, never failing the wave.
 */
export async function recordVersions(binary: string, dir: string, address: string, estate: string | undefined, env: NodeJS.ProcessEnv, now: () => Date = () => new Date(), exec: HistoryRun = run): Promise<ReportRecordVersions> {
  const r = await exec(binary, liveHistoryArgs(address, estate), dir, env);
  const read = now().toISOString();
  const parsed = r.code === 0 ? parseLiveHistory(r.stdout) : undefined;
  if (parsed) return { ...parsed, read };
  const error = (r.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim() || r.stdout.trim() || `${binary} live-history exited ${r.code}`).slice(0, ERROR_CHARS);
  return { error, read };
}

/** How a record's versions read on a page: "3 versions", "kept none (kubernetes)", or the error. */
export function versionsLine(v: ReportRecordVersions): string {
  if (v.error !== undefined) return `not listed: ${v.error.split("\n").find((l) => l.trim()) ?? v.error}`;
  if (!v.kept) return `the ${v.store} record store keeps no past versions`;
  const n = v.versions?.length ?? 0;
  return `${n} ${n === 1 ? "version" : "versions"}`;
}
