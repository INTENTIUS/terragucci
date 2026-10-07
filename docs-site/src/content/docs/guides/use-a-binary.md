---
title: Use OpenTofu or choudoufu
description: Pick the binary your roots run with, and see what changes with each.
claims: [check-diagnostics]
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

It comes from `.opentofu-version` or `.terraform-version`, then `.tofu` files, then your path. If it is the one you want, stop here.

### 2. Name the binary

Set `binary` in `terragucci.yml`.

```yaml
binary: tofu
```

The values are `terraform`, `tofu` and `choudoufu`; `npx terragucci init --binary tofu` writes the file for you. Pin the version with `version` or a `.opentofu-version` or `.terraform-version` file.

### 3. Write the pipeline again

```bash
npx terragucci init
```

```text
found 15 roots in 2 layers, tofu 1.13.1 (terragucci.yml), forge github (the origin remote (github.com))
updated .github/workflows/terragucci.yml
using terragucci.yml
```

Every job now runs in that binary's CI image, pinned by digest. Commit the file.

## What each binary changes

| Binary | Stages | State |
|---|---|---|
| `terraform` | `tf-check`, `tf-plan`, `tf-apply`, `tf-drift` | your backend |
| `tofu` | the same four | your backend |
| `choudoufu` | the same four, with choudoufu's live check in `tf-check` | tags on each resource |
| Terragrunt, calling `tofu` or `terraform` | the same four, on Terragrunt units | each unit's backend; see [Use Terragrunt](/terragucci/guides/use-terragrunt/) |

## choudoufu

[choudoufu](https://github.com/INTENTIUS/choudoufu) is the OpenTofu fork from the team behind terragucci, and `binary: choudoufu` runs the same four stages on it. Three things come with it:

| You get | Where you see it |
|---|---|
| A live check on every pull request, before any plan, with no cloud credentials | [the `tf-check` log and check report](/terragucci/reference/stages/#check) |
| No state file to host or lose: the apply writes a tag on each resource and the next plan reads it back | your cloud's own tags |
| How long a wave waited for a state lock, and how many tries it took, on a backend that locks | [the report, the trace and a metric](/terragucci/reference/observability/#state-lock-waits) |

`init` never picks choudoufu on its own: set `binary: choudoufu` or run `npx terragucci init --binary choudoufu`.

Its jobs run in the `terragucci-choudoufu` image, which carries choudoufu 0.22.0. Set `version` to run another release; each job installs it from choudoufu's GitHub releases, checked against SHA256SUMS. terragucci does not read a root's `required_version` as a choudoufu release.

With `choudoufu`, `tf-check` runs `choudoufu live-check` on each root after `validate`, against choudoufu's rules with no cloud calls. A refusal fails the job and its diagnostics go to the log and check report.

## Next

- [Use Terragrunt](/terragucci/guides/use-terragrunt/) if your roots are Terragrunt units.
- [Stages](/terragucci/reference/stages/) lists the inputs, permissions and outputs of each stage.
