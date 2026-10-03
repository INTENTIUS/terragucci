---
title: Where it runs
description: Forge CI, a fountain steward, or your own machine, with the same stages.
---

The stage declarations do not change between runtimes. A schedule declared on a stage becomes a workflow trigger on a forge, a cron on a steward, or a timer in `chant operator`. Approvals live on the `chant/lifecycle` branch, so an approval recorded in one runtime counts in the others.

| Runtime | Good for | Credentials |
|---|---|---|
| Forge CI (GitHub, GitLab, Forgejo) | pull-request stages, and teams with no other runner | per-job OIDC roles or secrets |
| fountain steward | apply and drift, where one machine should own an environment | a fountain vault, so none reach your CI |
| `chant operator` | a laptop or a server you run | your shell |

## Forge CI and a steward together

Forge CI is the default, and it runs every stage, gated waves included. A steward is opt-in: set `runtime: fountain` on a project in [your config file](/terragucci/getting-started/config/).

Pull-request stages run on the forge, where the pull request lives. The apply stage runs on the steward, started by a small forge job:

```bash
chant run tf-apply --on fountain
```

A steward keeps its checkout and provider cache between runs. It runs one stage at a time, so two applies on one environment cannot overlap.

## Running your own fountain

[fountain-ops](https://intentius.io/fountain-ops/) deploys fountain with chant. Its `just up` stands one up on a laptop, and terragucci's steward validation runs against it.
