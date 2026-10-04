---
title: Approve a waiting wave
description: Read what a wave will do, record your approval, and let the apply carry on.
---

## What you end up with

One wave applied, with an approval recorded in your repo that names the exact plans you read.

## Before you start

- A merge that reached the default branch, so `tf-apply` has started.
- `gate` set to `on-destroy` (the default) or `always`. With `never`, no wave waits. [Gate policy](/terragucci/reference/stages/#gate-policy) lists the three.
- chant installed where you approve: `npm i -D @intentius/chant`.
- Write access to the repo. The approval is a commit on its `chant/lifecycle` branch.
- You are a person. Approvals belong to people, so an agent or a script that approves on your behalf defeats the gate.

## Steps

### 1. Find the waiting wave

After a merge, the apply job applies each wave in turn. A wave that needs an approval stops the job with exit code 3 and prints the command to run. The pull request's plan note shows the same command at its foot, for example:

```text
approve wave 2 with chant approve tf-apply wave-2
```

Open the wave's roots in the report linked from the run. The report lists the wave's set digest and the approval state of each wave.

### 2. Read what the wave will do

The wave waits because its plans destroy something, or because `gate` is `always`. Read every destroy and replacement by name. They are never folded into a group, so they sit at the top of the report. Open a root's full plan when you need the detail.

### 3. Approve it

```bash
npx chant approve tf-apply wave-2
```

The command writes a record to the `chant/lifecycle` branch. The record names the wave's set digest, a hash over the plan digest of every root in it. The approval covers those plans and no others.

### 4. Run the stage again

Re-run the apply job from your forge, or push to the default branch. The stage finds the approval and applies the wave. It starts from where it stopped and never applies a root twice. If a later wave also needs an approval, the job stops again at exit code 3 with the next command.

The report now links each wave to its approval record.

## If the wave refuses instead

When any root's plan changed after you approved, the wave applies nothing. [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) covers that.

## Next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/)
