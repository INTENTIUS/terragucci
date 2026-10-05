/**
 * Policy as code: the opt-in `policy:` key runs conftest or OPA over each
 * planned root's plan JSON, and a violation fails the root in `tf-plan`.
 *
 * The check reads the unredacted `show -json` of each root, writes it to a
 * temporary file, and runs the engine on that file. Nothing here reads a
 * respond mode or an agent setting, and a policy that cannot run (no engine,
 * a policy that does not compile) fails the root too, so no path waives it.
 * A pull request's plan reads the policy, and the `policy:` key, from the
 * base branch (`trustedPolicy`), so a change that edits the policy cannot
 * waive its own violation. `tf-apply` applies the same check to a wave's
 * plans, with the policy of the checkout it runs from (main) or of TG_BASE.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig, resolveProject, resolveRepo, type PolicySettings } from "../config";

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

/** Every message a conftest JSON result denies with. Warnings are advice and do not count. */
export function conftestViolations(stdout: string): string[] | undefined {
  let results: unknown;
  try {
    results = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(results)) return undefined;
  const out: string[] = [];
  for (const r of results as { failures?: { msg?: unknown }[] }[]) {
    for (const f of r.failures ?? []) out.push(typeof f.msg === "string" ? f.msg : JSON.stringify(f.msg));
  }
  return out;
}

/** Every value `data.<namespace>.deny` holds in an `opa eval` JSON result. No result means no denial. */
export function opaViolations(stdout: string): string[] | undefined {
  let parsed: { result?: { expressions?: { value?: unknown }[] }[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const value = parsed.result?.[0]?.expressions?.[0]?.value;
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

/** Check one plan. `planJson` is the unredacted `show -json` text. */
export async function checkPlan(binary: string, policy: PolicySettings, repo: string, planJson: string, options: PolicyOptions = {}): Promise<PolicyVerdict> {
  const exec = options.exec ?? defaultPolicyExec;
  const dir = mkdtempSync(join(tmpdir(), "terragucci-policy-"));
  const file = join(dir, "plan.json");
  const path = resolve(repo, policy.path ?? "policy");
  const namespace = policy.namespace;
  try {
    writeFileSync(file, planJson);
    const opa = (policy.engine ?? "conftest") === "opa";
    const args = opa
      ? ["eval", "--format", "json", "--data", path, "--input", file, `data.${namespace ?? "main"}.deny`]
      : ["test", "--no-color", "--output", "json", "--policy", path, ...(namespace ? ["--namespace", namespace] : ["--all-namespaces"]), file];
    const r = await exec(binary, args, repo);
    const found = opa ? opaViolations(r.stdout) : conftestViolations(r.stdout);
    if (found === undefined) return { violations: [], error: `${policy.engine ?? "conftest"} gave no verdict (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}` };
    // conftest exits 1 on a denial and 2 or more when it could not run; opa exits 0 or 1 on a query it ran.
    if (found.length === 0 && r.status !== 0) return { violations: [], error: `${policy.engine ?? "conftest"} exited ${r.status}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}` };
    return { violations: found };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The error a failed root carries, which the report and the note show as the reason. */
export function describeVerdict(engine: string, v: PolicyVerdict): string {
  if (v.error) return `policy could not be checked, so the root fails: ${v.error}`;
  return `policy violation (${engine}):\n${v.violations.map((m) => `- ${m}`).join("\n")}`;
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
    if (/\.ts$/.test(rel)) {
      // A TypeScript config cannot be evaluated from a string; its policy settings stay the checkout's, and the directory still comes from the base.
    } else {
      const dir = mkdtempSync(join(tmpdir(), "terragucci-baseconfig-"));
      try {
        const file = join(dir, rel.split("/").pop()!);
        writeFileSync(file, shown.stdout);
        const config = await loadConfig(file);
        atBase = (options.project ? resolveProject(config, options.project) : resolveRepo(config)).policy;
      } catch (e) {
        return { ...own, error: `could not read the config at ${base}: ${(e as Error).message}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
