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
 * config folded at the base), from the base branch (`governingPolicy`,
 * `trustedPolicy`), so a change that edits or deletes the policy cannot
 * waive its own violation. `tf-apply` applies the same check to a wave's
 * plans, with the policy of the checkout it runs from (main) or of TG_BASE.
 *
 * A namespace that names no package fails the root by name. Denial and
 * warning messages have the plan's sensitive values replaced, as the stored
 * plan does. With `input: hcp`, a `policies.hcl` in the policy directory is
 * read as HCP Terraform reads it: each policy's query, and its enforcement
 * level (advisory policies warn, mandatory ones deny).
 *
 * With `source:` the Rego comes from a shared repo at a pinned ref, fetched
 * into a temporary directory for each run (`fetchPolicySource`), and `path`
 * is the directory inside that repo. The key itself is still read at the
 * base, so a pull request cannot point it at another repo or ref.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CONFIG_NAMES, loadConfig, parsePolicySource, resolveProject, resolveRepo, type PolicyEngine, type PolicyInput, type PolicySettings, type TerragucciConfig } from "../config";
import { redactPlan } from "./redact";
import { REDACTED, type ReportPolicy, type ReportRootPolicy } from "./schema";

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
  /** The ids of the rules that denied, sorted, each once: what an override names (ruleId). */
  rules?: string[];
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
  /** The id of the rule behind each violation, in the same order. */
  rules: string[];
}

/**
 * A rule's id: its package and name, `main.deny_public_bucket`, from the query
 * the engine ran (`data.main.deny_public_bucket`). An HCP policy set's rule is
 * its policy's name.
 */
export const ruleId = (query: string): string => query.replace(/^data\./, "");

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
  const out: PolicyFindings = { violations: [], warnings: [], rules: [] };
  for (const r of results as { namespace?: string; failures?: { msg?: unknown; metadata?: { query?: unknown } }[]; warnings?: { msg?: unknown }[] }[]) {
    for (const f of r.failures ?? []) {
      out.violations.push(typeof f.msg === "string" ? f.msg : JSON.stringify(f.msg));
      // conftest names the query that denied in the failure's metadata; an older one gives only the namespace.
      out.rules.push(typeof f.metadata?.query === "string" ? ruleId(f.metadata.query) : `${r.namespace ?? "main"}.deny`);
    }
    for (const w of r.warnings ?? []) out.warnings.push(typeof w.msg === "string" ? w.msg : JSON.stringify(w.msg));
  }
  return out;
}

/** The rules of one package's document: each deny-like and warn-like rule's messages. `nested` reads every child package too. `pkg` is the package's name, for the rule ids. */
function packageFindings(doc: Record<string, unknown>, out: PolicyFindings, nested: boolean, pkg: string): void {
  for (const [name, value] of Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const deny = DENY_RULE.test(name);
    const into = deny ? out.violations : WARN_RULE.test(name) ? out.warnings : undefined;
    if (into) {
      const before = into.length;
      if (Array.isArray(value)) into.push(...value.map(messageOf));
      else if (value === true) into.push(name);
      else if (typeof value === "string") into.push(value);
      if (deny) for (let i = before; i < into.length; i++) out.rules.push(`${pkg}.${name}`);
      continue;
    }
    if (nested && value !== null && typeof value === "object" && !Array.isArray(value)) packageFindings(value as Record<string, unknown>, out, false, `${pkg}.${name}`);
  }
}

/**
 * The findings in an `opa eval` JSON result. The query is a package
 * (`data.<namespace>`), so its value holds every rule: `deny`, `violation`
 * and `deny_*` fail the root, `warn` and `warn_*` are advice, as conftest
 * counts them. An array value is read as a deny set. No result means the
 * package has no rule that holds: no denial. `checkPlans` has already
 * failed the root when the namespace names no package at all.
 */
