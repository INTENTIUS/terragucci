import type { ChantConfig } from "@intentius/chant";
import { ciImages, REGISTRY, imageTag } from "./packages/terragucci/src/images";

/** The Changes page a GitHub release takes its notes from: its `## In <version>` section. */
const CHANGES = "docs-site/src/content/docs/reference/whats-new.mdx";

/**
 * terragucci's own config.
 *
 * The repo declares its workflows (ci/, pages/, image-ci/, publish/) with the
 * github lexicon and its CI images (images/) with the docker lexicon. The
 * kit's lifecycle Ops will add the terraform lexicon when they land.
 */
export default {
  lexicons: ["github", "docker", "otel", "prometheus", "aws"],

  // chant.workspace.json declares no members; it is there for ci.green (the
  // ci/green tags chant-ci-green.yml writes), so chant build and lint keep
  // building this root project alone.
  rootOnly: true,

  // The release (CONTRIBUTING.md, Releasing): chant's cut builds the four CI images as OCI
  // archives and records their digests, the bundle pins them (scripts/build-cli.mjs reads
  // CHANT_RELEASE_DIGESTS), and chant's publish pushes the images, publishes the package and
  // makes the GitHub release. The label is the package version `just version-bump` set.
  // The cut compiles one environment, `release`, which builds nothing but this root's workflows.
  environments: ["release"],
  release: {
    images: ciImages.map((name) => ({ name, build: `scripts/release-image.sh ${name}`, archive: `dist/images/${name}.tar` })),
    publish: [
      ...ciImages.map((name) => ({
        type: "oci" as const,
        image: `dist/images/${name}.tar`,
        repository: `${REGISTRY}/terragucci-${name}`,
        tags: [imageTag(name, "{label}")],
        // The image's SBOM is not the repo's lockfile, so none is attached.
        sbom: false as const,
      })),
      // The package pins the images by the digests the cut recorded; the plan refuses any other.
      { type: "npm" as const, packages: ["packages/terragucci"], access: "public" as const, stage: false, sbom: false as const, pins: "dist/image-digests.json" },
      {
        type: "forge" as const,
        forge: "github" as const,
        repo: "INTENTIUS/terragucci",
        assets: [],
        sbom: false as const,
        notes: {
          file: CHANGES,
          heading: "## In {version}",
          linkBase: "https://intentius.io",
          before: "`@intentius/terragucci@{version}` on npm. Upgrade each repo with `npx @intentius/terragucci@{version} init`, then merge the pipeline it writes.",
          after: "The [Changes page](https://intentius.io/terragucci/reference/whats-new/) lists every release.",
        },
      },
    ],
  },

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
