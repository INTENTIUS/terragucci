---
title: Approvals as records in your repo
description: Why an approval is a commit on a branch of your own repo.
---

An approval is a record on your repository's `chant/lifecycle` branch. [`terragucci approve`](/terragucci/reference/cli/#approve) writes it, naming the plan it approves.

| Question | Answer |
|---|---|
| What does a record hold? | the wave's stage and set digest; no plans and no report. The report links the record, so the branch alone says who approved what |
| Why a branch? | each approval is a commit `git log` can show, kept with the code across CI tools; every runtime reads the one branch, so a laptop approval counts wherever the apply runs |
| Why does it name the plan? | a changed plan needs a new approval, and a refusal is the safe outcome; [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) recovers from one |
| Who can write one? | any writer, or a GitHub job with `contents: write`, can push a line naming someone |
| Who approves? | people; terragucci writes no code that approves for an agent, agent recipes only comment and open pull requests, and no agent holds or is listed with a signing key |

## Valid approvals

A pushed line counts and binds the plans under the default `approval: ledger`, where any writer can name any person; `pr-review` also counts a review, and `sealed` only a sealed line ([Approval modes](/terragucci/standards/access-and-identity/#approval-modes)). The mode is read from `terragucci.yml` at base, and under `sealed` the signers file and [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) too.

These files come from the applied commit's first parent, so a change cannot judge itself. Only a multi-commit rebase merge breaks that rule; merge or squash those. [`agent-push`](/terragucci/reference/pipeline/#paths-an-agent-cannot-change) refuses edits to these files. Block force pushes and deletion on `chant/lifecycle` ([per forge](/terragucci/guides/approve-a-wave/#push-access-to-chantlifecycle)).

## Next

- [Waves and approvals](/terragucci/concepts/waves-and-approvals/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [The audit trail](/terragucci/reference/audit-trail/): one record of every project's approvals and applies, with its overrides and refused waves
