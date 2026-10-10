/**
 * The releases each Terragrunt unit runs. A unit may pin the binary
 * Terragrunt calls and the Terragrunt release itself:
 *
 *   binary      as a plain root pins it (pins.ts rootPin): terragucci.yml
 *               `version` as a map, its first glob the unit's path matches;
 *               a `.opentofu-version` or `.terraform-version` in the unit's
 *               directory; an exact `required_version` in its own .tf files
 *   Terragrunt  an exact `terragrunt_version_constraint` (`"= 1.1.5"`) in
 *               the unit's own `terragrunt.hcl`
 *
 * A unit with no pin runs the job's. Any other release is installed in the
 * job (`install`, checked against the release's SHA256SUMS) once per version,
 * and checked to say the version it was installed as.
 *
 * One `run --all` runs one Terragrunt with one `TG_TF_PATH`, so a wave whose
 * units pin different releases runs as one `run --all` per pair of releases
 * (planWaveGroups, applyWaveGroups), each in a directory of its own. The
 * units of a wave read none of each other, so splitting it changes nothing
 * but how many processes run it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTerragruntWave,
  planTerragruntWave,
  TerragruntMockRefusal,
  type TerragruntWaveApply,
  type TerragruntWavePlan,
  type TerragruntWaveRunInput,
} from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { binaryEnv } from "./binary-env";
import { ConfigError } from "./config";
import { assertLinux, install, type Tool } from "./install";
import { RootBinaries, type Installer } from "./pins";
import type { ReportRootBinary } from "./report/schema";

/** The Terragrunt release a unit's own `terragrunt.hcl` pins with an exact `terragrunt_version_constraint`. */
export function unitTerragruntPin(repo: string, unit: string): string | undefined {
  const file = join(repo, unit, "terragrunt.hcl");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
  return /^\s*terragrunt_version_constraint\s*=\s*"\s*=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*"/m.exec(text)?.[1];
}

/** `terragrunt --version` as a release: `terragrunt version v1.1.6` is 1.1.6. */
export function terragruntVersionOf(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const r = spawnSync(path, ["--version"], { encoding: "utf-8", env: binaryEnv(env) });
  return /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(`${r.stdout ?? ""}${r.stderr ?? ""}`)?.[1];
}

const jobInstall: Installer = async (tool, version) => {
  assertLinux();
  return install(tool, version);
};

/** What one unit runs: the paths Terragrunt and `TG_TF_PATH` take, and what the report says of them. */
export interface UnitTools {
  terragrunt: string;
  binary: string;
  report: ReportRootBinary;
}

export class UnitBinaries {
  private readonly roots: RootBinaries;
  private readonly tgInstalls = new Map<string, Promise<string>>();
  private carriedTg: { v?: string } | undefined;

  constructor(
    private readonly repo: string,
    binary: string,
    version: unknown,
    /** The job's Terragrunt. */
    readonly terragrunt: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly installer: Installer = jobInstall,
  ) {
    this.roots = new RootBinaries(repo, binary, version, env, installer);
  }

  get binary(): string {
    return this.roots.binary;
  }

  /** The job's Terragrunt release, asked once. */
  carriedTerragrunt(): string | undefined {
    this.carriedTg ??= { v: terragruntVersionOf(this.terragrunt, this.env) };
    return this.carriedTg.v;
  }

  /** Whether any of `units` pins a release of its own. Reads files only. */
  pinsAny(units: readonly string[]): boolean {
    return units.some((u) => this.roots.pin(u) !== undefined || unitTerragruntPin(this.repo, u) !== undefined);
  }

  private async terragruntFor(unit: string, version: string): Promise<string> {
    let dir = this.tgInstalls.get(version);
    if (!dir) {
      dir = this.installer("terragrunt" as Tool, version).then((d) => {
        const path = join(d, "terragrunt");
        const said = terragruntVersionOf(path, this.env);
        if (said !== version) throw new ConfigError(`the Terragrunt installed as ${version} says it is ${said ?? "no version"}`);
        return d;
      });
      this.tgInstalls.set(version, dir);
    }
    try {
      return join(await dir, "terragrunt");
    } catch (e) {
      throw new ConfigError(`${unit} pins Terragrunt ${version} (terragrunt_version_constraint), which was not installed: ${(e as Error).message}`);
    }
  }

