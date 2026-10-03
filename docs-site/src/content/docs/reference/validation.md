---
title: Validation
description: How every generated pipeline is run locally on a real forge before it ships.
---

terragucci validates every pipeline it generates by running it. A pipeline that only parses has not been tested, so each one runs on a real forge with a real runner, against an AWS emulator, on one Docker network. Every claim below runs for every forge before a release.

## The stack

`stack/` is one compose project. Profiles pick which pieces start.

| Profile | What starts | What it proves | When it runs |
|---|---|---|---|
| `aws` | floci, an AWS emulator | that the Terraform plans and applies | always |
| `forgejo` | a Forgejo server and its runner | triggers, checkout, pull-request comments, the approval loop | every pull request |
| `github` | `act`, plus a mock GitHub API | the GitHub workflow dialect | every pull request |
| `gitlab` | GitLab CE and its runner | the GitLab dialect and its merge-request notes | nightly or on demand |
| `fountain` | fountain, its database and a sandbox runner | that a steward runs the same stages | nightly or on demand |

```bash
just stack-up forgejo
just validate forgejo apply
just stack-down
```

## Claims

Each pipeline is checked as a set of named claims. `just validate <forge> <claim>` runs one, and `BREAK=1` breaks the property on purpose to prove the claim fails when it should.

| Claim | Holds when |
|---|---|
| `check` | an unformatted root fails and a formatted one passes |
| `plan` | a pull request plans only the affected roots and gets one grouped-summary note |
| `apply` | a wave stops at its approval, and applies after `chant approve` |
| `changed-set` | a root changed after approval makes the wave apply nothing |
| `waves` | each wave is its own job, canary first, then dependency order |
| `drift` | drift seeded into the emulator is reported |
| `no-secrets` | the pull-request job holds no secret and plans against an emulator seeded from the base branch |
| `steward` | a fountain steward applies the plan the forge approved |

## Fixtures

| Fixture | Exercises |
|---|---|
| five OpenTofu roots sharing one module | waves and the grouped summary |
| waterpark's `access/` root | a real estate, and stages extended with a repository's own scripts |
| a CDK Terrain app with two dependent stacks | synth before plan, and stack order as wave order |

## What the setup taught

Two rules come from running pipelines on a local GitLab before. They hold for every forge here.

- The forge's own URL uses its service name, never `localhost`. Inside a job container, `localhost` is the job.
- The runner starts its job containers on the stack's named network. Otherwise a job cannot reach the forge or the emulator.
