---
title: CLI commands
description: Every terragucci command, its flags and its exit codes.
prompt: |
  Read https://intentius.io/terragucci/reference/cli/.
  Run `npx terragucci config check` and `npx terragucci init --dry-run --json` in this repo and tell me the roots, binary and forge it found, and any config problem, with the exit code of each.
  Read only. Never apply, approve (a pull request review or `terragucci approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

Run `npx terragucci <command>` from a repo's root; a generated pipeline calls the same commands.

| Command | Does |
|---|---|
| `init` | finds roots, binary and forge, and writes the pipeline and [`terragucci.components.json`](#the-components-file); under `approval: sealed`, also [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) |
| `import` | writes `terragucci.yml` from an `atlantis.yaml`, a `digger.yml` or a Terragrunt Scale `.gruntwork`, or from the workspaces of HCP Terraform, OTF or Scalr, and prints what became of each setting |
| `reconcile` | from a [control repo](/terragucci/concepts/control-repo/), opens a pull request in each project that needs a change |
| `generate` | writes each root's backend, provider and version files from the [`generate` key](/terragucci/guides/generate-root-files/), and in a Terragrunt repo `terragucci.hcl`, which each unit includes; `--check` refuses one that differs, and the generated `tf-check` job runs it |
| `estate` | writes one page for every project, `estate.html`, `estate.json` and `dora.json`, to the reports bucket, and prints a link to it: presigned on S3, a signed URL on GCS, a SAS on Azure Blob |
| `audit` | appends every approval, apply, policy override and refused wave across the projects to the [audit trail](/terragucci/reference/audit-trail/), `audit.jsonl` in the reports bucket, with its page and a link to it, and every state version no wave or migration wrote; `--check` reports what the record lacks |
| `plan` | plans every root and prints the result |
| `stage tf-plan` | plans the roots a change reaches, groups them, and writes the report |
| `publish` | publishes each changed module at a new version |
| `verify-release` | checks one published version of a module: its signature, provenance and SBOM, and its record in the release ledger |
| `rollout` | moves a module's or provider's pin one wave at a time |
| `respond` | runs the response to a pipeline event |
| `comment` | reads a `/terragucci plan [root]` or `/terragucci agent <ask>` pull request comment, polls GitLab merge request notes, and pushes an agent's change; the generated pipeline runs it |
| `comment-apply` | reads a `/terragucci apply [wave-<n>]`, `/terragucci lock` or `/terragucci unlock` comment; the generated pipeline runs it |
| `pr-lock` | takes or releases a pull request's plan locks under `locks: plan`; the generated pipeline runs it |
| `approve` | approves a waiting wave: finds it on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle), prints what it does and records an approval of its digest, with `--sign` under `approval: sealed`; also approves a migration, a state export, a lock release and a pull request environment; a person runs it |
| `override` | overrides a policy denial of one root's plan: finds the denial a `tf-apply` wave recorded, checks the rules named are the ones that denied it, and records the override with the reason; a person `policy.override` lists runs it |
| `approval-status` | with `approval: pr-review`, posts `terragucci/approval` on a pull request's head: pending while a wave the gate will hold has no approving review of that head; the generated pipeline runs it |
| `post` | sets a commit status, posts or edits the plan note, replies, or marks plan notes stale; the generated pipeline's jobs run it |
| `plan-note` | on GitHub and Forgejo, posts the plan job's note and `terragucci/plan` from its report, read as data; the generated `plan-note` and `replan-note` jobs run it |
| `notify` | posts a wave that waits, is refused or fails to the Slack, Teams and generic webhooks `notify` names, and drift to Slack and Teams; the generated apply and drift jobs run it |
| `relay` | serves the Approve and Decline buttons of Slack and Teams messages, in your own cloud |
| `query` | runs one SQL statement over the inventory, versions, changes, history, audit trail and state edges in the reports bucket, on your machine, and prints the rows |
| `mcp` | an MCP server on stdio over what terragucci wrote to the reports bucket and the repo, for a coding agent; read-only, and with `--propose` it also pushes a branch, opens a pull request and reads its plan |
| `guard` | writes wrappers for the binaries and a Claude Code hook that refuse an apply in a root of the pipeline, for a coding agent's shell |
| `view` | runs [behold](https://intentius.io/behold/using/terragucci/) on your machine over the repo and its reports bucket: the roots as one graph, each resource marked with what the newest runs found; `--export` writes a static copy |
| `drift-agent` | writes the drift agent's prompt and opens a pull request with its change, with [`agent.drift`](/terragucci/guides/agent-fix-drift/); the generated pipeline runs it |
| `pr-merge` | merges a pull request every wave of which applied before merge, with `apply.merge: auto`; the generated pipeline runs it |
| `config check` | validates the config file and lists every problem, then prints the approval mode in force and where it comes from; with `oidc.roles`, the state each role reaches, and a warning for each role that reaches another environment's state; [config check tips](/terragucci/reference/tips/#config-check-tips) after `ok` |
| `config identities` | per environment and stage, prints the roots, the runner, the forge environment, the cloud identities, the OIDC subject and audience each job presents, and the trust each cloud needs to accept that job |
| `forge check` | compares what `config identities` expects with the live forge environments, runners, protections and variables and each cloud's trust, reading only, and exits 1 on a mismatch; a person or a scheduled job of the team's own runs it |
| `state export` | asks for one version of a root's state and, once someone else approved the request, downloads it to your machine and records who exported what on `chant/lifecycle`; a person runs it |
| `check-root`, `check-pins`, `check-policy`, `check-sources` | the steps of `tf-check` beyond the format check; the generated pipeline runs them |
| `check-job` | the first line of an environment's apply job: stops the job unless it runs in the environment's forge environment, on a branch it applies from and on its runner; the generated pipeline runs it |
| `resume` | applies a waiting wave once its approval stands, or the rest of a killed approved apply; the generated resume job runs it |
| `ephemeral` | applies a pull request's copy of the [ephemeral](/terragucci/reference/config/#ephemeral-environments) roots, destroys it on close, and sweeps the copies whose TTL passed; the generated pipeline runs it |
| `unlock-state` | releases a root's state lock a killed job left, once no run that may hold it is alive and an approval of its lock ID stands, and records the release; a person runs it |
| `auth-provider` | internal: Terragrunt's `auth-provider-cmd`, which the generated Terragrunt pipeline runs |
| `terramate generate` | internal: fails on stale [Terramate](/terragucci/guides/use-terramate/) generated code (`terramate generate --detailed-exit-code`), then writes each stack's order and inputs beside it; every job of the generated Terramate pipeline runs it first |
| `atmos write` | internal: writes each Atmos instance to `<stack>/<component>` from `atmos describe stacks`; every job of the generated [Atmos](/terragucci/guides/use-atmos/) pipeline runs it first |
| `profiles` | internal: prints the local stack profiles a config needs, `aws` and each project's forge |
| `install` | fetches a release of OpenTofu, Terraform, Terragrunt, Atmos, [choudoufu](/terragucci/concepts/glossary/#choudoufu) or Infracost, verified against its checksums |

## init

```bash
terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform|choudoufu] [--approval ledger|pr-review|sealed] [--signer <principal>] [--force] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--forge` | the forge, when the remote cannot tell |
| `--binary` | the binary, when detection picks the wrong one: `tofu`, `terraform` or `choudoufu` |
| `--approval` | `ledger`, `pr-review` or `sealed`, when the config names no mode; see [Approval modes](/terragucci/guides/approve-a-wave/#approval-modes) |
| `--signer` | under `approval: sealed`, write the first line of `.chant/allowed_signers` for this principal from `git config user.signingkey`, when the file does not exist |
| `--dry-run` | compute everything and write nothing |
| `--force` | overwrite a pipeline file or `terragucci.components.json` terragucci did not write; on GitLab that is `.gitlab/terragucci.yml`, never your `.gitlab-ci.yml` |

A flag detection would not reach goes into a new `terragucci.yml`. An existing config file is never edited: `init` exits 2 and names the line to add, such as `binary: terraform`. A key already set there wins.

The approval mode decides what else `init` writes.

| Mode | `init` also |
|---|---|
| `ledger` (the default) | writes no `chant.workspace.json`; with `approval: ledger` set, drops the wave gates an earlier `init` listed under [`identity.gates`](/terragucci/concepts/glossary/#identitygates) |
| `pr-review` | the same as `ledger`; on GitHub and Forgejo adds the `approval` job and the `terragucci/approval` status ([the pipeline](/terragucci/reference/pipeline/#statuses-and-stale-plans)) |
| `sealed` | writes [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) with each wave's gate (`wave-1`, `wave-2`) under `identity.gates`, so a wave counts only an approval sealed with `terragucci approve --sign`; an existing file gains missing gates |

[Approve a waiting wave](/terragucci/guides/approve-a-wave/) sets up the signers file.

### The components file

`init` also writes `terragucci.components.json` at the repo's root, beside the pipeline. It lists the repo's roots as chant components, with their waves and the pipeline's jobs that apply them. The pipeline does not read it, and the workflow is the same with or without it. `init` writes it again on every run and replaces it only when `generated_by` names terragucci, unless you pass `--force`.

| Field | Holds |
|---|---|
| `schema` | `terragucci.components/v1` |
| `generated_by` | `terragucci` and the release that wrote it |
| `roots` | each root by name, as reports and waves name it, with `dir`, its directory in the repo; an Atmos instance's `dir` is its component's |
| `components` | one per root: `name`, `dependsOn`, and `deploy`, one `Apply` phase with a `terraform-apply` step for the root. The step's `noRollback` says why it has no rollback: the pipeline applies the root, a failed wave leaves what applied, and a re-run finishes it |
| `pipeline.path`, `pipeline.forge` | the pipeline file and its forge |
| `pipeline.jobs` | each job that applies roots, named as in the pipeline, with its `needs`, its `wave`, and `applies`, the roots it applies |

A root's `dependsOn` is the roots it must follow: those whose state it reads, those [`waves.after`](/terragucci/reference/config/) puts before it, or in a Terragrunt, Atmos or Terramate repo the order that tool gives. When that order alone would group the roots into other waves than the pipeline's, as [`waves.canary`](/terragucci/reference/config/) does, each root also depends on every root of the wave before its own. Grouping the components by `dependsOn` then gives the pipeline's waves.

In `pipeline.jobs`, a wave split by `waves.jobs` or by environment has a job that decides the wave and applies no root, and a job per share or group that lists its own roots. `apply-done` and `apply-rest` apply none. In a Terragrunt repo, the share jobs' roots are the layer's units as `init` found them; the stage cuts them again when it runs. With `apply.when: pull-request`, the list holds the one job that applies a pull request's every wave, `apply-comment` (`mr-apply` on GitLab), with no `wave` and every root.

The [agent jobs](/terragucci/guides/agent-change-a-pull-request/) refuse a change to the file.

## import

```bash
terragucci import atlantis [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import digger [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import spacelift [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import env0 [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import terragrunt-scale [<dir>] [--force] [--dry-run]
```

Reads the file named, else `atlantis.yaml` (or `atlantis.yml`), or OpenTaco's `digger.yml` (or `digger.yaml`), and writes `terragucci.yml` by the tables of [Coming from Atlantis or OpenTaco](/terragucci/guides/coming-from-atlantis-or-opentaco/). Each setting the file carries is printed under one of four headings, quoting the guide's row:

| Heading | The setting |
|---|---|
| Written to terragucci.yml | became a key, such as a project's `dir` in `roots` |
| Done by terragucci with no key | needs no key, such as `autoplan.when_modified` |
| Not mapped | has no key here, with the guide's reason; so does a setting the guide has no row for |
| Left out on purpose | is something terragucci never does, such as an `import` workflow, with the guide's rule and what to do instead |

| Flag | Meaning |
|---|---|
| `--apply-when` | `pull-request` (the default, as Atlantis and OpenTaco apply before merge) or `merge`; a `digger.yml` whose `on_commit_to_default` runs `digger apply` already means `merge` |
| `--forge` | the forge, when the remote cannot tell; on GitLab the import keeps `apply.when: merge` and writes no `locks: plan`, and on Forgejo no `apply.merge: auto`, since those need a schedule or a token it cannot name |
| `--dry-run` | print what would be written, and write nothing |
| `--force` | replace an existing `terragucci.yml` |

It exits 2 when the file is missing or not YAML, or when `terragucci.yml` exists and `--force` is not given. A project `dir` that matches no directory with Terraform files is written and named.

Run [`init`](#init) next to write the pipeline.

`import terragrunt-scale` reads `.gruntwork` (or the directory named) and each unit's `gruntwork.hcl`, and writes each environment's plan and apply roles as `terragrunt.credentials` ([Terragrunt Scale](/terragucci/guides/use-terragrunt/#terragrunt-scale)). It exits 2 on a repo with no Terragrunt or a legacy `config.yml`.

`import spacelift` reads `.spacelift/config.yml` (or the file named) and every `spacelift_*` resource in the repo's `.tf` files; `import env0` reads `env0-discovery.yml` (or the file named), each `env0.yml` custom flow and every `env0_*` resource. Either runs on the admin code alone when the file is missing. They map by the concepts table of [Coming from Spacelift or env zero](/terragucci/guides/coming-from-spacelift-or-env-zero/#import), keep `apply.when: merge` unless `--apply-when` says otherwise, since both platforms apply a tracked branch after a push, and name each stack or environment whose state the platform manages.

### From a platform's workspaces

```bash
terragucci import hcp [--hostname <host>] --organization <org> [--repo owner/name] [--forge github|gitlab|forgejo] [--force] [--dry-run]
terragucci import otf --hostname <host> --organization <org> [--repo owner/name] [--forge github|gitlab|forgejo] [--force] [--dry-run]
terragucci import scalr --hostname <account>.scalr.io [--environment <name or ID>] [--repo owner/name] [--forge github|gitlab|forgejo] [--force] [--dry-run]
```

Reads the workspaces over the platform's API, with the token in `TF_TOKEN_<host>` or `credentials.tfrc.json` (for Scalr, also `SCALR_TOKEN`), and writes `terragucci.yml` and a `terraform.tfvars` in each root that has none, by [Coming from HCP Terraform, Scalr or OTF](/terragucci/guides/coming-from-hcp-terraform-scalr-or-otf/#import-the-workspaces). It only reads: no workspace, variable or run changes. A sensitive variable's value is never read; its name goes under `pass.secrets`.

| Flag | Meaning |
|---|---|
| `--hostname` | the platform's host; `app.terraform.io` for `hcp` when not given |
| `--organization` | the organization whose workspaces are read (`hcp`, `otf`) |
| `--environment` | one Scalr environment, by name or ID; every one the token sees when not given |
| `--repo` | this repo as the platform's VCS connection names it; the `origin` remote's `owner/name` when not given |
| `--forge` | the forge, when the remote cannot tell; on GitLab the secrets are listed as masked CI/CD variables to create, with no `pass` |
| `--dry-run`, `--force` | as above |

It exits 2 when the host refuses the token or names no TFE API, and, before it reads anything, when `terragucci.yml` exists and `--force` is not given.

## reconcile

```bash
terragucci reconcile [--config <file>] [--mode dry-run|apply] [--project <host/path>]
```

`--config` defaults to the config file in the working directory and `--mode` to `dry-run`. `--mode apply` opens a pull request per changed project and never runs `terraform apply` ([glossary](/terragucci/concepts/glossary/#words-that-mean-something-else-in-terraform)). `--project` limits the run to one project.

## generate

```bash
terragucci generate [--check] [--dry-run] [--config <file>]
```

From `terragucci.yml`'s `generate` key it writes `backend.tf`, `providers.tf` and `versions.tf` in each root and removes generated files the key no longer asks for. It never overwrites a file it did not write, and refuses a Terragrunt repo. `--dry-run` prints what it would write. `--check` writes nothing and fails on each generated file that differs from what it would write, is missing, or is no longer asked for, with the lines that differ. See [Generate backend and provider files](/terragucci/guides/generate-root-files/).

## estate

```bash
terragucci estate [--config <file>] [--out <dir>] [--link-hours <n>]
    [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
```

| Flag | Meaning |
|---|---|
| `--config` | the config file; default the one in the working directory |
| `--out` | where the page is written locally; default `terragucci-estate` |
| `--link-hours` | how long the link lives; default 24, at most 168 |
| `--bucket`, `--bucket-endpoint`, `--bucket-prefix` | the bucket to read and write (`s3://<bucket>`, `gs://<bucket>` or `az://<account>/<container>`), in place of `reports` in a repo's config |

| | `estate` |
|---|---|
| Reads | each project's `index.json`, `inventory.json`, `versions.json`, `changes.json` and `states.json`; `audit.jsonl` and `audit.json` when the audit trail is there, for the approvers and each root's [unrecorded writes](/terragucci/reference/audit-trail/#unrecorded-writes) |
| Writes | `estate.html`, `estate.json` and `dora.json` at the top of the prefix; `history.html` and `history.json` once an apply changed a resource, with each apply's approver from `audit.jsonl` |
| Projects | in a control repo, its `projects:`, each read from its own `reports`, the page written to `defaults.reports`; in a repo of its own, the ones the top `index.json` lists |
| Also | links the audit trail when `audit.json` is beside the page; computes the [delivery metrics](/terragucci/reference/delivery-metrics/) and sends them as gauges when an OTLP endpoint is set |
| Exit 1 | a project's index could not be read; the page names it |

## audit

```bash
terragucci audit [--check] [--config <file>] [--out <dir>] [--link-hours <n>]
    [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
```

| Flag | Meaning |
|---|---|
| `--check` | build the entries again and compare them with the record; write nothing; exit code 1 naming each entry the record lacks |
| `--config` | the config file; default the one in the working directory |
| `--out` | where the record, page and summary are written locally; default `terragucci-audit` |
| `--link-hours` | how long the link to `audit.html` lives; default 24, at most 168 |
| `--bucket`, `--bucket-endpoint`, `--bucket-prefix` | the bucket to read and write, in place of `reports` in a repo's config |

| | `audit` |
|---|---|
| Reads | each project's `chant/lifecycle` history, its `tf-apply` wave reports and its `states.json`; the list of versions each root's state store keeps (ids and times, never a state); with `audit_log_group`, the CloudWatch Logs group that names who wrote a version |
| Writes | the entries `audit.jsonl` lacks, appended, and `audit.html` and `audit.json` beside it at the top of the prefix |
| Projects | in a control repo, its `projects:`, each ledger fetched from the project's repo and its reports read from its own `reports`, the record written to `defaults.reports`; in a repo of its own, the checkout's, its ledger read from `origin` |
| Exit 1 | a project's ledger, index or `states.json` could not be read, or with `--check` the record lacks an entry. A root whose state's versions could not be listed is named in the log and on the page, and does not fail the run |

[The audit trail](/terragucci/reference/audit-trail/) describes every entry.

## plan and stage

```bash
terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>]
    [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--canary <globs>] [--bucket <url>]
    [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>] [--no-cost]
terragucci stage tf-drift [the same flags as tf-plan]
terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>]
    [--gate always|on-destructive|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>]
    [--shares <n> [--share <s>] [--decided <file>]] [--branches <branch>=<globs>[;...] [--branch <name>]]
    [--groups <group>=<globs>[;...] [--group <name>]] [--on-held wait|refuse] [--stand-down] [--after <dir>]
```

| Flag | Environment | Meaning |
|---|---|---|
| `--root` | | plan only the roots matching this glob |
| `--project` | | the project, as `<host>/<path>`, for a run from a control repo |
| `--config` | | the config file, when it is not at the repo root |
| `--out` | | where `stage` writes the report; default `terragucci-report/` |
| `--report-url` | | where the note links the HTML report; a URL that is not an `.html` file is read as the run's page |
| `--layers`, `--binary`, `--canary`, `--bucket` | | roots in apply order (layers split by `;`), binary, canary wave and bucket; each overrides `terragucci.yml` |
| `--bucket-endpoint`, `--bucket-prefix`, `--bucket-url` | | the store's endpoint, the key prefix, and the address that serves the bucket to a browser |
| `--terragrunt` | | run Terragrunt units, one `run --all` per wave; `tf-apply` applies each unit's saved plan |
| `--no-cost` | | leave out the cost estimate `cost` asks for; the confirm job passes it |
| `--rest` | | `tf-apply --terragrunt` only: run this wave, then each wave after it, stopping at the first that does not apply |
| `--base` | `TG_BASE` | the ref a change is measured against, such as `origin/main`; default is the pull request's target branch |
| `--forge` | | `github`, `forgejo` or `gitlab`, when the environment cannot tell; the plan note keeps to its comment limit, and `tf-drift` files its issue there |
| `--parallelism` | | roots run at once per dependency layer (`tf-plan`, `tf-drift`) or wave (`tf-apply`); overrides `parallelism` in `terragucci.yml`; `1` is serial |

Both `stage tf-plan` and `stage tf-drift` write the report even when a root refuses to plan. [The plan report](/terragucci/reference/report/) lists the files.

`stage tf-apply` applies one wave, as the generated `apply-wave-<n>` job does. Wave 1 first runs each [state migration](/terragucci/reference/migration-files/) that has not applied, behind its own gate, and `stage tf-plan` proves them. It refuses `--json` with exit 2. With `TG_OUTCOME_JSON` set it writes the wave's outcome to that file as [JSON](/terragucci/reference/cli-json/#the-apply-outcome).

| Flag | Environment | Meaning |
|---|---|---|
| `--wave` | | the wave to apply |
| `--gate` | | `always`, `on-destructive` (the default) or `never` |
| `--approval` | | the mode when the config at base names none and `chant.workspace.json` there lists no gate; a control repo's pipeline passes it |
| `--base` | `TG_BASE`, for the policy ref only | the ref that holds the wave's policy, approval mode, gate rule, signers file and other config; an open pull request's job passes `origin/<default branch>`. Without it the gate rule comes from the commit before the one applied |
| `--shares` | | `waves.jobs`: split the wave's roots into up to this many shares. Without `--share` the stage plans every root, decides the gate, writes each root's plan digest to `terragucci-wave/wave-<n>.json` and applies nothing |
| `--share` | | with `--shares`: plan this share's roots and apply each one whose plan has the digest in the decision file; exit 4 when one moved, which is not applied |
| `--decided` | | the decision file, when it is not `terragucci-wave/wave-<n>.json` |
| `--groups` | | [one apply job per identity](/terragucci/concepts/waves-and-approvals/#one-apply-job-per-identity), as `prod=envs/prod/**;dev=envs/dev/**`: each group's root globs or roots, and `default` for the roots none matches. Without `--group` the stage plans every root with the job's identities, decides the gate, writes the decision file and applies nothing. Plain roots only |
| `--group` | | with `--groups`: plan this group's roots of the wave (with `--shares`, its `--share`) and apply each one whose plan has the digest in the decision file; a group with no root in the wave applies nothing |
| `--branches` | | [`apply.branches`](/terragucci/reference/config/#apply-from-other-branches) as `release=envs/prod/*,envs/dr/*;staging=envs/staging/*`: the stage applies only the roots (in a Terragrunt repo, the units) of `--branch` when the map names it, and otherwise every root no branch's glob matches |
| `--branch` | | with `--branches`: the branch the push applies; unset means the default branch |
| `--on-held` | `TG_LOCK_POLL` | with `binary: choudoufu`, when another run's apply holds a resource the wave changes: `wait` (the default) polls every `TG_LOCK_POLL` seconds (10) for up to an hour, then plans again; `refuse` exits 5 naming that run, as the apply a comment starts does |
| `--stand-down` | | a push's wave: once it may apply, it applies nothing and exits 6 if a newer push is on its branch, which applies the whole tree |
| `--after` | | plain roots: the directory holding the earlier waves' report artifacts (`terragucci-earlier` in a pipeline). The stage writes each root's outcome beside its report, plans none of the roots [an upstream that did not apply holds](/terragucci/concepts/waves-and-approvals/#a-failed-root), applies the rest, and exits 1, or 3 when every root held waits for an approval |

## publish

```bash
terragucci publish [--dry-run] [--config <file>]
```

`--dry-run` lists what would be published and pushes nothing. A git tag that exists with the same content is unchanged and exits 0.

## verify-release

```bash
terragucci verify-release <module> <version> [--config <file>]
```

Run in the repo that publishes, with `modules.attest` set. For each target in `modules.publish` it reads the tag as it stands now and checks that the release ledger on `origin` records those bytes from the tag's commit. The public key must verify the release's signature, provenance and SBOM. It prints one line per target and exits 1 when any is refused.

## rollout

```bash
terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
```

`--mode` defaults to `dry-run`, and neither mode runs `terraform apply`. See [Rolling out a module version](/terragucci/reference/stages/#rolling-out-a-module-version).

## respond

```bash
terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|version-bump|description [--mode dry-run|apply] [flags]
terragucci respond rollout [--mode dry-run|apply]
```

`respond rollout` with a module runs that rollout's next step; without one it continues every rollout in flight and exits 1 only when one could not run.

| Flag | Used by | Meaning |
|---|---|---|
| `--mode` | all | `dry-run` (the default) or `apply`, which opens the pull request or pushes the commit and never runs `terraform apply` |
| `--report` | `plan`, `description`, `tips` | the report directory; for `tips`, a `stage tf-plan` report whose plans' renames get a `moved` block, and only those |
| `--approved`, `--current`, `--wave` | `wave-refused` | the approved report, the current report directory and the wave number |
| `--log` | `apply-failed` | the apply log; `-` reads standard input |
| `--root`, `--import` | `drift` | one root, and `<address>=<id>` for a resource the state does not hold |
| `--platform` | `tips` | lock file platforms, comma separated |
| `--branch` | `fmt`, `tips` | `fmt`: the branch to format; the default branch is refused. `tips` with `--report`: the branch the `moved` blocks' pull request goes into; default the default branch |
| `--module`, `--version` | `publish` | the module, and the release |
| `--module`, `--since` | `version-bump` | one module, and the ref to count changes from for a module with no release tag |
| `--title`, `--description` | `description` | the pull request's title and description; by default read from the job's event |
| `--attributions` | `drift` | the attributions `tf-drift` wrote, as a file; default `terragucci-report/attributions.json` |
| `--base` | `wave-refused`, `apply-failed` | read settings from the config at this ref (such as `origin/main`), not the checkout; an unreadable base gives no response and a logged reason |
| `--out`, `--binary`, `--config`, `--project` | all | as above |

[Responses to pipeline events](/terragucci/reference/responses/) explains each event. `respond` exits 0 once the event was handled, even when the response is `off`. The outcome is in the text, or in `results` with `--json` ([the JSON output](/terragucci/reference/cli-json/#respond)).

## comment

```text
terragucci comment --layers <a,b;c> --out <file> [--forge github|forgejo] [--agent off|on]
terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge github|forgejo]
terragucci comment --agent push --change <dir> [--policy-dir <dir>]
terragucci comment --forge gitlab --poll --layers <a,b;c> [--when merge|pull-request] [--requires <list>|none] [--plan-notes]
```

Reads the pull request comment in the event file (`GITHUB_EVENT_PATH`) and writes a decision to `--out`: plan, or stop with a reason. A refused command is answered on the pull request. `--forge github` (the default) asks the API for the commenter's permission and `--forge forgejo` reads it from the event. The generated `replan` job runs it before any credential; see [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/). `/terragucci apply` is read by `comment-apply`. Each `--agent` mode runs in its own job.

| `--agent` | Run by job | Does |
|---|---|---|
| `off` (the default) | `replan` | replies with how to turn the agent comment on |
| `on` | `replan` | leaves agent comments to the agent jobs |
| `run` | `agent` | decides on a `/terragucci agent <ask>` comment with the same checks and writes the prompt to `--prompt`; a fork or default-branch pull request gets no agent |
| `push` | `agent-push` | refuses the patch in `--change` when it touches a path an agent may not change, `--policy-dir` (default `policy`) among them, and commits a passing patch to the pull request's head branch with the `TG_*` variables in [Environment variables](/terragucci/reference/environment/) |

On GitLab, `--forge gitlab --poll` reads no event file; the generated `comments` job runs it on the comments schedule ([`comments`](/terragucci/reference/config/#keys)).

| Poll | Does |
|---|---|
| Which notes | those of the merge requests updated in the last day |
| Each `/terragucci` note | answered once: the reply carries a `<!-- terragucci:note=<id> -->` marker, and a note with one is never answered again |
| `--plan-notes` | first posts the plan note and status each merge request pipeline's plan job left in its report; the comments job passes it under `gitlab: { token: protected }` |
| Exit 1 | GitLab answered with an error |

| Note | Checked | Does |
|---|---|---|
| any | the author is a Developer or above; anyone else gets no reply | |
| `/terragucci plan [root]` | the merge request is open and from this project; a named root is a root of the pipeline | starts a merge request pipeline, which plans the whole merge request |
| `/terragucci apply` | the merge request merged into the default branch from this project; no later commit there has an apply of its own; no `wave-<n>` | retries the merge commit's first apply job that did not succeed; its gate decides again |
| `/terragucci apply [wave-<n>]`, with `--when pull-request` | the merge request is open, from this project, into the default branch; `--requires` (all four by default), `terragucci/plan` and the pipeline files, as `comment-apply` checks them | starts a pipeline on the default branch with `TG_MERGE_TOKEN` and the variables `TERRAGUCCI_MR`, `TERRAGUCCI_NOTE` and `TERRAGUCCI_HEAD` |
| `/terragucci lock`, `unlock`, with `--when pull-request` | the merge request is open | starts the same pipeline |
| `/terragucci lock`, `unlock` without it, `agent` | | replies that the verb does not run here |

[The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists the guarded paths, and [When a comment runs nothing](/terragucci/reference/pipeline/#ignored-comments) lists the checks every comment passes before a job uses a credential.

## review

```text
terragucci review prompt --report <dir> [--instructions <path>]
terragucci review post --dir <dir>
```

The `review` and `review-note` jobs of the generated review workflow run the two halves of the [review](/terragucci/guides/agent-review-a-pull-request/).

| Command | Does |
|---|---|
| `review prompt` | reads the pull request from the event file (on a `workflow_run` event, the one pull request of the run's head, with its title, description and base from the API); fetches the plan job's report from the pipeline's run of the head into `--report`, on a `pull_request_target` event waiting up to 30 minutes for the plan job; reads the diff of the base and head from git, and the plan note and policy results from the report; reads the instructions (`--instructions`, default `.terragucci/review.md`) from `origin/<default branch>` with `git show`, never from the checkout; writes the prompt to `/tmp/terragucci-review/prompt.md`, the pull request, head and base to `/tmp/terragucci-review/out/reviewed.json`, and unpacks the default branch's files into `/tmp/terragucci-review/work` |
| `review post` | reads the review and its command's exit code from `--dir` and posts them as one note on the pull request `TG_PR` names, with the head `TG_SHA` names; edits the note the pipeline posted before |

`review prompt` needs `TG_TOKEN`, a token that reads the repository's runs and artifacts. Exit 2 means the event names no pull request, a `workflow_run` event was not started by a `pull_request` run or names no one pull request of its head, or the checkout has no default branch ref. `review post` always exits 0 and says why when the forge refuses the note.

## pr-lock

```text
terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]
```

Reads the event file (a `pull_request_target` event, or a `/terragucci plan`, `lock` or `unlock` comment) and takes or releases the pull request's plan locks on `chant/lifecycle`. It posts `terragucci/lock` on the head and replies when another pull request holds a root. The generated `pr-lock` job runs it under [`locks: plan`](/terragucci/reference/config/#plan-locks). `--when pull-request` leaves `lock` and `unlock` to `comment-apply`; `--terragrunt` locks units.

## comment-apply

```text
terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo|gitlab]
    [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]
```

Reads a `/terragucci apply [wave-<n>]` comment, checks the commenter's permission as `comment` does, and writes a decision to `--out`: the merge commit and last wave to apply, or why nothing applies. The generated `apply-comment` job runs it before any credential. See [Apply a merged pull request](/terragucci/guides/re-plan-from-a-comment/#apply-a-merged-pull-request).

| `--when` | An open pull request |
|---|---|
| `merge` (the default) | does not apply |
| `pull-request` (written when `apply.when` is `pull-request`) | applies from its head once the checks in [Apply before merge](/terragucci/reference/pipeline/#apply-before-merge) pass; the command takes the root locks, `/terragucci lock` takes them without applying, and `/terragucci unlock` releases them |

`--requires` is a comma-separated list of `approved`, `mergeable`, `undiverged` and `checks`, or `none`; without it all four apply. `init` writes it from [`apply.requires`](/terragucci/reference/config/#apply-before-merge) when that leaves one out. `--terragrunt` (written in a Terragrunt repo under `apply.when: pull-request`) puts the locks on the units the pull request reaches, as [Locks](/terragucci/guides/apply-before-merge/#locks) describes. `--again` marks the second decision on Forgejo, which does not repeat a reply the first one posted.

The `mr-apply` job runs `--forge gitlab --when pull-request`, which reads no event file. `TERRAGUCCI_MR`, `TERRAGUCCI_NOTE` and `TERRAGUCCI_HEAD` name the merge request, note and head it reads from GitLab. Nothing runs unless the note is a Developer's `apply`, `lock` or `unlock` and the head is still the merge request's head.

## pr-merge

```text
terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo|gitlab]
```

Merges the pull request while its head is still `--sha` and releases its root locks. The generated `pr-merge` job runs it after the last wave applied before merge, with `apply.merge: auto`. The sha comes from a job that ran the pull request's code, so the command first checks with `TG_TOKEN` that:

- the pull request is open;
- its head is `--sha`;
- a reviewer other than the author approved that head.

It merges with `TG_MERGE_TOKEN` if set (named by `apply.merge_token_env`), else `TG_TOKEN`.

With `--forge gitlab` it first looks for the `mr-apply` reply, from `TG_TOKEN`'s user, that says every wave of `--sha` applied in this pipeline (`CI_PIPELINE_ID`). Without one it exits 0 and prints `nothing to merge`. The approval it checks is one given after the merge request's latest push.

## post

```text
terragucci post status <context> pending|success|failure <description>
terragucci post note <file>
terragucci post reply <text>
terragucci post stale <roots> <branch>
```

| Command | What it does |
|---|---|
| `status` | sets a commit status on `TG_SHA`, linked to the run; on GitLab a pending status shows as running |
| `note` | posts the file as the plan note on `TG_PR`, or edits the plan note already there |
| `reply` | adds a comment `terragucci: <text>` on `TG_PR` |
| `stale` | adds a line to the plan note of every open pull request into `<branch>` that covers one of `<roots>` (comma-separated), saying the plan is stale |

It posts with `TG_TOKEN`, on the forge `--forge` or `TG_FORGE` names (default `github`). The generated pipeline's jobs run it. With no token it posts nothing. A post the forge refuses is printed, and the command still exits 0.

## plan-note

```text
terragucci plan-note --forge github|forgejo --report <dir> --plan-result <result> [--root <root>] [--approval-status]
```

| Flag | Meaning |
|---|---|
| `--forge` | `github` (the default) or `forgejo` |
| `--report` | the plan job's report directory, read as data; default `terragucci-report` |
| `--plan-result` | the plan job's result (`success` or `failure`), which `terragucci/plan` follows |
| `--root` | the root a `/terragucci plan <root>` re-plan named |
| `--approval-status` | also post `terragucci/approval`, under `approval: pr-review` |

The generated `plan-note` and `replan-note` jobs run it, and it always exits 0.

## approval-status

```text
terragucci approval-status [--forge github|forgejo] [--report <dir>]
```

Sets `terragucci/approval` on the head `TG_SHA` and `TG_PR` name. The status stays pending while a wave the gate will hold has no approving review of that head. With `--report` it reads the waves from that plan report; without it, from the head's plan note. Under `approval: pr-review` the generated `approval` job runs it on each review; it always exits 0.

## notify

```text
terragucci notify waiting|refused|failed --wave <n> [--outcome <file>] [--outcome-json <file>] [--report <dir>]
```

Sends one wave's outcome to whichever of `TERRAGUCCI_SLACK_WEBHOOK`, `TERRAGUCCI_TEAMS_WEBHOOK` and `TERRAGUCCI_WEBHOOK` are set. The generic webhook gets a [`chant.notify/v1`](/terragucci/reference/notify-event/) event signed with `TERRAGUCCI_WEBHOOK_KEY` over `<timestamp>.<body>`, and nothing when the key is empty. With `notify` set, the generated apply jobs run it on any nonzero exit.

| Read from | For |
|---|---|
| `--outcome-json`, the stage's [outcome](/terragucci/reference/cli-json/#the-apply-outcome) (`TG_OUTCOME_JSON`) | the wave's roots, the digest and approve command of a waiting wave, the pull request to review under `approval: pr-review`, and the roots a refused or denied wave names |
| `--outcome`, the stage's `TG_OUTCOME` line | the outcome line the message quotes |
| `--report` (default `terragucci-report`) | the project, the report's link, and the wave's roots when there is no outcome |
| `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`, or `CI_JOB_URL` | the run's link |
| `TERRAGUCCI_RELAY` | the relay a waiting wave's Approve and Decline buttons (Slack) and reply (Teams) reach |

```text
terragucci notify drift [--report <dir>]
```

Posts to `TERRAGUCCI_SLACK_WEBHOOK` and `TERRAGUCCI_TEAMS_WEBHOOK` the drift job's findings in `--report` (default `terragucci-report`): the roots found drifted and the roots that could not be refreshed. Its Re-plan button opens the page where a person reruns the drift check with their own login (the workflow's Run workflow page on GitHub and Forgejo; the pipeline schedules on GitLab). With no drift and every root refreshed it posts nothing. The generic webhook gets no drift event. The generated drift job runs it when `notify` names `slack` or `teams`.

```text
terragucci notify unrecorded [--audit <dir>]
```

Posts to `TERRAGUCCI_SLACK_WEBHOOK` and `TERRAGUCCI_TEAMS_WEBHOOK` the [unrecorded writes](/terragucci/reference/audit-trail/#unrecorded-writes) the last `terragucci audit` run added: each project, root, version, time and writer. It reads the files that run wrote in `--audit` (default `terragucci-audit`, the audit's own `--out`), so run it after `terragucci audit` in the same job. A run that added none posts nothing. The generic webhook gets no event.

A webhook that answers a 5xx or does not answer within 10 seconds is tried twice more. One that still fails leaves a line in the log, and the command, which never prints a webhook's address, exits 0.

## relay

```text
terragucci relay [--port <n>]
```

Serves `POST /slack`, `POST /teams` and `GET /healthz`, with its settings from [the environment](/terragucci/reference/environment/#the-relay). On start it checks the token, and refuses one that can do more than approve. [Approve from Slack and Teams](/terragucci/guides/approve-from-chat/) sets it up.

| A request | The relay |
|---|---|
| whose signature does not verify, or a Slack one more than five minutes old | answers 401 and records nothing |
| from a chat user no line of the signers file on the default branch lists | answers in the thread that it refused, and records nothing |
| Approve, for the digest a wave waits for, under `approval: ledger` or `pr-review` | records the approval of that digest on `chant/lifecycle` as the person's principal, `relayedBy` the relay, and says so in the thread |
| Approve, for a digest no wave waits for | records nothing, and names the digest waiting |
| Approve, under `approval: sealed` | records nothing: only the approver's own key seals an approval |
| Decline | records nothing, and says in the thread who declined; the wave keeps waiting |

The relay runs until stopped, whatever error a request hits.

## query

```bash
terragucci query "<statement>" [--config <file>] [--json]
    [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
```

Loads the bucket's files into an in-memory SQLite database, runs the statement and prints the rows. It needs Node.js 22.13 or later. [Query the estate with SQL](/terragucci/guides/query-with-sql/) lists the tables.

| Flag | Meaning |
|---|---|
| `--config` | the config file; default the one in the working directory |
| `--bucket`, `--bucket-endpoint`, `--bucket-prefix` | the bucket to read, in place of `reports` in a repo's config |
| `--json` | the envelope, with `results.columns`, `results.rows` and `results.tables`, the row count of each table |

| | `query` |
|---|---|
| Reads | each project's `inventory.json`, `versions.json`, `changes.json` and `edges.json`, and `audit.jsonl` |
| Projects | as `estate`: a control repo's `projects:`, with `audit.jsonl` from `defaults.reports`; otherwise the ones the top `index.json` lists |
| Refuses | a statement that does not begin with `SELECT`, `WITH` or `VALUES`, and any write |

## mcp

```text
terragucci mcp [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>] [--propose]
```

Serves the Model Context Protocol on stdin and stdout until the client closes them, for an agent that reads the estate while it works. It reads the reports bucket that `reports` names (or `--bucket` in a single repo) with credentials from its own environment ([Reports](/terragucci/reference/environment/#reports) lists the variables). [Read the estate over MCP](/terragucci/guides/agent-read-over-mcp/) connects a client.

| Tool | Reads | Arguments |
|---|---|---|
| `estate` | `estate.json`, as `terragucci estate` last wrote it | none |
| `index` | the report index rows, newest first, each with its `report` path | `project`, `stage`, `limit` |
| `report` | a run's `report.json`, or one root of it | `path`, `root` |
| `last_apply` | a root's newest `tf-apply` wave: its commit, wave, gate, whether it applied, its changes and the state version it left | `root`, `project` |
| `run_view` | the run view of one applied commit | `commit`, `project` |
| `state_versions` | `states.json`, the state versions each root's applies left | `root`, `project` |
| `audit` | the audit trail, `audit.jsonl`, newest first, with `audit.json` | `project`, `kind`, `limit` |
| `dora` | `dora.json` | none |
| `waiting` | the waves waiting on `chant/lifecycle` in the repo it runs in, each with the `terragucci approve` command a person runs | none |

With `--propose` it serves three tools more, for an agent that gets a change planned without leaving its client ([Have an agent propose a change over MCP](/terragucci/guides/agent-propose-over-mcp/)). They use the forge token in the variable `token_env` names (by default `GITHUB_TOKEN`, `GITLAB_TOKEN` or `FORGEJO_TOKEN`) and git's own credentials, from the server's environment. A control repo has none of them.

| Tool | Does | Arguments |
|---|---|---|
| `propose` | pushes a local branch to `origin` without force and opens a pull request from it, or returns the one already open; refuses the default branch, `chant/lifecycle` and every `apply.branches` branch | `branch`, `title`, `body`, `base` |
| `request_plan` | comments `/terragucci plan [root]` on an open pull request | `pull_request`, `root` |
| `plan_result` | the pull request's head and plan note, and the `tf-plan` report of that head from the bucket: each root's status and policy verdict, the policy check, and whether each wave's gate will hold it; waits up to `wait` seconds (default 120, at most 600) for the head's plan | `pull_request`, `wait`, `project` |

Every other tool is marked read-only, and the server refuses these calls.

| A call | The answer |
|---|---|
| to a tool it does not list, such as `approve`, `apply`, `override` or `merge` | an error: the server never approves, applies, overrides or merges, approvals belong to a person at a shell, and an approval made over MCP is refused |
| with an argument the tool does not list | an error naming the argument; one named like a credential (`token`, `secret`, `key`) says credentials come from the server's environment |
| with a `path` outside the reports prefix | an error |

Without `--propose` the server writes nothing, and with it only the branch, the pull request and the comment above. Its bucket client refuses writes and signed links, and the server does not start with a tool whose name says it would write (approve, apply, override, lock, merge).

## guard

```text
terragucci guard [--config <file>] [--dir <dir>] [--no-hook]
```

Writes a local guard for a coding agent in this checkout, so that the agent's shell cannot apply a root the pipeline owns. It writes, under the checkout's git directory (`.git/terragucci/guard`, or `--dir`), so that nothing of it is committed:

| File | Does |
|---|---|
| `bin/tofu`, `bin/terraform`, `bin/terragrunt`, `bin/choudoufu` | wrappers to put ahead of the binaries on the agent's `PATH`; each runs the next binary of its name on `PATH` unless the guard refuses the command |
| `guard.mjs` | the rule, with the repo and its roots as they were when it was written |

It also adds a PreToolUse hook to `.claude/settings.local.json`, which Claude Code reads, keeping the rest of the file, and lists that file in `.git/info/exclude` unless git already ignores it. `--no-hook` leaves it alone. It prints the `export PATH=...` line for the agent's shell.

| In a root of the pipeline (a Terragrunt unit in a Terragrunt repo) | |
|---|---|
| refused | `apply`, `destroy`, `import`, `taint`, `untaint`, `force-unlock`, `state rm`, `state mv`, `state push`, `state replace-provider`, and any command with `-auto-approve`; `-chdir` and `--working-dir` name the directory |
| refused from a directory that holds a root | Terragrunt's `run --all`, `run-all` and `stack run` with any of the above |
| run | everything else, such as `init`, `validate`, `fmt`, `plan`, `show` and `state list` |

Outside the roots, the wrappers run every command. The hook applies the same rule to the agent's Bash commands, following `cd` and `sh -c`, and refuses `terragucci approve`, `override`, `stage tf-apply`, `unlock-state`, `pr-merge` and `--mode apply` anywhere in the repo. A refusal exits non-zero (3 from a wrapper, 2 from the hook) with a message that names `propose` on `terragucci mcp --propose`. Run it again after the roots change. The guard does not stop an agent that runs a binary another way; [the threat model](/terragucci/reference/threat-model/#trust) says what does.

## view

```text
terragucci view [--reports <dir|s3://<bucket>/<prefix>|https://...>] [--project <host/path>]
    [--port <n>] [--no-open] [--export <dir> [--publish]] [--config <file>]
```

Starts [behold](https://intentius.io/behold/using/terragucci/) with `npx`, at the version this terragucci pins, on the repo's checkout and its reports bucket. It waits until behold answers on `http://127.0.0.1:<port>`, opens the browser, and runs until Ctrl-C. Each root is drawn as a box of its resources, and a resource a run flagged carries a mark with that run's finish time.

```bash
npx --yes -p @intentius/behold@0.26.0 -p @intentius/chant-lexicon-terraform@^0.124.0 -p @cdktn/hcl2json@^0.24.0 \
  behold serve <repo> --terragucci <reports> --terragucci-project <project> --port 4600
```

| Flag | Meaning |
|---|---|
| `--reports` | where to read the reports, in place of `reports` in the config: a directory, `s3://<bucket>/<prefix>` or an https address |
| `--project` | the project's name in the index; default the one a run in this checkout writes, from the git remote |
| `--port` | the port behold serves on; default 4600 |
| `--no-open` | serve without opening the browser |
| `--export` | write a static view to the directory instead of serving, without each root's source text |
| `--publish` | with `--export`, also upload the view to `<prefix>/views/behold/<commit>/` in the reports bucket, where no run writes; `<prefix>/views/behold/index.html` opens the newest commit, and the 30 newest are kept |
| `--config` | the config file; default the one in the working directory or at the repo's root |

| Reports in | behold reads |
|---|---|
| S3 | `s3://<bucket>/<prefix>`, with your shell's AWS credentials; `reports.endpoint` is passed as `AWS_ENDPOINT_URL_S3` |
| GCS or Azure Blob | `reports.url` with the prefix; with no `reports.url`, the command stops and asks for `--reports <dir>` with a copy made by `gcloud storage rsync` or `azcopy` |

`--publish` writes to S3 only. A read-only identity needs `s3:GetObject` on the prefix; `--publish` also needs `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `<prefix>/views/behold/*`: it reads the list of published commits and removes the files of a commit past the newest 30.

When behold stops, the command prints one line and exits 1:

| Cause | The line says |
|---|---|
| no `npx` | `npx` is not on the path |
| the repo's [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) asks for a newer `minReader` than behold 0.26.0 reads | the repo asks for a newer reader than the pinned behold reads |
| the Terraform reader did not install | the package behold could not load |
| AWS refused or found no credentials | the source, and which error AWS gave |
| behold refused a report as malformed | behold's own error and what to fix |

The command writes nothing to the repo. behold refuses to deploy, approve or start a run on a terragucci repo, and a waiting wave shows the `terragucci approve` line to run in your shell.

## drift-agent

```text
terragucci drift-agent prompt --report <dir> --out <file> [--policy-dir <dir>]
terragucci drift-agent push --change <dir> [--forge github|forgejo] [--policy-dir <dir>]
```

Two generated jobs, `drift-agent` and `drift-agent-push`, run the halves of the [drift agent](/terragucci/guides/agent-fix-drift/).

| Command | Does |
|---|---|
| `drift-agent prompt` | reads `report.json` and `issue.json` from the drift job's report in `--report`, and writes the prompt to `--out`: each drifted resource with the state's value and the live one, never a sensitive one; exits 2 when the run opened no drift issue |
| `drift-agent push` | refuses the patch in `--change` when it touches a path an agent may not change, `--policy-dir` (default `policy`) among them; commits a passing patch on top of `TG_SHA` to `terragucci/drift-agent-<issue>`, pushes it without force with `TG_TOKEN`, opens the pull request and comments its link on the issue `TG_ISSUE` names |

## config check

```bash
terragucci config check [--config <file>]
```

Lists every problem. [The config keys](/terragucci/reference/config/) names the files it reads. A repo with [migration files](/terragucci/reference/migration-files/) is also a problem when its generated GitHub pipeline has an apply job that may not write `chant/lifecycle`; the message names the jobs and `terragucci init`, which writes the pipeline again.

```text
terragucci.yml: ok
approval: ledger (the default)
```

With [`oidc.roles`](/terragucci/reference/pipeline/#credentials) in a repo of plain roots, it reads each root's backend and `terraform_remote_state` blocks and prints a line per role and stage with the state that role reaches. Every glob in `oidc.roles` is an environment, and the unmatched roots form one more under `plan_role` and `apply_role`. `oidc.gcp.roles` and `oidc.azure.roles` get the same lines and warnings, marked `gcp` or `azure`, for the `gcs` or `azurerm` states their roots keep. Each warning goes to stderr.

| Warning | When |
|---|---|
| a role is the role of two environments | the same role ARN in two globs, or a glob and the pair; it reaches the state of each |
| a root reads the state of another environment's root | its `terraform_remote_state` names that root's state key, so its roles must reach that state |
| a root matches no glob and `oidc` names no pair | the root plans and applies with no AWS role |

Under `terragrunt.credentials` it warns when one role serves two unit globs.

In a repo of plain roots it warns for each `terraform_remote_state` block whose state [address](/terragucci/guides/track-cross-state-edges/#state-addresses) is not plain strings in the code, and, when any root reads state, for each root whose own backend's address is not. No edge orders those roots.

```text
terragucci.yml: 1 warning(s)
  state: app reads state through terraform_remote_state "net" where the code does not say (its pg conn_str is an expression, not a plain string), so it is not ordered after the root that writes it
```

Warnings leave the exit code 0.

```text
terragucci.yml: ok
approval: ledger (the default)
state access:
  arn:aws:iam::444455556666:role/dev-plan (plan, envs/dev/**): s3://acme-state/dev/app.tfstate
  arn:aws:iam::444455556666:role/dev-apply (apply, envs/dev/**): s3://acme-state/dev/app.tfstate
  arn:aws:iam::111122223333:role/prod-plan (plan, envs/prod/**): s3://acme-state/prod/app.tfstate; reads s3://acme-state/dev/app.tfstate
  arn:aws:iam::111122223333:role/prod-apply (apply, envs/prod/**): s3://acme-state/prod/app.tfstate; reads s3://acme-state/dev/app.tfstate
terragucci.yml: 1 warning(s)
  oidc: envs/prod/app (envs/prod/**) reads the state of envs/dev/app (envs/dev/**) through terraform_remote_state, so arn:aws:iam::111122223333:role/prod-plan and arn:aws:iam::111122223333:role/prod-apply reach s3://acme-state/dev/app.tfstate, another environment's state
```

## config identities

```bash
terragucci config identities [--config <file>] [--project <host/path>] [--forge github|gitlab|forgejo] [--repo <owner/name>] [--default-branch <branch>] [--owner-id <id>] [--repo-id <id>] [--no-roots]
```

Prints, for each environment in `environments` and for the roots in none, what each kind of job presents to a cloud: the plan job of a pull request, each wave's deciding job, the apply jobs on the default branch, and the drift job. Use it to write each role's trust, or read it with the [Terraform provider](/terragucci/guides/manage-the-control-repo-with-terraform/#read-the-environments-trust). `--json` prints [the contract](/terragucci/reference/cli-json/#config-identities).

| Flag | Meaning |
|---|---|
| `--project` | a control repo's project, by its key; its roots are elsewhere, so none are listed |
| `--forge` | the forge, when neither the config, the project key nor the origin remote names it |
| `--repo` | the repository the jobs run in, as `owner/name` or a GitLab project's full path; default: the project key's, or the origin remote's |
| `--default-branch` | the branch the apply and drift jobs run on; default `main` |
| `--owner-id`, `--repo-id` | Forgejo: the owner's and the repository's numeric ids, which Forgejo puts in the subject; without them the subject holds `<owner-id>` and `<repo-id>` |
| `--no-roots` | does not read the repo's roots, for a config read away from its repo |

```text
terragucci.yml: github github.com/acme/infra (default branch main)

environment prod: envs/prod/app, envs/prod/net
  plan: sub repo:acme/infra:pull_request
    runner ubuntu-latest
    aws arn:aws:iam::222222222222:role/prod-plan aud terragucci-plan
  decide: sub repo:acme/infra:ref:refs/heads/main
    runner group deployers self-hosted, linux
    aws arn:aws:iam::222222222222:role/prod-plan aud terragucci-plan
  apply: sub repo:acme/infra:environment:prod
    forge environment prod
    runner group deployers self-hosted, linux
    aws arn:aws:iam::222222222222:role/prod-apply aud terragucci-apply
```

## forge check

```bash
terragucci forge check [--config <file>] [--project <host/path>] [--forge github|gitlab|forgejo] [--repo <owner/name>] [--default-branch <branch>] [--owner-id <id>] [--repo-id <id>] [--no-roots] [--require-clouds]
```

Compares what [`config identities`](#config-identities) expects with the forge's and the clouds' live setup, and prints a row for each setting: what it expects, what it found, and whether they match. It reads the repository's default branch from the forge, and on Forgejo the owner's and repository's numeric ids, so the subjects it expects are the ones the jobs present. A person runs it, or a team adds it as a scheduled job of its own; no generated job runs it. `--json` prints [the rows](/terragucci/reference/cli-json/#forge-check).

The flags are those of `config identities`, and:

| Flag | Meaning |
|---|---|
| `--require-clouds` | a cloud the config configures but no credentials reach fails the check too |

| Where | Checks |
|---|---|
| GitHub | each forge environment of the apply jobs exists, and its deployment branch rule lets only the default branch deploy: protected branches, or custom policies that name the default branch alone; each runner group an apply runner names is limited to selected workflows |
| GitLab | each forge environment is protected; every runner of the project that carries an apply runner's tags runs on protected refs only (`ref_protected`); each variable the apply jobs read (`pass.secrets`, `pass.vars`, the `cost` key, the `notify` secrets) has a definition scoped to the environment and protected |
| Forgejo | the default branch and each [`apply.branches`](/terragucci/reference/config/#apply-from-other-branches) branch is protected |
| AWS | each role's trust admits each job the contract names, and no other: a `sub` or `aud` the contract does not name, a wildcard wider than its pattern, a statement with no `sub` or `aud` condition, another OIDC provider or account is a mismatch |
| GCP | the workload identity provider's `attribute_condition` is the contract's or narrower: each of its `\|\|` terms holds every `&&` part of a term of the contract's |
| Azure | each app's federated credentials are the contract's issuer, subject (or expression) and audiences; a credential the contract does not name is a mismatch |

Each row's status is one of these.

| Status | `MATCH` column | Means |
|---|---|---|
| `match` | `yes` | as expected |
| `mismatch` | `no` | different, missing or wider |
| `unknown` | `unknown` | could not be read: the row names the scope it needs, or that the edition has no such setting (GitLab protected environments are Premium) |
| `not-checked` | `not checked` | no credentials for that cloud |

Only a `mismatch` exits 1, and with `--require-clouds` a cloud row that is `not-checked`. A GitLab variable defined only at the group or instance is `unknown`, since the check reads the project's variables.

```text
terragucci.yml: github github.com/acme/infra (default branch main)

WHERE   CHECK                SUBJECT                                    EXPECTED                                                   FOUND                                                                                                         MATCH
github  environment          prod                                       exists                                                     exists                                                                                                        yes
github  deployment-branches  prod                                       deploys from main only                                     custom: main, release/*                                                                                       no
github  runner-group         deployers                                  limited to selected workflows                              could not read (403); the token needs Self-hosted runners: read on the organization (classic: admin:org)      unknown
aws     trust                arn:aws:iam::222222222222:role/prod-apply  sub repo:acme/infra:environment:prod aud terragucci-apply  not checked: no AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or a profile with static keys)  not checked

1 match, 1 mismatch, 1 could not be read, 1 not checked
```

### Read-only credentials

The command reads the forge with GET requests only, and sends AWS one action, `GetRole`, as a signed form POST, the way the AWS SDKs send it; it refuses any other request before sending it. Give it read-only credentials.

| Where | Read from | Needs |
|---|---|---|
| GitHub | the variable `token_env` names, or `GITHUB_TOKEN` | a fine-grained token with Metadata: read and Actions: read on the repository, and Self-hosted runners: read on the organization for runner groups; a classic token needs `repo`, and `admin:org` for runner groups |
| GitLab | the variable `token_env` names, or `GITLAB_TOKEN` | the `read_api` scope, held by a user or token with the Maintainer role, which protected environments, runners and variables need |
| Forgejo | the variable `token_env` names, or `FORGEJO_TOKEN` | the `read:repository` scope, held by a user with admin on the repository, which branch protections need |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, or static keys under `AWS_PROFILE` (or `default`) in the shared credentials file | `iam:GetRole` on each role; for SSO or a role profile, export its keys first with `aws configure export-credentials --format env` |
| GCP | `GOOGLE_OAUTH_ACCESS_TOKEN`, such as from `gcloud auth print-access-token` | `iam.workloadIdentityPoolProviders.get` on the provider |
| Azure | `AZURE_GRAPH_TOKEN`, such as from `az account get-access-token --resource-type ms-graph --query accessToken -o tsv` | `Application.Read.All` on Microsoft Graph |

## approve

```bash
terragucci approve [wave-<k> | <migration>] [--plan <digest>] [--actor <name>] [--sign [<key>]] [--dry-run] [--no-resume]
terragucci approve export <root> --plan <digest> [--sign]
terragucci approve unlock <root> --plan <digest> [--sign]
terragucci approve ephemeral <pr> --plan <digest> [--sign]
```

| Flag | Meaning |
|---|---|
| `wave-<k>` | the wave to approve; needed only when several wait and no `--plan` picks one |
| `<migration>` | a [state migration](/terragucci/reference/migration-files/) wave 1 waits on, by name: it approves the migration's digest and resumes wave 1; needed only when another gate waits too and no `--plan` picks one |
| `--plan` | the digest you read, from a chat message, a plan note or a report: approve only a wave waiting for exactly that digest. When none does, it approves nothing, prints the digest waiting and exits 1 |
| `--actor` | the name the approval records; under `approval: sealed`, your principal in the signers file |
| `--sign` | seal the approval with this key, or with git's `user.signingkey` when no key is given; the default under `approval: sealed` |
| `export <root>` | a [state export](#state-export) request for `<root>`; it counts only from someone other than the person who asked |
| `unlock <root>` | the release of the lock [`unlock-state`](#unlock-state) found on `<root>` |
| `ephemeral <pr>` | pull request `<pr>`'s [ephemeral environment](#ephemeral) |
| `--dry-run` | print what it would approve and record nothing |
| `--no-resume` | record the approval only; by default it then starts the wave again with your forge token ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)) |

Run it in a checkout whose `origin` you can push to.

```text
wave-2 waits for an approval of jcs1-sha256:2e7a63f3... (wave 2 of 2: app), since 2026-10-07T18:04:11.000Z
  roots: app
  destroys app: aws_s3_bucket.logs
```

With a digest that no longer waits, because the plans moved after you read them, `terragucci approve wave-2 --plan jcs1-sha256:9f2c...` prints:

```text
not approved: wave-2 waits for jcs1-sha256:9f2c...; waiting: wave-2 for jcs1-sha256:2e7a63f3.... The plans moved since that digest, or were approved and applied; read the waiting plans, then approve their digest
```

## migrate

```bash
terragucci migrate revert <migration>
```

Writes `migrations/<migration>-revert.yml`, the [revert](/terragucci/reference/migration-files/#revert) of a migration that applied, from its record on `chant/lifecycle` as `origin` holds it. Nothing else is written; the plan job proves the change that carries the file, which waits at wave 1 for its approval like any migration. Exit code 1 when the migration never applied, moved states to a new backend, or left a root with no version to put back.

## state export

```bash
terragucci state export <root> [--version <id>] [--out <file>] [--actor <name>]
```

| Flag | Meaning |
|---|---|
| `<root>` | the root whose state to export, with a backend that keeps versions (an `s3` bucket with versioning, a `gcs` bucket with object versioning, an `azurerm` account with blob versioning or a backend with `snapshot = true`), or on GitLab-managed state: a plain root, or a Terragrunt unit, which Terragrunt prepares through its `remote_state` block |
| `--version` | the version id, as the estate page's State versions section lists it (GitLab's serial on GitLab-managed state); the current version by default |
| `--out` | where to write the file, outside the repo; a new private directory under the system's temp directory by default |
| `--actor` | who asks; git's `user.name` by default |

Run it twice in a checkout whose `origin` you can push to, signed in to the cloud as yourself. [Export a state version](/terragucci/guides/export-a-state-version/) has the steps.

| Run | Does | Exits |
|---|---|---|
| first | reads the version's metadata, records a request on `chant/lifecycle` and prints `terragucci approve export <root> --plan <digest>` for someone else to run | 3 |
| second, once that approval stands | downloads the version, records the export in `_gates/tf-state-export/done.jsonl`, then writes the file, readable by you alone | 0 |

```text
state export: wrote /tmp/terragucci-export-Xb3k/envs_dev_app.3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY.tfstate: envs/dev/app's state, s3://acme-state/dev/app.tfstate version 3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY, approved by bob
```

An approval by the person who asked does not count. A request exports once; another export asks again. It never writes a state to the reports bucket or a job artifact.

## unlock-state

```bash
terragucci unlock-state <root> [--actor <name>] [--binary <b>] [--config <file>]
```

Releases the state lock a job killed mid-apply left on `<root>`: the lock file an `s3` backend with `use_lockfile = true` takes, a `gcs` backend's lock object, an `azurerm` backend's lease on the state blob, or the lock of GitLab-managed state. A comment never runs it. Run it at a shell with:

- the backend's credentials;
- the forge token in the variable `token_env` names (by default `FORGEJO_TOKEN`, `GITHUB_TOKEN` or `GITLAB_TOKEN`);
- push access to the checkout's `origin`.

| Step | Does |
|---|---|
| read the lock | inits the root and reads the lock file, the gcs lock object or the azurerm lease and metadata, or asks GitLab's lock endpoint: its ID, who took it and when |
| check no holder is alive | reads the forge's runs still running or waiting; while one that began before the lock was taken is alive, it may hold the lock, so nothing is released and it exits 1 naming the runs. A forge it cannot read is a refusal too |
| wait at the gate | records a pending fact for gate `<root>` of op `tf-unlock` on `chant/lifecycle`, bound to a digest of the root, the lock's location and its ID, prints `terragucci approve unlock <root> --plan <digest>` and exits 3. Under `approval: sealed`, only a sealed approval counts |
| release | approved, it checks the runs again, runs the binary's `force-unlock` of that ID (on GitLab, a `DELETE` of that ID on the lock endpoint), and appends who released which lock, and under whose approval, to `_gates/tf-unlock/done.jsonl`, which the [audit trail](/terragucci/reference/audit-trail/) reads |

| Flag | Meaning |
|---|---|
| `--actor` | the name the record gives the person who released it; default git's `user.name` |
| `--binary`, `--config` | as above |

```text
terragucci unlock-state: slow: s3://acme-state/slow.tfstate.tflock holds lock 1f0c..., OperationTypeApply by root@runner-7 at 2026-10-09T18:02:11.420Z
terragucci unlock-state: slow: no run that began before the lock is alive
terragucci unlock-state: slow: releasing lock 1f0c..., OperationTypeApply by root@runner-7 at 2026-10-09T18:02:11.420Z waits for an approval of digest jcs1-sha256:6d2b.... Approve it with:
terragucci unlock-state:   terragucci approve unlock slow --plan jcs1-sha256:6d2b...
```

An approval names one lock. If that lock was released some other way and a new one taken, the approval does not release the new one and the command exits 4.

## ephemeral

```bash
terragucci ephemeral up --pr <n> [--head <sha>] [--base <ref>] [--binary <b>] [--config <file>]
terragucci ephemeral down --pr <n> --reason closed|expired [--base <ref>] [--binary <b>] [--config <file>]
terragucci ephemeral sweep [--base <ref>] [--binary <b>] [--config <file>]
```

The generated pipeline runs it for [`ephemeral`](/terragucci/reference/config/#ephemeral-environments). It reads `ephemeral` from the checkout's terragucci.yml (the default branch, or `--base`) and checks out the pull request's code separately from the forge's pull request ref.

| Subcommand | What it does |
|---|---|
| `up` | inits each root the globs match at `--head` with `-backend-config` naming its key with `-pr-<n>` added, plans it, and decides gate `pr-<n>` of op `tf-ephemeral` on the set digest as `gate` says, printing `terragucci approve ephemeral <n> --plan <digest>` and exiting 3 while it waits; then applies, and appends the copy, its expiry and who approved it to `_gates/tf-ephemeral/done.jsonl` |
| `down` | plans the destroy of each root of the live copy and applies it, in reverse order, from the commit the copy applied, and appends the destroy with `--reason` and its digest; with no live copy it does nothing |
| `sweep` | destroys each live copy whose TTL passed (`expired`), and each whose pull request the forge says is closed or merged (`closed`), reading it with `TG_TOKEN` |

These are config errors (exit 2):

- a root on a backend other than `s3`, `azurerm`, `gcs` or `local`;
- a backend block that names no key;
- a Terragrunt repo;
- `synth`.

A destroy that fails leaves the copy live, and the next sweep tries again.

## resume

```text
terragucci resume [--forge github|forgejo|gitlab] [--out <file>]
```

The resume job runs it ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)). From `chant/lifecycle` it finds each waiting wave, and each state migration wave 1 waits on, whose digest has an approval no apply has used. An approved migration resumes wave 1, which runs it. It also finds a wave whose approved choudoufu apply was killed, once that run is gone ([Stopped applies](/terragucci/reference/pipeline/#stopped-applies)). It writes `TG_SHA` and `TG_PR` to `--out` for the job's waves to apply on GitHub and Forgejo, and retries the waiting apply job on GitLab. It exits 0 when there is nothing to resume.

## override

```bash
terragucci override <root> --rule <id> [--rule <id>] --reason <text> [--actor <name>] [--sign [<key>]] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `<root>` | the root the policy denied |
| `--rule` | a rule that denied it, such as `main.deny_public_bucket`; name every one, or give them comma-separated |
| `--reason` | required: why this plan goes out, kept on the ledger and shown in the report |
| `--actor` | the name the override records; it counts only when [`policy.override`](/terragucci/reference/policy/#overriding-a-denial) at base lists it |
| `--sign` | as for `approve`; the default under `approval: sealed` |
| `--dry-run` | print what it would override and record nothing |

```text
envs/prod/app: its plan jcs1-sha256:4c1e09d2... was denied by main.deny_public_bucket, since 2026-10-07T18:04:11.000Z
  the override binds the root, that plan and those rules: sha256:9b0f2a71...
```

## check-root, check-pins, check-policy and check-sources

```bash
terragucci check-root <dir> [--binary <b>] [--config <file>] [--base <ref>]
terragucci check-pins [--config <file>] [--base <ref>]
terragucci check-policy [--config <file>] [--base <ref>]
terragucci check-sources <dir>|--units [--config <file>] [--base <ref>]
```

| Command | Does |
|---|---|
| `check-root` | runs `validate -json` in an initialised root and prints each diagnostic with its file and range; with `--binary choudoufu`, also `choudoufu live-check -json`. Under `modules.require: attested` (read at `--base`) it first checks the root's module pins |
| `check-pins` | the same pin check on each Terragrunt unit's `terraform { source }`; prints nothing without `modules.require: attested` |
| `check-policy` | runs the policy's tests when `policy` is set |
| `check-sources` | checks a root's module sources and providers against [`sources`](/terragucci/guides/write-a-policy/#allow-only-listed-sources), read at `--base`, before its `init`; `--units` checks every Terragrunt unit instead; prints nothing without the key |

Each appends to `terragucci-check/report.md`, and the generated `tf-check` job runs them, `check-sources` only when `sources` is set. See [Stages](/terragucci/reference/stages/#check).

## check-job

```bash
terragucci check-job --forge github|gitlab|forgejo --environment <name> --branches <b>[,<b>...] [--forge-environment <name>] [--runner-tags <t>[,<t>...]] [--self-hosted]
```

The first line of each [environment's](/terragucci/reference/config/#environments) apply job, before any token is fetched or traded. `init` writes the expected values into the job: the forge environment, the branches the job applies from (the default branch from the forge, and those of `apply.branches`), GitLab's runner tags, and `--self-hosted` when the runner's labels include `self-hosted`. It prints what it checked, or one line per value that differs, naming the expected and the found value, and exits 1. What it reads on each forge: [The apply job's own check](/terragucci/reference/environment/#the-apply-jobs-own-check).

## install

```bash
terragucci install tofu|terraform|terragrunt|choudoufu|infracost|cosign|atmos|terramate <version>
```

Prints the directory it unpacked the release to, after checking it against its SHA256SUMS. The releases are Linux builds. Under `modules.attest` the publish job installs cosign this way before it publishes; in an Atmos repo every job installs Atmos this way.

## --json

`init`, `reconcile`, `plan`, `stage`, `rollout`, `respond`, `config check`, `config identities`, `forge check` and `query` take `--json`, which makes the command print only one envelope on stdout. [The CLI's JSON output](/terragucci/reference/cli-json/) lists the fields.

## Exit codes

The codes are the same with or without `--json`. Every command exits 2 on a usage or config error.

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | one or more projects or roots failed |
| 2 | a usage or config error |
| 3 | waiting on an approval, or on a rollout's pull request |
| 4 | a wave's plans changed after an approval or a policy override no run applied, so `stage tf-apply` applied nothing; or a share's plans changed after its wave decided, and the roots that moved were not applied |

| Command | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `init` | done | | an existing config file needs a line added | | |
| `reconcile` | done | a project failed | | | |
| `generate` | written, or with `--check` every generated file matches | with `--check`, a generated file out of line | a file it did not write is in the way, or a root's own files declare what it would write | | |
| `plan`, `stage tf-plan`, `stage tf-drift` | done | a root refused to plan | | | |
| `stage tf-apply` | wave applied, or with `--shares` decided for its shares | a root failed, or the policy denied one | `--json`, or a share with no decision file | waits for an approval | plans changed after an approval or a policy override no run applied, or after a share's wave decided |
| `publish` | done | | OCI tag exists already; git tag exists with different content | | |
| `rollout` | complete | stopped | | waiting | |
| `respond` | event handled, even when the response is `off` | | unknown event or missing flag | | |
| `comment`, `comment-apply` | decision written, or every note answered | forge error, unreadable event file | | | |
| `pr-lock` | locks taken, refused or released | the locks could not be read or pushed, unreadable event file | | | |
| `pr-merge` | merged | not merged | | | |
| `config check` | `ok`, with or without warnings | | problems found | | |
| `config identities` | printed | | no config, an unknown project, or no forge to name | | |
| `forge check` | no mismatch | a mismatch, or with `--require-clouds` a cloud not checked | no config, an unknown project, or no forge to name | | |
| `state export` | the version written and recorded | | a root, backend or version it does not export, a file inside the repo, or nobody named | waits for an approval by someone else | |
| `check-root`, `check-pins`, `check-policy`, `check-sources` | passed | failed | | | |
| `check-job` | the job runs where its environment's apply is set to run | a forge environment, ref or runner differs | a flag missing | | |
| `install` | done | | not a Linux host | | |
| `estate` | page written | a project's index could not be read | | | |
| `audit` | record written, or with `--check` nothing missing | a ledger or index could not be read; with `--check`, an entry the record lacks | | | |
| `verify-release` | every target verified | a target refused | | | |
| `ephemeral` | applied, destroyed, or nothing to do | a root failed to plan, apply or destroy | no `ephemeral` roots, a backend no key suffix fits, a Terragrunt unit whose `remote_state` key does not read `TERRAGUCCI_EPHEMERAL_SUFFIX` | the copy waits for an approval | an approval stands for other plans of the copy |
| `unlock-state` | released, or no lock held | a run that may hold the lock is alive | no forge token, a forge it cannot read, a backend with no lock file | waits for an approval of the lock | an approval stands for another lock |
| `approve`, `override` | approved | `approve --plan` names a digest no wave waits for | no wave waiting, several waiting and none named, no recorded denial, or the rules differ | | |
| `resume`, `notify`, `plan-note`, `approval-status` | always, once the flags parse | | a bad flag | | |
| `relay` | never: it serves until stopped | | a missing setting, a token that can do more than approve, or a repo it cannot read | | |
| `query` | rows printed | | a bad flag or config, a statement that does not run or writes | | |
| `mcp` | the client closed stdin | | a bad flag or config | | |
| `guard` | the guard written | | a bad flag or config, a control repo, no git checkout, or a Claude Code settings file that is not JSON | | |
| `view` | stopped with Ctrl-C, or the view exported | behold stopped or refused the reports | a bad flag or config, or a source behold cannot read | | |
| `drift-agent` | prompt written; pull request opened, or the change refused with a comment on the issue | git or the forge failed | a bad flag, or a run that opened no drift issue | | |

Code 4 comes from `stage tf-apply`, `unlock-state` and `ephemeral`, which have no `--json`.
