---
title: Glossary
description: The words terragucci, chant and the example use, and the ones that mean something different in Terraform and HCP Terraform.
---

A page links a word here on first use, unless the page explains it.

## Your code

### root

A directory whose files hold a `backend` or `cloud` block, or choudoufu's `live` block, or configure a provider. `init` finds roots, or `roots:` names them by glob. Every stage runs the binary once in each.

A root with a `cloud` block on remote execution runs on HCP Terraform's workers, where the job's `oidc` roles do not reach. Local execution keeps the runs in your CI.

### forge

The service that hosts your repository and runs its pipelines: GitHub, GitLab or Forgejo. terragucci writes a workflow for yours, and the jobs run on its runners.

### unit

A Terragrunt directory with a `terragrunt.hcl`; terragucci lists units with `terragrunt find` and treats each as a root. A directory of units is an implicit stack, shown as a report label.

### layer

A step of the dependency order set by `terraform_remote_state` reads, choudoufu's `terraform_estate_outputs` reads or Terragrunt `dependency` blocks. `init --dry-run` counts them; `tf-plan` plans one at a time.

### wave

A batch `tf-apply` applies behind one approval, gated as `wave-1`, `wave-2`: canary first, then one layer each. Terragrunt units go the same way, each wave one `terragrunt run --all`.

### canary

The roots named in `waves.canary`, applied first in wave 1 so a bad change reaches a few roots before the rest.

### plan digest

A hash of one root's plan. The job takes it before anything is redacted or rendered.

### set digest

The hash over the plan digests of the roots in a wave whose plan changes something. An approval names it, so when one plan in the wave changes, or a root starts or stops changing, the wave refuses to apply. A pull request's plan note shows it for each wave.

### gate

Where a wave waits for a person, per the `gate` setting: `on-destroy` (default), `always` or `never`. A waiting job exits 3 and prints its `chant approve` command.

## Approvals

### chant

The tool terragucci's stages are written in. [chant](https://intentius.io/chant/) renders them for your forge, and `chant approve` (`npm i -D @intentius/chant`) writes approvals from your machine.

### chant/lifecycle

A branch that holds the apply job's records and the approvals, each approval a commit. Let only the apply job's identity push to it and block force pushes and deletion. [Approvals as records](/terragucci/concepts/approvals-as-records/) says why.

### chant.workspace.json

chant's file at the repository root, written by `init` under `approval: sealed`, listing the wave gates under `identity.gates`. It has nothing to do with Terraform workspaces.

### identity.gates

The gates in `chant.workspace.json` (`init` lists all under `approval: sealed`) whose approvals count only with a seal that verifies against `.chant/allowed_signers` as of the parent commit. With no `approval` key, any gate listed here keeps the repo sealed.

### .chant/allowed_signers

The signers file: one ssh public key per approver, in ssh-keygen's allowed_signers format, read from the commit before the one applied. [Set up the signers file](/terragucci/guides/approve-a-wave/#set-up-the-signers-file).

### pr-review

The `approval:` mode where the merged pull request's approving review of its head approves a gated wave, when the wave plans what the review saw. Any `chant approve` of the digest still counts, as under `ledger`. [Approve by review](/terragucci/guides/approve-a-wave/#approve-by-review-approval-pr-review).

### seal

The ssh signature `chant approve --sign` puts on an approval. Under `approval: sealed` an unverified or edited record counts for nothing; under `ledger`, the default, and `pr-review` no seal is needed.

## Other tools

### fountain

A separate runtime that runs chant stages on a long-lived machine. terragucci's pipelines run on your forge's CI and never on [fountain](https://github.com/managoat/fountain).

### steward

fountain's word for the machine that runs stages for one environment. terragucci has no steward.

### floci

A local stand-in for the AWS API that the tutorial applies to, so it needs no AWS account. floci keeps no tags, so every root's tags show as drift.

### choudoufu

The OpenTofu fork from the team behind terragucci ([Choose your binary](/terragucci/guides/use-a-binary/#choudoufu), [its repository](https://github.com/INTENTIUS/choudoufu)). `binary: choudoufu` keeps the same six stages, and the four that run a binary (`tf-check`, `tf-plan`, `tf-apply`, `tf-drift`) run choudoufu.

| Feature | What it does |
|---|---|
| State | one record per resource in an S3 backend; the state file is a cache, never the record of what you own |
| Writes | each record write is conditional, so two writes to one record settle at the API, with no lock table or database ([Locking and staleness with choudoufu](/terragucci/concepts/locking-and-staleness/)) |
| Tags | each resource carries its identity as a tag the next plan reads back |
| Stages | `tf-check` also runs its live check, and wave reports show state lock waits |

## Words that mean something else in Terraform

| Here | What it means here | Not to be confused with |
|---|---|---|
| `chant.workspace.json` | chant's file that lists the gates | a Terraform or HCP Terraform workspace; each root plans in `default` unless `TF_WORKSPACE` says otherwise |
| `--mode apply` on `rollout`, `respond` and `reconcile` | push the commit or open the pull request that the dry run described | `terraform apply`, which none of the three runs |
| layer | a step of the dependency order | a wave, an apply batch built from layers |
| `/terragucci apply` | rerun `tf-apply` on a merged pull request, or an open one with `apply.when: pull-request`; gated waves still need an approval of their digest | Atlantis `apply`, which applies its stored plan; here each wave plans again |
| `/terragucci lock` | with `apply.when: pull-request` or `locks: plan`, lock the roots a pull request reaches without applying it | the lock Atlantis takes on every plan; under the default `locks: apply` a plan locks nothing, and with `locks: plan` the first plan locks |
| `/terragucci unlock` | with `apply.when: pull-request` or `locks: plan`, release the root locks a pull request took when it planned, applied or locked | Atlantis `unlock`, which also discards plans; none are kept here |
| run | a forge pipeline run, with its jobs | an HCP Terraform run, which is one plan and apply in one workspace |
