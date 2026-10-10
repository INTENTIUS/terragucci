<p align="center"><img src="docs-site/public/brand/taco-160.png" width="160" height="96" alt="terragucci's logo, a pixel-art taco with a diamond in it"></p>

# terragucci

One workflow, one audit trail and one policy for every Terraform and OpenTofu repo, run in your own CI. Plan, approve and apply hundreds of roots from pull requests and trace every run.

CI does this: each job runs in your forge's CI and lands in your git and your bucket, with no account to create and no platform to sign in to.

| You get | How |
|---|---|
| [No server to host](https://intentius.io/terragucci/concepts/how-it-works/#components) | Every job runs in your CI. State, plan reports and approvals stay in your git and your bucket. |
| [Built for many roots](https://intentius.io/terragucci/concepts/why-plans-are-grouped/) | One grouped note for 200 plans. Canary roots apply first, then the rest in [waves](https://intentius.io/terragucci/concepts/waves-and-approvals/). An approval covers exactly the plans it was shown, and a plan that changed after it is refused. |
| [A trace of every run](https://intentius.io/terragucci/guides/send-traces-and-metrics/) | One OpenTelemetry trace per stage run, with a span per root and the binary's own spans inside it (lock waits and slow provider calls with choudoufu). Metrics and dashboards come with it. |

Works with:

- Forges: [GitHub, GitLab and Forgejo](https://intentius.io/terragucci/guides/add-to-a-repo/#per-forge)
- Buckets: [S3, GCS and Azure Blob](https://intentius.io/terragucci/guides/keep-reports-in-a-bucket/), reached over [OIDC with no stored keys](https://intentius.io/terragucci/reference/pipeline/#credentials)
- Binaries: [Terraform, OpenTofu](https://intentius.io/terragucci/guides/use-a-binary/), [Terragrunt](https://intentius.io/terragucci/guides/use-terragrunt/) and [choudoufu](https://intentius.io/terragucci/guides/use-a-binary/#choudoufu)
- Also: [drift checks](https://intentius.io/terragucci/guides/turn-on-drift-checks/), [module publishing](https://intentius.io/terragucci/guides/publish-modules/) and [pinned rollouts](https://intentius.io/terragucci/guides/roll-out-a-module-version/)

[Pull request automation](https://intentius.io/terragucci/#pull-request-automation) lists what runs on a pull request (re-plans, locks, apply before merge, approvals) as plain CI jobs. Only the four opt-in agent features (agent comment, drift agent, review and refused-wave summary) run a model. Every pipeline feature on the site is proven by a smoke claim on a local Forgejo; the per-forge claims list what is also proven on GitHub and GitLab ([validation](https://intentius.io/terragucci/reference/validation/)).

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

The site is [intentius.io/terragucci](https://intentius.io/terragucci/); [Architecture](https://intentius.io/terragucci/concepts/how-it-works/) follows one change through its lifecycle.

## For agents

Paste this prompt into a coding agent to set terragucci up.

```text
Set up terragucci in this repository.
Read https://intentius.io/terragucci/llms.txt first, then
https://intentius.io/terragucci/getting-started/agents/ and follow it.
Open a pull request with the result.
Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
```

`llms.txt` lists every page and `llms-full.txt` holds their text. After setup an agent reads the estate (down to a root's last apply) and the audit trail over the read-only MCP server `terragucci mcp` ([Read the estate over MCP](https://intentius.io/terragucci/guides/agent-read-over-mcp/)). Agents working on this repo itself follow [AGENTS.md](AGENTS.md).

## Working on this repo

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

terragucci is Apache-2.0 ([LICENSE](./LICENSE)) and there is nothing to buy.
