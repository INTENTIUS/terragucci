/**
 * `tf-check`'s checks beyond the format check: what `validate` found in each
 * root, choudoufu's own `live-check` for a choudoufu root, and the tests of the
 * policy the plan stage will enforce. Each prints its findings to the job log
 * and appends them to the check report (`terragucci-check/report.md`, and the
 * job summary where the forge has one), and the exit code is the verdict.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findConfig, loadConfig, resolveRepo } from "./config";
import { defaultPolicyExec, engineBinary, governingPolicy, policyPathExists, shownUrl, trustedPolicy, type PolicyExec, type PolicyOptions } from "./report/policy";

/** Where the check report is written, relative to the checkout. */
export const CHECK_DIR = "terragucci-check";

/** One diagnostic of `validate -json`. */
export interface ValidateDiagnostic {
  severity?: string;
  summary?: string;
  detail?: string;
  range?: { filename?: string; start?: { line?: number; column?: number }; end?: { line?: number; column?: number } };
}

export interface CheckResult {
  ok: boolean;
  /** The lines for the job log. */
  log: string[];
  /** The markdown for the check report. */
  report: string[];
}

export interface CheckOptions {
  exec?: PolicyExec;
  env?: NodeJS.ProcessEnv;
  /** `modules.require: attested`: the root's pins checked before validate; each line names a refused pin. */
  pins?: (dir: string) => Promise<{ refused: string[]; verified: string[] }>;
}

/** `file:line:col-line:col` for a diagnostic, with the root's directory in front of the file. */
export function diagnosticWhere(dir: string, d: ValidateDiagnostic): string {
  const r = d.range;
  if (!r?.filename) return dir;
  const file = dir === "." ? r.filename : `${dir}/${r.filename}`;
  const s = r.start;
  const e = r.end;
  if (!s?.line) return file;
  const from = `${s.line}${s.column ? `:${s.column}` : ""}`;
  const to = e?.line && (e.line !== s.line || e.column !== s.column) ? `-${e.line}${e.column ? `:${e.column}` : ""}` : "";
  return `${file}:${from}${to}`;
}

/** The diagnostics of a `validate -json` document, or undefined when the text is not one. */
export function parseValidate(stdout: string): { valid: boolean; diagnostics: ValidateDiagnostic[] } | undefined {
  try {
    const doc = JSON.parse(stdout) as { valid?: unknown; diagnostics?: unknown };
    if (typeof doc.valid !== "boolean") return undefined;
    return { valid: doc.valid, diagnostics: Array.isArray(doc.diagnostics) ? (doc.diagnostics as ValidateDiagnostic[]) : [] };
  } catch {
    return undefined;
  }
}

const indent = (s: string, by = "    "): string => s.split("\n").map((l) => (l ? by + l : l)).join("\n");
const tail = (s: string, n = 5): string => s.trim().split("\n").slice(-n).join("\n");

/** One refusal of `live-check -json`: a rule, why, and the types and sites it covers. */
export interface LiveRefusal {
  rule: string;
  reason: string;
  /** How many resource instances the rule refuses; 1 for an instance row. */
  count: number;
  types: { type: string; count: number }[];
  sites: { address: string; location: string }[];
}

/**
 * The document `choudoufu live-check -json` printed (choudoufu 0.22.0 and
 * later): `blocked`, and a `refusals` array of `{rule, reason, count, types[],
 * sites[]}` naming everything behind `blocked`. A release without it names
 * refused instances in `instances[].refused` only, which come back as one
 * refusal each; when neither lists a refusal, the caller reads the text
 * output (#191). Undefined when the text is not a document.
 */
