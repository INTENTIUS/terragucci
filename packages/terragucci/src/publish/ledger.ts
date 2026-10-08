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
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ReleaseRecord, RunOrigin } from "@intentius/chant/lifecycle/release-ledger";

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
  const f = spawnSync("git", ["-C", repo, "fetch", "-q", "--no-tags", remote, `+refs/heads/${LIFECYCLE}:${local}`], { encoding: "utf-8" });
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
