# The demo's fan-out estate

The tree `stack/demo.sh` pushes to `<admin>/demo-fanout` for the
`fan-out-tofu` scenario: fifteen plain roots in floci, each with its own state
in `demo-fanout-state`, applied by terragucci's pipeline in waves.

```
                         network
                        /       \
                 cluster-a       cluster-b
                /  /  / \ \ \    /  /  / \ \ \
           app-01 ..... app-06  app-07 ..... app-12
```

Each cluster reads network's outputs through `terraform_remote_state`, and each
app reads its cluster's, so the waves come from the code: network, then the two
clusters, then the twelve apps. network sets the `release` every root tags its
resources with, and each cluster passes it on to its apps.

The resources are SQS queues and DynamoDB tables, which floci updates in place.
Every job installs hashicorp/aws 6.67.0 from the demo image's mirror
(`TF_CLI_CONFIG_FILE` in `terragucci.yml`, `stack/demo-yodel/Dockerfile`), so
none downloads it. Each root's `.terraform.lock.hcl` pins it for linux amd64
and arm64.

## The scenario

`scenarios/fan-out-tofu/pull/` is the pull request. network gets release
`r<cycle>`, so all fifteen roots plan a change. cluster-a gains a queue under
the name network's queue has, with another visibility timeout. The plan creates
it, and at apply SQS refuses a second queue of that name with other attributes.

On merge, network applies, cluster-a fails while cluster-b applies, and
cluster-b's six apps apply while cluster-a's six are blocked (terragucci#1161).
`scenarios/fan-out-tofu/fix/` is the second pull request, which gives the queue
a name of its own. Its waves apply cluster-a and its six apps, and the other
eight roots plan no changes. `scenarios/fan-out-tofu-fix/about.json` is the
fix's own card, which demo.json's `about` carries during the fix's steps; it is
a card, not a scenario.
