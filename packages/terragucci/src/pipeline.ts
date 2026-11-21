/**
 * `.chant/pipeline.ts` from terragucci.yml: `promotion`, `environments` and
 * `waves` mapped onto chant's pipeline declaration (`@intentius/chant/pipeline`).
 *
 * terragucci maps and chant does the rest. `pipelineFromConfig` reads the
 * stage keys of chant's vocabulary page as terragucci.yml spells them under
 * `environments.<name>` (`hold`, `freeze`, `failure_tolerance`, `after`,
 * `queue`, `urgent`, `pause_after_rollback`, `on_verify_fail`, `canary`,
 * `soak`, `publish`, `reads`, `agent_steps`, `approval_rules`), and this file
 * adds the few the helper leaves to the product:
 *
 * - each stage's waves: the waves of the committed waves spec
 *   (`.chant/op-waves/tf-apply.spec.json`, which `terragucci init` writes)
 *   cut to the roots of that environment, in the same order. A stage's first
 *   wave is its canary when every root in it matches `waves.canary` and the
 *   stage's soak has a check, so the canary maps the existing key and has
 *   none of its own;
 * - `risk`: `risk.approve_above` as the pipeline's `defaults.holds.risk`, and
 *   `environments.<name>.risk` as that stage gate's `holds.risk`, with its
 *   `approval_rules` as the rules an over score adds;
 * - `replan_dependents`: the pipeline's `defaults.replanDependents`, and an
 *   environment's own on its stage;
 * - `release` as written, with terragucci as the bin its cut runs as, and
 *   `recheck` as it is. With `promotion`, the merge path's last wave runs
 *   chant's release cut after its apply (firstStageRules), so each later
 *   stage promotes that release; `release.cut: false` turns the cut off.
 *
 * `environments.<name>.hooks.<when>` (chant#5421) reaches `pipelineFromConfig`
 * as written, which maps each `<when>` onto the stage's `hooks`; the merge
 * path's waves, the first stage's, run its hooks beside terragucci's own
 * (firstStageRules).
 *
 * A rule's `roots` is chant's `targets`, as in the top-level `approval_rules`.
 *
 * `terragucci ci` writes the file with chant's `pipelineSource`, and
 * `terragucci ci --check` fails with chant's `checkPipelineFile` when the
 * committed file is not the one the config writes now. With no `promotion`,
 * no file is written: the pipeline is off until a config sets it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateQuorumNode, GateQuorumRule } from "@intentius/chant/gate-decision";
import {
  checkPipelineFile,
  foldPipelineSource,
  pipelineFromConfig,
  pipelineSoakSection,
  pipelineSource,
  laterStageRisk,
  laterStageRiskLines,
  readPipelineAt,
  stageWavesSpec,
  writePipelineFile,
  PIPELINE_FILE,
  type PipelineDeclaration,
  type PipelineFailureTolerance,
  type Soak,
  type PipelineEnvironmentConfig,
  type PipelineSpec,
  type PipelineWave,
} from "@intentius/chant/pipeline";
import type { OpWaveHolds, OpWaveHook, OpWaveHooks } from "@intentius/chant/op";
import { environmentSetsProblems, type EnvironmentSet, type EnvironmentSets } from "@intentius/chant/components";
import { globMatch } from "./detect";
import { WAVES_OP, WAVES_SPEC, waveName } from "./chant-waves";
import { approvalModeOf, ConfigError, ENVIRONMENT_STAGE_KEYS, normalizeGate, type ApprovalRuleSettings, type EnvironmentSetSettings, type ProjectSettings, type RiskSettings, type StageApprovalRule } from "./config";
import { environmentOf, topGate } from "./environments";

/** The bin the release cut and the artifacts publish run as on the merge path: `terragucci release cut`, `terragucci pipeline artifacts publish`. */
export const RELEASE_BIN = ["terragucci"] as const;

