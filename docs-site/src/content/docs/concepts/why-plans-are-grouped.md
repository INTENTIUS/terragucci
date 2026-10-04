---
title: Why plans are grouped
description: What grouping does to two hundred plans, what it never folds away, and why no approval is bound to it.
---

Nobody reads two hundred plan logs. A change to a shared module can reach two hundred roots. Almost all the plans are identical, and the odd one out matters most. A reviewer who has to find it by scrolling will skim, and a destroy can slip through a skim.

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

Destroys, replacements and refusals are listed by name. None is ever part of a group, so a destroy cannot hide inside "180 roots". Imports and forgets are named on their own too, and a forget is not counted as a destroy.

The report opens on those. Roots that differ from every group stay open too, along with IAM, security group, KMS and DNS changes, where one wrong value reaches far. The rest is folded away. That covers groups of identical changes and updates that touch only tags or descriptions. It also covers values known after apply and roots with no changes.

## Nothing is summarized away

Grouping decides what to read first. It does not replace the plans. Every root's full plan is kept beside the report, both as the binary printed it and as JSON. The report links each group, root and named change to that plan. The summary sends a reviewer to the right plan.

## No approval is bound to the summary

The summary is a view. Approvals bind the plan digests underneath it. Those are taken inside the job before anything is redacted or rendered. Two different summaries of the same plans therefore sit under the same approval, and a change to how the summary reads never changes what a person approved.

## Where to go next

- [The plan report](/terragucci/reference/report/) shows the note, the HTML report and the JSON.
- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
