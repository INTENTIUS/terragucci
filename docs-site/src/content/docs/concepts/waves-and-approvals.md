---
title: How waves and approvals work
description: Why a change goes out in waves, what an approval binds, and when a wave refuses to apply.
---

A change to a shared module can touch hundreds of roots. Applying them all at once means a mistake reaches all of them. Applying them one at a time is slow and gives a reviewer nothing to look at. Waves sit between the two. A small first batch goes out first, and each later batch goes out only once the one before it is done. A batch waits for a person only when the [gate policy](#when-a-wave-waits) holds it, which by default means its plans destroy or replace something.

## How roots are split into waves

Each wave is one layer of the dependency order, so no root in a wave reads another root in it. The roots named in `waves.canary` go first, in their own waves, and the rest follow. The plan report numbers its waves the same way, so its wave 3 is the gate `wave-3`. A root never applies before one it reads from through `terraform_remote_state`, so a platform root that holds a shared bucket goes before the services that use the bucket.

In a Terragrunt repo the units `waves.canary` names make up wave 1 and the others make up wave 2. The dependency graph orders the units inside each. Its gate is the plain one: the job saves each unit's plan, and an approved wave applies exactly those saved plans.

## What an approval binds

Each wave has its own approval. The approval is bound to the wave's set digest, a hash over the plan digest of every root in that wave. It does not mean that the change is fine. It means that these exact plans are fine. The approval is sealed with the approver's ssh key, and the wave counts it only when the seal verifies against the signers file. The apply job reads the signers file and the gate list in [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) from the first parent of the commit it applies. After a merge commit or a squash that parent is the default branch from before the merge. A pull request therefore cannot add a signer or drop a gate for itself. A rebase of several commits is the exception: there the parent is the pull request's own next-to-last commit, and its changes to those files judge it. [Approve a waiting wave](/terragucci/guides/approve-a-wave/#which-commit-the-rule-is-read-from) says to land such a change with a merge commit or a squash. A pull request applied before it merges reads them from the default branch. [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/) explains why.

If any root's plan changes after the approval, the digest changes. Another merge or a changed data source can cause that. A wave the gate holds then applies nothing, because an approval that still covered a plan nobody read would be worth nothing. This refusal needs the gate to hold the wave as it is planned now. With `on-destroy`, a wave approved for a destroy whose new plans destroy nothing applies without a new approval. With `never` nothing is refused.

## Plans are made late

A wave is planned only after the wave before it has applied. Its plan reads the real outputs of the roots upstream, so an approval never covers placeholder values. The same holds in Terragrunt: a unit whose plan would read `mock_outputs` waits for its upstream instead of planning. When a unit reads another unit of its wave whose outputs are about to change, it plans after that unit has applied. It then goes through the gate on its own. [Use Terragrunt](/terragucci/guides/use-terragrunt/#what-is-different-in-a-terragrunt-repo) has the details.

## When a wave waits

The gate policy decides which waves wait for a person.

| Policy | Waits for an approval when |
|---|---|
| `always` | the wave has at least one change; a wave whose plans change nothing never waits |
| `on-destroy` | the wave's plans destroy or replace something |
| `never` | never; the wave applies as soon as its plans are made, so only the review of the pull request and the protection of the default branch stand in front of it |

A waiting wave exits with code 3 and prints the approval command. A person runs it, then the stage runs again. A run that stops at an approval, or after a failed root, carries on from there next time. It never applies a root twice.

## One apply at a time

A project applies one push at a time, so waves from different pushes never interleave. With `apply.when: pull-request`, a pull request that applies before it merges also locks each root it reaches until it merges or closes, so two open pull requests never apply the same root in turn. [The generated pipeline](/terragucci/reference/pipeline/#one-apply-at-a-time) shows how each forge does it.

## Where to go next

- [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/)
