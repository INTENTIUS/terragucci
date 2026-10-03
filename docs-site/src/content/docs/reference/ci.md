---
title: CI and the site
description: This repo's workflows are declared, and a gate fails if the committed YAML drifts.
---

Every workflow in this repo is a chant declaration. The YAML is rendered from it and committed, because GitHub reads YAML from the default branch.

```bash
just ci          # render every workflow
just ci-check    # fail if a committed workflow differs from its declaration
```

| Declaration | Rendered |
|---|---|
| `ci/pipeline.ts` | `.github/workflows/ci.yml` |
| `pages/pipeline.ts` | `.github/workflows/pages.yml` |
| `workflows/shared.ts` | pins both share |

The CI job runs `just check`. It typechecks and lints the declarations and runs the tests. It also scores the docs, so run it before you push.

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does, and `just site-dev` serves it locally.

The prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter:

```bash
just lint-docs        # default strictness
just lint-docs 3      # strict
```
