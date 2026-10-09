/**
 * `terragucci mcp`: a read-only MCP server over stdio, for a coding agent that
 * reads the estate rather than parsing `--json` envelopes.
 *
 * It serves what terragucci already wrote: from the reports bucket, the
 * estate (`estate.json`), the report indexes, each run's `report.json`, a
 * root's last apply, the run view (`runs/<commit>/run.json`), the state
 * versions (`states.json`), the audit trail (`audit.jsonl`, `audit.json`) and
 * the DORA figures (`dora.json`); from the repo, the waves waiting on
 * `chant/lifecycle`, each with the command a person runs to approve it.
 *
 * Nothing here approves, applies, overrides or writes:
 * - every tool reads, and the bucket's client is wrapped so a write throws;
 * - a call to a tool that is not listed is refused, and one whose name says it
 *   would approve, apply, override, lock, merge or write is refused by name,
 *   with the CLI's own answer: approvals belong to a person at a shell, and
 *   chant refuses a gate approval made over MCP;
 * - the server will not start with a tool whose name says it would write
 *   (`assertReadOnly`);
 * - credentials come from the server's environment (the variables the reports
 *   bucket's client reads, and git's own for the repo), never from a tool's
 *   arguments: a tool takes only the arguments it lists, and refuses any other.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConfigError, resolveProject, resolveRepo, type TerragucciConfig } from "./config";
import { clients, parseIndex } from "./estate";
import { AUDIT_FILES, readRecord, type AuditEntry } from "./report/audit";
import { DORA_FILE } from "./report/dora";
import { StoreError, type ObjectStore, type StoreFetch } from "./report/object-store";
import { runViewKey } from "./report/run-view";
import type { Report } from "./report/schema";
import { readStateVersions } from "./report/state-versions";
import { statesKey, type IndexEntry } from "./report/store";
import { readLedger } from "./apply";
import { waitingWaves } from "./approve";
import { version as VERSION } from "../package.json";

type Reports = NonNullable<TerragucciConfig["reports"]>;

/** A tool's input: JSON Schema, every property listed, nothing else accepted. */
interface InputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "integer"; description: string; minimum?: number; maximum?: number }>;
  required?: string[];
  additionalProperties: false;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  run(args: Record<string, unknown>, ctx: Context): Promise<unknown>;
}

/** What a tool reads through. */
export interface Context {
  /** The reports bucket of the estate (the repo's, or a control repo's `defaults`). */
  top(): { store: ObjectStore; prefix: string };
  /** A project's bucket and the prefix its directory sits under. */
  project(name: string | undefined): Promise<{ project: string; store: ObjectStore; prefix: string }>;
  /** The repo the server runs in, for `chant/lifecycle`. */
  repo: string;
}

/**
 * Words that say a tool would change something: each names what terragucci
 * does only from a shell or a pipeline, never over MCP. A tool's name may not
 * start with one, and may not hold one of STRONG_WORDS anywhere (so
 * `last_apply`, which reads, is a name; `apply_wave` and `wave_approve` are not).
 */
export const WRITE_WORDS = ["approve", "apply", "override", "revoke", "unlock", "lock", "merge", "resume", "migrate", "write", "put", "delete", "push", "commit", "publish", "reconcile", "rollout", "init", "generate", "respond", "relay", "notify", "update", "create", "exec"] as const;
export const STRONG_WORDS = ["approve", "override", "revoke", "unlock", "merge", "write", "delete", "push", "commit", "publish", "exec"] as const;

const writeWord = (name: string): string | undefined => {
  const parts = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const first = parts[0] ?? "";
  return WRITE_WORDS.find((w) => first.startsWith(w)) ?? STRONG_WORDS.find((w) => parts.some((p) => p.startsWith(w)));
};

/** Refuse to serve a tool whose name says it would approve, apply, override or write. */
export function assertReadOnly(tools: readonly Tool[]): void {
  for (const t of tools) {
    const w = writeWord(t.name);
    if (w) throw new ConfigError(`terragucci mcp is read-only, and the tool ${t.name} would ${w}; it is not served`);
  }
}

