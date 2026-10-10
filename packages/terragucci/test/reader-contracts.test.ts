/**
 * The reader contracts: the JSON Schemas the package ships for index.json,
 * estate.json, dora.json and audit.jsonl, held to what the writers put in a bucket.
 * The objects are the ones uploadReport, terragucci estate and the audit
 * record write, never hand-made rows, and between them they carry every
 * field each schema names, so a field added to a writer and not to its
 * schema fails here, and so does a schema field no writer writes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { updateList } from "../src/ephemeral";
import { appendEntries, APPLY_LEDGER, AUDIT_SCHEMA, ledgerEntries, OVERRIDE_LEDGER_FILE, readRecord, reportEntry, type LedgerChange } from "../src/report/audit";
import { buildReport } from "../src/report/build";
import { ESTATE_SCHEMA } from "../src/report/estate";
import { CHANGES_SCHEMA, HISTORY_SCHEMA } from "../src/report/history";
import { DORA_SCHEMA } from "../src/report/dora";
import { INVENTORY_SCHEMA } from "../src/report/inventory";
import { STATES_SCHEMA } from "../src/report/state-versions";
import { RUN_SCHEMA, runSkeleton, withWave } from "../src/report/run-view";
import { EDGES_SCHEMA } from "../src/report/state-edges";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report } from "../src/report/schema";
import { copyToRun, INDEX_DESTROYS, INDEX_SCHEMA, runPath, uploadReport, VIEWS_DIR, writeReportDir } from "../src/report/store";
import { unknownKeywords, validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN, smallFixture } from "./report-fixtures";
import { tmp } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const INDEX = schema("report-index.schema.json");
const ESTATE = schema("estate.schema.json");
const AUDIT = schema("audit.schema.json");
const INVENTORY = schema("inventory.schema.json");
const STATES = schema("state-versions.schema.json");
const EDGES = schema("state-edges.schema.json");
const CHANGES = schema("changes.schema.json");
const HISTORY = schema("history.schema.json");
const DORA = schema("dora.schema.json");
const RUN_VIEW = schema("run.schema.json");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const WEB = "github.com/acme/web";
const NET = "gitlab.example.com/platform/network";
const LINKS = { commit_url: "https://forge/c", pull_request: "7", pull_request_url: "https://forge/pr/7", trace_id: "abc123", trace_url: "https://traces/abc123" };

/** A bucket in memory, keyed `<bucket>:<key>`, that refuses every request to `locked`. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const [, name, ...rest] = new URL(url).pathname.split("/");
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    if (name === "locked") return { ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" };
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  const s3 = new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch);
  return { objects, fetch, s3 };
}

const at = (h: number, m = 0): string => `2026-10-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

/** Runs of two projects: plans with every link and more destroys than a row lists, a drift, apply waves approved, waiting and under an override. */
function runs(): Report[] {
  const many = plan(Array.from({ length: INDEX_DESTROYS + 3 }, (_, i) => rc(`aws_s3_object.o${i}`, ["delete"], { key: `o${i}` }, null)));
  const override = { by: "alice", at: at(9), rules: ["main.deny"], reason: "why", plan_digest: "jcs1-sha256:aa", digest: "sha256:bb", sealed: false };
  const created = plan([rc("aws_s3_bucket.logs", ["create"], null, { bucket: "logs" })], {
    planned_values: { root_module: { resources: [{ address: "aws_s3_bucket.logs", mode: "managed", type: "aws_s3_bucket", name: "logs", provider_name: "registry.opentofu.org/hashicorp/aws", values: { bucket: "logs" } }] } },
  });
  const b = "b".repeat(40);
  return [
    buildReport({ run: { ...RUN, project: WEB, ...LINKS, finished: at(11) }, roots: [...smallFixture(), { path: "envs/big", planner: "tofu", plan: many }], waves: [{ number: 1, roots: ["envs/big"] }] }),
    buildReport({ run: { ...RUN, project: WEB, stage: "tf-drift", finished: at(4, 17) }, roots: smallFixture().slice(0, 2) }),
    // The next check finds none: its row names the drift it cleared.
    buildReport({ run: { ...RUN, project: WEB, commit: "f".repeat(40), stage: "tf-drift", finished: at(5, 17) }, roots: [{ path: "envs/dev/orders", planner: "tofu", plan: plan([]) }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 1, finished: at(8, 55) }, roots: [{ path: "a", plan: created, applied: true, state: { backend: "s3", location: "s3://state/a.tfstate", version_id: "v1", versioning: "on", note: "n" }, policy: { result: "denied", denials: ["no"], rules: ["main.deny"], warnings: [], override } }], waves: [{ number: 1, roots: ["a"], approval: "not-required" }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 2, finished: at(10) }, roots: smallFixture().slice(0, 2), waves: [{ number: 2, roots: ["envs/dev/orders", "envs/dev/search"], approval: "waiting", waitingSince: at(9) }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 3, finished: at(10, 30) }, roots: smallFixture().slice(0, 1), waves: [{ number: 3, roots: ["envs/dev/orders"], approval: "approved" }] }),
    // A share of a wave split across jobs (waves.jobs).
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 4, share: 2, finished: at(10, 40) }, roots: smallFixture().slice(1, 2), waves: [{ number: 4, roots: ["envs/dev/search"], approval: "approved" }] }),
    // b reads a's state: a plan of the default branch finds the edge, and a pull request plans b after a applied.
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-drift", finished: at(9) }, roots: [{ path: "b", planner: "tofu", plan: plan([]), reads: [{ upstream: "a", data: "a", outputs: "applied" }] }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, finished: at(9, 10) }, roots: [{ path: "b", planner: "tofu", plan: plan([]), reads: [{ upstream: "a", data: "a", outputs: "applied" }] }] }),
    buildReport({ run: { ...RUN, project: NET, ...LINKS, finished: at(9, 30) }, roots: [{ path: "b", planner: "tofu", plan: plan([]), reads: [{ upstream: "a", data: "a", outputs: "applied" }] }] }),
  ];
}

