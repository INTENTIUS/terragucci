/**
 * `rollouts.soak` on chant's soak: a wave that applied waits before the next
 * one opens, and what must hold on its roots meanwhile.
 *
 * The keys are unchanged. This file maps them onto chant's wave soak
 * (`@intentius/chant/pipeline/soak`, which decides) and supplies what its
 * checks read:
 *
 * - `after` is the soak's `duration`, and each `conditions` entry is a check
 *   of that kind with `onFail: "hold"`: a finding holds the next wave and
 *   keeps the time elapsed;
 * - an `overrides` entry takes its `module` (or `provider`) glob as a member
 *   glob. The rollout is the member that is matched, by its name with and
 *   without the registry host and by its aliases;
 * - each project whose pull request merged is a member that applied, its
 *   roots are the targets and its merge time is the apply time, so the clock
 *   starts at the last merge as it always has;
 * - drift reads the project's open drift issue, apply the newest apply on the
 *   default branch, and policy the denials on the gate ledger of the user's
 *   repository.
 *
 * A person with write access ends the soak by commenting
 * `/terragucci skip-soak` on one of the wave's pull requests. That comment is
 * recorded as the approval of the wave's soak gate on chant's gate ledger,
 * and chant's early end reads it, so the ledger names who. A run that opens
 * nothing (a dry run) records nothing and ends the soak in memory.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { decideSoak, soakRuleFor as chantRuleFor, type Soak, type SoakCheckReader, type SoakCheck, type SoakDecision, type SoakOverride as ChantOverride, type SoakSubject } from "@intentius/chant/pipeline/soak";
import { soakCheckReader, type SoakSources } from "@intentius/chant/pipeline/soak-checks";
import { soakAtGate, waveSoakGate } from "@intentius/chant/pipeline/soak-gate";
import { type SoakCondition, type SoakSettings } from "../config";
import { appliedState, type RolloutForge } from "./forge";
import { namesOf } from "./releases";

/** The comment that skips a soak. */
export const SKIP_COMMAND = "/terragucci skip-soak";

/** The op a rollout's soak gates are recorded under on the gate ledger. */
export const ROLLOUT_SOAK_OP = "terragucci-rollout";

/** The soak a rollout is under: the wait, and the conditions. */
export interface SoakRule {
  /** The duration as written (`24h`), for the pull request and the report. */
  after: string;
  afterMs: number;
  conditions: SoakCondition[];
}

const checksOf = (conditions: SoakCondition[]): SoakCheck[] => conditions.map((kind) => ({ kind, onFail: "hold" as const }));

/**
 * `rollouts.soak` as chant's soak, for a rollout of `kind`. An override of the
 * other kind can never name the rollout and is left out.
 */
export function chantSoakOf(soak: SoakSettings | undefined, kind: "module" | "provider"): Soak | undefined {
  if (!soak) return undefined;
  const overrides: ChantOverride[] = (soak.overrides ?? [])
    .filter((o) => (kind === "module" ? o.module : o.provider) !== undefined)
    .map((o) => ({
      members: [(kind === "module" ? o.module : o.provider)!],
      ...(o.after !== undefined ? { duration: o.after } : {}),
      ...(o.conditions !== undefined ? { checks: checksOf(o.conditions) } : {}),
    }));
  return { duration: soak.after, ...(soak.conditions ? { checks: checksOf(soak.conditions) } : {}), ...(overrides.length > 0 ? { overrides } : {}) };
}

/** The spellings of a rollout an override glob may match. */
export const rolloutNames = (kind: "module" | "provider", name: string, aliases: string[] = []): string[] => [...new Set([...namesOf({ kind, name }), ...aliases])];

/** The rule for a rollout: the soak's own `after` and `conditions`, then the first override whose glob names it. */
export function soakRuleFor(soak: SoakSettings | undefined, kind: "module" | "provider", name: string, aliases: string[] = []): SoakRule | undefined {
  const chant = chantSoakOf(soak, kind);
  if (!chant) return undefined;
  const rule = chantRuleFor(chant, rolloutNames(kind, name, aliases));
  return { after: rule.duration, afterMs: rule.durationMs, conditions: rule.checks.map((c) => c.kind as SoakCondition) };
}

