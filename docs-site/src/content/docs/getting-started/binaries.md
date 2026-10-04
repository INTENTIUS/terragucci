---
title: Which binary you run
description: Terraform, OpenTofu, Terragrunt, CDK Terrain or choudoufu, and what changes with each.
---

terragucci takes the binary as a setting. Your choice decides which stages exist and how a plan reads live state.

| Binary | Stages | State |
|---|---|---|
| `terraform` | `tf-check`, `tf-plan`, `tf-apply`, `tf-drift` | your backend |
| `tofu` | the same four | your backend |
| Terragrunt, calling `tofu` or `terraform` | the same four, on Terragrunt units | each unit's backend |
| `choudoufu` | the same four, plus the three below | tags on each resource |

## Terragrunt

terragucci notices Terragrunt on its own: a `root.hcl`, `terragrunt.hcl` or `terragrunt.stack.hcl` turns it on. Each unit is a root, Terragrunt's dependency graph decides the wave order, and `binary` names the tool Terragrunt calls.

| What | How |
|---|---|
| Which units a change reaches | Terragrunt's own change detection, plus files a module reads with `file()`, modules called from inside modules, and stack templates |
| Units that depend on a changed unit | they go out in later waves, planned only after the units they read from have applied |
| `mock_outputs` | a unit whose plan would read mock values is not planned; it waits for its upstream to apply, so no approval covers a placeholder |
| Each wave | one `terragrunt run --all` over exactly that wave's units |
| Credentials | a plan role and an apply role chosen by the unit's path; a unit that sets its own `iam_role` keeps it |

An optional `terragrunt:` block in `terragucci.yml` tunes it. Terragrunt 1.1 or later is required.

```yaml
binary: tofu
terragrunt:
  version: 1.1.6
  exclude: ["live/sandbox/**"]
  parallelism: 16
  dependents: follow
  credentials:
    "live/prod/**": { plan: arn:aws:iam::111:role/plan, apply: arn:aws:iam::111:role/apply }
```

| Key | Default | Meaning |
|---|---|---|
| `version` | the version `terragrunt_version_constraint` pins exactly, or terragucci's | the Terragrunt release the jobs run |
| `exclude` | none | unit globs to leave out; `catalog/**` and `.terragrunt-cache` are always left out |
| `parallelism` | 3 for GitLab-managed state, else 16 | how many units one `run --all` runs at once |
| `dependents` | `follow` | `follow` plans dependents in later waves; `plan` also previews them on the pull request, marked provisional and left out of every digest |
| `credentials` | none | plan and apply roles by unit path glob; see [Credentials](/terragucci/reference/pipeline/#terragrunt) |

Units come from `terragrunt find`, so `.terragrunt-filters` is honoured. Implicit stacks, directories of units, are labels in the report.

## What choudoufu is

[choudoufu](https://github.com/INTENTIUS/choudoufu) is a fork of OpenTofu. It keeps no state file. Each resource it manages carries tags that name its owner, and a plan reads the live resources by those tags.

You need none of this to use terragucci with Terraform or OpenTofu. The choudoufu stages are separate workflows that appear only when the binary is `choudoufu`.

| choudoufu stage | What it does |
|---|---|
| `choudoufu-live-check` | checks the root against choudoufu's rules, with no cloud calls |
| `choudoufu-discover` | lists live resources nobody owns yet, on a schedule |
| `choudoufu-adopt` | claims discovered resources by writing their owner tags, after an approval |
