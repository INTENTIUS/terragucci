---
title: How terragucci works
description: The path of a change from pull request to plan note, merge, waves, approval, apply and drift, and what runs where.
---

terragucci is an npm package with one command. `npx terragucci init` reads your repository and writes a pipeline file in your forge's own format. From then on your forge's CI runs everything, in terragucci's CI image for your binary. Your state stays in the backend you configured. There is no server or hosted service, and the package is Apache-2.0.

The pipeline is made of [chant](/terragucci/concepts/glossary/#chant) stages. chant renders them into your forge's format, and its command line records approvals.

## A change, start to finish

### 1. The pull request

A pull request starts two jobs. `tf-check` formats and validates every root; it runs on the branch push, and on a pull request only when the pull request comes from a fork. `tf-plan` runs for the pull request itself and plans only the roots the change reaches, a [layer](/terragucci/concepts/glossary/#layer) at a time, with a read-only cloud identity.

### 2. The plan note

`tf-plan` posts one comment on the pull request and sets the `terragucci/plan` status. The note groups the roots whose plans are the same and names every destroy and replacement on its own. It links to the full report, which keeps each root's whole plan. On GitHub and Forgejo, `/terragucci plan` in a comment plans the pull request again.

### 3. The merge

By default nothing applies before the merge. The merge to the default branch starts `tf-apply`, with the apply identity. A project applies one push at a time, so two merges never interleave. Under the default `apply.when: merge`, any push to the default branch runs the `apply-wave` jobs, not only the merge of a pull request. A wave whose plans destroy or replace nothing applies without an approval under the default `on-destroy` gate; only a wave that destroys or replaces waits.

With [`apply.when: pull-request`](/terragucci/reference/config/#apply-before-merge), the order turns around. On GitHub and Forgejo a person with write access comments `/terragucci apply` on the open pull request; on GitLab they start its `apply-mr` job. `tf-apply` then runs from the head in the same waves and under the same gate. The job first refuses a head that has no approval or is behind the default branch, and a root that another open change has locked. The merge comes after the last wave, and the push that follows plans every root and applies nothing.

### 4. The waves

`tf-apply` splits the roots into [waves](/terragucci/concepts/glossary/#wave), one job per wave. The roots in `waves.canary` go first, and the rest follow in dependency order. Each wave plans only after the wave before it has applied, so it reads real outputs.

### 5. The approval

The `gate` setting decides which waves wait for a person: by default, a wave whose plans destroy something. A waiting wave's job stops with exit code 3 and prints a `chant approve` command naming the wave's [set digest](/terragucci/concepts/glossary/#set-digest). A person reads the wave's plans in the report and runs that command on their own machine, which seals the approval with their ssh key and commits it to the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch. The apply job counts it only when the seal verifies against `.chant/allowed_signers` as it stood before the commit being applied.

### 6. The apply

Running the wave again applies it. Re-run its job or push to the default branch; on GitHub and Forgejo you can also comment `/terragucci apply` on the merged pull request, or on the open one with `apply.when: pull-request`. The wave plans again and goes out only if the set digest still matches the approval. When a plan changed, the wave refuses. A run starts where the last one stopped and never applies a root twice.

### 7. Drift

With `drift:` set to a schedule, `tf-drift` plans every root with `-refresh-only`, using the plan identity. What changed outside your code goes into one issue. The job keeps that issue up to date and closes it once the drift is gone. It never applies.

## What runs where

| Where | What |
|---|---|
| your machine | `npx terragucci init`, once and after a config change; `chant approve`, to approve a wave |
| your forge's CI | every stage: check and plan on pull requests, apply on the default branch (or from the pull request with `apply.when: pull-request`), drift on its schedule, and the comment jobs |
| your repository | the pipeline file, an optional `terragucci.yml`, [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson), the signers file and the `chant/lifecycle` branch |
| your cloud | your state, and the plan and apply identities the jobs assume over OIDC |
| your bucket, if you set one | the reports, with an index across runs |

The plan identity is read-only, because a pull request's code runs with it. By default only jobs on the default branch get the apply identity. Applying before the merge hands it to code nobody has merged yet, and that trade is why it is opt-in.

## Where to go next

- [Get your first plan note](/terragucci/getting-started/) sets it up on your repository.
- [The tutorial](/terragucci/tutorial/) runs each step above on a 15-root example on your laptop.
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/) explains the waves and the gate.
- [The approvals runbook](/terragucci/guides/approvals-runbook/) has the commands for signers, pending waves and refusals.
- [The glossary](/terragucci/concepts/glossary/) defines the chant words and lists the ones that mean something else in Terraform.
