---
title: Glossary
description: The words terragucci and the example use, and the ones that mean something different in Terraform and HCP Terraform.
---

A page links a word here on first use, unless the page explains it.

## Your code

### root

A directory whose files configure a provider or hold a state block (`backend`, `cloud` or choudoufu's `live`). `init` finds them, or `roots:` names them by glob. Every stage runs the binary once in each.

A root with a `cloud` block on remote execution runs on HCP Terraform's workers, where the job's `oidc` roles do not reach. Local execution keeps the runs in your CI.

### forge

The service that hosts your repository and runs its pipelines: GitHub, GitLab or Forgejo. The workflow terragucci writes for yours runs on its runners.

### control repo

A repo whose `terragucci.yml` lists your projects under `projects` and their shared settings under `defaults`. `reconcile` opens a pull request in each project that changes, and each project's own pipeline applies. [Control repo](/terragucci/concepts/control-repo/).

### unit

A Terragrunt directory with a `terragrunt.hcl`. `terragrunt find` lists units and each is treated as a root. A directory of units is an implicit stack, shown as a report label.

### layer

A step of the dependency order that one root's reads of another set (`terraform_remote_state`, choudoufu's `terraform_estate_outputs` or a Terragrunt `dependency` block). `init --dry-run` counts them; `tf-plan` plans one at a time.

### wave

A batch `tf-apply` applies behind one approval, gated as `wave-1`, `wave-2`. Wave 1 holds the canary and each later wave one layer; for Terragrunt units a wave is one `terragrunt run --all`.

### canary

The roots named in `waves.canary`, applied first in wave 1 so a bad change reaches a few roots before the rest.

### plan digest

A hash of one root's plan. The job takes it before anything is redacted or rendered.

### set digest

The hash over the plan digests of the roots in a wave whose plan changes something. An approval names it, and the wave refuses to apply if any of its plans changes or a root starts or stops changing. A pull request's plan note shows it for each wave.

### gate

Where a wave waits for a person, per the `gate` setting: `on-destroy` (default), `always` or `never`. A waiting job exits 3 and prints its `terragucci approve` command.

## Approvals

### chant

The record format terragucci writes to [`chant/lifecycle`](#chantlifecycle): approvals, applies and lock releases, one line each. Approvers' keys are in [`.chant/allowed_signers`](#chantallowed_signers).

### chant/lifecycle

A branch holding the apply job's records and one commit per approval. Let only the apply job's identity push to it and block force pushes and deletion. [Approvals as records](/terragucci/concepts/approvals-as-records/) says why.

### chant.workspace.json

The file at the repository root, written by `init` under `approval: sealed`, listing the wave gates under `identity.gates`. It has nothing to do with Terraform workspaces.

### identity.gates

The gates in `chant.workspace.json` (`init` lists all under `approval: sealed`) whose approvals count only with a seal that verifies against `.chant/allowed_signers` as of the parent commit. With no `approval` key, any gate listed here keeps the repo sealed.

### .chant/allowed_signers

The signers file holds one ssh public key per approver in ssh-keygen's allowed_signers format and is read from the commit before the one applied. [Set up the signers file](/terragucci/guides/approve-a-wave/#set-up-the-signers-file).

### pr-review

The `approval:` mode where the merged pull request's approving review of its head approves a gated wave, when the wave plans what the review saw. Any `terragucci approve` of the digest still counts, as under `ledger`. [Approve by review](/terragucci/guides/approve-a-wave/#approve-by-review-approval-pr-review).

### seal

The ssh signature `terragucci approve --sign` puts on an approval. Under `approval: sealed` an unverified or edited record counts for nothing. `ledger` (the default) and `pr-review` need no seal.

## Other tools

### fountain

A separate runtime that runs pipeline stages on a long-lived machine. terragucci's pipelines run on your forge's CI and never on [fountain](https://github.com/managoat/fountain).

### steward

fountain's word for the machine that runs stages for one environment. terragucci has no steward.

### floci

A local stand-in for the AWS API that the tutorial applies to, so it needs no AWS account. It keeps no tags, so every root's tags show as drift.

### choudoufu

The OpenTofu fork from the team behind terragucci ([Choose your binary](/terragucci/guides/use-a-binary/#choudoufu), [its repository](https://github.com/INTENTIUS/choudoufu)). `binary: choudoufu` keeps the same six stages, and the four that run a binary (`tf-check`, `tf-plan`, `tf-apply`, `tf-drift`) run choudoufu.

| Feature | What it does |
|---|---|
| State | one record per resource in an S3 backend; the state file is a cache, never the record of what you own |
| Writes | each record write is conditional, so two writes to one record settle at the API, with no lock table or database ([locking with choudoufu](/terragucci/concepts/locking-and-staleness/#with-choudoufu)) |
| Tags | each resource carries its identity as a tag the next plan reads back |
| Stages | `tf-check` also runs its live check, and wave reports show state lock waits |

## Words that mean something else in Terraform

| Here | What it means here | Not to be confused with |
|---|---|---|
| `chant.workspace.json` | the file that lists the sealed gates | a Terraform or HCP Terraform workspace; each root plans in `default` unless `TF_WORKSPACE` says otherwise |
| `--mode apply` on `rollout`, `respond` and `reconcile` | push the commit or open the pull request that the dry run described | `terraform apply`, which none of the three runs |
| layer | a step of the dependency order | a wave, an apply batch built from layers |
| `/terragucci apply` | rerun `tf-apply` on a merged pull request, or an open one with `apply.when: pull-request`; gated waves still need an approval of their digest | Atlantis `apply`, which applies its stored plan; here each wave plans again |
| `/terragucci lock` | with `apply.when: pull-request` or `locks: plan`, lock the roots a pull request reaches without applying it | the lock Atlantis takes on every plan; under the default `locks: apply` a plan locks nothing, and with `locks: plan` the first plan locks |
| `/terragucci unlock` | with `apply.when: pull-request` or `locks: plan`, release the root locks a pull request took when it planned, applied or locked | Atlantis `unlock`, which also discards plans; none are kept here |
| run | a forge pipeline run, with its jobs | an HCP Terraform run, which is one plan and apply in one workspace |
