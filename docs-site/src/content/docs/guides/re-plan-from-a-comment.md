---
title: Re-plan a pull request from a comment
description: Ask for a read-only re-plan of a pull request by writing /terragucci plan, and re-run an approved apply with /terragucci apply, on GitHub and Forgejo.
claims: [comment-plan, comment-apply, comment-not-affected]
---

## What you end up with

Writing `/terragucci plan` on a pull request plans the change again. The plan note and the `terragucci/plan` status on the pull request's head are updated. `/terragucci plan envs/dev/orders` plans that root alone.

## Before you start

- The pipeline from [Get your first plan note](/terragucci/getting-started/), written by a terragucci that has this trigger. Run `npx terragucci init` again and merge the result to the default branch. GitHub and Forgejo start this workflow from the default branch, so nothing happens until it is merged.
- A repo on GitHub or Forgejo. GitLab has no such trigger yet.
- Write access to the repo for whoever asks.

## Steps

### 1. Write the command

```text
/terragucci plan
```

The comment is the command and nothing else: one line. The one optional word after `plan` is a root, written as its path from the repository root.

### 2. Read the note

The generated `replan` job checks the pull request out at its head and runs the plan stage that the pull request's own plan job runs. It uses the same read-only role, writes the same note and sets the same status. It plans the roots the change reaches, and a root you name narrows that set. If the change does not reach the root you name, the job replies on the pull request that the root is not affected and names it, and leaves the plan note and the status as they were. There is no form that plans a root the change does not reach.

## What the command can and cannot do

There are two commands, `plan` and `apply`. `plan` changes nothing. `agent` is a third command where `agent.comment` is set in `terragucci.yml`. A re-plan changes nothing an approval covers, since an approval binds the digests of the plans it was given for. No comment approves or unlocks.

The text is untrusted. The job never puts it in a script: `terragucci comment` reads it from the event file and accepts one grammar, `/terragucci plan`, `/terragucci plan <root>`, `/terragucci apply` or `/terragucci apply wave-<n>`. The root must be exactly one of the roots the pipeline was written with. Anything else is answered with the reason and plans nothing. Refused cases include `/terragucci approve` and `/terragucci unlock`, a root with a glob, a path trick or shell syntax in it, and text on a second line.

A re-plan also requires that:

- the author has write access to the repo. Anyone else gets no answer and no plan;
- the pull request is open;
- its head is in this repo and not in a fork, since a fork's code never meets the plan role;
- the comment is new. Editing it does not run it again.

An answer that refuses a command is a reply from the job's token that starts with `terragucci:`.

A comment that asks for nothing ends the job with no error. If the job cannot tell whether to plan because the forge answered 403 or failed, or because the event file is unreadable, it fails and the log gives the cause.

## Apply a merged pull request

`/terragucci apply` on a merged pull request re-runs `tf-apply` for waves you approved with `chant approve --sign`, as [Approve a waiting wave](/terragucci/guides/approve-a-wave/) describes. The `apply-comment` job reads the comment with `terragucci comment-apply` before any credential is asked for. Its workflow comes from the default branch, and its checkout is the merge commit, never the head. The job holds the apply lock a push holds, and assumes `oidc.apply_role` once the checks pass. Waves run in order from wave 1: one already applied plans no change, and the first that does not apply ends the run. With `wave-<n>` the run stops after wave n.

Nothing applies, and the reply says why, when:

- the commenter cannot push to the repo;
- the pull request is open or was closed unmerged;
- its head is in a fork;
- its base is not the default branch;
- the default branch no longer has the merge commit;
- a later commit on the default branch has an apply of its own, which the reply links, since going back would undo that newer tree;
- the named wave does not exist.

Waiting, refused and failed waves behave as on a push: a refused wave prints its diff (`respond.wave-refused`) and a failed one its triage (`respond.apply-failed`) before the reply. GitLab has no comment trigger, so retry the job there. A Terragrunt pipeline has no `apply-comment` job, and its reply says so.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/) is the one place an approval is given.
- [Stages](/terragucci/reference/stages/) lists what `tf-plan` reads and writes.