/** Each run written as a job writes it, then copied to the bucket under `reports`. */
async function upload(s3: S3Client, reports: Report[]): Promise<void> {
  for (const r of reports) {
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    await uploadReport(s3, dir, r, "reports", async () => {});
  }
}

/** Every property name an object (and the objects under it, at `path`) carries. */
const keys = (objects: Json[]): Set<string> => new Set(objects.flatMap((o) => Object.keys(o)));
const named = (s: Json): string[] => Object.keys(s.properties ?? {});

describe("the reader contracts' schemas", () => {
  it("use only the keywords the check reads, and name the schema id the writer puts in `schema`", () => {
    for (const [s, id] of [[INDEX, INDEX_SCHEMA], [ESTATE, ESTATE_SCHEMA], [AUDIT, AUDIT_SCHEMA], [INVENTORY, INVENTORY_SCHEMA], [CHANGES, CHANGES_SCHEMA], [HISTORY, HISTORY_SCHEMA], [DORA, DORA_SCHEMA], [STATES, STATES_SCHEMA], [RUN_VIEW, RUN_SCHEMA], [EDGES, EDGES_SCHEMA]] as const) {
      expect(unknownKeywords(s)).toEqual([]);
      expect(s.title).toBe(id);
      expect(s.properties.schema.const).toBe(id);
    }
    expect(unknownKeywords(schema("report.schema.json"))).toEqual([]);
  });

  it("ship beside report.schema.json: the build copies each one into dist, which the package publishes", () => {
    const shipped = readdirSync(SRC).filter((f) => f.endsWith(".schema.json")).sort();
    expect(shipped).toEqual(["audit.schema.json", "changes.schema.json", "dora.schema.json", "estate.schema.json", "history.schema.json", "inventory.schema.json", "report-index.schema.json", "report.schema.json", "run.schema.json", "state-edges.schema.json", "state-versions.schema.json"]);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"));
    expect(pkg.files).toContain("dist");
    const build = readFileSync(join(import.meta.dirname, "../../../scripts/build-cli.mjs"), "utf-8");
    for (const f of shipped) expect(build).toContain(`"${f}"`);
  });
});

