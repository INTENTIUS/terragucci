/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and `just ci-check`
 * fails when the committed file differs from what this renders, so a hand edit
 * to the YAML cannot quietly win over the declaration.
 *
 * The check job runs `just check`, the same chain a person runs before
 * pushing. The validate jobs boot one profile of the local validation stack
 * each (aws, forgejo, github) and run its claims plain and broken. GitLab is
 * too heavy for every pull request and runs nightly (nightly/pipeline.ts).
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust, installAct } from "../workflows/shared";

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

/**
 * One job per stack profile. Each boots the profile, runs every claim of that
 * forge plain and under BREAK=1 (`just validate-forge`), and removes the stack
 * whatever happened.
 */
const prelude = [
  Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
  SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
  installJust(),
  new Step({ name: "Install", run: "npm ci" }),
];
const start = (forge: string) => new Step({ name: `Start the ${forge} profile`, run: `just stack-up ${forge}` });
const claims = (forge: string) => new Step({ name: `Run the ${forge} claims`, run: `just validate-forge ${forge}` });
const stop = new Step({ name: "Stop the stack", if: "always()", run: "just stack-down" });

export const validateAws = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 15,
  steps: [...prelude, start("aws"), claims("aws"), stop],
});

export const validateForgejo = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 30,
  steps: [...prelude, start("forgejo"), claims("forgejo"), stop],
});

export const validateGithub = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 30,
  steps: [...prelude, installAct(), start("github"), claims("github"), stop],
});