export function opaFindings(stdout: string, nested = false, namespace = "main"): PolicyFindings | undefined {
  const answer = opaAnswer(stdout);
  if (answer === undefined) return undefined;
  return answer.value === undefined ? { violations: [], warnings: [], rules: [] } : findingsOf(answer.value, nested, namespace);
}

/** The value of an `opa eval` JSON result's query: `{}` when the query is undefined, `undefined` when the output is not a result. */
export function opaAnswer(stdout: string): { value?: unknown } | undefined {
  let parsed: { result?: { expressions?: { value?: unknown }[] }[]; errors?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.errors !== undefined) return undefined;
  const value = parsed.result?.[0]?.expressions?.[0]?.value;
  return value === undefined ? {} : { value };
}

/** The findings in a query's value: an array is a deny set (its rule is `query`), an object is the rules of the package `query` names. */
function findingsOf(value: unknown, nested: boolean, query: string): PolicyFindings | undefined {
  if (Array.isArray(value)) return { violations: value.map(messageOf), warnings: [], rules: value.map(() => ruleId(query)) };
  if (value === null || typeof value !== "object") return undefined;
  const out: PolicyFindings = { violations: [], warnings: [], rules: [] };
  packageFindings(value as Record<string, unknown>, out, nested, ruleId(query));
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

/** One `policy` block of an HCP Terraform `policies.hcl`. */
export interface HcpPolicy {
  name: string;
  /** The Rego query, such as `data.terraform.policies.public_buckets.deny`. */
  query: string;
  /** `advisory` (HCP's default) warns; `mandatory` denies. */
  level: "advisory" | "mandatory";
}

/** The file HCP Terraform reads a policy set's policies and enforcement levels from. */
export const HCP_POLICY_FILE = "policies.hcl";

/**
 * The policies an HCP Terraform `policies.hcl` declares: each `policy "<name>"`
 * block's `query` and `enforcement_level`. A string is the reason the file
 * cannot be read, which fails the root; `undefined` means there is no file.
 */
export function hcpPolicySet(dir: string): HcpPolicy[] | string | undefined {
  const file = join(dir, HCP_POLICY_FILE);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8").replace(/^\s*(#|\/\/).*$/gm, "");
  const out: HcpPolicy[] = [];
  for (const m of text.matchAll(/policy\s+"([^"]+)"\s*\{([^}]*)\}/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([A-Za-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((a) => [a[1], a[2].replace(/\\(.)/g, "$1")]));
    if (!attrs.query) return `${HCP_POLICY_FILE}: policy "${m[1]}" has no query`;
    const level = attrs.enforcement_level ?? "advisory";
    if (level !== "advisory" && level !== "mandatory") return `${HCP_POLICY_FILE}: policy "${m[1]}" has enforcement_level ${level}; HCP Terraform reads advisory or mandatory`;
    out.push({ name: m[1], query: attrs.query, level });
  }
  if (out.length === 0) return `${HCP_POLICY_FILE} declares no policy block`;
  return out;
}

/** The policies of a `policies.hcl` that a check runs: every one, or those whose query is inside `namespace`. */
function hcpPoliciesToRun(set: HcpPolicy[], namespace: string | undefined): HcpPolicy[] {
  if (namespace === undefined) return set;
  const prefix = `data.${namespace}`;
  return set.filter((p) => p.query === prefix || p.query.startsWith(`${prefix}.`));
}

