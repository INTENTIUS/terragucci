/**
 * Planned outputs: what an upstream's plan says its outputs will be once it
 * applies, read from its `show -json`, and which of them are known only then.
 * Nothing here knows how a downstream reads them: a plain root's
 * `terraform_remote_state` block (./linked.ts) and a Terragrunt `dependency`
 * block are both a label, an upstream and the outputs read.
 */
import type { ReportRead } from "./report/schema";

/** One output of an upstream's plan. `unknown` is `after_unknown`: true, false, or the same shape as the value. */
export interface PlannedOutput {
  value: unknown;
  unknown: unknown;
  sensitive: boolean;
}

/** An upstream's planned outputs, and whether its plan changes any of them. */
export interface PlannedOutputs {
  outputs: Map<string, PlannedOutput>;
  changed: boolean;
}

/** Whether a value or any part of it is `true`, as `after_unknown` and `after_sensitive` mark parts. */
export function anyTrue(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(anyTrue);
  if (v && typeof v === "object") return Object.values(v).some(anyTrue);
  return false;
}

type OutputChange = { actions?: string[]; after?: unknown; after_unknown?: unknown; after_sensitive?: unknown };
type PlannedValue = { value?: unknown; sensitive?: boolean };

/**
 * The outputs an upstream's plan leaves. From `output_changes`, which marks
 * each unknown part; a plan without it falls back to `planned_values.outputs`,
 * where an output with no `value` is unknown as a whole (and `changed` is
 * then unknown too, so it reads as true). Undefined when the plan has neither.
 */
export function plannedOutputs(plan: unknown): PlannedOutputs | undefined {
  const p = plan as { output_changes?: Record<string, OutputChange>; planned_values?: { outputs?: Record<string, PlannedValue> } } | undefined;
  const outputs = new Map<string, PlannedOutput>();
  if (p?.output_changes && typeof p.output_changes === "object") {
    let changed = false;
    for (const [name, c] of Object.entries(p.output_changes)) {
      const actions = c.actions ?? [];
      if (actions.some((a) => a !== "no-op")) changed = true;
      if (actions.includes("delete")) continue;
      outputs.set(name, { value: c.after, unknown: c.after_unknown ?? false, sensitive: anyTrue(c.after_sensitive) });
    }
    return { outputs, changed };
  }
  const planned = p?.planned_values?.outputs;
  if (!planned || typeof planned !== "object") return undefined;
  for (const [name, o] of Object.entries(planned)) {
    outputs.set(name, "value" in o ? { value: o.value, unknown: false, sensitive: o.sensitive === true } : { value: null, unknown: true, sensitive: o.sensitive === true });
  }
  return { outputs, changed: true };
}

/** The outputs among `read` (every output when undefined) that are known only once the upstream applies, sorted. */
export function unknownOutputs(outputs: ReadonlyMap<string, PlannedOutput>, read?: ReadonlySet<string>): string[] {
  return [...outputs].filter(([n, o]) => (read === undefined || read.has(n)) && anyTrue(o.unknown)).map(([n]) => n).sort();
}

/** The report's read of one block planned on an upstream's planned outputs. */
export function plannedRead(upstream: string, label: string, outputs: ReadonlyMap<string, PlannedOutput>, read?: ReadonlySet<string>): ReportRead {
  const unknown = unknownOutputs(outputs, read);
  return { upstream, data: label, outputs: "planned", ...(unknown.length ? { unknown } : {}) };
}

/** The upstreams whose outputs a downstream read before they were known: it plans again once they apply. */
export function unknownUpstreams(reads: readonly ReportRead[]): string[] {
  return [...new Set(reads.filter((r) => r.outputs === "planned" && r.unknown?.length).map((r) => r.upstream))].sort();
}

/** The waves `upstreams` are in, other than `own`, sorted: the waves a wave reads, or plans again after. */
export function wavesOf(waveOf: ReadonlyMap<string, number>, upstreams: Iterable<string>, own: number): number[] {
  return [...new Set([...upstreams].map((u) => waveOf.get(u)).filter((n): n is number => n !== undefined && n !== own))].sort((a, b) => a - b);
}

/** A log line for a downstream planned on an upstream's planned outputs. */
export function plannedReadLine(root: string, r: ReportRead): string {
  return `${root}: plans on the planned outputs of ${r.upstream}${r.unknown?.length ? `, ${r.unknown.join(", ")} known once it applies` : ""}`;
}
