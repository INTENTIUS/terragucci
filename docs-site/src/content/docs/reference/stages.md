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

A change that touches many roots goes out in waves. Wave 1 is an optional canary list. Later waves follow dependency order, so a root never applies before one it reads from.

Each wave has its own approval. The approval is bound to the wave's set digest, a hash over the plan digest of every root in that wave. If any root's plan changes after the approval, the wave stops and applies nothing.

A wave is planned only after the wave before it has applied. Its plan reads the real outputs of the roots upstream, so an approval never covers placeholder values.

A run that stops at an approval, or after a failed root, carries on from there next time. It never applies a root twice.

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

Name the module by its path or by its source without the pin. With no version, the rollout takes the newest one published. That is the highest `modules/network/vX.Y.Z` tag or the highest tag in the module's OCI repository. The old version is read from the pins; when they disagree, `--from` says which one moves. A pin keeps its shape, so a ref of `modules/network/v1.3.0` becomes `modules/network/v1.4.0`.

Each wave is a small pull request that the usual stages plan and apply. It changes only that wave's files, so a path-diff selection plans exactly what moved. The canaries in `waves.canary` form wave 1 and dependency order gives the rest. From a control repo, wave 1 holds the canaries of every project. Each project's later waves then follow in config order, with one pull request per project per wave.

Each run takes at most one step and exits. The next wave opens only on a run after the last wave's pull requests merged and their apply passed on the merge commit. A per-directory `apply/<path>` check decides when there is one; otherwise the pipeline's `apply` job does. A pull request closed without merging stops the rollout and so does a failed apply. Run it on a schedule or after each merge. It never merges anything or writes a default branch.

The default is a dry run that lists the pull requests it would open and their files. `--mode apply` pushes the branches and opens them with the token from `token_env`. The exit code is 0 after a step or at the end, 3 while a pull request waits for a merge or an apply, and 1 when the rollout stopped.

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

Keep your modules beside your roots and let `tf-publish` version them.

```yaml
modules:
  path: modules/*
  publish: oci://registry.example.com/acme/modules
```

`publish` takes an `oci://` registry address, `git-tags`, or a list of both. OpenTofu roots pin the OCI artifact as an `oci://` source. Terraform has no OCI sources, so its roots pin a git tag per module, such as `modules/network/v1.4.0`.

```bash
terragucci publish --dry-run
terragucci publish
```

A module is published when its content differs from its last release. The next version follows the commits since that release that touched the module: `feat` is a minor bump, `fix` and any other type a patch, and a breaking marker (`feat!:` or a `BREAKING CHANGE:` footer) a major. A module with no release yet starts at `0.1.0`. A `version` file in the module directory overrides the bump; once that version is published, change the file to publish the next content.

A published version never changes. Each release records the commit it was cut from and a digest of the module's content, so a second run on the same commit publishes nothing, and so does a change that was reverted. The OCI manifest digest is printed with each published version, and a root can pin it: `oci://registry.example.com/acme/modules/network@sha256:...`.

Registry credentials come from `TERRAGUCCI_REGISTRY_USER` and `TERRAGUCCI_REGISTRY_PASSWORD`. A registry without TLS needs `TERRAGUCCI_REGISTRY_INSECURE=1`. Git tags are pushed to `origin`, so check out the full history and the tags.

## The grouped summary

Nobody reads two hundred plan logs. The summary normalizes each root's changes and groups the roots whose changes are the same.

```
180 roots: identical change (update aws_iam_role.app, tags)
 15 roots: the same, plus replace aws_lambda_function.worker
  5 roots: read these individually
destroys: prod-eu/db (delete aws_db_instance.main)
```

Every destroy, replacement and refusal is listed by name and is never folded into a group. The summary comes as text, JSON, or markdown sized for a pull-request note. No approval is bound to it; approvals bind the plan digests underneath. [The plan report](/terragucci/reference/report/) covers the HTML and JSON forms and where they are kept.

## Gate policy

`tf-apply` takes one of three policies for each wave.

| Policy | Waits for an approval when |
|---|---|
| `always` | every wave |
| `on-destroy` | the wave's plans destroy something |
| `never` | never; use your forge's environment reviewers instead |

A waiting wave exits with code 3 and prints the approval command. Run it, then run the stage again.
