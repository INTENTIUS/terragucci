import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { describeQuery, describeTable, isSql, query, QUERY_TABLES, readTable, runQuery, type QueryOptions } from "../src/query";
import type { ObjectStore } from "../src/report/object-store";
import { changesKey, edgesKey, inventoryKey, versionsKey } from "../src/report/store";

const PREFIX = "tg";
const PROJECT = "github.com/acme/infra";
const OTHER = "github.com/acme/shop";

function memoryStore(objects: Map<string, string>): ObjectStore & { puts: number } {
  const s = {
    location: "s3://reports",
    puts: 0,
    async put() {
      s.puts++;
      return {};
    },
    async read(key: string) {
      return { body: objects.get(key) };
    },
    async get(key: string) {
      return objects.get(key);
    },
    async presign(key: string) {
      return { url: `https://signed/${key}`, expires: new Date(0) };
    },
  };
  return s;
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86400_000).toISOString();
const path = (c: string, wave = 1): string => `2026/10/${c.slice(0, 7)}/tf-apply-wave-${wave}`;

/** A change row of changes.json. */
function change(address: string, type: string, actions: string[], finished: string, commit: string, extra: Record<string, unknown> = {}) {
  return { address, type, actions, attributes: actions.includes("update") ? ["visibility_timeout_seconds"] : [], root: "app", commit, wave: 1, finished, path: path(commit), plan_digest: `sha256:p${commit[0]}`, set_digest: `sha256:s${commit[0]}`, ...extra };
}

/** The apply entry of audit.jsonl for a wave, naming the approver it applied under. */
function applyEntry(project: string, commit: string, finished: string, who: string | null) {
  return { schema: "terragucci.audit/v1", id: `sha256:apply-${commit[0]}`, kind: "apply", project, at: finished, who, what: "wave-1", digest: `sha256:s${commit[0]}`, result: "applied", evidence: { source: "report", bucket: "reports", key: `${PREFIX}/${project}/${path(commit)}/report.json` }, detail: { approval: `sha256:approval-${commit[0]}` } };
}

/**
 * Two projects. In acme/infra a queue was created 20 days ago (approved by
 * ana), updated 3 days ago (approved by bo) and updated again a day ago with
 * no gate; a terraform_data changed beside it. acme/shop created a queue 2
 * days ago, approved by cy.
 */
