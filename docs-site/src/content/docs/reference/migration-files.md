---
title: Migration files
description: The file that moves resources from one root's state to another's, and the record a migration leaves.
---

A migration file is `migrations/<name>.yml` at the top of the repo. [Move resources between roots](/terragucci/guides/move-resources-between-roots/) walks through one.

## The file

```yaml
moves:
  - from: envs/dev/platform
    to: envs/dev/queues
    addresses:
      - aws_sqs_queue.jobs
      - module.search
```

| Key | Holds |
|---|---|
| `moves[]` | one entry per pair of roots; at least one |
| `moves[].from`, `moves[].to` | root directories, relative to the repo; they differ |
| `moves[].addresses[]` | what moves, to the same address in `to` |

| An address | Moves |
|---|---|
| `aws_sqs_queue.jobs` | that resource, every instance of it |
| `module.service.aws_sqs_queue.jobs` | that resource in that module call, every instance of each |
| `module.search` | every resource and data source in that module call and the modules it calls |

The file's name, without `.yml`, names the gate `tf-migrate <name>`. It starts with a lower-case letter or digit and holds no spaces or capitals. An address with an instance key (`aws_s3_bucket.logs[0]`) or a data source is refused, as is any key the tables do not name. Migrations run in name order, so a date at the front of the name orders them.

## The new states

A changed state keeps its lineage and gets the next serial. A root with no state gets a new one at serial 1. Its lineage is derived from the migration and the root, so the same migration planned twice gives the same digest.

The proof plan runs the root's own binary against its new state, through a `terragucci_migrate_override.tf` file that switches the backend to a local file in a data dir of the job's own. The file is removed after the plan. The root's `.terraform` and its real state are left as they were.

## The record

`terragucci-report/migrations/<name>.json` is `terragucci.migration/v1`:

| Field | Holds |
|---|---|
| `name`, `file`, `file_digest`, `moves` | the migration file |
| `digest` | what an approval binds |
| `status` | `planned`, `proof-failed`, `waiting`, `refused`, `applied` or `failed` |
| `roots[].root`, `backend`, `location` | each affected root and where its state is |
| `roots[].before` | `version_id`, when the backend keeps versions, and `digest`, `null` for a root with no state |
| `roots[].after` | the new state's `digest`, and its `version_id` once written |
| `roots[].proof`, `roots[].verify` | the resource changes and the binary's summary line, against the new state and, after the write, against the backend |
| `approved_by`, `moved`, `error`, `finished`, `commit` | who approved it, the roots whose state moved, why it stopped, when and at which commit |
