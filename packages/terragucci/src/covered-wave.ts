/**
 * Covered rounds for linked roots (chant#4422, adopted in terragucci#1268): a
 * wave that read an upstream output unknown when the change was reviewed
 * plans again once its upstream applied. When that plan touches only the
 * roots the pull request's plan showed, and in each only the resources and
 * actions it showed, differing only where an input it previewed as known
 * after apply drives them, the pull request's approval covers it, and the
 * wave is not held for an approval of its own. Anything else holds the wave
 * as before, with the reason chant's `planShapeCovers` gives.
 *
 * chant decides (`coveredRound`); this hands it each root's shape, from the
 * pull request's stored plan of the root and from the wave's plan of it now.
 */
import type { ChangeSetDocument } from "@intentius/chant/change-set";
import { coveredRound, type CoverageSide, type PlanShape, type RoundCoverage } from "@intentius/chant/components";
import { terraformPlanShape } from "@intentius/chant-lexicon-terraform/plan-shape";
import type { UnknownRead } from "./unknown-reads";

/** One root of the wave as the pull request planned it, and as the wave planned it now. */
export interface CoveredRoot {
  root: string;
  /** The pull request's plan of the root (`show -json`, redacted as the reports bucket keeps it). Undefined when it has none. */
  previewed?: unknown;
  /** The wave's plan of the root, made after its upstreams applied. */
  fresh: unknown;
}

/** Every member carries a shape, so neither side's change set is read. */
const NO_DOC = {} as ChangeSetDocument;

/** The inputs a root was previewed without: each unknown output it read, as `<upstream>.<output>`, or the upstream alone when the carrier names none. */
export function unknownInputs(root: string, unknown: readonly UnknownRead[]): string[] {
  const out = new Set<string>();
  for (const u of unknown) {
    if (u.root !== root) continue;
    if (u.outputs.length === 0) out.add(u.upstream);
    for (const o of u.outputs) out.add(`${u.upstream}.${o}`);
  }
  return [...out].sort();
}

/**
 * Whether the pull request's approval of `approvedDigest` covers the wave's
 * plans of `roots` (the ones that change something). A root the pull request
 * did not plan is not covered.
 */
export function waveCoverage(roots: readonly CoveredRoot[], unknown: readonly UnknownRead[], approvedDigest: string): RoundCoverage {
  const missing = roots.find((r) => r.previewed === undefined);
  if (missing) return { covered: false, reason: `the pull request's plan of ${missing.root} could not be read, so nothing says what was approved for it` };
  const approvedShapes: Record<string, PlanShape> = {};
  const freshShapes: Record<string, PlanShape> = {};
  const approved: CoverageSide = { doc: NO_DOC, members: [], shapes: approvedShapes };
  const fresh: CoverageSide = { doc: NO_DOC, members: [], shapes: freshShapes };
  for (const r of roots) {
    const inputs = unknownInputs(r.root, unknown);
    approvedShapes[r.root] = terraformPlanShape(r.previewed, r.root, { unknownInputs: inputs });
    freshShapes[r.root] = terraformPlanShape(r.fresh, r.root);
    approved.members.push({ member: r.root, component: r.root, unknownInputs: inputs });
    fresh.members.push({ member: r.root, component: r.root });
  }
  return coveredRound({ approved, approvedDigest, fresh });
}
