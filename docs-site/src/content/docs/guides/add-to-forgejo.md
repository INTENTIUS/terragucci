---
title: Add terragucci to a Forgejo repo
description: Write the Forgejo Actions workflow and get a plan note on the next pull request, on Forgejo, Codeberg or Gitea-compatible hosts.
claims: [boot, check, affected]
---

## What you end up with

`.forgejo/workflows/terragucci.yml` in your repo, a plan note and the `terragucci/plan` status on every pull request, and an apply job on the default branch.

## Before you start

- A Forgejo repo with Terraform, OpenTofu or Terragrunt roots, with Actions enabled.
- A runner that carries the label `docker`. The generated jobs ask for it and run in terragucci's CI image.
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

terragucci recognises codeberg.org and hostnames that start with `forgejo.` or `gitea.`. For any other host, pass `--forge forgejo` once. It writes `terragucci.yml` with the forge recorded, and `url` there names the host when it is on another scheme or port.

### 2. Check the concurrency group

Forgejo cancels the earlier runs of a branch when a push arrives, even one that is applying, unless the workflow names a group. The generated workflow names one that does not cancel, so a second push waits for the first apply. [The generated pipeline](/terragucci/reference/pipeline/#one-apply-at-a-time) explains the lock behind it.

### 3. Give the jobs cloud access

The plan job runs `plan` and needs to read your state and providers. Forgejo 15 and Forgejo Runner 12.5 serve identity tokens to jobs. On those versions or later, set `oidc` in `terragucci.yml` and run `init` again. The plan and apply jobs then set `enable-openid-connect: true` and exchange Forgejo's identity token for roles.

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
```

The token's issuer is your Forgejo URL followed by `/api/actions`, and the role's trust policy must accept it and your repo. An older Forgejo or runner serves no token. There, leave `oidc` unset and give the runner static credentials instead. [Environment variables and credentials](/terragucci/reference/environment/#cloud-roles-over-oidc) has the details.

### 4. Commit and open a pull request

```bash
git switch -c add-terragucci
git add .forgejo chant.workspace.json package.json package-lock.json
git commit -m "Add terragucci"
git push -u origin add-terragucci
```

Change a line in one root and open a pull request. The check job runs, then the plan job posts its note. The report is the run's `terragucci-report` artifact, and the note links to the run.

### 5. Require the status

In the repo's branch protection, require the `terragucci/plan` status context.

### 6. Make approval possible

Approvals are sealed with a key. Until your key is in `.chant/allowed_signers` on the default branch and chant is installed, a waiting wave cannot be approved. The [getting-started page](/terragucci/getting-started/#before-your-first-approval) has both steps.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/)
- [The tutorial](/terragucci/tutorial/) runs this on a local Forgejo with a 15-root example.
