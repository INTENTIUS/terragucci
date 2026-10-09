/**
 * Cost estimates per root: with `cost:` in terragucci.yml, `stage tf-plan`
 * runs a cost estimator over each root's plan once it is planned, and the
 * report, the note and the text summary carry the monthly change per root
 * and in total. The estimator is Infracost by default, on the customer's own
 * key; any command that prints Infracost's JSON (`diffTotalMonthlyCost`,
 * `totalMonthlyCost`, `pastTotalMonthlyCost`, `currency`) works the same way.
 *
 * The command reads the root's stored plan, `show -json` with its sensitive
 * values redacted, from `TG_PLAN_JSON`, and gets the job's environment less
 * its forge tokens, as the binary does. Its output is kept beside the plan
 * as `roots/<root>/cost.json`. An estimate that fails is named in the report
 * and the note, and never fails the plan.
 *
 * `tf-apply` estimates each wave's plans the same way. The policy reads each
 * root's figures and its wave's (`input.cost`). With `cost.approve_above` in
 * the config at base, a wave whose monthly change is over that amount waits
 * for an approval whatever the gate, and the amount, the currency and the
 * wave's change join the wave's set digest (costMember), so an approval of
 * the plans at one cost does not apply them at another.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { binaryEnv } from "../binary-env";
import { resolveProject, resolveRepo, type CostSettings } from "../config";
import { configAtBase, type PolicyCost, type TrustedOptions } from "./policy";
import type { ReportCost, ReportRootCost, ReportWaveCost } from "./schema";

/** Infracost over the root's plan JSON. The job installs Infracost and maps the key secret to INFRACOST_API_KEY. */
export const INFRACOST_COMMAND = 'infracost breakdown --path "$TG_PLAN_JSON" --format json --log-level error';

/** How long one root's estimate may take. */
const TIMEOUT_MS = 120_000;

export interface CostCommand {
  command: string;
}

/** The command `cost:` runs: its own `command`, else Infracost. */
export function costCommand(setting: CostSettings): CostCommand {
  return { command: setting !== true && setting.command ? setting.command : INFRACOST_COMMAND };
}

/** What an estimator printed, run once per root. */
export type CostRunner = (command: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const shRunner: CostRunner = (command, env, cwd) =>
  new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 127, stdout: "", stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    });
  });

/** A money value as Infracost prints it (a decimal string, or null), as a number. */
function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One root's estimate from Infracost's JSON. The change is `diffTotalMonthlyCost`, else the total less the past total. */
export function parseInfracost(text: string): { currency: string; monthly_delta: number | null; monthly_total: number | null; past_monthly_total: number | null } {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (!doc || typeof doc !== "object" || !("totalMonthlyCost" in doc || "diffTotalMonthlyCost" in doc)) throw new Error("the output has no totalMonthlyCost or diffTotalMonthlyCost");
  const total = money(doc.totalMonthlyCost);
  const past = money(doc.pastTotalMonthlyCost);
  const diff = money(doc.diffTotalMonthlyCost);
  return {
    currency: typeof doc.currency === "string" && doc.currency ? doc.currency : "USD",
    monthly_delta: diff ?? (total !== null ? total - (past ?? 0) : null),
    monthly_total: total,
    past_monthly_total: past,
  };
}

/** The file beside a root's plan that keeps the estimator's output. */
export function costFile(root: string): string {
  return `roots/${root}/cost.json`;
}

