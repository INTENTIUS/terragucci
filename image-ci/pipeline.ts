/**
 * terragucci's CI images (terragucci#19), built and checked by hand
 * (workflow_dispatch). The build and size check are not unit tests, so they
 * do not run on pull requests or pushes to main.
 *
 * `just ci` renders this into .github/workflows/images.yml. The check job
 * builds all four images natively on an amd64 and an arm64 runner, runs each
 * image's tools, and holds each to its size budget. A release builds and
 * pushes them itself (chant.config.ts `release`, rendered to publish.yml).
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust } from "../workflows/shared";

export const workflow = new Workflow({
  name: "images",
  on: {
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
