---
title: How waves and approvals work
description: Why a change goes out in waves, what an approval binds, and when a wave refuses to apply.
---

A change to a shared module can touch hundreds of roots. Applying them all at once means a mistake reaches all of them. Applying them one at a time is slow and gives a reviewer nothing to look at. Waves sit between the two. A small first batch goes out first, and each later batch waits until the one before it has been checked.

## How roots are split into waves

Each wave is one layer of the dependency order, so no root in a wave reads another root in it. The roots named in `waves.canary` go first, in their own waves, and the rest follow. The plan report numbers its waves the same way, so its wave 3 is the gate `wave-3`. A root never applies before one it reads from through `terraform_remote_state`, so a platform root that holds a shared bucket goes before the services that use the bucket.

In a Terragrunt repo the dependency graph decides the order. Each wave is one `terragrunt run --all` over exactly its units.

## What an approval binds

Each wave has its own approval. The approval is bound to the wave's set digest, a hash over the plan digest of every root in that wave. It does not mean that the change is fine. It means that these exact plans are fine. The approval is sealed with the approver's ssh key, and the wave counts it only when the seal verifies against the signers file on the default branch. [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/) explains why.

If any root's plan changes after the approval, the digest changes and the wave applies nothing. Another merge or a changed data source can cause that. An approval that still covered a plan nobody read would be worth nothing, so the wave refuses.

## Plans are made late

A wave is planned only after the wave before it has applied. Its plan reads the real outputs of the roots upstream, so an approval never covers placeholder values. The same holds in Terragrunt: a unit whose plan would read `mock_outputs` waits for its upstream instead of planning.

## When a wave waits

The gate policy decides which waves wait for a person.

| Policy | Waits for an approval when |
|---|---|
| `always` | every wave |
| `on-destroy` | the wave's plans destroy something |
| `never` | never; use your forge's environment reviewers instead |

A waiting wave exits with code 3 and prints the approval command. A person runs it, then the stage runs again. A run that stops at an approval, or after a failed root, carries on from there next time. It never applies a root twice.

## One apply at a time

A project applies one push at a time, so waves from different pushes never interleave. [The generated pipeline](/terragucci/reference/pipeline/#one-apply-at-a-time) shows how each forge does it.

## Where to go next

- [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/)