describe("run.json", () => {
  it("is what the waves' jobs write, and between them they carry every field the schema names", () => {
    const states = new Map([
      ["net", { state: { bucket: "state", key: "net.tfstate" }, external: [] }],
      ["app", { state: { key: "app.tfstate" }, external: [{ data: "dns", bucket: "other", key: "dns.tfstate" }] }],
    ]);
    const skeleton = runSkeleton(WEB, "c0ffee", [["net"], ["app", "web"]], new Map([["app", new Set(["net"])]]), states);
    const spans = [{ phase: "plan" as const, start: at(1), end: at(1, 2) }, { phase: "gate" as const, start: at(1, 2) }, { phase: "apply" as const, start: at(1, 30), share: 1 }];
    let v = withWave(undefined, skeleton, { number: 1, state: "applied", gate: "wave-1", policy: "always", approval: "approved", digest: "d1", report: "2026/10/c0ffee/tf-apply-wave-1", changed: ["net"], spans }, at(1));
    v = withWave(JSON.stringify(v), skeleton, { number: 2, state: "waiting", approval: "waiting", digest: "d2", command: "terragucci approve wave-2 --plan d2", shares: 2 }, at(2));
    v = withWave(JSON.stringify(v), skeleton, { number: 2, shares_applied: [1] }, at(3));
    const progress = { read: at(1, 31), resources: [{ root: "net", address: "terraform_data.a", action: "create" as const, status: "done" as const, done_at: at(1, 31) }, { root: "net", address: "terraform_data.b", action: "update" as const, status: "in-flight" as const }] };
    v = withWave(JSON.stringify(v), skeleton, { number: 1, progress }, at(3));
    expect(validate(RUN_VIEW, v)).toEqual([]);
    expect([...keys([v as unknown as Json])].sort()).toEqual(named(RUN_VIEW).sort());
    expect([...keys(v.roots as unknown as Json[])].sort()).toEqual(named(RUN_VIEW.properties.roots.items).sort());
    expect([...keys(v.waves as unknown as Json[])].sort()).toEqual(named(RUN_VIEW.properties.waves.items).sort());
    expect([...keys(v.waves.flatMap((w) => w.spans ?? []) as unknown as Json[])].sort()).toEqual(named(RUN_VIEW.properties.waves.items.properties.spans.items).sort());
    expect([...keys(v.waves.flatMap((w) => (w.progress ? [w.progress] : [])) as unknown as Json[])].sort()).toEqual(named(RUN_VIEW.properties.waves.items.properties.progress).sort());
    expect([...keys(v.waves.flatMap((w) => w.progress?.resources ?? []) as unknown as Json[])].sort()).toEqual(named(RUN_VIEW.properties.waves.items.properties.progress.properties.resources.items).sort());
    expect([...keys(v.roots.flatMap((r) => [r.state, ...(r.external ?? [])]).filter(Boolean) as unknown as Json[])].sort()).toEqual(["bucket", "data", "key"]);
    expect(validate(RUN_VIEW, { ...v, waves: [{ ...v.waves[0], spans: [{ phase: "wait", start: at(1) }] }] })).toEqual(['$.waves[0].spans[0].phase: "wait" not in enum']);
  });
});

describe("the bucket layout", () => {
  it("keeps <prefix>/views/ for viewers: a project named views is refused before anything is written", async () => {
    const { objects, s3 } = bucket();
    const r = buildReport({ run: { ...RUN, project: `${VIEWS_DIR}/x` }, roots: smallFixture().slice(0, 1) });
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    await expect(uploadReport(s3, dir, r, "reports")).rejects.toThrow("project views/x would write under reports/views/, which is kept for viewers");
    await expect(copyToRun(s3, dir, r, ["report.json"], "reports")).rejects.toThrow(/kept for viewers/);
    expect([...objects.keys()]).toEqual([]);
    // A project whose path only contains the word is not refused.
    await upload(s3, [buildReport({ run: { ...RUN, project: "github.com/acme/views" }, roots: smallFixture().slice(0, 1) })]);
    expect([...objects.keys()].some((k) => k.startsWith("acme-reports:reports/github.com/acme/views/2026/"))).toBe(true);
    expect([...objects.keys()].some((k) => k.startsWith("acme-reports:reports/views/"))).toBe(false);
  });
});

