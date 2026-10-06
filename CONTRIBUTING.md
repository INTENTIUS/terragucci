# Working on terragucci

```bash
npm install
just check      # what CI runs: typecheck, lint, tests, the docs' prose and the tutorial
just site-dev   # serve the docs locally
```

## The package

`packages/terragucci` is `@intentius/terragucci`, the `terragucci` command. `just build-cli` bundles it into one file, `dist/terragucci.mjs`, with no runtime dependencies; chant is a build dependency of this repo only. `just bundle-check`, part of `just check`, fails if the package gains a dependency, the bundle imports anything but Node's modules and the two optional packages (the TypeScript folder that a `terragucci.ts` config needs, and the HCL parser), or the build's esbuild metafile lists an input from the TypeScript compiler, chant's lint rules, codegen or CLI, a lexicon's entry point, lint rules or codegen, or the dashboards' renderers (below). The size is not budgeted: 1 MB is an accident ceiling, and every `just build-cli` prints the raw and gzipped size, the change against origin/main and the ten largest inputs without failing on growth. The origin/main baseline is built from the origin/main sources on the chant installed in node_modules, and the line names that chant build (a `chant-local` install adds several KB over the pin, so compare sizes only on one chant build). The build writes into a private stage and renames the files into dist at the end, so builds that overlap leave a whole bundle. `npm pack` in that directory builds the tarball; publishing to npm waits for an explicit go.

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

### The decision service image

`images/images.ts` also declares `terragucci-decide` (`images/Dockerfile.decide`): Laya on CPU behind the Jev `/v1/systemone` shape, for the typed-decision uses (terragucci#28). It is opt-in and is not one of the CI images. `just images`, `just images-check` and the images workflow leave it out, and `images/budget.json` has no entry for it. Its pins (the `laya` release, the CPU torch build, the checkpoint's Hub commit and its weights' SHA-256) live in `DECIDE_IMAGE` in `packages/terragucci/src/images.ts`, `images/decide/requirements.txt` locks every Python wheel with its sha256 (the image installs it with `pip install --require-hashes`, so nothing resolves at build time; regenerate it when `laya` or `torch` moves), and `images/decide/server.py` is the wrapper that makes it answer as one pinned model id.

```bash
just decide-image        # build it into the local daemon as terragucci-decide:local
just decide up           # start it in the stack (builds it first if missing); http://decide:8790 on the network
just decide ask          # ask the three uses' questions through the client, and check it runs on CPU
just decide down
```

The client is `packages/terragucci/src/decide/` (`decide`, `isConfident`, `summarize`), and the uses' questions are in `decide/questions.ts`. `test/decide.test.ts` holds it to a recorded Jev response.

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
| `observability/collector.ts`, `observability/prometheus.ts` | `stack/observability/collector.yaml` and `prometheus.yml` |
| `packages/terragucci/src/dashboards/index.ts` (through `scripts/render-dashboards.ts`) | `packages/terragucci/src/dashboards/rendered.json`, the template `init` fills, and `stack/observability/terragucci/`, the dashboards and rules the stack's Grafana and Prometheus load, rendered with the stack's reports address (`http://localhost:4580/terragucci-reports`, prefix `reports`) so the Runs and Estate links resolve in the `drill-down` claim, and `stack/observability/grafana-datasources.yaml` |

The dashboards and rules are rendered by `just ci`, not by `init`. `scripts/render-dashboards.ts` renders the declarations with a placeholder for each value `terragucci.yml` sets (the `dashboards:` settings, and the reports address, rendered once with it and once without) and writes the result to `rendered.json`; `init` fills the placeholders (`src/dashboards/template.ts`), and `just build-cli` puts the template into the bundle gzipped. So the bundle carries neither the grafana, prometheus and otel lexicons nor js-yaml or the lezer PromQL parser, and `just bundle-check` fails if any of them, or `src/dashboards/index.ts`, reaches it. Before it writes or checks anything, the script fills the template with several settings, odd YAML values among them, and fails unless each comes out byte for byte as the declarations render it. `just ci-check` fails when `rendered.json` is stale. After an edit to the declarations, run `just ci` and commit `rendered.json` with the stack's files.

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes the finished product, links no issue tracker, and leaves what is built today to the Status page.

## The example, the checks and the tutorial

`stack/README.md` covers the local stack, `just example`, `just smoke` and `just tutorial-capture`. The capture workflow refreshes the tutorial's output and screenshots weekly and opens a pull request when they change.

### Capturing one step or all of them

```bash
just tutorial-capture              # every step whose smoke claims pass, from a fresh boot
just capture --list                # each step: what it needs, the files it writes, what they show
just capture check                 # one step; several names capture several
just capture --reuse wave-refused  # one step on the example as it is running now
```

The steps run in a fixed order (`STEPS` in `stack/tutorial-capture.sh`), each starting where the one before it left the example, so pull request and run numbers are the same on every capture. A step needs one of three things:

| Needs | Steps | Captured alone, the script |
|---|---|---|
| `fresh` | boot, fountain-apply | starts the stack from nothing, as the step itself does |
| `chain` | first-pr, check, one-note, wave-waiting, wave-refused, pin | boots the example fresh and replays every step before it without recording anything, so its numbers match a full capture |
| `booted` | report, drift, see-runs | resets a running example to its committed state, or boots one |

`--reuse` skips all of that. Use it when the example is already where the step expects it, and expect its pull request and run numbers to differ from a full capture's. A step whose claims do not pass in `smoke.json` is not captured; named alone, the command fails and says so.

A step writes nothing when it took fewer screenshots than its `STEPS` row lists (a page it could not find): its files stay as committed, the step is named, and the capture fails at the end. A screenshot that differs from the committed one only in Forgejo's relative times ("2 minutes ago") is the same screenshot: `stack/png-same.mjs` compares the two with a tolerance (1% of pixels, `TERRAGUCCI_SHOT_TOLERANCE`), and the committed file and its hash stay.

Screenshots of a job log or a note are found from the forge, never from a fixed number: a job by the run on its branch's head commit (`run_on`, `job_page`), a note by its `<!-- terragucci:plan` marker (`note_page`), a pull request by the number the command printed. The check step is the exception: the example's check job pushes `tofu fmt`'s fix to the branch, so the failed job is found from the push run on the commit the scenario pushed (`push_run`). `shot` takes a height when 860 pixels cut a note or log off, and a URL with a `#fragment` opens at that element. A Forgejo job page is taken by `stack/shot.mjs` (Node 22 or later, over Chrome's DevTools protocol), which hides the "Workflow warnings" box, opens the step `shot` names and scrolls to the first log line matching its pattern. A step that stops the capture is named in the last line, and a failed request names its URL.

