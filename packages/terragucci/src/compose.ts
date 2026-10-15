/**
 * The composed run (`waves.compose: true`), opt-in beside the waves: the
 * plain roots a change reaches, and the roots they read, plan as one plan and
 * apply as one apply of the stock binary, each root a module of a temporary
 * root. A value one root reads from another that is unknown at plan time is
 * then computed in the same apply, after the resources that make it, rather
 * than in a later wave that plans again.
 *
 * Without the key nothing here runs, and the waves are as they were: one run
 * per root, its own state, applied in dependency order.
 *
 * Each root keeps its own state. The run takes each root's backend lock the
 * way a state migration takes it (./migrate.ts), pulls each state and moves
 * it under its module's address in one working state, plans, and once the
 * gate lets it through applies the saved plan. Whether the apply finished or
 * failed, it splits the working state back by module address and writes each
 * root's state with what applied to it, then releases each lock. Nothing
 * about this is atomic: a failure leaves what applied applied, and each
 * state says so. A state whose write still fails after the retries is kept
 * beside the state in its own backend (`<key>.terragucci-unwritten`), its
 * lock still held, and the next run writes it before it plans anything.
 *
 * A change applies in waves as without the key, and the note says why, when
 * the set has more roots than `waves.compose_max`, is one root, or holds
 * roots one binary process cannot run together (compositionFor's checks).
 *
 * The composed root is built in the checkout, as the linked plan rewrites a
 * root in place (./linked.ts): `.terragucci-compose/main.tf` holds one module
 * block per root, and each root's backend block, its `terraform_remote_state`
 * blocks that read another root of the set, and its `import` and `removed`
 * blocks are cut from its files while it is composed. Every file goes back as
 * it was.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { backendBlock, blockBody, explicitOrder, stateOf, type WavesAfter } from "./detect";
import { configFiles, hclValue, outputsRead, refRe } from "./linked";
import { plannedOutputs, plannedRead } from "./planned-outputs";
import { isStored, rootWorkspace, stateObject, type StateObject } from "./backend";
import { rootRoleEnv } from "./roles";
import { derivedLineage, pullState, runBinary, takeLocks, type BinaryExec, type HeldLock, type StateFile, type StateResource } from "./migrate";
import { changesSomething } from "./report/changing";
import type { ReportComposedMember, ReportRead } from "./report/schema";
import type { StepWhen } from "./steps";

/** Where the composed root is written, in the checkout. */
export const COMPOSE_DIR = ".terragucci-compose";
/** The file a composed root adds to each root it composes, declaring the variables its reads become. */
export const COMPOSE_FILE = "terragucci_compose.tf";
/** The operation a composed run's locks name. */
export const COMPOSE_LOCK = { operation: "terragucci compose", info: "a composed run (waves.compose) holds this state while it plans, applies and writes it" };
/** The suffix of the object beside a root's state that holds the state a composed run could not write. */
export const UNWRITTEN_SUFFIX = ".terragucci-unwritten";
/** Where a state is kept, under the job's report directory (kept out of the reports bucket), when its own backend could not take it either. */
export const UNWRITTEN_DIR = "terragucci-report/unwritten";
export const DEFAULT_COMPOSE_MAX = 10;

/** The run target a wave's composed run is to chant: one run, one digest, in place of its roots. */
export const composeTarget = (wave: number): string => `compose:wave-${wave}`;
export const isComposeTarget = (target: string): boolean => /^compose:wave-\d+$/.test(target);

/** Why a change applies in waves although `waves.compose` is on. */
export type ComposeFallbackKind =
  | "too-many-roots"
  | "one-root"
  | "binary"
  | "identity"
  | "workspace"
  | "backend"
  | "provider-lock"
  | "cli-args"
  | "read"
  | "order-only"
  | "import"
  | "path"
  | "plan-failed";

export interface ComposeFallback {
  kind: ComposeFallbackKind;
  root?: string;
  reason: string;
}

/** One `terraform_remote_state` block of a member that reads another member. */
export interface ComposedReadBlock {
  /** The block's label. */
  name: string;
  upstream: string;
}

/** What `waves.compose` comes to for one change. */
export interface Composition {
  /** The roots the change reaches plus the roots they read, followed upstream, sorted. */
  roots: string[];
  /** The same roots, each after every root it reads. */
  order: string[];
  /** `waves.compose_max`. */
  max: number;
  /** The wave whose job runs it: the earliest wave its roots are in. Absent when the change applies in waves. */
  wave?: number;
  /** Why the change applies in waves. */
  fallback?: ComposeFallback;
  /** Each member's module name in the composed root. */
  modules: Map<string, string>;
  /** Each member's reads of another member. */
  reads: Map<string, ComposedReadBlock[]>;
  /** The wave each member is in on its own. */
  ownWave: Map<string, number>;
}

/** The binary a root runs, as RootBinaries.expected names it before anything is installed. */
export interface ExpectedBinary {
  name: string;
  version?: string;
  pin?: string;
}

export interface CompositionInput {
  /** Every root the pipeline lists. */
  all: string[];
  /** The roots the change reaches (affectedRoots); undefined when every root plans. */
  selected?: ReadonlySet<string>;
  /** The apply's waves, canary first. */
  waves: readonly string[][];
  max?: number;
  env: NodeJS.ProcessEnv;
  /** Each root's binary, before anything is installed. */
  binary: (root: string) => ExpectedBinary;
  /** The roots each root reads (rootDependencies). */
  deps: ReadonlyMap<string, ReadonlySet<string>>;
  after?: WavesAfter;
  /** Apply groups by name, when the wave applies one job per identity: every member has to be in one. */
  groupOf?: (root: string) => string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (xs: readonly string[]): string => xs.map((x) => `\`${x}\``).join(", ");

/**
 * The module name of each root: its path with every character a name cannot
 * hold as `_` (`envs/prod/app` is `envs_prod_app`), `root` for the repo's top,
 * and `_2`, `_3` on a clash.
 */
export function moduleNames(roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of [...roots].sort()) {
    let base = r === "." || r === "" ? "root" : r.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "root";
    if (/^[0-9]/.test(base)) base = `r_${base}`;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    taken.add(name);
    out.set(r, name);
  }
  return out;
}

/** The roots in `set`, each after every root of the set it reads; roots that read none of each other in name order. */
function readOrder(set: readonly string[], deps: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const left = new Set(set);
  const out: string[] = [];
  while (left.size > 0) {
    const ready = [...left].filter((r) => [...(deps.get(r) ?? [])].every((u) => !left.has(u))).sort();
    // A cycle the waves would refuse: take the rest in name order rather than stop.
    const take = ready.length > 0 ? ready : [...left].sort();
    for (const r of take) {
      out.push(r);
      left.delete(r);
    }
  }
  return out;
}

/** The roots a composed run covers: those the change reaches and every root they read, followed upstream. */
export function composeSet(all: readonly string[], selected: ReadonlySet<string> | undefined, deps: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const set = new Set(selected ? [...selected].filter((r) => all.includes(r)) : all);
  const queue = [...set];
  while (queue.length > 0) {
    const r = queue.pop()!;
    for (const u of deps.get(r) ?? []) {
      if (!set.has(u) && all.includes(u)) {
        set.add(u);
        queue.push(u);
      }
    }
  }
  return [...set].sort();
}

/**
 * What `waves.compose` comes to for a change: the set, the wave that runs it
 * and each root's module, or why it applies in waves. A change that cannot
 * compose for any reason applies wholly in waves; nothing composes part of a set.
 */
export function compositionFor(repo: string, input: CompositionInput): Composition {
  const max = input.max ?? DEFAULT_COMPOSE_MAX;
  const roots = composeSet(input.all, input.selected, input.deps);
  const order = readOrder(roots, input.deps);
  const ownWave = new Map(input.waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)).filter(([r]) => roots.includes(r)));
  const modules = moduleNames(roots);
  const reads = composedReads(repo, roots);
  const base = { roots, order, max, modules, reads, ownWave };
  const fallback = fallbackOf(repo, roots, input, reads);
  if (fallback) return { ...base, fallback };
  const wave = Math.min(...roots.map((r) => ownWave.get(r) ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(wave)) return { ...base, fallback: { kind: "one-root", reason: "none of its roots is in a wave of this apply" } };
  return { ...base, wave };
}

/** Each member's `terraform_remote_state` blocks that read another member. */
function composedReads(repo: string, roots: readonly string[]): Map<string, ComposedReadBlock[]> {
  const own = new Map(roots.map((r) => [r, stateOf(repo, r).own] as const));
  const out = new Map<string, ComposedReadBlock[]>();
  for (const r of roots) {
    const blocks: ComposedReadBlock[] = [];
    for (const read of stateOf(repo, r).reads) {
      for (const [other, o] of own) {
        if (other !== r && o && o.key === read.key && (!o.bucket || !read.bucket || o.bucket === read.bucket)) blocks.push({ name: read.name, upstream: other });
      }
    }
    out.set(r, blocks);
  }
  return out;
}

