---
title: Re-plan a pull request from a comment
description: Ask for a read-only re-plan of a pull request by writing /terragucci plan, and run an approved apply with /terragucci apply, on GitHub and Forgejo.
claims: [comment-plan, comment-apply, comment-not-affected, tg-comment-apply]
---

## What you end up with

`/terragucci plan` on a pull request plans it again and updates its plan note and `terragucci/plan` status. `/terragucci plan envs/dev/orders` plans that root alone.

## Before you start

- The pipeline from [Get your first plan note](/terragucci/getting-started/), from a terragucci with this trigger: run `npx terragucci init` again and merge the result, since the forge runs this workflow from the default branch.
- A repo on GitHub or Forgejo. GitLab has no comment commands.
- Write access to the repo for whoever asks.

## Steps

### 1. Write the command

```text
/terragucci plan
```

One line, nothing else. The optional word after `plan` is a root path from the repository root.

### 2. Read the note

The `replan` job plans the head as the plan job does, with its read-only role. It updates the same note and status. A named root the change does not reach gets a "not affected" reply and nothing is updated.

## What the command can and cannot do

`plan` changes nothing. `apply` runs approved waves. `agent` works where `agent.comment` is set, and `unlock` where `apply.when` is `pull-request`. No comment approves, and a re-plan cannot change what an approval binds.

The text is untrusted and never reaches a script; `terragucci comment` reads it from the event file. It accepts one line in one of these forms, and refuses anything else with the reason.

| Comment | Runs |
|---|---|
| `/terragucci plan` | a re-plan |
| `/terragucci plan <root>` | a re-plan of that root, which must be exactly a root the pipeline knows |
| `/terragucci apply` | the approved waves |
| `/terragucci apply wave-<n>` | the approved waves up to wave n |
| `/terragucci unlock` | a release of this pull request's locks |

A re-plan also requires that:

- the author has write access to the repo. Anyone else gets no answer and no plan;
- the pull request is open;
- its head is in this repo, not a fork;
- the comment is new. Editing it does not run it again.

A refusal is a reply that starts with `terragucci:`.

A comment that asks for nothing ends the job cleanly. A forge 403 or failure, or an unreadable event file, fails the job with the cause in the log.

## Apply a merged pull request

`/terragucci apply` on a merged pull request re-runs `tf-apply` for waves approved with [`chant approve --sign`](/terragucci/concepts/glossary/#chant), as [Approve a waiting wave](/terragucci/guides/approve-a-wave/) shows.

The `apply-comment` job runs the default branch's workflow at the merge commit, never the head. `terragucci comment-apply` checks the comment before any credential; then the job holds a push's apply lock and assumes `oidc.apply_role`. Waves run from wave 1 until one does not apply; `wave-<n>` stops after wave n.

Nothing applies, and the reply says why, when:

- the commenter cannot push to the repo;
- the pull request is open and `apply.when` is `merge`, or it was closed unmerged;
- its head is in a fork;
- its base is not the default branch;
- the default branch no longer has the merge commit;
- more than 50 commits reached the default branch after the merge commit;
- a later commit on the default branch has an apply of its own (the reply links it);
- the named wave does not exist.

Waiting, refused and failed waves behave as on a push. A refusal prints its diff (`respond.wave-refused`) and a failure its triage (`respond.apply-failed`). On GitLab, retry the job.

A [Terragrunt](/terragucci/guides/use-terragrunt/) repo gets the same job and refusals; each wave runs `tf-apply --terragrunt` on its units from the merge commit.

## Apply an open pull request

With [`apply.when: pull-request`](/terragucci/reference/config/#apply-before-merge), `/terragucci apply` on an open pull request applies its head before merge (plain roots on GitHub and Forgejo; `init` refuses it for Terragrunt or GitLab). After the commenter, fork and base checks above, the job also refuses when:

- no reviewer other than the author approved the head;
- a status or check on the head failed or is still running, or `terragucci/plan` has not passed there;
- the head does not contain the default branch;
- the change edits the pipeline file;
- another open pull request holds a lock on a root the change reaches.

Otherwise it locks the roots the change reaches and runs the waves from the head, with gate rule and signers from the default branch. `apply.merge: auto` merges once every wave applied; with `manual`, locks hold until you merge or close.

`/terragucci unlock` releases the pull request's locks so another one can apply those roots. Anyone with write access can use it, and the reply names what it released.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/) is the one place an approval is given.
- [Stages](/terragucci/reference/stages/) lists what `tf-plan` reads and writes.