/** The first word of the command, which the report names as the estimator. */
function estimatorName(command: string): string {
  return command.trim().split(/\s+/)[0]?.split("/").pop() ?? "estimator";
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Estimate each root whose plan JSON is in `plans`, in order, running the
 * command in `cwd` (the repo). Writes each plan to `work` for the command to
 * read, and returns the report's `cost` with each estimator output to keep
 * under `costFile(root)`.
 */
export async function estimateCosts(
  plans: { root: string; json: string }[],
  setting: CostCommand,
  env: NodeJS.ProcessEnv,
  work: string,
  cwd: string,
  log: (line: string) => void,
  run: CostRunner = shRunner,
): Promise<{ cost: ReportCost; outputs: Map<string, string> }> {
  const outputs = new Map<string, string>();
  const roots: ReportRootCost[] = [];
  const currencies = new Set<string>();
  const clean = binaryEnv(env);
  for (const [i, p] of plans.entries()) {
    const file = join(work, `cost-${i}.json`);
    writeFileSync(file, p.json);
    const r = await run(setting.command, { ...clean, TG_PLAN_JSON: file, TG_ROOT: p.root }, cwd);
    // Node ends a crash with its own version line; the line before it says why.
    const why = (r.stderr.trim().split("\n").filter((l) => l.trim() && !/^Node\.js v\d/.test(l)).pop() ?? "").trim().slice(0, 200);
    if (r.code !== 0) {
      log(`cost: ${p.root}: the estimator exited ${r.code}${why ? `: ${why}` : ""}`);
      roots.push({ root: p.root, monthly_delta: null, monthly_total: null, past_monthly_total: null, error: `the estimator exited ${r.code}${why ? `: ${why}` : ""}` });
      continue;
    }
    try {
      const e = parseInfracost(r.stdout);
      currencies.add(e.currency);
      outputs.set(p.root, r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
      roots.push({ root: p.root, monthly_delta: e.monthly_delta, monthly_total: e.monthly_total, past_monthly_total: e.past_monthly_total, output: costFile(p.root) });
      log(`cost: ${p.root}: ${e.monthly_delta === null ? "no estimate" : `${signed(e.monthly_delta)} ${e.currency} a month`}`);
    } catch (e) {
      log(`cost: ${p.root}: the estimator printed no estimate (${(e as Error).message})`);
      roots.push({ root: p.root, monthly_delta: null, monthly_total: null, past_monthly_total: null, error: `the estimator printed no estimate: ${(e as Error).message}` });
    }
  }
  const estimated = roots.filter((r) => r.monthly_delta !== null);
  const sum = (k: "monthly_delta" | "monthly_total" | "past_monthly_total"): number | null =>
    estimated.length > 0 ? round(estimated.reduce((n, r) => n + (r[k] ?? 0), 0)) : null;
  const cost: ReportCost = {
    estimator: estimatorName(setting.command),
    currency: currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? "USD" : [...currencies].sort().join(", "),
    monthly_delta: sum("monthly_delta"),
    monthly_total: sum("monthly_total"),
    past_monthly_total: sum("past_monthly_total"),
    roots,
  };
  if (cost.monthly_delta !== null) log(`cost: ${signed(cost.monthly_delta)} ${cost.currency} a month over ${estimated.length} of ${roots.length} roots`);
  return { cost, outputs };
}

/** Write each estimator output beside its root's plan in the report directory. */
export function writeCostFiles(dir: string, outputs: Map<string, string>): void {
  for (const [root, text] of outputs) {
    const path = join(dir, costFile(root));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** A change in money with its sign: `+12.40`, `-3.00`, `0.00`. */
export function signed(n: number): string {
  const v = round(n);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)}`;
}

/** `cost.approve_above`, when the setting has one. */
export function approveAbove(setting: CostSettings | undefined): number | undefined {
  return setting && setting !== true && typeof setting.approve_above === "number" ? setting.approve_above : undefined;
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

/**
 * A wave's monthly cost: the sums over its roots estimated, the roots that
 * could not be, and with an amount whether the change is over it. A change
 * that cannot be known (a root of the wave has no estimate) counts as over.
 */
export function waveCost(cost: ReportCost, roots: readonly string[], amount: number | undefined): ReportWaveCost {
  const mine = cost.roots.filter((r) => roots.includes(r.root));
  const estimated = mine.filter((r) => r.monthly_delta !== null);
  const unestimated = mine.filter((r) => r.monthly_delta === null).map((r) => r.root).sort();
  const sum = (k: "monthly_delta" | "monthly_total" | "past_monthly_total"): number | null =>
    estimated.length > 0 ? round(estimated.reduce((n, r) => n + (r[k] ?? 0), 0)) : null;
  const delta = sum("monthly_delta");
  return {
    currency: cost.currency,
    monthly_delta: delta,
    monthly_total: sum("monthly_total"),
    past_monthly_total: sum("past_monthly_total"),
    ...(unestimated.length > 0 ? { unestimated } : {}),
    ...(amount !== undefined ? { approve_above: amount, over: unestimated.length > 0 || delta === null || delta > amount } : {}),
  };
}

/** The member a wave's set digest takes for its cost when `cost.approve_above` is set: not a root, so no root can be named it. */
export const COST_MEMBER = "(monthly cost)";

/**
 * The wave's cost as a member of its set digest: the amount, the currency,
 * the change and the roots not estimated. Undefined without an amount, so a
 * repo that sets none keeps the digests it had.
 */
export function costMember(w: ReportWaveCost | undefined): { member: string; planDigest: string } | undefined {
  if (!w || w.approve_above === undefined) return undefined;
  return {
    member: COST_MEMBER,
    planDigest: computePlanDigest("terragucci-wave-cost", { approve_above: w.approve_above, currency: w.currency, monthly_delta: w.monthly_delta, unestimated: w.unestimated ?? [] }),
  };
}

/** Why a wave waits for its cost, for the log and the outcome: the change, the amount and where it was read. */
export function costReason(w: ReportWaveCost, source?: string): string {
  const where = source ? ` in ${source}` : "";
  if (w.unestimated?.length) return `the monthly cost of ${w.unestimated.join(", ")} could not be estimated, and cost.approve_above is ${w.approve_above!.toFixed(2)} ${w.currency}${where}`;
  if (w.monthly_delta === null) return `the wave's monthly cost could not be estimated, and cost.approve_above is ${w.approve_above!.toFixed(2)} ${w.currency}${where}`;
  return `the monthly cost changes by ${signed(w.monthly_delta)} ${w.currency}, over cost.approve_above ${w.approve_above!.toFixed(2)} ${w.currency}${where}`;
}

/** What the policy reads as `input.cost` for one root: its figures, its wave's, and the amount. */
export function policyCost(cost: ReportCost, root: string, wave: { number: number; cost: ReportWaveCost } | undefined, amount: number | undefined): PolicyCost {
  const r = cost.roots.find((x) => x.root === root);
  return {
    estimator: cost.estimator,
    currency: cost.currency,
    root: { monthly_delta: r?.monthly_delta ?? null, monthly_total: r?.monthly_total ?? null, past_monthly_total: r?.past_monthly_total ?? null },
    ...(wave ? { wave: { number: wave.number, monthly_delta: wave.cost.monthly_delta, monthly_total: wave.cost.monthly_total, past_monthly_total: wave.cost.past_monthly_total } } : {}),
    approve_above: amount ?? null,
  };
}
