---
title: Which binary you run
description: Terraform, OpenTofu or choudoufu, and what changes with each.
---

terragucci is planned to take the binary as a setting. Your choice decides which stages exist and how a plan reads live state.

| Binary | Stages | State |
|---|---|---|
| `terraform` | `tf-check`, `tf-plan`, `tf-apply`, `tf-drift` | your backend |
| `tofu` | the same four | your backend |
| `choudoufu` | the same four, plus the three below | tags on each resource |

## What choudoufu is

[choudoufu](https://github.com/INTENTIUS/choudoufu) is a fork of OpenTofu. It keeps no state file. Each resource it manages carries tags that name its owner, and a plan reads the live resources by those tags.

You need none of this to use terragucci with Terraform or OpenTofu. The choudoufu stages are separate workflows that appear only when the binary is `choudoufu`.

| choudoufu stage | What it does |
|---|---|
| `choudoufu-live-check` | checks the root against choudoufu's rules, with no cloud calls |
| `choudoufu-discover` | lists live resources nobody owns yet, on a schedule |
| `choudoufu-adopt` | claims discovered resources by writing their owner tags, after an approval |
