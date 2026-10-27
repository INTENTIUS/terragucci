/**
 * terragucci's words for chant's product pipeline (chant#4550,
 * terragucci#1282): the names terragucci shows people, which chant fills into
 * its own statuses, comment grammar, approve lines and note.
 *
 * Every name is the one terragucci has always used, so branch protection that
 * requires `terragucci/plan`, comments written `/terragucci apply wave-2`, and
 * the approvals already on `_gates/tf-apply.jsonl` under `wave-<k>` keep
 * counting across the switch.
 *
 * chant reads these through `@intentius/chant/ci-product` when the installed
 * chant has it (./chant-next.ts, `chantCiProduct`); on a chant without it
 * terragucci's own code renders the same names.
 */
import { chantCiProductWordsNow } from "./chant-next";

/** ./comment.ts ATLANTIS_COMMENTS_ENV, written out so comment.ts can import this file without a cycle. */
const ATLANTIS_COMMENTS_ENV = "TG_ATLANTIS_COMMENTS";

/** The op the waves record under: their gates stay `tf-apply` / `wave-<k>`. Kept in step with ./chant-waves.ts WAVES_OP. */
const WAVES_OP = "tf-apply";

/**
 * The words, in the shape of chant's `CiProductWordsInput`. Written out
 * here, not typed from chant, so this file compiles on a chant without the
 * product pipeline.
 */
export const TERRAGUCCI_WORDS = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan", apply: "apply", lock: "lock", unlock: "unlock", agent: "agent" } as Record<string, "plan" | "apply" | "lock" | "unlock" | "agent">,
  // atlantis_comments: true sets TG_ATLANTIS_COMMENTS=1 on every job, and only then do these read as terragucci's.
  aliases: [
    { from: "atlantis plan", command: "plan" as const, when: ATLANTIS_COMMENTS_ENV },
    { from: "atlantis apply", command: "apply" as const, when: ATLANTIS_COMMENTS_ENV },
  ],
  approve: "terragucci approve {gate} --plan {digest} {sign}",
  op: WAVES_OP,
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  adoptMarkers: ["<!-- terragucci:waves -->"],
  bin: "npx --no-install terragucci",
};

/**
 * terragucci's status context for a stage: `terragucci/plan`,
 * `terragucci/apply`, `terragucci/lock`. With chant's words module loaded
 * (./chant-next.ts) chant's `productStatusContext` names it from
 * TERRAGUCCI_WORDS, which gives the same context.
 */
export function terragucciStatus(stage: "plan" | "apply" | "lock" | "approval" | "control"): string {
  const chant = chantCiProductWordsNow();
  return chant ? chant.productStatusContext(chant.assertProductWords(TERRAGUCCI_WORDS), stage) : `${TERRAGUCCI_WORDS.product}/${stage}`;
}
