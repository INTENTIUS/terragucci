/**
 * A recorded policy override: a listed approver lets one denied plan through.
 *
 * chant's override gate (`@intentius/chant/override-gate`) records and
 * decides overrides. This module is terragucci's layer over it: the subject
 * is a root, the overriders are `policy.override` in the config at base, and
 * the command a person runs is `terragucci override`.
 *
 * When the policy denies a root in a `tf-apply` wave and `policy.override` in
 * the config at base names who may override, the wave records a pending fact
 * for the denial on `chant/lifecycle` (`_gates/policy-override.jsonl`, gate
 * the root's path; `overridePending`). Its digest binds three things: the
 * root, the root's plan digest, and the ids of the rules that denied it
 * (`overrideDigest`). An approver answers it with `terragucci override <root>
 * --rule <id> --reason <text>`, which runs `chant approve policy-override
 * <root> --rule <id> --reason <text>`, sealed with `--sign` under `approval:
 * sealed`.
 *
 * The next run of the wave applies the root only when an override of exactly
 * that digest stands (`decideOverride`): written after the newest pending
 * fact for the root, by someone `policy.override` lists at base, with a
 * reason, and under `approval: sealed` sealed by a key the signers file at
 * base lists for them. A line a job wrote (one that carries `via` or a
 * review) or an agent wrote never counts. A plan that moved, or rules that
 * changed, give another digest, so an earlier override counts for nothing:
 * the wave applies nothing and exits 4, as a wave whose plans changed after
 * approval does.
 *
 * Before a wave applies a root under an override it records that the override
 * was used, in `_gates/policy-override/applied.jsonl` as a wave records the
 * approval it applied under. An override a wave applied is spent: when the
 * root plans again and is denied, the spent override refuses nothing, and the
 * new denial is recorded and waits for its own override (exit 1). Only an
 * override of a plan no wave applied makes the wave exit 4.
 *
 * An override never touches the policy, and `tf-plan` still fails the root;
 * the plan note shows the override that stands for it.
 *
 * `policy.override` can scope who may override (overridersFor): beside the
 * flat names, which may override every root and rule, an entry names `who`
 * and `roles` (holders in `.chant/trust.json` at base, under `sealed`) for
 * the roots its globs match and, with `rules`, only an override of rules it
 * lists. chant's override gate takes one list per wave, so a wave hands it
 * everyone who may override any of its denied roots, and once chant decided,
 * the wave refuses an override whose writer the entries at base do not name
 * for that root and its rules, before anything applies or is spent.
 */
import { gateSignersAt, type GateSigners } from "@intentius/chant/gate-decision";
import {
  decideOverride as decideChantOverride,
  overridePending as chantOverridePending,
  recordedDenials as chantRecordedDenials,
  sortedRules,
  type GateResolutionRecord,
  type OverridePendingInput,
  type PendingGateRecord,
} from "@intentius/chant/override-gate";
import type { AppliedRecord, GateLedger, PendingRecord } from "./apply";
import type { Approval, OverrideEntry } from "./config";
import { globMatch } from "./detect";
import type { ReportOverride } from "./report/schema";

export { OVERRIDE_APPLIED, OVERRIDE_LEDGER, OVERRIDE_OP, overrideDigest, sortedRules } from "@intentius/chant/override-gate";

/** Where terragucci reads who may override, for the refusals. */
const OVERRIDERS_KEY = "policy.override";

/** A pending fact for a denial: the gate's record, with the plan and the rules that denied it. */
export interface OverridePending extends PendingRecord {
  /** The plan digest the policy denied; absent on facts recorded before chant held the override gate. */
  plan?: string;
  rules?: string[];
}

