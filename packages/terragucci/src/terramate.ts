/**
 * Terramate mode: how terragucci tells a Terramate repo, takes its stacks as
 * roots, and cuts waves from the order Terramate gives them.
 *
 * A root is a stack directory that holds Terraform, as `terramate list` names
 * it. Terramate's generated code is committed, so the stacks are on disk and
 * a pull request's diff names the stacks it changes, as for plain roots.
 *
 * Order: a stack's `after` and `before` (stack paths, directories and
 * `tag:` filters), resolved by Terramate itself (`terramate experimental
 * run-graph`), and its nesting: a parent stack runs before the stacks under
 * it. A stack that holds no Terraform is no root; the order through it is
 * kept. The waves are the dependency layers, as Terragrunt units' are.
 *
 * Outputs sharing: an `input` block in a stack reads an output of the stack
 * `from_stack_id` names. It is an edge, as an Atmos `!terraform.state` read
 * is (./atmos.ts): the stage reads the upstream's outputs once it has
 * credentials and fills the input's variable, holding the stack back while
 * the upstream has no state. It never plans on the input's `mock`. A `value`
 * other than `outputs.<name>.value`, or a path of keys into it, is refused.
 *
 * Every job runs `terragucci terramate generate` as its synth: `terramate
 * generate --detailed-exit-code`, which fails the job when the committed
 * generated code is stale, as `terramate run` refuses to run on it; then each
 * stack's edges are written beside it in `.terragucci-terramate.json`, which
 * the stages read for affected selection and for the inputs.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { terragruntExec } from "./binary-env";
import { ConfigError, responseTo, ROOTS_NOT_TERRAMATE, type ResolvedSettings } from "./config";
import { TERRAMATE_EDGES_FILE, type AtmosRead } from "./atmos";
import { rootDependencies, type RootReason } from "./detect";
import { unitWaves } from "./terragrunt";

export { TERRAMATE_EDGES_FILE };

/** The Terramate release the jobs install, checked against the release's checksums. */
export const TERRAMATE_VERSION = "0.17.3";

/** The project file at a Terramate repo's root. */
export const TERRAMATE_ROOT_MARKER = "terramate.tm.hcl";

/** The file a stack is usually declared in. */
export const TERRAMATE_STACK_MARKER = "stack.tm.hcl";

/** The command every job runs before it reads the stacks: the generate check, then the edges. */
export const TERRAMATE_GENERATE = "terragucci terramate generate";

/** The environment Terramate runs with: no version check against its servers. */
export const TERRAMATE_ENV = { CHECKPOINT_DISABLE: "1" } as const;

const SKIP_DIRS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", ".terragucci"]);

