/**
 * The part of chant's contract terragucci calls, written out as types, and
 * chant's agent job and Op generators (CHANT_AGENT_JOB, below). Every part
 * this file once loaded on first use, with a fallback for a chant that
 * lacked it, is now imported directly (terragucci#1304): the composed run,
 * the lock code and the plan shape (terragucci#1278), and the rest below.
 *
 * Imported directly since terragucci#1304, on the 0.124.55 pin: the module
 * registry protocol and its mirror code (`registry`, chant#4565, #4564;
 * ./publish/registry.ts, ./image-recipe.ts, ./publish/provider-mirror.ts),
 * the lexicon's module targets on it (chant#4603-#4605; ./publish/hosted.ts),
 * chant core's Terraform token reader (`terraform/credentials`, chant#4563,
 * now read through the terraform lexicon's `state`), the product words and pipeline (`ci-product-words`,
 * `ci-product`, chant#4550; ./ci-words.ts, ./comment.ts, ./render.ts,
 * ./report/marker.ts), the pull request environment ledger
 * (`components/pr-env-ledger`, chant#4551; ./ephemeral.ts), and the forge
 * reads and handover parameters (`pr-forge`, `ci-handover`, chant#4554;
 * ./forge.ts, ./handover.ts).
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
 * (./control-repo.ts, ./control-records.ts, ./reconcile.ts).
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
 * Newer than the pin too (terragucci#1282 part f): the op-wave stand-down on `op` (chant#4581),
 * told apart by its exports, which ./apply.ts and the step spec use.
 *
 * Imported directly since the pin moved to chant 0.124.56, which carries
 * them (terragucci#1304): chant core's apply-job guard (`ci-job-guard`,
 * chant#4624; ./check-job.ts), its audit log reader and known-writes table
 * (`ci-audit`, chant#4632; ./respond/attribute.ts, ./state-writers.ts), and
 * the op entry's after-plan hook with `opWavePlanPath` (chant#4614; the step
 * wave in ./apply.ts). And at the 0.124.88 pin: chant core's forge and
 * trust-policy check (`forge-check`, chant#4608), which `terragucci forge
 * check` calls (./identities.ts), and its notify relay (`notify-relay`,
 * chant#4611), which `terragucci relay` runs (./relay-host.ts sets it up), and its ledger estate (`ci-estate`, chant#4612),
 * which ./estate.ts builds on once the ledger holds wave run records and
 * whose helpers ./report/dora.ts uses, and its shared policy source
 * (`policy-source`, chant#4613), which fetches `policy.source`
 * (./report/policy.ts).
 *
 * Newer than the pin too (chant#3924): the terraform lexicon's reading of the
 * sources a root uses (`usedSources`, `lockedProviders`) and their forms
 * (`moduleSourceForms`, `providerAddressForms`), on its `registry` subpath.
 * ./sources.ts keeps only the lists and the refusals with them, and its own
 * reader and forms as the fallback.
 *
 * The terraform lexicon's day-2 action (chant#4653, terragucci#1310),
 * `invokeAction` on its `action-ops` subpath (op `tf-action`), is read into
 * the state operations below (./action.ts).
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
import { CI_AGENT_FLOOR, productDriftAgent, productPipelineJobs } from "@intentius/chant/ci-product";
import { setActiveProductWords } from "@intentius/chant/ci-product-words";
import { generateGithubOpPipeline } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import { generateGitlabOpPipeline } from "@intentius/chant-lexicon-gitlab/components/generate-op-pipeline";
import { generateForgejoOpPipeline } from "@intentius/chant-lexicon-forgejo/components/generate-op-pipeline";

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
export type ChantProductCommand = "plan" | "apply" | "lock" | "unlock" | "agent" | "action";

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
 * chant's reader of a gated request's stored attachment (chant#4551 stores it
 * at `_gates/<op>/requests/<digest>.json` on chant/lifecycle, chant#4623 for
 * an op-wave hold): the path, and `readBlobFromPath` from chant's ledger.
 */
export interface ChantRequestProof {
  gatedRequestAttachmentPath(op: string, digest: string): { dir: string; file: string };
  readBlobFromPath(environment: string, filename: string, opts?: { cwd?: string }): Promise<string | null>;
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
  /** The terraform lexicon's day-2 action (`action-ops`, chant#4653). */
  invokeAction: (input: ChantInvokeActionInput) => Promise<ChantInvokeActionResult>;
  /** The action address `-invoke` takes, as the lexicon checks it. */
  ACTION_ADDRESS: RegExp;
}

