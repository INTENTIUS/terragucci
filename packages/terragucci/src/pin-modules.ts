/**
 * `terragucci pin modules` (and `--providers`, or `pin providers`): turn the
 * version constraints in a repository's module calls and `required_providers`
 * entries into exact pins, as a rollout.
 *
 * A hand-written repository mostly says `version = "~> 5.0"`. `terragucci
 * rollout` moves an exact pin and refuses a constraint, so those roots never
 * join one. This command reads the version each root runs, writes it where
 * the constraint was, and opens the change as a rollout whose `from` is the
 * constraint and whose `to` is that version. A call or entry with no
 * `version` gains one, with the placeholder `(none)` as its `from`. A pin that is the version the
 * root already runs changes nothing, so each wave's plan shows no changes,
 * and that is the proof.
 *
 * The version a root runs comes from, in order:
 *
 *   1. what `init` left in the root: `.terraform/modules/modules.json` for a
 *      module call, `.terraform.lock.hcl` for a provider (the files the
 *      versions report records from);
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
import { exactVersion, readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { checkMode, ConfigError, findConfig, loadConfig, resolveRepo } from "./config";
import { detectBinary, findRoots } from "./detect";
import { rootVersions } from "./report/versions";
import { LOCK_FILE } from "./rollout/lock";
import { loadHclParser } from "./rollout/parser";
import { rollout, rolloutExit, describeRollout, type RolloutOptions, type RolloutResult } from "./rollout";
import { namesProvider } from "./rollout/lock";
import { isUnversionedRegistry, pinProviderRange, pinRange, providerEntries, providerKey, UNVERSIONED } from "./rollout/range";
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
  /** The newest version of a module's `source`, or a provider's address, that `constraint` allows. Called only for what init state did not answer. */
  lookup?: (source: string, constraint: string, kind: PinKind) => Promise<string | undefined>;
  /** With no `lookup`: ask the module and provider registries, as `--lookup` does. */
  registry?: boolean;
  /** What to pin. Default: modules. */
  kinds?: PinKind[];
  /** Passed to each rollout: the forge, fetch, env and the rest. */
  rollout?: Pick<RolloutOptions, "fetch" | "env" | "forge" | "registryFetch" | "locker">;
}

export type PinKind = "module" | "provider";

export type PinRowState = "pin" | "unresolved" | "unpinned";

