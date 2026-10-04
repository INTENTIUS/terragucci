/**
 * Terragrunt mode: how terragucci tells a Terragrunt repo, finds its units,
 * and picks the settings its pipeline runs with.
 *
 * A Terragrunt unit is a root. Units and their edges come from Terragrunt's
 * own discovery (`terragrunt find`, through chant's runner), so terragucci
 * never evaluates Terragrunt's HCL to learn the graph. When `terragrunt` is
 * not on the path, the units are the directories holding a `terragrunt.hcl`,
 * with no edges, and Terragrunt orders them itself inside each `run --all`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
// Narrow subpaths: units is pure, run spawns terragrunt. Neither pulls in a compiler.
import {
  matchesUnitGlob,
  stackOfUnit,
  TERRAGRUNT_DISCOVERY_EXCLUDES,
  terragruntWaves,
  type TerragruntUnit,
} from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { checkTerragruntVersion, discoverTerragruntUnits, type TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { ConfigError, type RolePair, type TerragruntSettings } from "./config";

/** The files that mark a Terragrunt repo, in the order detection looks for them. */
export const TERRAGRUNT_MARKERS = ["root.hcl", "terragrunt.hcl", "terragrunt.stack.hcl"] as const;

const SKIP = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", ".terragucci", "terragucci-report"]);
const posix = (p: string): string => p.split("\\").join("/");

function walk(repo: string, visit: (dir: string, names: string[]) => void): void {
  const go = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    visit(dir, names);
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) go(abs);
    }
  };
  go(repo);
}

export interface TerragruntDetection {
  /** Why the repo is a Terragrunt repo: the first marker found, by path. */
  reason: string;
  /** Directories holding a `terragrunt.stack.hcl`: explicit stacks. */
  stacks: string[];
}

/** Whether `repo` is a Terragrunt repo, and why. Undefined when no marker is in it. */
export function detectTerragrunt(repo: string): TerragruntDetection | undefined {
  const found = new Map<string, string>();
  const stacks: string[] = [];
  walk(repo, (dir, names) => {
    const rel = posix(relative(repo, dir)) || ".";
    for (const m of TERRAGRUNT_MARKERS) {
      if (names.includes(m) && !found.has(m)) found.set(m, rel === "." ? m : `${rel}/${m}`);
    }
    if (names.includes("terragrunt.stack.hcl")) stacks.push(rel);
  });
  const first = TERRAGRUNT_MARKERS.find((m) => found.has(m));
  return first ? { reason: found.get(first)!, stacks: stacks.sort() } : undefined;
}

export interface UnitDiscovery {
  units: TerragruntUnit[];
  /** How the units were found. */
  source: "terragrunt find" | "terragrunt.hcl files";
  /** Why discovery fell back to a file walk, or what it warned about. */
  notes: string[];
}

