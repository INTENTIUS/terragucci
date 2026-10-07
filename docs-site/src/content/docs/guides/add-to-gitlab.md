---
title: Add terragucci to a GitLab repo
description: Write .gitlab-ci.yml, add the token variable, and get a plan note on the next merge request.
claims: []
---

## What you end up with

`.gitlab-ci.yml` in your project, a plan note and the `terragucci/plan` status on every merge request, and an apply job on the default branch. A self-managed GitLab works the same as gitlab.com.

## Before you start

- A GitLab project with Terraform, OpenTofu or Terragrunt roots, and a runner that can run Docker images.
- Node.js 22 or later on the machine you run `init` from.
- Permission to add CI/CD variables.
- No existing `.gitlab-ci.yml`, or a willingness to merge the generated jobs into it. `init` writes the whole file.

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

[`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) lists the approval gate of each wave. Commit it with the pipeline.

terragucci recognises gitlab.com and hostnames that start with `gitlab.`. For any other host, pass `--forge gitlab`. It then writes `terragucci.yml` with the forge recorded, so the next run needs no flag.

### 2. Add the token

In Settings, CI/CD, Variables, add `GITLAB_TOKEN` as a masked variable. Use a project access token with the `api` scope. The plan job posts the merge-request note and the commit status with it. If you would rather name another variable, set `token_env` in `terragucci.yml`.

### 3. Give the jobs cloud access

Set `oidc` in `terragucci.yml` and run `init` again, and GitLab jobs get roles through `id_tokens`:

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

[Environment variables and credentials](/terragucci/reference/environment/) has the details. GitLab-managed Terraform state limits concurrent inits, so terragucci runs fewer Terragrunt units at once on it.

### 4. Commit and open a merge request

```bash
git switch -c add-terragucci
git add .gitlab-ci.yml chant.workspace.json package.json package-lock.json
git commit -m "Add terragucci"
git push -u origin add-terragucci
```

Change a line in one root and open a merge request. The check job runs, then the plan job posts its note. The plan job keeps the report as a job artifact, and the note links to the HTML report there. The merge-request widget shows the create, update and delete counts.

### 5. Require the pipeline

In Settings, Merge requests, turn on "Pipelines must succeed". A failed plan then blocks the merge.

### 6. Make approval possible

Approvals are sealed with a key. Until your key is in `.chant/allowed_signers` on the default branch and [chant](/terragucci/concepts/glossary/#chant) is installed, a waiting wave cannot be approved. The [getting-started page](/terragucci/getting-started/#before-your-first-approval) has both steps.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/)
- [The generated pipeline](/terragucci/reference/pipeline/)