/**
 * HCL text with its comments blanked to spaces, newlines kept, so every
 * position in it is the same position in the text as written. Strings and
 * their escapes are read through, so a `#` or `//` in one stays.
 */
export function blankComments(text: string): string {
  const out = text.split("");
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      for (; i < text.length && text[i] !== "\n"; i++) out[i] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
      i--;
    }
  }
  return out.join("");
}

/** The text of a root's own configuration files, comments blanked so positions still match. */
function rootTexts(dir: string): { file: string; text: string; json: boolean }[] {
  return configFiles(dir).map((f) => {
    const raw = readFileSync(f, "utf-8");
    const json = f.endsWith(".json");
    return { file: f, text: json ? raw : blankComments(raw), json };
  });
}

/** Local module directories a root calls (`source = "./..."` or `"../..."`), followed through, relative to the repo. */
function localModules(repo: string, root: string): string[] {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const { text } of rootTexts(join(repo, at))) {
      for (const m of text.matchAll(/\bmodule\s+"[^"]+"\s*\{/g)) {
        const src = blockBody(text, m.index!).match(/\bsource\s*=\s*"(\.{1,2}\/[^"]*)"/)?.[1];
        if (!src) continue;
        const rel = relative(resolve(repo), resolve(repo, at, src)).split("\\").join("/");
        if (rel.startsWith("..") || seen.has(rel)) continue;
        seen.add(rel);
        queue.push(rel);
      }
    }
  }
  return [...seen];
}

/** `TF_CLI_ARGS*` flags a composed run cannot take: their addresses name a root's resources without the module in front, and `-var` names no root. */
const CLI_REFUSED = /(^|\s)-{1,2}(target|exclude|replace|var)(=|\s|$)/;

/** The provider versions a root's lock file pins, by provider address. */
export function lockedProviders(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(join(dir, ".terraform.lock.hcl"), "utf-8");
  } catch {
    return out;
  }
  for (const m of text.matchAll(/^provider\s+"([^"]+)"\s*\{/gm)) {
    const v = blockBody(text, m.index!).match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
    if (v) out.set(m[1]!, v);
  }
  return out;
}

/** The identity a root's binary runs with: the variables `oidc.roles` sets or drops for it. */
function identityOf(env: NodeJS.ProcessEnv, root: string): string {
  let renv: NodeJS.ProcessEnv;
  try {
    renv = rootRoleEnv(env, root);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
  const keys = [...new Set([...Object.keys(env), ...Object.keys(renv)])].filter((k) => env[k] !== renv[k]).sort();
  return JSON.stringify(keys.map((k) => [k, renv[k] ?? null]));
}

/** The first reason the set cannot run as one composed run, in the order the checks are listed in the docs. */
function fallbackOf(repo: string, roots: string[], input: CompositionInput, reads: Map<string, ComposedReadBlock[]>): ComposeFallback | undefined {
  const max = input.max ?? DEFAULT_COMPOSE_MAX;
  if (roots.length > max) return { kind: "too-many-roots", reason: `this change reaches ${plural(roots.length, "root")}, more than \`waves.compose_max\` (${max})` };
  if (roots.length <= 1) return { kind: "one-root", ...(roots[0] ? { root: roots[0] } : {}), reason: roots.length === 0 ? "this change reaches no root" : `this change reaches one root, \`${roots[0]}\`, which applies in its own run` };
  // One binary process: one binary at one version.
  const bins = new Map(roots.map((r) => [r, input.binary(r)] as const));
  const first = bins.get(roots[0]!)!;
  for (const [r, b] of bins) {
    if (b.name === "choudoufu") return { kind: "binary", root: r, reason: `\`${r}\` runs choudoufu, which keeps no state for a composed run to split` };
    if (b.name !== first.name || (b.version ?? "") !== (first.version ?? "")) {
      return { kind: "binary", root: r, reason: `\`${r}\` runs ${b.name}${b.version ? ` ${b.version}` : ""} and \`${roots[0]}\` ${first.name}${first.version ? ` ${first.version}` : ""}, and one run has one binary` };
    }
  }
  // One binary process has one set of credentials.
  const ids = new Map(roots.map((r) => [r, identityOf(input.env, r)] as const));
  const firstId = ids.get(roots[0]!);
  for (const r of roots) {
    if (ids.get(r) !== firstId) {
      const same = roots.filter((x) => ids.get(x) === firstId);
      return { kind: "identity", root: r, reason: `\`${r}\` runs under another role (\`oidc.roles\`) than ${list(same)}, and one run has one set of credentials` };
    }
  }
  if (input.groupOf) {
    const g = input.groupOf(roots[0]!);
    const other = roots.find((r) => input.groupOf!(r) !== g);
    if (other) return { kind: "identity", root: other, reason: `\`${other}\` is in apply group ${input.groupOf(other)} and \`${roots[0]}\` in ${g}, and one group's job applies a composed run` };
  }
  for (const r of roots) {
    const ws = rootWorkspace(join(repo, r));
    if (ws && ws !== "default") return { kind: "workspace", root: r, reason: `\`${r}\` plans in workspace ${ws}, and a composed run plans in default` };
  }
  const initArgs = `${input.env.TF_CLI_ARGS ?? ""} ${input.env.TF_CLI_ARGS_init ?? ""}`;
  for (const r of roots) {
    const b = backendBlock(join(repo, r));
    if (b && "cloud" in b) return { kind: "backend", root: r, reason: `\`${r}\` has a \`cloud\` block, whose state terragucci does not lock itself` };
    const type = b?.type ?? "local";
    if (!["s3", "gcs", "azurerm", "local"].includes(type)) return { kind: "backend", root: r, reason: `\`${r}\`'s backend is ${type}, and terragucci locks only s3 (with use_lockfile), gcs, azurerm and local states itself` };
    if (type === "s3") {
      const said = rootTexts(join(repo, r)).some((t) => /\buse_lockfile\s*=\s*true\b/.test(t.text) || /"use_lockfile"\s*:\s*true/.test(t.text)) || /use_lockfile=true/.test(initArgs);
      if (!said) return { kind: "backend", root: r, reason: `\`${r}\`'s s3 backend takes no lock file (\`use_lockfile = true\`), so terragucci cannot hold its lock` };
    }
  }
  const locked = new Map<string, { version: string; root: string }>();
  for (const r of roots) {
    for (const [p, v] of lockedProviders(join(repo, r))) {
      const had = locked.get(p);
      if (had && had.version !== v) return { kind: "provider-lock", root: r, reason: `\`${r}\` locks ${p} at ${v} and \`${had.root}\` at ${had.version}, and one run installs one version` };
      if (!had) locked.set(p, { version: v, root: r });
    }
  }
  for (const k of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_CLI_ARGS_apply"]) {
    const m = (input.env[k] ?? "").match(CLI_REFUSED);
    if (m) return { kind: "cli-args", reason: `\`${k}\` carries \`-${m[2]}\`, which names a root's own addresses or variables, not the composed run's` };
  }
  const states = new Map(roots.map((r) => [r, stateOf(repo, r)] as const));
  for (const r of roots) {
    for (const b of reads.get(r) ?? []) {
      const read = states.get(r)!.reads.find((x) => x.name === b.name);
      if (read?.repeated) return { kind: "read", root: r, reason: `\`${r}\` reads \`${b.upstream}\` through a block with count or for_each (\`data.terraform_remote_state.${b.name}\`)` };
    }
  }
  for (const r of roots) {
    for (const mod of localModules(repo, r)) {
      for (const read of stateOf(repo, mod).reads) {
        const up = roots.find((o) => o !== r && states.get(o)!.own?.key === read.key);
        if (up) return { kind: "read", root: r, reason: `\`${r}\` reads \`${up}\` from its module \`${mod}\`, and a composed run rewrites only a root's own reads` };
      }
    }
  }
  const order = explicitOrder(input.after, input.all);
  for (const r of roots) {
    for (const u of order.get(r) ?? []) {
      if (roots.includes(u) && !input.deps.get(r)?.has(u)) {
        return { kind: "order-only", root: r, reason: `\`waves.after\` puts \`${r}\` after \`${u}\` with no read between them, and a module with its own providers takes no depends_on` };
      }
    }
  }
  for (const r of roots) {
    for (const t of rootTexts(join(repo, r))) {
      if (t.json) {
        let doc: unknown;
        try {
          doc = JSON.parse(t.text);
        } catch {
          continue;
        }
        for (const b of jsonBlocks(doc, "import")) {
          if (typeof b.id !== "string" || /\$\{|%\{/.test(b.id) || b.for_each !== undefined || b.provider !== undefined) return { kind: "import", root: r, reason: `an \`import\` block of \`${r}\` takes no literal string \`id\`, so it cannot be lifted into the composed root` };
        }
        continue;
      }
      for (const m of t.text.matchAll(/(^|\n)\s*import\s*\{/g)) {
        const body = blockBody(t.text, m.index! + m[1]!.length);
        if (!importLiteral(body)) return { kind: "import", root: r, reason: `an \`import\` block of \`${r}\` takes no literal string \`id\`, so it cannot be lifted into the composed root` };
      }
      if (/\bpath\.(root|cwd)\b/.test(t.text)) return { kind: "path", root: r, reason: `\`${r}\` uses \`path.root\` or \`path.cwd\`, which would name the composed root instead of \`${r}\`` };
    }
  }
  return undefined;
}

/** An `import` block the composed root can take as it is: a literal string id, no for_each, no provider of the root's own. */
function importLiteral(body: string): boolean {
  if (/^\s*(for_each|provider)\s*=/m.test(body)) return false;
  return /^\s*id\s*=\s*"(?:[^"\\$%]|\\.)*"\s*$/m.test(body);
}

/** The blocks of a kind in a JSON-syntax file: `{"import": [...]}` or `{"import": {...}}`. */
function jsonBlocks(doc: unknown, kind: string): Record<string, unknown>[] {
  const v = (doc as Record<string, unknown> | null)?.[kind];
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  return v && typeof v === "object" ? [v as Record<string, unknown>] : [];
}

/** The one line a note, a log and the report's fallback reason say for a change that applies in waves. */
export function fallbackLine(f: ComposeFallback): string {
  return `**Applies in waves** (\`waves.compose\`): ${f.reason}.`;
}

// ── HCL text ──────────────────────────────────────────────────────────────

/** The end (exclusive) of the expression that starts at `i`: to the end of its line, or further while a bracket or a string is open. */
function exprEnd(text: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0) return i;
  }
  return i;
}

