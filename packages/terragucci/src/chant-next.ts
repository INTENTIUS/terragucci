/**
 * The Terraform lexicon subpaths chant 0.124.52 and earlier lack
 * (terragucci#1278): the composed run (`compose`, `compose/run`,
 * `compose/root`, `compose/estate`, `compose/slice`), the lock code
 * (`state`) and the plan shape (`plan-shape`). chant 0.124.54, the pinned
 * release, carries all of them; the loaders stay so terragucci still builds
 * and runs on a chant without them.
 *
 * Each is imported on first use and is undefined when the installed chant
 * lacks it. The callers fall back: `waves.compose` applies in waves
 * (./compose.ts), migrate takes its locks with its own loop (./migrate.ts),
 * and a covered round holds the wave for an approval of its own
 * (./covered-wave.ts). A chant that carries them, as 0.124.54 does, turns
 * the full behaviour on with no change here.
 *
 * The types below are the part of chant's contract terragucci calls, written
 * out so the code compiles against a chant without them. Each `import()`
 * carries a `@ts-ignore` for the same reason; scripts/cli-bundle.mjs stands
 * in a module that throws for a subpath the installed chant lacks, so the
 * bundle builds either way.
 */
import type { DriverComponent } from "@intentius/chant/components";
import type { TerraformConfig } from "@intentius/chant-lexicon-terraform/config";
import type { HookMoment } from "./hooks";

// ── compose ────────────────────────────────────────────────────────────────

/** Why a member, or the whole change, applies in waves: chant's kinds. */
export type ChantFallbackKind =
  | "off"
  | "too-many-roots"
  | "one-root"
  | "binary"
  | "identity"
  | "workspace"
  | "backend"
  | "provider-lock"
  | "cli-args"
  | "read"
  | "order-only"
  | "import"
  | "path"
  | "plan-failed"
  | "targets"
  | "steps"
  | "same-root"
  | "split";

export interface ChantFallback {
  kind: ChantFallbackKind;
  member?: string;
  reason: string;
}

export type ChantComposedRead =
  | { via: "vars"; upstream: string; variable: string; output: string }
  | { via: "remote-state" | "estate-outputs"; upstream: string; name: string };

/** chant's `Composition`. */
export interface ChantComposition {
  candidates: string[];
  members: string[];
  order: string[];
  max: number;
  roots: Map<string, string>;
  dirs: Map<string, string>;
  binary?: string;
  modules: Map<string, string>;
  reads: Map<string, ChantComposedRead[]>;
  estate?: boolean;
  fallbacks: ChantFallback[];
  fallback?: ChantFallback;
}

export interface ChantCompositionInput {
  projectRoot: string;
  terraform: TerraformConfig;
  components: readonly DriverComponent[];
  selected?: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
  identity?: (member: string) => string | undefined;
  binary?: (member: string) => { name: string; version?: string };
}

export interface ChantCompose {
  compositionFor(input: ChantCompositionInput): ChantComposition;
  moduleNames(roots: readonly string[]): Map<string, string>;
  readOrder(set: readonly string[], deps: ReadonlyMap<string, ReadonlySet<string>>): string[];
}

// ── compose/run, compose/estate, compose/slice, compose/root ───────────────

export interface ChantMemberRead {
  upstream: string;
  via: ChantComposedRead["via"];
  name: string;
  outputs?: string[];
  unknown: string[];
}

export interface ChantRunPlan {
  members: Record<string, { slice: unknown; reads: ChantMemberRead[] } | undefined>;
  digest: string;
  fallback?: ChantFallback;
  error?: string;
  member?: string;
  plan?: unknown;
  planFile: string;
  text: string;
  texts: Record<string, string>;
  generated: [string, string][];
  counts: { changes: number; destroys: number };
  summary: string;
  /** A state run's: the members that read a value unknown at plan time. */
  unknownReads?: string[];
}

export type ChantMemberApply = "applied" | "partial" | "failed" | "not-started" | "no-changes";

export interface ChantRunApply {
  ok: boolean;
  members: Record<string, { status: ChantMemberApply; planned: number; done: number; error?: string } | undefined>;
  error?: string;
  /** An estate run's: the post-apply plan. */
  after?: unknown;
}

