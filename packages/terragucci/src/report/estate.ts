/**
 * The estate page: one self-contained `estate.html` and its `estate.json`,
 * built from the report index of every project and from nothing else. A row
 * of an index holds the counts a run's report summed (see IndexEntry), so the
 * page never opens a report, a plan's text or a root's plan JSON.
 *
 * Per project it shows the latest plan, the latest drift check, and the waves
 * of the newest commit that ran tf-apply: each wave's gate, how long a waiting
 * wave has waited, and the roots that failed. Below that, the newest runs
 * across every project, and the resources each root holds, from the
 * project's inventory.json (./inventory.ts): addresses, types and providers,
 * never a value. Then the versions every root runs, from each project's
 * versions.json (./versions.ts): per module, provider and binary, the
 * versions in use and the roots on each. Last, the state versions each root's applies left, from the
 * project's states.json (./state-versions.ts): version ids, never contents.
 *
 * The dependency graph comes from the run view of each project's newest
 * applied commit (./run-view.ts): its roots by wave and the roots each reads,
 * and each root's state and its reads of states outside the project, which
 * match another project's roots into edges between projects.
 *
 * The roots that read another root's state, from edges.json
 * (./state-edges.ts), each with its last plan against the producer's last
 * apply.
 *
 * The live ephemeral environments, from ephemeral.json (../ephemeral.ts):
 * each pull request's copy, its roots and state keys, and when it expires.
 */
import { esc } from "./html";
import { countTypes, type Inventory } from "./inventory";
import { estateVersions, type EstateVersionRow, type EstateVersions, type Versions } from "./versions";
import type { ReportResource } from "./schema";
import type { ChangeRow } from "./history";
import type { AuditEntry } from "./audit";
import type { StateVersions } from "./state-versions";
import { edgesOf, type Edge, type EdgeRun, type StateEdges } from "./state-edges";
import { renderDoraSection, type Dora } from "./dora";
import type { IndexEntry } from "./store";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";
import { GRAPH_CSS, renderGraphSvg, type GraphEdge } from "./graph";
import type { RunState, RunView } from "./run-view";
import { progressCounts } from "../apply-progress";
import type { EphemeralList, EphemeralRow } from "../ephemeral";

export const ESTATE_SCHEMA = "terragucci.estate/v1";

/** How many of the newest runs the page lists. */
export const RECENT_RUNS = 20;

/** One project's index, as the estate command read it. */
export interface ProjectIndex {
  project: string;
  /** Its rows, newest first. Absent when there is no index yet or it could not be read. */
  reports?: IndexEntry[];
  /** Why the index could not be read. */
  error?: string;
  /** Where the project's index.html and run directories are, from the page: relative, or absolute on another bucket's address. Absent when the page cannot link them. */
  base?: string;
  /** Its inventory.json, when an apply wrote one. */
  inventory?: Inventory;
  /** Its versions.json, when an apply wrote one. */
  versions?: Versions;
  /** Its changes.json rows, when an apply wrote them: the history page's, never the estate page's. */
  changes?: ChangeRow[];
  /** Its states.json, when an apply recorded a root's state. */
  states?: StateVersions;
  /** The run view (run.json) of its newest applied commit, when a wave wrote one. */
  run?: RunView;
  /** Its edges.json, when a root reads another's state or an apply changed a root. */
  edges?: StateEdges;
  /** Its ephemeral.json, when a pull request's copy of the ephemeral roots applied. */
  ephemeral?: EphemeralList;
}

/** One root's state on the page: where it is, whether its backend keeps versions, and the versions its applies left, newest first. */
export interface EstateStateRoot {
  root: string;
  backend: string;
  location?: string;
  versioning: "on" | "off" | "unknown";
  note?: string;
  /** When the newest apply that recorded it finished. */
  checked: string;
  versions: { version_id: string; commit: string; finished: string; wave?: number; report?: string }[];
  /** The versions its store lists that no wave or migration recorded, from the audit trail's `unrecorded-write` entries, newest first. */
  unrecorded?: { version_id: string; written_at: string; who: string | null; deleted?: boolean }[];
}

/** One root's resources, as its newest applied wave left them. */
export interface EstateInventoryRoot {
  root: string;
  commit: string;
  finished: string;
  wave?: number;
  /** The wave's report.html, when the page can link it. */
  report?: string;
  /** The environment the root was in when the wave applied, from its inventory. Absent when it was in none. */
  environment?: string;
  resources: EstateResource[];
}

/** A resource on the page, and its section of history.html when an apply changed it. */
export interface EstateResource extends ReportResource {
  history?: string;
  /** A choudoufu record's past versions, from its history: how many, that the store keeps none, or why they were not listed. */
  record_versions?: { kept: boolean; count?: number; error?: string };
}

/** A project's resources: how many, how many of each type, and each root's list. */
export interface EstateInventory {
  resources: number;
  types: { type: string; count: number }[];
  roots: EstateInventoryRoot[];
}

/** A run as the page shows it. */
export interface EstateRun {
  project: string;
  commit: string;
  stage: string;
  wave?: number;
  /** The share of a wave split across jobs. */
  share?: number;
  finished: string;
  roots: number;
  changed?: number;
  failed?: number;
  refused: number;
  totals: IndexEntry["totals"];
  destroys: number;
  approval?: IndexEntry["approval"];
  waiting_since?: string;
  applied?: string;
  /** Roots a policy override let through. */
  overridden?: number;
  /** The run's report.html, when the page can link it. */
  report?: string;
  pull_request?: string;
  pull_request_url?: string;
  job_url?: string;
}

export interface EstateWaiting {
  project: string;
  wave: number;
  commit: string;
  since: string;
  /** Seconds it had waited when the page was built. */
  age_seconds: number;
  report?: string;
}

