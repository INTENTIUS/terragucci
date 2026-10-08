---
title: terragucci.yml keys
description: Every key of the config file, its default, and the defaults terragucci uses when there is no file.
prompt: |
  Read https://intentius.io/terragucci/reference/config/.
  Run `npx terragucci config check --json` on this repo's terragucci.yml and list each problem it finds.
  Propose the smallest file that keeps current behaviour, run config check again, and open a pull request with it.
  Never run apply, `chant approve` or `--mode apply`, and never merge.
---

terragucci reads `terragucci.yml`, `.yaml`, `.json` or `.ts` from the repo root; two is an error. `terragucci config check` lists every problem.

## Defaults with no file

With no `terragucci.yml`, `init` starts from these defaults:

| Setting | Default |
|---|---|
| Roots | every directory whose `*.tf` or `*.tofu` files declare a backend or configure a provider |
| Binary | `.opentofu-version` gives `tofu`, `.terraform-version` gives `terraform`, then `.tofu` files, then the path, then `tofu` |
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

In a control repo, a project's keys override `defaults`; see [Govern many repos](/terragucci/guides/govern-many-repos/). A project's jobs read `policy` from the project's own `terragucci.yml`, so `reconcile` writes the key there.

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

## Every key

Each key set away from its default; keep only the lines you need. This file passes `config check`.

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
| `binary` | detected; see [Defaults with no file](#defaults-with-no-file) | `terraform`, `tofu` or [`choudoufu`](/terragucci/concepts/glossary/#choudoufu) |
| `forge` | read from the project's host | `github`, `gitlab` or `forgejo`, for a host terragucci cannot name |
| `gate` | `on-destroy` | `always`, `on-destroy` or `never`; see [Gate policy](/terragucci/reference/stages/#gate-policy) |
| `apply` | `when: merge` | `when`, `merge`, `merge_token_env` and `requires`; see [Apply before merge](#apply-before-merge) |
| `waves` | none | `canary`, a list of roots that go out first, as wave 1 |
| `drift` | `false` (off) | a cron schedule for `tf-drift`; see [Drift](/terragucci/reference/stages/#drift) |
| `runtime` | `forge` | `forge`, the only value: every stage runs on the forge's CI; see [Where it runs](/terragucci/reference/runtimes/) |
| `reports` | none: the report is a CI artifact | `bucket`, `endpoint`, `prefix`, `url` (the browser address links use) and `role` (the ARN that writes); see [Keep reports in S3](/terragucci/guides/keep-reports-in-s3/) |
| `version` | the one every root pins exactly, else terragucci's default for the binary | the binary's version |
| `env` | `{}` | environment variables every job gets; values only, never secrets |
| `url` | `https://<host>/<path>` | where a project lives, for a forge on another scheme or port |
| `telemetry` | none | `headers_secret`, the secret holding `OTEL_EXPORTER_OTLP_HEADERS`; `trace_url`, a trace link with `{trace_id}` |
| `token_env` | `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`, by forge | the forge token `reconcile`, `rollout` and `respond --mode apply` use |
| `oidc` | none | plan and apply identities per cloud; see [Cloud roles over OIDC](/terragucci/reference/environment/#cloud-roles-over-oidc) |
| `parallelism` | 3 for GitLab-managed state, else 16 | roots planned at once; Terragrunt uses `terragrunt.parallelism` |
| `terragrunt` | detected | Terragrunt settings: `version`, `exclude`, `parallelism`, `dependents`, `credentials` |
| `policy` | none (off) | `engine` (`conftest` or `opa`), `path` (default `policy`), `namespace`, `input` (`plan` or `hcp`), [`source`](/terragucci/reference/policy/#a-shared-policy-source) (`git+https://<host>/<path>@<ref>`); the [base branch's key](/terragucci/reference/policy/#the-base-branch-decides) decides |
| `modules.path` | `modules/*` | a glob of the directories that hold your modules |
| `modules.publish` | none | an `oci://` registry, `git-tags`, or a list of both; turns on `tf-publish` |
| `tips` | `true` | advice on pins, lock files and rollout setup, in the report and the dry run |
| `respond` | a response per event | how terragucci answers each pipeline event; see [Responses to pipeline events](/terragucci/reference/responses/) |
| `agent` | none | `via` (`forge`), `token_env` and [`comment`](#the-agent-comment) |
| `decide` | none | the typed-decision service a few responses may ask; see [The decide block](#the-decide-block) |
| `audit_region` | the `aws` CLI's region | the AWS region whose CloudTrail drift attribution reads |
| `dashboards` | `false` (off) | `true`, or `dir`, `prometheus`, `tempo`, `folder`, `path`, `drift_age`, `wave_wait`, `schedule`; see [Dashboards](/terragucci/reference/observability/#dashboards-and-alerts) |

`terragucci config check` rejects a key this table does not list and names the keys it accepts.

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
| `when: pull-request` | a writer comments `/terragucci apply [wave-<n>]` on the open pull request and its head applies; `/terragucci lock` takes the locks without applying; roots stay locked until merge, close or `/terragucci unlock`; after the merge, `terragucci/apply` fails if any root still plans a change | GitHub and Forgejo, plain roots; `init` and `config check` refuse it on GitLab, `init` refuses it in a Terragrunt repo |
| `merge: manual` | a person merges | `when: pull-request` only; `config check` refuses `merge` without it |
| `merge: auto` | `pr-merge` merges once every wave applied, never after a partial apply | `when: pull-request` only |
| `merge_token_env` | the secret the merge is made with; only `pr-merge`, which runs no pull request code, gets it | required on Forgejo |
| `requires` | what an open pull request needs before `/terragucci apply` applies it; see the next table | `when: pull-request` only; with `merge: auto` it must list `approved` |

| `requires` entry | The open pull request needs |
|---|---|
| `approved` | an approval of its head by a reviewer other than its author, and no reviewer whose last review asks for changes |
| `mergeable` | the forge to say it merges: no conflicts with the default branch, and on GitHub no branch protection blocking it |
| `undiverged` | its head to contain the default branch as it is now |
| `checks` | every status and check on its head to have passed |

Leaving an entry out drops that check, and `requires: []` drops all four. Three checks stay whatever `requires` lists: `terragucci/plan` passed on the head (a policy denial fails it), the change leaves the pipeline file alone, and no other open pull request holds a lock on a root it reaches. On GitHub, `mergeable` reads `mergeable_state: blocked`, so a required status that only the apply posts, such as `terragucci/apply`, blocks every apply; leave it out of branch protection.

Gate, signers and this file come from the default branch. [When a comment runs nothing](/terragucci/reference/pipeline/#when-a-comment-runs-nothing) lists every check an apply comment must pass.

Unmerged pull request code runs with the apply role. Forks never apply; require reviews in branch protection. [What the pull request's code can reach](/terragucci/reference/pipeline/#what-the-pull-requests-code-can-reach).

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
| `parallelism` | 3 for GitLab-managed state, else 16 | how many units one `run --all` runs at once |
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
