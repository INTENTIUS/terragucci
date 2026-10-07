---
title: Use Terragrunt
description: Add terragucci to a Terragrunt repo, where each unit is a root and dependency order decides the waves.
claims: [tg-zero-config, tg-waves, tg-check, tg-affected, tg-refuse, tg-gate-wait, tg-gate-refuse, tg-sealed]
---

## What you end up with

A pipeline that checks with `terragrunt hcl fmt` and `hcl validate`, plans the units a pull request reaches, and applies a wave at a time behind the same gate as plain roots: the wave's plans saved, approved by their set digest, and applied as saved.

## Before you start

- A Terragrunt repo with a `root.hcl` or `terragrunt.hcl`.
- Terragrunt 1.1 or later.
- terragucci installed: [Get your first plan note](/terragucci/getting-started/) covers it.

## Steps

### 1. Run init

```bash
npx terragucci init --dry-run
```

terragucci notices Terragrunt on its own. Each unit is a root, taken from `terragrunt find`, so `.terragrunt-filters` is honoured. Implicit stacks, directories of units, appear as labels in the report.

Explicit stacks are not supported. `init` skips a directory holding a `terragrunt.stack.hcl` and names it in its notes.

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

Commit the pipeline and [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson), which lists each wave's gate, and open a pull request. Only the units the change reaches are planned. Before the first wave waits for you, set up the signers file as [Approve a waiting wave](/terragucci/guides/approve-a-wave/) describes.

## What is different in a Terragrunt repo

| What | How |
|---|---|
| Which units a change reaches | Terragrunt's own change detection, plus files a module reads with `file()`, modules called from inside modules, and stack templates |
| Units that depend on a changed unit | they go out in later waves, planned only after the units they read from have applied |
| `mock_outputs` | a unit whose plan would read mock values is not planned; it waits for its upstream to apply, so no approval covers a made-up value |
| Each wave | one apply job: the canary units are wave 1 and the rest wave 2. The job plans the wave's units with one `terragrunt run --all`, saving each plan, and applies the saved plans with a second one |
| The gate | `gate` works as for plain roots, and an approval is sealed the same way. The set digest covers the units whose plan changes something. A unit that reads another unit of its wave, whose plan changes its outputs, plans and goes through the gate in a second pass, after that unit applied |
| Credentials | a plan role and an apply role chosen by the unit's path; a unit that sets its own `iam_role` keeps it |

## Next

- [The same shop on Terragrunt](/terragucci/tutorial/terragrunt/) runs this on an example.
- [The generated pipeline](/terragucci/reference/pipeline/#terragrunt) shows how roles follow unit paths.
