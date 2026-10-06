import type { ChantConfig } from "@intentius/chant";

/**
 * terragucci's own config.
 *
 * The repo declares its workflows (ci/, pages/, capture/, image-ci/, publish/) with the
 * github lexicon and its CI images (images/) with the docker lexicon. The
 * kit's lifecycle Ops will add the terraform lexicon when they land.
 */
export default {
  lexicons: ["github", "docker", "otel", "prometheus"],

  lint: {
    rules: {
      // A workflow is a nested object: a job's permissions, environment and
      // `with` block are its shape, not values to lift into exported consts.
      // Same call as fountain-ops.
      COR001: "off",
      // Workflow files export jobs for the build to collect, not for each
      // other, so "never referenced in this file" is the normal case.
      COR004: "off",
      // CI images run as root: GitHub runs container jobs as root and
      // actions/checkout writes the mounted workspace, and GitLab and Forgejo
      // jobs expect the same. The images hold no secrets of their own.
      DKRD012: "off",
    },
  },
} satisfies ChantConfig;
