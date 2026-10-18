// scripts/demo-reports.ts: each reset deletes the demo's old wave reports from
// the reports bucket, never a commit something still names, and drops their
// runs from every document that lists them first, and the gate lines each
// cycle's reset of chant/lifecycle took away from audit.jsonl (#1117). The choices are
// tested on their own, then the script against a stand-in bucket that answers
// as floci does.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../packages/terragucci/src/report/audit";
import type { History } from "../packages/terragucci/src/report/history";
import type { IndexEntry, ReportIndex } from "../packages/terragucci/src/report/store";
import {
  keptCommits,
  type Listed,
  listPage,
  objectCommit,
  objectsToDelete,
  protectedCommits,
  pruneAudit,
  pruneChanges,
  pruneHistory,
  pruneIndex,
  pruneStates,
  readLedgerCommits,
  recount,
  REPORTS_KEEP_MIN,
  runCommit,
} from "../scripts/demo-reports-lib";

const root = join(__dirname, "..");
const P = "forgejo:3000/admin/demo";
const OTHER = "forgejo:3000/admin/demo-terragrunt";
const DIR = `demo/${P}/`;
const OLD = "2026-01-01T00:00:00.000Z";

/** A commit's sha: 40 hex digits, distinct for each n. */
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const finished = (n: number): string => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
const runPath = (n: number, stage = "tf-plan"): string => `2026/10/${sha(n)}/${stage}`;

const row = (n: number, stage = "tf-plan", extra: Partial<IndexEntry> = {}): IndexEntry => ({
  project: P,
  commit: sha(n),
  stage,
  ...(stage === "tf-apply" ? { wave: 1 } : {}),
  finished: finished(n),
  path: runPath(n, stage === "tf-apply" ? "tf-apply-wave-1" : stage),
  roots: 1,
  groups: 1,
  totals: { create: 0, update: 1, replace: 0, delete: 0 },
  refused: 0,
  destroys: [],
  ...extra,
});

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("which commits a project keeps", () => {
  it("keeps the newest kept by their newest row, those protected, and those written in the grace", () => {
    const rows = range(1, 60).flatMap((n) => (n % 2 === 0 ? [row(n), row(n, "tf-apply")] : [row(n)]));
    const listed: Listed[] = [
      { key: `${DIR}${runPath(2)}/report.json`, modified: new Date(Date.UTC(2026, 9, 16, 11, 55)).toISOString() },
      { key: `${DIR}${runPath(4)}/report.json`, modified: OLD },
    ];
    const kept = keptCommits({ project: P, rows, listed, projectDir: DIR, keep: 50, protect: new Set([sha(3)]), now: new Date(Date.UTC(2026, 9, 16, 12, 0)) });
    expect([...kept].sort()).toEqual([...range(11, 60), 2, 3].map(sha).sort());
    expect(kept.has(sha(4))).toBe(false);
  });

  it("never keeps fewer than the minimum, and counts only the project's rows", () => {
    const rows = [...range(1, 30).map((n) => row(n)), { ...row(99), project: OTHER }];
    const kept = keptCommits({ project: P, rows, listed: [], projectDir: DIR, keep: 5, protect: new Set(), now: new Date() });
    expect(REPORTS_KEEP_MIN).toBe(20);
    expect([...kept].sort()).toEqual(range(11, 30).map(sha).sort());
  });

  it("protects the newest row of each stage and wave, what the project's documents name, and what the kiosk pins", () => {
    const rows = [row(1, "tf-drift"), row(2, "tf-drift"), ...range(3, 40).map((n) => row(n))];
    const got = protectedCommits({
      project: P,
      rows,
      inventory: { roots: [{ root: "network", path: runPath(4, "tf-apply-wave-1") }] },
      edges: { roots: [{ root: "app", reads: [], planned: { path: runPath(5) }, applied: { path: runPath(6, "tf-apply-wave-2") } }] },
      states: { roots: [{ root: "edge", versions: [{ path: runPath(7, "tf-apply-wave-3") }, { path: runPath(8, "tf-apply-wave-3") }] }] },
      demo: [
        { schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ commit: sha(9) }, { commit: null }] },
        { schema: "demo.cycle/v1", repo: "admin/demo-terragrunt", steps: [{ commit: sha(10) }] },
        { repo: "admin/demo", commit: sha(11), steps: undefined },
      ],
    });
    // tf-drift's newest is 2, tf-plan's 40; 1 is neither.
    expect([...got].sort()).toEqual([2, 40, 4, 5, 6, 7, 9, 11].map(sha).sort());
  });
});

