import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { describeQuery, query, QUERY_TABLES, runQuery, type QueryOptions } from "../src/query";
import type { ObjectStore } from "../src/report/object-store";
import { changesKey, edgesKey, inventoryKey } from "../src/report/store";

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

  it("loads the inventory, changes, audit trail and state edges", async () => {
    const { store } = bucket();
    const r = await query({}, "SELECT 1", opts(store));
    expect(r.tables).toEqual({ inventory: 2, changes: 5, history: 5, audit: 4, edges: 1 });
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
    const data = { inventory: [], changes: [], history: [], audit: [], edges: [] };
    for (const sql of ["DELETE FROM history", "  -- a comment\n INSERT INTO audit (id) VALUES ('x')", "ATTACH DATABASE '/tmp/x.db' AS x", "PRAGMA query_only = OFF", "DROP TABLE history"]) {
      await expect(runQuery(sql, data)).rejects.toThrow(/runs one SELECT/);
    }
    await expect(runQuery("WITH x AS (SELECT 1) INSERT INTO audit (id) SELECT * FROM x", data)).rejects.toThrow(/does not run: .*readonly|does not run/);
    await expect(runQuery("/* c */ VALUES (1)", data)).resolves.toMatchObject({ rows: [{ column1: 1 }] });
  });

  it("says why a statement does not run", async () => {
    const data = { inventory: [], changes: [], history: [], audit: [], edges: [] };
    await expect(runQuery("SELECT * FROM states", data)).rejects.toThrow(new ConfigError("the query does not run: no such table: states"));
    await expect(runQuery("SELECT commit FROM history", data)).rejects.toThrow('quote the column: "commit"');
    await expect(runQuery('SELECT "commit" FROM history', data)).resolves.toMatchObject({ columns: ["commit"] });
    await expect(query({}, "  ", {})).rejects.toThrow(/needs a statement/);
  });

  it("refuses without a reports bucket", async () => {
    await expect(query({}, "SELECT 1", { env: {} })).rejects.toThrow(/query reads the reports bucket/);
  });

  it("prints an aligned table and a count", async () => {
    expect(describeQuery({ columns: ["address", "approver"], rows: [{ address: "aws_sqs_queue.jobs", approver: "bo" }, { address: "aws_sqs_queue.x", approver: null }], tables: { inventory: 0, changes: 0, history: 0, audit: 0, edges: 0 } })).toBe(
      ["address             approver", "------------------  --------", "aws_sqs_queue.jobs  bo", "aws_sqs_queue.x", "(2 rows)"].join("\n"),
    );
  });
});
