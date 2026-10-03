---
title: For agents
description: How a coding agent adopts terragucci in a repository, and the prompt to hand it.
---

Coding agents can set terragucci up for you. This page is written for them, and for the person handing them the task.

## Hand your agent this

Paste this into Claude Code, Codex, Cursor or any agent working in your Terraform repository:

```text
Set up terragucci in this repository.
Read https://intentius.io/terragucci/llms.txt first, then
https://intentius.io/terragucci/getting-started/agents/ and follow it.
Check https://intentius.io/terragucci/status/ before using any feature.
Do not apply anything. Open a pull request with the result.
```

## What the agent reads

| File | Holds |
|---|---|
| [`llms.txt`](https://intentius.io/terragucci/llms.txt) | every page, with a one-line description |
| [`llms-full.txt`](https://intentius.io/terragucci/llms-full.txt) | the text of every page in one file |
| [Status](/terragucci/status/) | what is built today |

The site describes the finished product, and the status page is the only record of what exists now. An agent checks it before running a command and tells you when a step needs something not built yet.

## Steps for the agent

1. Find the roots. A root is a directory whose `.tf` or `.tofu` files declare a backend or a `terraform` block. List them for the user.
2. Find the binary. Read `required_version` and any `.terraform-version` or `.opentofu-version` file, and ask the user when they disagree.
3. Decide whether the repo needs a config file. With one binary and no canary preference, it needs none. Otherwise write the smallest `terragucci.yml` that corrects the defaults; [Your config file](/terragucci/getting-started/config/) lists every key and its default.
4. Preview. Run `terragucci reconcile --config terragucci.yml` and show the user the pipeline it would write.
5. Open a pull request with the config and the generated pipeline. The default branch is the user's to change. Applying and approving are theirs too, so the agent runs no `apply`, `chant approve` or `--mode apply`.
6. Read the tips the dry run prints about pins and lock files. Report them, and offer each fix as its own pull request.

## Rules for the agent

- Approvals belong to people. An agent may print the `chant approve` command for a waiting wave but never runs it.
- Credentials stay in the forge's secrets. The config names environment variables (`token_env`) and never holds a value.
- Ask before choosing a runtime other than the forge. A fountain steward is opt-in.
