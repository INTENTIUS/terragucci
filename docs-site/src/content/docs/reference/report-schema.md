---
title: Report JSON schema
description: The fields of report.json, which every plan, apply and drift run writes beside its HTML report.
prompt: |
  Read https://intentius.io/terragucci/reference/report-schema/.
  Write a jq script that reads terragucci-report/report.json and prints every destroy and replacement by address, with its root and the wave that applies it.
  Read only. Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

`report.json` sits beside every `report.html`, which also carries it inline:

```bash
sed -n '/id="terragucci-report"/,/<\/script>/p' report.html | sed '1d;$d' | jq '.named[] | select(.action == "delete") | .address'
```

## Fields

| Field | Holds |
|---|---|
| `schema` | `terragucci.report/v1`; a minor version only adds fields |
| `minor` | the minor version of the schema the report was written with |
| `run` | project, commit, base, stage, binary, runtime, start and finish times, and the job |
| `run.wave`, `run.terragucci` | the wave a `tf-apply` report is for, and the terragucci version that wrote the report |
| `run.commit_url`, `run.pull_request`, `run.pull_request_url` | the commit's page, and the pull or merge request the run planned with its page |
| `run.report_url` | where this `report.html` is served from the bucket, when `reports.url` is set |
| `run.trace_id`, `run.trace_url` | the run's trace, when the stage sent one, and its link when `telemetry.trace_url` is set |
| `change_set` | the set digest over every root's plan digest, the same digest [`chant`](/terragucci/concepts/glossary/#chant) gives the change set |
| `unit`, `units` | what the groups count: `member` or `instance`, and how many |
| `groups[]` | a stable id per normalized change, its roots and the change |
| `totals` | the run's changes by action, over the roots whose plan can apply; a root the policy denied is left out, though its `changes` stay in the report. GitLab's `reports:terraform` counts come from it |
| `roots[]` | path, plan digest, counts by action, its group, its changes and why it is open |
| `waves[]` | number, roots, set digest, approval state (`waiting`, `approved` or `not-required` on a `tf-apply` wave, `not-requested` on a plan) and, on a gated wave, the ledger's branch and path; on a waiting wave, `waiting_since`, when it began waiting for an approval of this digest; on a `tf-apply` wave that applied nothing although it planned, `refused`: the `reason` (`approval`, `review` or `override` when its plans changed after one, `policy` when the policy denied a root), the digest `approved` and `by` whom, and the `roots` that moved or were denied; on a waiting `tf-apply` wave under `approval: pr-review`, `review`: the `pull_request` whose approving review of its head would approve the wave and the `url` to review it on; on a plan's wave, `review_digest`, the set digest over the roots whose plan changes something, which `approval: pr-review` binds a review to, and `waits`, whether the gate will hold it |
| `named[]` | every destroy, replacement and refusal by address, and every import and forget apart from them |
| `holes[]` | a resource instance the report could not read a change for, with its root, address and the reason; always present, and empty when nothing is missing |
| `roots[].plan` | paths to the root's full plan text and JSON, and the job that ran it |
| `deferred[]` | Terragrunt units planned once the units they wait for apply, and what each waits for |
| `mock_reads[]` | Terragrunt dependencies that would have read `mock_outputs`, with the upstream and the reason |
| `roots[].terragrunt` | for a Terragrunt unit: its stack, why it was selected, whether its plan is a provisional preview, and its result in Terragrunt's run report |
| `intent` | the description check's decision: status, whether it flagged the pull request, the decision, probability and threshold, model, `state_digest` and the destroys and replacements the text leaves out (`unmentioned`); present only after `respond description` ran on the report |
| `cost` | with `cost` set, on a `tf-plan` run: the estimator, the currency, the monthly change and the totals before and after over the roots estimated, and per root (`roots[]`) the same three figures, the path of the estimator's output (`output`) or why there is no estimate (`error`) |
| `policy` | the policy check, when `policy` is on: engine, input mode, namespace, whether the policy came from the checkout or the base branch, the roots it denied and the warning count; with `policy.override` at base, `overriders` and the denied roots an override stands for, `overridden` |
| `roots[].policy` | the policy's verdict on the root's plan: `passed`, `denied` or `error`, the denial messages, the ids of the rules that denied (`rules`), the warnings and, for `error`, why it could not run; a denied root is `failed` and keeps its `changes` |
| `roots[].policy.override` | the [override](/terragucci/reference/policy/#overriding-a-denial) that stands for the root's plan and rules: `by`, `at`, `rules`, `reason`, `plan_digest`, the ledger line's `digest`, and `sealed`; on a `tf-apply` wave the root then applies and is `planned` |
| `redaction` | the marker that replaced sensitive values, and how many it replaced |
| `tips[]` | advice, each with the rule that produced it; absent with `tips: false` |
| `timings` | the run's roots or Terragrunt units, slowest first, and its slowest resource instances across roots |
| `roots[].resources` | on a `tf-apply` wave, for a root that applied or had nothing to apply: every managed resource it holds afterwards, from the plan's planned values, each with `address`, `type` and `provider`; never a value |
| `roots[].applied_changes` | on a `tf-apply` wave, for a root that applied: what the apply did to each resource (`actions`: `create`, `update`, `replace`, `delete`, `import`, `move` or `forget`), the top-level `attributes` an update or a replacement changed, by name, and `previous_address` for a move; never a value |
| `roots[].state` | on a `tf-apply` wave, for a root that applied or had nothing to apply: the state its backend holds afterwards, read from the object's metadata and never its contents: `backend`, `location` (`s3://<bucket>/<key>` or the local file), `version_id` (S3's version id), `versioning` (`on`, `off` or `unknown`) and a `note` saying why there is no version |
| `roots[].timings` | the root's wall time, its plan's and, on a `tf-apply` wave, its apply's (`apply_seconds`); the slowest resources, provider calls, provider start-up and lock waits from the binary's spans; summed spans of a large estate; `source: terragrunt` when the times come from Terragrunt's run report; and a `note` when the binary sent nothing per resource |