export function parseLiveCheck(stdout: string): { blocked: boolean; refused: LiveRefusal[] } | undefined {
  try {
    const doc = JSON.parse(stdout) as {
      blocked?: unknown;
      instances?: { address?: string; type?: string; refused?: boolean; rule?: string; reason?: string }[];
      refusals?: unknown;
    };
    if (typeof doc.blocked !== "boolean") return undefined;
    if (Array.isArray(doc.refusals)) {
      const refused: LiveRefusal[] = [];
      for (const r of doc.refusals as Record<string, unknown>[]) {
        if (!r || typeof r !== "object") continue;
        const types = (Array.isArray(r.types) ? (r.types as { type?: string; count?: number }[]) : []).map((t) => ({ type: t?.type ?? "", count: t?.count ?? 0 }));
        const sites = (Array.isArray(r.sites) ? (r.sites as { address?: string; location?: string }[]) : []).map((x) => ({ address: x?.address ?? "", location: x?.location ?? "" }));
        refused.push({ rule: String(r.rule ?? ""), reason: String(r.reason ?? ""), count: typeof r.count === "number" ? r.count : Math.max(sites.length, 1), types, sites });
      }
      return { blocked: doc.blocked, refused };
    }
    const refused: LiveRefusal[] = (Array.isArray(doc.instances) ? doc.instances : [])
      .filter((i) => i.refused)
      .map((i) => ({ rule: i.rule ?? "", reason: i.reason ?? "", count: 1, types: i.type ? [{ type: i.type, count: 1 }] : [], sites: i.address ? [{ address: i.address, location: "" }] : [] }));
    return { blocked: doc.blocked, refused };
  } catch {
    return undefined;
  }
}

/** The log line and report bullet for one refusal. */
export function refusalLine(dir: string, r: LiveRefusal): string {
  const types = r.types.map((t) => (t.count > 1 ? `${t.type} x${t.count}` : t.type)).join(", ");
  const where = r.sites.map((x) => (x.location ? `${x.address} (${x.location})` : x.address)).filter(Boolean).join(", ");
  return `refused: ${dir}: ${r.rule ? `${r.rule}: ` : ""}${r.reason}${types ? ` [${types}]` : ""}${where ? `: ${where}` : ""}`;
}

/** The non-empty lines of `choudoufu live-check <dir>`'s text output, which names a refusal the JSON does not. */
export function liveCheckTextLines(out: { stdout: string; stderr: string }, max = 40): string[] {
  return `${out.stdout}\n${out.stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(0, max);
}

/** One directory's module pins under `modules.require: attested`, into the log and the report; false when one is refused. */
async function pinLines(dir: string, check: NonNullable<CheckOptions["pins"]>, log: string[], report: string[]): Promise<boolean> {
  const pins = await check(dir);
  for (const line of pins.refused) {
    log.push(line);
    report.push(`- ${line.replace(`refused: ${dir}: `, `refused: \`${dir}\`: `)}`);
  }
  if (pins.refused.length) {
    log.push(`FAILED ${dir}: modules.require: attested refused ${pins.refused.length} module pin${pins.refused.length === 1 ? "" : "s"}`);
    return false;
  }
  if (pins.verified.length) {
    log.push(`attested ${dir}: ${pins.verified.join("; ")}`);
    report.push(`- attested: ${pins.verified.map((v) => `\`${v}\``).join(", ")}`);
  }
  return true;
}

/**
 * tf-check's pin step in a Terragrunt repo, where no unit runs check-root:
 * each unit's `terraform { source }` under `modules.require: attested`.
 * Only units that refuse a pin or verify one get a section in the report.
 */
export async function checkUnitPins(units: readonly string[], pins: NonNullable<CheckOptions["pins"]>): Promise<CheckResult> {
  const log: string[] = [];
  const report: string[] = [];
  let ok = true;
  for (const dir of units) {
    const r: string[] = [];
    if (!(await pinLines(dir, pins, log, r))) ok = false;
    if (r.length) report.push(`### ${dir}`, "", ...r, "");
  }
  return { ok, log, report };
}

/**
 * One root: `validate -json`, and for a choudoufu root `live-check -json` after
 * it. The root has been initialised (`init -backend=false`). Warnings print and
 * do not fail the root; an error, a refusal or a command that did not run does.
 */
