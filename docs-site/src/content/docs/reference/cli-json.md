---
title: The CLI's JSON output
description: The envelope that init, reconcile, plan, stage, rollout, respond, config check and query print with --json, the exit codes behind it, and the outcome stage tf-apply writes.
prompt: |
  Read https://intentius.io/terragucci/reference/cli-json/.
  Write a script that runs `npx terragucci plan --json` and branches on the envelope's `exit` and `status` and on `results.roots`, printing each failed root's summary.
  Read only. Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

With `--json`, these commands print only one JSON object on stdout.

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
| `command` | `init`, `reconcile`, `plan`, `stage`, `rollout`, `respond`, `config check` or `query`. |
| `exit` | The process exit code. |
| `status` | `ok` for exit 0, `failed` for 1, `usage` for 2, `waiting` for 3. |
| `results` | What the command found or did, as below. `null` when the command could not run. |
| `error` | Present when `results` is `null`: why it could not run. |

`--json` leaves the [exit codes](/terragucci/reference/cli/#exit-codes) as they are. `stage tf-apply` refuses `--json` and writes [its outcome](#the-apply-outcome) to a file instead, so no envelope carries code 4.

## init

`init --dry-run --json` computes everything and writes nothing.

| Field | Holds |
|---|---|
| `dryRun` | Whether the run wrote files. |
| `roots` | Each root as `path` and `reason`, such as `backend s3`, `cloud block`, `choudoufu live block` (a [choudoufu](/terragucci/concepts/glossary/#choudoufu) estate), `provider aws` or `matches roots glob <glob>`. |
| `layers` | Roots grouped in apply order; roots in one layer can apply together. |
| `binary`, `version`, `forge` | Each as `value` and `reason`, where the reason names the file, flag or detection that decided it. |
| `image` | The CI image the pipeline runs in. |
| `files` | Each file as `path`, `status` (`created`, `updated` or `unchanged`) and `content`. |
| `notes` | Settings the pipeline does not act on, and flags the config overrides. |
| `configNote` | Whether a `terragucci.yml` was used or written. |

## reconcile

`results` holds `mode` (`dry-run` or `apply`) and `projects`, with these fields per project:

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

## The apply outcome

On every exit but a usage error, `stage tf-apply` writes its wave's outcome to the file `TG_OUTCOME_JSON` names. With `--rest` the file holds the last wave that ran. The generated apply jobs set the variable when `notify` is on, and `terragucci notify` reads the file. A waiting wave's file carries the [chant](/terragucci/concepts/glossary/#chant) command that approves it and where its gate's record lives on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle).

```json
{
  "schema": "terragucci.outcome/v1",
  "status": "waiting",
  "exit": 3,
  "wave": 2,
  "roots": ["envs/prod/app", "envs/prod/db"],
  "line": "wave 2 waits: chant approve tf-apply wave-2 --plan jcs1-sha256:9f2c...",
  "set_digest": "jcs1-sha256:9f2c...",
  "gate": { "name": "wave-2", "branch": "chant/lifecycle", "path": "_gates/tf-apply.jsonl" },
  "approval": "waiting",
  "approval_mode": "pr-review",
  "approve_command": "chant approve tf-apply wave-2 --plan jcs1-sha256:9f2c...",
  "waiting_since": "2026-10-08T14:02:11.000Z",
  "review": { "pull_request": 12, "url": "https://github.com/acme/infra/pull/12/files" }
}
```

| Field | Holds |
|---|---|
| `schema` | `terragucci.outcome/v1`. It changes only when a field is removed or changes meaning; new fields can appear without a bump. |
| `status`, `exit` | `applied` (0), `waiting` (3), `refused` (4; 5 when another run's apply holds a resource it changes; 6 when a newer push superseded it) or `failed` (1) |
| `wave`, `roots` | the wave and its roots (units in a Terragrunt repo); `roots` is empty when the repo has no such wave |
| `line` | the line the job's `terragucci/apply` status carries, when the wave wrote one (`TG_OUTCOME`) |
| `set_digest` | the set digest over the roots that change: what an approval binds |
| `gate` | when a gate held the wave: its `name` and the `branch` and `path` of its ledger |
| `approval` | `waiting`, `approved` or `not-required` |
| `approval_mode` | with a gate: `ledger`, `pr-review` or `sealed`, the mode in force at base |
| `approve_command` | waiting, or refused because the plans moved after an approval or a review: the `chant approve` command for `set_digest`, with `--sign` under `sealed` |
| `waiting_since` | waiting: when the wave began waiting for an approval of this digest |
| `review` | waiting under `approval: pr-review`: the `pull_request` whose approving review of its head would approve the wave, and the `url` to review it on |
| `refused` | why the wave applied nothing although it planned: `reason` (`approval`, `review`, `override` or `policy`), the digest `approved` and `by` whom, and the `roots` that moved or were denied |
| `policy_denied` | the roots the policy denied, when no override lets them through |
| `failed_roots` | failed: the roots that failed to plan or apply |

## rollout

`results` holds the state the run left the rollout in.

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
| `exit` | set when the command exits other than 0 |

`respond rollout` with no module puts `mode` and `rollouts` in `data`: for each rollout in flight, `kind`, `name`, `from`, `to`, `wave` (its newest), `waves`, `action` (`ran`, `waiting`, `stopped`, `done` or `failed`), `reason`, `pullRequests`, and `result`, [the rollout](#rollout) when it ran.

Exit 0 when handled, and 1 when a rollout `respond rollout` continued could not run. An unknown event or a missing flag exits 2 with `results` null.

## config check

`terragucci config check [--config <file>]` lists every problem, and for `.ts` checks that folding and running agree.

| `results` field | Holds |
|---|---|
| `file` | the config file read |
| `ok` | whether it has no problems |
| `problems` | a list of strings; a config with problems exits 2 |
| `approval` | for a repo's own config with no problems: `mode` (`ledger`, `pr-review` or `sealed`), `source` (the key, [`identity.gates`](/terragucci/concepts/glossary/#identitygates), or the default) and a `note` when the repo should change something |
| `warnings` | present when there are some: each role that reaches another environment's state, as text; warnings leave the exit code 0 |
| `state_access` | with `oidc.roles` and no problems: one entry per role and stage, with `role`, `stage` (`plan` or `apply`), `environment` (the glob, or `plan_role/apply_role`), `roots`, `states` (the state keys its roots' backends name) and `reads` (other environments' states they read) |

## query

`terragucci query "<statement>" --json` prints the rows the statement returned.

| `results` field | Holds |
|---|---|
| `columns` | the column names, in order |
| `rows` | one object per row, by column name; SQL `NULL` is `null` |
| `tables` | the row count of each table: `inventory`, `changes`, `history`, `audit` and `edges` |
