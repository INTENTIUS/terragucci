---
title: Webhook event schema
description: The fields of chant.notify/v1, the signed JSON event notify posts to a generic webhook when a wave waits, is refused or fails, and how to verify it.
prompt: |
  Read https://intentius.io/terragucci/reference/notify-event/.
  Write a small HTTP handler that verifies X-Terragucci-Signature over X-Terragucci-Timestamp, a dot and the raw body with a key from the environment, refuses a timestamp more than five minutes from now, drops a repeated id, and prints the wave, its targets and, for a waiting wave, the approve command.
  Read only. Never apply, approve (a pull request review or `terragucci approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

When a wave waits, is refused or fails, its apply job posts one event to `notify.webhook`, provided `notify.webhook_key` is set. [Send events to your own webhook](/terragucci/guides/notify-a-chat-channel/#send-events-to-your-own-webhook) sets it up and verifies it. Slack and Teams notices need none of it; it is for a program of yours, such as a relay that turns a chat click into `terragucci approve --plan`.

The event is [chant](/terragucci/concepts/glossary/#chant)'s `chant.notify/v1`, with `source: "terragucci"`. terragucci's [apply outcome](/terragucci/reference/cli-json/#the-apply-outcome) travels whole in `detail`.

```json
{
  "schema": "chant.notify/v1",
  "id": "4b0c9e...",
  "event": "waiting",
  "at": "2026-10-08T14:02:15.000Z",
  "source": "terragucci",
  "project": "github.com/acme/infra",
  "summary": "wave 2 of github.com/acme/infra waits for an approval",
  "wave": { "number": 2 },
  "targets": ["envs/prod/app", "envs/prod/db"],
  "digest": "jcs1-sha256:9f2c...",
  "approve": { "command": "npx terragucci approve wave-2 --plan jcs1-sha256:9f2c..." },
  "status": "waiting",
  "exitCode": 3,
  "run": {
    "url": "https://github.com/acme/infra/actions/runs/42",
    "forge": "github",
    "repository": "acme/infra",
    "commit": "9d1f0c..."
  },
  "detail": {
    "schema": "terragucci.outcome/v1",
    "status": "waiting",
    "exit": 3,
    "wave": 2,
    "roots": ["envs/prod/app", "envs/prod/db"],
    "set_digest": "jcs1-sha256:9f2c...",
    "approval_mode": "ledger",
    "approve_command": "terragucci approve wave-2 --plan jcs1-sha256:9f2c..."
  }
}
```

## Headers

| Header | Holds |
|---|---|
| `X-Terragucci-Signature` | `sha256=` and the hex HMAC-SHA256, with the key `notify.webhook_key` names, of the timestamp header, a dot, and the raw body: `<timestamp>.<body>` |
| `X-Terragucci-Timestamp` | when the job signed it, in seconds since the epoch |
| `X-Terragucci-Event` | the `event` |
| `X-Terragucci-Delivery` | the `id` |

An event is never posted unsigned. Check the signature over the bytes received, before parsing them, and refuse a timestamp more than five minutes from your clock: a delivery replayed later then fails.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verified(rawBody, headers, key, now = Math.floor(Date.now() / 1000)) {
  const ts = headers["x-terragucci-timestamp"] ?? "";
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 300) return false;
  const want = Buffer.from("sha256=" + createHmac("sha256", key).update(`${ts}.${rawBody}`).digest("hex"));
  const got = Buffer.from(headers["x-terragucci-signature"] ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}
```

Or install `@intentius/chant` and call its `verifyWebhook` from `@intentius/chant/notify-verify`, which needs only `node:crypto`: `verifyWebhook({ body, headers, key, prefix: "x-terragucci" })` checks the signature and the five minutes, and returns `{ ok: true, event }` or `{ ok: false, reason }`.

## Fields

| Field | Holds |
|---|---|
| `schema` | `chant.notify/v1`. A field is only ever added within a version. |
| `id` | sha256 over the source, the project, the event, the wave and the set digest (the commit when the wave has none): the same for every post of one wave's event about one digest, so a re-run's post can be dropped |
| `event` | `waiting`, `refused` or `failed` |
| `at` | when the job posted it |
| `source` | `terragucci` |
| `project` | the repo as `<host>/<path>` |
| `summary` | the line the chat messages lead with |
| `wave`, `targets` | the wave, and its roots; for a refused or denied wave the roots that moved or were denied, for a failed one the roots that failed |
| `digest` | the set digest the stage planned |
| `approve` | on `waiting` only: the `terragucci approve` command, and under `approval: pr-review` the pull request whose review approves it (`review.pr`, `review.url`) |
| `status`, `exitCode`, `reason` | the outcome's status and exit code, and on `refused` and `failed` its one-line reason |
| `run` | the run's page, the forge, the repo's path on it, the commit the wave applied, and `pr` when a comment's apply posted it |
| `reportUrl` | the wave's report when [`reports`](/terragucci/guides/keep-reports-in-a-bucket/) serves one |
| `detail` | the stage's [outcome](/terragucci/reference/cli-json/#the-apply-outcome) as it wrote it |

The JSON Schema ships with the package as `@intentius/terragucci/notify.schema.json`, a copy of chant's `@intentius/chant/notify.schema.json`.
