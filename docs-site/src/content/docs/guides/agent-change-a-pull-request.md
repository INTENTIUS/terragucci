---
title: Have an agent change a pull request
description: Write /terragucci agent and an ask on a pull request, and a coding agent commits the change to its branch, on GitHub and Forgejo.
claims: [comment-agent]
---

## What you end up with

A comment such as this one on a pull request:

```text
/terragucci agent rename var.bucket to var.bucket_name in app and its callers
```

A coding agent makes the change. terragucci commits it to the pull request's head and replies with a link to the commit. The new commit is planned again like any other, and nothing is ever applied or merged by it.

## Before you start

- The pipeline from [Get your first plan note](/terragucci/getting-started/), on GitHub or Forgejo. GitLab starts no pipeline for a merge request note, so it has no agent comment.
- An API key for the model in your forge's secrets. The default command needs an Anthropic API key.
- A token for the agent's commits in your forge's secrets. Step 1 makes it.

## Steps

### 1. Make the agent's token

The token writes to a pull request's branch and comments on it. Branch rules on the forge keep it off everything else. The job's own token will not do: a commit sent with it starts no workflow run, so the change would never be planned.

On GitHub, use a machine user with write access to the repository. Give it a fine-grained personal access token for that repository alone with these permissions:

- Contents: read and write
- Pull requests: read and write
- no Workflows permission, so GitHub refuses any change it sends to `.github/workflows/`

A token's permissions cannot name a branch. Add a ruleset on the default branch that requires a pull request and one approval of the most recent reviewable change, and give the machine user no bypass. GitHub then keeps it off the default branch and does not count its approval of its own commit. It cannot merge without a person's approval either. If you use code owners, leave the machine user out of `CODEOWNERS`.

On Forgejo, add a machine user as a collaborator with Write access. Its access token needs the `write:repository` and `write:issue` scopes. In the default branch's protection, leave the machine user out of the push allowlist, the approval allowlist and the merge allowlist. Forgejo then refuses its commits to the default branch and counts none of its approvals.

Keep the token in a secret such as `AGENT_FORGE_TOKEN`. The model's key goes in another, such as `ANTHROPIC_API_KEY`.

### 2. Turn it on

Add the `comment` key to the `agent` block of `terragucci.yml`.

```yaml
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
  comment:
    key_secret: ANTHROPIC_API_KEY
    max_turns: 30
    timeout: 30
```

`token_env` names the secret that holds the agent's token. `comment: true` takes every default, and [terragucci.yml keys](/terragucci/reference/config/#the-agent-comment) lists them.

### 3. Check the file and write the pipeline

```bash
npx terragucci config check
npx terragucci init
```

Merge the result to the default branch. GitHub and Forgejo run comment workflows from the default branch, so nothing happens before then.

### 4. Ask

Write `/terragucci agent` and the ask on one line, with one space between them. The reply links the commit and names the files it changed. The plan note updates when the new plan finishes.

## What the agent can and cannot do

Two jobs answer the comment.

The `agent` job runs the agent. `terragucci comment` reads the comment first and applies the checks a re-plan applies. Only an author with write access gets an agent, and only on an open pull request whose branch is in this repository. The ask goes into the prompt file and the commit message, and no shell ever sees it. The checkout keeps no credentials. The model's key is in the agent's step alone. This job's own token can read and comment, and the agent's step runs without it: the step clears `GITHUB_TOKEN`, `FORGEJO_TOKEN`, `GITEA_TOKEN` and the runner's artifact and identity token variables before the command starts. Forgejo ignores a workflow's `permissions:` and gives the job's token the forge's default scope, so on Forgejo this is what keeps that token from the agent. Whatever the agent changed leaves the job as a patch.

The `agent-push` job never runs the agent. In a fresh container it checks out the same head and applies the patch. A patch that touches CI files, `terragucci.yml`, `chant.workspace.json`, `.chant/`, the signers file `.chant/trust.json` names, or the policy directory is refused with a reply naming the paths. A patch to a file that decides who reviews or how an agent behaves is refused the same way: `CODEOWNERS`, `.claude/`, `.cursor/`, `.cursorrules`, `.mcp.json`, and `CLAUDE.md`, `AGENTS.md`, `.gitattributes` or `.gitmodules` in any directory. [The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists every path the job guards. Any other patch becomes one commit on top of the head, sent to the head branch without force. A branch that moved meanwhile keeps what it has.

Neither job has a cloud role, whatever `oidc` and `agent.role` say. The agent cannot plan or apply. Its change is planned by the plan job, with that job's read-only role.

The default command is Claude Code in print mode, pinned to one release:

```text
npx -y @anthropic-ai/claude-code@<version> -p --max-turns "$TG_AGENT_MAX_TURNS"
  --permission-prompts none --setting-sources user --strict-mcp-config --no-session-persistence
  --tools "Read,Edit,Write,Glob,Grep,Bash"
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(terragucci config check)" "Bash(terragucci init --dry-run)"
  --disallowedTools "WebFetch" "WebSearch" "mcp__*" "Edit(.git/**)"
```

The agent edits files and may run two read-only terragucci commands. Nobody is there to answer a permission prompt, so any other command is denied. No MCP server loads, and neither do the repository's own Claude Code settings, which the pull request could have changed. The flags come from the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

Some comments get no agent:

- a comment whose author lacks write access, which gets no reply either
- a comment on a pull request from a fork, which gets a reply saying why
- a comment on a pull request whose head is the default branch
- an ask longer than one line or 2000 characters
- an ask with control characters in it
- an edited comment, since only a new one runs

When the agent fails or reaches its turn limit, the reply says so and the branch stays as it was. If the pull request moves while the agent works, the branch also stays as it was.

## Use another agent

`command` takes any command line that reads a prompt on stdin and edits files in the working directory.

```yaml
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
  comment:
    command: my-agent --non-interactive
    key_secret: MY_AGENT_KEY
```

The prompt's path is also in `TG_AGENT_PROMPT`, and the turn limit in `TG_AGENT_MAX_TURNS`. The secret that `key_secret` names reaches the command's environment under its own name. The guard in `agent-push` holds for whatever it changes.

## Next

- [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/) plans again without changing anything.
- [The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists the jobs and their tokens.