/** A state run's apply: what it wrote of each member's state. */
export interface ChantStateRunApply extends ChantRunApply {
  members: Record<string, { status: ChantMemberApply; planned: number; done: number; error?: string; state: "written" | "unchanged" | "not-written"; kept?: string; lockHeld?: true } | undefined>;
  settled: string[];
  shown: Record<string, unknown>;
}

export interface ChantRunner {
  plan(): Promise<ChantRunPlan>;
  apply(): Promise<ChantRunApply>;
  release(): Promise<void>;
}

/** What a binary run returns: its exit code and its output. */
export type ChantBinaryExec = (binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; out: string }>;

export interface ChantComposedRunOptions {
  projectRoot: string;
  composition: ChantComposition;
  terraform: TerraformConfig;
  binary: { path: string; name?: string };
  env: NodeJS.ProcessEnv;
  work: string;
  lock: boolean;
  runId?: string;
  exec?: ChantBinaryExec;
  retryDelays?: number[];
  initTurn?: <T>(fn: () => Promise<T>) => Promise<T>;
  hook?: (member: string, moment: HookMoment, planFile?: string) => Promise<string | undefined | void>;
  reportDir?: string;
  log?: (line: string) => void;
}

export interface ChantEstateRunOptions {
  projectRoot: string;
  composition: ChantComposition;
  terraform: TerraformConfig;
  env: NodeJS.ProcessEnv;
  binary?: string;
  work?: string;
  exec?: ChantBinaryExec;
  log?: (line: string) => void;
}

export interface ChantComposedRoot {
  dir: string;
  rewritten: string[];
  generated: [string, string][];
  outputs: Map<string, Map<string, boolean>>;
  restore: () => void;
}

/** The composed run's classes and helpers, from four subpaths: all of them or none. */
export interface ChantComposeRun {
  ComposedRun: new (o: ChantComposedRunOptions) => ChantRunner;
  EstateRun: new (o: ChantEstateRunOptions) => ChantRunner;
  writeEstateRoot(input: { projectRoot: string; composition: ChantComposition }): ChantComposedRoot;
  moduleValues(values: unknown, m: string, outputs: Record<string, unknown>): Record<string, unknown> | undefined;
}

// ── state ──────────────────────────────────────────────────────────────────

export interface LockOperation {
  operation: string;
  info: string;
}

export interface ChantLockHolder {
  id: string;
  who?: string;
  operation?: string;
  info?: string;
  created?: string;
}

export interface ChantSourceLock {
  root: string;
  location: string;
  lock(reason: string): Promise<() => Promise<void>>;
}

/** The part of a state store chant's lock code calls. */
export interface ChantLockStore {
  location: string;
  lockLocation: string;
  heldLock(): Promise<{ id: string; info: string } | undefined>;
  lock(info: string): Promise<boolean>;
  unlock(): Promise<void>;
}

export interface ChantState {
  takeLocksWithSources<S extends ChantLockStore>(input: {
    sources: readonly ChantSourceLock[];
    stores: readonly { root: string; store: S }[];
    now: string;
    op: LockOperation;
    sourceOp?: LockOperation;
    who?: string;
  }): Promise<{ sources: { root: string; location: string; release: () => Promise<void> }[]; locks: { root: string; store: S; release: () => Promise<void> }[] }>;
  SourceLockedError: abstract new (...args: never[]) => Error & { root: string; location: string; reason: string };
  StateLockedError: abstract new (...args: never[]) => Error & { root: string; lockLocation: string; holder?: ChantLockHolder };
}

// ── plan-shape ─────────────────────────────────────────────────────────────

export interface ChantPlanShape {
  // The shape is core's `PlanShape`; terragucci hands it to `coveredRound` as it is.
  terraformPlanShape(planJson: unknown, member: string, options?: { unknownInputs?: string[] }): unknown;
}

// ── loading ────────────────────────────────────────────────────────────────

/**
 * The imports below take turns. The subpaths share a module graph with import cycles in it, and vitest's module
 * runner never settles two concurrent imports into such a graph: with them in parallel the suite hung on a chant
 * that has them, though plain node and the bundle are fine either way.
 */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(load: () => Promise<T>): Promise<T> {
  const next = turn.then(load);
  turn = next.catch(() => undefined);
  return next;
}

