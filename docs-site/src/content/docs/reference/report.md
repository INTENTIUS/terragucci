---
title: The plan report
description: One JSON document per run, rendered as the pull-request note, a self-contained HTML report and an index of every past report.
---

Each `tf-plan`, `tf-apply` wave and `tf-drift` run writes one report. The report is a JSON document, and everything a person reads is rendered from it.

## Running it

The pipeline's plan job runs the stage for every pull request and merge request. The report's note becomes the one plan note, and the `terragucci/plan` status takes its counts from the report. GitHub and Forgejo keep the report as the run's `terragucci-report` artifact, and the note links to the run. GitLab keeps it with the job's artifacts, where the note links to the HTML report. Its merge-request widget reads `gitlab-terraform.json`.

To run the stage yourself, from the repo:

```bash
npx terragucci stage tf-plan
```

It plans every root, prints the grouped summary, and writes the run's report to `terragucci-report/`:

| File | What it is |
|---|---|
| `report.json` | the report |
| `report.html` | the HTML report |
| `note.md` | the plan note |
| `summary.txt` | the grouped summary, as the job log shows it |
| `gitlab-terraform.json` | the counts for GitLab's merge-request widget |
| `roots/<root>/plan.txt` | the root's full plan, as the binary printed it |
| `roots/<root>/plan.json` | the same plan as `show -json`, with sensitive values redacted |

`--out <dir>` writes it somewhere else. `--report-url <url>` is where the note links the HTML report, when it is not beside the note. `--root <glob>` plans only matching roots. `--layers`, `--binary`, `--canary` and `--bucket` (with `--bucket-endpoint` and `--bucket-prefix`) are how the pipeline passes the roots, binary, canary wave and bucket it was written with; each overrides `terragucci.yml`. A Terragrunt repo's units are planned with one `terragrunt run --all` per wave. `--json` prints one result object instead of the summary. The stage exits 1 when a root refuses to plan, and still writes the report.

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
- changes to types where one wrong value reaches far, each marked with why;
- anything declared with `prevent_destroy`;
- inside a group, the attributes that differ from root to root.

The types that are highlighted, and the reason the report gives:

| Types | Why |
|---|---|
| IAM: `aws_iam_*`, `google_*_iam_*`, `azurerm_role_assignment`, Kubernetes roles and bindings | changes who may do what |
| `aws_security_group`, its rules, `google_compute_firewall`, `azurerm_network_security_*` | changes what traffic gets in or out |
| `aws_network_acl` and its rules | changes what traffic a subnet allows |
| `aws_kms_*`, `google_kms_*`, `azurerm_key_vault_key` | data encrypted under the key depends on it |
| `aws_route53_*`, `google_dns_*`, `azurerm_dns_*`, Cloudflare records | changes where names resolve |

A change to one of these that only touches tags stays folded.

Folded, one click away:

- each group of identical changes, shown as one diff and a root count;
- updates that only touch tags or descriptions;
- values known only after apply;
- roots with no changes.

## Back to the full plan

Nothing is summarized away. Every root's full plan is kept beside the report, as the binary printed it and as JSON. Every group, root and named change in the HTML links to that plan and to the CI job that produced it. In the plan note, each group links to its place in the report and each destroy to its root, so one click from the pull request lands on the line you were reading about.

The page opens on two lists: every destroy, replacement and refusal, and the outlier roots and highlighted changes to read first. Both fit on the first screen and neither is ever folded.

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
| `roots[]` | path, plan digest, counts by action, its group, its changes and why it is open |
| `waves[]` | number, roots, set digest, approval state and a link to the approval record |
| `named[]` | every destroy, replacement and refusal by address, and every import and forget apart from them |
| `roots[].plan` | paths to the root's full plan text and JSON, and the job that ran it |
| `roots[].terragrunt` | for a Terragrunt unit: its stack, why it was selected, whether its plan is a provisional preview, and its result in Terragrunt's run report |
| `redaction` | the marker that replaced sensitive values, and how many it replaced |
| `tips[]` | advice, each with the rule that produced it; absent with `tips: false` |

The JSON Schema ships with the package as `@intentius/terragucci/report.schema.json`.

Approvals stay on your repo's `chant/lifecycle` branch. The report links to each record and never copies it, so the branch is the one record of who approved what.

## Sensitive values

`show -json` prints sensitive values in plain text. Before a plan is kept, every value the plan marks sensitive is replaced with `(sensitive, redacted by terragucci)`, and so is the default of every sensitive variable. The report page says how many were replaced. Plan digests are taken before that, inside the job, so an approval binds the plan as it was planned.

A change to a write-only attribute's version (`*_wo_version`) is labelled as such, since the value itself is never in the plan. Ephemeral values last only as long as the run and are not reported as changes. Imports and forgets are named on their own and never counted as destroys; a forget leaves the resource running.

## Where reports are kept

By default a report is a CI artifact of the plan job, kept as long as your forge keeps artifacts.

To keep them longer, name a bucket in `terragucci.yml` and run `npx terragucci init` again; the plan job then copies each report there as well. Any S3-compatible store works, Google Cloud Storage and MinIO included. The job reads its credentials from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, when set, `AWS_SESSION_TOKEN`. Set `endpoint` for a store that is not AWS; without it, `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` is used when set.

```yaml
reports:
  bucket: s3://acme-terragucci
  prefix: reports
```

Reports land under one path per run, the plans beside them. Links in a report are relative, so they work in the bucket as they do in the CI artifact:

```
reports/github.com/acme/infra/2026/10/4f1a9c0/tf-plan/report.html
reports/github.com/acme/infra/2026/10/4f1a9c0/tf-apply-wave-2/report.json
```

## Tips

With `tips` on, which is the default, the report ends with advice on how your roots are set up. It flags modules and providers that float instead of pinning, a missing lock file, a local module so widely shared that every change to it plans every root, and a project with no canary wave. Each tip names the rule behind it, and the code rules are the same ones `chant lint` runs. A tip never fails a run or changes a gate. The plan note shows only how many there are. `tips: false` removes all of it. The rules are listed on [Tips](/terragucci/reference/tips/).

## The report index

Every upload rewrites `index.html` and `index.json` for the project, at the project's path, and for every project, at the top of the prefix. Each run gets a row in the index with its counts and destroys, and the row links to that run's report. Serve the bucket as a static site and the index is the home page for every plan you have run. Retention is your bucket's lifecycle rule.
