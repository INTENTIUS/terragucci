---
title: Why plans are grouped
description: What grouping does to two hundred plans, what it never folds away, and why no approval is bound to it.
---

A shared module change can reach two hundred roots with near-identical plans, and a reviewer scrolling for the odd one out can miss a destroy.

## What grouping does

terragucci normalizes each root's changes and groups the roots whose changes are the same:

```text
180 roots: identical change (update aws_iam_role.app, tags)
 15 roots: the same, plus replace aws_lambda_function.worker
  5 roots: read these individually
destroys: prod-eu/db (delete aws_db_instance.main)
```

A hundred and eighty identical updates become one line with a count. The reviewer reads the change once, and reads the 20 roots that differ.

## What it never folds

Destroys, replacements, refusals, imports and forgets are always named, never grouped; a forget is not counted as a destroy.

The report opens on those and on:

- roots that differ from every group
- IAM and security group changes
- KMS and DNS changes

It folds:

- groups of identical changes
- updates to tags or descriptions only
- values known after apply
- roots with no changes

## Nothing is summarized away

Each root and group in the report links to its full plan, which is kept as printed and as JSON.

## No approval is bound to the summary

Approvals bind the plan digests, taken before redaction or rendering, so changing how the summary reads never changes what was approved.

## Where to go next

- [The plan report](/terragucci/reference/report/) shows the note, the HTML report and the JSON.
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
