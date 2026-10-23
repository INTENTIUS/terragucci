/**
 * `apply.requires` before an open pull request applies from its head:
 * chant's four requires checks (`@intentius/chant/pr-requires`), each asked
 * of the forge through its PrForge method. A check the forge has not settled
 * is asked again a few times before it counts as unmet.
 *
 * chant asks only the checks `apply.requires` lists (`only`). `approved`
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

/** Each requirement's outcome, in chant's order. One `apply.requires` leaves out passes without a call. */
export async function checkApplyRequires(forge: PrForge, pr: number, head: string, o: ApplyRequiresOptions = {}): Promise<PrRequireOutcome[]> {
  const approved = forge.prApproved?.bind(forge);
  const counted = o.counted;
  const view: PrForge = !counted || !approved ? forge : {
    ...forge,
    prApproved: async (n, h, f) => {
      const r = await approved(n, h, f);
      return r.passed ? counted() : r;
    },
    prMergeable: forge.prMergeable?.bind(forge),
    prUndiverged: forge.prUndiverged?.bind(forge),
    prChecksPassed: forge.prChecksPassed?.bind(forge),
  };
  return checkPrRequires(view, pr, head, { only: o.requires ?? APPLY_REQUIRES, ...(o.ignore ? { ignore: o.ignore } : {}), ...(o.wait ? { wait: o.wait } : {}) });
}

/** The unmet requirements as one line for a reply, or undefined when every one passed. */
export async function unmetApplyRequires(forge: PrForge, pr: number, head: string, o: ApplyRequiresOptions = {}): Promise<string | undefined> {
  return unmetRequires(await checkApplyRequires(forge, pr, head, o)) ?? undefined;
}