/** The answer to a call that would approve, apply, override or write: the CLI's own refusal. */
export function refusal(name: string): string {
  const w = writeWord(name);
  const what = w ? `${name} would ${w}, and ` : `there is no tool ${name}; `;
  return `terragucci mcp is read-only: ${what}it serves only what terragucci wrote to the reports bucket and the repo. Approvals, applies and overrides belong to a person at a shell (terragucci approve, terragucci override), and chant refuses a gate approval made over MCP.`;
}

/** Arguments named like a credential: refused by name, since credentials come from the environment. */
const CREDENTIAL = /token|secret|password|passwd|credential|key|auth|session|cookie|signature|sas/i;

/** The arguments a tool takes, checked against its schema; any other is refused. */
export function checkArgs(tool: Tool, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const a = args ?? {};
  const s = tool.inputSchema;
  for (const k of Object.keys(a)) {
    if (s.properties[k]) continue;
    if (CREDENTIAL.test(k)) throw new ToolError(`${tool.name} takes no ${k}: terragucci mcp reads credentials from its own environment, never from a tool's arguments`);
    throw new ToolError(`${tool.name} takes no argument ${k} (it takes ${Object.keys(s.properties).join(", ") || "none"})`);
  }
  for (const k of s.required ?? []) if (a[k] === undefined) throw new ToolError(`${tool.name} needs ${k}`);
  for (const [k, p] of Object.entries(s.properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (p.type === "string" && (typeof v !== "string" || v === "")) throw new ToolError(`${tool.name}: ${k} must be a string`);
    if (p.type === "integer" && !(Number.isInteger(v) && (p.minimum === undefined || (v as number) >= p.minimum) && (p.maximum === undefined || (v as number) <= p.maximum))) {
      throw new ToolError(`${tool.name}: ${k} must be a whole number${p.minimum !== undefined ? ` from ${p.minimum}` : ""}${p.maximum !== undefined ? ` to ${p.maximum}` : ""}`);
    }
  }
  return a;
}

/** A refusal or a missing object: the tool answers with an error result, and the server goes on. */
export class ToolError extends Error {}

/** The bucket's client with its writes refused, so no tool can write whatever it calls. */
export function readOnlyStore(store: ObjectStore): ObjectStore {
  const no = (what: string) => async (): Promise<never> => {
    throw new StoreError(`terragucci mcp is read-only: it does not ${what} in ${store.location}`);
  };
  return { location: store.location, read: (k) => store.read(k), get: (k) => store.get(k), put: no("write"), presign: no("sign a link") };
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const key = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** A path under the bucket's prefix, as an index row names it: no `..`, no empty segment, nothing but the characters run paths use. */
const SAFE_PATH = /^[A-Za-z0-9._~@+-]+(\/[A-Za-z0-9._~@+-]+)*$/;
function safePath(p: string, what: string): string {
  const t = trim(p);
  if (!SAFE_PATH.test(t) || t.split("/").some((s) => s === "." || s === "..")) throw new ToolError(`${what} ${JSON.stringify(p)} is not a path under the reports prefix`);
  return t;
}

async function readJson<T>(store: ObjectStore, at: string, what: string): Promise<T> {
  const text = await store.get(at);
  if (text === undefined) throw new ToolError(`there is no ${what} at ${store.location}/${at}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(`${store.location}/${at} is not JSON`);
  }
}

async function readIndex(store: ObjectStore, at: string): Promise<IndexEntry[]> {
  const text = await store.get(at);
  if (text === undefined) throw new ToolError(`there is no report index at ${store.location}/${at}`);
  return parseIndex(text, at);
}

/** An index row with the path of its run under the prefix, which `report` takes. */
const withPath = (row: IndexEntry, project: string | undefined): IndexEntry & { report: string } => ({ ...row, report: project ? key(project, row.path) : row.path });

/** A report's root, cut to what a reader asks first: never a value, since the report holds none. */
function rootSummary(r: Report["roots"][number]) {
  return {
    path: r.path,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    plan_digest: r.plan_digest,
    counts: r.counts,
    changes: r.changes.map((c) => ({ address: c.address, action: c.action })),
    ...(r.applied_changes ? { applied_changes: r.applied_changes } : {}),
    ...(r.state ? { state: r.state } : {}),
    ...(r.binary ? { binary: r.binary } : {}),
    ...(r.policy ? { policy: r.policy } : {}),
    ...(r.job_url ? { job_url: r.job_url } : {}),
  };
}

const project = { type: "string", description: "The project, as the index names it (<host>/<path>). Optional when the bucket holds one project." } as const;

/** How many tf-apply reports `last_apply` reads before it gives up on a root. */
export const LAST_APPLY_REPORTS = 50;

export const TOOLS: Tool[] = [
  {
    name: "estate",
    description: "The estate page's data (estate.json, terragucci.estate/v1), as `terragucci estate` last wrote it: every project, its waiting waves, drift, failed roots, inventory and state versions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      const { store, prefix } = ctx.top();
      return readJson(store, key(prefix, "estate.json"), "estate.json (run terragucci estate first)");
    },
  },
  {
    name: "index",
    description: "Report index rows (terragucci.report-index/v1), newest first: each run's stage, wave, commit, totals, approval and failures. `report` on a row's report path reads the run's report.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Read this project's index; without it, the index at the top of the prefix, every project's rows." },
        stage: { type: "string", description: "Only rows of this stage: tf-plan, tf-apply or tf-drift." },
        limit: { type: "integer", description: "At most this many rows (default 50).", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    async run(a, ctx) {
      const limit = (a.limit as number | undefined) ?? 50;
      if (a.project !== undefined) {
        const p = await ctx.project(a.project as string);
        const rows = await readIndex(p.store, key(p.prefix, p.project, "index.json"));
        return rows.filter((r) => a.stage === undefined || r.stage === a.stage).slice(0, limit).map((r) => withPath(r, p.project));
      }
      const { store, prefix } = ctx.top();
      const rows = await readIndex(store, key(prefix, "index.json"));
      return rows.filter((r) => a.stage === undefined || r.stage === a.stage).slice(0, limit).map((r) => withPath(r, undefined));
    },
  },
  {
    name: "report",
    description: "A run's report.json (terragucci.report/v1), by the report path an index row gives (<project>/<yyyy>/<mm>/<commit>/<stage>). With root, that root alone.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The run's report path under the prefix, from an index row's `report`." },
        root: { type: "string", description: "Only this root of the run." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(a, ctx) {
      const path = safePath(a.path as string, "path");
      const { store, prefix } = ctx.top();
      const report = await readJson<Report>(store, key(prefix, path, "report.json"), "report");
      if (a.root === undefined) return report;
      const root = report.roots.find((r) => r.path === a.root);
      if (!root) throw new ToolError(`the run at ${path} has no root ${a.root} (it has ${report.roots.map((r) => r.path).join(", ") || "none"})`);
      return { run: report.run, root };
    },
  },
  {
    name: "last_apply",
    description: "A root's last apply: the newest tf-apply wave in the project's index that ran the root, with its commit, wave, gate, whether it applied, what it did to each resource, and the state version it left.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string", description: "The root's path, such as envs/prod/app." }, project },
      required: ["root"],
      additionalProperties: false,
    },
    async run(a, ctx) {
      const p = await ctx.project(a.project as string | undefined);
      const rows = (await readIndex(p.store, key(p.prefix, p.project, "index.json"))).filter((r) => r.stage === "tf-apply");
      let read = 0;
      for (const row of rows) {
        if (read >= LAST_APPLY_REPORTS) break;
        read++;
        const text = await p.store.get(key(p.prefix, p.project, row.path, "report.json"));
        if (text === undefined) continue;
        let report: Report;
        try {
          report = JSON.parse(text) as Report;
        } catch {
          continue;
        }
        const root = report.roots?.find((r) => r.path === a.root);
        if (!root) continue;
        return {
          project: p.project,
          root: a.root,
          commit: report.run.commit,
          wave: report.run.wave,
          ...(report.run.share !== undefined ? { share: report.run.share } : {}),
          finished: report.run.finished,
          approval: row.approval ?? "not-required",
          applied: row.applied !== undefined && root.status === "planned",
          report: key(p.project, row.path),
          ...(report.run.commit_url ? { commit_url: report.run.commit_url } : {}),
          ...(report.run.job_url ? { job_url: report.run.job_url } : {}),
          ...(report.run.report_url ? { report_url: report.run.report_url } : {}),
          result: rootSummary(root),
        };
      }
      throw new ToolError(`no tf-apply wave in ${p.project}'s index ran ${a.root}${rows.length > LAST_APPLY_REPORTS ? ` (read the newest ${LAST_APPLY_REPORTS})` : ""}`);
    },
  },
  {
    name: "run_view",
    description: "The run view of one applied commit (terragucci.run/v1): every wave of its apply, its roots, the roots whose state each reads, and where each wave stands at its gate, with the approve command for a waiting one.",
    inputSchema: {
      type: "object",
      properties: { commit: { type: "string", description: "The commit, in full." }, project },
      required: ["commit"],
      additionalProperties: false,
    },
    async run(a, ctx) {
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(a.commit as string)) throw new ToolError("commit must be a full commit id");
      const p = await ctx.project(a.project as string | undefined);
      return readJson(p.store, key(runViewKey(p.project, a.commit as string, p.prefix), "run.json"), `run view for ${a.commit}`);
    },
  },
  {
    name: "state_versions",
    description: "The state versions each root's applies left (terragucci.state-versions/v1), newest first: the version id a person restores, and the run, commit and wave that wrote it. Never a state's contents.",
    inputSchema: { type: "object", properties: { root: { type: "string", description: "Only this root." }, project }, additionalProperties: false },
    async run(a, ctx) {
      const p = await ctx.project(a.project as string | undefined);
      const text = await p.store.get(statesKey(p.project, p.prefix));
      if (text === undefined) throw new ToolError(`${p.project} has no states.json: no apply recorded a state version`);
      const states = readStateVersions(text);
      return a.root === undefined ? states : { ...states, roots: states.roots.filter((r) => r.root === a.root) };
    },
  },
  {
    name: "audit",
    description: "The audit trail (terragucci.audit/v1) that `terragucci audit` keeps: approvals, overrides, applies, refusals and migrations, each with who, when, the digest and its evidence. Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Only this project's entries." },
        kind: { type: "string", description: "Only entries of this kind, such as approval, apply, override or refused." },
        limit: { type: "integer", description: "At most this many entries (default 100).", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    async run(a, ctx) {
      const { store, prefix } = ctx.top();
      const text = await store.get(key(prefix, AUDIT_FILES.record));
      if (text === undefined) throw new ToolError(`there is no audit trail at ${store.location}/${key(prefix, AUDIT_FILES.record)} (run terragucci audit first)`);
      const at = (e: AuditEntry): number => new Date(e.at).getTime();
      const entries = readRecord(text).entries
        .filter((e) => (a.project === undefined || e.project === a.project) && (a.kind === undefined || e.kind === a.kind))
        .sort((x, y) => at(y) - at(x))
        .slice(0, (a.limit as number | undefined) ?? 100);
      const summary = await store.get(key(prefix, AUDIT_FILES.summary));
      let parsed: unknown;
      try {
        parsed = summary === undefined ? undefined : JSON.parse(summary);
      } catch {
        parsed = undefined;
      }
      return { ...(parsed ? { summary: parsed } : {}), entries };
    },
  },
  {
    name: "dora",
    description: "The DORA figures (dora.json, terragucci.dora/v1) `terragucci estate` last wrote: deployment frequency, lead time, change failure rate and time to restore, for the estate, each project and each week.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      const { store, prefix } = ctx.top();
      return readJson(store, key(prefix, DORA_FILE), "dora.json (run terragucci estate first)");
    },
  },
  {
    name: "waiting",
    description: "The waves waiting for an approval on chant/lifecycle, each with its digest and the command a person runs at a shell to approve it. This server never runs it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      return waitingWaves(readLedger(ctx.repo)).map((w) => ({ ...w, approve: `terragucci approve wave-${w.wave} --plan ${w.digest}` }));
    },
  },
];

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failed = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Answer one tools/call: a listed tool with its own arguments, or a refusal. */
export async function callTool(tools: readonly Tool[], name: string, args: Record<string, unknown> | undefined, ctx: Context): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failed(refusal(name));
  try {
    return text(await tool.run(checkArgs(tool, args), ctx));
  } catch (e) {
    if (e instanceof ToolError || e instanceof StoreError || e instanceof ConfigError || e instanceof TypeError) return failed(e.message);
    throw e;
  }
}

