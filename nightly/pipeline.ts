/**
 * The validation claims that are too heavy for every push to main, run nightly.
 *
 * `just ci` renders this into .github/workflows/nightly.yml. GitLab CE is
 * several gigabytes and boots in minutes; a GitHub runner is amd64, which is
 * the image's own architecture, so nothing is emulated here.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust } from "../workflows/shared";

export const workflow = new Workflow({
  name: "nightly",
  on: {
    workflow_dispatch: {},
    schedule: [{ cron: "41 3 * * *" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "nightly", "cancel-in-progress": false },
});

export const gitlab = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 90,
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
    installJust(),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Start the gitlab profile", run: "just stack-up gitlab" }),
    new Step({ name: "Run the gitlab claims", run: "just validate-forge gitlab" }),
    new Step({ name: "Stop the stack", if: "always()", run: "just stack-down" }),
  ],
});
