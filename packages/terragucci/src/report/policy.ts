/**
 * Policy as code: the opt-in `policy:` key runs conftest or OPA over each
 * planned root's plan JSON, and a violation fails the root in `tf-plan`.
 * Both engines count `deny`, `violation` and `deny_*` rules, as conftest
 * does, and read `warn` rules as warnings that fail nothing. `input: hcp`
 * wraps the plan as `{plan, run}`, the shape HCP Terraform's OPA policies read.
 *
 * The check reads the unredacted `show -json` of each root, writes it to a
 * temporary file, and runs the engine on that file. Nothing here reads a
 * respond mode or an agent setting, and a policy that cannot run (no engine,
 * a policy that does not compile) fails the root too, so no path waives it.
 * A pull request's plan reads the policy, and the `policy:` key (a `.ts`
 * config folded at the base), from the base branch (`trustedPolicy`), so a change that edits the policy cannot
 * waive its own violation. `tf-apply` applies the same check to a wave's
 * plans, with the policy of the checkout it runs from (main) or of TG_BASE.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig, resolveProject, resolveRepo, type PolicyEngine, type PolicyInput, type PolicySettings } from "../config";
import type { ReportPolicy, ReportRootPolicy } from "./schema";

/** What one run of an engine printed and how it exited. */
export interface PolicyRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type PolicyExec = (file: string, args: string[], cwd: string) => Promise<PolicyRun>;

export const CONFTEST_VERSION = "0.71.0";

/** SHA-256 of the Linux release archives, from the release's checksums.txt, so a download is checked against a pin and not against itself. */
export const CONFTEST_SHA256: Record<string, string> = {
  x86_64: "765dfefdf0730693d7541ea0147e10d530a54ed257bbfec055ff34c837ffdf72",
  arm64: "542f255081cfab9919cba327d3c4014fd46d6ee3f0441c634b14b1465e9469d9",
};

export const OPA_VERSION = "1.21.1";

/** SHA-256 of the static Linux builds, from the release's `.sha256` files. OPA ships a bare binary, not an archive. */
export const OPA_SHA256: Record<string, string> = {
  x86_64: "668506eb17a2eaa1fce6cc0d1f42ef85125d4ac5bda5fc74d1152d0c77145031",
  arm64: "9a1f3625529c6f01240fe68286dde06aa0b23c5253da700ac48f4d943ff8a4de",
};

export const defaultPolicyExec: PolicyExec = (file, args, cwd) =>
  new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let failed: Error | undefined;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => (failed = e));
    child.on("close", (code) => done({ status: failed ? null : code, stdout: Buffer.concat(out).toString("utf-8"), stderr: `${Buffer.concat(err).toString("utf-8")}${failed ? failed.message : ""}` }));
  });

/** The one root's verdict: what the policy denied, or why it could not run. */
export interface PolicyVerdict {
  violations: string[];
  /** `warn` messages: shown in the note and the report, and never fail the root. */
  warnings?: string[];
  /** Set when the engine did not run or did not answer; the root fails all the same. */
  error?: string;
}

export interface PolicyOptions {
  exec?: PolicyExec;
  /** Fetches a release archive. Default: Node's fetch. */
  download?: (url: string) => Promise<Buffer>;
  /** Where an engine installed on demand is kept. Default: the temp directory. */
  cache?: string;
  /** The platform, for the release archive. Default: this process's. */
  arch?: string;
}

