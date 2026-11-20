/**
 * `cost:` in terragucci.yml, mapped onto chant's cost estimate (chant#5334):
 * chant runs the estimator once per root whose plan changes something,
 * reads Infracost's JSON and sums the figures, and with `cost.approve_above`
 * its verdict (`opWaveCostVerdict`) holds a wave over the amount, with the
 * wave's cost as a member of its set digest. The wave hands the verdict to
 * chant's gate from its after-plan hook: a `holds.cost` in the spec would
 * have chant spawn the estimator itself, and a `terragucci run wave` job
 * (chant's `ProductWaveHook`) cannot give it the exec below. terragucci
 * keeps only the mapping and two things around the run:
 *
 * - `cost.command` stays a shell line reading `$TG_PLAN_JSON` and `$TG_ROOT`.
 *   chant takes argv and fills `{planJson}` and `{target}` in each element,
 *   so terragucci hands it `sh -c '<sets the two variables>; <command>' sh
 *   {planJson} {target}` ({@link costArgv}).
 * - The command reads the plan with its sensitive values redacted, and runs
 *   with the job's environment less its forge tokens, as before: chant runs
 *   it through terragucci's exec ({@link costExec}), which writes the
 *   redacted copy and strips the tokens.
 *
 * `cost.approve_above` is read at base (`--base`, else the commit before
 * the one applied), so a change cannot raise the amount its own apply is
 * judged by ({@link costRule}). `cost.key_secret` is the secret the jobs
 * map into `INFRACOST_API_KEY`, as `pass.secrets` maps a secret.
 *
 * The policy's `input.cost` is chant's record (camelCase: `monthlyDelta`,
 * `approveAbove`, `members`, `member`), with the snake_case fields of
 * terragucci's own record beside it for one release ({@link policyCostOf}).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { costEstimateOf, policyCost as chantPolicyCost, priceRuns, type CostEstimate, type CostEstimateExec, type CostEstimateSettings, type CostRun, type MemberCost } from "@intentius/chant/ci-product";
import { opWaveCostVerdict, type OpWaveRunCost } from "@intentius/chant/op";
import type { WaveMember } from "@intentius/chant/gated-waves";
import { binaryEnv } from "./binary-env";
import { resolveProject, resolveRepo, type CostSettings } from "./config";
import { configAtBase, type PolicyCost, type TrustedOptions } from "./report/policy";
import { redactPlan } from "./report/redact";
import type { ReportCost, ReportRootCost, ReportWaveCost } from "./report/schema";

/** Infracost over the root's plan JSON. The job installs Infracost and maps the key secret to INFRACOST_API_KEY. */
export const INFRACOST_COMMAND = 'infracost breakdown --path "$TG_PLAN_JSON" --format json --log-level error';

/** What sets the command's two variables from chant's `{planJson}` and `{target}`. */
const SCRIPT_HEAD = 'TG_PLAN_JSON="$1" TG_ROOT="$2"; export TG_PLAN_JSON TG_ROOT; ';

/** How long one root's estimate may take. */
const TIMEOUT_MS = 120_000;

/** The command `cost:` runs: its own `command`, else Infracost. */
export function costCommand(setting: CostSettings): string {
  return setting !== true && setting.command ? setting.command : INFRACOST_COMMAND;
}

/** The argv chant runs for a shell line: `sh -c` with `{planJson}` and `{target}` as `$1` and `$2`. */
export function costArgv(command: string): string[] {
  return ["sh", "-c", SCRIPT_HEAD + command, "sh", "{planJson}", "{target}"];
}

/** Whether chant is running terragucci's cost argv (with its placeholders filled). */
export function isCostArgv(argv: readonly string[]): boolean {
  return argv.length === 6 && argv[0] === "sh" && argv[1] === "-c" && (argv[2] ?? "").startsWith(SCRIPT_HEAD) && argv[3] === "sh";
}

/** The first word of the command, which the note and the report name as the estimator. */
export function estimatorName(command: string): string {
  return command.trim().split(/\s+/)[0]?.split("/").pop() ?? "estimator";
}

/** chant's `ci.cost` settings for a `cost` setting, with the amount at base when there is one. */
export function chantCostSettings(setting: CostSettings, approveAbove?: number): CostEstimateSettings {
  return { command: costArgv(costCommand(setting)), format: "infracost", ...(approveAbove !== undefined ? { approveAbove } : {}) };
}