export interface EstateProject {
  project: string;
  /** No index yet, or one that could not be read. */
  status: "ok" | "no-index" | "error";
  error?: string;
  /** The project's index.html, when the page can link it. */
  index?: string;
  plan?: EstateRun;
  drift?: EstateRun;
  /** The waves of the newest commit that ran tf-apply, by wave number. */
  apply?: { commit: string; waves: EstateRun[] };
  waiting: EstateWaiting[];
  /** Roots that drifted in the latest drift check. */
  drifted: number;
  /** Roots that failed in the latest plan, drift check and apply waves. */
  failed: number;
  /** Roots the newest commit's apply waves applied under a policy override. Absent when none. */
  overridden?: number;
  /** The resources its roots hold, from its inventory. Absent until an apply records them. */
  inventory?: EstateInventory;
  /** Each root's state versions, from its states.json. Absent until an apply records them. */
  states?: EstateStateRoot[];
  /** Each cross-state edge, from its edges.json. Absent until a run records one. */
  edges?: EstateEdge[];
  /** The run view the graph read: its commit, when a wave last wrote it, and its page when the page can link it. Absent until a wave writes one. */
  run_view?: { commit: string; updated: string; page?: string };
  /** The waves of that run view still applying that follow their resources (a choudoufu wave): how many are done, in flight and waiting at the last read. */
  applying?: { wave: number; read: string; total: number; done: number; in_flight: number; waiting: number }[];
  /** The live ephemeral environments, from its ephemeral.json: each pull request's copy and when it expires. Absent when none is live. */
  ephemeral?: EphemeralRow[];  /** The secrets its states hold and its choudoufu estates' settings, from one run's index row. Absent until a run records them. */
  secrets?: EstateSecrets;
}

/**
 * Per root, the sensitive attributes its state holds and how many a
 * write-only argument or an ephemeral resource could keep out, and for a
 * choudoufu root its estate, record store and `strict { secrets }` setting.
 * From the newest drift check that recorded them, else the newest plan of a
 * push, else the newest plan of a pull request.
 */
export interface EstateSecrets {
  run: EstateRun;
  roots: { root: string; in_state?: number; movable?: number; estate?: string; record_store?: string; secrets?: string }[];
}

/** A run of an edge, linked to its report when the page can link it. */
export type EstateEdgeRun = Omit<EdgeRun, "path"> & { report?: string };

/** One cross-state edge on the page. */
export interface EstateEdge extends Omit<Edge, "consumer_planned" | "producer_applied"> {
  consumer_planned?: EstateEdgeRun;
  producer_applied?: EstateEdgeRun;
}

/** The estate's dependency graph: every root of each project's run view by wave, and an edge from each root to each root that reads its state. */
export interface EstateGraph {
  nodes: { project: string; root: string; wave: number }[];
  /** `to` reads the state of `from`; an edge between two projects matched a read of a state outside the reader's project to a root of the other. */
  edges: GraphEdge[];
}

export interface Estate {
  schema: typeof ESTATE_SCHEMA;
  generated: string;
  /** `overridden_roots` only when a policy override let a root through; `resources` only when a project has an inventory. */
  totals: { projects: number; waiting: number; drifted_projects: number; drifted_roots: number; failed_roots: number; unreadable: number; overridden_roots?: number; resources?: number; ephemeral?: number };
  projects: EstateProject[];
  /** The newest runs across every project, newest first. */
  recent: EstateRun[];
  /** The audit trail beside the page, when `terragucci audit` wrote one: its page, how many entries, and when. */
  audit?: { page: string; entries: number; generated: string };
  /** The resource history beside the page, when an apply changed a resource: its page, how many addresses, and when. */
  history?: { page: string; resources: number; generated: string };
  /** The DORA metrics beside the page (dora.json): when they were built, and the estate's applied waves in their window. */
  dora?: { file: string; generated: string; deployments: number };
  /** The dependency graph, from the projects' run views. Absent when no project has one. */
  graph?: EstateGraph;
  /** Per module, provider and binary, the versions the roots run and the roots on each, from the projects' versions.json. Absent until an apply records them. */
  versions?: EstateVersions;
}

const at = (iso: string): number => Date.parse(iso) || 0;
const secondsSince = (iso: string, now: Date): number => Math.max(0, Math.round((now.getTime() - at(iso)) / 1000));

function run(e: IndexEntry, base: string | undefined): EstateRun {
  return {
    project: e.project,
    commit: e.commit,
    stage: e.stage,
    ...(e.wave !== undefined ? { wave: e.wave } : {}),
    ...(e.share !== undefined ? { share: e.share } : {}),
    finished: e.finished,
    roots: e.roots,
    ...(e.changed !== undefined ? { changed: e.changed } : {}),
    ...(e.failed !== undefined ? { failed: e.failed } : {}),
    refused: e.refused,
    totals: e.totals,
    destroys: e.destroys_total ?? e.destroys.length,
    ...(e.approval ? { approval: e.approval } : {}),
    ...(e.waiting_since ? { waiting_since: e.waiting_since } : {}),
    ...(e.applied ? { applied: e.applied } : {}),
    ...(e.overridden ? { overridden: e.overridden } : {}),
    ...(base !== undefined ? { report: `${base}${e.path}/report.html` } : {}),
    ...(e.pull_request ? { pull_request: e.pull_request } : {}),
    ...(e.pull_request_url ? { pull_request_url: e.pull_request_url } : {}),
    ...(e.job_url ? { job_url: e.job_url } : {}),
  };
}

/** A base that ends in a slash, so a run's path can follow it. */
const dirOf = (base: string | undefined): string | undefined => (base === undefined || base === "" || base.endsWith("/") ? base : `${base}/`);

const newest = (rows: IndexEntry[]): IndexEntry | undefined => rows.reduce<IndexEntry | undefined>((a, r) => (!a || at(r.finished) > at(a.finished) ? r : a), undefined);

/** The project's secrets in state and estates' settings, from the newest row that recorded them (EstateSecrets). */
function secretsOf(rows: IndexEntry[], base: string | undefined): EstateSecrets | undefined {
  const recorded = rows.filter((r) => r.secrets || r.estates);
  const row = newest(recorded.filter((r) => r.stage === "tf-drift")) ?? newest(recorded.filter((r) => r.stage === "tf-plan" && !r.pull_request)) ?? newest(recorded.filter((r) => r.stage === "tf-plan"));
  if (!row) return undefined;
  const byRoot = new Map<string, EstateSecrets["roots"][number]>();
  const of = (root: string) => byRoot.get(root) ?? byRoot.set(root, { root }).get(root)!;
  for (const r of row.secrets ?? []) Object.assign(of(r.root), { in_state: r.in_state, movable: r.movable });
  for (const e of row.estates ?? []) Object.assign(of(e.root), { estate: e.estate, record_store: e.record_store, secrets: e.secrets });
  return { run: run(row, base), roots: [...byRoot.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)) };
}