/** The engine's executable: the one on the path, or conftest or OPA fetched once and checked against its pinned digest. */
export async function engineBinary(policy: PolicySettings, repo: string, options: PolicyOptions = {}): Promise<string> {
  const exec = options.exec ?? defaultPolicyExec;
  const name = policy.engine ?? "conftest";
  const onPath = await exec(name, name === "opa" ? ["version"] : ["--version"], repo);
  if (onPath.status === 0) return name;
  const arch = (options.arch ?? process.arch) === "arm64" ? "arm64" : "x86_64";
  const dir = join(options.cache ?? tmpdir(), `terragucci-${name}-${name === "opa" ? OPA_VERSION : CONFTEST_VERSION}-${arch}`);
  const bin = join(dir, name);
  if (existsSync(bin)) return bin;
  const archive = name === "conftest";
  const version = archive ? CONFTEST_VERSION : OPA_VERSION;
  const asset = archive ? `conftest_${CONFTEST_VERSION}_Linux_${arch}.tar.gz` : `opa_linux_${arch === "arm64" ? "arm64" : "amd64"}_static`;
  const url = archive
    ? `https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/${asset}`
    : `https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/${asset}`;
  const body = await (options.download ?? fetchBytes)(url);
  const sum = createHash("sha256").update(body).digest("hex");
  if (sum !== (archive ? CONFTEST_SHA256 : OPA_SHA256)[arch]) throw new Error(`${name} ${version} from ${url} does not match its pinned digest (got ${sum}); not running it`);
  const work = mkdtempSync(join(tmpdir(), `terragucci-${name}-`));
  try {
    writeFileSync(join(work, asset), body);
    if (archive) {
      const untar = await exec("tar", ["-xzf", join(work, asset), "-C", work, "conftest"], work);
      if (untar.status !== 0) throw new Error(`could not unpack conftest: ${untar.stderr.trim()}`);
    } else {
      renameSync(join(work, asset), join(work, "opa"));
    }
    mkdirSync(dir, { recursive: true });
    renameSync(join(work, name), bin);
    chmodSync(bin, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bin;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A rule whose messages fail the root, as conftest counts them: `deny`, `violation`, `deny_<name>`, `violation_<name>`. */
export const DENY_RULE = /^(deny|violation)(_[A-Za-z0-9]+)*$/;
/** A rule whose messages are advice, as conftest counts them: `warn`, `warn_<name>`. */
export const WARN_RULE = /^warn(_[A-Za-z0-9]+)*$/;

/** What an engine's answer holds: messages that fail the root, and advice that does not. */
export interface PolicyFindings {
  violations: string[];
  warnings: string[];
}

/** A rule's message as conftest prints it: a string as it is, an object's `msg`, anything else as JSON. */
function messageOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { msg?: unknown }).msg === "string") return (v as { msg: string }).msg;
  return JSON.stringify(v);
}

/** Every message a conftest JSON result denies with (failures; conftest counts `deny`, `violation` and `deny_*` there). */
export function conftestViolations(stdout: string): string[] | undefined {
  return conftestFindings(stdout)?.violations;
}

/** conftest's failures and warnings, from `conftest test --output json`. */
export function conftestFindings(stdout: string): PolicyFindings | undefined {
  let results: unknown;
  try {
    results = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(results)) return undefined;
  const out: PolicyFindings = { violations: [], warnings: [] };
  for (const r of results as { failures?: { msg?: unknown }[]; warnings?: { msg?: unknown }[] }[]) {
    for (const f of r.failures ?? []) out.violations.push(typeof f.msg === "string" ? f.msg : JSON.stringify(f.msg));
    for (const w of r.warnings ?? []) out.warnings.push(typeof w.msg === "string" ? w.msg : JSON.stringify(w.msg));
  }
  return out;
}

/** The rules of one package's document: each deny-like and warn-like rule's messages. `nested` reads every child package too. */
function packageFindings(doc: Record<string, unknown>, out: PolicyFindings, nested: boolean): void {
  for (const [name, value] of Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const into = DENY_RULE.test(name) ? out.violations : WARN_RULE.test(name) ? out.warnings : undefined;
    if (into) {
      if (Array.isArray(value)) into.push(...value.map(messageOf));
      else if (value === true) into.push(name);
      else if (typeof value === "string") into.push(value);
      continue;
    }
    if (nested && value !== null && typeof value === "object" && !Array.isArray(value)) packageFindings(value as Record<string, unknown>, out, false);
  }
}

/**
 * The findings in an `opa eval` JSON result. The query is a package
 * (`data.<namespace>`), so its value holds every rule: `deny`, `violation`
 * and `deny_*` fail the root, `warn` and `warn_*` are advice, as conftest
 * counts them. An array value is read as a deny set. No result means the
 * package is empty: no denial.
 */