/** Run each policy of a `policies.hcl` by its own query: a mandatory policy's messages deny, an advisory one's warn. */
async function checkHcpSet(binary: string, set: HcpPolicy[], policy: PolicySettings, path: string, file: string, repo: string, exec: PolicyExec): Promise<PolicyVerdict> {
  const run = hcpPoliciesToRun(set, policy.namespace);
  if (run.length === 0) return { violations: [], error: `no policy in ${HCP_POLICY_FILE} has a query under data.${policy.namespace}` };
  const out: PolicyFindings = { violations: [], warnings: [], rules: [] };
  for (const p of run) {
    const r = await exec(binary, ["eval", "--format", "json", "--data", path, "--input", file, p.query], repo);
    const answer = opaAnswer(r.stdout);
    if (answer === undefined) return { violations: [], error: `opa gave no verdict for policy ${p.name} (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}` };
    if (answer.value === undefined) return { violations: [], error: `policy ${p.name}: its query ${p.query} matches no rule` };
    const found = findingsOf(answer.value, true, p.query);
    if (found === undefined) return { violations: [], error: `policy ${p.name}: its query ${p.query} gives ${JSON.stringify(answer.value)}, not a set of messages` };
    // HCP reads the query's messages as the policy's result, whatever the rule is named; the level decides what they do.
    const messages = [...found.violations, ...found.warnings].map((m) => `${p.name}: ${m}`);
    (p.level === "mandatory" ? out.violations : out.warnings).push(...messages);
    if (p.level === "mandatory") out.rules.push(...messages.map(() => p.name));
  }
  return { violations: out.violations, ...ruleList(out.rules), ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}) };
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
    // An HCP policy set's policies.hcl names each policy's query and enforcement level; opa runs them as HCP does.
    if (opa && policy.input === "hcp") {
      const set = hcpPolicySet(path);
      if (typeof set === "string") return { violations: [], error: set };
      if (set) return await checkHcpSet(binary, set, policy, path, file, repo, exec);
    }
    const r = await exec(binary, policyArgs(policy, path, file), repo);
    // With input: hcp and no namespace, every package under terraform.policies is one policy of the set.
    const found = opa ? opaFindings(r.stdout, policy.input === "hcp" && policy.namespace === undefined, opaNamespace(policy)) : conftestFindings(r.stdout);
    if (found === undefined) return { violations: [], error: `${engine} gave no verdict (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}` };
    // conftest exits 1 on a denial and 2 or more when it could not run; opa exits 0 or 1 on a query it ran.
    if (found.violations.length === 0 && r.status !== 0) return { violations: [], error: `${engine} exited ${r.status}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}` };
    return { violations: found.violations, ...ruleList(found.rules), ...(found.warnings.length > 0 ? { warnings: found.warnings } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A verdict's `rules`: each id once, sorted; nothing when no rule denied. */
const ruleList = (rules: string[]): { rules?: string[] } => (rules.length > 0 ? { rules: [...new Set(rules)].sort() } : {});

/** The error a failed root carries, which the report and the note show as the reason. */
export function describeVerdict(engine: string, v: PolicyVerdict): string {
  if (v.error) return `policy could not be checked, so the root fails: ${v.error}`;
  return `policy violation (${engine}):\n${v.violations.map((m) => `- ${m}`).join("\n")}`;
}

/** A verdict as the report keeps it under the root. */
export function rootPolicy(v: PolicyVerdict): ReportRootPolicy {
  const result = v.error !== undefined ? "error" : v.violations.length > 0 ? "denied" : "passed";
  return { result, denials: v.violations, ...(v.rules?.length ? { rules: v.rules } : {}), warnings: v.warnings ?? [], ...(v.error !== undefined ? { error: v.error } : {}) };
}

/** Every `.rego` file under `dir` that is not a test, with its text. */
function regoFiles(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".rego") && !name.endsWith("_test.rego")) out.push({ file: p, text: readFileSync(p, "utf-8") });
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

/** A rule head that counts: `deny`, `violation`, `warn` and their `_<name>` forms, at the start of a line. */
const COUNTED_HEAD = /^\s*(?:default\s+)?(deny|violation|warn)(_[A-Za-z0-9]+)*\b/m;

/**
 * Why the namespace the engine reads matches nothing: no Rego file under
 * `dir` declares that package (a child package too, for opa's HCP default),
 * or none of its files has a `deny`, `violation` or `warn` rule. Undefined
 * when it matches, when conftest reads every namespace, or when a package
 * name is written in a form this does not parse. `shown` names the
 * directory in the message.
 */
export function namespaceProblem(policy: PolicySettings, dir: string, shown: string): string | undefined {
  const engine = policy.engine ?? "conftest";
  if (engine === "conftest" && policy.namespace === undefined) return undefined;
  if (engine === "opa" && policy.input === "hcp" && existsSync(join(dir, HCP_POLICY_FILE))) return undefined;
  const target = engine === "opa" ? opaNamespace(policy) : policy.namespace!;
  const nested = engine === "opa" && policy.input === "hcp" && policy.namespace === undefined;
  const packages = new Map<string, boolean>();
  for (const { text } of regoFiles(dir)) {
    const m = /^\s*package\s+(\S+)/m.exec(text);
    if (!m) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(m[1])) return undefined;
    packages.set(m[1], (packages.get(m[1]) ?? false) || COUNTED_HEAD.test(text));
  }
  const matched = [...packages.keys()].filter((p) => p === target || (nested && p.startsWith(`${target}.`)));
  const named = nested ? `package ${target} or a package under it` : `package ${target}`;
  const known = packages.size > 0 ? ` (the packages there: ${[...packages.keys()].sort().join(", ")})` : "";
  if (matched.length === 0) return `the namespace ${target} matches no policy: no Rego file in ${shown} declares ${named}${known}`;
  if (!matched.some((p) => packages.get(p))) return `the namespace ${target} matches no rule: ${named} in ${shown} has no deny, violation or warn rule`;
  return undefined;
}

