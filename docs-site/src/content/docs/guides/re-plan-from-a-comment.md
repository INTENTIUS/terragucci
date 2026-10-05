---
title: Re-plan a pull request from a comment
description: Ask for a read-only re-plan of a pull request by writing /terragucci plan, on GitHub and Forgejo.
claims: [comment-plan]
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

The generated `replan` job checks the pull request out at its head and runs the plan stage that the pull request's own plan job runs. It uses the same read-only role, writes the same note and sets the same status. It plans the roots the change reaches, and a root you name narrows that set. If the change does not reach the root you name, nothing is planned.

## What the command can and cannot do

The only command is `plan`. Nothing here applies, approves or unlocks. A re-plan changes nothing an approval covers, since an approval binds the digests of the plans it was given for.

The text is untrusted. The job never puts it in a script: `terragucci comment` reads it from the event file and accepts one grammar, `/terragucci plan` or `/terragucci plan <root>`. The root must be exactly one of the roots the pipeline was written with. Anything else is answered with the reason and plans nothing. Refused cases include `/terragucci apply`, `/terragucci approve` and `/terragucci unlock`, a root with a glob, a path trick or shell syntax in it, and text on a second line.

The job also requires that:

- the author has write access to the repo. Anyone else gets no answer and no plan;
- the pull request is open;
- its head is in this repo and not in a fork, since a fork's code never meets the plan role;
- the comment is new. Editing it does not run it again.

An answer that refuses a command is a reply from the job's token that starts with `terragucci:`.

## Next

- [Approve a waiting wave](/terragucci/guides/approve-a-wave/) is the one place an approval is given.
- [Stages](/terragucci/reference/stages/) lists what `tf-plan` reads and writes.
