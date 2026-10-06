---
title: Roll out a new module version
description: Move a module's pin one wave at a time, as one pull request per wave, across the roots and repos that use it.
claims: [rollout]
---

## What you end up with

Every root that pins the module moved to the new version, a few roots at a time. Each wave is a small pull request that the usual stages plan and apply.

## Before you start

- Roots that pin the module exactly: an `oci://` tag or digest, a registry `version`, or a git tag. A range such as `~> 1.4` cannot be moved; [Stages](/terragucci/reference/stages/#rolling-out-a-module-version) lists the cases.
- The new version published. [Publish your modules](/terragucci/guides/publish-modules/) covers it.
- The HCL parser beside terragucci: `npm i -D @cdktn/hcl2json`.
- A forge token in the variable `token_env` names, with permission to open pull requests. Only the apply run needs it.
- Optional: `waves.canary` in `terragucci.yml`, so the first wave is the roots you trust to break first.

## Steps

### 1. Preview the rollout

```bash
npx terragucci rollout modules/network
```

Name the module by its path, or by its source without the pin. With no version, the rollout takes the newest one published: the highest `modules/network/vX.Y.Z` tag, or the highest tag in the module's OCI repository. A dry run lists the pull requests it would open and their files, and changes nothing.

The old version is read from the pins. When they disagree, `--from` says which one moves.

### 2. Fix any pin it refuses

The preview reports a pin it cannot move, with its reason and a tip:

| The pin | Tip |
|---|---|
| a range such as `~> 1.4` | `rollout-floating-pin`: pin one version |
| set from a variable or a local | `rollout-literal-pin`: write a literal, since a variable's value is not in the diff |
| absent from the source | `rollout-pin`: add a `?ref=`, `?tag=` or `version` |
| two versions of the module in one directory | `rollout-one-pin`: pin every call at one version |

Fix those in their own pull request and run the preview again.

### 3. Open the first wave

```bash
npx terragucci rollout modules/network 1.4.0 --mode apply
```

The command pushes a branch and opens one pull request for the canary wave, or for the first wave dependency order gives. It changes only that wave's files, so the plan covers exactly what moved. A pin keeps its shape: a ref of `modules/network/v1.3.0` becomes `modules/network/v1.4.0`.

### 4. Merge it and let it apply

Review the pull request as any other. When it merges, the apply stage runs on the merge commit.

### 5. Run the rollout again

Each run takes at most one step and exits. Run it on a schedule or after each merge:

```bash
npx terragucci rollout modules/network 1.4.0 --mode apply
```

The next wave opens only after the last wave's pull requests merged and their apply passed. The check that decides it is `apply/<path>` per directory when there is one, and the pipeline's `apply` job otherwise. A pull request closed without merging stops the rollout, and so does a failed apply. The command never merges anything and never writes a default branch.

| Exit code | Meaning |
|---|---|
| 0 | a step was taken, or the rollout is complete |
| 3 | a pull request waits for a merge or an apply |
| 1 | the rollout stopped |

From a control repo, wave 1 holds the canaries of every project, and each project's later waves follow in config order, with one pull request per project per wave.

## Provider upgrades

The same flow moves a provider through the lock file:

```bash
npx terragucci rollout --provider hashicorp/aws 6.68.0 --mode apply
```

It runs the binary to rewrite each lock file for that provider alone. An exact `version` constraint on the provider moves with it. The new lock file must hold the provider at the new version and every other provider where it was, or the wave stops.

## Next

- [Tips](/terragucci/reference/tips/) names the setup that makes rollouts hard, such as a widely shared local module.
- [The JSON output of rollout](/terragucci/reference/cli-json/#rollout) lists each wave's state for scripts.
