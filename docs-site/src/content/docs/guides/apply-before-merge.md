---
title: Apply a pull request before it merges
description: Turn on apply.when pull-request, apply an approved change from a comment or a manual job, and merge it once every wave applied.
claims: [pr-apply, pr-apply-lock, pr-apply-stale]
---

## What you end up with

An open change that applies from its head in the same waves and gates as a merge. It merges once every wave applied, and the push after the merge applies nothing.

## Before you start

- Plain roots on GitHub or Forgejo, set up as in [Get your first plan note](/terragucci/getting-started/). Terragrunt repos and GitLab apply after merge; `init` refuses `apply.when: pull-request` there.
- Branch protection on the default branch that requires a review.
- The trade in [Apply before merge](/terragucci/reference/config/#apply-before-merge) accepted: the applying job runs the change's code with the apply role.

## Steps

### 1. Turn it on

Add the `apply` block to `terragucci.yml`.

```yaml
apply:
  when: pull-request
  merge: auto      # or manual, the default, to merge by hand
  merge_token_env: MERGE_TOKEN
```

With `merge: auto`, add that secret, holding a token of a user who may push to the default branch. Forgejo refuses the job's own token, and on GitHub a merge without it starts no `confirm`. Only `pr-merge`, which runs none of the change's code, gets it.

Run `npx terragucci init` and merge the result in its own pull request; nothing changes until it lands. Then each new default-branch commit runs `confirm` instead of the apply waves.

### 2. Get it reviewed

Open the change as usual; its plan note and `terragucci/plan` status come as before. A reviewer other than its author approves the head on the forge. A push after the review needs a fresh approval.

### 3. Ask for the apply

Comment `/terragucci apply` on the pull request.

Nothing applies when one of these holds, and the reply names it:

- the head has no approval;
- a check on the head failed or is still running;
- the head is behind the default branch;
- the change edits the pipeline file;
- another open change holds a lock on a root this one reaches.

A head behind the default branch needs the default branch merged or rebased in, then a new plan and a new approval.

### 4. Approve a waiting wave

A wave the `gate` policy holds stops, and the reply gives its [chant](/terragucci/concepts/glossary/#chant) approve command. [Approve a waiting wave](/terragucci/guides/approve-a-wave/) covers it. Then comment `/terragucci apply` again.

### 5. Merge

With `merge: auto` the job merges after the last wave and releases the locks. With `manual` the locks hold until you merge. A run that stopped at a wave never merges.

The `confirm` job then plans every root. Its `terragucci/apply` status on the default branch passes when nothing plans a change.

## Which config applies

An open change's apply reads its settings from the default branch. Edits to `terragucci.yml` in the change count once it merges.

| Setting | Read from |
|---|---|
| Waves, `binary`, `gate`, `canary`, the apply role | the default branch's pipeline |
| `policy` and the policy directory | the default branch; if it has no `policy` key, a change adding one is checked against its own |
| The gate rule ([`identity.gates`](/terragucci/concepts/glossary/#identitygates) in [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson)) and the signers file | the default branch |
| `reports`, `telemetry`, `parallelism` and every other key of `terragucci.yml` | the default branch |
| `respond` | the default branch; if unreadable, no response |
| The roots, modules and code that plan and apply | the change's head |

An unreadable default-branch config fails the wave before anything applies.

## Locks

Applying locks each root the change reaches. Another change that reaches one is refused, and the reply names the holder. Locks go when the holder merges or closes, or on `/terragucci unlock` there.

## Next

- [The generated pipeline](/terragucci/reference/pipeline/#apply-before-merge) lists the jobs, the checks and the credentials.
- [Re-plan a pull request from a comment](/terragucci/guides/re-plan-from-a-comment/) has every comment command.
