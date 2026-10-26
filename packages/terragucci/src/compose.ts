/**
 * The composed run (`waves.compose: true`), opt-in beside the waves: the
 * plain roots a change reaches, and the roots they read, plan as one plan and
 * apply as one apply of the stock binary, each root a module of a temporary
 * root. A value one root reads from another that is unknown at plan time is
 * then computed in the same apply, after the resources that make it, rather
 * than in a later wave that plans again.
 *
 * Without the key nothing here runs, and the waves are as they were: one run
 * per root, its own state, applied in dependency order.
 *
 * The composed run is chant's (the Terraform lexicon's `compositionFor`,
 * `ComposedRun` and `EstateRun`, lifted from this file in chant#4424 and
 * described in chant's guide/composed-runs). What is left here is
 * terragucci's side of it:
 *
 * - each root of the pipeline becomes a chant component with one
 *   `terraform-apply` step, `waves.after` and the roots it reads its
 *   `dependsOn`, and `oidc.roles` with the apply groups its identity;
 * - a change composes whole or not at all: a root chant leaves out makes the
 *   whole change apply in waves, with that root's reason, as it did before
 *   chant could compose part of a change;
 * - the wave a composed run sits in, its target for chant's spec, and the
 *   report's `compose`;
 * - `ci.hooks` and the sources check around each member, and the results
 *   cut back into the shapes apply.ts and report/stage.ts read.
 *
 * chant's names hold (terragucci#1268 ruling): the composed root is
 * `.chant-compose/`, a state a run could not write is kept as
 * `<key>.chant-unwritten`, and the locks name `chant terraform.compose`. A
 * state an older terragucci kept as `<key>.terragucci-unwritten` is still
 * read and written first by the next run.
 */
import { join, resolve } from "node:path";
// Subpaths, not the lexicon's index: the index carries its lint plugin, which
// imports typescript, and the CLI bundle leaves typescript out (scripts/cli-bundle.mjs).
import {
  compositionFor as chantCompositionFor,
  moduleNames,
  readOrder,
  type Composition as ChantComposition,
  type ComposeFallbackKind as ChantFallbackKind,
} from "@intentius/chant-lexicon-terraform/compose";
import { EstateRun, type ComposedRunApply, type ComposedRunPlan } from "@intentius/chant-lexicon-terraform/compose/estate";
import { ComposedRun as ChantComposedRun, type StateRunApply, type StateRunPlan } from "@intentius/chant-lexicon-terraform/compose/run";
import type { ComposedMemberRead } from "@intentius/chant-lexicon-terraform/compose/slice";
import type { TerraformConfig } from "@intentius/chant-lexicon-terraform/config";
import { COMPOSE_DIR as CHANT_COMPOSE_DIR, writeEstateRoot as chantEstateRoot, type ComposedRoot } from "@intentius/chant-lexicon-terraform/compose/root";
import { moduleValues } from "@intentius/chant-lexicon-terraform/compose/slice";
import type { DriverComponent } from "@intentius/chant/components";
import { backendConfigArgs, explicitOrder, initBackendConfigs, type WavesAfter } from "./detect";
import { rootWorkspace } from "./backend";
import { rootRoleEnv } from "./cloud-identity";
import type { BinaryExec } from "./migrate";
import type { ReportCompose, ReportComposedMember, ReportRead } from "./report/schema";
import type { HookMoment } from "./hooks";

export { composeSet } from "@intentius/chant-lexicon-terraform/compose";

/** Where the composed root is written, in the checkout: chant's `.chant-compose/`. */
export const COMPOSE_DIR = CHANT_COMPOSE_DIR;
/** Where a state is kept, under the job's report directory (kept out of the reports bucket), when its own backend could not take it either. */
export const UNWRITTEN_REPORT_DIR = "terragucci-report";
export const DEFAULT_COMPOSE_MAX = 10;

