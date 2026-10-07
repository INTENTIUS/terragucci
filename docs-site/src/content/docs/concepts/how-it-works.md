---
title: How terragucci works
description: The path of a change from pull request to plan note, merge, waves, approval, apply and drift, and what runs where.
---

`npx terragucci init` writes a pipeline file for your forge; its CI runs everything in terragucci's image. It needs no server or hosted service and keeps state in your backend. The package is Apache-2.0.

The pipeline is made of [chant](/terragucci/concepts/glossary/#chant) stages. chant renders them into your forge's format, and its command line records approvals.

## A change, start to finish

### 1. The pull request

`tf-check` formats and validates every root on the branch push (on a pull request only from a fork). `tf-plan` uses a read-only identity and plans only the roots the change reaches, one [layer](/terragucci/concepts/glossary/#layer) at a time.

### 2. The plan note

`tf-plan` posts one grouped comment naming every destroy and replacement, and sets `terragucci/plan`. `/terragucci plan` re-plans (GitHub, Forgejo).

### 3. The merge

By default any push to the default branch runs `tf-apply` with the apply identity, and pushes apply one at a time. Under the default `on-destroy` gate only a wave that destroys or replaces waits.

With [`apply.when: pull-request`](/terragucci/reference/config/#apply-before-merge) (GitHub, Forgejo), a writer's `/terragucci apply` comment applies the open head. The job refuses a head without approval or behind the default branch, and a root another open change locked.

### 4. The waves

`tf-apply` runs one job per [wave](/terragucci/concepts/glossary/#wave): `waves.canary` roots first, then dependency order. Each wave plans after the one before it applied.

### 5. The approval

A waiting job exits 3 and prints `chant approve` for its [set digest](/terragucci/concepts/glossary/#set-digest). A person runs it to seal an approval onto [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle); the seal must verify against `.chant/allowed_signers` from the commit before the applied one.

### 6. The apply

Rerun the job, push, or comment `/terragucci apply` (GitHub, Forgejo). The wave re-plans and refuses on a changed digest. It never applies a root twice.

### 7. Drift

With `drift:` set to a schedule, `tf-drift` plans every root with `-refresh-only` under the plan identity and keeps one issue updated, closing it when drift is gone. It never applies.

## What runs where

| Where | What |
|---|---|
| your machine | `npx terragucci init`, once and after a config change; `chant approve`, to approve a wave |
| your forge's CI | every stage: check and plan on pull requests, apply on the default branch or the pull request, drift on schedule, comment jobs |
| your repository | the pipeline file, an optional `terragucci.yml`, [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson), the signers file and the `chant/lifecycle` branch |
| your cloud | your state, and the plan and apply identities the jobs assume over OIDC |
| your bucket, if you set one | the reports, with an index across runs |

The plan identity is read-only because pull request code runs with it. Applying before merge gives the apply identity to unmerged code, so it is opt-in.

## Where to go next

- [Get your first plan note](/terragucci/getting-started/) sets it up on your repository.
- [The tutorial](/terragucci/tutorial/) runs each step above on a 15-root example on your laptop.
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/) explains the waves and the gate.
- [The approvals runbook](/terragucci/guides/approvals-runbook/) has the commands for signers, pending waves and refusals.
- [The glossary](/terragucci/concepts/glossary/) defines the chant words and lists the ones that mean something else in Terraform.
