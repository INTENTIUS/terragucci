/**
 * Terragrunt mode: how terragucci tells a Terragrunt repo, finds its units,
 * and picks the settings its pipeline runs with.
 *
 * A Terragrunt unit is a root. Units and their edges come from Terragrunt's
 * own discovery (`terragrunt find`, through chant's runner), so terragucci
 * never evaluates Terragrunt's HCL to learn the graph. When `terragrunt` is
 * not on the path (`init` on a laptop), the units are the directories holding
 * a `terragrunt.hcl`, with the edges their `dependency` and `dependencies`
 * blocks name as plain strings. That cut only sizes the pipeline: the apply
 * jobs run in the Terragrunt image and take the waves from `terragrunt find`.
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
import { terragruntExec } from "./binary-env";
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

/** The body of each top-level `<keyword> ... {` block in HCL text, braces matched, strings and comments skipped. */
function blocks(text: string, keyword: string): string[] {
  const out: string[] = [];
  const head = new RegExp(`^\\s*${keyword}\\b[^{\\n]*\\{`, "gm");
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (let quoted = false; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.push(text.slice(start, i - 1));
    head.lastIndex = i;
  }
  return out;
}

/**
 * The paths a unit's `terragrunt.hcl` names in its `dependency` blocks'
 * `config_path` and its `dependencies` block's `paths`, when each is a plain
 * string. A path built with a function or an interpolation is not read: only
 * Terragrunt can evaluate it.
 */
export function literalDependencies(text: string): string[] {
  const clean = text.replace(/(^|[^:"$])(#|\/\/).*$/gm, "$1");
  const plain = /^"([^"$]*)"$/;
  const out: string[] = [];
  for (const b of blocks(clean, "dependency")) {
    const m = /^\s*config_path\s*=\s*("[^"\n]*")\s*$/m.exec(b);
    const p = m && plain.exec(m[1]);
    if (p) out.push(p[1]);
  }
  for (const b of blocks(clean, "dependencies")) {
    const m = /\bpaths\s*=\s*\[([^\]]*)\]/.exec(b);
    for (const item of m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : []) {
      const p = plain.exec(item);
      if (p) out.push(p[1]);
    }
  }
  return out;
}

/**
 * The units by a file walk: every directory holding a `terragrunt.hcl`, less
 * the excludes, each with the units its plain-string dependency paths name.
 */
export function walkUnits(repo: string, exclude: readonly string[] = []): TerragruntUnit[] {
  const globs = [...TERRAGRUNT_DISCOVERY_EXCLUDES, ...exclude];
  const out: TerragruntUnit[] = [];
  walk(repo, (dir, names) => {
    const rel = posix(relative(repo, dir));
    if (!rel || !names.includes("terragrunt.hcl")) return;
    if (globs.some((g) => matchesUnitGlob(rel, g))) return;
    let text = "";
    try {
      text = readFileSync(join(dir, "terragrunt.hcl"), "utf-8");
    } catch {
      /* unreadable: no edges */
    }
    const deps = literalDependencies(text).map((p) => posix(relative(repo, resolve(dir, p))));
    out.push({ path: rel, dependencies: [...new Set(deps)].sort() });
  });
  const paths = new Set(out.map((u) => u.path));
  // An edge to a directory that is not a unit (excluded, or outside the repo) holds nothing back.
  for (const u of out) u.dependencies = u.dependencies.filter((d) => paths.has(d));
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Generate the units of the repo's explicit stacks (`terragrunt.stack.hcl`)
 * with `terragrunt stack generate`, so discovery and the waves see them under
 * each stack's `.terragrunt-stack/`. Nothing to do in a repo with no stack.
 * Only Terragrunt can generate a stack's units, so a repo with stacks needs
 * Terragrunt 1.1 or later: without it this throws, rather than leave the
 * stacks' units out.
 */
export async function generateStacks(repo: string, options: { terragrunt?: string; binary?: string; exec?: TerragruntExec } = {}): Promise<string[]> {
  const stacks = detectTerragrunt(repo)?.stacks ?? [];
  if (stacks.length === 0) return [];
  const terragrunt = options.terragrunt ?? process.env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const exec = options.exec ?? terragruntExec;
  const run = { dir: repo, terragrunt, ...(options.binary ? { binary: options.binary } : {}), exec };
  try {
    await checkTerragruntVersion(run);
  } catch (e) {
    throw new ConfigError(`${stacks.map((d) => (d === "." ? "terragrunt.stack.hcl" : `${d}/terragrunt.stack.hcl`)).join(", ")}: an explicit stack's units are generated by terragrunt stack generate, and Terragrunt did not run (${(e as Error).message.split("\n")[0]}); put Terragrunt 1.1 or later on the path, or set TERRAGUCCI_TERRAGRUNT`);
  }
  const out = await exec(terragrunt, ["stack", "generate", "--non-interactive", "--no-color"], { cwd: repo, env: { TG_NON_INTERACTIVE: "true", ...(options.binary ? { TG_TF_PATH: options.binary } : {}) } });
  if (out.code !== 0) throw new ConfigError(`terragrunt stack generate failed (exit ${out.code}):\n${(out.stderr || out.stdout).trim().split("\n").slice(-20).join("\n")}`);
  return stacks;
}

/**
 * The repo's units, from `terragrunt find` when Terragrunt 1.1 or later is
 * on the path, and from a file walk when it is not. Explicit stacks are
 * generated first (generateStacks), so their units are found too.
 */
export async function discoverUnits(repo: string, options: DiscoverOptions = {}): Promise<UnitDiscovery> {
  const terragrunt = options.terragrunt ?? process.env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const run = { dir: repo, terragrunt, ...(options.binary ? { binary: options.binary } : {}), exec: options.exec ?? terragruntExec };
  await generateStacks(repo, run);
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
    notes: [`units and their edges come from terragrunt.hcl files: Terragrunt discovery did not run (${fallback.split("\n")[0]}), so a dependency path built with a function is not followed; the apply jobs take the waves from terragrunt find`],
  };
}

