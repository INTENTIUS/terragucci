// What scripts/demo-reports.ts decides, kept apart so it can be tested without
// a bucket: which commits' reports a demo project keeps, which objects go, and
// each document that names a run, rewritten without the runs that went.
//
// A project's reports are under <prefix>/<project>/ (packages/terragucci/src/report/store.ts):
// a wave's or a stage's directory at <yyyy>/<mm>/<commit>/<stage>[-wave-N]/,
// and an applied commit's run view at runs/<commit>/ (report/run-view.ts).
// Every other object there (index.json, changes.json, inventory.json, ...) is
// the project's own and stays.
import type { AuditEntry, AuditSummary } from "../packages/terragucci/src/report/audit";
import type { ChangeRow, History } from "../packages/terragucci/src/report/history";
import type { StateVersions } from "../packages/terragucci/src/report/state-versions";
import type { IndexEntry, ReportIndex } from "../packages/terragucci/src/report/store";

/** The commits each project keeps by default: the newest this many its index lists. */
export const REPORTS_KEEP = 50;
/** The fewest commits a project keeps, whatever DEMO_REPORTS_KEEP says: more than the 12 runs per stage behold reads. */
export const REPORTS_KEEP_MIN = 20;
/** At most this many objects are deleted in one reset, oldest commits first, so a long backlog never holds one up. */
export const REPORTS_DELETE_MAX = 5000;
/** A commit with an object written this recently, in seconds, is kept: a run may be writing it. */
export const REPORTS_GRACE = 900;

/** One object of a bucket listing: its key, and when it was written (null when the listing does not say). */
export interface Listed {
  key: string;
  modified: string | null;
}

const unxml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The objects of one S3 ListObjectsV2 answer, and the token of the next page (null on the last). */
export function listPage(xml: string): { objects: Listed[]; next: string | null } {
  const objects: Listed[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
    if (!key) continue;
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[1]);
    objects.push({ key: unxml(key[1]), modified: modified ? modified[1] : null });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { objects, next: truncated && next ? unxml(next[1]) : null };
}

/** The commit of a run's path under its project (`<yyyy>/<mm>/<commit>/<stage>`), or null when it is not one. */
export function runCommit(path: string): string | null {
  const m = /^\d{4}\/\d{2}\/([^/]+)\/[^/]+$/.exec(path.replace(/^\/+|\/+$/g, ""));
  return m ? m[1] : null;
}

/** The commit an object under the project's directory belongs to, or null for the project's own files. `rel` is the key from `<project>/` on. */
export function objectCommit(rel: string): string | null {
  const m = /^(?:\d{4}\/\d{2}|runs)\/([^/]+)\/./.exec(rel);
  return m ? m[1] : null;
}

/** The repo a project of the demo names: `forgejo:3000/<admin>/demo` is `<admin>/demo`'s. */
export const projectOfRepo = (project: string, repo: unknown): boolean => typeof repo === "string" && repo !== "" && (project === repo || project.endsWith(`/${repo}`));

/** What makes an index row the latest of its kind (store.ts rowKind): its project, stage, wave and share. */
const rowKind = (r: IndexEntry): string => `${r.project}\n${r.stage}\n${r.wave ?? ""}\n${r.share ?? ""}`;

const at = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) || 0 : 0);

/**
 * The commits a project's documents need beyond the newest kept: the newest
 * row of each stage and wave (the estate page's latest state of each), the
 * runs inventory.json and edges.json name, the newest state version of each
 * root, and each commit a stored cycle record or demo.json names for the
 * project's repo (what behold's kiosk pins and replays).
 */
