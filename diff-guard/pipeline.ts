/**
 * A check that the squash undoes nothing: scripts/diff-guard.sh, in seconds.
 * It is a policy check, not a unit test, so it runs by hand only
 * (workflow_dispatch) and no longer on pull requests. Pass the branch to check
 * as the ref (`gh workflow run diff-guard.yml --ref <branch>`); `base` is the
 * branch to compare against, and `allow_revert` replaces the "revert" label.
 *
 * `just ci` renders this into .github/workflows/diff-guard.yml. The test suite
 * runs beside it (ci/pipeline.ts). What a merge can break without a test
 * noticing is a squash that undoes a commit main already has, as a rebase
 * that keeps a stale copy of a file does; this check refuses that. The label
 * "revert" lets a pull request that reverts on purpose through. A second step,
 * scripts/lfs-check.sh, fails a pull request that adds a picture, video or PDF
 * outside Git LFS, or any blob over 512 KB.
 */

import { Workflow, Job, Step, Checkout } from "@intentius/chant-lexicon-github";
import { CHECKOUT } from "../workflows/shared";

export const workflow = new Workflow({
  name: "diff-guard",
  on: {
    workflow_dispatch: {
      inputs: {
        base: { description: "The branch to compare against", required: true, default: "main", type: "string" },
        allow_revert: { description: "Let a deliberate revert through, as the revert label did", required: false, default: false, type: "boolean" },
      },
    },
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
        BASE_REF: "${{ inputs.base }}",
        HEAD_SHA: "${{ github.sha }}",
        DIFF_GUARD_ALLOW: "${{ inputs.allow_revert && '1' || '' }}",
      },
    }),
    // Reads git's objects, so the checkout needs no LFS files.
    new Step({
      name: "The pull request adds no binary outside LFS",
      run: 'scripts/lfs-check.sh "origin/$BASE_REF" "$HEAD_SHA"',
      env: {
        BASE_REF: "${{ inputs.base }}",
        HEAD_SHA: "${{ github.sha }}",
      },
    }),
  ],
});
