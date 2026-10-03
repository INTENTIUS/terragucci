/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and `just ci-check`
 * fails when the committed file differs from what this renders, so a hand edit
 * to the YAML cannot quietly win over the declaration.
 *
 * The check job runs `just check`, the same chain a person runs before
 * pushing.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust } from "../workflows/shared";

export const workflow = new Workflow({
  name: "terragucci",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
  permissions: { contents: "read" },
  // A new push to a pull request cancels the run it supersedes.
  concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": true },
});

export const check = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
    installJust(),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Check", run: "just check" }),
    new Step({ name: "Workflows match their declarations", run: "just ci-check" }),
  ],
});