/** A project's resources from its inventory. */
function inventoryOf(inv: Inventory, base: string | undefined): EstateInventory {
  const roots = inv.roots.map((r) => ({
    root: r.root,
    commit: r.commit,
    finished: r.finished,
    ...(r.wave !== undefined ? { wave: r.wave } : {}),
    ...(base !== undefined ? { report: `${base}${r.path}/report.html` } : {}),
    ...(r.environment ? { environment: r.environment } : {}),
    resources: r.resources.map((x) => ({ address: x.address, type: x.type, provider: x.provider })),
  }));
  const all = roots.flatMap((r) => r.resources);
  return { resources: all.length, types: countTypes(all), roots };
}

/** A project's state versions, each run linked to its report when the page can link it. */
function statesOf(st: StateVersions, base: string | undefined): EstateStateRoot[] {
  return st.roots.map((r) => ({
    root: r.root,
    backend: r.backend,
    ...(r.location !== undefined ? { location: r.location } : {}),
    versioning: r.versioning,
    ...(r.note !== undefined ? { note: r.note } : {}),
    checked: r.checked,
    versions: r.versions.map((v) => ({
      version_id: v.version_id,
      commit: v.commit,
      finished: v.finished,
      ...(v.wave !== undefined ? { wave: v.wave } : {}),
      ...(base !== undefined ? { report: `${base}${v.path}/report.html` } : {}),
    })),
  }));
}

/** A project's cross-state edges, each run linked to its report when the page can link it. */
function edgesOfProject(st: StateEdges, base: string | undefined): EstateEdge[] {
  const linked = (r: EdgeRun | undefined): EstateEdgeRun | undefined => {
    if (!r) return undefined;
    const { path, ...rest } = r;
    return { ...rest, ...(base !== undefined ? { report: `${base}${path}/report.html` } : {}) };
  };
  return edgesOf(st).map((e) => {
    const planned = linked(e.consumer_planned);
    const applied = linked(e.producer_applied);
    return { consumer: e.consumer, producer: e.producer, via: e.via, ...(planned ? { consumer_planned: planned } : {}), ...(applied ? { producer_applied: applied } : {}), status: e.status };
  });
}

/** One project's state from its index rows. A row of another project (a top-of-prefix index) is left out. */
export function projectState(p: ProjectIndex, now: Date): EstateProject {
  const base = dirOf(p.base);
  const index = base !== undefined ? { index: `${base}index.html` } : {};
  if (p.error !== undefined) return { project: p.project, status: "error", error: p.error, ...index, waiting: [], drifted: 0, failed: 0 };
  const ephemeral = p.ephemeral && p.ephemeral.project === p.project && p.ephemeral.environments.length > 0 ? { ephemeral: p.ephemeral.environments } : {};
  if (!p.reports) return { project: p.project, status: "no-index", waiting: [], drifted: 0, failed: 0, ...ephemeral };
  const rows = p.reports.filter((r) => r.project === p.project);
  const plan = newest(rows.filter((r) => r.stage === "tf-plan"));
  const drift = newest(rows.filter((r) => r.stage === "tf-drift"));
  const applies = rows.filter((r) => r.stage === "tf-apply");
  // The newest commit that ran tf-apply holds the estate's apply state; an older commit's waiting wave is behind it.
  const last = newest(applies);
  let apply: EstateProject["apply"];
  const waiting: EstateWaiting[] = [];
  if (last) {
    // A wave split across jobs has a row per share, and each share is its own entry.
    const byWave = new Map<string, IndexEntry>();
    for (const r of applies.filter((x) => x.commit === last.commit)) {
      const n = `${r.wave ?? 0}/${r.share ?? 0}`;
      const held = byWave.get(n);
      if (!held || at(r.finished) > at(held.finished)) byWave.set(n, r);
    }
    const waves = [...byWave.values()].sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0) || (a.share ?? 0) - (b.share ?? 0));
    apply = { commit: last.commit, waves: waves.map((r) => run(r, base)) };
    for (const r of waves) {
      if (r.approval !== "waiting") continue;
      const since = r.waiting_since ?? r.finished;
      waiting.push({
        project: p.project,
        wave: r.wave ?? 0,
        commit: r.commit,
        since,
        age_seconds: secondsSince(since, now),
        ...(base !== undefined ? { report: `${base}${r.path}/report.html` } : {}),
      });
    }
  }
  const failedIn = (r: IndexEntry | undefined): number => r?.failed ?? 0;
  const overridden = apply ? apply.waves.reduce((n, w) => n + (w.overridden ?? 0), 0) : 0;
  return {
    project: p.project,
    status: "ok",
    ...index,
    ...(plan ? { plan: run(plan, base) } : {}),
    ...(drift ? { drift: run(drift, base) } : {}),
    ...(apply ? { apply } : {}),
    waiting,
    drifted: drift?.changed ?? 0,
    failed: failedIn(plan) + failedIn(drift) + (apply ? apply.waves.reduce((n, w) => n + (w.failed ?? 0), 0) : 0),
    ...(overridden > 0 ? { overridden } : {}),
    ...(p.inventory ? { inventory: inventoryOf(p.inventory, base) } : {}),
    ...(p.states ? { states: statesOf(p.states, base) } : {}),
    ...(p.run ? { run_view: { commit: p.run.commit, updated: p.run.updated, ...(base !== undefined ? { page: `${base}runs/${p.run.commit}/run.html` } : {}) } } : {}),
    ...applyingOf(p.run),
    ...(p.edges && edgesOf(p.edges).length > 0 ? { edges: edgesOfProject(p.edges, base) } : {}),
    ...ephemeral,
    ...((): Pick<EstateProject, "secrets"> => {
      const secrets = secretsOf(rows, base);
      return secrets ? { secrets } : {};
    })(),
  };
}

/** The run view's waves still applying with their resources followed, as counts. */
function applyingOf(run: RunView | undefined): Pick<EstateProject, "applying"> {
  const rows = (run?.waves ?? [])
    .filter((w) => w.state === "applying" && w.progress)
    .map((w) => {
      const c = progressCounts(w.progress!);
      return { wave: w.number, read: w.progress!.read, total: w.progress!.resources.length, done: c.done, in_flight: c["in-flight"], waiting: c.waiting };
    });
  return rows.length ? { applying: rows } : {};
}

const sameState = (a: RunState, b: RunState): boolean => a.key === b.key && (!a.bucket || !b.bucket || a.bucket === b.bucket);

