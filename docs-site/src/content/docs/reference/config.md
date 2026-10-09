---
title: terragucci.yml keys
description: Every key of the config file, its default, and the defaults terragucci uses when there is no file.
prompt: |
  Read https://intentius.io/terragucci/reference/config/.
  Run `npx terragucci config check --json` on this repo's terragucci.yml and list each problem it finds.
  Propose the smallest file that keeps current behaviour, run config check again, and open a pull request with it.
  Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

terragucci reads `terragucci.yml`, `.yaml`, `.json` or `.ts` from the repo root; two is an error. `terragucci config check` lists every problem.

## Defaults with no file

With no `terragucci.yml`, `init` starts from these defaults:

| Setting | Default |
|---|---|
| Roots | every directory whose `*.tf` or `*.tofu` files declare a backend or configure a provider, or, in a Terragrunt repo, each unit `terragrunt find` lists |
| Binary | `.opentofu-version` gives `tofu`, `.terraform-version` gives `terraform`, then `.tofu` files, then the path, then `tofu` |
| Version | the repo's `.opentofu-version` or `.terraform-version`, then the one `required_version` pins exactly, or terragucci's default for the binary; a root that pins its own runs that one ([A version per root](#a-version-per-root)) |
| Forge | from a workflow directory already in the repo, or the host of its `origin` remote |
| Order | a root that reads another's state through `terraform_remote_state` applies after it |
| Gate | `on-destroy`, so a wave waits for an approval only when it destroys or replaces something |
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

In a control repo, a project's keys override `defaults`; see [Govern many repos](/terragucci/guides/govern-many-repos/). `defaults` takes every key but `url`, which names one project's repo, and `rollouts`, which a control repo runs with `terragucci respond rollout` instead.

A key the control repo sets away from its default reaches each project one of two ways:

| How it reaches the project | Keys |
|---|---|
| `reconcile` writes it into the project's own `terragucci.yml`, which the jobs read | `policy`, `reports`, `approval`, `gate`, `roots`, `waves`, `parallelism`, `synth`, `steps`, `drift`, `cost`, `tips`, `runtime`, `telemetry`, `respond`, `decide`, `audit_region`, `modules` (with `modules.attest`, `modules.require` and `modules.trusted`), `terragrunt`, `token_env`, `generate` (whose files `reconcile` also writes into the same pull request), `review` (its jobs are in the pipeline too) |
| in the pipeline `reconcile` writes | `binary`, `version`, `forge`, `apply` (with `apply.resume`), `locks`, `comments`, `gitlab`, `env`, `oidc`, `agent`, `atlantis_comments`, `dashboards`, `notify` (with `notify.webhook`) |

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

## A full example

Most keys set away from their default; [Keys](#keys) lists every one. Keep only the lines you need. This file passes `config check`.

```yaml
roots: ["envs/*/*"]
binary: tofu
version: 1.10.6
forge: forgejo
url: https://git.example.com:3000/acme/infra
gate: always
apply:
  when: merge                 # pull-request: see Apply before merge
waves:
  canary: [envs/dev/core]
drift: "17 4 * * *"
runtime: forge
reports:
  bucket: acme-terragucci-reports
  prefix: infra
  url: https://reports.example.com
  role: arn:aws:iam::111122223333:role/terragucci-reports
env:
  TF_LOG: WARN
telemetry:
  headers_secret: OTLP_HEADERS
  trace_url: https://grafana.example.com/explore?trace={trace_id}
token_env: FORGE_TOKEN
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
parallelism: 8
terragrunt:                   # read in a Terragrunt repo only
  version: 1.1.6
policy:
  engine: conftest
  path: policy
  override: [github:alice]
modules:
  path: "modules/*"
  publish: git-tags
tips: false
respond:
  drift: attribute
  version-bump: suggest
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
  comment: true
review:
  agent: true
decide:
  backend: laya
  url: http://decide:8790
audit_region: eu-west-1
dashboards: true
```

## Keys

| Key | Default | Meaning |
|---|---|---|
| `roots` | detected | globs of root directories |
| `synth` | none | the command that writes the roots, such as `npx cdktn synth`; the check, plan, apply, tips and drift jobs run it on their checkout before reading them, and a pull request plans only the synthesized roots whose output differs from the base's. With it, `rollouts` and a `drift` schedule under `respond.drift: pull-request` are config errors, since both edit the files the command writes; see [Plan CDK Terrain stacks](/terragucci/guides/plan-cdk-terrain-stacks/) |
| `steps` | none | commands run before or after a root's `init`, `plan`, `apply` or `drift`, in the stage's own job: each has `run`, one of `before` and `after`, and optionally `name`, `roots` (globs) and `on_failure` (`fail`, the default, or `approve`, which holds the root's wave at its gate instead). Read from `terragucci.yml` at base. Plain roots only; see [Run steps around a stage](/terragucci/guides/run-steps/) |
| `image` | terragucci's image for the binary | the image every job runs in, built `FROM` terragucci's image for the binary so the jobs keep terragucci and the binary; see [Run steps around a stage](/terragucci/guides/run-steps/#run-the-jobs-in-your-own-image) |
| `binary` | detected; see [Defaults with no file](#defaults-with-no-file) | `terraform`, `tofu` or [`choudoufu`](/terragucci/concepts/glossary/#choudoufu) |
| `forge` | read from the project's host | `github`, `gitlab` or `forgejo`, for a host terragucci cannot name |
| `gate` | `on-destroy` | `always`, `on-destroy` or `never`; see [Gate policy](/terragucci/reference/stages/#gate-policy) |
| `approval` | `ledger`; `sealed` when [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) lists gates and the key is unset | what counts as a waiting wave's approval: `ledger`, any approval of its digest; `pr-review`, also a review of the merged head; `sealed`, only a sealed one. Read at base; see [Approval modes](/terragucci/guides/approve-a-wave/#approval-modes) |
| `apply` | `when: merge` | `when`, `merge`, `merge_token_env` and `requires`; see [Apply before merge](#apply-before-merge). `resume`: the minutes, 5 to 60, between runs of the [resume job](/terragucci/reference/pipeline/#resume-after-an-approval), which applies a waiting wave once its approval is on `chant/lifecycle`; off when unset |
| `locks` | `apply` | when a pull request locks the roots it reaches: `apply`, when it applies before merge or a writer comments `/terragucci lock`; `plan`, from its first plan (GitHub and Forgejo); see [Plan locks](#plan-locks) |
| `waves` | none | `canary`, a list of roots that go out first, as wave 1; `jobs`, the most jobs one wave's roots spread across, 1 when unset (plain roots on GitHub and Forgejo, not with `apply.when: pull-request`; see [A wide wave across jobs](/terragucci/concepts/waves-and-approvals/#a-wide-wave-across-jobs)) |
| `notify` | none (off) | the secrets of a Slack (`slack`) or Teams (`teams`) incoming webhook, and `webhook` with `webhook_key` for a signed [`terragucci.notify/v1`](/terragucci/reference/notify-event/) event; an apply job posts a wave that waits, is refused or fails, and the drift job posts drift to Slack and Teams with a Re-plan button. A message approves nothing; see [Notify a chat channel](/terragucci/guides/notify-a-chat-channel/). `relay`: the name of [your relay](/terragucci/guides/approve-from-chat/), not a secret; a waiting wave's Slack message then carries Approve and Decline buttons, and its Teams card the reply that approves |
| `cost` | none (off) | a monthly cost estimate per root in the plan note: `true` runs Infracost in the plan job on the key in the secret `INFRACOST_API_KEY`; `key_secret` names another secret, and `command` runs another estimator that prints Infracost's JSON. Each `tf-apply` wave prices its plans too, for the policy's `input.cost`; `approve_above: <amount>`, read at base, makes a wave whose monthly change is over the amount wait for an approval whatever `gate` says ([Estimate the cost of a change](/terragucci/guides/estimate-cost/#hold-a-wave-over-an-amount)) |
| `drift` | `false` (off) | a cron schedule for `tf-drift`; see [Drift](/terragucci/reference/stages/#drift) |
| `rollouts` | `false` (off) | a cron schedule for the rollout job, which opens the next wave of each rollout in flight once the last applied; `respond.rollout: off` leaves it out. Not in a control repo; see [Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) for its token and the GitLab schedule |
| `comments` | `false` (off) | GitLab only: the cron of the comments schedule, whose pipelines answer `/terragucci` merge request notes; see [Re-plan from a comment](/terragucci/guides/re-plan-from-a-comment/) |
| `gitlab.token` | `unprotected` | GitLab only: `protected` keeps `GITLAB_TOKEN` (or the `token_env` variable, marked Protected and Masked) out of every merge request and branch pipeline; the comments job then posts the plan notes, and there is no fmt job. Needs `comments`; see [the threat model](/terragucci/reference/threat-model/) |
| `runtime` | `forge` | `forge`, the only value: every stage runs on the forge's CI; see [Where it runs](/terragucci/reference/runtimes/) |
| `reports` | none: the report is a CI artifact | `bucket` (`s3://<bucket>`, `gs://<bucket>` or `az://<account>/<container>`), `endpoint` (the store's address, for an S3-compatible store, an emulator or a sovereign cloud), `prefix`, `url` (the browser address links use, such as the [front door](/terragucci/guides/keep-reports-in-a-bucket/#5-serve-the-index)) and `role` (an AWS role ARN that writes, `s3://` only); see [Keep reports in a bucket](/terragucci/guides/keep-reports-in-a-bucket/) |
| `version` | the repo's version file, then the one every root pins exactly, else terragucci's default for the binary | the binary's version; as a map of root glob to version, the version each root it matches runs; see [A version per root](#a-version-per-root) |
| `generate` | none (off) | each plain root's `backend.tf`, `providers.tf` and `versions.tf`, which `terragucci generate` writes and `tf-check` holds to: `backend`, `providers` and `required_version` for every root, then the same under `dirs` (root path globs) and `roots` (exact root paths); see [Generate backend and provider files](/terragucci/guides/generate-root-files/) |
| `env` | `{}` | environment variables every job gets; values only, never secrets |
| `url` | `https://<host>/<path>` | where a project lives, for a forge on another scheme or port |
| `telemetry` | none | `headers_secret`, the secret holding `OTEL_EXPORTER_OTLP_HEADERS`; `trace_url`, a trace link with `{trace_id}` |
| `token_env` | `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`, by forge | the forge token `reconcile`, `rollout` and `respond --mode apply` use |
| `oidc` | none | plan and apply identities per cloud; see [Cloud roles over OIDC](/terragucci/reference/environment/#cloud-roles-over-oidc) |
| `parallelism` | 3 for GitLab-managed state, else 4 | roots planned at once, and applied at once in a wave; Terragrunt uses `terragrunt.parallelism`. Each root running starts its own providers: with the AWS provider, about 800 MB each, so 4 fit a 7 GB runner and 16 need about 13 GB |
| `terragrunt` | detected | Terragrunt settings: `version`, `exclude`, `parallelism`, `dependents`, `credentials` |
| `policy` | none (off) | `engine` (`conftest` or `opa`), `path` (default `policy`), `namespace`, `input` (`plan` or `hcp`), [`source`](/terragucci/reference/policy/#a-shared-policy-source) (`git+https://<host>/<path>@<ref>`), [`override`](/terragucci/reference/policy/#overriding-a-denial) (who may let one denied plan through, read at base; unset, nobody); the [base branch's key](/terragucci/reference/policy/#the-base-branch-decides) decides |
| `modules.path` | `modules/*` | a glob of the directories that hold your modules |
| `modules.publish` | none | an `oci://` registry, `git-tags`, or a list of both; turns on `tf-publish` |
| `modules.attest` | none (off) | `true`, or `key` (default `cosign.pub`): sign each release, attest its provenance and SBOM, and record it in the release ledger; see [Attest each release](/terragucci/guides/publish-modules/#attest-each-release) |
| `modules.require` | none (off) | `attested`: `tf-check` and `tf-plan` refuse a root that pins a release of a checked source unless it verifies; `tf-plan` reads it at base. terragucci's CI images carry the HCL parser it reads pins with; elsewhere, `npm i -D @cdktn/hcl2json`. See [Require attested releases](/terragucci/guides/publish-modules/#require-attested-releases) |
| `modules.trusted` | none | publishers in other repos that `require` checks: each a `source` (an `oci://` prefix or a git URL), the `key` (a path to their `cosign.pub` in this repo) and the `ledger` (the git URL whose `chant/lifecycle` holds their release ledger) |
| `tips` | `true` | advice on pins, lock files and rollout setup, in the report and the dry run |
| `respond` | a response per event | how terragucci answers each pipeline event; see [Responses to pipeline events](/terragucci/reference/responses/) |
| `agent` | none | `via` (`forge`), `token_env` and [`comment`](#the-agent-comment) |
| `atlantis_comments` | `false` (off) | `true`: `atlantis plan` and `atlantis apply` comments work as `/terragucci plan` and `/terragucci apply`, with the same checks; see [Comment forms](/terragucci/guides/re-plan-from-a-comment/#comment-forms) |
| `review` | none (off) | `agent`, `command`, `key_secret`, `instructions`, `timeout`: a model reviews each pull request's description against its plan; see [The review](#the-review) |
| `decide` | none | the typed-decision service a few responses may ask; see [The decide block](#the-decide-block) |
| `audit_region` | the `aws` CLI's region | the AWS region whose CloudTrail drift attribution reads |
| `dashboards` | `false` (off) | `true`, or `dir`, `prometheus`, `tempo`, `folder`, `path`, `drift_age`, `wave_wait`, `schedule`; see [Dashboards](/terragucci/reference/observability/#dashboards-and-alerts) |

`terragucci config check` rejects a key this table does not list and names the keys it accepts.

## A version per root

A plain root can run its own OpenTofu or Terraform version, so one wave plans and applies roots on different versions. The first of these that names an exact version picks it:

| Order | Where | Example |
|---|---|---|
| 1 | `version` in `terragucci.yml` as a map, the first glob the root's path matches | `"envs/legacy/*": "1.9.1"` |
| 2 | a `.opentofu-version` (`tofu`) or `.terraform-version` (`terraform`) file in the root | `1.10.6` |
| 3 | an exact `required_version` in the root | `required_version = "1.10.6"` |

```yaml
binary: tofu
version:
  "envs/legacy/*": "1.9.1"
  envs/edge: "1.11.2"
```

A root that pins nothing runs the version every job runs. A pin that is that version uses the job's binary as it is. Any other pin is installed in the job for the roots that pin it, checked against the release's SHA256SUMS, once per version, under `TOFU_INSTALL_DIR` by version, so a runner that keeps that directory reuses it. A version file that names no exact version (`latest`, `min-required`) and a `required_version` range pin nothing. The [report](/terragucci/reference/report-schema/) names each root's binary, version and pin, and so does the plan note once a root pins.

A map of versions goes in the repo's own `terragucci.yml`, which the jobs read; in a control repo, `version` is one version. Pins are for `tofu` and `terraform`: `choudoufu` takes one version, and a Terragrunt repo runs one version of its binary for every unit. Run `npx terragucci init` again after you add or change a pin, so the check job validates each root with its own version. With [`generate`](/terragucci/guides/generate-root-files/#the-version-a-root-declares) set, each root's generated `required_version` is the version this map gives it, unless `generate` sets one.

## Apply before merge

```yaml
apply:
  when: pull-request   # default: merge
  merge: auto          # default: manual
  merge_token_env: MERGE_TOKEN   # the secret the merge is made with
  requires: [approved, mergeable, undiverged, checks]   # the default: all four
```

| Setting | Does | Allowed on |
|---|---|---|
| `when: merge` | only merged code applies, and the apply role never meets a pull request's code | every forge |
| `when: pull-request` | a writer's `/terragucci apply [wave-<n>]` on the open pull request applies its head, and its roots stay [locked](/terragucci/guides/apply-before-merge/#locks) until merge or close; after the merge, `terragucci/apply` fails if any root still plans a change | every forge, plain roots and Terragrunt repos, not with `waves.jobs`; on GitLab it needs `comments` and `merge_token_env` ([GitLab](#apply-before-merge-on-gitlab)) |
| `merge: manual` | a person merges | `when: pull-request` only; `config check` refuses `merge` without it |
| `merge: auto` | `pr-merge` merges once every wave applied, never after a partial apply | `when: pull-request` only |
| `merge_token_env` | the secret the merge is made with; only `pr-merge`, which runs no pull request code, gets it; on GitLab the `comments` job too, which starts the apply pipeline with it | required on Forgejo with `merge: auto`, and on GitLab with either `merge` |
| `requires` | what an open pull request needs before `/terragucci apply` applies it; see the next table | `when: pull-request` only; with `merge: auto` it must list `approved` |

| `requires` entry | The open pull request needs |
|---|---|
| `approved` | an approval of its head by a reviewer other than its author, and no reviewer whose last review asks for changes; on GitLab, an approval by a Developer or above after its latest push |
| `mergeable` | the forge to say it merges: no conflicts with the default branch, on GitHub no branch protection blocking it, on GitLab a `detailed_merge_status` of `mergeable` |
| `undiverged` | its head to contain the default branch as it is now |
| `checks` | every status and check on its head to have passed |

Leaving an entry out drops that check, and `requires: []` drops all four. These stay whatever `requires` lists:

| Always checked | The open pull request needs |
|---|---|
| `terragucci/plan` | to have passed on its head; a policy denial fails it |
| the pipeline file | to be left alone by the change |
| locks | no other open pull request holding a lock on a root it reaches |

### Apply before merge on GitLab

A merge request note starts no pipeline, and a merge request's own pipeline runs its own `.gitlab-ci.yml`. So the `comments` job reads `/terragucci apply` and starts a pipeline on the default branch, whose `mr-apply` job applies the head.

```yaml
forge: gitlab
comments: "*/5 * * * *"
apply:
  when: pull-request
  merge: auto                               # or manual
  merge_token_env: TERRAGUCCI_MERGE_TOKEN   # required on GitLab
```

| Setting | Why |
|---|---|
| `comments` | the schedule whose job reads the note |
| `merge_token_env` | a CI/CD variable with a token whose role may merge into the default branch: only such a token may start a pipeline there, and with `merge: auto` it merges |
| `forge: gitlab` | needed with `merge: manual`, so `config check` knows the token is not only for merging |

`config check` and `init` refuse `when: pull-request` on GitLab without `comments` or `merge_token_env`. [Apply a pull request before it merges](/terragucci/guides/apply-before-merge/) has the variable's settings.

:::caution
On GitHub, `mergeable` reads `mergeable_state: blocked`, so a required status that only the apply posts, such as `terragucci/apply`, blocks every apply. Leave it out of branch protection.
:::

Gate, approval mode, signers and this file come from the default branch. [When a comment runs nothing](/terragucci/reference/pipeline/#when-a-comment-runs-nothing) lists every check an apply comment must pass.

Unmerged pull request code runs with the apply role. Forks never apply; require reviews in branch protection. [What the pull request's code can reach](/terragucci/reference/pipeline/#what-the-pull-requests-code-can-reach).

## Plan locks

```yaml
locks: plan   # default: apply
```

| Setting | A pull request locks its roots | Allowed on |
|---|---|---|
| `locks: apply` | when it applies before merge, or a writer comments `/terragucci lock` | every forge |
| `locks: plan` | from its first plan, and again on each push or `/terragucci plan` | GitHub and Forgejo, with either `apply.when`; `init` and `config check` refuse it on GitLab, where no merge request event runs a job from the default branch |

With `locks: plan`, `init` adds the `pr-lock` job ([the generated pipeline](/terragucci/reference/pipeline/#plan-locks)). A second pull request that reaches a locked root gets a failing `terragucci/lock` status, and branch protection can require that status. [Locks](/terragucci/guides/apply-before-merge/#locks) lists what takes and releases a lock.

## A TypeScript file

`terragucci.ts` (`TerragucciConfig`) is folded without running; reading the environment is refused. It needs `npm i -D @intentius/tsad-reference`.

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
| `parallelism` | 3 for GitLab-managed state, else 16 | how many units one `run --all` runs at once; each unit running starts its own providers, about 800 MB each with the AWS provider, so 16 need about 13 GB: set 4 on a 7 GB runner |
| `dependents` | `follow` | `follow`, or `plan` to preview them, provisional and undigested |
| `credentials` | none | AWS roles by unit glob; see [Credentials](/terragucci/reference/pipeline/#terragrunt) |

Terragrunt 1.1 or later is required; see [Use Terragrunt](/terragucci/guides/use-terragrunt/).

## The agent comment

`agent.comment` lets a writer ask an agent to change a pull request; GitHub and Forgejo only.

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

`comment: true` takes defaults; `agent.token_env` is the push token's secret name.

| Key | Default | Meaning |
|---|---|---|
| `command` | Claude Code in print mode | run in the checkout, prompt on stdin |
| `key_secret` | `ANTHROPIC_API_KEY` | the secret holding the model's API key, given to the agent's step alone |
| `max_turns` | 30 | the turn limit, passed to the command as `TG_AGENT_MAX_TURNS` |
| `timeout` | 30 | minutes before the agent's job is stopped |

The agent's jobs get no cloud credentials; `init` refuses `agent.comment` on GitLab. [The jobs](/terragucci/reference/pipeline/#the-agent-comment).

## The review

`review.agent` adds two jobs after a pull request's plan: a model compares the title and description with the diff, the plan note and the policy results, and the pipeline posts its review as a note. GitHub and Forgejo only; [Have a model review a pull request](/terragucci/guides/agent-review-a-pull-request/).

```yaml
review:
  agent: true
  command: my-reviewer --stdin
  key_secret: ANTHROPIC_API_KEY
  instructions: .terragucci/review.md
  timeout: 10
```

| Key | Default | Meaning |
|---|---|---|
| `agent` | `false` | `true` turns the review on; the other keys need it |
| `command` | Claude Code in print mode with no tools | run in the default branch's files with the prompt on stdin; what it prints is the review |
| `key_secret` | `ANTHROPIC_API_KEY` | the secret holding the model's API key, given to the command's step alone |
| `instructions` | `.terragucci/review.md` | the instructions file, read from the default branch only |
| `timeout` | 10 | minutes before the review job is stopped |

The review jobs get no cloud credentials and the command's step no forge token; `init` refuses `review` on GitLab. With `policy` set, each `tf-apply` wave reads the review's risk as [`input.review`](/terragucci/reference/policy/#review).

## The decide block

Some responses can ask a typed-decision model about free text; with no `decide` block, nothing is asked.

```yaml
decide:
  backend: laya
  url: http://decide:8790
  thresholds: { noul: 0.8, choice: 0.7 }
```

| Key | Default | Meaning |
|---|---|---|
| `backend` | required | `laya` (the `terragucci-decide` image), `von`, `decider` or `jev` |
| `url` | required, except `jev` | the service's base URL; `jev` defaults to `https://api.typesafe.ai` |
| `model` | required, except `laya` | a pinned version such as `jev-1.13.0`; `jev-latest` is refused |
| `token_env` | none, required for `jev` | the bearer token's variable |
| `thresholds` | `noul` 0.8, `choice` 0.7, `score` 0.7 | the probability an answer needs before a response acts on it |

A weak, missing or other-model answer is ignored. A decision never approves, applies or resolves a gate, and the model reads only the redacted report.

## Parameters

None. [`chant approve`](/terragucci/concepts/glossary/#chant) writes approvals to [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle). A local run can narrow:

```bash
terragucci plan --project github.com/acme/infra --root envs/dev/core
```

Nothing that changes what an approval covers can be passed at run time.
