---
title: Report JSON schema
description: The fields of report.json, which every plan, apply and drift run writes beside its HTML report.
---

`report.json` sits beside every `report.html`, and the HTML also carries it inline. A script handed only the HTML still has the data:

```bash
sed -n '/id="terragucci-report"/,/<\/script>/p' report.html | sed '1d;$d' | jq '.named[] | select(.action == "delete") | .address'
```

## Fields

| Field | Holds |
|---|---|
| `schema` | `terragucci.report/v1`; a minor version only adds fields |
| `run` | project, commit, base, stage, binary, runtime, start and finish times, and the job |
| `run.commit_url`, `run.pull_request`, `run.pull_request_url` | the commit's page, and the pull or merge request the run planned with its page |
| `run.report_url` | where this `report.html` is served from the bucket, when `reports.url` is set |
| `run.trace_id`, `run.trace_url` | the run's trace, when the stage sent one, and its link when `telemetry.trace_url` is set |
| `groups[]` | a stable id per normalized change, its roots and the change |
| `totals` | the run's changes by action, over the roots whose plan can apply; a root the policy denied is left out, though its `changes` stay in the report. GitLab's `reports:terraform` counts are read from it |
| `roots[]` | path, plan digest, counts by action, its group, its changes and why it is open |
| `waves[]` | number, roots, set digest, approval state and a link to the approval record |
| `named[]` | every destroy, replacement and refusal by address, and every import and forget apart from them |
| `roots[].plan` | paths to the root's full plan text and JSON, and the job that ran it |
| `deferred[]` | Terragrunt units planned after the units they wait for apply, and what each waits for |
| `mock_reads[]` | Terragrunt dependencies that would have read `mock_outputs`, with the upstream and the reason |
| `roots[].terragrunt` | for a Terragrunt unit: its stack, why it was selected, whether its plan is a provisional preview, and its result in Terragrunt's run report |
| `intent` | the description check's decision: its status, whether it flagged the pull request, the decision in a sentence, the probability and threshold, the model and the destroys and replacements the text leaves out; present only after `respond description` ran on the report |
| `policy` | the run's policy check, when `policy` is on: the engine, the input mode, the namespace, whether the policy came from the checkout or the base branch, the roots it failed and how many warnings it gave |
| `roots[].policy` | the policy's verdict on the root's plan: `passed`, `denied` or `error`, the denial messages, the warnings and, for `error`, why it could not run. A denied root is `failed` and keeps its `changes`, so the report shows what was refused |
| `redaction` | the marker that replaced sensitive values, and how many it replaced |
| `tips[]` | advice, each with the rule that produced it; absent with `tips: false` |
| `timings` | the run's roots or Terragrunt units, slowest first, and its slowest resource instances across roots |
| `roots[].timings` | the root's wall time, its plan's and, on a `tf-apply` wave, its apply's (`apply_seconds`); the slowest resources, provider calls, provider start-up and lock waits from the binary's spans; the summed spans of a large estate; `source: terragrunt` when the times come from Terragrunt's run report; and a `note` when the binary sent nothing per resource |

The JSON Schema ships with the package as `@intentius/terragucci/report.schema.json`. A minor version of `terragucci.report/v1` only adds fields, so a reader that ignores fields it does not know keeps working.

## Reading it

| To find | Read |
|---|---|
| every destroy, replacement and refusal | `named[]`, filtered on `action` |
| the roots a group folds | `groups[].units`, matched to `roots[].path` |
| the digest an approval binds | `waves[].set_digest`, over each root's `roots[].plan_digest` |
| why a root is shown open | `roots[].why` |
| the full plan of a root | `roots[].plan` |
| the slowest resources of a run | `timings.resources`, then `roots[].timings.resources` |
| how long a root waited for its state lock | `roots[].timings.lock_waits`, with the attempts it took |
| what the policy denied or warned about in a root | `roots[].policy` |
| the trace of the run, to search your tracing backend | `run.trace_id` |

Approvals stay on your repo's `chant/lifecycle` branch. The report links to each record and never copies it, so the branch is the one record of who approved what.