/**
 * The graph from every project's run view: each project's own edges, and an
 * edge from a root of one project to a root of another whose read of a state
 * outside its project names the first root's state.
 */
export function estateGraph(indexes: readonly ProjectIndex[]): EstateGraph | undefined {
  const views = indexes.filter((p) => p.reports && p.error === undefined && p.run && p.run.project === p.project).map((p) => p.run!);
  if (views.length === 0) return undefined;
  const nodes = views.flatMap((v) => v.roots.map((r) => ({ project: v.project, root: r.root, wave: r.wave })));
  const edges: GraphEdge[] = [];
  for (const v of views) {
    for (const r of v.roots) for (const u of r.reads) edges.push({ from: { project: v.project, root: u }, to: { project: v.project, root: r.root } });
  }
  const held = views.flatMap((v) => v.roots.filter((r) => r.state).map((r) => ({ project: v.project, root: r.root, state: r.state! })));
  for (const v of views) {
    for (const r of v.roots) {
      for (const x of r.external ?? []) {
        for (const h of held) {
          if (h.project === v.project || !sameState(h.state, x)) continue;
          if (!edges.some((e) => e.from.project === h.project && e.from.root === h.root && e.to.project === v.project && e.to.root === r.root)) {
            edges.push({ from: { project: h.project, root: h.root }, to: { project: v.project, root: r.root } });
          }
        }
      }
    }
  }
  return { nodes, edges };
}

/** The estate from every project's index. Projects keep the order given. */
/**
 * Put each `unrecorded-write` entry of the audit trail on its root's state,
 * newest first: the versions the store lists that no wave or migration
 * recorded.
 */
