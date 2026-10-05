# The terragucci example

The estate of a small shop, on a laptop. floci stands in for AWS, and a local Forgejo runs the pipelines, so nothing here needs a cloud account or costs anything.

The tutorial walks through it step by step: https://intentius.io/terragucci/tutorial/

## What is here

```
modules/service/     one service: a bucket, a jobs queue, a records table
envs/<env>/platform  each environment's logs bucket, applied first
envs/<env>/<service> orders, payments, search and email, each calling modules/service
terragucci.yml       the whole terragucci config, four lines
changes/             the tutorial's scenarios, one patch or script each
.forgejo/            the pipeline terragucci generates for this repo
```

Three environments (dev, staging and prod) with five roots each make 15 roots. Payments in prod is the one that differs: its jobs queue has a dead-letter queue.

The roots are plain AWS code. Everything that points them at floci instead of AWS is in the pipeline's `env` block.

## Scenarios

| Scenario | The change |
|---|---|
| `one-root` | dev orders keeps unclaimed jobs for seven days |
| `unformatted` | dev orders gains a file `tofu fmt` would rewrite |
| `module-bump` | every queue waits 60 seconds before retrying a job |
| `replace` | prod search keys its records table by `sku`, which replaces the table |
| `destroy` | staging email drops its records table |
| `float` | dev search lets the AWS provider version float |
| `drift` | staging orders' jobs queue is deleted outside Terraform |
| `pin` | `modules/service` is published as 1.1.0 and the first rollout wave's pull request opens |

From the terragucci repo, `just example change <scenario>` opens a pull request with one of them.
