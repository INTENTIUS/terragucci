/**
 * `ci.hooks` in chant.workspace.json: commands run before and after each
 * root's plan and apply, inside the stage's own job. chant reads and checks
 * the block (`readDeclaration`), and chant's stage hook runner
 * (`runStageHooks`, from `@intentius/chant/op/stage-hooks`) runs a moment's
 * hooks: which roots a hook is for, how its argv is filled and what a
 * failure does. The stage code calls the hooks, so they need no pipeline
 * job of their own and work the same on every forge.
 *
 * terragucci runs each hook for each root its `targets` match (every root
 * when unset), in that root's directory, so a hook must set `perRun: true`.
 * `{target}`, `CHANT_TARGET` and `TG_ROOT` name the root. A hook gets the
 * job's environment less its forge tokens (binaryEnv, as the binary gets it),
 * chant's hook variables (`CHANT_HOOK`, `CHANT_TARGET`, `CHANT_RUNS` among
 * them), and `TG_STAGE`, `TG_ROOT`, `TG_REPO` and, after a plan,
 * `TG_PLAN_FILE` (also `{plan}` and `CHANT_PLAN`).
 *
 * The moments: `before.observe` before the root's init, `before.plan` after
 * it, `after.plan` once the root planned, and `before.apply` and
 * `after.apply` around its apply. A drift job runs the plan-side moments
 * around its refresh-only plan.
 *
 * A non-zero exit fails the root, so nothing in its wave applies. With
 * `onFailure: "approve"` it holds the root's wave at its gate instead: the
 * wave waits for an approval of its set digest whatever `gate` says.
 *
 * The hooks are read from the declaration at base, never from the change
 * being planned or applied, as chant's pull-request jobs read them
 * (`prLoopHooksAt`), so a change cannot add, edit or remove a hook that runs
 * with its own apply credentials.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runStageHooks } from "@intentius/chant/op/stage-hooks";
import { opWaveHookRuns, PR_LOOP_HOOK_MOMENTS, type OpWaveHook, type OpWaveHookMoment, type OpWaveHooks } from "@intentius/chant/op/op-waves";
import { readDeclaration, WorkspaceReadError } from "@intentius/chant/workspace/declaration";
import { locateWorkspace } from "@intentius/chant/workspace/which-chant";
import { binaryEnv } from "./binary-env";
import { ConfigError } from "./config";
import type { ReportStep } from "./report/schema";

/** The moments terragucci runs: those of chant's pull-request jobs. */
export type HookMoment = Exclude<OpWaveHookMoment, "after-gate">;

/** A declaration's hooks, by moment, top level first. */
export type StageHooks = Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;

/** The hooks a run uses, and where they were read. */
export interface HooksSource {
  hooks: StageHooks;
  /** The ref the hooks were read at, or `checkout` when there was no base. */
  from: string;
  /** A line for the log, when none run because the base has no declaration or could not be read. */
  note?: string;
}

/** A hook's name: its own, or its command, cut at 60 characters, as chant names it. */
export function hookName(h: OpWaveHook): string {
  const line = h.command.join(" ");
  return h.name ?? (line.length > 60 ? `${line.slice(0, 57)}...` : line);
}

/** How many hooks there are. */
export const hookCount = (hooks: StageHooks): number => Object.values(hooks).reduce((n, l) => n + (l?.length ?? 0), 0);

/** The hooks terragucci cannot run: each runs for each root, so it must set `perRun`. */
export function hookProblems(hooks: StageHooks): string[] {
  return Object.entries(hooks).flatMap(([moment, list]) =>
    (list ?? []).filter((h) => !h.perRun).map((h) => `ci.hooks ${moment} ${hookName(h)}: terragucci runs a hook for each root it matches, in that root's directory, so set perRun: true`),
  );
}

function checked(source: HooksSource): HooksSource {
  const problems = hookProblems(source.hooks);
  if (problems.length) throw new ConfigError(problems.join("; "), problems);
  return source;
}

/** A `ci.hooks` block by moment, as chant's pull-request jobs take it (`prLoopHooksOf`). */
function byMoment(hooks: OpWaveHooks | undefined): StageHooks {
  const out: StageHooks = {};
  for (const moment of PR_LOOP_HOOK_MOMENTS) {
    const [side, stage] = moment.split("-") as ["before" | "after", string];
    const list = (hooks?.[side] as Record<string, OpWaveHook[] | undefined> | undefined)?.[stage] ?? [];
    if (list.length > 0) out[moment] = list;
  }
  return out;
}

