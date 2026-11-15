/**
 * `terragucci pin modules`: turn the version constraints in a repository's
 * module calls into exact pins, as a rollout.
 *
 * A hand-written repository mostly says `version = "~> 5.0"`. `terragucci
 * rollout` moves an exact pin and refuses a constraint, so those roots never
 * join one. This command reads the version each root runs, writes it where
 * the constraint was, and opens the change as a rollout whose `from` is the
 * constraint and whose `to` is that version. A pin that is the version the
 * root already runs changes nothing, so each wave's plan shows no changes,
 * and that is the proof.
 *
 * The version a root runs comes from, in order:
 *
 *   1. `.terraform/modules/modules.json` in the root, which `init` wrote
 *      (the file the versions report records from);
 *   2. `init -backend=false` in the root, when there is none (`init: false`
 *      skips it);
 *   3. `lookup`, when given: the newest version of the module the constraint
 *      allows. A caller that has no init state passes the registry's answer;
 *      tests pass a fixed one, so nothing here reaches the network on its own.
 *
 * Whatever the source, the version has to satisfy the constraint it replaces.
 *
 * The rollout does the rest. One rollout runs for each module, constraint and
 * resolved version, limited to the roots that resolved to it, because two
 * roots under one constraint can run different releases. Calls in reusable
 * modules are left alone: only roots are read, and a minimum version is the
 * usual advice there.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { checkMode, ConfigError, findConfig, loadConfig, resolveRepo } from "./config";
import { detectBinary, findRoots } from "./detect";
import { rootVersions } from "./report/versions";
import { loadHclParser } from "./rollout/parser";
import { rollout, rolloutExit, describeRollout, type RolloutOptions, type RolloutResult } from "./rollout";
import { detectShape } from "./shape";
import { compareSemver, parseSemver, type Semver } from "./publish/semver";
import { registryVersions } from "./publish/registry";

export interface PinModulesOptions {
  /** `dry-run` (the default) plans the waves and opens nothing; `apply` opens the next wave's pull requests. */
  mode?: "dry-run" | "apply";
  /** Print the table and stop: no waves are planned, so no forge is asked. */
  tableOnly?: boolean;
  config?: string;
  /** Limit to the roots under this directory or equal to it. */
  root?: string;
  parser?: Hcl2Json;
  /** Run `init -backend=false` for a root with no init state. Default true. */
  init?: boolean;
  /** For tests: runs init in a root. Default: the project's binary. */
  runInit?: (dir: string, binary: string) => void;
  /** The newest version of `source` that `constraint` allows. Called only for a call init state did not answer. */
  lookup?: (source: string, constraint: string) => Promise<string | undefined>;
  /** Passed to each rollout: the forge, fetch, env and the rest. */
  rollout?: Pick<RolloutOptions, "fetch" | "env" | "forge" | "registryFetch" | "locker">;
}

export type PinRowState = "pin" | "unresolved" | "no-version" | "skipped";

/** One module call, as the table lists it. */
export interface PinRow {
  root: string;
  call: string;
  /** The module's source. */
  module: string;
  /** The constraint written in the call. Absent for a call with no `version`. */
  range?: string;
  /** The version the root runs. */
  version?: string;
  /** Where it came from: `init state`, `init` or `lookup`. */
  from?: string;
  state: PinRowState;
  reason?: string;
}

export interface PinModulesResult {
  mode: "dry-run" | "apply";
  rows: PinRow[];
  /** One rollout for each module, constraint and version that has roots to pin. Empty with `tableOnly`. */
  rollouts: RolloutResult[];
}

// ── constraints ──────────────────────────────────────────────────────────────

type Parts = [number, number, number];

function parts(text: string): { v: Parts; given: number } | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return undefined;
  return { v: [+m[1]!, +(m[2] ?? 0), +(m[3] ?? 0)], given: m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1 };
}

