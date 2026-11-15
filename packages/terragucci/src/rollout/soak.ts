/**
 * `rollouts.soak`: a wave that applied waits before the next one opens, and
 * what must hold on its roots meanwhile.
 *
 * The wait is a fact read on the next run, like every other gate of a
 * rollout: the wave's pull request merged at some time, the soak is `after`
 * long, and a run that finds the time not yet up says when it will be and
 * opens nothing. No timer is hosted. Once the time is up the conditions are
 * read the same way:
 *
 * - drift: the project's open drift issue names none of the wave's roots;
 * - apply: the newest apply on the default branch did not fail on them;
 * - policy: no denial of them was recorded on the gate ledger since the wave
 *   merged.
 *
 * A person with write access skips the whole soak by commenting
 * `/terragucci skip-soak` on one of the wave's pull requests. The forge
 * records who and when, and the report names the comment's author.
 *
 * What a condition reads goes through `Health`, which a caller can replace, so
 * a test touches no forge and no ledger.
 */
import { execFileSync } from "node:child_process";
import { globMatch } from "../detect";
import { soakMs, type SoakCondition, type SoakOverride, type SoakSettings } from "../config";
import { appliedState, type CommitCheck, type RolloutForge } from "./forge";
import { namesOf } from "./releases";

/** The comment that skips a soak. */
export const SKIP_COMMAND = "/terragucci skip-soak";

/** The soak a rollout is under: the wait, and the conditions. */
export interface SoakRule {
  /** The duration as written (`24h`), for the pull request and the report. */
  after: string;
  afterMs: number;
  conditions: SoakCondition[];
}

/** The rule for a rollout: the soak's own `after` and `conditions`, then the first override whose glob names it. */
export function soakRuleFor(soak: SoakSettings | undefined, kind: "module" | "provider", name: string, aliases: string[] = []): SoakRule | undefined {
  if (!soak) return undefined;
  const names = [...new Set([...namesOf({ kind, name }), ...aliases])];
  const hit = (soak.overrides ?? []).find((o: SoakOverride) => {
    const glob = kind === "module" ? o.module : o.provider;
    return glob !== undefined && names.some((n) => globMatch(glob, n));
  });
  const after = hit?.after ?? soak.after;
  return { after, afterMs: soakMs(after) ?? 0, conditions: hit?.conditions ?? soak.conditions ?? [] };
}

/** One thing a condition found that holds the next wave. */
export interface Finding {
  condition: SoakCondition;
  project: string;
  roots: string[];
  detail: string;
}

/** What a health check reads: one project's roots in the wave that soaks, and when it merged. */
export interface HealthInput {
  /** The project, with the checkout of its default branch and its forge. */
  project: { key: string; dir: string; forge: RolloutForge };
  /** The user's repository, where the gate ledger is read. */
  repo: string;
  roots: string[];
  conditions: SoakCondition[];
  /** When the wave merged, in milliseconds. */
  since: number;
}

export type Health = (input: HealthInput) => Promise<Finding[]>;

/** The roots of a list a drift issue's body names, in code spans as terragucci writes them. */
export const driftRootsIn = (body: string, roots: string[]): string[] => roots.filter((r) => body.includes(`\`${r}\``));