describe("terragucci.report-index/v1", () => {
  it("holds both index.json files uploads write, and every row field is one some upload writes", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs());
    const files = ["acme-reports:reports/index.json", `acme-reports:reports/${WEB}/index.json`, `acme-reports:reports/${NET}/index.json`];
    const rows: Json[] = [];
    for (const f of files) {
      const index = JSON.parse(objects.get(f)!);
      expect(validate(INDEX, index), f).toEqual([]);
      rows.push(...index.reports);
    }
    expect([...keys(rows)].sort()).toEqual(named(INDEX.$defs.row).sort());
  });

  it("refuses a row with a field it does not name, without a field it needs, or with a stage it does not know", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs().slice(0, 1));
    const index = JSON.parse(objects.get("acme-reports:reports/index.json")!);
    const row = index.reports[0];
    expect(validate(INDEX, { ...index, reports: [{ ...row, surprise: 1 }] })).toEqual(["$.reports[0]: surprise is not in the schema"]);
    const { path: _path, ...noPath } = row;
    expect(validate(INDEX, { ...index, reports: [noPath] })).toEqual(["$.reports[0]: missing path"]);
    expect(validate(INDEX, { ...index, reports: [{ ...row, stage: "tf-destroy" }] })).toEqual(['$.reports[0].stage: "tf-destroy" not in enum']);
    expect(validate(INDEX, { ...index, schema: "terragucci.report-index/v2" })).toEqual(['$.schema: not "terragucci.report-index/v1"']);
  });
});

describe("terragucci.estate/v1", () => {
  it("holds the estate.json terragucci estate writes, with projects ok, unreadable and with no index, and the audit link", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, runs());
    objects.set("acme-reports:reports/audit.json", JSON.stringify({ schema: "terragucci.audit-summary/v1", generated: at(11, 30), entries: 3 }));
    // The run view of the network project's applied commit, as its waves' jobs write it.
    const netSkeleton = runSkeleton(NET, "b".repeat(40), [["a"], ["envs/dev/orders", "envs/dev/search"]], new Map([["envs/dev/orders", new Set(["a"])]]));
    const applied = withWave(undefined, netSkeleton, { number: 1, state: "applied" }, at(10, 40));
    // Its second wave is a choudoufu wave still applying, its resources followed.
    const view = withWave(JSON.stringify(applied), netSkeleton, { number: 2, state: "applying", progress: { read: at(10, 45), resources: [{ root: "envs/dev/orders", address: "terraform_data.a", action: "create", status: "done", done_at: at(10, 44) }, { root: "envs/dev/orders", address: "terraform_data.b", action: "create", status: "waiting" }] } }, at(10, 45));
    objects.set(`acme-reports:reports/${NET}/runs/${"b".repeat(40)}/run.json`, JSON.stringify(view));
    // A pull request's ephemeral copy, as its job lists it beside the index.
    objects.set(`acme-reports:reports/${WEB}/ephemeral.json`, JSON.stringify(updateList(undefined, WEB, 12, { pull_request: 12, pull_request_url: "https://github.com/acme/web/pull/12", suffix: "pr-12", roots: [{ root: "envs/preview/app", location: "s3://state/web/preview/app-pr-12.tfstate" }], commit: "c".repeat(40), applied: at(10), expires: at(23), approved_by: "alice", status: "live" }, at(10))));
    const config = {
      defaults: { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } },
      projects: { [WEB]: {}, [NET]: {}, "github.com/acme/locked": { reports: { bucket: "s3://locked", endpoint: "http://minio:9000" } }, "github.com/acme/fresh": {} },
    };
    await estate(tmp(), config, { fetch, env: ENV, now: NOW });
    const page = JSON.parse(objects.get("acme-reports:reports/estate.json")!);
    expect(validate(ESTATE, page)).toEqual([]);
    expect(page.projects.map((p: Json) => p.status)).toEqual(["ok", "ok", "error", "no-index"]);

    // Between them the written objects carry every field the schema names.
    const projects: Json[] = page.projects;
    const runRows: Json[] = [...page.recent, ...projects.flatMap((p) => [p.plan, p.drift, ...(p.apply?.waves ?? [])].filter(Boolean))];
    expect([...keys([page])].sort()).toEqual(named(ESTATE).sort());
    expect([...keys([page.totals])].sort()).toEqual(named(ESTATE.properties.totals).sort());
    expect([...keys(projects)].sort()).toEqual(named(ESTATE.$defs.project).sort());
    expect([...keys(runRows)].sort()).toEqual(named(ESTATE.$defs.run).sort());
    expect([...keys(projects.flatMap((p) => p.waiting))].sort()).toEqual(named(ESTATE.$defs.waiting).sort());
    const inventories: Json[] = projects.flatMap((p) => (p.inventory ? [p.inventory] : []));
    expect([...keys(inventories)].sort()).toEqual(named(ESTATE.$defs.inventory).sort());
    const invRoots: Json[] = inventories.flatMap((i) => i.roots);
    expect([...keys(invRoots)].sort()).toEqual(named(ESTATE.$defs.inventory.properties.roots.items).sort());
    expect([...keys(invRoots.flatMap((r) => r.resources))].sort()).toEqual(named(ESTATE.$defs.resource).sort());
    const stateRoots: Json[] = projects.flatMap((p) => p.states ?? []);
    expect([...keys(stateRoots)].sort()).toEqual(named(ESTATE.$defs.stateRoot).sort());
    expect([...keys(stateRoots.flatMap((r) => r.versions))].sort()).toEqual(named(ESTATE.$defs.stateRoot.properties.versions.items).sort());
    expect([...keys(projects.flatMap((p) => (p.run_view ? [p.run_view] : [])))].sort()).toEqual(named(ESTATE.$defs.project.properties.run_view).sort());
    expect([...keys(projects.flatMap((p) => p.applying ?? []))].sort()).toEqual(named(ESTATE.$defs.project.properties.applying.items).sort());
    expect([...keys(page.graph.nodes)].sort()).toEqual(named(ESTATE.properties.graph.properties.nodes.items).sort());
    expect([...keys(page.graph.edges)].sort()).toEqual(named(ESTATE.properties.graph.properties.edges.items).sort());
    expect([...keys(page.graph.edges.flatMap((e: Json) => [e.from, e.to]))].sort()).toEqual(named(ESTATE.$defs.graphRoot).sort());
    const edges: Json[] = projects.flatMap((p) => p.edges ?? []);
    expect([...keys(edges)].sort()).toEqual(named(ESTATE.$defs.edge).sort());
    expect([...keys(edges.flatMap((e) => [e.consumer_planned, e.producer_applied]))].sort()).toEqual(named(ESTATE.$defs.edgeRun).sort());
    const copies: Json[] = projects.flatMap((p) => p.ephemeral ?? []);
    expect([...keys(copies)].sort()).toEqual(named(ESTATE.$defs.project.properties.ephemeral.items).sort());
    expect([...keys(copies.flatMap((c) => c.roots))].sort()).toEqual(named(ESTATE.$defs.project.properties.ephemeral.items.properties.roots.items).sort());
  });

  it("refuses a project with a status it does not know, and a run with a field it does not name", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, runs().slice(0, 1));
    await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const page = JSON.parse(objects.get("acme-reports:reports/estate.json")!);
    expect(validate(ESTATE, { ...page, projects: [{ ...page.projects[0], status: "stale" }] })).toEqual(['$.projects[0].status: "stale" not in enum']);
    expect(validate(ESTATE, { ...page, recent: [{ ...page.recent[0], live: true }] })).toEqual(["$.recent[0]: live is not in the schema"]);
  });
});