/** A module once: its promise, kept, resolving undefined when the import fails. */
function once<T>(load: () => Promise<unknown>, pick: (m: Record<string, unknown>) => T | undefined): () => Promise<T | undefined> {
  let p: Promise<T | undefined> | undefined;
  return () =>
    (p ??= inTurn(load).then(
      (m) => pick(m as Record<string, unknown>),
      () => undefined,
    ));
}

const has = (m: Record<string, unknown>, ...names: string[]): boolean => names.every((n) => typeof m[n] === "function");

const loaders = {
  compose: once<ChantCompose>(
    // @ts-ignore chant 0.124.52 has no compose subpath (terragucci#1278)
    () => import("@intentius/chant-lexicon-terraform/compose"),
    (m) => (has(m, "compositionFor", "moduleNames", "readOrder") ? (m as unknown as ChantCompose) : undefined),
  ),
  composeRun: once<ChantComposeRun>(
    // One subpath at a time, for the reason inTurn gives.
    async () => {
      // @ts-ignore chant 0.124.52 has no compose/run subpath (terragucci#1278)
      const run: object = await import("@intentius/chant-lexicon-terraform/compose/run");
      // @ts-ignore chant 0.124.52 has no compose/estate subpath (terragucci#1278)
      const estate: object = await import("@intentius/chant-lexicon-terraform/compose/estate");
      // @ts-ignore chant 0.124.52 has no compose/root subpath (terragucci#1278)
      const root: object = await import("@intentius/chant-lexicon-terraform/compose/root");
      // @ts-ignore chant 0.124.52 has no compose/slice subpath (terragucci#1278)
      const slice: object = await import("@intentius/chant-lexicon-terraform/compose/slice");
      return { ...slice, ...root, ...estate, ...run };
    },
    (m) => (has(m, "ComposedRun", "EstateRun", "writeEstateRoot", "moduleValues") ? (m as unknown as ChantComposeRun) : undefined),
  ),
  state: once<ChantState>(
    // @ts-ignore chant 0.124.52 has no state subpath (terragucci#1278)
    () => import("@intentius/chant-lexicon-terraform/state"),
    (m) => (has(m, "takeLocksWithSources", "SourceLockedError", "StateLockedError") ? (m as unknown as ChantState) : undefined),
  ),
  planShape: once<ChantPlanShape>(
    // @ts-ignore chant 0.124.52 has no plan-shape subpath (terragucci#1278)
    () => import("@intentius/chant-lexicon-terraform/plan-shape"),
    (m) => (has(m, "terraformPlanShape") ? (m as unknown as ChantPlanShape) : undefined),
  ),
};

export type ChantNextPart = keyof typeof loaders;

/** Set by a test: what each part loads to, in place of the import. `null` makes it missing. */
const overrides = new Map<ChantNextPart, unknown>();

async function load<K extends ChantNextPart>(part: K): Promise<Awaited<ReturnType<(typeof loaders)[K]>>> {
  if (overrides.has(part)) return (overrides.get(part) ?? undefined) as Awaited<ReturnType<(typeof loaders)[K]>>;
  return (await loaders[part]()) as Awaited<ReturnType<(typeof loaders)[K]>>;
}

/** chant's composition (`/compose`), or undefined when the installed chant has none. */
export const chantCompose = (): Promise<ChantCompose | undefined> => load("compose");
/** chant's composed and estate runs (`/compose/run`, `/compose/estate`, `/compose/root`, `/compose/slice`), or undefined. */
export const chantComposeRun = (): Promise<ChantComposeRun | undefined> => load("composeRun");
/** chant's lock code (`/state`), or undefined. */
export const chantState = (): Promise<ChantState | undefined> => load("state");
/** chant's plan shape (`/plan-shape`), or undefined. */
export const chantPlanShape = (): Promise<ChantPlanShape | undefined> => load("planShape");

/**
 * For tests: make a part missing (`null`), or stand a module in for it.
 * Returns the function that puts the import back.
 */
export function overrideChantNext(part: ChantNextPart, module: unknown | null): () => void {
  overrides.set(part, module);
  return () => {
    overrides.delete(part);
  };
}

/** What the installed chant carries of the composed run, its locks and its plan shape. */
export async function chantNextParts(): Promise<Record<ChantNextPart, boolean>> {
  const [compose, composeRun, state, planShape] = await Promise.all([chantCompose(), chantComposeRun(), chantState(), chantPlanShape()]);
  return { compose: !!compose, composeRun: !!composeRun, state: !!state, planShape: !!planShape };
}
