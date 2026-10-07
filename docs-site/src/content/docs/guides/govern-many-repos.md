---
title: Govern many repos from one place
description: List your projects in a control repo and let terragucci open a pull request in each one that needs a change.
claims: [reconcile]
---

## What you end up with

A control repo whose `terragucci.yml` lists every project. One command previews each project's pipeline and another opens a pull request in each project that changes. The projects' own pipelines apply.

## Before you start

- A repo to act as the control repo. It holds only `terragucci.yml`.
- A token per forge that can push branches and open pull requests: `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`, or the variable a project's `token_env` names.
- Projects on GitHub, GitLab or Forgejo. They can be mixed.

## Steps

### 1. List the projects

A project is its address on the forge. `defaults` apply to every project, and a project's own keys override them.

```yaml
defaults:
  binary: tofu
  gate: on-destroy
projects:
  github.com/acme/infra:
    roots: ["envs/*/*"]
  gitlab.example.com/platform/network:
    binary: terraform
    drift: "17 4 * * *"
  codeberg.org/acme/edge: {}
```

A repo you leave out is never touched. [terragucci.yml keys](/terragucci/reference/config/#keys) lists what a project can set.

### 2. Check the file

```bash
npx terragucci config check
```

```text
terragucci.yml: ok
```

### 3. Preview

```bash
npx terragucci reconcile --config terragucci.yml
```

This dry run says per project whether the pipeline would change, prints the files and lists setup tips. `--project github.com/acme/infra` narrows it to one project; `--json` prints one object ([JSON output](/terragucci/reference/cli-json/#reconcile)).

### 4. Open the pull requests

```bash
npx terragucci reconcile --config terragucci.yml --mode apply
```

Each project gets a pull request, never a push to its main branch; `--mode apply` runs no `terraform apply`. Current projects are left alone. The exit code is 1 when any project failed.

### 5. Merge in each project

Each team reviews its pull request. Run `reconcile` again later, for example after editing `defaults`, and it opens one only where something changed.

## Next

- [Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) works across projects.
- [Environment variables and credentials](/terragucci/reference/environment/) lists the tokens.
