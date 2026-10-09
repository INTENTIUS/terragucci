---
title: Approvals as records in your repo
description: Why an approval is a commit on a branch of your own repo.
---

An approval in terragucci is a record on the `chant/lifecycle` branch of your repository. [`chant approve`](/terragucci/concepts/glossary/#chant) writes it, and the record names the plan it approves.

| Question | Answer |
|---|---|
| What does a record hold? | the wave's stage and set digest; no plans and no report. The report links the record, so the branch alone says who approved what |
| Why a branch? | each approval is a commit `git log` can show, kept with the code across CI tools; every runtime reads the one branch, so a laptop approval counts wherever the apply runs |
| Why does it name the plan? | a changed plan needs a new approval, and a refusal is the safe outcome; [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) recovers from one |
| Who can write one? | any writer, or a GitHub job with `contents: write`, can push a line naming someone |
| Who approves? | people; terragucci writes no code that approves for an agent, agent recipes only comment and open pull requests, and no agent holds or is listed with a signing key |

## Valid approvals

Under `approval: ledger`, the default, a pushed line counts: it binds the plans; any writer can name any person.

| `approval` | A wave's approval counts when | Read from |
|---|---|---|
| `ledger` | a line names the wave's digest | `terragucci.yml` at base |
| `pr-review` | a line names the digest, or the merged pull request's head was approved by a writer other than its author (on GitLab, after its latest push) and the wave plans what the review saw | `terragucci.yml` at base |
| `sealed` | a line names the digest and its seal, made by `chant approve --sign`, verifies against `.chant/allowed_signers` (or the file `.chant/trust.json` names) | `terragucci.yml`, [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson) and the signers file at base |

These files come from the applied commit's first parent, so a change cannot judge itself, except a multi-commit rebase merge: merge or squash those. [`agent-push`](/terragucci/reference/pipeline/#paths-an-agent-cannot-change) refuses edits to these files. Block force pushes and deletion on `chant/lifecycle` ([per forge](/terragucci/guides/approve-a-wave/#push-access-to-chantlifecycle)).

## Next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
- [The audit trail](/terragucci/reference/audit-trail/): every approval, apply, override and refused wave across your projects in one record
