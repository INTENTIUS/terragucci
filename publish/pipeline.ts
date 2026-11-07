/**
 * Releases terragucci with chant's release block (chant.config.ts `release`,
 * CONTRIBUTING.md, Releasing): one run, started by hand with the version.
 *
 * `just ci` renders this into .github/workflows/publish.yml. npm's trusted
 * publisher is configured for that filename, so the file keeps its name.
 *
 * The jobs are the ones `chant release workflow` writes for `trigger:
 * "dispatch"` (chant issue 4656):
 *
 * - gate: the commit to release is the newest green one at or below the
 *   dispatched commit (`chant ci last-green`). No tag exists before it passes.
 * - cut: `chant release cut <version> --at <commit>` builds the four CI images
 *   as OCI archives and records their digests (`release.images`, chant issue
 *   4657), builds the bundle that pins them, pushes chant/lifecycle, and the
 *   job pushes the `release/<version>` tag the cut made.
 * - publish: `chant release images` builds the images again from the commit
 *   and refuses one whose digest is not the recorded one, the bundle is built
 *   with those digests, and `chant release publish` pushes the images to GHCR,
 *   publishes the package with npm trusted publishing and makes the GitHub
 *   release with its notes from the Changes page (chant issue 4658).
 *
 * It is declared here, not generated, for what chant's generated file cannot
 * say yet (chant issue 4751): the publish job's `packages: write` and the
 * GHCR credentials the oci target reads, QEMU for the arm64 half of each
 * image, and npm 11.5.1 or later for trusted publishing.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, NPM_VERSION, NPM_TRUSTED_PUBLISHING_MIN } from "../workflows/shared";

export const workflow = new Workflow({
  name: "publish",
  on: {
    workflow_dispatch: {
      inputs: {
        version: {
          description: "The version to release, as packages/terragucci/package.json has it on main (just version-bump)",
          required: true,
          type: "string",
        },
      },
    },
  },
  // contents: write for the cut's chant/lifecycle push, its tag and the GitHub release;
  // id-token: write for npm trusted publishing; packages: write for GHCR.
  permissions: { contents: "write", "id-token": "write", packages: "write" },
  concurrency: { group: "publish", "cancel-in-progress": false },
  // The version reaches the shell as a variable, never spliced into a run line.
  env: { CHANT_RELEASE_LABEL: "${{ inputs.version }}" },
});

const COMMIT = "${{ needs.gate.outputs.commit }}";

/** Checkout (full history, for chant's trunk and green checks) and Node, with no npm cache: a release builds from what npm ci resolves now. */
const setup = (ref?: string) => [
  Checkout({ ...(ref ? { ref } : {}), fetchDepth: 0, defaults: { step: { uses: CHECKOUT } } }).step,
  SetupNode({ nodeVersion: NODE_VERSION, registryUrl: "https://registry.npmjs.org", defaults: { step: { uses: SETUP_NODE } } }).step,
  new Step({ name: "Install dependencies", run: "npm ci" }),
];

const fetchLedger = [
  new Step({ name: "Fetch the ci tags", run: "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'" }),
  new Step({ name: "Fetch chant/lifecycle", run: "git fetch origin chant/lifecycle:chant/lifecycle" }),
];

/** QEMU, so a amd64 runner builds the arm64 half of each image. */
const binfmt = new Step({
  name: "Run arm64 images under QEMU",
  run: "docker run --privileged --rm tonistiigi/binfmt:qemu-v9.2.2@sha256:1b804311fe87047a4c96d38b4b3ef6f62fca8cd125265917a9e3dc3c996c39e6 --install arm64",
});

export const gate = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  outputs: { commit: "${{ steps.green.outputs.commit }}" },
  steps: [
    ...setup(),
    fetchLedger[0],
    new Step({
      name: "Name the newest green commit",
      id: "green",
      run: [
        "set -eu",
        `commit="$(npx chant ci last-green --from "$GITHUB_SHA" --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.commit?.sha??""))')"`,
        'if [ -z "$commit" ]; then echo "::error::no green commit at or below $GITHUB_SHA, so nothing is released"; exit 1; fi',
        'version="$(git show "$commit:packages/terragucci/package.json" | node -p \'JSON.parse(require("fs").readFileSync(0,"utf8")).version\')"',
        'if [ "$version" != "$CHANT_RELEASE_LABEL" ]; then echo "::error::$commit is at $version, not $CHANT_RELEASE_LABEL; run just version-bump $CHANT_RELEASE_LABEL and merge it first"; exit 1; fi',
        'echo "commit=$commit" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    }),
  ],
});

export const cut = new Job({
  needs: "gate",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 60,
  env: { CHANT_RELEASE_COMMIT: COMMIT },
  steps: [
    ...setup(COMMIT),
    ...fetchLedger,
    binfmt,
    new Step({
      name: "Cut the release: build the images, record their digests, build the bundle that pins them",
      run: [
        "set -eu",
        'git config user.name "chant release"',
        'git config user.email "chant-release@localhost"',
        'npx chant release cut "$CHANT_RELEASE_LABEL" --at "$CHANT_RELEASE_COMMIT" --yes --build "node scripts/build-cli.mjs" --json > "$RUNNER_TEMP/chant-cut.json"',
        `tag="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag?.name??""))' "$RUNNER_TEMP/chant-cut.json")"`,
        'if [ -n "$tag" ]; then git push origin "refs/tags/$tag"; fi',
      ].join("\n"),
    }),
  ],
});

export const publish = new Job({
  needs: ["gate", "cut"],
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 60,
  // The oci target's credentials: this run's token, which packages: write lets push to GHCR.
  env: { OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" },
  steps: [
    ...setup(COMMIT),
    new Step({
      name: `Use npm ${NPM_TRUSTED_PUBLISHING_MIN} or later, which trusted publishing needs`,
      run: [
        "set -eu",
        'have="$(npm --version)"',
        `if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then`,
        `  echo "npm $have is older than ${NPM_TRUSTED_PUBLISHING_MIN}; installing npm ${NPM_VERSION}"`,
        `  npm install -g npm@${NPM_VERSION}`,
        "fi",
        "npm --version",
      ].join("\n"),
    }),
    ...fetchLedger,
    binfmt,
    new Step({
      name: "Build the images again and check each against the digest the cut recorded",
      run: 'npx chant release images "$CHANT_RELEASE_LABEL" -o .chant/release-digests.json && echo "CHANT_RELEASE_DIGESTS=$PWD/.chant/release-digests.json" >> "$GITHUB_ENV"',
    }),
    new Step({ name: "Build the bundle that pins them", run: "node scripts/build-cli.mjs" }),
    new Step({ name: "Publish: the images to GHCR, the package to npm, the GitHub release", run: 'npx chant release publish "$CHANT_RELEASE_LABEL" --yes' }),
  ],
});