/** Health read from the forge and the gate ledger. */
export const forgeHealth: Health = async ({ project, repo, roots, conditions, since }) => {
  const out: Finding[] = [];
  if (conditions.includes("drift") && project.forge.openDriftIssue) {
    const issue = await project.forge.openDriftIssue();
    const drifted = issue ? driftRootsIn(issue.body, roots) : [];
    if (issue && drifted.length > 0) out.push({ condition: "drift", project: project.key, roots: drifted, detail: `the drift issue ${issue.url} is open and names ${drifted.join(", ")}` });
  }
  if (conditions.includes("apply")) {
    let head: string | undefined;
    try {
      head = execFileSync("git", ["-C", project.dir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      head = undefined;
    }
    const checks: CommitCheck[] = head ? await project.forge.commitChecks(head) : [];
    const failed = roots.filter((r) => appliedState(checks, r) === "failure");
    if (failed.length > 0) out.push({ condition: "apply", project: project.key, roots: failed, detail: `the newest apply on the default branch failed for ${failed.join(", ")}` });
  }
  if (conditions.includes("policy")) {
    const { readLedger } = await import("../apply");
    const { OVERRIDE_LEDGER, recordedDenials } = await import("../override");
    const denied = recordedDenials(readLedger(repo, OVERRIDE_LEDGER)).filter((d) => roots.includes(d.gate) && Date.parse(d.timestamp) >= since);
    if (denied.length > 0) out.push({ condition: "policy", project: project.key, roots: denied.map((d) => d.gate), detail: `policy denied ${denied.map((d) => d.gate).join(", ")} since the wave merged${denied[0]!.rules?.length ? ` (${denied[0]!.rules.join(", ")})` : ""}` });
  }
  return out;
};

/** Where a rollout stands against its soak. */
export interface SoakStatus {
  /** The wave that soaks, the one before the wave that is waiting to open. */
  wave: number;
  after: string;
  conditions: SoakCondition[];
  /** When the soaked wave merged (ISO 8601): the last of its pull requests. */
  since?: string;
  /** When the soak is up (ISO 8601). */
  due?: string;
  /** `soaking`: the next wave is held. `passed`: the time and the conditions held. `skipped`: a person skipped it. */
  state: "soaking" | "passed" | "skipped";
  /** What the next wave waits for, in words. */
  waitingFor: string[];
  findings: Finding[];
  /** Who skipped it, and the comment. */
  skippedBy?: { by: string; url?: string };
}

export interface SoakWave {
  wave: number;
  /** The merge times of the wave's pull requests, by project. A missing one is a merge the forge gave no time for. */
  merged: { project: string; roots: string[]; branch: string; at?: string }[];
}

/**
 * Decide the soak of the wave that applied, at `now`. The wave's soak starts
 * at the last of its merges.
 */
export async function soakOf(
  rule: SoakRule,
  soaked: SoakWave,
  o: { now: number; projects: Map<string, { key: string; dir: string; forge: RolloutForge }>; repo: string; health: Health },
): Promise<SoakStatus> {
  const base = { wave: soaked.wave, after: rule.after, conditions: rule.conditions, findings: [] as Finding[] };
  // A skip is one person's comment on any pull request of the wave.
  for (const m of soaked.merged) {
    const skips = (await o.projects.get(m.project)?.forge.soakSkips?.(m.branch)) ?? [];
    if (skips[0]) return { ...base, state: "skipped", waitingFor: [], skippedBy: { by: skips[0].by, ...(skips[0].url ? { url: skips[0].url } : {}) } };
  }
  const unknown = soaked.merged.filter((m) => m.at === undefined || Number.isNaN(Date.parse(m.at)));
  if (unknown.length > 0) {
    return { ...base, state: "soaking", waitingFor: [`the forge gave no merge time for wave ${soaked.wave}'s pull request in ${unknown.map((m) => m.project).join(", ")}, so its soak cannot be counted; a person can skip it with ${SKIP_COMMAND}`] };
  }
  const since = Math.max(...soaked.merged.map((m) => Date.parse(m.at!)));
  const due = since + rule.afterMs;
  const times = { since: new Date(since).toISOString(), due: new Date(due).toISOString() };
  if (o.now < due) return { ...base, ...times, state: "soaking", waitingFor: [`${rule.after} to pass since wave ${soaked.wave} merged, until ${times.due}`] };
  if (rule.conditions.length === 0) return { ...base, ...times, state: "passed", waitingFor: [] };
  const findings: Finding[] = [];
  for (const m of soaked.merged) {
    const project = o.projects.get(m.project);
    if (project) findings.push(...(await o.health({ project, repo: o.repo, roots: m.roots, conditions: rule.conditions, since })));
  }
  return findings.length === 0
    ? { ...base, ...times, state: "passed", waitingFor: [] }
    : { ...base, ...times, state: "soaking", waitingFor: findings.map((f) => `${f.project}: ${f.detail}`), findings };
}

/** The soak as a pull request body says it, once, when a wave is opened. */
export function soakNote(rule: SoakRule, nextWave: number): string {
  const checks = rule.conditions.length > 0 ? `, and ${rule.conditions.map((c) => SOAK_WORDS[c]).join(", ")}` : "";
  return rule.afterMs > 0 || rule.conditions.length > 0
    ? `Wave ${nextWave} opens once this wave has soaked${rule.afterMs > 0 ? ` for ${rule.after} after it merges` : ""}${checks}. A person with write access can skip the soak by commenting \`${SKIP_COMMAND}\` on this pull request.`
    : "";
}

const SOAK_WORDS: Record<SoakCondition, string> = {
  drift: "no open drift issue names its roots",
  apply: "no apply has failed on its roots",
  policy: "policy has denied none of its roots",
};
