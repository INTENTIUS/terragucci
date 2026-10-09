---
title: Where it runs
description: Every stage runs on your forge's CI, and an approval is a record in your repository.
---

Each stage is a job on your forge's CI, and its schedule a workflow trigger. `runtime` in [your config file](/terragucci/reference/config/) takes one value, `forge`, the default.

| Forge | What runs the jobs | Credentials |
|---|---|---|
| GitHub | GitHub Actions | per-job OIDC roles or secrets |
| GitLab | GitLab CI, with the summary as the merge-request note | per-job OIDC roles or CI variables |
| Forgejo | Forgejo Actions, on your own instance | per-job OIDC roles or secrets |

## Approvals outside CI

[`terragucci approve`](/terragucci/reference/cli/#approve), run on your laptop, records the approval on the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch and restarts the waiting wave with your forge token. With `apply.resume` set, the scheduled resume job picks up any wave it could not restart ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)).

Each stage also runs from your shell, with your own credentials, as `terragucci stage <name>`; [Stages](/terragucci/reference/stages/) lists them.
