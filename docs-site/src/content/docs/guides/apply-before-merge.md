---
title: Apply a pull request before it merges
description: Turn on apply.when pull-request, apply an approved change from a comment or a manual job, and merge it once every wave applied.
draft: true
claims: [pr-apply, pr-apply-lock, pr-apply-stale]
---

## What you end up with

An open change that applies from its head in the same waves and gates as a merge. It merges once every wave applied, and the push after the merge applies nothing.

## Before you start

- A repo of plain roots on GitHub, Forgejo or GitLab, set up as [Get your first plan note](/terragucci/getting-started/) shows. A Terragrunt repo applies after merge.
- Branch protection on the default branch that requires a review.
- The trade in [Apply before merge](/terragucci/reference/config/#apply-before-merge), read and accepted: the job that applies a change runs its code with the apply role.

## Steps

### 1. Turn it on

Add the `apply` block to `terragucci.yml`.

```yaml
apply:
  when: pull-request
  merge: auto      # or manual, the default, to merge by hand
```

Run `npx terragucci init` and merge the result through a pull request of its own. The comment job runs the default branch's pipeline, so nothing changes until that merge lands. After it, each new commit on the default branch runs the `confirm` job instead of the apply waves.

### 2. Get it reviewed

Open the change as usual; its plan note and `terragucci/plan` status come as before. A reviewer other than its author approves the head on the forge. A push after the review needs a fresh approval.

### 3. Ask for the apply

On GitHub or Forgejo, comment `/terragucci apply`. On GitLab, run the manual `apply-mr` job of the merge request pipeline, which starts once its `plan` job passed.

Nothing applies when one of these holds, and the reply names it:

- the head has no approval;
- a check on the head failed or is still running;
- the head is behind the default branch;
- the change edits the pipeline file;
- another open change holds a lock on a root this one reaches.

A head behind the default branch needs the default branch merged or rebased in, then a new plan and a new approval.

### 4. Approve a waiting wave

A wave the `gate` policy holds stops, and the reply gives its [chant](/terragucci/concepts/glossary/#chant) approve command. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) covers it. Then comment `/terragucci apply` again, or run `apply-mr` again.

### 5. Merge

With `merge: auto` the job merges after the last wave and releases the locks. With `manual`, you merge, and the locks hold until then. A run that stopped at a wave never merges.

The `confirm` job then plans every root. Its `terragucci/apply` status on the default branch passes when nothing plans a change.

## Which config applies

The apply of an open change reads its settings from the default branch, and the change's own edits to `terragucci.yml` take effect after it merges.

| Setting | Read from |
|---|---|
| Waves, `binary`, `gate`, `canary`, the apply role | the default branch's pipeline, which `init` wrote from its config |
| `policy` and the policy directory | the default branch; when it has no `policy` key, a change that adds one is checked against its own |
| The gate rule ([`identity.gates`](/terragucci/concepts/glossary/#identitygates) in [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson)) and the signers file | the default branch |
| `reports`, `telemetry`, `parallelism` and every other key of `terragucci.yml` | the default branch |
| The roots, modules and code that plan and apply | the change's head |

A change that edits `reports.bucket`, for example, still has its apply report copied to the default branch's bucket. If the default branch's config cannot be read, the wave fails and nothing in it applies.

## Locks

Applying locks each root the change reaches. Another open change that reaches one of them is refused, and the reply names the root and its holder. The lock goes when the holder merges or closes. To release it sooner, comment `/terragucci unlock` on the holder (on GitLab, run its `unlock-mr` job).

## Next

- [The generated pipeline](/terragucci/reference/pipeline/#apply-before-merge) lists the jobs, the checks and the credentials.
- [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/) has every comment command.
