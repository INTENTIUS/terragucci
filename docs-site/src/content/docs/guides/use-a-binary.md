---
title: Use OpenTofu, choudoufu or CDK Terrain
description: Pick the binary your roots run with, and see what changes with each.
---

## What you end up with

A pipeline whose jobs run the binary you chose, in the CI image built for it.

## Before you start

- terragucci installed in the repo: [Get your first plan note](/terragucci/getting-started/) covers it.
- Your roots already work with the binary on your own machine.

## Steps

### 1. See what terragucci picked

```bash
npx terragucci init --dry-run
```

The first line names the binary and why:

```text
found 15 roots in 2 layers, tofu 1.13.1 (tofu on the path), forge github (the origin remote (github.com))
```

The binary comes from `.opentofu-version` or `.terraform-version`, then from `.tofu` files, then from what is on your path. If it is the one you want, stop here.

### 2. Name the binary

Set `binary` in `terragucci.yml`:

```yaml
binary: tofu
```

The values are `terraform`, `tofu`, `choudoufu` and `cdktn`. `npx terragucci init --binary tofu` sets it for you and writes the file when there is none. Pin the version with `version`, or with a `.opentofu-version` or `.terraform-version` file.

### 3. Write the pipeline again

```bash
npx terragucci init
```

```text
found 15 roots in 2 layers, tofu 1.13.1 (terragucci.yml), forge github (the origin remote (github.com))
updated .github/workflows/terragucci.yml
using terragucci.yml
```

Every job now runs in the CI image for that binary, pinned by digest once the image is published. Commit the file and your next pull request runs on it.

## What each binary changes

| Binary | Stages | State |
|---|---|---|
| `terraform` | `tf-check`, `tf-plan`, `tf-apply`, `tf-drift` | your backend |
| `tofu` | the same four | your backend |
| `cdktn` | the same four | your backend |
| `choudoufu` | the same four, plus the three below | tags on each resource |
| Terragrunt, calling `tofu` or `terraform` | the same four, on Terragrunt units | each unit's backend; see [Use Terragrunt](/terragucci/guides/use-terragrunt/) |

## choudoufu

[choudoufu](https://github.com/INTENTIUS/choudoufu) is a fork of OpenTofu. It keeps no state file. Each resource it manages carries tags that name its owner, and a plan reads the live resources by those tags.

You need none of this to use terragucci with Terraform or OpenTofu. The choudoufu stages are separate workflows that appear only when the binary is `choudoufu`.

| choudoufu stage | What it does |
|---|---|
| `choudoufu-live-check` | checks the root against choudoufu's rules, with no cloud calls |
| `choudoufu-discover` | lists live resources nobody owns yet, on a schedule |
| `choudoufu-adopt` | claims discovered resources by writing their owner tags, after an approval |

## Next

- [Use Terragrunt](/terragucci/guides/use-terragrunt/) if your roots are Terragrunt units.
- [Stages](/terragucci/reference/stages/) lists the inputs, permissions and outputs of each stage.
