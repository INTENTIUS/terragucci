import type { ChantConfig } from "@intentius/chant";
import { ciImages, IMAGE_BASES, REGISTRY, imageTag, releaseImageName } from "./packages/terragucci/src/images";

/** Each image in each set: the Debian image `tofu` and the Chainguard image `tofu-chainguard`, as the release names them. */
const releaseImages = IMAGE_BASES.flatMap((base) => ciImages.map((name) => ({ name, base, release: releaseImageName(name, base), file: `Dockerfile.${name}${base === "chainguard" ? "Chainguard" : ""}` })));

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
  // ci/green tags chant-ci-green.yml writes, which scripts/ci-red reads), so
  // chant build and lint keep building this root project alone.
  rootOnly: true,

  // The declarations chant builds from this root when no directory is named: the release cut's compile (chant release
  // compile) reads them. Without it the build loads every .ts in the repo, scripts included, and a script that runs on
  // load (scripts/coverage-gaps.ts --json) prints and exits in the compile's place.
  sourceDir: "ci",

  // The harness scenarios' overlays hold terragucci.component.ts files written for the scenario's own repo, gated on
  // that repo's environments. They are not this root's components, so chant's discovery here (the build's check of
  // the environments a gate names, chant components) leaves them out.
  exclude: ["stack/harness/scenarios"],

  // The release (CONTRIBUTING.md, Releasing): chant's cut builds the four CI images in each of two sets, Debian and
  // Chainguard, as OCI archives and records their digests, the bundle pins them (scripts/build-cli.mjs reads
  // CHANT_RELEASE_DIGESTS), and chant's publish pushes the images, publishes the package and
  // makes the GitHub release. The label is the version: the cut and the publish job stamp it into
  // packages/terragucci/package.json and the lockfile (release.version), so main keeps its committed version.
  // The cut compiles one environment, `release`, which builds nothing but this root's workflows.
  environments: ["release"],
  release: {
    // The release's label is the package's version for the cut's build and the publish (chant issue 4840). The images
    // take it as the CHANT_RELEASE_LABEL build argument for their version label.
    version: { packages: ["packages/terragucci"] },
    // The cut tags v<version>. Releases 0.4.50 to 0.4.62 were tagged release/<version>, and chant still reads those.
    tag: "v{version}",
    legacyTags: ["release/"],
    // The cut releases a commit whose GitHub checks passed, the ruleset's required `static` and `test (n/3)` among
    // them. The ci/green tags stay for scripts/ci-red alone; the release does not read them.
    green: "forge-checks",
    // .github/workflows/publish.yml, from `chant release workflow` (chant issues 4656 and 4751): one run, started by
    // hand with the version. The gate hands on the dispatched commit, the cut checks its checks, builds the
    // images and the bundle that pins them and pushes the v<version> tag, and the publish job takes the cut's
    // image archives, checks them against its digests and publishes. npm's trusted publisher is configured for publish.yml.
    workflow: {
      trigger: "dispatch",
      install: "npm ci",
      build: "node scripts/build-cli.mjs",
      chant: "npx chant",
      // chant adds packages: write and this run's token for the GHCR oci targets, and npm 11.5.1 or later for
      // trusted publishing, from the targets (chant issue 4786), and QEMU for the arm64 half of each image
      // (chant issue 4876).
      file: ".github/workflows/publish.yml",
    },
    // chant builds each image from its Dockerfile (chant issue 4819): reproducibly, as an OCI archive at
    // dist/images/<name>.tar, after the bundle the image copies in is built with no digests file named.
    // TERRAGUCCI_IMAGE_PLATFORMS narrows the platforms for a local build.
    //
    // Eight images: each of the four on Debian and on Chainguard's public images, whose bases the Dockerfiles pin by digest
    // (a release under supply-chain refuses a FROM that is not pinned). The Chainguard set needs no pull login. A
    // Chainguard org's registry takes a `pull` entry on each Chainguard image here (registry cgr.dev, usernameEnv and
    // passwordEnv naming secrets) and `base: { registry }` in images/stages.ts; see CONTRIBUTING.md.
    images: releaseImages.map(({ release, file }) => ({
      name: release,
      dockerfile: `images/${file}`,
      prepare: "node scripts/build-cli.mjs >/dev/null",
      ...(process.env.TERRAGUCCI_IMAGE_PLATFORMS ? { platforms: process.env.TERRAGUCCI_IMAGE_PLATFORMS.split(",") } : {}),
    })),
    publish: [
      // Both sets go to the same repository, the Chainguard tags ending in -chainguard. The image's SBOM is the one the
      // scan makes from its layers (supply-chain), so each lists the OS packages of its base.
      ...releaseImages.map(({ name, base, release }) => ({
        type: "oci" as const,
        image: `dist/images/${release}.tar`,
        repository: `${REGISTRY}/terragucci-${name}`,
        tags: [imageTag(name, "{label}", base)],
      })),
      // The package pins the images of both sets by the digests the cut recorded; the plan refuses any other. Its SBOM
      // is the one scripts/build-cli.mjs writes for a release build (packages/terragucci/sbom.spdx.json).
      { type: "npm" as const, packages: ["packages/terragucci"], access: "public" as const, stage: false, pins: "dist/image-digests.json" },
      {
        type: "forge" as const,
        forge: "github" as const,
        repo: "INTENTIUS/terragucci",
        assets: [],
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
