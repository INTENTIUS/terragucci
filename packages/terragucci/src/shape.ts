/**
 * The repo's shape, resolved once per command and passed down: how its roots
 * come to be, the engine that runs them, the command the jobs run before they
 * read them, how to find them, the environment each runs with, where each
 * keeps its state, what the shape refuses, and where an edit to a root
 * belongs.
 *
 *   roots       Directories with a backend or a provider block (./detect.ts).
 *   synth       Roots a command writes, such as CDK Terrain's stacks.
 *   atmos       Instances `terragucci atmos write` writes from Atmos stacks (./atmos.ts).
 *   terragrunt  Terragrunt units, run with `terragrunt run --all` (./terragrunt.ts).
 *   terramate   Terramate stacks, committed with their generated code (./terramate.ts).
 *
 * detectShape is the only detector: every command asks it, never the
 * markers. There are two execution engines: one binary run per root, and
 * Terragrunt's `run --all` per wave. Atmos and synth reduce to the per-root
 * engine once `prepare` has run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { ATMOS_MARKER, ATMOS_WRITE, atmosEdges, atmosInstances, describeStacks, detectAtmos, instanceStates, instanceWaves, type AtmosInstance } from "./atmos";
import { rootWorkspace, workspaceEnv, workspaceInit } from "./backend";
import { ConfigError, type Binary, type ResolvedSettings } from "./config";
import { applyLayers, detectBinary, explicitOrder, findRootsWithReasons, rootDependencies, rootOrder, rootStates, type Detected, type WavesAfter, type RootReason, type StateAddress } from "./detect";
import { refusal, shapeProblems, type Feature, type ShapeKind } from "./refusals";
import { terragruntStepsRefusal } from "./steps";
import { detectTerragrunt, discoverUnits, unitWaves, type TerragruntDetection } from "./terragrunt";
import { detectTerramate, TERRAMATE_GENERATE, terramateDiscover } from "./terramate";
import { generateStacks, generatingStack, stackFile } from "./tg-stacks";

export type { Feature, ShapeKind } from "./refusals";

/** The engine a shape's roots run on. */
export type Engine = "per-root" | "terragrunt";

/** What discovery found: the roots, their waves, and their edges. */
export interface Discovered {
  roots: RootReason[];
  /** The apply order: dependency layers, the canary's first where the shape cuts waves itself. */
  layers: string[][];
  /** For each root, the roots whose state it reads. */
  reads: Map<string, Set<string>>;
  /** For each root, every root it must follow: its reads and any explicit order. */
  order: Map<string, Set<string>>;
  /** What discovery noticed, for init to print. */
  notes: string[];
  /** A Terramate repo's: the stacks that hold no Terraform, so are no roots. */
  skipped?: string[];
  /** A Terragrunt repo's: how the units were found. */
  source?: "terragrunt find" | "terragrunt.hcl files";
}

export interface DiscoverOptions {
  /** The engine Terragrunt calls (`TG_TF_PATH`). */
  binary?: string;
  /** The `terragrunt` executable. Default: `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragrunt?: string;
  /** The `atmos` executable. Default: `TERRAGUCCI_ATMOS`, then `atmos` on the path. */
  atmos?: string;
  /** The `terramate` executable. Default: `TERRAGUCCI_TERRAMATE`, then `terramate` on the path. */
  terramate?: string;
  exec?: TerragruntExec;
}

/** How `init` and `workspace select` run for a root that names its workspace. */
export type RootInit = ReturnType<typeof workspaceInit>;

