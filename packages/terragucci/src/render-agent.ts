/**
 * The agent comment's two jobs, `agent` and `agent-push`, for GitHub and
 * Forgejo (see agent-comment.ts for what each does and why there are two),
 * and their scripts on GitLab, where the comments job starts them in a
 * pipeline of the default branch (gitlab-agent.ts).
 */
import { Job, Step } from "@intentius/chant-lexicon-github/generated/index";
import { AGENT_CHANGE_DIR, AGENT_DECISION_JS, AGENT_DIR, type AgentCommentInput } from "./agent-comment";
import type { ForgeName } from "./config";
import { READS_EXIT } from "./render";

/** Comments the agent job reads. The replan job leaves them alone when the agent comment is on. */
export const AGENT_COMMENT_IF = "startsWith(github.event.comment.body, '/terragucci agent ')";

/** Variables a runner may set to the job's own token or to its artifact and identity services. The agent's step runs without them. */
export const RUNNER_TOKEN_VARS = "GITHUB_TOKEN FORGEJO_TOKEN GITEA_TOKEN ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL";

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The agent job's first step: `terragucci comment --agent run` decides, with
 * the re-plan's checks, and writes the prompt. The step's outputs are the only
 * values later steps and the push job take from it.
 */
export function agentAskScript(forge: ForgeName, policyDir: string): string {
  return [
    "set -uo pipefail",
    `mkdir -p ${AGENT_DIR}`,
    `terragucci comment --agent run${forge === "forgejo" ? " --forge forgejo" : ""} --policy-dir ${sh(policyDir)} --out ${AGENT_DIR}/decision.json --prompt ${AGENT_DIR}/prompt.md || exit 1`,
    "read -r TG_PR TG_SHA TG_HEAD <<EOF",
    `$(node -e '${AGENT_DECISION_JS}' ${AGENT_DIR}/decision.json)`,
    "EOF",
    '[ -n "$TG_PR" ] || exit 0',
    '{ echo "go=1"; echo "pr=$TG_PR"; echo "sha=$TG_SHA"; echo "head=$TG_HEAD"; } >>"$GITHUB_OUTPUT"',
  ].join("\n");
}

/**
 * The agent's step: the command runs in the checkout with the prompt on
 * stdin, and what it changed against the pull request's head becomes a patch.
 * Its exit code goes with the patch; a failed agent pushes nothing, and the
 * push job's reply says it stopped. The step's bash runs with `-e`, which
 * would end it at a failed agent before the exit code is written, so the
 * script turns `-e` off and stops on a failed `git` itself.
 */
export function agentRunScript(command: string): string {
  return [
    READS_EXIT,
    `mkdir -p ${AGENT_CHANGE_DIR}`,
    'if [ "$(git rev-parse HEAD)" != "$TG_SHA" ]; then',
    `  echo moved >${AGENT_CHANGE_DIR}/rc`,
    '  echo "terragucci: the pull request moved after the comment was read" >&2',
    "  exit 0",
    "fi",
    // Forgejo's runner puts the job's token in the step's environment and ignores \`permissions:\`, so the agent does not get to see it.
    `unset ${RUNNER_TOKEN_VARS}`,
    `export TG_AGENT_PROMPT=${AGENT_DIR}/prompt.md`,
    `( ${command} ) <"$TG_AGENT_PROMPT"`,
    `echo "$?" >${AGENT_CHANGE_DIR}/rc`,
    "git -c core.hooksPath=/dev/null add -A || exit 1",
    `git -c core.hooksPath=/dev/null diff --cached --binary --no-renames "$TG_SHA" >${AGENT_CHANGE_DIR}/change.patch || exit 1`,
    `git -c core.hooksPath=/dev/null diff --cached --stat "$TG_SHA"`,
  ].join("\n");
}

/** The variables the agent's command keeps on GitLab, where every job holds the project's variables: the environment is cleared but for these and the model's key. */
export const GL_AGENT_ENV = ["PATH", "HOME", "LANG", "TG_AGENT_PROMPT", "TG_AGENT_MAX_TURNS", "TG_REVIEW_PROMPT"];

/** `env -i` with the variables GitLab's agent and review commands keep, and the model's key. */
export function gitlabCleanEnv(keySecret: string): string {
  return ["env -i", ...[...GL_AGENT_ENV, keySecret].map((v) => `${v}="\${${v}:-}"`)].join(" ");
}

/**
 * The GitLab agent job's script (gitlab-agent.ts): read the ask again, check
 * out the merge request's head, drop the job token from the remote, and run
 * the agent with a cleared environment. GitLab hands every job the project's
 * variables, so the agent sees none of them: only the model's key, the
 * prompt and the turns. The change and the agent's exit code go to the job's
 * artifact; an ask that no longer stands leaves `moved`, and the push job
 * reads the ask again and says why.
 */
