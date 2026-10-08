/**
 * The scale bench, rerun for each release.
 *
 * `just ci` renders this into .github/workflows/scale.yml. When a release is
 * published, the job boots the bench's own stack (stack/scale/), runs a
 * terralith of 10,069 resources carved into 1,361 roots across 12 repos
 * through the pipeline that release generates, and opens a pull request with
 * the run's record in docs-site/src/data/scale.json, the numbers the Scale
 * page states. A failed run fails the job and opens nothing, so the page keeps
 * the last numbers a run proved. Dispatch it by hand to run another scale or
 * release.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, UPLOAD_ARTIFACT, installJust } from "../workflows/shared";

export const workflow = new Workflow({
  name: "scale",
  on: {
    release: { types: ["published"] },
    workflow_dispatch: {
      inputs: {
        scale: {
          description: "The terralith scale: 136 is 10,069 resources, 1 is 79",
          required: true,
          default: "136",
          type: "string",
        },
        release: {
          description: "The published release to measure; empty for the newest",
          required: false,
          default: "",
          type: "string",
        },
      },
    },
  },
  permissions: { contents: "read" },
  concurrency: { group: "scale", "cancel-in-progress": false },
});

export const scale = new Job({
  "runs-on": "ubuntu-latest",
  // A hosted runner's limit is six hours.
  timeoutMinutes: 355,
  // The only step that writes: a branch and a pull request, never main.
  permissions: { contents: "write", "pull-requests": "write" },
  env: {
    TGSCALE_RELEASE: "${{ github.event.release.tag_name && github.event.release.tag_name || inputs.release }}",
    SCALE: "${{ inputs.scale || '136' }}",
  },
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, defaults: { step: { uses: SETUP_NODE } } }).step,
    installJust(),
    new Step({ name: "Start the bench's stack", run: "just scale up" }),
    new Step({
      name: "Run the bench",
      run: ['export TGSCALE_RELEASE="${TGSCALE_RELEASE#v}"', 'just scale run "$SCALE"', "just scale record"].join("\n"),
    }),
    new Step({ name: "Stop the bench's stack", if: "always()", run: "just scale down" }),
    new Step({
      name: "Keep the record",
      if: "always()",
      uses: UPLOAD_ARTIFACT,
      with: { name: "scale-record", path: "stack/scale/.state/runs/", "if-no-files-found": "ignore", "retention-days": 90 },
    }),
    new Step({
      name: "Open a pull request with the record",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: [
        "set -eu",
        'if [ -z "$(git status --porcelain docs-site/src/data/scale.json)" ]; then',
        '  echo "nothing changed"',
        "  exit 0",
        "fi",
        'branch="scale/$(date -u +%Y-%m-%d)-${GITHUB_RUN_ID}"',
        'git config user.name "github-actions[bot]"',
        'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
        'git checkout -b "$branch"',
        "git add docs-site/src/data/scale.json",
        'git commit -m "docs: the scale bench record for $(jq -r \'.runs[-1].release\' docs-site/src/data/scale.json)"',
        'git push origin "$branch"',
        'gh pr create --base main --head "$branch" --title "docs: the scale bench record" --body "From the scale workflow, run ${GITHUB_RUN_ID}."',
      ].join("\n"),
    }),
  ],
});
