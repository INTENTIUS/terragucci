/**
 * What the pipeline keeps of the agent comment beside chant's agent job
 * (./render-chant-agent.ts): the comments the re-plan job leaves to it, and
 * the cleared environment GitLab's review command runs in.
 */

/** Comments the agent job reads. The replan job leaves them alone when the agent comment is on. */
export const AGENT_COMMENT_IF = "startsWith(github.event.comment.body, '/terragucci agent ')";

/** Variables a runner may set to the job's own token or to its artifact and identity services. The agent's step runs without them. */
export const RUNNER_TOKEN_VARS = "GITHUB_TOKEN FORGEJO_TOKEN GITEA_TOKEN ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL";

/** The variables the agent's command keeps on GitLab, where every job holds the project's variables: the environment is cleared but for these and the model's key. */
export const GL_AGENT_ENV = ["PATH", "HOME", "LANG", "TG_AGENT_PROMPT", "TG_AGENT_MAX_TURNS", "TG_AGENT_MAX_COST_USD", "TG_REVIEW_PROMPT", "TG_AGENT_USAGE"];

/** `env -i` with the variables GitLab's agent and review commands keep, and the model's key. */
export function gitlabCleanEnv(keySecret: string): string {
  return ["env -i", ...[...GL_AGENT_ENV, keySecret].map((v) => `${v}="\${${v}:-}"`)].join(" ");
}