export function protectedCommits(o: { project: string; rows: readonly IndexEntry[]; inventory?: unknown; edges?: unknown; states?: unknown; demo?: readonly unknown[] }): Set<string> {
  const out = new Set<string>();
  const addPath = (p: unknown) => {
    const c = typeof p === "string" ? runCommit(p) : null;
    if (c) out.add(c);
  };
  const newest = new Map<string, IndexEntry>();
  for (const r of o.rows) {
    if (r.project !== o.project) continue;
    const held = newest.get(rowKind(r));
    if (!held || at(r.finished) > at(held.finished)) newest.set(rowKind(r), r);
  }
  for (const r of newest.values()) addPath(r.path);
  const roots = (doc: unknown): Record<string, unknown>[] =>
    doc && typeof doc === "object" && Array.isArray((doc as { roots?: unknown }).roots) ? ((doc as { roots: unknown[] }).roots.filter((r) => r && typeof r === "object") as Record<string, unknown>[]) : [];
  for (const r of roots(o.inventory)) addPath(r.path);
  for (const r of roots(o.edges)) {
    for (const run of [r.planned, r.applied]) if (run && typeof run === "object") addPath((run as { path?: unknown }).path);
  }
  for (const r of roots(o.states)) {
    const v = Array.isArray(r.versions) ? (r.versions[0] as { path?: unknown } | undefined) : undefined;
    if (v) addPath(v.path);
  }
  for (const d of o.demo ?? []) {
    if (!d || typeof d !== "object") continue;
    const doc = d as { repo?: unknown; commit?: unknown; steps?: unknown };
    if (!projectOfRepo(o.project, doc.repo)) continue;
    if (typeof doc.commit === "string" && doc.commit) out.add(doc.commit);
    if (Array.isArray(doc.steps)) {
      for (const s of doc.steps) {
        const c = s && typeof s === "object" ? (s as { commit?: unknown }).commit : undefined;
        if (typeof c === "string" && c) out.add(c);
      }
    }
  }
  return out;
}

/** Whether a kept commit `c` covers `commit`: the same sha, or one names the other's start (a short sha). */
const sameCommit = (a: string, b: string): boolean => a === b || (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)));

/** A set of kept commits that also answers for short shas. */
export function keeps(kept: ReadonlySet<string>): (commit: string) => boolean {
  const list = [...kept];
  return (commit) => kept.has(commit) || list.some((k) => sameCommit(k, commit));
}

/**
 * The commits a project keeps: the newest `keep` (never fewer than
 * REPORTS_KEEP_MIN) by the newest row its index lists for each, those
 * `protect` names, and each with an object written within `grace` seconds of
 * `now`.
 */
export function keptCommits(o: { project: string; rows: readonly IndexEntry[]; listed: readonly Listed[]; projectDir: string; keep: number; protect: ReadonlySet<string>; now: Date; grace?: number }): Set<string> {
  const last = new Map<string, number>();
  for (const r of o.rows) {
    if (r.project !== o.project) continue;
    const c = runCommit(r.path) ?? r.commit;
    last.set(c, Math.max(last.get(c) ?? 0, at(r.finished)));
  }
  const kept = new Set(
    [...last.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(o.keep, REPORTS_KEEP_MIN))
      .map(([c]) => c),
  );
  for (const c of o.protect) kept.add(c);
  const since = o.now.getTime() - (o.grace ?? REPORTS_GRACE) * 1000;
  for (const l of o.listed) {
    if (!l.key.startsWith(o.projectDir)) continue;
    const c = objectCommit(l.key.slice(o.projectDir.length));
    if (c && l.modified !== null && at(l.modified) >= since) kept.add(c);
  }
  return kept;
}

/**
 * The objects to delete: every one under the project's directory of a commit
 * it does not keep, the commits whose newest object is oldest first, at most
 * `max`. A commit is deleted whole or not started, unless it alone is more
 * than `max`.
 */
export function objectsToDelete(o: { listed: readonly Listed[]; projectDir: string; kept: ReadonlySet<string>; max?: number }): { keys: string[]; commits: string[] } {
  const max = o.max ?? REPORTS_DELETE_MAX;
  const keep = keeps(o.kept);
  const byCommit = new Map<string, { keys: string[]; newest: number }>();
  for (const l of o.listed) {
    if (!l.key.startsWith(o.projectDir)) continue;
    const c = objectCommit(l.key.slice(o.projectDir.length));
    if (!c || keep(c)) continue;
    const held = byCommit.get(c) ?? { keys: [], newest: 0 };
    held.keys.push(l.key);
    held.newest = Math.max(held.newest, at(l.modified));
    byCommit.set(c, held);
  }
  const keys: string[] = [];
  const commits: string[] = [];
  for (const [c, { keys: ks }] of [...byCommit.entries()].sort((a, b) => a[1].newest - b[1].newest || (a[0] < b[0] ? -1 : 1))) {
    if (keys.length > 0 && keys.length + ks.length > max) break;
    keys.push(...ks.sort().slice(0, max - keys.length));
    commits.push(c);
    if (keys.length >= max) break;
  }
  return { keys, commits };
}