/** The top-level `name = expression` attributes of an HCL attribute file (a `.tfvars`), comments blanked. */
export function hclAttributes(text: string): Map<string, string> {
  const t = blankComments(text);
  const out = new Map<string, string>();
  const re = /(^|\n)[ \t]*([A-Za-z_][\w-]*)[ \t]*=(?!=)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const start = m.index + m[0].length;
    const end = exprEnd(t, start);
    out.set(m[2]!, t.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

/** A root's declared variables: the type expression and whether it is sensitive. */
function declaredVariables(texts: readonly { text: string; json: boolean }[]): Map<string, { type?: string; sensitive: boolean }> {
  const out = new Map<string, { type?: string; sensitive: boolean }>();
  for (const t of texts) {
    if (t.json) {
      try {
        const v = (JSON.parse(t.text) as { variable?: Record<string, { type?: unknown; sensitive?: unknown }> }).variable ?? {};
        for (const [name, body] of Object.entries(v)) {
          const b = Array.isArray(body) ? body[0] : body;
          out.set(name, { ...(typeof b?.type === "string" ? { type: b.type.replace(/^\$\{(.*)\}$/, "$1") } : {}), sensitive: b?.sensitive === true });
        }
      } catch {
        // Not JSON the binary reads either; its plan says so.
      }
      continue;
    }
    for (const m of t.text.matchAll(/\bvariable\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(t.text, m.index!);
      const at = body.match(/(^|\n)\s*type\s*=/);
      const type = at ? body.slice(at.index! + at[0].length, exprEnd(body, at.index! + at[0].length)).trim() : undefined;
      out.set(m[1]!, { ...(type ? { type } : {}), sensitive: /(^|\n)\s*sensitive\s*=\s*true\b/.test(body) });
    }
  }
  return out;
}

/** A root's outputs and whether each is sensitive. */
function declaredOutputs(texts: readonly { text: string; json: boolean }[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const t of texts) {
    if (t.json) {
      try {
        const o = (JSON.parse(t.text) as { output?: Record<string, { sensitive?: unknown }> }).output ?? {};
        for (const [name, body] of Object.entries(o)) out.set(name, (Array.isArray(body) ? body[0] : body)?.sensitive === true);
      } catch {
        // As above.
      }
      continue;
    }
    for (const m of t.text.matchAll(/\boutput\s+"([^"]+)"\s*\{/g)) out.set(m[1]!, /(^|\n)\s*sensitive\s*=\s*true\b/.test(blockBody(t.text, m.index!)));
  }
  return out;
}

/** The `-var-file` paths `TF_CLI_ARGS` and `TF_CLI_ARGS_plan` name, as the binary reads them, relative to the root. */
export function cliVarFiles(env: NodeJS.ProcessEnv): string[] {
  const s = `${env.TF_CLI_ARGS ?? ""} ${env.TF_CLI_ARGS_plan ?? ""}`;
  return [...s.matchAll(/(?:^|\s)-{1,2}var-file(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))/g)].map((m) => m[2] ?? m[3] ?? m[4]!).filter(Boolean);
}

/** `env` with the `-var-file` flags taken out of `TF_CLI_ARGS` and `TF_CLI_ARGS_plan`: the composed run passes those files' values as module arguments. */
export function withoutVarFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan"]) {
    if (out[k] === undefined) continue;
    out[k] = out[k]!.replace(/(?:^|\s)-{1,2}var-file(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g, "").trim();
  }
  return out;
}

/** A root's variable values as the binary would read them, by name: its tfvars files, its auto tfvars files, then the -var-file files, later over earlier. */
function rootVarValues(dir: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  } catch {
    return out;
  }
  const files = [
    ...["terraform.tfvars", "terraform.tfvars.json"].filter((n) => names.includes(n)),
    ...names.filter((n) => n.endsWith(".auto.tfvars") || n.endsWith(".auto.tfvars.json")).sort(),
    ...cliVarFiles(env),
  ];
  for (const f of files) {
    const path = resolve(dir, f);
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (f.endsWith(".json")) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) out.set(k, hclValue(v, false, "null"));
      } catch {
        // The binary would refuse it too; the plan says so.
      }
    } else {
      for (const [k, v] of hclAttributes(text)) out.set(k, v);
    }
  }
  return out;
}

// ── the composed root ─────────────────────────────────────────────────────