export interface Shape {
  kind: ShapeKind;
  /** Why detection chose it: the marker's path, or the setting. */
  reason: string;
  engine: Engine;
  /** The command every job runs before it reads the roots: the synth, or the Atmos write. Undefined when git holds the roots. */
  prepare?: string;
  /** Whether git holds the roots, so a pull request's diff names the ones it changes; false when prepare writes them. */
  rootsInGit: boolean;
  /** A Terragrunt repo's detection: its marker and its explicit stacks. */
  terragrunt?: TerragruntDetection;
  /** `waves.after`, for plain roots and a synth's: the order it adds to the reads. The other shapes refuse it. */
  after?: WavesAfter;
  /** The roots, their waves and edges. Throws ConfigError when there is none. */
  discover(options?: DiscoverOptions): Promise<Discovered>;
  /** The binary the roots run when nothing names one: a version file, `.tofu` files in the code, the path. */
  binary(roots?: readonly string[]): Detected<Binary>;
  /** The environment a root's binary runs with: its workspace in `TF_WORKSPACE` when it names one. */
  rootEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** How a root that names its workspace is initialised (init in default, then select); undefined for one that names none. */
  rootInit(root: string, env: NodeJS.ProcessEnv): RootInit;
  /** Where a root keeps its state, read from its code; undefined when the code does not say. */
  stateAddress(root: string): StateAddress | undefined;
  /** Why the shape refuses `feature`, whatever the settings say; undefined when it does not. */
  refuses(feature: Feature): string | undefined;
  /** Every refusal of what the settings ask for, and a block that names a shape the repo is not, each as `<where>.<key>: <why>`. */
  problems(where?: string): string[];
  /** Where an edit to a root belongs, from the repo: the root itself, an Atmos instance's component, or the stack file that generates a Terragrunt unit. */
  sourceOf(root: string): string;
  /**
   * Write the roots git does not hold, in the checkout, before a command reads
   * them: an explicit stack's units, through `terragrunt stack generate`. With
   * `roots`, only when one of them is not on disk yet. The stacks it generated.
   * (`prepare` is the shell the jobs run; discover() prepares on its own.)
   */
  prepareRoots(options?: DiscoverOptions & { roots?: readonly string[] }): Promise<string[]>;
}

/**
 * What each binary can do, where the code paths differ by binary.
 * choudoufu pins the OpenTofu language it forks in required_version, not a
 * release of its own; it has no `test`; under live resource markers it
 * refuses the refresh-only plan drift runs; and its applies are kept apart
 * per resource, where every other binary's are kept apart per root by the
 * backend's state lock (`applyScope`, ./apply-rows.ts).
 */
export const BINARY: Record<Binary, { releaseInRequiredVersion: boolean; test: boolean; refreshOnlyOnLiveRoots: boolean; applyScope: "resource" | "root" }> = {
  tofu: { releaseInRequiredVersion: true, test: true, refreshOnlyOnLiveRoots: true, applyScope: "root" },
  terraform: { releaseInRequiredVersion: true, test: true, refreshOnlyOnLiveRoots: true, applyScope: "root" },
  choudoufu: { releaseInRequiredVersion: false, test: false, refreshOnlyOnLiveRoots: false, applyScope: "resource" },
};

const NO_ROOTS = "found no roots: no directory has Terraform files with a backend or a provider block";

