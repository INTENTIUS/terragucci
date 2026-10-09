---
title: Where it runs
description: Every stage runs on your forge's CI, and an approval is a record in your repository.
---

Every stage runs as a job on your forge's CI, and a stage's schedule becomes a workflow trigger. `runtime` in [your config file](/terragucci/reference/config/) takes one value, `forge`, the default.

| Forge | What runs the jobs | Credentials |
|---|---|---|
| GitHub | GitHub Actions | per-job OIDC roles or secrets |
| GitLab | GitLab CI, with the summary as the merge-request note | per-job OIDC roles or CI variables |
| Forgejo | Forgejo Actions, on your own instance | per-job OIDC roles or secrets |

## Approvals outside CI

Run [`terragucci approve`](/terragucci/reference/cli/#approve) on your laptop: it records the approval on the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch and restarts the waiting wave with your forge token. With `apply.resume` set, the scheduled resume job picks up any wave it could not restart ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)).

Each stage also runs from your shell as `terragucci stage <name>`, with your own credentials; [Stages](/terragucci/reference/stages/) lists them.
