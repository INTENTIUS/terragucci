# terragucci

CI for Terraform, OpenTofu and Terragrunt, from the pull request to the drift check. CI does this: every job runs in your forge's CI and lands in your git and your bucket. No account, no sign-in, no platform.

| You get | How |
|---|---|
| [No server to host](https://intentius.io/terragucci/concepts/how-it-works/#what-runs-where) | every job runs in your forge's CI and writes to your repo and your bucket |
| [GitHub, GitLab or Forgejo](https://intentius.io/terragucci/guides/add-to-a-repo/#per-forge) | one init writes the pipeline in your forge's own format |
| [Object storage on AWS, GCP or Azure](https://intentius.io/terragucci/reference/pipeline/#credentials) | state, plan reports and the estate page stay in your S3, GCS or Azure Blob storage; with `oidc` set, CI reaches them with no stored keys |
| [Tracing and metrics](https://intentius.io/terragucci/guides/send-traces-and-metrics/) | one trace per stage run and the pipeline's numbers as metrics, over OTLP to your collector |
| [Rich lifecycles](https://intentius.io/terragucci/concepts/how-it-works/) | check on every push, plan on the pull request, apply on merge (or before it, on GitHub and Forgejo), and drift on a schedule |
| [Gated waves](https://intentius.io/terragucci/concepts/waves-and-approvals/) | a wave that destroys or replaces waits for an approval bound to its plans |
| [Aggregated plan output](https://intentius.io/terragucci/concepts/why-plans-are-grouped/) | one note groups the roots taking the same change and names every destroy |
| [Module publishing and pinned rollouts](https://intentius.io/terragucci/guides/publish-modules/) | version modules on merge, then move each pin one wave of pull requests at a time |

It runs whichever binary you already use; [Choose Terraform, OpenTofu, Terragrunt or choudoufu](https://intentius.io/terragucci/guides/use-a-binary/) compares them.

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

The site is [intentius.io/terragucci](https://intentius.io/terragucci/), and [How terragucci works](https://intentius.io/terragucci/concepts/how-it-works/) follows one change from pull request to drift. Its [validation page](https://intentius.io/terragucci/reference/validation/) lists every check the generated pipelines pass.

## For agents

Setting terragucci up with a coding agent? Paste this prompt into it.

```text
Set up terragucci in this repository.
Read https://intentius.io/terragucci/llms.txt first, then
https://intentius.io/terragucci/getting-started/agents/ and follow it.
Open a pull request with the result.
Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
```

`llms.txt` lists every page and `llms-full.txt` holds their text. An agent working on this repo itself reads [AGENTS.md](AGENTS.md) instead.

## Working on this repo

[CONTRIBUTING.md](CONTRIBUTING.md) is the guide for contributors.

## Licence

The licence is Apache 2.0, in [LICENSE](./LICENSE).