/** Every sensitive value in a plan, as text, longest first: what `redactPlan` replaces. */
export function sensitiveTexts(plan: unknown): string[] {
  const found = new Set<string>();
  const leaves = (v: unknown) => {
    if (typeof v === "string") {
      if (v !== "") found.add(v);
    } else if (typeof v === "number") {
      found.add(String(v));
    } else if (v !== null && typeof v === "object") {
      found.add(JSON.stringify(v));
      for (const c of Object.values(v)) leaves(c);
    }
  };
  const walk = (orig: unknown, red: unknown) => {
    if (red === REDACTED && orig !== REDACTED) return leaves(orig);
    if (orig === null || typeof orig !== "object" || red === null || typeof red !== "object") return;
    for (const k of Object.keys(orig)) walk((orig as Record<string, unknown>)[k], (red as Record<string, unknown>)[k]);
  };
  walk(plan, redactPlan(plan).plan);
  return [...found].sort((a, b) => b.length - a.length);
}

/** `text` with every sensitive value replaced, as the stored plan has it. */
export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** A verdict whose messages carry no sensitive value of the plan it judged. */
export function redactVerdict(v: PolicyVerdict, plan: unknown): PolicyVerdict {
  const secrets = sensitiveTexts(plan);
  if (secrets.length === 0) return v;
  const clean = (m: string) => redactText(m, secrets);
  return {
    violations: v.violations.map(clean),
    ...(v.rules ? { rules: v.rules } : {}),
    ...(v.warnings ? { warnings: v.warnings.map(clean) } : {}),
    ...(v.error !== undefined ? { error: clean(v.error) } : {}),
  };
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
  /** Where the policy key came from, for the log. */
  from: "checkout" | "base";
  /** With `source:`, the commit of the shared repo the Rego was read at. */
  sourceCommit?: string;
  cleanup: () => void;
}

/** A URL with any user name and password taken out, for a log line or an error. */
export function shownUrl(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^/@]*@/, "$1");
}

/**
 * Fetch `policy.source` at its ref into a temporary directory: the settings
 * with `path` pointing at the policy directory inside it, and the commit
 * read. A tag or branch is fetched alone; a commit the server does not hand
 * out by itself is found after fetching every branch and tag. The job's own
 * git credentials, if any, reach the repo. A source that cannot be fetched,
 * or has no such directory at that ref, is an error that fails every root.
 */
