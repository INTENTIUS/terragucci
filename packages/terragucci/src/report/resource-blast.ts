/**
 * A change's blast radius by resource: for each resource a root's plan
 * changes, the resources that depend on it, in its own root and in the roots
 * that read its root's outputs, followed through.
 *
 * Within a root the edges are the references `show -json` gives in the
 * plan's `configuration`: each resource's expressions, `count`, `for_each`
 * and `depends_on`, each output's expression, and each module call's
 * arguments, into the module and out through its outputs. A reference to a
 * local is followed through the local's value as the module's code writes it.
 *
 * Between roots the edges are outputs: a resource that changes reaches an
 * output of its root, and a root that reads that root's state through
 * `terraform_remote_state` (or its estate's outputs through
 * `terraform_estate_outputs`) reaches every resource that reads that output,
 * and on through that root's own outputs. A reader whose plan this run did
 * not make is named in the root-level blast radius only.
 */
import { join } from "node:path";
import { estateOf, estateOutputReads, localsText } from "../detect";
import type { ReportBlastResource, ReportBlastReach } from "./schema";

/** A root's plan as `show -json` prints it, as much as this reads. */
interface PlanJson {
  resource_changes?: { address?: string; mode?: string; change?: { actions?: string[] } }[];
  configuration?: { root_module?: ModuleJson };
}

interface ModuleJson {
  resources?: { address?: string; mode?: string; expressions?: unknown; count_expression?: unknown; for_each_expression?: unknown; depends_on?: string[] }[];
  outputs?: Record<string, { expression?: unknown }>;
  module_calls?: Record<string, { source?: string; expressions?: Record<string, unknown>; module?: ModuleJson }>;
}

/** One root's plan, and where its outputs go. */
export interface BlastRoot {
  root: string;
  plan: unknown;
  /** The roots whose outputs it reads: the data block (`terraform_remote_state.<label>` or `terraform_estate_outputs.<label>`) and the root it reads. */
  reads: { data: string; upstream: string }[];
  /** A module's locals, by its source as the module call names it (`""` for the root): each local's value as written. */
  locals?: (source: string) => ReadonlyMap<string, string>;
}

/** A root's references as edges: for each node, the nodes that refer to it. */
interface Graph {
  dependents: Map<string, Set<string>>;
  /** The managed resources, by node. */
  resources: Set<string>;
}

const READERS = ["terraform_remote_state", "terraform_estate_outputs"] as const;
/** Where a reader's values are: `outputs` for remote state, `values` for estate outputs. */
const VALUES: Record<(typeof READERS)[number], string> = { terraform_remote_state: "outputs", terraform_estate_outputs: "values" };

const IDENT = "[A-Za-z_][\\w-]*";
const KEY = `(?:\\.(${IDENT})|\\["([^"]+)"\\])`;
/** A reference in an expression's text, for a local's value. */
const REFERENCE = new RegExp(`\\b(?:data\\.${IDENT}\\.${IDENT}(?:\\.(?:outputs|values)${KEY}?)?|module\\.${IDENT}(?:\\.${IDENT})?|local\\.${IDENT}|var\\.${IDENT}|[a-z][a-z0-9]*_[a-z0-9_]*\\.${IDENT})`, "g");

/**
 * A reference as a node of the graph, in a module at `prefix` (`module.a.`,
 * or `""` for the root): a resource (`aws_sqs_queue.jobs`,
 * `data.aws_iam_policy.x`), a local, a variable, a module's output, or one
 * output a reader reads (`read.<data>.<output>`, `*` for all of them).
 */
export function nodeOf(ref: string, prefix: string): string | undefined {
  const r = ref.trim();
  for (const type of READERS) {
    const m = new RegExp(`^data\\.${type}\\.(${IDENT})(?:\\[[^\\]]*\\])?(?:\\.${VALUES[type]}${KEY}?)?`).exec(r);
    if (m) return `${prefix}read.${type}.${m[1]}.${m[2] ?? m[3] ?? "*"}`;
  }
  const bare = r.replace(/\[[^\]]*\]/g, "");
  const parts = bare.split(".");
  switch (parts[0]) {
    case "module":
      return parts[1] ? `${prefix}module.${parts[1]}.output.${parts[2] ?? "*"}` : undefined;
    case "local":
    case "var":
      return parts[1] ? `${prefix}${parts[0]}.${parts[1]}` : undefined;
    case "data":
      return parts[2] ? `${prefix}data.${parts[1]}.${parts[2]}` : undefined;
    case "each":
    case "count":
    case "self":
    case "path":
    case "terraform":
      return undefined;
    default:
      return parts[1] ? `${prefix}${parts[0]}.${parts[1]}` : undefined;
  }
}

