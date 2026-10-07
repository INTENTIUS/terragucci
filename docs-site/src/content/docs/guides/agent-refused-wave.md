---
title: Have an agent summarize a refused wave
description: Give an agent the diff between an approved plan and the current one, and read a short summary of what moved.
claims: []
---

## What you end up with

One comment saying what changed between the approved plan and the plan that was refused. The agent never approves, applies or merges.

## Before you start

- [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/): you can already print the diff by hand.
- An API key for the model, and a forge token that can comment but not push, approve or merge.
- The report of the approved run and the report of the refused run, as artifacts.

## Steps

### 1. Produce the diff without a model

This needs no model and is the agent's input:

```bash
npx terragucci respond wave-refused --approved approved --current terragucci-report/current --wave 2 --json
```

The envelope holds each root whose plan digest moved, with what moved inside it.

### 2. Add a job to the apply workflow

Run it when a wave's apply job fails on a refusal. Wave jobs are `apply-wave-<k>`; each keeps its reports, including `approved/report.json` and `current/report.json` when refused, in the artifact `terragucci-report-apply-wave-<k>`. This GitHub version covers wave 2; change the number everywhere for another.

```yaml
explain-refusal:
  needs: apply-wave-2
  if: failure()
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: write
    issues: write
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: terragucci-report-apply-wave-2, path: reports }
    - run: >
        npx -y @intentius/terragucci respond wave-refused
        --approved reports/approved --current reports/current --wave 2
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

On GitLab, add a job after the wave's job; its artifact unpacks at `terragucci-report/`:

```yaml
explain-refusal:
  stage: apply
  needs: [apply-wave-2]
  when: on_failure
  script:
    - >
      npx -y @intentius/terragucci respond wave-refused
      --approved terragucci-report/approved --current terragucci-report/current --wave 2
      --json > refusal.json
    - >
      npx -y @anthropic-ai/claude-code -p
      "Read refusal.json. Summarize which roots changed since the approval and why
      the plan moved, in five lines or fewer, as one note on the merge request.
      Do not run chant approve, terragucci or any apply command."
```

Give the job `ANTHROPIC_API_KEY` and `AGENT_FORGE_TOKEN` as masked variables, the token limited to merge-request notes.

### 3. Read the summary, then decide

Choose between approving the new plan and reverting the change. The choice and the [`chant approve`](/terragucci/concepts/glossary/#chant) are yours.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
