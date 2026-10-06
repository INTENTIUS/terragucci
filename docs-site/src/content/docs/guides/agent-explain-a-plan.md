---
title: Have an agent explain a plan
description: A Claude Code GitHub Action or a GitLab job reads the plan report and adds a plain-words explanation to the pull request.
claims: []
---

## What you end up with

A job after the plan job that hands the report to an agent. The agent posts one comment on the pull request that explains the grouped summary and each destroy.

The agent never approves, applies or merges. Its token can comment and nothing else.

## Before you start

- The pipeline from [Get your first plan note](/terragucci/getting-started/).
- An API key for the model, kept in your forge's secrets.
- A forge token that can comment on pull requests and cannot push, approve or merge. Create it for this job alone.
- If the agent needs cloud access at all, a read-only role. Naming the apply role in the agent settings is an error.

## Steps

### 1. Turn the plan event over to an agent

Put it in `terragucci.yml`.

```yaml
respond:
  plan: agent
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
```

`token_env` names the variable that holds the comment-only token.

### 2. Check the file

```bash
npx terragucci config check
```

```text
terragucci.yml: ok
```

With `plan: agent` and no `agent` block, the check names the event and the missing keys instead.

### 3. See what the agent would get

```bash
npx terragucci respond plan --report terragucci-report
```

The command writes `terragucci-respond/plan.json`. It holds the deterministic result and the integration, and it lists what the agent may do and what it never does. The model works from that file and the report and has no access to your cloud.

| May | Never |
|---|---|
| comment | approve, apply or merge |
| open a pull request for a person to review | re-approve a gate or push to the default branch |
| | run `state rm`, `import` or `force-unlock` |

### 4. Add the job

This is the GitHub job, using the Claude Code action:

```yaml
explain:
  needs: plan
  if: always()
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: write
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: terragucci-report, path: terragucci-report }
    - run: npx -y @intentius/terragucci respond plan --report terragucci-report
    - uses: anthropics/claude-code-action@v1
      with:
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        github_token: ${{ secrets.AGENT_FORGE_TOKEN }}
        prompt: |
          Read terragucci-respond/plan.json. Explain the grouped summary and each
          destroy in plain words, as one comment on this pull request.
          Do only what its agent.may list allows.
```

On GitLab, add a job after `plan` that runs the same command and then starts the agent. Its token is limited to merge-request notes.

```yaml
explain:
  stage: apply
  needs: [plan]
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - npx -y @intentius/terragucci respond plan --report terragucci-report
    - >
      npx -y @anthropic-ai/claude-code -p
      "Read terragucci-respond/plan.json. Explain the grouped summary and each destroy
      in plain words, as one note on merge request $CI_MERGE_REQUEST_IID.
      Do only what its agent.may list allows."
```

Give the job `ANTHROPIC_API_KEY` and `AGENT_FORGE_TOKEN` as masked variables, and make the plan job's `terragucci-report` available to it as an artifact dependency. GitLab Duo or any other agent that reads a JSON file and comments through the forge API can take the file in place of the Claude Code command.

### 5. Open a pull request

The usual plan note appears first, and the explanation follows as a second comment. A person still reads the note, the report and the destroys. The explanation is an aid and replaces none of them.

## Next

- [Have an agent summarize a refused wave](/terragucci/guides/agent-refused-wave/)
- [Responses to pipeline events](/terragucci/reference/responses/#agent-recipes)
