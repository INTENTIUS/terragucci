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

A coding agent makes the change and terragucci commits it to the pull request's head. The commit is planned like any other; nothing is applied or merged.

## Before you start

- The pipeline from [Get your first plan note](/terragucci/getting-started/), on GitHub or Forgejo. GitLab starts no pipeline for a merge request note, so it has no agent comment.
- An Anthropic API key (for the default command) in your forge's secrets.
- A token for the agent's commits in your forge's secrets (step 1).

## Steps

### 1. Make the agent's token

The job's own token will not do: a commit sent with it starts no workflow run, so the change would not be planned.

On GitHub, give a machine user with write access a fine-grained token for this repository alone:

- Contents: read and write
- Pull requests: read and write
- no Workflows permission, so GitHub refuses any change it sends to `.github/workflows/`

Add a ruleset on the default branch requiring a pull request and one approval of the latest change, with no bypass for the machine user, which stays out of `CODEOWNERS`.

On Forgejo, add a machine user as a collaborator with Write access and a token scoped `write:repository` and `write:issue`. Keep it off the default branch's push allowlist, approval allowlist and merge allowlist.

Keep the token in a secret such as `AGENT_FORGE_TOKEN` and the model's key in `ANTHROPIC_API_KEY`.

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

`token_env` names the secret with the agent's token. `comment: true` takes every default, listed in [terragucci.yml keys](/terragucci/reference/config/#the-agent-comment).

### 3. Check the file and write the pipeline

```bash
npx terragucci config check
npx terragucci init
```

Merge the result to the default branch, where comment workflows run from.

### 4. Ask

Write `/terragucci agent` and the ask on one line. The reply links the commit and names the files it changed.

## What the agent can and cannot do

Two jobs answer the comment.

The `agent` job runs the agent for an author with write access on an open pull request from this repository. The ask never reaches a shell and the checkout keeps no credentials. The model's key is in the agent's step alone. That step first clears `GITHUB_TOKEN`, `FORGEJO_TOKEN`, `GITEA_TOKEN` and the runner's artifact and identity token variables. Its changes leave the job as a patch.

The `agent-push` job applies the patch to the same head in a fresh container. It refuses a patch that touches any of these, with a reply naming the paths:

- CI files, `terragucci.yml`, [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) and `.chant/`
- the signers file `.chant/trust.json` names, and the policy directory
- `CODEOWNERS`, `.claude/`, `.cursor/`, `.cursorrules` and `.mcp.json`
- `CLAUDE.md`, `AGENTS.md`, `.gitattributes` and `.gitmodules` in any directory

[The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists every guarded path. Any other patch is pushed as one commit without force; a branch that moved keeps what it has.

Neither job has a cloud role, whatever `oidc` says. The plan job plans the change with its read-only role.

The default command is Claude Code in print mode, pinned to one release:

```text
npx -y @anthropic-ai/claude-code@<version> -p --max-turns "$TG_AGENT_MAX_TURNS"
  --permission-prompts none --setting-sources user --strict-mcp-config --no-session-persistence
  --tools "Read,Edit,Write,Glob,Grep,Bash"
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(terragucci config check)" "Bash(terragucci init --dry-run)"
  --disallowedTools "WebFetch" "WebSearch" "mcp__*" "Edit(.git/**)"
```

The agent edits files and may run two read-only terragucci commands; any other command is denied. No MCP server and none of the repository's own Claude Code settings load. The flags are in the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

These get no agent:

- an author without write access (no reply either)
- a pull request from a fork (the reply says why)
- a pull request whose head is the default branch
- an ask over one line or 2000 characters, or with control characters
- an edited comment, since only a new one runs

The branch stays as it was when the agent fails or hits its turn limit, or when the pull request moves.

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

The prompt's path is in `TG_AGENT_PROMPT` and the turn limit in `TG_AGENT_MAX_TURNS`. The `key_secret` secret reaches the command under its own name. The `agent-push` guard holds for any agent.

## Next

- [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/) plans again without changing anything.
- [The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists the jobs and their tokens.