describe("terragucci.inventory/v1", () => {
  it("holds the inventory.json an applied wave's upload writes, and every field it names is one the upload writes", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs());
    const inv = JSON.parse(objects.get(`acme-reports:reports/${NET}/inventory.json`)!);
    expect(validate(INVENTORY, inv)).toEqual([]);
    expect([...keys([inv])].sort()).toEqual(named(INVENTORY).sort());
    expect([...keys(inv.roots)].sort()).toEqual(named(INVENTORY.properties.roots.items).sort());
    expect([...keys(inv.roots.flatMap((r: Json) => r.resources))].sort()).toEqual(named(INVENTORY.properties.roots.items.properties.resources.items).sort());
    // Only a wave whose roots applied writes one.
    expect(objects.has(`acme-reports:reports/${WEB}/inventory.json`)).toBe(false);
    expect(validate(INVENTORY, { ...inv, roots: [{ ...inv.roots[0], resources: [{ address: "x", type: "t" }] }] })).toEqual(["$.roots[0].resources[0]: missing provider"]);
  });
});

describe("terragucci.state-versions/v1", () => {
  it("holds the states.json an applied wave's upload writes, and every field it names is one the upload writes", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs());
    const file = JSON.parse(objects.get(`acme-reports:reports/${NET}/states.json`)!);
    expect(validate(STATES, file)).toEqual([]);
    expect([...keys([file])].sort()).toEqual(named(STATES).sort());
    expect([...keys(file.roots)].sort()).toEqual(named(STATES.properties.roots.items).sort());
    expect([...keys(file.roots.flatMap((r: Json) => r.versions))].sort()).toEqual(named(STATES.properties.roots.items.properties.versions.items).sort());
    // Only a wave whose roots recorded their state writes one.
    expect(objects.has(`acme-reports:reports/${WEB}/states.json`)).toBe(false);
    expect(validate(STATES, { ...file, roots: [{ ...file.roots[0], versioning: "maybe" }] })).not.toEqual([]);
  });
});

