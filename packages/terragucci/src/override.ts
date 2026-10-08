/**
 * A recorded policy override: a listed approver lets one denied plan through.
 *
 * When the policy denies a root in a `tf-apply` wave and `policy.override` in
 * the config at base names who may override, the wave records a pending fact
 * for the denial on `chant/lifecycle` (`_gates/policy-override.jsonl`, gate
 * the root's path). Its digest binds three things: the root, the root's plan
 * digest, and the ids of the rules that denied it (`overrideDigest`). An
 * approver answers it with `terragucci override <root> --rule <id> --reason
 * <text>`, which runs `chant approve policy-override <root> --plan <digest>
 * --note <reason>`, sealed with `--sign` under `approval: sealed`.
 *
 * The next run of the wave applies the root only when an override of exactly
 * that digest stands (`decideOverride`): written after the newest pending
 * fact for the root, by someone `policy.override` lists at base, with a
 * reason, and under `approval: sealed` sealed by a key the signers file at
 * base lists for them. A line a job wrote (one that carries `via`) never
 * counts. A plan that moved, or rules that changed, give another digest, so an
 * earlier override counts for nothing: the wave applies nothing and exits 4,
 * as a wave whose plans changed after approval does.
 *
 * An override never touches the policy, and `tf-plan` still fails the root;
 * the plan note shows the override that stands for it.
 */
import { createHash } from "node:crypto";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { GateLedger, PendingRecord, ResolutionRecord } from "./apply";
import type { Approval } from "./config";
import type { ReportOverride } from "./report/schema";
import { sealRefusal, type Signer } from "./seal";

/** The op every override is recorded under. */
export const OVERRIDE_OP = "policy-override";
/** The ledger file overrides and their pending facts live in, on chant/lifecycle. */
export const OVERRIDE_LEDGER = `_gates/${OVERRIDE_OP}.jsonl`;

/** A pending fact for a denial: the gate's record, with the rules that denied the plan. */
export interface OverridePending extends PendingRecord {
  rules?: string[];
}

/** The rules as an override names them: each once, sorted. */
export const sortedRules = (rules: readonly string[]): string[] => [...new Set(rules.map((r) => r.trim()).filter(Boolean))].sort();

/** The digest an override binds: the root, its plan digest and the rules that denied it. */
export function overrideDigest(root: string, planDigest: string, rules: readonly string[]): string {
  const text = [OVERRIDE_OP, root, planDigest, ...sortedRules(rules)].join("\n");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The command that overrides a denial. */
export function overrideCommand(root: string, rules: readonly string[], sealed = false): string {
  return `terragucci override ${root} ${sortedRules(rules).map((r) => `--rule ${r}`).join(" ")} --reason "<why>"${sealed ? " --sign" : ""}`;
}

/** What is read at base to judge an override: who may write one, and under `sealed` the signers. */
export interface OverrideRule {
  mode: Approval;
  overriders: string[];
  signers: Signer[] | null;
  signersPath: string;
}

export type OverrideDecision =
  /** An override of this digest stands. */
  | { status: "overridden"; override: ReportOverride }
  /** No override of this digest counts. `refusals` says why each that names it does not; `standing` as in decideGate. */
  | { status: "none"; refusals: string[]; standing?: PendingRecord }
  /** An override counts for another digest: the plan or its rules changed since it was written. */
  | { status: "moved"; by: string; was: string | undefined; refusals: string[]; standing?: PendingRecord };

const at = (iso: string): number => new Date(iso).getTime();
const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/** Why this ledger line does not count as an override, or null when it does. */
export function overrideRefusal(rule: OverrideRule, r: ResolutionRecord & { note?: string }): string | null {
  if (r.via !== undefined) return `the override line was written by a job (via ${r.via}), and an override is a person's`;
  if (!rule.overriders.map(norm).includes(norm(r.resolvedBy))) {
    return `${r.resolvedBy} is not listed under policy.override at base${rule.overriders.length ? ` (${rule.overriders.join(", ")})` : ""}`;
  }
  if (!r.note?.trim()) return `the override by ${r.resolvedBy} gives no reason`;
  if (rule.mode === "sealed") return sealRefusal(rule.signers, rule.signersPath, r);
  return null;
}

/**
 * Decide one denied root against the override ledger, as decideGate decides a
 * wave: a line counts only when it is newer than the newest pending fact for
 * the root, names this digest, and passes `overrideRefusal`.
 */
export function decideOverride(ledger: GateLedger, rule: OverrideRule, root: string, planDigest: string, rules: readonly string[], now: string): OverrideDecision {
  const digest = overrideDigest(root, planDigest, rules);
  let latest: PendingRecord | undefined;
  for (const p of ledger.pending) if (p.op === OVERRIDE_OP && p.gate === root && (!latest || at(p.timestamp) >= at(latest.timestamp))) latest = p;
  const since = latest ? at(latest.timestamp) : 0;
  let matched: (ResolutionRecord & { note?: string }) | undefined;
  let mismatched: ResolutionRecord | undefined;
  const refusals: string[] = [];
  for (const r of ledger.resolutions as (ResolutionRecord & { note?: string })[]) {
    if (r.op !== OVERRIDE_OP || r.gate !== root || at(r.timestamp) < since) continue;
    const why = overrideRefusal(rule, r);
    if (samePlanDigest(r.planDigest, digest)) {
      if (why !== null) refusals.push(why);
      else if (!matched || at(r.timestamp) >= at(matched.timestamp)) matched = r;
    } else if (why === null && (!mismatched || at(r.timestamp) >= at(mismatched.timestamp))) {
      mismatched = r;
    }
  }
  if (matched) {
    return {
      status: "overridden",
      override: { by: matched.resolvedBy, at: matched.timestamp, rules: sortedRules(rules), reason: matched.note!.trim(), plan_digest: planDigest, digest, sealed: rule.mode === "sealed" },
    };
  }
  const standing = latest && at(latest.expiresAt) > at(now) && samePlanDigest(latest.planDigest, digest) ? latest : undefined;
  if (mismatched) return { status: "moved", by: mismatched.resolvedBy, was: mismatched.planDigest, refusals, ...(standing ? { standing } : {}) };
  return { status: "none", refusals, ...(standing ? { standing } : {}) };
}

/** The denials on the ledger: each root's newest pending fact, the plan and rules a run of its wave last refused. Sorted by root. */
export function recordedDenials(ledger: GateLedger): OverridePending[] {
  const newest = new Map<string, OverridePending>();
  for (const p of ledger.pending as OverridePending[]) {
    const before = newest.get(p.gate);
    if (p.op === OVERRIDE_OP && p.planDigest && (!before || at(p.timestamp) >= at(before.timestamp))) newest.set(p.gate, p);
  }
  return [...newest.values()].sort((a, b) => (a.gate < b.gate ? -1 : 1));
}
