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
 * Nothing here approves, applies, overrides or merges:
 * - every tool reads, and the bucket's client is wrapped so a write throws;
 * - with `--propose` (PROPOSE_TOOLS), three tools more write to the forge and
 *   nothing else: `propose` pushes a local branch without force and opens a
 *   pull request from it, refusing the default branch, `chant/lifecycle` and
 *   every `apply.branches` branch; `request_plan` comments `/terragucci plan`
 *   on a pull request; `plan_result` reads the plan note and the head's plan
 *   report. A pull request they open plans and goes through the gate like any
 *   other, and nothing they do changes what a wave needs;
 * - a call to a tool that is not listed is refused, and one whose name says it
 *   would approve, apply, override, lock, merge or write is refused by name,
 *   with the CLI's own answer: approvals belong to a person at a shell, and
 *   chant refuses a gate approval made over MCP;
 * - the server will not start with a tool whose name says it would write
 *   (`assertReadOnly`);
 * - credentials come from the server's environment (the variables the reports
 *   bucket's client reads, the forge token `token_env` names, and git's own
 *   for the repo), never from a tool's arguments: a tool takes only the
 *   arguments it lists, and refuses any other.
 */
import { execFileSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BRANCH, parseComment } from "./comment";
import { ConfigError, resolveProject, resolveRepo, type ResolvedSettings, type TerragucciConfig } from "./config";
import { call, DEFAULT_TOKEN_ENV, defaultBranch, openPullRequest, prForgeOf, type Fetch, type ForgeTarget } from "./forge";
import { PLAN_MARK } from "./plan-note-gitlab";
import { forgeOf } from "./respond/change";
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

