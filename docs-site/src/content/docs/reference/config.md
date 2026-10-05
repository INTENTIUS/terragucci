---
title: terragucci.yml keys
description: Every key of the config file, its default, and the defaults terragucci uses when there is no file.
---

terragucci reads one file, `terragucci.yml`. The same schema works in a single repo and in a control repo that governs many, and most single repos need no file at all. `terragucci config check` validates a file and lists every problem at once.

## Defaults with no file

With no `terragucci.yml`, `init` starts from these defaults:

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

Running `init` again changes nothing unless the repo changed.

## A file for one repo

Put `terragucci.yml` at the repo root to change only what the defaults got wrong:

```yaml
binary: tofu
waves:
  canary: [envs/dev/core]
drift: "17 4 * * *"
```

## A file for many repos

In a control repo, `defaults` apply to every project and a project's own keys override them. [Govern many repos from one place](/terragucci/guides/govern-many-repos/) walks through it.

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

## Keys

| Key | Default | Meaning |
|---|---|---|
| `roots` | detected | globs of root directories |
| `binary` | the one on the path | `terraform`, `tofu`, `choudoufu` or `cdktn` |
| `forge` | read from the project's host | `github`, `gitlab` or `forgejo`, for a host terragucci cannot name |
| `gate` | `on-destroy` | `always`, `on-destroy` or `never`; see [Gate policy](/terragucci/reference/stages/#gate-policy) |
| `waves.canary` | none | roots that go out first, as wave 1 |
| `drift` | off | a cron schedule for `tf-drift`; see [Drift](/terragucci/reference/stages/#drift) |
| `runtime` | `forge` | `fountain` runs apply and drift on a steward; see [Where it runs](/terragucci/reference/runtimes/) |
| `reports` | CI artifact | a bucket to copy reports to; see [The plan report](/terragucci/reference/report/) |
| `version` | detected | the binary's version |
| `env` | none | environment variables every job gets; values only, never secrets |
| `url` | `https://<host>/<path>` | where a project lives, for a forge on another scheme or port |
| `telemetry` | none | `headers_secret`: the name of the CI secret or variable holding `OTEL_EXPORTER_OTLP_HEADERS`; the generated plan, apply and drift jobs map it into the environment |
| `token_env` | `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN` | the environment variable holding the forge token |
| `oidc` | none | `plan_role`, `apply_role` and an optional `audience`: the cloud roles the jobs assume over OIDC; see [Credentials](/terragucci/reference/pipeline/#credentials) |
| `parallelism` | 3 for GitLab-managed state, else 16 | how many roots of one dependency layer `tf-plan` and `tf-drift` plan at once; a Terragrunt repo uses `terragrunt.parallelism` |
| `terragrunt` | detected | Terragrunt settings: `version`, `exclude`, `parallelism`, `dependents`, `credentials` |
| `modules.path` | none | where your modules live, such as `modules/*` |
| `modules.publish` | none | an `oci://` registry, `git-tags`, or a list of both; turns on `tf-publish` |
| `tips` | `true` | advice on pins, lock files and rollout setup, in the report and the dry run |
| `respond` | a response per event, none of them an agent | how terragucci answers each pipeline event; see [Responses to pipeline events](/terragucci/reference/responses/) |
| `agent` | none | `via` (`forge` or `fountain`), `token_env` and an optional read-only `role`: where an event set to `agent` runs |

The file can also be `terragucci.ts`, typed with `TerragucciConfig`. terragucci folds it to plain data without running it, so a value that reads the environment is refused with its line number.

## The terragrunt block

```yaml
terragrunt:
  version: 1.1.6
  exclude: ["live/sandbox/**"]
  parallelism: 16
  dependents: follow
  credentials:
    "live/prod/**": { plan: arn:aws:iam::111:role/plan, apply: arn:aws:iam::111:role/apply }
```

| Key | Default | Meaning |
|---|---|---|
| `version` | the version `terragrunt_version_constraint` pins exactly, or terragucci's | the Terragrunt release the jobs run |
| `exclude` | none | unit globs to leave out; `catalog/**` and `.terragrunt-cache` are always left out |
| `parallelism` | 3 for GitLab-managed state, else 16 | how many units one `run --all` runs at once |
| `dependents` | `follow` | `follow` plans dependents in later waves; `plan` also previews them on the pull request, marked provisional and left out of every digest |
| `credentials` | none | plan and apply roles by unit path glob; see [Credentials](/terragucci/reference/pipeline/#terragrunt) |

Terragrunt 1.1 or later is required. [Use Terragrunt](/terragucci/guides/use-terragrunt/) covers what changes in a Terragrunt repo.

## Parameters

There are none to pass. A generated pipeline knows its project and roots from the config, and reads the pull request and commit from the forge event. Approving a wave is `chant approve`, which writes a record to your repo's `chant/lifecycle` branch. A local run can narrow itself:

```bash
terragucci plan --project github.com/acme/infra --root envs/dev/core
```

Nothing that changes what an approval covers can be passed at run time.