export function fetchPolicySource(policy: PolicySettings, from: TrustedPolicy["from"]): TrustedPolicy {
  const source = parsePolicySource(policy.source ?? "");
  const own: TrustedPolicy = { policy, from, cleanup: () => {} };
  if (!source) return { ...own, error: `policy.source ${policy.source} is not git+https://<host>/<path>@<ref>` };
  const shown = `${shownUrl(source.url)}@${source.ref}`;
  const dest = mkdtempSync(join(tmpdir(), "terragucci-policysource-"));
  const cleanup = () => rmSync(dest, { recursive: true, force: true });
  const fail = (why: string): TrustedPolicy => {
    cleanup();
    return { ...own, error: `could not read the policy from ${shown}: ${why.split(source.url).join(shownUrl(source.url))}` };
  };
  const quiet = ["-c", "advice.detachedHead=false", "-c", "init.defaultBranch=main"];
  const g = (...args: string[]) => gitOut(dest, [...quiet, ...args]);
  if (g("init", "-q").status !== 0) return fail("git init failed");
  let fetched = g("fetch", "-q", "--depth", "1", source.url, source.ref);
  let commit = fetched.status === 0 ? g("rev-parse", "--verify", "FETCH_HEAD^{commit}").stdout.trim() : "";
  if (!commit) {
    fetched = g("fetch", "-q", source.url, "+refs/heads/*:refs/remotes/source/*", "+refs/tags/*:refs/tags/*");
    if (fetched.status !== 0) return fail(fetched.stderr.trim().split("\n").pop() ?? `git fetch exited ${fetched.status}`);
    commit = g("rev-parse", "--verify", "--quiet", `${source.ref}^{commit}`).stdout.trim();
    if (!commit) return fail(`${source.ref} is not a tag, branch or commit there`);
  }
  if (g("checkout", "-q", "--detach", commit).status !== 0) return fail(`could not check out ${commit}`);
  const path = (policy.path ?? "policy").replace(/^\.\//, "");
  const dir = join(dest, path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(`the policy directory ${policy.path ?? "policy"} does not exist at ${source.ref}`);
  return { policy: { ...policy, path: dir }, from, sourceCommit: commit, cleanup };
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

/** What the base branch's config says about policy. */
type BaseConfig =
  /** The base has no config file (or no ref by that name, `missing`): nothing was in force there that terragucci can read. */
  | { kind: "none"; missing?: string }
  /** The config at the base, read: its `policy:` key, if any, and the whole config. */
  | { kind: "read"; policy?: PolicySettings; config: TerragucciConfig }
  /** The config is there and cannot be read. `mentions` is whether its text names `policy` at all. */
  | { kind: "error"; error: string; mentions: boolean };

/**
 * The config file's path at the base: the one the run reads, else the first
 * of CONFIG_NAMES beside it that the base has, since a pull request may
 * delete or rename it. Undefined when the base has none.
 */
function baseConfigPath(repo: string, base: string, options: TrustedOptions): string | undefined {
  const rel = options.config ? relative(repo, options.config) : undefined;
  const dir = rel ? dirname(rel) : ".";
  const candidates = [...(rel ? [rel] : []), ...CONFIG_NAMES.map((n) => (dir === "." ? n : `${dir}/${n}`))];
  return candidates.find((c) => gitOut(repo, ["cat-file", "-e", `${base}:./${c}`]).status === 0);
}

/** Read the config at `base` and take its `policy:` key, folding a `.ts` config from the base's own files. */
async function readBaseConfig(repo: string, base: string, options: TrustedOptions): Promise<BaseConfig> {
  if (gitOut(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) return { kind: "none", missing: `${base} is not a commit in this checkout` };
  const rel = baseConfigPath(repo, base, options);
  if (rel === undefined) return { kind: "none" };
  const shown = gitOut(repo, ["show", `${base}:./${rel}`]);
  if (shown.status !== 0) {
    // No config file at the base: nothing was in force there.
    if (/exists on disk, but not in|does not exist in|path .* does not exist/.test(shown.stderr)) return { kind: "none" };
    return { kind: "error", error: `could not read ${rel} at ${base}: ${shown.stderr.trim().split("\n")[0]}`, mentions: true };
  }
  const dir = mkdtempSync(join(tmpdir(), "terragucci-baseconfig-"));
  let text = shown.stdout;
  try {
    const file = join(dir, rel.split("/").pop()!);
    if (/\.ts$/.test(rel)) {
      // A TypeScript config is folded, never run, from the base's own files: every .ts file beside it, as the folder reads them at the checkout.
      const copied = exportSiblingsTs(repo, base, rel, dir);
      if (typeof copied === "string") return { kind: "error", error: `could not read ${rel} at ${base}: ${copied}`, mentions: true };
      text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
    } else {
      writeFileSync(file, shown.stdout);
    }
    const config = await loadConfig(file);
    return { kind: "read", policy: (options.project ? resolveProject(config, options.project) : resolveRepo(config)).policy, config };
  } catch (e) {
    return { kind: "error", error: `could not read the config at ${base}: ${(e as Error).message}`, mentions: /\bpolicy\b/.test(text) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The whole config at `base`, read the way the policy key is: a `.ts` config
 * folded from the base's own files, never run. A base with no config file
 * gives the empty config, since nothing was set there. A base ref the
 * checkout does not have, or a config there that cannot be read, gives the
 * reason instead. `tf-apply` reads a pull request's settings from here when
 * it applies the pull request before it merges.
 */
export async function configAtBase(repo: string, base: string, options: TrustedOptions = {}): Promise<{ config: TerragucciConfig } | { error: string }> {
  const read = await readBaseConfig(repo, base, options);
  if (read.kind === "error") return { error: read.error };
  if (read.kind === "none") return read.missing ? { error: read.missing } : { config: {} };
  return { config: read.config };
}

/** Which `policy:` key governs a run, and the trust options that read it again for the check. */
export interface GoverningPolicy {
  /** The settings to check with; undefined when no policy is in force. */
  policy?: PolicySettings;
  /** Where the key came from. */
  from: "checkout" | "base";
  /** The options for `checkPlans` and `trustedPolicy`: the config path at the base, when the checkout has none. */
  trust: TrustedOptions;
  /** A line for the log, when the base was not read. */
  note?: string;
}

/**
 * Whether policy runs, and with which `policy:` key. Without a base that is
 * the checkout's key. With one, the base's key governs: a pull request that
 * deletes or edits `policy:` is checked against the base's. A base with no
 * key leaves the checkout's in force, since there is nothing to waive. A base
 * whose config cannot be read keeps the check on (and `trustedPolicy` then
 * fails every root), unless the checkout has no key and the base's config
 * never names `policy`. A base ref the checkout does not have leaves the
 * checkout's key, as affected-root selection does; with a key there,
 * `trustedPolicy` fails closed on it.
 */
export async function governingPolicy(repo: string, checkout: PolicySettings | undefined, base: string | undefined, options: TrustedOptions = {}): Promise<GoverningPolicy> {
  if (!base) return { ...(checkout ? { policy: checkout } : {}), from: "checkout", trust: options };
  const rel = baseConfigPath(repo, base, options);
  const trust = rel ? { ...options, config: join(repo, rel) } : options;
  const read = await readBaseConfig(repo, base, trust);
  const own = { ...(checkout ? { policy: checkout } : {}), from: "checkout" as const, trust };
  if (read.kind === "none") return read.missing && !checkout ? { ...own, note: `policy: ${read.missing}, so the policy key is read from this checkout` } : own;
  if (read.kind === "read") return read.policy ? { policy: read.policy, from: "base", trust } : own;
  if (checkout || read.mentions) return { policy: checkout ?? {}, from: "checkout", trust };
  return { ...own, note: `policy: ${read.error}; it never names policy, so no policy was in force there` };
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
  // A shared source is fetched whichever side the key came from; the key, and so the repo and ref, is the trusted one.
  const own: TrustedPolicy = { policy: checkout, from: "checkout", cleanup: () => {} };
  const ownOrSource = (): TrustedPolicy => (checkout.source ? fetchPolicySource(checkout, "checkout") : own);
  if (!base) return ownOrSource();
  let atBase: PolicySettings | undefined = checkout;
  if (options.config) {
    const read = await readBaseConfig(repo, base, options);
    if (read.kind === "none" && !read.missing) return ownOrSource();
    if (read.kind === "none") return { ...own, error: `could not read the policy at ${base}: ${read.missing}` };
    if (read.kind === "error") return { ...own, error: read.error };
    atBase = read.policy;
  }
  if (!atBase) return ownOrSource();
  if (atBase.source) return fetchPolicySource(atBase, "base");
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
  /** With `source:`, the commit of the shared repo the Rego was read at. */
  sourceCommit?: string;
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
    ...(trusted.sourceCommit ? { sourceCommit: trusted.sourceCommit } : {}),
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
 * lists the messages; a policy that cannot be read or run fails it too, as
 * does a namespace that names no package; warnings fail nothing.
 * For a pull request (`base` set) the policy comes from the base branch, so
 * the change under review cannot edit it away; `governingPolicy` decides
 * whether it runs at all. Messages have the plan's sensitive values
 * replaced. Nothing reads a response or agent setting, so no path waives it.
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
    if (resolved.settings.source && resolved.sourceCommit) log(`policy: read from ${shownUrl(resolved.settings.source)} at commit ${resolved.sourceCommit.slice(0, 12)}${resolved.from === "base" ? `, as the policy key at ${base} names it` : ""}`);
    else if (resolved.from === "base") log(`policy: read from ${base}, not from this checkout`);
    let binary: string | undefined;
    let setup: string | undefined = resolved.error ?? namespaceProblem(resolved.settings, resolved.dir, policy.path ?? "policy");
    if (setup === undefined && resolved.engine === "conftest" && resolved.input === "hcp" && existsSync(join(resolved.dir, HCP_POLICY_FILE))) {
      log(`policy: conftest does not read ${HCP_POLICY_FILE}, so every policy is mandatory; set engine: opa for its enforcement levels`);
    }
    if (setup === undefined) {
      try {
        binary = await engineBinary(resolved.settings, repo, options);
      } catch (e) {
        setup = (e as Error).message;
      }
    }
    let denied = 0;
    for (const item of items) {
      // The engine reads the unredacted plan; what it prints back is redacted as the stored plan is.
      const verdict: PolicyVerdict = setup !== undefined || binary === undefined
        ? { violations: [], error: setup ?? "no engine" }
        : redactVerdict(await checkPlan(binary, resolved.settings, repo, JSON.stringify(item.plan), options, { ...run, root: item.path }), item.plan);
      roots.set(item.path, rootPolicy(verdict));
      for (const w of verdict.warnings ?? []) log(`${item.path}: policy warns: ${w}`);
      if (verdict.error === undefined && verdict.violations.length === 0) {
        log(`${item.path}: policy passed`);
        continue;
      }
      denied += verdict.violations.length;
      failed.set(item.path, describeVerdict(resolved.engine, verdict));
      log(`${item.path}: ${verdict.error ? "policy could not be checked" : `policy denied ${verdict.violations.length}${verdict.rules?.length ? ` (${verdict.rules.join(", ")})` : ""}`}`);
      for (const m of verdict.violations) log(`  ${m}`);
    }
    if (failed.size > 0) log(`policy: ${failed.size} root${failed.size === 1 ? "" : "s"} failed${denied ? `, ${denied} violation${denied === 1 ? "" : "s"}` : ""}`);
    return { policy: summary(resolved.from, resolved.settings), roots, failed };
  } finally {
    resolved.cleanup();
  }
}