// ---------------------------------------------------------------------------
// The documents, each without the runs of the commits that go. Each returns
// null when it has nothing to drop (or cannot be read), so it is not written.
// ---------------------------------------------------------------------------

/** A row's run path under its project: as the project's index lists it, or the top index's `<project>/<path>`. */
const rowRun = (r: IndexEntry, project: string, top: boolean): string | null => (!top ? r.path : r.path.startsWith(`${project}/`) ? r.path.slice(project.length + 1) : null);

/** An index without the project's rows of commits it does not keep. `top`: the index at the top of the prefix, whose paths start with the project. */
export function pruneIndex(text: string | undefined, project: string, kept: ReadonlySet<string>, top = false): { index: ReportIndex; dropped: number } | null {
  if (!text) return null;
  let parsed: Partial<ReportIndex>;
  try {
    parsed = JSON.parse(text) as Partial<ReportIndex>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.reports)) return null;
  const keep = keeps(kept);
  const reports = parsed.reports.filter((r) => {
    if (r.project !== project) return true;
    const run = rowRun(r, project, top);
    const c = run === null ? null : runCommit(run);
    return c === null || keep(c);
  });
  const dropped = parsed.reports.length - reports.length;
  return dropped === 0 ? null : { index: { ...(parsed as ReportIndex), reports }, dropped };
}

/** changes.json without the rows of runs that go. */
export function pruneChanges(text: string | undefined, kept: ReadonlySet<string>): { doc: { schema: string; changes: ChangeRow[] }; dropped: number } | null {
  if (!text) return null;
  let parsed: { schema?: string; changes?: ChangeRow[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.changes)) return null;
  const keep = keeps(kept);
  const changes = parsed.changes.filter((c) => {
    const commit = typeof c?.path === "string" ? runCommit(c.path) : null;
    return commit === null || keep(commit);
  });
  const dropped = parsed.changes.length - changes.length;
  return dropped === 0 ? null : { doc: { ...(parsed as { schema: string }), changes }, dropped };
}

/** states.json without the versions whose run goes. The newest version of each root is protected, so it never goes. */
export function pruneStates(text: string | undefined, kept: ReadonlySet<string>): { doc: StateVersions; dropped: number } | null {
  if (!text) return null;
  let parsed: Partial<StateVersions>;
  try {
    parsed = JSON.parse(text) as Partial<StateVersions>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.roots)) return null;
  const keep = keeps(kept);
  let dropped = 0;
  const roots = parsed.roots.map((r) => {
    if (!r || !Array.isArray(r.versions)) return r;
    const versions = r.versions.filter((v) => {
      const c = typeof v?.path === "string" ? runCommit(v.path) : null;
      return c === null || keep(c);
    });
    dropped += r.versions.length - versions.length;
    return { ...r, versions };
  });
  return dropped === 0 ? null : { doc: { ...(parsed as StateVersions), roots }, dropped };
}

/** The commit of a history apply's `report` link: `<base><yyyy>/<mm>/<commit>/<stage>/report.html`. */
const reportLinkCommit = (link: unknown): string | null => {
  const m = typeof link === "string" ? /(?:^|\/)\d{4}\/\d{2}\/([^/]+)\/[^/]+\/report\.html$/.exec(link) : null;
  return m ? m[1] : null;
};

/** history.json without the applies of runs that go, for each project in `kept`; a resource left with none goes too. */
export function pruneHistory(text: string | undefined, kept: ReadonlyMap<string, ReadonlySet<string>>): { history: History; dropped: number } | null {
  if (!text) return null;
  let parsed: Partial<History>;
  try {
    parsed = JSON.parse(text) as Partial<History>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.resources)) return null;
  const keepers = new Map([...kept].map(([p, s]) => [p, keeps(s)]));
  let dropped = 0;
  const resources = parsed.resources.flatMap((r) => {
    const keep = r && keepers.get(r.project);
    if (!keep || !Array.isArray(r.applies)) return [r];
    const applies = r.applies.filter((a) => {
      const c = reportLinkCommit(a?.report) ?? (typeof a?.commit === "string" ? a.commit : null);
      return c === null || keep(c);
    });
    dropped += r.applies.length - applies.length;
    return applies.length > 0 ? [{ ...r, applies }] : [];
  });
  return dropped === 0 ? null : { history: { ...(parsed as History), resources }, dropped };
}

