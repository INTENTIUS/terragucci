---
title: CLI commands
description: Every terragucci command, its flags and its exit codes.
prompt: |
  Read https://intentius.io/terragucci/reference/cli/.
  Run `npx terragucci config check` and `npx terragucci init --dry-run --json` in this repo and tell me the roots, binary and forge it found, and any config problem, with the exit code of each.
  Read only. Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

Run `npx terragucci <command>` from a repo's root; a generated pipeline calls the same commands.

| Command | Does |
|---|---|
| `init` | finds roots, binary and forge, and writes the pipeline; under `approval: sealed`, also [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) |
| `import` | writes `terragucci.yml` from an `atlantis.yaml` or a `digger.yml`, and prints what became of each setting |
| `reconcile` | from a [control repo](/terragucci/concepts/control-repo/), opens a pull request in each project that needs a change |
| `generate` | writes each root's backend, provider and version files from the [`generate` key](/terragucci/guides/generate-root-files/), and in a Terragrunt repo `terragucci.hcl`, which each unit includes; `--check` refuses one that differs, and the generated `tf-check` job runs it |
| `estate` | writes one page for every project, `estate.html`, `estate.json` and `dora.json`, to the reports bucket, and prints a link to it: presigned on S3, a signed URL on GCS, a SAS on Azure Blob |
| `audit` | appends every approval, apply, policy override and refused wave across the projects to the [audit trail](/terragucci/reference/audit-trail/), `audit.jsonl` in the reports bucket, with its page and a link to it; `--check` reports what the record lacks |
| `plan` | plans every root and prints the result |
| `stage tf-plan` | plans the roots a change reaches, groups them, and writes the report |
| `publish` | publishes each changed module at a new version |
| `verify-release` | checks one published version of a module: its signature, provenance and SBOM, and its record in the release ledger |
| `rollout` | moves a module's or provider's pin one wave at a time |
| `respond` | runs the response to a pipeline event |
| `comment` | reads a `/terragucci plan [root]` or `/terragucci agent <ask>` pull request comment, polls GitLab merge request notes, and pushes an agent's change; the generated pipeline runs it |
| `comment-apply` | reads a `/terragucci apply [wave-<n>]`, `/terragucci lock` or `/terragucci unlock` comment; the generated pipeline runs it |
| `pr-lock` | takes or releases a pull request's plan locks under `locks: plan`; the generated pipeline runs it |
| `approve` | approves a waiting wave: finds it on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle), prints what it does and runs `chant approve tf-apply wave-<k> --plan <digest>`, with `--sign` under `approval: sealed`; a person runs it |
| `override` | overrides a policy denial of one root's plan: finds the denial a `tf-apply` wave recorded, checks the rules named are the ones that denied it, and runs `chant approve policy-override <root> --plan <digest> --note <reason>`; a person `policy.override` lists runs it |
| `approval-status` | with `approval: pr-review`, posts `terragucci/approval` on a pull request's head: pending while a wave the gate will hold has no approving review of that head; the generated pipeline runs it |
| `plan-note` | on GitHub and Forgejo, posts the plan job's note and `terragucci/plan` from its report, read as data; the generated `plan-note` and `replan-note` jobs run it |
| `notify` | posts a wave that waits, is refused or fails to the Slack, Teams and generic webhooks `notify` names, and drift to Slack and Teams; the generated apply and drift jobs run it |
| `relay` | serves the Approve and Decline buttons of Slack and Teams messages, in your own cloud |
| `mcp` | a read-only MCP server on stdio over what terragucci wrote to the reports bucket and the repo, for a coding agent |
| `drift-agent` | writes the drift agent's prompt and opens a pull request with its change, with [`agent.drift`](/terragucci/guides/agent-fix-drift/); the generated pipeline runs it |
| `pr-merge` | merges a pull request every wave of which applied before merge, with `apply.merge: auto`; the generated pipeline runs it |
| `config check` | validates the config file and lists every problem, then prints the approval mode in force and where it comes from; with `oidc.roles`, the state each role reaches, and a warning for each role that reaches another environment's state |
| `state export` | asks for one version of a root's state and, once someone else approved the request, downloads it to your machine and records who exported what on `chant/lifecycle`; a person runs it |
| `check-root`, `check-pins`, `check-policy` | the steps of `tf-check` beyond the format check; the generated pipeline runs them |
| `resume` | applies a waiting wave once its approval stands; the generated resume job runs it |
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
| `--force` | overwrite a pipeline file terragucci did not write; on GitLab that is `.gitlab/terragucci.yml`, never your `.gitlab-ci.yml` |

