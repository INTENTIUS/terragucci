---
title: Runtimes
description: Every stage runs on your forge's CI, and an approval is a record in your repository.
---

Each stage is a job on your forge's CI, and its schedule a workflow trigger. `runtime` in [your config file](/terragucci/reference/config/) is `forge`, the default, or `prow` for a GitHub repository whose CI is Prow.

| Forge | What runs the jobs | Credentials |
|---|---|---|
| GitHub | GitHub Actions | per-job OIDC roles or secrets |
| GitLab | GitLab CI, with the summary as the merge-request note | per-job OIDC roles or CI variables |
| Forgejo | Forgejo Actions, on your own instance | per-job OIDC roles or secrets |

## Prow

With `runtime: prow`, `terragucci init` writes one Prow job config file, `prow/terragucci.yaml` unless `prow.path` names another, in place of a workflow. When Prow reads its job config from another repository, set `prow.config_repo` and copy the file there each time init writes it.

```yaml
runtime: prow
prow:
  config_repo: acme/test-infra
  cluster: untrusted
  trusted_cluster: trusted
  service_accounts: { plan: tf-plan, apply: tf-apply }
  token_secret: { name: terragucci-github-token }
```

| Job | Kind | Cluster | Service account | What it does |
|---|---|---|---|---|
| `terragucci-check` | presubmit | `cluster` | none | format check, validate, the source allowlist and the policy tests; holds no credential, so a fork's pull request runs it after `/ok-to-test` |
| `terragucci-plan` | presubmit, with `plan_before_merge` | `trusted_cluster` | `plan` | plans a pull request from this repository and posts the plan note; a fork's pull request is not planned before merge |
| `terragucci-plan` | postsubmit | `trusted_cluster` | `plan` | the merged commit's plan, kept in the job's artifacts |
| `terragucci-apply` | postsubmit | `trusted_cluster` | `apply` | every wave in order in one pod, each behind its gate, and `terragucci/apply` after each |
| `terragucci-drift` | periodic, with `drift` | `trusted_cluster` | `plan` | the drift stage and the drift issue |

The jobs get their cloud identity from the pod's service account, which the cluster binds to a cloud identity with GKE Workload Identity, EKS IRSA or Pod Identity, or AKS Workload Identity, so `oidc` is not set. Bind the `plan` account to a read-only identity and the `apply` account to a write one. `terragucci config identities` prints each stage's account under `pod`.

Some Prow installations keep presubmits off the clusters that hold credentials. There, leave `plan_before_merge` off: the checks run before merge, and the plan and the apply run after it. A wave the gate holds stops the apply job; approve its plans with `terragucci approve`, then rerun `terragucci-apply` from Deck. With `plan_before_merge` on, `approval: prow-labels` lets the `lgtm` and `approved` labels approve a wave when the plan note on the merged head showed the same plans and someone with no hand in the change commented `/lgtm` or `/approve`. `/terragucci plan` runs the plan presubmit again and plans every root.

Plan notes, `terragucci/plan`, `terragucci/apply` and the drift issue go through the GitHub API with the token from `token_secret`. Prow runs plain Terraform and OpenTofu roots; a Terragrunt, Atmos or Terramate repository keeps `runtime: forge`. The keys whose jobs are forge workflows, such as `rollouts`, `review`, `agent`, `environments` and `apply.resume`, are refused with `runtime: prow`.

## Approvals outside CI

[`terragucci approve`](/terragucci/reference/cli/#approve), run on your laptop, records the approval on the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch and restarts the waiting wave with your forge token. With `apply.resume` set, the scheduled resume job picks up any wave it could not restart ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)).

Each stage also runs from your shell, with your own credentials, as `terragucci stage <name>`; [Stages](/terragucci/reference/stages/) lists them.
