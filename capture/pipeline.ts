/**
 * The tutorial's captures and the smoke record, refreshed on a schedule.
 *
 * `just ci` renders this into .github/workflows/capture.yml. A GitHub runner
 * has Docker, so it boots the same stack a person does, runs every smoke
 * claim and every validation claim of every forge, captures the tutorial's output and screenshots, and opens a pull
 * request when any of it changed. The pages build only reads what is
 * committed and never boots the stack.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust, installAct } from "../workflows/shared";

export const workflow = new Workflow({
  name: "capture",
  on: {
    workflow_dispatch: {},
    schedule: [{ cron: "17 6 * * 1" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "capture", "cancel-in-progress": false },
});

export const capture = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 120,
  // The only job that writes: a branch and a pull request, never main.
  permissions: { contents: "write", "pull-requests": "write" },
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
    new Step({ name: "Install dependencies", run: "npm ci" }),
    installJust(),
    // The example's pipeline runs in terragucci's CI image; build it here.
    new Step({ name: "Build the CI images", run: "just images" }),
    installAct(),
    new Step({ name: "Record the smoke claims", run: "just smoke-record" }),
    new Step({ name: "Record the validation claims", run: "just validation-record" }),
    new Step({ name: "Capture the tutorial", run: "CHROME=google-chrome just tutorial-capture" }),
    new Step({ name: "Stop the stack", if: "always()", run: "just stack-down" }),
    new Step({
      name: "Open a pull request with what changed",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: [
        "set -eu",
        'if [ -z "$(git status --porcelain docs-site/src/data docs-site/src/assets)" ]; then',
        '  echo "nothing changed"',
        "  exit 0",
        "fi",
        'branch="capture/$(date -u +%Y-%m-%d)-${GITHUB_RUN_ID}"',
        'git config user.name "github-actions[bot]"',
        'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
        'git checkout -b "$branch"',
        "git add docs-site/src/data docs-site/src/assets",
        'git commit -m "docs: refresh the smoke record and tutorial captures"',
        'git push origin "$branch"',
        'gh pr create --base main --head "$branch" --title "docs: refresh the smoke record and tutorial captures" --body "From the capture workflow, run ${GITHUB_RUN_ID}. Review the screenshots before merging."',
      ].join("\n"),
    }),
  ],
});
