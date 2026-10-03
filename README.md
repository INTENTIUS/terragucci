# terragucci

The whole Terraform lifecycle, handled. Every pull request gets one grouped plan note, and every merge goes out in approved waves while terragucci watches for drift.

It runs whichever binary you already use; [Which binary you run](https://intentius.io/terragucci/getting-started/binaries/) lists them. Pipelines run on your forge's CI, or a fountain steward takes apply and drift for durable runs.

The site is [intentius.io/terragucci](https://intentius.io/terragucci/). Build progress lives on its [status page](https://intentius.io/terragucci/status/).

## For agents

Setting terragucci up with a coding agent? Paste this prompt into it.

```text
Set up terragucci in this repository.
Read https://intentius.io/terragucci/llms.txt first, then
https://intentius.io/terragucci/getting-started/agents/ and follow it.
Check https://intentius.io/terragucci/status/ before using any feature.
Do not apply anything. Open a pull request with the result.
```

`llms.txt` lists every page and `llms-full.txt` holds their text. An agent working on this repo itself reads [AGENTS.md](AGENTS.md) instead.

## Working on this repo

[CONTRIBUTING.md](CONTRIBUTING.md) is the guide for contributors.

## Licence

The licence is Apache 2.0, in [LICENSE](./LICENSE).
