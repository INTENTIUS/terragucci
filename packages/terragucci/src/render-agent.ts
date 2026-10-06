/**
 * The agent comment's two jobs, `agent` and `agent-push`, for GitHub and
 * Forgejo (see agent-comment.ts for what each does and why there are two).
 * GitLab starts no pipeline for a merge request note, so it has neither.
 */
import { Job, Step } from "@intentius/chant-lexicon-github/generated/index";
import { AGENT_CHANGE_DIR, AGENT_DECISION_JS, AGENT_DIR, type AgentCommentInput } from "./agent-comment";
import type { ForgeName } from "./config";

/** Comments the agent job reads. The replan job leaves them alone when the agent comment is on. */
export const AGENT_COMMENT_IF = "startsWith(github.event.comment.body, '/terragucci agent ')";

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
 * Its exit code goes with the patch; a failed agent pushes nothing.
 */
export function agentRunScript(command: string): string {
  return [
    "set -u",
    `mkdir -p ${AGENT_CHANGE_DIR}`,
    'if [ "$(git rev-parse HEAD)" != "$TG_SHA" ]; then',
    `  echo moved >${AGENT_CHANGE_DIR}/rc`,
    '  echo "terragucci: the pull request moved after the comment was read" >&2',
    "  exit 0",
    "fi",
    `export TG_AGENT_PROMPT=${AGENT_DIR}/prompt.md`,
    `( ${command} ) <"$TG_AGENT_PROMPT"`,
    `echo "$?" >${AGENT_CHANGE_DIR}/rc`,
    "git -c core.hooksPath=/dev/null add -A",
    `git -c core.hooksPath=/dev/null diff --cached --binary --no-renames "$TG_SHA" >${AGENT_CHANGE_DIR}/change.patch`,
    `git -c core.hooksPath=/dev/null diff --cached --stat "$TG_SHA"`,
  ].join("\n");
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
