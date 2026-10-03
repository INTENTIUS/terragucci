---
title: Stages
description: What each stage does, its inputs, permissions and outputs.
---

Every stage takes the root directories and the binary.

| Stage | What it does | Forge permissions | Outputs |
|---|---|---|---|
| `tf-check` | format and validate | read the repository | pass or fail |
| `tf-plan` | plans only the roots a change affects, in one run, and posts the grouped summary on the pull request | read the repository, comment on pull requests | the grouped summary, and a plan digest per root |
| `tf-apply` | applies wave by wave, one job per wave, each wave behind its own approval | read the repository, write the `chant/lifecycle` branch | per wave, whether it waited and the command that approves it |
| `tf-drift` | plans every root on a schedule and reports the grouped summary | read the repository, open issues | drift, grouped |

## Gated waves

A change that touches many roots goes out in waves. Wave 1 is an optional canary list. Later waves follow dependency order, so a root never applies before one it reads from.

Each wave has its own approval. The approval is bound to the wave's set digest, a hash over the plan digest of every root in that wave. If any root's plan changes after the approval, the wave stops and applies nothing.

A wave is planned only after the wave before it has applied. Its plan reads the real outputs of the roots upstream, so an approval never covers placeholder values.

A run that stops at an approval, or after a failed root, carries on from there next time. It never applies a root twice.

## The grouped summary

Nobody reads two hundred plan logs. The summary normalizes each root's changes and groups the roots whose changes are the same.

```
180 roots: identical change (update aws_iam_role.app, tags)
 15 roots: the same, plus replace aws_lambda_function.worker
  5 roots: read these individually
destroys: prod-eu/db (delete aws_db_instance.main)
```

Every destroy, replacement and refusal is listed by name and is never folded into a group. The summary comes as text, JSON, or markdown sized for a pull-request note. No approval is bound to it; approvals bind the plan digests underneath.

## Gate policy

`tf-apply` takes one of three policies for each wave.

| Policy | Waits for an approval when |
|---|---|
| `always` | every wave |
| `on-destroy` | the wave's plans destroy something |
| `never` | never; use your forge's environment reviewers instead |

A waiting wave exits with code 3 and prints the approval command. Run it, then run the stage again.