const cmp = (a: Parts, b: Parts): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a release satisfies a module `version` constraint: clauses joined
 * by commas, each `=`, `!=`, `>`, `>=`, `<`, `<=` or `~>` with a version.
 * Undefined when the constraint is not one this reads.
 */
export function satisfies(version: string, constraint: string): boolean | undefined {
  const at = parts(version);
  if (!at) return undefined;
  let all = true;
  for (const clause of constraint.split(",")) {
    const m = /^\s*(=|!=|>=|<=|>|<|~>)?\s*(\S+)\s*$/.exec(clause);
    const want = m ? parts(m[2]!) : undefined;
    if (!m || !want) return undefined;
    const op = m[1] ?? "=";
    const c = cmp(at.v, want.v);
    let ok: boolean;
    if (op === "=") ok = c === 0;
    else if (op === "!=") ok = c !== 0;
    else if (op === ">") ok = c > 0;
    else if (op === ">=") ok = c >= 0;
    else if (op === "<") ok = c < 0;
    else if (op === "<=") ok = c <= 0;
    else {
      // `~> 1.2` allows the rightmost given part to rise: below 2.0.0; `~> 1.2.3` below 1.3.0; `~> 1` below 2.0.0.
      const top: Parts = want.given >= 3 ? [want.v[0], want.v[1] + 1, 0] : [want.v[0] + 1, 0, 0];
      ok = c >= 0 && cmp(at.v, top) < 0;
    }
    all = all && ok;
  }
  return all;
}

/** A lookup that asks the module registry for the source's releases and takes the newest the constraint allows. */
export function registryLookup(fetchFn?: Parameters<typeof registryVersions>[1]): NonNullable<PinModulesOptions["lookup"]> {
  return async (source, constraint) => {
    let best: Semver | undefined;
    for (const v of await registryVersions(source, fetchFn)) {
      const s = parseSemver(v);
      if (s && satisfies(v, constraint) === true && (!best || compareSemver(s, best) > 0)) best = s;
    }
    return best ? `${best.major}.${best.minor}.${best.patch}` : undefined;
  };
}

// ── reading the roots ────────────────────────────────────────────────────────

const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

interface Call {
  root: string;
  call: string;
  source: string;
  range?: string;
  skipped?: string;
}

async function callsOf(repo: string, root: string, parser: Hcl2Json): Promise<Call[]> {
  const dir = join(repo, root);
  const out: Call[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tf")).sort()) {
    const file = root === "." ? f : posix.join(root, f);
    const tree = (await parser.parse(file, readFileSync(join(dir, f), "utf-8"))) as Record<string, unknown>;
    for (const [name, bodies] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
      for (const body of bodies) {
        if (typeof body.source !== "string" || isLocal(body.source)) continue;
        const version = typeof body.version === "string" ? body.version : undefined;
        const pin = readModulePin(body.source, version);
        const call = `module.${name}`;
        if (pin.pin !== null) continue;
        if (version !== undefined && pin.at === "version" && /is a constraint/.test(pin.unpinned ?? "")) out.push({ root, call, source: body.source, range: version });
        else if (version === undefined && pin.at === "source" && /no version argument/.test(pin.unpinned ?? "")) out.push({ root, call, source: body.source });
        else out.push({ root, call, source: body.source, ...(version !== undefined ? { range: version } : {}), skipped: pin.unpinned ?? "no pin to read" });
      }
    }
  }
  return out;
}

function initRoot(dir: string, binary: string): void {
  const run = spawnSync(binary, ["init", "-backend=false", "-input=false", "-no-color"], { cwd: dir, encoding: "utf-8" });
  if (run.status !== 0) throw new Error(`${binary} init -backend=false failed in ${dir}: ${(run.stderr || run.stdout || String(run.error)).trim().split("\n").pop()}`);
}

