---
title: Set up with a coding agent
description: How a coding agent adopts terragucci in a repository, and the prompt to hand it.
prompt: setup
---

Setup needs no agent. [Get your first plan note](/terragucci/getting-started/) gives every step by hand, and only four opt-in features [run a model](/terragucci/#opt-in-coding-agent).

Give the prompt above to an agent working in a repository of Terraform or OpenTofu roots, including a Terragrunt, Atmos, Terramate or CDK Terrain repo.

## Agent inputs

| File | Holds |
|---|---|
| [`llms.txt`](https://intentius.io/terragucci/llms.txt) | every page, with a one-line description |
| [`llms-full.txt`](https://intentius.io/terragucci/llms-full.txt) | the text of every page in one file |
| Copy page as Markdown, under each page's title | that page's text, with its prompt |

A task page's own prompt sits under its title as "Optional: hand this page to your coding agent". Each one carries the line in step 5.

A key that `terragucci config check` refuses is not part of terragucci.

## Steps for the agent

1. Install terragucci with `npm i -D @intentius/terragucci` and run `npx terragucci init --dry-run --json`. Show the user the findings with their reasons and the files it would write.
2. Check what it found. Pass `--binary` or `--forge` if either is wrong, or ask the user.
3. Write a `terragucci.yml`, as small as possible, only if the defaults are wrong; [terragucci.yml keys](/terragucci/reference/config/) lists every key.
4. Run `npx terragucci init` to write the pipeline, and show the user the file it wrote.
5. Open a pull request with the config and the files `init` wrote; check `git status` so the commit holds nothing else. Then stop. Approvals are [chant](/terragucci/concepts/glossary/#chant) records on [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle), and they belong to the user.

   ```text
   Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
   ```
6. Tell the user to install chant, and under `approval: sealed` to add their key to `.chant/allowed_signers` ([Before your first approval](/terragucci/getting-started/#first-approval)). Do not add a key yourself. The file must be on the default branch before the first merge that destroys something, because the apply reads it from before the merge.

## Rules for the agent

- Set terragucci up or change its config from the shell with `--json`, and parse the envelope ([JSON output](/terragucci/reference/cli-json/)).
- Read what terragucci already wrote through `terragucci mcp`, when the user has added it ([Read the estate over MCP](/terragucci/guides/agent-read-over-mcp/)).
- Run `npx terragucci config check --json` after writing a config; it lists every problem at once.
- Approvals belong to people. Print the `chant approve` command for a waiting wave but never run it; chant refuses to resolve a wave's gate over MCP or ACP.
- [Responses to pipeline events](/terragucci/reference/responses/) need no model.
- Credentials stay in the forge's secrets. The config names environment variables (`token_env`) and never holds a value.

## MCP or `--json`

| You want to | Use | Why |
|---|---|---|
| find the roots, binary and forge, write a config, check it, write the pipeline | the CLI with `--json` | these commands write files in the repo, and the envelope gives each finding and the exit code |
| plan a root, or run a response in dry run | the CLI with `--json` | they run the binary in the checkout |
| read the estate, a root's last apply, a run's report, the state versions, the audit trail or the DORA figures | `terragucci mcp` | it reads the reports bucket with the credentials in its own environment, and every tool only reads |
| find a waiting wave and its digest | `terragucci mcp`'s `waiting` tool | it prints the `terragucci approve` command for a person to run |
| approve, apply, override or merge | neither | these belong to a person at a shell; the server has no such tool, and chant refuses a gate approval made over MCP |

## Next

After setup, see [read the estate over MCP](/terragucci/guides/agent-read-over-mcp/), [summarize a refused wave](/terragucci/guides/agent-refused-wave/) (comment-only token), [change a pull request](/terragucci/guides/agent-change-a-pull-request/), [fix drift](/terragucci/guides/agent-fix-drift/), and [review a pull request](/terragucci/guides/agent-review-a-pull-request/).
