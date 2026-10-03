---
title: What terragucci is
description: The stages, who they are for, and what they are built on.
---

:::tip[Using a coding agent?]
Hand it [this prompt](/terragucci/getting-started/agents/#hand-your-agent-this). It reads [`llms.txt`](https://intentius.io/terragucci/llms.txt), sets terragucci up and opens a pull request.
:::

terragucci runs the lifecycle around your Terraform roots. Your Terraform code and its state stay yours. The kit only adds the steps around them.

| Stage | When it runs | What it does |
|---|---|---|
| `tf-check` | every pull request | format and validate |
| `tf-plan` | every pull request | plan the affected roots and post one grouped summary |
| `tf-apply` | a push to the main branch | apply in waves, each behind an approval tied to that wave's plans |
| `tf-drift` | on a schedule | plan every root and report any drift, grouped |
| `tf-publish` | a change under `modules/` on the main branch | publish each changed module at a new version |
| `tf-rollout` | when you run `terragucci rollout` | move a module's pin one wave at a time, one pull request per wave |

[Stages](/terragucci/reference/stages/) explains waves and the grouped summary. [Your config file](/terragucci/getting-started/config/) covers setup, which for most repos is nothing.

## Who it is for

Anyone running Terraform or OpenTofu who wants these stages without writing them per repository. choudoufu users get the same stages plus three of their own; see [Which binary you run](/terragucci/getting-started/binaries/).

## What it is built on

The stages are [chant](https://intentius.io/chant/) Ops from chant's terraform lexicon. chant renders each one into a workflow for your forge. This repo holds the declarations, and the YAML is generated from them.

An approval is a record on a `chant/lifecycle` branch in your repository. It names the plan it approves, so a changed plan needs a new approval.

## Where it runs

The same stages can run on a forge, on a [fountain](https://github.com/managoat/fountain) steward or on your own machine. [Where it runs](/terragucci/reference/runtimes/) compares them.
