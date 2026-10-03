---
title: The plan report
description: One JSON document per run, rendered as the pull-request note, a self-contained HTML report and an index of every past report.
---

Each `tf-plan`, `tf-apply` wave and `tf-drift` run writes one report. The report is a JSON document, and everything a person reads is rendered from it.

## What a reviewer sees

| View | Where | What it shows |
|---|---|---|
| Plan note | the pull request or merge request | groups, every destroy by name, the wave plan, the approval command, and a link to the full report |
| HTML report | wherever the report is kept | every group, root and wave, with filters |
| Merge-request widget | GitLab | create, update and delete counts, from a `reports:terraform` artifact |
| Text summary | the job log | the grouped summary |

The plan note stays under your forge's comment limit however many roots change. The detail lives in the HTML report.

## Built for hundreds of plans

If every change plans hundreds of roots, the report is where you read them. It opens on what a reviewer looks for and folds away the rest.

Open and highlighted:

- every destroy, replacement and refusal, with the attributes that forced each replacement;
- the roots whose change differs from every group;
- changes to types where one wrong value reaches far, such as IAM policies, security groups, KMS keys and DNS records, each marked with why;
- inside a group, the attributes that differ from root to root.

Folded, one click away:

- each group of identical changes, shown as one diff and a root count;
- updates that only touch tags or descriptions;
- values known only after apply;
- roots with no changes.

## Back to the full plan

Nothing is summarized away. Every root's full plan is kept beside the report, as the binary printed it and as JSON. Every group, root and named change in the HTML links to that plan and to the CI job that produced it. In the plan note, each group links to its place in the report and each destroy to its root, so one click from the pull request lands on the line you were reading about.

The HTML report is one file that makes no network calls, so it opens the same wherever you copy it. Its filters narrow the page to what one reviewer owns, and destroys stay pinned above every filter. It follows the reader's light or dark setting.

## What a script reads

`report.json` sits beside every `report.html`. The HTML also carries it inline, so a script handed only the HTML still has the data:

```bash
sed -n '/id="terragucci-report"/,/<\/script>/p' report.html | sed '1d;$d' | jq '.named[] | select(.action == "delete") | .address'
```

| Field | Holds |
|---|---|
| `schema` | `terragucci.report/v1`; a minor version only adds fields |
| `run` | project, commit, base, stage, binary, runtime, start and finish times |
| `groups[]` | a stable id per normalized change, its roots and the change |
| `roots[]` | path, plan digest, counts by action and its group |
| `waves[]` | number, roots, set digest, approval state and a link to the approval record |
| `named[]` | every destroy, replacement and refusal by address |
| `roots[].plan` | paths to the root's full plan text and JSON, and the job that ran it |
| `tips[]` | advice, each with the rule that produced it; absent with `tips: false` |

Approvals stay on your repo's `chant/lifecycle` branch. The report links to each record and never copies it, so the branch is the one record of who approved what.

## Where reports are kept

By default a report is a CI artifact, kept as long as your forge keeps artifacts.

To keep them longer, name a bucket. Any S3-compatible store works, Google Cloud Storage and MinIO included.

```yaml
reports:
  bucket: s3://acme-terragucci
  prefix: reports
```

Reports land under one path per run:

```
reports/github.com/acme/infra/2026/10/4f1a9c0/tf-plan/report.html
reports/github.com/acme/infra/2026/10/4f1a9c0/tf-apply-wave-2/report.json
```

## Tips

With `tips` on, which is the default, the report ends with advice on how your roots are set up. It flags modules and providers that float instead of pinning, a missing lock file, a local module so widely shared that every change to it plans every root, and a project with no canary wave. Each tip names the rule behind it, and the code rules are the same ones `chant lint` runs. A tip never fails a run or changes a gate. The plan note shows only how many there are.

## The report index

Every upload rewrites `index.html` and `index.json` for the project and for the whole bucket. Each run gets a row in the index with its counts and destroys, and the row links to that run's report. Serve the bucket as a static site and the index is the home page for every plan you have run. Retention is your bucket's lifecycle rule.
