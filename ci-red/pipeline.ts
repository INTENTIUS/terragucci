/**
 * Tells people when main stays red, or a green commit is revoked.
 *
 * `just ci` renders this into .github/workflows/ci-red.yml. Every hour, with
 * the job token (no secret), scripts/ci-red reads main and the ci/ tags
 * chant-ci-green.yml writes, and opens, comments on or closes one issue titled
 * "main is red"; GitHub notifies the repo's watchers. Repository variables:
 * TERRAGUCCI_RED_HOURS (how long main may go without a green commit, 6 by
 * default) and TERRAGUCCI_RED_MENTION (people to @-mention when the issue
 * opens).
 */

import { Workflow, Job, Step, Checkout } from "@intentius/chant-lexicon-github";
import { CHECKOUT } from "../workflows/shared";

export const workflow = new Workflow({
  name: "ci-red",
  on: {
    schedule: [{ cron: "23 * * * *" }],
    workflow_dispatch: {},
  },
  permissions: { contents: "read", issues: "write" },
  concurrency: { group: "ci-red", "cancel-in-progress": false },
});

// Not named like a ci.green phase (chant.workspace.json): its runs land on
// main's head commit too.
export const alarm = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 5,
  steps: [
    // All of main and every tag, the ci/ ones among them.
    Checkout({ ref: "main", fetchDepth: 0, defaults: { step: { uses: CHECKOUT } } }).step,
    new Step({
      name: "Open, comment on or close the main is red issue",
      run: "scripts/ci-red",
      env: {
        GH_TOKEN: "${{ github.token }}",
        TERRAGUCCI_RED_HOURS: "${{ vars.TERRAGUCCI_RED_HOURS || '6' }}",
        TERRAGUCCI_RED_MENTION: "${{ vars.TERRAGUCCI_RED_MENTION }}",
      },
    }),
  ],
});