/** What a client is told a tool does; a tool without them reads. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  annotations?: ToolAnnotations;
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
  /** The repo's forge, with the token from the server's environment, for the propose tools. */
  forge(): Forge;
  /** Wait, for `plan_result`. */
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The forge the propose tools reach, and what they read of the repo's settings. */
export interface Forge {
  target: ForgeTarget;
  fetch: Fetch;
  settings: ResolvedSettings;
  /** The variable the token is read from. */
  tokenEnv: string;
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

/** The answer to a call that would approve, apply, override or write: the CLI's own refusal. With `proposing`, the server serves PROPOSE_TOOLS. */
export function refusal(name: string, proposing = false): string {
  const w = writeWord(name);
  const what = w ? `${name} would ${w}, and ` : `there is no tool ${name}; `;
  const serves = proposing
    ? "terragucci mcp never approves, applies, overrides or merges: " + what + "it serves what terragucci wrote to the reports bucket and the repo, and opens pull requests and asks for their plans."
    : "terragucci mcp is read-only: " + what + "it serves only what terragucci wrote to the reports bucket and the repo.";
  return `${serves} Approvals, applies and overrides belong to a person at a shell (terragucci approve, terragucci override), and a gate approval made over MCP is refused.`;
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
    description: "The estate page's data (estate.json, terragucci.estate/v1), as `terragucci estate` last wrote it: every project, its waiting waves, drift, failed roots, inventory and state versions, and the module, provider and binary versions every root runs.",
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

/** The branch that holds the approval records: never pushed from here. */
export const LIFECYCLE_BRANCH = "chant/lifecycle";

/** How often `plan_result` looks again while it waits. */
export const PLAN_POLL_MS = 10_000;

/** The footer on every pull request `propose` opens. */
export const PROPOSED_FOOTER = "Proposed through terragucci mcp. Nothing was applied, approved or merged: the pipeline plans this pull request, and a person approves its apply.";

/** Why `propose` will not push `branch`, or undefined when it may. */
export function refusedBranch(branch: string, main: string, settings: ResolvedSettings): string | undefined {
  if (branch === main) return `propose never pushes the default branch (${main}): commit the change to a branch of its own`;
  if (branch === LIFECYCLE_BRANCH) return `propose never pushes ${LIFECYCLE_BRANCH}: it holds the approval records, which belong to people`;
  if (Object.hasOwn(settings.apply?.branches ?? {}, branch)) return `propose never pushes ${branch}: a push to it applies roots (apply.branches)`;
  return undefined;
}

function branchName(v: unknown, what: string): string {
  const b = v as string;
  if (!BRANCH.test(b) || b.split("/").some((s) => s === "" || s.startsWith(".") || s.endsWith(".lock")) || b.includes("..") || b.endsWith(".")) throw new ToolError(`${what} ${JSON.stringify(b)} is not a branch name propose takes`);
  return b;
}

/** git in the repo, with the server's own credentials and no prompt: the protocol owns stdin and stdout. */
function gitIn(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").filter(Boolean).pop() ?? "";
    throw new ToolError(`git ${args[0]} failed: ${why}`);
  }
}

function needToken(f: Forge): void {
  if (!f.target.token) throw new ToolError(`${f.tokenEnv} is not set in terragucci mcp's environment; it holds the forge token the server opens pull requests and comments with`);
}

const pullNumber = { type: "integer", description: "The pull request's number (the merge request's iid on GitLab).", minimum: 1 } as const;

/** A pull request's state and head, from the forge. */
export async function pullHead(f: Forge, n: number): Promise<{ state: "open" | "closed" | "merged"; sha: string; branch: string; url?: string }> {
  if (f.target.forge === "gitlab") {
    const m = (await call(f.fetch, f.target, "GET", `/projects/${encodeURIComponent(f.target.path)}/merge_requests/${n}`)) as { state?: string; sha?: string; source_branch?: string; web_url?: string };
    return { state: m.state === "opened" ? "open" : m.state === "merged" ? "merged" : "closed", sha: m.sha ?? "", branch: m.source_branch ?? "", ...(m.web_url ? { url: m.web_url } : {}) };
  }
  const p = (await call(f.fetch, f.target, "GET", `/repos/${f.target.path}/pulls/${n}`)) as { state?: string; merged?: boolean; head?: { sha?: string; ref?: string }; html_url?: string };
  return { state: p.state === "open" ? "open" : p.merged ? "merged" : "closed", sha: p.head?.sha ?? "", branch: p.head?.ref ?? "", ...(p.html_url ? { url: p.html_url } : {}) };
}

/** A tf-plan report cut to what an agent acts on: each root's status and policy verdict, the policy check, and whether each wave's gate will hold it. */
function planSummary(r: Report) {
  return {
    commit: r.run.commit,
    finished: r.run.finished,
    ...(r.run.job_url ? { job_url: r.run.job_url } : {}),
    ...(r.run.report_url ? { report_url: r.run.report_url } : {}),
    totals: r.totals,
    roots: r.roots.map((x) => ({
      path: x.path,
      status: x.status,
      ...(x.error ? { error: x.error } : {}),
      counts: x.counts,
      ...(x.policy ? { policy: { result: x.policy.result, denials: x.policy.denials, ...(x.policy.rules ? { rules: x.policy.rules } : {}), warnings: x.policy.warnings, ...(x.policy.error ? { error: x.policy.error } : {}) } } : {}),
    })),
    ...(r.policy ? { policy: { denied: r.policy.denied, warnings: r.policy.warnings, ...(r.policy.overriders ? { overriders: r.policy.overriders } : {}) } } : {}),
    gate: r.waves.map((w) => ({ wave: w.number, roots: w.roots, ...(w.waits !== undefined ? { waits: w.waits } : {}), ...(w.policy_gate ? { policy_gate: w.policy_gate } : {}) })),
  };
}

/**
 * The tools `terragucci mcp --propose` serves besides TOOLS. They write to
 * the forge (a branch, a pull request, a comment) and never approve, apply,
 * override or merge.
 */
export const PROPOSE_TOOLS: Tool[] = [
  {
    name: "propose",
    description: `Push a local branch to origin, without force, and open a pull request from it (or return the one already open), so the pipeline plans the change. Refuses the default branch, ${LIFECYCLE_BRANCH} and every branch an apply runs from. It never approves, applies or merges; a person does.`,
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "The local branch with the change, committed." },
        title: { type: "string", description: "The pull request's title." },
        body: { type: "string", description: "The pull request's description." },
        base: { type: "string", description: "The branch it merges into. Default: the repository's default branch." },
      },
      required: ["branch", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(a, ctx) {
      const branch = branchName(a.branch, "branch");
      const f = ctx.forge();
      needToken(f);
      const main = await defaultBranch(f.fetch, f.target);
      const refused = refusedBranch(branch, main, f.settings);
      if (refused) throw new ToolError(refused);
      const base = a.base === undefined ? main : branchName(a.base, "base");
      if (base === LIFECYCLE_BRANCH) throw new ToolError(`a pull request never goes into ${LIFECYCLE_BRANCH}`);
      if (base === branch) throw new ToolError("the pull request's branch and its base are the same branch");
      let commit: string;
      try {
        commit = gitIn(ctx.repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
      } catch {
        throw new ToolError(`there is no local branch ${branch}: commit the change to it first`);
      }
      // Never a force push: a branch already on origin moves only forward.
      gitIn(ctx.repo, ["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
      const body = [typeof a.body === "string" ? a.body.trim() : "", PROPOSED_FOOTER].filter(Boolean).join("\n\n");
      const pr = await openPullRequest(f.fetch, f.target, { head: branch, base, title: a.title as string, body });
      return {
        branch,
        commit,
        base,
        pull_request: pr.number,
        url: pr.url,
        existing: pr.existing,
        next: `the pipeline plans ${commit.slice(0, 12)}; plan_result with pull_request ${pr.number} reads its plan note and policy result`,
      };
    },
  },
  {
    name: "request_plan",
    description: "Ask the pipeline to plan a pull request again, as a `/terragucci plan [root]` comment does. A push to the pull request plans it too.",
    inputSchema: {
      type: "object",
      properties: { pull_request: pullNumber, root: { type: "string", description: "Plan only this root." } },
      required: ["pull_request"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a, ctx) {
      const n = a.pull_request as number;
      const command = a.root === undefined ? "/terragucci plan" : `/terragucci plan ${a.root as string}`;
      const parsed = parseComment(command);
      if (parsed?.kind !== "plan") throw new ToolError(parsed?.kind === "refused" ? parsed.reason : `${command} is not a plan command`);
      const f = ctx.forge();
      needToken(f);
      const pr = await pullHead(f, n);
      if (pr.state !== "open") throw new ToolError(`pull request ${n} is ${pr.state}, so there is nothing to plan`);
      const c = await prForgeOf(f.target, f.fetch).addComment(n, command);
      return { pull_request: n, head: pr.sha, comment: command, ...(c.url ? { url: c.url } : {}), next: `plan_result with pull_request ${n} waits for the plan of ${pr.sha.slice(0, 12)}` };
    },
  },
  {
    name: "plan_result",
    description: "A pull request's plan: its plan note, and from the reports bucket the tf-plan report of its head, with each root's status, the policy's denials and warnings, and whether each wave's gate will hold it. Waits up to `wait` seconds for the head's plan.",
    inputSchema: {
      type: "object",
      properties: {
        pull_request: pullNumber,
        wait: { type: "integer", description: "Wait up to this many seconds for the plan of the head (default 120).", minimum: 0, maximum: 600 },
        project,
      },
      required: ["pull_request"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(a, ctx) {
      const n = a.pull_request as number;
      const f = ctx.forge();
      const deadline = ctx.now() + ((a.wait as number | undefined) ?? 120) * 1000;
      for (;;) {
        const pr = await pullHead(f, n);
        const note = await prForgeOf(f.target, f.fetch).findComment(n, PLAN_MARK);
        let bucket: string | undefined;
        let found: { path: string; report: Report } | undefined;
        try {
          const p = await ctx.project(a.project as string | undefined);
          const rows = (await readIndex(p.store, key(p.prefix, p.project, "index.json"))).filter((r) => r.stage === "tf-plan" && r.pull_request === String(n) && r.commit === pr.sha);
          if (rows[0]) {
            const at = key(p.project, rows[0].path);
            const text = await p.store.get(key(p.prefix, at, "report.json"));
            if (text !== undefined) found = { path: at, report: JSON.parse(text) as Report };
          }
        } catch (e) {
          if (!(e instanceof ToolError) && !(e instanceof SyntaxError)) throw e;
          // No bucket is named: the note is all there is. Anything else (no index yet) is a plan still to come.
          if (e instanceof ToolError && e.message.includes("names no reports bucket")) bucket = e.message;
        }
        const base = { pull_request: n, state: pr.state, head: pr.sha, ...(pr.url ? { url: pr.url } : {}), ...(note ? { note: note.body } : {}) };
        if (found) return { ...base, planned: true, report: found.path, plan: planSummary(found.report) };
        // Without the bucket, the note is all there is to read.
        if ((bucket && note) || pr.state !== "open" || ctx.now() >= deadline) {
          return { ...base, planned: false, why: bucket ?? (pr.state !== "open" ? `pull request ${n} is ${pr.state}` : `no plan of ${pr.sha.slice(0, 12)} is in the reports bucket yet; call plan_result again`) };
        }
        await ctx.sleep(Math.max(0, Math.min(PLAN_POLL_MS, deadline - ctx.now())));
      }
    },
  },
];

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failed = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Answer one tools/call: a listed tool with its own arguments, or a refusal. */
export async function callTool(tools: readonly Tool[], name: string, args: Record<string, unknown> | undefined, ctx: Context): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failed(refusal(name, tools.some((t) => PROPOSE_TOOLS.includes(t))));
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
  /** Serve PROPOSE_TOOLS too: push a branch, open a pull request, ask for and read its plan. */
  propose?: boolean;
  /** The forge's fetch, for the propose tools (tests). */
  forgeFetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
    forge() {
      if (control) throw new ToolError("propose, request_plan and plan_result work in a project's own repo, not in a control repo");
      const settings = resolveRepo(o.config);
      const target = forgeOf(o.cwd, settings, env);
      return { target, fetch: o.forgeFetch ?? (globalThis.fetch as unknown as Fetch), settings, tokenEnv: settings.token_env ?? DEFAULT_TOKEN_ENV[target.forge] };
    },
    sleep: o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: o.now ?? Date.now,
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
  const tools = [...(o.tools ?? TOOLS), ...(o.propose ? PROPOSE_TOOLS : [])];
  assertReadOnly(tools);
  const ctx = context(o);
  const server = new Server(
    { name: "terragucci", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: o.propose
        ? "terragucci's estate, reports, state versions, audit trail and DORA figures, and a way to propose a change: commit it to a local branch, call propose to push it and open a pull request, then plan_result to read its plan note and policy result. Nothing here approves, applies, overrides or merges; a person does that."
        : "terragucci's estate, reports, state versions, audit trail and DORA figures, read-only. Nothing here approves, applies, overrides or writes; a person does that at a shell.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
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