export function linkUnrecorded(page: Estate, entries: AuditEntry[]): void {
  const by = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    if (e.kind !== "unrecorded-write") continue;
    const k = `${e.project}\n${e.what}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  for (const p of page.projects) {
    for (const r of p.states ?? []) {
      const found = by.get(`${p.project}\n${r.root}`);
      if (!found) continue;
      r.unrecorded = found
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .map((e) => ({ version_id: String(e.detail?.current_version ?? e.evidence.version_id ?? ""), written_at: e.at, who: e.who, ...(e.detail?.deleted === true ? { deleted: true } : {}) }));
    }
  }
}

export function buildEstate(indexes: ProjectIndex[], now: Date = new Date()): Estate {
  const projects = indexes.map((p) => projectState(p, now));
  const overridden = projects.reduce((n, p) => n + (p.overridden ?? 0), 0);
  const inventoried = projects.filter((p) => p.inventory);
  const ephemeral = projects.reduce((n, p) => n + (p.ephemeral?.length ?? 0), 0);
  const recent = indexes
    .flatMap((p) => (p.reports ?? []).filter((r) => r.project === p.project).map((r) => ({ r, base: dirOf(p.base) })))
    .sort((a, b) => at(b.r.finished) - at(a.r.finished) || (a.r.path < b.r.path ? -1 : 1))
    .slice(0, RECENT_RUNS)
    .map(({ r, base }) => run(r, base));
  return {
    schema: ESTATE_SCHEMA,
    generated: now.toISOString(),
    totals: {
      projects: projects.length,
      waiting: projects.reduce((n, p) => n + p.waiting.length, 0),
      drifted_projects: projects.filter((p) => p.drifted > 0).length,
      drifted_roots: projects.reduce((n, p) => n + p.drifted, 0),
      failed_roots: projects.reduce((n, p) => n + p.failed, 0),
      unreadable: projects.filter((p) => p.status === "error").length,
      ...(overridden > 0 ? { overridden_roots: overridden } : {}),
      ...(inventoried.length > 0 ? { resources: inventoried.reduce((n, p) => n + p.inventory!.resources, 0) } : {}),
      ...(ephemeral > 0 ? { ephemeral } : {}),
    },
    projects,
    recent,
    ...((): { graph?: EstateGraph } => {
      const graph = estateGraph(indexes);
      return graph ? { graph } : {};
    })(),
    ...((): { versions?: EstateVersions } => {
      // An index that could not be read leaves its project out, as it leaves its inventory out.
      const versions = estateVersions(indexes.filter((p) => p.reports && p.error === undefined));
      return versions ? { versions } : {};
    })(),
  };
}

/** "3d 4h", "2h 10m", "5m": how long, to two units. */
export function age(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const changes = (r: EstateRun): string => {
  const t = r.totals;
  return `+${t.create} ~${t.update} -/+${t.replace} -${t.delete}`;
};

const link = (href: string | undefined, text: string): string => (href ? `<a href="${esc(href)}">${text}</a>` : text);

/** How long ago; the page's script moves it forward while the page is open. */
const when = (iso: string, now: Date): string => `<time datetime="${esc(iso)}">${esc(age(secondsSince(iso, now)))} ago</time>`;

/** How long since, as a duration ("waiting 2h 10m"). */
const lasting = (iso: string, now: Date): string => `<time datetime="${esc(iso)}" data-for>${esc(age(secondsSince(iso, now)))}</time>`;

const short = (commit: string): string => `<code>${esc(commit.slice(0, 12))}</code>`;

function stageCell(r: EstateRun | undefined, now: Date, drift = false): string {
  if (!r) return `<td class="none">none yet</td>`;
  const bits = [drift ? `${r.changed ?? 0} of ${r.roots} roots drifted` : `${r.roots} roots, ${changes(r)}`];
  if (r.failed) bits.push(`<span class="bad">${r.failed} failed</span>`);
  if (r.refused) bits.push(`${r.refused} refused`);
  return `<td${drift && (r.changed ?? 0) > 0 ? ` class="warn"` : ""}>${link(r.report, bits.join(", "))}<br><small>${short(r.commit)} ${when(r.finished, now)}</small></td>`;
}

function applyCell(p: EstateProject, now: Date): string {
  if (!p.apply) return `<td class="none">none yet</td>`;
  const waves = p.apply.waves.map((w) => {
    const state = w.approval === "waiting"
      ? `<span class="warn">waiting ${lasting(w.waiting_since ?? w.finished, now)}</span>`
      : w.failed
        ? `<span class="bad">${w.failed} failed</span>`
        : w.applied
          ? "applied"
          : w.approval ?? "ran";
    return `<li>${link(w.report, `wave ${w.wave ?? 0}${w.share !== undefined ? `, share ${w.share}` : ""}`)}: ${state}${w.overridden ? `, <span class="warn">${w.overridden} by policy override</span>` : ""}</li>`;
  });
  const view = p.run_view?.page && p.run_view.commit === p.apply.commit ? ` ${link(p.run_view.page, "run view")}` : "";
  return `<td><ul>${waves.join("")}</ul>${applyingBars(p)}<small>${short(p.apply.commit)}${view}</small></td>`;
}

/** Each wave still applying, as a bar of its resources done, in flight and waiting. */
function applyingBars(p: EstateProject): string {
  return (p.applying ?? [])
    .map((a) => {
      const seg = (n: number, cls: string): string => (n > 0 ? `<span class="${cls}" style="flex:${n}"></span>` : "");
      const bar = `<span class="pbar">${seg(a.done, "p-done")}${seg(a.in_flight, "p-in-flight")}${seg(a.waiting, "p-waiting")}</span>`;
      return `<div class="applying" data-wave="${a.wave}" data-done="${a.done}" data-in-flight="${a.in_flight}" data-waiting="${a.waiting}">${link(p.run_view?.page, `wave ${a.wave}`)} applying: ${a.done} of ${a.total} done, ${a.in_flight} in flight, ${a.waiting} waiting${bar}</div>`;
    })
    .join("");
}

/** A provider's source address without the public registry's host. */
const providerName = (p: string): string => p.replace(/^registry\.(terraform\.io|opentofu\.org)\//, "");

/** Beside a choudoufu resource: its record's version count, linked to the list, or that the store keeps none, or that they were not listed. */
function versionsNote(v: NonNullable<EstateResource["record_versions"]>, history: string | undefined): string {
  if (v.error !== undefined) return `<small class="versions" data-versions="error" title="${esc(v.error)}">versions not listed</small>`;
  if (!v.kept) return `<small class="versions" data-versions="none">no past versions kept</small>`;
  const n = v.count ?? 0;
  return `<small class="versions" data-versions="${n}">${link(history, `${n} ${n === 1 ? "version" : "versions"}`)}</small>`;
}

/** The resources section: per project its counts by type, then each root's resources. A filter box narrows the rows once scripts run. */
function resourcesSection(estate: Estate, now: Date): string {
  const projects = estate.projects.filter((p) => p.inventory);
  if (projects.length === 0) return `<p class="none">No apply has recorded its resources yet.</p>`;
  const blocks = projects.map((p) => {
    const inv = p.inventory!;
    const types = inv.types.map((t) => `<code>${esc(t.type)}</code> ${t.count}`).join(", ");
    const roots = inv.roots.map((r) => {
      const head = `<tr class="head"><th colspan="3"><code>${esc(r.root)}</code>${r.environment ? ` <span class="env" data-environment="${esc(r.environment)}">${esc(r.environment)}</span>` : ""}: ${r.resources.length} ${r.resources.length === 1 ? "resource" : "resources"}, ${link(r.report, `${r.wave !== undefined ? `wave ${r.wave}` : "applied"}`)} ${short(r.commit)} ${when(r.finished, now)}</th></tr>`;
      const rows = r.resources.map((x) => `<tr data-r="${esc(`${r.root}${r.environment ? ` ${r.environment}` : ""} ${x.address} ${x.type} ${x.provider}`.toLowerCase())}"><td>${link(x.history, `<code>${esc(x.address)}</code>`)}${x.record_versions ? ` ${versionsNote(x.record_versions, x.history)}` : ""}</td><td><code>${esc(x.type)}</code></td><td>${esc(providerName(x.provider))}</td></tr>`);
      return `<tbody class="inv" data-root="${esc(r.root)}">${head}${rows.join("")}</tbody>`;
    });
    return `<h3>${link(p.index, esc(p.project))}: ${inv.resources} ${inv.resources === 1 ? "resource" : "resources"} in ${inv.roots.length} ${inv.roots.length === 1 ? "root" : "roots"}</h3>
<p class="types">${types}</p>
<div class="scroll"><table class="resources"><thead><tr><th>Address</th><th>Type</th><th>Provider</th></tr></thead>${roots.join("\n")}</table></div>`;
  });
  return `<p><input type="search" id="resources-filter" placeholder="Filter by root, address, type or provider" aria-label="Filter resources" hidden></p>\n${blocks.join("\n")}`;
}

/**
 * The versions section: per module source, provider and binary, each version
 * in use, newest first, and the roots on it. A rollout that finished leaves
 * one version of what it moved.
 */
function versionsSection(estate: Estate): string {
  const v = estate.versions;
  if (!v) return `<p class="none">No apply has recorded its versions yet.</p>`;
  const where = (r: EstateVersionRow["roots"][number]): string => `${esc(r.project)}: <code>${esc(r.root)}</code>${r.call ? ` <small>${esc(r.call)}</small>` : ""}`;
  const table = (title: string, kind: string, none: string, groups: { name: string; versions: EstateVersionRow[] }[]): string => {
    if (groups.length === 0) return "";
    const bodies = groups.map((g) => {
      const live = g.versions.length;
      const head = `<tr class="head"><th colspan="2"><code>${esc(g.name)}</code>: ${live === 1 ? "1 version" : `<span class="warn">${live} versions</span>`} live</th></tr>`;
      const rows = g.versions.map((x) => `<tr data-version="${esc(x.version ?? "")}"><td>${x.version !== undefined ? `<code>${esc(x.version)}</code>` : `<span class="none">${none}</span>`}</td><td>${x.roots.map(where).join("<br>")}</td></tr>`);
      return `<tbody class="ver" data-${kind}="${esc(g.name)}" data-live="${live}">${head}${rows.join("")}</tbody>`;
    });
    return `<h3>${title}</h3>
<div class="scroll"><table id="versions-${title.toLowerCase()}"><thead><tr><th>Version</th><th>Roots</th></tr></thead>${bodies.join("\n")}</table></div>`;
  };
  return [
    table("Modules", "module", "no version in its source", v.modules.map((m) => ({ name: m.source, versions: m.versions }))),
    table("Providers", "provider", "not locked", v.providers.map((p) => ({ name: p.provider, versions: p.versions }))),
    table("Binaries", "binary", "version not reported", v.binaries.map((b) => ({ name: b.binary, versions: b.versions }))),
  ].filter(Boolean).join("\n");
}

/**
 * The state versions section: per project, each root's state, and either the
 * versions its applies left, newest first, with any version its store lists
 * that no wave or migration recorded among them, or why there are none.
 */
function statesSection(estate: Estate, now: Date): string {
  const projects = estate.projects.filter((p) => p.states && p.states.length > 0);
  if (projects.length === 0) return `<p class="none">No apply has recorded a state version yet.</p>`;
  const blocks = projects.map((p) => {
    const roots = p.states!.map((r) => {
      const where = r.location ? ` <code>${esc(r.location)}</code>` : "";
      const state =
        r.versioning === "off"
          ? `<span class="warn">versions are off</span>${r.note ? `: ${esc(r.note)}` : ""}`
          : r.versioning === "unknown"
            ? `<span class="warn">versions not read</span>${r.note ? `: ${esc(r.note)}` : ""}`
            : `${r.versions.length} ${r.versions.length === 1 ? "version" : "versions"}`;
      const flagged = r.unrecorded?.length ? `, <span class="warn">${r.unrecorded.length} unrecorded ${r.unrecorded.length === 1 ? "write" : "writes"}</span>` : "";
      const head = `<tr class="head"><th colspan="3"><code>${esc(r.root)}</code>: ${esc(r.backend)}${where}, ${state}${flagged}</th></tr>`;
      const recorded = r.versions.map((v) => ({ at: v.finished, row: `<tr><td><code>${esc(v.version_id)}</code></td><td>${link(v.report, v.wave !== undefined ? `wave ${v.wave}` : "applied")} ${short(v.commit)}</td><td>${when(v.finished, now)}</td></tr>` }));
      const unrecorded = (r.unrecorded ?? []).map((u) => ({ at: u.written_at, row: `<tr class="unrecorded"><td><code>${esc(u.version_id)}</code></td><td><span class="warn">${u.deleted ? "deleted" : "written"} outside a wave or migration</span>${u.who ? ` by ${esc(u.who)}` : ""}</td><td>${when(u.written_at, now)}</td></tr>` }));
      const rows = [...recorded, ...unrecorded].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((x) => x.row);
      return `<tbody class="states" data-root="${esc(r.root)}">${head}${rows.join("")}</tbody>`;
    });
    return `<h3>${link(p.index, esc(p.project))}</h3>
<div class="scroll"><table><thead><tr><th>Version id</th><th>Written by</th><th>When</th></tr></thead>${roots.join("\n")}</table></div>`;
  });
  return blocks.join("\n");
}

/**
 * The secrets section: per project, each root's sensitive attributes in
 * state and how many could stay out of it, and each choudoufu estate's record
 * store and `secrets` setting, from the run that recorded them.
 */
function secretsSection(estate: Estate, now: Date): string {
  const projects = estate.projects.filter((p) => p.secrets && p.secrets.roots.length > 0);
  if (projects.length === 0) return `<p class="none">No plan or drift check has recorded a secret in state or a choudoufu estate yet.</p>`;
  const tip = (name: string) => `<a href="https://intentius.io/terragucci/reference/tips/#${name}"><code>${name}</code></a>`;
  const blocks = projects.map((p) => {
    const s = p.secrets!;
    const rows = s.roots.map((r) => {
      const held = r.in_state === undefined ? `<td>0</td><td></td>` : `<td>${r.in_state}</td><td>${r.movable ? `<span class="warn">${r.movable}</span>` : "0"}</td>`;
      const store = r.estate !== undefined ? `<td><code>${esc(r.estate)}</code> <code>${esc(r.record_store ?? "")}</code></td><td>${r.secrets === "refuse" ? "<code>refuse</code>" : `<span class="warn"><code>${esc(r.secrets ?? "store")}</code></span>`}</td>` : `<td></td><td></td>`;
      return `<tr data-root="${esc(r.root)}"><td><code>${esc(r.root)}</code></td>${held}${store}</tr>`;
    });
    return `<h3>${link(p.index, esc(p.project))}</h3>
<p><small>From ${link(s.run.report, esc(s.run.stage))} ${short(s.run.commit)}, ${when(s.run.finished, now)}.</small></p>
<div class="scroll"><table><thead><tr><th>Root</th><th>Sensitive attributes in state</th><th>Could stay out</th><th>Estate and record store</th><th><code>secrets</code></th></tr></thead>
${rows.join("\n")}
</table></div>`;
  });
  return `<p>Each count under Could stay out has a ${tip("terragucci-secret-in-state")} tip on the plan naming the attribute and its write-only argument or ephemeral resource. An estate whose <code>secrets</code> is not <code>refuse</code> has a ${tip("terragucci-choudoufu-secrets")} tip.</p>\n${blocks.join("\n")}`;
}

/** The dependency graph section: the picture, and its edges between projects as a list. */
function graphSection(estate: Estate): string {
  const g = estate.graph;
  if (!g) return `<p class="none">No apply has written a run view yet, so the roots' order is not known.</p>`;
  const projects = estate.projects
    .filter((p) => g.nodes.some((n) => n.project === p.project))
    .map((p) => ({ project: p.project, ...(p.run_view?.page ? { href: p.run_view.page } : {}), roots: g.nodes.filter((n) => n.project === p.project).map((n) => ({ root: n.root, wave: n.wave })) }));
  const svg = renderGraphSvg(projects, g.edges);
  const cross = g.edges.filter((e) => e.from.project !== e.to.project);
  const within = g.edges.length - cross.length;
  const crossList = cross.length
    ? `<h3>Between projects</h3><ul id="cross-edges">${cross.map((e) => `<li data-from="${esc(`${e.from.project} ${e.from.root}`)}" data-to="${esc(`${e.to.project} ${e.to.root}`)}">${esc(e.to.project)}: <code>${esc(e.to.root)}</code> reads ${esc(e.from.project)}: <code>${esc(e.from.root)}</code></li>`).join("")}</ul>`
    : "";
  const views = estate.projects.filter((p) => p.run_view).map((p) => `${link(p.run_view!.page, esc(p.project))} at ${short(p.run_view!.commit)}`);
  return `<p>${g.nodes.length} ${g.nodes.length === 1 ? "root" : "roots"} by wave, ${within} ${within === 1 ? "read" : "reads"} within a project and ${cross.length} between projects, from the run view of each project's newest apply: ${views.join(", ")}. An arrow points from a root to the roots that read its state; a dashed one crosses projects.</p>
<div class="graphwrap">${svg}</div>
${crossList}`;
}

