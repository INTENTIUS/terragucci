---
title: Have an agent summarize a refused wave
description: Give an agent the diff between an approved plan and the current one, and read a short summary of what moved.
claims: []
---

## What you end up with

One comment that says in plain words what changed between the approved plan and the plan that refused to apply.

The agent never approves, applies or merges. Approving again stays with a person.

## Before you start

- [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/): you can already print the diff by hand.
- An API key for the model. Give the job a forge token that can comment and cannot push, approve or merge.
- The report of the approved run and the report of the refused run, as artifacts.

## Steps

### 1. Produce the diff without a model

The refused-wave response needs no model, and it is the input to the agent:

```bash
npx terragucci respond wave-refused --approved approved/report.json --current terragucci-report --wave 2 --json
```

The envelope holds each root whose plan digest moved, with the changes and attributes that moved inside it.

### 2. Add a job to the apply workflow

Run it when the apply job fails on a refusal. This is the GitHub version.

```yaml
explain-refusal:
  needs: apply
  if: failure()
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: write
    issues: write
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { pattern: terragucci-report*, path: reports }
    - run: >
        npx -y @intentius/terragucci respond wave-refused
        --approved reports/approved/report.json --current reports/current --wave 2
        --json > refusal.json
    - uses: anthropics/claude-code-action@v1
      with:
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        github_token: ${{ secrets.AGENT_FORGE_TOKEN }}
        prompt: |
          Read refusal.json. Summarize which roots changed since the approval and why
          the plan moved, in five lines or fewer. Do not run chant approve,
          terragucci or any apply command.
```

The paths depend on how your pipeline stores the approved report. Adjust them to match. On GitLab, the job takes the same shape as the one in [Have an agent explain a plan](/terragucci/guides/agent-explain-a-plan/), with `refusal.json` in place of the plan file.

### 3. Read the summary, then decide

The comment helps you choose between approving the new plan and reverting the change that moved it. The choice, and the `chant approve` that follows, are yours.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