/** The repo's shape, from its markers and the settings. Never throws: a block naming a shape the repo is not is one of `problems()`. */
export function detectShape(repo: string, settings: ResolvedSettings): Shape {
  const tg = detectTerragrunt(repo);
  const atmos = detectAtmos(repo);
  const conflicts: string[] = [];
  if (settings.terragrunt && !tg) conflicts.push("terragucci.yml has a terragrunt block, but the repo has no root.hcl, terragrunt.hcl or terragrunt.stack.hcl");
  if (settings.atmos && !atmos) conflicts.push(`terragucci.yml has an atmos block, but the repo has no ${ATMOS_MARKER} at its root`);
  if (atmos && tg) conflicts.push(`the repo has ${atmos} and ${tg.reason}; terragucci runs an Atmos repo or a Terragrunt repo, not both`);
  const tmMarker = detectTerramate(repo);
  if (tmMarker && (atmos || tg)) conflicts.push(`the repo has ${tmMarker} and ${atmos ?? tg!.reason}; terragucci runs a Terramate repo, an Atmos repo or a Terragrunt repo, one at a time`);
  const terramate = !atmos && !tg ? tmMarker : undefined;
  const synth = typeof settings.synth === "string" && settings.synth.trim() !== "" ? settings.synth : undefined;
  const kind: ShapeKind = atmos ? "atmos" : tg ? "terragrunt" : terramate ? "terramate" : synth ? "synth" : "roots";
  const reason = atmos ?? tg?.reason ?? terramate ?? (synth ? `synth: ${synth}` : "roots");
  const canary = settings.waves?.canary;
  const plainAfter = (kind === "roots" || kind === "synth") && settings.waves?.after && Object.keys(settings.waves.after).length ? settings.waves.after : undefined;
  let instances: AtmosInstance[] | undefined;

  const sourceOf = (root: string): string => {
    if (kind === "terragrunt") {
      const stack = generatingStack(root);
      return stack === undefined ? root : stackFile(stack);
    }
    if (kind !== "atmos") return root;
    return instances?.find((i) => i.path === root)?.componentPath ?? atmosEdges(join(repo, root))?.component ?? root;
  };

  const discover = async (options: DiscoverOptions = {}): Promise<Discovered> => {
    if (kind === "atmos") {
      instances = atmosInstances(await describeStacks(repo, { ...(options.atmos ? { atmos: options.atmos } : {}), ...(options.exec ? { exec: options.exec } : {}) }));
      if (instances.length === 0) throw new ConfigError(`found no Atmos instances (${atmos} turned Atmos mode on): atmos describe stacks lists no Terraform component that is neither abstract nor disabled`);
      const reads = new Map(instances.filter((i) => i.reads.length > 0).map((i) => [i.path, new Set(i.reads.map((r) => r.upstream))]));
      const order = new Map(instances.filter((i) => i.dependencies.length > 0).map((i) => [i.path, new Set(i.dependencies)]));
      return {
        roots: instances.map((i) => ({ root: i.path, reason: `atmos describe stacks: ${i.componentPath} in workspace ${i.workspace}` })),
        layers: instanceWaves(instances, canary),
        reads,
        order,
        notes: [],
      };
    }
    if (kind === "terramate") return terramateDiscover(repo, terramate!, canary, { ...(options.terramate ? { terramate: options.terramate } : {}), ...(options.exec ? { exec: options.exec } : {}) });
    if (kind === "terragrunt") {
      const found = await discoverUnits(repo, {
        exclude: settings.terragrunt?.exclude,
        ...(options.binary ? { binary: options.binary } : {}),
        ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}),
        ...(options.exec ? { exec: options.exec } : {}),
      });
      if (found.units.length === 0) throw new ConfigError(`found no Terragrunt units (${tg!.reason} turned Terragrunt mode on): no directory outside catalog/ holds a terragrunt.hcl`);
      let layers: string[][];
      try {
        layers = unitWaves(found.units, canary);
      } catch (e) {
        throw new ConfigError((e as Error).message);
      }
      const order = new Map(found.units.filter((u) => u.dependencies.length > 0).map((u) => [u.path, new Set(u.dependencies)]));
      return {
        roots: found.units.map((u) => ({ root: u.path, reason: found.source === "terragrunt find" ? "terragrunt find" : "terragrunt.hcl" })),
        layers,
        // A unit's dependency blocks read its upstreams' outputs, which is their state.
        reads: order,
        order,
        notes: found.notes,
        source: found.source,
      };
    }
    const roots = findRootsWithReasons(repo, settings.roots);
    if (roots.length === 0) {
      throw new ConfigError(
        (settings.roots ? `no directory matches roots ${JSON.stringify(settings.roots)}` : NO_ROOTS) +
          // The pipeline names the roots init finds, so a synthesized root must be on disk when init runs.
          (synth ? `; run the synth command (${synth}) first, then init` : ""),
      );
    }
    const paths = roots.map((r) => r.root);
    const reads = rootDependencies(repo, paths);
    // waves.after adds order the reads do not give: a root applies after the roots it names, and plans when they change.
    const after = plainAfter;
    const order = after ? rootOrder(repo, paths, after) : reads;
    const explicit = explicitOrder(after, paths);
    return { roots, layers: applyLayers(repo, paths, after), reads, order, notes: explicit.size ? [`waves.after orders ${[...explicit].map(([r, ups]) => `${r} after ${[...ups].sort().join(", ")}`).join("; ")}`] : [] };
  };

  const binary = (roots: readonly string[] = []): Detected<Binary> => {
    // A Terragrunt unit carries no .tf files to read the binary from; an Atmos instance's are its component's.
    if (kind === "terragrunt") return detectBinary(repo, []);
    const dirs = [...new Set(roots.map(sourceOf))].filter((d) => existsSync(join(repo, d)));
    return detectBinary(repo, dirs);
  };

  const stateAddress = (root: string): StateAddress | undefined => {
    if (kind === "terragrunt") return undefined;
    if (kind === "atmos") {
      const i = instances?.find((x) => x.path === root);
      if (i) return instanceStates([i]).states.get(root);
      // Written by atmos write: its backend and workspace are beside it.
      const dir = join(repo, root);
      const ws = rootWorkspace(dir);
      const file = join(dir, "backend.tf.json");
      if (!ws || !existsSync(file)) return undefined;
      try {
        const backends = (JSON.parse(readFileSync(file, "utf-8")) as { terraform?: { backend?: Record<string, Record<string, unknown>> } }).terraform?.backend ?? {};
        const [type, config] = Object.entries(backends)[0] ?? [];
        if (!type || !config) return undefined;
        const component = atmosEdges(dir)?.component?.split("/").pop() ?? root.split("/").pop()!;
        return instanceStates([{ path: root, stack: "", component, componentPath: "", workspace: ws, vars: {}, backendType: type, backend: config, providers: {}, dependencies: [], reads: [] }]).states.get(root);
      } catch {
        return undefined;
      }
    }
    return rootStates(repo, [root]).get(root)?.state;
  };

  return {
    kind,
    reason,
    engine: kind === "terragrunt" ? "terragrunt" : "per-root",
    // A Terramate repo commits its generated code: its prepare checks it and writes no root.
    rootsInGit: kind !== "synth" && kind !== "atmos",
    ...(kind === "atmos" ? { prepare: ATMOS_WRITE } : kind === "terramate" ? { prepare: TERRAMATE_GENERATE } : synth && kind === "synth" ? { prepare: synth } : {}),
    ...(tg && kind === "terragrunt" ? { terragrunt: tg } : {}),
    ...(plainAfter ? { after: plainAfter } : {}),
    discover,
    binary,
    rootEnv: (root, env) => workspaceEnv(env, join(repo, root)),
    rootInit: (root, env) => workspaceInit(env, join(repo, root)),
    stateAddress,
    refuses: (feature) => (feature === "steps" && kind === "terragrunt" ? terragruntStepsRefusal(settings.steps) : refusal(kind, feature)),
    problems: (where = "config") => {
      const steps = kind === "terragrunt" ? terragruntStepsRefusal(settings.steps) : undefined;
      return [...conflicts, ...shapeProblems(kind, settings, where), ...(steps ? [`${where}.${steps}`] : [])];
    },
    sourceOf,
    prepareRoots: async (options = {}) => {
      if (kind !== "terragrunt" || !tg?.stacks.length) return [];
      const run = { ...(options.binary ? { binary: options.binary } : {}), ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}), ...(options.exec ? { exec: options.exec } : {}) };
      if (options.roots && options.roots.every((r) => generatingStack(r) === undefined || existsSync(join(repo, r, "terragrunt.hcl")))) return [];
      return generateStacks(repo, run);
    },
  };
}

/** Throw the shape's problems as one ConfigError, as init and the commands refuse them. */
export function refuseProblems(shape: Shape, where?: string): void {
  const problems = shape.problems(where);
  if (problems.length > 0) throw new ConfigError(problems.join("; "));
}
