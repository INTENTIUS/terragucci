// A demo cycle as the reports bucket keeps it for behold's per-tool page:
// <prefix>/cycles/<tool>/latest.json and <prefix>/cycles/<tool>/<cycle>.json
// (schema demo.cycle/v1), the newest CYCLES_KEEP per tool. Pure functions; the
// reading and the uploads are in scripts/demo-cycles.ts, which stack/demo.sh
// calls when a cycle writes reset.
import type { Mark } from "./demo-runs-lib";

export const CYCLES_KEEP = 5;

/** One line of the driver's timeline: demo.json as it was written, and when (`at`). */
export interface CycleStep {
  cycle?: number;
  step?: string;
  started_at?: string;
  at?: string;
  [field: string]: unknown;
}

export interface CycleDoc {
  schema: "demo.cycle/v1";
  tool: string;
  repo: string;
  scenario: string;
  cycle: number;
  started: string | null;
  ended: string | null;
  steps: CycleStep[];
  /** The ids under <prefix>/runs/ of the runs the cycle started, oldest first. */
  runs: number[];
}

/** The timeline's steps, in order; a line that is not a JSON object is skipped. */
export function readTimeline(text: string): CycleStep[] {
  const out: CycleStep[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as CycleStep);
    } catch {
      // a torn line from a driver that stopped mid-write
    }
  }
  return out;
}

/**
 * The record of a cycle that ended with reset, or why there is none: the base
 * is no scenario's cycle, a cycle that stalled at any step is never published
 * (so latest is always a cycle that ran to its reset), and a cycle whose last
 * step is not reset has not ended. Only the timeline's lines of this cycle count.
 */
export function buildCycle(o: {
  tool: string;
  repo: string;
  scenario: string;
  cycle: number;
  steps: readonly CycleStep[];
  marks: ReadonlyMap<number, Mark>;
}): { doc: CycleDoc } | { skip: string } {
  if (!o.scenario || o.scenario === "base") return { skip: "the base is no scenario's cycle" };
  const steps = o.steps.filter((s) => s.cycle === o.cycle);
  if (steps.length === 0) return { skip: `the timeline holds no step of cycle ${o.cycle}` };
  if (steps.some((s) => s.step === "stalled")) return { skip: `cycle ${o.cycle} stalled, so it does not replace the latest` };
  const last = steps[steps.length - 1];
  if (last.step !== "reset") return { skip: `cycle ${o.cycle} has not reset yet (its last step is ${last.step ?? "none"})` };
  const runs = [...o.marks.values()].filter((m) => m.cycle === o.cycle).map((m) => m.id).sort((a, b) => a - b);
  const first = steps[0];
  return {
    doc: {
      schema: "demo.cycle/v1",
      tool: o.tool,
      repo: o.repo,
      scenario: o.scenario,
      cycle: o.cycle,
      started: first.started_at ?? first.at ?? null,
      ended: last.at ?? null,
      steps,
      runs: [...new Set(runs)],
    },
  };
}

/** The cycle numbers of the `<prefix>/cycles/<tool>/<n>.json` keys in an S3 ListObjectsV2 answer. */
export function cycleKeys(xml: string, prefix: string, tool: string): number[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<Key>${esc(prefix)}/cycles/${esc(tool)}/(\\d+)\\.json</Key>`, "g");
  return [...xml.matchAll(re)].map((m) => Number(m[1]));
}

/** The stored cycles to delete, oldest first: all but the newest `keep`. */
export function cyclesToPrune(stored: readonly number[], keep = CYCLES_KEEP): number[] {
  const newest = [...new Set(stored)].sort((a, b) => b - a);
  return newest.slice(Math.max(keep, 1)).sort((a, b) => a - b);
}