A flag detection would not reach goes into a new `terragucci.yml`. An existing config file is never edited: `init` exits 2 and names the line to add, such as `binary: terraform`. A key already set there wins.

The approval mode decides what else `init` writes.

| Mode | `init` also |
|---|---|
| `ledger` (the default) | writes no `chant.workspace.json`; with `approval: ledger` set, drops the wave gates an earlier `init` listed under [`identity.gates`](/terragucci/concepts/glossary/#identitygates) |
| `pr-review` | the same as `ledger`; on GitHub and Forgejo adds the `approval` job and the `terragucci/approval` status ([the pipeline](/terragucci/reference/pipeline/#statuses-and-stale-plans)) |
| `sealed` | writes chant's `chant.workspace.json` with each wave's gate (`wave-1`, `wave-2`) under `identity.gates`, so a wave counts only an approval sealed with [`chant approve --sign`](/terragucci/concepts/glossary/#chant); an existing file gains missing gates |

[Approve a waiting wave](/terragucci/guides/approve-a-wave/) sets up the signers file.

## import

```bash
terragucci import atlantis [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import digger [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
terragucci import terrateam [<file>] [--forge github|gitlab|forgejo] [--apply-when merge|pull-request] [--force] [--dry-run]
```

Reads the file named, else `atlantis.yaml` (or `atlantis.yml`), OpenTaco's `digger.yml` (or `digger.yaml`) or Terrateam's `.terrateam/config.yml`, and writes `terragucci.yml` by the tables of [Coming from Atlantis, OpenTaco or Terrateam](/terragucci/guides/coming-from-atlantis-or-opentaco/). Each setting the file carries is printed under one of four headings, quoting the guide's row:

| Heading | The setting |
|---|---|
| Written to terragucci.yml | became a key, such as a project's `dir` in `roots` |
| Done by terragucci with no key | needs no key, such as `autoplan.when_modified` |
| Not mapped | has no key here, with the guide's reason; so does a setting the guide has no row for |
| Left out on purpose | is something terragucci never does, such as an `import` workflow, with the guide's rule and what to do instead |

| Flag | Meaning |
|---|---|
| `--apply-when` | `pull-request` (the default, as Atlantis, OpenTaco and Terrateam apply before merge) or `merge`; a `digger.yml` whose `on_commit_to_default` runs `digger apply`, or a Terrateam config with `autoapply` or `apply_after_merge`, already means `merge` |
| `--forge` | the forge, when the remote cannot tell; on GitLab the import keeps `apply.when: merge` and writes no `locks: plan`, and on Forgejo no `apply.merge: auto`, since those need a schedule or a token it cannot name |
| `--dry-run` | print what would be written, and write nothing |
| `--force` | replace an existing `terragucci.yml` |

It exits 2 when the file is missing or not YAML, or when `terragucci.yml` exists and `--force` is not given. A project `dir` that matches no directory with Terraform files is written and named.

`import terrateam` writes no `roots`, since terragucci detects the directories Terrateam plans, and names each `dirs` key that matches no root. It reads `depends_on` against the roots' `terraform_remote_state` reads and writes `waves.canary` for an order the reads do not give ([Terrateam](/terragucci/guides/coming-from-atlantis-or-opentaco/#terrateam)). A `run` hook or workflow step becomes a [step](/terragucci/guides/run-steps/). Run [`init`](#init) next to write the pipeline.

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
| Reads | each project's `index.json`, `inventory.json`, `changes.json` and `states.json`; `audit.jsonl` and `audit.json` when the audit trail is there |
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
| Reads | each project's `chant/lifecycle` history and its `tf-apply` wave reports |
| Writes | the entries `audit.jsonl` lacks, appended, and `audit.html` and `audit.json` beside it at the top of the prefix |
| Projects | in a control repo, its `projects:`, each ledger fetched from the project's repo and its reports read from its own `reports`, the record written to `defaults.reports`; in a repo of its own, the checkout's, its ledger read from `origin` |
| Exit 1 | a project's ledger or index could not be read, or with `--check` the record lacks an entry |

[The audit trail](/terragucci/reference/audit-trail/) describes every entry.

## plan and stage

```bash
terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>]
    [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--canary <globs>] [--bucket <url>]
    [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>] [--no-cost]
terragucci stage tf-drift [the same flags as tf-plan]
terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>]
    [--gate always|on-destroy|never] [--approval ledger|pr-review|sealed] [--config <file>] [--parallelism <n>] [--terragrunt [--rest]] [--base <ref>]
    [--shares <n> [--share <s>] [--decided <file>]] [--branches <branch>=<globs>[;...] [--branch <name>]]
    [--on-held wait|refuse] [--stand-down]
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
| `--gate` | | `always`, `on-destroy` (the default) or `never` |
| `--approval` | | the mode when the config at base names none and `chant.workspace.json` there lists no gate; a control repo's pipeline passes it |
| `--base` | `TG_BASE`, for the policy ref only | the ref that holds the wave's policy, approval mode, gate rule, signers file and other config; an open pull request's job passes `origin/<default branch>`. Without it the gate rule comes from the commit before the one applied |
| `--shares` | | `waves.jobs`: split the wave's roots into up to this many shares. Without `--share` the stage plans every root, decides the gate, writes each root's plan digest to `terragucci-wave/wave-<n>.json` and applies nothing |
| `--share` | | with `--shares`: plan this share's roots and apply them when each plan has the digest in the decision file; exit 4 when one moved |
| `--decided` | | the decision file, when it is not `terragucci-wave/wave-<n>.json` |
| `--branches` | | [`apply.branches`](/terragucci/reference/config/#apply-from-other-branches) as `release=envs/prod/*,envs/dr/*;staging=envs/staging/*`: the stage applies only the roots (in a Terragrunt repo, the units) of `--branch` when the map names it, and otherwise every root no branch's glob matches |
| `--branch` | | with `--branches`: the branch the push applies; unset means the default branch |
| `--on-held` | `TG_LOCK_POLL` | with `binary: choudoufu`, when another run's apply holds a resource the wave changes: `wait` (the default) polls every `TG_LOCK_POLL` seconds (10) for up to an hour, then plans again; `refuse` exits 5 naming that run, as the apply a comment starts does |
| `--stand-down` | | a push's wave: once it may apply, it applies nothing and exits 6 if a newer push is on its branch, which applies the whole tree |

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

Sends one wave's outcome to whichever of `TERRAGUCCI_SLACK_WEBHOOK`, `TERRAGUCCI_TEAMS_WEBHOOK` and `TERRAGUCCI_WEBHOOK` are set. The generic webhook gets a [`terragucci.notify/v1`](/terragucci/reference/notify-event/) event signed with `TERRAGUCCI_WEBHOOK_KEY`, and nothing when the key is empty. With `notify` set, the generated apply jobs run it on any nonzero exit.

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

A webhook that fails or does not answer within 10 seconds leaves a line in the log, and the command, which never prints a webhook's address, exits 0.

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

## mcp

```text
terragucci mcp [--config <file>] [--bucket <url>] [--bucket-endpoint <url>] [--bucket-prefix <p>]
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

Every tool is marked read-only, and the server refuses these calls.

| A call | The answer |
|---|---|
| to a tool it does not list, such as `approve`, `apply` or `override` | an error: the server is read-only, approvals belong to a person at a shell, and chant refuses a gate approval made over MCP |
| with an argument the tool does not list | an error naming the argument; one named like a credential (`token`, `secret`, `key`) says credentials come from the server's environment |
| with a `path` outside the reports prefix | an error |

The server writes nothing. Its bucket client refuses writes and signed links, and the server does not start with a tool whose name says it would write (approve, apply, override, lock, merge).

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

With [`oidc.roles`](/terragucci/reference/pipeline/#credentials) in a repo of plain roots, it reads each root's backend and `terraform_remote_state` blocks and prints a line per role and stage with the state that role reaches. Every glob in `oidc.roles` is an environment, and the unmatched roots form one more under `plan_role` and `apply_role`. Each warning goes to stderr.

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

## approve

```bash
terragucci approve [wave-<k> | <migration>] [--plan <digest>] [--actor <name>] [--sign [<key>]] [--dry-run] [--no-resume]
```

| Flag | Meaning |
|---|---|
| `wave-<k>` | the wave to approve; needed only when several wait and no `--plan` picks one |
| `<migration>` | a [state migration](/terragucci/reference/migration-files/) wave 1 waits on, by name: it runs `chant approve tf-migrate <migration> --plan <digest>`, and resumes wave 1; needed only when another gate waits too and no `--plan` picks one |
| `--plan` | the digest you read, from a chat message, a plan note or a report: approve only a wave waiting for exactly that digest. When none does, it approves nothing, prints the digest waiting and exits 1 |
| `--actor` | the name the approval records; under `approval: sealed`, your principal in the signers file |
| `--sign` | seal the approval with this key, or with git's `user.signingkey` when no key is given; the default under `approval: sealed` |
| `--dry-run` | print the `chant approve` command and run nothing |
| `--no-resume` | record the approval only; by default it then starts the wave again with your forge token ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)) |

Run it in a checkout whose `origin` you can push to; chant is looked up in `node_modules/.bin`, then on the path.

```text
wave-2 waits for an approval of jcs1-sha256:2e7a63f3... (wave 2 of 2: app), since 2026-10-07T18:04:11.000Z
  roots: app
  destroys app: aws_s3_bucket.logs
running: chant approve tf-apply wave-2 --plan jcs1-sha256:2e7a63f3... --actor github:alice
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
| `<root>` | the root whose state to export, with an `s3` backend in a bucket that keeps versions: a plain root, or a Terragrunt unit, which Terragrunt prepares through its `remote_state` block |
| `--version` | the version id, as the estate page's State versions section lists it; the bucket's current version by default |
| `--out` | where to write the file, outside the repo; a new private directory under the system's temp directory by default |
| `--actor` | who asks; git's `user.name` by default |

Run it twice in a checkout whose `origin` you can push to, signed in to the cloud as yourself. [Export a state version](/terragucci/guides/export-a-state-version/) has the steps.

| Run | Does | Exits |
|---|---|---|
| first | reads the version's metadata, records a request on `chant/lifecycle` and prints `chant approve tf-state-export <root> --plan <digest>` for someone else to run | 3 |
| second, once that approval stands | downloads the version, records the export in `_gates/tf-state-export/done.jsonl`, then writes the file, readable by you alone | 0 |

```text
state export: wrote /tmp/terragucci-export-Xb3k/envs_dev_app.3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY.tfstate: envs/dev/app's state, s3://acme-state/dev/app.tfstate version 3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY, approved by bob
```

An approval by the person who asked does not count. A request exports once; another export asks again. It never writes a state to the reports bucket or a job artifact.

## unlock-state

```bash
terragucci unlock-state <root> [--actor <name>] [--binary <b>] [--config <file>]
```

Releases the state lock a job killed mid-apply left on `<root>`: the lock file an `s3` backend with `use_lockfile = true` takes. A comment never runs it. Run it at a shell with:

- the backend's credentials;
- the forge token in the variable `token_env` names (by default `FORGEJO_TOKEN`, `GITHUB_TOKEN` or `GITLAB_TOKEN`);
- push access to the checkout's `origin`.

| Step | Does |
|---|---|
| read the lock | inits the root and reads `<key>.tflock`: its ID, who took it and when |
| check no holder is alive | reads the forge's runs still running or waiting; while one that began before the lock was taken is alive, it may hold the lock, so nothing is released and it exits 1 naming the runs. A forge it cannot read is a refusal too |
| wait at the gate | records a pending fact for gate `<root>` of op `tf-unlock` on `chant/lifecycle`, bound to a digest of the root, the lock's location and its ID, prints `chant approve tf-unlock <root> --plan <digest>` and exits 3. Under `approval: sealed`, only a sealed approval counts |
| release | approved, it checks the runs again, runs the binary's `force-unlock` of that ID, and appends who released which lock, and under whose approval, to `_gates/tf-unlock/done.jsonl`, which the [audit trail](/terragucci/reference/audit-trail/) reads |

| Flag | Meaning |
|---|---|
| `--actor` | the name the record gives the person who released it; default git's `user.name` |
| `--binary`, `--config` | as above |

```text
terragucci unlock-state: slow: s3://acme-state/slow.tfstate.tflock holds lock 1f0c..., OperationTypeApply by root@runner-7 at 2026-10-09T18:02:11.420Z
terragucci unlock-state: slow: no run that began before the lock is alive
terragucci unlock-state: slow: releasing lock 1f0c..., OperationTypeApply by root@runner-7 at 2026-10-09T18:02:11.420Z waits for an approval of digest jcs1-sha256:6d2b.... Approve it with:
terragucci unlock-state:   chant approve tf-unlock slow --plan jcs1-sha256:6d2b...
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
| `up` | inits each root the globs match at `--head` with `-backend-config` naming its key with `-pr-<n>` added, plans it, and decides gate `pr-<n>` of op `tf-ephemeral` on the set digest as `gate` says, printing `chant approve tf-ephemeral pr-<n> --plan <digest>` and exiting 3 while it waits; then applies, and appends the copy, its expiry and who approved it to `_gates/tf-ephemeral/done.jsonl` |
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

The resume job runs it ([Resume after an approval](/terragucci/reference/pipeline/#resume-after-an-approval)). From `chant/lifecycle` it finds each waiting wave, and each state migration wave 1 waits on, whose digest has an approval no apply has used. An approved migration resumes wave 1, which runs it. It writes `TG_SHA` and `TG_PR` to `--out` for the job's waves to apply on GitHub and Forgejo, and retries the waiting apply job on GitLab. It exits 0 when there is nothing to resume.

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

## check-root, check-pins and check-policy

```bash
terragucci check-root <dir> [--binary <b>] [--config <file>] [--base <ref>]
terragucci check-pins [--config <file>] [--base <ref>]
terragucci check-policy [--config <file>] [--base <ref>]
```

| Command | Does |
|---|---|
| `check-root` | runs `validate -json` in an initialised root and prints each diagnostic with its file and range; with `--binary choudoufu`, also `choudoufu live-check -json`. Under `modules.require: attested` (read at `--base`) it first checks the root's module pins |
| `check-pins` | the same pin check on each Terragrunt unit's `terraform { source }`; prints nothing without `modules.require: attested` |
| `check-policy` | runs the policy's tests when `policy` is set |

Each appends to `terragucci-check/report.md`, and the generated `tf-check` job runs all three. See [Stages](/terragucci/reference/stages/#check).

## install

```bash
terragucci install tofu|terraform|terragrunt|choudoufu|infracost|cosign|atmos|terramate <version>
```

Prints the directory it unpacked the release to, after checking it against its SHA256SUMS. The releases are Linux builds. Under `modules.attest` the publish job installs cosign this way before it publishes; in an Atmos repo every job installs Atmos this way.

## --json

`init`, `reconcile`, `plan`, `stage`, `rollout`, `respond` and `config check` take `--json`, which makes the command print only one envelope on stdout. [The CLI's JSON output](/terragucci/reference/cli-json/) lists the fields.

## Exit codes

The codes are the same with or without `--json`. Every command exits 2 on a usage or config error.

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | one or more projects or roots failed |
| 2 | a usage or config error |
| 3 | waiting on an approval, or on a rollout's pull request |
| 4 | a wave's plans changed after an approval or a policy override no run applied, or a share's plans changed after its wave decided, so `stage tf-apply` applied nothing |

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
| `state export` | the version written and recorded | | a root, backend or version it does not export, a file inside the repo, or nobody named | waits for an approval by someone else | |
| `check-root`, `check-pins`, `check-policy` | passed | failed | | | |
| `install` | done | | not a Linux host | | |
| `estate` | page written | a project's index could not be read | | | |
| `audit` | record written, or with `--check` nothing missing | a ledger or index could not be read; with `--check`, an entry the record lacks | | | |
| `verify-release` | every target verified | a target refused | | | |
| `ephemeral` | applied, destroyed, or nothing to do | a root failed to plan, apply or destroy | no `ephemeral` roots, a backend no key suffix fits, a Terragrunt unit whose `remote_state` key does not read `TERRAGUCCI_EPHEMERAL_SUFFIX` | the copy waits for an approval | an approval stands for other plans of the copy |
| `unlock-state` | released, or no lock held | a run that may hold the lock is alive | no forge token, a forge it cannot read, a backend with no lock file | waits for an approval of the lock | an approval stands for another lock |
| `approve`, `override` | approved (chant's own code otherwise) | `approve --plan` names a digest no wave waits for | no wave waiting, several waiting and none named, no recorded denial, or the rules differ | | |
| `resume`, `notify`, `plan-note`, `approval-status` | always, once the flags parse | | a bad flag | | |
| `relay` | never: it serves until stopped | | a missing setting, a token that can do more than approve, or a repo it cannot read | | |
| `mcp` | the client closed stdin | | a bad flag or config | | |
| `drift-agent` | prompt written; pull request opened, or the change refused with a comment on the issue | git or the forge failed | a bad flag, or a run that opened no drift issue | | |

Code 4 comes from `stage tf-apply`, `unlock-state` and `ephemeral`, which have no `--json`.
