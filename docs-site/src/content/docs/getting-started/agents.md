---
title: Set up with a coding agent
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

1. Install terragucci with `npm i -D @intentius/terragucci`, then run `npx terragucci init --dry-run --json`. It lists what it found, with a reason for each. Show the user.
2. Check what it found. When the binary or the forge is wrong, pass `--binary` or `--forge`, or ask the user.
3. Decide whether the repo needs a config file. With one binary and no canary preference, it needs none. Otherwise write the smallest `terragucci.yml` that corrects the defaults; [terragucci.yml keys](/terragucci/reference/config/) lists every key and its default.
4. Run `npx terragucci init` to write the pipeline, and show the user the file it wrote.
5. Open a pull request with the config and the generated pipeline. The default branch is the user's to change. Applying and approving are theirs too, so the agent runs no `apply`, `chant approve` or `--mode apply`.
6. Read the tips the dry run prints about pins and lock files. Report them, and offer each fix as its own pull request.

## Rules for the agent

- Run terragucci from the shell with `--json` and parse the envelope ([JSON output](/terragucci/reference/cli-json/)). Each root carries the reason it was found, and the binary, version and forge carry theirs. Do not add an MCP server for it.
- Run `npx terragucci config check --json` after writing a config; it lists every problem at once.
- Approvals belong to people. An agent may print the `chant approve` command for a waiting wave but never runs it. Over MCP or ACP, chant refuses to resolve a wave's gate at all, whichever channel reached it.
- Responses to pipeline events need no model. [Responses to pipeline events](/terragucci/reference/responses/) shows how a project opts in, one event at a time.
- Credentials stay in the forge's secrets. The config names environment variables (`token_env`) and never holds a value.
- Ask before choosing a runtime other than the forge. A fountain steward is opt-in.

## Next

To have an agent work after setup, read the recipes: [explain a plan](/terragucci/guides/agent-explain-a-plan/), [summarize a refused wave](/terragucci/guides/agent-refused-wave/) and [propose drift fixes](/terragucci/guides/agent-drift-fixes/). Each uses a read-only token.
