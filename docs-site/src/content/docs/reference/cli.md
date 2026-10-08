---
title: CLI commands
description: Every terragucci command, its flags and its exit codes.
prompt: |
  Read https://intentius.io/terragucci/reference/cli/.
  Run `npx terragucci config check` and `npx terragucci init --dry-run --json` in this repo and tell me the roots, binary and forge it found, and any config problem, with the exit code of each.
  Read only. Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

`npx terragucci <command>` runs from the root of a repo. A generated pipeline calls the same commands.

| Command | What it does |
|---|---|
| `init` | finds roots, binary and forge, and writes the pipeline; under `approval: sealed`, also [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) |
| `reconcile` | from a control repo, opens a pull request in each project that needs a change |
| `estate` | writes one page for every project, `estate.html` and `estate.json`, to the reports bucket, and prints a link to it: presigned on S3, a signed URL on GCS, a SAS on Azure Blob |
| `audit` | appends every approval, apply, policy override and refused wave across the projects to the [audit trail](/terragucci/reference/audit-trail/), `audit.jsonl` in the reports bucket, with its page and a link to it; `--check` reports what the record lacks |
| `plan` | plans every root and prints the result |
| `stage tf-plan` | plans the roots a change reaches, groups them, and writes the report |
| `publish` | publishes each changed module at a new version |
| `rollout` | moves a module's or provider's pin one wave at a time |
| `respond` | runs the response to a pipeline event |
| `comment` | reads a `/terragucci plan [root]` or `/terragucci agent <ask>` pull request comment, polls GitLab merge request notes, and pushes an agent's change; the generated pipeline runs it |
| `comment-apply` | reads a `/terragucci apply [wave-<n>]`, `/terragucci lock` or `/terragucci unlock` comment; the generated pipeline runs it |
| `pr-lock` | takes or releases a pull request's plan locks under `locks: plan`; the generated pipeline runs it |
| `approve` | approves a waiting wave: finds it on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle), prints what it does and runs `chant approve tf-apply wave-<k> --plan <digest>`, with `--sign` under `approval: sealed`; a person runs it |
| `override` | overrides a policy denial of one root's plan: finds the denial a `tf-apply` wave recorded, checks the rules named are the ones that denied it, and runs `chant approve policy-override <root> --plan <digest> --note <reason>`; a person `policy.override` lists runs it |
| `approval-status` | with `approval: pr-review`, posts `terragucci/approval` on a pull request's head: pending while a wave the gate will hold has no approving review of that head; the generated pipeline runs it |
| `notify` | posts a wave that waits, is refused or fails to the Slack, Teams and generic webhooks `notify` names; the generated apply jobs run it |
| `pr-merge` | merges a pull request every wave of which applied before merge, with `apply.merge: auto`; the generated pipeline runs it |
| `config check` | validates the config file and lists every problem, then prints the approval mode in force and where it comes from |
| `check-root`, `check-policy` | the steps of `tf-check` beyond the format check; the generated pipeline runs them |
| `auth-provider` | internal: Terragrunt's `auth-provider-cmd`, which the generated Terragrunt pipeline runs |
| `install` | fetches a release of OpenTofu, Terraform, Terragrunt, [choudoufu](/terragucci/concepts/glossary/#choudoufu) or Infracost, verified against its checksums |

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
| `--force` | overwrite a pipeline file terragucci did not write; on GitLab that is `.gitlab/terragucci.yml`, never your `.gitlab-ci.yml` |

A flag detection would not reach goes into a new `terragucci.yml`. An existing config file is never edited: `init` exits 2 and names the line to add, such as `binary: terraform`. A key already set there wins.

What `init` writes besides the pipeline depends on the approval mode. `--approval ledger|pr-review|sealed` picks the mode and saves it to `terragucci.yml` when detection would not reach it.

| Mode | `init` also |
|---|---|
| `ledger` (the default) | writes no `chant.workspace.json`; with `approval: ledger` set, drops the wave gates an earlier `init` listed under [`identity.gates`](/terragucci/concepts/glossary/#identitygates) |
| `pr-review` | the same as `ledger`; on GitHub and Forgejo adds the `approval` job and the `terragucci/approval` status ([the pipeline](/terragucci/reference/pipeline/#statuses-and-stale-plans)) |
| `sealed` | writes chant's `chant.workspace.json` with each wave's gate (`wave-1`, `wave-2`) under `identity.gates`, so a wave counts only an approval sealed with [`chant approve --sign`](/terragucci/concepts/glossary/#chant); an existing file gains missing gates |

[Approve a waiting wave](/terragucci/guides/approve-a-wave/) sets up the signers file.

## reconcile

```bash
terragucci reconcile [--config <file>] [--mode dry-run|apply] [--project <host/path>]
```

`--config` defaults to the config file in the working directory and `--mode` to `dry-run`. `--mode apply` opens a pull request per changed project and never runs `terraform apply` ([glossary](/terragucci/concepts/glossary/#words-that-mean-something-else-in-terraform)). `--project` limits the run to one project.

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

It reads each project's `index.json`, then writes `estate.html` and `estate.json` at the top of the prefix. In a control repo the projects are its `projects:`, each read from its own `reports`, and the page goes to `defaults.reports`. In a repo of its own the projects are the ones the top `index.json` lists. When `audit.json` is beside the page, the page links the audit trail. Exit code 1 when a project's index could not be read; the page names it.

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

It reads each project's `chant/lifecycle` history and its `tf-apply` wave reports, appends the entries `audit.jsonl` lacks, and writes `audit.html` and `audit.json` beside it at the top of the prefix. In a control repo the projects are its `projects:`, each ledger fetched from the project's repo and each project's reports read from its own `reports`; the record goes to `defaults.reports`. In a repo of its own the project is the checkout's, its ledger read from `origin`. Exit code 1 when a project's ledger or index could not be read. [The audit trail](/terragucci/reference/audit-trail/) describes every entry.

## plan and stage

```bash
terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>]
    [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--canary <globs>] [--bucket <url>]
    [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>] [--no-cost]
terragucci stage tf-drift [the same flags as tf-plan]
terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>]
    [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>]
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

`stage tf-plan` and `stage tf-drift` still write the report when a root refuses to plan. [The plan report](/terragucci/reference/report/) lists the files.

`stage tf-apply` applies one wave, as the generated `apply-wave-<n>` job does. It refuses `--json` with exit 2. With `TG_OUTCOME_JSON` set it writes how the wave ended to that file as [JSON](/terragucci/reference/cli-json/#the-apply-outcome).

| Flag | Environment | Meaning |
|---|---|---|
| `--wave` | | the wave to apply |
| `--gate` | | `always`, `on-destroy` (the default) or `never` |
| `--approval` | | the mode when the config at base names none and `chant.workspace.json` there lists no gate; a control repo's pipeline passes it |
| `--base` | `TG_BASE`, for the policy ref only | the ref that holds the wave's policy, approval mode, gate rule, signers file and other config; an open pull request's job passes `origin/<default branch>`. Without it the gate rule comes from the commit before the one applied |

## publish

```bash
terragucci publish [--dry-run] [--config <file>]
```

`--dry-run` lists what would be published and pushes nothing. A git tag that exists with the same content is unchanged and exits 0.

## rollout

```bash
terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
```

`--mode` defaults to `dry-run`, and neither mode runs `terraform apply`. See [Rolling out a module version](/terragucci/reference/stages/#rolling-out-a-module-version).

## respond

```bash
terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|version-bump|description [--mode dry-run|apply] [flags]
```

| Flag | Used by | Meaning |
|---|---|---|
| `--mode` | all | `dry-run` (the default) or `apply`, which opens the pull request or pushes the commit and never runs `terraform apply` |
| `--report` | `plan`, `description` | the report directory |
| `--approved`, `--current`, `--wave` | `wave-refused` | the approved report, the current report directory and the wave number |
| `--log` | `apply-failed` | the apply log; `-` reads standard input |
| `--root`, `--import` | `drift` | one root, and `<address>=<id>` for a resource the state does not hold |
| `--platform` | `tips` | lock file platforms, comma separated |
| `--branch` | `fmt` | the branch to format; the default branch is refused |
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
terragucci comment --forge gitlab --poll --layers <a,b;c> [--when merge|pull-request] [--requires <list>|none]
```

Reads the pull request comment in the event file (`GITHUB_EVENT_PATH`) and writes a decision to `--out`: plan, or stop with a reason. A refused command is answered on the pull request. `--forge github` (the default) asks the API for the commenter's permission and `--forge forgejo` reads it from the event. The generated `replan` job runs it before any credential; see [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/). `/terragucci apply` is read by `comment-apply`.

`--agent` picks the mode:

| `--agent` | Run by job | Does |
|---|---|---|
| `off` (the default) | `replan` | replies with how to turn the agent comment on |
| `on` | `replan` | leaves agent comments to the agent jobs |
| `run` | `agent` | decides on a `/terragucci agent <ask>` comment with the same checks and writes the prompt to `--prompt`; a fork or default-branch pull request gets no agent |
| `push` | `agent-push` | refuses the patch in `--change` when it touches a path an agent may not change, `--policy-dir` (default `policy`) among them, and commits a passing patch to the pull request's head branch with the `TG_*` variables in [Environment variables](/terragucci/reference/environment/) |

On GitLab, `--forge gitlab --poll` reads no event file. The generated `comments` job runs it on the comments schedule ([`comments`](/terragucci/reference/config/#keys)). It reads the notes of the merge requests updated in the last day and answers each `/terragucci` note once: each reply carries a `<!-- terragucci:note=<id> -->` marker, and a note with one is never answered again. The poll exits 1 when GitLab answers with an error.

| Note | Checked | Does |
|---|---|---|
| any | the author is a Developer or above; anyone else gets no reply | |
| `/terragucci plan [root]` | the merge request is open and from this project; a named root is a root of the pipeline | starts a merge request pipeline, which plans the whole merge request |
| `/terragucci apply` | the merge request merged into the default branch from this project; no later commit there has an apply of its own; no `wave-<n>` | retries the merge commit's first apply job that did not succeed; its gate decides again |
| `/terragucci apply [wave-<n>]`, with `--when pull-request` | the merge request is open, from this project, into the default branch; `--requires` (all four by default), `terragucci/plan` and the pipeline files, as `comment-apply` checks them | starts a pipeline on the default branch with `TG_MERGE_TOKEN` and the variables `TERRAGUCCI_MR`, `TERRAGUCCI_NOTE` and `TERRAGUCCI_HEAD` |
| `/terragucci lock`, `unlock`, with `--when pull-request` | the merge request is open | starts the same pipeline |
| `/terragucci lock`, `unlock` without it, `agent` | | replies that the verb does not run here |

[The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists the guarded paths, and [When a comment runs nothing](/terragucci/reference/pipeline/#when-a-comment-runs-nothing) lists the checks every comment passes before a job uses a credential.

## pr-lock

```text
terragucci pr-lock --layers <a,b;c> [--forge github|forgejo] [--when merge|pull-request] [--terragrunt]
```

Reads a `pull_request_target` event, or a `/terragucci plan`, `/terragucci lock` or `/terragucci unlock` comment, from the event file, and takes or releases the pull request's plan locks on `chant/lifecycle`. It posts `terragucci/lock` on the head and replies when another pull request holds a root. The generated `pr-lock` job runs it under [`locks: plan`](/terragucci/reference/config/#plan-locks). `--when pull-request` leaves `lock` and `unlock` to `comment-apply`; `--terragrunt` locks units.

## comment-apply

```text
terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo|gitlab]
    [--when merge|pull-request] [--requires <list>|none] [--terragrunt] [--again]
```

Reads a `/terragucci apply [wave-<n>]` comment, checks the commenter's permission as `comment` does, and writes a decision to `--out`: the merge commit and last wave to apply, or why nothing applies. The generated `apply-comment` job runs it before any credential, and on Forgejo again once it holds the apply lock. See [Apply a merged pull request](/terragucci/guides/re-plan-from-a-comment/#apply-a-merged-pull-request).

| `--when` | An open pull request |
|---|---|
| `merge` (the default) | does not apply |
| `pull-request` (written when `apply.when` is `pull-request`) | applies from its head once the checks in [Apply before merge](/terragucci/reference/pipeline/#apply-before-merge) pass; the command takes the root locks, `/terragucci lock` takes them without applying, and `/terragucci unlock` releases them |

`--requires` is a comma-separated list of `approved`, `mergeable`, `undiverged` and `checks`, or `none`; without it all four apply. `init` writes it from [`apply.requires`](/terragucci/reference/config/#apply-before-merge) when that leaves one out. `--terragrunt` (written in a Terragrunt repo under `apply.when: pull-request`) puts the locks on the units the pull request reaches, as [Locks](/terragucci/guides/apply-before-merge/#locks) describes. `--again` marks the second decision on Forgejo, which does not repeat a reply the first one posted.

`--forge gitlab --when pull-request` is the `mr-apply` job's. It reads no event file: `TERRAGUCCI_MR`, `TERRAGUCCI_NOTE` and `TERRAGUCCI_HEAD` point at the merge request, the note and the head, and it reads each from GitLab. The note must be a Developer's `apply`, `lock` or `unlock`, and the head must be the merge request's head now, else nothing runs.

## pr-merge

```text
terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo|gitlab]
```

Merges the pull request while its head is still `--sha`, then releases its root locks. The generated `pr-merge` job runs it after the last wave applied before merge, with `apply.merge: auto`. The sha comes from a job that ran the pull request's code, so the command first checks with `TG_TOKEN` that:

- the pull request is open;
- its head is `--sha`;
- a reviewer other than the author approved that head.

It merges with `TG_MERGE_TOKEN` if set (named by `apply.merge_token_env`), else `TG_TOKEN`.

With `--forge gitlab` it first looks for the `mr-apply` reply, from `TG_TOKEN`'s user, that says every wave of `--sha` applied in this pipeline (`CI_PIPELINE_ID`). Without one it prints `nothing to merge` and exits 0. The approval it checks is one given after the merge request's latest push.

## notify

```text
terragucci notify waiting|refused|failed --wave <n> [--outcome <file>] [--outcome-json <file>] [--report <dir>]
```

Posts one wave's outcome to `TERRAGUCCI_SLACK_WEBHOOK`, `TERRAGUCCI_TEAMS_WEBHOOK` and `TERRAGUCCI_WEBHOOK`, whichever are set. The generic webhook gets a [`terragucci.notify/v1`](/terragucci/reference/notify-event/) event signed with `TERRAGUCCI_WEBHOOK_KEY`, and nothing when the key is empty. The generated apply jobs run it with `notify` set, on exit 3, 4 and any other failure.

| Read from | For |
|---|---|
| `--outcome-json`, the stage's [outcome](/terragucci/reference/cli-json/#the-apply-outcome) (`TG_OUTCOME_JSON`) | the wave's roots, the digest and approve command of a waiting wave, the pull request to review under `approval: pr-review`, and the roots a refused or denied wave names |
| `--outcome`, the stage's `TG_OUTCOME` line | the outcome line the message quotes |
| `--report` (default `terragucci-report`) | the project, the report's link, and the wave's roots when there is no outcome |
| `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`, or `CI_JOB_URL` | the run's link |

A webhook that fails or does not answer within 10 seconds leaves a line in the log, and the command exits 0. It never prints a webhook's address.

## config check

```bash
terragucci config check [--config <file>]
```

Lists every problem. [The config keys](/terragucci/reference/config/) names the files it reads.

```text
terragucci.yml: ok
approval: ledger (the default)
```

## approve

```bash
terragucci approve [wave-<k>] [--plan <digest>] [--actor <name>] [--sign [<key>]] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `wave-<k>` | the wave to approve; needed only when several wait and no `--plan` picks one |
| `--plan` | the digest you read, from a chat message, a plan note or a report: approve only a wave waiting for exactly that digest. When none does, it approves nothing, prints the digest waiting and exits 1 |
| `--actor` | the name the approval records; under `approval: sealed`, your principal in the signers file |
| `--sign` | seal the approval with this key, or with git's `user.signingkey` when no key is given; the default under `approval: sealed` |
| `--dry-run` | print the `chant approve` command and run nothing |

Run it in a checkout whose `origin` you can push to. It finds chant in `node_modules/.bin`, then on the path.

```text
wave-2 waits for an approval of jcs1-sha256:2e7a63f3... (wave 2 of 2: app), since 2026-10-07T18:04:11.000Z
  roots: app
  destroys app: aws_s3_bucket.logs
running: chant approve tf-apply wave-2 --plan jcs1-sha256:2e7a63f3... --actor github:alice
```

With a digest that no longer waits, because the plans moved after you read them:

```text
not approved: wave-2 waits for jcs1-sha256:9f2c...; waiting: wave-2 for jcs1-sha256:2e7a63f3.... The plans moved since that digest, or were approved and applied; read the waiting plans, then approve their digest
```

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
| `--dry-run` | print the `chant approve` command and run nothing |

```text
envs/prod/app: its plan jcs1-sha256:4c1e09d2... was denied by main.deny_public_bucket, since 2026-10-07T18:04:11.000Z
  the override binds the root, that plan and those rules: sha256:9b0f2a71...
running: chant approve policy-override envs/prod/app --plan sha256:9b0f2a71... --note 'the incident needs the bucket public until 18:00' --actor github:alice
```

## check-root and check-policy

```bash
terragucci check-root <dir> [--binary <b>]
terragucci check-policy [--config <file>] [--base <ref>]
```

`check-root` runs `validate -json` in an initialised root and prints each diagnostic with its file and range; with `--binary choudoufu` it also runs `choudoufu live-check -json`. `check-policy` runs the policy's tests when `policy` is set. Both append to `terragucci-check/report.md`, and run in the generated `tf-check` job. See [Stages](/terragucci/reference/stages/#check).

## install

```bash
terragucci install tofu|terraform|terragrunt|choudoufu|infracost <version>
```

Fetches the release, checks it against its SHA256SUMS and prints the directory it unpacked to. The releases are Linux builds.

## --json

`init`, `reconcile`, `plan`, `stage`, `rollout`, `respond` and `config check` take `--json`. The command then prints one envelope on stdout and nothing else. [The CLI's JSON output](/terragucci/reference/cli-json/) lists the fields.

## Exit codes

The codes are the same with or without `--json`. Every command exits 2 on a usage or config error.

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | one or more projects or roots failed |
| 2 | a usage or config error |
| 3 | waiting on an approval, or on a rollout's pull request |
| 4 | a wave's plans changed after an approval no run applied, or after its policy override, so `stage tf-apply` applied nothing |

| Command | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `init` | done | | an existing config file needs a line added | | |
| `reconcile` | done | a project failed | | | |
| `plan`, `stage tf-plan`, `stage tf-drift` | done | a root refused to plan | | | |
| `stage tf-apply` | wave applied | a root failed, or the policy denied one | `--json` | waits for an approval | plans changed after an approval no run applied, or after a policy override |
| `publish` | done | | OCI tag exists already; git tag exists with different content | | |
| `rollout` | complete | stopped | | waiting | |
| `respond` | event handled, even when the response is `off` | | unknown event or missing flag | | |
| `comment`, `comment-apply` | decision written, or every note answered | forge error, unreadable event file | | | |
| `pr-lock` | locks taken, refused or released | the locks could not be read or pushed, unreadable event file | | | |
| `pr-merge` | merged | not merged | | | |
| `config check` | `ok` | | problems found | | |
| `check-root`, `check-policy` | passed | failed | | | |
| `install` | done | | not a Linux host | | |

Code 4 comes only from `stage tf-apply`, which has no `--json`.
