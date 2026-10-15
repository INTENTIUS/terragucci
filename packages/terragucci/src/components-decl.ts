/**
 * `terragucci.components.json` (schema terragucci.components/v1): the repo's
 * roots as chant components, grouped by wave, under the pipeline's jobs that
 * apply them. `terragucci init` writes it at the repo's root beside the
 * workflow it renders, so behold can draw a terragucci repo the way it draws
 * a chant one. The workflow is unchanged by it.
 *
 * - `roots`: each root's name, as terragucci names it everywhere, and its
 *   directory in the repo.
 * - `components`: one per root, in chant's portable component form. A root's
 *   `dependsOn` is terragucci's own order (state reads plus `waves.after`, or
 *   what Terragrunt, Atmos or Terramate gave). When that order alone does not
 *   layer into terragucci's waves, as when `waves.canary` reorders them, each
 *   root in wave k also depends on every root in wave k-1, so chant's wave
 *   grouping equals terragucci's waves.
 * - `pipeline.jobs`: the jobs that apply roots, named as the rendered workflow
 *   names them (render.ts `applyJobs`).
 */
import { version as VERSION } from "../package.json";
import type { ForgeName } from "./config";
import type { PipelineApplyJob } from "./render";

export const COMPONENTS_PATH = "terragucci.components.json";
export const COMPONENTS_SCHEMA = "terragucci.components/v1";
const GENERATED_BY = "terragucci";

export interface ComponentsDecl {
  schema: typeof COMPONENTS_SCHEMA;
  generated_by: string;
  roots: Record<string, { dir: string }>;
  components: { name: string; dependsOn: string[]; deploy: { phase: "Apply"; steps: { kind: "terraform-apply"; root: string }[] }[] }[];
  pipeline: { path: string; forge: ForgeName; jobs: PipelineApplyJob[] };
}

export interface ComponentsDeclInput {
  /** terragucci's waves, in order: applyWaves(layers, canary) for plain roots, the shape's layers otherwise. */
  waves: string[][];
  /** For each root, every root it must follow (Discovered.order). A root missing from it follows none. */
  order: ReadonlyMap<string, ReadonlySet<string>>;
  /** A root's directory in the repo. Default: its name. */
  dirOf?: (root: string) => string;
  pipeline: { path: string; forge: ForgeName; applyJobs: PipelineApplyJob[] };
}

/** Kahn layering of `deps` over `roots`, each layer sorted: the waves chant's resolveComponentGraph groups components into. */
export function dependencyWaves(roots: readonly string[], deps: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const done = new Set<string>();
  const out: string[][] = [];
  while (done.size < roots.length) {
    const layer = roots.filter((r) => !done.has(r) && [...(deps.get(r) ?? [])].every((d) => done.has(d))).sort();
    if (layer.length === 0) throw new Error(`these roots depend on each other in a cycle: ${roots.filter((r) => !done.has(r)).join(", ")}`);
    layer.forEach((r) => done.add(r));
    out.push(layer);
  }
  return out;
}

const sameWaves = (a: string[][], b: string[][]): boolean => JSON.stringify(a.map((w) => [...w].sort())) === JSON.stringify(b.map((w) => [...w].sort()));

/** Each root's upstreams: its order among the roots, and with it the previous wave's roots when the order alone layers otherwise. */
export function componentDeps(waves: string[][], order: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const roots = waves.flat();
  const known = new Set(roots);
  const deps = new Map(roots.map((r) => [r, new Set([...(order.get(r) ?? [])].filter((u) => known.has(u) && u !== r))]));
  if (sameWaves(dependencyWaves(roots, deps), waves)) return deps;
  // waves.canary, or a shape whose waves are cut otherwise: chain the waves, so wave k's roots follow wave k-1's.
  waves.forEach((w, i) => {
    if (i > 0) for (const r of w) for (const u of waves[i - 1]!) deps.get(r)!.add(u);
  });
  return deps;
}

export function componentsDecl(input: ComponentsDeclInput): ComponentsDecl {
  const waves = input.waves.map((w) => [...w].sort());
  const deps = componentDeps(waves, input.order);
  const dirOf = input.dirOf ?? ((r: string) => r);
  const roots = waves.flat();
  return {
    schema: COMPONENTS_SCHEMA,
    generated_by: `${GENERATED_BY} ${VERSION}`,
    roots: Object.fromEntries(roots.map((r) => [r, { dir: dirOf(r) }])),
    components: roots.map((r) => ({ name: r, dependsOn: [...deps.get(r)!].sort(), deploy: [{ phase: "Apply" as const, steps: [{ kind: "terraform-apply" as const, root: r }] }] })),
    pipeline: { path: input.pipeline.path, forge: input.pipeline.forge, jobs: input.pipeline.applyJobs },
  };
}

/** The file's content. */
export const componentsJson = (decl: ComponentsDecl): string => `${JSON.stringify(decl, null, 2)}\n`;

/** Whether a file at COMPONENTS_PATH is one terragucci wrote: JSON whose generated_by names terragucci. JSON has no comment to carry the workflow's MARKER. */
export function componentsWrittenByTerragucci(content: string): boolean {
  try {
    const v = JSON.parse(content) as { generated_by?: unknown };
    return typeof v.generated_by === "string" && (v.generated_by === GENERATED_BY || v.generated_by.startsWith(`${GENERATED_BY} `));
  } catch {
    return false;
  }
}
