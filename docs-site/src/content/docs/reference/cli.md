---
title: CLI commands
description: Every terragucci command, its flags and its exit codes.
---

`npx terragucci <command>` runs from the root of a repo. A generated pipeline calls the same commands.

| Command | What it does |
|---|---|
| `init` | finds roots, binary and forge, and writes the pipeline and `chant.workspace.json` |
| `reconcile` | from a control repo, opens a pull request in each project that needs a change |
| `plan` | plans every root and prints the result |
| `stage tf-plan` | plans the roots a change reaches, groups them, and writes the report |
| `publish` | publishes each changed module at a new version |
| `rollout` | moves a module's or provider's pin one wave at a time |
| `respond` | runs the response to a pipeline event |
| `comment` | reads a `/terragucci plan [root]` pull request comment; the generated pipeline runs it |
| `config check` | validates the config file and lists every problem |
| `check-root`, `check-policy` | the steps of `tf-check` beyond the format check; the generated pipeline runs them |
| `install` | fetches a release of OpenTofu, Terraform or Terragrunt, verified against its checksums |
| `profiles` | prints the stack profiles a config needs, for the local validation stack |

## init

```bash
terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform] [--force] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--forge` | the forge, when the remote cannot tell |
| `--binary` | the binary, when detection picks the wrong one |
| `--dry-run` | compute everything and write nothing |
| `--force` | overwrite a pipeline file terragucci did not write |

A flag that detection cannot find on its own is recorded in `terragucci.yml`.

`init` also writes `chant.workspace.json` and lists each apply wave's gate (`wave-1`, `wave-2` and so on) under `identity.gates`, so a wave counts only an approval sealed with `chant approve --sign`. When the file already exists, `init` adds the gates it lacks and leaves the rest as it is. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) sets up the signers file the seals are checked against.

## reconcile

```bash
terragucci reconcile --config <file> [--mode dry-run|apply] [--project <host/path>]
```

`--mode` defaults to `dry-run`. `--mode apply` opens a pull request in each project that changes. `--project` narrows the run to one project.

## plan and stage

```bash
terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>]
    [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--canary <globs>] [--bucket s3://<b>]
    [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--parallelism <n>]
```

| Flag | Meaning |
|---|---|
| `--root` | plan only the roots matching this glob |
| `--project` | the project, as `<host>/<path>`, for a run from a control repo |
| `--config` | the config file, when it is not at the repo root |
| `--out` | where `stage` writes the report; default `terragucci-report/` |
| `--report-url` | where the note links the HTML report, when it is not beside the note. A URL that is not an `.html` file is read as the run's page, which holds the report in its artifacts, and the note says so |
| `--layers`, `--binary`, `--canary`, `--bucket` | the roots in apply order (layers split by `;`), binary, canary wave and bucket the pipeline was written with; each overrides `terragucci.yml` |
| `--bucket-endpoint`, `--bucket-prefix`, `--bucket-url` | the store's endpoint, the key prefix, and the address that serves the bucket to a browser; with an address, the note links the bucket's copy |
| `--terragrunt` | plan Terragrunt units, one `run --all` per wave |
| `--base` | the ref a change is measured against, such as `origin/main`; default is the pull request's target branch |
| `--parallelism` | how many roots of one dependency layer plan at once (`tf-plan`, `tf-drift`), or of one wave (`tf-apply`); overrides `parallelism` in `terragucci.yml`. `--parallelism 1` plans one root at a time |

`stage` exits 1 when a root refuses to plan, and still writes the report. [The plan report](/terragucci/reference/report/) lists the files.

## publish

```bash
terragucci publish [--dry-run] [--config <file>]
```

## rollout

```bash
terragucci rollout <module> [<version>] [--from <version>] [--mode dry-run|apply] [--config <file>]
terragucci rollout --provider <address> <version> [--from <version>] [--mode dry-run|apply]
```

`--mode` defaults to `dry-run`. See [Rolling out a module version](/terragucci/reference/stages/#rolling-out-a-module-version).

## respond

```bash
terragucci respond plan|wave-refused|apply-failed|drift|tips|fmt|publish|rollout|question|version-bump|description [--mode dry-run|apply] [flags]
```

| Flag | Used by | Meaning |
|---|---|---|
| `--mode` | all | `dry-run` (the default) or `apply`, which opens the pull request or pushes the commit |
| `--report` | `plan`, `description` | the report directory |
| `--approved`, `--current`, `--wave` | `wave-refused` | the approved report, the current report directory and the wave number |
| `--log` | `apply-failed` | the apply log; `-` reads standard input |
| `--root`, `--import` | `drift` | one root, and `<address>=<id>` for a resource the state does not hold |
| `--platform` | `tips` | lock file platforms, comma separated |
| `--branch` | `fmt` | the branch to format; the default branch is refused |
| `--module`, `--version` | `publish` | the module, and the release |
| `--module`, `--since` | `version-bump` | one module, and a ref (a tag, branch or commit) to count changes from for a module with no release tag |
| `--question` | `question` | the reviewer's question |
| `--title`, `--description` | `description` | the pull request's title and description; by default read from the job's event |
| `--out`, `--binary`, `--config`, `--project` | all | as above |

[Responses to pipeline events](/terragucci/reference/responses/) explains each event.

## comment

```text
terragucci comment --layers <a,b;c> --out <file> [--forge github|forgejo]
```

Reads the pull request comment in the event file (`GITHUB_EVENT_PATH`) and writes a decision to `--out`. With `--forge github`, the default, it asks the API for the commenter's permission. With `--forge forgejo` it reads the permission Forgejo wrote into the event for the commenter, since a Forgejo job's token may not ask the API for another user's permission. The generated `replan` job runs it before it asks for any credential. See [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/). The decision is to plan, or to stop with a reason; a refused command is answered on the pull request. When the command cannot decide because of an error (the forge refused or failed a call, or the event file is unreadable), it exits 1 with the cause, so the job fails instead of ending as if nothing was asked. The only command is `plan`.

## config check

```bash
terragucci config check [--config <file>]
```

Validates `terragucci.yml`, `terragucci.json` or `terragucci.ts` and lists every problem rather than the first.

```text
terragucci.yml: ok
```

## check-root and check-policy

```bash
terragucci check-root <dir> [--binary <b>]
terragucci check-policy [--config <file>] [--base <ref>]
```

`check-root` runs `validate -json` in an initialised root and prints each diagnostic with its file and range. With `--binary choudoufu` it then runs `choudoufu live-check -json` and prints each refusal. `check-policy` runs the policy's tests when `policy` is set, and does nothing when it is not. Both exit 1 on a failure, append to `terragucci-check/report.md`, and are what the generated `tf-check` job runs. See [Stages](/terragucci/reference/stages/#check).

## install

```bash
terragucci install tofu|terraform|terragrunt <version>
```

Fetches the release, checks it against the release's SHA256SUMS, unpacks it and prints the directory. A pipeline uses it when a repo pins a version its image does not carry.

## --json

`init`, `reconcile`, `plan`, `stage`, `rollout`, `respond` and `config check` take `--json`. The command then prints one envelope on stdout and nothing else. [The CLI's JSON output](/terragucci/reference/cli-json/) lists the fields.

## Exit codes

The codes are the same with or without `--json`.

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | one or more projects or roots failed |
| 2 | a usage or config error |
| 3 | waiting on an approval, or on a rollout's pull request |