/** The top level's `ci.hooks` in the declaration at `base`, or the checkout's. Throws chant's WorkspaceReadError. */
const hooksIn = (repo: string, base?: string): StageHooks => byMoment(readDeclaration(locateWorkspace(repo, base).tree).ci?.hooks);

const missing = (e: unknown): boolean => e instanceof WorkspaceReadError && (e.code === "declaration-missing" || e.code === "not-a-git-repository");

/** The checkout's own `ci.hooks`, for a run with no base. */
function checkoutHooks(repo: string): StageHooks {
  try {
    return hooksIn(repo);
  } catch (e) {
    if (missing(e)) return {};
    throw new ConfigError(`ci.hooks: chant.workspace.json could not be read (${(e as Error).message})`);
  }
}

/**
 * The hooks a run uses: those in chant.workspace.json at `base`, or the
 * checkout's when there is no base. A base with no declaration gives none. A
 * base whose declaration cannot be read gives no hooks when the checkout
 * names none, and throws when it names some.
 */
export function readHooks(repo: string, base: string | undefined): HooksSource {
  if (!base) return checked({ hooks: checkoutHooks(repo), from: "checkout" });
  try {
    return checked({ hooks: hooksIn(repo, base), from: base });
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const why = (e as Error).message;
    let named = false;
    try {
      named = hookCount(hooksIn(repo)) > 0;
    } catch {
      // An unreadable checkout declaration names no hook it could run.
    }
    if (!named) return { hooks: {}, from: base, ...(missing(e) ? {} : { note: `ci.hooks: the declaration at ${base} could not be read (${why}); this checkout names no hooks, so none run` }) };
    if (missing(e)) return { hooks: {}, from: base, note: `ci.hooks: ${base} has no chant.workspace.json, so the hooks this checkout declares do not run until it merges` };
    throw new ConfigError(`ci.hooks are read from chant.workspace.json at ${base}, and it could not be read (${why}), so no hook can be trusted to run`);
  }
}

/** The hooks a stage ever runs: a plan or a drift job runs no apply-side hooks. */
export function hooksUsed(hooks: StageHooks, stage: HookContext["stage"]): StageHooks {
  if (stage === "tf-apply") return hooks;
  const { "before-apply": _b, "after-apply": _a, ...plan } = hooks;
  return plan;
}

/** The hooks of one moment for one root, in the order the declaration lists them. */
export function hooksAt(hooks: StageHooks, moment: HookMoment, root: string): OpWaveHook[] {
  return (hooks[moment] ?? []).filter((h) => opWaveHookRuns(h, [{ target: root }]).length > 0);
}

/** What one moment's hooks came to for one root. */
export interface HooksOutcome {
  runs: ReportStep[];
  /** Set when a hook failed and its root fails: the error, with the end of its output. */
  error?: string;
  /** The names of hooks whose failure holds the wave for an approval. */
  holds: string[];
}

export interface HookContext {
  repo: string;
  root: string;
  stage: "tf-plan" | "tf-apply" | "tf-drift";
  env: NodeJS.ProcessEnv;
  /** After a plan or before an apply: the plan file. */
  planFile?: string;
  log: (line: string) => void;
}

const tail = (s: string, n = 20): string => s.trim().split("\n").slice(-n).join("\n");

/** The variables chant's runner sets itself, dropped from the job's environment so an inherited one cannot override them. */
const CHANT_HOOK_VARS = ["CHANT_OP_WAVES", "CHANT_WAVE", "CHANT_WAVE_NUMBER", "CHANT_HOOK", "CHANT_RUNS", "CHANT_HOLD", "CHANT_TARGET", "CHANT_PLAN"];

/** One hook call's output, exit and time, as the exec below saw it. */
interface HookCall {
  code: number | null;
  out: string;
  seconds: number;
}

/**
 * Run the hooks of one moment for one root, in order, through chant's
 * `runStageHooks`. A failed hook stops the rest and fails the root, unless it
 * has `onFailure: "approve"`: then it holds the wave, and the hooks after it
 * run. Each call runs to its end before the next starts, and the job waits
 * on it.
 */
