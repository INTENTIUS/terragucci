---
title: Turn on drift checks
description: Plan every root on a schedule and get a grouped report of what changed outside Terraform.
claims: [drift]
---

## What you end up with

A scheduled `tf-drift` run that plans every root and one issue reporting the drift, grouped like a pull-request plan.

## Before you start

- A repo with the pipeline from [Get your first plan note](/terragucci/getting-started/).
- A plan role that can read your cloud; drift plans use the same read-only role as pull requests.
- Terraform or OpenTofu roots, or Terragrunt units (the issue then names units).
- A cron expression in UTC.

## Steps

### 1. Set a schedule

Put it in `terragucci.yml`.

```yaml
drift: "17 4 * * *"
```

Pick an odd minute. Forge schedulers are busiest on the hour.

### 2. Check the file

```bash
npx terragucci config check
```

```text
terragucci.yml: ok
```

A bad value is listed as a problem, and the command exits 2.

### 3. Write the pipeline again

```bash
npx terragucci init
```

This adds a `drift` job with the cron and a `workflow_dispatch` trigger. On GitLab, set the same cron under CI/CD, Schedules. `GITLAB_TOKEN` (or the `token_env` variable) needs the `api` scope. Commit and merge.

### 4. Wait for the first run, or start one

`terragucci stage tf-drift` plans each root with `-refresh-only`, comparing state with real objects. Only an object changed or deleted outside Terraform counts as drift, and a merged but unapplied change does not.

### 5. Read the issue

Each project has at most one open issue, `terragucci: drift found`, updated on each run. It closes when every root is clean, and stays as it is if a root could not be planned. The job never applies. A root that cannot be refreshed fails it; drift alone does not.

### 6. Correct the drift

Apply the code to put the object back, or read and merge the pull request that writes the live value into a literal attribute. [Responses](/terragucci/reference/responses/#drift) lists what is only reported.

## Next

- [Stages](/terragucci/reference/stages/) lists what `tf-drift` reads and writes.