/** One module call or provider entry, as the table lists it. */
export interface PinRow {
  kind: PinKind;
  root: string;
  /** `module.<name>` or `provider.<local name>`. */
  call: string;
  /** The module's source, or the provider's address. */
  module: string;
  /** The constraint written in it, or `(none)` when it has no `version`. */
  range?: string;
  /** The version the root runs. */
  version?: string;
  /** Where it came from: `init state`, `init` or `lookup`. */
  from?: string;
  /** `pin`: it will be pinned. `unresolved`: no version was found for it. `unpinned`: a version is known and the call is left as written, and `reason` says why. */
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
export function registryLookup(binary?: string, fetchFn?: Parameters<typeof registryVersions>[1]): NonNullable<PinModulesOptions["lookup"]> {
  return async (source, constraint, kind) => {
    let best: Semver | undefined;
    let versions: string[];
    if (kind === "module") versions = await registryVersions(source, fetchFn);
    else {
      // The registry the root's binary reads: OpenTofu's, or HashiCorp's for terraform.
      const host = binary === "terraform" ? "registry.terraform.io" : "registry.opentofu.org";
      const res = await fetch(`https://${host}/v1/providers/${providerKey(source)}/versions`);
      versions = res.ok ? (((await res.json()) as { versions?: Array<{ version?: string }> }).versions ?? []).flatMap((v) => (v.version ? [v.version] : [])) : [];
    }
    for (const v of versions) {
      const s = parseSemver(v);
      if (s && satisfies(v, constraint) === true && (!best || compareSemver(s, best) > 0)) best = s;
    }
    return best ? `${best.major}.${best.minor}.${best.patch}` : undefined;
  };
}

// ── reading the roots ────────────────────────────────────────────────────────

const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

interface Found {
  kind: PinKind;
  root: string;
  call: string;
  /** The module's source, or the provider's key. */
  source: string;
  file: string;
  /** The constraint as written, or `UNVERSIONED`. */
  range?: string;
  /** Why the call is left as written. */
  skipped?: string;
}

async function modulesOf(repo: string, root: string, parser: Hcl2Json): Promise<Found[]> {
  const dir = join(repo, root);
  const out: Found[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tf")).sort()) {
    const file = root === "." ? f : posix.join(root, f);
    const tree = (await parser.parse(file, readFileSync(join(dir, f), "utf-8"))) as Record<string, unknown>;
    for (const [name, bodies] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
      for (const body of bodies) {
        if (typeof body.source !== "string" || isLocal(body.source)) continue;
        const version = typeof body.version === "string" ? body.version : undefined;
        const pin = readModulePin(body.source, version);
        const base = { kind: "module" as const, root, call: `module.${name}`, source: body.source, file };
        if (pin.pin !== null) continue;
        if (version !== undefined && pin.at === "version" && /is a constraint/.test(pin.unpinned ?? "")) out.push({ ...base, range: version });
        else if (isUnversionedRegistry(body.source, version)) out.push({ ...base, range: UNVERSIONED });
        else out.push({ ...base, ...(version !== undefined ? { range: version } : {}), skipped: pin.unpinned ?? "no pin to read" });
      }
    }
  }
  return out;
}

async function providersOf(repo: string, root: string, parser: Hcl2Json): Promise<Found[]> {
  const out: Found[] = [];
  for (const e of await providerEntries(repo, root, undefined, parser)) {
    if (e.version !== undefined && exactVersion(e.version) !== null) continue;
    out.push({ kind: "provider", root, call: `provider.${e.name}`, source: e.provider, file: e.file, range: e.version ?? UNVERSIONED });
  }
  return out;
}

function initRoot(dir: string, binary: string): void {
  const run = spawnSync(binary, ["init", "-backend=false", "-input=false", "-no-color"], { cwd: dir, encoding: "utf-8" });
  if (run.status !== 0) throw new Error(`${binary} init -backend=false failed in ${dir}: ${(run.stderr || run.stdout || String(run.error)).trim().split("\n").pop()}`);
}

/** Why the edit that pins one found call would not go through, or undefined when it would. Nothing is written. */
async function placeable(repo: string, f: Found, to: string, parser: Hcl2Json): Promise<string | undefined> {
  try {
    const text = readFileSync(join(repo, f.file), "utf-8");
    const edit = f.kind === "module" ? await pinRange(text, f.file, { module: f.source, from: f.range!, to }, parser) : await pinProviderRange(text, f.file, { provider: f.source, from: f.range!, to }, parser);
    const mine = edit.calls.find((c) => c.call === f.call);
    return mine?.outcome === "moved" ? undefined : (mine?.reason ?? "the edit does not reach it");
  } catch (e) {
    return (e as Error).message;
  }
}

/** The module calls and provider entries of every root, each with the version its root runs. */
export async function readPins(
  repo: string,
  roots: string[],
  options: Pick<PinModulesOptions, "init" | "runInit" | "lookup"> & { parser: Hcl2Json; binary: string; env?: NodeJS.ProcessEnv; kinds?: PinKind[] },
): Promise<PinRow[]> {
  const kinds = options.kinds ?? ["module"];
  const rows: PinRow[] = [];
  for (const root of roots) {
    const found = [...(kinds.includes("module") ? await modulesOf(repo, root, options.parser) : []), ...(kinds.includes("provider") ? await providersOf(repo, root, options.parser) : [])];
    if (found.length === 0) continue;
    const dir = join(repo, root);
    const data = options.env?.TF_DATA_DIR ? (isAbsolute(options.env.TF_DATA_DIR) ? options.env.TF_DATA_DIR : join(dir, options.env.TF_DATA_DIR)) : join(dir, ".terraform");
    const read = () => rootVersions(dir, options.env);
    let how = "init state";
    let known = read();
    let initFailed: string | undefined;
    const wanting = found.filter((c) => !c.skipped);
    const have = (c: Found) => (c.kind === "module" ? known.modules.find((k) => k.call === c.call)?.version : known.providers.find((k) => namesProvider(k.provider, c.source))?.version);
    const needInit = wanting.some((c) => !have(c) && !existsSync(c.kind === "module" ? join(data, "modules", "modules.json") : join(dir, LOCK_FILE)));
    if (needInit && options.init !== false) {
      try {
        (options.runInit ?? initRoot)(dir, options.binary);
        known = read();
        how = "init";
      } catch (e) {
        initFailed = (e as Error).message;
      }
    }
    for (const c of found) {
      const base = { kind: c.kind, root: c.root, call: c.call, module: c.source, ...(c.range !== undefined ? { range: c.range } : {}) };
      if (c.skipped) {
        rows.push({ ...base, state: "unpinned", reason: c.skipped });
        continue;
      }
      let version = have(c);
      let from = how;
      if (!version && options.lookup) {
        version = await options.lookup(c.source, c.range === UNVERSIONED ? ">= 0.0.0" : c.range!, c.kind);
        from = "lookup";
      }
      if (!version) {
        const where = `${root === "." ? "" : `${root}/`}${c.kind === "module" ? ".terraform/modules/modules.json" : LOCK_FILE}`;
        rows.push({ ...base, state: "unresolved", reason: initFailed ?? `no version recorded for it in ${where}; run init there` });
        continue;
      }
      if (c.range !== UNVERSIONED && satisfies(version, c.range!) === false) {
        rows.push({ ...base, version, from, state: "unresolved", reason: `${from} holds ${version}, which "${c.range}" does not allow; run init again` });
        continue;
      }
      const why = await placeable(repo, c, version, options.parser);
      if (why) rows.push({ ...base, version, from, state: "unpinned", reason: why });
      else rows.push({ ...base, version, from, state: "pin" });
    }
  }
  return rows;
}

// ── the command ──────────────────────────────────────────────────────────────

interface Group {
  kind: PinKind;
  module: string;
  range: string;
  version: string;
  roots: string[];
}

/**
 * One group per module or provider, constraint and version. A root that
 * carries one module or provider under different constraints, or whose calls
 * of it ran different versions, is out of every group, and so is a root where
 * another call of the same module or provider cannot be edited: the rollout
 * moves all of a root's calls of it or none.
 */
export function groupPins(rows: PinRow[]): { groups: Group[] } {
  const byKey = new Map<string, PinRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.kind, r.root, r.module]);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const groups = new Map<string, Group>();
  for (const list of byKey.values()) {
    const pins = list.filter((r) => r.state === "pin");
    if (pins.length === 0) continue;
    const r = pins[0]!;
    const blocked = list.find((x) => x.state === "unpinned");
    const reason = new Set(list.map((x) => x.range)).size > 1
      ? `its calls of ${r.module} carry different constraints; pin them by hand to one`
      : new Set(pins.map((x) => x.version)).size > 1
        ? `its calls of ${r.module} under "${r.range}" ran different versions`
        : blocked
          ? `another call of ${r.module} in this root cannot be edited (${blocked.reason}), and a rollout moves all of a root's calls or none`
          : undefined;
    if (reason) {
      for (const x of pins) {
        x.state = "unpinned";
        x.reason = reason;
      }
      continue;
    }
    const id = JSON.stringify([r.kind, r.module, r.range, r.version]);
    const g = groups.get(id) ?? { kind: r.kind, module: r.module, range: r.range!, version: r.version!, roots: [] };
    if (!g.roots.includes(r.root)) g.roots.push(r.root);
    groups.set(id, g);
  }
  return { groups: [...groups.values()].sort((a, b) => (a.kind + a.module + a.range + a.version).localeCompare(b.kind + b.module + b.range + b.version)) };
}

