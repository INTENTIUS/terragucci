/**
 * A choudoufu wave's progress per resource while it applies: each resource
 * its plans change is done, in flight, or waiting, read from the estate's
 * record store (./cdf-records.ts), never from the apply's output.
 *
 * Before the first apply starts, the wave reads each estate's records once.
 * While the applies run it reads them again every `TG_PROGRESS_SECONDS`
 * seconds (5 by default). A create, update or replace is done once its
 * record differs from the one read before the apply (it is new, or its
 * version moved); a delete once its record is gone. choudoufu 0.24.0 writes
 * the record of a resource it keeps one for the moment that resource's apply
 * returns. A resource it keeps no record for is done when its root's apply
 * returns.
 *
 * A resource not done is in flight when its root is applying and every
 * resource of the plan it depends on (its references and `depends_on`, from
 * the plan's configuration) is done, and waiting otherwise. Once a root's
 * apply failed, what it did not finish is `not-applied`.
 */
import type { RecordStore, Records } from "./cdf-records";

export type ProgressStatus = "done" | "in-flight" | "waiting" | "not-applied";

export interface ProgressResource {
  root: string;
  address: string;
  /** What the plan does to it: create, update, replace, delete or forget. */
  action: string;
  status: ProgressStatus;
  /** When a read first found it done. */
  done_at?: string;
}

/** The wave's progress at one read. */
export interface WaveProgress {
  /** When the records were last read. */
  read: string;
  resources: ProgressResource[];
}

/** How many resources stand at each status. */
export function progressCounts(p: Pick<WaveProgress, "resources">): Record<ProgressStatus, number> {
  const out: Record<ProgressStatus, number> = { done: 0, "in-flight": 0, waiting: 0, "not-applied": 0 };
  for (const r of p.resources) out[r.status]++;
  return out;
}

/** One line for a log: "1 of 2 done, 1 in flight, 0 waiting". */
export function progressLine(p: Pick<WaveProgress, "resources">): string {
  const c = progressCounts(p);
  return `${c.done} of ${p.resources.length} done, ${c["in-flight"]} in flight, ${c.waiting} waiting${c["not-applied"] ? `, ${c["not-applied"]} not applied` : ""}`;
}

/** A change the apply makes, and the configuration addresses of the changes it waits on. */
export interface PlannedChange {
  address: string;
  action: string;
  /** Its configuration address: the address without instance keys. */
  config: string;
  /** The configuration addresses (of resources, or of whole modules ending in `.`) it depends on. */
  after: string[];
}

/** An instance address without its instance keys: `module.a["x"].aws_s3_bucket.b[0]` is `module.a.aws_s3_bucket.b`. */
export const configAddress = (address: string): string => address.replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]]*)\]/g, "");

function actionOf(actions: string[]): string | undefined {
  if (actions.includes("delete") && actions.includes("create")) return "replace";
  return ["create", "update", "delete", "forget"].find((a) => actions.includes(a));
}

/** Every `references` string under an expression tree. */
function references(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) references(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "references" && Array.isArray(x)) out.push(...x.filter((r): r is string => typeof r === "string"));
      else references(x, out);
    }
  }
  return out;
}

