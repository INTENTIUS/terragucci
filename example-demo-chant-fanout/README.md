# The demo's fan-out estate

The tree `stack/demo.sh` pushes to `<admin>/demo-chant-fanout` for the
`fan-out` scenario. It is chant's `examples/fan-out-estate`: fifteen
CloudFormation stacks, each deployed on its own, in the stack's floci.

```
                         network
                        /       \
                 cluster-a       cluster-b
                /  /  / \ \ \    /  /  / \ \ \
           app-01 ..... app-06  app-07 ..... app-12
```

No file lists that order. Each component says what it depends on
(`dependsOn` in `*.component.ts`), and each stack's template takes its
upstream's outputs as parameters (`src/<stack>/params.ts`), filled by the
component's `stackOutput` inputs. chant derives the waves from the change.

## What differs from chant's example

- The components are written as plain data with type imports only, and
  `chant.config.ts` has no imports, so a checkout with no `node_modules`
  evaluates them: behold draws the estate from its view checkout.
- `chant.config.ts` has one environment, `demo`, at `http://floci:4566`, where
  the jobs reach floci on the stack's network.
- `package.json` pins chant and its aws lexicon, which
  `stack/demo-chant-fanout.Dockerfile` installs into the job image, and keeps
  only the build and lint scripts.
- `.forgejo/workflows/chant-pr.yml` is chant's pull-request pipeline: `chant
  components pr-plan` on each pull request and `pr-apply --require-review` on
  each push to main. Each job also builds and lints the templates. chant reads
  the deployed outputs of a stack the change does not reach, and its `--report-url` copies each
  stage's events, report and change set to floci as it runs.

## The scenario

`scenarios/fan-out/pull/` is the pull request: network's topic gets a display
name with the cycle in it, and cluster-a gains a FIFO queue whose name lacks
`.fifo`, which builds and lints and which SQS refuses at apply. On merge,
cluster-a fails, its six apps are blocked, and cluster-b and its six apps
apply. `scenarios/fan-out/fix/` is the second pull request, which adds the
`.fifo` and applies cluster-a and its six apps. `scenarios/fan-out-fix/about.json` is
the fix's own card, which demo.json's `about` carries during the fix's steps; it
is a card, not a scenario. Each reset applies the base
again, so the next cycle fails the same way.
