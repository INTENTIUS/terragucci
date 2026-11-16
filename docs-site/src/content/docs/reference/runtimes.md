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

### Run the jobs on a scratch cluster

`just prow-smoke` runs the jobs `init` writes under Prow's own controller on your laptop. The tools it needs are listed in the recipe's doc line; Go must already hold `sigs.k8s.io/prow` in its module cache, which `go mod download` in `packages/terragucci/test/fixtures/prow/check` fetches once.

The script makes or reuses the k3d cluster `terragucci-prow-smoke` and installs the ProwJob CRD and Prow's plank and sinker on it at pinned image digests. MinIO keeps the job artifacts. A small stand-in for GitHub serves the repository over git's HTTP protocol and answers the REST calls the jobs make; its port is bound to `127.0.0.1` alone. The terragucci image is built from `images/` unless `TG_PROW_SMOKE_IMAGE=published` picks the published one.

The estate is a copy of `example/` whose roots keep local state and hold `terraform_data` in place of the AWS resources, so no job reaches a cloud or a network backend. After `terragucci init` with `runtime: prow` and `approval: prow-labels`, Prow's strict loader reads the job config. Each job then becomes a ProwJob whose refs point at the stand-in, as `mkpj` makes one.

| Job | What the script checks |
|---|---|
| `terragucci-check` presubmit | it passes with no service account token and no Secret in its container |
| `terragucci-plan` presubmit | it posts the plan note and `terragucci/plan` |
| `terragucci-plan` postsubmit | its plan report is in the job's artifacts |
| `terragucci-apply` postsubmit | it applies only when both labels sit on the head the note planned; a missing label, an author's own approval, plans that moved and a newer head each leave the wave waiting |
| `terragucci-drift` periodic | it plans every root and applies nothing |

The pods' service accounts are compared with `terragucci config identities`. A result line reads `ok`, `FAIL`, or `GAP` where the jobs as written fall short and the script works around it so the later steps still run. The Prow parts that talk to GitHub itself (hook, Tide, crier and the `/ok-to-test` command) are not part of the run.

The script deletes nothing. The cluster stays up for the next run, whose ProwJobs carry a run id of their own. The files of a run stay in the work directory it prints. `k3d cluster delete terragucci-prow-smoke` removes the cluster.

## Approvals outside CI

[`terragucci approve`](/terragucci/reference/cli/#approve), run on your laptop, records the approval on the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch and restarts the waiting wave with your forge token. With `apply.resume` set, the scheduled resume job picks up any wave it could not restart ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)).

Each stage also runs from your shell, with your own credentials, as `terragucci stage <name>`; [Stages](/terragucci/reference/stages/) lists them.
