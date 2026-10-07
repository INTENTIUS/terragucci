---
title: Glossary
description: The words terragucci, chant and the example use, and the ones that mean something different in Terraform and HCP Terraform.
---

Each docs page links a word here the first time it uses it, unless the page explains the word itself.

## Your code

### root

A directory that Terraform or OpenTofu runs in. Its files declare a `backend` or a `cloud` block, or they configure a provider. A child module does neither. `init` finds these directories on its own, and `roots:` in `terragucci.yml` names them by glob instead. Every stage runs the binary once in each.

A directory with a `cloud` block counts like any other, and the jobs run the binary's own `plan` and `apply` in it. When its HCP Terraform workspace uses remote execution, Terraform carries those runs out on HCP Terraform's workers with the workspace's variables and credentials. The job's `oidc` roles do not reach them there. Set the workspace to local execution to keep the runs in your CI while HCP Terraform holds the state.

### unit

In Terragrunt, a directory with a `terragrunt.hcl` is a unit. terragucci treats each unit as a root and takes the list from `terragrunt find`. A directory of units is an implicit stack; it appears as a label in the report.

### layer

One step of the dependency order. A root that reads another through `terraform_remote_state` sits in a later layer than the one it reads, and so does a unit with a `dependency` block. `init --dry-run` counts the layers, and `tf-plan` plans one layer at a time.

### wave

A batch of roots that `tf-apply` applies together, behind its own approval. Waves are built from layers. The roots named in `waves.canary` go first in waves of their own, and the rest follow layer by layer, so nothing in a wave reads anything else in it. In a Terragrunt repo the canary units are wave 1 and the rest wave 2. The wave's job plans its units with one `terragrunt run --all`, and Terragrunt orders the units inside it. The gates take the waves' names: `wave-1`, `wave-2` and so on.

### plan digest

A hash of one root's plan. The job takes it before anything is redacted or rendered.

### set digest

The hash over the plan digest of every root in a wave. An approval names it, so the approval covers those plans and no others. When one plan in the wave changes, the set digest changes too and the wave refuses to apply.

### gate

The point where a wave can wait for a person. The `gate` setting decides which waves wait: `on-destroy` (the default), `always` or `never`. A waiting wave's job exits with code 3 and prints the `chant approve` command for it.

## Approvals

### chant

The tool terragucci's stages are written in. [chant](https://intentius.io/chant/) declares a pipeline in TypeScript and renders it for GitHub Actions, GitLab CI or Forgejo Actions. That is how `init` writes your forge's own workflow file. Install chant (`npm i -D @intentius/chant`) on the machine you approve from, because `chant approve` writes approvals. The pipeline's jobs find what they need in terragucci's CI image.

### chant/lifecycle

A branch of your repository that holds approvals and the records the apply job writes. Each approval is a commit on it. Protect it so that only the apply job's identity can push to it, and block force pushes and deletion. [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/) says why it is a branch.

### chant.workspace.json

chant's file at the root of your repository, which `init` writes. For terragucci it lists the apply waves' gates under `identity.gates`. It has nothing to do with Terraform workspaces or HCP Terraform workspaces.

### identity.gates

The key in `chant.workspace.json` that lists gates whose approvals must be sealed. `init` lists every wave's gate. Once the list names any gate, the apply job counts an approval only when its seal verifies against `.chant/allowed_signers` at base, the commit before the one it applies.

### .chant/allowed_signers

The signers file. It has one line per person who may approve, with their ssh public key, in ssh-keygen's allowed_signers format. The job reads it from the commit before the one it applies, so a change cannot loosen the rule that judges it. [Set up the signers file](/terragucci/guides/approve-a-wave/#set-up-the-signers-file) shows one.

### seal

The ssh signature that `chant approve --sign` puts over an approval record. A record whose seal does not verify against the signers file counts for nothing. Editing a record after it was sealed breaks the seal.

## Other tools

### fountain

A separate runtime that runs chant stages on a long-lived machine instead of in a CI job. You meet the word in chant's docs. terragucci's pipelines run on your forge's CI and never on [fountain](https://github.com/managoat/fountain).

### steward

fountain's word for the machine that runs stages for one environment. terragucci has no steward.

### floci

A local stand-in for the AWS API. The tutorial's example applies its roots to floci, so you need no AWS account to run it. The validation stack checks every generated pipeline against it too. floci keeps no tags, so on floci every root's tags show as drift.

### choudoufu

A fork of OpenTofu that keeps no state file. Each resource it manages carries tags that name its owner. With `binary: choudoufu`, terragucci adds its own checks and stages. [Use OpenTofu, choudoufu or CDK Terrain](/terragucci/guides/use-a-binary/#choudoufu) covers them, and [its repository](https://github.com/INTENTIUS/choudoufu) has the rest.

## Words that mean something else in Terraform

| Here | What it means here | Not to be confused with |
|---|---|---|
| `chant.workspace.json` | chant's file that lists the gates | a Terraform CLI workspace or an HCP Terraform workspace. terragucci selects no Terraform workspace; each root plans in the one the binary picks, `default` unless `TF_WORKSPACE` says otherwise |
| `--mode apply` on `rollout`, `respond` and `reconcile` | push the commit or open the pull request that the dry run described | `terraform apply`, which none of the three runs |
| layer | a step of the dependency order | a wave, which is an apply batch built from layers, canary roots first |
| `/terragucci apply` | run `tf-apply` again at a merged pull request's merge commit; a gated wave still needs its sealed approval | an Atlantis `apply` comment, which applies the pull request's plan before the merge |
| run | a forge pipeline run, with its jobs | an HCP Terraform run, which is one plan and apply in one workspace |
