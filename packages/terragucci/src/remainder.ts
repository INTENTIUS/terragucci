/**
 * Resuming a wave whose approved apply stopped before it finished.
 *
 * A gated wave records, before it applies under an approval, each change its
 * plans make (`changes` on the applied record), when every root that changes
 * something applies per resource (choudoufu, ./apply-rows.ts). Once its apply
 * ends it records how (`finished`). An apply that was killed records no end.
 *
 * choudoufu writes a resource's record when its apply returns
 * (./records.ts), so the next plan of a wave that stopped holds only what it
 * did not apply. That plan has another digest, so the approval would not
 * count. It still does when the plan is the rest of the approved one: each
 * change it makes is one the approved plans made, the same in every value,
 * and each approved change it no longer makes is done in the records (a
 * create or an update recorded, a delete or a forget gone). A change that
 * moved since the approval, or an approved one neither done nor planned,
 * leaves the wave to wait for an approval of its own. choudoufu's apply then
 * re-reads each resource and refuses a change that went stale.
 *
 * Stock binaries keep one state per root and record nothing per resource, so
 * a wave of theirs plans again and needs an approval of the plans it makes.
 */
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { terraformPlanChangeSet } from "@intentius/chant-lexicon-terraform/plan-digest";
import type { AppliedRecord, FinishedRecord, GateLedger } from "./apply";
import { applyScope } from "./apply-rows";
import { recordedAddresses } from "./records";

/** One change an approved plan makes, and the digest of everything it would write. */
export interface ApprovedChange {
  root: string;
  address: string;
  /** The plan's actions, joined by commas: `create`, `update`, `delete`, `delete,create`, `forget`. */
  actions: string;
  digest: string;
}

/** A root's plan, and the binary it planned with. */
export interface RootPlan {
  root: string;
  plan?: unknown;
  binary: string;
}

const CHANGING = new Set(["create", "update", "delete", "forget"]);

/**
 * Every change the plans make, each with its digest, or undefined when a root
 * that changes something applies per root: its wave cannot be resumed.
 */
export function approvedChanges(plans: readonly RootPlan[]): ApprovedChange[] | undefined {
  const out: ApprovedChange[] = [];
  for (const p of plans) {
    const changes = (Array.isArray((p.plan as { resource_changes?: unknown })?.resource_changes) ? (p.plan as { resource_changes: unknown[] }).resource_changes : []) as Array<Record<string, any>>;
    const mine = changes.filter((c) => c?.mode !== "data" && typeof c?.address === "string" && (Array.isArray(c.change?.actions) ? c.change.actions : []).some((a: string) => CHANGING.has(a)));
    if (mine.length === 0) continue;
    if (applyScope(p.binary) !== "resource") return undefined;
    for (const c of mine) {
      const [projected] = terraformPlanChangeSet({ resource_changes: [c] }).resourceChanges;
      out.push({ root: p.root, address: c.address, actions: (c.change.actions as string[]).join(","), digest: computePlanDigest("terraform-resource-change", projected) });
    }
  }
  return out.sort((a, b) => (`${a.root} ${a.address}` < `${b.root} ${b.address}` ? -1 : 1));
}

/** The finished record of an applied one, when its apply ended. */
export function finishOf(ledger: GateLedger, a: AppliedRecord): FinishedRecord | undefined {
  return (ledger.finished ?? []).find((f) => f.gate === a.gate && f.planDigest === a.planDigest && f.applied === a.timestamp);
}

const at = (iso: string): number => new Date(iso).getTime();

/**
 * The newest apply of the gate under the approval made at `approvedAt` that
 * recorded its changes and did not finish applying them: killed (no finished
 * record) or failed. Undefined when there is none.
 */
export function stoppedApply(ledger: GateLedger, gate: string, approvedAt: string): AppliedRecord | undefined {
  const newest = (ledger.applied ?? [])
    .filter((a) => a.gate === gate && at(a.approvedAt) === at(approvedAt))
    .reduce<AppliedRecord | undefined>((n, a) => (!n || at(a.timestamp) >= at(n.timestamp) ? a : n), undefined);
  if (!newest?.changes) return undefined;
  return finishOf(ledger, newest)?.result === "applied" ? undefined : newest;
}

export type Cover =
  /** The plans are the rest of the approved ones. */
  | { covered: true; remaining: ApprovedChange[]; done: ApprovedChange[] }
  /** They are not: `why` says what moved. */
  | { covered: false; why: string };

/** Whether the plans made now are the rest of the approved changes, the others done in the records. */
export function coverRemainder(approved: readonly ApprovedChange[], plans: readonly RootPlan[]): Cover {
  const now = approvedChanges(plans);
  if (!now) return { covered: false, why: "a root that changes something now applies per root" };
  const key = (c: Pick<ApprovedChange, "root" | "address">): string => `${c.root} ${c.address}`;
  const was = new Map(approved.map((c) => [key(c), c]));
  const moved = now.filter((c) => was.get(key(c))?.digest !== c.digest).map(key);
  if (moved.length > 0) return { covered: false, why: `${moved.join(", ")} ${moved.length === 1 ? "is a change" : "are changes"} the approved plans did not make` };
  const planned = new Set(now.map(key));
  const records = new Map(plans.map((p) => [p.root, recordedAddresses(p.plan)]));
  const done: ApprovedChange[] = [];
  const lost: string[] = [];
  for (const c of approved) {
    if (planned.has(key(c))) continue;
    const kept = records.get(c.root)?.has(c.address) ?? false;
    const leaves = c.actions.split(",").some((a) => a === "create" || a === "update");
    if (records.has(c.root) && kept === leaves) done.push(c);
    else lost.push(key(c));
  }
  if (lost.length > 0) return { covered: false, why: `${lost.join(", ")} ${lost.length === 1 ? "was" : "were"} approved but ${lost.length === 1 ? "is" : "are"} neither done in the records nor planned` };
  return { covered: true, remaining: now, done };
}
