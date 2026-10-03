---
title: Validation
description: Every pipeline terragucci generates runs on a real forge and runner before it ships.
---

A pipeline that only parses has not been tested. Before a release, every pipeline terragucci generates runs on a real forge, with a real runner, against an AWS emulator. Each feature has a check that must pass, and each check is also broken on purpose to show it fails when it should.

| Forge | What runs |
|---|---|
| Forgejo | a Forgejo server and its runner |
| GitHub | the GitHub workflow dialect, with `act` and a mock GitHub API |
| GitLab | GitLab CE and its runner |
| fountain | a fountain steward, its database and a sandbox runner |

The same setup runs on your laptop. [The tutorial](/terragucci/tutorial/) boots it with one command and walks through each feature, and [Status](/terragucci/status/) shows which checks pass today.

## Running it yourself

```bash
just stack-up forgejo
just smoke
just stack-down
```

`just smoke` prints one line per check. `BREAK=1 just smoke <check>` breaks the property on purpose, and the line must then say `caught`.
