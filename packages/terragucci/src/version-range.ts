/**
 * A root's `required_version` range against the version its job runs.
 *
 * `init` honours an exact `required_version` as a pin. A range (`~> 1.5.0`,
 * `>= 1.3, < 2.0`) pins nothing, so the root runs the job's version, and a
 * range that version falls outside makes `terraform init` fail in the job.
 * This reads each root's ranges and names the ones the job's version
 * breaks, with the version map entry that fixes it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_VERSIONS } from "./images";
import { pinnedTool, rootPin, VERSION_FILES, versionFileRelease, type PinnedTool } from "./pins";

type Version = [number, number, number];

function parseVersion(s: string): Version | undefined {
  const m = s.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** One clause of a constraint: `~> 1.5.0`, `>= 1.3`, `!= 1.4.1`, `1.2.3`. */
interface Clause {
  op: string;
  v: Version;
  /** Parts the clause wrote, which a `~>` range depends on. */
  parts: number;
}

function parseClause(text: string): Clause | undefined {
  const m = text.trim().match(/^(~>|>=|<=|!=|=|>|<)?\s*(\S+)$/);
  if (!m) return undefined;
  const v = parseVersion(m[2]);
  if (!v) return undefined;
  return { op: m[1] ?? "=", v, parts: m[2].replace(/-.*$/, "").split(".").length };
}

function holds(c: Clause, version: Version): boolean {
  const cmp = compare(version, c.v);
  switch (c.op) {
    case "=": return cmp === 0;
    case "!=": return cmp !== 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
    default: {
      // ~> keeps every part but the last fixed: ~> 1.5.0 is 1.5.x, ~> 1.5 is 1.x from 1.5.
      if (cmp < 0) return false;
      const fixed = Math.max(c.parts - 1, 1);
      for (let i = 0; i < fixed; i++) if (version[i] !== c.v[i]) return false;
      return true;
    }
  }
}

/** Whether `version` satisfies a comma-separated constraint; undefined when the constraint does not parse. */
export function satisfies(version: string, constraint: string): boolean | undefined {
  const v = parseVersion(version);
  const clauses = constraint.split(",").map(parseClause);
  if (!v || clauses.length === 0 || clauses.some((c) => !c)) return undefined;
  return clauses.every((c) => holds(c!, v));
}

/** The lowest release a constraint admits, when it names one a release can be: the floor of a `~>`, `>=` or `=` clause. */
function floor(constraint: string): string | undefined {
  for (const text of constraint.split(",")) {
    const c = parseClause(text);
    if (c && (c.op === "~>" || c.op === ">=" || c.op === "=")) return c.v.join(".");
  }
  return undefined;
}

/** Every `required_version` string in a root's Terraform files, one per distinct value. */
export function requiredVersionRanges(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".tf") || n.endsWith(".tofu"));
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (!statSync(p).isFile()) continue;
    const text = readFileSync(p, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
    for (const m of text.matchAll(/required_version\s*=\s*"([^"]*)"/g)) if (!out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

/** A root whose range excludes the version its job runs. */
export interface RangeConflict {
  root: string;
  range: string;
  /** The version the root would run. */
  version: string;
  /** What to put under `version` in terragucci.yml for this root. */
  fix: string;
}

/**
 * The roots whose `required_version` excludes the version they run: the
 * root's own pin when it has one, else `jobVersion`. A range that does not
 * parse is left alone. Nothing is fetched, so the fix names the lowest
 * release in the range for terraform (a release that exists) and the range
 * itself for tofu, whose releases start well above most ranges' floors.
 */
export function rangeConflicts(repo: string, roots: readonly string[], binary: string, settingsVersion: unknown, jobVersion: string): RangeConflict[] {
  const tool = pinnedTool(binary);
  if (!tool || !jobVersion) return [];
  const out: RangeConflict[] = [];
  for (const root of roots) {
    const dir = join(repo, root);
    const version = rootPin(repo, root, binary, settingsVersion)?.version ?? jobVersion;
    for (const range of requiredVersionRanges(dir)) {
      if (satisfies(version, range) !== false) continue;
      const lowest = tool === "terraform" ? floor(range) : undefined;
      out.push({ root, range, version, fix: lowest ? `version: { "${root}": "${lowest}" }` : `version: { "${root}": "<a ${tool} release inside ${range}>" }` });
    }
  }
  return out;
}

/** The version a job runs when no root pins one: `version` in terragucci.yml, the repo's version file, then the image's. */
export function jobVersionOf(repo: string, binary: string, settingsVersion: unknown): string {
  if (typeof settingsVersion === "string") return settingsVersion;
  const tool: PinnedTool | undefined = pinnedTool(binary);
  if (tool) {
    const file = join(repo, VERSION_FILES[tool]);
    const filed = existsSync(file) ? versionFileRelease(readFileSync(file, "utf-8")) : undefined;
    if (filed) return filed;
  }
  return (TOOL_VERSIONS as Record<string, string>)[binary] ?? "";
}

/** The note for a set of conflicts, one line per root. */
export function conflictNotes(conflicts: readonly RangeConflict[]): string[] {
  return conflicts.map((c) => `${c.root} requires ${c.range}, which excludes ${c.version}, the version its job runs; add ${c.fix} to terragucci.yml`);
}
