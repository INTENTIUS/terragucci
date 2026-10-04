# The terragucci example, on Terragrunt

The same small shop as `example/`, written as Terragrunt units. floci stands in for AWS and a local Forgejo runs the pipelines, so nothing here needs a cloud account.

The tutorial's Terragrunt path walks through it: https://intentius.io/terragucci/tutorial/terragrunt/

## What is here

```
root.hcl                  where each unit keeps its state, and the AWS provider every unit gets
live/common.hcl           settings every unit reads with read_terragrunt_config
live/<env>/env.hcl        the environment's name
live/<env>/platform       the environment's logs bucket; every service unit depends on it
live/<env>/<service>      orders, payments, search and email, each on modules/service
modules/platform          one bucket
modules/service           a bucket, a jobs queue, a records table; reads policy.json with file()
terragucci.yml            three lines: the binary and the canary wave
changes/                  the scenarios, one patch each
.forgejo/                 the pipeline terragucci generates for this repo
```

Three environments with five units each make 15 units, in implicit stacks: a stack is a directory of units. Each service unit reads its platform's outputs through a `dependency` block with `mock_outputs`, so it can be validated before the platform exists.

A few units differ on purpose:

| Unit | What is different |
|---|---|
| `live/prod/payments` | its jobs queue has a dead-letter queue |
| `live/prod/search` | a `dependencies` block puts it after orders, for ordering only |
| `live/staging/email` | its mocks also stand in for `destroy` |
| `live/prod/email` | its mocks have no allow-list, so Terragrunt lets them stand in for `apply`; terragucci's tips name it |

## Scenarios

| Scenario | The change |
|---|---|
| `one-unit` | dev orders keeps unclaimed jobs for seven days |
| `unformatted` | dev orders gains a file `terragrunt hcl fmt` would rewrite |
| `module-bump` | `modules/service/policy.json` keeps files 60 days; Terragrunt's own change detection misses it |
| `destroy` | staging email drops its records table |
| `new-service` | dev gains a ledger unit and a billing unit that reads it, in one change |

From the terragucci repo, `just example-terragrunt change <scenario>` opens a pull request with one of them.