export function opaFindings(stdout: string, nested = false): PolicyFindings | undefined {
  let parsed: { result?: { expressions?: { value?: unknown }[] }[]; errors?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.errors !== undefined) return undefined;
  const value = parsed.result?.[0]?.expressions?.[0]?.value;
  if (value === undefined) return { violations: [], warnings: [] };
  if (Array.isArray(value)) return { violations: value.map(messageOf), warnings: [] };
  if (value === null || typeof value !== "object") return undefined;
  const out: PolicyFindings = { violations: [], warnings: [] };
  packageFindings(value as Record<string, unknown>, out, nested);
  return out;
}

/** Every message an `opa eval` JSON result denies with. */
export function opaViolations(stdout: string): string[] | undefined {
  return opaFindings(stdout)?.violations;
}

/** The facts of the run a plan belongs to, for `input: hcp`'s `input.run`. */
export interface PolicyRunContext {
  /** The root's path in the repo: HCP Terraform's workspace. */
  root: string;
  stage?: "tf-plan" | "tf-apply";
  /** `<host>/<path>` of the repo. */
  project?: string;
  commit?: string;
  /** The pull or merge request, by number. */
  pullRequest?: string;
}

/**
 * HCP Terraform's `input.run`, filled with what terragucci knows: the
 * workspace is the root, the organization is the repo's owner, a pull
 * request's plan is speculative. Fields terragucci has no value for keep
 * HCP's types (empty lists, false), so a policy that reads them still runs.
 */
export function hcpRun(context: PolicyRunContext): Record<string, unknown> {
  const parts = (context.project ?? "").split("/");
  const owner = parts.length >= 3 ? parts.slice(1, -1).join("/") : "";
  const name = parts.length >= 3 ? parts[parts.length - 1] : (context.project ?? "");
  return {
    id: "",
    message: context.pullRequest ? `pull request ${context.pullRequest}` : "",
    commit_sha: context.commit ?? "",
    is_destroy: false,
    refresh: true,
    refresh_only: false,
    replace_addrs: [],
    speculative: context.stage !== "tf-apply",
    target_addrs: [],
    variables: {},
    organization: { name: owner },
    project: { id: "", name },
    workspace: {
      id: "",
      name: context.root,
      description: "",
      execution_mode: "agent",
      auto_apply: false,
      tags: [],
      working_directory: context.root,
      vcs_repo: { identifier: [owner, name].filter(Boolean).join("/"), display_identifier: [owner, name].filter(Boolean).join("/"), branch: "", ingress_submodules: false },
    },
  };
}

/** What the engine reads as `input`: the plan as it is, or `{plan, run}` with `input: hcp`. */
export function policyInput(policy: PolicySettings, planJson: string, context?: PolicyRunContext): string {
  if ((policy.input ?? "plan") !== "hcp") return planJson;
  return `{"plan":${planJson},"run":${JSON.stringify(hcpRun(context ?? { root: "" }))}}`;
}

/** The engine's arguments for one input file. */
export function policyArgs(policy: PolicySettings, path: string, file: string): string[] {
  if ((policy.engine ?? "conftest") === "opa") {
    return ["eval", "--format", "json", "--data", path, "--input", file, `data.${opaNamespace(policy)}`];
  }
  return ["test", "--no-color", "--output", "json", "--policy", path, ...(policy.namespace ? ["--namespace", policy.namespace] : ["--all-namespaces"]), file];
}

/** The package the opa engine queries: the namespace, else `main`, else (with `input: hcp`) HCP's `terraform.policies`. */
export function opaNamespace(policy: PolicySettings): string {
  return policy.namespace ?? (policy.input === "hcp" ? "terraform.policies" : "main");
}

