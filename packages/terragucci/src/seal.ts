/**
 * Sealed approvals for the tf-apply wave gates, through chant's bundle-safe
 * `@intentius/chant/gate-decision` (chant#3763).
 *
 * Under `approval: sealed` (./approval.ts) a wave gate counts only an
 * approval whose seal, made by `chant approve --sign`, verifies for its
 * approver against the signers file at base (`.chant/allowed_signers`, or the
 * path `.chant/trust.json` names). Base is the commit before the one being
 * applied (`baseCommit`). What stays here is the error type terragucci reports.
 */
import { baseCommit as chantBaseCommit, DEFAULT_SIGNERS_PATH, gateSealRefusal, gateSignersAt, identityGatesAt, type GateSigners, type SealedGateApproval } from "@intentius/chant/gate-decision";
import { ConfigError } from "./config";

export { GATE_SEAL_NAMESPACE, gateSealPayload, type GateSigners, type Signer } from "@intentius/chant/gate-decision";

/** Where the signers are when `.chant/trust.json` names no other path. */
export const SIGNERS_PATH = DEFAULT_SIGNERS_PATH;

/** The fields of a resolution line a seal covers. */
export type SealedApproval = SealedGateApproval;

/** The rule at base: the gates `identity.gates` names, and the signers to check a seal against. */
export interface SealRule {
  gates: Set<string>;
  signers: GateSigners;
  signersPath: string;
}

/**
 * Why this approval does not count toward a gate that needs a seal, or null
 * when it does: its seal verifies for its approver against the signers. An
 * unsealed approval is told how to seal one.
 */
export function sealRefusal(signers: GateSigners, a: SealedApproval): string | null {
  const why = gateSealRefusal(signers, a);
  return why !== null && signers.active && (a.seal === undefined || a.seal === null) ? `${why} (terragucci approve --sign)` : why;
}

/**
 * The gates `chant.workspace.json` names under `identity.gates`, and the
 * signers, both as they stand at base. `at` names another base, for a caller
 * that applies something other than the default branch's own commit.
 */
export function sealRule(repo: string, at?: string): SealRule {
  const base = at ?? baseCommit(repo);
  let gates: Set<string>;
  try {
    gates = new Set(identityGatesAt(repo, base).map((g) => g.gate));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const signers = gateSignersAt(repo, base);
  return { gates, signers, signersPath: signers.signersPath };
}

/** The first parent of HEAD, fetched when the checkout is shallow; HEAD itself when it has none. */
export function baseCommit(repo: string): string {
  try {
    return chantBaseCommit(repo);
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}, so the gate cannot be decided`);
  }
}
