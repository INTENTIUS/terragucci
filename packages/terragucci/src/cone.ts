/**
 * choudoufu's cone plans: `plan -cone=<base>` plans only the blocks a
 * change touches and every block that reads them.
 *
 * A pull request's plan of a root under a `live` block passes the pull
 * request's base (`origin/<target branch>`). So does a wave that applies an
 * open pull request (`apply.when: pull-request`, `--base`). A wave that
 * applies a merge commit and a drift run plan the whole estate, as does a
 * root with no `live` block, an estate file (`estate.chdf.hcl`), whose form
 * choudoufu refuses `-cone` on, and any binary but choudoufu.
 *
 * choudoufu's guard can plan the whole estate anyway: no base, a provider,
 * terraform or live block or the lock file changed, a refactor no block
 * declares, a cone over 30% of the estate's blocks, a marked object outside
 * it, or `-estate-outputs-from`. It says why in a warning, and the plan note
 * shows the reason. A cone plan says its size in a warning too, and with
 * `-out FILE` writes `FILE.cone.json`: the cone's base, the commit it named
 * and the addresses it targets.
 *
 * The record's targets join the root's plan digest (`conePlanDigest`), so the
 * digest an approval binds names the cone. A wave that plans again after its
 * approval and finds another cone has another digest, and refuses as a
 * changed wave. choudoufu's `apply FILE` checks the same record again.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { liveRoots } from "./detect";
import type { ReportCone } from "./report/schema";

/** The flags choudoufu refuses beside `-cone`, or plans in full with: a plan that carries one gets no `-cone`. */
export const CONE_EXCLUDES = ["-target", "-exclude", "-destroy", "-refresh-only", "-json", "-estate"] as const;

/** What choudoufu writes beside a saved cone plan, `FILE.cone.json`. */
export interface ConeRecord {
  base: string;
  base_sha: string;
  targets: string[];
}

/** What one root's cone plan did: planned the cone, or planned the whole estate for the guard's reason. */
export interface PlanCone {
  /** The revision the plan was asked to measure the change from. */
  base: string;
  /** With a cone: its blocks, and the estate's, as choudoufu counted them. Absent when it did not say. */
  blocks?: number;
  of?: number;
  /** With a cone: the record beside the plan file. */
  record?: ConeRecord;
  /** The guard planned the whole estate: its kind and why. */
  fallback?: { kind: string; reason: string };
}

/** Whether `binary` (a name or a path) is choudoufu. */
export const isChoudoufu = (binary: string): boolean => basename(binary) === "choudoufu";

/** Whether a root takes `-cone`: under a `live` block, and not an estate file, whose form refuses it. */
export function coneRoot(repo: string, root: string): boolean {
  return !existsSync(join(repo, root, "estate.chdf.hcl")) && liveRoots(repo, [root]).length === 1;
}

/**
 * The `-cone` argument a plan takes: `-cone=<base>` for choudoufu with a
 * base, on a root `coneRoot` admits, when none of `args` is a flag in
 * CONE_EXCLUDES. Otherwise none, and the plan is full.
 */
export function coneArgs(binary: string, base: string | undefined, args: readonly string[], cone: boolean): string[] {
  if (!base || !cone || !isChoudoufu(binary)) return [];
  const excluded = args.some((a) => CONE_EXCLUDES.some((f) => a === f || a.startsWith(`${f}=`)));
  return excluded ? [] : [`-cone=${base}`];
}

/** The path of the cone record beside a plan file. */
export const coneRecordPath = (planFile: string): string => `${planFile}.cone.json`;

/** The cone record beside `planFile`, or none when there is none or it does not read as one. */
export function readConeRecord(planFile: string): ConeRecord | undefined {
  const path = coneRecordPath(planFile);
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, "utf-8")) as Partial<ConeRecord> | null;
    if (!r || typeof r.base !== "string" || !Array.isArray(r.targets) || !r.targets.every((t) => typeof t === "string")) return undefined;
    return { base: r.base, base_sha: typeof r.base_sha === "string" ? r.base_sha : "", targets: [...r.targets].sort() };
  } catch {
    return undefined;
  }
}

/**
 * The detail of the last warning with this summary in a plan's output, its
 * lines joined. The binary prints a warning as `Warning: <summary>`, a blank
 * line, and the detail wrapped to the terminal's width up to the next blank
 * line; a box drawn around it with colour on is stripped.
 */
function warningDetail(text: string, summary: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/^[\s│╷╵]*/, "").trimEnd());
  let found: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== `Warning: ${summary}`) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] === "") j++;
    const detail: string[] = [];
    for (; j < lines.length && lines[j] !== ""; j++) detail.push(lines[j]);
    found = detail.join(" ").replace(/\s+/g, " ").trim();
  }
  return found;
}

/**
 * What a plan run with `-cone=<base>` did, from its output and the record
 * beside `planFile`. A fallback warning means the whole estate was planned,
 * even after a cone warning (the sweep's half of the guard trips once the
 * plan has begun). With no fallback, the record is the cone. With neither,
 * choudoufu said nothing this reads, and the plan counts as full.
 */
export function readPlanCone(output: string, planFile: string, base: string): PlanCone {
  const fell = warningDetail(output, "Cone plan fell back to a full plan");
  if (fell !== undefined) {
    const m = /^This plan covers the whole estate \(guard ([^)]*)\): (.*?)\.?$/.exec(fell);
    return { base, fallback: m ? { kind: m[1], reason: m[2] } : { kind: "unknown", reason: fell } };
  }
  const record = readConeRecord(planFile);
  if (!record) return { base, fallback: { kind: "unknown", reason: "choudoufu wrote no cone record beside the plan" } };
  const size = /: (\d+) of the estate's (\d+) blocks/.exec(warningDetail(output, "Cone plan") ?? "");
  return { base, ...(size ? { blocks: Number(size[1]), of: Number(size[2]) } : {}), record };
}

/** What a cone plan did, in words: its size, or why it planned the whole estate. */
export function coneText(cone: PlanCone): string {
  if (cone.fallback) return `the whole estate, since ${cone.fallback.reason} (guard ${cone.fallback.kind})`;
  const n = cone.record?.targets.length ?? 0;
  const size = cone.blocks !== undefined && cone.of !== undefined ? `${cone.blocks} of the estate's ${cone.of} blocks` : `${n} target${n === 1 ? "" : "s"}`;
  return `the cone of the change since ${cone.base}, ${size}`;
}

/** A root's cone as report.json keeps it: the counts, never the addresses. */
export function reportCone(cone: PlanCone): ReportCone {
  if (cone.fallback) return { base: cone.base, fallback: cone.fallback };
  return {
    base: cone.base,
    ...(cone.blocks !== undefined && cone.of !== undefined ? { blocks: cone.blocks, of: cone.of } : {}),
    ...(cone.record ? { targets: cone.record.targets.length } : {}),
  };
}

/** The log's line for a root's cone plan. */
export const coneLogLine = (root: string, cone: PlanCone): string => `${root}: planned ${coneText(cone)}`;

/**
 * A root's plan digest with its cone in it:the plan's own digest, unchanged,
 * when the plan was full; with a cone, the digest over the plan's digest and
 * the cone's targets, so an approval of one cone counts for no other.
 */
export function conePlanDigest(planDigest: string, cone: PlanCone | undefined): string {
  if (!cone?.record) return planDigest;
  return computePlanDigest("terragucci-cone-plan", { plan: planDigest, targets: [...cone.record.targets].sort() });
}
