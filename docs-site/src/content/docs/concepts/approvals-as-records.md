---
title: Approvals as records in your repo
description: Why an approval is a commit on a branch of your own repo, and what that gives you over a button in a CI tool.
---

An approval in terragucci is a record on the `chant/lifecycle` branch of your repository. `chant approve` writes it, and the record names the plan it approves.

## What a record holds

A record names the stage, the wave and the wave's set digest, the hash over the plan digest of every root in it. It does not hold the plans or the report. The report links to the record and never copies it, so the branch is the one place that says who approved what.

## Why a branch

An approval is a commit, so it has an author and a time. You read it with `git log`. It lives with the code and outlasts a change of CI tool. Branch protection on `chant/lifecycle` decides who may write approvals, using permissions you already manage. Every runtime reads the same branch, so an approval recorded from a laptop also counts in forge CI and on a fountain steward.

## Why it names the plan

An approval of just "wave 2 is fine" would stay valid after the plans changed. Tying it to the set digest means a changed plan needs a new approval. A refusal is the safe outcome, and [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) shows how to recover from one.

## Who approves

People do. terragucci writes no code that approves on an agent's behalf, and the agent integrations are read-only recipes that comment and open pull requests. A gate's signing key is never given to an agent.

## Where to go next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approve a waiting wave](/terragucci/guides/approve-a-wave/)
