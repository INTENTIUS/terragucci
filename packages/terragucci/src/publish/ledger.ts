/**
 * Where an attested release is recorded: chant's release ledger on the
 * publishing repo's `chant/lifecycle` branch, in the `modules` environment.
 *
 * Each release adds one line to `modules/releases.jsonl`, a chant
 * `ReleaseRecord` (`chant components status modules` reads it): the module's
 * path as the component, the release digest (the content digest of a git tag,
 * the manifest digest of an OCI tag), the commit it was cut from, the run and
 * who ran it. Beside it, under `modules/attest/<digest>/`, are the signature,
 * provenance and SBOM bundles, the SBOM itself and the chant component the
 * release ran as.
 *
 * The record says nothing a tag does not: a tag and a record agree when the
 * tag's digest and commit are in a record for its module.
 *
 * Every publish writes a record, attested or not, and each names its version
 * (`releaseVersion`, terragucci#1289 ruling A), so the release catalog reads
 * the ledger only. Records are written with chant's ledger writer
 * ({@link recordRelease}).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ReleaseRecord, RunOrigin } from "@intentius/chant/lifecycle/release-ledger";
import { ConfigError } from "../config";

export const LIFECYCLE = "chant/lifecycle";
/** The release ledger's environment: one per repo for every module release. */
export const LEDGER_ENV = "modules";
export const LEDGER_PATH = `${LEDGER_ENV}/releases.jsonl`;

/** The files beside a release's record. */
export const ATTEST_FILES = {
  signature: "signature.bundle",
  provenance: "provenance.bundle",
  sbomAttestation: "sbom.bundle",
  sbom: "sbom.spdx.json",
  component: "component.json",
} as const;

export const attestDir = (digest: string): string => `${LEDGER_ENV}/attest/${digest.replace(":", "_")}`;

/**
 * The run id and where it can be followed, from the job's environment: chant's
 * `resolveRunId` rules (a GitHub or Forgejo run, a GitLab pipeline, else a
 * local id), kept here so the bundle does not carry the ledger's git layer.
 */
