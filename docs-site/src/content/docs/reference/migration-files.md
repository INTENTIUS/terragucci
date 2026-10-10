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
| `backends[].from.backend` | where the state is now: `s3`, `gcs`, `azurerm`, `local`, `pg`, `kubernetes`, `consul`, `http`, `remote`, `cloud` or `file` |
| `backends[].from.config` | that backend's settings, as its block gave them; for `s3`, `bucket` and `key` at least; for `gcs`, `bucket`; for `azurerm`, `storage_account_name`, `container_name` and `key`; for `kubernetes`, `secret_suffix`; for `consul`, `path`; for `http`, `address` |

For these backends, the job reads the state through the root with the old backend in an override file. It writes the state unchanged to the backend the root's code names. The new backend must hold no state for the root. The old state stays where it was; delete it once the move is verified.

### Unversioned backends

The `pg`, `kubernetes`, `consul` and `http` backends (an `http` backend other than GitLab-managed state) keep no versions. A state moves from or to any of them, and a move between roots works on them.

```yaml
backends:
  - root: envs/dev/platform
    from:
      backend: pg
      config:
        conn_str: postgres://db.internal/terraform
        schema_name: platform_old
```

| Step | What the job does |
|---|---|
| plan | `state pull`, through an override file for the source |
| digest | each state's contents; there is no version id |
| write | `state push` under the backend's own lock; the binary refuses a state of another lineage or an older serial. A `kubernetes` backend writes an empty state at init, which the move replaces with `-force` |
| record | each state's address, such as `pg:db.internal/terraform/platform.states` or `kubernetes:<namespace>/<secret_suffix>` |

Credentials stay out of the file: `password`, `token`, `client_key` and `access_token` are refused, and so is a `conn_str` with a password. The job gives them in the backend's own variables, such as `PGPASSWORD` or `KUBE_TOKEN`. The source's lock is not held between the check and the write; the digest check runs just before it. `terragucci migrate revert` refuses these roots, since there is no earlier version to read.

### Workspaces

`remote` and `cloud` read a workspace's current state version over the TFE API, the protocol the `remote` backend and the `cloud` block use. HCP Terraform, Terraform Enterprise, Scalr, OTF and env zero's backend serve it.

```yaml
backends:
  - root: envs/dev/platform
    from:
      backend: cloud
      config:
        hostname: app.terraform.io
        organization: acme
        workspaces:
          name: platform-dev
```

| Key | Holds |
|---|---|
| `hostname` | the API's host; default `app.terraform.io`. The job finds the API through `https://<hostname>/.well-known/terraform.json` |
| `organization` | the organization; for env zero, `<organization id>.<project id>` |
| `workspaces.name` | the one workspace whose state moves; `prefix` and `tags` are refused |

The token is the one Terraform and OpenTofu read for the host: `TF_TOKEN_<host>`, dots as `_` and dashes as `__` (`TF_TOKEN_app_terraform_io`), else `~/.terraform.d/credentials.tfrc.json`. A `token` key in the file is refused. Give the plan and apply jobs the variable as a CI secret.

The digest covers the state version id (`sv-...`) and the state's digest. While it writes, the job holds the workspace's lock, checks that the current version is still the one approved, and unlocks it after. A workspace locked by someone else stops the move. The workspace keeps its versions.

### State files

`file` reads a state file the job can see, for state exported from a platform with no TFE API:

```yaml
backends:
  - root: envs/dev/platform
    from:
      backend: file
      config:
        path: exported/platform.tfstate
```

`path` is relative to the repo, or absolute. The file must be a state of format version 4 with a lineage, a serial and resources. The digest covers its contents, so a file changed after the approval is refused. State holds secrets: put the file in place in the job, not in git.

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
| `restores[].version_id` | the version to put back, read by its id; `null` for a root that had no state, which gets an empty one |
| `restores[].from_version_id` | the version the migration left; a state at any other version is refused, since putting the old one back would undo that later change too |

The revert goes through the same proof, gate and lock as any migration, so revert the code of the migration in the same change. A backend move is put back with a backend move the other way. The command refuses a root on a local backend or a bucket that kept no version, since it has nothing to put back.

## Estates

With [choudoufu](/terragucci/concepts/glossary/#choudoufu) as the binary, when every root a file names has a `live` block:

| File | Change | Refused when |
|---|---|---|
| `moves` | `retag`: each resource's tags are rewritten by `choudoufu live-mv -from-estate`, run in `to` | the roots are one estate, an address is a module call, or `from`'s plan does not destroy the address |
| `backends` | `adopt`: the state in `from` is read once and `choudoufu live-import` stamps each resource it verifies | the state is missing, or the `s3` backend takes no lock file |

A file whose roots mix estates and roots with a state is refused, as is any other binary. An address with `count` or `for_each` moves each instance the source plan destroys.

## The new states

A changed state keeps its lineage and gets the next serial. A root with no state gets a new one at serial 1. Its lineage is derived from the migration and the root, so the same migration planned twice gives the same digest.

The proof plan runs the root's own binary against its new state, through a `terragucci_migrate_override.tf` file that switches the backend to a local file in a data dir of the job's own. The file is removed after the plan, and the root's `.terraform` and real state are left as they were.

## The record

`terragucci-report/migrations/<name>.json` is `terragucci.migration/v1`:

| Field | Holds |
|---|---|
| `name`, `file`, `file_digest`, `change` | the migration file, and its kind: `moves`, `backends`, `revert`, or for estates `retag` or `adopt` |
| `retags[]` | a retag: each instance's `address`, its roots `from` and `to`, `from_estate`, `to_estate`, the `live_id` of the resource, and the `followers` that move with it |
| `stamps[]` | an adoption: each instance of the old state, its `status` as `live-import` verified it, and its `live_id` |
| `moves`, `backends`, `revert` | what it does: the moves; each root and where its state was; the migration a revert puts back |
| `digest` | what an approval binds |
| `status` | `planned`, `proof-failed`, `waiting`, `refused`, `applied` or `failed` |
| `roots[].root`, `backend`, `location` | each affected root and where its state is; for an estate, `estate` and `estate <name>` |
| `roots[].before` | `version_id`, when the backend keeps versions, and `digest`, `null` for a root with no state |
| `roots[].after` | the new state's `digest`, and its `version_id` once written |
| `roots[].source` | a backend move: where the state was read from, its `version_id` and `digest` |
| `roots[].restore` | a revert: the `version_id` put back, `null` for an empty state |
| `roots[].proof`, `roots[].verify` | the resource changes and the binary's summary line, against the new state and, after the write, against the backend |
| `approved_by`, `moved`, `error`, `finished`, `commit` | who approved it, the roots whose state moved, why it stopped, when and at which commit |