/** The command that writes the file, as its header and `--check` name it. */
export const PIPELINE_COMMAND = "terragucci ci";
const SOURCE_OPTIONS = { product: "terragucci", config: "terragucci.yml", command: PIPELINE_COMMAND } as const;

/** A stage rule (or group) in chant's words: `roots` is `targets`, the rest as written. */
function stageRule(r: StageApprovalRule): Record<string, unknown> {
  if ("all" in r) return { ...(r.name ? { name: r.name } : {}), all: r.all.map(stageRule) };
  if ("any" in r) return { ...(r.name ? { name: r.name } : {}), any: r.any.map(stageRule) };
  const { roots, ...rest } = r;
  return { ...rest, ...(roots?.length ? { targets: [...roots] } : {}) };
}

/** The top-level `approval_rules` (each with `roots`) in chant's words. */
function topRules(rules: readonly ApprovalRuleSettings[]): Record<string, unknown>[] {
  return rules.map(({ roots, ...rest }) => ({ ...rest, targets: [...roots] }));
}

/** A `risk` map as chant's `holds.risk`: `approveAbove` and the flat rules an over score adds. */
function riskHold(risk: RiskSettings | undefined, fallback?: number): { approveAbove?: number; quorum?: GateQuorumRule[] } | undefined {
  const approveAbove = risk?.approve_above ?? fallback;
  const quorum = (risk?.approval_rules ?? []).map(stageRule) as unknown as GateQuorumNode[];
  if (approveAbove === undefined && quorum.length === 0) return undefined;
  return { ...(approveAbove !== undefined ? { approveAbove } : {}), ...(quorum.length ? { quorum: quorum as GateQuorumRule[] } : {}) };
}

/**
 * Each stage's waves: `layers` (the merge path's waves, canary first) cut to
 * the stage's roots, renumbered from 1. The first wave is the canary when
 * `waves.canary` names every root in it and the stage's soak has a check,
 * since chant holds the waves after a canary on its soak and refuses a canary
 * with none.
 */
export function stageWaves(layers: readonly string[][], stage: string, settings: Pick<ProjectSettings, "environments" | "waves">): PipelineWave[] {
  const soaks = (settings.environments?.[stage]?.soak?.checks?.length ?? 0) > 0;
  const canary = soaks ? (settings.waves?.canary ?? []) : [];
  const cut = layers.map((roots) => roots.filter((r) => environmentOf(r, settings) === stage)).filter((roots) => roots.length > 0);
  return cut.map((roots, i) => ({
    name: waveName(i + 1),
    runs: [...roots].sort().map((target) => ({ target })),
    ...(i === 0 && canary.length > 0 && roots.every((r) => canary.some((g) => globMatch(g, r))) ? { canary: true } : {}),
  }));
}

/** The stage keys of one environment, as `pipelineFromConfig` reads them, with its rules in chant's words. */
function stageConfig(e: NonNullable<ProjectSettings["environments"]>[string]): PipelineEnvironmentConfig {
  const picked = Object.fromEntries((ENVIRONMENT_STAGE_KEYS as readonly string[]).filter((k) => (e as unknown as Record<string, unknown>)[k] !== undefined).map((k) => [k, (e as unknown as Record<string, unknown>)[k]]));
  // Read by the mapping below or by chant elsewhere: not keys of pipelineFromConfig.
  for (const k of ["risk", "replan_dependents", "config", "secrets", "imports"]) delete picked[k];
  return {
    ...picked,
    ...(e.gate !== undefined ? { gate: normalizeGate(e.gate) } : {}),
    ...(e.forge_environment !== undefined ? { forge_environment: e.forge_environment } : {}),
    ...(e.approval_rules ? { approval_rules: e.approval_rules.map(stageRule) as unknown as PipelineEnvironmentConfig["approval_rules"] } : {}),
  } as PipelineEnvironmentConfig;
}