describe("terragucci.state-edges/v1", () => {
  it("holds the edges.json uploads write, and every field it names is one an upload writes", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs());
    const file = JSON.parse(objects.get(`acme-reports:reports/${NET}/edges.json`)!);
    expect(validate(EDGES, file)).toEqual([]);
    expect([...keys([file])].sort()).toEqual(named(EDGES).sort());
    expect([...keys(file.roots)].sort()).toEqual(named(EDGES.properties.roots.items).sort());
    expect([...keys(file.roots.flatMap((r: Json) => [r.planned, r.applied].filter(Boolean)))].sort()).toEqual(named(EDGES.$defs.run).sort());
    // A project whose roots read no state and that applied no change writes none.
    expect(objects.has(`acme-reports:reports/${WEB}/edges.json`)).toBe(false);
  });
});

describe("terragucci.changes/v1 and terragucci.history/v1", () => {
  it("hold the changes.json applied waves' uploads write and the history.json terragucci estate writes, and every field each names is one they write", async () => {
    const { objects, fetch, s3 } = bucket();
    const D = `sha256:${"d".repeat(64)}`;
    const moved = plan([{ ...rc("aws_s3_bucket.logs2", ["update"], { bucket: "logs", tags: {} }, { bucket: "logs", tags: { a: "b" } }), previous_address: "aws_s3_bucket.logs" }]);
    const wave4 = buildReport({ run: { ...RUN, project: NET, commit: "e".repeat(40), stage: "tf-apply", wave: 4, finished: at(11, 30), pull_request: "9" }, roots: [{ path: "a", plan: moved, applied: true }], waves: [{ number: 4, roots: ["a"], approval: "approved", setDigest: D }] });
    const reports = [...runs(), wave4];
    await upload(s3, reports);
    const approval = { schema: AUDIT_SCHEMA as typeof AUDIT_SCHEMA, id: "sha256:ap", kind: "approval" as const, project: NET, at: at(11), who: "bob", what: "wave-4", digest: D, result: "unsigned", evidence: { source: "ledger" as const } };
    const applies = reports.map((r) => reportEntry(r, runPath(r), { source: "report", bucket: "s3://acme-reports", key: `reports/${r.run.project}/${runPath(r)}/report.json` }, [approval])).filter((e) => e !== undefined);
    objects.set("acme-reports:reports/audit.jsonl", appendEntries(readRecord(undefined), [approval, ...applies]));
    await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });

    const changes = JSON.parse(objects.get(`acme-reports:reports/${NET}/changes.json`)!);
    expect(validate(CHANGES, changes)).toEqual([]);
    expect([...keys([changes])].sort()).toEqual(named(CHANGES).sort());
    expect([...keys(changes.changes)].sort()).toEqual(named(CHANGES.properties.changes.items).sort());

    const history = JSON.parse(objects.get("acme-reports:reports/history.json")!);
    expect(validate(HISTORY, history)).toEqual([]);
    expect([...keys([history])].sort()).toEqual(named(HISTORY).sort());
    expect([...keys(history.resources)].sort()).toEqual(named(HISTORY.properties.resources.items).sort());
    expect([...keys(history.resources.flatMap((r: Json) => r.applies))].sort()).toEqual(named(HISTORY.properties.resources.items.properties.applies.items).sort());
    expect(validate(HISTORY, { ...history, resources: [{ ...history.resources[0], applies: [{ ...history.resources[0].applies[0], actions: ["rename"] }] }] })).toEqual(['$.resources[0].applies[0].actions[0]: "rename" not in enum']);
  });
});

