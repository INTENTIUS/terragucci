---
title: The CLI's JSON output
description: The envelope that init, reconcile, plan, stage, rollout, respond and config check print with --json, and the exit codes behind it.
prompt: |
  Read https://intentius.io/terragucci/reference/cli-json/.
  Write a script that runs `npx terragucci plan --json` and branches on the envelope's `exit` and `status` and on `results.roots`, printing each failed root's summary.
  Read only. Never run apply, `chant approve` or `--mode apply`, and never merge.
---

With `--json`, these commands print one JSON object on stdout and nothing else.

## The envelope

```json
{
  "schema": 1,
  "command": "init",
  "exit": 0,
  "status": "ok",
  "results": {}
}
```

| Field | Holds |
|---|---|
| `schema` | The envelope version. It changes only when a field is removed or changes meaning; new fields can appear without a bump. |
| `command` | `init`, `reconcile`, `plan`, `stage`, `rollout`, `respond` or `config check`. |
| `exit` | The process exit code. |
| `status` | `ok` for exit 0, `failed` for 1, `usage` for 2, `waiting` for 3. |
| `results` | What the command found or did, as below. `null` when the command could not run. |
| `error` | Present when `results` is `null`: why it could not run. |

Exit codes are the same with or without `--json`; [the CLI page](/terragucci/reference/cli/#exit-codes) lists them. No envelope carries code 4: `stage tf-apply` refuses `--json`.

## init

`init --dry-run --json` computes everything and writes nothing.

| Field | Holds |
|---|---|
| `dryRun` | Whether the run wrote files. |
| `roots` | Each root as `path` and `reason`, such as `backend s3`, `cloud block`, `provider aws` or `matches roots glob <glob>`. |
| `layers` | Roots grouped in apply order; roots in one layer can apply together. |
| `binary`, `version`, `forge` | Each as `value` and `reason`, where the reason names the file, flag or detection that decided it. |
| `image` | The CI image the pipeline runs in. |
| `files` | Each file as `path`, `status` (`created`, `updated` or `unchanged`) and `content`. |
| `notes` | Settings the pipeline does not act on, and flags the config overrides. |
| `configNote` | Whether a `terragucci.yml` was used or written. |

## reconcile

`results.mode` is `dry-run` or `apply`. `results.projects` has one entry per project:

| Field | Holds |
|---|---|
| `key` | The project, as `<host>/<path>`. |
| `status` | `unchanged`, `would-change`, `pull-request` or `failed`. |
| `changes` | The files, as in `init`'s `files`. |
| `pullRequest` | The pull request's URL, when one was opened. |
| `error` | Why the project failed. |
| `tips` | On a dry run with `tips` on, advice on the project's setup, as `rule`, `root`, `message` and `url`. |

The exit code is 1 when any project failed.

## plan

`results.roots` has one entry per root, in apply order:

| Field | Holds |
|---|---|
| `root` | the root's path |
| `ok` | whether it planned |
| `summary` | the plan's `Plan:` or `No changes.` line, or the failure |

## stage

| `results` field | Holds |
|---|---|
| `stage` | the stage that ran |
| `change_set` | the set digest |
| `files` | the report files |
| `uploaded` | the bucket copy; `null` without `reports.bucket` |
| `issue` | `tf-drift` only: `action` (`opened`, `updated`, `closed`, `left-open` or `none`), `issue` and `error` |

A root that refused to plan exits 1.

## rollout

`results` is the rollout as the run left it.

| Field | Holds |
|---|---|
| `kind`, `name` | `module` or `provider`, and the module or provider address. |
| `from`, `to` | The version that moves and the one it moves to. |
| `discovered` | Where `to` was found, when no version was named: a tag, or an OCI repository. |
| `mode` | `dry-run` or `apply`. |
| `status` | `complete`, `opened`, `would-open`, `waiting` or `stopped`, with `stop` saying why it stopped. |
| `waves` | `wave`, `canary` and `parts`: `project`, `roots`, `branch`, `state`, `pullRequest`, `pending`, `failed`, `files`. |
| `roots` | `project`, `root`, `state` (`from`, `to`, `refused` or `elsewhere`), `version`, `reason`. |
| `tips` | Each refused root's tip, as `rule`, `project`, `root` and `message`. |

A part's `state` is `applied`, `nothing-to-move`, `opened`, `would-open`, `open`, `waiting-apply`, `failed`, `closed` or `not-reached`. Exit 3 means waiting; 1 means stopped.

## respond

| `results` field | Holds |
|---|---|
| `event`, `response`, `text` | the event, the response it got and the text printed |
| `skipped`, `data`, `proposals`, `agent_input` | set only when the response has them |

Exit 0 when handled. An unknown event or a missing flag exits 2 with `results` null.

## config check

`terragucci config check [--config <file>]` lists every problem; for `.ts` it also checks that folding and running agree.

| `results` field | Holds |
|---|---|
| `file` | the config file read |
| `ok` | whether it has no problems |
| `problems` | a list of strings; a config with problems exits 2 |