/** Who may override one root's denial by `rules`, as `policy.override` at base says. */
export interface Overriders {
  /** The principals: the flat names, each matching entry's `who`, and the holders of its `roles`. */
  principals: string[];
  /** How the denial message names them: names, then `role <r>` with its holders. */
  shown: string[];
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/**
 * Who may override a denial of `root` by `rules`: every flat name of
 * `policy.override`, and each entry whose roots match the root and whose
 * `rules`, when set, hold every rule denied. A role counts only under
 * `sealed` (`roles` is the trust.json grants at base, `{}` otherwise), since
 * only a seal proves who wrote the override.
 */
export function overridersFor(o: { overriders: readonly string[]; entries?: readonly OverrideEntry[]; roles: Record<string, string[]> }, root: string, rules: readonly string[]): Overriders {
  const principals: string[] = [];
  const shown: string[] = [];
  const add = (p: string): void => {
    if (!principals.some((x) => norm(x) === norm(p))) principals.push(p);
  };
  for (const p of o.overriders) {
    add(p);
    if (!shown.includes(p)) shown.push(p);
  }
  for (const e of o.entries ?? []) {
    if (!e.roots.some((g) => globMatch(g, root))) continue;
    if (e.rules && !rules.every((r) => e.rules!.includes(r))) continue;
    for (const p of e.who ?? []) {
      add(p);
      if (!shown.includes(p)) shown.push(p);
    }
    for (const r of e.roles ?? []) {
      const holders = o.roles[r] ?? [];
      holders.forEach(add);
      const line = `role ${r} (${holders.length ? holders.join(", ") : "nobody holds it at base"})`;
      if (!shown.includes(line)) shown.push(line);
    }
  }
  return { principals, shown };
}

/** Whether `by`, an override's writer as chant names them, is one of `principals`. */
export const mayOverride = (principals: readonly string[], by: string): boolean => principals.some((p) => norm(p) === norm(by));

/** The command that overrides a denial. */
export function overrideCommand(root: string, rules: readonly string[], sealed = false): string {
  return `terragucci override ${root} ${sortedRules(rules).map((r) => `--rule ${r}`).join(" ")} --reason "<why>"${sealed ? " --sign" : ""}`;
}

/** What is read at base to judge an override: who may write one (`policy.override`), and under `sealed` the signers. */
export interface OverrideRule {
  mode: Approval;
  overriders: string[];
  /** The signers at base, as chant reads them. Under `sealed`, absent means nothing counts. */
  signers?: GateSigners;
}

/** The override rule for an approval rule read at `base`: the signers are read there only under `sealed`. */
export function overrideRule(repo: string, rule: { mode: Approval; overriders: string[]; base: string }): OverrideRule {
  return { mode: rule.mode, overriders: rule.overriders, ...(rule.mode === "sealed" ? { signers: gateSignersAt(repo, rule.base) } : {}) };
}

export type OverrideDecision =
  /** An override of this digest stands. */
  | { status: "overridden"; override: ReportOverride }
  /**
   * No override of this digest counts. `refusals` says why each that names it does not; `standing` as in decideGate.
   * `spent` names the newest override of another digest that a wave applied under, which therefore refuses nothing.
   */
  | { status: "none"; refusals: string[]; standing?: PendingRecord; spent?: { digest: string; by: string } }
  /** An override counts for another digest: the plan or its rules changed since it was written. */
  | { status: "moved"; by: string; was: string | undefined; refusals: string[]; standing?: PendingRecord };

/** The ledger's lines as chant's override gate reads them: the same JSON lines, typed as chant's records. */
const chantLedger = (ledger: GateLedger) => ({
  pending: ledger.pending as unknown as PendingGateRecord[],
  resolutions: ledger.resolutions as unknown as GateResolutionRecord[],
});

/**
 * Decide one denied root against the override ledger with chant's
 * `decideOverride`, and say it as the report does.
 */
export function decideOverride(ledger: GateLedger, rule: OverrideRule, root: string, planDigest: string, rules: readonly string[], now: string): OverrideDecision {
  const d = decideChantOverride({
    ledger: chantLedger(ledger),
    applied: (ledger.applied ?? []).filter((a): a is AppliedRecord & { kind: "applied" } => a.kind === "applied"),
    overriders: rule.overriders,
    overridersPath: OVERRIDERS_KEY,
    mode: rule.mode,
    ...(rule.signers ? { signers: rule.signers } : {}),
    subject: root,
    planDigest,
    rules,
    now,
  });
  if (d.status === "overridden") {
    const o = d.override;
    return { status: "overridden", override: { by: o.by, at: o.at, rules: o.rules, reason: o.reason, plan_digest: o.planDigest, digest: o.digest, sealed: o.sealed } };
  }
  const standing = d.standing ? { standing: d.standing as unknown as PendingRecord } : {};
  if (d.status === "moved") return { status: "moved", by: d.by, was: d.was, refusals: d.refusals, ...standing };
  return { status: "none", refusals: d.refusals, ...standing, ...(d.spent ? { spent: { digest: d.spent.digest, by: d.spent.by } } : {}) };
}

/** The pending fact a wave records for a root the policy denied, with the wave's own fields beside chant's. */
export function overridePending(input: OverridePendingInput, extra: Pick<OverridePending, "members" | "neverOverMcp">): OverridePending {
  return { ...(chantOverridePending(input) as unknown as OverridePending), ...extra };
}

/** The denials on the ledger: each root's newest pending fact, the plan and rules a run of its wave last refused. Sorted by root. */
export function recordedDenials(ledger: GateLedger): OverridePending[] {
  return chantRecordedDenials(chantLedger(ledger).pending) as unknown as OverridePending[];
}