export async function checkRoot(binary: string, dir: string, repo: string, options: CheckOptions = {}): Promise<CheckResult> {
  const exec = options.exec ?? defaultPolicyExec;
  const log: string[] = [];
  const report: string[] = [`### ${dir}`, ""];
  let ok = true;
  if (options.pins) ok = await pinLines(dir, options.pins, log, report);
  const v = await exec(binary, [`-chdir=${dir}`, "validate", "-json"], repo);
  const parsed = parseValidate(v.stdout);
  if (!parsed) {
    ok = false;
    log.push(`FAILED ${dir}: ${binary} validate gave no result (exit ${v.status})`, indent(tail(v.stderr || v.stdout)));
    report.push(`\`${binary} validate\` gave no result (exit ${v.status}):`, "", "```", tail(v.stderr || v.stdout), "```", "");
  } else {
    for (const d of parsed.diagnostics) {
      const where = diagnosticWhere(dir, d);
      const sev = d.severity ?? "error";
      log.push(`${sev}: ${where}: ${d.summary ?? ""}`, ...(d.detail ? [indent(d.detail.trim())] : []));
      report.push(`- ${sev}: \`${where}\`: ${d.summary ?? ""}${d.detail ? `\n\n  ${d.detail.trim().replace(/\n/g, "\n  ")}\n` : ""}`);
    }
    if (!parsed.valid || v.status !== 0) {
      ok = false;
      if (parsed.diagnostics.length === 0) log.push(`FAILED ${dir}: ${binary} validate exited ${v.status}`);
      log.push(`FAILED ${dir}: validate found ${parsed.diagnostics.filter((d) => (d.severity ?? "error") === "error").length} error(s)`);
    } else {
      log.push(`valid ${dir}`);
      report.push(`- valid`);
    }
  }
  if (binary === "choudoufu") {
    const c = await exec(binary, ["live-check", "-json", dir], repo);
    const live = parseLiveCheck(c.stdout);
    // A refusal the JSON does not list is named only by the text output.
    const textRefusals = async (): Promise<void> => {
      const t = await exec(binary, ["live-check", dir], repo);
      for (const l of liveCheckTextLines(t)) {
        log.push(`refused: ${dir}: ${l}`);
        report.push(`- refused: \`${dir}\`: ${l}`);
      }
    };
    if (!live) {
      ok = false;
      log.push(`FAILED ${dir}: choudoufu live-check gave no result (exit ${c.status})`, indent(tail(c.stderr || c.stdout)));
      report.push(`- \`choudoufu live-check\` gave no result (exit ${c.status}):`, "", "```", tail(c.stderr || c.stdout), "```");
      await textRefusals();
    } else {
      for (const r of live.refused) {
        const line = refusalLine(dir, r);
        log.push(line);
        report.push(`- ${line.replace(`refused: ${dir}: `, `refused: \`${dir}\`: `)}`);
      }
      if (live.blocked || c.status !== 0) {
        ok = false;
        // A release that prints no `refusals` array names a refusal only in the text output.
        if (live.refused.length === 0) await textRefusals();
        const refusedCount = live.refused.reduce((n, r) => n + r.count, 0);
        log.push(`FAILED ${dir}: choudoufu live-check refused ${refusedCount} resource${refusedCount === 1 ? "" : "s"} (exit ${c.status})`);
      } else {
        log.push(`live-check passed ${dir}`);
        report.push("- live-check passed");
      }
    }
  }
  report.push("");
  return { ok, log, report };
}

/** Whether a directory holds Rego tests (`*_test.rego`), at any depth. */
export function hasPolicyTests(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory() ? hasPolicyTests(p) : name.endsWith("_test.rego")) return true;
  }
  return false;
}

/**
 * The base the policy is read from. A pull request's target branch when the
 * forge names one, else the default branch for a push to any other branch, so
 * a change that edits the policy cannot edit its tests away. On the default
 * branch there is no base and the checkout's policy is the trusted one.
 */
export function policyBase(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TG_BASE) return env.TG_BASE;
  const target = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (target) return `origin/${target}`;
  const branch = env.GITHUB_REF_NAME || env.CI_COMMIT_BRANCH;
  const main = env.TG_BRANCH;
  return branch && main && branch !== main ? `origin/${main}` : undefined;
}

export interface PolicyCheckOptions extends CheckOptions {
  config?: string;
  base?: string;
  policy?: PolicyOptions;
}

/**
 * With `policy:` set, run the policy's own tests (`conftest verify`, or
 * `opa test`) over the trusted policy directory. The key, like the
 * directory, is read from the base when there is one, so a change that
 * deletes or edits it still runs the base's tests. No key on either side is
 * a pass with no output; a directory with no tests is a pass with a note.
 */
export async function checkPolicyTests(repo: string, options: PolicyCheckOptions = {}): Promise<CheckResult> {
  const env = options.env ?? process.env;
  const path = options.config ?? findConfig(repo);
  const settings = resolveRepo(path ? await loadConfig(resolve(repo, path)) : {});
  const base = options.base ?? policyBase(env);
  // The base's policy key decides whether the tests run, so a change that deletes the key still runs the base's tests.
  const governing = await governingPolicy(repo, settings.policy, base, path ? { config: resolve(repo, path) } : {});
  const policy = governing.policy;
  if (!policy) return { ok: true, log: governing.note ? [governing.note] : [], report: [] };
  const exec = options.exec ?? defaultPolicyExec;
  // Without a resolvable base the checkout's policy would be the pull request's own; fail closed instead.
  const trusted = await trustedPolicy(repo, policy, base, governing.trust);
  const engine = trusted.policy.engine ?? "conftest";
  const fail = (msg: string): CheckResult => ({ ok: false, log: [`FAILED policy tests: ${msg}`], report: ["### Policy tests", "", `- failed: ${msg}`, ""] });
  try {
    if (trusted.error) return fail(trusted.error);
    if (!policyPathExists(trusted.policy, repo)) return fail(`the policy directory ${policy.path ?? "policy"} does not exist`);
    const dir = resolve(repo, trusted.policy.path ?? "policy");
    const from = trusted.sourceCommit && trusted.policy.source
      ? ` (read from ${shownUrl(trusted.policy.source)} at commit ${trusted.sourceCommit.slice(0, 12)})`
      : trusted.from === "base" ? ` (read from ${base}, not from this checkout)` : "";
    if (!hasPolicyTests(dir)) {
      const note = `policy tests skipped: ${policy.path ?? "policy"} has no *_test.rego files${from}`;
      return { ok: true, log: [note], report: ["### Policy tests", "", `- ${note}`, ""] };
    }
    let binary: string;
    try {
      binary = await engineBinary(trusted.policy, repo, options.policy ?? {});
    } catch (e) {
      return fail((e as Error).message);
    }
    const args = engine === "opa" ? ["test", dir] : ["verify", "--no-color", "--policy", dir];
    const r = await exec(binary, args, repo);
    const out = `${r.stdout}${r.stderr}`.trim();
    if (r.status !== 0) {
      const lines = out ? out.split("\n") : [];
      return {
        ok: false,
        log: [`FAILED policy tests: ${engine} ${args[0]} exited ${r.status}${from}`, ...lines.map((l) => `  ${l}`)],
        report: ["### Policy tests", "", `\`${engine} ${args[0]}\` exited ${r.status}${from}:`, "", "```", out, "```", ""],
      };
    }
    return { ok: true, log: [`policy tests passed (${engine} ${args[0]})${from}`], report: ["### Policy tests", "", `- passed (${engine} ${args[0]})${from}`, ""] };
  } finally {
    trusted.cleanup();
  }
}

/** Print a result and append its report to the check report file and the forge's job summary. */
export function emitCheck(repo: string, result: CheckResult, env: NodeJS.ProcessEnv = process.env): void {
  for (const l of result.log) console.log(l);
  if (result.report.length === 0) return;
  const text = `${result.report.join("\n")}\n`;
  const file = join(repo, CHECK_DIR, "report.md");
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // The report is help on top of the log; a failed write never changes the verdict.
  }
}
