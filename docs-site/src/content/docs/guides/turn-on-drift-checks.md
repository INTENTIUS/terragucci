---
title: Turn on drift checks
description: Plan every root on a schedule and get a grouped report of what changed outside Terraform.
claims: [drift]
---

## What you end up with

A scheduled `tf-drift` run that plans every root against what exists, and one issue that reports the drift, grouped like a pull-request plan.

## Before you start

- A repo with the pipeline from [Get your first plan note](/terragucci/getting-started/).
- A plan role that can read your cloud. Drift plans run with the same read-only role as pull requests.
- Terraform or OpenTofu roots, or Terragrunt units. In a Terragrunt repo the drift job refresh-plans every unit through Terragrunt, and the issue names units where it would name roots.
- A time that suits you. The schedule is a cron expression in UTC.

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

The pipeline gets a `drift` job that runs on the schedule. On GitHub and Forgejo the generated workflow carries the cron and a `workflow_dispatch` trigger, so you can also start a check by hand. On GitLab, set the same cron under CI/CD, Schedules, because GitLab keeps schedules outside the pipeline file. Because drift writes issues, `GITLAB_TOKEN`, or the variable `token_env` names, needs the `api` scope. Commit and merge.

### 4. Wait for the first run, or start one

The job runs `terragucci stage tf-drift`, which plans each root with `-refresh-only`. That plan compares state with the real objects and ignores the code. A change merged but not yet applied is therefore not drift. An object changed or deleted outside Terraform is.

The report groups roots whose drift is the same and lists a deleted object by name with its root. The job keeps the report as an artifact, as the plan job does.

### 5. Read the issue

Each project has at most one open issue, titled `terragucci: drift found`. It opens when drift is found and updates in place on the next run. When every root is clean it closes, with a comment that names the commit. If a root could not be planned, the issue stays as it is, since that root is unknown.

The job never applies. A root that cannot be refreshed fails the job, and drift alone does not.

### 6. Correct the drift

You can apply the code as it is, which puts the object back. Or you can accept the live value, which terragucci proposes as a pull request. where the changed attribute is a literal in the root, the pull request writes the live value there. Merging it accepts the change made outside Terraform, so read it first. [Responses to pipeline events](/terragucci/reference/responses/#drift) lists what is only reported, such as values set from a variable or inside a module.

## Next

- [Have an agent propose drift fixes](/terragucci/guides/agent-drift-fixes/)
- [Stages](/terragucci/reference/stages/) lists what `tf-drift` reads and writes.
