/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and `just ci-check`
 * fails when the committed file differs from what this renders, so a hand edit
 * to the YAML cannot quietly win over the declaration.
 *
 * CI runs unit tests only, in jobs that run side by side: `static` runs
 * `just check-unit` (the typecheck and the provider's gofmt, vet and tests),
 * and each `test` job runs a third of the unit tests (`just test-shard`, which
 * builds the bundle first). Lint, the docs, the tutorial, the rendered
 * workflows, the chant pipelines, the bundle's shape and the LFS check are in
 * `just check`, which a person runs before pushing. No claim runs in CI: the
 * validation and smoke claims hold a stack and are a person's runs
 * (`just validate-forge`, `just claims`).
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, GO_VERSION, TEST_TERRAGRUNT, installJust, installTerragrunt, installTofu, setupGo } from "../workflows/shared";
import { TOOL_VERSIONS } from "../packages/terragucci/src/images";

export const workflow = new Workflow({
  name: "terragucci",
  on: {
    push: { branches: ["main"] },
    pull_request: {},
    workflow_dispatch: {},
  },
  permissions: { contents: "read" },
  // chant-ci-green.yml tags the main commits that pass ci/green/<sha>
  // (chant.workspace.json's ci.green); it reads main's runs alone, so a pull
  // request's runs tag nothing. A pull request's newer push cancels its run
  // in progress, and so does a branch run by hand (`gh workflow run ci.yml
  // --ref BRANCH`). main's runs all finish. GitHub keeps one run going and one
  // waiting per group, so a burst of merges to main runs the first and the
  // newest, and the commits between are never tagged.
  concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}" },
});

const SETUP = [
  Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
  SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
  installJust(),
];

/** The typecheck and the provider's gofmt, vet and Go tests. */
export const staticChecks = new Job({
  name: "static",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    ...SETUP,
    setupGo(GO_VERSION),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Check", run: "just check-unit" }),
  ],
});

/**
 * The unit tests, a third each. chant.workspace.json's ci.green names each
 * job, so a change to the shard count changes it too. A test that runs the
 * real tofu skips without it, so each job installs it, and Terragrunt off
 * the path for the tests that run it.
 */
export const test = new Job({
  name: "test (${{ matrix.shard }}/3)",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  strategy: {
    "fail-fast": false,
    matrix: { shard: [1, 2, 3] },
  },
  steps: [
    ...SETUP,
    installTofu(TOOL_VERSIONS.tofu),
    installTerragrunt(TOOL_VERSIONS.terragrunt),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Test", run: "just test-shard ${{ matrix.shard }} 3", env: { TERRAGUCCI_TEST_TERRAGRUNT: TEST_TERRAGRUNT } }),
  ],
});