export function gitlabAgentRunScript(agent: AgentCommentInput, artifact: string): string {
  return [
    READS_EXIT,
    `mkdir -p ${AGENT_CHANGE_DIR}`,
    `terragucci comment --forge gitlab --agent run --policy-dir ${sh(agent.policyDir)} --out ${AGENT_DIR}/decision.json --prompt ${AGENT_DIR}/prompt.md || exit 1`,
    "read -r TG_PR TG_SHA TG_HEAD <<EOF",
    `$(node -e '${AGENT_DECISION_JS}' ${AGENT_DIR}/decision.json)`,
    "EOF",
    'if [ -z "$TG_PR" ]; then',
    `  echo moved >${AGENT_CHANGE_DIR}/rc`,
    "else",
    '  git -c core.hooksPath=/dev/null fetch -q origin "+refs/merge-requests/$TG_PR/head:refs/terragucci/agent-head" || exit 1',
    '  git -c core.hooksPath=/dev/null checkout -q --detach "$TG_SHA" || exit 1',
    '  git remote set-url origin "$CI_SERVER_URL/$CI_PROJECT_PATH.git"',
    `  export TG_AGENT_PROMPT=${AGENT_DIR}/prompt.md`,
    `  ${gitlabCleanEnv(agent.keySecret)} bash -c ${sh(agent.command)} <"$TG_AGENT_PROMPT"`,
    `  echo "$?" >${AGENT_CHANGE_DIR}/rc`,
    "  git -c core.hooksPath=/dev/null add -A || exit 1",
    `  git -c core.hooksPath=/dev/null diff --cached --binary --no-renames "$TG_SHA" >${AGENT_CHANGE_DIR}/change.patch || exit 1`,
    '  git -c core.hooksPath=/dev/null diff --cached --stat "$TG_SHA"',
    "fi",
    // After the diff, so the artifact's directory is never part of the change.
    `mkdir -p "$CI_PROJECT_DIR/${artifact}" && cp ${AGENT_CHANGE_DIR}/* "$CI_PROJECT_DIR/${artifact}/"`,
  ].join("\n");
}

/** The GitLab agent-push job's script: read the ask again with the push token, apply, guard, commit, push and reply (pushGitLabAgentChange). */
export function gitlabAgentPushScript(policyDir: string, artifact: string): string {
  return ["set -uo pipefail", `terragucci comment --forge gitlab --agent push --change ${artifact} --policy-dir ${sh(policyDir)}`].join("\n");
}

/** The push job's step: apply, guard, commit, push and reply (`pushAgentChange`). */
export function agentPushScript(policyDir: string): string {
  return ["set -uo pipefail", `terragucci comment --agent push --change ${AGENT_CHANGE_DIR} --policy-dir ${sh(policyDir)}`].join("\n");
}