export interface McpOptions {
  /** The repo the server runs in. */
  cwd: string;
  config: TerragucciConfig;
  /** The bucket to read, in place of the config's `reports` (a single repo only). */
  reports?: Reports;
  env?: NodeJS.ProcessEnv;
  fetch?: StoreFetch;
  /** The client of a bucket, in place of the one the environment gives (tests). */
  store?: (r: Reports) => ObjectStore;
  tools?: Tool[];
}

/** How the tools reach the buckets: the repo's `reports`, or a control repo's `defaults.reports` and each project's own. */
export function context(o: McpOptions): Context {
  const env = o.env ?? process.env;
  const client = o.store ?? clients(env, o.fetch);
  const ro = new Map<ObjectStore, ObjectStore>();
  const store = (r: Reports): ObjectStore => {
    const c = client(r);
    let w = ro.get(c);
    if (!w) ro.set(c, (w = readOnlyStore(c)));
    return w;
  };
  const control = o.config.projects && Object.keys(o.config.projects).length > 0;
  if (control && o.reports) throw new ConfigError("--bucket names one bucket; a control repo reads each project's reports and the estate under defaults.reports");
  const out = control ? o.config.defaults?.reports : (o.reports ?? resolveRepo(o.config).reports);
  const need = (r: Reports | undefined, what: string): Reports => {
    if (!r?.bucket) throw new ToolError(`${what} names no reports bucket: set reports.bucket in terragucci.yml, or start terragucci mcp with --bucket`);
    return r;
  };
  return {
    repo: o.cwd,
    top() {
      const r = need(out, control ? "defaults" : "the repo");
      return { store: store(r), prefix: r.prefix ?? "" };
    },
    async project(name) {
      if (control) {
        const names = Object.keys(o.config.projects!);
        const chosen = name ?? (names.length === 1 ? names[0] : undefined);
        if (!chosen) throw new ToolError(`name a project: ${names.join(", ")}`);
        if (!names.includes(chosen)) throw new ToolError(`no project ${chosen} (projects: ${names.join(", ")})`);
        const r = need(resolveProject(o.config, chosen).reports, chosen);
        return { project: chosen, store: store(r), prefix: r.prefix ?? "" };
      }
      const r = need(out, "the repo");
      const s = store(r);
      if (name !== undefined) return { project: safePath(name, "project"), store: s, prefix: r.prefix ?? "" };
      const top = key(r.prefix ?? "", "index.json");
      const textOf = await s.get(top);
      const projects = [...new Set((textOf === undefined ? [] : parseIndex(textOf, top)).map((row) => row.project))].sort();
      if (projects.length === 1) return { project: projects[0], store: s, prefix: r.prefix ?? "" };
      throw new ToolError(projects.length === 0 ? `the index at ${s.location}/${top} lists no project yet` : `name a project: ${projects.join(", ")}`);
    },
  };
}

/** The server, on any transport: the tools listed, each call answered or refused. */
export async function serve(o: McpOptions, transport: Transport): Promise<Server> {
  const tools = o.tools ?? TOOLS;
  assertReadOnly(tools);
  const ctx = context(o);
  const server = new Server(
    { name: "terragucci", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: "terragucci's estate, reports, state versions, audit trail and DORA figures, read-only. Nothing here approves, applies, overrides or writes; a person does that at a shell.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(tools, req.params.name, req.params.arguments, ctx));
  await server.connect(transport);
  return server;
}

/** `terragucci mcp`: serve on stdin and stdout until the client closes them. */
export async function mcp(o: McpOptions): Promise<void> {
  const server = await serve(o, new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.close();
}
