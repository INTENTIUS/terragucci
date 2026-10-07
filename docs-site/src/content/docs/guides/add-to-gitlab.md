---
title: Add terragucci to a GitLab repo
description: Write .gitlab-ci.yml, add the token variable, and get a plan note on the next merge request.
claims: []
---

## What you end up with

`.gitlab-ci.yml`, a plan note and the `terragucci/plan` status on every merge request, and an apply job on the default branch. Self-managed GitLab works the same.

## Before you start

- A GitLab project with Terraform, OpenTofu or Terragrunt roots, and a runner that can run Docker images.
- Node.js 22 or later on the machine you run `init` from.
- Permission to add CI/CD variables.
- No existing `.gitlab-ci.yml`, or merge the generated jobs into it: `init` writes the whole file.

## Steps

### 1. Install and run init

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

```text
found 15 roots in 2 layers, tofu 1.13.1 (tofu on the path), forge gitlab (the origin remote (gitlab.com))
wrote .gitlab-ci.yml
wrote chant.workspace.json
no terragucci.yml needed (defaults fit)
```

Commit [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) with the pipeline. gitlab.com and hostnames starting `gitlab.` are recognised; for any other host pass `--forge gitlab`, which records it in `terragucci.yml`.

### 2. Add the token

In Settings, CI/CD, Variables, add `GITLAB_TOKEN` as a masked variable holding a project access token with the `api` scope, which the plan job uses to post the note and status. To use another variable, set `token_env` in `terragucci.yml`.

### 3. Give the jobs cloud access

Set `oidc` in `terragucci.yml` and run `init` again, and GitLab jobs get roles through `id_tokens`:

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

See [Environment variables and credentials](/terragucci/reference/environment/). GitLab-managed Terraform state limits concurrent inits, so fewer Terragrunt units run at once.

### 4. Commit and open a merge request

```bash
git switch -c add-terragucci
git add .gitlab-ci.yml chant.workspace.json package.json package-lock.json
git commit -m "Add terragucci"
git push -u origin add-terragucci
```

Change a line in one root and open a merge request. The plan note links to the HTML report, a job artifact, and the widget shows the create, update and delete counts.

### 5. Require the pipeline

In Settings, Merge requests, turn on "Pipelines must succeed". A failed plan then blocks the merge.

### 6. Make approval possible

A waiting wave cannot be approved until your key is in `.chant/allowed_signers` on the default branch and [chant](/terragucci/concepts/glossary/#chant) is installed ([both steps](/terragucci/getting-started/#before-your-first-approval)).

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/)
- [The generated pipeline](/terragucci/reference/pipeline/)
