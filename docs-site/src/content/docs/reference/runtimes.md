---
title: Where it runs
description: Every stage runs on your forge's CI, and an approval is a record in your repository.
---

Every stage runs as a job on your forge's CI: GitHub Actions, GitLab CI or Forgejo Actions. A schedule declared on a stage becomes a workflow trigger. `runtime` in [your config file](/terragucci/reference/config/) takes one value, `forge`, which is also the default.

| Forge | What runs the jobs | Credentials |
|---|---|---|
| GitHub | GitHub Actions | per-job OIDC roles or secrets |
| GitLab | GitLab CI, with the summary as the merge-request note | per-job OIDC roles or CI variables |
| Forgejo | Forgejo Actions, on your own instance | per-job OIDC roles or secrets |

## Approvals outside CI

Approvals live on the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch, so an approval recorded with [`chant approve`](/terragucci/concepts/glossary/#chant) on your laptop counts in the next CI run. Each stage converges on the declared state, so a run that stops partway is simply run again.

Each stage also runs from your shell as `terragucci stage <name>`, with your own credentials; [Stages](/terragucci/reference/stages/) lists them.