export async function pinModules(cwd: string, options: PinModulesOptions = {}): Promise<PinModulesResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new ConfigError("terragucci pin runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  if (config.projects) throw new ConfigError("terragucci pin reads the init state of one checkout, so it runs in a repository with its roots, not a control repository");
  const settings = resolveRepo(config);
  const refused = detectShape(repo, settings).refuses("rollouts");
  if (refused) throw new ConfigError(`terragucci pin: ${refused}`);

  const parser = options.parser ?? (await loadHclParser("terragucci pin reads module calls and providers"));
  let roots = findRoots(repo, settings.roots);
  if (options.root) {
    const under = options.root.replace(/^\.\//, "").replace(/\/+$/, "");
    roots = roots.filter((r) => r === under || r.startsWith(`${under}/`) || under === ".");
  }
  const binary = settings.binary ?? detectBinary(repo, roots).value;
  const lookup = options.lookup ?? (options.registry ? registryLookup(binary) : undefined);
  const rows = await readPins(repo, roots, { init: options.init, runInit: options.runInit, lookup, parser, binary, env: (options.rollout?.env ?? process.env) as NodeJS.ProcessEnv, kinds: options.kinds });
  const { groups } = groupPins(rows);

  const rollouts: RolloutResult[] = [];
  if (!options.tableOnly) {
    for (const g of groups) {
      rollouts.push(await rollout(repo, { ...options.rollout, kind: g.kind, name: g.module, from: g.range, to: g.version, only: g.roots, mode, ...(options.config ? { config: options.config } : {}), parser }));
    }
  }
  const order: Record<PinRowState, number> = { pin: 0, unpinned: 1, unresolved: 2 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.root.localeCompare(b.root) || a.call.localeCompare(b.call));
  return { mode, rows, rollouts };
}

/** 0 when every rollout ran or finished, 1 when one stopped, 3 when one waits. */
export function pinExit(result: PinModulesResult): number {
  return result.rollouts.reduce((code, r) => Math.max(code, rolloutExit(r)), 0);
}

export function describePins(result: PinModulesResult): string {
  if (result.rows.length === 0) return "no module call or provider entry in a root names a version constraint or lacks a version";
  const header = ["root", "call", "module or provider", "range", "resolved", "state"];
  const cells = result.rows.map((r) => [r.root, r.call, r.module, r.range ?? "(none)", r.version ?? "-", r.state === "pin" ? "pin" : `${r.state}: ${r.reason}`]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((x, i) => (i < c.length - 1 ? x.padEnd(widths[i]!) : x)).join("  ").trimEnd();
  const pins = result.rows.filter((r) => r.state === "pin").length;
  const lines = [line(header), ...cells.map(line), "", `${pins} of ${result.rows.length} pinned${result.rollouts.length > 0 ? `, as ${result.rollouts.length} rollout${result.rollouts.length === 1 ? "" : "s"}` : ""}`];
  for (const r of result.rollouts) lines.push("", describeRollout(r));
  return lines.join("\n");
}

const PIN_USAGE = "usage: terragucci pin modules [--providers] | pin providers [--root <dir>] [--dry-run] [--mode dry-run|apply] [--no-init] [--lookup] [--config <file>]";

/** `terragucci pin modules|providers` arguments as options. */
export function pinModulesArgs(args: string[], flags: Record<string, string | true>): PinModulesOptions {
  const value = (k: string): string | undefined => {
    const v = flags[k];
    if (v === true) throw new ConfigError(`--${k} needs a value`);
    return v;
  };
  if (args.length !== 1 || !["modules", "providers"].includes(args[0]!)) throw new ConfigError(PIN_USAGE);
  const kinds: PinKind[] = args[0] === "providers" ? ["provider"] : flags.providers === true ? ["module", "provider"] : ["module"];
  return {
    mode: checkMode(value("mode") ?? "dry-run"),
    tableOnly: flags["dry-run"] === true,
    kinds,
    ...(value("config") ? { config: value("config") } : {}),
    ...(value("root") ? { root: value("root") } : {}),
    ...(flags["no-init"] === true ? { init: false } : {}),
    ...(flags.lookup === true ? { registry: true } : {}),
  };
}
