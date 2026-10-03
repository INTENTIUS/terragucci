# Working on terragucci

```bash
npm install
just check      # what CI runs: typecheck, lint, tests, the docs' prose and the tutorial
just site-dev   # serve the docs locally
```

## The package

`packages/terragucci` is `@intentius/terragucci`, the `terragucci` command. It ships TypeScript and runs through tsx, like chant. Its tests run with the rest under `just check`. `npm pack` in that directory builds the tarball; publishing to npm waits for an explicit go.

## Workflows

Every workflow in this repo is a chant declaration. The YAML is rendered from it and committed, because GitHub reads YAML from the default branch.

```bash
just ci          # render every workflow
just ci-check    # fail if a committed workflow differs from its declaration
```

| Declaration | Rendered |
|---|---|
| `ci/pipeline.ts` | `.github/workflows/ci.yml` |
| `pages/pipeline.ts` | `.github/workflows/pages.yml` |
| `capture/pipeline.ts` | `.github/workflows/capture.yml` |
| `workflows/shared.ts` | the pins they share |

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes the finished product, links no issue tracker, and leaves what is built today to the Status page.

## The example, the checks and the tutorial

`stack/README.md` covers the local stack, `just example`, `just smoke` and `just tutorial-capture`. The capture workflow refreshes the tutorial's output and screenshots weekly and opens a pull request when they change.
