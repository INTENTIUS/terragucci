import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertReadOnly, callTool, checkArgs, context, readOnlyStore, refusal, serve, TOOLS, type McpOptions, type Tool } from "../src/mcp";
import { buildReport } from "../src/report/build";
import { StoreError, type ObjectStore } from "../src/report/object-store";
import type { Report } from "../src/report/schema";
import { addToIndex, indexEntry, runPath } from "../src/report/store";
import { RUN, smallFixture } from "./report-fixtures";
import { tmp } from "./helpers";

const DIST = join(import.meta.dirname, "../dist/terragucci.mjs");

function memoryStore(objects: Map<string, string> = new Map()): ObjectStore & { objects: Map<string, string>; puts: number } {
  const s = {
    location: "s3://reports",
    objects,
    puts: 0,
    async put(key: string, body: string | Uint8Array) {
      s.puts++;
      objects.set(key, typeof body === "string" ? body : Buffer.from(body).toString("utf-8"));
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

const PREFIX = "tg";
const PROJECT = RUN.project;

/** A tf-apply wave's report: its roots, the time it finished, and the commit. */
function wave(n: number, finished: string, commit: string, roots: string[], approval: "approved" | "not-required" | "waiting" = "not-required"): Report {
  const fixture = smallFixture().filter((r) => roots.includes(r.path));
  return buildReport({
    run: { ...RUN, stage: "tf-apply", wave: n, commit, finished, started: finished },
    roots: fixture,
    waves: [{ number: n, roots, approval }],
  });
}

/** A bucket holding two applies of envs/dev/orders and one of envs/dev/search, newest first in the index. */
function bucket(): ReturnType<typeof memoryStore> {
  const store = memoryStore();
  const reports = [
    wave(1, "2026-10-01T10:00:00.000Z", "a".repeat(40), ["envs/dev/orders", "envs/dev/search"]),
    wave(1, "2026-10-05T10:00:00.000Z", "b".repeat(40), ["envs/dev/orders"], "approved"),
  ];
  let top: string | undefined;
  let mine: string | undefined;
  for (const r of reports) {
    const path = runPath(r);
    store.objects.set(`${PREFIX}/${PROJECT}/${path}/report.json`, JSON.stringify(r));
    mine = JSON.stringify(addToIndex(mine, indexEntry(r, path)));
    top = JSON.stringify(addToIndex(top, indexEntry(r, `${PROJECT}/${path}`)));
  }
  store.objects.set(`${PREFIX}/${PROJECT}/index.json`, mine!);
  store.objects.set(`${PREFIX}/index.json`, top!);
  store.objects.set(`${PREFIX}/estate.json`, JSON.stringify({ schema: "terragucci.estate/v1", projects: [{ project: PROJECT }] }));
  store.objects.set(`${PREFIX}/dora.json`, JSON.stringify({ schema: "terragucci.dora/v1", estate: { deployments: 2 } }));
  store.objects.set(
    `${PREFIX}/${PROJECT}/states.json`,
    JSON.stringify({ schema: "terragucci.state-versions/v1", roots: [{ root: "envs/dev/orders", backend: "s3", versioning: "on", checked: "2026-10-05T10:00:00.000Z", versions: [{ version_id: "v2", commit: "b".repeat(40), finished: "2026-10-05T10:00:00.000Z", path: "x" }] }, { root: "envs/dev/search", backend: "local", versioning: "off", checked: "2026-10-01T10:00:00.000Z", versions: [] }] }),
  );
  const entry = (id: string, kind: string, at: string, project = PROJECT) => JSON.stringify({ schema: "terragucci.audit/v1", id, kind, project, at, who: "ana", what: "wave-1", digest: null, result: "ok", evidence: { source: "ledger" } });
  store.objects.set(`${PREFIX}/audit.jsonl`, [entry("sha256:1", "approval", "2026-10-05T09:00:00.000Z"), entry("sha256:2", "apply", "2026-10-05T10:00:00.000Z"), entry("sha256:3", "apply", "2026-10-01T10:00:00.000Z", "other/x")].join("\n") + "\n");
  return store;
}

function options(store: ObjectStore, extra: Partial<McpOptions> = {}): McpOptions {
  return { cwd: tmp(), config: { reports: { bucket: "s3://reports", prefix: PREFIX } }, store: () => store, env: {}, ...extra };
}

async function connected(o: McpOptions): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await serve(o, a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const body = (r: object): any => JSON.parse(((r as { content: unknown }).content as { text: string }[])[0].text);
const said = (r: object): string => ((r as { content: unknown }).content as { text: string }[])[0].text;

describe("terragucci mcp", () => {
  it("lists only tools that read, each marked read-only, none named for a write", async () => {
    const client = await connected(options(bucket()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["audit", "dora", "estate", "index", "last_apply", "report", "run_view", "state_versions", "waiting"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.name).not.toMatch(/approve|override|unlock|merge|^apply/);
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("reads a root's last apply: the newest tf-apply wave that ran it", async () => {
    const client = await connected(options(bucket()));
    const orders = body(await client.callTool({ name: "last_apply", arguments: { root: "envs/dev/orders" } }));
    expect(orders).toMatchObject({ project: PROJECT, root: "envs/dev/orders", commit: "b".repeat(40), wave: 1, approval: "approved", applied: true, result: { path: "envs/dev/orders", status: "planned" } });
    expect(orders.report).toBe(`${PROJECT}/2026/10/${"b".repeat(40)}/tf-apply-wave-1`);
    // search was not in the newer wave, so its last apply is the older one.
    const search = body(await client.callTool({ name: "last_apply", arguments: { root: "envs/dev/search" } }));
    expect(search.commit).toBe("a".repeat(40));
    const none = await client.callTool({ name: "last_apply", arguments: { root: "envs/prod/orders" } });
    expect(none.isError).toBe(true);
    expect(said(none)).toContain("no tf-apply wave");
  });

  it("serves the estate, the index, a report, the state versions, the audit trail and the DORA figures", async () => {
    const client = await connected(options(bucket()));
    expect(body(await client.callTool({ name: "estate", arguments: {} })).schema).toBe("terragucci.estate/v1");
    expect(body(await client.callTool({ name: "dora", arguments: {} })).estate.deployments).toBe(2);
    const rows = body(await client.callTool({ name: "index", arguments: { stage: "tf-apply", limit: 1 } }));
    expect(rows).toHaveLength(1);
    const one = body(await client.callTool({ name: "report", arguments: { path: rows[0].report, root: "envs/dev/orders" } }));
    expect(one.run.commit).toBe("b".repeat(40));
    expect(one.root.path).toBe("envs/dev/orders");
    const mine = body(await client.callTool({ name: "index", arguments: { project: PROJECT } }));
    expect(mine.map((r: { report: string }) => r.report)).toEqual(rows.length ? [rows[0].report, expect.stringContaining("a".repeat(40))] : []);
    const states = body(await client.callTool({ name: "state_versions", arguments: { root: "envs/dev/orders" } }));
    expect(states.roots.map((r: { root: string }) => r.root)).toEqual(["envs/dev/orders"]);
    const audit = body(await client.callTool({ name: "audit", arguments: { project: PROJECT } }));
    expect(audit.entries.map((e: { id: string }) => e.id)).toEqual(["sha256:2", "sha256:1"]);
    expect(body(await client.callTool({ name: "audit", arguments: { kind: "apply", limit: 1 } })).entries.map((e: { id: string }) => e.id)).toEqual(["sha256:2"]);
  });

  it("refuses a tool that would approve, apply, override or write, with the CLI's answer", async () => {
    const store = bucket();
    const client = await connected(options(store));
    for (const name of ["approve", "apply", "override", "unlock", "merge", "write_report"]) {
      const r = await client.callTool({ name, arguments: { wave: "wave-1" } });
      expect(r.isError, name).toBe(true);
      expect(said(r)).toContain("terragucci mcp is read-only");
      expect(said(r)).toContain("chant refuses a gate approval made over MCP");
    }
    expect(refusal("approve")).toContain("approve would approve");
    expect(refusal("nothing")).toContain("there is no tool nothing");
    expect(store.puts).toBe(0);
  });

  it("takes credentials from its environment, never from a tool's arguments", async () => {
    const client = await connected(options(bucket()));
    for (const k of ["token", "aws_secret_access_key", "AZURE_STORAGE_KEY", "password"]) {
      const r = await client.callTool({ name: "estate", arguments: { [k]: "x" } });
      expect(r.isError, k).toBe(true);
      expect(said(r)).toContain("reads credentials from its own environment");
    }
    const other = await client.callTool({ name: "last_apply", arguments: { root: "app", bucket: "s3://elsewhere" } });
    expect(said(other)).toContain("takes no argument bucket");
    const missing = await client.callTool({ name: "last_apply", arguments: {} });
    expect(said(missing)).toContain("last_apply needs root");
  });

  it("refuses a report path outside the prefix", async () => {
    const client = await connected(options(bucket()));
    for (const path of ["../secrets", "a/../../b", "/etc/passwd", "a//b"]) {
      const r = await client.callTool({ name: "report", arguments: { path } });
      expect(r.isError, path).toBe(true);
    }
  });

  it("will not start with a tool named for a write, and its bucket client never writes", async () => {
    const approve: Tool = { name: "approve", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => "approved" };
    expect(() => assertReadOnly([...TOOLS, approve])).toThrow(/read-only, and the tool approve would approve/);
    expect(() => assertReadOnly([{ ...approve, name: "wave_approve" }])).toThrow(/would approve/);
    expect(() => assertReadOnly([{ ...approve, name: "apply_wave" }])).toThrow(/would apply/);
    expect(() => assertReadOnly(TOOLS)).not.toThrow();
    await expect(connected(options(bucket(), { tools: [approve] }))).rejects.toThrow(/read-only/);
    const store = memoryStore();
    const ro = readOnlyStore(store);
    await expect(ro.put("k", "v", "text/plain")).rejects.toBeInstanceOf(StoreError);
    await expect(ro.presign("k", 60)).rejects.toBeInstanceOf(StoreError);
    expect(store.puts).toBe(0);
  });

  it("asks for a project when the bucket holds several, and reads a control repo's projects from their own buckets", async () => {
    const store = bucket();
    const top = JSON.parse(store.objects.get(`${PREFIX}/index.json`)!);
    top.reports.push({ ...top.reports[0], project: "other/x" });
    store.objects.set(`${PREFIX}/index.json`, JSON.stringify(top));
    const ctx = context(options(store));
    const r = await callTool(TOOLS, "last_apply", { root: "envs/dev/orders" }, ctx);
    expect(said(r)).toContain(`name a project: ${PROJECT}, other/x`);
    const control = context({ ...options(store), config: { defaults: { reports: { bucket: "s3://reports", prefix: PREFIX } }, projects: { [PROJECT]: {}, "github.com/acme/web": {} } } });
    expect(said(await callTool(TOOLS, "last_apply", { root: "envs/dev/orders", project: PROJECT }, control))).toContain("b".repeat(40));
    expect(said(await callTool(TOOLS, "last_apply", { root: "envs/dev/orders", project: "nope/x" }, control))).toContain("no project nope/x");
  });

  it("says what to set when no bucket is named", async () => {
    const r = await callTool(TOOLS, "estate", {}, context({ cwd: tmp(), config: {}, env: {} }));
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("set reports.bucket in terragucci.yml, or start terragucci mcp with --bucket");
  });

  it("checks argument types against each tool's schema", () => {
    const idx = TOOLS.find((t) => t.name === "index")!;
    expect(() => checkArgs(idx, { limit: 0 })).toThrow(/whole number from 1 to 500/);
    expect(() => checkArgs(idx, { stage: 3 })).toThrow(/must be a string/);
    expect(checkArgs(idx, { limit: 5 })).toEqual({ limit: 5 });
  });
});

describe.skipIf(!existsSync(DIST))("the bundle's terragucci mcp", () => {
  it("answers an MCP client over stdio, and refuses an approve tool", async () => {
    const cwd = tmp();
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST, "mcp", "--bucket", "s3://nowhere"], cwd, stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("last_apply");
    expect(tools.map((t) => t.name)).not.toContain("approve");
    const r = await client.callTool({ name: "approve", arguments: {} });
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("terragucci mcp is read-only");
    await client.close();
  }, 30_000);

  it("ends when its stdin closes", async () => {
    const child = spawn(process.execPath, [DIST, "mcp", "--bucket", "s3://nowhere"], { cwd: tmp(), stdio: ["pipe", "pipe", "pipe"] });
    const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.end();
    expect(await done).toBe(0);
  }, 30_000);
});
