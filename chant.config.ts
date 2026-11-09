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

  // The declarations chant builds from this root when no directory is named: the release cut's compile (chant release
  // compile) reads them. Without it the build loads every .ts in the repo, scripts included, and a script that runs on
  // load (scripts/coverage-gaps.ts --json) prints and exits in the compile's place.
  sourceDir: "ci",

  // The release (CONTRIBUTING.md, Releasing): chant's cut builds the four CI images as OCI
  // archives and records their digests, the bundle pins them (scripts/build-cli.mjs reads
  // CHANT_RELEASE_DIGESTS), and chant's publish pushes the images, publishes the package and
  // makes the GitHub release. The label is the version: the cut and the publish job stamp it into
  // packages/terragucci/package.json and the lockfile (release.version), so main keeps its committed version.
  // The cut compiles one environment, `release`, which builds nothing but this root's workflows.
  environments: ["release"],
  release: {
    // The release's label is the package's version for the cut's build and the publish (chant issue 4840). The images
    // take it as the CHANT_RELEASE_LABEL build argument for their version label.
    version: { packages: ["packages/terragucci"] },
    // .github/workflows/publish.yml, from `chant release workflow` (chant issues 4656 and 4751): one run, started by
    // hand with the version. The gate names the newest green commit at or below the dispatched one, the cut builds the
    // images and the bundle that pins them and pushes the release/<version> tag, and the publish job takes the cut's
    // image archives, checks them against its digests and publishes. npm's trusted publisher is configured for publish.yml.
    workflow: {
      trigger: "dispatch",
      gate: "last-green",
      install: "npm ci",
      build: "node scripts/build-cli.mjs",
      chant: "npx chant",
      // chant adds packages: write and this run's token for the GHCR oci targets, and npm 11.5.1 or later for
      // trusted publishing, from the targets (chant issue 4786).
      setup: [
        // QEMU, so an amd64 runner builds the arm64 half of each image.
        { uses: "docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0", with: { platforms: "arm64" } },
      ],
      file: ".github/workflows/publish.yml",
    },
    // chant builds each image from its Dockerfile (chant issue 4819): reproducibly, as an OCI archive at
    // dist/images/<name>.tar, after the bundle the image copies in is built with no digests file named.
    // TERRAGUCCI_IMAGE_PLATFORMS narrows the platforms for a local build.
    images: ciImages.map((name) => ({
      name,
      dockerfile: `images/Dockerfile.${name}`,
      prepare: "node scripts/build-cli.mjs >/dev/null",
      ...(process.env.TERRAGUCCI_IMAGE_PLATFORMS ? { platforms: process.env.TERRAGUCCI_IMAGE_PLATFORMS.split(",") } : {}),
    })),
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