/** Whether `repo` is a Terramate repo: the reason (the marker's path), or undefined. */
export function detectTerramate(repo: string): string | undefined {
  if (existsSync(join(repo, TERRAMATE_ROOT_MARKER))) return TERRAMATE_ROOT_MARKER;
  const walk = (rel: string, depth: number): string | undefined => {
    if (depth > 8) return undefined;
    let names: string[];
    try {
      names = readdirSync(join(repo, rel)).sort();
    } catch {
      return undefined;
    }
    if (names.includes(TERRAMATE_STACK_MARKER)) return posix.join(rel, TERRAMATE_STACK_MARKER);
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const sub = posix.join(rel, name);
      try {
        if (!statSync(join(repo, sub)).isDirectory()) continue;
      } catch {
        continue;
      }
      const hit = walk(sub, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(".", 0)?.replace(/^\.\//, "");
}

export interface TerramateOptions {
  /** The `terramate` executable. Default: `TERRAGUCCI_TERRAMATE`, then `terramate` on the path. */
  terramate?: string;
  exec?: TerragruntExec;
}

/** One stack, as terragucci runs it. */
export interface TerramateStack {
  /** Its directory from the repo root: the root's name. */
  path: string;
  /** `stack.id`, which an input's `from_stack_id` names. */
  id?: string;
  /** Whether it holds Terraform; one that does not is no root. */
  terraform: boolean;
  /** The stacks that run before it, by path: its `after`, the `before` that name it, its parent stack, and each input's upstream. */
  dependencies: string[];
  /** The inputs it reads from another stack's outputs, which the stage fills in. */
  reads: AtmosRead[];
}

async function run(repo: string, args: string[], options: TerramateOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const terramate = options.terramate ?? process.env.TERRAGUCCI_TERRAMATE ?? "terramate";
  const exec = options.exec ?? terragruntExec;
  let out: Awaited<ReturnType<TerragruntExec>>;
  try {
    out = await exec(terramate, args, { cwd: repo, env: { ...TERRAMATE_ENV } });
  } catch (e) {
    throw new ConfigError(`terramate ${args[0]} did not run (${(e as Error).message}); put Terramate ${TERRAMATE_VERSION} on the path, or set TERRAGUCCI_TERRAMATE`);
  }
  const why = (out.stderr || out.stdout).trim();
  if (out.code === null || (out.code !== 0 && /ENOENT|not found/.test(why.split("\n")[0] ?? ""))) {
    throw new ConfigError(`terramate ${args[0]} did not run (${why.split("\n")[0]}); put Terramate ${TERRAMATE_VERSION} on the path, or set TERRAGUCCI_TERRAMATE`);
  }
  return out;
}

const tail = (s: string): string => s.trim().split("\n").filter((l) => l.trim()).slice(0, 12).join("\n");

/** The edges of `terramate experimental run-graph --label stack.dir`, as [before, after] pairs of stack paths. */
export function parseRunGraph(dot: string): [string, string][] {
  const labels = new Map<string, string>();
  for (const m of dot.matchAll(/^\s*(\w+)\s*\[\s*label\s*=\s*"([^"]*)"/gm)) labels.set(m[1], m[2].replace(/^\/+/, "") || ".");
  const out: [string, string][] = [];
  for (const m of dot.matchAll(/^\s*(\w+)\s*->\s*(\w+)/gm)) {
    const a = labels.get(m[1]);
    const b = labels.get(m[2]);
    if (a && b && a !== b) out.push([a, b]);
  }
  return out;
}

/** The HCL of a file with its comments blanked out, strings kept. */
function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Each top-level block of `type` in the HCL: its labels and its body. */
function blocks(text: string, type: string): { labels: string[]; body: string }[] {
  const src = stripComments(text);
  const out: { labels: string[]; body: string }[] = [];
  const head = new RegExp(`(^|\\n)\\s*${type}((?:\\s+"[^"]*")*)\\s*\\{`, "g");
  for (const m of src.matchAll(head)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    out.push({ labels: [...m[2].matchAll(/"([^"]*)"/g)].map((l) => l[1]), body: src.slice(start, i - 1) });
  }
  return out;
}

/** An attribute's expression in a block body, as written, on its line. */
function attribute(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*([^\\n]*)`));
  return m ? m[2].trim() : undefined;
}

const literal = (expr: string | undefined): string | undefined => expr?.match(/^"([^"\\]*)"$/)?.[1];

/** The Terramate files of a stack directory: what Terramate reads there, `*.tm` and `*.tm.hcl`. */
function tmFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".tm") || n.endsWith(".tm.hcl"))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** An input as a stack's files declare it, before its stack id is resolved. */
export interface TerramateInput {
  var: string;
  fromStackId: string;
  /** The output, then the keys into its value. */
  output: string[];
  /** The block, in words, for the logs. */
  function: string;
}

/**
 * The inputs an HCL text declares (`input "<var>" { from_stack_id, value }`).
 * Refused: an input without a literal from_stack_id, and a value other than
 * `outputs.<name>.value` or a path of keys into it, which terragucci does
 * not evaluate.
 */
export function parseInputs(stack: string, text: string): TerramateInput[] {
  const out: TerramateInput[] = [];
  for (const b of blocks(text, "input")) {
    const name = b.labels[0];
    if (!name) continue;
    const what = `${stack} declares input "${name}"`;
    const from = literal(attribute(b.body, "from_stack_id"));
    if (!from) throw new ConfigError(`${what} without a literal from_stack_id; terragucci reads an input from the stack whose id it names`);
    const value = attribute(b.body, "value") ?? "";
    const m = value.match(/^outputs\.([A-Za-z_][\w-]*)\.value((?:\.[A-Za-z_][\w-]*|\["[^"\\]+"\])*)$/);
    if (!m) {
      throw new ConfigError(
        `${what} with value = ${value || "nothing"}, which terragucci does not evaluate; read an output by name, outputs.<name>.value, or a path of keys into it, ` +
          `or read the upstream's state with a terraform_remote_state data source`,
      );
    }
    const keys = [...m[2].matchAll(/\.([A-Za-z_][\w-]*)|\["([^"\\]+)"\]/g)].map((k) => k[1] ?? k[2]);
    out.push({ var: name, fromStackId: from, output: [m[1], ...keys], function: `input "${name}" from stack ${from}, ${value}` });
  }
  return out;
}

/** The literal `id` of the stack block in an HCL text, if it has one. */
export function parseStackId(text: string): string | undefined {
  for (const b of blocks(text, "stack")) {
    const id = literal(attribute(b.body, "id"));
    if (id) return id;
  }
  return undefined;
}

/** Whether a directory holds Terraform files of its own. */
function holdsTerraform(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => /\.(tf|tofu)(\.json)?$/.test(n));
  } catch {
    return false;
  }
}

/**
 * The stacks and their edges, from the stacks Terramate lists, the order its
 * run graph resolves, nesting, and the inputs each stack declares. A stack
 * that holds no Terraform is dropped and the order through it kept; an input
 * from such a stack, or from an id no stack has, is refused.
 */
export function terramateGraph(
  repo: string,
  paths: readonly string[],
  order: readonly [string, string][],
  files: { id?: (path: string) => string | undefined; inputs?: (path: string) => TerramateInput[]; terraform?: (path: string) => boolean } = {},
): TerramateStack[] {
  const read = (p: string): string => tmFiles(join(repo, p)).map((f) => readFileSync(f, "utf-8")).join("\n");
  const idOf = files.id ?? ((p: string) => parseStackId(read(p)));
  const inputsOf = files.inputs ?? ((p: string) => parseInputs(p, read(p)));
  const tfOf = files.terraform ?? ((p: string) => holdsTerraform(join(repo, p)));
  const set = new Set(paths);
  const before = new Map<string, Set<string>>(paths.map((p) => [p, new Set<string>()]));
  for (const [a, b] of order) if (set.has(a) && set.has(b)) before.get(b)!.add(a);
  // A parent stack runs before the stacks under it.
  for (const p of paths) {
    for (let d = posix.dirname(p); d !== "." && d !== "/" && d !== ""; d = posix.dirname(d)) {
      if (set.has(d)) {
        before.get(p)!.add(d);
        break;
      }
    }
    if (p !== "." && set.has(".")) before.get(p)!.add(".");
  }
  const ids = new Map<string, string>();
  for (const p of paths) {
    const id = idOf(p);
    if (!id) continue;
    if (ids.has(id)) throw new ConfigError(`stacks ${ids.get(id)} and ${p} both have id ${id}`);
    ids.set(id, p);
  }
  const idByPath = new Map([...ids].map(([id, p]) => [p, id]));
  const terraform = new Map(paths.map((p) => [p, tfOf(p)]));
  const reads = new Map<string, AtmosRead[]>();
  for (const p of paths) {
    const inputs = inputsOf(p);
    if (inputs.length > 0 && !terraform.get(p)) throw new ConfigError(`${p} declares inputs but holds no Terraform for them to fill`);
    for (const i of inputs) {
      const up = ids.get(i.fromStackId);
      const what = `${p} reads ${i.var} from stack ${i.fromStackId}`;
      if (!up) throw new ConfigError(`${what}, which no stack has as its id`);
      if (up === p) throw new ConfigError(`${what}, its own outputs`);
      if (!terraform.get(up)) throw new ConfigError(`${what} (${up}), which holds no Terraform, so it has no outputs`);
      // An input is an edge: the stack waits for the upstream it reads.
      before.get(p)!.add(up);
      if (!reads.has(p)) reads.set(p, []);
      reads.get(p)!.push({ var: i.var, upstream: up, output: i.output, function: i.function });
    }
  }
  // Through a stack with no Terraform: its own upstreams stand in for it.
  const closure = (p: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    for (const d of before.get(p) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (terraform.get(d)) out.add(d);
      else for (const x of closure(d, seen)) out.add(x);
    }
    return out;
  };
  return [...paths]
    .sort()
    .map((p) => ({
      path: p,
      ...(idByPath.has(p) ? { id: idByPath.get(p)! } : {}),
      terraform: terraform.get(p)!,
      dependencies: [...closure(p)].filter((d) => d !== p).sort(),
      reads: reads.get(p) ?? [],
    }));
}

/**
 * The stacks of the repo, from Terramate: `terramate list` names them, and
 * `terramate experimental run-graph` resolves their `after` and `before`. A
 * path in either that names no stack is refused, where Terramate only warns:
 * the order is explicit, so a missing stack is a mistake.
 */
export async function terramateStacks(repo: string, options: TerramateOptions = {}): Promise<TerramateStack[]> {
  const listed = await run(repo, ["list"], options);
  if (listed.code !== 0) throw new ConfigError(`terramate list failed (exit ${listed.code}):\n${tail(listed.stderr || listed.stdout)}`);
  const paths = listed.stdout.split("\n").map((l) => l.trim().replace(/\/+$/, "")).filter(Boolean).map((p) => posix.normalize(p));
  const graph = await run(repo, ["experimental", "run-graph", "--label", "stack.dir"], options);
  const invalid = `${graph.stderr}\n${graph.stdout}`.split("\n").filter((l) => /references an invalid path/.test(l));
  if (invalid.length > 0) throw new ConfigError(`terramate: ${invalid.map((l) => l.replace(/^\s*(Warning|WRN):?\s*/i, "")).join("; ")}; the order names a stack that is not there, so fix the path`);
  if (graph.code !== 0) throw new ConfigError(`terramate experimental run-graph failed (exit ${graph.code}):\n${tail(graph.stderr || graph.stdout)}`);
  return terramateGraph(repo, paths, parseRunGraph(graph.stdout));
}

/** The roots among the stacks: the ones that hold Terraform. */
export function terramateRoots(stacks: readonly TerramateStack[]): TerramateStack[] {
  return stacks.filter((s) => s.terraform);
}

/** The waves the roots apply in: their dependency layers, the canary stacks' layers first. A cycle is refused. */
export function stackWaves(stacks: readonly TerramateStack[], canary: readonly string[] = [], extra: Map<string, Set<string>> = new Map()): string[][] {
  const roots = terramateRoots(stacks);
  try {
    return unitWaves(
      roots.map((s) => ({ path: s.path, dependencies: [...new Set([...s.dependencies, ...(extra.get(s.path) ?? [])])].filter((d) => d !== s.path).sort() })),
      canary,
    );
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

/**
 * `terramate generate --detailed-exit-code`: undefined when the committed
 * generated code is up to date; why not, when Terramate changed a file.
 */
export async function generateCheck(repo: string, options: TerramateOptions = {}): Promise<string | undefined> {
  const out = await run(repo, ["generate", "--detailed-exit-code"], options);
  if (out.code === 0) return undefined;
  const report = tail(`${out.stdout}\n${out.stderr}`);
  if (out.code === 2) {
    return `the generated code is stale: terramate generate changed files the repo commits\n${report}\nrun terramate generate and commit what it writes`;
  }
  throw new ConfigError(`terramate generate failed (exit ${out.code}):\n${report}`);
}

/** `terragucci terramate generate`: the generate check, then each root's edges beside it. The lines it prints. */
export async function terramateWrite(repo: string, options: TerramateOptions = {}): Promise<string[]> {
  const stale = await generateCheck(repo, options);
  if (stale) throw new ConfigError(stale);
  const stacks = terramateRoots(await terramateStacks(repo, options));
  if (stacks.length === 0) throw new ConfigError("terramate list names no stack that holds Terraform");
  for (const s of stacks) writeFileSync(join(repo, s.path, TERRAMATE_EDGES_FILE), `${JSON.stringify({ dependencies: s.dependencies, reads: s.reads }, null, 2)}\n`);
  return [
    "terramate generate: the generated code is up to date",
    ...stacks.map((s) => `${s.path}: ${s.dependencies.length ? `after ${s.dependencies.join(", ")}` : "first"}${s.reads.length ? `, reads ${s.reads.map((r) => `${r.var} from ${r.upstream}`).join(", ")}` : ""}`),
  ];
}

/** What a repo's shape may refuse; the names follow the Shape of gucci7-shape (architecture-adapters.md). */
export type TerramateFeature = "roots" | "synth" | "drift-pr" | "rollouts";

/** What discovery found: the roots, their waves, and the edges between them. */
export interface TerramateDiscovery {
  roots: RootReason[];
  layers: string[][];
  /** For each root, the stacks whose outputs its inputs read. */
  reads: Map<string, Set<string>>;
  /** For each root, every stack that runs before it. */
  order: Map<string, Set<string>>;
  /** Stacks that hold no Terraform, so are no roots. */
  skipped: string[];
  notes: string[];
}

/**
 * A Terramate repo as every command sees it, resolved once: the per-root
 * engine after a prepare step (the generate check and the edges), the stacks
 * as roots, and what the shape refuses. Shaped like gucci7-shape's `Shape`,
 * so it moves there whole.
 */
export interface TerramateShape {
  kind: "terramate";
  /** The marker that turned Terramate mode on. */
  reason: string;
  engine: "per-root";
  /** What the jobs run before they read the stacks. */
  prepare: string;
  /** The Terramate release the jobs install. */
  version: string;
  discover(settings: ResolvedSettings): Promise<TerramateDiscovery>;
  /** A stack runs in the job's environment as it is: Terramate selects no workspace. */
  rootEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  refuses(feature: TerramateFeature, settings: ResolvedSettings): string | undefined;
  /** Where an edit to a root belongs: the stack's own directory, whose generated files come from its .tm.hcl. */
  sourceOf(root: string): string;
}

/** The Terramate shape of `repo`, or undefined when it is no Terramate repo. */
export function terramateShape(repo: string, options: TerramateOptions = {}): TerramateShape | undefined {
  const reason = detectTerramate(repo);
  if (!reason) return undefined;
  return {
    kind: "terramate",
    reason,
    engine: "per-root",
    prepare: TERRAMATE_GENERATE,
    version: TERRAMATE_VERSION,
    rootEnv: (_root, env) => env,
    sourceOf: (root) => root,
    refuses(feature, settings) {
      switch (feature) {
        case "roots":
          return settings.roots ? ROOTS_NOT_TERRAMATE : undefined;
        case "synth":
          return settings.synth ? `synth is for roots a command writes; a Terramate repo commits its generated code, and its jobs check it with ${TERRAMATE_GENERATE}, so remove synth` : undefined;
        case "drift-pr":
          return settings.drift && responseTo(settings, "drift") === "pull-request"
            ? "respond.drift: the drift pull request writes each live value into a stack's files, and terramate generate owns the generated ones; set respond.drift to attribute, which names who changed each value in the drift issue, or to off"
            : undefined;
        case "rollouts":
          return settings.rollouts && responseTo(settings, "rollout") !== "off"
            ? "rollouts: a rollout moves a pin in each stack's files, and in a Terramate repo the pin is usually in code terramate generate writes from a .tm.hcl, which terragucci does not edit; leave rollouts unset"
            : undefined;
      }
    },
    async discover(settings) {
      const stacks = await terramateStacks(repo, options);
      const found = terramateRoots(stacks);
      if (found.length === 0) {
        throw new ConfigError(`found no Terramate stacks that hold Terraform (${reason} turned Terramate mode on): terramate list names ${stacks.length === 0 ? "no stack" : stacks.map((s) => s.path).join(", ")}`);
      }
      // terraform_remote_state reads between stacks cut waves too, as they do for plain roots.
      const remote = rootDependencies(repo, found.map((s) => s.path));
      const skipped = stacks.filter((s) => !s.terraform).map((s) => s.path);
      return {
        roots: found.map((s) => ({ root: s.path, reason: `terramate list${s.dependencies.length ? `, after ${s.dependencies.join(", ")}` : ""}` })),
        layers: stackWaves(stacks, settings.waves?.canary, remote),
        reads: new Map(found.filter((s) => s.reads.length > 0).map((s) => [s.path, new Set(s.reads.map((r) => r.upstream))])),
        order: new Map(found.filter((s) => s.dependencies.length > 0).map((s) => [s.path, new Set(s.dependencies)])),
        skipped,
        notes: skipped.length > 0 ? [`stacks with no Terraform are no roots: ${skipped.join(", ")}; the order through them is kept`] : [],
      };
    },
  };
}
