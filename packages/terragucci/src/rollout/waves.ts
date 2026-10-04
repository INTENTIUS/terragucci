/**
 * The waves of a rollout, across one project or many.
 *
 * In one project, the canaries (`waves.canary`, globs over root directories)
 * form wave 1 and the rest follow dependency order: a root that reads
 * another's state lands in a later wave. chant's planner does the layering
 * (`planPinWaves`), the order gated waves use.
 *
 * Across the projects of a control repo there is no dependency graph to read,
 * so order is the canary list and then project order in the config: wave 1
 * holds every project's canaries, and each project's other waves follow, one
 * project after another.
 */
import { planPinWaves } from "@intentius/chant-lexicon-terraform/pin";
import { globMatch } from "../detect";

export interface ProjectRoots {
  key: string;
  /** The roots in the rollout. */
  roots: string[];
  /** Roots each root depends on, by directory. */
  dependsOn: Map<string, Set<string>>;
  /** `waves.canary` from the project's settings. */
  canary: string[];
}

export interface WavePart {
  project: string;
  roots: string[];
}

export interface Wave {
  wave: number;
  canary: boolean;
  parts: WavePart[];
}

export function planWaves(projects: ProjectRoots[]): Wave[] {
  const canaries: WavePart[] = [];
  const rest: Array<{ project: string; layers: string[][] }> = [];
  for (const p of projects) {
    const canary = p.roots.filter((r) => p.canary.some((g) => globMatch(g, r)));
    const planned = planPinWaves(
      p.roots.map((root) => ({ root, dependsOn: [...(p.dependsOn.get(root) ?? [])] })),
      canary,
    );
    if (canary.length > 0) canaries.push({ project: p.key, roots: planned[0]!.roots });
    rest.push({ project: p.key, layers: planned.filter((w) => !w.canary).map((w) => w.roots) });
  }
  const waves: Wave[] = [];
  if (canaries.length > 0) waves.push({ wave: 1, canary: true, parts: canaries });
  for (const { project, layers } of rest) {
    for (const roots of layers) waves.push({ wave: waves.length + 1, canary: false, parts: [{ project, roots }] });
  }
  return waves;
}