/**
 * The cross-state edges section: per project, each root that reads another
 * root's state, with its last plan against the producer's last apply that
 * changed it. A consumer that last planned before that apply is stale.
 */
function edgesSection(estate: Estate, now: Date): string {
  const projects = estate.projects.filter((p) => p.edges && p.edges.length > 0);
  if (projects.length === 0) return `<p class="none">No root reads another root's state, or no run has recorded one yet.</p>`;
  const ran = (r: EstateEdgeRun | undefined, what: string): string =>
    r ? `${link(r.report, `${esc(r.stage)}${r.wave !== undefined ? ` wave ${r.wave}` : ""}`)} ${short(r.commit)} ${when(r.finished, now)}${r.version_id ? ` <code>${esc(r.version_id)}</code>` : ""}` : `<span class="none">${what}</span>`;
  const STATUS = { stale: `<span class="warn">stale: the producer applied after this plan</span>`, current: "current", unknown: `<span class="none">unknown</span>` } as const;
  const blocks = projects.map((p) => {
    const byConsumer = new Map<string, EstateEdge[]>();
    for (const e of p.edges!) byConsumer.set(e.consumer, [...(byConsumer.get(e.consumer) ?? []), e]);
    const bodies = [...byConsumer].map(([consumer, edges]) => {
      const head = `<tr class="head"><th colspan="4"><code>${esc(consumer)}</code> reads ${edges.length} ${edges.length === 1 ? "state" : "states"}</th></tr>`;
      const rows = edges.map((e) => `<tr data-edge="${esc(e.consumer)} ${esc(e.producer)}" data-status="${e.status}"><td><code>${esc(e.producer)}</code> <small>${e.via === "dependency" ? "dependency" : "terraform_remote_state"}</small></td><td>${ran(e.consumer_planned, "no plan recorded")}</td><td>${ran(e.producer_applied, "no change applied")}</td><td>${STATUS[e.status]}</td></tr>`);
      return `<tbody class="edges" data-root="${esc(consumer)}">${head}${rows.join("")}</tbody>`;
    });
    return `<h3>${link(p.index, esc(p.project))}</h3>
<div class="scroll"><table><thead><tr><th>Reads</th><th>Its last plan</th><th>The producer's last apply</th><th></th></tr></thead>${bodies.join("\n")}</table></div>`;
  });
  return blocks.join("\n");
}

