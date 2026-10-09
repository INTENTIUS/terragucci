/**
 * Database units: SQL schemas beside Terraform roots.
 *
 * A unit is a chant project with the `sql` lexicon and an environment one of
 * its Ops applies to: an `ApplyOp` whose `target` is `clickhouse` or
 * `postgres`. The unit's name is the project's directory and the environment,
 * `db@prod`, and it is named in the pipeline's layers like a root. chant does
 * the work that touches the database:
 *
 *   plan   `chant build`, then `chant sql plan <env>`: every change classified
 *          (ClickHouse: metadata only, background rewrite, rebuild; Postgres:
 *          by the lock it takes). Exit 2 is a change the server cannot make in
 *          place, which the unit refuses, naming the Op that makes it instead.
 *   apply  `chant run <op>`, the project's ApplyOp, after the wave's gate let
 *          the plan it just made through.
 *   drift  `chant lifecycle diff <env> --live`: an owned object changed or
 *          gone. An object the project does not own is not drift.
 *
 * Each plan becomes a plan document in Terraform's JSON shape, one resource
 * change per classified change, so the report, the plan digest, the waves and
 * the gate read a unit as they read a root. The text chant prints, each change
 * with its class and rule, is the unit's plan.txt, which the note shows.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { binaryEnv } from "./binary-env";

export const SQL_TARGETS = ["clickhouse", "postgres"] as const;
export type SqlTarget = (typeof SQL_TARGETS)[number];

export interface SqlUnit {
  /** `<dir>@<env>`, as the layers name it. */
  name: string;
  /** The chant project's directory, relative to the repo. */
  dir: string;
  /** The chant environment: `sql.profiles.<env>` binds its server. */
  env: string;
  /** The ApplyOp that applies it, by name. */
  op: string;
  target: SqlTarget;
  /** The build output the ApplyOp reads, relative to the project: its `output`, else `dist/schema.json`. */
  output: string;
}

const SKIP_DIRS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", ".terragucci", "dist"]);
const CONFIG_FILES = ["chant.config.ts", "chant.config.mts", "chant.config.js", "chant.config.mjs"];
const posix = (p: string): string => p.split("\\").join("/");

/** Whether a directory holds a chant project that uses the `sql` lexicon. */
export function isSqlProject(dir: string): boolean {
  for (const f of CONFIG_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    if (/\blexicons\s*:\s*\[[^\]]*["']sql["']/.test(text)) return true;
  }
  return false;
}

function walk(root: string, visit: (dir: string, names: string[]) => void): void {
  const go = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    visit(dir, names);
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      try {
        if (statSync(abs).isDirectory()) go(abs);
      } catch {
        /* gone */
      }
    }
  };
  go(root);
}

/** The text of an object literal starting at `open` (a `{`), braces balanced. */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const field = (body: string, key: string): string | undefined => new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(body)?.[1];