/** Every `references` list in an expression, nested blocks included. */
function referenceLists(expr: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(expr)) for (const e of expr) referenceLists(e, out);
  else if (expr && typeof expr === "object") {
    const o = expr as Record<string, unknown>;
    if (Array.isArray(o.references)) out.push(o.references.filter((x): x is string => typeof x === "string"));
    for (const [k, v] of Object.entries(o)) if (k !== "references" && k !== "constant_value") referenceLists(v, out);
  }
  return out;
}

/** The nodes one expression refers to. A list names `a.b.c`, then `a.b`, then `a`: the most specific is kept. */
function refsOf(expr: unknown, prefix: string): string[] {
  const out = new Set<string>();
  for (const list of referenceLists(expr)) {
    for (const r of list) {
      if (list.some((o) => o !== r && (o.startsWith(`${r}.`) || o.startsWith(`${r}[`)))) continue;
      const n = nodeOf(r, prefix);
      if (n) out.add(n);
    }
  }
  return [...out];
}

/** A root's graph from its plan's configuration, its locals read from its code. */
function graphOf(plan: unknown, locals: BlastRoot["locals"]): Graph {
  const g: Graph = { dependents: new Map(), resources: new Set() };
  const edge = (from: string, to: string): void => {
    if (from === to) return;
    if (!g.dependents.has(from)) g.dependents.set(from, new Set());
    g.dependents.get(from)!.add(to);
  };
  const walk = (m: ModuleJson | undefined, prefix: string, source: string): void => {
    if (!m) return;
    for (const r of m.resources ?? []) {
      if (!r.address) continue;
      const node = `${prefix}${r.address}`;
      if (r.mode !== "data") g.resources.add(node);
      for (const ref of [...refsOf(r.expressions, prefix), ...refsOf(r.count_expression, prefix), ...refsOf(r.for_each_expression, prefix)]) edge(ref, node);
      for (const d of r.depends_on ?? []) {
        const n = nodeOf(d, prefix);
        if (n) edge(n, node);
      }
    }
    for (const [name, o] of Object.entries(m.outputs ?? {})) {
      const node = `${prefix}output.${name}`;
      for (const ref of refsOf(o.expression, prefix)) edge(ref, node);
      // A reader of the whole module reads this output too.
      if (prefix) edge(node, `${prefix}output.*`);
    }
    for (const [name, value] of locals?.(source) ?? new Map<string, string>()) {
      for (const ref of value.match(REFERENCE) ?? []) {
        const n = nodeOf(ref, prefix);
        if (n) edge(n, `${prefix}local.${name}`);
      }
    }
    for (const [name, call] of Object.entries(m.module_calls ?? {})) {
      const inner = `${prefix}module.${name}.`;
      for (const [arg, expr] of Object.entries(call.expressions ?? {})) for (const ref of refsOf(expr, prefix)) edge(ref, `${inner}var.${arg}`);
      const local = call.source && /^\.\.?\//.test(call.source) ? joinSource(source, call.source) : undefined;
      walk(call.module, inner, local ?? `\u0000${call.source ?? ""}`);
    }
  };
  walk((plan as PlanJson | undefined)?.configuration?.root_module, "", "");
  return g;
}

/** A local module's source against its caller's: `../../modules/x` from `""` stays as written. */
function joinSource(from: string, to: string): string {
  if (from.startsWith("\u0000")) return `\u0000${to}`;
  const parts = from ? from.split("/") : [];
  for (const p of to.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

/** The nodes reached from `seeds`, the seeds left out. */
function reach(g: Graph, seeds: Iterable<string>): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seen];
  const out = new Set<string>();
  while (queue.length) {
    const n = queue.shift()!;
    for (const d of g.dependents.get(n) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      out.add(d);
      queue.push(d);
    }
  }
  return out;
}

/** A resource instance's address as a node: its instance keys left out. */
const configAddress = (address: string): string => address.replace(/\[[^\]]*\]/g, "");

/** The managed resources a plan changes: anything but a no-op or a read. */
export function changedResources(plan: unknown): { address: string; actions: string[] }[] {
  return ((plan as PlanJson | undefined)?.resource_changes ?? [])
    .filter((c) => c.address && c.mode !== "data")
    .map((c) => ({ address: c.address!, actions: c.change?.actions ?? [] }))
    .filter((c) => c.actions.length > 0 && !c.actions.every((a) => a === "no-op" || a === "read"));
}

/** The root outputs among `nodes`, by name. */
const outputsIn = (nodes: Iterable<string>): string[] => [...nodes].filter((n) => /^output\.[^.]+$/.test(n)).map((n) => n.slice("output.".length));

