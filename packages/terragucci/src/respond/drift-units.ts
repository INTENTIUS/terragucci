/**
 * Drift codified for a Terragrunt repo's units. A unit's resources are
 * usually in the module its `terraform.source` names, and the values that
 * differ between units are its `inputs`. A drifted attribute the module sets
 * with `var.<name>` is brought in line in the unit's own `terragrunt.hcl`,
 * when its `inputs` block sets `<name>` to a literal: the live value is
 * written there, so only that unit changes. An attribute the module sets as
 * a literal is left, with why: every unit that calls the module shares it. A
 * unit with no `terraform.source` is its own root, codified as a plain root
 * is. A unit an explicit stack generates is left, naming its stack file: its
 * `terragrunt.hcl` is written by `terragrunt stack generate`, not kept in git.
 *
 * Each unit is planned again with `-refresh-only` through `terragrunt run`,
 * since the stage's plan files are gone and its report's plan is redacted.
 * Only the units the stage's report shows drifted are planned, or every
 * unit when there is no report.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { terragruntExec } from "../binary-env";
import { ConfigError } from "../config";
import { globMatch } from "../detect";
import { discoverUnits } from "../terragrunt";
import { STACK_UNIT_DRIFT_PR } from "../refusals";
import { codify, driftOf, hcl, literal, type Codified, type Drifted, type Left } from "./drift";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const tail = (s: string, n = 20): string => s.trim().split("\n").slice(-n).join("\n");

export interface UnitRunner {
  terragrunt: string;
  binary: string;
  exec: TerragruntExec;
  env: NodeJS.ProcessEnv;
}

export function unitRunner(binary: string, env: NodeJS.ProcessEnv, o: { terragrunt?: string; exec?: TerragruntExec } = {}): UnitRunner {
  return { terragrunt: o.terragrunt ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt", binary, exec: o.exec ?? terragruntExec, env };
}

/** `terragrunt run` in one unit, the binary's arguments after `--`. Throws with the tail of the log when it fails. */
async function runIn(r: UnitRunner, repo: string, unit: string, args: string[], what: string): Promise<string> {
  const out = await r.exec(r.terragrunt, ["run", "--non-interactive", "--no-color", "--working-dir", unit, "--", ...args], {
    cwd: repo,
    env: { TG_TF_PATH: r.binary, TG_NON_INTERACTIVE: "true" },
  });
  if (out.code !== 0) throw new ConfigError(`${unit}: ${what} failed:\n${tail(out.stderr || out.stdout)}`);
  return out.stdout;
}

/** The units a drift response looks at: those the stage's report shows drifted, else every unit discovery finds. */
export async function driftedUnits(repo: string, r: UnitRunner, o: { report?: string; root?: string; exclude?: string[] } = {}): Promise<{ units: string[]; from: string }> {
  const file = resolve(repo, o.report ?? "terragucci-report", "report.json");
  let units: string[];
  let from: string;
  if (existsSync(file)) {
    const report = JSON.parse(readFileSync(file, "utf-8")) as { run?: { stage?: string }; roots?: { path: string; changes?: unknown[] }[] };
    if (report.run?.stage !== "tf-drift") throw new ConfigError(`${relative(repo, file)} is not a tf-drift report; run terragucci stage tf-drift first, or move it aside to check every unit`);
    units = (report.roots ?? []).filter((x) => (x.changes ?? []).length > 0).map((x) => x.path);
    from = "the drift report";
  } else {
    const found = await discoverUnits(repo, { binary: r.binary, terragrunt: r.terragrunt, exec: r.exec, ...(o.exclude ? { exclude: o.exclude } : {}) });
    units = found.units.map((u) => u.path);
    from = "discovery";
  }
  return { units: units.filter((u) => !o.root || globMatch(o.root, u)).sort(), from };
}

