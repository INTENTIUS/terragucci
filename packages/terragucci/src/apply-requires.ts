/**
 * `apply.requires` before an open pull request applies from its head:
 * chant's four requires checks (`@intentius/chant/pr-requires`), each asked
 * of the forge through its PrForge method. A check the forge has not settled
 * is asked again a few times before it counts as unmet.
 *
 * A requirement `apply.requires` leaves out passes without a call. `approved`
 * also has to pass terragucci's own count of who approved (`counted`): on
 * GitHub an approver with write access, on Forgejo an official review, on
 * GitLab Developer or more, and never someone with a hand in the change
 * (./involved.ts).
 */
import type { PrForge, PrRequireResult } from "@intentius/chant/pr-forge";
import { checkPrRequires, unmetRequires, type PrRequireOutcome } from "@intentius/chant/pr-requires";
import { APPLY_REQUIRES, type ApplyRequire } from "./config";

export interface ApplyRequiresOptions {
  /** `apply.requires`. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  /** terragucci's count of the approvals, asked once chant's `approved` passed. */
  counted?: () => Promise<PrRequireResult>;
  /** Status names `checks` leaves out: the apply's own. */
  ignore?: readonly string[];
  wait?: (ms: number) => Promise<void>;
}

const unasked = async (): Promise<PrRequireResult> => ({ passed: true, reason: "not in apply.requires" });

/**
 * Forgejo answers `mergeable: false` while it still checks a pull request for
 * conflicts, so a refusal there is asked again, as a pending check is, before
 * it counts.
 */
const forgejoMergeable = (ask: NonNullable<PrForge["prMergeable"]>): NonNullable<PrForge["prMergeable"]> => async (pr, head) => {
  const r = await ask(pr, head);
  return r.passed ? r : { ...r, pending: true };
};

/** Each requirement's outcome, in chant's order. */
export async function checkApplyRequires(forge: PrForge, pr: number, head: string, o: ApplyRequiresOptions = {}): Promise<PrRequireOutcome[]> {
  const on = new Set<ApplyRequire>(o.requires ?? APPLY_REQUIRES);
  const approved = forge.prApproved?.bind(forge);
  const view: PrForge = {
    ...forge,
    prApproved: !on.has("approved") ? unasked : approved && (async (n, h) => {
      const r = await approved(n, h);
      return r.passed && o.counted ? o.counted() : r;
    }),
    prMergeable: !on.has("mergeable") ? unasked : forge.kind === "forgejo" && forge.prMergeable ? forgejoMergeable(forge.prMergeable.bind(forge)) : forge.prMergeable?.bind(forge),
    prUndiverged: on.has("undiverged") ? forge.prUndiverged?.bind(forge) : unasked,
    prChecksPassed: on.has("checks") ? forge.prChecksPassed?.bind(forge) : unasked,
  };
  return checkPrRequires(view, pr, head, { ...(o.ignore ? { ignore: o.ignore } : {}), ...(o.wait ? { wait: o.wait } : {}) });
}

/** The unmet requirements as one line for a reply, or undefined when every one passed. */
export async function unmetApplyRequires(forge: PrForge, pr: number, head: string, o: ApplyRequiresOptions = {}): Promise<string | undefined> {
  return unmetRequires(await checkApplyRequires(forge, pr, head, o)) ?? undefined;
}