/**
 * For each resource the `changed` roots' plans change, what depends on it:
 * the resources its own root's references reach, and the resources of each
 * root that reads an output those reach, followed through those roots'
 * outputs. Nearest first; a resource that reaches nothing is left out.
 */
export function resourceBlast(roots: readonly BlastRoot[], changed: readonly string[]): ReportBlastResource[] {
  const byRoot = new Map(roots.map((r) => [r.root, r]));
  const graphs = new Map<string, Graph>();
  const graph = (root: string): Graph => {
    if (!graphs.has(root)) graphs.set(root, graphOf(byRoot.get(root)!.plan, byRoot.get(root)!.locals));
    return graphs.get(root)!;
  };
  /** The roots that read `root`'s outputs, each with the data blocks it reads them through. */
  const readersOf = (root: string): { root: string; data: string[] }[] =>
    roots.filter((r) => r.root !== root).map((r) => ({ root: r.root, data: r.reads.filter((x) => x.upstream === root).map((x) => x.data) })).filter((r) => r.data.length > 0);

  const out: ReportBlastResource[] = [];
  for (const root of [...changed].sort()) {
    if (!byRoot.has(root)) continue;
    for (const c of changedResources(byRoot.get(root)!.plan)) {
      const start = configAddress(c.address);
      const reaches: ReportBlastReach[] = [];
      const listed = new Set<string>([`${root}\u0000${start}`]);
      const take = (r: string, nodes: Iterable<string>, through?: ReportBlastReach["through"]): void => {
        const g = graph(r);
        for (const n of [...nodes].sort()) {
          if (!g.resources.has(n) || listed.has(`${r}\u0000${n}`)) continue;
          listed.add(`${r}\u0000${n}`);
          reaches.push({ root: r, address: n, ...(through ? { through } : {}) });
        }
      };
      const own = reach(graph(root), [start]);
      take(root, own);
      // The outputs each root in the radius makes from the change, and the roots that read them, nearest first.
      const crossed = new Map<string, Set<string>>([[root, new Set(outputsIn(own))]]);
      const queue = [root];
      while (queue.length) {
        const up = queue.shift()!;
        const outputs = crossed.get(up)!;
        if (outputs.size === 0) continue;
        for (const reader of readersOf(up)) {
          const g = graph(reader.root);
          for (const output of [...outputs].sort()) {
            const seeds = reader.data.flatMap((d) => [`read.${d}.${output}`, `read.${d}.*`]);
            const got = reach(g, seeds);
            take(reader.root, got, { root: up, output });
            const more = outputsIn(got);
            const held = crossed.get(reader.root) ?? new Set<string>();
            const grew = more.some((o) => !held.has(o));
            for (const o of more) held.add(o);
            crossed.set(reader.root, held);
            if (grew && !queue.includes(reader.root)) queue.push(reader.root);
          }
        }
      }
      if (reaches.length > 0) out.push({ root, address: c.address, actions: c.actions, reaches });
    }
  }
  return out;
}

/**
 * The roots this run planned, as `resourceBlast` reads them: each plan, the
 * data blocks through which it reads another root's outputs (`blocks`, each
 * root's `terraform_remote_state` blocks as ../detect.ts lines them up, and
 * its `terraform_estate_outputs` blocks, by the root that holds the estate),
 * and its modules' locals from the code.
 */
export function blastRootsOf(repo: string, all: readonly string[], plans: readonly { path: string; plan?: unknown }[], blocks: ReadonlyMap<string, readonly { name: string; upstream: string }[]>): BlastRoot[] {
  const owner = new Map<string, string>();
  for (const r of all) {
    const e = estateOf(join(repo, r)).estate;
    if (e) owner.set(e, r);
  }
  return plans
    .filter((p) => p.plan !== undefined)
    .map((p) => {
      const reads = [
        ...(blocks.get(p.path) ?? []).map((b) => ({ data: `terraform_remote_state.${b.name}`, upstream: b.upstream })),
        ...estateOutputReads(join(repo, p.path)).flatMap((e) => (owner.has(e.estate) && owner.get(e.estate) !== p.path ? [{ data: `terraform_estate_outputs.${e.name}`, upstream: owner.get(e.estate)! }] : [])),
      ];
      const cache = new Map<string, ReadonlyMap<string, string>>();
      const locals = (source: string): ReadonlyMap<string, string> => {
        if (source.startsWith("\u0000")) return new Map();
        if (!cache.has(source)) cache.set(source, localsText(join(repo, p.path, source)));
        return cache.get(source)!;
      };
      return { root: p.path, plan: p.plan, reads, locals };
    });
}