/** The composed root as written: what to put back, and the generated files that join its digest. */
export interface ComposedRoot {
  dir: string;
  /** sha256 of each generated file, by its path in the repo, sorted. */
  generated: [string, string][];
  /** Each member's outputs and whether each is sensitive. */
  outputs: Map<string, Map<string, boolean>>;
  /** Put every root's files back as they were and take the generated files away. The composed root's directory stays for its state. */
  restore: () => void;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Cut ranges out of a text, from the end so positions hold. */
function cut(text: string, ranges: [number, number][]): string {
  let out = text;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/**
 * Write the composed root of `c` into the checkout and rewrite each member:
 * its backend block cut, its reads of other members turned into variables
 * the composed root passes `{ outputs = module.<upstream> }`, and its import
 * and removed blocks lifted into the composed root with the module in front
 * of their addresses. Throws, changing nothing, when a root already has a
 * file of the generated file's name.
 */
export function writeComposedRoot(repo: string, c: Composition, env: NodeJS.ProcessEnv): ComposedRoot {
  const dir = join(repo, COMPOSE_DIR);
  const originals = new Map<string, string>();
  const generatedFiles: string[] = [];
  for (const r of c.roots) if (existsSync(join(repo, r, COMPOSE_FILE))) throw new Error(`${r}: ${COMPOSE_FILE} is already in the root`);
  const restore = (): void => {
    for (const [f, t] of originals) writeFileSync(f, t);
    for (const f of generatedFiles) rmSync(f, { force: true });
  };
  const outputs = new Map<string, Map<string, boolean>>();
  const lifted: string[] = [];
  const passed = new Map<string, { type?: string; sensitive: boolean }>();
  const modules: string[] = [];
  try {
    for (const r of c.order) {
      const m = c.modules.get(r)!;
      const rdir = join(repo, r);
      const texts = rootTexts(rdir);
      const raws = new Map(texts.map((t) => [t.file, readFileSync(t.file, "utf-8")]));
      outputs.set(r, declaredOutputs(texts));
      const variables = declaredVariables(texts);
      const reads = c.reads.get(r) ?? [];
      for (const t of texts) {
        const raw = raws.get(t.file)!;
        let next: string;
        if (t.json) next = rewriteJson(raw, reads, m, lifted);
        else {
          const ranges: [number, number][] = [];
          for (const b of t.text.matchAll(/\bbackend\s+"[^"]+"\s*\{/g)) ranges.push([b.index!, b.index! + blockBody(t.text, b.index!).length]);
          for (const b of t.text.matchAll(/\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{/g)) {
            if (reads.some((x) => x.name === b[1])) ranges.push([b.index!, b.index! + blockBody(t.text, b.index!).length]);
          }
          for (const b of t.text.matchAll(/(^|\n)([ \t]*)(import|removed)\s*\{/g)) {
            const at = b.index! + b[1]!.length;
            const body = raw.slice(at, at + blockBody(t.text, at).length);
            ranges.push([at, at + body.length]);
            lifted.push(liftBlock(body, b[3] as "import" | "removed", m));
          }
          next = cut(raw, ranges);
          for (const x of reads) next = next.replace(refRe(x.name), `var.terragucci_read_${x.name}`);
        }
        if (next !== raw) {
          originals.set(t.file, raw);
          writeFileSync(t.file, next);
        }
      }
      const gen = join(rdir, COMPOSE_FILE);
      const decl = [...new Set(reads.map((x) => x.name))].map((n) => `variable "terragucci_read_${n}" {\n  type = any\n}\n`).join("\n");
      writeFileSync(gen, `# Written by terragucci for a composed run (waves.compose), and removed once it ends.\n${decl}`);
      generatedFiles.push(gen);
      // Arguments: the root's variable values, then a TF_VAR_ the job sets for a variable it has no value for, then its reads.
      const values = rootVarValues(rdir, env);
      const args: string[] = [`  source = ${JSON.stringify(`../${r === "." ? "" : r}`)}`];
      for (const [k, v] of [...values].sort(([a], [b]) => (a < b ? -1 : 1))) if (variables.has(k)) args.push(`  ${k} = ${v}`);
      for (const [k, v] of [...variables].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (values.has(k) || env[`TF_VAR_${k}`] === undefined) continue;
        if (!passed.has(k)) passed.set(k, v);
        args.push(`  ${k} = var.${k}`);
      }
      for (const n of [...new Set(reads.map((x) => x.name))]) {
        const up = reads.find((x) => x.name === n)!.upstream;
        args.push(`  terragucci_read_${n} = { outputs = module.${c.modules.get(up)} }`);
      }
      modules.push(`module "${m}" {\n${args.join("\n")}\n}\n`);
    }
    mkdirSync(dir, { recursive: true });
    const vars = [...passed].map(([k, v]) => `variable "${k}" {\n${v.type ? `  type = ${v.type}\n` : ""}${v.sensitive ? "  sensitive = true\n" : ""}}\n`);
    const outs = c.order.flatMap((r) =>
      [...outputs.get(r)!].map(([o, sensitive]) => `output "${c.modules.get(r)}__${o}" {\n  value = module.${c.modules.get(r)}.${o}\n${sensitive ? "  sensitive = true\n" : ""}}\n`),
    );
    const main = join(dir, "main.tf");
    writeFileSync(main, ["# Written by terragucci for a composed run (waves.compose): each root a module, its state its own.\n", ...vars, ...modules, ...outs, ...lifted].join("\n"));
    generatedFiles.push(main);
    const lock = unionLock(c.roots.map((r) => join(repo, r)));
    if (lock) {
      const lockFile = join(dir, ".terraform.lock.hcl");
      writeFileSync(lockFile, lock);
      generatedFiles.push(lockFile);
    }
  } catch (e) {
    restore();
    throw e;
  }
  const generated = generatedFiles.map((f) => [relative(repo, f).split("\\").join("/"), sha256(readFileSync(f, "utf-8"))] as [string, string]).sort(([a], [b]) => (a < b ? -1 : 1));
  return { dir, generated, outputs, restore };
}

/** An `import` or `removed` block of module `m`, lifted into the composed root: its address with `module.<m>.` in front. */
function liftBlock(body: string, kind: "import" | "removed", m: string): string {
  const key = kind === "import" ? "to" : "from";
  return `${body.replace(new RegExp(`(^|\\n)(\\s*)${key}(\\s*)=(\\s*)`), `$1$2${key}$3=$4module.${m}.`).trim()}\n`;
}

/** A JSON-syntax file rewritten as writeComposedRoot rewrites HCL: its backend, its reads of members, and its import and removed blocks out. */
function rewriteJson(raw: string, reads: readonly ComposedReadBlock[], m: string, lifted: string[]): string {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  let changed = false;
  for (const t of Array.isArray(doc.terraform) ? doc.terraform : [doc.terraform]) {
    if (t && typeof t === "object" && "backend" in (t as object)) {
      delete (t as Record<string, unknown>).backend;
      changed = true;
    }
  }
  const data = doc.data as Record<string, Record<string, unknown>> | undefined;
  const rs = data?.terraform_remote_state;
  if (rs && typeof rs === "object") {
    for (const x of reads) {
      if (x.name in rs) {
        delete rs[x.name];
        changed = true;
      }
    }
    if (Object.keys(rs).length === 0) delete data!.terraform_remote_state;
  }
  for (const kind of ["import", "removed"] as const) {
    for (const b of jsonBlocks(doc, kind)) {
      const key = kind === "import" ? "to" : "from";
      const addr = String(b[key] ?? "").replace(/^\$\{(.*)\}$/, "$1");
      const rest = kind === "import" ? `  id = ${JSON.stringify(b.id)}\n` : b.lifecycle ? `  lifecycle {\n    destroy = ${(b.lifecycle as { destroy?: unknown }).destroy === false ? "false" : "true"}\n  }\n` : "";
      lifted.push(`${kind} {\n  ${key} = module.${m}.${addr}\n${rest}}\n`);
      changed = true;
    }
    if (kind in doc) delete doc[kind];
  }
  let text = changed ? JSON.stringify(doc, null, 2) + "\n" : raw;
  for (const x of reads) text = text.replace(refRe(x.name), `var.terragucci_read_${x.name}`);
  return text;
}

/** The union of the roots' `.terraform.lock.hcl`: one block per provider, with every hash any root's file holds for it. */
export function unionLock(dirs: readonly string[]): string | undefined {
  const blocks = new Map<string, { version: string; constraints?: string; hashes: Set<string> }>();
  for (const d of dirs) {
    let text: string;
    try {
      text = readFileSync(join(d, ".terraform.lock.hcl"), "utf-8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^provider\s+"([^"]+)"\s*\{/gm)) {
      const body = blockBody(text, m.index!);
      const version = body.match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
      if (!version) continue;
      const constraints = body.match(/\bconstraints\s*=\s*"([^"]*)"/)?.[1];
      const hashes = [...(body.match(/\bhashes\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((h) => h[1]!);
      const had = blocks.get(m[1]!);
      if (had) for (const h of hashes) had.hashes.add(h);
      else blocks.set(m[1]!, { version, ...(constraints !== undefined ? { constraints } : {}), hashes: new Set(hashes) });
    }
  }
  if (blocks.size === 0) return undefined;
  const out = ["# Written by terragucci for a composed run: the union of its roots' lock files.\n"];
  for (const [p, b] of [...blocks].sort(([a], [c]) => (a < c ? -1 : 1))) {
    out.push(`provider "${p}" {\n  version     = "${b.version}"\n${b.constraints !== undefined ? `  constraints = "${b.constraints}"\n` : ""}  hashes = [\n${[...b.hashes].sort().map((h) => `    "${h}",`).join("\n")}\n  ]\n}\n`);
  }
  return out.join("\n");
}

/** The composed plan's digest: chant's digest of the plan, joined with the generated files, so an approval of one composition never applies another. */
export function composedDigest(planDigest: string, generated: readonly [string, string][]): string {
  return computePlanDigest("terragucci-composed-plan", { plan: planDigest, files: generated.map(([path, sha]) => `${path} ${sha}`) });
}

/** The digest of a composed plan as chant takes it for the gate, with its generated files. */
export function composedPlanDigest(plan: unknown, binary: string, target: string, generated: readonly [string, string][]): string {
  const part = terraformChangeSetPart({ member: target, plan, planner: plannerForBinary(binary) });
  return part.member.planDigest ? composedDigest(part.member.planDigest, generated) : "";
}

// ── the working state ─────────────────────────────────────────────────────

/** Whether a module address is `module.<m>` or inside it. */
const inModule = (address: string | undefined, m: string): boolean => address === `module.${m}` || (address?.startsWith(`module.${m}.`) ?? false) || (address?.startsWith(`module.${m}[`) ?? false);
/** An address with `module.<m>.` taken off its front. */
const unprefix = (address: string, m: string): string => (address.startsWith(`module.${m}.`) ? address.slice(`module.${m}.`.length) : address);

/** Whether a root's module configures the provider of type `type` itself (a `provider "<type>"` block): its resources then name the module's configuration. */
function ownsProvider(dir: string, type: string): boolean {
  return rootTexts(dir).some((t) => (t.json ? new RegExp(`"provider"\\s*:\\s*\\{[^]*"${type}"`).test(t.text) : new RegExp(`\\bprovider\\s+"${type}"\\s*\\{`).test(t.text)));
}

/**
 * The working state: each member's resources with `module.<m>` in front of
 * their module, each output as `<m>__<name>` (the composed root's outputs, so
 * an output that does not change plans no change), check results left out.
 * A resource whose root configures its provider itself names the module's
 * provider configuration.
 */
export function mergeStates(repo: string, c: Composition, pulled: ReadonlyMap<string, StateFile | null>): StateFile {
  const resources: StateResource[] = [];
  const outputs: Record<string, unknown> = {};
  let tfVersion: string | undefined;
  for (const r of c.order) {
    const s = pulled.get(r);
    if (!s) continue;
    const m = c.modules.get(r)!;
    if (s.terraform_version && (!tfVersion || versionAbove(s.terraform_version, tfVersion))) tfVersion = s.terraform_version;
    for (const res of s.resources) {
      const provider = typeof res.provider === "string" ? res.provider : undefined;
      const type = provider?.match(/provider\["([^"]+)"\]/)?.[1]?.split("/").pop();
      const own = provider && type && !provider.startsWith("module.") && ownsProvider(join(repo, r), type);
      resources.push({ ...structuredClone(res), module: res.module ? `module.${m}.${res.module}` : `module.${m}`, ...(provider ? { provider: own ? `module.${m}.${provider}` : provider.startsWith("module.") ? `module.${m}.${provider}` : provider } : {}) });
    }
    for (const [k, v] of Object.entries(s.outputs ?? {})) outputs[`${m}__${k}`] = structuredClone(v);
  }
  return { version: 4, terraform_version: tfVersion ?? "1.0.0", serial: 1, lineage: derivedLineage("terragucci compose", ...c.order), outputs, resources, check_results: null };
}

function versionAbove(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** A state's resources and outputs in one order, for comparing two states. */
const canonical = (s: Pick<StateFile, "resources" | "outputs">): string =>
  JSON.stringify({
    resources: [...s.resources].map((r) => JSON.stringify(r)).sort(),
    outputs: Object.fromEntries(Object.entries(s.outputs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
  });

/**
 * One member's state out of the working state: its resources with the module
 * taken off, its outputs from `<m>__*`, its pulled lineage and its pulled
 * serial plus one (a root with no state yet gets a lineage of its own).
 * `same` when it holds what was pulled.
 */
export function splitState(working: StateFile, c: Composition, root: string, pulled: StateFile | null): { state: StateFile; same: boolean } {
  const m = c.modules.get(root)!;
  const resources: StateResource[] = [];
  for (const res of working.resources) {
    if (!inModule(res.module, m)) continue;
    const module = res.module === `module.${m}` ? undefined : unprefix(res.module!, m);
    const { module: _m, ...rest } = structuredClone(res);
    const provider = typeof rest.provider === "string" ? unprefix(rest.provider, m) : undefined;
    resources.push({ ...rest, ...(module ? { module } : {}), ...(provider !== undefined ? { provider } : {}) });
  }
  const outputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(working.outputs ?? {})) if (k.startsWith(`${m}__`)) outputs[k.slice(m.length + 2)] = v;
  const state: StateFile = {
    version: 4,
    terraform_version: working.terraform_version,
    serial: (pulled?.serial ?? 0) + 1,
    lineage: pulled?.lineage || derivedLineage("terragucci compose", root),
    outputs,
    resources,
    check_results: null,
  };
  const same = pulled ? canonical(state) === canonical(pulled) : resources.length === 0 && Object.keys(outputs).length === 0;
  return { state, same };
}

// ── the plan, cut by module ───────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** A module's part of `planned_values` or `prior_state.values`: its child module as the root module, addresses unprefixed. */
function moduleValues(values: unknown, m: string, outputs: Json): Json | undefined {
  if (!isObj(values)) return undefined;
  const root = isObj(values.root_module) ? values.root_module : {};
  const child = (Array.isArray(root.child_modules) ? root.child_modules : []).find((x) => isObj(x) && x.address === `module.${m}`) as Json | undefined;
  const strip = (mod: Json): Json => ({
    ...mod,
    ...(Array.isArray(mod.resources) ? { resources: mod.resources.map((x) => (isObj(x) ? { ...x, address: unprefix(String(x.address), m) } : x)) } : {}),
    ...(Array.isArray(mod.child_modules) ? { child_modules: mod.child_modules.map((x) => (isObj(x) ? strip({ ...x, address: unprefix(String(x.address), m) }) : x)) } : {}),
  });
  const { address: _a, ...rest } = child ? strip(child) : { address: undefined };
  return { ...values, outputs, root_module: rest };
}

/** The outputs of module `m` among a composed root's, by their own names. */
function moduleOutputs(outputs: unknown, m: string): Json {
  if (!isObj(outputs)) return {};
  return Object.fromEntries(Object.entries(outputs).filter(([k]) => k.startsWith(`${m}__`)).map(([k, v]) => [k.slice(m.length + 2), v]));
}

/** A change's address fields with the module taken off. */
function stripChange(x: unknown, m: string): unknown {
  if (!isObj(x)) return x;
  const out: Json = { ...x, address: unprefix(String(x.address), m) };
  if (typeof x.previous_address === "string") out.previous_address = unprefix(x.previous_address, m);
  if (x.module_address === `module.${m}`) delete out.module_address;
  else if (typeof x.module_address === "string") out.module_address = unprefix(x.module_address, m);
  return out;
}

/**
 * One member's part of the composed plan's `show -json`, as if it had
 * planned alone: its resource changes and drift with `module.<m>.` taken off,
 * its outputs by their own names, its planned values, prior state and
 * configuration as the root module.
 */
export function slicePlan(plan: unknown, m: string): unknown {
  if (!isObj(plan)) return plan;
  const out: Json = { ...plan };
  const changes = (k: string) => (Array.isArray(plan[k]) ? (plan[k] as unknown[]).filter((x) => isObj(x) && inModule(String(x.module_address ?? ""), m)).map((x) => stripChange(x, m)) : undefined);
  const rc = changes("resource_changes");
  if (rc) out.resource_changes = rc;
  const rd = changes("resource_drift");
  if (rd) out.resource_drift = rd;
  if (isObj(plan.output_changes)) out.output_changes = moduleOutputs(plan.output_changes, m);
  if (isObj(plan.planned_values)) out.planned_values = moduleValues(plan.planned_values, m, moduleOutputs(plan.planned_values.outputs, m));
  if (isObj(plan.prior_state)) {
    const values = isObj(plan.prior_state.values) ? plan.prior_state.values : undefined;
    out.prior_state = { ...plan.prior_state, ...(values ? { values: moduleValues(values, m, moduleOutputs(values.outputs, m)) } : {}) };
  }
  if (isObj(plan.configuration)) {
    const root = isObj(plan.configuration.root_module) ? plan.configuration.root_module : {};
    const call = isObj(root.module_calls) && isObj(root.module_calls[m]) ? (root.module_calls[m] as Json) : undefined;
    const pc = isObj(plan.configuration.provider_config) ? plan.configuration.provider_config : {};
    out.configuration = {
      ...plan.configuration,
      provider_config: Object.fromEntries(Object.entries(pc).flatMap(([k, v]) => (k.startsWith(`module.${m}:`) ? [[k.slice(`module.${m}:`.length), isObj(v) ? { ...v, module_address: undefined } : v]] : k.includes(":") ? [] : [[k, v]]))),
      root_module: isObj(call?.module) ? call!.module : {},
    };
  }
  if (Array.isArray(plan.relevant_attributes)) out.relevant_attributes = plan.relevant_attributes.filter((x) => isObj(x) && String(x.resource).startsWith(`module.${m}.`)).map((x) => ({ ...(x as Json), resource: unprefix(String((x as Json).resource), m) }));
  delete out.checks;
  delete out.variables;
  return out;
}

/**
 * One member's part of the composed plan's `show` text: the text before the
 * actions, each resource block of its module with `module.<m>.` taken off,
 * its line of counts, and its outputs by their own names.
 */
export function sliceText(text: string, m: string, counts: { add: number; change: number; destroy: number }): string {
  const lines = text.split("\n");
  const head: string[] = [];
  const blocks: string[][] = [];
  const outs: string[] = [];
  let i = 0;
  for (; i < lines.length && !/^\s{2}# /.test(lines[i]!); i++) {
    if (/^(Plan:|No changes\.|Changes to Outputs:)/.test(lines[i]!)) break;
    head.push(lines[i]!);
  }
  let cur: string[] | undefined;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s{2}# /.test(l)) {
      cur = [l];
      blocks.push(cur);
    } else if (/^(Plan:|Changes to Outputs:|─|Note:|Saved the plan)/.test(l)) {
      cur = undefined;
      if (l.startsWith("Changes to Outputs:")) {
        for (i++; i < lines.length && /^\s/.test(lines[i]!); i++) if (new RegExp(`^\\s+[-+~] ${m}__`).test(lines[i]!)) outs.push(lines[i]!.replace(`${m}__`, ""));
        i--;
      }
    } else if (cur) cur.push(l);
  }
  const mine = blocks.filter((b) => new RegExp(`^\\s{2}# module\\.${m}\\.`).test(b[0]!)).map((b) => [b[0]!.replace(`module.${m}.`, ""), ...b.slice(1)].join("\n").trimEnd());
  const parts = [head.join("\n").trimEnd()];
  if (mine.length === 0 && outs.length === 0) parts.push("No changes. Its part of the composed run matches the configuration.");
  else {
    if (mine.length) parts.push(mine.join("\n\n"));
    parts.push(`Plan: ${counts.add} to add, ${counts.change} to change, ${counts.destroy} to destroy.`);
    if (outs.length) parts.push(`Changes to Outputs:\n${outs.join("\n")}`);
  }
  return parts.filter((p) => p !== "").join("\n\n") + "\n";
}

/** A plan's counts as the binary's `Plan:` line gives them. */
export function planCounts(plan: unknown): { add: number; change: number; destroy: number; changes: number; destroys: number } {
  const rc = isObj(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  let add = 0;
  let change = 0;
  let destroy = 0;
  let destroys = 0;
  let changes = 0;
  for (const r of rc) {
    const a: string[] = isObj(r) && isObj(r.change) && Array.isArray(r.change.actions) ? (r.change.actions as string[]) : [];
    if (a.every((x) => x === "no-op" || x === "read")) continue;
    changes++;
    if (a.includes("create")) add++;
    if (a.includes("delete")) {
      destroy++;
      destroys++;
    }
    if (a.includes("update")) change++;
  }
  return { add, change, destroy, changes, destroys };
}

/**
 * Each member's reads of another member, as the report names them: planned
 * on the upstream's part of the composed plan, each output read that is known
 * only once that part applies named as unknown, and `composed`.
 */
export function composedReportReads(repo: string, c: Composition, slices: ReadonlyMap<string, unknown>): Map<string, ReportRead[]> {
  const out = new Map<string, ReportRead[]>();
  for (const r of c.roots) {
    const texts = configFiles(join(repo, r)).map((f) => readFileSync(f, "utf-8"));
    const reads: ReportRead[] = [];
    for (const b of c.reads.get(r) ?? []) {
      const planned = plannedOutputs(slices.get(b.upstream));
      if (!planned) continue;
      reads.push({ ...plannedRead(b.upstream, b.name, planned.outputs, outputsRead(texts, b.name)), composed: true });
    }
    if (reads.length) out.set(r, reads);
  }
  return out;
}

// ── the apply's events ────────────────────────────────────────────────────

/** How one member's part of the apply ended. */
export type MemberApply = "applied" | "partial" | "failed" | "not-started" | "no-changes";

/** What `apply -json` said of each module: the changes that completed, started, or errored, and the first error. */
export interface ApplyEvents {
  done: Map<string, number>;
  started: Map<string, number>;
  errored: Map<string, string>;
  /** Errors no module's resource names. */
  other: string[];
}

/** Read `apply -json` lines into each module's progress. */
export function readApplyEvents(out: string, modules: readonly string[]): ApplyEvents {
  const ev: ApplyEvents = { done: new Map(), started: new Map(), errored: new Map(), other: [] };
  const moduleOf = (addr: string | undefined): string | undefined => modules.find((m) => addr !== undefined && (addr.startsWith(`module.${m}.`) || addr.startsWith(`module.${m}[`)));
  const bump = (map: Map<string, number>, m: string) => map.set(m, (map.get(m) ?? 0) + 1);
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { type?: string; hook?: { resource?: { addr?: string }; error?: string }; diagnostic?: { severity?: string; summary?: string; detail?: string; address?: string }; "@message"?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const addr = e.hook?.resource?.addr;
    const m = moduleOf(addr);
    if (e.type === "apply_start" && m) bump(ev.started, m);
    else if (e.type === "apply_complete" && m) bump(ev.done, m);
    else if (e.type === "apply_errored" && m && !ev.errored.has(m)) ev.errored.set(m, `${unprefix(addr!, m)}: ${e.hook?.error ?? e["@message"] ?? "errored"}`);
    else if (e.type === "diagnostic" && e.diagnostic?.severity === "error") {
      const dm = moduleOf(e.diagnostic.address);
      const text = `${e.diagnostic.summary ?? "Error"}${e.diagnostic.detail ? `: ${e.diagnostic.detail.split("\n")[0]}` : ""}`;
      if (dm && !ev.errored.has(dm)) ev.errored.set(dm, `${unprefix(e.diagnostic.address!, dm)}: Error: ${text}`);
      else if (!dm) ev.other.push(text);
    }
  }
  return ev;
}

/** How a member's part of the apply ended, from its planned changes and the events. */
export function memberApply(m: string, planned: number, ev: ApplyEvents): { apply: MemberApply; done: number } {
  const done = Math.min(ev.done.get(m) ?? 0, planned);
  if (planned === 0) return { apply: "no-changes", done: 0 };
  if (done >= planned) return { apply: "applied", done };
  if (done > 0) return { apply: "partial", done };
  if (ev.errored.has(m) || (ev.started.get(m) ?? 0) > 0) return { apply: "failed", done };
  return { apply: "not-started", done };
}

/** Write a file, its directory first. */
export function writeWithDir(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// ── the run ───────────────────────────────────────────────────────────────

/** What a composed run calls out to for each member: its steps, and the sources check after its init. */
export interface ComposeHooks {
  /** Run one moment's steps for a member; the error when one failed it. A step given the plan file gets the composed one. */
  step?: (root: string, when: StepWhen, planFile?: string) => Promise<string | undefined>;
  /** After a member's init, before anything of it plans: the error when the sources check refuses what init fetched. */
  afterInit?: (root: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  log: (line: string) => void;
}

export interface ComposeRunOptions {
  repo: string;
  composition: Composition;
  /** The binary every member runs: its path and its name. */
  binary: { path: string; name: string };
  /** The job's environment, with the shared provider cache. Each member's own role is added to it. */
  env: NodeJS.ProcessEnv;
  /** A directory of the job's own for the plan file and the states it writes. */
  work: string;
  /** Take each state's lock (an apply); a plan takes none. */
  lock: boolean;
  /** Names the run in the locks it takes. */
  runId?: string;
  hooks: ComposeHooks;
  exec?: BinaryExec;
  /** How long to wait before each retry of a state's write. Default 5s, 15s, 30s, 60s, 120s: five retries, inside the lock timeout of 5 minutes. */
  retryDelays?: number[];
  /** The init of each member, one at a time when they share a provider cache. */
  initTurn?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The composed plan, cut back into each member's part. */
export interface ComposedPlan {
  /** Why it did not plan, and the member it is about when there is one. */
  error?: string;
  root?: string;
  plan?: unknown;
  planFile: string;
  text?: string;
  /** The digest the gate binds: the composed plan's, joined with the generated files. Empty when it failed. */
  digest: string;
  generated: [string, string][];
  /** Each member's part of the plan JSON and of its text. */
  slices: Map<string, unknown>;
  texts: Map<string, string>;
  /** Each member's reads of another member. */
  reads: Map<string, ReportRead[]>;
  /** The members that read a value of another member unknown at plan time. */
  unknown: string[];
  changes: number;
  destroys: number;
  /** The binary's `Plan:` line for the whole run. */
  summary: string;
}

/** How a composed apply ended. */
export interface ComposedApply {
  ok: boolean;
  members: ReportComposedMember[];
  /** The members whose state the run wrote or left as it was: their backend holds what applied to them. */
  settled: string[];
  error?: string;
}

const DEFAULT_RETRIES = [5_000, 15_000, 30_000, 60_000, 120_000];
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstLines = (s: string, n = 6): string => s.trim().split("\n").slice(-n).join("\n");
const safeName = (root: string): string => (root === "." ? "root" : root.replace(/[^\w.-]/g, "_"));

/**
 * One composed run: prepare and plan it (`plan`), then apply it once the
 * gate lets it through (`apply`). `release` lets go of every lock it still
 * holds, but a lock held on purpose for a state it could not write, and puts
 * every file back; call it whatever happened.
 */
export class ComposedRun {
  private readonly exec: BinaryExec;
  private readonly pulled = new Map<string, StateFile | null>();
  private readonly objects = new Map<string, StateObject>();
  private locks: HeldLock[] = [];
  private readonly heldOnPurpose = new Set<string>();
  private planned?: ComposedPlan;
  private readonly composeDir: string;

  constructor(private readonly o: ComposeRunOptions) {
    this.exec = o.exec ?? runBinary;
    this.composeDir = join(o.repo, COMPOSE_DIR);
  }

  private get c(): Composition {
    return this.o.composition;
  }

  private log(line: string): void {
    this.o.hooks.log(line);
  }

  /** A member's environment: the job's with its role. */
  rootEnv(root: string): NodeJS.ProcessEnv {
    return rootRoleEnv(this.o.env, root);
  }

  /**
   * The composed root's environment: the first member's role (every member
   * has the same, or the change would not compose), its `-var-file` flags
   * taken out. With a shared provider cache and no lock file to check a
   * cached provider against, the cache may fill the lock file, as a root's
   * own plan lets it (rootCacheEnv in ./report/stage.ts).
   */
  private composedEnv(): NodeJS.ProcessEnv {
    const env = withoutVarFiles(this.rootEnv(this.c.order[0]!));
    return env.TF_PLUGIN_CACHE_DIR && !existsSync(join(this.composeDir, ".terraform.lock.hcl")) ? { ...env, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "true" } : env;
  }

  private failedPlan(error: string, root?: string): ComposedPlan {
    return { error, ...(root ? { root } : {}), planFile: join(this.o.work, "composed.tfplan"), digest: "", generated: [], slices: new Map(), texts: new Map(), reads: new Map(), unknown: [], changes: 0, destroys: 0, summary: "" };
  }

  private async step(root: string, when: StepWhen, planFile?: string): Promise<string | undefined> {
    return this.o.hooks.step ? this.o.hooks.step(root, when, planFile) : undefined;
  }

  /**
   * Init each member against its backend, take each state's lock (an apply),
   * write first any state an earlier run kept unwritten, pull each state,
   * write the composed root and its working state, and plan once.
   */
  async plan(): Promise<ComposedPlan> {
    const { repo } = this.o;
    const bin = this.o.binary.path;
    const turn = this.o.initTurn ?? ((fn) => fn());
    for (const r of this.c.order) {
      const dir = join(repo, r);
      const env = this.rootEnv(r);
      let e = await this.step(r, "before-init");
      if (e) return this.failedPlan(e, r);
      const init = await turn(() => this.exec(bin, ["init", "-input=false", "-no-color"], dir, env));
      if (init.code !== 0) return this.failedPlan(`init failed\n${firstLines(init.out, 40)}`, r);
      e = await this.o.hooks.afterInit?.(r, env);
      if (e) return this.failedPlan(e, r);
      e = await this.step(r, "after-init");
      if (e) return this.failedPlan(e, r);
      const object = stateObject(dir, env);
      if ("unsupported" in object && isStoredBackend(object.backend)) return this.failedPlan(`its state cannot be read where it is: ${object.unsupported}`, r);
      if (object.backend === "s3" && "lockfile" in object && !object.lockfile && this.o.lock) return this.failedPlan("its s3 backend takes no lock file (use_lockfile = true), so a composed run cannot hold its lock", r);
      if (!isStored(object) && object.backend !== "local") return this.failedPlan(`its backend is ${object.backend}, and a composed run locks and writes s3, gcs, azurerm and local states`, r);
      this.objects.set(r, object);
    }
    if (this.o.lock) {
      const op = { operation: COMPOSE_LOCK.operation, info: `${COMPOSE_LOCK.info}${this.o.runId ? ` (run ${this.o.runId})` : ""}` };
      const files = new Map(this.c.order.map((r) => [r, { object: this.objects.get(r)! }] as const));
      try {
        this.locks = await takeLocks(files, new Date().toISOString(), undefined, op, async (root, store, held) => {
          // A lock an earlier composed run left held for a state it could not write: this run writes that state first.
          if (!held.info.includes(COMPOSE_LOCK.operation)) return false;
          const kept = await store.readBeside(UNWRITTEN_SUFFIX).catch(() => undefined);
          if (!kept?.trim()) return false;
          store.adopt(held);
          this.log(`${root}: its lock is held by an earlier composed run that kept a state it could not write; this run takes the lock over and writes that state first`);
          return true;
        });
      } catch (e) {
        return this.failedPlan(`${(e as Error).message}; nothing was pulled`);
      }
      for (const r of this.c.order) {
        try {
          await this.writeKept(r);
        } catch (e) {
          return this.failedPlan(`the state an earlier composed run kept for it could not be written: ${(e as Error).message}`, r);
        }
      }
    }
    for (const r of this.c.order) {
      try {
        this.pulled.set(r, await pullState(this.exec, bin, r, join(repo, r), this.rootEnv(r)));
      } catch (e) {
        return this.failedPlan((e as Error).message, r);
      }
    }
    for (const r of this.c.order) {
      const e = await this.step(r, "before-plan");
      if (e) return this.failedPlan(e, r);
    }
    const planFile = join(this.o.work, "composed.tfplan");
    let root: ComposedRoot;
    try {
      root = writeComposedRoot(repo, this.c, this.o.env);
    } catch (e) {
      return this.failedPlan(`the composed root could not be written: ${(e as Error).message}`);
    }
    let plan: unknown;
    let text = "";
    let summary = "";
    try {
      writeFileSync(join(this.composeDir, "terraform.tfstate"), JSON.stringify(mergeStates(repo, this.c, this.pulled), null, 2) + "\n");
      const env = this.composedEnv();
      const init = await turn(() => this.exec(bin, ["init", "-input=false", "-no-color"], this.composeDir, env));
      if (init.code !== 0) return this.failedPlan(`the composed root's init failed\n${firstLines(init.out, 40)}`);
      const p = await this.exec(bin, ["plan", "-input=false", "-no-color", "-lock=false", `-out=${planFile}`], this.composeDir, env);
      if (p.code !== 0 || !existsSync(planFile)) return this.failedPlan(`the composed plan failed\n${firstLines(p.out, 40)}`);
      summary = p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned";
      const json = await this.exec(bin, ["show", "-json", planFile], this.composeDir, env);
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        return this.failedPlan(`show -json printed no plan\n${firstLines(json.out)}`);
      }
      text = (await this.exec(bin, ["show", "-no-color", planFile], this.composeDir, env)).stdout;
    } finally {
      root.restore();
    }
    for (const r of this.c.order) {
      const e = await this.step(r, "after-plan", planFile);
      if (e) return this.failedPlan(e, r);
    }
    const slices = new Map<string, unknown>();
    const texts = new Map<string, string>();
    for (const r of this.c.order) {
      const m = this.c.modules.get(r)!;
      const slice = slicePlan(plan, m);
      slices.set(r, slice);
      texts.set(r, sliceText(text, m, planCounts(slice)));
    }
    const reads = composedReportReads(repo, this.c, slices);
    const unknown = [...reads].filter(([, rs]) => rs.some((x) => x.unknown?.length)).map(([r]) => r);
    const counts = planCounts(plan);
    const target = composeTarget(this.c.wave ?? 0);
    this.planned = {
      plan,
      planFile,
      text,
      digest: composedPlanDigest(plan, this.o.binary.name, target, root.generated),
      generated: root.generated,
      slices,
      texts,
      reads,
      unknown,
      changes: counts.changes,
      destroys: counts.destroys,
      summary,
    };
    return this.planned;
  }

  /** A state an earlier composed run kept beside a member's state: write it, then clear what was kept. */
  private async writeKept(root: string): Promise<void> {
    const object = this.objects.get(root)!;
    const lock = this.locks.find((l) => l.root === root && l.store);
    let kept: string | undefined;
    if (lock?.store) kept = await lock.store.readBeside(UNWRITTEN_SUFFIX);
    else if (object.backend === "local" && "path" in object) {
      const file = resolve(this.o.repo, root, object.path) + UNWRITTEN_SUFFIX;
      kept = existsSync(file) ? readFileSync(file, "utf-8") : undefined;
    }
    if (!kept?.trim()) return;
    await this.writeState(root, JSON.parse(kept) as StateFile);
    if (lock?.store) await lock.store.writeBeside(UNWRITTEN_SUFFIX, "");
    else if ("path" in object) writeFileSync(resolve(this.o.repo, root, object.path) + UNWRITTEN_SUFFIX, "");
    this.log(`${root}: wrote the state an earlier composed run kept unwritten, before planning`);
  }

  /** Write one member's state to its backend: under azurerm's lease with the store's own write, else `state push`, with the lock terragucci holds. */
  private async writeState(root: string, state: StateFile): Promise<void> {
    const body = JSON.stringify(state, null, 2) + "\n";
    const lock = this.locks.find((l) => l.root === root && l.store);
    if (lock?.store?.write) {
      await lock.store.write(body);
      return;
    }
    const file = join(this.o.work, `${safeName(root)}.tfstate`);
    writeFileSync(file, body);
    const object = this.objects.get(root);
    const args = object && isStored(object) ? ["-lock=false"] : [];
    const push = await this.exec(this.o.binary.path, ["state", "push", ...args, file], join(this.o.repo, root), this.rootEnv(root));
    if (push.code !== 0) throw new Error(`state push failed: ${firstLines(push.out, 3)}`);
  }

  /**
   * Apply the saved plan, then split the working state by module and write
   * each changed state, upstreams first, whether the apply finished or not.
   * Each lock is released once its state is written; one whose state could
   * not be written stays held, and the state is kept beside it.
   */
  async apply(): Promise<ComposedApply> {
    const p = this.planned;
    const { repo } = this.o;
    const members = (): ReportComposedMember[] => this.c.order.map((r) => ({ root: r, module: `module.${this.c.modules.get(r)}` }));
    if (!p?.plan) return { ok: false, members: members(), settled: [], error: "the composed run did not plan" };
    for (const r of this.c.order) {
      const e = await this.step(r, "before-apply", p.planFile);
      if (e) return { ok: false, members: members().map((m) => (m.root === r ? { ...m, apply: "not-started" as const, error: e } : { ...m, apply: "not-started" as const })), settled: [], error: `a step before the apply of ${r} failed, so nothing applied` };
    }
    let root: ComposedRoot;
    try {
      root = writeComposedRoot(repo, this.c, this.o.env);
    } catch (e) {
      return { ok: false, members: members(), settled: [], error: `the composed root could not be written: ${(e as Error).message}` };
    }
    let out = "";
    let code = 1;
    try {
      if (JSON.stringify(root.generated) !== JSON.stringify(p.generated)) {
        return { ok: false, members: members(), settled: [], error: "the composed root differs from the one planned, so nothing applied" };
      }
      const a = await this.exec(this.o.binary.path, ["apply", "-json", "-input=false", "-no-color", p.planFile], this.composeDir, this.composedEnv());
      out = a.stdout;
      code = a.code;
      for (const line of a.stdout.split("\n")) {
        try {
          const msg = (JSON.parse(line) as { "@message"?: string; type?: string })["@message"];
          if (msg && !/^(Plan to|Refreshing|Reading)/.test(msg)) this.log(`composed: ${msg}`);
        } catch {
          if (line.trim()) this.log(`composed: ${line}`);
        }
      }
    } finally {
      root.restore();
    }
    const mods = this.c.order.map((r) => this.c.modules.get(r)!);
    const ev = readApplyEvents(out, mods);
    const workingFile = existsSync(join(this.composeDir, "errored.tfstate")) ? join(this.composeDir, "errored.tfstate") : join(this.composeDir, "terraform.tfstate");
    let working: StateFile;
    try {
      working = JSON.parse(readFileSync(workingFile, "utf-8")) as StateFile;
    } catch (e) {
      // With no working state to split, nothing is written and every lock stays held: what applied is only in the binary's output.
      for (const r of this.c.order) this.heldOnPurpose.add(r);
      return { ok: false, members: members().map((m) => ({ ...m, state: "not-written" as const, lock_held: true, error: `the working state could not be read: ${(e as Error).message}` })), settled: [], error: "the working state could not be read after the apply" };
    }
    const result: ReportComposedMember[] = [];
    const settled: string[] = [];
    for (const r of this.c.order) {
      const m = this.c.modules.get(r)!;
      const planned = planCounts(p.slices.get(r)).changes;
      const { apply, done } = memberApply(m, planned, ev);
      const row: ReportComposedMember = { root: r, module: `module.${m}`, apply, changes: { done, planned }, ...(ev.errored.get(m) ? { error: ev.errored.get(m) } : {}) };
      const split = splitState(working, this.c, r, this.pulled.get(r) ?? null);
      if (!changesSomething(p.slices.get(r)) || split.same) {
        row.state = "unchanged";
        settled.push(r);
        await this.releaseOne(r);
      } else {
        const err = await this.writeWithRetries(r, split.state);
        if (err === undefined) {
          row.state = "written";
          settled.push(r);
          this.log(`${r}: wrote its state, serial ${split.state.serial}`);
          await this.releaseOne(r);
        } else {
          const kept = await this.keep(r, split.state);
          this.heldOnPurpose.add(r);
          Object.assign(row, { state: "not-written" as const, kept, lock_held: true, error: err });
          this.log(`${r}: its state could not be written (${err}); kept at ${kept}, and its lock stays held until a run of this wave writes it`);
        }
      }
      result.push(row);
    }
    for (const r of this.c.order) {
      const row = result.find((x) => x.root === r)!;
      if (row.apply === "applied" || row.apply === "no-changes") {
        const e = await this.step(r, "after-apply");
        if (e) row.error = e;
      }
    }
    const ok = code === 0 && result.every((x) => (x.apply === "applied" || x.apply === "no-changes") && x.state !== "not-written" && !x.error);
    return { ok, members: result, settled, ...(ok ? {} : { error: ev.other[0] ?? (code !== 0 ? "the composed apply failed" : result.find((x) => x.error)?.error) }) };
  }

  /** Write one state, retrying while the lock is held. Undefined once written; the last error otherwise. */
  private async writeWithRetries(root: string, state: StateFile): Promise<string | undefined> {
    const delays = this.o.retryDelays ?? DEFAULT_RETRIES;
    let last = "";
    for (let i = 0; i <= delays.length; i++) {
      try {
        await this.writeState(root, state);
        return undefined;
      } catch (e) {
        last = (e as Error).message;
        if (i < delays.length) {
          this.log(`${root}: the write of its state failed (${last}); trying again in ${Math.round(delays[i]! / 1000)}s`);
          await sleepMs(delays[i]!);
        }
      }
    }
    return last;
  }

  /** Keep a state that could not be written: beside it in its own backend, else as a file of the job's report directory. Returns where. */
  private async keep(root: string, state: StateFile): Promise<string> {
    const body = JSON.stringify(state, null, 2) + "\n";
    const object = this.objects.get(root);
    const lock = this.locks.find((l) => l.root === root && l.store);
    try {
      if (lock?.store) {
        await lock.store.writeBeside(UNWRITTEN_SUFFIX, body);
        return `${lock.store.location}${UNWRITTEN_SUFFIX}`;
      }
      if (object && "path" in object) {
        const file = resolve(this.o.repo, root, object.path) + UNWRITTEN_SUFFIX;
        writeFileSync(file, body);
        return relative(this.o.repo, file).split("\\").join("/");
      }
    } catch (e) {
      this.log(`${root}: the state could not be kept beside its backend's state either (${(e as Error).message}); it is kept as a file of the job`);
    }
    const file = join(this.o.repo, UNWRITTEN_DIR, `${safeName(root)}.tfstate`);
    writeWithDir(file, body);
    return `${UNWRITTEN_DIR}/${safeName(root)}.tfstate in the job's artifacts`;
  }

  private async releaseOne(root: string): Promise<void> {
    const mine = this.locks.filter((l) => l.root === root);
    this.locks = this.locks.filter((l) => l.root !== root);
    for (const l of mine) await l.release().catch((e: unknown) => this.log(`${root}: its lock could not be released: ${(e as Error).message}`));
  }

  /** Release every lock but those held on purpose, and take the composed root's directory away once nothing in it is needed. */
  async release(): Promise<void> {
    for (const r of [...new Set(this.locks.map((l) => l.root))]) if (!this.heldOnPurpose.has(r)) await this.releaseOne(r);
    rmSync(this.composeDir, { recursive: true, force: true });
  }
}

const isStoredBackend = (b: string): boolean => b === "s3" || b === "gcs" || b === "azurerm";

/**
 * The apply's waves with a composed run in the earliest wave its roots are
 * in: its roots taken out of every wave, and in that wave either the run's
 * target (`target`, as chant's spec holds it) or its roots, upstreams first
 * (as the run view and the gates read them). A wave left with none stays,
 * empty: it finds nothing to apply.
 */
export function wavesWithRun(waves: readonly string[][], c: Composition | undefined, target: boolean): string[][] {
  if (!c || c.wave === undefined || c.fallback) return waves.map((w) => [...w]);
  const inRun = new Set(c.roots);
  return waves.map((w, i) => [...w.filter((r) => !inRun.has(r)), ...(i + 1 === c.wave ? (target ? [composeTarget(c.wave)] : c.order) : [])]);
}

/** The log line that says what `waves.compose` came to. */
export function compositionLine(c: Composition): string {
  return c.fallback || c.wave === undefined
    ? `compose: ${c.fallback?.reason ?? "no wave runs it"}, so the change applies in waves`
    : `compose: ${c.order.join(", ")} apply as one composed run in wave ${c.wave} (${composeTarget(c.wave)})`;
}
