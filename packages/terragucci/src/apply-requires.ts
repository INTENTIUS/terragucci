/**
 * `apply.requires` before an open pull request applies from its head:
 * chant's four requires checks (`@intentius/chant/pr-requires`), each asked
 * of the forge through its PrForge method. A check the forge has not settled
 * is asked again a few times before it counts as unmet.
 *
 * chant asks only the checks `apply.requires` lists (`only`). `approved`
 * counts whom `approvers` lets through (chant's PrApproverFilter): the
 * forge's rule, on GitHub write access, on Forgejo an official review, on
 * GitLab Developer or more, and never the run's own token or someone with a
 * hand in the change (./involved.ts).
 */
import type { PrApproverFilter, PrForge, PrRequireResult } from "@intentius/chant/pr-forge";
import { checkPrRequires, unmetRequires, type PrRequireOutcome } from "@intentius/chant/pr-requires";
import { APPLY_REQUIRES, type ApplyRequire } from "./config";

export interface ApplyRequiresOptions {
  /** `apply.requires`. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  /**
   * Who counts for `approved`, built when chant asks it. A PrRequireResult
   * instead answers `approved` without asking the forge.
   */
  approvers?: () => Promise<PrApproverFilter | PrRequireResult>;
  /** Status names `checks` leaves out: the apply's own. */
  ignore?: readonly string[];
  wait?: (ms: number) => Promise<void>;
}

/** Each requirement's outcome, in chant's order. One `apply.requires` leaves out passes without a call. */
export async function checkApplyRequires(forge: PrForge, pr: number, head: string, o: ApplyRequiresOptions = {}): Promise<PrRequireOutcome[]> {
  const approved = forge.prApproved?.bind(forge);
  const who = o.approvers;
  const view: PrForge = !who || !approved ? forge : {
    ...forge,
    prApproved: async (n, h) => {
      const f = await who();
      // An answer given without asking the forge counted nobody and left nobody out.
      return "passed" in f ? { ...f, approvers: [], excluded: [] } : approved(n, h, f);
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
