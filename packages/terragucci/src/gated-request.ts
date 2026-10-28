/**
 * The state operations outside waves on chant (terragucci#1282, chant#4618):
 * a lock release, a state export and a standalone migration ask, spend and
 * finish chant's gated request (chant#4551) when the installed chant has the
 * terraform lexicon's `state-ops`, and run the binary through its fixed
 * operations. Without it, export.ts, unlock.ts and migrate.ts run their own
 * gate and write their `done.jsonl` lines as before.
 *
 * What changes with chant's gate, by its ruling: chant computes the digest
 * over the request (so a request pending at the switch is asked again), and
 * the requester's own approval never counts, for a lock release and a
 * migration too. The ops and the gates are the same as before (`tf-unlock`,
 * `tf-state-export`, `tf-migrate`, gate the root or the migration), so
 * `terragucci approve unlock|export|migrate` approves either way.
 */
import { chantStateOps, type ChantGatedStateOpResult, type ChantRootRun, type ChantStateOps } from "./chant-next";
import type { ApprovalRule } from "./approval";

export { chantStateOps };
export type { ChantGatedStateOpResult, ChantStateOps };

/** The rules a request is decided by: the mode at base and `approval_rules` as chant's quorum. */
export function requestRules(rule: Pick<ApprovalRule, "mode" | "approvalRules">): { mode: string; quorum?: readonly unknown[] } {
  return { mode: rule.mode, ...(rule.approvalRules?.length ? { quorum: rule.approvalRules } : {}) };
}

/** terragucci's synchronous exec, as the lexicon's operations take one. */
export function asyncExec(exec: (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => { status: number; stdout?: string; out: string }): NonNullable<ChantRootRun["exec"]> {
  return async (binary, args, dir, env) => {
    const r = exec(binary, args, dir, env);
    return { code: r.status, stdout: r.stdout ?? r.out, out: r.out };
  };
}

/** The last lines of a binary's output, from a lexicon operation's error. */
export const opMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
