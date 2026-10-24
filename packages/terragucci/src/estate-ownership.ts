/**
 * Which project owns an estate, resolved fresh at each plan (terragucci#753).
 *
 * The control repo's records say which projects own which choudoufu estates.
 * A plan reads them at its start, so nothing written into a project goes
 * stale, and sets them beside what the project's own roots own and read:
 *
 * - an estate two projects claim is refused, so the conflict shows before any
 *   apply;
 * - an estate this project's roots own that the records give to another
 *   project is refused;
 * - an estate a root reads that no root here owns is named with its owner, or
 *   noted as owned by nobody.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseProjectKey, type ControlSettings } from "./config";
import { hasControlRecords, readClaims, type ChantRunner } from "./control-records";

/** The token a plan may read the control repo with, when no checkout is given. */
export const CONTROL_READ_TOKEN_ENV = "TERRAGUCCI_CONTROL_READ_TOKEN";
/** A control repo checkout the plan reads, in place of cloning one. */
export const CONTROL_DIR_ENV = "TERRAGUCCI_CONTROL_DIR";

export interface OwnershipInput {
  /** This project's key, when known. */
  self?: string;
  /** The estates this project's roots own, each with the root. */
  local: ReadonlyMap<string, string>;
  /** Each root's `terraform_estate_outputs` reads. */
  reads: ReadonlyMap<string, readonly { name: string; estate: string }[]>;
  /** Estate to the projects that claim it, as the control repo's records say now. */
  claims: ReadonlyMap<string, readonly string[]>;
}

export interface OwnershipResult {
  /** Lines for the log: who owns each estate a root reads from elsewhere. */
  notes: string[];
  /** Problems that stop the plan. */
  refusals: string[];
  /** Estate to its owning project, for the reads that leave this project. */
  owners: Map<string, string>;
}

export function checkOwnership(input: OwnershipInput): OwnershipResult {
  const notes: string[] = [];
  const refusals: string[] = [];
  const owners = new Map<string, string>();
  for (const [estate, who] of input.claims) {
    if (who.length > 1) refusals.push(`estate ${estate} is claimed by ${who.join(" and ")} in the control repo's records; give it to one project`);
  }
  for (const [estate, root] of input.local) {
    const who = input.claims.get(estate) ?? [];
    if (who.length === 1 && input.self && who[0] !== input.self) refusals.push(`${root} owns estate ${estate}, which the control repo's records give to ${who[0]}`);
  }
  for (const [root, reads] of input.reads) {
    for (const r of reads) {
      if (input.local.has(r.estate)) continue;
      const who = input.claims.get(r.estate) ?? [];
      if (who.length === 1) {
        owners.set(r.estate, who[0]!);
        notes.push(`${root} reads estate ${r.estate} (${r.name}), owned by ${who[0]} in the control repo`);
      } else if (who.length === 0) notes.push(`${root} reads estate ${r.estate} (${r.name}), which no project in the control repo's records owns`);
    }
  }
  return { notes, refusals, owners };
}

/** This job's project key from the forge's CI environment, or undefined. */
export function projectKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_REPOSITORY) {
    const host = env.GITHUB_SERVER_URL ? new URL(env.GITHUB_SERVER_URL).host : "github.com";
    return `${host}/${env.GITHUB_REPOSITORY}`;
  }
  if (env.CI_PROJECT_PATH && env.CI_SERVER_HOST) return `${env.CI_SERVER_HOST}/${env.CI_PROJECT_PATH}`;
  return undefined;
}

export type Clone = (url: string, into: string) => void;
const gitClone: Clone = (url, into) => void execFileSync("git", ["clone", "--quiet", "--depth", "1", url, into], { stdio: ["ignore", "ignore", "pipe"] });

/**
 * The estate claims in the control repo's records, read now: from the
 * checkout `TERRAGUCCI_CONTROL_DIR` names, else from a shallow clone of
 * `control.repo` with `TERRAGUCCI_CONTROL_READ_TOKEN`. With neither, undefined:
 * the plan has no control repo to ask and says so.
 */
export function controlClaims(
  control: ControlSettings | undefined,
  env: NodeJS.ProcessEnv,
  run?: ChantRunner,
  clone: Clone = gitClone,
): Map<string, string[]> | undefined {
  const dir = env[CONTROL_DIR_ENV];
  if (dir) return readClaims(dir, run);
  const token = env[CONTROL_READ_TOKEN_ENV];
  if (!control || !token) return undefined;
  const into = mkdtempSync(join(tmpdir(), "terragucci-control-"));
  try {
    const pk = parseProjectKey(control.repo);
    const url = `https://oauth2:${encodeURIComponent(token)}@${pk.host}/${pk.path}.git`;
    try {
      clone(url, into);
    } catch (e) {
      throw new ConfigError(`could not read the control repo ${control.repo} to resolve estate ownership: ${String((e as Error).message).replaceAll(token, "***").split("\n")[0]}`);
    }
    if (!hasControlRecords(into)) return undefined;
    return readClaims(into, run);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
}
