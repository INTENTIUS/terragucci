# terragucci

The whole Terraform lifecycle, handled. Every pull request gets one grouped plan note, and every merge goes out in approved waves while terragucci watches for drift.

It runs whichever binary you already use; [Which binary you run](https://intentius.io/terragucci/getting-started/binaries/) lists them. Pipelines run on your forge's CI, or a fountain steward takes apply and drift for durable runs.

The site is [intentius.io/terragucci](https://intentius.io/terragucci/). Build progress lives on its [status page](https://intentius.io/terragucci/status/).

## Working on this repo

```bash
npm install
just check      # the same checks CI runs
just ci         # render the workflows from ci/ and pages/
just site-dev   # serve the docs locally
```

## Licence

The licence is Apache 2.0, in [LICENSE](./LICENSE).
