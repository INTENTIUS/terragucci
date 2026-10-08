---
title: Approvals as records in your repo
description: Why an approval is a commit on a branch of your own repo, and what that gives you over a button in a CI tool.
---

An approval in terragucci is a record on the `chant/lifecycle` branch of your repository. [`chant approve`](/terragucci/concepts/glossary/#chant) writes it, and the record names the plan it approves.

## What a record holds

A record names the wave's stage and set digest; it holds no plans or report. The report links the record, so the branch alone says who approved what.

## Why a branch

Each approval is a commit `git log` can show, kept with the code across CI tools. Every runtime reads the one branch, so a laptop approval counts wherever the apply runs.

## When it is sealed

Any writer, or GitHub job with `contents: write`, can push a line naming someone. Under `approval: ledger`, the default, such a line counts: it binds the plans, not the person. Under `approval: sealed` an approval counts only if sealed by `chant approve --sign` and verified against `.chant/allowed_signers` (or the file `.chant/trust.json` names).

| `approval` | A line counts when | Read from |
|---|---|---|
| `ledger` | it names the wave's digest | `terragucci.yml` at base |
| `sealed` | it names the digest and its seal verifies | `terragucci.yml`, [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) and the signers file at base |

These files come from the applied commit's first parent, so a change cannot judge itself, except a multi-commit rebase merge: merge or squash those. The agent comment refuses edits to either. Block force pushes and deletion on `chant/lifecycle` ([per forge](/terragucci/guides/approve-a-wave/#who-can-push-to-chantlifecycle)).

## Why it names the plan

A changed plan needs a new approval, and a refusal is the safe outcome; [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) recovers from one.

## Who approves

People do. terragucci writes no code that approves for an agent; agent recipes only comment and open pull requests, and no agent holds or is listed with a signing key.

## Where to go next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