/** The run target a wave's composed run is to chant: one run, one digest, in place of its roots. */
export const composeTarget = (wave: number): string => `compose:wave-${wave}`;
export const isComposeTarget = (target: string): boolean => /^compose:wave-\d+$/.test(target);

/** Why a change applies in waves although `waves.compose` is on: chant's kinds. */
export type ComposeFallbackKind = ChantFallbackKind;

export interface ComposeFallback {
  kind: ComposeFallbackKind;
  root?: string;
  reason: string;
}

/** One `terraform_remote_state` or `terraform_estate_outputs` block of a member that reads another member. */
export interface ComposedReadBlock {
  /** The block's label. */
  name: string;
  upstream: string;
}

/** What `waves.compose` comes to for one change. */
export interface Composition {
  /** The roots the change reaches plus the roots they read, followed upstream, sorted. */
  roots: string[];
  /** The same roots, each after every root it reads. */
  order: string[];
  /** `waves.compose_max`. */
  max: number;
  /** The wave whose job runs it: the earliest wave its roots are in. Absent when the change applies in waves. */
  wave?: number;
  /** Why the change applies in waves. */
  fallback?: ComposeFallback;
  /** Each member's module name in the composed root. */
  modules: Map<string, string>;
  /** Each member's reads of another member. */
  reads: Map<string, ComposedReadBlock[]>;
  /** The wave each member is in on its own. */
  ownWave: Map<string, number>;
  /** Every member runs choudoufu: the run is one choudoufu run over estates, with no state to pull, split or write back. */
  estate?: boolean;
  /** chant's composition, which its run takes. Absent on a composition made by hand. */
  chant?: ChantComposition;
  /** The `terraform` config chant's composition was made from. */
  terraform?: TerraformConfig;
}

/** The binary a root runs, as RootBinaries.expected names it before anything is installed. */
export interface ExpectedBinary {
  name: string;
  version?: string;
  pin?: string;
}

export interface CompositionInput {
  /** Every root the pipeline lists. */
  all: string[];
  /** The roots the change reaches (affectedRoots); undefined when every root plans. */
  selected?: ReadonlySet<string>;
  /** The apply's waves, canary first. */
  waves: readonly string[][];
  max?: number;
  env: NodeJS.ProcessEnv;
  /** Each root's binary, before anything is installed. */
  binary: (root: string) => ExpectedBinary;
  /** The roots each root reads (rootDependencies). */
  deps: ReadonlyMap<string, ReadonlySet<string>>;
  after?: WavesAfter;
  /** Apply groups by name, when the wave applies one job per identity: every member has to be in one. */
  groupOf?: (root: string) => string;
}

const BINARIES = ["terraform", "tofu", "choudoufu"] as const;

