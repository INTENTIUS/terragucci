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
Do not apply anything. Open a pull request with the result.
```

## What the agent reads

| File | Holds |
|---|---|
| [`llms.txt`](https://intentius.io/terragucci/llms.txt) | every page, with a one-line description |
| [`llms-full.txt`](https://intentius.io/terragucci/llms-full.txt) | the text of every page in one file |

Every page is true as written. A key that `terragucci config check` refuses is not part of terragucci, whatever an older copy of a page said.

## Steps for the agent

1. Install terragucci with `npm i -D @intentius/terragucci`, then run `npx terragucci init --dry-run --json`. Each finding comes with its reason, and the output names the files it would write: the pipeline and, outside Terragrunt, `chant.workspace.json`. Show the user.
2. Check what it found. When the binary or the forge is wrong, pass `--binary` or `--forge`, or ask the user.
3. Decide whether the repo needs a config file. With one binary and no canary preference, it needs none. Otherwise write the smallest `terragucci.yml` that corrects the defaults; [terragucci.yml keys](/terragucci/reference/config/) lists every key and its default.
4. Run `npx terragucci init` to write the pipeline, and show the user the file it wrote.
5. Open a pull request with the config, the generated pipeline and `chant.workspace.json`, which declares the wave gates. Check `git status` first so the commit holds nothing else. The default branch is the user's to change. Applying and approving are theirs too, so the agent runs no `apply`, `chant approve` or `--mode apply`.
6. Tell the user what they do before their first approval: install chant and add their key to `.chant/allowed_signers` ([Before your first approval](/terragucci/getting-started/#before-your-first-approval)). Do not add a key yourself.

## Rules for the agent

- Run terragucci from the shell with `--json` and parse the envelope ([JSON output](/terragucci/reference/cli-json/)). Each root carries the reason it was found, and the binary, version and forge carry theirs. Do not add an MCP server for it.
- Run `npx terragucci config check --json` after writing a config; it lists every problem at once.
- Approvals belong to people. An agent may print the `chant approve` command for a waiting wave but never runs it. Over MCP or ACP, chant refuses to resolve a wave's gate at all, whichever channel reached it.
- Responses to pipeline events need no model. [Responses to pipeline events](/terragucci/reference/responses/) lists each event's choices.
- Credentials stay in the forge's secrets. The config names environment variables (`token_env`) and never holds a value.

## Next

To have an agent work after setup, read [summarize a refused wave](/terragucci/guides/agent-refused-wave/), which uses a comment-only token, and [change a pull request](/terragucci/guides/agent-change-a-pull-request/).
