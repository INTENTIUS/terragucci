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
 * 1. the upstream wave's plans in this push's pipeline: an output the
 *    reader reads that is `after_unknown` in any plan that changes the
 *    upstream was unknown when the change was reviewed. A plan that changes
 *    nothing has every output known. As the first run of this commit, that
 *    is what the change left the upstream with, so the reads were known;
 *    but a run of this commit after an earlier one applied the upstream (a
 *    comment's apply, the resume job, a re-run) plans it again with the
 *    change already applied, and that plan says nothing of what was
 *    reviewed. So a plan that changes nothing counts only when the caller
 *    finds no record of an earlier apply of the upstream at this commit
 *    (`appliedBefore`), and is skipped otherwise;
 * 2. the report of the pull request that merged as this commit: its rows'
 *    reads with `unknown` outputs, and its waves' `replans_after`;
 * 3. with neither, every read counts as unknown: the wave is held, and the
 *    log says why.
 *
 * An Atmos `!terraform.state` read and a Terramate `input` (#1053) are
 * planned in the pull request on the upstream's applied state, never on its
 * plan, so the review saw none of the upstream's change: such a read
 * (`review: "applied"`) holds the wave when a plan that changes the upstream
 * changes, deletes or leaves unknown an output it reads, known or not. The
 * pull request's report cannot say what that change moved, so with no plan
 * of the upstream to read, the read holds the wave.
 *
 * Nothing here reads the forge or the bucket: the caller hands in each
 * carrier as a function, and this module decides from what they return.
 */
import { changedOutputs, plannedOutputs, unknownOutputs } from "./planned-outputs";
import { changesSomething } from "./report/changing";
import type { Report } from "./report/schema";

/** One read of a wave's root: the upstream root, the wave that applies it, and the outputs read (undefined: every one). */
export interface WaveRead {
  root: string;
  upstream: string;
  wave: number;
  outputs?: ReadonlySet<string>;
  /**
   * `applied`: the pull request planned the root on the upstream's applied
   * state, not its planned outputs (an Atmos `!terraform.state` read, a
   * Terramate `input`), so any change to an output it reads was unseen.
   */
  review?: "applied";
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
  /**
   * Every plan JSON of the upstream in this push's pipeline (its `tf-apply`
   * wave) the wave can read, each with where it was read; empty when it can
   * read none. Plans that change nothing are skipped by the caller.
   */
  upstreamPlans(upstream: string, wave: number): Promise<{ plan: unknown; from: string }[]>;
  /** The report of the pull request that made this commit. Called at most once. */
  pullReport(): Promise<PullReport>;
  /**
   * Whether an earlier run of this commit applied a change to the upstream
   * in its wave: where that is recorded, or why the caller cannot tell; or
   * undefined when the records show none, so this run's plans of the
   * upstream are the first of this commit. Absent, or failing, counts as
   * cannot tell: a plan that changes nothing is then skipped.
   */
  appliedBefore?(upstream: string, wave: number): Promise<string | undefined>;
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
  const plans = new Map<string, Promise<{ plan: unknown; from: string }[]>>();
  const planOf = (r: WaveRead) => {
    const key = `${r.wave}\n${r.upstream}`;
    if (!plans.has(key)) plans.set(key, carriers.upstreamPlans(r.upstream, r.wave).catch(() => []));
    return plans.get(key)!;
  };
  const earlier = new Map<string, Promise<string | undefined>>();
  const earlierOf = (r: WaveRead) => {
    const key = `${r.wave}\n${r.upstream}`;
    if (!earlier.has(key)) {
      const asked = carriers.appliedBefore ? carriers.appliedBefore(r.upstream, r.wave) : Promise.resolve("nothing here reads whether an earlier run of this commit applied it");
      earlier.set(key, asked.catch((e: Error) => `whether an earlier run of this commit applied it could not be read (${e.message.split("\n")[0]})`));
    }
    return earlier.get(key)!;
  };
  const left: WaveRead[] = [];
  const said = new Set<string>();
  for (const r of reads) {
    const got = await planOf(r);
    // A plan that changes the upstream is one whose outputs the change's reviewers could not see; one that changes nothing
    // counts only as the first plan of the upstream at this commit, which leaves its outputs as they were applied before.
    const changing: { from: string; names: string[] }[] = [];
    for (const g of got) {
      const outputs = plannedOutputs(g.plan);
      if (!changesSomething(g.plan)) {
        const why = await earlierOf(r);
        if (why !== undefined) {
          if (!said.has(g.from)) lines.push(`${g.from} changes nothing, and ${why}, so it says nothing of what was unknown when the change was reviewed`);
          said.add(g.from);
          continue;
        }
        if (!said.has(g.from)) lines.push(`${g.from} changes nothing, and no earlier run of this commit applied ${r.upstream}, so its outputs were known when the change was reviewed`);
        said.add(g.from);
        changing.push({ from: g.from, names: r.review === "applied" ? [] : unknownOutputs(outputs?.outputs ?? new Map(), r.outputs) });
        continue;
      }
      if (outputs) changing.push({ from: g.from, names: r.review === "applied" ? changedOutputs(g.plan, r.outputs) : unknownOutputs(outputs.outputs, r.outputs) });
    }
    if (changing.length === 0) {
      left.push(r);
      continue;
    }
    const held = changing.filter((c) => c.names.length > 0);
    if (held.length) unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [...new Set(held.flatMap((c) => c.names))].sort(), carrier: "upstream-plan", from: held.map((c) => c.from).join(", "), ...(r.review ? { review: r.review } : {}) });
    else lines.push(`${r.root} reads no output of ${r.upstream} that ${changing.map((c) => c.from).join(", ")} ${r.review === "applied" ? "changes" : "left unknown"}`);
  }
  if (left.length === 0) return { unknown, lines };
  // A read planned on the applied state is not asked of the pull request's report, which cannot say.
  const asked = left.some((r) => r.review !== "applied");
  const pulled: PullReport = asked ? await carriers.pullReport().catch((e: Error): PullReport => ({ missing: `the pull request's report could not be read (${e.message.split("\n")[0]})` })) : { missing: "" };
  for (const r of left) {
    if (r.review === "applied") {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [], carrier: "none", review: r.review, why: `this push has no plan that changes ${r.upstream} the wave can read, and the pull request planned ${r.root} on the applied state of ${r.upstream}, so its report cannot say whether the change moved what ${r.root} reads` });
      continue;
    }
    if ("missing" in pulled) {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [], carrier: "none", why: `this push has no plan that changes ${r.upstream} the wave can read, and ${pulled.missing}` });
      continue;
    }
    const said = pullRequestSays(pulled.report, r);
    if (said === undefined) {
      unknown.push({ root: r.root, upstream: r.upstream, wave: r.wave, outputs: [], carrier: "none", why: `this push has no plan that changes ${r.upstream} the wave can read, and ${pulled.from} did not plan ${r.root}` });
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
  if (u.review === "applied") return `${u.root} reads ${what}, which ${u.from} changes; the pull request planned ${u.root} on the state ${u.upstream} had before, so its review showed none of what wave ${u.wave} applied`;
  return `${u.root} read ${what}, unknown in ${u.from} and known only once wave ${u.wave} applied it`;
}