/** The ApplyOps in a project's Op files that apply to a database: name, environment and target, read without running them. */
export function applyOpsIn(projectDir: string): { op: string; env: string; target: SqlTarget; output: string }[] {
  const out: { op: string; env: string; target: SqlTarget; output: string }[] = [];
  walk(projectDir, (dir, names) => {
    for (const n of names) {
      if (!/\.op\.(ts|mts|js|mjs)$/.test(n)) continue;
      const text = readFileSync(join(dir, n), "utf-8");
      for (const m of text.matchAll(/\bApplyOp\s*\(\s*\{/g)) {
        const body = objectAt(text, m.index! + m[0].length - 1);
        const target = field(body, "target");
        const op = field(body, "name");
        const env = field(body, "env");
        if (op && env && (SQL_TARGETS as readonly string[]).includes(target ?? "")) out.push({ op, env, target: target as SqlTarget, output: field(body, "output") ?? "dist/schema.json" });
      }
    }
  });
  return out;
}

/** Every database unit in the repo, sorted by name. Two ApplyOps for one environment of one project are an error. */
export function findSqlUnits(repo: string): SqlUnit[] {
  const units = new Map<string, SqlUnit>();
  walk(repo, (dir) => {
    if (!isSqlProject(dir)) return;
    const rel = posix(relative(repo, dir)) || ".";
    for (const { op, env, target, output } of applyOpsIn(dir)) {
      const name = `${rel}@${env}`;
      const seen = units.get(name);
      if (seen && seen.op !== op) throw new Error(`${rel}: the ApplyOps ${seen.op} and ${op} both apply environment ${env}; a database unit needs one`);
      units.set(name, { name, dir: rel, env, op, target, output });
    }
  });
  return [...units.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The unit a layer names, when it names one: `<dir>@<env>` with that project and an ApplyOp for that environment on disk. */
export function sqlUnitOf(repo: string, name: string): SqlUnit | undefined {
  const at = name.lastIndexOf("@");
  if (at <= 0) return undefined;
  const dir = name.slice(0, at);
  const env = name.slice(at + 1);
  if (!env || !isSqlProject(join(repo, dir))) return undefined;
  const found = applyOpsIn(join(repo, dir)).find((o) => o.env === env);
  return found ? { name, dir, env, op: found.op, target: found.target, output: found.output } : undefined;
}

/** Whether a name in the layers is a database unit, from its shape alone: a directory can hold `@`, so this is for the pipeline's shell, not for dispatch. */
export const looksLikeSqlUnit = (name: string): boolean => name.lastIndexOf("@") > 0;

/** The layers with the database units added as the last layer: a schema applies after the roots that may create its server. */
export function withSqlUnits(layers: string[][], units: readonly SqlUnit[]): string[][] {
  return units.length === 0 ? layers : [...layers, units.map((u) => u.name)];
}

// ── running chant ────────────────────────────────────────────────────────────

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export type SqlExec = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<Ran>;

export const sqlExec: SqlExec = (file, args, { cwd, env }) =>
  new Promise((done) => {
    const child = spawn(file, args, { cwd, env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => done({ code: 127, stdout: "", stderr: e.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") }));
  });

export interface SqlRunOptions {
  env?: NodeJS.ProcessEnv;
  exec?: SqlExec;
}

/**
 * The chant command for a project: `TERRAGUCCI_CHANT` when set, else the
 * `chant` its node_modules (or the repo's, above it) installs. A project with
 * none gets `npm ci` (or `npm install` without a lock file) first.
 */
export async function chantFor(repo: string, unit: SqlUnit, o: SqlRunOptions = {}): Promise<string> {
  const env = o.env ?? process.env;
  if (env.TERRAGUCCI_CHANT) return env.TERRAGUCCI_CHANT;
  const top = resolve(repo);
  const find = (): string | undefined => {
    for (let d = resolve(repo, unit.dir); ; d = dirname(d)) {
      const bin = join(d, "node_modules", ".bin", "chant");
      if (existsSync(bin)) return bin;
      if (d === top || dirname(d) === d) return undefined;
    }
  };
  const found = find();
  if (found) return found;
  const dir = join(repo, unit.dir);
  const lock = existsSync(join(dir, "package-lock.json"));
  const r = await (o.exec ?? sqlExec)("npm", lock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], { cwd: dir, env });
  if (r.code !== 0) throw new Error(`npm ${lock ? "ci" : "install"} in ${unit.dir} failed:\n${tail(r.stderr || r.stdout)}`);
  const after = find();
  if (!after) throw new Error(`${unit.dir} installs no chant: add @intentius/chant and @intentius/chant-lexicon-sql to its package.json`);
  return after;
}

const tail = (s: string, n = 30): string => s.trim().split("\n").slice(-n).join("\n");
/** chant prints colour when it thinks it may; the stored text and the note do not want it. */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── plans ────────────────────────────────────────────────────────────────────

/** One classified change, as `chant sql plan --json` prints it in either dialect. */
export interface SqlChange {
  object: string;
  field: string;
  before?: string;
  after?: string;
  rule: string;
  class: string;
  destructive?: boolean;
  note?: string;
}

/** `chant sql plan --json`: ClickHouse names its refusals `rebuilds`, Postgres `refused`. */
export interface SqlDiff {
  changes: SqlChange[];
  hints?: string[];
  rebuilds?: SqlChange[];
  refused?: SqlChange[];
  rebuildOps?: unknown[];
  migrationOps?: unknown[];
}

/** `events (analytics.events)` is the export `events` for the object `analytics.events`; the object is the address. */
export const objectName = (label: string): string => /\(([^()]+)\)\s*$/.exec(label)?.[1] ?? label;

/** What a change does to its address, in Terraform's action words: a removed column destroys data, so it is a delete. */
export function changeActions(c: SqlChange): string[] {
  if (c.class === "create") return ["create"];
  if (c.class === "drop") return ["delete"];
  if (c.destructive) return c.after === undefined ? ["delete"] : ["delete", "create"];
  return ["update"];
}

/**
 * A classified change as a plan document in Terraform's JSON shape: one
 * resource change per classified change, addressed by the object and, for a
 * change to part of it, the field (`app.users.columns.email`). The type is the
 * dialect, and the change's class and rule ride in its `sql` block.
 */
export function sqlPlanDocument(diff: SqlDiff, target: SqlTarget): Record<string, unknown> {
  const resource_changes = diff.changes.map((c) => {
    const name = objectName(c.object);
    const whole = c.field === "object" || c.class === "create" || c.class === "drop";
    const address = whole ? name : `${name}.${c.field}`;
    const key = whole ? "definition" : c.field;
    const actions = changeActions(c);
    return {
      address,
      mode: "managed",
      type: target,
      name: address,
      provider_name: `chant/${target}`,
      change: {
        actions,
        before: actions[0] === "create" ? null : { [key]: c.before ?? null },
        after: actions.length === 1 && actions[0] === "delete" ? null : { [key]: c.after ?? null },
      },
      sql: { class: c.class, rule: c.rule, ...(c.destructive ? { destructive: true } : {}) },
    };
  });
  return { format_version: "1.2", planner: "chant sql plan", resource_changes };
}

/** The changes the server cannot make in place, and why the unit refuses them. Undefined when there are none. */
export function sqlRefusal(diff: SqlDiff, unit: SqlUnit): string | undefined {
  const refused = [...(diff.rebuilds ?? []), ...(diff.refused ?? [])];
  if (refused.length === 0) return undefined;
  const ops = diff.rebuildOps?.length ? "ClickHouseRebuildOp" : diff.migrationOps?.length ? "PostgresMigrationOp" : unit.target === "clickhouse" ? "ClickHouseRebuildOp" : "PostgresMigrationOp";
  const what = refused.map((c) => `${objectName(c.object)} ${c.field} (${c.rule})`).join(", ");
  return `${refused.length === 1 ? "a change needs" : `${refused.length} changes need`} more than an in-place change, which ${unit.op} does not make: ${what}. Run it as a ${ops}; chant sql plan prints the declaration. Nothing in ${unit.name} is applied while it stands.`;
}

export interface SqlPlanned {
  /** The plan document (sqlPlanDocument), when chant planned. */
  plan?: Record<string, unknown>;
  /** chant's text: each change with its class and rule. */
  text?: string;
  /** Why the unit did not plan, or why it refuses to apply what it planned. */
  error?: string;
  /** Set when the plan holds a change the server cannot make in place. */
  refused?: boolean;
  summary: string;
  changes: number;
  destroys: number;
}

/**
 * The project built as its ApplyOp builds it, so the plan and the apply read
 * the same declarations: `npm run build` when the project has a build script,
 * which writes the Op's output, else `chant build .` into it.
 */
async function buildUnit(chant: string, unit: SqlUnit, cwd: string, env: NodeJS.ProcessEnv, exec: SqlExec): Promise<{ out: string } | { error: string }> {
  const out = resolve(cwd, unit.output);
  let script = false;
  try {
    script = typeof (JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as { scripts?: Record<string, unknown> }).scripts?.build === "string";
  } catch {
    /* no package.json */
  }
  mkdirSync(dirname(out), { recursive: true });
  const r = script
    ? await exec("npm", ["run", "build", "--silent"], { cwd, env })
    : await exec(chant, ["build", ".", "--lexicon", "sql", "-o", out], { cwd, env });
  if (r.code !== 0 || !existsSync(out)) {
    return { error: `${script ? "npm run build" : "chant build"} failed${existsSync(out) ? "" : ` or wrote no ${unit.output}`}:\n${plain(tail(r.stderr || r.stdout))}` };
  }
  return { out };
}

/** The project built as its ApplyOp builds it, then `chant sql plan <env>` against the server its profile binds. */
export async function planSqlUnit(repo: string, unit: SqlUnit, work: string, o: SqlRunOptions = {}): Promise<SqlPlanned> {
  const env = o.env ?? process.env;
  const exec = o.exec ?? sqlExec;
  const cwd = join(repo, unit.dir);
  let chant: string;
  try {
    chant = await chantFor(repo, unit, o);
  } catch (e) {
    return { error: (e as Error).message, summary: "failed", changes: 0, destroys: 0 };
  }
  const built = await buildUnit(chant, unit, cwd, env, exec);
  if ("error" in built) return { error: built.error, summary: "failed", changes: 0, destroys: 0 };
  const out = built.out;
  const json = await exec(chant, ["sql", "plan", unit.env, out, "--json"], { cwd, env });
  let diff: SqlDiff;
  try {
    diff = JSON.parse(json.stdout) as SqlDiff;
  } catch {
    return { error: `chant sql plan ${unit.env} failed:\n${plain(tail(json.stderr || json.stdout))}`, summary: "failed", changes: 0, destroys: 0 };
  }
  if (json.code !== 0 && json.code !== 2) return { error: `chant sql plan ${unit.env} exited ${json.code}:\n${plain(tail(json.stderr))}`, summary: "failed", changes: 0, destroys: 0 };
  const shown = await exec(chant, ["sql", "plan", unit.env, out], { cwd, env });
  const text = plain(shown.stdout).replace(/^.*\n\n?/, "");
  const plan = sqlPlanDocument(diff, unit.target);
  const changes = diff.changes.length;
  const destroys = (plan.resource_changes as { change: { actions: string[] } }[]).filter((r) => r.change.actions.includes("delete")).length;
  const refusal = sqlRefusal(diff, unit);
  const summary = changes === 0 ? "No changes." : `${changes} change${changes === 1 ? "" : "s"}${destroys ? `, ${destroys} destroying data` : ""}${refusal ? ", refused" : ""}`;
  return { plan, text, summary, changes, destroys, ...(refusal ? { error: refusal, refused: true } : {}) };
}

// ── apply ────────────────────────────────────────────────────────────────────

/** chant's exit code for a run that stopped at a gate nobody approved. */
const CHANT_GATED = 3;

/** Run the unit's ApplyOp. The wave's gate has already let the plan through; the Op's own plan is the one it applies. */
export async function applySqlUnit(repo: string, unit: SqlUnit, o: SqlRunOptions = {}): Promise<{ ok: boolean; output: string }> {
  const env = o.env ?? process.env;
  let chant: string;
  try {
    chant = await chantFor(repo, unit, o);
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
  const r = await (o.exec ?? sqlExec)(chant, ["run", unit.op], { cwd: join(repo, unit.dir), env });
  const output = plain(`${r.stdout}${r.stderr}`);
  if (r.code === CHANT_GATED) {
    return { ok: false, output: `${unit.op} stopped at an approval gate of its own. The wave's gate is the approval here, so declare the ApplyOp without one.\n${tail(output)}` };
  }
  return { ok: r.code === 0, output };
}

// ── drift ────────────────────────────────────────────────────────────────────

interface LifecycleDiff {
  lexicons?: Record<string, {
    resources?: { missing?: string[] };
    observed?: Record<string, { type?: string; physicalId?: string; ownership?: string }>;
    deep?: { drifted?: { name: string; type?: string; changes?: { path: string; kind?: string; declared?: unknown; live?: unknown }[] }[] };
  }>;
}

/**
 * `chant lifecycle diff --json` as a refresh-only plan document: each owned
 * object changed out of band is an update of what changed, from what was
 * declared to what is live, and each declared object gone from the server a
 * delete. An object the project does not own reports nothing.
 */
export function sqlDriftDocument(diff: LifecycleDiff, target: SqlTarget): Record<string, unknown> {
  const sql = diff.lexicons?.sql ?? {};
  const drift: Record<string, unknown>[] = [];
  for (const name of sql.resources?.missing ?? []) {
    drift.push({ address: name, mode: "managed", type: target, name, provider_name: `chant/${target}`, change: { actions: ["delete"], before: { name }, after: null } });
  }
  for (const d of sql.deep?.drifted ?? []) {
    for (const c of d.changes ?? []) {
      const address = `${d.name}.${c.path}`;
      drift.push({
        address, mode: "managed", type: target, name: address, provider_name: `chant/${target}`,
        change: { actions: ["update"], before: { name: d.name, [c.path]: c.declared ?? null }, after: { name: d.name, [c.path]: c.live ?? null } },
      });
    }
  }
  return { format_version: "1.2", planner: "chant lifecycle diff", resource_changes: [], resource_drift: drift };
}

/** Read a unit's drift: `chant lifecycle diff <env> --live --json` in its project. */
export async function driftSqlUnit(repo: string, unit: SqlUnit, o: SqlRunOptions = {}): Promise<{ plan?: Record<string, unknown>; text?: string; error?: string }> {
  const env = o.env ?? process.env;
  let chant: string;
  try {
    chant = await chantFor(repo, unit, o);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const r = await (o.exec ?? sqlExec)(chant, ["lifecycle", "diff", unit.env, "--live", "--json"], { cwd: join(repo, unit.dir), env });
  let diff: LifecycleDiff;
  try {
    diff = JSON.parse(r.stdout) as LifecycleDiff;
  } catch {
    return { error: `chant lifecycle diff ${unit.env} --live failed:\n${plain(tail(r.stderr || r.stdout))}` };
  }
  const plan = sqlDriftDocument(diff, unit.target);
  const drifted = (plan.resource_drift as { address: string; change: { actions: string[]; before: Record<string, unknown> | null; after: Record<string, unknown> | null } }[]);
  const text = drifted.length === 0
    ? "No drift."
    : drifted.map((d) => (d.change.actions[0] === "delete" ? `${d.address}: declared, and gone from the server` : `${d.address}: ${JSON.stringify(Object.values(d.change.before ?? {})[1])} declared, ${JSON.stringify(Object.values(d.change.after ?? {})[1])} live`)).join("\n");
  return { plan, text: text + "\n" };
}