function bucket(withAudit = true): { store: ReturnType<typeof memoryStore>; objects: Map<string, string> } {
  const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), d = "d".repeat(40);
  const objects = new Map<string, string>();
  const row = (project: string, commit: string, finished: string) => ({ project, commit, stage: "tf-apply", wave: 1, finished, path: `${project}/${path(commit)}`, roots: 1, groups: 1, totals: { create: 0, update: 0, replace: 0, delete: 0 }, refused: 0, destroys: [] });
  objects.set(`${PREFIX}/index.json`, JSON.stringify({ schema: "terragucci.report-index/v1", reports: [row(PROJECT, c, daysAgo(1)), row(OTHER, d, daysAgo(2))] }));
  objects.set(
    changesKey(PROJECT, PREFIX),
    JSON.stringify({
      schema: "terragucci.changes/v1",
      changes: [
        change("aws_sqs_queue.jobs", "aws_sqs_queue", ["update"], daysAgo(1), c),
        change("aws_sqs_queue.jobs", "aws_sqs_queue", ["update"], daysAgo(3), b),
        change("terraform_data.app", "terraform_data", ["update"], daysAgo(3), b),
        change("aws_sqs_queue.jobs", "aws_sqs_queue", ["create"], daysAgo(20), a),
      ],
    }),
  );
  objects.set(changesKey(OTHER, PREFIX), JSON.stringify({ schema: "terragucci.changes/v1", changes: [change("aws_sqs_queue.orders", "aws_sqs_queue", ["create"], daysAgo(2), d)] }));
  objects.set(
    inventoryKey(PROJECT, PREFIX),
    JSON.stringify({ schema: "terragucci.inventory/v1", roots: [{ root: "app", commit: c, finished: daysAgo(1), wave: 1, path: path(c), resources: [{ address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", provider: "registry.opentofu.org/hashicorp/aws" }, { address: "terraform_data.app", type: "terraform_data", provider: "terraform.io/builtin/terraform" }] }] }),
  );
  const versions = (aws: string, vpc: string) => ({ binary: { name: "tofu", version: "1.10.6", pin: ".opentofu-version" }, providers: [{ provider: "registry.opentofu.org/hashicorp/aws", version: aws }], modules: [{ call: "module.vpc", source: "registry.opentofu.org/acme/vpc/aws", version: vpc }] });
  objects.set(versionsKey(PROJECT, PREFIX), JSON.stringify({ schema: "terragucci.versions/v1", roots: [{ root: "app", commit: c, finished: daysAgo(1), wave: 1, path: path(c), ...versions("5.80.0", "1.2.0") }] }));
  objects.set(versionsKey(OTHER, PREFIX), JSON.stringify({ schema: "terragucci.versions/v1", roots: [{ root: "shop", commit: d, finished: daysAgo(2), wave: 1, path: path(d), ...versions("5.70.0", "1.2.0") }] }));
  objects.set(edgesKey(PROJECT, PREFIX), JSON.stringify({ schema: "terragucci.state-edges/v1", roots: [{ root: "app", reads: [{ root: "network", via: "terraform_remote_state" }], reads_seen: daysAgo(1) }, { root: "network", reads: [] }] }));
  if (withAudit) {
    objects.set(
      `${PREFIX}/audit.jsonl`,
      [applyEntry(PROJECT, a, daysAgo(20), "ana"), applyEntry(PROJECT, b, daysAgo(3), "bo"), applyEntry(PROJECT, c, daysAgo(1), null), applyEntry(OTHER, d, daysAgo(2), "cy")].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
  return { store: memoryStore(objects), objects };
}

const opts = (store: ObjectStore): QueryOptions => ({ reports: { bucket: "s3://reports", prefix: PREFIX }, store: () => store });

const SQS_LAST_WEEK = `
  SELECT project, address, actions, approver FROM history
  WHERE type = 'aws_sqs_queue' AND julianday(finished) >= julianday('now', '-7 days')
  ORDER BY finished`;

describe("terragucci query", () => {
  it("lists the queues changed in the last 7 days with their approvers, from the audit trail", async () => {
    const { store } = bucket();
    const r = await query({}, SQS_LAST_WEEK, opts(store));
    expect(r.columns).toEqual(["project", "address", "actions", "approver"]);
    expect(r.rows).toEqual([
      { project: PROJECT, address: "aws_sqs_queue.jobs", actions: "update", approver: "bo" },
      { project: OTHER, address: "aws_sqs_queue.orders", actions: "create", approver: "cy" },
      { project: PROJECT, address: "aws_sqs_queue.jobs", actions: "update", approver: null },
    ]);
    expect(store.puts).toBe(0);
  });

  it("leaves the approver empty when there is no audit trail", async () => {
    const { store } = bucket(false);
    const r = await query({}, "SELECT approver, count(*) AS n FROM history GROUP BY approver", opts(store));
    expect(r.rows).toEqual([{ approver: null, n: 5 }]);
    expect(r.tables.audit).toBe(0);
  });

  it("loads the inventory, versions, changes, audit trail and state edges", async () => {
    const { store } = bucket();
    const r = await query({}, "SELECT 1", opts(store));
    expect(r.tables).toEqual({ inventory: 2, versions: 6, changes: 5, history: 5, audit: 4, edges: 1 });
    // Which roots run which version of a provider across the estate.
    const aws = await query({}, "SELECT version, count(*) AS roots FROM versions WHERE kind = 'provider' AND name LIKE '%/hashicorp/aws' GROUP BY version ORDER BY version", opts(store));
    expect(aws.rows).toEqual([{ version: "5.70.0", roots: 1 }, { version: "5.80.0", roots: 1 }]);
    const vpc = await query({}, "SELECT project, root, call, version, wave FROM versions WHERE kind = 'module' ORDER BY project", opts(store));
    expect(vpc.rows).toEqual([
      { project: PROJECT, root: "app", call: "module.vpc", version: "1.2.0", wave: 1 },
      { project: OTHER, root: "shop", call: "module.vpc", version: "1.2.0", wave: 1 },
    ]);
    const bin = await query({}, "SELECT DISTINCT name, version FROM versions WHERE kind = 'binary'", opts(store));
    expect(bin.rows).toEqual([{ name: "tofu", version: "1.10.6" }]);
    const inv = await query({}, "SELECT type, provider, wave FROM inventory ORDER BY address", opts(store));
    expect(inv.rows[0]).toEqual({ type: "aws_sqs_queue", provider: "registry.opentofu.org/hashicorp/aws", wave: 1 });
    const edges = await query({}, "SELECT root, reads, via FROM edges", opts(store));
    expect(edges.rows).toEqual([{ root: "app", reads: "network", via: "terraform_remote_state" }]);
    const attrs = await query({}, "SELECT DISTINCT j.value AS name FROM changes, json_each(changes.attributes) AS j", opts(store));
    expect(attrs.rows).toEqual([{ name: "visibility_timeout_seconds" }]);
    const audit = await query({}, "SELECT json_extract(detail, '$.approval') AS approval FROM audit WHERE who = 'ana'", opts(store));
    expect(audit.rows).toEqual([{ approval: "sha256:approval-a" }]);
  });

  it("gives every table the columns it documents", async () => {
    const { store } = bucket();
    for (const [table, cols] of Object.entries(QUERY_TABLES)) {
      const r = await query({}, `SELECT * FROM ${table} WHERE 0`, opts(store));
      expect(r.columns).toEqual([...cols]);
    }
  });

  it("runs only a statement that reads", async () => {
    const data = { inventory: [], versions: [], changes: [], history: [], audit: [], edges: [] };
    for (const sql of ["DELETE FROM history", "  -- a comment\n INSERT INTO audit (id) VALUES ('x')", "ATTACH DATABASE '/tmp/x.db' AS x", "PRAGMA query_only = OFF", "DROP TABLE history"]) {
      await expect(runQuery(sql, data)).rejects.toThrow(/runs one SELECT/);
    }
    await expect(runQuery("WITH x AS (SELECT 1) INSERT INTO audit (id) SELECT * FROM x", data)).rejects.toThrow(/does not run: .*readonly|does not run/);
    await expect(runQuery("/* c */ VALUES (1)", data)).resolves.toMatchObject({ rows: [{ column1: 1 }] });
  });

  it("says why a statement does not run", async () => {
    const data = { inventory: [], versions: [], changes: [], history: [], audit: [], edges: [] };
    await expect(runQuery("SELECT * FROM states", data)).rejects.toThrow(new ConfigError("the query does not run: no such table: states"));
    await expect(runQuery("SELECT commit FROM history", data)).rejects.toThrow('quote the column: "commit"');
    await expect(runQuery('SELECT "commit" FROM history', data)).resolves.toMatchObject({ columns: ["commit"] });
    await expect(query({}, "  ", {})).rejects.toThrow(/needs a statement/);
  });

  it("refuses without a reports bucket", async () => {
    await expect(query({}, "SELECT 1", { env: {} })).rejects.toThrow(/query reads the reports bucket/);
  });

  it("prints an aligned table and a count", async () => {
    expect(describeQuery({ columns: ["address", "approver"], rows: [{ address: "aws_sqs_queue.jobs", approver: "bo" }, { address: "aws_sqs_queue.x", approver: null }], tables: { inventory: 0, versions: 0, changes: 0, history: 0, audit: 0, edges: 0 } })).toBe(
      ["address             approver", "------------------  --------", "aws_sqs_queue.jobs  bo", "aws_sqs_queue.x", "(2 rows)"].join("\n"),
    );
  });
});

describe("terragucci query <table> over the reports bucket", () => {
  it("filters a table with --where and --since, with no SQL", async () => {
    const { store } = bucket();
    const r = await readTable({}, "history", { ...opts(store), where: ["type=aws_sqs_queue"], since: "7d" });
    expect(r.source).toBe("bucket");
    expect(r.total).toBe(5);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map((x) => [x.project, x.actions, x.approver])).toEqual(expect.arrayContaining([
      [OTHER, "create", "cy"],
      [PROJECT, "update", "bo"],
      [PROJECT, "update", null],
    ]));
    expect(new Set(r.rows.map((x) => x.approver))).toEqual(new Set(["bo", null, "cy"]));
    expect(store.puts).toBe(0);
  });

  it("filters on a number, a key under JSON and a substring, and prints JSON parsed", async () => {
    const { store } = bucket();
    const mods = await readTable({}, "versions", { ...opts(store), where: ["kind=module", "wave>=1", "name~/acme/vpc"] });
    expect(mods.rows.map((x) => x.root).sort()).toEqual(["app", "shop"]);
    const ana = await readTable({}, "audit", { ...opts(store), where: ["detail.approval=sha256:approval-a"] });
    expect(ana.rows).toHaveLength(1);
    expect(ana.rows[0]).toMatchObject({ who: "ana", detail: { approval: "sha256:approval-a" } });
    const attrs = await readTable({}, "changes", { ...opts(store), where: ["attributes~visibility_timeout_seconds"] });
    expect(attrs.rows[0].attributes).toEqual(["visibility_timeout_seconds"]);
    expect(attrs.columns).toEqual([...QUERY_TABLES.changes]);
  });

  it("refuses an unknown table, a bad filter, --since on edges and --at on the bucket", async () => {
    const { store } = bucket();
    await expect(readTable({}, "states", opts(store))).rejects.toThrow(/no table "states"; the tables are resources, .*gates.*, inventory/);
    await expect(readTable({}, "history", { ...opts(store), where: ["nope=1"] })).rejects.toThrow(/^filter-invalid: /);
    await expect(readTable({}, "edges", { ...opts(store), since: "1d" })).rejects.toThrow(/edges has no time column/);
    await expect(readTable({}, "inventory", { ...opts(store), at: "HEAD" })).rejects.toThrow(/no revisions/);
  });

  it("tells the SQL form from a table name", () => {
    expect(isSql("SELECT * FROM inventory")).toBe(true);
    expect(isSql("  with x as (select 1) select * from x")).toBe(true);
    expect(isSql("gates")).toBe(false);
    expect(isSql("inventory")).toBe(false);
  });
});

// The waves' gates are chant's ledger on chant/lifecycle, so chant's ledger read (chant ledger gates) reads them, with no table of terragucci's.
describe("the waves' gates through chant's ledger read", () => {
  function lifecycle(): { repo: string; git: (...a: string[]) => string } {
    const repo = mkdtempSync(join(tmpdir(), "tg-query-gates-"));
    const git = (...a: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf-8" });
    git("init", "-q", "-b", "chant/lifecycle");
    mkdirSync(join(repo, "_gates"));
    return { repo, git };
  }
  const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: "2026-10-09T05:00:00.000Z", expiresAt: "2026-10-10T05:00:00.000Z", planDigest: "sha256:aa" };
  const approval = { version: 1, op: "tf-apply", gate: "wave-1", timestamp: "2026-10-09T05:10:00.000Z", resolvedBy: "approver-one", planDigest: "sha256:aa" };

  it("reads a wave's pending fact and its approval from _gates/tf-apply.jsonl, filtered on op", async () => {
    const { repo, git } = lifecycle();
    writeFileSync(join(repo, "_gates", "tf-apply.jsonl"), `${JSON.stringify(pending)}\n${JSON.stringify(approval)}\n`);
    writeFileSync(join(repo, "_gates", "other.jsonl"), `${JSON.stringify({ ...pending, op: "other" })}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "gates");
    const r = await readTable({}, "gates", { cwd: repo, where: ["op=tf-apply"] });
    expect(r).toMatchObject({ source: "ledger", $schema: "https://intentius.io/chant/schemas/workspace/ledger/v1/ledger.schema.json", table: "gates", total: 3, at: null });
    expect(r.rows.map((x) => ({ op: x.op, gate: x.gate, kind: x.kind, resolved_by: x.resolved_by, plan_digest: x.plan_digest }))).toEqual([
      { op: "tf-apply", gate: "wave-1", kind: "pending", resolved_by: null, plan_digest: "sha256:aa" },
      { op: "tf-apply", gate: "wave-1", kind: "resolution", resolved_by: "approver-one", plan_digest: "sha256:aa" },
    ]);
    expect(describeTable(r).split("\n").at(-1)).toBe("(2 of 3 rows)");
  });

  it("reads the gates as an earlier commit held them with --at, and refuses a revision that names none", async () => {
    const { repo, git } = lifecycle();
    writeFileSync(join(repo, "_gates", "tf-apply.jsonl"), `${JSON.stringify(pending)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "pending");
    writeFileSync(join(repo, "_gates", "tf-apply.jsonl"), `${JSON.stringify(pending)}\n${JSON.stringify(approval)}\n`);
    git("commit", "-q", "-am", "approved");
    const before = await readTable({}, "gates", { cwd: repo, at: "chant/lifecycle~1" });
    expect(before.rows.map((x) => x.kind)).toEqual(["pending"]);
    expect(before.at).toBe("chant/lifecycle~1");
    await expect(readTable({}, "gates", { cwd: repo, at: "nope" })).rejects.toThrow(/^revision-unknown: /);
    await expect(readTable({}, "gates", { cwd: repo, where: ["nope=1"] })).rejects.toThrow(/^filter-invalid: /);
  });
});
