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
 * The module registry protocol (`registry`, chant#4565) is newer than the
 * pin: until a chant release carries it, ./publish/registry.ts keeps its own
 * reader and writer as the fallback.
 *
 * Newer than the pin too (chant#4554, terragucci#1282): chant core's object
 * store clients (`@intentius/chant/object-store`), which ./report/bucket.ts
 * and ./backend.ts's version list use when the installed chant has them, and
 * the forge reads and handover parameters on modules the pin already has
 * (`pr-forge`, `ci-handover`). Those two are told apart by what the
 * installed functions do, not by an import: ./forge.ts, ./comment-apply.ts,
 * ./comment-apply-gitlab.ts, ./forge-post.ts and ./handover.ts keep their
 * own code as the fallback.
 *
 * The types below are the part of chant's contract terragucci calls, written
 * out so the code compiles against a chant without them. Each `import()`
 * carries a `@ts-ignore` for the same reason; scripts/cli-bundle.mjs stands
 * in a module that throws for a subpath the installed chant lacks, so the
 * bundle builds either way.
 */
import { checkoutScript as chantCheckoutScript, handoverTrap as chantHandoverTrap, packJs as chantPackJs, type HandoverForge } from "@intentius/chant/ci-handover";
import type { DriverComponent } from "@intentius/chant/components";
import type { PrForge } from "@intentius/chant/pr-forge";
import type { TerraformConfig } from "@intentius/chant-lexicon-terraform/config";
import type { HookMoment } from "./hooks";
import type { AzureBlobClient, AzureTarget } from "./report/azure-blob";
import type { GcsClient, GcsTarget } from "./report/gcs";
import { adoptChantStoreErrors, type ObjectStore, type StoreFetch } from "./report/object-store";
import type { S3Client, S3Target } from "./report/s3";

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

// ── registry ───────────────────────────────────────────────────────────────

/** A store the registry writer puts files to: terragucci's RegistryStore fits it. */
export interface ChantRegistryStore {
  put(key: string, body: string | Buffer, contentType?: string, when?: { ifMatch: string } | { ifNoneMatch: "*" }): Promise<unknown>;
  read(key: string): Promise<{ body?: string; etag?: string }>;
}

type ChantRegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The module registry protocol chant#4565 moved into the lexicon
 * (`/registry`): the writer, with the download answer that carries
 * X-Terraform-Get (terragucci#1287), and the reader.
 */
export interface ChantRegistry {
  writeVersion(
    store: ChantRegistryStore,
    addr: { namespace: string; name: string; system: string; source: string; path: string },
    version: { major: number; minor: number; patch: number },
    files: { tarball?: { key: string; body: Buffer }; download: { key: string; body: string }; meta: { key: string; body: string } },
    options?: { prefix?: string; isConflict?: (e: unknown) => boolean },
  ): Promise<void>;
  registryVersions(source: string, options?: { fetch?: ChantRegistryFetch }): Promise<string[]>;
  registryLocation(source: string, version: string, options?: { fetch?: ChantRegistryFetch; reads?: "terraform" | "tofu" | "either" }): Promise<string>;
  fetchTarball(location: string, options?: { fetch?: ChantRegistryFetch }): Promise<Buffer>;
  downloadDoc(location: string): string;
  downloadAnswer(location: string): { status: 200; headers: Record<string, string>; body: string };
  registryHandler(files: (key: string) => Promise<{ body?: string | Uint8Array }>, options?: { prefix?: string; log?: (line: string) => void }): (request: Request) => Promise<Response>;
  /**
   * The `_headers` file Cloudflare Pages and Netlify read (chant#4566), one
   * X-Terraform-Get rule per download path, merged into the file there. Newer
   * than chant#4565's `/registry`, so a caller checks it is there.
   */
  headersFile?(rules: { path: string; location: string }[], existing?: string): string;
  /** The rules Cloudflare Pages reads from `_headers` (chant#4566). */
  PAGES_HEADER_RULES?: number;
}

// ── object-store ───────────────────────────────────────────────────────────

/**
 * chant core's object store clients (`@intentius/chant/object-store`,
 * chant#4554), lifted from ./report/s3.ts, gcs.ts, azure-blob.ts and
 * bucket.ts. The targets are the same shape as terragucci's, and so are the
 * clients' methods; the product words are parameters.
 */
export interface ChantObjectStore {
  storeFromEnv(
    where: { bucket: string; endpoint?: string; role?: string; sessionName?: string; setting?: string; roleSetting?: string },
    env?: NodeJS.ProcessEnv,
    fetchFn?: StoreFetch,
  ): ObjectStore;
  S3Client: new (target: S3Target, fetchFn?: StoreFetch) => Pick<S3Client, keyof S3Client>;
  GcsClient: new (target: GcsTarget, fetchFn?: StoreFetch) => Pick<GcsClient, keyof GcsClient>;
  AzureBlobClient: new (target: AzureTarget, fetchFn?: StoreFetch) => Pick<AzureBlobClient, keyof AzureBlobClient>;
  StoreError: abstract new (...args: never[]) => Error;
  StoreConflict: abstract new (...args: never[]) => Error;
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
  registry: once<ChantRegistry>(
    // @ts-ignore chant 0.124.54 has no registry subpath (chant#4565)
    () => import("@intentius/chant-lexicon-terraform/registry"),
    (m) => (has(m, "writeVersion", "registryVersions", "registryLocation", "fetchTarball", "downloadAnswer", "registryHandler") ? (m as unknown as ChantRegistry) : undefined),
  ),
  objectStore: once<ChantObjectStore>(
    // @ts-ignore chant 0.124.54 has no object-store subpath (chant#4554)
    () => import("@intentius/chant/object-store"),
    (m) => {
      if (!has(m, "storeFromEnv", "S3Client", "GcsClient", "AzureBlobClient", "StoreError", "StoreConflict")) return undefined;
      const store = m as unknown as ChantObjectStore;
      // A chant client throws chant's errors: terragucci's StoreError and StoreConflict take them as their own.
      adoptChantStoreErrors(store.StoreError, store.StoreConflict);
      return store;
    },
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
/** chant's module registry protocol (`/registry`, chant#4565), or undefined. */
export const chantRegistry = (): Promise<ChantRegistry | undefined> => load("registry");
/** chant core's object store clients (`@intentius/chant/object-store`, chant#4554), or undefined. */
export const chantObjectStore = (): Promise<ChantObjectStore | undefined> => load("objectStore");

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
  const [compose, composeRun, state, planShape, registry, objectStore] = await Promise.all([chantCompose(), chantComposeRun(), chantState(), chantPlanShape(), chantRegistry(), chantObjectStore()]);
  return { compose: !!compose, composeRun: !!composeRun, state: !!state, planShape: !!planShape, registry: !!registry, objectStore: !!objectStore };
}

// ── forge reads (chant#4554) ───────────────────────────────────────────────

/** A commit status as chant's forge reads it back: each context's newest, with the forge's own state word. */
export interface ChantReadCommitStatus {
  context: string;
  state: string;
  description?: string;
  targetUrl?: string;
  allowFailure?: boolean;
}

/** The reads chant#4554 added to chant's forge clients, where the installed chant's client has them. */
export interface ChantForgeReads {
  defaultBranch?: () => Promise<string>;
  commitStatuses?: (sha: string) => Promise<ChantReadCommitStatus[]>;
}

/** `forge`'s default-branch and status reads, each undefined when the installed chant's client lacks it. */
export function chantForgeReads(forge: PrForge): ChantForgeReads {
  const f = forge as PrForge & { defaultBranch?: unknown; commitStatuses?: unknown };
  return {
    ...(typeof f.defaultBranch === "function" ? { defaultBranch: () => (f.defaultBranch as () => Promise<string>).call(forge) } : {}),
    ...(typeof f.commitStatuses === "function" ? { commitStatuses: (sha: string) => (f.commitStatuses as (sha: string) => Promise<ChantReadCommitStatus[]>).call(forge, sha) } : {}),
  };
}

// ── handover parameters (chant#4554) ───────────────────────────────────────

/** chant's handover scripts with a product's parameters (chant#4554). */
export interface ChantHandover {
  packJs(forge: HandoverForge, opts: { noteFiles?: readonly string[]; label?: string }): string;
  handoverTrap(dir: string, forge: HandoverForge, opts: { noteFiles?: readonly string[]; label?: string; before?: string }): string[];
  checkoutScript(history: boolean, ledger: boolean, opts: { tokenEnv?: string; refEnv?: string; headName?: string }): string;
}

let handover: ChantHandover | null | undefined;

/**
 * chant's parameterised handover scripts, or undefined when the installed
 * chant's take no parameters. The pin's functions take fewer arguments and
 * ignore the rest, so each is asked once with a parameter and kept only when
 * its script carries it.
 */
export function chantHandover(): ChantHandover | undefined {
  if (handover === undefined) {
    const h = { packJs: chantPackJs, handoverTrap: chantHandoverTrap, checkoutScript: chantCheckoutScript } as unknown as ChantHandover;
    try {
      const ok =
        h.packJs("github", { label: "tgprobe", noteFiles: ["tgprobe.json"] }).includes("tgprobe.json") &&
        h.handoverTrap("tgprobe", "github", { label: "tgprobe", before: "tgprobe_before" }).some((l) => l.includes("tgprobe_before")) &&
        h.checkoutScript(false, false, { tokenEnv: "TGPROBE_TOKEN", refEnv: "TGPROBE_REF", headName: "tgprobe-head" }).includes("TGPROBE_REF");
      handover = ok ? h : null;
    } catch {
      handover = null;
    }
  }
  return handover ?? undefined;
}
