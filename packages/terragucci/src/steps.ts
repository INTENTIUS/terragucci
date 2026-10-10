/**
 * `steps:` in terragucci.yml: commands run before and after a root's init,
 * plan, apply and drift, inside the stage's own job. The stage code calls
 * them, so they need no pipeline job of their own and work the same on
 * every forge.
 *
 * A step runs in the root's directory, with the job's environment less its
 * forge tokens (binaryEnv, as the binary gets it), plus `TG_STAGE`,
 * `TG_STEP`, `TG_ROOT`, `TG_REPO` and, after a plan, `TG_PLAN_FILE`. Its
 * output goes to the job log.
 *
 * A non-zero exit fails the root, so nothing in its wave applies. With
 * `on_failure: approve` it holds the root's wave at its gate instead: the
 * wave waits for an approval of its set digest whatever `gate` says, through
 * the same ledger as every other wave (apply.ts).
 *
 * In a Terragrunt repo a wave plans and applies its units with one
 * `run --all` each, so a moment comes once for the wave and each step runs
 * in every unit its `roots` globs match (runUnitSteps). `after: init` is
 * refused there: Terragrunt inits each unit inside the plan.
 *
 * The steps are read from terragucci.yml at base, never from the change
 * being planned or applied: a pull request's plan reads the target branch's
 * file, a pull request applied before it merges reads the base it names, and
 * a wave after a merge reads the applied commit's first parent, as the
 * approval rule is read. So a change cannot add, edit or remove a step that
 * runs with its own apply credentials. When the base cannot be read and the
 * checkout names no steps, none run; when the checkout names some, the run
 * fails rather than guess.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { binaryEnv } from "./binary-env";
import { ConfigError, findConfig, resolveProject, resolveRepo, type StepSettings, type StepStage, type TerragucciConfig } from "./config";
import { globMatch } from "./detect";
import { configAtBase } from "./report/policy";
import type { ReportStep, ReportStepWhen } from "./report/schema";
import { baseCommit } from "./seal";

export type StepWhen = ReportStepWhen;

/** The steps a run uses, and where they were read. */
export interface StepsSource {
  steps: StepSettings[];
  /** The ref the steps were read at, or `checkout` when there was no base. */
  from: string;
  /** A line for the log, when the base could not be read and no steps run. */
  note?: string;
}

/** `before-plan` and the like, for a step. */
export const stepWhen = (s: StepSettings): StepWhen => (s.before ? `before-${s.before}` : `after-${s.after!}`) as StepWhen;

/** A step's name: its own, or its command's first line, cut at 60 characters. */
export function stepName(s: StepSettings): string {
  if (s.name) return s.name;
  const line = s.run.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** The steps of one moment of one root, in the order the config lists them. */
export function stepsAt(steps: readonly StepSettings[], when: StepWhen, root: string): StepSettings[] {
  return steps.filter((s) => stepWhen(s) === when && (!s.roots || s.roots.some((g) => globMatch(g, root))));
}

/** The settings of the repo, or of the control repo's project, in a config. */
function settingsOf(config: TerragucciConfig, project: string | undefined) {
  return project ? resolveProject(config, project) : resolveRepo(config);
}

/**
 * The steps a run uses: those in terragucci.yml at `base`, or the checkout's
 * when there is no base (`checkout` names the steps the checkout has).
 * A base whose config cannot be read gives no steps when the checkout names
 * none, and throws when it names some.
 */
export async function readSteps(repo: string, base: string | undefined, checkout: StepSettings[] | undefined, options: { config?: string; project?: string } = {}): Promise<StepsSource> {
  if (!base) return { steps: checkout ?? [], from: "checkout" };
  const configPath = options.config ?? findConfig(repo);
  const read = await configAtBase(repo, base, configPath ? { config: configPath } : {});
  let why: string | undefined;
  if ("error" in read) why = read.error;
  else {
    try {
      return { steps: settingsOf(read.config, options.project).steps ?? [], from: base };
    } catch (e) {
      why = (e as Error).message;
    }
  }
  if (!checkout?.length) return { steps: [], from: base, note: `steps: the config at ${base} could not be read (${why}); this checkout names no steps, so none run` };
  throw new ConfigError(`steps are read from the config at ${base}, and it could not be read (${why}), so no step can be trusted to run`);
}

/**
 * The base a wave reads its steps at: the one it was given (a pull request
 * applied before it merges), else the applied commit's first parent.
 */
export function waveStepsBase(repo: string, given: string | undefined): string {
  return given ?? baseCommit(repo);
}

/** What one moment's steps came to for one root. */
export interface StepsOutcome {
  runs: ReportStep[];
  /** Set when a step failed and its root fails: the error, with the end of its output. */
  error?: string;
  /** The names of steps whose failure holds the wave for an approval. */
  holds: string[];
}

export interface StepContext {
  repo: string;
  root: string;
  stage: "tf-plan" | "tf-apply" | "tf-drift";
  env: NodeJS.ProcessEnv;
  /** After a plan or before an apply: the plan file. */
  planFile?: string;
  log: (line: string) => void;
}

/** Run one shell command, keeping its output. */
function sh(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    child.on("error", (e) => done({ code: null, out: e.message }));
    child.on("close", (code) => done({ code, out: Buffer.concat(out).toString("utf-8") }));
  });
}