The JSON Schema ships with the package as `@intentius/terragucci/report.schema.json`. [The reports bucket](/terragucci/reference/reports-bucket/) lists where each object lives and the schema of each.

## Reading it

| To find | Read |
|---|---|
| every destroy, replacement and refusal | `named[]`, filtered on `action` |
| the roots a group folds | `groups[].units`, matched to `roots[].path` |
| the digest an approval binds | `waves[].set_digest` of a `tf-apply` wave, over the `roots[].plan_digest` of each root whose plan changes something; a plan's waves carry the same digest as `review_digest` |
| the digest a pull request review binds | `waves[].review_digest` in the plan report, compared with the same digest the wave plans after the merge |
| why a root is shown open | `roots[].why` |
| the full plan of a root | `roots[].plan` |
| the slowest resources of a run | `timings.resources`, then `roots[].timings.resources` |
| how long a root waited for its state lock | `roots[].timings.lock_waits`, with the attempts it took |
| what the policy denied or warned about in a root | `roots[].policy` |
| who overrode a denial, and why | `roots[].policy.override` |
| the trace of the run, to search your tracing backend | `run.trace_id` |

Approvals stay on your repo's [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch. The report names each record's branch and path and never copies it.

## The index and the estate page

Each `index.json` in the bucket is `terragucci.report-index/v1`, with its JSON Schema in the package as `dist/report-index.schema.json`: one row per run, newest first.

| Row field | What it holds |
|---|---|
| `project`, `commit`, `stage`, `wave`, `finished`, `path` | the run, and its directory relative to the index |
| `roots`, `groups`, `totals`, `refused` | the report's counts |
| `failed` | roots that failed to plan or apply |
| `changed` | roots with a change; on a `tf-drift` row, the roots that drifted |
| `approval`, `waiting_since` | a `tf-apply` wave's gate, and when a waiting wave began waiting |
| `applied` | when a `tf-apply` wave finished applying |
| `overridden` | roots the policy denied that a recorded override let through; absent when none |
| `destroys`, `destroys_total` | up to 50 destroys and replacements, and how many there are when the row lists fewer |
| `commit_url`, `pull_request`, `pull_request_url`, `job_url`, `trace_url` | links |