/**
 * The declaration terragucci.yml makes, or undefined with no `promotion`.
 * `layers` are the merge path's waves, as the committed waves spec lists
 * their roots. `step` is that spec's `step`, which each stage's waves plan
 * and apply through: chant's `stageWavesSpec` refuses a stage with no step,
 * so the merge path could not take its first stage's rules without it.
 * Throws when chant refuses it.
 */
export function pipelineDeclaration(settings: ProjectSettings, layers: readonly string[][], step?: Record<string, unknown>): PipelineDeclaration | undefined {
  const promotion = settings.promotion;
  if (!promotion?.length) return undefined;
  const environments = settings.environments ?? {};
  const waves = Object.fromEntries(promotion.map((stage) => [stage, stageWaves(layers, stage, settings)]));
  const empty = promotion.filter((stage) => waves[stage]!.length === 0);
  if (empty.length) throw new ConfigError(`promotion: ${empty.join(", ")} ${empty.length === 1 ? "has" : "have"} no roots in the committed waves spec (${WAVES_SPEC}); run terragucci init after adding the environment's roots`);
  const approval = approvalModeOf(settings.approval);
  const declaration = pipelineFromConfig({
    name: WAVES_OP,
    promotion,
    environments: Object.fromEntries(promotion.map((stage) => [stage, environments[stage] ? stageConfig(environments[stage]!) : {}])),
    gate: topGate(settings),
    ...(approval ? { approval: approval as NonNullable<Parameters<typeof pipelineFromConfig>[0]["approval"]> } : {}),
    ...(settings.approval_rules?.length ? { approvalRules: topRules(settings.approval_rules) as never } : {}),
    waves,
    defaults: {
      op: WAVES_OP,
      ...(step ? { step: structuredClone(step) as never } : {}),
      ...(riskHold(settings.risk) ? { holds: { risk: riskHold(settings.risk)! } } : {}),
      ...(settings.replan_dependents?.length ? { replanDependents: [...settings.replan_dependents] } : {}),
    },
    // The merge applies the first stage and cuts a release (chant#5324): `release.cut: false` turns it off. The cut
    // and the artifacts publish run as terragucci, which the wave jobs have, and terragucci hands them to chant.
    release: { ...(settings.release ?? {}), bin: [...RELEASE_BIN] },
    ...(settings.recheck ? { recheck: { schedule: settings.recheck.schedule } } : {}),
  });
  // What pipelineFromConfig leaves to the product: a stage's risk hold and its replanDependents.
  for (const stage of declaration.stages) {
    const e = environments[stage.name];
    if (!e) continue;
    const risk = e.risk ? riskHold(e.risk, settings.risk?.approve_above) : undefined;
    if (risk) stage.gate = { ...stage.gate, holds: { ...stage.gate?.holds, risk } };
    if (e.replan_dependents?.length) stage.replanDependents = [...e.replan_dependents];
  }
  return pipeline(declaration);
}

/** chant's own check of a declaration, after the product's additions: fold its source and take the spec. */
function pipeline(declaration: PipelineDeclaration): PipelineDeclaration {
  const folded = foldPipelineSource(pipelineSource(declaration, SOURCE_OPTIONS), PIPELINE_FILE);
  if ("finding" in folded) throw new ConfigError(`promotion: chant refuses the pipeline terragucci.yml makes: ${folded.finding.message}`);
  // The merge path takes its rules from the first stage's op-waves spec: with the step known, that spec must build.
  const first = folded.spec.stages[0];
  if (declaration.defaults?.step && first) {
    try {
      stageWavesSpec(folded.spec, first.name);
    } catch (e) {
      throw new ConfigError(`promotion: chant refuses the merge path's spec for ${first.name}: ${(e as Error).message}`);
    }
  }
  return declaration;
}

/** The step the committed waves spec plans and applies through, which each stage's waves take (`defaults.step`). */
export function committedStep(repo: string): Record<string, unknown> | undefined {
  const path = join(repo, WAVES_SPEC);
  if (!existsSync(path)) return undefined;
  const step = (JSON.parse(readFileSync(path, "utf-8")) as { step?: unknown }).step;
  return step && typeof step === "object" ? (step as Record<string, unknown>) : undefined;
}

