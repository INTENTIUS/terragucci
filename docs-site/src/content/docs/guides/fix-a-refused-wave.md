---
title: Fix a refused wave
description: A wave that applied nothing because a plan changed after its approval. Read the diff, then approve again or stop.
---

## What you end up with

A decision on a refused wave: either the new plan approved and applied, or the change that moved it removed.

## Before you start

- A wave that stopped with a refusal. The apply job fails with a message that the wave's set digest no longer matches its approval, and nothing in that wave was applied.
- The report of the run that gave the approval, and the report of the run that refused.

## Steps

### 1. Understand why it refused

An approval binds a wave's set digest. If any root's plan changes after the approval, the digest changes and the wave applies nothing. The usual causes are another merge to the default branch that touched a root in the wave, or a data source that read a different value.

### 2. Get the two reports

Download the `terragucci-report` artifact of the run that was approved into `approved/`, and the artifact of the refused run into `terragucci-report/`. On GitLab, take them from each job's artifacts. If you keep reports in a bucket, copy the two run folders instead.

### 3. Print the diff

```bash
npx terragucci respond wave-refused --approved approved/report.json --current terragucci-report --wave 2
```

The response lists each root whose plan digest moved, with the changes and attributes that moved inside it. Roots whose plan did not move are left out. `--json` prints the same as one envelope.

### 4. Decide

- The moved plan is the one you want: record a new approval with `npx chant approve tf-apply wave-2 --sign`, then run the stage again. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) has the steps.
- The moved plan is not what you meant to apply: find the change that moved it, revert it on the default branch, and let the pipeline plan the wave again. The earlier approval still counts if the digest matches again.

An agent may summarize the diff for you, but it does not re-approve. [Have an agent summarize a refused wave](/terragucci/guides/agent-refused-wave/) sets that up.

## Next

- [Responses to pipeline events](/terragucci/reference/responses/#wave-refused)
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