/** Check one plan. `planJson` is the unredacted `show -json` text; `context` fills `input.run` with `input: hcp`. */
export async function checkPlan(binary: string, policy: PolicySettings, repo: string, planJson: string, options: PolicyOptions = {}, context?: PolicyRunContext): Promise<PolicyVerdict> {
  const exec = options.exec ?? defaultPolicyExec;
  const dir = mkdtempSync(join(tmpdir(), "terragucci-policy-"));
  const file = join(dir, "plan.json");
  const path = resolve(repo, policy.path ?? "policy");
  const engine = policy.engine ?? "conftest";
  try {
    writeFileSync(file, policyInput(policy, planJson, context));
    const opa = engine === "opa";
    const r = await exec(binary, policyArgs(policy, path, file), repo);
    // With input: hcp and no namespace, every package under terraform.policies is one policy of the set.
    const found = opa ? opaFindings(r.stdout, policy.input === "hcp" && policy.namespace === undefined) : conftestFindings(r.stdout);
    if (found === undefined) return { violations: [], error: `${engine} gave no verdict (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}` };
    // conftest exits 1 on a denial and 2 or more when it could not run; opa exits 0 or 1 on a query it ran.
    if (found.violations.length === 0 && r.status !== 0) return { violations: [], error: `${engine} exited ${r.status}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}` };
    return { violations: found.violations, ...(found.warnings.length > 0 ? { warnings: found.warnings } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The error a failed root carries, which the report and the note show as the reason. */
export function describeVerdict(engine: string, v: PolicyVerdict): string {
  if (v.error) return `policy could not be checked, so the root fails: ${v.error}`;
  return `policy violation (${engine}):\n${v.violations.map((m) => `- ${m}`).join("\n")}`;
}

/** A verdict as the report keeps it under the root. */
export function rootPolicy(v: PolicyVerdict): ReportRootPolicy {
  const result = v.error !== undefined ? "error" : v.violations.length > 0 ? "denied" : "passed";
  return { result, denials: v.violations, warnings: v.warnings ?? [], ...(v.error !== undefined ? { error: v.error } : {}) };
}

/** Whether the policy path exists in the repo, so a typo fails loudly and not as a pass. */
export function policyPathExists(policy: PolicySettings, repo: string): boolean {
  return existsSync(resolve(repo, policy.path ?? "policy"));
}

/** What `trustedPolicy` hands the check: the settings to run, and a cleanup for the base copy it made. */
export interface TrustedPolicy {
  policy: PolicySettings;
  /** Set when the policy could not be read from the base; every root fails with it. */
  error?: string;
  /** Where the policy came from, for the log. */
  from: "checkout" | "base";
  cleanup: () => void;
}

function gitOut(repo: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Copy the tree under `path` at `ref` into `dest`. Returns the file count, or the reason it failed. */
function exportTree(repo: string, ref: string, path: string, dest: string): number | string {
  const rel = `./${path.replace(/^\.\//, "").replace(/\/+$/, "")}`;
  const ls = gitOut(repo, ["ls-tree", "-r", "-z", ref, "--", rel]);
  if (ls.status !== 0) return `git ls-tree ${ref} ${path}: ${ls.stderr.trim().split("\n")[0]}`;
  let count = 0;
  for (const entry of ls.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode] = entry.slice(0, tab).split(" ");
    if (mode === "120000" || mode === "160000") continue;
    const file = entry.slice(tab + 1);
    const shown = gitOut(repo, ["show", `${ref}:./${file}`]);
    if (shown.status !== 0) return `git show ${ref}:./${file}: ${shown.stderr.trim().split("\n")[0]}`;
    const out = join(dest, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, shown.stdout);
    count++;
  }
  return count;
}

/** Copy the `.ts` files beside `rel` at `ref` (its directory, not below it) into `dest`. Returns the count, or the reason it failed. */
function exportSiblingsTs(repo: string, ref: string, rel: string, dest: string): number | string {
  const parent = dirname(rel);
  const ls = gitOut(repo, ["ls-tree", "-z", ref, "--", parent === "." ? "./" : `./${parent}/`]);
  if (ls.status !== 0) return `git ls-tree ${ref} ${parent}: ${ls.stderr.trim().split("\n")[0]}`;
  let count = 0;
  for (const entry of ls.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    const name = file.split("/").pop()!;
    if (type !== "blob" || mode === "120000" || !name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".test.ts")) continue;
    const shown = gitOut(repo, ["show", `${ref}:./${file}`]);
    if (shown.status !== 0) return `git show ${ref}:./${file}: ${shown.stderr.trim().split("\n")[0]}`;
    writeFileSync(join(dest, name), shown.stdout);
    count++;
  }
  return count;
}

export interface TrustedOptions {
  /** The config file the run reads; its base copy supplies the `policy:` key. */
  config?: string;
  /** The control repo project the run reads, if any. */
  project?: string;
}

/**
 * The policy a plan is checked against. Without a base (a push to main, a
 * schedule) that is the checkout's. With one (a pull request's target branch)
 * the `policy:` key is read from the config at the base, and its directory is
 * exported from the base into a temporary directory, so the pull request's own
 * edits to either change nothing. A base that has no `policy:` key leaves the
 * checkout's in force: there is nothing there to waive. A base that cannot be
 * read fails closed.
 */
export async function trustedPolicy(repo: string, checkout: PolicySettings, base: string | undefined, options: TrustedOptions = {}): Promise<TrustedPolicy> {
  const own: TrustedPolicy = { policy: checkout, from: "checkout", cleanup: () => {} };
  if (!base) return own;
  let atBase: PolicySettings | undefined = checkout;
  if (options.config) {
    const rel = relative(repo, options.config);
    const shown = gitOut(repo, ["show", `${base}:./${rel}`]);
    if (shown.status !== 0) {
      // No config file at the base: nothing was in force there.
      if (/exists on disk, but not in|does not exist in|path .* does not exist/.test(shown.stderr)) return own;
      return { ...own, error: `could not read ${rel} at ${base}: ${shown.stderr.trim().split("\n")[0]}` };
    }
    const dir = mkdtempSync(join(tmpdir(), "terragucci-baseconfig-"));
    try {
      const file = join(dir, rel.split("/").pop()!);
      if (/\.ts$/.test(rel)) {
        // A TypeScript config is folded, never run, from the base's own files: every .ts file beside it, as the folder reads them at the checkout.
        const copied = exportSiblingsTs(repo, base, rel, dir);
        if (typeof copied === "string") return { ...own, error: `could not read ${rel} at ${base}: ${copied}` };
      } else {
        writeFileSync(file, shown.stdout);
      }
      const config = await loadConfig(file);
      atBase = (options.project ? resolveProject(config, options.project) : resolveRepo(config)).policy;
    } catch (e) {
      return { ...own, error: `could not read the config at ${base}: ${(e as Error).message}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!atBase) return own;
  const path = atBase.path ?? "policy";
  const dest = mkdtempSync(join(tmpdir(), "terragucci-basepolicy-"));
  const cleanup = () => rmSync(dest, { recursive: true, force: true });
  const n = exportTree(repo, base, path, dest);
  if (typeof n === "string" || n === 0) {
    cleanup();
    return { ...own, error: typeof n === "string" ? `could not read the policy at ${base}: ${n}` : `the policy directory ${path} does not exist at ${base}` };
  }
  return { policy: { ...atBase, path: join(dest, path.replace(/^\.\//, "")) }, from: "base", cleanup };
}

/**
 * The policy settings a check runs with, once read from the trusted ref: the
 * directory (a temporary copy of the base's, for a pull request), the engine,
 * the namespace and the input mode. `tf-check` reads it to test the same
 * policy the plan is checked against. Call `cleanup` when done.
 */
export interface ResolvedPolicy {
  /** The policy directory, absolute. */
  dir: string;
  engine: PolicyEngine;
  /** The namespace set in the config, if any (conftest then reads every namespace; opa reads `opaNamespace`). */
  namespace?: string;
  input: PolicyInput;
  /** The settings as read, `path` pointing at `dir`, for `engineBinary` and `checkPlan`. */
  settings: PolicySettings;
  from: "checkout" | "base";
  /** Set when the policy could not be read from the base, or its directory is missing; a check fails closed on it. */
  error?: string;
  cleanup: () => void;
}

/** Resolve the policy a run is checked against: `trustedPolicy`, with every default filled in. */
export async function resolvePolicySettings(repo: string, checkout: PolicySettings, base: string | undefined, options: TrustedOptions = {}): Promise<ResolvedPolicy> {
  const trusted = await trustedPolicy(repo, checkout, base, options);
  const settings = trusted.policy;
  const dir = resolve(repo, settings.path ?? "policy");
  const missing = trusted.error === undefined && !existsSync(dir) ? `the policy directory ${checkout.path ?? "policy"} does not exist` : undefined;
  const error = trusted.error ?? missing;
  return {
    dir,
    engine: settings.engine ?? "conftest",
    ...(settings.namespace !== undefined ? { namespace: settings.namespace } : {}),
    input: settings.input ?? "plan",
    settings,
    from: trusted.from,
    ...(error !== undefined ? { error } : {}),
    cleanup: trusted.cleanup,
  };
}

/** What `checkPlans` found: the run's settings for the report, and each root's verdict. */
export interface PolicyCheck {
  /** The run's policy, as the report keeps it. */
  policy: ReportPolicy;
  /** Each checked root's verdict, by path. */
  roots: Map<string, ReportRootPolicy>;
  /** The error of every root that fails, as the report and the note show it. */
  failed: Map<string, string>;
}

/**
 * Check each plan against the project's policy. A denial fails the root and
 * lists the messages; a policy that cannot be read or run fails it too;
 * warnings fail nothing. For a pull request (`base` set) the policy comes
 * from the base branch, so the change under review cannot edit it away.
 * Nothing reads a response or agent setting, so no path waives it.
 */
export async function checkPlans(
  repo: string,
  policy: PolicySettings,
  items: { path: string; plan: unknown }[],
  base: string | undefined,
  trust: TrustedOptions,
  options: PolicyOptions,
  log: (line: string) => void,
  run: Omit<PolicyRunContext, "root"> = {},
): Promise<PolicyCheck> {
  const roots = new Map<string, ReportRootPolicy>();
  const failed = new Map<string, string>();
  const engine = policy.engine ?? "conftest";
  const summary = (from: ReportPolicy["from"], settings: PolicySettings): ReportPolicy => ({
    engine: settings.engine ?? engine,
    input: settings.input ?? "plan",
    ...(settings.namespace !== undefined ? { namespace: settings.namespace } : {}),
    from,
    denied: [...failed.keys()].sort(),
    warnings: [...roots.values()].reduce((n, r) => n + r.warnings.length, 0),
  });
  if (items.length === 0) return { policy: summary("checkout", policy), roots, failed };
  const resolved = await resolvePolicySettings(repo, policy, base, trust);
  try {
    if (resolved.from === "base") log(`policy: read from ${base}, not from this checkout`);
    let binary: string | undefined;
    let setup: string | undefined = resolved.error;
    if (setup === undefined) {
      try {
        binary = await engineBinary(resolved.settings, repo, options);
      } catch (e) {
        setup = (e as Error).message;
      }
    }
    let denied = 0;
    for (const item of items) {
      const verdict: PolicyVerdict = setup !== undefined || binary === undefined
        ? { violations: [], error: setup ?? "no engine" }
        : await checkPlan(binary, resolved.settings, repo, JSON.stringify(item.plan), options, { ...run, root: item.path });
      roots.set(item.path, rootPolicy(verdict));
      for (const w of verdict.warnings ?? []) log(`${item.path}: policy warns: ${w}`);
      if (verdict.error === undefined && verdict.violations.length === 0) {
        log(`${item.path}: policy passed`);
        continue;
      }
      denied += verdict.violations.length;
      failed.set(item.path, describeVerdict(resolved.engine, verdict));
      log(`${item.path}: ${verdict.error ? "policy could not be checked" : `policy denied ${verdict.violations.length}`}`);
      for (const m of verdict.violations) log(`  ${m}`);
    }
    if (failed.size > 0) log(`policy: ${failed.size} root${failed.size === 1 ? "" : "s"} failed${denied ? `, ${denied} violation${denied === 1 ? "" : "s"}` : ""}`);
    return { policy: summary(resolved.from, resolved.settings), roots, failed };
  } finally {
    resolved.cleanup();
  }
}