/** The merge path's waves as the committed waves spec lists their roots, or why it cannot be read. */
export function committedLayers(repo: string): string[][] {
  const path = join(repo, WAVES_SPEC);
  if (!existsSync(path)) throw new ConfigError(`${WAVES_SPEC} is missing; run terragucci init first, which writes the waves each stage is cut from`);
  const spec = JSON.parse(readFileSync(path, "utf-8")) as { waves?: { runs?: { target: string }[]; discover?: unknown }[] };
  if (!Array.isArray(spec.waves) || spec.waves.some((w) => w.discover)) throw new ConfigError(`promotion: ${WAVES_SPEC} lists waves found at plan time, and a stage needs its roots named; promotion takes plain roots`);
  return spec.waves.map((w) => (w.runs ?? []).map((r) => r.target));
}

/** The text of `.chant/pipeline.ts` for `settings`, or undefined with no `promotion`. */
export function pipelineText(repo: string, settings: ProjectSettings): string | undefined {
  if (!settings.promotion?.length) return undefined;
  const declaration = pipelineDeclaration(settings, committedLayers(repo), committedStep(repo));
  return declaration ? pipelineSource(declaration, SOURCE_OPTIONS) : undefined;
}

/**
 * `terragucci ci` and `terragucci ci --check`: write `.chant/pipeline.ts`
 * from terragucci.yml, or fail (exit 1) when the committed one is stale or
 * missing. With no `promotion`, there is nothing to write or check.
 */
export function pipelineCommand(repo: string, settings: ProjectSettings, o: { check?: boolean; log?: (line: string) => void } = {}): number {
  const log = o.log ?? ((l: string) => console.log(l));
  const sets = setsCommand(repo, settings, o.check === true, log);
  const text = pipelineText(repo, settings);
  if (text === undefined) {
    log(`terragucci ci: promotion is not set in terragucci.yml, so there is no ${PIPELINE_FILE} to ${o.check ? "check" : "write"}`);
    return sets;
  }
  if (o.check) {
    const found = checkPipelineFile(repo, text, { command: PIPELINE_COMMAND });
    if (found.status === "current") {
      log(`terragucci ci --check: ${PIPELINE_FILE} is what terragucci.yml writes`);
      return sets;
    }
    log(`terragucci ci --check: ${found.message}`);
    if (found.status === "stale") for (const line of found.diff) log(line);
    return 1;
  }
  log(writePipelineFile(repo, text) ? `terragucci ci: wrote ${PIPELINE_FILE}` : `terragucci ci: ${PIPELINE_FILE} is already what terragucci.yml writes`);
  return sets;
}

/** `ci.environmentSets` in chant.workspace.json: written, or with `check` compared; 1 when it is stale. */
function setsCommand(repo: string, settings: ProjectSettings, check: boolean, log: (line: string) => void): number {
  const path = join(repo, WORKSPACE_DECLARATION);
  const text = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  const want = workspaceWithSets(text, environmentSetsOf(settings));
  if (want === undefined || want === text) return 0;
  if (check) {
    log(`terragucci ci --check: ${WORKSPACE_DECLARATION} ci.environmentSets is not what terragucci.yml writes; run \`${PIPELINE_COMMAND}\` and commit it`);
    return 1;
  }
  writeFileSync(path, want);
  log(`terragucci ci: wrote ci.environmentSets in ${WORKSPACE_DECLARATION}`);
  return 0;
}

/** The committed pipeline in `dir`, folded, or undefined when there is none or it does not fold. */
export function committedPipeline(dir: string): PipelineSpec | undefined {
  const path = join(dir, PIPELINE_FILE);
  if (!existsSync(path)) return undefined;
  const folded = foldPipelineSource(readFileSync(path, "utf-8"), PIPELINE_FILE);
  return "spec" in folded ? folded.spec : undefined;
}

