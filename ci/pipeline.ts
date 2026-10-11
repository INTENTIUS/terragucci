/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and `just ci-check`
 * fails when the committed file differs from what this renders, so a hand edit
 * to the YAML cannot quietly win over the declaration.
 *
 * The check job runs `just check`, the same chain a person runs before
 * pushing. No claim runs in CI: the validation and smoke claims hold a stack
 * and are a person's runs (`just validate-forge`, `just claims`).
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, GO_VERSION, installJust, installTofu, installGo } from "../workflows/shared";
import { TOOL_VERSIONS } from "../packages/terragucci/src/images";

export const workflow = new Workflow({
  name: "terragucci",
  on: {
    push: { branches: ["main"] },
    workflow_dispatch: {},
  },
  permissions: { contents: "read" },
  // main's pushes only, never pull requests: merges land without waiting for
  // a run each, and chant-ci-green.yml tags the commits that pass ci/green/<sha>
  // (chant.workspace.json's ci.green). A branch runs by hand:
  // `gh workflow run ci.yml --ref BRANCH`, and a newer one cancels its run in
  // progress. main's runs all finish. GitHub keeps one run going and one
  // waiting per group, so a burst of merges to main runs the first and the
  // newest, and the commits between are never tagged.
  concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}" },
});

export const check = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
    installJust(),
    installTofu(TOOL_VERSIONS.tofu),
    installGo(GO_VERSION),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Check", run: "just check" }),
    new Step({ name: "Workflows match their declarations", run: "just ci-check" }),
  ],
});
