/**
 * The review's two jobs, `review` and `review-note`, for GitHub and Forgejo
 * (see review-agent.ts for what each does and why there are two).
 */
import { Job, Step } from "@intentius/chant-lexicon-github/generated/index";
import type { ForgeName } from "./config";
import { READS_EXIT } from "./render";
import { RUNNER_TOKEN_VARS } from "./render-agent";
import { REVIEW_ARTIFACT, REVIEW_DIR, REVIEW_FILE, REVIEW_OUT, REVIEW_WORK, type ReviewInput } from "./review-agent";

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The prompt's step: `terragucci review prompt` reads the event, the checkout's history and the plan report. */
export function reviewPromptScript(report: string, instructions: string): string {
  return ["set -uo pipefail", `terragucci review prompt --report ${report} --instructions ${sh(instructions)}`].join("\n");
}

/**
 * The review command's step. It runs in the default branch's tree with the
 * prompt on stdin, without the runner's token variables; what it prints is
 * the review, and its exit code goes with it. The step's bash runs with
 * `-e`, so the script turns it off to write the exit code of a failed command.
 */
export function reviewRunScript(command: string): string {
  return [
    READS_EXIT,
    // Forgejo's runner puts the job's token in the step's environment and ignores `permissions:`, so the command does not get to see it.
    `unset ${RUNNER_TOKEN_VARS}`,
    `mkdir -p ${REVIEW_OUT}`,
    `cd ${REVIEW_WORK} || exit 1`,
    `export TG_REVIEW_PROMPT=${REVIEW_DIR}/prompt.md`,
    `( ${command} ) <"$TG_REVIEW_PROMPT" >${REVIEW_OUT}/${REVIEW_FILE}`,
    `echo "$?" >${REVIEW_OUT}/rc`,
    `echo "terragucci review: the review command exited $(cat ${REVIEW_OUT}/rc) and printed $(wc -c <${REVIEW_OUT}/${REVIEW_FILE}) bytes"`,
  ].join("\n");
}

export function reviewJobs(forge: Exclude<ForgeName, "gitlab">, image: string, review: ReviewInput, o: { sameRepo: string; reportDir: string }): [string, never][] {
  const upload = forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4";
  const download = forge === "forgejo" ? "actions/download-artifact@v3" : "actions/download-artifact@v4";
  // The model runs here. The job's token reads the repository; the model's key is in the command's step alone.
  // No oidc, no role, no forge token in the command's step: Forgejo ignores `permissions:`, so the step also drops the runner's token variables.
  const run = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "plan",
    if: `always() && (needs.plan.result == 'success' || needs.plan.result == 'failure') && github.event_name == 'pull_request' && ${o.sameRepo}`,
    permissions: { contents: "read" },
    "timeout-minutes": review.timeout,
    steps: [
      // The whole history: the diff reads the base, and the instructions and the command's tree come from the default branch.
      new Step({ uses: "actions/checkout@v4", with: { ref: "${{ github.event.pull_request.head.sha }}", "fetch-depth": 0, "persist-credentials": false } }),
      new Step({ name: "Fetch the plan report", uses: download, "continue-on-error": true, with: { name: o.reportDir, path: o.reportDir } } as never),
      // Forgejo ignores continue-on-error, so a plan job that kept no report still gets a review, of the diff and the description.
      new Step({
        id: "prompt",
        name: "Write the review's prompt: the pull request, its diff and plan, and the default branch's instructions",
        if: "always()",
        shell: "bash",
        env: { TG_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" },
        run: reviewPromptScript(o.reportDir, review.instructions),
      }),
      new Step({ name: "Run the review command on the prompt", if: "always() && steps.prompt.outcome == 'success'", shell: "bash", env: { [review.keySecret]: `\${{ secrets.${review.keySecret} }}` }, run: reviewRunScript(review.command) }),
      // The verdict a tf-apply wave's policy reads comes from this artifact, bound by the forge to this run and its head (reviewOfPull).
      new Step({ name: "Keep the review", if: "always() && steps.prompt.outcome == 'success'", uses: upload, with: { name: REVIEW_ARTIFACT, path: `${REVIEW_OUT}/`, "if-no-files-found": "error" } }),
    ],
  } as never);
  // A fresh container that never ran the model: it posts the review as a note, and nothing else.
  const note = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "review",
    if: "always() && (needs.review.result == 'success' || needs.review.result == 'failure')",
    permissions: { "pull-requests": "write" },
    env: { TG_TOKEN: "${{ github.token }}", TG_PR: "${{ github.event.pull_request.number }}", TG_SHA: "${{ github.event.pull_request.head.sha }}" },
    steps: [
      new Step({ name: "Fetch the review", uses: download, with: { name: REVIEW_ARTIFACT, path: REVIEW_OUT } }),
      new Step({ name: "Post the review as a note on the pull request", shell: "bash", run: `set -uo pipefail\nterragucci review post --dir ${REVIEW_OUT}` }),
    ],
  } as never);
  return [["review", run as never], ["review-note", note as never]];
}