The report step plans three scenarios of the example in its tofu CI image, each against its base commit, with `reports.bucket` naming the floci bucket `terragucci-reports`. Its four screenshots (the module bump's `report.html`, its prod payments row, that root's `plan.txt`, and the project's `index.html`) are served by floci's S3 endpoint. The drift step deletes the queue, dispatches the pipeline's drift job through the Forgejo API and photographs the issue it keeps, then resets the example.

### What makes a capture stale

Each step writes only its own files: `docs-site/src/data/tutorial/<step>.json` and `docs-site/src/assets/tutorial/<step>-<view>-<theme>.png`. The JSON holds the commands and their normalized output, `source_hash` (a hash of every file under `example/`) and `shots`, the hash of each screenshot it took. A step is rewritten, JSON and screenshots together, when its output or any screenshot differs byte for byte from what is committed. Otherwise its files are kept. Forgejo prints relative times, so a recapture usually rewrites the screenshots.

`just tutorial-check` holds every page that embeds a capture to these rules, step by step:

- a `<Captured>` step is stale when its `source_hash` is not the hash of `example/` as it is now;
- a `<Shot>` is stale when its step is, and wrong when the PNG on disk is not the one its step's JSON records.

So recapturing one step makes that step current and leaves every other step as it was: current if it was captured from the same `example/`, stale if not. Each step carries its own hash, so a fresh step cannot make another step look fresh, and a hand-copied or leftover PNG fails the check. After an edit under `example/`, every step is stale until it is recaptured: run `just tutorial-capture`, or `just capture` with each stale step the check names. `manifest.json` records the date, commit and tool versions of the last capture that changed anything. It is for contributors and the check does not read it.

`<Shot optional>` and `<Captured optional>` let the site build before a step's first capture. The check still fails on them until the step is captured.