const tail = (s: string, n = 20): string => s.trim().split("\n").slice(-n).join("\n");

/**
 * Run the steps of one moment for one root, in order. A failed step stops
 * the rest and fails the root, unless it has `on_failure: approve`: then it
 * holds the wave, and the steps after it run.
 */
export async function runSteps(steps: readonly StepSettings[], when: StepWhen, ctx: StepContext): Promise<StepsOutcome> {
  const out: StepsOutcome = { runs: [], holds: [] };
  for (const step of stepsAt(steps, when, ctx.root)) {
    const name = stepName(step);
    const env = {
      ...binaryEnv(ctx.env),
      TG_STAGE: ctx.stage,
      TG_STEP: when,
      TG_ROOT: ctx.root,
      TG_REPO: ctx.repo,
      ...(ctx.planFile ? { TG_PLAN_FILE: ctx.planFile } : {}),
    };
    const started = Date.now();
    const r = await sh(step.run, join(ctx.repo, ctx.root), env);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    for (const line of r.out.split("\n").filter((l) => l.trim())) ctx.log(`${ctx.root}: ${when} ${name}: ${line}`);
    if (r.code === 0) {
      out.runs.push({ name, when, status: "passed", exit: 0, seconds });
      ctx.log(`${ctx.root}: ${when} step ${name} passed`);
      continue;
    }
    if (step.on_failure === "approve") {
      out.runs.push({ name, when, status: "approval", exit: r.code, seconds });
      out.holds.push(name);
      ctx.log(`${ctx.root}: ${when} step ${name} exited ${r.code ?? "without a code"}, so its wave waits for an approval`);
      continue;
    }
    out.runs.push({ name, when, status: "failed", exit: r.code, seconds });
    ctx.log(`${ctx.root}: ${when} step ${name} failed (exit ${r.code ?? "none"})`);
    out.error = `step ${when} ${name} failed with exit ${r.code ?? "none"}${r.out.trim() ? `:\n${tail(r.out)}` : ""}`;
    return out;
  }
  return out;
}

/**
 * Why `after: init` is refused in a Terragrunt repo: Terragrunt inits each
 * unit inside the wave's `run --all plan`, so nothing runs between a unit's
 * init and its plan. Every other moment runs (runUnitSteps).
 */
export const STEPS_AFTER_INIT_TERRAGRUNT =
  "a Terragrunt repo inits each unit inside the wave's run --all plan, so no step can run between a unit's init and its plan; use before: plan instead of after: init";

/** The refusal for a Terragrunt repo's steps, or undefined when every step can run. */
export function terragruntStepsRefusal(steps: readonly StepSettings[] | undefined): string | undefined {
  const late = (steps ?? []).filter((s) => s.after === "init").map(stepName);
  return late.length ? `steps ${late.join(", ")}: ${STEPS_AFTER_INIT_TERRAGRUNT}` : undefined;
}

/**
 * One moment's steps for the units of a Terragrunt wave, which plans or
 * applies with one `run --all`: the moment comes once for the whole wave, and
 * each step runs in the directory of every unit its `roots` globs match, unit
 * by unit in wave order. `planFile` gives a unit's saved plan, after a plan
 * and before an apply. The outcome of each unit with a step at this moment.
 */
export async function runUnitSteps(
  steps: readonly StepSettings[],
  when: StepWhen,
  units: readonly string[],
  ctx: Omit<StepContext, "root" | "planFile"> & { planFile?: (unit: string) => string | undefined },
): Promise<Map<string, StepsOutcome>> {
  const out = new Map<string, StepsOutcome>();
  for (const unit of units) {
    if (stepsAt(steps, when, unit).length === 0) continue;
    const planFile = ctx.planFile?.(unit);
    out.set(unit, await runSteps(steps, when, { repo: ctx.repo, root: unit, stage: ctx.stage, env: ctx.env, log: ctx.log, ...(planFile ? { planFile } : {}) }));
  }
  return out;
}

/** The steps a stage of a given kind ever runs (`plan` steps do not run in drift, `drift` steps only there). */
export function stepsUsed(steps: readonly StepSettings[], stage: StepContext["stage"]): StepSettings[] {
  const used: Record<StepContext["stage"], StepStage[]> = { "tf-plan": ["init", "plan"], "tf-apply": ["init", "plan", "apply"], "tf-drift": ["init", "drift"] };
  return steps.filter((s) => used[stage].includes((s.before ?? s.after)!));
}
