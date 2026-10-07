---
title: Add terragucci to a GitHub repo
description: Write the GitHub Actions workflow, require its status in branch protection, and get a plan note on the next pull request.
claims: []
---

## What you end up with

The workflow file `.github/workflows/terragucci.yml`, a `terragucci/plan` status on every pull request and an apply job on the default branch.

## Before you start

- A GitHub repo with Terraform or OpenTofu roots, and Actions enabled.
- Node.js 22 or later on the machine you run `init` from.
- Permission to edit branch protection, for the last step.

## Steps

### 1. Install and run init

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

```text
found 15 roots in 2 layers, tofu 1.13.1 (tofu on the path), forge github (the origin remote (github.com))
wrote .github/workflows/terragucci.yml
wrote chant.workspace.json
no terragucci.yml needed (defaults fit)
```

[`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) lists the approval gate of each wave. Commit it with the pipeline.

The forge comes from the `origin` remote. Add `--forge github` when your remote does not say.

### 2. Read the permissions it asks for

The workflow reads the repo by default. The plan job adds `statuses: write` and `pull-requests: write` to post the note and the status. It runs only for pull requests from branches in the same repo, so a fork's pull request reaches no job with those permissions. Nothing in the file needs a secret you create: the jobs use the run's `github.token`.

### 3. Give the jobs cloud access

The plan job runs `plan`, so it needs to read your state and providers. To avoid long-lived keys, set `oidc` in `terragucci.yml` and run `init` again. The jobs then exchange GitHub's identity token for roles.

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

The role's trust policy must accept your repo. [Environment variables and credentials](/terragucci/reference/environment/) has the details.

### 4. Commit and open a pull request

```bash
git switch -c add-terragucci
git add .github chant.workspace.json package.json package-lock.json
git commit -m "Add terragucci"
git push -u origin add-terragucci
```

Change a line in one root so the pull request has something to plan. The plan job finishes with one terragucci comment on the pull request and a `terragucci/plan` status.

### 5. Require the status

In the repo's branch protection for the default branch, require `terragucci/plan`. Pull requests can no longer merge while the plan fails or is missing.

### 6. Make approval possible

Approvals are sealed with a key. Until your key is in `.chant/allowed_signers` on the default branch and [chant](/terragucci/concepts/glossary/#chant) is installed, a waiting wave cannot be approved. The [getting-started page](/terragucci/getting-started/#before-your-first-approval) has both steps.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/)
- [The generated pipeline](/terragucci/reference/pipeline/) explains apply order, statuses and stale notes.
