/**
 * The one check a pull request runs: scripts/diff-guard.sh, in seconds.
 *
 * `just ci` renders this into .github/workflows/diff-guard.yml. The test suite
 * and the validation stack run on main's pushes (ci/pipeline.ts), so a pull
 * request waits for nothing heavy. What a merge can break without a test
 * noticing is a squash that undoes a commit main already has, as a rebase
 * that keeps a stale copy of a file does; this check refuses that. The label
 * "revert" lets a pull request that reverts on purpose through.
 */

import { Workflow, Job, Step, Checkout } from "@intentius/chant-lexicon-github";
import { CHECKOUT } from "../workflows/shared";

export const workflow = new Workflow({
  name: "diff-guard",
  on: {
    pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened", "labeled", "unlabeled"] },
  },
  permissions: { contents: "read" },
  concurrency: { group: "diff-guard-${{ github.ref }}", "cancel-in-progress": true },
});

export const diffGuard = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 5,
  steps: [
    // The base branch's history, for the merge base and the commits before it.
    Checkout({ fetchDepth: 0, defaults: { step: { uses: CHECKOUT } } }).step,
    new Step({
      name: "The pull request undoes no commit main has",
      run: 'scripts/diff-guard.sh "origin/$BASE_REF" "$HEAD_SHA"',
      env: {
        BASE_REF: "${{ github.base_ref }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
        DIFF_GUARD_ALLOW: "${{ contains(github.event.pull_request.labels.*.name, 'revert') && '1' || '' }}",
      },
    }),
  ],
});
