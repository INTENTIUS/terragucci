---
title: The CLI's JSON output
description: The envelope that init, reconcile, plan, stage, rollout, respond, config check, config identities, forge check and query print with --json, the exit codes behind it, and the outcome stage tf-apply writes.
prompt: |
  Read https://intentius.io/terragucci/reference/cli-json/.
  Write a script that runs `npx terragucci plan --json` and branches on the envelope's `exit` and `status` and on `results.roots`, printing each failed root's summary.
  Read only. Never apply, approve (a pull request review or `terragucci approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

With `--json`, these commands print only one JSON object on stdout.

## The envelope

```json
{
  "schema": 1,
  "command": "init",
  "exit": 0,
  "status": "ok",
  "results": {}
}
```

| Field | Holds |
|---|---|
| `schema` | The envelope version. It changes only when a field is removed or changes meaning; new fields can appear without a bump. |
| `command` | `init`, `reconcile`, `plan`, `stage`, `rollout`, `respond`, `config check`, `config identities`, `forge check` or `query`. |
| `exit` | The process exit code. |
| `status` | `ok` for exit 0, `failed` for 1, `usage` for 2, `waiting` for 3. |
| `results` | What the command found or did, as below. `null` when the command could not run. |
| `error` | Present when `results` is `null`: why it could not run. |

`--json` leaves the [exit codes](/terragucci/reference/cli/#exit-codes) as they are. `stage tf-apply` refuses `--json` and writes [its outcome](#the-apply-outcome) to a file instead, so no envelope carries code 4.

## init

`init --dry-run --json` computes everything and writes nothing.

| Field | Holds |
|---|---|
| `dryRun` | Whether the run wrote files. |
| `roots` | Each root as `path` and `reason`, such as `backend s3`, `cloud block`, `choudoufu live block` (a [choudoufu](/terragucci/concepts/glossary/#choudoufu) estate), `provider aws` or `matches roots glob <glob>`. |
| `layers` | Roots grouped in apply order; roots in one layer can apply together. |
| `binary`, `version`, `forge` | Each as `value` and `reason`, where the reason names the file, flag or detection that decided it. |
| `image` | The CI image the pipeline runs in. |
| `files` | Each file as `path`, `status` (`created`, `updated` or `unchanged`) and `content`. |
| `notes` | Settings the pipeline does not act on, and flags the config overrides. |
| `configNote` | Whether a `terragucci.yml` was used or written. |

## reconcile

`results` holds `mode` (`dry-run` or `apply`) and `projects`, with these fields per project:

| Field | Holds |
|---|---|
| `key` | The project, as `<host>/<path>`. |
| `status` | `unchanged`, `would-change`, `pull-request` or `failed`. |
| `changes` | The files, as in `init`'s `files`. |
| `pullRequest` | The pull request's URL, when one was opened. |
| `error` | Why the project failed. |
| `tips` | On a dry run with `tips` on, advice on the project's setup, as `rule`, `root`, `message` and `url`. |

The exit code is 1 when any project failed.

## plan

`results.roots` has one entry per root, in apply order:

| Field | Holds |
|---|---|
| `root` | the root's path |
| `ok` | whether it planned |
| `summary` | the plan's `Plan:` or `No changes.` line, or the failure |

## stage

| `results` field | Holds |
|---|---|
| `stage` | the stage that ran |
| `change_set` | the set digest |
| `files` | the report files |
| `uploaded` | the bucket copy; `null` without `reports.bucket` |
| `issue` | `tf-drift` only: `action` (`opened`, `updated`, `closed`, `left-open` or `none`), `issue` and `error` |

A root that refused to plan exits 1.

## The apply outcome

On every exit but a usage error, `stage tf-apply` writes its wave's outcome to the file `TG_OUTCOME_JSON` names. With `--rest` the file holds the last wave that ran. The generated apply jobs set the variable when `notify` is on, and `terragucci notify` reads the file. A waiting wave's file carries the `terragucci approve` command that approves it and where its gate's record lives on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle).

```json
{
  "schema": "terragucci.outcome/v1",
  "status": "waiting",
  "exit": 3,
  "wave": 2,
  "roots": ["envs/prod/app", "envs/prod/db"],
  "line": "wave 2 waits: terragucci approve wave-2 --plan jcs1-sha256:9f2c...",
  "set_digest": "jcs1-sha256:9f2c...",
  "gate": { "name": "wave-2", "branch": "chant/lifecycle", "path": "_gates/tf-apply.jsonl" },
  "approval": "waiting",
  "approval_mode": "pr-review",
  "approve_command": "terragucci approve wave-2 --plan jcs1-sha256:9f2c...",
  "waiting_since": "2026-10-08T14:02:11.000Z",
  "review": { "pull_request": 12, "url": "https://github.com/acme/infra/pull/12/files" }
}
```

| Field | Holds |
|---|---|
| `schema` | `terragucci.outcome/v1`. It changes only when a field is removed or changes meaning; new fields can appear without a bump. |
| `status`, `exit` | `applied` (0), `waiting` (3), `refused` (4; 5 when another run's apply holds a resource it changes; 6 when a newer push superseded it; 8 when a decision point was answered with an answer the gate does not pass on) or `failed` (1; 7 when chant's policy denied the plan) |
| `wave`, `roots` | the wave and its roots (units in a Terragrunt repo); `roots` is empty when the repo has no such wave |
| `line` | the line the job's `terragucci/apply` status carries, when the wave wrote one (`TG_OUTCOME`) |
| `set_digest` | the set digest over the roots that change: what an approval binds |
| `gate` | when a gate held the wave: its `name` and the `branch` and `path` of its ledger |
| `approval` | `waiting`, `approved` or `not-required` |
| `approval_mode` | with a gate: `ledger`, `pr-review` or `sealed`, the mode in force at base |
| `approve_command` | waiting, or refused because the plans moved after an approval or a review: the `terragucci approve` command for `set_digest`, with `--sign` under `sealed` |
| `waiting_since` | waiting: when the wave began waiting for an approval of this digest |
| `review` | waiting under `approval: pr-review`: the `pull_request` whose approving review of its head would approve the wave, and the `url` to review it on |
| `refused` | why the wave applied nothing although it planned: `reason` (`approval`, `review`, `override` or `policy`), the digest `approved` and `by` whom, and the `roots` that moved or were denied |
| `policy_denied` | the roots the policy denied, when no override lets them through |
| `failed_roots` | failed: the roots that failed to plan or apply |

## rollout

`results` holds the state the run left the rollout in.

| Field | Holds |
|---|---|
| `kind`, `name` | `module` or `provider`, and the module or provider address. |
| `from`, `to` | The version that moves and the one it moves to. |
| `discovered` | Where `to` was found, when no version was named: a tag, or an OCI repository. |
| `mode` | `dry-run` or `apply`. |
| `status` | `complete`, `opened`, `would-open`, `waiting` or `stopped`, with `stop` saying why it stopped. |
| `waves` | `wave`, `canary` and `parts`: `project`, `roots`, `branch`, `state`, `pullRequest`, `pending`, `failed`, `files`. |
| `roots` | `project`, `root`, `state` (`from`, `to`, `refused` or `elsewhere`), `version`, `reason`. |
| `tips` | Each refused root's tip, as `rule`, `project`, `root` and `message`. |

A part's `state` is `applied`, `nothing-to-move`, `opened`, `would-open`, `open`, `waiting-apply`, `failed`, `closed` or `not-reached`. Exit 3 means waiting; 1 means stopped.

## respond

| `results` field | Holds |
|---|---|
| `event`, `response`, `text` | the event, the response it got and the text printed |
| `skipped`, `data`, `proposals`, `agent_input` | set only when the response has them |
| `exit` | set when the command exits other than 0 |

`respond rollout` with no module puts `mode` and `rollouts` in `data`: for each rollout in flight, `kind`, `name`, `from`, `to`, `wave` (its newest), `waves`, `action` (`ran`, `waiting`, `stopped`, `done` or `failed`), `reason`, `pullRequests`, and `result`, [the rollout](#rollout) when it ran.

Exit 0 when handled, and 1 when a rollout `respond rollout` continued could not run. An unknown event or a missing flag exits 1 with `results` null.

## config check

`terragucci config check [--config <file>]` lists every problem, and for `.ts` checks that folding and running agree.

| `results` field | Holds |
|---|---|
| `file` | the config file read |
| `ok` | whether it has no problems |
| `problems` | a list of strings; a config with problems exits 1 |
| `approval` | for a repo's own config with no problems: `mode` (`ledger`, `pr-review` or `sealed`), `source` (the key, [`identity.gates`](/terragucci/concepts/glossary/#identitygates), or the default) and a `note` when the repo should change something |
| `warnings` | present when there are some: each role that reaches another environment's state, as text; warnings leave the exit code 0 |
| `tips` | present when there are some and no problems: `rule` and `message` of each [config check tip](/terragucci/reference/tips/#config-check-tips); tips leave the exit code 0 |
| `state_access` | with `oidc.roles` and no problems: one entry per role and stage, with `role`, `stage` (`plan` or `apply`), `environment` (the glob, or `plan_role/apply_role`), `roots`, `states` (the state keys its roots' backends name) and `reads` (other environments' states they read) |

## config identities

`terragucci config identities --json` prints what each job presents to a cloud, per environment and stage, and the trust that accepts those jobs and no other. The [Terraform provider](/terragucci/guides/manage-the-control-repo-with-terraform/#read-the-environments-trust) reads this output, so the trust it writes is the trust this command prints.

| `results` field | Holds |
|---|---|
| `schema` | `terragucci.identities/v1`. It changes only when a field is removed or changes meaning. |
| `file` | the config file read |
| `forge` | `github`, `gitlab` or `forgejo` |
| `repository` | `host`, `path` (`owner/name`, or a GitLab project's full path) and `default_branch`; on Forgejo, `owner_id` and `repo_id` when given |
| `environments` | one entry per environment, in the config's order, then `default` for the roots in no environment when there are any, or when the roots were not read |

Each entry:

| Field | Holds |
|---|---|
| `name` | the environment's name, or `default` |
| `environment` | `false` for `default` |
| `root_globs` | the environment's `roots`; for `default`, the top-level `roots`, or `null` when roots are detected |
| `roots` | the repo's roots in the entry, found as `config check` finds them; `null` for a [control repo](/terragucci/concepts/control-repo/)'s project, or with `--no-roots` |
| `stages` | `plan` (the pull request's plan job), `decide` (each wave's deciding job, as below), `confirm` (with `apply.when: pull-request`, the job the push after a merge runs; `null` otherwise), `apply` (the default branch's apply jobs) and `drift` (the scheduled drift job, `null` when `drift` is off) |

Each stage:

| Field | Holds |
|---|---|
| `runner` | `labels` and `group` (a GitHub runner group, or `null`); `null` when `runner` gives the stage none. For `apply`, the environment's `runner` (its `apply`) over the top-level one; `decide` runs on the top-level apply runner |
| `forge_environment` | for `apply` on GitHub and GitLab, the environment's `forge_environment`, which defaults to its name; `null` for the other stages, on Forgejo, for `default`, and in a Terragrunt repo |
| `token` | `issuer`, `subject` (the `sub` claim), `subject_pattern`, `claims` and `placeholders`, as below |
| `aws` | `role` (`null` when only `oidc.roles` names roles), `root_roles` (roots whose role is another, by `oidc.roles`), `audience` (for `apply`, the environment's `oidc.audience` over `oidc.audience`), `trusts`, and `assume_role_policy`, the role's trust policy as a JSON string with a statement for each stage in `trusts`; `null` without AWS roles |
| `gcp` | `service_account`, `root_service_accounts`, `workload_identity_provider`, `audience` (the provider's full name), `trusts`, and `attribute_condition`, a CEL condition for the provider that holds for each stage in `trusts`; `null` without `oidc.gcp` |
| `azure` | `client_id`, `root_client_ids`, `tenant_id`, and a federated credential's `issuer`, `subject` and `audiences` (`oidc.azure.audience`, by default `api://AzureADTokenExchange`); for a subject pattern, `subject` is `null` and `claims_matching_expression` holds a flexible federated credential's expression; `null` without `oidc.azure` |

The plan, decide, confirm and drift stages take the plan identities, and apply the apply identities. `confirm` presents them on the apply audience. An environment's own `oidc` pair wins over the top-level pair for its roots.

`decide` is set when each environment's roots apply in jobs of their own, or when roles by glob tell the roots apart: each wave then has a job on the default branch that plans every root with the plan identities, on the plan audience, and decides the wave's gate, before each group's apply job. It is `null` when a wave applies in one job, as in a Terragrunt repo. With the roots not read, an entry has `decide` whenever the config has environments.

A role has one trust policy, so `trusts` lists every stage of the entry whose jobs take the same identity, and `assume_role_policy` and `attribute_condition` accept each of them: the plan role's names the plan, deciding, confirm and drift jobs. An Azure client takes a federated credential per subject: give it one for each of those stages' `subject`.

The subject, by forge:

| Forge | `plan` | `apply` | `decide`, `confirm` and `drift` |
|---|---|---|---|
| GitHub | `repo:<owner>/<repo>:pull_request` | `repo:<owner>/<repo>:environment:<forge environment>`; for `default`, `repo:<owner>/<repo>:ref:refs/heads/<default branch>` | `repo:<owner>/<repo>:ref:refs/heads/<default branch>` |
| GitLab | `project_path:<path>:ref_type:branch:ref:*`, a pattern, since a merge request pipeline's token names its source branch | `project_path:<path>:ref_type:branch:ref:<default branch>` | the same as `apply` |
| Forgejo | `repo:<owner>-<owner id>/<repo>-<repo id>:pull_request` | `repo:<owner>-<owner id>/<repo>-<repo id>:ref:refs/heads/<default branch>` | the same as `apply` |

On GitLab an apply job with a forge environment also carries `environment`, `environment_protected` and `ref_protected`, which `claims` lists with the values the trust expects (`"true"` for both protections). AWS reads no claim of a GitLab token but `sub` and `aud`, so an AWS role on GitLab tells jobs apart by their subject and their audience alone. GCP's `attribute_condition` checks `environment`, `environment_protected` and `ref_protected` as well as `sub`. Forgejo has no deployment environments: every apply job on the default branch presents the same subject.

The issuer is `https://token.actions.githubusercontent.com` on github.com and `https://<host>/_services/token` on GitHub Enterprise Server, the instance's URL on GitLab, and `https://<host>/api/actions` on Forgejo. The AWS trust policy names the OIDC provider `arn:<partition>:iam::<account>:oidc-provider/<issuer without https://>` in the role's own account, and checks `aud` and `sub` with `StringEquals`, or `sub` with `StringLike` for a pattern.

`placeholders` lists the parts of `subject` written as `<name>` that the command could not know: Forgejo's `owner-id` and `repo-id` without `--owner-id` and `--repo-id`, and `owner` and `repo` when neither `--repo`, a project key nor the origin remote names the repository. A trust policy that holds a placeholder accepts no token.

## forge check

`terragucci forge check --json` prints a row for each setting [`forge check`](/terragucci/reference/cli/#forge-check) compares. `exit` is 1 when a row is a `mismatch`, or with `--require-clouds` when a cloud row is `not-checked`, and 0 otherwise. The [Terraform provider](/terragucci/guides/manage-the-control-repo-with-terraform/#check-the-live-setup) reads this output.

| `results` field | Holds |
|---|---|
| `schema` | `terragucci.forge-check/v1`. It changes only when a field is removed or changes meaning. |
| `file`, `forge`, `repository` | as in [`config identities`](#config-identities); `default_branch` is the forge's, and on Forgejo `owner_id` and `repo_id` are the forge's when the flags give none |
| `rows` | one per setting: `where` (`github`, `gitlab`, `forgejo`, `aws`, `gcp` or `azure`), `check`, `subject`, `expected`, `found` and `status` |
| `counts` | the number of rows of each status: `match`, `mismatch`, `unknown` and `not-checked` |
| `ok` | `true` when `exit` is 0 |

| `check` | `subject` |
|---|---|
| `repository` | the repository, when the forge would not answer for it; no other forge row follows |
| `environment`, `deployment-branches` | a GitHub forge environment |
| `runner-group` | a GitHub runner group |
| `protected-environment` | a GitLab forge environment |
| `protected-runners` | a GitLab apply runner's tags, as `tags <tag>, <tag>` |
| `variable` | a GitLab variable in an environment, as `<name> in <environment>` |
| `protected-branch` | a Forgejo branch |
| `trust` | an AWS role ARN, a GCP provider's resource name, or an Azure app's client id |

## query

`terragucci query <table> --json` prints the table read. For a ledger table, `results` is the document `chant ledger <table> --json` prints ([`ledger.schema.json`](https://intentius.io/chant/schemas/workspace/ledger/v1/ledger.schema.json)), with `source` added. A bucket table's `results` has the same fields but `$schema` and `contract`.

| `results` field | Holds |
|---|---|
| `source` | `ledger` or `bucket` |
| `table` | the table read |
| `columns` | the column names, in order |
| `at` | the `--at` revision as given, or `null` |
| `filter` | `where`, the clauses as given, and `since`, the instant `--since` named or `null` |
| `total` | the table's rows before the filters |
| `rows` | one object per row the filters kept, by column name; JSON columns are parsed |
| `malformed` | the ledger entries that could not be read and were left out; 0 for a bucket table |

A table, filter or revision that is refused exits 1 with `error` naming its code: `table-unknown`, `filter-invalid`, `revision-unknown` or `ledger-unreadable`.

`terragucci query "<statement>" --json`, the deprecated SQL form, prints `columns`, `rows` (SQL `NULL` is `null`) and `tables`, the row count of each bucket table.
