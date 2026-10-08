---
title: Set up with a coding agent
description: How a coding agent adopts terragucci in a repository, and the prompt to hand it.
prompt: setup
---

This page is for a coding agent setting terragucci up, and the person handing it the task. Paste the prompt above into Claude Code, Codex, Cursor or any agent working in your Terraform repository.

## What the agent reads

| File | Holds |
|---|---|
| [`llms.txt`](https://intentius.io/terragucci/llms.txt) | every page, with a one-line description |
| [`llms-full.txt`](https://intentius.io/terragucci/llms-full.txt) | the text of every page in one file |
| Copy page as Markdown, under each page's title | that page's text, with its prompt |

A task page's own prompt sits under its title as "Hand this to your agent". Each one forbids apply, approve and merge.

A key that `terragucci config check` refuses is not part of terragucci.

## Steps for the agent

1. Install terragucci with `npm i -D @intentius/terragucci`, then run `npx terragucci init --dry-run --json`. It lists each finding with its reason and the files it would write. Show the user.
2. Check what it found. When the binary or the forge is wrong, pass `--binary` or `--forge`, or ask the user.
3. Write a `terragucci.yml` only if the defaults are wrong, as small as possible; [terragucci.yml keys](/terragucci/reference/config/) lists every key.
4. Run `npx terragucci init` to write the pipeline, and show the user the file it wrote.
5. Open a pull request with the config and the files `init` wrote; check `git status` so the commit holds nothing else. The default branch, applying and approving are the user's, so run no `apply`, [`chant approve`](/terragucci/concepts/glossary/#chant) or `--mode apply`.
6. Tell the user to install chant, and under `approval: sealed` to add their key to `.chant/allowed_signers` ([Before your first approval](/terragucci/getting-started/#before-your-first-approval)). Do not add a key yourself. The file must be on the default branch before the first merge that destroys something, because the apply reads it from before the merge.

## Rules for the agent

- Run terragucci from the shell with `--json` and parse the envelope ([JSON output](/terragucci/reference/cli-json/)). Do not add an MCP server.
- Run `npx terragucci config check --json` after writing a config; it lists every problem at once.
- Approvals belong to people. Print the `chant approve` command for a waiting wave but never run it. Over MCP or ACP, chant refuses to resolve a wave's gate.
- [Responses to pipeline events](/terragucci/reference/responses/) need no model.
- Credentials stay in the forge's secrets. The config names environment variables (`token_env`) and never holds a value.

## Next

After setup, see [summarize a refused wave](/terragucci/guides/agent-refused-wave/) (comment-only token) and [change a pull request](/terragucci/guides/agent-change-a-pull-request/).
