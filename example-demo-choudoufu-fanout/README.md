# The demo's fan-out estate on choudoufu

The tree `stack/demo.sh` pushes to `<admin>/demo-choudoufu-fanout` for the
`fan-out-choudoufu` scenario. It is `example-demo-fanout/`'s fifteen roots as
choudoufu estates: each root's `live` block names its estate (`fo-<root>`) and
the demo's record store, `demo-live-records`. There is no backend and no state
file: each resource has one record of its own.

```
                         network
                        /       \
                 cluster-a       cluster-b
                /  /  / \ \ \    /  /  / \ \ \
           app-01 ..... app-06  app-07 ..... app-12
```

Each cluster reads network's recorded outputs through
`data.terraform_estate_outputs`, and each app reads its cluster's, so the waves
come from the code as in the tofu tree. Every job installs hashicorp/aws 6.67.0
from the demo image's mirror (`TF_CLI_CONFIG_FILE` in `terragucci.yml`).

## The scenario

Its first two chapters are `fan-out-tofu`'s. The pull request
(`scenarios/fan-out-choudoufu/pull/`) sets network's release, and cluster-a
gains a queue under the name network's queue has, which SQS refuses at apply.
cluster-a fails and its six apps are blocked, while cluster-b and its six apps
apply.

The fix (`scenarios/fan-out-choudoufu/fix/`) gives the queue its own name.
While its wave 3 applies app-01, an operator applies
`scenarios/fan-out-choudoufu/operator/app-01/operator.tf` to app-01's estate
from outside the pipeline, with `-target` on its new queue alone. Both land, and
neither waits. Each resource has its own record, written with a condition on
the version read, and nothing is locked across a run (choudoufu's
`model/concurrency` page).

app-01's estate keeps a resource that no code there declares
(`undeclared_tagged = "keep"`). So the pipeline's apply of its approved plan
neither destroys the operator's queue nor refuses because the estate now holds
it. Every other estate keeps choudoufu's default, `delete`.

## The reset

It has no states to write back:

1. The driver destroys the operator's queue.
2. It pushes the base back. The pipeline then applies the base tree, which
   deletes what the fix added to cluster-a and puts every tag back.