`estate.json` is `terragucci.estate/v1`, which [`terragucci estate`](/terragucci/reference/cli/#estate) builds from those rows alone, with its JSON Schema in the package as `dist/estate.schema.json`:

| Field | What it holds |
|---|---|
| `generated` | when the page was built; every `age_seconds` is as of then |
| `totals` | projects, waiting waves, drifted projects and roots, failed roots, unreadable indexes, `overridden_roots` when an override let a root through, and `resources` when a project has an inventory |
| `projects[]` | each project's latest plan, latest drift check, the waves of its newest applied commit, its waiting waves with `age_seconds`, `status` (`ok`, `no-index` or `error`), `inventory`: its resource count, the count of each type (`types`) and each root's resources with the wave that recorded them (`roots`), and `states`: each root's state location, `versioning` and the version ids its applies left, newest first, each with its commit, wave and `report` |
| `recent[]` | the 20 newest runs across every project |
| `audit` | the [audit trail](/terragucci/reference/audit-trail/) beside the page: `page`, `entries` and `generated`, when `terragucci audit` wrote one |
| `history` | the resource history beside the page: `page`, how many addresses it holds (`resources`) and `generated`, once an apply changed a resource; each listed resource with a history links its section as `history` |

Each project's `inventory.json` is `terragucci.inventory/v1`, with its JSON Schema in the package as `dist/inventory.schema.json`. A `tf-apply` wave's upload replaces the list of each root it applied, unless the file holds a newer one.

| Field | What it holds |
|---|---|
| `roots[]` | by root path: `root`, the `commit`, `wave` and `finished` time of the wave that recorded the list, the wave's directory as `path`, relative to the project's `index.json`, and `resources`, each with `address`, `type` and `provider` |

Each project's `changes.json` is `terragucci.changes/v1`, with its JSON Schema in the package as `dist/changes.schema.json`: one row per resource each applied `tf-apply` wave changed, newest first, up to 20,000 rows. A rerun of the same wave replaces its rows.

| Row field | What it holds |
|---|---|
| `address`, `type`, `actions`, `attributes`, `previous_address` | what the wave did to the resource, as in `roots[].applied_changes` |
| `root`, `commit`, `wave`, `finished`, `path` | the root and the wave, and the wave's directory relative to the project's `index.json` |
| `plan_digest`, `set_digest` | the root's plan digest, and the wave's set digest, which its approval binds |
| `pull_request` | the pull or merge request the wave applied |

`history.json` beside the page is `terragucci.history/v1`, with its JSON Schema in the package as `dist/history.schema.json`. `terragucci estate` builds it from every project's `changes.json` and the audit trail.

| Field | What it holds |
|---|---|
| `generated` | when it was built |
| `audit` | whether `audit.jsonl` was read for the approvers |
| `resources[]` | each address by `project` and `root`, with its `type`, its `id` (the anchor on `history.html`) and `applies`, oldest first: the row's actions, attributes, commit, wave, time and digests, the `report` link, and `approver` from the wave's apply entry in the audit trail, with that entry's `approval` id; `approver` is `null` when no gate held the wave, and absent when the audit trail has no entry for it |

## State versions

A project's `states.json` holds the version ids its roots' applies left, never a state's contents. Its `schema` is `terragucci.state-versions/v1`, checked by `dist/state-versions.schema.json`. When a wave uploads its report, every root it applied adds its version, unless the root already lists that version. A root keeps its newest 20.

| Field | What it holds |
|---|---|
| `roots[].root`, `backend`, `location` | the root, its backend type, and `s3://<bucket>/<key>` or the local file |
| `roots[].versioning`, `note` | `on`, `off` or `unknown` as the newest apply found it, and why there is no version |
| `roots[].checked` | when that apply finished |
| `roots[].versions[]` | newest first: `version_id`, the `commit`, `wave` and `finished` time of the wave that recorded it, and its directory as `path` |
