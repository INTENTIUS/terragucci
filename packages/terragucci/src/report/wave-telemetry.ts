/**
 * What a tf-apply wave run adds to its stage's telemetry (report/observe.ts):
 * the `terragucci.result` on its stage span, so the span metrics count wave
 * runs by how they ended, and the gauges the Rollouts and waves dashboard and
 * the waiting-wave alert read: when the wave started waiting for an approval,
 * when it last settled, and how many roots it holds.
 */
import { METRIC, type StageResult } from "../dashboards/names";
import type { Gauge } from "../telemetry";

/** What a wave run found out, filled in as it runs. */
export interface WaveFacts {
  roots?: string[];
  /** The wave had nothing to change. */
  nothing?: boolean;
  /** When the wave first asked for the approval it waits for (its standing pending fact, or now). */
  waitingSince?: string;
}

/** The result a wave's exit code and facts add up to. */
export function waveResult(code: number, facts: WaveFacts): StageResult {
  if (code === 1) return "failed";
  if (code === 3) return "waiting";
  if (code === 4) return "refused";
  return facts.nothing ? "nothing" : "applied";
}

type GaugeOf = (name: string, unit: string, description: string, value: number, attributes: Record<string, string>) => Gauge;

/** The gauges one wave run gives, `at` Unix seconds, through the stage's gauge maker (which adds project and stage). */
export function waveGauges(wave: number, code: number, facts: WaveFacts, at: number, g: GaugeOf): Gauge[] {
  const result = waveResult(code, facts);
  const attrs = { wave: String(wave) };
  const out: Gauge[] = [g(METRIC.waveRoots, "{root}", "Roots in the wave", facts.roots?.length ?? 0, attrs)];
  // A refused wave records a pending fact for its new digest, so it waits again.
  if (result === "waiting" || result === "refused") {
    const since = facts.waitingSince ? Date.parse(facts.waitingSince) / 1000 : at;
    out.push(g(METRIC.waveWaitingSince, "s", "When the wave started waiting for an approval, in Unix seconds", since, attrs));
  } else {
    out.push(g(METRIC.waveSettled, "s", "When the wave last stopped waiting, in Unix seconds", at, attrs));
  }
  return out;
}
