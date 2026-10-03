---
title: Status
description: What exists, what terragucci debuts with, and where each piece is tracked.
---

This page is authoritative over everything else on the site and in the README. The debut is tracked in [chant#3343](https://github.com/INTENTIUS/chant/issues/3343), the design in [chant#3341](https://github.com/INTENTIUS/chant/issues/3341), and the adoption research and rulings in [chant#3347](https://github.com/INTENTIUS/chant/issues/3347).

## Exists

| Piece | State |
|---|---|
| This site | built by `just site`, published by the pages workflow |
| This repo's CI | `just check` and `just ci-check` |
| The validation stack | the `forgejo` and `aws` profiles (Forgejo 16.0.5, forgejo-runner 13.2.0), with the `check` and `apply` claims passing on a hand-written fixture workflow. The `github`, `gitlab` and `fountain` profiles are declared and not validated yet. |

## At debut

| Piece | Tracked in |
|---|---|
| One change-set format across planners | [chant#3181](https://github.com/INTENTIUS/chant/issues/3181) |
| The grouped plan summary | [chant#3188](https://github.com/INTENTIUS/chant/issues/3188) |
| Gated waves | [chant#3049](https://github.com/INTENTIUS/chant/issues/3049), on [chant#2417](https://github.com/INTENTIUS/chant/issues/2417) |
| Affected-only plans, and apply bound to the pull request's plan | [chant#3183](https://github.com/INTENTIUS/chant/issues/3183) |
| One plan job and one job per wave in the generated pipelines | [choudoufu#1755](https://github.com/INTENTIUS/choudoufu/issues/1755), moving here |
| The four stages, with the binary as a setting | this repo |
| Local validation of every generated pipeline | [chant#3344](https://github.com/INTENTIUS/chant/issues/3344) |
| One config file for one repo or many, and `terragucci reconcile` | [chant#3348](https://github.com/INTENTIUS/chant/issues/3348) |
| The plan report: JSON, the plan note, the HTML report, bucket copies and the index | [chant#3349](https://github.com/INTENTIUS/chant/issues/3349) |
| `tf-rollout`: pin-bump waves across repos, and lock-file waves | [chant#3352](https://github.com/INTENTIUS/chant/issues/3352), on [chant#3189](https://github.com/INTENTIUS/chant/issues/3189) and [chant#3190](https://github.com/INTENTIUS/chant/issues/3190) |
| `tf-publish`: modules published as OCI artifacts or git tags | [chant#3353](https://github.com/INTENTIUS/chant/issues/3353) |
| Tips | [chant#3354](https://github.com/INTENTIUS/chant/issues/3354) |

choudoufu's side already exists: the set digest and wave planning (choudoufu#1754), and its grouped summary (choudoufu#1753).

## After debut

| Piece | Tracked in |
|---|---|
| A steward started by a pull request | [chant#2518](https://github.com/INTENTIUS/chant/issues/2518) |
