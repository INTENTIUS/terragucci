# terragucci

CI for Terraform, OpenTofu and Terragrunt, from the pull request to the drift check. Every pull request gets one grouped plan note, and every merge goes out in approved waves while terragucci watches for drift.

It runs whichever binary you already use; [Use OpenTofu or choudoufu](https://intentius.io/terragucci/guides/use-a-binary/) lists them. Pipelines run on your forge's CI.

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

The site is [intentius.io/terragucci](https://intentius.io/terragucci/), and [How terragucci works](https://intentius.io/terragucci/concepts/how-it-works/) follows one change from pull request to drift. Its [validation page](https://intentius.io/terragucci/reference/validation/) lists every check the generated pipelines pass.

[How terragucci compares](https://intentius.io/terragucci/compare/) sets it beside Atlantis, HCP Terraform, Spacelift and Digger.

## For agents

Setting terragucci up with a coding agent? Paste this prompt into it.

```text
Set up terragucci in this repository.
Read https://intentius.io/terragucci/llms.txt first, then
https://intentius.io/terragucci/getting-started/agents/ and follow it.
Do not apply anything. Open a pull request with the result.
Never approve or run chant approve; never merge.
```

`llms.txt` lists every page and `llms-full.txt` holds their text. An agent working on this repo itself reads [AGENTS.md](AGENTS.md) instead.

## Working on this repo

[CONTRIBUTING.md](CONTRIBUTING.md) is the guide for contributors.

## Licence

The licence is Apache 2.0, in [LICENSE](./LICENSE).
