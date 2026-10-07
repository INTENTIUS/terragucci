---
title: Govern many repos from one place
description: List your projects in a control repo and let terragucci open a pull request in each one that needs a change.
claims: [reconcile]
---

## What you end up with

A control repo whose `terragucci.yml` lists every project. One command previews what each project's pipeline would become, and another opens a pull request in each project that changes. The projects' own pipelines do the applying.

## Before you start

- A repo to act as the control repo. It holds only `terragucci.yml`.
- A token for each forge, with permission to push branches and open pull requests in the listed projects. By default terragucci reads `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`; `token_env` names another variable for a project.
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

The dry run is the default. For each project it says whether the pipeline would change and prints the files. It also lists the tips for each project's setup, such as pins and lock files. `--project github.com/acme/infra` narrows the run to one project, and `--json` prints the same as one object ([JSON output](/terragucci/reference/cli-json/#reconcile)).

### 4. Open the pull requests

```bash
npx terragucci reconcile --config terragucci.yml --mode apply
```

terragucci writes to each project through a pull request, never straight to its main branch. Despite its name, `--mode apply` runs no `terraform apply`. A project whose pipeline is already current is left alone. The exit code is 1 when any project failed.

### 5. Merge in each project

Each project's team reviews its pull request like any other. Run `reconcile` again later and it opens one only where something changed, for example after you edit `defaults`.

## Next

- [Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) works across projects: wave 1 holds the canaries of every project.
- [Environment variables and credentials](/terragucci/reference/environment/) lists the tokens.
