---
title: Approvals as records in your repo
description: Why an approval is a commit on a branch of your own repo, and what that gives you over a button in a CI tool.
---

An approval in terragucci is a record on the `chant/lifecycle` branch of your repository. [`chant approve`](/terragucci/concepts/glossary/#chant) writes it, and the record names the plan it approves.

## What a record holds

A record names the stage, the wave and the wave's set digest, the hash over the plan digest of every root in it. It does not hold the plans or the report. The report links to the record and never copies it, so the branch is the one place that says who approved what.

## Why a branch

Each approval is a commit, and `git log` shows who made it and when. It lives with the code and outlasts a change of CI tool. The people who approve push to the branch from their own machines, and the apply job pushes its pending records there. Every runtime reads that one branch, so an approval recorded from a laptop counts wherever the apply runs.

## Why it is sealed

Anything that can push to `chant/lifecycle` can write a line that names a person, and that includes every person with write access and, on GitHub, every workflow job with `contents: write`. So an approval is sealed: `chant approve --sign` signs the whole record with the approver's ssh key. `terragucci init` lists every wave's gate under [`identity.gates`](/terragucci/concepts/glossary/#identitygates) in [`chant.workspace.json`](/terragucci/concepts/glossary/#chantworkspacejson). Once that list names any gate, the apply job counts an approval of any wave only when its seal verifies against `.chant/allowed_signers` (or the file `.chant/trust.json` names). A line without a valid seal from a listed key counts for nothing, and so does a line edited after it was sealed.

The seal is the guard, so the rules that keep it sound are about the files it is checked against. The job reads them from the commit before the one it applies, so a merge that adds a signer does not judge its own apply. Agent keys never go in the signers file, and the agent comment refuses a change to it or to `chant.workspace.json`. Protecting `chant/lifecycle` against force pushes and deletion keeps the record of who approved what; [Approve a waiting wave](/terragucci/guides/approve-a-wave/#who-can-push-to-chantlifecycle) shows how on each forge.

## Why it names the plan

An approval of just "wave 2 is fine" would stay valid after the plans changed. Tying it to the set digest means a changed plan needs a new approval. A refusal is the safe outcome, and [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) shows how to recover from one.

## Who approves

People do. terragucci writes no code that approves on an agent's behalf, and the agent integrations are read-only recipes that comment and open pull requests. A gate's signing key is never given to an agent, and an agent's key is never listed in the signers file.

## Where to go next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