export async function runHooks(hooks: StageHooks, moment: HookMoment, ctx: HookContext): Promise<HooksOutcome> {
  const out: HooksOutcome = { runs: [], holds: [] };
  const list = hooksAt(hooks, moment, ctx.root);
  if (list.length === 0) return out;
  const cwd = join(ctx.repo, ctx.root);
  const dir = mkdtempSync(join(tmpdir(), "terragucci-hooks-"));
  try {
    const run = { target: ctx.root, op: ctx.stage, ...(ctx.planFile ? { plan: ctx.planFile } : {}) };
    const runs = join(dir, "runs.json");
    writeFileSync(runs, `${JSON.stringify({ version: 1, op: ctx.stage, stage: ctx.stage, hook: moment, runs: [run] }, null, 2)}\n`);
    const jobEnv = Object.fromEntries(Object.entries(binaryEnv(ctx.env)).filter((e): e is [string, string] => e[1] !== undefined && !CHANT_HOOK_VARS.includes(e[0])));
    const env = { ...jobEnv, TG_STAGE: ctx.stage, TG_ROOT: ctx.root, TG_REPO: ctx.repo, ...(ctx.planFile ? { TG_PLAN_FILE: ctx.planFile } : {}) };
    const calls: HookCall[] = [];
    const exec = (argv: string[], at: string, callEnv: Record<string, string> = {}): number => {
      const file = join(dir, `out-${calls.length}`);
      const fd = openSync(file, "w");
      const started = Date.now();
      let r: ReturnType<typeof spawnSync>;
      try {
        r = spawnSync(argv[0]!, argv.slice(1), { cwd: at, env: callEnv, stdio: ["ignore", fd, fd] });
      } finally {
        closeSync(fd);
      }
      const code = r.error ? null : r.status;
      calls.push({ code, out: r.error ? r.error.message : readFileSync(file, "utf-8"), seconds: Math.round((Date.now() - started) / 100) / 10 });
      return code ?? 127;
    };
    const result = runStageHooks(moment, list, { name: ctx.stage, op: ctx.stage, wave: ctx.stage, runs: [run], runsFile: runs, holdFile: relative(cwd, join(dir, "hold.json")), env, cwd, exec, log: () => {} });
    result.outcomes.forEach((o, i) => {
      const call = calls[i]!;
      for (const line of call.out.split("\n").filter((l) => l.trim())) ctx.log(`${ctx.root}: ${moment} ${o.name}: ${line}`);
      if (o.outcome === "passed") {
        out.runs.push({ name: o.name, when: moment, status: "passed", exit: 0, seconds: call.seconds });
        ctx.log(`${ctx.root}: ${moment} hook ${o.name} passed`);
      } else if (o.outcome === "held") {
        out.runs.push({ name: o.name, when: moment, status: "approval", exit: call.code, seconds: call.seconds });
        out.holds.push(o.name);
        ctx.log(`${ctx.root}: ${moment} hook ${o.name} exited ${call.code ?? "without a code"}, so its wave waits for an approval`);
      } else {
        out.runs.push({ name: o.name, when: moment, status: "failed", exit: call.code, seconds: call.seconds });
        ctx.log(`${ctx.root}: ${moment} hook ${o.name} failed (exit ${call.code ?? "none"})`);
        out.error = `hook ${moment} ${o.name} failed with exit ${call.code ?? "none"}${call.out.trim() ? `:\n${tail(call.out)}` : ""}`;
      }
    });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One moment's hooks for the units of a Terragrunt wave, which plans or
 * applies with one `run --all`: the moment comes once for the whole wave,
 * and each hook runs in the directory of every unit its `targets` match,
 * unit by unit in wave order. `planFile` gives a unit's saved plan, after a
 * plan and before an apply. The outcome of each unit with a hook at this
 * moment.
 */
export async function runUnitHooks(
  hooks: StageHooks,
  moment: HookMoment,
  units: readonly string[],
  ctx: Omit<HookContext, "root" | "planFile"> & { planFile?: (unit: string) => string | undefined },
): Promise<Map<string, HooksOutcome>> {
  const out = new Map<string, HooksOutcome>();
  for (const unit of units) {
    if (hooksAt(hooks, moment, unit).length === 0) continue;
    const planFile = ctx.planFile?.(unit);
    out.set(unit, await runHooks(hooks, moment, { repo: ctx.repo, root: unit, stage: ctx.stage, env: ctx.env, log: ctx.log, ...(planFile ? { planFile } : {}) }));
  }
  return out;
}