/** When an ephemeral copy expires: in how long, or that the sweep has yet to destroy it. */
const expiry = (iso: string, now: Date): string => {
  const left = Math.round((at(iso) - now.getTime()) / 1000);
  return left > 0 ? `<time datetime="${esc(iso)}" data-in>in ${esc(age(left))}</time>` : `<span class="warn">expired <time datetime="${esc(iso)}">${esc(age(-left))} ago</time>; the next sweep destroys it</span>`;
};

/** The ephemeral environments section: per pull request, its copy's roots and state keys, when it last applied and when it expires. */
function ephemeralSection(estate: Estate, now: Date): string {
  const rows = estate.projects.flatMap((p) =>
    (p.ephemeral ?? []).map((e) => {
      const roots = e.roots.map((r) => `<code>${esc(r.root)}</code> <small>${esc(r.location)}</small>`).join("<br>");
      const status = e.status === "destroy-failed" ? `<span class="bad">a destroy failed; the sweep tries again</span>` : "live";
      return `<tr data-pr="${e.pull_request}"><td>${esc(p.project)}</td><td>${link(e.pull_request_url, `#${e.pull_request}`)}</td><td>${roots}</td><td>${short(e.commit)} ${when(e.applied, now)}</td><td>${expiry(e.expires, now)}</td><td>${status}</td></tr>`;
    }),
  );
  if (rows.length === 0) return `<p class="none">No pull request has a live ephemeral environment.</p>`;
  return `<div class="scroll"><table id="ephemeral-environments"><tr><th>Project</th><th>Pull request</th><th>Roots and state keys</th><th>Applied</th><th>Expires</th><th></th></tr>\n${rows.join("\n")}\n</table></div>`;
}

/**
 * The page. Its numbers are in the HTML, so it reads with scripts off; a
 * small script only moves the "ago" times forward while it is open, and the
 * estate JSON rides inline for a reader that wants it.
 */
