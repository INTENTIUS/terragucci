---
title: Use Terragrunt
description: Add terragucci to a Terragrunt repo, where each unit is a root and dependency order decides the waves.
claims: [tg-zero-config, tg-waves, tg-check, tg-affected, tg-refuse]
---

## What you end up with

A pipeline that checks with `terragrunt hcl fmt` and `hcl validate`, plans the units a pull request reaches, and applies a wave at a time with one `terragrunt run --all`.

## Before you start

- A Terragrunt repo with a `root.hcl`, `terragrunt.hcl` or `terragrunt.stack.hcl`.
- Terragrunt 1.1 or later.
- terragucci installed: [Get your first plan note](/terragucci/getting-started/) covers it.

## Steps

### 1. Run init

```bash
npx terragucci init --dry-run
```

terragucci notices Terragrunt on its own. Each unit is a root, taken from `terragrunt find`, so `.terragrunt-filters` is honoured. Implicit stacks, directories of units, appear as labels in the report.

### 2. Name the tool Terragrunt calls

`binary` names the tool Terragrunt runs underneath:

```yaml
binary: tofu
```

### 3. Tune it, if you need to

An optional `terragrunt:` block sets the Terragrunt version, parallelism and roles by unit path. It also lists units to leave out and says how dependents are planned. [terragucci.yml keys](/terragucci/reference/config/#the-terragrunt-block) lists each key.

```yaml
terragrunt:
  exclude: ["live/sandbox/**"]
  dependents: follow
```

### 4. Write the pipeline

```bash
npx terragucci init
```

Commit the file and open a pull request. Only the units the change reaches are planned.

## What is different in a Terragrunt repo

| What | How |
|---|---|
| Which units a change reaches | Terragrunt's own change detection, plus files a module reads with `file()`, modules called from inside modules, and stack templates |
| Units that depend on a changed unit | they go out in later waves, planned only after the units they read from have applied |
| `mock_outputs` | a unit whose plan would read mock values is not planned; it waits for its upstream to apply, so no approval covers a placeholder |
| Each wave | one `terragrunt run --all` over exactly that wave's units |
| Credentials | a plan role and an apply role chosen by the unit's path; a unit that sets its own `iam_role` keeps it |

## Next

- [The same shop on Terragrunt](/terragucci/tutorial/terragrunt/) runs this on an example.
- [The generated pipeline](/terragucci/reference/pipeline/#terragrunt) shows how roles follow unit paths.
