import type { ChantConfig } from "@intentius/chant";

/**
 * terragucci's own config.
 *
 * Today the repo declares only its two workflows (ci/ and pages/), so the one
 * lexicon it needs is github. The kit's lifecycle Ops will add the terraform
 * lexicon, and the steward preset the fountain lexicon, when they land; see
 * INTENTIUS/chant#3341.
 */
export default {
  lexicons: ["github"],

  lint: {
    rules: {
      // A workflow is a nested object: a job's permissions, environment and
      // `with` block are its shape, not values to lift into exported consts.
      // Same call as fountain-ops.
      COR001: "off",
      // Workflow files export jobs for the build to collect, not for each
      // other, so "never referenced in this file" is the normal case.
      COR004: "off",
    },
  },
} satisfies ChantConfig;
