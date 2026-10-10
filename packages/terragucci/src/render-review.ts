/**
 * The review workflow's two jobs, `review` and `review-note`, for GitHub and
 * Forgejo (see review-agent.ts for what each does and why there are two),
 * and the review job's script on GitLab (gitlab-agent.ts).
 */
import { Job, Step, Workflow } from "@intentius/chant-lexicon-github/generated/index";
import type { ForgeName } from "./config";
import { READS_EXIT } from "./render";
import { gitlabCleanEnv, RUNNER_TOKEN_VARS } from "./render-agent";
import { REVIEW_ARTIFACT, REVIEW_DIR, REVIEW_FILE, REVIEW_OUT, REVIEW_WORK, type ReviewInput } from "./review-agent";

/** Where the prompt's step puts the plan report it fetches: outside the checkout. */
export const REVIEW_REPORT = `${REVIEW_DIR}/report`;

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The prompt's step: `terragucci review prompt` reads the event, fetches the plan report of the pipeline's run, and reads the checkout's history. */
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

/**
 * The GitLab review job's script (gitlab-agent.ts): read the merge request and
 * its plan report and write the prompt, drop the job token from the remote,
 * then run the review command in the default branch's tree with a cleared
 * environment, since GitLab hands every job the project's variables. The
 * review, its exit code and what was reviewed go to the job's artifact.
 */
export function gitlabReviewScript(review: ReviewInput, artifact: string): string {
  return [
    READS_EXIT,
    `terragucci review prompt --forge gitlab --report ${REVIEW_REPORT} --instructions ${sh(review.instructions)} || exit 1`,
    'git remote set-url origin "$CI_SERVER_URL/$CI_PROJECT_PATH.git"',
    `mkdir -p ${REVIEW_OUT}`,
    `cd ${REVIEW_WORK} || exit 1`,
    `export TG_REVIEW_PROMPT=${REVIEW_DIR}/prompt.md`,
    `${gitlabCleanEnv(review.keySecret)} bash -c ${sh(review.command)} <"$TG_REVIEW_PROMPT" >${REVIEW_OUT}/${REVIEW_FILE}`,
    `echo "$?" >${REVIEW_OUT}/rc`,
    `echo "terragucci review: the review command exited $(cat ${REVIEW_OUT}/rc) and printed $(wc -c <${REVIEW_OUT}/${REVIEW_FILE}) bytes"`,
    `cd "$CI_PROJECT_DIR" && mkdir -p ${artifact} && cp ${REVIEW_OUT}/* ${artifact}/`,
  ].join("\n");
}

/** Minutes the Forgejo review job waits for the pipeline's plan before it reviews without one. */
export const PLAN_WAIT_MINUTES = 30;

/**
 * The review workflow (REVIEW_PATHS): the review and review-note jobs, in a
 * file of their own that the forge runs from the default branch. GitHub runs
 * it on `workflow_run`, once the pipeline's run of a pull request completes;
 * Forgejo, which has no `workflow_run`, on `pull_request_target`, where the
 * prompt's step waits for the pipeline's plan. A pull request's edit of this
 * file does nothing until it merges.
 */
export function reviewWorkflow(forge: Exclude<ForgeName, "gitlab">, image: string, review: ReviewInput, o: { pipelineName: string; env: Record<string, string> }): Map<string, never> {
  const upload = forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4";
  const download = forge === "forgejo" ? "actions/download-artifact@v3" : "actions/download-artifact@v4";
  const github = forge === "github";
  // What the event says was planned: GitHub's workflow_run names the pipeline's run, Forgejo's pull_request_target the pull request.
  const head = github ? "${{ github.event.workflow_run.head_sha }}" : "${{ github.event.pull_request.head.sha }}";
  const pr = github ? "${{ github.event.workflow_run.pull_requests[0].number }}" : "${{ github.event.pull_request.number }}";
  const runs = github
    ? "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name == github.repository && (github.event.workflow_run.conclusion == 'success' || github.event.workflow_run.conclusion == 'failure')"
    : "github.event.pull_request.head.repo.full_name == github.repository";
  const workflow = new Workflow({
    name: "terragucci review",
    on: github
      ? { workflow_run: { workflows: [o.pipelineName], types: ["completed"] } }
      : { pull_request_target: { types: ["opened", "reopened", "synchronize"] } },
    env: o.env,
    permissions: { contents: "read" },
    // A pull_request_target run's ref is the default branch's, so each pull request gets a group of its own, and a later push waits.
    ...(github ? {} : { concurrency: { group: "terragucci-review-${{ github.event.pull_request.number }}", "cancel-in-progress": false } }),
  } as never);
  // The model runs here. The job's token reads the repository and the runs' artifacts; the model's key is in the command's step alone.
  // No oidc, no role, no forge token in the command's step: Forgejo ignores `permissions:`, so the step also drops the runner's token variables.
  const run = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: runs,
    permissions: { contents: "read", actions: "read", "pull-requests": "read" },
    "timeout-minutes": review.timeout + (github ? 0 : PLAN_WAIT_MINUTES),
    steps: [
      // The head, with the whole history and no credentials kept: the diff reads the base, and the instructions and the command's tree come from the default branch. Nothing in the checkout runs.
      new Step({ uses: "actions/checkout@v4", with: { ref: head, "fetch-depth": 0, "persist-credentials": false } }),
      new Step({
        id: "prompt",
        name: "Write the review's prompt: the pull request, its diff and plan, and the default branch's instructions",
        shell: "bash",
        env: { TG_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}", TG_TOKEN: "${{ github.token }}" },
        run: reviewPromptScript(REVIEW_REPORT, review.instructions),
      }),
      new Step({ name: "Run the review command on the prompt", if: "always() && steps.prompt.outcome == 'success'", shell: "bash", env: { [review.keySecret]: `\${{ secrets.${review.keySecret} }}` }, run: reviewRunScript(review.command) }),
      // The verdict a tf-apply wave's policy reads comes from this artifact, once the forge says this workflow's run kept it (reviewOfPull).
      new Step({ name: "Keep the review", if: "always() && steps.prompt.outcome == 'success'", uses: upload, with: { name: `${REVIEW_ARTIFACT}-${head}`, path: `${REVIEW_OUT}/`, "if-no-files-found": "error" } }),
    ],
  } as never);
  // A fresh container that never ran the model: it posts the review as a note, and nothing else.
  const note = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "review",
    if: "always() && (needs.review.result == 'success' || needs.review.result == 'failure')",
    permissions: { "pull-requests": "write" },
    env: { TG_TOKEN: "${{ github.token }}", TG_PR: pr, TG_SHA: head },
    steps: [
      new Step({ name: "Fetch the review", uses: download, with: { name: `${REVIEW_ARTIFACT}-${head}`, path: REVIEW_OUT } }),
      new Step({ name: "Post the review as a note on the pull request", shell: "bash", run: `set -uo pipefail\nterragucci review post --dir ${REVIEW_OUT}` }),
    ],
  } as never);
  return new Map<string, never>([["workflow", workflow as never], ["review", run as never], ["review-note", note as never]]);
}
