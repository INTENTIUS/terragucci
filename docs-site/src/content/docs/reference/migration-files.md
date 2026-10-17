---
title: Migration files
description: The files that move resources from one root's state to another's, move a state to a new backend, or put a migration back, and the record each leaves.
---

A migration file is `migrations/<name>.yml` at the top of the repo, and holds one kind of change: `moves`, `backends`, or a `revert`. [Move resources between roots](/terragucci/guides/move-resources-between-roots/) walks through each.

A repo whose pipeline applies each wave in [one job per identity](/terragucci/concepts/waves-and-approvals/#one-apply-job-per-identity) cannot run migrations: wave 1's deciding job runs them, and it holds the plan roles alone, which cannot write a state. A pull request's plan fails on a migration that has not applied, naming the file.

| A migration is released by | Never by |
|---|---|
| `terragucci approve <name>` from a checkout, of its digest, sealed with `--sign` under `approval: sealed` | a pull request review under any `approval` mode, a click in chat, or a `/terragucci` comment |

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

The `pg`, `kubernetes`, `consul` and `http` backends (an `http` backend other than GitLab-managed state) keep no versions. A state can move out of any of them or into one, and a move between roots works on them.

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

Both `remote` and `cloud` read a workspace's current state version over the TFE API that the `remote` backend and the `cloud` block speak. HCP Terraform, Terraform Enterprise, Scalr, OTF and env zero's backend serve it.

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

The digest covers the state version id (`sv-...`) and the state's digest. The job holds the workspace's lock while it writes and checks that the current version is still the one approved; it unlocks the workspace after. A workspace locked by someone else stops the move. Every version it had is kept.

### State files

For state exported from a platform with no TFE API, `file` reads a state file the job can see:

```yaml
backends:
  - root: envs/dev/platform
    from:
      backend: file
      config:
        path: exported/platform.tfstate
```

`path` is relative to the repo, or absolute. The job reads a state of format version 4 that has resources and both a lineage and a serial. The digest covers its contents, so a file changed after the approval is refused. Put the file in place in the job rather than in git, since a state holds secrets.

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
| `moves` | `retag`: each resource's tags are rewritten by `choudoufu live-mv -from-estate`, run in `to` | the roots are one estate, an address is a module call, `from`'s plan does not destroy the address, or `live-mv -dry-run` refuses a resource |
| `backends` | `adopt`: the state in `from` is read once and `choudoufu live-import` stamps each resource it verifies | the state is missing, the `s3` backend takes no lock file, or an instance of the state does not verify |

A `retag` is proved by `live-mv -dry-run -json`, run for each resource in the root it joins: choudoufu must find the resource in the estate it leaves, and one refusal stops the migration. The resources carry the other estate's tags until the retag, and a plan of the root they join is refused before then, so its first plan comes once the tags are rewritten. The root they only leave is planned, and each change it plans must be a destroy the retag removes. Nothing plans a root that both gives and takes resources before the write; its addresses move as the file names them. An `adopt` is proved by `live-import` without `-approve` alone. Its root is not planned before the stamp, since choudoufu refuses to plan a root while an untagged live object is at a resource's identity. Every instance must come back `VERIFIED`, or `UNTAGGABLE` and composed from a verified parent; the others are the proof's changes. Its digest binds those entries along with the old state's version id and digest. Until either kind of migration applies, `stage tf-plan` and wave 1 list each root it adopts or retags resources into as planned by the migration in place of planning it. After the write every root plans and must show no change.

A file whose roots mix estates and roots with a state is refused, as is any other binary. An address with `count` or `for_each` moves each instance the source plan destroys.

### Progress

The job adds `-progress-json` to each `live-mv` and `live-import -approve` it runs when the binary's `live-mv -help` lists that flag. choudoufu then prints a JSON line on stderr for each resource once its tags are written. Each line is appended to `terragucci-report/migrations/<name>/progress.jsonl` the moment it arrives. With a [reports bucket](/terragucci/reference/reports-bucket/), the file and the record are copied to `<prefix>/<project>/migrations/` every `TG_PROGRESS_SECONDS` seconds (5 by default) while lines arrive, and once more when the writes end. A binary whose help does not list the flag writes no progress file and runs as before.

```json
{"at":"2026-10-17T04:39:52.1Z","estate_from":"mono","estate_to":"team","address":"aws_sqs_queue.jobs","live_id":"https://sqs.us-east-1.amazonaws.com/000000000000/jobs","outcome":"moved","migration":"carve","counts":{"moved":36,"stamped":0,"refused":0,"skipped":0,"left":43}}
```

| Field | Holds |
|---|---|
| `at`, `estate_from`, `estate_to`, `address`, `live_id`, `outcome`, `reason`, `follows` | the line as choudoufu wrote it: `outcome` is `moved`, `stamped`, `refused` or `skipped`, `estate_from` is empty for an adoption, and `follows` names the resource a follower moved with |
| `migration` | its name |
| `counts` | how many resources hold each outcome once this line arrived, and how many are `left` with no line yet |

In the [trace](/terragucci/guides/send-traces-and-metrics/), each line is also an event on the span `migration <name>`, which hangs under wave 1's `migrate` span.

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
| `progress` | an estate migration whose binary printed [progress lines](#progress): `moved`, `stamped`, `refused`, `skipped` and `left`, as the last line's `counts` |
