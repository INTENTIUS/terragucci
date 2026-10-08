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
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { binaryEnv } from "../binary-env";
import type { CostSettings } from "../config";
import type { ReportCost, ReportRootCost } from "./schema";

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