/** One thing a condition found that holds the next wave. */
export interface Finding {
  condition: SoakCondition;
  project: string;
  roots: string[];
  detail: string;
}

/** A project of the rollout: its checkout of the default branch, and its forge. */
export interface SoakProject {
  key: string;
  dir: string;
  forge: RolloutForge;
}

/** The sources chant's drift, apply and policy checks read, from the forge and the gate ledger. */
export function forgeSources(projects: Map<string, SoakProject>, repo: string): SoakSources {
  return {
    async driftIssue(_env, member) {
      const issue = member ? await projects.get(member)?.forge.openDriftIssue?.() : undefined;
      return issue ? { body: issue.body, url: issue.url } : null;
    },
    async applies(_env, member, targets) {
      const project = member ? projects.get(member) : undefined;
      if (!project) return {};
      let head: string | undefined;
      try {
        head = execFileSync("git", ["-C", project.dir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        head = undefined;
      }
      const checks = head ? await project.forge.commitChecks(head) : [];
      return Object.fromEntries(targets.map((t) => [t, appliedState(checks, t)]));
    },
    async denials(_env, _member, targets) {
      const { readLedger } = await import("../apply");
      const { OVERRIDE_LEDGER, recordedDenials } = await import("../override");
      return recordedDenials(readLedger(repo, OVERRIDE_LEDGER))
        .filter((d) => targets.includes(d.gate))
        .map((d) => ({ target: d.gate, at: d.timestamp, rules: d.rules ?? [] }));
    },
  };
}

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
  /** The decision chant's soak made, for a caller that wants the holds as chant states them. */
  decision: SoakDecision;
}

export interface SoakWave {
  wave: number;
  /** The merge times of the wave's pull requests, by project. A missing one is a merge the forge gave no time for. */
  merged: { project: string; roots: string[]; branch: string; at?: string }[];
}

/** What a rollout's soak reads and records. */
export interface SoakContext {
  kind: "module" | "provider";
  name: string;
  aliases?: string[];
  now: number;
  projects: Map<string, SoakProject>;
  /** The user's repository, where the gate ledger is read. */
  repo: string;
  /** What the checks read. Default: the forge and the gate ledger. */
  read?: SoakCheckReader;
  /**
   * Where a skip is recorded: the gate ledger of the repository, which chant's
   * early end then reads. Absent, the skip is not recorded (a dry run).
   */
  gates?: GateLedgerPort;
}

/** The gate wave `k` of a rollout is soaked through: its own name, then chant's `-soak`. */
export function rolloutSoakGate(kind: string, name: string, wave: number): string {
  return waveSoakGate(`${kind}-${name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}-wave-${wave}`);
}

/** The digest a skip binds: the wave and the pull requests that merged, so a later wave's merges are not covered by it. */
export function rolloutSoakDigest(soaked: SoakWave): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([soaked.wave, soaked.merged.map((m) => [m.project, m.branch, m.at ?? null])])).digest("hex")}`;
}

/**
 * Decide the soak of the wave that applied, at `ctx.now`. The wave's soak
 * starts at the last of its merges.
 */
export async function soakOf(rule: SoakRule, soaked: SoakWave, ctx: SoakContext, settings: SoakSettings): Promise<SoakStatus> {
  const soak = chantSoakOf(settings, ctx.kind)!;
  const names = rolloutNames(ctx.kind, ctx.name, ctx.aliases);
  const subjects: SoakSubject[] = soaked.merged.map((m) => ({ member: m.project, names, targets: m.roots, ...(m.at !== undefined ? { appliedAt: m.at } : {}) }));
  const read = ctx.read ?? soakCheckReader(forgeSources(ctx.projects, ctx.repo));
  const environment = "rollout";

  // A skip is one person's comment on any pull request of the wave.
  let skip: { by: string; url?: string } | undefined;
  for (const m of soaked.merged) {
    const found = (await ctx.projects.get(m.project)?.forge.soakSkips?.(m.branch)) ?? [];
    if (found[0]) {
      skip = { by: found[0].by, ...(found[0].url ? { url: found[0].url } : {}) };
      break;
    }
  }

  let decision: SoakDecision;
  if (skip && ctx.gates) decision = await endEarly({ soak, soaked, subjects, read, environment, skip, now: ctx.now, gates: ctx.gates, kind: ctx.kind, name: ctx.name });
  else decision = await decideSoak({ soak, subjects, environment, now: new Date(ctx.now), ...(skip ? { ended: skip } : {}), read });
  return statusOf(rule, soaked, decision);
}

/**
 * Record the skip as the approval of the wave's soak gate, then let chant's
 * early end read it. The approval is written once; chant records the spend.
 */
async function endEarly(o: { soak: Soak; soaked: SoakWave; subjects: SoakSubject[]; read: SoakCheckReader; environment: string; skip: { by: string; url?: string }; now: number; gates: GateLedgerPort; kind: string; name: string }): Promise<SoakDecision> {
  const gate = rolloutSoakGate(o.kind, o.name, o.soaked.wave);
  const digest = rolloutSoakDigest(o.soaked);
  const at = new Date(o.now).toISOString();
  const ledger = await o.gates.read(ROLLOUT_SOAK_OP);
  const same = (r: { gate: string; planDigest?: string | undefined; environment?: string | undefined }) => r.gate === gate && r.planDigest === digest && r.environment === o.environment;
  if (!ledger.resolutions.some(same)) {
    if (!o.gates.appendResolution) throw new Error("chant's gate ledger cannot record an approval");
    await o.gates.appendResolution({ op: ROLLOUT_SOAK_OP, gate, resolvedBy: o.skip.by, timestamp: at, planDigest: digest, environment: o.environment, note: SKIP_COMMAND, ...(o.skip.url ? { url: o.skip.url } : {}) });
  }
  if ((await o.gates.readApplied?.(ROLLOUT_SOAK_OP))?.some(same)) {
    // Spent on an earlier run: the soak stays ended.
    return decideSoak({ soak: o.soak, subjects: o.subjects, environment: o.environment, now: new Date(o.now), ended: o.skip, read: o.read });
  }
  const out = await soakAtGate({ op: ROLLOUT_SOAK_OP, gate, soak: o.soak, stage: o.environment, holds: `wave ${o.soaked.wave + 1}`, wave: o.soaked.wave, digest, subjects: o.subjects, port: o.gates, read: o.read, now: new Date(o.now) });
  // chant names the approver it found on the ledger; the comment's author and link are what a person reads.
  return { ...out.decision, ...(out.decision.via === "ended" ? { endedBy: o.skip } : {}) };
}

function statusOf(rule: SoakRule, soaked: SoakWave, d: SoakDecision): SoakStatus {
  const base = { wave: soaked.wave, after: rule.after, conditions: rule.conditions, findings: [] as Finding[], decision: d };
  if (d.via === "ended") return { ...base, state: "skipped", waitingFor: [], skippedBy: d.endedBy! };
  const times = d.clockStart ? { since: d.clockStart, due: d.due! } : {};
  if (d.outcome === "release") return { ...base, ...times, state: "passed", waitingFor: [] };
  const findings: Finding[] = [];
  const waitingFor: string[] = [];
  for (const h of d.holds) {
    if (h.reason === "time") waitingFor.push(`${rule.after} to pass since wave ${soaked.wave} merged, until ${h.due}`);
    else if (h.reason === "clock-unknown") waitingFor.push(`the forge gave no merge time for wave ${soaked.wave}'s pull request in ${h.members.join(", ")}, so its soak cannot be counted; a person can skip it with ${SKIP_COMMAND}`);
    else {
      const f: Finding = { condition: h.kind as SoakCondition, project: h.member ?? "", roots: h.targets ?? [], detail: h.detail };
      findings.push(f);
      waitingFor.push(`${f.project}: ${f.detail}`);
    }
  }
  return { ...base, ...times, state: "soaking", waitingFor, findings };
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
