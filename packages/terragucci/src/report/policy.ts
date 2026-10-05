/**
 * Policy as code: the opt-in `policy:` key runs conftest or OPA over each
 * planned root's plan JSON, and a violation fails the root in `tf-plan`.
 *
 * The check reads the unredacted `show -json` of each root, writes it to a
 * temporary file, and runs the engine on that file. Nothing here reads a
 * respond mode or an agent setting, and a policy that cannot run (no engine,
 * a policy that does not compile) fails the root too, so no path waives it.
 * Pull-request code can edit the policy directory like any file in the
 * checkout; protect it with CODEOWNERS or a branch rule.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PolicySettings } from "../config";

/** What one run of an engine printed and how it exited. */
export interface PolicyRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type PolicyExec = (file: string, args: string[], cwd: string) => Promise<PolicyRun>;

export const CONFTEST_VERSION = "0.56.0";

/** SHA-256 of the Linux release archives, so a download is checked against a pin and not against itself. */
export const CONFTEST_SHA256: Record<string, string> = {
  x86_64: "620f41640d63bbde1646a108ce2816ba54c980466ceebb7e754dda2d508e8cd5",
  arm64: "86334e4ca57b991f0dca0dd3d011270edda50fdff2b2e208954ea639bb1c99ec",
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

/** The engine's executable: the one on the path, or conftest fetched once and checked against its pinned digest. */
export async function engineBinary(policy: PolicySettings, repo: string, options: PolicyOptions = {}): Promise<string> {
  const exec = options.exec ?? defaultPolicyExec;
  const name = policy.engine ?? "conftest";
  const onPath = await exec(name, ["--version"], repo);
  if (onPath.status === 0) return name;
  if (name !== "conftest") throw new Error(`policy.engine is ${name}, but ${name} is not on the path; put it in the job's image or install it in an earlier step`);
  const arch = (options.arch ?? process.arch) === "arm64" ? "arm64" : "x86_64";
  const dir = join(options.cache ?? tmpdir(), `terragucci-conftest-${CONFTEST_VERSION}-${arch}`);
  const bin = join(dir, "conftest");
  if (existsSync(bin)) return bin;
  const asset = `conftest_${CONFTEST_VERSION}_Linux_${arch}.tar.gz`;
  const url = `https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/${asset}`;
  const body = await (options.download ?? fetchBytes)(url);
  const sum = createHash("sha256").update(body).digest("hex");
  if (sum !== CONFTEST_SHA256[arch]) throw new Error(`conftest ${CONFTEST_VERSION} from ${url} does not match its pinned digest (got ${sum}); not running it`);
  const work = mkdtempSync(join(tmpdir(), "terragucci-conftest-"));
  try {
    writeFileSync(join(work, asset), body);
    const untar = await exec("tar", ["-xzf", join(work, asset), "-C", work, "conftest"], work);
    if (untar.status !== 0) throw new Error(`could not unpack conftest: ${untar.stderr.trim()}`);
    mkdirSync(dir, { recursive: true });
    renameSync(join(work, "conftest"), bin);
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