/** The calls of every root, each with the version its root runs. */
export async function readPins(repo: string, roots: string[], options: Pick<PinModulesOptions, "init" | "runInit" | "lookup"> & { parser: Hcl2Json; binary: string; env?: NodeJS.ProcessEnv }): Promise<PinRow[]> {
  const rows: PinRow[] = [];
  for (const root of roots) {
    const calls = await callsOf(repo, root, options.parser);
    if (calls.length === 0) continue;
    const dir = join(repo, root);
    const manifest = () => (options.env?.TF_DATA_DIR ? (isAbsolute(options.env.TF_DATA_DIR) ? options.env.TF_DATA_DIR : join(dir, options.env.TF_DATA_DIR)) : join(dir, ".terraform"));
    let how = "init state";
    let known = rootVersions(dir, options.env).modules;
    let initFailed: string | undefined;
    const wanting = calls.filter((c) => !c.skipped);
    const missing = () => wanting.some((c) => !known.find((k) => k.call === c.call && k.version));
    if (missing() && options.init !== false && !existsSync(join(manifest(), "modules", "modules.json"))) {
      try {
        (options.runInit ?? initRoot)(dir, options.binary);
        known = rootVersions(dir, options.env).modules;
        how = "init";
      } catch (e) {
        initFailed = (e as Error).message;
      }
    }
    for (const c of calls) {
      const base = { root: c.root, call: c.call, module: c.source, ...(c.range !== undefined ? { range: c.range } : {}) };
      if (c.skipped) {
        rows.push({ ...base, state: "skipped", reason: c.skipped });
        continue;
      }
      let version = known.find((k) => k.call === c.call)?.version;
      let from = how;
      if (!version && c.range !== undefined && options.lookup) {
        version = await options.lookup(c.source, c.range);
        from = "lookup";
      }
      if (!version) {
        rows.push({ ...base, state: "unresolved", reason: initFailed ?? `no version recorded for it in ${root === "." ? "" : `${root}/`}.terraform/modules/modules.json; run init there` });
        continue;
      }
      if (c.range === undefined) {
        // Nothing to move from: the table shows what the call runs, and a pin is the person's to add.
        rows.push({ ...base, version, from, state: "no-version", reason: "the call has no version argument, so there is no constraint to rewrite" });
        continue;
      }
      if (satisfies(version, c.range) === false) {
        rows.push({ ...base, version, from, state: "unresolved", reason: `${from} holds ${version}, which "${c.range}" does not allow; run init again` });
        continue;
      }
      rows.push({ ...base, version, from, state: "pin" });
    }
  }
  return rows;
}

// ── the command ──────────────────────────────────────────────────────────────

interface Group {
  module: string;
  range: string;
  version: string;
  roots: string[];
}

/** One group per module, constraint and version; a root whose calls of one module and constraint ran different versions drops out of the pin. */
export function groupPins(rows: PinRow[]): { groups: Group[]; conflicts: PinRow[] } {
  const byKey = new Map<string, PinRow[]>();
  for (const r of rows.filter((r) => r.state === "pin")) byKey.set(JSON.stringify([r.root, r.module, r.range]), [...(byKey.get(JSON.stringify([r.root, r.module, r.range])) ?? []), r]);
  const groups = new Map<string, Group>();
  const conflicts: PinRow[] = [];
  for (const list of byKey.values()) {
    if (new Set(list.map((r) => r.version)).size > 1) {
      for (const r of list) {
        r.state = "unresolved";
        r.reason = `its calls of ${r.module} under "${r.range}" ran different versions`;
        conflicts.push(r);
      }
      continue;
    }
    const r = list[0]!;
    const id = JSON.stringify([r.module, r.range, r.version]);
    const g = groups.get(id) ?? { module: r.module, range: r.range!, version: r.version!, roots: [] };
    if (!g.roots.includes(r.root)) g.roots.push(r.root);
    groups.set(id, g);
  }
  return { groups: [...groups.values()].sort((a, b) => (a.module + a.range + a.version).localeCompare(b.module + b.range + b.version)), conflicts };
}

