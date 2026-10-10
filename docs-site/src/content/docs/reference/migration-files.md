---
title: Migration files
description: The files that move resources from one root's state to another's, move a state to a new backend, or put a migration back, and the record each leaves.
---

A migration file is `migrations/<name>.yml` at the top of the repo, and holds one kind of change: `moves`, `backends`, or a `revert`. [Move resources between roots](/terragucci/guides/move-resources-between-roots/) walks through each.

## Moves

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
| `moves[].from`, `moves[].to` | root directories, relative to the repo; they differ. A root holds `.tf` files, or `*.tf.json` files such as a CDK Terrain stack's `cdktf.out/stacks/<stack>/cdk.tf.json` |
| `moves[].addresses[]` | what moves, to the same address in `to` |

| An address | Moves |
|---|---|
| `aws_sqs_queue.jobs` | that resource, every instance of it |
| `module.service.aws_sqs_queue.jobs` | that resource in that module call, every instance of each |
| `module.search` | every resource and data source in that module call and the modules it calls |

The file's name, without `.yml`, names the gate `tf-migrate <name>`. It starts with a lower-case letter or digit and holds no spaces or capitals. An address with an instance key (`aws_s3_bucket.logs[0]`) or a data source is refused, as is any key the tables do not name. Migrations run in name order, so a date at the front of the name orders them.

## Backends

```yaml
backends:
  - root: envs/dev/platform
    from:
      backend: s3
      config:
        bucket: acme-old-state
        key: envs/dev/platform.tfstate
        region: us-east-1
        use_lockfile: true
```

| Key | Holds |
|---|---|
| `backends[].root` | a root whose backend block, in the same change, names the new backend |
| `backends[].from.backend` | `s3` or `local`: the backend the state is in now |
| `backends[].from.config` | that backend's settings, as its block gave them; for `s3`, `bucket` and `key` at least |

The job reads the state through the root with the old backend in an override file and writes it unchanged to the backend the root's code names. The new backend must hold no state for the root. The old state stays where it was; delete it once the move is verified.

## Revert

`terragucci migrate revert <name>` writes `migrations/<name>-revert.yml` from the line `_gates/tf-migrate/done.jsonl` keeps for a migration that applied:

```yaml
revert: split-queues
restores:
  - root: envs/dev/platform
    location: s3://acme-state/envs/dev/platform.tfstate
    version_id: "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY"
    from_version_id: "0dca9e05ea0c465297e4eed760e743f2"
  - root: envs/dev/queues
    location: s3://acme-state/envs/dev/queues.tfstate
    version_id: null
    from_version_id: "3a695fbfaea5493aa48fa9d07b9de2e4"
```

| Key | Holds |
|---|---|
| `revert` | the migration it puts back |
| `restores[].version_id` | the version to put back, read from the bucket by its id; `null` for a root that had no state, which gets an empty one |
| `restores[].from_version_id` | the version the migration left; a state at any other version is refused, since putting the old one back would undo that later change too |

The revert goes through the same proof, gate and lock as any migration, so revert the code of the migration in the same change. A backend move is put back with a backend move the other way. The command refuses a root on a local backend or a bucket that kept no version, since it has nothing to put back.

## The new states

A changed state keeps its lineage and gets the next serial. A root with no state gets a new one at serial 1. Its lineage is derived from the migration and the root, so the same migration planned twice gives the same digest.

The proof plan runs the root's own binary against its new state, through a `terragucci_migrate_override.tf` file that switches the backend to a local file in a data dir of the job's own. The file is removed after the plan, and the root's `.terraform` and real state are left as they were.

## The record

`terragucci-report/migrations/<name>.json` is `terragucci.migration/v1`:

| Field | Holds |
|---|---|
| `name`, `file`, `file_digest`, `change` | the migration file, and its kind: `moves`, `backends` or `revert` |
| `moves`, `backends`, `revert` | what it does: the moves; each root and where its state was; the migration a revert puts back |
| `digest` | what an approval binds |
| `status` | `planned`, `proof-failed`, `waiting`, `refused`, `applied` or `failed` |
| `roots[].root`, `backend`, `location` | each affected root and where its state is |
| `roots[].before` | `version_id`, when the backend keeps versions, and `digest`, `null` for a root with no state |
| `roots[].after` | the new state's `digest`, and its `version_id` once written |
| `roots[].source` | a backend move: where the state was read from, its `version_id` and `digest` |
| `roots[].restore` | a revert: the `version_id` put back, `null` for an empty state |
| `roots[].proof`, `roots[].verify` | the resource changes and the binary's summary line, against the new state and, after the write, against the backend |
| `approved_by`, `moved`, `error`, `finished`, `commit` | who approved it, the roots whose state moved, why it stopped, when and at which commit |
