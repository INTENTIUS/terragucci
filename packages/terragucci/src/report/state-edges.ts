/**
 * The roots each root reads the state of: `<prefix>/<project>/edges.json`,
 * `terragucci.state-edges/v1`. A report names, for each root, the roots it
 * reads: `roots[].reads`, each `terraform_remote_state` block's upstream,
 * and `roots[].dependencies`, a Terragrunt unit's `dependency` and
 * `dependencies` blocks. The upload keeps, for each
 * root, the reads the newest default-branch run found in its code, the
 * newest run that planned it (a pull request's plan, a drift check or an
 * apply wave's plan), and the newest apply wave that changed it.
 *
 * The estate page lists each edge with the consumer's last plan against its
 * producer's last apply: a consumer whose last plan is older than its
 * producer's last apply read outputs that have changed since.
 *
 * Only root paths, run facts and version ids are kept: never a state's
 * contents or an output's value.
 */
import type { Report, ReportRoot } from "./schema";

export const EDGES_SCHEMA = "terragucci.state-edges/v1";

/** A run that planned or applied a root. */
export interface EdgeRun {
  stage: string;
  commit: string;
  finished: string;
  wave?: number;
  /** The run's directory, relative to the project's index. */
  path: string;
  /** The pull or merge request a plan was for. */
  pull_request?: string;
  /** An apply: the state version it left, when the backend keeps versions. */
  version_id?: string;
}

/** One root a root reads, and how. */
export interface EdgeRead {
  root: string;
  via: "terraform_remote_state" | "dependency";
}

export interface EdgeRoot {
  root: string;
  /** The roots it reads, as the newest default-branch run found them. */
  reads: EdgeRead[];
  /** When that run finished. */
  reads_seen?: string;
  planned?: EdgeRun;
  /** The newest apply wave that changed a resource of the root. */
  applied?: EdgeRun;
}

export interface StateEdges {
  schema: typeof EDGES_SCHEMA;
  /** By root path. */
  roots: EdgeRoot[];
}

/** Read the file; anything unreadable is an empty one, rebuilt from the next run on. */
export function readStateEdges(text: string | undefined): StateEdges {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<StateEdges>;
      if (parsed.schema === EDGES_SCHEMA && Array.isArray(parsed.roots)) return { schema: EDGES_SCHEMA, roots: parsed.roots };
    } catch {
      // An unreadable file is rebuilt.
    }
  }
  return { schema: EDGES_SCHEMA, roots: [] };
}

const at = (iso: string): number => Date.parse(iso) || 0;
const newer = (a: EdgeRun | undefined, b: EdgeRun): EdgeRun => (a && at(a.finished) > at(b.finished) ? a : b);

/**
 * Whether a report has anything for edges.json: a root that reads another
 * (its plan is a consumer's), or an apply wave that changed a root (it may be
 * a producer). A project whose roots read no state writes edges.json only
 * when it applies a change.
 */
export function hasEdgeFacts(report: Report): boolean {
  return report.roots.some((r) => readsOf(r).length > 0 || (report.run.stage === "tf-apply" && (r.applied_changes?.length ?? 0) > 0));
}

/**
 * The file with a report's roots added. A root that planned (not a
 * Terragrunt preview on mock outputs) moves its `planned` forward; on an
 * apply wave, a root that applied a change moves its `applied` forward. Its
 * reads follow the newest run of the default branch, never a pull request's
 * code. An older run never replaces a newer one's facts.
 */
export function addToStateEdges(existing: string | undefined, report: Report, path: string): StateEdges {
  const held = new Map(readStateEdges(existing).roots.map((r) => [r.root, r]));
  const run = report.run;
  const mark: EdgeRun = {
    stage: run.stage,
    commit: run.commit,
    finished: run.finished,
    ...(run.wave !== undefined ? { wave: run.wave } : {}),
    path,
    ...(run.pull_request ? { pull_request: run.pull_request } : {}),
  };
  for (const r of report.roots) {
    const old = held.get(r.path);
    // Reads come from the newest default-branch plan or apply that planned the root; the code under review in a
    // pull request never sets them, and a drift check, which names no reads, leaves them.
    const knows = !run.pull_request && run.stage !== "tf-drift" && r.status === "planned";
    const readsNewer = knows && (!old?.reads_seen || at(run.finished) >= at(old.reads_seen));
    const reads = readsNewer ? readsOf(r) : (old?.reads ?? []);
    const seen = readsNewer ? run.finished : old?.reads_seen;
    const planned = r.status === "planned" && !r.terragrunt?.provisional ? newer(old?.planned, mark) : old?.planned;
    const changed = run.stage === "tf-apply" && r.status === "planned" && (r.applied_changes?.length ?? 0) > 0;
    const applied = changed ? newer(old?.applied, { ...mark, ...(r.state?.version_id ? { version_id: r.state.version_id } : {}) }) : old?.applied;
    if (reads.length === 0 && !planned && !applied && !old) continue;
    held.set(r.path, { root: r.path, reads, ...(seen ? { reads_seen: seen } : {}), ...(planned ? { planned } : {}), ...(applied ? { applied } : {}) });
  }
  return { schema: EDGES_SCHEMA, roots: [...held.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)) };
}

/** One edge as the estate page shows it. */
export interface Edge {
  consumer: string;
  producer: string;
  via: EdgeRead["via"];
  consumer_planned?: EdgeRun;
  producer_applied?: EdgeRun;
  /**
   * `stale`: the producer applied a change after the consumer's last plan, so
   * that plan read outputs that have changed since. `current`: the consumer's
   * last plan is newer than that apply. `unknown`: no plan of the consumer, or no apply of the
   * producer that changed it, is recorded.
   */
  status: "current" | "stale" | "unknown";
}

/** Every edge of a project, by consumer and then producer. */
export function edgesOf(edges: StateEdges): Edge[] {
  const byRoot = new Map(edges.roots.map((r) => [r.root, r]));
  const out: Edge[] = [];
  for (const c of edges.roots) {
    for (const read of c.reads) {
      const p = byRoot.get(read.root);
      const planned = c.planned;
      const applied = p?.applied;
      const status = !planned || !applied ? "unknown" : at(applied.finished) > at(planned.finished) ? "stale" : "current";
      out.push({ consumer: c.root, producer: read.root, via: read.via, ...(planned ? { consumer_planned: planned } : {}), ...(applied ? { producer_applied: applied } : {}), status });
    }
  }
  return out.sort((a, b) => (a.consumer < b.consumer ? -1 : a.consumer > b.consumer ? 1 : a.producer < b.producer ? -1 : a.producer > b.producer ? 1 : 0));
}

/** The roots a report's root reads: its remote state blocks' upstreams, then a unit's dependencies, each once. */
export function readsOf(r: Pick<ReportRoot, "reads" | "dependencies">): EdgeRead[] {
  const out: EdgeRead[] = [];
  for (const up of [...new Set((r.reads ?? []).map((x) => x.upstream))].sort()) out.push({ root: up, via: "terraform_remote_state" });
  for (const up of [...new Set(r.dependencies ?? [])].sort()) if (!out.some((x) => x.root === up)) out.push({ root: up, via: "dependency" });
  return out;
}