/**
 * The plan note's lines for the pipeline at `dir`: chant's soak section (the
 * soaks a change passes through once it merges) and, with a score, how each
 * later stage reads it. One notice a line; empty when the pipeline sets
 * neither.
 */
export function pipelineNoteLines(spec: PipelineSpec | undefined, score?: number): string[] {
  if (!spec) return [];
  const soak = pipelineSoakSection(spec);
  const risk = score !== undefined ? laterStageRiskLines(laterStageRisk(spec, { score, reasons: [] }), score) : [];
  return [...(soak ? soak.split("\n") : []), ...risk].filter((l) => l.trim() !== "");
}

/** What the merge path's waves spec takes from the first stage of the pipeline committed at base. */
export interface FirstStageRules {
  /** The stage's holds (`risk`), else the pipeline's defaults. */
  holds?: OpWaveHolds;
  /** The stage's `replanDependents`, else the pipeline's defaults. */
  replanDependents?: string[];
  /** The canary wave's soak: the stage's, when its first wave is the canary. */
  canarySoak?: Soak;
  /** The stage's `failureTolerance`, for each wave. */
  failureTolerance?: PipelineFailureTolerance;
  /** The stage's `hooks` (`environments.<name>.hooks.<when>`, chant#5421), which the merge path's waves run beside terragucci's own. */
  hooks?: OpWaveHooks;
  /**
   * The hooks chant puts after the apply of the first stage's last wave
   * (`stageWavesSpec`): the release cut and, when the stage publishes, the
   * artifacts publish. Empty with `release.cut: false`.
   */
  releaseHooks?: OpWaveHook[];
}

/**
 * Two hook sets as one: each moment's hooks of `first`, then those of
 * `then`, as chant joins a stage's hooks onto the pipeline's defaults.
 */
export function joinHooks(first: OpWaveHooks | undefined, then: OpWaveHooks | undefined): OpWaveHooks | undefined {
  if (!first) return then;
  if (!then) return first;
  const both = (k: "before" | "after"): Record<string, OpWaveHook[]> | undefined => {
    const a = (first[k] ?? {}) as Record<string, OpWaveHook[]>;
    const b = (then[k] ?? {}) as Record<string, OpWaveHook[]>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.length === 0 ? undefined : Object.fromEntries(keys.map((m) => [m, [...(a[m] ?? []), ...(b[m] ?? [])]]));
  };
  const before = both("before");
  const after = both("after");
  const apply = then.apply ?? first.apply;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}), ...(apply ? { apply } : {}) } as OpWaveHooks;
}

/**
 * The rules the merge path's waves take from the pipeline committed at
 * `sha`, folded by chant (`readPipelineAt`) and cut to its first stage by
 * chant's `stageWavesSpec`, so the spec terragucci renders carries the folded
 * one's holds, replan and soak. Undefined when the commit has no pipeline.
 * Throws when the committed pipeline does not fold, so the wave fails
 * rather than run without its rules.
 */
export function firstStageRules(repo: string, sha: string): FirstStageRules | undefined {
  const read = readPipelineAt(sha, repo);
  if (read.status === "absent") return undefined;
  if (read.status === "refused") throw new ConfigError(`the waves' rules are read from ${PIPELINE_FILE} at ${sha.slice(0, 12)}, and it does not fold: ${read.line}`);
  const first = read.spec.stages[0];
  if (!first) return undefined;
  const stage = stageWavesSpec(read.spec, first.name);
  const canary = stage.waves[0]?.canary === true ? stage.waves[0].soak : undefined;
  // chant#5324: the merge applies the first stage and cuts a release, which each later stage promotes.
  const releaseHooks = structuredClone(stage.waves.at(-1)?.hooks?.after?.apply ?? []);
  return {
    ...(stage.holds ? { holds: stage.holds } : {}),
    ...(stage.replanDependents?.length ? { replanDependents: [...stage.replanDependents] } : {}),
    ...(canary ? { canarySoak: canary } : {}),
    ...(first.failureTolerance !== undefined ? { failureTolerance: first.failureTolerance } : {}),
    ...(stage.hooks ? { hooks: structuredClone(stage.hooks) } : {}),
    ...(releaseHooks.length ? { releaseHooks } : {}),
  };
}

