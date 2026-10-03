---
title: Your config file
description: One file, terragucci.yml, for one repo or for every repo you run. Most repos need none.
---

terragucci reads one file, `terragucci.yml`. The same schema works in a single repo and in a control repo that governs many, and most single repos need no file at all.

## No file

Install terragucci and let it read the repo:

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

`init` writes the pipeline for your forge and prints what it found. With no `terragucci.yml`, it starts from these defaults:

| Setting | Default |
|---|---|
| Roots | every directory whose `*.tf` or `*.tofu` files declare a backend or configure a provider |
| Binary | from `.opentofu-version` or `.terraform-version`, then `.tofu` files, then what is on your path |
| Version | the one `required_version` pins exactly, or terragucci's default for the binary |
| Forge | from a workflow directory already in the repo, or the host of its `origin` remote |
| Order | a root that reads another's state through `terraform_remote_state` applies after it |
| Gate | `on-destroy`, so a wave waits for an approval only when it destroys something |
| Drift | off |
| Runtime | your forge's CI |
| Reports | a CI artifact, linked from the pull-request note |

Commit the pipeline, and your next pull request runs it. Running `init` again changes nothing unless the repo changed.

## One repo

Put `terragucci.yml` at the repo root to change only what the defaults got wrong:

```yaml
binary: tofu
waves:
  canary: [envs/dev/core]
drift: "17 4 * * *"
```

## Many repos from one place

A control repo lists each project by its address on the forge. `defaults` apply to every project, and a project's own keys override them.

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

Preview what each project's pipeline would become, then open a pull request in each project that changes:

```bash
npx terragucci reconcile --config terragucci.yml
npx terragucci reconcile --config terragucci.yml --mode apply
```

A dry run is the default. terragucci writes to each project through a pull request, never straight to its main branch, and the project's own pipeline does the applying. A repo you leave out is never touched.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `roots` | detected | globs of root directories |
| `binary` | the one on the path | `terraform`, `tofu`, `choudoufu` or `cdktn` |
| `forge` | read from the project's host | `github`, `gitlab` or `forgejo`, for a host terragucci cannot name |
| `gate` | `on-destroy` | `always`, `on-destroy` or `never`; see [Gate policy](/terragucci/reference/stages/#gate-policy) |
| `waves.canary` | none | roots that go out first, as wave 1 |
| `drift` | off | a cron schedule for `tf-drift` |
| `runtime` | `forge` | `fountain` runs apply and drift on a steward; see [Where it runs](/terragucci/reference/runtimes/) |
| `reports` | CI artifact | a bucket to copy reports to; see [The plan report](/terragucci/reference/report/) |
| `version` | detected | the binary's version |
| `env` | none | environment variables every job gets; values only, never secrets |
| `url` | `https://<host>/<path>` | where a project lives, for a forge on another scheme or port |
| `token_env` | `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN` | the environment variable holding the forge token |
| `modules.path` | none | where your modules live, such as `modules/*` |
| `modules.publish` | none | an `oci://` registry, or `git-tags`; turns on `tf-publish` |
| `tips` | `true` | advice on pins, lock files and rollout setup, in the report and the dry run |

The file can also be `terragucci.ts`, typed with `TerragucciConfig`. terragucci folds it to plain data without running it, so a value that reads the environment is refused with its line number.

## Parameters

There are none to pass. A generated pipeline knows its project and roots from the config, and reads the pull request and commit from the forge event. Approving a wave is `chant approve`, which writes a record to your repo's `chant/lifecycle` branch. A local run can narrow itself:

```bash
terragucci plan --project github.com/acme/infra --root envs/dev/core
```

Nothing that changes what an approval covers can be passed at run time.