export function agentCommentJobs(forge: Exclude<ForgeName, "gitlab">, image: string, agent: AgentCommentInput): [string, never][] {
  const upload = forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4";
  const download = forge === "forgejo" ? "actions/download-artifact@v3" : "actions/download-artifact@v4";
  const secret = (name: string): string => `\${{ secrets.${name} }}`;
  // The agent runs here. The job's token reads the pull request and answers a refusal; it cannot push.
  // No oidc, no role, no forge token in the agent's step: the model's key is all it holds.
  // Forgejo ignores `permissions:`, so the step also drops the runner's own token variables (agentRunScript).
  const run = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'issue_comment' && ${AGENT_COMMENT_IF}`,
    permissions: { contents: "read", "pull-requests": "write" },
    "timeout-minutes": agent.timeout,
    concurrency: { group: "terragucci-agent-${{ github.repository }}-${{ github.event.issue.number }}", "cancel-in-progress": false },
    outputs: {
      go: "${{ steps.ask.outputs.go }}",
      pr: "${{ steps.ask.outputs.pr }}",
      sha: "${{ steps.ask.outputs.sha }}",
      head: "${{ steps.ask.outputs.head }}",
    },
    steps: [
      new Step({ id: "ask", name: "Read the comment and write the agent's prompt", shell: "bash", env: { TG_TOKEN: "${{ github.token }}" }, run: agentAskScript(forge, agent.policyDir) }),
      // The head comes from the pull request, by number; the checkout keeps no credentials for the agent to find.
      new Step({ name: "Check out the pull request's head", if: "steps.ask.outputs.go == '1'", uses: "actions/checkout@v4", with: { ref: "refs/pull/${{ steps.ask.outputs.pr }}/head", "persist-credentials": false } }),
      new Step({
        name: "Run the agent on the ask",
        if: "steps.ask.outputs.go == '1'",
        shell: "bash",
        env: { TG_SHA: "${{ steps.ask.outputs.sha }}", TG_AGENT_MAX_TURNS: String(agent.maxTurns), [agent.keySecret]: secret(agent.keySecret) },
        run: agentRunScript(agent.command),
      }),
      new Step({ name: "Keep the agent's change", if: "steps.ask.outputs.go == '1'", uses: upload, with: { name: "terragucci-agent", path: `${AGENT_CHANGE_DIR}/`, "if-no-files-found": "error" } }),
    ],
  } as never);
  // A fresh container that never ran the agent: it holds the push token, applies the patch, and refuses a forbidden path.
  const push = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "agent",
    if: "needs.agent.outputs.go == '1'",
    permissions: { contents: "read" },
    concurrency: { group: "terragucci-agent-push-${{ github.repository }}-${{ github.event.issue.number }}", "cancel-in-progress": false },
    env: {
      TG_TOKEN: secret(agent.tokenSecret),
      TG_PR: "${{ needs.agent.outputs.pr }}",
      TG_SHA: "${{ needs.agent.outputs.sha }}",
      TG_HEAD: "${{ needs.agent.outputs.head }}",
    },
    steps: [
      new Step({ name: "Check out the pull request's head", uses: "actions/checkout@v4", with: { ref: "refs/pull/${{ needs.agent.outputs.pr }}/head", "persist-credentials": false } }),
      new Step({ name: "Fetch the agent's change", uses: download, with: { name: "terragucci-agent", path: AGENT_CHANGE_DIR } }),
      new Step({ name: "Push the change to the pull request's branch, unless it touches CI, terragucci.yml or the policy", shell: "bash", run: agentPushScript(agent.policyDir) }),
    ],
  } as never);
  return [["agent", run as never], ["agent-push", push as never]];
}

/**
 * `agent.drift`'s two jobs, `drift-agent` and `drift-agent-push`, after the
 * drift job (see drift-agent.ts). They run when the drift job opened the
 * drift issue, on the commit it planned, from its report artifact.
 */
export function driftAgentJobs(forge: Exclude<ForgeName, "gitlab">, image: string, agent: AgentCommentInput, reportArtifact: string): [string, never][] {
  const upload = forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4";
  const download = forge === "forgejo" ? "actions/download-artifact@v3" : "actions/download-artifact@v4";
  const secret = (name: string): string => `\${{ secrets.${name} }}`;
  const opened = "needs.drift.outputs.agent == '1'";
  // The agent runs here: a read-only job token, which its step runs without; no oidc and no role, whatever the drift job holds.
  const run = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "drift",
    if: opened,
    permissions: { contents: "read" },
    "timeout-minutes": agent.timeout,
    concurrency: { group: "terragucci-drift-agent-${{ github.repository }}", "cancel-in-progress": false },
    steps: [
      // The commit the drift job planned; the checkout keeps no credentials for the agent to find.
      new Step({ name: "Check out the commit the drift job planned", uses: "actions/checkout@v4", with: { ref: "${{ github.sha }}", "persist-credentials": false } }),
      new Step({ name: "Fetch the drift report", uses: download, with: { name: reportArtifact, path: `${AGENT_DIR}/drift` } }),
      new Step({ name: "Write the agent's prompt from the drift report", shell: "bash", run: driftPromptScript(agent.policyDir) }),
      new Step({
        name: "Run the agent on the drift",
        shell: "bash",
        env: { TG_SHA: "${{ github.sha }}", TG_AGENT_MAX_TURNS: String(agent.maxTurns), [agent.keySecret]: secret(agent.keySecret) },
        run: agentRunScript(agent.command),
      }),
      new Step({ name: "Keep the agent's change", uses: upload, with: { name: "terragucci-drift-agent", path: `${AGENT_CHANGE_DIR}/`, "if-no-files-found": "error" } }),
    ],
  } as never);
  // A fresh container that never ran the agent: it holds the agent's token, applies the patch, refuses a forbidden path and opens the pull request.
  const push = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: ["drift", "drift-agent"],
    if: opened,
    permissions: { contents: "read" },
    concurrency: { group: "terragucci-drift-agent-push-${{ github.repository }}", "cancel-in-progress": false },
    env: { TG_TOKEN: secret(agent.tokenSecret), TG_SHA: "${{ github.sha }}", TG_ISSUE: "${{ needs.drift.outputs.issue }}" },
    steps: [
      new Step({ name: "Check out the commit the drift job planned", uses: "actions/checkout@v4", with: { ref: "${{ github.sha }}", "persist-credentials": false } }),
      new Step({ name: "Fetch the agent's change", uses: download, with: { name: "terragucci-drift-agent", path: AGENT_CHANGE_DIR } }),
      new Step({ name: "Open a pull request with the change, unless it touches CI, terragucci.yml or the policy", shell: "bash", run: driftPushScript(forge, agent.policyDir) }),
    ],
  } as never);
  return [["drift-agent", run as never], ["drift-agent-push", push as never]];
}

/** The drift agent's first step: the prompt, from the drift job's report and its issue.json. */
export function driftPromptScript(policyDir: string): string {
  return ["set -uo pipefail", `terragucci drift-agent prompt --report ${AGENT_DIR}/drift --out ${AGENT_DIR}/prompt.md --policy-dir ${sh(policyDir)}`].join("\n");
}

/** The push job's step: apply, guard, commit, push, open the pull request and say so on the issue (`pushDriftChange`). */
export function driftPushScript(forge: Exclude<ForgeName, "gitlab">, policyDir: string): string {
  return ["set -uo pipefail", `terragucci drift-agent push --forge ${forge} --change ${AGENT_CHANGE_DIR} --policy-dir ${sh(policyDir)}`].join("\n");
}