/** A unit's refresh-only plan, through Terragrunt: what drifted in it. */
export async function unitDrift(repo: string, unit: string, r: UnitRunner): Promise<Drifted[]> {
  const work = mkdtempSync(join(tmpdir(), "terragucci-drift-"));
  const planFile = join(work, "drift.tfplan");
  try {
    await runIn(r, repo, unit, ["plan", "-refresh-only", "-input=false", "-lock=false", "-no-color", `-out=${planFile}`], "the refresh-only plan");
    const text = await runIn(r, repo, unit, ["show", "-json", planFile], "show -json");
    try {
      return driftOf(JSON.parse(text));
    } catch {
      throw new ConfigError(`${unit}: show -json printed no plan`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A unit's evaluated `terraform.source`, from `terragrunt render --json`; undefined when it names none. */
export async function unitSource(repo: string, unit: string, r: UnitRunner): Promise<string | undefined> {
  const out = await r.exec(r.terragrunt, ["render", "--json", "--non-interactive", "--no-color", "--working-dir", unit], { cwd: repo, env: { TG_TF_PATH: r.binary, TG_NON_INTERACTIVE: "true" } });
  if (out.code !== 0) throw new ConfigError(`${unit}: terragrunt render failed:\n${tail(out.stderr || out.stdout)}`);
  let rendered: { terraform?: { source?: unknown } | null };
  try {
    rendered = JSON.parse(out.stdout);
  } catch {
    throw new ConfigError(`${unit}: terragrunt render printed no JSON`);
  }
  const s = rendered.terraform?.source;
  return typeof s === "string" && s ? s : undefined;
}

/**
 * The directory a local `terraform.source` names, relative to the repo, or
 * undefined for a source outside it (git, a registry, a URL). `a//b` is the
 * module `b` under `a`.
 */
export function localModule(repo: string, unit: string, source: string): string | undefined {
  if (/^[a-z0-9]+::/i.test(source) || /^[a-z]+:\/\//i.test(source) || /^(github\.com|bitbucket\.org|tfr:)/.test(source)) return undefined;
  const plain = source.split("?")[0].replace(/\/\/+/, "/");
  const abs = isAbsolute(plain) ? plain : resolve(repo, unit, plain);
  const rel = relative(resolve(repo), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return posix.normalize(rel.split("\\").join("/"));
}

function tfFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tf") || f.endsWith(".tofu")).sort() : [];
}

const stripStrings = (l: string): string => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/(#|\/\/).*$/, "");

/** The body line range of a `resource "type" "name"` block in a file's lines. */
function resourceBlock(lines: string[], type: string, name: string): [number, number] | undefined {
  const head = new RegExp(`^\\s*resource\\s+"${type}"\\s+"${name}"\\s*\\{`);
  return blockAt(lines, lines.findIndex((l) => head.test(l)));
}

function blockAt(lines: string[], start: number): [number, number] | undefined {
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of stripStrings(lines[i]!)) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
    if (depth === 0) return [start, i];
  }
  return undefined;
}

/** The line in a block's body, at its top level, that sets `key`; -1 when none does. */
function keyLine(lines: string[], [start, end]: [number, number], key: string): number {
  let depth = 0;
  for (let i = start + 1; i < end; i++) {
    if (depth === 0 && new RegExp(`^\\s*"?${key}"?\\s*=`).test(lines[i]!)) return i;
    for (const ch of stripStrings(lines[i]!)) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
  }
  return -1;
}

const ASSIGN = /^(\s*"?[\w-]+"?\s*=\s*)(.*?)(\s*(?:#.*|\/\/.*)?)$/;

/**
 * Write each live value where a unit can take it: the `inputs` entry of the
 * unit's `terragrunt.hcl` that the module's `var.<name>` reads. `files` maps
 * repo-relative paths to their text and is edited in place.
 */
export function codifyUnit(repo: string, unit: string, moduleDir: string, drifted: Drifted[], files = new Map<string, string>()): { codified: Codified[]; left: Left[]; files: Map<string, string> } {
  const codified: Codified[] = [];
  const left: Left[] = [];
  const unitFile = posix.join(unit, "terragrunt.hcl");
  const read = (f: string): string => files.get(f) ?? readFileSync(join(repo, f), "utf-8");
  for (const d of drifted) {
    const leave = (reason: string, path?: string): void => {
      left.push({ root: unit, address: d.address, ...(path ? { path } : {}), reason });
    };
    if (d.action === "delete") {
      leave("deleted outside Terraform; the next apply makes it again, or remove it from the code if that was the intent");
      continue;
    }
    if (d.module) {
      leave(`reached through ${d.module}; the value is set in a module the unit's module calls`);
      continue;
    }
    if (d.index !== undefined) {
      leave("an instance of count or for_each; one value sets every instance");
      continue;
    }
    const file = tfFiles(join(repo, moduleDir)).find((f) => resourceBlock(read(posix.join(moduleDir, f)).split("\n"), d.type, d.name));
    if (!file) {
      leave(`its resource block is not in ${moduleDir}`);
      continue;
    }
    const modLines = read(posix.join(moduleDir, file)).split("\n");
    const block = resourceBlock(modLines, d.type, d.name)!;
    for (const a of d.attributes) {
      const at = keyLine(modLines, block, a.path);
      if (at < 0) {
        leave(`not set in ${moduleDir}'s block; it comes from a default or the provider`, a.path);
        continue;
      }
      const expr = ASSIGN.exec(modLines[at]!)![2]!.trim();
      if (literal(expr)) {
        leave(`set as a literal in ${moduleDir}, which every unit calling it shares; change it there if every unit should take the live value`, a.path);
        continue;
      }
      const v = /^var\.([A-Za-z_][\w-]*)$/.exec(expr);
      if (!v) {
        leave(`set from an expression in ${moduleDir} (${expr})`, a.path);
        continue;
      }
      const lines = read(unitFile).split("\n");
      const inputs = blockAt(lines, lines.findIndex((l) => /^inputs\s*=\s*\{/.test(l)));
      const line = inputs ? keyLine(lines, inputs, v[1]!) : -1;
      if (line < 0) {
        leave(`${moduleDir} reads var.${v[1]}, which ${unitFile}'s inputs do not set; it comes from a default or a file the unit includes`, a.path);
        continue;
      }
      const m = ASSIGN.exec(lines[line]!)!;
      const lit = literal(m[2]!);
      if (!lit) {
        leave(`the input ${v[1]} is set from an expression (${m[2]!.trim()})`, a.path);
        continue;
      }
      if (!same(lit.value, a.before)) {
        leave(`the input ${v[1]} is not the value last applied, so the code moved too`, a.path);
        continue;
      }
      const to = hcl(a.live);
      if (to === undefined) {
        leave("its live value is a list, a map or null", a.path);
        continue;
      }
      lines[line] = `${m[1]}${to}${m[3]}`;
      files.set(unitFile, lines.join("\n"));
      codified.push({ root: unit, address: d.address, path: a.path, file: unitFile, from: m[2]!.trim(), to });
    }
  }
  return { codified, left, files };
}

/**
 * Codify one unit's drift: in its `inputs` when it calls a module in the
 * repo, in its own files when it names no source, and left with why when its
 * module is outside the repo.
 */
export async function codifyUnitDrift(repo: string, unit: string, drifted: Drifted[], r: UnitRunner, files: Map<string, string>, editAt = unit): Promise<{ codified: Codified[]; left: Left[] }> {
  // Where the shape says an edit to the unit belongs (Shape.sourceOf): a stack file, for a unit an explicit stack generates.
  if (editAt !== unit) {
    return { codified: [], left: drifted.map((d) => ({ root: unit, address: d.address, reason: `${editAt} ${STACK_UNIT_DRIFT_PR}` })) };
  }
  const source = await unitSource(repo, unit, r);
  if (!source) {
    const local = new Map<string, string>();
    const c = codify(unit, join(repo, unit), drifted, local);
    for (const [f, text] of local) files.set(posix.join(unit, f), text);
    return { codified: c.codified, left: c.left };
  }
  const moduleDir = localModule(repo, unit, source);
  if (!moduleDir) {
    return { codified: [], left: drifted.map((d) => ({ root: unit, address: d.address, reason: `its module is outside the repo (${source}), so there is no code here to change` })) };
  }
  const c = codifyUnit(repo, unit, moduleDir, drifted, files);
  return { codified: c.codified, left: c.left };
}