export function renderEstateHtml(estate: Estate, dora?: Dora): string {
  const now = new Date(estate.generated);
  const t = estate.totals;
  const tiles = [
    [t.projects, "projects"],
    [t.waiting, t.waiting === 1 ? "wave waiting" : "waves waiting"],
    [t.drifted_projects, t.drifted_projects === 1 ? "project drifted" : "projects drifted"],
    [t.failed_roots, t.failed_roots === 1 ? "root failed" : "roots failed"],
    ...(t.overridden_roots ? [[t.overridden_roots, t.overridden_roots === 1 ? "root applied by policy override" : "roots applied by policy override"]] : []),
    ...(t.resources !== undefined ? [[t.resources, t.resources === 1 ? "resource" : "resources"]] : []),
    ...(t.ephemeral ? [[t.ephemeral, t.ephemeral === 1 ? "ephemeral environment" : "ephemeral environments"]] : []),
  ].map(([n, label]) => `<div class="tile${Number(n) > 0 && label !== "projects" && !String(label).startsWith("resource") && !String(label).startsWith("ephemeral") ? " hot" : ""}"><b>${n}</b><span>${label}</span></div>`);
  const waiting = estate.projects.flatMap((p) => p.waiting).sort((a, b) => b.age_seconds - a.age_seconds);
  const waitingRows = waiting.map((w) => `<tr><td>${esc(w.project)}</td><td>${link(w.report, `wave ${w.wave}`)}</td><td>${short(w.commit)}</td><td>${lasting(w.since, now)}</td></tr>`);
  const projectRows = estate.projects.map((p) => {
    const name = link(p.index, esc(p.project));
    if (p.status === "no-index") return `<tr><td>${name}</td><td colspan="3" class="none">no runs in the bucket yet</td></tr>`;
    if (p.status === "error") return `<tr><td>${name}</td><td colspan="3" class="bad">the index could not be read: ${esc(p.error ?? "")}</td></tr>`;
    return `<tr><td>${name}</td>${stageCell(p.plan, now)}${stageCell(p.drift, now, true)}${applyCell(p, now)}</tr>`;
  });
  const recentRows = estate.recent.map((r) => {
    const pr = r.pull_request ? link(r.pull_request_url, `#${esc(r.pull_request)}`) : "";
    const state = r.approval === "waiting" ? `<span class="warn">waiting</span>` : r.failed ? `<span class="bad">${r.failed} failed</span>` : r.applied ? "applied" : r.stage === "tf-drift" ? `${r.changed ?? 0} drifted` : "";
    return `<tr><td>${esc(r.project)}</td><td>${link(r.report, `${esc(r.stage)}${r.wave !== undefined ? ` wave ${r.wave}` : ""}`)}</td><td>${short(r.commit)}</td><td>${pr}</td><td>${changes(r)}</td><td>${state}</td><td>${when(r.finished, now)}</td>${r.job_url ? `<td><a href="${esc(r.job_url)}">job</a></td>` : "<td></td>"}</tr>`;
  });
  // The JSON is inert data in a script tag; "</" is escaped so no value can close it.
  const json = JSON.stringify(estate).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>terragucci estate</title>
${TACO_ICON}
<style>${TACO_CSS}${GRAPH_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--dim:#6b6b64;--line:#deded8;--link:#1f5fbf;--warn:#9a5b00;--bad:#b3261e;--tile:#f0f0ec}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--dim:#a3a39a;--line:#34342f;--link:#8ab4ff;--warn:#f0b35a;--bad:#ff8a80;--tile:#1f1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}a{color:var(--link)}h2{font-size:16px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.tile{background:var(--tile);border-radius:6px;padding:10px 12px}.tile b{display:block;font-size:24px}.tile span{color:var(--dim)}.tile.hot b{color:var(--warn)}
.applying .pbar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--line);margin:4px 0}.p-done{background:#2e7d32}.p-in-flight{background:var(--warn)}.p-waiting{background:var(--line)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 12px 6px 0;text-align:left;vertical-align:top}th{color:var(--dim);font-weight:600}ul{margin:0;padding-left:16px}h3{font-size:14px;margin:16px 0 4px}.types{margin:0 0 6px}tbody.inv th,tbody.states th,tbody.edges th,tbody.ver th{font-weight:400;padding-top:12px}input[type=search]{width:100%;max-width:420px;padding:6px 8px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}small,.none{color:var(--dim)}dl.defs{margin:0 0 8px}dl.defs dt{font-weight:600}dl.defs dd{margin:0 0 4px;color:var(--dim)}.warn{color:var(--warn)}.bad{color:var(--bad)}code{font:12.5px ui-monospace,Menlo,monospace}</style>
</head><body><main><h1 class="brand">${TACO_IMG}Estate</h1>
<p>${estate.projects.length} projects, built from their report indexes <time datetime="${esc(estate.generated)}">${esc(estate.generated)}</time>.</p>
${estate.audit ? `<p>Audit trail: <a href="${esc(estate.audit.page)}" id="audit-trail">${estate.audit.entries} ${estate.audit.entries === 1 ? "entry" : "entries"}</a>, built <time datetime="${esc(estate.audit.generated)}">${esc(estate.audit.generated)}</time>.</p>` : ""}
<div class="tiles">${tiles.join("")}</div>
<h2>Waiting for an approval</h2>
${waitingRows.length ? `<div class="scroll"><table><tr><th>Project</th><th>Wave</th><th>Commit</th><th>Waiting for</th></tr>\n${waitingRows.join("\n")}\n</table></div>` : `<p class="none">No wave is waiting.</p>`}
<h2>Projects</h2>
<div class="scroll"><table><tr><th>Project</th><th>Latest plan</th><th>Latest drift check</th><th>Apply waves</th></tr>
${projectRows.join("\n")}
</table></div>
<h2 id="ephemeral">Ephemeral environments</h2>
${ephemeralSection(estate, now)}
<h2 id="dependencies">Dependencies</h2>
${graphSection(estate)}
<h2>Recent runs</h2>
${recentRows.length ? `<div class="scroll"><table><tr><th>Project</th><th>Stage</th><th>Commit</th><th>Pull request</th><th>Changes</th><th></th><th>Finished</th><th></th></tr>\n${recentRows.join("\n")}\n</table></div>` : `<p class="none">No runs yet.</p>`}
${dora ? `<h2 id="delivery">Delivery</h2>\n${renderDoraSection(dora, (name) => link(estate.projects.find((p) => p.project === name)?.index, esc(name)))}\n` : ""}<h2 id="resources">Resources</h2>
${estate.history ? `<p>Change history: <a href="${esc(estate.history.page)}" id="resource-history">${estate.history.resources} ${estate.history.resources === 1 ? "resource" : "resources"}</a>, each apply that changed one with its approver.</p>\n` : ""}${resourcesSection(estate, now)}
<h2 id="versions">Versions</h2>
${versionsSection(estate)}
<h2 id="state-versions">State versions</h2>
${statesSection(estate, now)}
<h2 id="secrets">Secrets in state</h2>
${secretsSection(estate, now)}
<h2 id="state-edges">Cross-state edges</h2>
${edgesSection(estate, now)}
</main>
<script type="application/json" id="terragucci-estate">${json}</script>
<script>(function(){function f(s){var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+"d "+h+"h":h>0?h+"h "+m+"m":m+"m"}var n=Date.now();document.querySelectorAll("td time[datetime],tbody.inv th time[datetime]").forEach(function(t){if(t.hasAttribute("data-in")){var l=Math.round((Date.parse(t.getAttribute("datetime"))-n)/1000);if(l>0)t.textContent="in "+f(l);return}var s=Math.max(0,Math.round((n-Date.parse(t.getAttribute("datetime")))/1000));if(!isNaN(s))t.textContent=f(s)+(t.hasAttribute("data-for")?"":" ago")});var q=document.getElementById("resources-filter");if(q){q.hidden=false;q.addEventListener("input",function(){var v=q.value.toLowerCase().trim();document.querySelectorAll("tbody.inv").forEach(function(b){var n=0;b.querySelectorAll("tr[data-r]").forEach(function(r){var m=!v||r.getAttribute("data-r").indexOf(v)>=0;r.hidden=!m;if(m)n++});b.hidden=n===0})})}})()</script>
</body></html>
`;
}

/** The estate JSON inlined in a page renderEstateHtml wrote. */
export function readInlineEstate(html: string): Estate | undefined {
  const m = /<script type="application\/json" id="terragucci-estate">([\s\S]*?)<\/script>/.exec(html);
  return m ? (JSON.parse(m[1]) as Estate) : undefined;
}
