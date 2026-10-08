---
title: Report JSON schema
description: The fields of report.json, which every plan, apply and drift run writes beside its HTML report.
prompt: |
  Read https://intentius.io/terragucci/reference/report-schema/.
  Write a jq script that reads terragucci-report/report.json and prints every destroy and replacement by address, with its root and the wave that applies it.
  Read only. Never run apply, `chant approve` or `--mode apply`, and never merge.
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
| `waves[]` | number, roots, set digest, approval state (`waiting`, `approved` or `not-required` on a `tf-apply` wave, `not-requested` on a plan) and, on a gated wave, the ledger's branch and path; on a waiting wave, `waiting_since`, when it began waiting for an approval of this digest; on a plan's wave, `review_digest`, the set digest over the roots whose plan changes something, which `approval: pr-review` binds a review to, and `waits`, whether the gate will hold it |
| `named[]` | every destroy, replacement and refusal by address, and every import and forget apart from them |
| `holes[]` | a resource instance the report could not read a change for, with its root, address and the reason; always present, and empty when nothing is missing |
| `roots[].plan` | paths to the root's full plan text and JSON, and the job that ran it |
| `deferred[]` | Terragrunt units planned once the units they wait for apply, and what each waits for |
| `mock_reads[]` | Terragrunt dependencies that would have read `mock_outputs`, with the upstream and the reason |
| `roots[].terragrunt` | for a Terragrunt unit: its stack, why it was selected, whether its plan is a provisional preview, and its result in Terragrunt's run report |
| `intent` | the description check's decision: status, whether it flagged the pull request, the decision, probability and threshold, model, `state_digest` and the destroys and replacements the text leaves out (`unmentioned`); present only after `respond description` ran on the report |
| `policy` | the policy check, when `policy` is on: engine, input mode, namespace, whether the policy came from the checkout or the base branch, the roots it failed and the warning count |
| `roots[].policy` | the policy's verdict on the root's plan: `passed`, `denied` or `error`, the denial messages, the warnings and, for `error`, why it could not run; a denied root is `failed` and keeps its `changes` |
| `redaction` | the marker that replaced sensitive values, and how many it replaced |
| `tips[]` | advice, each with the rule that produced it; absent with `tips: false` |
| `timings` | the run's roots or Terragrunt units, slowest first, and its slowest resource instances across roots |
| `roots[].timings` | the root's wall time, its plan's and, on a `tf-apply` wave, its apply's (`apply_seconds`); the slowest resources, provider calls, provider start-up and lock waits from the binary's spans; summed spans of a large estate; `source: terragrunt` when the times come from Terragrunt's run report; and a `note` when the binary sent nothing per resource |

The JSON Schema ships with the package as `@intentius/terragucci/report.schema.json`.

## Reading it

| To find | Read |
|---|---|
| every destroy, replacement and refusal | `named[]`, filtered on `action` |
| the roots a group folds | `groups[].units`, matched to `roots[].path` |
| the digest an approval binds | `waves[].set_digest`, over each root's `roots[].plan_digest` |
| the digest a pull request review binds | `waves[].review_digest` in the plan report, compared with the same digest the wave plans after the merge |
| why a root is shown open | `roots[].why` |
| the full plan of a root | `roots[].plan` |
| the slowest resources of a run | `timings.resources`, then `roots[].timings.resources` |
| how long a root waited for its state lock | `roots[].timings.lock_waits`, with the attempts it took |
| what the policy denied or warned about in a root | `roots[].policy` |
| the trace of the run, to search your tracing backend | `run.trace_id` |

Approvals stay on your repo's [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch. The report names each record's branch and path and never copies it.

## The index and the estate page

Each `index.json` in the bucket is `terragucci.report-index/v1`: one row per run, newest first.

| Row field | What it holds |
|---|---|
| `project`, `commit`, `stage`, `wave`, `finished`, `path` | the run, and its directory relative to the index |
| `roots`, `groups`, `totals`, `refused` | the report's counts |
| `failed` | roots that failed to plan or apply |
| `changed` | roots with a change; on a `tf-drift` row, the roots that drifted |
| `approval`, `waiting_since` | a `tf-apply` wave's gate, and when a waiting wave began waiting |
| `applied` | when a `tf-apply` wave finished applying |
| `destroys`, `destroys_total` | up to 50 destroys and replacements, and how many there are when the row lists fewer |
| `commit_url`, `pull_request`, `pull_request_url`, `job_url`, `trace_url` | links |

`estate.json` is `terragucci.estate/v1`, which [`terragucci estate`](/terragucci/reference/cli/#estate) builds from those rows alone:

| Field | What it holds |
|---|---|
| `totals` | projects, waiting waves, drifted projects and roots, failed roots, unreadable indexes |
| `projects[]` | each project's latest plan, latest drift check, the waves of its newest applied commit, its waiting waves with `age_seconds`, and `status` (`ok`, `no-index` or `error`) |
| `recent[]` | the 20 newest runs across every project |
