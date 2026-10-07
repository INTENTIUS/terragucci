---
title: terragucci.yml keys
description: Every key of the config file, its default, and the defaults terragucci uses when there is no file.
---

terragucci reads one file from the repo root: `terragucci.yml`, `terragucci.yaml`, `terragucci.json` or `terragucci.ts`. Two of them in one directory is an error. The same schema works in a single repo and in a control repo that governs many, and most single repos need no file at all. `terragucci config check` validates a file and lists every problem at once.

## Defaults with no file

With no `terragucci.yml`, `init` starts from these defaults:

| Setting | Default |
|---|---|
| Roots | every directory whose `*.tf` or `*.tofu` files declare a backend or configure a provider |
| Binary | `tofu` when `.opentofu-version` exists, `terraform` when `.terraform-version` does, `tofu` when a root has `.tofu` files, then `tofu` or `terraform` on your path, whichever is found first, and `tofu` when neither is |
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
| `binary` | detected: a version file, then `.tofu` files, then the path, then `tofu`; see [Defaults with no file](#defaults-with-no-file) | `terraform`, `tofu` or [`choudoufu`](/terragucci/concepts/glossary/#choudoufu) |
| `forge` | read from the project's host | `github`, `gitlab` or `forgejo`, for a host terragucci cannot name |
| `gate` | `on-destroy` | `always`, `on-destroy` or `never`; see [Gate policy](/terragucci/reference/stages/#gate-policy) |
| `apply` | `when: merge` | `when`: `merge` applies the default branch after a merge; `pull-request` applies an open pull request on request, before it merges. `merge`, with `when: pull-request` only: `manual` (default) leaves the merge to a person, `auto` merges once every wave applied. `merge_token_env`, with `merge: auto` only: the secret the merge is made with, required on Forgejo. Plain roots only. See [Apply before merge](#apply-before-merge) |
| `waves` | none | `canary`, a list of roots that go out first, as wave 1 |
| `drift` | `false` (off) | a cron schedule for `tf-drift`; see [Drift](/terragucci/reference/stages/#drift) |
| `runtime` | `forge` | `forge`, the only value: every stage runs on the forge's CI; see [Where it runs](/terragucci/reference/runtimes/) |
| `reports` | none: the report is a CI artifact | a bucket to copy reports to (`bucket`, `endpoint`, `prefix`), and `url`, the address that serves the bucket to a browser, so the note, the index and the dashboards link the bucket's copy; `role`, an AWS role ARN the job assumes with its OIDC token to write the reports, apart from its own role; see [The plan report](/terragucci/reference/report/) and [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/) |
| `version` | the one every root pins exactly, else terragucci's default for the binary | the binary's version |
| `env` | `{}` | environment variables every job gets; values only, never secrets |
| `url` | `https://<host>/<path>` | where a project lives, for a forge on another scheme or port |
| `telemetry` | none | `headers_secret`: the name of the CI secret or variable holding `OTEL_EXPORTER_OTLP_HEADERS`; the generated plan, apply and drift jobs map it into the environment. `trace_url`: a link to a trace with `{trace_id}` in it, which the report links |
| `token_env` | `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`, by forge | the environment variable holding the forge token that `reconcile`, `rollout` and `respond --mode apply` push and open pull requests with |
| `oidc` | none | the cloud identities the jobs take over OIDC, one for plan and one for apply on each cloud set: AWS with `plan_role`, `apply_role` and an optional `audience`; GCP with `gcp: { workload_identity_provider, plan_service_account, apply_service_account }` and an optional `token_url`; Azure with `azure: { tenant_id, subscription_id, plan_client_id, apply_client_id }` and an optional `audience`. See [Credentials](/terragucci/reference/pipeline/#credentials) |
| `parallelism` | 3 for GitLab-managed state, else 16 | how many roots of one dependency layer `tf-plan` and `tf-drift` plan at once, and of one wave `tf-apply` plans at once; a Terragrunt repo uses `terragrunt.parallelism` |
| `terragrunt` | detected | Terragrunt settings: `version`, `exclude`, `parallelism`, `dependents`, `credentials` |
| `policy` | none (off) | `engine` (`conftest` or `opa`), `path` (default `policy`), `namespace` and `input` (`plan` or `hcp`): run policy over each root's plan and fail `tf-plan` or refuse a `tf-apply` wave on a denial. For a pull request the base branch's `policy` key decides whether policy runs, so a pull request that deletes the key is still checked; see [Policy](/terragucci/reference/policy/#the-base-branch-decides) |
| `modules.path` | `modules/*` | a glob of the directories that hold your modules |
| `modules.publish` | none | an `oci://` registry, `git-tags`, or a list of both; turns on `tf-publish` |
| `tips` | `true` | advice on pins, lock files and rollout setup, in the report and the dry run |
| `respond` | a response per event | how terragucci answers each pipeline event; see [Responses to pipeline events](/terragucci/reference/responses/) |
| `agent` | none | `via` (`forge`) and `token_env`: the agent integration. `comment` turns on the `/terragucci agent` pull request comment; see [The agent comment](#the-agent-comment) |
| `decide` | none | the typed-decision service a few responses may ask; see [The decide block](#the-decide-block) |
| `audit_region` | the `aws` CLI's region | the AWS region whose CloudTrail drift attribution reads |
| `dashboards` | `false` (off) | `true`, or a map of `dir`, `prometheus`, `tempo`, `folder`, `path`, `drift_age`, `wave_wait` and `schedule`: `init` and `reconcile` write the dashboards and alert rules next to the pipeline; see [Dashboards and alerts](/terragucci/reference/observability/#dashboards-and-alerts) |

`terragucci config check` rejects a key this table does not list and names the keys it accepts.

## Apply before merge

```yaml
apply:
  when: pull-request   # default: merge
  merge: auto          # default: manual
  merge_token_env: MERGE_TOKEN   # the secret the merge is made with
```

With `when: merge`, the default, only merged code applies: the push to the default branch runs the waves, and `/terragucci apply` on a merged pull request runs them again. The apply role never meets a pull request's code.

With `when: pull-request`, a pull request applies before it merges, as Atlantis does. On GitHub and Forgejo a person with write access comments `/terragucci apply [wave-<n>]` on the open pull request; on GitLab, which starts no pipeline for a comment, they start the merge request pipeline's manual `apply-mr` job. The waves, the set digests, the `gate` policy and the sealed approvals are the same as after a merge. The gate rule and the signers are read from the default branch, and so is this file: a pull request that changes `terragucci.yml` gets the new settings once it merges. Before anything applies, the pull request must be approved by a reviewer other than its author, its checks must have passed, its head must contain the default branch, and no other open pull request may hold a lock on a root it reaches; each is refused by name. Applying locks those roots until the pull request merges or closes, and `/terragucci unlock` (on GitLab, the `unlock-mr` job) releases them. After the last wave, `merge: auto` merges the pull request; a pull request whose apply stopped partway is never merged. The push after the merge plans every root and applies nothing; its `terragucci/apply` status fails, naming the roots, if any still plans a change.

`merge_token_env` names the secret whose token makes the merge, a user's token that may push to the default branch. Forgejo refuses a merge made with the job's own token, so there it is required. On GitHub it is optional; with it, the merge starts the default branch's workflow. GitLab merges with `token_env`'s token, and `init` refuses the key there.

The trade is the apply role: the job that applies a pull request runs that pull request's code with it, before anyone merged it. A provider, an external data source or a module in the pull request runs with write access to your cloud. That is why `merge` is the default. With `when: pull-request`, keep forks out (they never apply), require reviews in branch protection, and on GitLab protect the `terragucci-apply` environment. [Apply before merge](/terragucci/reference/pipeline/#apply-before-merge) lists the jobs and the checks.

`config check` refuses `merge` without `when: pull-request`, and `init` refuses `when: pull-request` in a Terragrunt repo.

## A TypeScript file

`terragucci.ts` is typed with `TerragucciConfig`. terragucci folds it to plain data without running it, so a value that reads the environment is refused with its line number. Folding needs `@intentius/tsad-reference`, an optional peer dependency of the package: `npm i -D @intentius/tsad-reference`. The `.yml`, `.yaml` and `.json` forms need nothing extra, and the package has no other required dependency.

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
| `credentials` | none | AWS plan and apply roles by unit path glob; GCP and Azure units take `oidc`'s identities or their provider block's. See [Credentials](/terragucci/reference/pipeline/#terragrunt) |

Terragrunt 1.1 or later is required. [Use Terragrunt](/terragucci/guides/use-terragrunt/) covers what changes in a Terragrunt repo.

## The agent comment

`agent.comment` lets a person with write access ask a coding agent, in a pull request comment, to change the pull request. It is off unless set, on GitHub and Forgejo only.

```yaml
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
  comment:
    command: claude -p --max-turns "$TG_AGENT_MAX_TURNS"
    key_secret: ANTHROPIC_API_KEY
    max_turns: 30
    timeout: 30
```

`comment: true` takes every default. `agent.token_env` names the secret holding the token the change is pushed with; it must be a secret name.

| Key | Default | Meaning |
|---|---|---|
| `command` | Claude Code in print mode, with the file tools and two read-only terragucci commands | the agent's command line, run in the pull request's checkout with the prompt on stdin |
| `key_secret` | `ANTHROPIC_API_KEY` | the secret holding the model's API key, given to the agent's step alone |
| `max_turns` | 30 | the turn limit, passed to the command as `TG_AGENT_MAX_TURNS` |
| `timeout` | 30 | minutes before the agent's job is stopped |

The agent's jobs get no cloud credentials, whatever `oidc` says. GitLab has no agent comment, and `init` refuses `agent.comment` for a GitLab repo. [The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) describes the jobs.

## The decide block

A few responses read free text that no rule can judge: a pull request's description beside its plan, drift that neither the known-defaults table nor the audit log explains, and commit messages with no conventional type. For those, terragucci can ask a typed-decision model a yes-or-no or a choice question and get back a probability. With no `decide` block, nothing is asked and every response is the deterministic one.

```yaml
decide:
  backend: laya
  url: http://decide:8790
  thresholds: { noul: 0.8, choice: 0.7 }
```

| Key | Default | Meaning |
|---|---|---|
| `backend` | required | `laya` (terragucci's `terragucci-decide` image), `von`, `decider` or `jev` (TypeSafe's API); each answers the same request shape |
| `url` | required, except `jev` | the service's base URL; `jev` defaults to `https://api.typesafe.ai` |
| `model` | required, except `laya` | the pinned model version, such as `jev-1.13.0`; a moving alias such as `jev-latest` is refused, and an answer from any other version is not used |
| `token_env` | none, required for `jev` | the environment variable holding the service's bearer token; on GitHub and Forgejo the secret of that name reaches the plan and re-plan jobs when `respond.description` is `check`, the drift job when `respond.drift` is `attribute`, and the `version-bump` job when `respond.version-bump` is `suggest` |
| `thresholds` | `noul` 0.8, `choice` 0.7, `score` 0.7 | the probability an answer needs before a response acts on it |

An answer below its threshold, a service that does not answer, or an answer from another model leaves the response as it would be with no `decide` block. A decision raises a flag, picks a route or suggests a value for a person to confirm. It never approves, applies or resolves a gate. The model reads the redacted report, never a secret or a raw plan value.

`terragucci-decide` runs the Laya model on CPU and carries its weights, so it is an image of its own: the CI images stay small, and only the job or host that runs the service downloads it.

## Parameters

There are none to pass. A generated pipeline knows its project and roots from the config, and reads the pull request and commit from the forge event. Approving a wave is [`chant approve`](/terragucci/concepts/glossary/#chant), which writes a record to your repo's [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch. A local run can narrow itself:

```bash
terragucci plan --project github.com/acme/infra --root envs/dev/core
```

Nothing that changes what an approval covers can be passed at run time.