describe("which objects go", () => {
  const listed: Listed[] = [
    { key: `${DIR}index.json`, modified: OLD },
    { key: `${DIR}changes.json`, modified: OLD },
    { key: `${DIR}${runPath(1)}/report.json`, modified: "2026-10-01T00:01:00.000Z" },
    { key: `${DIR}runs/${sha(1)}/run.json`, modified: "2026-10-01T00:01:30.000Z" },
    { key: `${DIR}${runPath(2)}/report.json`, modified: "2026-10-01T00:02:00.000Z" },
    { key: `${DIR}${runPath(2)}/roots/envs/app/plan.txt`, modified: "2026-10-01T00:02:00.000Z" },
    { key: `${DIR}${runPath(3)}/report.json`, modified: "2026-10-01T00:03:00.000Z" },
    { key: `demo/${OTHER}/${runPath(1)}/report.json`, modified: OLD },
  ];

  it("deletes the commits not kept, a run view with its commit, oldest first, never the project's own files or another project's", () => {
    const got = objectsToDelete({ listed, projectDir: DIR, kept: new Set([sha(3)]) });
    expect(got.commits).toEqual([sha(1), sha(2)]);
    expect(got.keys).toEqual([`${DIR}${runPath(1)}/report.json`, `${DIR}runs/${sha(1)}/run.json`, `${DIR}${runPath(2)}/report.json`, `${DIR}${runPath(2)}/roots/envs/app/plan.txt`]);
  });

  it("deletes at most max, a commit whole or not started, and a commit larger than max in part", () => {
    expect(objectsToDelete({ listed, projectDir: DIR, kept: new Set([sha(3)]), max: 3 }).commits).toEqual([sha(1)]);
    const one = objectsToDelete({ listed, projectDir: DIR, kept: new Set([sha(3)]), max: 1 });
    expect(one.keys).toHaveLength(1);
    expect(one.commits).toEqual([sha(1)]);
  });

  it("answers a short sha for a kept commit", () => {
    expect(objectsToDelete({ listed, projectDir: DIR, kept: new Set([sha(1).slice(0, 12), sha(2), sha(3)]) }).keys).toEqual([]);
  });

  it("reads keys and times from a bucket listing, and the next page's token", () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken><Contents><Key>demo/x&amp;y/index.json</Key><LastModified>${OLD}</LastModified></Contents><Contents><Key>demo/z</Key></Contents></ListBucketResult>`;
    expect(listPage(xml)).toEqual({ objects: [{ key: "demo/x&y/index.json", modified: OLD }, { key: "demo/z", modified: null }], next: "a&b" });
    expect(listPage("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").next).toBeNull();
  });

  it("finds the commit of a run's path and of an object under the project", () => {
    expect(runCommit(runPath(5, "tf-apply-wave-2"))).toBe(sha(5));
    expect(runCommit("index.json")).toBeNull();
    expect(objectCommit(`runs/${sha(5)}/run.html`)).toBe(sha(5));
    expect(objectCommit(`${runPath(5)}/note.md`)).toBe(sha(5));
    expect(objectCommit("inventory.json")).toBeNull();
  });
});

describe("the documents, without the runs that go", () => {
  const kept = new Set([sha(2)]);

  it("drops the project's index rows of commits not kept, in the project's index and the top one, and leaves the rest", () => {
    const own = { schema: "terragucci.report-index/v1", reports: [row(2), row(1), { ...row(3), path: "odd" }, { ...row(1), project: OTHER }] };
    const got = pruneIndex(JSON.stringify(own), P, kept);
    expect(got?.dropped).toBe(1);
    expect(got?.index.reports.map((r) => `${r.project} ${r.path}`)).toEqual([`${P} ${runPath(2)}`, `${P} odd`, `${OTHER} ${runPath(1)}`]);
    const top = { schema: "terragucci.report-index/v1", reports: [row(2), row(1)].map((r) => ({ ...r, path: `${P}/${r.path}` })) };
    expect(pruneIndex(JSON.stringify(top), P, kept, true)?.index.reports.map((r) => r.commit)).toEqual([sha(2)]);
    // Nothing to drop, or nothing that reads: not written.
    expect(pruneIndex(JSON.stringify({ reports: [row(2)] }), P, kept)).toBeNull();
    expect(pruneIndex("{", P, kept)).toBeNull();
  });

  it("drops changes.json rows and states.json versions of runs that go", () => {
    const changes = { schema: "terragucci.changes/v1", changes: [{ path: runPath(2, "tf-apply-wave-1"), address: "a" }, { path: runPath(1, "tf-apply-wave-1"), address: "b" }] };
    expect(pruneChanges(JSON.stringify(changes), kept)?.doc.changes.map((c) => c.address)).toEqual(["a"]);
    const states = { schema: "terragucci.state-versions/v1", roots: [{ root: "app", versions: [{ version_id: "v2", path: runPath(2, "tf-apply-wave-1") }, { version_id: "v1", path: runPath(1, "tf-apply-wave-1") }] }] };
    const got = pruneStates(JSON.stringify(states), kept);
    expect(got?.dropped).toBe(1);
    expect(got?.doc.roots[0].versions.map((v) => v.version_id)).toEqual(["v2"]);
  });

  it("drops the history's applies of runs that go, and a resource left with none, for the projects pruned only", () => {
    const apply = (n: number, project = P) => ({ actions: ["update"], attributes: [], commit: sha(n), finished: finished(n), plan_digest: null, set_digest: null, report: `${project}/${runPath(n, "tf-apply-wave-1")}/report.html` });
    const history = {
      schema: "terragucci.history/v1",
      generated: OLD,
      audit: true,
      resources: [
        { id: "h-1", project: P, root: "app", address: "a", type: "t", applies: [apply(1), apply(2)] },
        { id: "h-2", project: P, root: "app", address: "b", type: "t", applies: [apply(1)] },
        { id: "h-3", project: OTHER, root: "u", address: "c", type: "t", applies: [apply(1, OTHER)] },
      ],
    };
    const got = pruneHistory(JSON.stringify(history), new Map([[P, kept]]));
    expect(got?.dropped).toBe(2);
    expect((got?.history as History).resources.map((r) => `${r.id} ${r.applies.map((a) => a.commit.slice(-1)).join("")}`)).toEqual(["h-1 2", "h-3 1"]);
  });

  it("drops audit.jsonl's report entries of runs that go, keeps every other line in its place, and recounts the summary", () => {
    const entry = (id: string, kind: string, evidence: Record<string, unknown>, project = P) =>
      JSON.stringify({ schema: "terragucci.audit/v1", id, kind, project, at: OLD, who: null, what: "wave-1", digest: null, result: "applied", evidence });
    const report = (n: number, project = P) => ({ source: "report", bucket: "demo-reports", key: `demo/${project}/${runPath(n, "tf-apply-wave-1")}/report.json` });
    const lines = [
      entry("sha256:a1", "apply", report(1)),
      entry("sha256:l1", "approval", { source: "ledger", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl", commit: sha(1) }),
      "not an entry",
      entry("sha256:a2", "apply", report(2)),
      entry("sha256:o1", "apply", report(1, OTHER), OTHER),
    ];
    const got = pruneAudit(lines.join("\n") + "\n", new Map([[P, kept]]));
    expect(got?.dropped).toBe(1);
    expect(got?.text).toBe([lines[1], lines[2], lines[3], lines[4]].join("\n") + "\n");
    expect(got?.entries.map((e) => e.id)).toEqual(["sha256:l1", "sha256:a2", "sha256:o1"]);
    expect(pruneAudit(lines[1] + "\n", new Map([[P, kept]]))).toBeNull();

    const summary = { schema: "terragucci.audit-summary/v1", generated: OLD, record: "audit.jsonl", entries: 4, added: 1, kinds: { apply: 3, approval: 1 }, projects: [] };
    expect(recount(JSON.stringify(summary), got?.entries as AuditEntry[])).toMatchObject({ entries: 3, added: 1, kinds: { apply: 2, approval: 1 } });
    expect(recount("{}", [])).toBeNull();
  });
});

// The prune end to end, against a stand-in for floci's bucket: ETags, If-Match, and a listing in pages.
interface Stand {
  url: string;
  objects: Map<string, string>;
  deleted: string[];
  close: () => void;
}

async function stand(seed: Record<string, string>, opts: { listDown?: boolean } = {}): Promise<Stand> {
  const objects = new Map(Object.entries(seed));
  const versions = new Map<string, number>();
  const deleted: string[] = [];
  const etag = (k: string) => `"v${versions.get(k) ?? 0}"`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, text: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, headers);
        res.end(text);
      };
      if (url.searchParams.get("list-type") === "2") {
        if (opts.listDown) return send(503, "");
        const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
        const from = Number(url.searchParams.get("continuation-token") ?? 0);
        const page = keys.slice(from, from + 4);
        const more = from + 4 < keys.length;
        return send(
          200,
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 4}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${k}</Key><LastModified>${OLD}</LastModified></Contents>`).join("")}</ListBucketResult>`,
        );
      }
      const key = url.pathname.replace(/^\/demo-reports\//, "").split("/").map(decodeURIComponent).join("/");
      if (req.method === "GET") return objects.has(key) ? send(200, objects.get(key)!, { etag: etag(key) }) : send(404, "");
      if (req.method === "PUT") {
        const match = req.headers["if-match"];
        if (match !== undefined && match !== etag(key)) return send(412, "");
        objects.set(key, body);
        versions.set(key, (versions.get(key) ?? 0) + 1);
        return send(200, "", { etag: etag(key) });
      }
      if (req.method === "DELETE") {
        deleted.push(key);
        objects.delete(key);
        return send(204, "");
      }
      send(405, "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, objects, deleted, close: () => server.close() };
}

function prune(s: Stand, extra: Record<string, string> = {}): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) =>
    execFile(
      join(root, "node_modules", ".bin", "tsx"),
      [join(root, "scripts", "demo-reports.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DEMO_REPORTS_BUCKET_URL: `${s.url}/demo-reports`,
          DEMO_REPORTS_PREFIX: "demo",
          DEMO_REPORTS_KEEP: "20",
          ...extra,
        },
      },
      (err, _out, stderr) => resolve({ stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    ),
  );
}

/** A bucket the demo wrote: 25 commits the index lists, each with a plan and an apply, and 3 older ones it no longer lists. */
function demoBucket(): Record<string, string> {
  const seed: Record<string, string> = {};
  const rows = range(1, 25).flatMap((n) => [row(n), row(n, "tf-apply")]);
  rows.sort((a, b) => (a.finished < b.finished ? 1 : -1));
  seed[`${DIR}index.json`] = JSON.stringify({ schema: "terragucci.report-index/v1", reports: rows });
  seed[`${DIR}index.html`] = "old";
  seed["demo/index.json"] = JSON.stringify({ schema: "terragucci.report-index/v1", reports: rows.map((r) => ({ ...r, path: `${P}/${r.path}` })) });
  for (const n of [...range(1, 25), 101, 102, 103]) {
    for (const stage of ["tf-plan", "tf-apply-wave-1"]) {
      seed[`${DIR}2026/10/${sha(n)}/${stage}/report.json`] = "{}";
      seed[`${DIR}2026/10/${sha(n)}/${stage}/report.html`] = "";
    }
    seed[`${DIR}runs/${sha(n)}/run.json`] = "{}";
  }
  // Commit 2 is still the inventory's for its root; commit 4 the kiosk's tool page replays.
  seed[`${DIR}inventory.json`] = JSON.stringify({ schema: "terragucci.inventory/v1", roots: [{ root: "other", path: runPath(2, "tf-apply-wave-1"), resources: [] }] });
  seed["demo/cycles/terraform/latest.json"] = JSON.stringify({ schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ commit: sha(4) }], runs: [] });
  seed["demo/demo.json"] = JSON.stringify({ repo: "admin/demo", commit: sha(25) });
  seed[`${DIR}changes.json`] = JSON.stringify({ schema: "terragucci.changes/v1", changes: [range(1, 25).map((n) => ({ path: runPath(n, "tf-apply-wave-1"), address: `a${n}` }))].flat() });
  const entry = (n: number) => JSON.stringify({ schema: "terragucci.audit/v1", id: `sha256:${n}`, kind: "apply", project: P, at: finished(n), who: null, what: "wave-1", digest: null, result: "applied", evidence: { source: "report", bucket: "demo-reports", key: `${DIR}${runPath(n, "tf-apply-wave-1")}/report.json` } });
  const ledger = JSON.stringify({ schema: "terragucci.audit/v1", id: "sha256:l", kind: "approval", project: P, at: OLD, who: "reviewer", what: "wave-2", digest: null, result: "approved", evidence: { source: "ledger", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl", commit: sha(1) } });
  seed["demo/audit.jsonl"] = [ledger, ...range(1, 25).map(entry)].join("\n") + "\n";
  seed["demo/audit.json"] = JSON.stringify({ schema: "terragucci.audit-summary/v1", generated: OLD, record: "audit.jsonl", entries: 26, added: 1, kinds: { apply: 25, approval: 1 }, projects: [] });
  return seed;
}

describe("the ledger entries chant/lifecycle no longer holds", () => {
  const ledger = (id: string, commit: string, when: string, project = P) =>
    JSON.stringify({ schema: "terragucci.audit/v1", id, kind: "approval", project, at: when, who: "reviewer", what: "wave-2", digest: null, result: "approved", evidence: { source: "ledger", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl", commit } });
  const report = JSON.stringify({ schema: "terragucci.audit/v1", id: "sha256:r", kind: "apply", project: P, at: OLD, who: null, what: "wave-1", digest: null, result: "applied", evidence: { source: "report", key: `${DIR}${runPath(12, "tf-apply-wave-1")}/report.json` } });
  const lines = [
    ledger("sha256:held", "aaa", OLD),
    ledger("sha256:old", "bbb", OLD),
    ledger("sha256:new", "ccc", finished(30)),
    ledger("sha256:other", "ddd", OLD, OTHER),
    report,
  ];
  const text = lines.join("\n") + "\n";
  const kept = new Map([[P, new Set([sha(12)])]]);

  it("reads the driver's list of each repo's chant/lifecycle commits, a repo alone holding none", () => {
    const got = readLedgerCommits("admin/demo aaa\nadmin/demo bbb\nadmin/demo-terragrunt\n\n");
    expect([...got.keys()]).toEqual(["admin/demo", "admin/demo-terragrunt"]);
    expect([...got.get("admin/demo")!]).toEqual(["aaa", "bbb"]);
    expect(got.get("admin/demo-terragrunt")!.size).toBe(0);
  });

  it("drops an entry whose commit the branch no longer holds and that is older than the project's oldest kept report, and nothing else", () => {
    const got = pruneAudit(text, kept, { commits: new Map([["admin/demo", new Set(["aaa"])]]), oldest: new Map([[P, Date.parse(finished(10))]]) });
    expect(got?.dropped).toBe(1);
    expect(got?.entries.map((e) => e.id)).toEqual(["sha256:held", "sha256:new", "sha256:other", "sha256:r"]);
  });

  it("keeps every ledger entry of a repo the driver could not read, or of a project the prune did not read", () => {
    expect(pruneAudit(text, kept, { commits: new Map(), oldest: new Map([[P, Date.parse(finished(10))]]) })).toBeNull();
    expect(pruneAudit(text, kept, { commits: new Map([["admin/demo", new Set<string>()]]), oldest: new Map() })).toBeNull();
    // A repo with no branch holds nothing: every entry older than the oldest kept report goes.
    const none = pruneAudit(text, kept, { commits: new Map([["admin/demo", new Set<string>()]]), oldest: new Map([[P, Date.parse(finished(10))]]) });
    expect(none?.entries.map((e) => e.id)).toEqual(["sha256:new", "sha256:other", "sha256:r"]);
  });
});

describe("scripts/demo-reports.ts", () => {
  it("deletes the reports past the newest kept commits and the ones no index lists, after dropping their runs from every document", async () => {
    const s = await stand(demoBucket());
    try {
      const r = await prune(s);
      expect(r.code).toBe(0);
      // Kept: 6..25 (the newest 20), 2 (the inventory's) and 4 (the stored cycle's). Gone: 1, 3, 5 and 101..103.
      const gone = [...new Set(s.deleted.map((k) => /([0-9a-f]{40})/.exec(k)?.[1]))].sort();
      expect(gone).toEqual([1, 3, 5, 101, 102, 103].map(sha).sort());
      expect(s.deleted).toHaveLength(6 * 5);
      for (const n of [2, 4, 6, 25]) expect(s.objects.has(`${DIR}2026/10/${sha(n)}/tf-plan/report.json`)).toBe(true);
      expect(s.objects.has(`${DIR}runs/${sha(1)}/run.json`)).toBe(false);
      expect(s.objects.has(`${DIR}runs/${sha(2)}/run.json`)).toBe(true);

      const own = JSON.parse(s.objects.get(`${DIR}index.json`)!) as ReportIndex;
      expect(new Set(own.reports.map((x) => x.commit))).toEqual(new Set([2, 4, ...range(6, 25)].map(sha)));
      expect(s.objects.get(`${DIR}index.html`)).toContain(`Plan reports: ${P}`);
      const top = JSON.parse(s.objects.get("demo/index.json")!) as ReportIndex;
      expect(top.reports).toHaveLength(own.reports.length);
      expect(s.objects.get("demo/index.html")).toContain("Plan reports");
      const changes = JSON.parse(s.objects.get(`${DIR}changes.json`)!) as { changes: { address: string }[] };
      expect(changes.changes.map((c) => c.address)).not.toContain("a1");
      expect(changes.changes).toHaveLength(22);

      const audit = s.objects.get("demo/audit.jsonl")!.trim().split("\n");
      expect(audit).toHaveLength(23);
      expect(audit[0]).toContain('"sha256:l"');
      expect(JSON.parse(s.objects.get("demo/audit.json")!)).toMatchObject({ entries: 23, kinds: { apply: 22, approval: 1 } });
      expect(s.objects.get("demo/audit.html")).toContain("audit.jsonl");
      expect(r.stderr).toContain(`reports: deleted 30 objects of 6 commits of ${P}`);

      // The next reset: nothing more to delete, and nothing rewritten.
      const before = s.objects.get(`${DIR}index.json`);
      const again = await prune(s);
      expect(again.code).toBe(0);
      expect(s.deleted).toHaveLength(30);
      expect(s.objects.get(`${DIR}index.json`)).toBe(before);
    } finally {
      s.close();
    }
  });

  it("drops the ledger entries the driver's list says chant/lifecycle no longer holds", async () => {
    const s = await stand(demoBucket());
    try {
      const dir = mkdtempSync(join(tmpdir(), "demo-reports-"));
      writeFileSync(join(dir, "lifecycle-commits"), `admin/demo ${sha(999)}\nadmin/demo-terragrunt\n`);
      const r = await prune(s, { DEMO_REPORTS_LEDGER: join(dir, "lifecycle-commits") });
      expect(r.code).toBe(0);
      const audit = s.objects.get("demo/audit.jsonl")!.trim().split("\n");
      // The 22 report entries of kept runs; the approval of a commit the branch lost, older than every kept report, went.
      expect(audit).toHaveLength(22);
      expect(audit.join("\n")).not.toContain('"sha256:l"');
      expect(JSON.parse(s.objects.get("demo/audit.json")!)).toMatchObject({ entries: 22, kinds: { apply: 22 } });
    } finally {
      s.close();
    }
  });

  it("deletes nothing and writes nothing when the bucket cannot be listed, and says so", async () => {
    const seed = demoBucket();
    const s = await stand(seed, { listDown: true });
    try {
      const r = await prune(s);
      expect(r.code).toBe(1);
      expect(s.deleted).toEqual([]);
      expect(s.objects.get(`${DIR}index.json`)).toBe(seed[`${DIR}index.json`]);
      expect(s.objects.get("demo/audit.jsonl")).toBe(seed["demo/audit.jsonl"]);
    } finally {
      s.close();
    }
  });
});

describe("stack/demo.sh", () => {
  it("prunes the reports at a reset whose prune is due, after the pull requests, once the estate page is done, and never fails the reset on it", () => {
    const demo = readFileSync(join(root, "stack", "demo.sh"), "utf8");
    const work = demo.slice(demo.indexOf("\nreset_work() {"), demo.indexOf("\nreset_written() {"));
    expect(work.match(/reports_prune/g)).toHaveLength(2);
    expect(work.lastIndexOf("reports_prune")).toBeGreaterThan(work.lastIndexOf("pulls_prune"));
    // In the branch that waits for the push back's run, the prune comes after it ended.
    expect(work.indexOf("reports_prune")).toBeGreaterThan(work.indexOf('run_ended "$LIMIT_RUN"'));
    const fn = demo.slice(demo.indexOf("\nreports_prune() {"), demo.indexOf("\n}\n", demo.indexOf("\nreports_prune() {")));
    expect(fn).toContain("estate_wait");
    expect(fn).toContain("scripts/demo-reports.ts) \\\n    || log");
    expect(fn).toContain('DEMO_REPORTS_KEEP="$REPORTS_KEEP"');
    expect(demo).toMatch(/^REPORTS_KEEP="\$\{DEMO_REPORTS_KEEP:-50\}"/m);
    expect(fn).toContain('DEMO_REPORTS_LEDGER="$held"');
    expect(fn.indexOf("lifecycle_commits >")).toBeGreaterThan(fn.indexOf("estate_wait"));
  });

  it("puts each repo's chant/lifecycle back to its base as a cycle starts, before the scenario, and never fails the cycle on it", () => {
    const demo = readFileSync(join(root, "stack", "demo.sh"), "utf8");
    const cycle = demo.slice(demo.indexOf("\nrun_cycle() {"), demo.indexOf('case "$SCENARIO" in', demo.indexOf("\nrun_cycle() {")));
    expect(cycle).toContain("lifecycle_back");
    const fn = demo.slice(demo.indexOf("\nlifecycle_back() {"), demo.indexOf("\n}\n", demo.indexOf("\nlifecycle_back() {")));
    expect(fn).toContain('remote_head "$REPO" chant/lifecycle');
    expect(fn).toContain('git push -q "$REMOTE" ":refs/heads/chant/lifecycle"');
    expect(fn).toContain("|| log");
    expect(fn).toContain("return 0");
  });
});
