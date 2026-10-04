/**
 * terragucci's CI images (terragucci#19), built and checked on every change and
 * published on a release tag.
 *
 * `just ci` renders this into .github/workflows/images.yml. The check job
 * builds all three images natively on an amd64 and an arm64 runner, runs each
 * image's tools, and holds each to its size budget. The publish job runs only
 * for a `v*` tag: it pushes both platforms to GHCR with provenance and an
 * SBOM, and prints each image's digest for the release to record.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust } from "../workflows/shared";

export const workflow = new Workflow({
  name: "images",
  on: {
    push: { branches: ["main"], tags: ["v*"] },
    pull_request: {},
    workflow_dispatch: {},
  },
  permissions: { contents: "read" },
  concurrency: { group: "images-${{ github.ref }}", "cancel-in-progress": true },
});

const SETUP = [
  Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
  SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
  new Step({ name: "Install dependencies", run: "npm ci" }),
  installJust(),
];

export const check = new Job({
  name: "check (${{ matrix.platform }})",
  "runs-on": "${{ matrix.runner }}",
  timeoutMinutes: 30,
  strategy: {
    "fail-fast": false,
    matrix: {
      include: [
        { platform: "linux/amd64", runner: "ubuntu-latest" },
        { platform: "linux/arm64", runner: "ubuntu-24.04-arm" },
      ],
    },
  },
  steps: [
    ...SETUP,
    new Step({ name: "Build the images", run: "just images ${{ matrix.platform }}" }),
    new Step({ name: "Run each image's tools and check its size", run: "just images-check ${{ matrix.platform }}" }),
  ],
});

export const publish = new Job({
  needs: "check",
  if: "startsWith(github.ref, 'refs/tags/v')",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 45,
  // The only job that writes: images to this repository's packages.
  permissions: { contents: "read", packages: "write" },
  steps: [
    ...SETUP,
    new Step({ name: "Build the bundle", run: "just build-cli" }),
    new Step({
      name: "Log in to GHCR",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: 'echo "$GH_TOKEN" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin',
    }),
    new Step({
      name: "Push both platforms, with provenance and an SBOM",
      run: [
        "set -eu",
        "docker buildx create --use --name terragucci",
        "npx tsx scripts/images.ts tags | while read -r name ref; do",
        '  docker buildx build --push --platform linux/amd64,linux/arm64 --provenance=true --sbom=true -f "images/Dockerfile.$name" -t "$ref" .',
        '  echo "$ref $(docker buildx imagetools inspect "$ref" --format \'{{json .Manifest.Digest}}\' | tr -d \'"\')"',
        "done",
      ].join("\n"),
    }),
  ],
});
