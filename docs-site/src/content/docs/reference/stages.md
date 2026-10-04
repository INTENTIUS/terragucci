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
terragucci rollout modules/network 1.4.0
```

Each wave is a small pull request that the usual stages plan and apply. The next wave's pull request opens only after the last one merged and its roots applied. From a control repo, a wave can reach roots in several repos, with one pull request in each.

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