export function runOf(env: NodeJS.ProcessEnv): { runId: string; runOrigin: RunOrigin } {
  if (env.GITHUB_RUN_ID) {
    return {
      runId: env.GITHUB_RUN_ID,
      runOrigin: {
        forge: "github",
        ...(env.GITHUB_REPOSITORY ? { repo: env.GITHUB_REPOSITORY } : {}),
        ...(env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? { url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` } : {}),
      },
    };
  }
  if (env.CI_PIPELINE_ID) {
    return { runId: env.CI_PIPELINE_ID, runOrigin: { forge: "gitlab", ...(env.CI_PROJECT_PATH ? { repo: env.CI_PROJECT_PATH } : {}), ...(env.CI_PIPELINE_URL ? { url: env.CI_PIPELINE_URL } : {}) } };
  }
  return { runId: `local-${Date.now()}`, runOrigin: { forge: "local" } };
}

/** Who ran the release: the forge's actor, else the git user, else terragucci. */
export function actorOf(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || env.USER || "terragucci";
}

export function releaseRecord(component: string, digest: string, gitSha: string, env: NodeJS.ProcessEnv, timestamp = new Date().toISOString()): ReleaseRecord {
  return { version: 1, component, env: LEDGER_ENV, digest, gitSha, ...runOf(env), timestamp, actor: actorOf(env) };
}

/** A release record with the version it names (chant#4595's optional `releaseVersion`, terragucci#1289 ruling A). */
export type VersionedReleaseRecord = ReleaseRecord & { releaseVersion?: string };

/** What one release adds to the ledger: its record, the files beside it, and the tags pushed with it. */
export interface ReleaseWrite {
  record: VersionedReleaseRecord;
  /** Paths from the ledger's root, such as `modules/attest/<digest>/signature.bundle`. */
  files?: Record<string, string>;
  message: string;
  /** Refs pushed in one atomic push with the ledger commit, so neither lands alone. */
  refs?: string[];
  /** Keep the record on the local branch even when there is an origin (publish's `push: false`). */
  local?: boolean;
}

const LOCAL_BRANCH = `refs/heads/${LIFECYCLE}`;
const TRACKING = `refs/remotes/origin/${LIFECYCLE}`;

function tip(repo: string, ref: string): string | undefined {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

function gitRun(repo: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, stderr: (r.stderr || "").trim() };
}

/** The local ledger branch back where it was before a write whose push did not land. */
function resetBranch(repo: string, to: string | undefined): void {
  if (to) gitRun(repo, ["update-ref", LOCAL_BRANCH, to]);
  else gitRun(repo, ["update-ref", "-d", LOCAL_BRANCH]);
}

/**
 * Record one release on the ledger through chant's writer (terragucci#1297,
 * replacing the raw-git append publish used before): the files beside the
 * record with `writeLedgerFiles`, the record with `appendReleaseRecord`, both
 * under the member prefix chant resolves for the repo. With an origin the
 * branch is fetched first and pushed after, with `refs` in the same atomic
 * push; a push another writer beat is retried on the new tip, so no tag stands
 * without its record. Without an origin the record stays on the local branch,
 * as chant keeps a ledger with no remote.
 */
export async function recordRelease(repo: string, w: ReleaseWrite): Promise<{ commit: string; pushed: boolean }> {
  const chantGit = await import("@intentius/chant/lifecycle/git");
  const chantLedger = await import("@intentius/chant/lifecycle/release-ledger");
  const origin = !w.local && gitRun(repo, ["remote", "get-url", "origin"]).ok;
  const refs = w.refs ?? [];
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (origin) {
      const fetched = await chantGit.fetchLifecycleStatus({ cwd: repo });
      if (fetched.status === "diverged" || fetched.status === "unreachable") {
        throw new ConfigError(`cannot record ${w.message}: ${LIFECYCLE} at origin ${fetched.status === "diverged" ? "has diverged from this checkout's" : "cannot be read"}: ${fetched.stderr.split("\n")[0]}`);
      }
    }
    const before = tip(repo, LOCAL_BRANCH);
    const prefix = await chantGit.ledgerDir("", { cwd: repo });
    const files = Object.entries(w.files ?? {}).map(([path, content]) => ({ path: `${prefix}${path}`, content }));
    if (files.length > 0) await chantGit.writeLedgerFiles(files, `${w.message} (attestations)`, { cwd: repo });
    const { version: _v, ...input } = w.record;
    const { commit } = await chantLedger.appendReleaseRecord(input as Parameters<typeof chantLedger.appendReleaseRecord>[0], { cwd: repo });
    if (!origin) return { commit, pushed: false };
    if (refs.length === 0) {
      const pushed = await chantGit.pushLifecycleStatus({ cwd: repo });
      if (pushed.status === "pushed" || pushed.status === "not-recorded") return { commit, pushed: pushed.status === "pushed" };
      last = pushed.status === "stale" || pushed.status === "failed" ? pushed.stderr : pushed.status;
      resetBranch(repo, before);
      if (pushed.status !== "stale") break;
      continue;
    }
    // The tags go in the same push as the record, which chant's push does not take: git's own atomic push, with chant's lease.
    const lease = `${LOCAL_BRANCH}:${tip(repo, TRACKING) ?? ""}`;
    const push = gitRun(repo, ["push", "-q", "--atomic", `--force-with-lease=${lease}`, "origin", `${LIFECYCLE}:${LIFECYCLE}`, ...refs]);
    if (push.ok) {
      const now = tip(repo, LOCAL_BRANCH);
      if (now) gitRun(repo, ["update-ref", TRACKING, now]);
      return { commit, pushed: true };
    }
    last = push.stderr;
    resetBranch(repo, before);
  }
  throw new ConfigError(`could not push the ledger record (${w.message}) to ${LIFECYCLE}${refs.length ? ` with ${refs.join(", ")}` : ""}; check that the job may push to it${last ? `: ${last.split("\n")[0]}` : ""}`);
}

/**
 * The `modules` ledger as this checkout holds it after a fetch from origin
 * (when there is one): every release record, and the lines of `statusFile`
 * (chant#4596's `release-status.jsonl`) when one is named. Read through
 * chant's reader, under the member prefix chant resolves for the repo.
 */
export async function readModuleLedger(repo: string, statusFile?: string): Promise<{ records: VersionedReleaseRecord[]; status: string | null; prefix: string }> {
  const chantGit = await import("@intentius/chant/lifecycle/git");
  const chantLedger = await import("@intentius/chant/lifecycle/release-ledger");
  if (gitRun(repo, ["remote", "get-url", "origin"]).ok) await chantGit.fetchLifecycleStatus({ cwd: repo });
  if (!tip(repo, LOCAL_BRANCH)) return { records: [], status: null, prefix: "" };
  const { records } = await chantLedger.readReleaseLedger(LEDGER_ENV, { cwd: repo });
  const status = statusFile ? await chantGit.readBlobFromPath(LEDGER_ENV, statusFile, { cwd: repo }) : null;
  return { records: records as VersionedReleaseRecord[], status, prefix: await chantGit.ledgerDir("", { cwd: repo }) };
}

/** The records of the ledger text, skipping lines that are not records. */
export function parseLedger(text: string): ReleaseRecord[] {
  const out: ReleaseRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReleaseRecord;
      if (["component", "env", "digest", "gitSha", "runId", "timestamp", "actor"].every((k) => typeof (r as unknown as Record<string, unknown>)[k] === "string")) out.push(r);
    } catch {
      // a malformed line is not a record, as chant reads it
    }
  }
  return out;
}

/** A read-only view of a ledger: what the branch holds at one commit. */
export interface Ledger {
  /** Where it was read from, for messages. */
  from: string;
  records: ReleaseRecord[];
  /** A file under `modules/attest/<digest>/`, or undefined. */
  file(digest: string, name: string): string | undefined;
}

function show(repo: string, ref: string, path: string): string | undefined {
  const r = spawnSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf-8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * Fetch `chant/lifecycle` from `remote` (a remote name or a URL) into a ref
 * of its own and read the ledger there. Undefined when the remote has no such
 * branch; throws when the remote cannot be read.
 */
export function fetchLedger(repo: string, remote: string): Ledger | undefined {
  const local = `refs/terragucci/ledger/${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
  const heads = spawnSync("git", ["-C", repo, "ls-remote", "--heads", remote, LIFECYCLE], { encoding: "utf-8" });
  if (heads.status !== 0) throw new Error(`cannot read ${LIFECYCLE} from ${shown(remote)}: ${(heads.stderr || "").trim().split("\n")[0]}`);
  if (!heads.stdout.trim()) return undefined;
  const f = spawnSync("git", ["-C", repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${LIFECYCLE}:${local}`], { encoding: "utf-8" });
  if (f.status !== 0) throw new Error(`cannot fetch ${LIFECYCLE} from ${shown(remote)}: ${(f.stderr || "").trim().split("\n")[0]}`);
  return {
    from: shown(remote),
    records: parseLedger(show(repo, local, LEDGER_PATH) ?? ""),
    file: (digest, name) => show(repo, local, `${attestDir(digest)}/${name}`),
  };
}

/** A URL with any credentials taken out, for a message. */
export function shown(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//");
}