/**
 * The waves a Terragrunt repo applies in, one `terragrunt run --all` each:
 * the dependency layers of the canary units, then the layers of the rest.
 * No unit of a wave reads another unit of it, so every wave plans against
 * what the waves before it applied. Each wave is sorted by path. A canary
 * that depends on a unit outside the canaries is refused, and so is a cycle.
 */
export function unitWaves(units: readonly TerragruntUnit[], canary: readonly string[] = []): string[][] {
  return terragruntWaves(units, { canary }).filter((w) => w.length > 0);
}

/**
 * The waves a pipeline lists, cut again by the edges `terragrunt find` gives
 * now: each listed wave split into its own dependency layers, the listed
 * order kept, so the canary waves stay first. A pipeline written with the
 * edges (by init, from discovery or the files) comes back as it is. A unit
 * that reads a unit of a later listed wave is refused: the list is stale, and
 * init cuts it again. Units the pipeline does not list stay out.
 */
export function refineWaves(listed: readonly (readonly string[])[], units: readonly TerragruntUnit[]): string[][] {
  const deps = new Map(units.map((u) => [u.path, u.dependencies]));
  const waveOf = new Map<string, number>();
  listed.forEach((w, i) => w.forEach((u) => waveOf.set(u, i)));
  const out: string[][] = [];
  listed.forEach((wave, i) => {
    const members = new Set(wave);
    for (const u of wave) {
      const later = (deps.get(u) ?? []).filter((d) => (waveOf.get(d) ?? -1) > i);
      if (later.length > 0) throw new ConfigError(`${u} reads ${later.join(", ")}, which the pipeline applies in a later wave; run terragucci init to cut the waves again`);
    }
    const sub = wave.map((path) => ({ path, dependencies: (deps.get(path) ?? []).filter((d) => members.has(d)) }));
    out.push(...terragruntWaves(sub).filter((w) => w.length > 0));
  });
  return out;
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
  const top = resolve(repoDir);
  const unit = resolve(unitDir);
  for (let d = unit; d.startsWith(top); d = dirname(d)) {
    // The unit's own config, and any other .hcl above it (root.hcl, env.hcl) it may include.
    const names = d === unit ? ["terragrunt.hcl"] : readdirSync(d).filter((n) => /^[^.].*\.hcl$/.test(n) && n !== "terragrunt.hcl");
    if (names.some((n) => sets(join(d, n)))) return true;
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
