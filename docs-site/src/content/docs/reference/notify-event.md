---
title: Webhook event schema
description: The fields of terragucci.notify/v1, the signed JSON event notify posts to a generic webhook when a wave waits, is refused or fails.
prompt: |
  Read https://intentius.io/terragucci/reference/notify-event/.
  Write a small HTTP handler that verifies X-Terragucci-Signature over the raw body with a key from the environment, drops a repeated id, and prints the wave, its roots and, for a waiting wave, the approve command.
  Read only. Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

With `notify.webhook` and `notify.webhook_key` set, each apply job whose wave waits, is refused or fails posts one event to the webhook. [Send events to your own webhook](/terragucci/guides/notify-a-chat-channel/#send-events-to-your-own-webhook) sets it up and verifies it.

```json
{
  "schema": "terragucci.notify/v1",
  "id": "4b0c9e...",
  "event": "waiting",
  "sent_at": "2026-10-08T14:02:15.000Z",
  "project": "github.com/acme/infra",
  "forge": "github",
  "repo": "acme/infra",
  "sha": "9d1f0c...",
  "wave": 2,
  "roots": ["envs/prod/app", "envs/prod/db"],
  "run_url": "https://github.com/acme/infra/actions/runs/42",
  "outcome": {
    "schema": "terragucci.outcome/v1",
    "status": "waiting",
    "exit": 3,
    "wave": 2,
    "roots": ["envs/prod/app", "envs/prod/db"],
    "set_digest": "jcs1-sha256:9f2c...",
    "approval_mode": "ledger",
    "approve_command": "chant approve tf-apply wave-2 --plan jcs1-sha256:9f2c..."
  }
}
```

## Headers

| Header | Holds |
|---|---|
| `X-Terragucci-Signature` | `sha256=` and the hex HMAC-SHA256 of the raw body, with the key `notify.webhook_key` names |
| `X-Terragucci-Event` | the `event` |
| `X-Terragucci-Delivery` | the `id` |

An event is never posted unsigned. Check the signature over the bytes received, before parsing them.

## Fields

| Field | Holds |
|---|---|
| `schema` | `terragucci.notify/v1`. It changes only when a field is removed or changes meaning; new fields can appear without a bump. |
| `id` | sha256 over the project, the wave, the event and the set digest (the commit when the wave has none): the same for every post of one wave's event about one digest, so a re-run's post can be dropped |
| `event` | `waiting`, `refused` or `failed` |
| `sent_at` | when the job posted it |
| `project` | the repo as `<host>/<path>` |
| `forge`, `repo`, `sha` | the forge, the repo's path on it, and the commit the wave applied |
| `pr` | the pull or merge request, when a comment's apply posted it |
| `wave`, `roots` | the wave, and its roots; for a refused or denied wave the roots that moved or were denied, for a failed one the roots that failed |
| `run_url`, `report_url` | the run, and the wave's report when [`reports`](/terragucci/guides/keep-reports-in-a-bucket/) serves one |
| `outcome` | the stage's [outcome](/terragucci/reference/cli-json/#the-apply-outcome) as it wrote it, with the [chant](/terragucci/concepts/glossary/#chant) command that approves a waiting wave |

The JSON Schema ships with the package as `@intentius/terragucci/notify.schema.json`.