/** How the estimator runs: its argv, the environment and the directory. Tests pass one. */
export type CostRunner = (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => { status: number | null; stdout: string; stderr: string };

const spawnRunner: CostRunner = (argv, env, cwd) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

/** One job's exec for chant's estimate: each root's output, and every run it made, by argv. */
export interface CostExec {
  /** chant's `CostEstimateExec`: terragucci's cost argv run over the redacted plan without the forge tokens; any other argv through `other`. */
  exec: CostEstimateExec;
  /** The estimator's output for each root it priced, kept beside the root's plan. */
  outputs: Map<string, string>;
}

/**
 * The exec chant runs the estimator through. The plan document chant names
 * (`{planJson}`, the argv's fifth element) is copied with its sensitive
 * values redacted into `work`, and the command runs on that copy with the
 * job's environment less its forge tokens. The same argv runs once a job:
 * the wave's hold and the policy's `input.cost` read the same run.
 */
export function costExec(env: NodeJS.ProcessEnv, work: string, o: { run?: CostRunner; other?: CostEstimateExec } = {}): CostExec {
  const run = o.run ?? spawnRunner;
  const clean = binaryEnv(env);
  const outputs = new Map<string, string>();
  const ran = new Map<string, ReturnType<CostEstimateExec>>();
  let n = 0;
  const exec: CostEstimateExec = (argv, cwd) => {
    if (!isCostArgv(argv)) return o.other ? o.other(argv, cwd) : spawnRunner(argv, process.env, cwd);
    const key = argv.join("\0");
    const seen = ran.get(key);
    if (seen) return seen;
    const target = argv[5]!;
    let redacted: string;
    try {
      const path = argv[4]!.startsWith("/") ? argv[4]! : join(cwd, argv[4]!);
      redacted = JSON.stringify(redactPlan(JSON.parse(readFileSync(path, "utf-8"))).plan);
    } catch (e) {
      const r = { status: 1, stdout: "", stderr: `the plan document could not be read to redact it: ${(e as Error).message}` };
      ran.set(key, r);
      return r;
    }
    mkdirSync(work, { recursive: true });
    const file = join(work, `cost-${n++}.json`);
    writeFileSync(file, redacted);
    const r = run([...argv.slice(0, 4), file, target], clean, cwd);
    // Node ends a crash with its own version line; the line before it says why.
    const result = { status: r.status, stdout: r.stdout, stderr: r.stderr.split("\n").filter((l) => !/^Node\.js v\d/.test(l)).join("\n") };
    ran.set(key, result);
    if (r.status === 0) outputs.set(target, r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    return result;
  };
  return { exec, outputs };
}

/** A root to price: its plan document and whether its plan changes nothing. */
export interface CostRoot {
  root: string;
  /** The engine's plan document (`show -json`), as chant's step wrote it or the plan stage kept it. */
  planJson: string;
  empty: boolean;
}

/**
 * Price the roots through chant (`priceRuns`, `costEstimateOf`), each root
 * whose plan changes something, and name the estimator after the command's
 * first word.
 */
export function estimateRoots(setting: CostSettings, roots: readonly CostRoot[], cwd: string, exec: CostEstimateExec, approveAbove?: number): CostEstimate {
  const settings = chantCostSettings(setting, approveAbove);
  const runs: CostRun[] = roots.map((r) => ({ member: r.root, artifact: { planJson: r.planJson }, empty: r.empty }));
  const estimate = costEstimateOf(settings, priceRuns(settings, runs, cwd, exec));
  return { ...estimate, estimator: estimatorName(costCommand(setting)) };
}

/** The file beside a root's plan that keeps the estimator's output. */
export function costFile(root: string): string {
  return `roots/${root}/cost.json`;
}

/** Write each estimator output beside its root's plan in the report directory. */
export function writeCostFiles(dir: string, outputs: Map<string, string>): void {
  for (const [root, text] of outputs) {
    const path = join(dir, costFile(root));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

const priced = (m: MemberCost): m is Extract<MemberCost, { monthlyDelta: number }> => "monthlyDelta" in m;

/** The report's `cost` (terragucci.report/v1's body) from chant's estimate. */
export function reportCostOf(estimate: CostEstimate, outputs: ReadonlyMap<string, string> = new Map()): ReportCost {
  const roots: ReportRootCost[] = estimate.members.map((m) =>
    priced(m)
      ? { root: m.member, monthly_delta: m.monthlyDelta, monthly_total: m.monthlyTotal ?? null, past_monthly_total: m.pastMonthlyTotal ?? null, ...(outputs.has(m.member) ? { output: costFile(m.member) } : {}) }
      : { root: m.member, monthly_delta: null, monthly_total: null, past_monthly_total: null, error: m.error },
  );
  const any = estimate.members.some(priced);
  return {
    estimator: estimate.estimator,
    currency: estimate.currency,
    monthly_delta: any ? estimate.monthlyDelta : null,
    monthly_total: estimate.monthlyTotal ?? null,
    past_monthly_total: estimate.pastMonthlyTotal ?? null,
    roots,
  };
}

/**
 * chant's record from the report's `cost`, for the plan note (`PrPlanNote.cost`),
 * which chant renders. It carries no amount: each wave holds on its own
 * change, which terragucci's line on `cost.approve_above` gives.
 */
export function noteCostOf(cost: ReportCost): CostEstimate {
  const members: MemberCost[] = cost.roots.map((r) =>
    r.monthly_delta === null
      ? { member: r.root, error: r.error ?? "no estimate" }
      : { member: r.root, monthlyDelta: r.monthly_delta, ...(r.monthly_total !== null ? { monthlyTotal: r.monthly_total } : {}), ...(r.past_monthly_total !== null ? { pastMonthlyTotal: r.past_monthly_total } : {}) },
  );
  return {
    estimator: cost.estimator,
    format: "infracost",
    currency: cost.currency,
    monthlyDelta: cost.monthly_delta ?? 0,
    ...(cost.monthly_total !== null ? { monthlyTotal: cost.monthly_total } : {}),
    ...(cost.past_monthly_total !== null ? { pastMonthlyTotal: cost.past_monthly_total } : {}),
    members,
    unestimated: members.filter((m) => "error" in m).map((m) => m.member).sort(),
    approveAbove: null,
    over: false,
  };
}

/** The part of an estimate over `roots`, against `approveAbove` when given. */
export function waveEstimate(estimate: CostEstimate, roots: readonly string[], approveAbove?: number): CostEstimate {
  const mine = estimate.members.filter((m) => roots.includes(m.member));
  return { ...costEstimateOf({ command: [estimate.estimator], format: estimate.format, ...(approveAbove !== undefined ? { approveAbove } : {}) }, mine), estimator: estimate.estimator, currency: estimate.currency };
}

const runCosts = (e: CostEstimate): OpWaveRunCost[] => e.members.map(({ member, ...rest }) => ({ target: member, ...rest }) as OpWaveRunCost);

/**
 * A wave's cost hold as chant decides it (`opWaveCostVerdict`): the digest
 * member chant adds to the wave's set digest and, over the amount, the hold.
 * The plan note's digest takes the same member, so it matches the wave's.
 */
export function waveCostVerdict(estimate: CostEstimate, roots: readonly string[], approveAbove: number): { member: WaveMember; hold?: string } {
  const v = opWaveCostVerdict({ command: [estimate.estimator], approveAbove }, runCosts(waveEstimate(estimate, roots)));
  return { member: v.member, ...(v.hold ? { hold: v.hold } : {}) };
}

/** The report's wave `cost` (terragucci.report/v1's body) from chant's estimate. */
export function reportWaveCostOf(estimate: CostEstimate, roots: readonly string[], approveAbove?: number): ReportWaveCost {
  const w = waveEstimate(estimate, roots, approveAbove);
  const any = w.members.some(priced);
  return {
    currency: w.currency,
    monthly_delta: any ? w.monthlyDelta : null,
    monthly_total: w.monthlyTotal ?? null,
    past_monthly_total: w.pastMonthlyTotal ?? null,
    ...(w.unestimated.length > 0 ? { unestimated: w.unestimated } : {}),
    ...(approveAbove !== undefined ? { approve_above: approveAbove, over: waveCostVerdict(estimate, roots, approveAbove).hold !== undefined } : {}),
  };
}

/** A change in money with its sign: `+12.40`, `-3.00`, `0.00`. */
export function signed(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)}`;
}

/** Why a wave waits for its cost, for the log: the change, the amount and where it was read. */
export function costReason(w: ReportWaveCost, source?: string): string {
  const where = source ? ` in ${source}` : "";
  if (w.unestimated?.length) return `the monthly cost of ${w.unestimated.join(", ")} could not be estimated, and cost.approve_above is ${w.approve_above!.toFixed(2)} ${w.currency}${where}`;
  return `the monthly cost changes by ${signed(w.monthly_delta ?? 0)} ${w.currency}, over cost.approve_above ${w.approve_above!.toFixed(2)} ${w.currency}${where}`;
}

/**
 * What the policy reads as `input.cost` for one root: chant's record
 * (`policyCost`, the wave's estimate in a wave and the plan's otherwise,
 * with the root's own figures as `member`), and beside it, for one release,
 * terragucci's snake_case fields: `root`, `wave` and `approve_above`.
 */
export function policyCostOf(estimate: CostEstimate, root: string, wave: { number: number; roots: readonly string[] } | undefined, approveAbove: number | undefined): PolicyCost {
  const own = wave ? waveEstimate(estimate, wave.roots, approveAbove) : { ...estimate, approveAbove: approveAbove ?? null, over: false };
  const record = chantPolicyCost(own, root);
  const m = estimate.members.find((x) => x.member === root);
  const figures = (e: { monthlyDelta?: number; monthlyTotal?: number; pastMonthlyTotal?: number } | undefined, any: boolean) => ({
    monthly_delta: any && e?.monthlyDelta !== undefined ? e.monthlyDelta : null,
    monthly_total: e?.monthlyTotal ?? null,
    past_monthly_total: e?.pastMonthlyTotal ?? null,
  });
  // A root whose plan changes nothing is not priced: its change is 0.
  const rootFigures = m ? figures(priced(m) ? m : undefined, priced(m)) : { monthly_delta: 0, monthly_total: null, past_monthly_total: null };
  return {
    ...record,
    root: rootFigures,
    ...(wave ? { wave: { number: wave.number, ...figures(own, own.members.some(priced)) } } : {}),
    approve_above: approveAbove ?? null,
  };
}

/** The estimator a run uses and the amount over which a wave waits, read at base. */
export interface CostRule {
  /** The `cost` setting the run estimates with: its own, else the one at base. Undefined: no estimate. */
  setting?: CostSettings;
  /** `cost.approve_above` in the config at base (or, with no base, in the config read). */
  approveAbove?: number;
  /** Where `approveAbove` was read, for the log. */
  source?: string;
  /** A line for the log: the checkout's amount differs from the one that counts. */
  note?: string;
  /** The config at base could not be read while the run's own config sets an amount, so whether a wave waits cannot be decided. */
  error?: string;
}

/** `cost.approve_above`, when the setting has one. */
export function approveAbove(setting: CostSettings | undefined): number | undefined {
  return setting && setting !== true && typeof setting.approve_above === "number" ? setting.approve_above : undefined;
}

/**
 * The cost rule of a run. Without a base, the run's own `cost`. With one,
 * `cost.approve_above` is the base's: a change cannot raise or drop the
 * amount its own apply is judged by. The estimator is the run's own setting,
 * else the base's, so a change that drops `cost` is still priced. A base
 * whose config cannot be read is an error only when the run's own config
 * sets an amount.
 */
export async function costRule(repo: string, own: CostSettings | undefined, base: string | undefined, options: TrustedOptions = {}): Promise<CostRule> {
  if (!base) return { ...(own ? { setting: own } : {}), ...(approveAbove(own) !== undefined ? { approveAbove: approveAbove(own), source: "the config here" } : {}) };
  const read = await configAtBase(repo, base, options);
  if ("error" in read) {
    if (approveAbove(own) !== undefined) return { ...(own ? { setting: own } : {}), error: `cost.approve_above is read from the config at ${base}, and it could not be read (${read.error})` };
    return own ? { setting: own } : {};
  }
  let atBase: CostSettings | undefined;
  try {
    atBase = read.config.projects ? (options.project ? resolveProject(read.config, options.project).cost : undefined) : resolveRepo(read.config).cost;
  } catch (e) {
    if (approveAbove(own) !== undefined) return { ...(own ? { setting: own } : {}), error: `cost.approve_above is read from the config at ${base}, and it could not be read (${(e as Error).message})` };
    return own ? { setting: own } : {};
  }
  const amount = approveAbove(atBase);
  const mine = approveAbove(own);
  const setting = own ?? atBase;
  return {
    ...(setting ? { setting } : {}),
    ...(amount !== undefined ? { approveAbove: amount, source: `the config at ${base}` } : {}),
    ...(mine !== amount ? { note: `cost: approve_above is ${mine ?? "unset"} here and ${amount ?? "unset"} at ${base}; the amount at ${base} counts` } : {}),
  };
}