  /** What `unit` runs, installing a pinned release the job does not carry. Throws ConfigError when an install fails. */
  async resolve(unit: string): Promise<UnitTools> {
    const bin = await this.roots.resolve(unit);
    const tgPin = unitTerragruntPin(this.repo, unit);
    const carried = this.carriedTerragrunt();
    const terragrunt = tgPin && tgPin !== carried ? await this.terragruntFor(unit, tgPin) : this.terragrunt;
    const tgVersion = tgPin ?? carried;
    return {
      terragrunt,
      binary: bin.path,
      report: {
        name: bin.name,
        ...(bin.version ? { version: bin.version } : {}),
        ...(bin.pin ? { pin: bin.pin } : {}),
        ...(tgVersion ? { terragrunt: { version: tgVersion, ...(tgPin ? { pin: "terragrunt_version_constraint" } : {}) } } : {}),
      },
    };
  }
}

/** A wave's units by the pair of releases they run, the job's own pair first. */
export interface UnitGroup {
  terragrunt: string;
  binary: string;
  units: string[];
  /** The group's work directory: the wave's for the first group, a sibling for each other. */
  workDir: string;
}

/**
 * Split a wave's units by what they run. With no pin, or every unit on the
 * job's releases, there is one group in `workDir` itself, so a wave with no
 * pin runs exactly as before. `tools` undefined means no unit pins anything.
 */
export function groupUnits(units: readonly string[], workDir: string, job: { terragrunt: string; binary: string }, tools?: Map<string, UnitTools>): UnitGroup[] {
  const groups: UnitGroup[] = [];
  const key = (t: { terragrunt: string; binary: string }): string => `${t.terragrunt}\u0000${t.binary}`;
  const byKey = new Map<string, UnitGroup>();
  const jobKey = key(job);
  for (const u of units) {
    const t = tools?.get(u) ?? job;
    const k = key(t);
    let g = byKey.get(k);
    if (!g) {
      g = { terragrunt: t.terragrunt, binary: t.binary, units: [], workDir: "" };
      byKey.set(k, g);
      groups.push(g);
    }
    g.units.push(u);
  }
  groups.sort((a, b) => (key(a) === jobKey ? -1 : key(b) === jobKey ? 1 : 0));
  groups.forEach((g, i) => (g.workDir = i === 0 ? workDir : `${workDir}-pinned-${i}`));
  return groups;
}

export type PlanWave = typeof planTerragruntWave;
export type ApplyWave = typeof applyTerragruntWave;

/**
 * Plan a wave as one `run --all` per group. A group whose units would read
 * mock_outputs is refused as a whole wave is: every group still plans, then
 * one TerragruntMockRefusal names every read. Parts and results come back in
 * the units' order; the code is the first that is neither 0 nor 2.
 */
export async function planWaveGroups(groups: UnitGroup[], input: Omit<TerragruntWaveRunInput, "units" | "workDir" | "binary" | "terragrunt">, plan: PlanWave = planTerragruntWave): Promise<TerragruntWavePlan> {
  const reads: TerragruntMockRefusal["reads"] = [];
  const out: TerragruntWavePlan = { parts: [], provisional: input.provisional === true, results: [], code: 0, log: "" };
  const codes: (number | null)[] = [];
  for (const g of groups) {
    let p: TerragruntWavePlan;
    try {
      p = await plan({ ...input, units: g.units, workDir: g.workDir, binary: g.binary, terragrunt: g.terragrunt });
    } catch (e) {
      if (e instanceof TerragruntMockRefusal && groups.length > 1) {
        reads.push(...e.reads);
        continue;
      }
      throw e;
    }
    out.parts.push(...p.parts);
    out.results.push(...p.results);
    out.log += p.log;
    codes.push(p.code);
  }
  if (reads.length > 0) throw new TerragruntMockRefusal(reads);
  out.code = codes.find((c) => c !== 0 && c !== 2) ?? (codes.includes(2) ? 2 : 0);
  return out;
}

/** Apply a planned wave's units group by group, each from its own saved plans. */
export async function applyWaveGroups(groups: UnitGroup[], units: readonly string[], input: Omit<TerragruntWaveRunInput, "units" | "workDir" | "binary" | "terragrunt">, apply: ApplyWave = applyTerragruntWave): Promise<TerragruntWaveApply> {
  const want = new Set(units);
  const out: TerragruntWaveApply = { results: [], code: 0, log: "" };
  for (const g of groups) {
    const mine = g.units.filter((u) => want.has(u));
    if (mine.length === 0) continue;
    const a = await apply({ ...input, units: mine, workDir: g.workDir, binary: g.binary, terragrunt: g.terragrunt });
    out.results.push(...a.results);
    out.log += a.log;
    if (out.code === 0) out.code = a.code;
  }
  return out;
}

/** The work directory of the group that planned `unit`. */
export function dirOf(groups: UnitGroup[], unit: string, fallback: string): string {
  return groups.find((g) => g.units.includes(unit))?.workDir ?? fallback;
}