/** What `invokeAction` takes (`InvokeActionInput`, chant#4653). */
export interface ChantInvokeActionInput {
  root: string;
  dir: string;
  binary?: string;
  version?: string;
  address: string;
  requester: string;
  rules: { mode: string; quorum?: readonly unknown[] };
  commit?: string;
  planFile?: string;
  lockTimeout?: string | false;
  env?: NodeJS.ProcessEnv;
  exec?: ChantRootRun["exec"];
  cwd?: string;
  now?: string;
  runId?: string;
  expiry?: string;
  anew?: boolean;
}

/** How an action call ended (`InvokeActionResult`, chant#4653). */
export type ChantInvokeActionResult =
  | { outcome: "refused"; code: "action-engine" | "action-address" | "unknown-action"; reason: string; exit: number }
  | { outcome: "gated"; digest: string; subject: string; command: string; reason?: string; exit: number }
  | { outcome: "spent"; digest: string; subject: string; exit: number }
  | { outcome: "ok"; digest: string; subject: string; approvedBy: string; tail: string; recorded: boolean; exit: number }
  | { outcome: "failed"; digest: string; subject: string; approvedBy: string; error: string; tail: string; recorded: boolean; exit: number };

/** A tool on chant's MCP server (`McpToolContribution`). */
export interface ChantMcpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  /** A tool that reads (chant#4555). */
  readOnly?: true;
  /** A tool that opens pull requests and comments, served only on the `--propose` tier (chant#4655). */
  forgeWrite?: true;
  /** MCP's hints; chant sets readOnlyHint and destructiveHint from the two above (chant#4823). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** chant's product tool hook (`ProductMcpHook`, chant#4555). */
export interface ChantProductMcpHook {
  product: string;
  tools(ctx: { cwd: string; readOnly: boolean; propose?: boolean }): ChantMcpTool[];
  reportUrl?: string;
  readOnly?: boolean;
  /** Serve the `forgeWrite` tools on the read-only server, as `--propose` does (chant#4655). */
  propose?: boolean;
  instructions?: string;
}

/** chant core's release record reader (`lifecycle/release-ledger`'s `parseReleaseLedger`), for a ledger read from another remote. */
export interface ChantReleaseRead {
  releaseLedgerLines(text: string | null): string[];
  parseReleaseLedger(lines: readonly string[]): { records: unknown[]; malformed: number };
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
  /** Who asked, as the forge vouches for it: the run's actor. */
  requestedBy: string;
  /** Who the client says asked, shown as claimed. */
  claimedBy?: string;
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
  /**
   * An add-on's module call for an app's root, `addon-<name>.tf` (ruling C of chant#4642). A value
   * `app.<output>` becomes `module.app.<output>`, and one naming an output the app module lacks throws
   * with code `unknown-output`.
   */
  renderAddonCall(options: { request: ChantTemplateRequest; source: string; inputs: readonly ChantTemplateInput[]; appOutputs: readonly (string | { name: string })[] }): ChantRenderedFile;
  terraformInputType(input: Pick<ChantTemplateInput, "kind" | "of">): string;
  /** Thrown with a `code` and a `subject` when a request cannot become files. */
  TemplateRenderError: new (...args: never[]) => Error & { code: string; subject: string };
}

// ── chant's agent job and Op generators ────────────────────────────────────

/**
 * chant's agent job and Op generators (chant#4616, #4619, terragucci#1305):
 * the comment agent's jobs (./render-chant-agent.ts) and the drift Op
 * (./render-chant-drift.ts) are written with them on every render.
 */
export const CHANT_AGENT_JOB: ChantAgentJob = {
  CI_AGENT_FLOOR,
  productPipelineJobs: productPipelineJobs as unknown as ChantAgentJob["productPipelineJobs"],
  productDriftAgent: productDriftAgent as unknown as ChantAgentJob["productDriftAgent"],
  setActiveProductWords: setActiveProductWords as unknown as ChantAgentJob["setActiveProductWords"],
  generate: {
    github: generateGithubOpPipeline as unknown as ChantOpGenerator,
    gitlab: generateGitlabOpPipeline as unknown as ChantOpGenerator,
    forgejo: generateForgejoOpPipeline as unknown as ChantOpGenerator,
  },
};