/** The `key=value` pairs of the `-backend-config` arguments every root's init takes, which say where a root's state is. */
function backendConfigPairs(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of initBackendConfigs(repo)) {
    const m = a.match(/^([A-Za-z_][\w-]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * The project chant composes: `terraform.roots` keyed by each root's path in
 * the repo, and one component per root, deployed by one `terraform-apply`
 * step of that root, after the roots `waves.after` and its reads name.
 */
export function chantProject(repo: string, input: Pick<CompositionInput, "all" | "max" | "env" | "binary" | "deps" | "after">): { terraform: TerraformConfig; components: DriverComponent[] } {
  const backendConfig = { ...backendConfigPairs(repo), ...backendConfigArgsOf(input.env) };
  const names = new Set(input.all.map((r) => input.binary(r).name));
  const one = names.size === 1 ? [...names][0] : undefined;
  const binary = BINARIES.find((b) => b === one);
  const roots: TerraformConfig["roots"] = {};
  for (const r of input.all) {
    const ws = rootWorkspace(join(repo, r));
    roots[r] = { dir: r === "" ? "." : r, ...(ws ? { workspace: ws } : {}), ...(Object.keys(backendConfig).length ? { backendConfig } : {}) };
  }
  const order = explicitOrder(input.after, input.all);
  const components: DriverComponent[] = input.all.map((r) => {
    const dependsOn = [...new Set([...(order.get(r) ?? []), ...(input.deps.get(r) ?? [])])].filter((u) => u !== r && input.all.includes(u)).sort();
    return { name: r, ...(dependsOn.length ? { dependsOn } : {}), deploy: [{ phase: "deploy", steps: [{ kind: "terraform-apply", root: r }] }] };
  });
  const terraform = { roots, compose: { enabled: true, max: input.max ?? DEFAULT_COMPOSE_MAX }, ...(binary ? { binary } : {}) } as TerraformConfig;
  return { terraform, components };
}

/** The `key=value` `-backend-config` pairs of the job's own `TF_CLI_ARGS` and `TF_CLI_ARGS_init`. */
function backendConfigArgsOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of [env.TF_CLI_ARGS, env.TF_CLI_ARGS_init]) {
    if (typeof v !== "string") continue;
    for (const a of backendConfigArgs(v)) {
      const m = a.match(/^([A-Za-z_][\w-]*)=(.*)$/);
      if (m) out[m[1]!] = m[2]!;
    }
  }
  return out;
}

/** The identity a root's binary runs with: the variables `oidc.roles` sets or drops for it. */
function identityOf(env: NodeJS.ProcessEnv, root: string): string {
  let renv: NodeJS.ProcessEnv;
  try {
    renv = rootRoleEnv(env, root);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
  const keys = [...new Set([...Object.keys(env), ...Object.keys(renv)])].filter((k) => env[k] !== renv[k]).sort();
  return JSON.stringify(keys.map((k) => [k, renv[k] ?? null]));
}

/** chant's reason in terragucci's terms: its config keys where chant names its own. */
function inTerragucciTerms(f: { kind: string; reason: string }): string {
  if (f.kind === "identity") return f.reason.replace(/applies under another cloud identity \(`ci\.identity\.cloud`\)/, "runs under another role (`oidc.roles`) or apply group");
  return f.reason
    .replace("`terraform.compose.max`", "`waves.compose_max`")
    .replace(/\(`dependsOn`\)/, "(`waves.after`, or a read a composed run cannot rewrite)")
    .replace(/terraform-apply step/g, "root");
}

/**
 * What `waves.compose` comes to for a change: chant's composition of the
 * pipeline's roots, the wave that runs it and each root's module, or why it
 * applies in waves. A change that cannot compose whole applies wholly in
 * waves: the first root chant leaves out gives the reason.
 */
export function compositionFor(repo: string, input: CompositionInput): Composition {
  const max = input.max ?? DEFAULT_COMPOSE_MAX;
  const { terraform, components } = chantProject(repo, input);
  const identity = (r: string): string => `${identityOf(input.env, r)}${input.groupOf ? `\ngroup ${input.groupOf(r)}` : ""}`;
  const chant = chantCompositionFor({
    projectRoot: resolve(repo),
    terraform,
    components,
    ...(input.selected ? { selected: input.selected } : {}),
    env: input.env,
    identity,
    binary: (r) => {
      const b = input.binary(r);
      return { name: b.name, ...(b.version ? { version: b.version } : {}) };
    },
  });
  const roots = chant.candidates;
  const ownWave = new Map(input.waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)).filter(([r]) => roots.includes(r)));
  // chant judges each member first and the whole change after, so its `one-root` over a change of two or more
  // roots means its checks left one or none: the first root left out is the reason. A whole-change reason
  // chant gives over the roots themselves (`cli-args`, `too-many-roots`, one root reached) stands.
  const whole = chant.fallback && !(chant.fallback.kind === "one-root" && roots.length > 1) ? chant.fallback : undefined;
  const first = whole ?? chant.fallbacks[0] ?? chant.fallback;
  const reads = new Map(roots.map((r) => [r, (chant.reads.get(r) ?? []).flatMap((x) => (x.via === "vars" ? [] : [{ name: x.name, upstream: x.upstream }]))] as const));
  const base = {
    roots,
    order: chant.order.length ? chant.order : readOrder(roots, input.deps),
    max,
    modules: chant.modules.size ? chant.modules : moduleNames(roots),
    reads,
    ownWave,
    // chant composes the members it kept as estates; a change that leaves a root out applies wholly in waves, so it is no estate run.
    ...(chant.estate && chant.fallbacks.length === 0 ? { estate: true } : {}),
    chant,
    terraform,
  };
  if (first) {
    const fallback: ComposeFallback = { kind: first.kind, ...(first.member ? { root: first.member } : {}), reason: inTerragucciTerms(first) };
    return { ...base, fallback };
  }
  const wave = Math.min(...roots.map((r) => ownWave.get(r) ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(wave)) return { ...base, fallback: { kind: "one-root", reason: "none of its roots is in a wave of this apply" } };
  return { ...base, wave };
}

/** The one line a note, a log and the report's fallback reason say for a change that applies in waves. */
export function fallbackLine(f: ComposeFallback): string {
  return `**Applies in waves** (\`waves.compose\`): ${f.reason}.`;
}

/** The composed root of an estate run, written into the checkout: chant's, one `module` call per estate. */
export function writeEstateRoot(repo: string, c: Composition): ComposedRoot {
  if (!c.chant) throw new Error("the composition was not made by compositionFor");
  return chantEstateRoot({ projectRoot: resolve(repo), composition: c.chant });
}

// ── the run ───────────────────────────────────────────────────────────────

/** What a composed run calls out to for each member: its `ci.hooks`, and the sources check after its init. */
export interface ComposeHooks {
  /** Run one moment's hooks for a member; the error when one failed it. A hook given the plan file gets the composed one. */
  step?: (root: string, when: HookMoment, planFile?: string) => Promise<string | undefined>;
  /** After a member's init, before anything of it plans: the error when the sources check refuses what init fetched. */
  afterInit?: (root: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  log: (line: string) => void;
}

export interface ComposeRunOptions {
  repo: string;
  composition: Composition;
  /** The binary every member runs: its path and its name. */
  binary: { path: string; name: string };
  /** The job's environment, with the shared provider cache. Each member's own role is added to it. */
  env: NodeJS.ProcessEnv;
  /** A directory of the job's own for the plan file and the states it writes. */
  work: string;
  /** Take each state's lock (an apply); a plan takes none. */
  lock: boolean;
  /** Names the run in the locks it takes. */
  runId?: string;
  hooks: ComposeHooks;
  exec?: BinaryExec;
  /** How long to wait before each retry of a state's write. Default chant's: five retries, inside the lock timeout of 5 minutes. */
  retryDelays?: number[];
  /** The init of each member, one at a time when they share a provider cache. */
  initTurn?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The composed plan, cut back into each member's part. */
export interface ComposedPlan {
  /** Why it did not plan, and the member it is about when there is one. */
  error?: string;
  root?: string;
  plan?: unknown;
  planFile: string;
  text?: string;
  /** The digest the gate binds: chant's digest of the composed plan, joined with the generated files. Empty when it failed. */
  digest: string;
  generated: [string, string][];
  /** Each member's part of the plan JSON and of its text. */
  slices: Map<string, unknown>;
  texts: Map<string, string>;
  /** Each member's reads of another member. */
  reads: Map<string, ReportRead[]>;
  /** The members that read a value of another member unknown at plan time. */
  unknown: string[];
  changes: number;
  destroys: number;
  /** The binary's `Plan:` line for the whole run. */
  summary: string;
}

/** How a composed apply ended. */
export interface ComposedApply {
  ok: boolean;
  members: ReportComposedMember[];
  /** The members whose state the run wrote or left as it was: their backend holds what applied to them. */
  settled: string[];
  /** `show -json` of each member's part of the working state, as if the member had applied alone: where the report reads the values its plan left unknown. */
  shown?: Map<string, unknown>;
  error?: string;
}

/** A member's read of another member, as the report names it. */
function reportRead(r: ComposedMemberRead): ReportRead {
  return { upstream: r.upstream, data: r.name, outputs: "planned", ...(r.unknown.length ? { unknown: [...r.unknown] } : {}), composed: true };
}

/**
 * One composed run: plan it (`plan`), then apply it once the gate lets it
 * through (`apply`), then `release` whatever happened. chant's run does the
 * work; this runs terragucci's hooks and sources check around each member and
 * says what came of it in terragucci's shapes.
 */
export class ComposedRun {
  private inner?: ChantComposedRun | EstateRun;
  private planned?: ComposedPlan;

  constructor(private readonly o: ComposeRunOptions) {}

  private get c(): Composition {
    return this.o.composition;
  }

  /** A member's environment: the job's with its role. */
  rootEnv(root: string): NodeJS.ProcessEnv {
    return rootRoleEnv(this.o.env, root);
  }

  private get estate(): boolean {
    return this.c.chant?.estate === true;
  }

  /** chant's run, made once. Throws for a composition chant did not make or that falls back. */
  private runner(): ChantComposedRun | EstateRun {
    if (this.inner) return this.inner;
    const { chant, terraform } = this.c;
    if (!chant || !terraform) throw new Error("the composition was not made by compositionFor");
    const log = (l: string) => this.o.hooks.log(l);
    if (chant.estate) {
      this.inner = new EstateRun({ projectRoot: resolve(this.o.repo), composition: chant, terraform, env: this.o.env, binary: this.o.binary.path, work: this.o.work, ...(this.o.exec ? { exec: this.o.exec } : {}), log });
      return this.inner;
    }
    // Every member has the same role, or the change would not compose: the first member's is the run's.
    const env = rootRoleEnv(this.o.env, this.c.order[0]!);
    // Each root's init reads TF_CLI_ARGS_init for its backend settings, as a root planned alone does: chant passes no -backend-config of its own.
    const runTerraform = { ...terraform, roots: Object.fromEntries(Object.entries(terraform.roots).map(([k, r]) => [k, { dir: r.dir }])) } as TerraformConfig;
    this.inner = new ChantComposedRun({
      projectRoot: resolve(this.o.repo),
      composition: chant,
      terraform: runTerraform,
      binary: { path: this.o.binary.path, name: this.o.binary.name },
      env,
      work: this.o.work,
      lock: this.o.lock,
      ...(this.o.runId ? { runId: this.o.runId } : {}),
      ...(this.o.exec ? { exec: this.o.exec } : {}),
      ...(this.o.retryDelays ? { retryDelays: this.o.retryDelays } : {}),
      ...(this.o.initTurn ? { initTurn: this.o.initTurn } : {}),
      reportDir: join(this.o.repo, UNWRITTEN_REPORT_DIR),
      hook: (member, moment, planFile) => this.hook(member, moment, planFile),
      log,
    });
    return this.inner;
  }

  /**
   * A member's hooks at one moment. The sources check runs at its
   * `before-plan`: chant inits every member, takes the locks and pulls the
   * states first, and nothing of it has planned yet.
   */
  private async hook(member: string, moment: HookMoment, planFile?: string): Promise<string | undefined> {
    if (moment === "before-plan" && this.o.hooks.afterInit) {
      const e = await this.o.hooks.afterInit(member, this.rootEnv(member));
      if (e) return e;
    }
    return this.o.hooks.step ? this.o.hooks.step(member, moment, planFile) : undefined;
  }

  private failedPlan(error: string, root?: string): ComposedPlan {
    return { error, ...(root ? { root } : {}), planFile: join(this.o.work, "composed.tfplan"), digest: "", generated: [], slices: new Map(), texts: new Map(), reads: new Map(), unknown: [], changes: 0, destroys: 0, summary: "" };
  }

  /**
   * An estate run's members before chant plans them: each member's
   * `before-observe` hooks, its init in its own directory (which fetches what
   * the sources check reads), the sources check and its `before-plan` hooks.
   * chant's estate run inits only the composed root.
   */
  private async estateBefore(): Promise<ComposedPlan | undefined> {
    const turn = this.o.initTurn ?? ((fn) => fn());
    const exec = this.o.exec ?? (await import("./migrate")).runBinary;
    for (const r of this.c.order) {
      const env = this.rootEnv(r);
      let e = await this.o.hooks.step?.(r, "before-observe");
      if (e) return this.failedPlan(e, r);
      const init = await turn(() => exec(this.o.binary.path, ["init", "-input=false", "-no-color"], join(this.o.repo, r), env));
      if (init.code !== 0) return this.failedPlan(`init failed\n${init.out.trim().split("\n").slice(-40).join("\n")}`, r);
      e = await this.hook(r, "before-plan");
      if (e) return this.failedPlan(e, r);
    }
    return undefined;
  }

  /** Plan the composed run once, cut back into each member's part. */
  async plan(): Promise<ComposedPlan> {
    let runner: ChantComposedRun | EstateRun;
    try {
      runner = this.runner();
    } catch (e) {
      return this.failedPlan((e as Error).message);
    }
    if (this.estate) {
      const stop = await this.estateBefore();
      if (stop) return stop;
    }
    const p: ComposedRunPlan | StateRunPlan = await runner.plan();
    if (p.fallback) return this.failedPlan(p.fallback.reason, p.fallback.member);
    if (p.error || p.plan === undefined) return this.failedPlan(p.error ?? "the composed run did not plan", p.member);
    if (this.estate) {
      for (const r of this.c.order) {
        const e = await this.o.hooks.step?.(r, "after-plan", p.planFile);
        if (e) return this.failedPlan(e, r);
      }
    }
    const slices = new Map<string, unknown>();
    const texts = new Map<string, string>();
    const reads = new Map<string, ReportRead[]>();
    for (const r of this.c.order) {
      const m = p.members[r];
      slices.set(r, m?.slice);
      texts.set(r, p.texts[r] ?? "");
      if (m?.reads.length) reads.set(r, m.reads.map(reportRead));
    }
    const unknown = (p as Partial<StateRunPlan>).unknownReads ?? this.c.order.filter((r) => (p.members[r]?.reads ?? []).some((x) => x.unknown.length > 0)).sort();
    const planned: ComposedPlan = { plan: p.plan, planFile: p.planFile, text: p.text, digest: p.digest, generated: p.generated, slices, texts, reads, unknown, changes: p.counts.changes, destroys: p.counts.destroys, summary: p.summary };
    this.planned = planned;
    return planned;
  }

  /**
   * Apply the saved plan. chant splits the working state by module and
   * writes each changed state, upstreams first, whether the apply finished or
   * not; a state it could not write is kept beside it with its lock held.
   */
  async apply(): Promise<ComposedApply> {
    const p = this.planned;
    const module = (r: string): string => `module.${this.c.modules.get(r)}`;
    const notStarted = (error: string, root?: string, rootError?: string): ComposedApply => ({
      ok: false,
      members: this.c.order.map((r) => ({ root: r, module: module(r), apply: "not-started" as const, ...(r === root && rootError ? { error: rootError } : {}) })),
      settled: [],
      error,
    });
    if (!p?.plan || !this.inner) return { ok: false, members: this.c.order.map((r) => ({ root: r, module: module(r) })), settled: [], error: "the composed run did not plan" };
    if (this.estate) {
      for (const r of this.c.order) {
        const e = await this.o.hooks.step?.(r, "before-apply", p.planFile);
        if (e) return notStarted(`a step before the apply of ${r} failed, so nothing applied`, r, e);
      }
    }
    const a: ComposedRunApply | StateRunApply = await this.inner.apply();
    const state = "settled" in a ? (a as StateRunApply) : undefined;
    const members: ReportComposedMember[] = this.c.order.map((r) => {
      const o = a.members[r];
      if (!o) return { root: r, module: module(r) };
      const s = state?.members[r];
      const written = s ? s.state : o.done > 0 ? "written" : "unchanged";
      return {
        root: r,
        module: module(r),
        apply: o.status,
        changes: { done: o.done, planned: o.planned },
        state: written,
        ...(s?.kept ? { kept: s.kept } : {}),
        ...(s?.lockHeld ? { lock_held: true } : {}),
        ...(o.error ? { error: o.error } : {}),
      };
    });
    let ok = a.ok;
    if (this.estate) {
      for (const row of members) {
        if (row.apply !== "applied" && row.apply !== "no-changes") continue;
        const e = await this.o.hooks.step?.(row.root, "after-apply");
        if (e) {
          row.error = e;
          ok = false;
        }
      }
    }
    const shown = new Map<string, unknown>();
    if (state) for (const [r, v] of Object.entries(state.shown)) shown.set(r, v);
    else {
      // What each estate holds after the apply: the post-apply plan's prior state, which choudoufu builds from the records and the live system, cut per member.
      const prior = (a.after as { prior_state?: { values?: unknown } } | undefined)?.prior_state;
      if (prior) for (const r of this.c.order) shown.set(r, { ...prior, values: moduleValues(prior.values, this.c.modules.get(r)!, {}) });
    }
    const settled = state ? state.settled : [...this.c.order];
    const error = ok ? undefined : (a.error ?? members.find((m) => m.error)?.error ?? "the composed apply failed");
    return { ok, members, settled, ...(shown.size ? { shown } : {}), ...(error ? { error } : {}) };
  }

  /** Release every lock but those held on purpose for a state that could not be written, and take the composed root away. */
  async release(): Promise<void> {
    await this.inner?.release();
  }
}

/**
 * The apply's waves with a composed run in the earliest wave its roots are
 * in: its roots taken out of every wave, and in that wave either the run's
 * target (`target`, as chant's spec holds it) or its roots, upstreams first
 * (as the run view and the gates read them). A wave left with none stays,
 * empty: it finds nothing to apply.
 */
export function wavesWithRun(waves: readonly string[][], c: Composition | undefined, target: boolean): string[][] {
  if (!c || c.wave === undefined || c.fallback) return waves.map((w) => [...w]);
  const inRun = new Set(c.roots);
  return waves.map((w, i) => [...w.filter((r) => !inRun.has(r)), ...(i + 1 === c.wave ? (target ? [composeTarget(c.wave)] : c.order) : [])]);
}

/**
 * The waves as chant's spec holds them: wavesWithRun's, with each wave the
 * run emptied listing the run's target, where its roots apply. chant refuses
 * a wave with no runs, and it numbers waves by their place in the spec, so
 * leaving one out would move every later wave onto another gate. A job runs
 * only its own wave of the spec, and an emptied wave's job ends before it
 * asks chant (apply.ts runWaves), so only the composed wave's job runs it.
 */
export function specWavesWithRun(waves: readonly string[][], c: Composition | undefined): string[][] {
  const out = wavesWithRun(waves, c, true);
  if (!c || c.wave === undefined || c.fallback) return out;
  const target = composeTarget(c.wave);
  return out.map((w, i) => (w.length === 0 && waves[i]!.length > 0 ? [target] : w));
}

/** The log line that says what `waves.compose` came to. */
export function compositionLine(c: Composition): string {
  return c.fallback || c.wave === undefined
    ? `compose: ${c.fallback?.reason ?? "no wave runs it"}, so the change applies in waves`
    : `compose: ${c.order.join(", ")} apply as one composed run in wave ${c.wave} (${composeTarget(c.wave)})`;
}

/** `Report.compose` from a composition. */
export function reportCompose(c: Composition): ReportCompose {
  return { roots: c.roots, max: c.max, ...(c.wave !== undefined && !c.fallback ? { wave: c.wave } : {}), ...(c.estate ? { estate: true as const } : {}), ...(c.fallback ? { fallback: c.fallback } : {}) };
}
