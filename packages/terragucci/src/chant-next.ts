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
 * Imported directly since terragucci#1304, on the 0.124.55 pin: the module
 * registry protocol and its mirror code (`registry`, chant#4565, #4564;
 * ./publish/registry.ts, ./image-recipe.ts, ./publish/provider-mirror.ts),
 * the lexicon's module targets on it (chant#4603-#4605; ./publish/hosted.ts),
 * chant core's Terraform token reader (`terraform/credentials`, chant#4563;
 * ./state-source.ts), the product words and pipeline (`ci-product-words`,
 * `ci-product`, chant#4550; ./ci-words.ts, ./comment.ts, ./render.ts,
 * ./report/marker.ts), the pull request environment ledger
 * (`components/pr-env-ledger`, chant#4551; ./ephemeral.ts), and the forge
 * reads and handover parameters (`pr-forge`, `ci-handover`, chant#4554;
 * ./forge.ts, ./handover.ts).
 *
 * Newer than the pin too (chant#4554, terragucci#1282): chant core's object
 * store clients (`@intentius/chant/object-store`), which ./report/bucket.ts
 * and ./backend.ts's version list use when the installed chant has them.
 *
 * Newer than the pin too (chant#4556, terragucci#1284): the check moment,
 * `ci.hooks.check`, from `@intentius/chant/components/check-hooks`: the
 * writer `init` adds the pre-commit preset's hook with, and the runner the
 * check job calls. Without it init writes no hook, and `terragucci
 * check-hooks` runs the preset's hook itself (./pre-commit.ts).
 *
 * Newer than the pin too (terragucci#1285): chant core's shared bucket check
 * (`@intentius/chant/bucket-check`, chant#4558), which `init` runs on the
 * record store choudoufu derives for a live root, and the terraform
 * lexicon's TF046 (`lint/post-synth/tf046`, chant#4561), the local record
 * store in CI, which ./tips/index.ts turns on. Without the first, init prints
 * the store and checks no bucket; without the second, the tip is left out.
 *
 * Newer than the pin too (chant#4568, terragucci#1282): the control repo in
 * chant core, `@intentius/chant/ci-control`, and each forge lexicon's
 * `components/control-pipeline`. With them the member's dispatch, the control
 * repo's pipeline, its entries on the ledger and reconcile are chant's
 * (./control-repo.ts, ./control-records.ts, ./reconcile.ts). Without them
 * terragucci's own code runs, with its record files.
 *
 * Newer than the pin too (terragucci#1282 part e): the
 * op-wave step contract (`op/op-waves-capability`, chant#4545) with the
 * terraform lexicon's `terraform-apply` capability passed in process. The
 * object store's setting hints (chant#4584) are told apart by what the
 * installed module exports, on a subpath the pin already has.
 *
 * Imported directly since the pin moved to chant 0.124.55, which carries
 * them (terragucci#1304): chant's exit-code table (`exit-codes`, chant#4553;
 * ./apply.ts, ./cli.ts), the terraform lexicon's drift rows (`drift-rows`,
 * chant#4580; ./report/drift.ts), chant's OTLP exporter (`otlp`, chant#4555;
 * ./telemetry.ts) and the review agent's quoting with a tag list (chant#4580;
 * ./review-agent.ts).
 *
 * Newer than the pin too (chant#4560, terragucci#1286): the terraform
 * lexicon's known-module catalog (`module-catalog`), the static tier of
 * choudoufu's module compatibility table. ./report/estate.ts puts its answer
 * beside each module version on the estate page and ./tips/index.ts words a
 * tip from it for a choudoufu project. Without it the column and the tip are
 * left out.
 *
 * The release catalog and the registry catalog parts are imported directly in
 * ./chant-catalog.ts (terragucci#1304 P6); the types for them stay below.
 *
 * Newer than the pin too (terragucci#1302): the registry proxies (chant#4606)
 * on the lexicon's `registry` subpath, which `sources.proxies` matches and
 * `require` reads through; without them a source through a proxy is matched
 * as written.
 * Newer than the pin too (terragucci#1282 part f): chant core's forge and
 * trust-policy check (`forge-check`, chant#4608), which `terragucci forge
 * check` calls (./forge-check.ts); its notify relay (`notify-relay`,
 * chant#4611), whose signature checks and principal mapping ./relay.ts
 * uses; its ledger estate (`ci-estate`, chant#4612), which ./estate.ts
 * builds on once the ledger holds wave run records; its shared policy source
 * (`policy-source`, chant#4613), which fetches `policy.source`
 * (./report/policy.ts); and the op-wave stand-down on `op` (chant#4581),
 * told apart by its exports, which ./apply.ts and the step spec use.
 *
 * Imported directly since the pin moved to chant 0.124.56, which carries
 * them (terragucci#1304): chant core's apply-job guard (`ci-job-guard`,
 * chant#4624; ./check-job.ts), its audit log reader and known-writes table
 * (`ci-audit`, chant#4632; ./respond/attribute.ts, ./state-writers.ts), and
 * the op entry's after-plan hook with `opWavePlanPath` (chant#4614; the step
 * wave in ./apply.ts).
 *
 * Newer than the pin too (chant#3924): the terraform lexicon's reading of the
 * sources a root uses (`usedSources`, `lockedProviders`) and their forms
 * (`moduleSourceForms`, `providerAddressForms`), on its `registry` subpath.
 * ./sources.ts keeps only the lists and the refusals with them, and its own
 * reader and forms as the fallback.
 *
 * The types below are the part of chant's contract terragucci calls, written
 * out so the code compiles against a chant without them. A `@ts-ignore` marks an
 * `import()` of a subpath the pin lacks; scripts/cli-bundle.mjs stands
 * in a module that throws for a subpath the installed chant lacks, so the
 * bundle builds either way.
 */
import type { DriverComponent } from "@intentius/chant/components";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
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

// ── check hooks ────────────────────────────────────────────────────────────

/** A `ci.hooks.check` hook: chant's `OpWaveHook`, with no `{plan}` and `onFailure` only `fail`. */
export interface ChantCheckHook {
  name?: string;
  command: string[];
  onFailure?: "fail";
  perRun?: boolean;
  targets?: string[];
}

/** What chant's check hooks came to (`CheckHooksReport`). */
export interface ChantCheckHooksReport {
  version: 1;
  moment: "check";
  base: string;
  targets: string[];
  status: "passed" | "failed" | "none";
  hooks: { name: string; target?: string; exit: number; outcome: "passed" | "failed" | "skipped"; reason?: string }[];
  failed?: string;
  note?: string;
}

/**
 * chant's check moment (`/components/check-hooks`, chant#4556): the hooks
 * read from the workspace declaration at base, run without forge tokens or
 * cloud credentials, and the writer a product's init adds a hook with.
 */
export interface ChantCheckHooks {
  runCheckHooks(options: {
    base: string;
    targets?: readonly string[];
    cwd?: string;
    dir?: string;
    env?: Record<string, string>;
    log?: (line: string) => void;
  }): ChantCheckHooksReport;
  writeCiHook(root: string, moment: "check", hook: ChantCheckHook, opts?: { member?: string }): { file: string; replaced: boolean };
  /** The first chant that reads `ci.hooks.check`: a declaration that uses it sets `minReader` to it. */
  CI_CHECK_HOOK_FLOOR: string;
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
    where: { bucket: string; endpoint?: string; role?: string; sessionName?: string; setting?: string; roleSetting?: string; hints?: { oidc?: string; gcp?: string; azure?: string } },
    env?: NodeJS.ProcessEnv,
    fetchFn?: StoreFetch,
  ): ObjectStore;
  S3Client: new (target: S3Target, fetchFn?: StoreFetch) => Pick<S3Client, keyof S3Client>;
  GcsClient: new (target: GcsTarget, fetchFn?: StoreFetch) => Pick<GcsClient, keyof GcsClient>;
  AzureBlobClient: new (target: AzureTarget, fetchFn?: StoreFetch) => Pick<AzureBlobClient, keyof AzureBlobClient>;
  StoreError: abstract new (...args: never[]) => Error;
  StoreConflict: abstract new (...args: never[]) => Error;
}

// ── bucket-check ───────────────────────────────────────────────────────────

/** One setting's verdict in chant's bucket report (`BucketFinding`). */
export interface ChantBucketFinding {
  setting: string;
  verdict: "ok" | "fail" | "unreadable";
  found: string;
  unwaivable: boolean;
  fix?: string;
}

/** What chant's bucket check found (`BucketReport`). */
export interface ChantBucketReport {
  store: "s3" | "gcs" | "azblob";
  bucket: string;
  namespaces: string[];
  correct: boolean;
  settings: ChantBucketFinding[];
}

/** The stores chant's bucket check reads, as its targets name them. */
export type ChantBucketTarget =
  | { store: "s3"; bucket: string; region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }
  | { store: "gcs"; bucket: string; endpoint?: string; token?: string | null }
  | { store: "azblob"; subscriptionId: string; resourceGroup: string; account: string; container: string; endpoint?: string; token?: string };

/**
 * chant core's shared bucket check (`@intentius/chant/bucket-check`,
 * chant#4558): the settings plunge and choudoufu refuse to open a bucket
 * without, read with GETs only.
 */
export interface ChantBucketCheck {
  checkBucket(target: ChantBucketTarget, options?: { namespaces?: readonly string[]; recoveryDays?: number }): Promise<ChantBucketReport>;
  BucketCheckError: abstract new (...args: never[]) => Error;
}

// ── TF046 ──────────────────────────────────────────────────────────────────

/** The terraform lexicon's TF046 (chant#4561): its check, and the reader that takes the environment it treats as CI. */
export interface ChantTf046 {
  tf046: PostSynthCheck;
  checkLocalRecordStore(ctx: PostSynthContext, env: Readonly<Record<string, string | undefined>>): PostSynthDiagnostic[];
}

// ── module catalog (chant#4560) ────────────────────────────────────────────

/** One refusal ID at a module version, across the examples that carry it. */
export interface ChantModuleRefusal {
  id: string;
  sites: number;
  docsUrl: string;
  examples: string[];
}

/** The catalog's answer for one pinned module version. Every figure is from the one tier it names. */
export interface ChantModuleCompatibility {
  module: string;
  version: string;
  tier: string;
  status: "unknown-module" | "unknown-version" | "clear" | "refused";
  examples: number;
  clearExamples: number;
  refusedExamples: number;
  refusals: ChantModuleRefusal[];
  measuredVersions: string[];
}

/** The terraform lexicon's known-module catalog (`module-catalog`, chant#4560). */
export interface ChantModuleCatalog {
  moduleCompatibility(source: string, version: string): ChantModuleCompatibility | undefined;
  MODULE_COMPATIBILITY_PAGE: string;
  MODULE_CATALOG_SOURCE: { date: string; awsProvider: string; commit: string };
}

// ── ci-product (chant#4550) ────────────────────────────────────────────────

/** A command a comment may name, as chant's words module lists them. */
export type ChantProductCommand = "plan" | "apply" | "lock" | "unlock" | "agent";

/** A stage a product names in a status context and the note. */
export type ChantProductStage = "plan" | "apply" | "record" | "check" | "drift" | "lock" | "approval" | "control";

/** chant's words with every slot filled (`CiProductWords`), as far as terragucci reads them. */
export interface ChantProductWords {
  product: string;
  stages: Record<ChantProductStage, string>;
  noun: [string, string];
  commands: Record<string, ChantProductCommand>;
  aliases: { from: string; command: ChantProductCommand; when?: string }[];
  approve: string;
  op?: string;
  gateName: string;
  approval: "per-wave" | "pull-request";
  bin?: string;
  adoptMarkers: string[];
}

// ── ci-control (chant#4568) ────────────────────────────────────────────────

/** chant's control settings with the defaults filled in (`ControlTarget`). */
export interface ChantControlTarget {
  repo: string;
  host: string;
  path: string;
  forge: "github" | "gitlab" | "forgejo";
  apiBase: string;
  op: string;
  member: string;
  ref: string;
  tokenSecret: string;
  readTokenSecret: string;
}

export type ChantControlEntryKind = "project" | "defaults";

/** An entry's current version on the control repo's ledger (`ControlEntry`). */
export interface ChantControlEntry {
  id: string;
  entry: ChantControlEntryKind;
  project?: string;
  settings: Record<string, unknown>;
  estates: string[];
  digest: string;
  at: string;
  by?: string;
}

/** Where the entries are read and appended (`ControlLedgerPort`). */
export interface ChantControlLedgerPort {
  read(): Promise<string | null>;
  append(line: string, message: string): Promise<string>;
}

export type ChantControlValidator = (entry: ChantControlEntryKind, project: string | undefined, settings: Record<string, unknown>) => string[];

export interface ChantControlWriteOptions {
  product: string;
  by?: string;
  validate?: ChantControlValidator;
  expect?: string;
  dryRun?: boolean;
}

export interface ChantControlPut {
  id: string;
  status: "created" | "updated" | "unchanged" | "retired";
  commit?: string;
}

/** A file reconcile's generator wrote, relative to the project's root. */
export interface ChantControlFileChange {
  path: string;
  status: "created" | "updated" | "unchanged" | "removed";
}

export interface ChantReconcileOutcome {
  key: string;
  status: "unchanged" | "would-change" | "pull-request" | "failed";
  changes: ChantControlFileChange[];
  pullRequest?: string;
  error?: string;
}

/** chant core's control repo (`@intentius/chant/ci-control`, chant#4568). */
export interface ChantCiControl {
  resolveControlTarget(
    input: { repo: string; forge?: "github" | "gitlab" | "forgejo"; op: string; member?: string; tokenSecret?: string; readTokenSecret?: string; ref?: string; apiBase?: string },
    fallbackMember: string,
  ): ChantControlTarget;
  controlDispatchScript(target: ChantControlTarget, opts?: { words?: object; sentCheck?: string; markSent?: string }): string;
  controlStatusContext(words?: object): string;
  gitControlLedger(opts?: { cwd?: string }): ChantControlLedgerPort;
  readControlEntries(port: ChantControlLedgerPort, opts?: { validate?: ChantControlValidator; lenient?: boolean }): Promise<ChantControlEntry[]>;
  putControlEntry(port: ChantControlLedgerPort, want: { entry: ChantControlEntryKind; project?: string; settings: Record<string, unknown>; estates?: string[] }, opts: ChantControlWriteOptions): Promise<ChantControlPut>;
  retireControlEntry(port: ChantControlLedgerPort, project: string, opts: ChantControlWriteOptions): Promise<ChantControlPut>;
  importControlConfig(
    port: ChantControlLedgerPort,
    config: { defaults?: Record<string, unknown>; projects: Record<string, Record<string, unknown>>; estates?: Record<string, string[]> },
    opts: ChantControlWriteOptions,
  ): Promise<(ChantControlPut & { entry: string })[]>;
  estateClaims(entries: readonly ChantControlEntry[]): Map<string, string[]>;
  /** The note job's read of the control repo's chant/lifecycle (chant#4619), which sets CHANT_CONTROL_DIR. Absent before #4619. */
  controlNoteCheckout?(memberForge: "github" | "gitlab" | "forgejo", target: ChantControlTarget, words?: object): { stepName: string; env: Record<string, string>; script: string };
  reconcileProjects(
    projects: readonly { key: string; settings: Record<string, unknown>; forge?: "github" | "gitlab" | "forgejo"; url?: string; tokenEnv?: string; apiBase?: string }[],
    options: {
      mode: "dry-run" | "apply";
      project?: string;
      words?: object;
      generate: (dir: string, target: { key: string; name: string; forge: "github" | "gitlab" | "forgejo"; settings: Record<string, unknown>; dryRun: boolean }) => Promise<ChantControlFileChange[]>;
      env?: Record<string, string | undefined>;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ): Promise<ChantReconcileOutcome[]>;
  CI_CONTROL_FLOOR: string;
}

/** A forge lexicon's control repo pipeline (`components/control-pipeline`, chant#4568). */
export interface ChantControlPipeline {
  generateControlPipeline(options?: { words?: object; image?: string; command?: string }): { path: string; content: string; notes: string[] };
}

// ── part e: pr-env ledger, wave step ─────────

export interface ChantOpWaveStep {
  opWaveStepProblems(spec: object): string[];
  opWaveHoldsProblems(holds: unknown): string[];
  planOpWaveStep: (...args: never[]) => unknown;
  applyOpWaveStep: (...args: never[]) => unknown;
}

/** A capability registry with the terraform lexicon's `terraform-apply`, for a wave run in terragucci's process (ruling C). */
export interface ChantWaveCapabilities {
  registry: { has(kind: string): boolean; kinds?(): string[] };
}

/** One planned run, as chant's after-plan hook in the wave's process hands it (chant#4614). */
export interface ChantAfterPlanRun {
  wave: number;
  waveName: string;
  job: "wave" | "decide" | "share" | "group";
  target: string;
  planDigest: string;
  /** The run's plan file, relative to the job's directory. */
  plan: string;
  /** The engine's plan document (`show -json`), when the plan names one. */
  planJson?: string;
  empty: boolean;
  destructive: boolean;
  changeSet?: { entries: { action: string }[] };
}

/** A policy row on chant's run record (chant#4614). */
export interface ChantPolicyRow {
  source: string;
  result: "passed" | "warned" | "denied" | "held";
  rules: string[];
  reason?: string;
}

/** chant's op-wave job run in this process with after-plan hooks (`@intentius/chant/op`, chant#4614). */
export interface ChantAfterPlan {
  runOpWave(options: {
    spec: object;
    specFile: string;
    wave: number;
    decide?: boolean;
    share?: number;
    group?: string;
    base?: string;
    cwd?: string;
    log?: (line: string) => void;
    capabilities?: unknown;
    hookExec?: (argv: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
    afterPlan?: { name: string; onFailure?: "fail" | "approve"; run(r: ChantAfterPlanRun): Promise<{ policy?: ChantPolicyRow[]; files?: string[] } | void> | { policy?: ChantPolicyRow[]; files?: string[] } | void };
  }): Promise<import("@intentius/chant/op").RunOpWaveResult>;
  opWavePlanPath(spec: { name: string }, wave: number, target: string): string;
  spawnExecAsync(argv: string[], cwd: string, env?: Record<string, string>): Promise<number>;
}

// ── release catalog (terragucci#1297, chant#4595-#4599) ───────────────────

/** A version's status in the catalog. */
export type ChantReleaseState = "active" | "deprecated" | "yanked";

/** One version in chant's release catalog (`CatalogVersion`, chant#4595). */
export interface ChantCatalogVersion {
  version: string | null;
  digest: string;
  commit: string;
  time: string;
  actor: string;
  envs: string[];
  status: { state: ChantReleaseState; reason: string | null; replacement: string | null; actor: string | null; time: string | null };
  changelog: { bump: "major" | "minor" | "patch" | null; entries: { kind: string; sha: string; subject: string; scope?: string }[] };
  attestation: { state: "verified" | "signed" | "unsigned"; verify: string | null; identity: string | null };
  consumers: { repo?: string; root: string; file?: string; address?: string }[];
  fields: Record<string, Record<string, unknown>>;
}

/** One component in the catalog. */
export interface ChantCatalogComponent {
  name: string;
  latest: string | null;
  fields: Record<string, Record<string, unknown>>;
  versions: ChantCatalogVersion[];
}

/** chant's release catalog document (`ReleaseCatalog`, chant#4595). */
export interface ChantReleaseCatalogDoc {
  $schema: string;
  contract: 1;
  chant: string;
  generatedAt: string;
  components: ChantCatalogComponent[];
}

/** A status record (`ReleaseStatusRecord`, chant#4596). */
export interface ChantReleaseStatusRecord {
  version: 1;
  component: string;
  env: string;
  digest: string;
  releaseVersion?: string;
  status: ChantReleaseState;
  reason?: string;
  replacement?: string;
  actor: string;
  timestamp: string;
}

/** The site's engine sections (`CatalogSiteSections`), passed through untouched. */
export type ChantCatalogSections = object;

/**
 * chant core's release catalog: the model (`lifecycle/release-catalog`,
 * chant#4595), its static site (`lifecycle/release-catalog-site`), the status
 * records (`lifecycle/release-status`, chant#4596) and the changelog
 * (`lifecycle/release-changelog`, chant#4597).
 */
export interface ChantReleaseCatalog {
  buildReleaseCatalog(
    input: {
      releases: readonly unknown[];
      statuses?: readonly unknown[];
      changelogs?: readonly { component: string; version?: string; digest?: string; entries: unknown[]; bump?: string }[];
      consumers?: readonly { component: string; version?: string; digest?: string; consumers: unknown[] }[];
      attestations?: readonly { component: string; digest: string; state: string; verify?: string; identity?: string }[];
      fields?: readonly { component: string; version?: string; digest?: string; engine: string; fields: Record<string, unknown> }[];
    },
    opts: { generatedAt: string; chant?: string },
  ): ChantReleaseCatalogDoc;
  parseReleaseCatalog(text: string | unknown): ChantReleaseCatalogDoc;
  renderCatalogSite(catalog: ChantReleaseCatalogDoc, sections?: ChantCatalogSections, opts?: { title?: string }): { path: string; contentType: string; bytes: Uint8Array }[];
  versionPath(component: string, key: string): string;
  componentPath(component: string): string;
  parseReleaseStatus(text: string | null): { records: ChantReleaseStatusRecord[]; malformed: number };
  catalogStatusInputs(records: readonly ChantReleaseStatusRecord[]): unknown[];
  statusOf(records: readonly ChantReleaseStatusRecord[], component: string, digest: string): { status: ChantReleaseState; record?: ChantReleaseStatusRecord };
  appendReleaseStatus(input: Omit<ChantReleaseStatusRecord, "version">, opts?: { cwd?: string }): Promise<{ commit: string; record: ChantReleaseStatusRecord }>;
  releaseChangelog(commits: readonly { sha: string; message: string }[]): { bump: "major" | "minor" | "patch"; entries: { kind: string; sha: string; subject: string; scope?: string }[] };
  RELEASE_STATUS_FILE: string;
  RELEASE_CATALOG_FLOOR: string;
}

/** A module call the terraform lexicon's scan found (`ModuleConsumer`, chant#4599). */
export interface ChantModuleConsumer {
  root: string;
  file: string;
  address: string;
  kind: "terraform" | "terragrunt";
  source: string;
  module: string;
  pin: string | null;
}

/** One finding of the deprecated-version check (`DeprecatedPin`, chant#4599). */
export interface ChantDeprecatedPin {
  consumer: ChantModuleConsumer;
  component: string;
  version: string;
  status: "deprecated" | "yanked";
  reason: string | null;
  replacement: string | null;
  message: string;
}

/** The terraform-docs runner the lexicon's extractor takes (`TerraformDocsRunner`, chant#4598). */
export type ChantTerraformDocsRunner = (args: { dir: string; config: string }) => Promise<string | null>;

/**
 * The terraform lexicon's catalog parts, on its `registry` subpath: the docs
 * extractor and catalog fields (chant#4598), the consumer scan, the catalog
 * reader and the deprecated-version check (chant#4599).
 */
export interface ChantRegistryCatalog {
  moduleDocs(dir: string, options?: { parser?: unknown; terraformDocs?: ChantTerraformDocsRunner; binary?: string }): Promise<{ docsFrom: "terraform-docs" | "hcl"; note: string | null } & Record<string, unknown>>;
  terraformCatalogFields(docs: unknown, address: string): Record<string, unknown>;
  terraformCatalogSections(): ChantCatalogSections;
  moduleConsumers(repo: string, roots: readonly string[], parser?: unknown): Promise<ChantModuleConsumer[]>;
  normalizeModuleSource(module: string): string;
  readRegistryCatalog(registry: string, options?: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; scheme?: "https" | "http"; token?: string | false }): Promise<ChantReleaseCatalogDoc | null>;
  deprecatedPins(consumers: readonly ChantModuleConsumer[], catalog: ChantReleaseCatalogDoc): { warnings: ChantDeprecatedPin[]; refusals: ChantDeprecatedPin[] };
  CATALOG_PATH: string;
}

// ── module targets (terragucci#1300, chant#4602-#4604) ───────────────────

/** A module in a hosted registry, without the host (`ModuleAddress`, chant#4603). */
export interface ChantModuleAddress {
  namespace: string;
  name: string;
  system: string;
}

/** What a module target is given (`ModuleVersionContext`, chant#4603), on core's publish context (chant#4602). */
export interface ChantModuleVersionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  redactor: { add(value: string | undefined | null): void; redact(text: string): string };
  log(line: string): void;
  provenance: { oidc: boolean; ci: "github" | "gitlab" | null; reason: string };
  tag: string | null;
  address: ChantModuleAddress;
  version: string;
  archive: Uint8Array;
  revision: string;
  content: string;
}

/** A module publish target (`ModulePublishTarget`, chant#4603): core's contract plus its two reads. */
export interface ChantModuleTarget {
  kind: string;
  name: string;
  credentialEnv: string[];
  versions(address: ChantModuleAddress, ctx: Pick<ChantModuleVersionContext, "env" | "redactor">): Promise<string[]>;
  held(address: ChantModuleAddress, version: string, ctx: Pick<ChantModuleVersionContext, "env" | "redactor">): Promise<{ content: string; revision?: string; status?: string } | undefined>;
  plan(ctx: ChantModuleVersionContext): Promise<unknown[]>;
  stage(ctx: ChantModuleVersionContext): Promise<{ target: string; destination: string }>;
  reveal(ctx: ChantModuleVersionContext, staged: { target: string; destination: string }): Promise<unknown>;
}

/** The fetch a module target and its registry reads take. */
export type ChantModuleFetch = (url: string, init?: { method?: string; headers?: unknown; body?: unknown; redirect?: "follow" | "manual" }) => Promise<Response>;

/** What a module target's factory is given (`ModuleTargetDeps`). */
export interface ChantModuleTargetDeps {
  fetch?: ChantModuleFetch;
  registryFetch?: ChantModuleFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The terraform lexicon's module targets (`registry/targets`, chant#4603),
 * with core's redactor and error class from the publish-target contract
 * (`lifecycle/publish-credentials`, `lifecycle/release-publish`, on the pin).
 */
export interface ChantModuleTargets {
  gitlabModuleTarget(options: { project?: string; api?: string; tokenEnv?: string; namespace?: string }, deps?: ChantModuleTargetDeps): ChantModuleTarget;
  /** HCP Terraform or Terraform Enterprise (chant#4604). */
  hcpModuleTarget(options: { organization: string; host?: string; tokenEnv?: string; waitMs?: number; pollMs?: number }, deps?: ChantModuleTargetDeps): ChantModuleTarget;
  /** JFrog Artifactory and Sonatype Nexus hosted repositories (chant#4605). */
  artifactoryModuleTarget(options: { url: string; repo: string; tokenEnv?: string; userEnv?: string; user?: string; waitMs?: number; pollMs?: number }, deps?: ChantModuleTargetDeps): ChantModuleTarget;
  nexusModuleTarget(options: { url: string; repo: string; host?: string; tokenEnv?: string; userEnv?: string; user?: string; waitMs?: number; pollMs?: number }, deps?: ChantModuleTargetDeps): ChantModuleTarget;
  createRedactor(env?: NodeJS.ProcessEnv, names?: readonly string[]): ChantModuleVersionContext["redactor"];
  PublishTargetError: new (code: string, message: string, fix?: string) => Error & { code: string; fix?: string };
}

// ── registry proxies (terragucci#1302, chant#4606) ────────────────────────

/** A registry proxy (`RegistryProxy`, chant#4606): an Artifactory remote repository or a Nexus proxy in front of an upstream. */
export interface ChantRegistryProxy {
  host: string;
  repo?: string;
  upstream?: string;
  modules?: string;
  providers?: string;
}

/** The terraform lexicon's proxy forms and the reads that go through them (`registry/proxies`, chant#4606). */
export interface ChantRegistryProxies {
  artifactoryProxy(host: string, repo: string, upstream?: string): ChantRegistryProxy;
  nexusProxy(o: { url: string; repo: string; upstream?: string; host?: string }): ChantRegistryProxy;
  moduleThroughProxy(source: string, proxies?: readonly ChantRegistryProxy[]): { proxy: ChantRegistryProxy; upstream: string } | undefined;
  providerThroughProxy(source: string, proxies?: readonly ChantRegistryProxy[]): { proxy: ChantRegistryProxy; upstream: string } | undefined;
  registryLocation(source: string, version: string, options?: { fetch?: ChantModuleFetch; proxies?: readonly ChantRegistryProxy[] }): Promise<string>;
  fetchTarball(location: string, options?: { fetch?: ChantModuleFetch }): Promise<Uint8Array>;
}

// ── part f: forge check, relay, estate, policy source, stand-down ─────────

/** A forge check row (`CheckRow` in `@intentius/chant/forge-check`, chant#4608). */
export interface ChantCheckRow {
  where: "github" | "gitlab" | "forgejo" | "aws" | "gcp" | "azure" | "pulumi";
  check: string;
  subject: string;
  expected: string;
  found: string;
  status: "match" | "mismatch" | "unknown" | "not-checked";
}

/** The repository a forge check names (`ForgeCheckRepository`). */
export interface ChantForgeCheckRepository {
  host: string;
  path: string;
  defaultBranch: string;
  ownerId?: string;
  repoId?: string;
}

/** A job's OIDC token, as the contract holds it (`JobToken`). */
export interface ChantJobToken {
  issuer: string;
  subject: string;
  pattern: boolean;
  claims: Record<string, string>;
  placeholders: string[];
}

/** One job of the contract (`ForgeCheckJob`). */
export interface ChantForgeCheckJob {
  name: string;
  identity: "plan" | "apply";
  token: ChantJobToken;
  forgeEnvironment?: string;
  runner?: { labels: string[]; group?: string };
  aws?: { roles: string[]; audience: string };
  gcp?: { provider: string; audience: string };
  azure?: { clientIds: string[]; audience: string };
}

/** The forge check's contract (`ForgeCheckContract`). */
export interface ChantForgeCheckContract {
  forge: "github" | "gitlab" | "forgejo";
  repository: ChantForgeCheckRepository;
  jobs: ChantForgeCheckJob[];
  protectedBranches?: string[];
  requiredStatuses?: string[];
  gitlabVariables?: string[];
}

/** The forge to read (`ForgeTarget` in `@intentius/chant/pr-forge`). */
export interface ChantForgeCheckTarget {
  kind: "github" | "gitlab" | "forgejo";
  apiBase: string;
  repo: string;
  host: string;
  token: string;
  tokenSource: string;
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
}

/** The fetch chant's forge check reads through (`ForgeFetch`). */
export type ChantForgeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The forge check's result (`ForgeCheckResult`): `<product>.forge-check/v1`. */
export interface ChantForgeCheckResult {
  schema: string;
  file?: string;
  forge: "github" | "gitlab" | "forgejo";
  repository: ChantForgeCheckRepository;
  rows: ChantCheckRow[];
  counts: Record<ChantCheckRow["status"], number>;
  ok: boolean;
}

/** chant core's forge and trust-policy check (`@intentius/chant/forge-check`, chant#4608). */
export interface ChantForgeCheck {
  forgeCheck(
    input: { target: ChantForgeCheckTarget; contract: ChantForgeCheckContract | ((live: { defaultBranch?: string; path?: string; ownerId?: string; repoId?: string }) => ChantForgeCheckContract); requireClouds?: boolean; words?: object; file?: string },
    deps: { fetch: ChantForgeFetch; env: Record<string, string | undefined>; readFile?: (path: string) => string | undefined; now?: () => Date },
  ): Promise<ChantForgeCheckResult>;
  readRepository(fetch: ChantForgeFetch, t: ChantForgeCheckTarget): Promise<{ ok: true; value: { defaultBranch?: string; path?: string; ownerId?: string; repoId?: string } } | { ok: false; status: number | undefined; why: string }>;
  readOnly(fetch: ChantForgeFetch, command?: string): ChantForgeFetch;
  describeForgeCheck(r: ChantForgeCheckResult): string;
  forgeCheckExit(r: ChantForgeCheckResult): number;
}

/** A click read from a verified chat request (`RelayClick` in `@intentius/chant/notify-relay`). */
export interface ChantRelayClick {
  app: "slack" | "teams";
  chatUser: string;
  display: string;
  action: "approve" | "decline";
  token: string;
  responseUrl?: string;
  thread?: string;
}

/** A standing pending fact chant's relay may approve (`RelayPending`). */
export interface ChantRelayPending {
  op: string;
  gate: string;
  digest: string;
  environment?: string;
}

/** What chant's relay reads and writes (`RelayDeps`). */
export interface ChantRelayDeps {
  signers(): Promise<{ signers: ReadonlyArray<{ principal: string; line: number }>; path: string }>;
  pending(digest: string): Promise<ChantRelayPending[]>;
  approve(input: { op: string; gate: string; digest: string; environment?: string; actor: string; relayedBy: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  principal: string;
  words: ChantProductWords;
  now?: () => Date;
}

/** chant core's notify relay (`@intentius/chant/notify-relay`, chant#4611). */
export interface ChantNotifyRelay {
  verifySlackRequest(headers: Record<string, string | undefined>, raw: string, secret: string | undefined, now?: number): string | null;
  verifyTeamsRequest(headers: Record<string, string | undefined>, raw: string, secret: string | undefined): string | null;
  relayPrincipalFor(signers: ReadonlyArray<{ principal: string; line: number }>, chatUser: string): string | undefined;
  slackRelayClick(raw: string): ChantRelayClick | { error: string };
  teamsRelayClick(raw: string): ChantRelayClick | { error: string };
  decideRelayClick(click: ChantRelayClick, settings: { key?: string; maxAgeSeconds?: number }, deps: ChantRelayDeps): Promise<{ ok: boolean; outcome: string; text: string; op?: string; gate?: string; principal?: string }>;
  RELAY_ENV: { key: string; maxAge: string };
}

/** The delivery metrics, as chant's `buildDelivery` writes `dora.json` (terragucci's shape, plus `source`). */
export interface ChantDora {
  schema: string;
  generated: string;
  audit: boolean;
  source: "ledger";
  estate: { deployments: number } & Record<string, unknown>;
  projects: ({ project: string } & Record<string, unknown>)[];
}

/** A member's section of chant's ledger estate (`EstateProject` in `@intentius/chant/ci-estate`). */
export interface ChantEstateProject {
  project: string;
  status: "ok" | "no-index";
  drift?: object;
  apply?: { commit: string; waves: object[] };
  waiting: { project: string; wave: number; commit: string; since: string; age_seconds: number; gate?: string }[];
  drifted: number;
  failed: number;
  overdue?: object[];
  ephemeral?: object[];
}

/** chant's ledger estate (`LedgerEstate`): the page, its delivery metrics and the overdue checks. */
export interface ChantLedgerEstate {
  estate: { schema: string; generated: string; source: "ledger"; totals: { overdue: number } & Record<string, number | undefined>; projects: ChantEstateProject[]; recent: object[] };
  dora: ChantDora;
  overdue: object[];
}

/** chant core's estate page, overdue checks and delivery metrics (`@intentius/chant/ci-estate`, chant#4612). */
export interface ChantCiEstate {
  buildLedgerEstate(input: { load: unknown; words?: object; now?: Date; members?: readonly string[]; project?: string; schedules?: readonly { op: string; cron: string; members?: string[] }[] }): ChantLedgerEstate;
  readEstateLedger(cwd: string, members?: readonly string[]): Promise<unknown>;
  deliveryGauges(dora: ChantDora, words?: object): { name: string; unit: string; description: string; value: number; attributes: Record<string, string> }[];
  CI_ESTATE_FLOOR: string;
}

/** `ci.policy.source` (`GatePolicySource` in `@intentius/chant/policy-source`). */
export interface ChantGatePolicySource {
  repo: string;
  ref: string;
  path?: string;
}

/** A tree chant read at a commit (`WorkspaceTree`). */
export interface ChantWorkspaceTree {
  stat(path: string): "file" | "dir" | undefined;
  list(path: string): { name: string; type: "file" | "dir" }[] | undefined;
  read(path: string): string;
  bytes?(path: string): Uint8Array;
}

/** chant core's shared policy source (`@intentius/chant/policy-source`, chant#4613). */
export interface ChantPolicySource {
  assertGatePolicySource(where: string, raw: unknown): void;
  fetchGatePolicySource(source: ChantGatePolicySource, opts?: { tmp?: string }): { source: { repo: string; ref: string; commit: string; path: string }; tree: ChantWorkspaceTree; cleanup: () => void } | { error: string };
  CI_POLICY_SOURCE_FLOOR: string;
}

/** A newer commit on the run's branch (`OpWaveNewerCommit`). */
export interface ChantNewerCommit {
  branch: string;
  head: string;
  tip: string;
}

/** chant's op-wave stand-down (`newerCommitOnBranch` in `@intentius/chant/op`, chant#4581). */
export interface ChantOpStandDown {
  newerCommitOnBranch(cwd: string, env?: NodeJS.ProcessEnv, head?: string): Promise<ChantNewerCommit | undefined>;
  tipAppliesTargets(atTip: unknown, branch: string, waveName: string, targets: readonly string[]): boolean;
  OP_WAVE_STAND_DOWN_FLOOR: string;
}

// ── used sources (chant#3924) ─────────────────────────────────────────────

/** A source a root uses, as the terraform lexicon reads it (`UsedSource`, chant#3924). */
export interface ChantUsedSource {
  kind: "module" | "provider";
  file: string;
  block: string;
  source: string;
  normal: string;
  implied?: string;
}

/** The terraform lexicon's source reading and forms (`used-sources`, `registry/source-forms`, chant#3924), on its `registry` subpath. */
export interface ChantSourceForms {
  moduleSourceForms(source: string, options?: { proxies?: readonly ChantRegistryProxy[] }): string[];
  providerAddressForms(source: string, options?: { proxies?: readonly ChantRegistryProxy[] }): string[];
  usedSources(
    dir: string,
    options?: { followLocal?: boolean; project?: string; parser?: unknown; proxies?: readonly ChantRegistryProxy[] },
  ): Promise<{ used: ChantUsedSource[]; unread: { file: string; block: string; source: string; why: string }[] }>;
  lockedProviders(lockText: string): string[];
}

// ── state operations, lock rows, product tools, changelog, release reads ───

/** A gated request (`GatedRequest`, chant#4551). */
export interface ChantGatedRequest {
  kind: string;
  subject: string;
  by: string;
  at: string;
  fields: Record<string, string>;
}

/** How a gated operation ended (`GatedStateOpResult`, chant#4618). */
export type ChantGatedStateOpResult<T> =
  | { status: "waiting"; digest: string; request: ChantGatedRequest; command: string }
  | { status: "refused"; digest: string; request: ChantGatedRequest; by: string; reason: string; command: string }
  | { status: "spent"; digest: string; request: ChantGatedRequest; finished?: { result: string; timestamp: string; detail?: Record<string, unknown> } }
  | { status: "held"; digest: string; request: ChantGatedRequest; reason: string }
  | { status: "done"; digest: string; request: ChantGatedRequest; approvedBy: string; output: T; recorded: boolean }
  | { status: "failed"; digest: string; request: ChantGatedRequest; approvedBy: string; error: Error; recorded: boolean };

export interface ChantGatedStateOpInput {
  op: string;
  request: Omit<ChantGatedRequest, "at"> & { at?: string };
  rules: { mode: string; quorum?: readonly unknown[] };
  description?: string;
  expiry?: string;
  base?: string;
  attachment?: string;
  cwd?: string;
  now?: string;
  runId?: string;
  commit?: string;
  beforeSpend?: () => Promise<string | undefined>;
}

/** How the binary runs for one root, as the terraform lexicon's state operations take it. */
export interface ChantRootRun {
  root: string;
  binary: string;
  dir: string;
  env?: NodeJS.ProcessEnv;
  exec?: (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; out: string }>;
}

/** One gated request as the ledger holds it (`GatedRequestRead`). */
export interface ChantGatedRequestRead {
  op: string;
  gate: string;
  digest: string;
  request: ChantGatedRequest;
  pending: { timestamp: string; expiresAt?: string };
  approvals: { resolvedBy: string; timestamp: string }[];
  applied?: { timestamp: string; approvedBy?: string; approvedAt?: string };
  finished?: { result: string; timestamp: string; detail?: Record<string, string | number | boolean> };
}

/**
 * chant's recorded op-wave hold (chant#4623): a hold file with `record: true`
 * has chant write the held gate's applied line before the approved re-run
 * and its finished line after, from what the re-run writes to
 * `CHANT_HOLD_FINISHED`, and store the hold's `attachment` at
 * {@link ChantHoldRecord.gatedRequestAttachmentPath}.
 */
export interface ChantHoldRecord {
  OP_WAVE_HOLD_RECORD_FLOOR: string;
  gatedRequestAttachmentPath(op: string, digest: string): { dir: string; file: string };
}

/**
 * chant's reader of a gated request's stored attachment (chant#4551 stores it
 * at `_gates/<op>/requests/<digest>.json` on chant/lifecycle, chant#4623 for
 * an op-wave hold): the path, and `readBlobFromPath` from chant's ledger.
 */
export interface ChantRequestProof {
  gatedRequestAttachmentPath(op: string, digest: string): { dir: string; file: string };
  readBlobFromPath(environment: string, filename: string, opts?: { cwd?: string }): Promise<string | null>;
}

/** What chant's gate ledger writers answer: whether the line reached the remote. */
export interface ChantLedgerPush {
  pushed: boolean;
  pushWarning?: string;
}

/** chant's gate ledger port (`op/gate` `gitGateLedgerPort`): the writers of `_gates/<op>.jsonl` and `_gates/<op>/applied.jsonl`. */
export interface ChantGateLedgerPort {
  appendPending(input: Record<string, unknown>): Promise<ChantLedgerPush>;
  appendResolution?(input: Record<string, unknown>): Promise<ChantLedgerPush>;
  appendApplied?(record: Record<string, unknown>): Promise<ChantLedgerPush>;
  /** chant#4623; on a chant without it a finished line goes through appendApplied, which appends any line to the same file. */
  appendFinished?(record: Record<string, unknown>): Promise<ChantLedgerPush>;
}

/**
 * chant's ledger writers for the records a tf-apply wave writes on chant's
 * path (terragucci#1282 part j): the gate port, a file beside a pending fact,
 * and the push. Loaded only from a chant with the recorded hold
 * (`OP_WAVE_HOLD_RECORD_FLOOR`, chant#4623), so the published pin keeps
 * terragucci's own writer.
 */
export interface ChantGateWriters {
  OP_WAVE_HOLD_RECORD_FLOOR: string;
  gitGateLedgerPort(opts?: { cwd?: string }): ChantGateLedgerPort;
  writeBlobToPath(dir: string, file: string, content: string, message: string, opts?: { cwd?: string }): Promise<string>;
  pushLifecycleReport(opts?: { cwd?: string }): Promise<ChantLedgerPush>;
  /** Fetch chant/lifecycle into the checkout's branch, refusing a fork (#2303); every chant has it. */
  requireLifecycleLedger(opts?: { cwd?: string }): Promise<void>;
  isLifecycleLocalNote(warning: string | undefined): boolean;
}

/** The terraform lexicon's state operations (`state-ops`, chant#4618) with chant's gated-request reader (chant#4551). */
export interface ChantStateOps {
  gatedStateOp<T>(input: ChantGatedStateOpInput, act: (approved: { digest: string; request: ChantGatedRequest; approvedBy: string }) => Promise<{ output: T; detail?: Record<string, string | number | boolean> }>): Promise<ChantGatedStateOpResult<T>>;
  forceUnlockState(r: ChantRootRun & { id: string }): Promise<void>;
  pushStateFile(r: ChantRootRun & { file: string; lock?: boolean; force?: boolean }): Promise<void>;
  planStateCheck(r: ChantRootRun & { planFile: string; lock?: boolean }): Promise<{ planFile: string; json: unknown; summary: string }>;
  planCopy(r: ChantRootRun & { backendConfig: Record<string, string>; planFile: string; destroy?: boolean; lockTimeout?: string | false; init?: boolean }): Promise<{ planFile: string; json: unknown; summary: string; planDigest: string }>;
  applyPlanFile(r: ChantRootRun & { planFile: string; lockTimeout?: string | false }): Promise<void>;
  readGatedRequests(op: string, location?: { cwd?: string }): Promise<ChantGatedRequestRead[]>;
}

/** One row an apply holds (`LockRow`, chant#4552). */
export interface ChantLockRow {
  key: string;
  target: string;
  address: string;
}

export interface ChantLockRowHolder {
  run: string;
  at: string;
  url?: string;
  sha?: string;
}

export interface ChantHeldLockRow {
  key: string;
  wanted: string;
  holder: ChantLockRowHolder;
}

export interface ChantLockRowsFile {
  version: 1;
  holders: Record<string, ChantLockRowHolder>;
  rows: Record<string, string>;
}

/** chant core's row leases (`lifecycle/resource-lock`, chant#4552, #4594) and the terraform lexicon's rows (`lock-rows`). */
export interface ChantLockRows {
  terraformLockRows(root: string, estate: string | undefined, plan: unknown): ChantLockRow[];
  takeLockRows(gate: string, rows: readonly ChantLockRow[], me: ChantLockRowHolder, opts?: { cwd?: string; alive?: (h: ChantLockRowHolder) => Promise<"alive" | "dead"> }): Promise<{ ok: true; tookOver: ChantLockRowHolder[]; pushed: boolean } | { ok: false; held: ChantHeldLockRow[] }>;
  releaseLockRows(gate: string, keys: readonly string[], me: string, opts?: { cwd?: string }): Promise<boolean>;
  readLockRows(gate: string, opts?: { cwd?: string }): Promise<ChantLockRowsFile>;
  lockRowsPath(gate: string): string;
}

/** A tool on chant's MCP server (`McpToolContribution`). */
export interface ChantMcpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  readOnly?: boolean;
}

/** chant's product tool hook (`ProductMcpHook`, chant#4555). */
export interface ChantProductMcpHook {
  product: string;
  tools(ctx: { cwd: string; readOnly: boolean }): ChantMcpTool[];
  reportUrl?: string;
  readOnly?: boolean;
  instructions?: string;
}

/** chant's in-process CLI with the product tool hook (`@intentius/chant/ci-product`, chant#4555). */
export interface ChantProductMcp {
  runChantInProcess(argv: string[], words: object, options?: { mcp?: ChantProductMcpHook }): Promise<number>;
  PRODUCT_MCP_HOOK_FLOOR: string;
}

/** chant core's changelog bump (`lifecycle/release-changelog`, chant#4597): pure, so the synchronous callers read it. */
export interface ChantChangelog {
  changelogBump(messages: readonly string[]): "major" | "minor" | "patch";
}

/** chant core's release record reader (`lifecycle/release-ledger`'s `parseReleaseLedger`), for a ledger read from another remote. */
export interface ChantReleaseRead {
  releaseLedgerLines(text: string | null): string[];
  parseReleaseLedger(lines: readonly string[]): { records: unknown[]; malformed: number };
}

/** chant's agent run record (`agentRunRecordInput`, `@intentius/chant/ci-agent`, chant#4616) and the run ledger's writer (`appendRunRecord`). */
export interface ChantAgentRuns {
  agentRunRecordInput(o: {
    settings: { name: string; on: string; env: string };
    started: string;
    ended: string;
    result: "pushed" | "opened" | "updated" | "refused" | "stopped" | "failed";
    reason: string;
    requestedBy?: string;
    commit?: string;
    pullRequest?: string;
    promptDigest?: string;
    usage?: { model?: string; usd?: number; inputTokens?: number; outputTokens?: number };
    gitSha?: string;
  }): object;
  appendRunRecord(input: object, opts?: { cwd?: string }): Promise<{ commit: string }>;
  pushLifecycleReport(opts?: { cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }>;
}

/** A scheduled Op spec as chant's Op generator takes it (`ScheduledOpSpec`), as far as terragucci writes one. */
export type ChantScheduledOpSpec = { name: string; trigger?: object; agent?: object; runner?: unknown; findingMode?: string; [k: string]: unknown };

/** One file chant's Op generator writes (`OpPipelineResult.files`). */
export interface ChantOpPipelineFile {
  name: string;
  yaml: string;
}

/** A forge lexicon's Op generator (`components/generate-op-pipeline`), with the options terragucci passes. */
export type ChantOpGenerator = (ops: ChantScheduledOpSpec[], options?: { image?: string; beforeScript?: string[]; runCommand?: string[]; opsStage?: string; opsFileName?: string; variables?: Record<string, string> }) => { files: ChantOpPipelineFile[] };

/**
 * chant's agent job (chant#4616, #4619): the agent's Op spec from
 * `productPipelineJobs(..., { agent })`, the drift agent of a scheduled drift
 * Op (`productDriftAgent`), and each forge lexicon's Op generator, which
 * writes the agent's jobs in the words that are active
 * (`setActiveProductWords`). `CI_AGENT_FLOOR` on the ci-product entry is the
 * feature-detect.
 */
export interface ChantAgentJob {
  CI_AGENT_FLOOR: string;
  productPipelineJobs(
    forge: "github" | "gitlab" | "forgejo",
    env: string,
    options: { words: object; agent?: boolean | Record<string, unknown>; [k: string]: unknown },
  ): { agent?: { comment: string; name: string; spec: ChantScheduledOpSpec } };
  productDriftAgent(words: object, op: string, options?: Record<string, unknown>): Record<string, unknown>;
  setActiveProductWords(words: object | undefined): unknown;
  generate: Record<"github" | "gitlab" | "forgejo", ChantOpGenerator>;
}

// ── template requests (chant#4651, #4652) ──────────────────────────────────

/** An input's engine-neutral kind in template.yml/v1 (`TemplateInputKind`). */
export type ChantTemplateInputKind = "string" | "number" | "bool" | "list" | "map" | "object";

/** One input of a template (`TemplateInput`). */
export interface ChantTemplateInput {
  name: string;
  kind: ChantTemplateInputKind;
  of?: "string" | "number" | "bool";
  label?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  sensitive?: boolean;
}

/** A parsed template.yml (`TemplateSpec`). */
export interface ChantTemplateSpec {
  $schema?: string;
  contract: 1;
  kind?: "app" | "addon";
  description: string;
  inputs: ChantTemplateInput[];
}

/** A template request, template-request/v1 (`TemplateRequest`). */
export interface ChantTemplateRequest {
  $schema: string;
  contract: 1;
  kind: "app" | "addon";
  template: string;
  version: string;
  app: string;
  addon?: string;
  inputs: Record<string, unknown>;
  requestedBy: string;
  via: "form" | "mcp" | "cli";
}

/** One refusal of a request (`TemplateRequestRefusal`). */
export interface ChantTemplateRequestRefusal {
  code: string;
  field: string;
  reason: string;
}

/** chant core's template request (`@intentius/chant/template-request`, chant#4651). */
export interface ChantTemplateRequests {
  TEMPLATE_REQUEST_FLOOR: string;
  makeTemplateRequest(input: Omit<ChantTemplateRequest, "$schema" | "contract">): ChantTemplateRequest;
  checkTemplateRequest(
    request: unknown,
    catalog: ChantReleaseCatalogDoc,
    templateSpec: ChantTemplateSpec,
    options?: { component?: string; require?: "verified" | "signed" | "unsigned" },
  ): { ok: true; request: ChantTemplateRequest } | { ok: false; refusals: ChantTemplateRequestRefusal[] };
  requestBranch(request: Pick<ChantTemplateRequest, "template" | "app"> & Partial<Pick<ChantTemplateRequest, "kind" | "addon">>): string;
  requestBody(request: ChantTemplateRequest, words?: object): string;
  templateName(template: string): string;
  parseTemplateSpec(text: string | unknown): ChantTemplateSpec;
}

/** One file of a rendered request, relative to the app's root (`RenderedFile`). */
export interface ChantRenderedFile {
  path: string;
  text: string;
}

/** The terraform lexicon's template rendering (`@intentius/chant-lexicon-terraform/template`, chant#4652). */
export interface ChantTemplateRender {
  renderAppRoot(options: { request: ChantTemplateRequest; source: string; inputs: readonly ChantTemplateInput[]; outputs?: readonly { name: string; description?: string | null; sensitive?: boolean }[] }): ChantRenderedFile[];
  terraformInputType(input: Pick<ChantTemplateInput, "kind" | "of">): string;
  /** Thrown with a `code` and a `subject` when a request cannot become files. */
  TemplateRenderError: new (...args: never[]) => Error & { code: string; subject: string };
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
    () => import("@intentius/chant-lexicon-terraform/compose"),
    (m) => (has(m, "compositionFor", "moduleNames", "readOrder") ? (m as unknown as ChantCompose) : undefined),
  ),
  composeRun: once<ChantComposeRun>(
    // One subpath at a time, for the reason inTurn gives.
    async () => {
      const run: object = await import("@intentius/chant-lexicon-terraform/compose/run");
      const estate: object = await import("@intentius/chant-lexicon-terraform/compose/estate");
      const root: object = await import("@intentius/chant-lexicon-terraform/compose/root");
      const slice: object = await import("@intentius/chant-lexicon-terraform/compose/slice");
      return { ...slice, ...root, ...estate, ...run };
    },
    (m) => (has(m, "ComposedRun", "EstateRun", "writeEstateRoot", "moduleValues") ? (m as unknown as ChantComposeRun) : undefined),
  ),
  state: once<ChantState>(
    () => import("@intentius/chant-lexicon-terraform/state"),
    (m) => (has(m, "takeLocksWithSources", "SourceLockedError", "StateLockedError") ? (m as unknown as ChantState) : undefined),
  ),
  planShape: once<ChantPlanShape>(
    () => import("@intentius/chant-lexicon-terraform/plan-shape"),
    (m) => (has(m, "terraformPlanShape") ? (m as unknown as ChantPlanShape) : undefined),
  ),
  checkHooks: once<ChantCheckHooks>(
    () => import("@intentius/chant/components/check-hooks"),
    (m) => (has(m, "runCheckHooks", "writeCiHook") && typeof m.CI_CHECK_HOOK_FLOOR === "string" ? (m as unknown as ChantCheckHooks) : undefined),
  ),
  bucketCheck: once<ChantBucketCheck>(
    () => import("@intentius/chant/bucket-check"),
    (m) => (has(m, "checkBucket", "BucketCheckError") ? (m as unknown as ChantBucketCheck) : undefined),
  ),
  tf046: once<ChantTf046>(
    () => import("@intentius/chant-lexicon-terraform/lint/post-synth/tf046"),
    (m) => {
      const check = m.tf046 as PostSynthCheck | undefined;
      return check?.id === "TF046" && typeof check.check === "function" && has(m, "checkLocalRecordStore") ? (m as unknown as ChantTf046) : undefined;
    },
  ),
  moduleCatalog: once<ChantModuleCatalog>(
    () => import("@intentius/chant-lexicon-terraform/module-catalog"),
    (m) => (has(m, "moduleCompatibility") && typeof m.MODULE_COMPATIBILITY_PAGE === "string" && typeof m.MODULE_CATALOG_SOURCE === "object" ? (m as unknown as ChantModuleCatalog) : undefined),
  ),
  ciControl: once<ChantCiControl>(
    () => import("@intentius/chant/ci-control"),
    // chant#4568's own feature-detect: these three present means the rest is too.
    (m) => (has(m, "controlDispatchRequest", "putControlEntry", "reconcileProjects") && has(m, "resolveControlTarget", "controlDispatchScript", "gitControlLedger", "readControlEntries", "retireControlEntry", "importControlConfig", "estateClaims") ? (m as unknown as ChantCiControl) : undefined),
  ),
  controlPipelineGithub: once<ChantControlPipeline>(
    () => import("@intentius/chant-lexicon-github/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  controlPipelineGitlab: once<ChantControlPipeline>(
    () => import("@intentius/chant-lexicon-gitlab/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  controlPipelineForgejo: once<ChantControlPipeline>(
    () => import("@intentius/chant-lexicon-forgejo/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  opWaveStep: once<ChantOpWaveStep>(
    () => import("@intentius/chant/op/op-waves-capability"),
    (m) => (has(m, "opWaveStepProblems", "opWaveHoldsProblems", "planOpWaveStep", "applyOpWaveStep") ? (m as unknown as ChantOpWaveStep) : undefined),
  ),
  waveCapabilities: once<ChantWaveCapabilities>(
    async () => {
      const core: Record<string, unknown> = await import("@intentius/chant/components/capability");
      const lexicon: Record<string, unknown> = await import("@intentius/chant-lexicon-terraform/components/capability-plugin");
      const Registry = core.CapabilityRegistry as (new () => { register(c: unknown): unknown; has(kind: string): boolean }) | undefined;
      const capability = lexicon.terraformApplyCapability as { kind?: string } | undefined;
      if (!Registry || capability?.kind !== "terraform-apply") return {};
      const registry = new Registry();
      registry.register(capability);
      return { registry };
    },
    (m) => (m.registry ? (m as unknown as ChantWaveCapabilities) : undefined),
  ),
  registryProxies: once<ChantRegistryProxies>(
    () => import("@intentius/chant-lexicon-terraform/registry"),
    (m) => (has(m, "artifactoryProxy", "nexusProxy", "moduleThroughProxy", "providerThroughProxy", "registryLocation", "fetchTarball") ? (m as unknown as ChantRegistryProxies) : undefined),
  ),
  forgeCheck: once<ChantForgeCheck>(
    () => import("@intentius/chant/forge-check"),
    (m) => (has(m, "forgeCheck", "readRepository", "readOnly", "describeForgeCheck", "forgeCheckExit") ? (m as unknown as ChantForgeCheck) : undefined),
  ),
  notifyRelay: once<ChantNotifyRelay>(
    () => import("@intentius/chant/notify-relay"),
    (m) => (has(m, "verifySlackRequest", "verifyTeamsRequest", "relayPrincipalFor", "slackRelayClick", "teamsRelayClick", "decideRelayClick") && typeof m.RELAY_ENV === "object" ? (m as unknown as ChantNotifyRelay) : undefined),
  ),
  ciEstate: once<ChantCiEstate>(
    () => import("@intentius/chant/ci-estate"),
    // chant#4612's own feature-detect: buildLedgerEstate present means the rest is too.
    (m) => (has(m, "buildLedgerEstate", "readEstateLedger", "deliveryGauges") && typeof m.CI_ESTATE_FLOOR === "string" ? (m as unknown as ChantCiEstate) : undefined),
  ),
  policySource: once<ChantPolicySource>(
    () => import("@intentius/chant/policy-source"),
    (m) => (has(m, "assertGatePolicySource", "fetchGatePolicySource") && typeof m.CI_POLICY_SOURCE_FLOOR === "string" ? (m as unknown as ChantPolicySource) : undefined),
  ),
  opStandDown: once<ChantOpStandDown>(
    // `op` is on the pin; the stand-down (chant#4581) is told apart by its exports.
    () => import("@intentius/chant/op"),
    (m) => (has(m, "newerCommitOnBranch", "tipAppliesTargets") && typeof m.OP_WAVE_STAND_DOWN_FLOOR === "string" ? (m as unknown as ChantOpStandDown) : undefined),
  ),
  sourceForms: once<ChantSourceForms>(
    () => import("@intentius/chant-lexicon-terraform/registry"),
    (m) => (has(m, "moduleSourceForms", "providerAddressForms", "usedSources", "lockedProviders") ? (m as unknown as ChantSourceForms) : undefined),
  ),
  objectStore: once<ChantObjectStore>(
    () => import("@intentius/chant/object-store"),
    (m) => {
      if (!has(m, "storeFromEnv", "S3Client", "GcsClient", "AzureBlobClient", "StoreError", "StoreConflict")) return undefined;
      const store = m as unknown as ChantObjectStore;
      // A chant client throws chant's errors: terragucci's StoreError and StoreConflict take them as their own.
      adoptChantStoreErrors(store.StoreError, store.StoreConflict);
      return store;
    },
  ),
  stateOps: once<ChantStateOps>(
    async () => {
      const ops: object = await import("@intentius/chant-lexicon-terraform/state-ops");
      const requests: object = await import("@intentius/chant/lifecycle/gated-request");
      return { ...requests, ...ops };
    },
    (m) => (has(m, "gatedStateOp", "forceUnlockState", "pushStateFile", "planStateCheck", "planCopy", "applyPlanFile", "readGatedRequests") ? (m as unknown as ChantStateOps) : undefined),
  ),
  lockRows: once<ChantLockRows>(
    async () => {
      const leases: object = await import("@intentius/chant/lifecycle/resource-lock");
      const rows: object = await import("@intentius/chant-lexicon-terraform/lock-rows");
      return { ...leases, ...rows };
    },
    (m) => (has(m, "terraformLockRows", "takeLockRows", "releaseLockRows", "readLockRows", "lockRowsPath") ? (m as unknown as ChantLockRows) : undefined),
  ),
  productMcp: once<ChantProductMcp>(
    () => import("@intentius/chant/ci-product"),
    (m) => (has(m, "runChantInProcess") && typeof m.PRODUCT_MCP_HOOK_FLOOR === "string" ? (m as unknown as ChantProductMcp) : undefined),
  ),
  changelog: once<ChantChangelog>(
    () => import("@intentius/chant/lifecycle/release-changelog"),
    (m) => (has(m, "changelogBump") ? (m as unknown as ChantChangelog) : undefined),
  ),
  agentRuns: once<ChantAgentRuns>(
    async () => {
      const agent: object = await import("@intentius/chant/ci-agent");
      const runs: object = await import("@intentius/chant/lifecycle/run-ledger");
      const git: object = await import("@intentius/chant/lifecycle/git");
      return { ...git, ...runs, ...agent };
    },
    // chant#4616's agent module: agentRunRecordInput and landAgentChange present means the job is there.
    (m) => (has(m, "agentRunRecordInput", "landAgentChange", "appendRunRecord", "pushLifecycleReport") ? (m as unknown as ChantAgentRuns) : undefined),
  ),
  agentJob: once<ChantAgentJob>(
    async () => {
      const product: Record<string, unknown> = await import("@intentius/chant/ci-product");
      const words: Record<string, unknown> = await import("@intentius/chant/ci-product-words");
      const github: Record<string, unknown> = await import("@intentius/chant-lexicon-github/components/generate-op-pipeline");
      const gitlab: Record<string, unknown> = await import("@intentius/chant-lexicon-gitlab/components/generate-op-pipeline");
      const forgejo: Record<string, unknown> = await import("@intentius/chant-lexicon-forgejo/components/generate-op-pipeline");
      return {
        CI_AGENT_FLOOR: product.CI_AGENT_FLOOR,
        productPipelineJobs: product.productPipelineJobs,
        productDriftAgent: product.productDriftAgent,
        setActiveProductWords: words.setActiveProductWords,
        generate: { github: github.generateGithubOpPipeline, gitlab: gitlab.generateGitlabOpPipeline, forgejo: forgejo.generateForgejoOpPipeline },
      };
    },
    // chant#4616's feature-detect: CI_AGENT_FLOOR on the ci-product entry, with the generators that read a spec's `agent`.
    (m) => {
      const g = m.generate as Record<string, unknown> | undefined;
      return typeof m.CI_AGENT_FLOOR === "string" && has(m, "productPipelineJobs", "productDriftAgent", "setActiveProductWords") && g && has(g, "github", "gitlab", "forgejo") ? (m as unknown as ChantAgentJob) : undefined;
    },
  ),
  holdRecord: once<ChantHoldRecord>(
    () => import("@intentius/chant/lifecycle/gated-request"),
    // chant#4623's feature-detect: an op-wave hold with `record: true` gets chant's applied and finished lines and keeps its attachment.
    (m) => (typeof m.OP_WAVE_HOLD_RECORD_FLOOR === "string" && has(m, "gatedRequestAttachmentPath") ? (m as unknown as ChantHoldRecord) : undefined),
  ),
  requestProof: once<ChantRequestProof>(
    async () => {
      const requests: Record<string, unknown> = await import("@intentius/chant/lifecycle/gated-request");
      const git: Record<string, unknown> = await import("@intentius/chant/lifecycle/git");
      return { gatedRequestAttachmentPath: requests.gatedRequestAttachmentPath, readBlobFromPath: git.readBlobFromPath };
    },
    (m) => (has(m, "gatedRequestAttachmentPath", "readBlobFromPath") ? (m as unknown as ChantRequestProof) : undefined),
  ),
  gateWriters: once<ChantGateWriters>(
    async () => {
      const requests: Record<string, unknown> = await import("@intentius/chant/lifecycle/gated-request");
      const gate: Record<string, unknown> = await import("@intentius/chant/op/gate");
      const git: Record<string, unknown> = await import("@intentius/chant/lifecycle/git");
      const note: Record<string, unknown> = await import("@intentius/chant/lifecycle/local-note");
      return { OP_WAVE_HOLD_RECORD_FLOOR: requests.OP_WAVE_HOLD_RECORD_FLOOR, gitGateLedgerPort: gate.gitGateLedgerPort, writeBlobToPath: git.writeBlobToPath, pushLifecycleReport: git.pushLifecycleReport, requireLifecycleLedger: git.requireLifecycleLedger, isLifecycleLocalNote: note.isLifecycleLocalNote };
    },
    (m) => (typeof m.OP_WAVE_HOLD_RECORD_FLOOR === "string" && has(m, "gitGateLedgerPort", "writeBlobToPath", "pushLifecycleReport", "requireLifecycleLedger", "isLifecycleLocalNote") ? (m as unknown as ChantGateWriters) : undefined),
  ),
  releaseRead: once<ChantReleaseRead>(
    () => import("@intentius/chant/lifecycle/release-ledger"),
    (m) => (has(m, "releaseLedgerLines", "parseReleaseLedger") ? (m as unknown as ChantReleaseRead) : undefined),
  ),
  templateRequest: once<ChantTemplateRequests>(
    // @ts-ignore: chant#4651's subpath, newer than the pin
    () => import("@intentius/chant/template-request"),
    (m) => (has(m, "makeTemplateRequest", "checkTemplateRequest", "requestBranch", "requestBody", "templateName", "parseTemplateSpec") && typeof m.TEMPLATE_REQUEST_FLOOR === "string" ? (m as unknown as ChantTemplateRequests) : undefined),
  ),
  templateRender: once<ChantTemplateRender>(
    // @ts-ignore: chant#4652's subpath, newer than the pin
    () => import("@intentius/chant-lexicon-terraform/template"),
    (m) => (has(m, "renderAppRoot", "terraformInputType", "TemplateRenderError") ? (m as unknown as ChantTemplateRender) : undefined),
  ),
};

export type ChantNextPart = keyof typeof loaders;

/** Set by a test: what each part loads to, in place of the import. `null` makes it missing. */
const overrides = new Map<ChantNextPart, unknown>();

/** What each part came to once its import settled, for the synchronous callers below. `null`: missing. */
const settled = new Map<ChantNextPart, unknown>();

async function load<K extends ChantNextPart>(part: K): Promise<Awaited<ReturnType<(typeof loaders)[K]>>> {
  if (overrides.has(part)) return (overrides.get(part) ?? undefined) as Awaited<ReturnType<(typeof loaders)[K]>>;
  const m = (await loaders[part]()) as Awaited<ReturnType<(typeof loaders)[K]>>;
  settled.set(part, m ?? null);
  return m;
}

/** A part as it already loaded, without waiting: undefined when it is missing or has not been asked for yet. */
function loaded<K extends ChantNextPart>(part: K): Awaited<ReturnType<(typeof loaders)[K]>> | undefined {
  if (overrides.has(part)) return (overrides.get(part) ?? undefined) as Awaited<ReturnType<(typeof loaders)[K]>>;
  return (settled.get(part) ?? undefined) as Awaited<ReturnType<(typeof loaders)[K]>> | undefined;
}

/** chant's composition (`/compose`), or undefined when the installed chant has none. */
export const chantCompose = (): Promise<ChantCompose | undefined> => load("compose");
/** chant's composed and estate runs (`/compose/run`, `/compose/estate`, `/compose/root`, `/compose/slice`), or undefined. */
export const chantComposeRun = (): Promise<ChantComposeRun | undefined> => load("composeRun");
/** chant's lock code (`/state`), or undefined. */
export const chantState = (): Promise<ChantState | undefined> => load("state");
/** chant's plan shape (`/plan-shape`), or undefined. */
export const chantPlanShape = (): Promise<ChantPlanShape | undefined> => load("planShape");
/** chant core's object store clients (`@intentius/chant/object-store`, chant#4554), or undefined. */
export const chantObjectStore = (): Promise<ChantObjectStore | undefined> => load("objectStore");

/** chant's check moment (`/components/check-hooks`, chant#4556), or undefined. */
export const chantCheckHooks = (): Promise<ChantCheckHooks | undefined> => load("checkHooks");

/** chant core's shared bucket check (`@intentius/chant/bucket-check`, chant#4558), or undefined. */
export const chantBucketCheck = (): Promise<ChantBucketCheck | undefined> => load("bucketCheck");

/** The terraform lexicon's TF046 (chant#4561), or undefined. */
export const chantTf046 = (): Promise<ChantTf046 | undefined> => load("tf046");

/** The terraform lexicon's known-module catalog (`module-catalog`, chant#4560), or undefined. */
export const chantModuleCatalog = (): Promise<ChantModuleCatalog | undefined> => load("moduleCatalog");

/** chant's op-wave step contract (chant#4545), or undefined. */
export const chantOpWaveStep = (): Promise<ChantOpWaveStep | undefined> => load("opWaveStep");
/** A registry with `terraform-apply` for a wave run in this process (chant#4545, ruling C), or undefined. */
export const chantWaveCapabilities = (): Promise<ChantWaveCapabilities | undefined> => load("waveCapabilities");
/** The terraform lexicon's source reading and forms (chant#3924), or undefined. */
export const chantSourceForms = (): Promise<ChantSourceForms | undefined> => load("sourceForms");
/** The source forms as they already loaded, for the synchronous matchers in ./sources.ts. */
export const chantSourceFormsNow = (): ChantSourceForms | undefined => loaded("sourceForms");
/** The terraform lexicon's registry proxies (chant#4606), or undefined. */
export const chantRegistryProxies = (): Promise<ChantRegistryProxies | undefined> => load("registryProxies");
/** The terraform lexicon's state operations with chant's gated requests (chant#4618, #4551), or undefined. */
export const chantStateOps = (): Promise<ChantStateOps | undefined> => load("stateOps");
/** chant's recorded op-wave hold (chant#4623), or undefined on a chant whose hold writes no applied or finished line. */
export const chantHoldRecord = (): Promise<ChantHoldRecord | undefined> => load("holdRecord");
/** chant's reader of a gated request's stored proof (chant#4551, #4623), or undefined. */
export const chantRequestProof = (): Promise<ChantRequestProof | undefined> => load("requestProof");
/** chant's gate ledger writers (terragucci#1282 part j), or undefined on a chant before chant#4623, where terragucci writes its own lines. */
export const chantGateWriters = (): Promise<ChantGateWriters | undefined> => load("gateWriters");
/** chant's row leases and the lexicon's rows (chant#4552, #4594), or undefined. */
export const chantLockRows = (): Promise<ChantLockRows | undefined> => load("lockRows");
/** chant's in-process CLI with the product tool hook (chant#4555), or undefined. */
export const chantProductMcp = (): Promise<ChantProductMcp | undefined> => load("productMcp");
/** chant's changelog bump (chant#4597) as it already loaded, for the synchronous `bumpFor`. preloadChantNext loads it. */
export const chantChangelogNow = (): ChantChangelog | undefined => loaded("changelog");
/** chant's release record reader as it already loaded, for the synchronous ledger reads of another remote. preloadChantNext loads it. */
export const chantReleaseReadNow = (): ChantReleaseRead | undefined => loaded("releaseRead");
/** chant's agent run record and run ledger (chant#4616), or undefined. */
export const chantAgentRuns = (): Promise<ChantAgentRuns | undefined> => load("agentRuns");
/** chant's agent job (chant#4616), or undefined. init loads it before it renders the pipeline. */
export const chantAgentJob = (): Promise<ChantAgentJob | undefined> => load("agentJob");
/** The agent job as it already loaded, for the synchronous renderer (./render-chant-agent.ts). */
export const chantAgentJobNow = (): ChantAgentJob | undefined => loaded("agentJob");

/**
 * Load the parts synchronous code reads, once, before a command runs. cli.ts
 * calls it.
 */
export async function preloadChantNext(): Promise<void> {
  await chantPolicySource();
  await chantOpStandDown();
  await load("changelog");
  await load("releaseRead");
}

/** chant core's forge and trust-policy check (chant#4608), or undefined. */
export const chantForgeCheck = (): Promise<ChantForgeCheck | undefined> => load("forgeCheck");
/** The forge check as it already loaded, for `describeForgeCheck`. */
export const chantForgeCheckNow = (): ChantForgeCheck | undefined => loaded("forgeCheck");
/** chant core's notify relay (chant#4611), or undefined. */
export const chantNotifyRelay = (): Promise<ChantNotifyRelay | undefined> => load("notifyRelay");
/** chant core's ledger estate and delivery metrics (chant#4612), or undefined. */
export const chantCiEstate = (): Promise<ChantCiEstate | undefined> => load("ciEstate");
/** chant core's shared policy source (chant#4613), or undefined. */
export const chantPolicySource = (): Promise<ChantPolicySource | undefined> => load("policySource");
/** The policy source as it already loaded, for the synchronous fetch in ./report/policy.ts. cli.ts loads it first. */
export const chantPolicySourceNow = (): ChantPolicySource | undefined => loaded("policySource");
/** chant's op-wave stand-down (chant#4581), or undefined. */
export const chantOpStandDown = (): Promise<ChantOpStandDown | undefined> => load("opStandDown");
/** The stand-down as it already loaded, for the synchronous spec builder in ./chant-waves.ts. cli.ts loads it first. */
export const chantOpStandDownNow = (): ChantOpStandDown | undefined => loaded("opStandDown");

/** chant core's control repo (`@intentius/chant/ci-control`, chant#4568), or undefined. */
export const chantCiControl = (): Promise<ChantCiControl | undefined> => load("ciControl");
/** chant's control repo as it already loaded, for the synchronous script builders (./control-repo.ts). init loads it first. */
export const chantCiControlNow = (): ChantCiControl | undefined => loaded("ciControl");
/** The forge lexicon's control repo pipeline (chant#4568), or undefined. */
export function chantControlPipeline(forge: "github" | "gitlab" | "forgejo"): Promise<ChantControlPipeline | undefined> {
  return load(forge === "github" ? "controlPipelineGithub" : forge === "gitlab" ? "controlPipelineGitlab" : "controlPipelineForgejo");
}

/** chant core's template request (`@intentius/chant/template-request`, chant#4651), or undefined. */
export const chantTemplateRequests = (): Promise<ChantTemplateRequests | undefined> => load("templateRequest");
/** The terraform lexicon's template rendering (`@intentius/chant-lexicon-terraform/template`, chant#4652), or undefined. */
export const chantTemplateRender = (): Promise<ChantTemplateRender | undefined> => load("templateRender");

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
  const [compose, composeRun, state, planShape, objectStore, checkHooks, bucketCheck, tf046, moduleCatalog, ciControl, controlPipelineGithub, controlPipelineGitlab, controlPipelineForgejo, opWaveStep, waveCapabilities] = await Promise.all([chantCompose(), chantComposeRun(), chantState(), chantPlanShape(), chantObjectStore(), chantCheckHooks(), chantBucketCheck(), chantTf046(), chantModuleCatalog(), chantCiControl(), chantControlPipeline("github"), chantControlPipeline("gitlab"), chantControlPipeline("forgejo"), chantOpWaveStep(), chantWaveCapabilities()]);
  const registryProxies = await chantRegistryProxies();
  const sourceForms = await chantSourceForms();
  const [forgeCheck, notifyRelay, ciEstate, policySource, opStandDown] = [await chantForgeCheck(), await chantNotifyRelay(), await chantCiEstate(), await chantPolicySource(), await chantOpStandDown()];
  const [stateOps, lockRows, productMcp, changelog, releaseRead] = [await chantStateOps(), await chantLockRows(), await chantProductMcp(), await load("changelog"), await load("releaseRead")];
  const agentRuns = await chantAgentRuns();
  const agentJob = await chantAgentJob();
  const holdRecord = await chantHoldRecord();
  const gateWriters = await chantGateWriters();
  const requestProof = await chantRequestProof();
  const templateRequest = await chantTemplateRequests();
  const templateRender = await chantTemplateRender();
  return { compose: !!compose, composeRun: !!composeRun, state: !!state, planShape: !!planShape, objectStore: !!objectStore, checkHooks: !!checkHooks, bucketCheck: !!bucketCheck, tf046: !!tf046, moduleCatalog: !!moduleCatalog, ciControl: !!ciControl, controlPipelineGithub: !!controlPipelineGithub, controlPipelineGitlab: !!controlPipelineGitlab, controlPipelineForgejo: !!controlPipelineForgejo, opWaveStep: !!opWaveStep, waveCapabilities: !!waveCapabilities, registryProxies: !!registryProxies, forgeCheck: !!forgeCheck, notifyRelay: !!notifyRelay, ciEstate: !!ciEstate, policySource: !!policySource, opStandDown: !!opStandDown, sourceForms: !!sourceForms, stateOps: !!stateOps, lockRows: !!lockRows, productMcp: !!productMcp, changelog: !!changelog, releaseRead: !!releaseRead, agentRuns: !!agentRuns, agentJob: !!agentJob, holdRecord: !!holdRecord, gateWriters: !!gateWriters, requestProof: !!requestProof, templateRequest: !!templateRequest, templateRender: !!templateRender };
}
