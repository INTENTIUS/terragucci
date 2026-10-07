---
title: Add terragucci to a Forgejo repo
description: Write the Forgejo Actions workflow and get a plan note on the next pull request, on Forgejo, Codeberg or Gitea-compatible hosts.
claims: [boot, check, affected]
---

## What you end up with

`.forgejo/workflows/terragucci.yml`, a plan note and the `terragucci/plan` status on every pull request, and an apply job on the default branch.

## Before you start

- A Forgejo repo with Terraform, OpenTofu or Terragrunt roots, with Actions enabled.
- A runner with the label `docker`, which the generated jobs ask for.
- Node.js 22 or later on the machine you run `init` from.

## Steps

### 1. Install and run init

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

```text
found 15 roots in 2 layers, tofu 1.13.1 (tofu on the path), forge forgejo (the origin remote (codeberg.org))
wrote .forgejo/workflows/terragucci.yml
wrote chant.workspace.json
no terragucci.yml needed (defaults fit)
```

Commit [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) too. For hosts other than codeberg.org, `forgejo.*` and `gitea.*`, pass `--forge forgejo` once; `url` in `terragucci.yml` names a host on another scheme or port.

### 2. Check the concurrency group

The generated workflow names a group that does not cancel, so a second push waits for the first apply instead of cancelling it ([details](/terragucci/reference/pipeline/#one-apply-at-a-time)).

### 3. Give the jobs cloud access

On Forgejo 15 with Forgejo Runner 12.5 or later, set `oidc` in `terragucci.yml` and run `init` again; the jobs set `enable-openid-connect: true` and exchange the identity token for roles.

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

The issuer is your Forgejo URL plus `/api/actions`; the role's trust policy must accept it and your repo. Older versions serve no token: leave `oidc` unset and give the runner static credentials ([details](/terragucci/reference/environment/#cloud-roles-over-oidc)).

### 4. Commit and open a pull request

```bash
git switch -c add-terragucci
git add .forgejo chant.workspace.json package.json package-lock.json
git commit -m "Add terragucci"
git push -u origin add-terragucci
```

Change a line in one root and open a pull request. The plan note links to the run, whose `terragucci-report` artifact is the report.

### 5. Require the status

In the repo's branch protection, require the `terragucci/plan` status context.

### 6. Make approval possible

A waiting wave cannot be approved until your key is in `.chant/allowed_signers` on the default branch and [chant](/terragucci/concepts/glossary/#chant) is installed ([both steps](/terragucci/getting-started/#before-your-first-approval)).

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/)
- [The tutorial](/terragucci/tutorial/) runs this on a local Forgejo with a 15-root example.
