# Working on terragucci

```bash
npm install
just check      # what CI runs: typecheck, lint, tests, the docs' prose and the tutorial
just site-dev   # serve the docs locally
```

## The package

`packages/terragucci` is `@intentius/terragucci`, the `terragucci` command. `just build-cli` bundles it into one file, `dist/terragucci.mjs`, with no runtime dependencies; chant is a build dependency of this repo only. `just bundle-check`, part of `just check`, fails if the package gains a dependency, the bundle imports anything but Node's modules and the two optional packages (the TypeScript folder that a `terragucci.ts` config needs, and the HCL parser), or the build's esbuild metafile lists an input from the TypeScript compiler, chant's lint rules, codegen or CLI, or a lexicon's entry point, lint rules or codegen. The size is not budgeted: 1 MB is an accident ceiling, and every `just build-cli` prints the raw and gzipped size, the change against origin/main and the ten largest inputs without failing on growth. `npm pack` in that directory builds the tarball; publishing to npm waits for an explicit go.

## Building on a local chant

terragucci pins a chant release in package.json. To build and test against chant's main branch, or any chant checkout, before it is released:

```bash
just chant-local                 # chant's origin/main, in a worktree next to the chant checkout
just chant-local ../chant-fix    # any chant checkout, as it is on disk
just chant-local --reset         # back to the pinned release
```

Without an argument it fetches the chant checkout next to this repo's main checkout (`CHANT_REPO` overrides it) and moves a detached worktree, `chant-local` beside that checkout (`CHANT_LOCAL_WORKTREE` overrides it), to origin/main. It never changes the chant checkout itself. In the chant directory it runs `npm ci` when chant's lock changed since the last run, then `npm pack` for chant's core and every lexicon terragucci's package.json files name, the fountain lexicon, and the chant packages those depend on (k8s, the k8s client). Each package's prepack generates, bundles and builds it, so the fountain lexicon's `src/generated` is made on the way.

The tarballs land in `.chant-local/`, which git ignores, and are installed with `npm install --no-save`. For that install the recipe points package.json and `packages/*/package.json` at the tarballs and puts them back afterwards, so the workspace gets the local build too and `git status` stays clean. Every installed `node_modules/@intentius/chant*/package.json` gets a `chantLocal` field with the chant commit, and the recipe prints that commit last. It then runs `just build-cli` and `just images`; `CHANT_LOCAL_IMAGES=0` skips the images on a machine without Docker. `stack/bootstrap.sh fountain` sees the `chantLocal` field and builds the steward image from the same tarballs instead of npm.

`--reset` runs `npm ci`, checks every chant package in node_modules against package-lock.json, and rebuilds the bundle and the images the same way. `npm ls @intentius/chant` reports the pinned version afterwards; it exits non-zero on the pin as well, because the lock's k8s lexicon asks for a newer core as a peer.

## The CI images

`images/images.ts` declares one image per toolchain (tofu, terraform, terragrunt) with chant's docker lexicon; `just ci` renders `images/Dockerfile.*`, and `just ci-check` fails on a hand edit. Tool versions come from `packages/terragucci/src/images.ts`, the table `init` reads too.

```bash
just images             # build all three for this machine, into the local daemon
just images-check       # run each image's tools and hold it to images/budget.json
```

The images workflow builds and checks them on amd64 and arm64 for every change, and pushes them to GHCR only for a `v*` tag, which waits for an explicit go. A release then records each pushed digest in `packages/terragucci/src/image-digests.json` before the npm package is built, so `init` pins the images by digest.

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
| `image-ci/pipeline.ts` | `.github/workflows/images.yml` |
| `images/images.ts` | `images/Dockerfile.*` |
| `workflows/shared.ts` | the pins they share |

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes the finished product, links no issue tracker, and leaves what is built today to the Status page.

## The example, the checks and the tutorial

`stack/README.md` covers the local stack, `just example`, `just smoke` and `just tutorial-capture`. The capture workflow refreshes the tutorial's output and screenshots weekly and opens a pull request when they change.
