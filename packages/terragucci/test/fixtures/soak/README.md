# Soak fixtures

Cases for `rollouts.soak` as terragucci decides it today. Each case states the world a rollout is in (config, clock, merges, drift, applies, denials, skip comments) and the decision: hold or release, why, and when the clock started. The files are plain JSON with no terragucci types, so another engine can load them in its own tests and compare its decisions. `test/soak-fixtures.test.ts` runs `src/rollout/soak.ts` over every case, which keeps them true.

Files: `clock.json` (durations, boundaries, merge times), `conditions.json` (drift, apply, policy), `overrides.json` (per module or provider rules), `skip.json` (`/terragucci skip-soak`). Each is `{ "cases": [...] }`. Case names are unique within a file.

## A case

| field | meaning |
|---|---|
| `name`, `why` | what the case is, and the rule of the code it pins |
| `soak` | the `rollouts.soak` config: a duration string (`"24h"`), a map, or `null` when the config has none |
| `rollout` | the rollout under soak: `kind` (`module` or `provider`), `name` (the source or provider address), `aliases` (other spellings of the same module that an override glob may match) |
| `wave` | the wave that applied and now soaks: `number`, and `merged`, one entry per pull request |
| `now` | the time of the run, ISO 8601 |
| `world` | what the conditions read |
| `decision` | what the engine must answer |

`soak` map: `after` (`<n>m`, `<n>h`, `<n>d` or `"0"`), `conditions` (a list of `drift`, `apply`, `policy`), `overrides` (a list of `{ module | provider, after?, conditions? }`). The first override whose glob names the rollout decides: a module glob for a module rollout, a provider glob for a provider rollout. Its `after` and `conditions` replace the soak's; a field it leaves out is the soak's. A glob matches the name with or without its registry host, and a name's aliases; `*` stays inside one segment and `**` crosses them.

`wave.merged[]`: `project`, `roots` (the wave's roots in that project), `branch` (the pull request's head branch), `at` (when it merged; absent or not a date means the forge gave no time).

`world.projects`, by project key:

| field | meaning |
|---|---|
| `driftIssue` | the project's open drift issue, or `null`. `roots` are the roots it names in code spans, `text` is other body text. A root counts as named only when it is written in a code span, equal to the whole root. |
| `applies` | the newest apply on the default branch, by root: `success`, `failure` or `pending`. A root not listed has no apply on record, which counts as `pending`. |
| `skips` | `/terragucci skip-soak` comments by pull request branch, oldest first, each `{ by, url? }`. These are already the comments of people allowed to push; checking that is the forge's job and is not part of the cases. |

`world.denials`: the policy denials on the gate ledger, each `{ root, at, rules }`. The ledger is the user's repository, so it is shared by all projects. Only a root's newest denial is read.

## The decision

| field | meaning |
|---|---|
| `outcome` | `hold` keeps the next wave closed; `release` lets it open |
| `via` | on a release: `no-soak` (no soak config, no rule), `skip` (a person skipped it), or `soaked` (the time is up and the conditions are clear) |
| `rule` | the rule that applied after overrides: `after` as written, `afterMs`, `conditions` in config order; `null` with no soak |
| `clockStart` | when the soak started: the latest `at` of the wave's merges; `null` when a skip or no soak decided, or when a merge time is missing |
| `due` | `clockStart + afterMs`; `null` where `clockStart` is |
| `holds` | on a hold, why, in the order reported. `{ reason: "time" }`: `now < due`. `{ reason: "condition", condition, project, roots }`: the time is up and that condition found those roots. `{ reason: "merge-time-unknown", projects }`: those projects' pull requests have no usable merge time, so no clock can be counted. Empty on a release. |
| `skippedBy` | on a skip: `{ by, url? }` of the first skip comment found |

## Order of decisions

1. No soak config: release, `no-soak`.
2. A skip comment on any of the wave's pull requests: release, `skip`, whatever else is true. Pull requests are read in `wave.merged` order, the oldest comment first.
3. A merge with no usable time: hold, `merge-time-unknown`.
4. `now < due`: hold, `time`. The conditions are not read yet. `now == due` is past due.
5. Each condition in the rule is read per merged project on that project's roots, in the order drift, apply, policy whatever the config order, and projects in `wave.merged` order. Any finding holds the wave, with one hold per finding. A policy denial counts when its time is at or after `clockStart`.
6. Otherwise release, `soaked`.