export async function pinModules(cwd: string, options: PinModulesOptions = {}): Promise<PinModulesResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new ConfigError("terragucci pin modules runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  if (config.projects) throw new ConfigError("terragucci pin modules reads the init state of one checkout, so it runs in a repository with its roots, not a control repository");
  const settings = resolveRepo(config);
  const refused = detectShape(repo, settings).refuses("rollouts");
  if (refused) throw new ConfigError(`terragucci pin modules: ${refused}`);

  const parser = options.parser ?? (await loadHclParser("terragucci pin modules reads module calls"));
  let roots = findRoots(repo, settings.roots);
  if (options.root) {
    const under = options.root.replace(/^\.\//, "").replace(/\/+$/, "");
    roots = roots.filter((r) => r === under || r.startsWith(`${under}/`) || under === ".");
  }
  const binary = settings.binary ?? detectBinary(repo, roots).value;
  const rows = await readPins(repo, roots, { init: options.init, runInit: options.runInit, lookup: options.lookup, parser, binary, env: (options.rollout?.env ?? process.env) as NodeJS.ProcessEnv });
  const { groups } = groupPins(rows);

  const rollouts: RolloutResult[] = [];
  if (!options.tableOnly) {
    for (const g of groups) {
      rollouts.push(await rollout(repo, { ...options.rollout, kind: "module", name: g.module, from: g.range, to: g.version, only: g.roots, mode, ...(options.config ? { config: options.config } : {}), parser }));
    }
  }
  const order: Record<PinRowState, number> = { pin: 0, "no-version": 1, unresolved: 2, skipped: 3 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.root.localeCompare(b.root) || a.call.localeCompare(b.call));
  return { mode, rows, rollouts };
}

/** 0 when every rollout ran or finished, 1 when one stopped, 3 when one waits. */
export function pinExit(result: PinModulesResult): number {
  return result.rollouts.reduce((code, r) => Math.max(code, rolloutExit(r)), 0);
}

export function describePins(result: PinModulesResult): string {
  if (result.rows.length === 0) return "no module call in a root names a version constraint";
  const header = ["root", "call", "module", "range", "resolved", "state"];
  const cells = result.rows.map((r) => [r.root, r.call, r.module, r.range ?? "(none)", r.version ?? "-", r.state === "pin" ? "pin" : `${r.state}: ${r.reason}`]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((x, i) => (i < c.length - 1 ? x.padEnd(widths[i]!) : x)).join("  ").trimEnd();
  const pins = result.rows.filter((r) => r.state === "pin").length;
  const lines = [line(header), ...cells.map(line), "", `${pins} of ${result.rows.length} calls pinned${result.rollouts.length > 0 ? `, as ${result.rollouts.length} rollout${result.rollouts.length === 1 ? "" : "s"}` : ""}`];
  for (const r of result.rollouts) lines.push("", describeRollout(r));
  return lines.join("\n");
}

/** `terragucci pin modules` arguments as options. */
export function pinModulesArgs(args: string[], flags: Record<string, string | true>, lookup?: PinModulesOptions["lookup"]): PinModulesOptions {
  const value = (k: string): string | undefined => {
    const v = flags[k];
    if (v === true) throw new ConfigError(`--${k} needs a value`);
    return v;
  };
  if (args[0] !== "modules" || args.length !== 1) throw new ConfigError("usage: terragucci pin modules [--root <dir>] [--dry-run] [--mode dry-run|apply] [--no-init] [--lookup] [--config <file>]");
  return {
    mode: checkMode(value("mode") ?? "dry-run"),
    tableOnly: flags["dry-run"] === true,
    ...(value("config") ? { config: value("config") } : {}),
    ...(value("root") ? { root: value("root") } : {}),
    ...(flags["no-init"] === true ? { init: false } : {}),
    ...(flags.lookup === true && lookup ? { lookup } : {}),
  };
}