export interface DiscoverOptions {
  exclude?: readonly string[];
  /** The engine Terragrunt calls (`TG_TF_PATH`). */
  binary?: string;
  /** The `terragrunt` executable. Default: `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragrunt?: string;
  exec?: TerragruntExec;
}

/** The units by a file walk: every directory holding a `terragrunt.hcl`, less the excludes. No edges. */
export function walkUnits(repo: string, exclude: readonly string[] = []): TerragruntUnit[] {
  const globs = [...TERRAGRUNT_DISCOVERY_EXCLUDES, ...exclude];
  const out: TerragruntUnit[] = [];
  walk(repo, (dir, names) => {
    const rel = posix(relative(repo, dir));
    if (!rel || !names.includes("terragrunt.hcl")) return;
    if (globs.some((g) => matchesUnitGlob(rel, g.replace(/\/\*\*$/, "")) || matchesUnitGlob(rel, g))) return;
    out.push({ path: rel, dependencies: [] });
  });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The repo's units, from `terragrunt find` when Terragrunt 1.1 or later is
 * on the path, and from a file walk when it is not.
 */
export async function discoverUnits(repo: string, options: DiscoverOptions = {}): Promise<UnitDiscovery> {
  const terragrunt = options.terragrunt ?? process.env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const run = { dir: repo, terragrunt, ...(options.binary ? { binary: options.binary } : {}), ...(options.exec ? { exec: options.exec } : {}) };
  let fallback: string;
  try {
    await checkTerragruntVersion(run);
    const found = await discoverTerragruntUnits({ ...run, ...(options.exclude ? { exclude: options.exclude } : {}) });
    return { units: found.units, source: "terragrunt find", notes: found.warnings };
  } catch (e) {
    fallback = (e as Error).message;
  }
  return {
    units: walkUnits(repo, options.exclude),
    source: "terragrunt.hcl files",
    notes: [`units come from terragrunt.hcl files, with no dependency edges, because Terragrunt discovery did not run: ${fallback.split("\n")[0]}`],
  };
}

/**
 * The waves a pipeline runs, one `terragrunt run --all` each: the canary
 * units first, then the rest. Terragrunt orders the units inside a run by
 * its graph. A canary that depends on a unit outside the canary wave is refused.
 */
export function unitWaves(units: readonly TerragruntUnit[], canary: readonly string[] = []): string[][] {
  terragruntWaves(units, { canary }); // throws on a canary that reads a later unit, or a cycle
  const isCanary = (p: string): boolean => canary.some((g) => matchesUnitGlob(p, g));
  const first = units.filter((u) => isCanary(u.path)).map((u) => u.path);
  const rest = units.filter((u) => !isCanary(u.path)).map((u) => u.path);
  return [first, rest].filter((w) => w.length > 0);
}

export { stackOfUnit };

/** The state backend `root.hcl` configures, when it names one. */
export function stateBackend(repo: string): { backend: string; gitlab: boolean } | undefined {
  const file = join(repo, "root.hcl");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
  const block = /\bremote_state\s*\{[\s\S]*?\bbackend\s*=\s*"([^"]+)"/.exec(text);
  if (!block) return undefined;
  return { backend: block[1], gitlab: block[1] === "http" && /\/api\/v4\/projects\/[^"]*\/terraform\/state\//.test(text) };
}

/**
 * How many units a `run --all` runs at once: the setting, else from the state
 * backend. GitLab-managed state rate-limits concurrent inits, so it gets 3;
 * every other backend gets 16.
 */
export function parallelism(repo: string, settings: TerragruntSettings = {}): { value: number; reason: string } {
  if (settings.parallelism !== undefined) return { value: settings.parallelism, reason: "terragucci.yml" };
  const backend = stateBackend(repo);
  if (backend?.gitlab) return { value: 3, reason: "GitLab-managed state rate-limits concurrent inits" };
  return { value: 16, reason: backend ? `the ${backend.backend} backend` : "the default" };
}

/** The exact Terragrunt version `root.hcl` pins with `terragrunt_version_constraint = "= x.y.z"`. */
export function pinnedTerragrunt(repo: string): string | undefined {
  const file = join(repo, "root.hcl");
  if (!existsSync(file)) return undefined;
  return /terragrunt_version_constraint\s*=\s*"\s*=?\s*(\d+\.\d+\.\d+)\s*"/.exec(readFileSync(file, "utf-8"))?.[1];
}

// ── the auth provider ────────────────────────────────────────────────────────

/** The environment variable that carries a job's role map to the auth provider. */
export const ROLES_ENV = "TERRAGUCCI_TG_ROLES";

/** One phase's roles by unit glob, in the order the config lists them, as the job's env carries them. */
export function rolesFor(credentials: Record<string, RolePair>, phase: "plan" | "apply"): [string, string][] {
  return Object.entries(credentials).map(([glob, pair]) => [glob, pair[phase]]);
}

/** Whether a unit sets its own `iam_role`: in its `terragrunt.hcl`, or an `.hcl` file in a directory above it. */
export function unitSetsRole(repoDir: string, unitDir: string): boolean {
  const sets = (f: string): boolean => {
    try {
      return /^\s*iam_role\s*=/m.test(readFileSync(f, "utf-8"));
    } catch {
      return false;
    }
  };
  if (sets(join(unitDir, "terragrunt.hcl"))) return true;
  const top = resolve(repoDir);
  for (let d = dirname(resolve(unitDir)); d.startsWith(top); d = dirname(d)) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      /* unreadable */
    }
    if (names.some((n) => n.endsWith(".hcl") && n !== "terragrunt.hcl" && n !== ".terraform.lock.hcl" && sets(join(d, n)))) return true;
    if (d === top) break;
  }
  return false;
}

/**
 * What `terragucci auth-provider` prints for the unit Terragrunt runs it in
 * (its working directory): the role for the first glob that matches the
 * unit, with the job's OIDC token, as Terragrunt's `awsRole`. A unit that
 * sets its own `iam_role`, or matches no glob, gets no role, so its own
 * configuration and the job's credentials stand.
 */
export function authProviderOutput(unitDir: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const repo = env.TERRAGUCCI_REPO ?? process.cwd();
  const unit = posix(relative(repo, unitDir));
  let roles: [string, string][];
  try {
    roles = JSON.parse(env[ROLES_ENV] ?? "[]") as [string, string][];
  } catch {
    throw new ConfigError(`${ROLES_ENV} is not JSON`);
  }
  if (unitSetsRole(repo, unitDir)) return {};
  const hit = roles.find(([glob]) => matchesUnitGlob(unit, glob));
  if (!hit) return {};
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  if (!tokenFile || !existsSync(tokenFile)) throw new ConfigError(`${unit} needs ${hit[1]}, but the job has no OIDC token file`);
  return {
    awsRole: {
      roleARN: hit[1],
      roleSessionName: `terragucci-${env.TERRAGUCCI_PHASE ?? "run"}`,
      webIdentityToken: readFileSync(tokenFile, "utf-8").trim(),
    },
  };
}
