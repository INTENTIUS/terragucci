---
title: Stages
description: What each stage does, its inputs, permissions and outputs.
---

Every stage takes the root directories and the binary.

| Stage | What it does | Forge permissions | Outputs |
|---|---|---|---|
| `tf-check` | format and validate | read the repository | pass or fail |
| `tf-plan` | plans only the roots a change affects, in one run, and posts the grouped summary on the pull request | read the repository, comment on pull requests | the grouped summary, and a plan digest per root |
| `tf-apply` | applies wave by wave, one job per wave, each wave behind its own approval | read the repository, write the `chant/lifecycle` branch | per wave, whether it waited and the command that approves it |
| `tf-drift` | plans every root on a schedule and reports the grouped summary | read the repository, open issues | drift, grouped |
| `tf-publish` | publishes each changed module as an OCI artifact or a git tag | read the repository, push tags or to the registry | the new version and its digest |
| `tf-rollout` | opens one pull request per wave, moving the pin for that wave's roots | open pull requests, in every project of the wave | per wave, its pull requests and their state |

## Gated waves

A change that touches many roots goes out in waves, each behind its own approval bound to the wave's set digest. A changed plan stops the wave. [How waves and approvals work](/terragucci/concepts/waves-and-approvals/) explains why, and [Approve a waiting wave](/terragucci/guides/approve-a-wave/) shows the steps.

## Rolling out a module version

How a root takes a module decides how a new version reaches it.

| The root's module source | Roots a change reaches | How it goes out |
|---|---|---|
| a local path, `../modules/x` | every root that includes it | one change set, applied in gated waves |
| an exact pin: an `oci://` tag or digest, a registry `version`, a git tag | only those whose pin moved | `tf-rollout`, one pull request per wave |
| a range such as `~> 1.4` | cannot be told from the diff | neither; terragucci refuses it and tips you to pin it |
| a provider version, in `.terraform.lock.hcl` | everything using the provider | `tf-rollout`, moving the lock file a wave at a time |

```bash
terragucci rollout modules/network                 # dry run: the newest published version
terragucci rollout modules/network 1.4.0 --mode apply
terragucci rollout --provider hashicorp/aws 6.68.0 --mode apply
```

With no version, the rollout takes the newest one published: the highest `modules/network/vX.Y.Z` tag, or the highest tag in the module's OCI repository. The old version is read from the pins, and `--from` says which one moves when they disagree. Each run takes at most one step and exits; the default is a dry run, and `--mode apply` pushes the branches and opens the pull requests with the token from `token_env`. It never merges anything or writes a default branch.

| Exit code | Meaning |
|---|---|
| 0 | a step was taken, or the rollout is at its end |
| 3 | a pull request waits for a merge or an apply |
| 1 | the rollout stopped, after a closed pull request or a failed apply |

[Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) walks through a rollout.

A pin the rollout cannot move is reported with its reason and a tip:

| The pin | Tip |
|---|---|
| a range such as `~> 1.4` | `rollout-floating-pin`: pin one version |
| set from a variable or a local | `rollout-literal-pin`: write a literal, since a variable's value is not in the diff |
| absent from the source | `rollout-pin`: add a `?ref=`, `?tag=` or `version` |
| two versions of the module in one directory | `rollout-one-pin`: pin every call at one version |
| a provider with no `.terraform.lock.hcl` | `rollout-lock-file`: commit the lock file |

A provider rollout runs the binary to rewrite each lock file for that provider alone. An exact `version` constraint on the provider moves with it. The new lock file must hold the provider at the new version and every other provider where it was, or the wave stops.

Reading module pins needs the HCL parser, which is installed beside terragucci rather than bundled: `npm i -D @cdktn/hcl2json`.

## Publishing modules

`modules.path` names the modules and `modules.publish` takes an `oci://` registry address, `git-tags`, or a list of both. OpenTofu roots pin the OCI artifact as an `oci://` source. Terraform has no OCI sources, so its roots pin a git tag per module, such as `modules/network/v1.4.0`.

```bash
terragucci publish --dry-run
terragucci publish
```

A module is published when its content differs from its last release. The next version follows the commits since that release that touched the module: `feat` is a minor bump, `fix` and any other type a patch, and a breaking marker (`feat!:` or a `BREAKING CHANGE:` footer) a major. A module with no release yet starts at `0.1.0`, and a `version` file in the module directory overrides the bump.

A published version never changes. Each release records the commit it was cut from and a digest of the module's content, so a second run on the same commit publishes nothing, and so does a change that was reverted. With `modules.publish` set, the pipeline's `publish` job runs after `apply` on a push to the default branch and is the only job given the registry credentials listed in [Environment variables and credentials](/terragucci/reference/environment/). [Publish your modules](/terragucci/guides/publish-modules/) walks through it.

## The grouped summary

`tf-plan` and `tf-drift` group the roots whose changes are the same, and list every destroy, replacement and refusal by name. The summary comes as text, JSON, or markdown sized for a pull-request note. [Why plans are grouped](/terragucci/concepts/why-plans-are-grouped/) explains the idea, and [The plan report](/terragucci/reference/report/) covers the HTML and JSON forms and where they are kept.

## Gate policy

`tf-apply` takes one of three policies for each wave.

| Policy | Waits for an approval when |
|---|---|
| `always` | every wave |
| `on-destroy` | the wave's plans destroy something |
| `never` | never; use your forge's environment reviewers instead |

A waiting wave exits with code 3 and prints the approval command. Run it, then run the stage again.
