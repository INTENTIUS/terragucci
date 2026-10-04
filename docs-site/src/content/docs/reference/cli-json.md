---
title: The CLI's JSON output
description: The envelope that init, reconcile, plan, stage and config check print with --json, and the exit codes behind it.
---

`init`, `reconcile`, `plan`, `stage` and `config check` take `--json`. With it, the command prints one JSON object on stdout and nothing else, so a script or an agent can parse the whole output. Text, progress and tool output stay off stdout.

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
| `command` | `init`, `reconcile`, `plan`, `stage` or `config check`. |
| `exit` | The process exit code. |
| `status` | `ok` for 0, `failed` for 1, `usage` for 2, `waiting` for 3. |
| `results` | What the command found or did, as below. `null` when the command could not run. |
| `error` | Present when `results` is `null`: why it could not run. |

Exit codes are the same with or without `--json`: 0 done, 1 one or more projects or roots failed, 2 a usage or config error, 3 waiting on an approval.

## init

`init --dry-run --json` computes everything and writes nothing.

| Field | Holds |
|---|---|
| `dryRun` | Whether the run wrote files. |
| `roots` | Each root as `path` and `reason`: `backend s3` (or the backend's type), `cloud block`, `provider aws` (or the provider's name), or `matches roots glob <glob>` when `roots` is set in the config. |
| `layers` | Roots grouped in apply order; roots in one layer can apply together. |
| `binary`, `version`, `forge` | Each as `value` and `reason`, where the reason names the file, flag or detection that decided it. |
| `image` | The CI image the pipeline runs in. |
| `files` | Each file as `path` (relative to the repo), `status` (`created`, `updated` or `unchanged`) and `content`, the full text it writes or would write. |
| `notes` | Settings the pipeline does not act on yet. |
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

The exit code is 1 when any project failed.

## plan

`results.roots` has one entry per root, in apply order: `root`, `ok`, and `summary`, which is the plan's `Plan:` or `No changes.` line, or the failure.

## stage

`results` holds `stage`, `change_set` (the run's set digest), `files` (the paths of `report.html`, `report.json` and `note.md`) and `uploaded`, which is null unless `reports.bucket` is set. Then it holds the run's key prefix in the bucket and the indexes it rewrote. The exit code is 1 when a root refused to plan; the report is written either way.

## config check

`terragucci config check [--config <file>]` validates `terragucci.yml`, `terragucci.json` or `terragucci.ts` and lists every problem rather than the first. For a `.ts` file it also checks that folding and running the config agree.

`results` holds `file`, `ok`, and `problems`, a list of strings. A config with problems exits 2.
