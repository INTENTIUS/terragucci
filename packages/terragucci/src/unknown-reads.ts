/**
 * Whether a wave of an apply read an upstream output that was unknown when
 * the change was reviewed (#1012).
 *
 * A pull request's plan of a root that reads another root's outputs plans on
 * the upstream's planned outputs. An output known only once the upstream
 * applies has no value there, so the reader's plan in the pull request is
 * provisional: the plan note gives its wave no review digest, and the report
 * lists the wave under `replans_after`. On the default branch the wave plans
 * again on the state its upstream applied. That plan has nothing unknown, and
 * nobody has seen it, so the wave's gate holds it whatever `gate` says, except
 * under `gate: never`.
 *
 * The apply learns it from the first carrier it can read:
 *
 * 1. the upstream wave's own plan in this push's pipeline: an output the
 *    reader reads that is `after_unknown` there was unknown when the change
 *    was reviewed;
 * 2. the report of the pull request that merged as this commit: its rows'
 *    reads with `unknown` outputs, and its waves' `replans_after`;
 * 3. with neither, every read counts as unknown: the wave is held, and the
 *    log says why.
 *
 * Nothing here reads the forge or the bucket: the caller hands in each
 * carrier as a function, and this module decides from what they return.
 */
import { plannedOutputs, unknownOutputs } from "./planned-outputs";
import type { Report } from "./report/schema";

/** One read of a wave's root: the upstream root, the wave that applies it, and the outputs read (undefined: every one). */
export interface WaveRead {
  root: string;
  upstream: string;
  wave: number;
  outputs?: ReadonlySet<string>;
}

/** Which carrier settled a read: the upstream's plan in this push, the pull request's report, or none. */
export type ReadCarrier = "upstream-plan" | "pull-request" | "none";

/** A read that holds the wave: the outputs that were unknown, empty when the carrier does not name them. */
export interface UnknownRead extends Omit<WaveRead, "outputs"> {
  outputs: string[];
  carrier: ReadCarrier;
  /** Where the carrier was read: the upstream's plan or the pull request's report. */
  from?: string;
  /** With carrier `none`: why no carrier could say. */
  why?: string;
}

/** The pull request's tf-plan report, and where it was read; or why there is none. */
export type PullReport = { report: Report; from: string } | { missing: string };

/** The carriers, as the caller reads them. Each may fail; a failure counts as the carrier being unavailable. */
export interface ReadCarriers {
  /** The upstream's plan JSON in this push's pipeline (its `tf-apply` wave), and where it was read; undefined when the wave cannot read it. */
  upstreamPlan(upstream: string, wave: number): Promise<{ plan: unknown; from: string } | undefined>;
  /** The report of the pull request that made this commit. Called at most once. */
  pullReport(): Promise<PullReport>;
}

/** What the gate learns: the reads that hold the wave, and the lines that say how each read was settled. */
export interface UnknownReadsVerdict {
  unknown: UnknownRead[];
  lines: string[];
}

/**
 * Decide each read from the first carrier that can say. A read the
 * upstream's plan in this push settles is not asked of the pull request; a
 * read neither carrier settles holds the wave.
 */
export async function unknownReads(reads: readonly WaveRead[], carriers: ReadCarriers): Promise<UnknownReadsVerdict> {
  const unknown: UnknownRead[] = [];
  const lines: string[] = [];
  if (reads.length === 0) return { unknown, lines };
  const plans = new Map<string, Promise<{ plan: unknown; from: string } | undefined>>();
  const planOf = (r: WaveRead) => {
    const key = `${r.wave}\n${r.upstream}`;
    if (!plans.has(key)) plans.set(key, carriers.upstreamPlan(r.upstream, r.wave).catch(() => undefined));
    return plans.get(key)!;
  };
  const left: WaveRead[] = [];
  for (const r of reads) {
    const got = await planOf(r);
    const outputs = got ? plannedOutputs(got.plan) : undefined;
    if (!got || !outputs) {
      left.push(r);
      continue;
    }
    const names = unknownOutputs(outputs.outputs, r.outputs);
    if (names.length) unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: names, carrier: "upstream-plan", from: got.from });
    else lines.push(`${r.root} reads no output of ${r.upstream} that ${got.from} left unknown`);
  }
  if (left.length === 0) return { unknown, lines };
  const pulled = await carriers.pullReport().catch((e: Error): PullReport => ({ missing: `the pull request's report could not be read (${e.message.split("\n")[0]})` }));
  for (const r of left) {
    if ("missing" in pulled) {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [], carrier: "none", why: `this push has no plan of ${r.upstream} the wave can read, and ${pulled.missing}` });
      continue;
    }
    const said = pullRequestSays(pulled.report, r);
    if (said === undefined) {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [], carrier: "none", why: `this push has no plan of ${r.upstream} the wave can read, and ${pulled.from} did not plan ${r.root}` });
    } else if (said.unknown) {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: said.outputs, carrier: "pull-request", from: pulled.from });
    } else {
      lines.push(`${r.root} read no output of ${r.upstream} that ${pulled.from} left unknown`);
    }
  }
  return { unknown, lines };
}

/**
 * What the pull request's report says of one read: unknown, with the outputs
 * when its row names them; known; or undefined when the report neither has a
 * row for the reader nor lists it as waiting for the upstream, so it cannot say.
 */
export function pullRequestSays(report: Report, r: WaveRead): { unknown: boolean; outputs: string[] } | undefined {
  const row = report.roots.find((x) => x.path === r.root);
  // A Terragrunt unit the pull request did not plan because it waits for this upstream to apply: nobody saw its plan.
  if (!row) return report.deferred?.some((d) => d.unit === r.root && !d.previewed && d.after.includes(r.upstream)) ? { unknown: true, outputs: [] } : undefined;
  // The row's `unknown` already lists only the outputs the root reads.
  const outputs = [...new Set((row.reads ?? []).filter((x) => x.upstream === r.upstream && x.outputs === "planned").flatMap((x) => x.unknown ?? []))].sort();
  if (outputs.length) return { unknown: true, outputs };
  // A Terragrunt unit that was not previewed has no reads in its row: its wave's replans_after names the waves it waits for.
  const replans = report.waves.some((w) => w.roots.includes(r.root) && (w.replans_after ?? []).includes(r.wave));
  if (replans && !(row.reads ?? []).some((x) => x.upstream === r.upstream)) return { unknown: true, outputs: [] };
  return { unknown: false, outputs: [] };
}

/** The log line for a read that holds a wave: the outputs that were unknown, where, and the wave that settled them. */
export function unknownReadLine(u: UnknownRead): string {
  if (u.carrier === "none") return `${u.root} reads the state of ${u.upstream}, which wave ${u.wave} applied, and nothing says whether the outputs it reads were known when the change was reviewed: ${u.why}`;
  const what = u.outputs.length ? `${u.outputs.join(", ")} of ${u.upstream}` : `outputs of ${u.upstream}`;
  return `${u.root} read ${what}, unknown in ${u.from} and known only once wave ${u.wave} applied it`;
}
