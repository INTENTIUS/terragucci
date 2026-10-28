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
 * chant core's Terraform token reader (`@intentius/chant/terraform/credentials`,
 * chant#4563) is newer than the pin: ./state-source.ts keeps its own lookup
 * as the fallback.
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
 * Newer than the pin too (chant#4550, terragucci#1282): the product pipeline,
 * `@intentius/chant/ci-product`, and its words module, which imports nothing
 * (`ci-product-words`). With them terragucci's words (./ci-words.ts) go
 * through chant: the comment grammar (`parseProductComment`, ./comment.ts),
 * the approve line (`approveLine`, ./report/marker.ts), the status contexts,
 * and the pipeline's comment conditions and waves names
 * (`productPipelineJobs`, ./render.ts). Without them terragucci's own code
 * gives the same names.
 *
 * Newer than the pin too (chant#4568, terragucci#1282): the control repo in
 * chant core, `@intentius/chant/ci-control`, and each forge lexicon's
 * `components/control-pipeline`. With them the member's dispatch, the control
 * repo's pipeline, its entries on the ledger and reconcile are chant's
 * (./control-repo.ts, ./control-records.ts, ./reconcile.ts). Without them
 * terragucci's own code runs, with its record files.
 *
 * Newer than the pin too (terragucci#1282 part e): chant's exit-code table
 * (`exit-codes`, chant#4553), which terragucci passes through; the
 * terraform lexicon's drift rows (`drift-rows`, chant#4580), which count and
 * name the drift report's objects; chant's pull request environment ledger
 * (`components/pr-env-ledger`, chant#4551); the op-wave step contract
 * (`op/op-waves-capability`, chant#4545) with the terraform lexicon's
 * `terraform-apply` capability passed in process; and chant's OTLP exporter
 * (`otlp`, chant#4555). The review agent's tag list (chant#4580) and the
 * object store's setting hints (chant#4584) are told apart by what the
 * installed module exports, on subpaths the pin already has.
 *
 * The types below are the part of chant's contract terragucci calls, written
 * out so the code compiles against a chant without them. Each `import()`
 * carries a `@ts-ignore` for the same reason; scripts/cli-bundle.mjs stands
 * in a module that throws for a subpath the installed chant lacks, so the
 * bundle builds either way.
 */
import { checkoutScript as chantCheckoutScript, handoverTrap as chantHandoverTrap, packJs as chantPackJs, type HandoverForge } from "@intentius/chant/ci-handover";
import type { DriverComponent } from "@intentius/chant/components";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
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

// ── terraform/credentials ──────────────────────────────────────────────────

/**
 * chant core's token reader (`@intentius/chant/terraform/credentials`,
 * chant#4563): the token Terraform and OpenTofu send to a host, from
 * `TF_TOKEN_<host>`, a `credentials` block in the CLI config, or
 * credentials.tfrc.json. ./state-source.ts keeps its own copy as the fallback.
 */
export interface ChantCredentials {
  terraformCredential(host: string, options?: { env?: Record<string, string | undefined> }): { token: string; from: string } | undefined;
  tokenVariable(host: string): string | undefined;
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

/** A comment read against a product's grammar (`ParsedProductComment`). */
export type ChantParsedProductComment =
  | { kind: "plan"; member?: string }
  | { kind: "apply"; wave?: number }
  | { kind: "lock" }
  | { kind: "unlock" }
  | { kind: "agent"; ask: string }
  | { kind: "refused"; reason: string };

/** chant's words module (`@intentius/chant/ci-product-words`): imports nothing, so every command may load it. */
export interface ChantCiProductWords {
  assertProductWords(input: object, options?: { jobs?: readonly ChantProductCommand[] }): ChantProductWords;
  approveLine(words: ChantProductWords, input: { op: string; gate: string; digest: string; approver?: string; sign?: boolean; target?: string }): string;
  parseProductComment(words: ChantProductWords, body: unknown, env?: Record<string, string | undefined>): ChantParsedProductComment | undefined;
  productStatusContext(words: ChantProductWords, stage: ChantProductStage, member?: string): string;
  commentLine(words: ChantProductWords, command: ChantProductCommand): string | undefined;
}

/** What `productPipelineJobs` gives back, as far as terragucci reads it. */
export interface ChantProductPipelineJobs {
  words: ChantProductWords;
  comments: Partial<Record<ChantProductCommand, string>>;
  waves?: { spec: { name: string; op: string; gateName?: string }; specFile: string; jobs: unknown[] };
}

/** chant's product pipeline (`@intentius/chant/ci-product`, chant#4550). */
export interface ChantCiProduct extends ChantCiProductWords {
  productPipelineJobs(
    forge: "github" | "gitlab" | "forgejo",
    env: string,
    options: { words: object; waves?: object; applyBeforeMerge?: boolean; locks?: "plan"; agent?: boolean; member?: string },
  ): ChantProductPipelineJobs;
  productWavesSpec<S extends object>(spec: S, words: object): S;
  CI_PRODUCT_FLOOR: string;
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

// ── part e: exit codes, drift rows, pr-env ledger, wave step, otlp ─────────

/** chant's exit-code table (`@intentius/chant/exit-codes`, chant#4553). */
export interface ChantExitCodes {
  CHANT_EXIT: { done: 0; failed: 1; drift: 2; waiting: 3; moved: 4; held: 5; superseded: 6; denied: 7; declined: 8 };
  chantExitName(code: number): string | undefined;
}

/** The terraform lexicon's drift rows (`drift-rows`, chant#4580), with terragucci's counting rules. */
export interface ChantDriftRows {
  terraformPlanDriftRows(plan: unknown, options?: { live?: boolean }): { address: string; action: string; type?: string; name?: string }[];
  terraformPlanDriftCount(plan: unknown, options?: { live?: boolean }): number;
  terraformPlanDriftNames(plan: unknown, options?: { live?: boolean }): Map<string, string>;
}

/** chant's `_pr-envs/records.jsonl` writer (`components/pr-env-ledger`, chant#4551). */
export interface ChantPrEnvLedger {
  appendPrEnvRecord(record: unknown, opts?: { cwd?: string }): Promise<{ commit: string }>;
  PR_ENV_APPEND_FLOOR: string;
}

/** The part of chant's `lifecycle/git` the pr-env writer needs after it appends. */
export interface ChantLifecycleGit {
  pushLifecycleReport(opts?: { cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }>;
}

/** chant's op-wave step contract (`op/op-waves-capability`, chant#4545). */
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

/** chant's OTLP exporter (`@intentius/chant/otlp`, chant#4555). */
export interface ChantOtlp {
  otlpFromEnv(env?: NodeJS.ProcessEnv, opts?: { prefix?: string }): { prefix: string } | undefined;
  OTLP_EXPORTER_FLOOR: string;
  configureOtlp?(opts: { prefix?: string }): unknown;
  /** One OTLP/JSON POST: the problem, or undefined when the collector took it. Never throws. */
  sendOtlp(
    target: { url: string; headers: Record<string, string> },
    body: unknown,
    fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  ): Promise<string | undefined>;
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
  checkHooks: once<ChantCheckHooks>(
    // @ts-ignore chant 0.124.54 has no components/check-hooks subpath (chant#4556)
    () => import("@intentius/chant/components/check-hooks"),
    (m) => (has(m, "runCheckHooks", "writeCiHook") && typeof m.CI_CHECK_HOOK_FLOOR === "string" ? (m as unknown as ChantCheckHooks) : undefined),
  ),
  credentials: once<ChantCredentials>(
    // @ts-ignore chant 0.124.54 has no terraform/credentials subpath (chant#4563)
    () => import("@intentius/chant/terraform/credentials"),
    (m) => (has(m, "terraformCredential", "tokenVariable") ? (m as unknown as ChantCredentials) : undefined),
  ),
  bucketCheck: once<ChantBucketCheck>(
    // @ts-ignore chant 0.124.54 has no bucket-check subpath (chant#4558)
    () => import("@intentius/chant/bucket-check"),
    (m) => (has(m, "checkBucket", "BucketCheckError") ? (m as unknown as ChantBucketCheck) : undefined),
  ),
  tf046: once<ChantTf046>(
    // @ts-ignore chant 0.124.54 has no TF046 (chant#4561)
    () => import("@intentius/chant-lexicon-terraform/lint/post-synth/tf046"),
    (m) => {
      const check = m.tf046 as PostSynthCheck | undefined;
      return check?.id === "TF046" && typeof check.check === "function" && has(m, "checkLocalRecordStore") ? (m as unknown as ChantTf046) : undefined;
    },
  ),
  ciProductWords: once<ChantCiProductWords>(
    // @ts-ignore chant 0.124.54 has no ci-product-words module (chant#4550)
    () => import("@intentius/chant/ci-product-words"),
    (m) => (has(m, "assertProductWords", "approveLine", "parseProductComment", "productStatusContext", "commentLine") ? (m as unknown as ChantCiProductWords) : undefined),
  ),
  ciProduct: once<ChantCiProduct>(
    // @ts-ignore chant 0.124.54 has no ci-product subpath (chant#4550)
    () => import("@intentius/chant/ci-product"),
    // chant#4550's own feature-detect: these three present means the rest is too.
    (m) => (has(m, "productPipelineJobs", "approveLine", "assertProductWords") && has(m, "parseProductComment", "productStatusContext", "commentLine", "productWavesSpec") ? (m as unknown as ChantCiProduct) : undefined),
  ),
  ciControl: once<ChantCiControl>(
    // @ts-ignore chant 0.124.54 has no ci-control subpath (chant#4568)
    () => import("@intentius/chant/ci-control"),
    // chant#4568's own feature-detect: these three present means the rest is too.
    (m) => (has(m, "controlDispatchRequest", "putControlEntry", "reconcileProjects") && has(m, "resolveControlTarget", "controlDispatchScript", "gitControlLedger", "readControlEntries", "retireControlEntry", "importControlConfig", "estateClaims") ? (m as unknown as ChantCiControl) : undefined),
  ),
  controlPipelineGithub: once<ChantControlPipeline>(
    // @ts-ignore chant 0.124.54 has no components/control-pipeline in the github lexicon (chant#4568)
    () => import("@intentius/chant-lexicon-github/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  controlPipelineGitlab: once<ChantControlPipeline>(
    // @ts-ignore chant 0.124.54 has no components/control-pipeline in the gitlab lexicon (chant#4568)
    () => import("@intentius/chant-lexicon-gitlab/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  controlPipelineForgejo: once<ChantControlPipeline>(
    // @ts-ignore chant 0.124.54 has no components/control-pipeline in the forgejo lexicon (chant#4568)
    () => import("@intentius/chant-lexicon-forgejo/components/control-pipeline"),
    (m) => (has(m, "generateControlPipeline") ? (m as unknown as ChantControlPipeline) : undefined),
  ),
  exitCodes: once<ChantExitCodes>(
    // @ts-ignore chant 0.124.54 has no exit-codes subpath (chant#4553)
    () => import("@intentius/chant/exit-codes"),
    (m) => {
      const t = m.CHANT_EXIT as Record<string, unknown> | undefined;
      return t && t.moved === 4 && t.denied === 7 && has(m, "chantExitName") ? (m as unknown as ChantExitCodes) : undefined;
    },
  ),
  driftRows: once<ChantDriftRows>(
    // @ts-ignore chant 0.124.54 has no drift-rows subpath (chant#4580)
    () => import("@intentius/chant-lexicon-terraform/drift-rows"),
    (m) => (has(m, "terraformPlanDriftRows", "terraformPlanDriftCount", "terraformPlanDriftNames") ? (m as unknown as ChantDriftRows) : undefined),
  ),
  prEnvLedger: once<ChantPrEnvLedger & ChantLifecycleGit>(
    async () => {
      // @ts-ignore chant 0.124.54 has no components/pr-env-ledger subpath (chant#4551)
      const ledger: object = await import("@intentius/chant/components/pr-env-ledger");
      const git: object = await import("@intentius/chant/lifecycle/git");
      return { ...git, ...ledger };
    },
    (m) => (has(m, "appendPrEnvRecord", "pushLifecycleReport") ? (m as unknown as ChantPrEnvLedger & ChantLifecycleGit) : undefined),
  ),
  opWaveStep: once<ChantOpWaveStep>(
    // @ts-ignore chant 0.124.54 has no op/op-waves-capability subpath (chant#4545)
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
  otlp: once<ChantOtlp>(
    // @ts-ignore chant 0.124.54 has no otlp subpath (chant#4555)
    () => import("@intentius/chant/otlp"),
    (m) => (has(m, "otlpFromEnv", "sendOtlp") && typeof m.OTLP_EXPORTER_FLOOR === "string" ? (m as unknown as ChantOtlp) : undefined),
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
/** chant's module registry protocol (`/registry`, chant#4565), or undefined. */
export const chantRegistry = (): Promise<ChantRegistry | undefined> => load("registry");
/** chant core's Terraform token reader (`@intentius/chant/terraform/credentials`, chant#4563), or undefined. */
export const chantCredentials = (): Promise<ChantCredentials | undefined> => load("credentials");
/** chant core's object store clients (`@intentius/chant/object-store`, chant#4554), or undefined. */
export const chantObjectStore = (): Promise<ChantObjectStore | undefined> => load("objectStore");

/** chant's check moment (`/components/check-hooks`, chant#4556), or undefined. */
export const chantCheckHooks = (): Promise<ChantCheckHooks | undefined> => load("checkHooks");

/** chant core's shared bucket check (`@intentius/chant/bucket-check`, chant#4558), or undefined. */
export const chantBucketCheck = (): Promise<ChantBucketCheck | undefined> => load("bucketCheck");

/** The terraform lexicon's TF046 (chant#4561), or undefined. */
export const chantTf046 = (): Promise<ChantTf046 | undefined> => load("tf046");

/** chant's words module (`@intentius/chant/ci-product-words`, chant#4550), or undefined. */
export const chantCiProductWords = (): Promise<ChantCiProductWords | undefined> => load("ciProductWords");
/** chant's product pipeline (`@intentius/chant/ci-product`, chant#4550), or undefined. */
export const chantCiProduct = (): Promise<ChantCiProduct | undefined> => load("ciProduct");
/**
 * chant's words module as it already loaded: the synchronous parsers and
 * line builders read it. cli.ts loads it before any command runs; a caller
 * that never loaded it gets undefined, and terragucci's own code.
 */
export const chantCiProductWordsNow = (): ChantCiProductWords | undefined => loaded("ciProductWords");

/** chant's exit-code table (chant#4553), or undefined. */
export const chantExitCodes = (): Promise<ChantExitCodes | undefined> => load("exitCodes");
/** chant's exit-code table as it already loaded, for the synchronous exit paths. cli.ts loads it first. */
export const chantExitCodesNow = (): ChantExitCodes | undefined => loaded("exitCodes");
/** The terraform lexicon's drift rows (chant#4580), or undefined. */
export const chantDriftRows = (): Promise<ChantDriftRows | undefined> => load("driftRows");
/** The drift rows as they already loaded, for the synchronous report code. cli.ts loads them first. */
export const chantDriftRowsNow = (): ChantDriftRows | undefined => loaded("driftRows");
/** chant's pull request environment ledger writer (chant#4551), or undefined. */
export const chantPrEnvLedger = (): Promise<(ChantPrEnvLedger & ChantLifecycleGit) | undefined> => load("prEnvLedger");
/** chant's op-wave step contract (chant#4545), or undefined. */
export const chantOpWaveStep = (): Promise<ChantOpWaveStep | undefined> => load("opWaveStep");
/** A registry with `terraform-apply` for a wave run in this process (chant#4545, ruling C), or undefined. */
export const chantWaveCapabilities = (): Promise<ChantWaveCapabilities | undefined> => load("waveCapabilities");
/** chant's OTLP exporter (chant#4555), or undefined. */
export const chantOtlp = (): Promise<ChantOtlp | undefined> => load("otlp");

/**
 * Load the parts synchronous code reads, once, before a command runs: the
 * words module, the exit-code table and the drift rows. cli.ts calls it.
 */
export async function preloadChantNext(): Promise<void> {
  await chantCiProductWords();
  await chantExitCodes();
  await chantDriftRows();
}

/** chant core's control repo (`@intentius/chant/ci-control`, chant#4568), or undefined. */
export const chantCiControl = (): Promise<ChantCiControl | undefined> => load("ciControl");
/** chant's control repo as it already loaded, for the synchronous script builders (./control-repo.ts). init loads it first. */
export const chantCiControlNow = (): ChantCiControl | undefined => loaded("ciControl");
/** The forge lexicon's control repo pipeline (chant#4568), or undefined. */
export function chantControlPipeline(forge: "github" | "gitlab" | "forgejo"): Promise<ChantControlPipeline | undefined> {
  return load(forge === "github" ? "controlPipelineGithub" : forge === "gitlab" ? "controlPipelineGitlab" : "controlPipelineForgejo");
}

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
  const [compose, composeRun, state, planShape, registry, objectStore, checkHooks, credentials, bucketCheck, tf046, ciProductWords, ciProduct, ciControl, controlPipelineGithub, controlPipelineGitlab, controlPipelineForgejo, exitCodes, driftRows, prEnvLedger, opWaveStep, waveCapabilities, otlp] = await Promise.all([chantCompose(), chantComposeRun(), chantState(), chantPlanShape(), chantRegistry(), chantObjectStore(), chantCheckHooks(), chantCredentials(), chantBucketCheck(), chantTf046(), chantCiProductWords(), chantCiProduct(), chantCiControl(), chantControlPipeline("github"), chantControlPipeline("gitlab"), chantControlPipeline("forgejo"), chantExitCodes(), chantDriftRows(), chantPrEnvLedger(), chantOpWaveStep(), chantWaveCapabilities(), chantOtlp()]);
  return { compose: !!compose, composeRun: !!composeRun, state: !!state, planShape: !!planShape, registry: !!registry, objectStore: !!objectStore, checkHooks: !!checkHooks, credentials: !!credentials, bucketCheck: !!bucketCheck, tf046: !!tf046, ciProductWords: !!ciProductWords, ciProduct: !!ciProduct, ciControl: !!ciControl, controlPipelineGithub: !!controlPipelineGithub, controlPipelineGitlab: !!controlPipelineGitlab, controlPipelineForgejo: !!controlPipelineForgejo, exitCodes: !!exitCodes, driftRows: !!driftRows, prEnvLedger: !!prEnvLedger, opWaveStep: !!opWaveStep, waveCapabilities: !!waveCapabilities, otlp: !!otlp };
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
  /** chant#4584: the statuses read filtered by ref, where the installed client takes one (GitLab filters; GitHub and Forgejo ignore it). */
  commitStatusesAt?: (sha: string, ref: string) => Promise<ChantReadCommitStatus[]>;
}

/** `forge`'s default-branch and status reads, each undefined when the installed chant's client lacks it. */
export function chantForgeReads(forge: PrForge): ChantForgeReads {
  const f = forge as PrForge & { defaultBranch?: unknown; commitStatuses?: unknown };
  return {
    ...(typeof f.defaultBranch === "function" ? { defaultBranch: () => (f.defaultBranch as () => Promise<string>).call(forge) } : {}),
    ...(typeof f.commitStatuses === "function" ? { commitStatuses: (sha: string) => (f.commitStatuses as (sha: string) => Promise<ChantReadCommitStatus[]>).call(forge, sha) } : {}),
    // A client whose read takes the ref (chant#4584) declares two parameters; the pin's takes one and would drop the filter.
    ...(typeof f.commitStatuses === "function" && (f.commitStatuses as (...a: unknown[]) => unknown).length >= 2
      ? { commitStatusesAt: (sha: string, ref: string) => (f.commitStatuses as (sha: string, ref: string) => Promise<ChantReadCommitStatus[]>).call(forge, sha, ref) }
      : {}),
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