describe("terragucci.dora/v1", () => {
  it("holds the dora.json terragucci estate writes from the audit record and the indexes, and every field it names is one it writes", async () => {
    const { objects, fetch, s3 } = bucket();
    const reports = runs();
    await upload(s3, reports);
    const applies = reports.map((r) => reportEntry(r, runPath(r), { source: "report", bucket: "s3://acme-reports", key: `reports/${r.run.project}/${runPath(r)}/report.json` }, [])).filter((e) => e !== undefined);
    objects.set("acme-reports:reports/audit.jsonl", appendEntries(readRecord(undefined), applies));
    await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const dora = JSON.parse(objects.get("acme-reports:reports/dora.json")!);
    expect(validate(DORA, dora)).toEqual([]);
    expect(dora.estate.deployments).toBeGreaterThan(0);
    expect([...keys([dora])].sort()).toEqual(named(DORA).sort());
    expect([...keys([dora.estate])].sort()).toEqual(named(DORA.$defs.metrics).sort());
    expect([...keys(dora.projects)].sort()).toEqual(named(DORA.properties.projects.items).sort());
    expect([...keys([dora.estate.lead_time])].sort()).toEqual(named(DORA.$defs.lead_time).sort());
    expect([...keys([dora.estate.change_failure])].sort()).toEqual(named(DORA.$defs.change_failure).sort());
    expect([...keys([dora.estate.restore])].sort()).toEqual(named(DORA.$defs.restore).sort());
    expect([...keys(dora.estate.trend)].sort()).toEqual(named(DORA.$defs.trend.items).sort());
    expect(validate(DORA, { ...dora, estate: { ...dora.estate, per_week: "often" } })).toEqual(["$.estate.per_week: string is not number"]);
  });
});

describe("terragucci.audit/v1", () => {
  const D = `sha256:${"a".repeat(64)}`;
  const line = (o: Json, commit: string, added = true): LedgerChange => ({ line: JSON.stringify(o), added, commit, author: "x", date: o.timestamp });
  const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: at(10), expiresAt: "2026-10-09T10:00:00.000Z", planDigest: D, members: [{ member: "envs/dev/orders", planDigest: "sha256:1" }] };
  const bob = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "bob", timestamp: at(10, 5), planDigest: D };
  const carol = { ...bob, resolvedBy: "carol", timestamp: at(10, 10), seal: { signer: "carol", key: "k", signature: "s" } };
  const denial = { version: 1, kind: "pending", op: "policy-override", gate: "envs/dev/orders", timestamp: at(9), expiresAt: "2026-10-09T09:00:00.000Z", planDigest: D, members: [{ member: "envs/dev/orders", planDigest: "sha256:p1" }], rules: ["main.deny"] };
  const allowed = { version: 1, kind: "resolution", op: "policy-override", gate: "envs/dev/orders", resolvedBy: "alice", timestamp: at(9, 5), planDigest: D, note: "why" };

  it("holds every line the record appends, from the ledger and from wave reports", () => {
    const approvals = ledgerEntries(RUN.project, APPLY_LEDGER, [line(pending, "c1"), line(bob, "c2"), line(carol, "c3"), line(bob, "c4", false)], (c) => `https://forge/commit/${c}`);
    const overrides = ledgerEntries(RUN.project, OVERRIDE_LEDGER_FILE, [line(denial, "c5"), line(allowed, "c6"), line(allowed, "c7", false)]);
    const wave = (approval: "approved" | "waiting", finished: string, refused?: { reason: "approval"; approved: string; by: string; roots: string[] }) =>
      buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1, finished }, roots: smallFixture().slice(0, 1), waves: [{ number: 1, roots: ["envs/dev/orders"], approval, setDigest: D, ...(refused ? { refused } : {}) }] });
    const evidence = { source: "report" as const, bucket: "s3://acme-reports", key: "reports/x/report.json", url: "https://reports/x/report.html", job_url: RUN.job_url };
    const fromReports = [
      reportEntry(wave("approved", at(10, 20)), "x", evidence, approvals)!,
      reportEntry(wave("waiting", at(11), { reason: "approval", approved: `sha256:${"c".repeat(64)}`, by: "carol", roots: ["envs/dev/orders"] }), "y", evidence, approvals)!,
    ];
    const text = appendEntries(readRecord(undefined), [...approvals, ...overrides, ...fromReports]);
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json);
    expect(new Set(lines.map((l) => l.kind))).toEqual(new Set(["approval-requested", "approval", "approval-revoked", "override-requested", "override", "override-revoked", "apply", "refused"]));
    for (const [i, l] of lines.entries()) expect(validate(AUDIT, l), `line ${i + 1}`).toEqual([]);
    expect([...keys(lines)].sort()).toEqual(named(AUDIT).sort());
    expect([...keys(lines.map((l) => l.evidence))].sort()).toEqual(named(AUDIT.properties.evidence).sort());
    expect(validate(AUDIT, { ...lines[0], kind: "deploy" })).toEqual(['$.kind: "deploy" not in enum']);
  });
});
