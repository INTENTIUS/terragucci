---
title: The generated pipeline
description: Apply order, commit statuses, stale plan notes and cloud credentials in the pipeline init writes.
---

## One apply at a time

A project applies one push at a time. GitHub holds the apply job in a concurrency group that is not cancelled while it runs. GitLab uses a resource group. Forgejo cancels the earlier runs of a branch when a push arrives, even one that is applying, unless the workflow names a group, so the workflow names one that does not cancel. For runners that ignore concurrency, the Forgejo apply job also takes a lock on the remote. The lock carries a lease, and a waiter takes it over once the holder's run has ended or the lease is two hours old. A run whose commit is no longer the branch tip stands down, because the newer push applies the whole tree.

A waiting push applies after the one ahead of it. Pull requests take no locks, so there is nothing to release by hand.

Roots that apply together each get a provider cache directory of their own.

## Statuses and stale plans

Each stage posts one commit status for the whole run. `terragucci/plan` carries the counts of roots, groups and destroys. `terragucci/apply` appears on the default branch. Require either in branch protection.

When the default branch changes a root that a pull request's plan note covers, the note is marked stale. Pushing to the pull request plans it again.

## Credentials

Set `oidc` in your config and jobs trade the forge's identity token for cloud roles. CI holds no long-lived keys.

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

Plan runs the pull request's code, so it gets the read-only role. The config rejects one role for both. Apply gets the write role and runs only on the default branch. Forks get no plan job, so nothing reaches their pull requests.

GitHub jobs get the token through `id-token: write`, and GitLab jobs through `id_tokens`. Forgejo jobs ask the runner's token endpoint.