/** A report entry's run commit: its evidence key is `<prefix>/<project>/<yyyy>/<mm>/<commit>/<stage>/report.json`. */
function entryCommit(e: AuditEntry): string | null {
  if (e.evidence?.source !== "report" || typeof e.evidence.key !== "string") return null;
  const tail = e.evidence.key.replace(/\/report\.json$/, "");
  const i = tail.lastIndexOf(`${e.project}/`);
  return i < 0 ? null : runCommit(tail.slice(i + e.project.length + 1));
}

/**
 * The commits each repo's chant/lifecycle holds, from the driver's
 * `<repo> <sha>` lines; a line of the repo alone says it has no such branch,
 * so it holds none. A repo with no line is not known, and none of its
 * ledger entries is dropped.
 */
export function readLedgerCommits(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    const [repo, sha] = line.trim().split(/\s+/);
    if (!repo) continue;
    const held = out.get(repo) ?? new Set<string>();
    if (sha) held.add(sha);
    out.set(repo, held);
  }
  return out;
}

/** What the ledger holds, for pruneAudit: each repo's chant/lifecycle commits, and when each project's oldest kept report finished. */
export interface LedgerHeld {
  commits: ReadonlyMap<string, ReadonlySet<string>>;
  oldest: ReadonlyMap<string, number>;
}

/**
 * Whether a ledger entry goes: its repo's chant/lifecycle no longer holds the
 * commit that added or removed its line (each cycle puts the branch back to
 * its base, so `terragucci audit` never builds it again), and it is older
 * than its project's oldest kept report, so the DORA numbers' gate times
 * cover the same runs the reports do.
 */
function ledgerGone(e: AuditEntry, ledger: LedgerHeld | undefined): boolean {
  if (!ledger || e.evidence?.source !== "ledger") return false;
  const repo = [...ledger.commits.keys()].find((r) => projectOfRepo(e.project, r));
  if (repo === undefined) return false;
  const commit = e.evidence.commit;
  if (typeof commit === "string" && ledger.commits.get(repo)!.has(commit)) return false;
  // A project the prune did not read keeps its entries.
  const oldest = ledger.oldest.get(e.project);
  return oldest !== undefined && at(e.at) < oldest;
}

/**
 * audit.jsonl without the report entries of runs that go, for each project
 * in `kept`, and without the ledger entries `ledger` says are gone. Every
 * other line stays, in its place: a ledger entry chant/lifecycle still holds
 * (`terragucci audit --check` finds the record holds every entry its sources
 * do), and a line that is not an entry. The record's entries after it are
 * returned too.
 */
export function pruneAudit(text: string | undefined, kept: ReadonlyMap<string, ReadonlySet<string>>, ledger?: LedgerHeld): { text: string; entries: AuditEntry[]; dropped: number } | null {
  if (!text) return null;
  const keepers = new Map([...kept].map(([p, s]) => [p, keeps(s)]));
  const lines: string[] = [];
  const entries: AuditEntry[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let e: AuditEntry | undefined;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && (v as { schema?: unknown }).schema === "terragucci.audit/v1") e = v as AuditEntry;
    } catch {
      e = undefined;
    }
    const keep = e ? keepers.get(e.project) : undefined;
    const c = e && keep ? entryCommit(e) : null;
    if ((e && keep && c !== null && !keep(c)) || (e && ledgerGone(e, ledger))) {
      dropped++;
      continue;
    }
    lines.push(line);
    if (e) entries.push(e);
  }
  return dropped === 0 ? null : { text: lines.length ? lines.join("\n") + "\n" : "", entries, dropped };
}

/** audit.json's counts for the record after the prune; null when it is not the summary terragucci audit writes. */
export function recount(text: string | undefined, entries: readonly AuditEntry[]): AuditSummary | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as AuditSummary;
    if (s.schema !== "terragucci.audit-summary/v1") return null;
    const kinds: AuditSummary["kinds"] = {};
    for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return { ...s, entries: entries.length, kinds };
  } catch {
    return null;
  }
}