/** `risk.approve_above` and `replan_dependents` as the merge path's spec takes them when no pipeline is committed. */
export function topLevelRules(settings: Pick<ProjectSettings, "risk" | "replan_dependents">): FirstStageRules {
  const risk = riskHold(settings.risk);
  return { ...(risk ? { holds: { risk } } : {}), ...(settings.replan_dependents?.length ? { replanDependents: [...settings.replan_dependents] } : {}) };
}

/** A set's secret place in chant's words: a forge secret's name as it is, a map's snake_case keys in camelCase. */
const SET_SECRET_WORDS: Record<string, string> = { forge_secret: "forgeSecret", aws_secrets_manager: "awsSecretsManager", gcp_secret_manager: "gcpSecretManager", azure_key_vault: "azureKeyVault", json_key: "jsonKey" };

function setOf(s: EnvironmentSetSettings): EnvironmentSet {
  return {
    ...(s.imports?.length ? { imports: [...s.imports] } : {}),
    ...(s.config && Object.keys(s.config).length ? { config: { ...s.config } } : {}),
    ...(s.secrets && Object.keys(s.secrets).length
      ? { secrets: Object.fromEntries(Object.entries(s.secrets).map(([k, v]) => [k, typeof v === "string" ? v : Object.fromEntries(Object.entries(v).map(([w, x]) => [SET_SECRET_WORDS[w] ?? w, x]))])) as EnvironmentSet["secrets"] }
      : {}),
  };
}

/**
 * `environments.<name>.config`, `.secrets` and `.imports`, and `config_sets`,
 * as chant's `EnvironmentSets` (chant#5348). Undefined when no environment
 * sets any. chant checks them (`environmentSetsProblems`).
 */
export function environmentSetsOf(settings: Pick<ProjectSettings, "environments" | "config_sets">): EnvironmentSets | undefined {
  const named = Object.entries(settings.environments ?? {}).filter(([, e]) => e.config !== undefined || e.secrets !== undefined || e.imports !== undefined);
  if (named.length === 0 && !settings.config_sets) return undefined;
  const sets: EnvironmentSets = {
    environments: Object.fromEntries(Object.keys(settings.environments ?? {}).map((name) => [name, setOf(settings.environments![name]!)])),
    ...(settings.config_sets ? { configSets: Object.fromEntries(Object.entries(settings.config_sets).map(([k, v]) => [k, setOf(v)])) } : {}),
  };
  const [problem] = environmentSetsProblems(sets);
  if (problem) throw new ConfigError(`environments: chant refuses the config and secret sets: ${problem}`);
  return sets;
}

/** The workspace declaration chant reads `ci.environmentSets` from. */
export const WORKSPACE_DECLARATION = "chant.workspace.json";

/**
 * chant.workspace.json's text with `ci.environmentSets` set to `sets`, or
 * taken out with none; undefined when the file is missing and there is
 * nothing to write.
 */
export function workspaceWithSets(text: string | undefined, sets: EnvironmentSets | undefined): string | undefined {
  if (text === undefined && !sets) return undefined;
  if (text === undefined) throw new ConfigError(`${WORKSPACE_DECLARATION} is missing, and the environments' config and secrets go in its ci.environmentSets; run terragucci init first`);
  const decl = JSON.parse(text) as { ci?: Record<string, unknown> };
  if (!sets && decl.ci?.environmentSets === undefined) return text;
  const ci = { ...(decl.ci ?? {}) };
  if (sets) ci.environmentSets = sets;
  else delete ci.environmentSets;
  const out = { ...decl, ...(Object.keys(ci).length || decl.ci ? { ci } : {}) };
  return `${JSON.stringify(out, null, 2)}\n`;
}
