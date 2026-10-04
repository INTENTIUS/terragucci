---
title: Move apply onto a fountain steward
description: Run apply and drift on a machine that owns an environment, with credentials that never reach your CI.
---

## What you end up with

Pull-request stages still run on your forge. The apply stage runs on a fountain steward, started by a small forge job, with its cloud credentials held in a fountain vault.

## Before you start

- A running fountain with a steward. [fountain-ops](https://intentius.io/fountain-ops/) deploys one with chant, and `just up` there stands one up on a laptop.
- The pipeline from [Get your first plan note](/terragucci/getting-started/).
- chant installed where you run `chant run`.

## Steps

### 1. Opt in

Forge CI is the default and runs every stage. Set `runtime` on the project:

```yaml
runtime: fountain
```

In a control repo, set it on the projects that want it.

### 2. Check the file

```bash
npx terragucci config check
```

```text
terragucci.yml: ok
```

### 3. Bring up what the config needs

When you run the local validation stack, `profiles` prints the stack profiles a config needs, including fountain only if a project runs there:

```bash
npx terragucci profiles --config terragucci.yml
```

### 4. Write the pipeline again

```bash
npx terragucci init
```

The apply job on the forge becomes a small job that starts the stage on the steward:

```bash
chant run tf-apply --on fountain
```

The plan and check jobs stay as they were, since the pull request lives on the forge.

### 5. Move the credentials

Put the apply role and any keys in the fountain vault, and remove them from your CI's secrets. The steward holds them, so none reach your CI.

### 6. Merge and watch

On the next push to the default branch the forge job starts the steward. A steward keeps its checkout and provider cache between runs. It runs one stage at a time, so two applies on one environment cannot overlap.

Approvals live on the `chant/lifecycle` branch, so one recorded from your laptop or from CI counts on the steward too. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) works unchanged.

## Next

- [Where it runs](/terragucci/reference/runtimes/) compares forge CI, a steward and your own machine.
- [Have an agent explain a plan](/terragucci/guides/agent-explain-a-plan/) can run on a steward as well.
