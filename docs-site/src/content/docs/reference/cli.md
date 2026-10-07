---
title: CLI commands
description: Every terragucci command, its flags and its exit codes.
---

`npx terragucci <command>` runs from the root of a repo. A generated pipeline calls the same commands.

| Command | What it does |
|---|---|
| `init` | finds roots, binary and forge, and writes the pipeline and [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) |
| `reconcile` | from a control repo, opens a pull request in each project that needs a change |
| `plan` | plans every root and prints the result |
| `stage tf-plan` | plans the roots a change reaches, groups them, and writes the report |
| `publish` | publishes each changed module at a new version |
| `rollout` | moves a module's or provider's pin one wave at a time |
| `respond` | runs the response to a pipeline event |
| `comment` | reads a `/terragucci plan [root]` or `/terragucci agent <ask>` pull request comment, and pushes an agent's change; the generated pipeline runs it |
| `comment-apply` | reads a `/terragucci apply [wave-<n>]` or `/terragucci unlock` comment; the generated pipeline runs it |
| `pr-merge` | merges a pull request every wave of which applied before merge, with `apply.merge: auto`; the generated pipeline runs it |
| `config check` | validates the config file and lists every problem |
| `check-root`, `check-policy` | the steps of `tf-check` beyond the format check; the generated pipeline runs them |
| `auth-provider` | internal: Terragrunt's `auth-provider-cmd`, which the generated Terragrunt pipeline runs |
| `install` | fetches a release of OpenTofu, Terraform, Terragrunt or [choudoufu](/terragucci/concepts/glossary/#choudoufu), verified against its checksums |
| `profiles` | prints the stack profiles a config needs, for the local validation stack |

## init

```bash
terragucci init [--forge github|gitlab|forgejo] [--binary tofu|terraform|choudoufu] [--force] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--forge` | the forge, when the remote cannot tell |
| `--binary` | the binary, when detection picks the wrong one: `tofu`, `terraform` or `choudoufu` |
| `--dry-run` | compute everything and write nothing |
| `--force` | overwrite a pipeline file terragucci did not write |

A flag detection would not reach goes into a new `terragucci.yml`. An existing config file is never edited: `init` exits 2 and names the line to add, such as `binary: terraform`. A key already set there wins.

`init` also writes chant's `chant.workspace.json`, with each wave's gate (`wave-1`, `wave-2`) under [`identity.gates`](/terragucci/concepts/glossary/#identitygates), so a wave counts only an approval sealed with [`chant approve --sign`](/terragucci/concepts/glossary/#chant). An existing file gains missing gates. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) sets up the signers file.

## reconcile

```bash
terragucci reconcile [--config <file>] [--mode dry-run|apply] [--project <host/path>]
```

`--config` defaults to the config file in the working directory and `--mode` to `dry-run`. `--mode apply` opens a pull request per changed project and never runs `terraform apply` ([glossary](/terragucci/concepts/glossary/#words-that-mean-something-else-in-terraform)). `--project` limits the run to one project.

## plan and stage

```bash
terragucci plan [--root <glob>] [--project <host/path>] [--config <file>]
terragucci stage tf-plan [--root <glob>] [--project <host/path>] [--config <file>] [--out <dir>]
    [--report-url <url>] [--layers <a,b;c>] [--binary <b>] [--canary <globs>] [--bucket s3://<b>]
    [--bucket-endpoint <url>] [--bucket-prefix <p>] [--bucket-url <url>] [--terragrunt] [--base <ref>] [--forge github|forgejo|gitlab] [--parallelism <n>]
terragucci stage tf-drift [the same flags as tf-plan]
terragucci stage tf-apply --wave <n> --layers <a,b;c> [--canary <globs>] [--binary <b>]
    [--gate always|on-destroy|never] [--config <file>] [--parallelism <n>] [--terragrunt] [--base <ref>]
```

| Flag | Meaning |
|---|---|
| `--root` | plan only the roots matching this glob |
| `--project` | the project, as `<host>/<path>`, for a run from a control repo |
| `--config` | the config file, when it is not at the repo root |
| `--out` | where `stage` writes the report; default `terragucci-report/` |
| `--report-url` | where the note links the HTML report, when it is not beside the note; a URL that is not an `.html` file is read as the run's page, and the note says so |
| `--layers`, `--binary`, `--canary`, `--bucket` | the roots in apply order (layers split by `;`), binary, canary wave and bucket the pipeline was written with; each overrides `terragucci.yml` |
| `--bucket-endpoint`, `--bucket-prefix`, `--bucket-url` | the store's endpoint, the key prefix, and the address that serves the bucket to a browser; with an address, the note links the bucket's copy |
| `--terragrunt` | run Terragrunt units: `tf-plan` and `tf-drift` use one `run --all` per wave; `tf-apply` saves each unit's plan and applies the saved plans |
| `--base` | the ref a change is measured against, such as `origin/main`; default is the pull request's target branch |
| `--forge` | `github`, `forgejo` or `gitlab`, when the environment alone cannot tell the forge; used by `tf-drift` to file its issue |
| `--parallelism` | how many roots of a dependency layer (`tf-plan`, `tf-drift`) or of a wave (`tf-apply`) run at once; overrides `parallelism` in `terragucci.yml`; `1` runs one at a time |

`stage tf-plan` and `stage tf-drift` exit 1 when a root refuses to plan, and still write the report. [The plan report](/terragucci/reference/report/) lists the files.

`stage tf-apply` applies one wave, as the generated `apply-wave-<n>` job does. `--gate` is `always`, `on-destroy` (the default) or `never`. `--base` names the ref that holds the wave's policy, gate rule, signers file and other config; the job for an open pull request passes `origin/<default branch>`. Without it the gate rule comes from the commit before the one applied, and other settings from the checkout. Exit 3 means the wave waits for an approval. Exit 4 means its plans changed after the approval, so nothing applied. `--json` is refused with exit 2.

## publish

```bash
terragucci publish [--dry-run] [--config <file>]
```

`--dry-run` lists what would be published and pushes nothing. `publish` exits 0 when it finishes. It exits 2 on a config error, on an OCI tag that exists already, and on a git tag that exists with different content. A git tag with the same content is unchanged and exits 0.

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
| `--module`, `--since` | `version-bump` | one module, and a ref (a tag, branch or commit) to count changes from for a module with no release tag |
| `--title`, `--description` | `description` | the pull request's title and description; by default read from the job's event |
| `--attributions` | `drift` | the attributions `tf-drift` wrote, as a file; default `terragucci-report/attributions.json` |
| `--base` | `wave-refused`, `apply-failed` | read settings from the config at this ref (such as `origin/main`), not the checkout; the generated apply of an open pull request passes it. An unreadable base gives no response and a logged reason |
| `--out`, `--binary`, `--config`, `--project` | all | as above |

[Responses to pipeline events](/terragucci/reference/responses/) explains each event. `respond` exits 0 once the event was handled, even when the response is `off`. The outcome is in the text, or in `results` with `--json` ([the JSON output](/terragucci/reference/cli-json/#respond)).

## comment

```text
terragucci comment --layers <a,b;c> --out <file> [--forge github|forgejo] [--agent off|on]
terragucci comment --agent run --out <file> --prompt <file> [--policy-dir <dir>] [--forge github|forgejo]
terragucci comment --agent push --change <dir> [--policy-dir <dir>]
```

Reads the pull request comment in the event file (`GITHUB_EVENT_PATH`) and writes a decision to `--out`: plan, or stop with a reason. A refused command is answered on the pull request. `--forge github` (the default) asks the API for the commenter's permission and `--forge forgejo` reads it from the event. The generated `replan` job runs it before any credential; see [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/). A forge error or an unreadable event file exits 1. `/terragucci apply` is read by `comment-apply`.

With `--agent on`, `replan` leaves agent comments to the agent jobs. With `off`, the default, it replies with how to turn the agent comment on.

The `agent` job runs `--agent run`. It decides on a `/terragucci agent <ask>` comment with the same checks and writes the prompt to `--prompt`. A fork or default-branch pull request gets no agent.

The `agent-push` job runs `--agent push`. It refuses the patch in `--change` when it touches a path an agent may not change, `--policy-dir` (default `policy`) among them; [The generated pipeline](/terragucci/reference/pipeline/#the-agent-comment) lists the rest. A passing patch is committed to the pull request's head branch, using the `TG_*` variables in [Environment variables](/terragucci/reference/environment/).

## comment-apply

```text
terragucci comment-apply --layers <a,b;c> --out <file> [--canary <globs>] [--forge github|forgejo]
    [--when merge|pull-request]
```

Reads a `/terragucci apply [wave-<n>]` comment, checks the commenter's permission as `comment` does, and writes a decision to `--out`: the merge commit and last wave to apply, or why nothing applies. The generated `apply-comment` job runs it before any credential, and on Forgejo again once it holds the apply lock. See [Apply a merged pull request](/terragucci/guides/re-plan-from-a-comment/#apply-a-merged-pull-request).

With `--when pull-request` (written when `apply.when` is `pull-request`), an open pull request applies from its head once the checks in [Apply before merge](/terragucci/reference/pipeline/#apply-before-merge) pass. The command takes the root locks, and `/terragucci unlock` releases them.

## pr-merge

```text
terragucci pr-merge --pr <n> --sha <sha> [--forge github|forgejo]
```

Merges the pull request while its head is still `--sha`, then releases its root locks. The generated `pr-merge` job runs it after the last wave applied before merge, with `apply.merge: auto`. Because the sha comes from a job that ran the pull request's code, it first checks with `TG_TOKEN` that the pull request is open, its head is `--sha`, and a reviewer other than the author approved that head. It merges with `TG_MERGE_TOKEN` if set (named by `apply.merge_token_env`), else `TG_TOKEN`, and exits 1 when it does not merge.

## config check

```bash
terragucci config check [--config <file>]
```

Lists every problem. [The config keys](/terragucci/reference/config/) names the files it reads.

```text
terragucci.yml: ok
```

## check-root and check-policy

```bash
terragucci check-root <dir> [--binary <b>]
terragucci check-policy [--config <file>] [--base <ref>]
```

`check-root` runs `validate -json` in an initialised root and prints each diagnostic with its file and range; with `--binary choudoufu` it also runs `choudoufu live-check -json`. `check-policy` runs the policy's tests when `policy` is set. Both exit 1 on a failure, append to `terragucci-check/report.md`, and run in the generated `tf-check` job. See [Stages](/terragucci/reference/stages/#check).

## install

```bash
terragucci install tofu|terraform|terragrunt|choudoufu <version>
```

Fetches the release, checks it against its SHA256SUMS and prints the directory it unpacked to. The releases are Linux builds; on another OS the command exits 2.

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
| 4 | a wave's plans changed after its approval, so `stage tf-apply` applied nothing |

Code 4 comes only from `stage tf-apply`, which has no `--json`.