/** Each configured resource's dependencies, from `show -json`'s `configuration`, keyed by its configuration address. */
export function configDependencies(plan: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (mod: Record<string, any> | undefined, prefix: string): void => {
    if (!mod || typeof mod !== "object") return;
    const resources: Record<string, any>[] = Array.isArray(mod.resources) ? mod.resources : [];
    const own = resources.map((r) => (typeof r?.address === "string" ? (r.address as string) : "")).filter(Boolean);
    const resolve = (ref: string): string | undefined => {
      const m = /^module\.([^.[]+)/.exec(ref);
      if (m) return `${prefix}module.${m[1]}.`;
      const hit = own.find((a) => ref === a || ref.startsWith(`${a}.`) || ref.startsWith(`${a}[`));
      return hit ? `${prefix}${hit}` : undefined;
    };
    for (const r of resources) {
      if (typeof r?.address !== "string" || r.mode === "data") continue;
      const refs = [...references(r.expressions), ...references(r.count_expression), ...references(r.for_each_expression), ...(Array.isArray(r.depends_on) ? r.depends_on : [])];
      const deps = [...new Set(refs.map(resolve).filter((d): d is string => d !== undefined && d !== `${prefix}${r.address}`))].sort();
      out.set(`${prefix}${r.address}`, deps);
    }
    for (const [name, call] of Object.entries((mod.module_calls ?? {}) as Record<string, any>)) visit(call?.module, `${prefix}module.${name}.`);
  };
  visit((plan as { configuration?: { root_module?: Record<string, any> } } | undefined)?.configuration?.root_module, "");
  return out;
}

/** The changes a plan's apply makes to managed resources, each with what it waits on. */
export function plannedChanges(plan: unknown): PlannedChange[] {
  const deps = configDependencies(plan);
  const out: PlannedChange[] = [];
  for (const c of ((plan as { resource_changes?: unknown[] } | undefined)?.resource_changes ?? []) as Record<string, any>[]) {
    if (c?.mode === "data" || typeof c?.address !== "string") continue;
    const action = actionOf(Array.isArray(c.change?.actions) ? c.change.actions : []);
    if (!action) continue;
    const config = configAddress(c.address);
    // A delete runs in reverse order and its configuration is gone: it waits on nothing the plan's configuration says.
    out.push({ address: c.address, action, config, after: action === "delete" || action === "forget" ? [] : (deps.get(config) ?? []) });
  }
  return out.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** Where a root stands in the wave's apply. */
export type RootPhase = "pending" | "applying" | "applied" | "failed";

/** Whether the records show a change done: a create, update or replace's record is new or moved, a delete's is gone. */
export function recordedDone(change: Pick<PlannedChange, "address" | "action">, before: Records | undefined, now: Records | undefined): boolean {
  if (!before || !now) return false;
  if (change.action === "delete" || change.action === "forget") return before.has(change.address) && !now.has(change.address);
  const v = now.get(change.address);
  return v !== undefined && v !== before.get(change.address);
}

/** One root's resources at one read. `doneAt` keeps when each was first found done, and is updated. */
export function rootProgress(root: string, changes: readonly PlannedChange[], phase: RootPhase, before: Records | undefined, now: Records | undefined, doneAt: Map<string, string>, at: string): ProgressResource[] {
  const done = new Set<string>();
  for (const c of changes) {
    if (doneAt.has(c.address) || recordedDone(c, before, now) || phase === "applied") {
      done.add(c.address);
      if (!doneAt.has(c.address)) doneAt.set(c.address, at);
    }
  }
  const pendingConfig = (dep: string): boolean =>
    changes.some((c) => !done.has(c.address) && (dep.endsWith(".") ? c.config.startsWith(dep) : c.config === dep));
  return changes.map((c) => {
    const status: ProgressStatus = done.has(c.address)
      ? "done"
      : phase === "failed"
        ? "not-applied"
        : phase === "applying" && !c.after.some(pendingConfig)
          ? "in-flight"
          : "waiting";
    return { root, address: c.address, action: c.action, status, ...(status === "done" ? { done_at: doneAt.get(c.address)! } : {}) };
  });
}

/** One root the watch follows. */
export interface WatchedRoot {
  root: string;
  plan: unknown;
  /** Its estate's record store, when it has one this can read. */
  store?: RecordStore;
  /** The environment its apply runs with, which reads the store. */
  env: NodeJS.ProcessEnv;
}

export interface ProgressOptions {
  /** Read the records this often. */
  intervalMs: number;
  read: (store: RecordStore, env: NodeJS.ProcessEnv) => Promise<Records>;
  /** Called with the progress whenever a read changes it. Never throws into the watch. */
  changed: (p: WaveProgress) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
}

/** The interval from `TG_PROGRESS_SECONDS`: 5 seconds unless it names a whole number of 1 or more. */
export function progressInterval(env: NodeJS.ProcessEnv): number {
  const n = Number(env.TG_PROGRESS_SECONDS);
  return (Number.isInteger(n) && n >= 1 ? n : 5) * 1000;
}

/**
 * Follow a wave's applies: `start` reads every store once before the first
 * apply, `phase` notes a root starting and ending, and `stop` reads a last
 * time once the applies are over. A store that cannot be read is logged once;
 * its resources are done when their root's apply returns.
 */
export class ApplyProgress {
  private readonly changes: Map<string, PlannedChange[]>;
  private readonly phases = new Map<string, RootPhase>();
  private readonly before = new Map<string, Records>();
  private readonly current = new Map<string, Records>();
  private readonly doneAt = new Map<string, Map<string, string>>();
  private readonly unread = new Set<string>();
  private last = "";
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private reading: Promise<void> = Promise.resolve();
  latest?: WaveProgress;

  constructor(private readonly roots: readonly WatchedRoot[], private readonly o: ProgressOptions) {
    this.changes = new Map(roots.map((r) => [r.root, plannedChanges(r.plan)]));
    for (const r of roots) {
      this.phases.set(r.root, "pending");
      this.doneAt.set(r.root, new Map());
    }
  }

  /** How many resources the wave changes. */
  get total(): number {
    return [...this.changes.values()].reduce((n, c) => n + c.length, 0);
  }

  private async records(r: WatchedRoot): Promise<Records | undefined> {
    if (!r.store || this.unread.has(r.root)) return undefined;
    try {
      return await this.o.read(r.store, r.env);
    } catch (e) {
      this.unread.add(r.root);
      this.o.log?.(`${r.root}: its records could not be read (${(e as Error).message}); its resources show done when its apply returns`);
      return undefined;
    }
  }

  /** Read every store once, before any apply starts, and keep what it holds as each root's starting point. */
  async start(): Promise<void> {
    await Promise.all(
      this.roots.map(async (r) => {
        const got = await this.records(r);
        if (got) this.before.set(r.root, got);
      }),
    );
    await this.tick(false);
    this.every();
  }

  private every(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.reading = this.reading.then(() => this.tick(true)).finally(() => this.every());
    }, this.o.intervalMs);
    this.timer.unref?.();
  }

  /** A root's apply started or ended: an ended root's records are read a last time, and the progress is written again at once. */
  phase(root: string, phase: RootPhase): Promise<void> {
    const r = this.roots.find((x) => x.root === root);
    this.reading = this.reading.then(async () => {
      if (r && (phase === "applied" || phase === "failed")) {
        const got = await this.records(r);
        if (got) this.current.set(root, got);
      }
      this.phases.set(root, phase);
      await this.tick(false);
    });
    return this.reading;
  }

  /** Read the applying roots' records, and report the progress when it moved. */
  private async tick(read: boolean): Promise<void> {
    const at = (this.o.now?.() ?? new Date()).toISOString();
    const resources: ProgressResource[] = [];
    for (const r of this.roots) {
      const phase = this.phases.get(r.root)!;
      // Only an applying root's records move; a root not started, or ended and read once more, is read no more.
      if (read && phase === "applying") {
        const got = await this.records(r);
        if (got) this.current.set(r.root, got);
      }
      resources.push(...rootProgress(r.root, this.changes.get(r.root)!, phase, this.before.get(r.root), this.current.get(r.root), this.doneAt.get(r.root)!, at));
    }
    const progress: WaveProgress = { read: at, resources };
    this.latest = progress;
    const key = JSON.stringify(resources.map((x) => [x.root, x.address, x.status]));
    if (key === this.last) return;
    this.last = key;
    try {
      await this.o.changed(progress);
    } catch (e) {
      this.o.log?.(`the progress was not written: ${(e as Error).message}`);
    }
  }

  /** Stop reading on a timer. The progress as it ended. */
  async stop(): Promise<WaveProgress | undefined> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.reading;
    await this.tick(false);
    return this.latest;
  }
}
