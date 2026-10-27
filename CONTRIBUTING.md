# <img src="docs-site/public/brand/taco-small.png" width="26" height="16" alt=""> Working on terragucci

```bash
npm install
just check      # what CI runs: typecheck, lint, tests, the docs' prose, the tutorial and the rendered workflows
just docs       # serve the docs locally with hot reload and open them
just docs-preview  # build the docs as CI does and open that build
```

## The package

`packages/terragucci` is `@intentius/terragucci`, the `terragucci` command. `just build-cli` bundles it into one file, `dist/terragucci.mjs`. The package has one runtime dependency, `@intentius/chant` at the exact pin in `package.json`: the bundle imports chant core from it at run time wherever that chant serves compiled JS (`scripts/chant-external.mjs`), and `terragucci approve` spawns its bin. The chant lexicons it uses are devDependencies, bundled into that file, and their own imports of chant core go to the installed chant as well. `just bundle-check`, part of `just check` and of CI's `just check-unit`, holds that pin to the root's, and fails if the package gains another dependency, the bundle imports anything but Node's modules, a chant core subpath the installed chant's exports map serves as compiled JS, and the two optional packages (the TypeScript folder that a `terragucci.ts` config needs, and the HCL parser), or the build's esbuild metafile lists an input from the TypeScript compiler, chant's lint rules, codegen or CLI, a lexicon's entry point, lint rules or codegen, or the dashboards' renderers (below). On a chant that predates compiled exports (0.124.54), chant core is bundled, and the ceiling and the denied inputs only chant core brings are reported as waiting rather than failing. The size is not budgeted: 2 MB is an accident ceiling (1 MB until `terragucci mcp` brought the MCP SDK in; its JSON Schema validator, Ajv, is swapped for one that refuses, since the server asks a client for no input), and every `just build-cli` prints the raw and gzipped size, the change against origin/main and the ten largest inputs without failing on growth. The origin/main baseline is built from the origin/main sources on the chant installed in node_modules, and the line names that chant build (a `chant-local` install adds several KB over the pin, so compare sizes only on one chant build). The build writes into a private stage and renames the files into dist at the end, so builds that overlap leave a whole bundle. `npm pack` in that directory builds the tarball. The publish workflow puts it on npm; see [Releasing](#releasing).

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

`images/images.ts` declares one image per toolchain (tofu, terraform, terragrunt, choudoufu) with chant's docker lexicon; `just ci` renders `images/Dockerfile.*`, and `just ci-check` fails on a hand edit. Tool versions come from `packages/terragucci/src/images.ts`, the table `init` reads too.

```bash
just images             # build all four for this machine, into the local daemon
just images-check       # run each image's tools and hold it to images/budget.json
```

Each image's system git config marks every directory safe (`safe.directory = *`), because a job often runs as another user than the one who owns its checkout: on github.com a container job is root and the runner's user owns the workspace. `just images-check` runs git both ways round in each image, root in a checkout uid 1001 owns and uid 1001 in one root owns, including a fetch from a local remote, and the smoke claim `init/foreign-checkout` plans the example as root on a checkout uid 1001 owns. Both test the images built from this tree, so run `just images` first.

The images workflow builds and checks them on amd64 and arm64 for every change, and pushes them to GHCR only for a `v*` tag, which waits for an explicit go. A release then records each pushed digest in `packages/terragucci/src/image-digests.json` before the npm package is built, so `init` pins the images by digest.

### The decision service image

`images/images.ts` also declares `terragucci-decide` (`images/Dockerfile.decide`): Laya on CPU behind the Jev `/v1/systemone` shape, for the typed-decision uses (terragucci#28). It is opt-in and is not one of the CI images. `just images`, `just images-check` and the images workflow leave it out, and `images/budget.json` has no entry for it. Its pins (the `laya` release, the CPU torch build, the checkpoint's Hub commit and its weights' SHA-256) live in `DECIDE_IMAGE` in `packages/terragucci/src/images.ts`, `images/decide/requirements.txt` locks every Python wheel with its sha256 (the image installs it with `pip install --require-hashes`, so nothing resolves at build time; pip itself is in it, pinned by `DECIDE_IMAGE.pip`; regenerate it with `just decide-requirements` when `laya`, `torch` or `pip` moves), and `images/decide/server.py` is the wrapper that makes it answer as one pinned model id.

```bash
just decide-image        # build it into the local daemon as terragucci-decide:local
just decide up           # start it in the stack (builds it first if missing); http://decide:8790 on the network
just decide ask          # ask the three uses' questions through the client, and check it runs on CPU
just decide down
```

The client is `packages/terragucci/src/decide/` (`decide`, `isConfident`, `summarize`), and the uses' questions are in `decide/questions.ts`. `test/decide.test.ts` holds it to a recorded Jev response.

## Releasing

The history on main starts at one commit, "terragucci, from 0.4.38", made on 2026-10-20 when the earlier history was squashed to keep clones small. The changes before it are in pull requests #1 to #1194, and release tags and GitHub releases start at v0.4.39.

A release puts the CI images on GHCR and then `@intentius/terragucci` on npm. The npm package must name the images by digest, and the digests exist only after the images are pushed, so the order is fixed:

1. Run `just version-bump <version>` and merge the result to main. It sets the version in `packages/terragucci/package.json` and `package-lock.json`, renders the five images' Dockerfiles with the new version label, and regenerates both examples' pipelines, their patches and the cli-json goldens. Image tags carry the package version (`imageTag` in `packages/terragucci/src/images.ts`), and `image-digests.json` has no digest for the new tags yet, so `init` writes them bare and the bump commit passes CI as it is. `just release-preflight <version>` then names the newest green commit at that version (`chant ci last-green`, never a hand-picked commit) and prints the `git tag v<version> <sha> && git push origin v<version>` to run.
2. The images workflow runs on the tag. Its publish job pushes the four images to GHCR and prints each reference with its digest.
3. Run `just record-digests <run id>` with the images workflow's run on the tag (`gh run list --workflow images.yml --branch v<version>`), and merge the result to main. It reads each reference `npx tsx scripts/images.ts tags` prints from GHCR, refuses when one is missing or its digest is not the one the run printed, writes them to `packages/terragucci/src/image-digests.json` in place of the earlier release's, moves `stack/sandbox-github.sh` to the new release, and regenerates the same files as step 1, now pinned by digest. Without a run id it takes GHCR's digests alone.
4. Run the publish workflow on main: `gh workflow run publish.yml --ref main` (its `ref` input defaults to main; pass `-f ref=<ref>` to publish another one).
5. Run `just github-release <version>` once npm has the version. It creates the GitHub release on the existing tag `v<version>` (`gh release create --verify-tag`, so it never creates or moves a tag), titled with the version and marked latest, with its notes from the `## In <version>` section of the Changes page that step 3 merged. The Changes page links this release. A version whose release exists is left as it is; `--dry-run` prints the notes.

`scripts/release-preflight.sh` fetches main and the `ci/` tags, and refuses a commit with no `ci/green/<sha>`, one with `ci/revoked/<sha>`, and one whose package is at another version. The tags are a convenience: when main has no green commit (the tick has not run, or every recent commit changed a workflow and `CI_GREEN_TOKEN` is missing) it says so, and `TERRAGUCCI_RELEASE_SKIP_GREEN=1 just release-preflight <version> [<commit>]` releases main, or the commit given, without the check.

The tag starts the publish workflow too. At that point the digests are not recorded yet, so that run refuses and the step 4 dispatch publishes. A tag pushed after its digests are already on main publishes directly.

The publish workflow (`publish/pipeline.ts`, rendered to `.github/workflows/publish.yml`) runs the unit tests (`test` job) and, once they pass, builds the bundle and then:

- skips with a notice when npm already has this version;
- on a tag, fails unless the tag is `v` plus the package version;
- fails unless every image reference this version's bundle names has a `sha256:` digest in `image-digests.json`, and that digest is in the built bundle;
- runs `npm publish --provenance --access public` from `packages/terragucci`.

It publishes with npm trusted publishing: npm accepts the job's GitHub OIDC token (the workflow has `id-token: write`), so no npm token is stored anywhere, and the package carries a provenance statement for the run. Trusted publishing needs npm 11.5.1 or later; the workflow installs the npm pinned as `NPM_VERSION` in `workflows/shared.ts` when the Node 24 it gets bundles an older one.

The trusted publisher is configured once, on npmjs.com, in the settings of `@intentius/terragucci` under Trusted Publisher, GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `INTENTIUS` |
| Repository | `terragucci` |
| Workflow filename | `publish.yml` |
| Environment | (empty) |

The fields are case-sensitive, and `repository.url` in `packages/terragucci/package.json` must match the repository exactly. Renaming the workflow file breaks publishing until the setting is changed too. npm expires a new trusted publisher configuration that has not published within 2 days, so configure it shortly before a release. Once it works, the package's publishing access can be set to require two-factor authentication and disallow tokens, which leaves this workflow as the only way to publish. npm's reference: https://docs.npmjs.com/trusted-publishers.

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
| `image-ci/pipeline.ts` | `.github/workflows/images.yml` |
| `publish/pipeline.ts` | `.github/workflows/publish.yml` |
| `ci-red/pipeline.ts` | `.github/workflows/ci-red.yml` |
| `diff-guard/pipeline.ts` | `.github/workflows/diff-guard.yml` |
| `images/images.ts` | `images/Dockerfile.*` |
| `front-door/stack.ts` (the `ReportsFrontDoor` composite in `front-door/front-door.ts`, with the edge code `front-door/edge.cjs` minified into it) | `docs-site/public/reports-front-door.json`, the CloudFormation template the Keep reports in S3 guide deploys; `test/front-door.test.ts` runs that inlined code |
| `workflows/shared.ts` | the pins they share |
| `observability/collector.ts`, `observability/prometheus.ts` | `stack/observability/collector.yaml` and `prometheus.yml` |
| `packages/terragucci/src/dashboards/index.ts` (through `scripts/render-dashboards.ts`) | `packages/terragucci/src/dashboards/rendered.json`, the template `init` fills, and `stack/observability/terragucci/`, the dashboards and rules the stack's Grafana and Prometheus load, rendered with the stack's reports address (`http://localhost:4580/terragucci-reports`, prefix `reports`) so the Runs and Estate links resolve in the `report/drill-down` claim, and `stack/observability/grafana-datasources.yaml` |

The dashboards and rules are rendered by `just ci`, not by `init`. `scripts/render-dashboards.ts` renders the declarations with a placeholder for each value `terragucci.yml` sets (the `dashboards:` settings, and the reports address, rendered once with it and once without) and writes the result to `rendered.json`; `init` fills the placeholders (`src/dashboards/template.ts`), and `just build-cli` puts the template into the bundle gzipped. So the bundle carries neither the grafana, prometheus and otel lexicons nor js-yaml or the lezer PromQL parser, and `just bundle-check` fails if any of them, or `src/dashboards/index.ts`, reaches it. Before it writes or checks anything, the script fills the template with several settings, odd YAML values among them, and fails unless each comes out byte for byte as the declarations render it. `just ci-check` fails when `rendered.json` is stale. After an edit to the declarations, run `just ci` and commit `rendered.json` with the stack's files.

## CI

`ci.yml` runs the unit tests and the docs lint, on every pull request and on each push to main, in four jobs that run side by side: `static` runs `just check-unit` (the typecheck, the bundle's shape and the provider's gofmt, vet and tests) and then `just lint-docs`, and `test (1/3)` to `test (3/3)` each run a third of the unit tests (`just test-shard <n>`, vitest's `--shard`). Lint, the tutorial, the rendered workflows and the LFS check are in `just check`, which you run before pushing; CI does not. `diff-guard` runs by hand only. A branch with no pull request runs it by hand: `gh workflow run ci.yml --ref <branch>`. No claim runs in CI: the validation and smoke claims hold a stack, and a person runs them (`just validate-forge`, `just claims`).

| Workflow | Runs | What it does |
|---|---|---|
| `diff-guard.yml` | by hand (`gh workflow run diff-guard.yml --ref <branch>`; the `allow_revert` input replaces the `revert` label) | `scripts/diff-guard.sh origin/main <head>`: fails when the squash would undo a commit main already has; `scripts/lfs-check.sh origin/main <head>`: fails when the pull request adds a binary outside Git LFS |
| `ci.yml` | every pull request, each push to main, and by hand | `just check-unit` in `static`, `just test-shard <n>` in `test (<n>/3)` |
| `chant-ci-green.yml` | when `ci.yml` or `publish.yml` completes on main, and every 15 minutes | `chant ci tick`: tags each commit that passed every `ci.green` phase `ci/green/<sha>`, and a green commit that later fails `ci/revoked/<sha>` |
| `ci-red.yml` | hourly | `scripts/ci-red`: opens one issue, "main is red", when main has had no green commit for `TERRAGUCCI_RED_HOURS` (6) hours or a green commit is revoked, and closes it once main is green again |

main's runs of `ci.yml` are never cancelled. GitHub keeps one run going and one waiting per concurrency group, so in a burst of merges the first and the newest are tested and the commits between them get no tag. A pull request's new push cancels its run in progress, and so does a run by hand on a branch. The tick reads main's commits alone, so a pull request's runs tag nothing.

### diff-guard

A rebase that keeps a stale copy of a file puts back the lines that a commit merged meanwhile changed, and the squash then reverts that commit without saying so (#465 reverted #464 this way). For each file the pull request changes, `scripts/diff-guard.sh` takes the commits among the merge base's last 20 first parents (`DIFF_GUARD_DEPTH`) that changed it, and fails when one of their changes would apply to the pull request's tree and not to the merge base's: the pull request holds the lines as they were before that commit. It names the file and the commit. Rebase again and keep main's copy. A pull request that reverts on purpose gets the label `revert`, which lets it through with the findings printed. Run it before pushing:

```bash
just diff-guard             # origin/main against HEAD
```

### Binaries go through Git LFS

Every clone downloads every version of a plain git blob, so pictures, videos and PDFs go through Git LFS: `.gitattributes` tracks `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`, `*.ico`, `*.mp4`, `*.webm` and `*.pdf` across the repo. Install it once with `git lfs install`; after that `git add` stores the pointer and the file goes to LFS on push. The pages workflow checks out with `lfs: true`, so the site gets the real files.

`scripts/lfs-check.sh` enforces it. `just check` runs it on the index (`just lfs-check`), and `diff-guard` runs it on the pull request's head. It fails when a tracked file of one of those types is not an LFS pointer, or when a commit on the branch adds a blob over 512 KB, of any type. It names the file and the fix: `git lfs track "*.<ext>"` for a type `.gitattributes` lacks, then `git add --renormalize <file>`. A large blob stays in the branch's history until the commit that added it is rewritten, so amend or rebase it out before pushing.

Media too large even for LFS, such as the launch video, stays out of the repository. It lives as an asset of the `site-media` GitHub release, and `scripts/fetch-media.sh` downloads it into `docs-site/public/media/`, checked against a pinned sha256, whenever `just site`, `just site-dev` or `just docs` runs. To add or replace one, upload it with `gh release upload site-media <file> --clobber` and add or update its line in that script.

### Green commits

`chant.workspace.json` declares `ci.green` for main over the `ci.yml` jobs, `static` and the three `test` jobs by name, with a 24-hour window. `chant.config.ts` sets `rootOnly`, since the declaration has no members and `chant build` and `chant lint` keep building this project alone. `chant-ci-green.yml` is written by chant, not declared here. `just ci` regenerates it with `npx chant ci workflow --token-secret CI_GREEN_TOKEN`, and `just ci-check` fails when it has drifted. The tick runs `npx @intentius/chant@<version>` with the version of the installed chant, so the pin in `packages/terragucci/package.json` sets it: after a pin bump, or a change to `ci.green` or a job name, run `just ci`. chant triggers the tick on every workflow holding a required job's name, which is why `publish.yml` and its `test` jobs are in the list.

```bash
git fetch origin --tags
npx chant ci last-green                        # the newest commit on main that passed
npx chant ci tick --dry-run                    # what a tick would tag; needs GITHUB_REPOSITORY and GH_TOKEN, never CI_GREEN_TOKEN
```

The tick pushes its tags with the repository secret `CI_GREEN_TOKEN`, a fine-grained personal access token for this repository with Contents and Workflows read and write. GitHub refuses the Actions token a new ref to a commit that changes `.github/workflows/`, so without the secret such a commit gets no green tag, and the tick reports it. Nothing else needs the secret: CI, `diff-guard`, `ci-red` and every local run work without it. `chant ci workflow` writes the checkout with `token: ${{ secrets.CI_GREEN_TOKEN || github.token }}`, so without the secret the tick runs on the Actions token and a commit that changes `.github/workflows/` stays untagged; when no recent commit is green, releases go through `TERRAGUCCI_RELEASE_SKIP_GREEN=1` (below).

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes what works today and is true as written, links no issue tracker, and never says a feature is being built or planned.

## The example, the checks and the tutorial

`stack/README.md` covers the local stack, `just example`, `just smoke` and `just tutorial-capture`.

A claim is named `<area>/<part>`: the area is the behaviour it proves (`lock`, `waves`, `refuse`, `policy`), the part the flavor, forge case or variant (`lock/terragrunt`, `lock/plan`, `waves/atmos`). Forgejo, GitLab and the validation forges record the same id, told apart by their row's forge. A page's `claims:` line names parts, or an area alone, which passes only when every part of it does.

Claims are a person's runs, apart from making a change: nothing waits on one, and no page is held back by one. To run them, use `just claims-affected` (or `just claims <area or area/part>...`). `stack/claims-affected.sh` picks the claims from the change since `origin/main` and prints why it picked each one:

| Changed | Claims picked |
|---|---|
| a claim's row, group line or function in `stack/smoke.sh` or one of the `stack/smoke-claims-<n>.sh` parts it sources | that claim |
| a helper function in `stack/smoke.sh` or a part | the claims that call it |
| any other line of `stack/smoke.sh` or a part | every claim |
| a docs page | the claims its `claims:` line newly lists |
| anything else | the claims `stack/claim-paths.txt` names for its path, none when no line names it |

The picked claims run plain and under `BREAK=1`, six at a time with the locks `CLAIM_GROUPS` gives them, and their rows replace theirs in `smoke.json`. A run whose log stops growing for `SMOKE_STALL_MIN` minutes (the claim timeout plus two, 17 by default) is stopped and fails as stalled, with its last lines and the stack's job containers printed. The full `just smoke-record` runs for a release. Captures do not. Only tutorial pages hold captures, each `optional`, and a person takes one by hand when a page needs it (below). Neither a change nor a release waits on a capture, and no workflow captures.

### Capturing one step or all of them

```bash
just tutorial-capture              # every step whose smoke claims pass, from a fresh example
just capture --list                # each step: what it needs, the files it writes, what they show
just capture check                 # one step; several names capture several
just capture --reuse wave-refused  # one step on the example as it is running now
```

A capture runs on the capture stack (`TG_STACK=capture`, `stack/instance.sh`): its own Forgejo, runner and floci on host ports 100 above the shared stack's, with a lock directory of its own, so the smoke claims never wait for a capture. It holds that stack alone (`stack!`), so two captures take turns. `TG_STACK=shared just capture <step>` captures on the shared stack instead, holding the claims' `stack!` lock as an exclusive claim does. `just capture-stack-down` removes the capture stack. A capture never tears its stack down: its boot makes the example's repo afresh and wipes floci (`just example up --fresh`), and the Forgejo every worktree's token works against stays up. Before the first step it checks that the CI image the example's pipeline pins has every `terragucci` command the pipeline runs; a pipeline ahead of its published image fails its plan-note job on every pull request, and every recorded note would be missing.

The steps run in a fixed order (`STEPS` in `stack/tutorial-capture.sh`), each starting where the one before it left the example, so pull request and run numbers are the same on every capture. A step needs one of three things:

| Needs | Steps | Captured alone, the script |
|---|---|---|
| `fresh` | boot | makes the example afresh, as the step itself does |
| `chain` | first-pr, check, one-note, wave-waiting, wave-refused, approved (records nothing; it leaves the example where pin starts), pin | boots the example fresh and replays every step before it without recording anything, so its numbers match a full capture |
| `booted` | drift, see-runs, tips | resets a running example to its committed state, or boots one |

`--reuse` skips all of that. Use it when the example is already where the step expects it, and expect its pull request and run numbers to differ from a full capture's. A step whose claims do not pass in `smoke.json` is not captured; named alone, the command fails and says so.

A step writes nothing when it recorded fewer views than its `STEPS` row lists (a note or a job it could not find): its files stay as committed, the step is named, and the capture fails at the end.

Each view is recorded as text through the forge's API, never from a browser:

| Kind | Views | Recorded from |
|---|---|---|
| `markdown` | plan notes, replies, issues, pull request descriptions | the comment's or the description's Markdown, and the forge's own rendering of it (Forgejo `POST /api/v1/markdown`), so the page shows what the forge shows |
| `log` | job logs, `plan.txt` | the job's raw log, cut to the lines the page is about |
| `diff` | a pull request's or a commit's files | the forge's `.diff` |
| `html` | the report and the report index | the page floci serves, shown in a sandboxed frame |
| `table` | commit statuses, a run's jobs, tags, the repo's files | the forge's API, in the columns the forge shows |

Notes and jobs are found from the forge, never from a fixed number: a job by the run on its branch's head commit (`run_on`, `job_page`), a note by its `<!-- terragucci:plan` marker (`note_page`), a pull request by the number the command printed. The check step is the exception: after the example's check job fails, its fmt job pushes `tofu fmt`'s fix to the branch, so the failed job is found from the push run on the commit the scenario pushed (`push_run`). A step checks what it records before it records it: a plan note needs its pull request's plan-note job to have passed and the note to be there (`note_ready`), and a pull request's run has to have ended as the page says; a step that fails its check writes nothing, and the capture fails at the end.

The tips step plans the float scenario with `reports.bucket` naming the floci bucket `terragucci-reports` and records that run's `report.html` at its Tips section, as floci's S3 endpoint serves it. The drift step deletes the queue, dispatches the pipeline's drift job through the Forgejo API and records the issue it keeps, then resets the example. The see-runs step records command output only: Grafana's panels have no text form, so the page describes them.

The site's only pictures of a forge are the GitHub and GitLab settings that make `terragucci/plan` required (`docs-site/src/assets/forge/`, shown by `ForgePicture`). A person takes those by hand when the forge's page changes; no capture writes them.

### What makes a capture stale

Each step writes only its own file, `docs-site/src/data/tutorial/<step>.json`. It holds the commands and their normalized output, `source_hash` (a hash of every file under `example/`, with the image references in its pipeline left out, since a release moves them and no capture shows them) and `views`, each view the step recorded. A step is rewritten when anything in it differs from what is committed. Otherwise its file is kept.

`just tutorial-check` holds the pages to these rules:

- only a tutorial page holds a `<Captured>` or a `<Recorded>`; any other page fails the check;

- a `<Captured>` step is stale when its `source_hash` is not the hash of `example/` as it is now;
- a `<Recorded>` view is stale when its step is, and missing when its step's JSON has no such view.

Every capture on a tutorial page is `optional`: until it is taken the page renders without it. An optional capture never taken and a stale one do not fail the check; it prints one line naming the steps of each and passes. A capture without `optional` must exist. `just tutorial-check --strict` fails on each one not taken or stale, page by page; run it before and after a capture.

Recapturing one step makes that step current and leaves every other step as it was: current if it was captured from the same `example/`, stale if not. Each step carries its own hash, so a fresh step cannot make another step look fresh. After an edit under `example/`, every step is stale until someone recaptures it with `just tutorial-capture`, or `just capture` with each stale step the check names. `manifest.json` records the date, commit and tool versions of the last capture that changed anything. It is for contributors and the check does not read it.


### The example on GitLab

`just example-gitlab` runs the same 15 roots on the stack's GitLab CE profile, applied to floci by GitLab CI, for the docs' GitLab views. It is `stack/example-gitlab.sh`, which shares `stack/lib.sh` with the Forgejo example (`LIB_FORGE=gitlab`) and takes its merge request helpers from `stack/forge-gitlab.sh`.

```bash
just example-gitlab up                  # boot the gitlab profile, push the example, apply every root
just example-gitlab change module-bump  # a merge request with one scenario from example/changes
just example-gitlab change destroy
just example-gitlab merge destroy       # merge it; wave 4 waits and prints its approve command
just example-gitlab approve             # approve as the reader, retry the waiting job, wait for the apply
just example-gitlab reset               # close merge requests, drop branches, apply the example again
just example-gitlab verify              # every resource main declares is in floci
just example-gitlab logs                # the failing lines of the last pipeline with a failed job
just example-gitlab change drift        # delete a queue, run the drift schedule, print the issue
just example-gitlab plan-comment        # note /terragucci plan on change/one-root and wait for the re-plan
just example-gitlab pr-apply            # apply before merge: a reviewer approves, /terragucci apply applies and merges
```

The GitLab views the docs place in their GitLab tabs (the plan note, the note after `/terragucci plan`, the failed check, the waiting wave's log, the drift issue and the reply of an apply before merge) come from `just example-gitlab capture`, which records them as text in `docs-site/src/data/tutorial/gitlab.json`. On the GitLab lab it is `TGLAB=1 just example-gitlab up`, then `TGLAB=1 just example-gitlab capture`, about 15 minutes; there the jobs run this tree's bundle in the lab's own image, as the GitLab claims do.

| Step | Took on an Apple silicon Mac, GitLab under emulation |
|---|---|
| `just stack-up gitlab` | about 2.5 minutes; ten or more on a slower machine |
| `up` on a running GitLab | about 3.5 minutes |
| `change` (plan and check pipelines) | about 40 seconds |
| `merge destroy`, to the waiting wave | about 4 minutes, with the pipeline that lists the reader's key |
| `approve`, the retried wave applied | about 50 seconds |
| `change drift`, to the issue | about 2 minutes |
| `reset` | about 2 minutes |

What differs from the Forgejo example:

| | Forgejo (`just example`) | GitLab (`just example-gitlab`) |
|---|---|---|
| Pipeline | `example/.forgejo/workflows/terragucci.yml`, committed | `.gitlab/terragucci.yml` and the `.gitlab-ci.yml` that includes it, written at push time by `terragucci init` with `forge: gitlab` added to `terragucci.yml` |
| Image | pushed by tag, digest pins stripped (`push_tree`) | the same |
| Approve | `chant approve` only; the reader re-runs the stage | `chant approve`, then the waiting `apply-wave-N` job is retried, as the docs tell a GitLab reader to |
| Drift | `change drift` deletes the queue | deletes the queue, then runs the pipeline schedule `terragucci drift` (made on first use) |
| Pin | `change pin` | not on GitLab |
| Project | `terragucci-admin/example` | `root/example`, public, with the CI variable `GITLAB_TOKEN` |

The generated jobs push to `${CI_SERVER_PROTOCOL}://oauth2:...@${CI_SERVER_FQDN}/<project>.git`, the server's own protocol, host and port. The stack's GitLab serves plain http on `gitlab:8929`, which those variables carry, so the jobs need no address rewrite. A waiting wave fails its job with exit code 3 and fails `terragucci/apply`, so the pipeline ends.

#### GitLab views

`just example-gitlab capture` records the one GitLab view the tutorial shows, the plan note of a one-root merge request, and writes it as the tutorial step `gitlab` (`docs-site/src/data/tutorial/gitlab.json`), the way `just sandbox capture` writes `github`. The note is its Markdown and GitLab's rendering of it (`POST /api/v4/markdown`). A page uses it as `<Recorded step="gitlab" view="note" ... optional />`. `TGLAB=1` runs any of these commands on the GitLab lab instead of the gitlab profile.

The "Pipelines must succeed" setting the docs show is a picture taken by hand (`docs-site/src/assets/forge/gitlab-required-*.png`); `capture` turns the setting on while it runs, as on a reader's project.

### The smoke claims on GitLab

A smoke claim ported to GitLab runs on the GitLab lab, `stack/gitlab/`: GitLab CE, a gitlab-runner and floci under a compose project of their own (`tglab`), beside the validation stack and touching none of its names. `stack/README.md` (The GitLab lab) has its ports, what it costs the machine, and how a run on it is laid out.

```bash
just gitlab-lab up                    # several minutes; nothing else starts it
just gitlab-claims tips note-footer   # plain and under BREAK=1; GitLab rows into smoke.json
just gitlab-lab down
```

`SMOKE_FORGE=gitlab` switches `stack/smoke.sh` to the claims in `stack/smoke-gitlab.sh` (`GITLAB_CLAIMS`, `GITLAB_CLAIM_GROUPS`, `gitlab_claim_<area>/<part>`). A port is a new line in `GITLAB_CLAIMS` with the name of the Forgejo claim it matches, its group line and its function, and `just lint` holds the table to the same rules as `CLAIMS`. Its row in `smoke.json` carries `forge: "gitlab"`, sits after the Forgejo row of the same claim, and shows in the GitLab column of the validation page.

### The core claims on Terraform and choudoufu (SMOKE_BINARY)

```bash
just binary-claims terraform              # every core claim on Terraform, plain and under BREAK=1
just binary-claims choudoufu waves,drift  # some of them on choudoufu
```

`SMOKE_BINARY=terraform|choudoufu` keeps `stack/smoke.sh` to the claims in `BINARY_CLAIMS` and runs each on that binary: `stack/binary-tree.py` writes the claim's tree for it (`binary:`, and under choudoufu a `live` block per root with its records in `terragucci-smoke-records`, reached through a proxy of the claim's own, since choudoufu addresses the bucket virtual-hosted), and the stage runs use its CI image. The example claims (boot, report, drift) run on a copy of the example of the binary's own, `example-<binary>` with names under `shoptf-` or `shopcdf-`, so they never touch the example the other claims read. A row carries `binary: "terraform"` or `"choudoufu"`, sits after the OpenTofu row of the same claim, and shows in that binary's column of the validation page. A feature the binary cannot run is a config error with a claim of its own that proves the refusal, never a claim left out of `BINARY_CLAIMS`.

### A claim's feature area

The coverage grids on the validation page count each claim under a feature area from `docs-site/src/data/claim-areas.json`, keyed by claim name. The recorders rewrite `smoke.json` and `validation.json`, so the areas live in that file and not in the rows. A new claim in `CLAIMS`, `GITLAB_CLAIMS`, `stack/validation.sh` or `PROVE_CLAIMS` needs a line there, and `just test` fails until it has one (`test/claim-areas.test.ts`). A claim that sets the binary in its own config (`with binary: terraform` in its description, or a `cdf-` claim) also goes under `binary`, so its row counts in that binary's column. The grid's repo shape comes from the claim's prefix (`tg-`, `atmos-`, `terramate-`, `cdktn-`); `import/terragrunt-scale` counts as Terragrunt too.

### Filling the coverage gaps

`just coverage-gaps` lists what the validation page still lacks, and what fills each gap:
- grid cells that are not proven, from the code the grids render with (`docs-site/src/data/coverage.ts`);
- claims a table defines with no recorded row;
- captures under `docs-site/src/data/tutorial` that quote a command terragucci no longer prints.

The page's "What is left" list shows the same cells, without the commands.

`just coverage-fill` with no step prints the plan. With steps it runs them in order, each holding one source:
- `forgejo`
- `terraform`
- `choudoufu`
- `gitlab`, which boots the lab and takes it down again if it booted it
- `github`, the github.com sandbox: prove, prove under BREAK, then captures
- `validation`, which takes the whole stack down, so it runs only with `--exclusive`

Run it on demand, when the host is quiet. Review the rows and captures it writes, and commit them. A cell that reads "none" for a repo shape, or for a forge, needs a new claim first. `coverage-gaps` names which.

Neither command runs in CI. Every test bench, `coverage-fill` included, asks a person to type `run` in their own terminal before it starts (`stack/human-gate.sh`). Without a terminal it stops with exit 3, so a coding agent cannot start one, unless you granted it: `just grant <claim>... [--runs N] [--hours H]` (or `capture`) asks you to type `run` once and lets an agent run those claims that many times each (2 by default) for that long (4 hours). A granted run stops itself after 5 minutes with nothing written. `just grant --show` lists what is left and `just grant --end` ends it. The nightly, capture and scale workflows are disabled; `gh workflow enable <name>` turns one back on.

### The real-AWS pilot (SMOKE_AWS=1)

floci is the AWS the smoke claims run against, in `just smoke`, `just smoke-record` and CI. `SMOKE_AWS=1` runs five of them on a real account instead, the one the default AWS CLI profile signs in to: boot, drift, respond-drift, tg-drift and report. Any other claim exits with a refusal under it, and so does `--record`, since `smoke.json` is floci's record. forgejo-oidc stays on floci. The ruling and the cost research are in terragucci#116.

```bash
SMOKE_AWS=1 SMOKE_AWS_MEASURE=1 stack/smoke.sh boot   # the measured boot run
just smoke-aws-count                                  # its requests by service and operation
SMOKE_AWS=1 stack/smoke.sh boot                       # any one of the five; BREAK=1 as usual
SMOKE_AWS=1 stack/smoke.sh                            # the five, plain (BREAK=1 for broken)
just smoke-aws-cleanup --list                         # what the run left, by name
just smoke-aws-cleanup                                # list it, then delete it
```

Before anything touches AWS, `stack/smoke-aws.sh` checks two things and refuses to start if either fails. A cost budget must have an alert at $1 or less (`aws budgets describe-budgets`, then each budget's notifications; an absolute threshold, or a percentage of the limit that comes to $1 or less). The month's unblended spend from Cost Explorer (`aws ce get-cost-and-usage`) must be under $5. Cost Explorer bills $0.01 a request and lags by up to a day, so a passed check is kept in `stack/.state/smoke-aws/guard` for 30 minutes (`SMOKE_AWS_GUARD_TTL`, in seconds), and the cap only holds because a pass costs cents. `stack/smoke-aws.sh guard` and `stack/smoke-aws.sh spend` run either check alone.

Every name carries a run prefix: `SMOKE_AWS_PREFIX`, or `tgsmoke-` and six hex digits, made once and kept in `stack/.state/smoke-aws/prefix`. Buckets, queues and tables are `<prefix>-<the floci name>`, state is in the bucket `<prefix>-terraform-state` under `<prefix>/`, and the report claim's bucket is `<prefix>-terragucci-reports`. All five claims share the prefix, so drift and report read the estate boot applied. A cleanup that leaves nothing behind forgets the prefix, and the next run makes a new one, which keeps S3 and SQS from meeting a name they deleted moments ago.

`example/` and `example-terragrunt/` are not edited. Each copy a claim pushes or runs gets the changes instead:

- every plain root, and `modules/service`, gets `smoke_aws_override.tf`: the backend and the `terraform_remote_state` reads in the prefixed bucket and key, the provider addressing S3 virtual-hosted, and the prefix on each literal bucket, queue and table name and on the module's `shop-` local. The roots set no endpoint or `skip_*` setting of their own; floci comes from `AWS_ENDPOINT_URL` in the environment, which the mode leaves out.
- the Terragrunt copy's `root.hcl`, which generates each unit's `backend.tf` and `provider.tf`, gets the prefixed bucket and key and path-style off, and `live/common.hcl` gets the prefix on `shop`. Terragrunt writes those two files itself, so an override file beside them would compete with its backend settings.
- the pipeline's jobs ask for `runs-on: smoke-aws` in place of `docker`.

Credentials come from the default profile (`SMOKE_AWS_PROFILE` names another) through `aws configure export-credentials`. Long-lived keys are traded for a one-hour session with `sts get-session-token`, so no container sees them. The keys are exported to the smoke process only; a claim's `docker run` passes them by name (`-e AWS_ACCESS_KEY_ID`), so they never appear on a command line. Pipeline jobs get them from a second Forgejo runner, `terragucci-smoke-aws`, the only runner with the `smoke-aws` label. `example.sh up` and `example-terragrunt.sh up` start it for the push and remove it, container and registration, when they exit. Its config sits on a tmpfs inside its container. The stack's own runner keeps floci's `test` keys, so a floci claim cannot reach AWS. Nothing in the repo or the forge holds the keys, and the scripts never echo them.

Wipes and checks use the aws CLI and match only prefixed names. boot's wipe deletes the plain example's buckets with their objects, its queues and tables, and its state under `<prefix>/envs/`, then waits 65 seconds, because SQS refuses a deleted queue's name for 60. drift and tg-drift delete their queue with the CLI and wait until SQS stops answering for it, and before a claim applies it again it waits out the same 60 seconds. tg-drift boots the Terragrunt example on AWS itself when its queue is not there, since tg-waves does not run in this mode.

`just smoke-aws-cleanup` lists every bucket (with its object count), queue and table whose name starts with `<prefix>-`, then deletes them, the state bucket and every key in it included, and lists again: anything still there is printed and the command fails. It also removes a SMOKE_AWS runner a crashed run left and the prefix's debug logs. `--list` only lists. `--all` takes every name starting with `tgsmoke-`, for prefixes a lost `stack/.state` no longer names. Cleanup never makes a prefix. A custom `SMOKE_AWS_PREFIX` needs the same variable set when you clean up.

`SMOKE_AWS_MEASURE=1` sets `TF_LOG=debug` on the SMOKE_AWS runner, with `TF_LOG_PATH` pointing every job's log at `/cache/smoke-aws-logs/<prefix>/<example>-<time>.log` in the job cache volume, out of the job logs. `just smoke-aws-count` reads the newest of those, and `just smoke-aws-count <file>` any log on disk. `stack/smoke-aws-count.py` counts each "HTTP Request Sent" line from the provider and the S3 backend, retries included, by service and operation, and prices them at the us-east-1 list prices of the research (S3 PUT, COPY, POST and LIST at $0.005 per 1,000, other S3 requests at $0.0004 per 1,000, SQS at $0.40 per million, DynamoDB's control plane, IAM and STS free). It prints nothing else from the log. Only the pipeline's jobs are measured; the claims' own `docker run` plans and the CLI's wipes and checks are not, so the spend delta from Cost Explorer, a day later, is the full figure.

### The GitHub sandbox

The docs' GitHub views come from [INTENTIUS/terragucci-sandbox](https://github.com/INTENTIUS/terragucci-sandbox), a public repo on github.com run by `stack/sandbox-github.sh`. It needs no stack, no cloud account and no secret in the repo. It needs `gh`, `jq`, Python 3, Docker (for the roots' state) and `npm ci` (for chant).

```bash
just sandbox up                    # push the first commit if the repo is empty; --fresh replaces it
just sandbox change one-root       # a pull request with a scenario, and its plan note
just sandbox plan-comment one-root # comment /terragucci plan on it and wait for the re-plan
just sandbox merge one-root        # merge it; a green apply commits the state it left
just sandbox change destroy
just sandbox merge destroy         # wave 4 waits, with its approve command
just sandbox approve               # chant approve --plan ... --sign, then re-run the stopped jobs
just sandbox approve --hold        # approve only; then change and merge module-bump: wave 4 is refused
just sandbox drift                 # delete a file staging orders keeps, run the drift job, wait for its issue
just sandbox pr-apply              # apply before merge: /terragucci apply applies and merges a pull request
just sandbox reset                 # close the pull requests and issues, delete the branches, tags, secrets and the environments prod and dev, main back to its first commit
just sandbox minutes 2026-10-07T00:00:00Z   # Actions run time since then
just sandbox capture               # all of the docs' GitHub views, from reset to reset
just sandbox prove                 # the github.com claims, from reset to reset; a phase name runs one; --record FILE writes their rows
just sandbox prove --break         # the locking and report claims, each with its property broken; --record FILE writes their breaks
```

`just sandbox prove` runs four phases; `just sandbox prove merge` (or `pull-request`, `modules`, `reports`, `audience`, `groups`, `check-job`, `trust-policy`, `forge-check`) runs the ones named. `audience` runs only when named, on a release whose `init` takes `oidc.audience` as a map (from the release after 0.4.8): `TERRAGUCCI_SANDBOX_RELEASE=<version> just sandbox prove audience`, and `--break` for its BREAK. `groups` likewise, on a release whose `init` renders an apply job per environment (from the release after 0.4.8): `TERRAGUCCI_SANDBOX_RELEASE=<version> just sandbox prove groups`. `check-job` and `trust-policy` likewise, on a release whose `init` renders an apply job per environment with its `terragucci check-job` line (from the release after 0.4.8); `trust-policy` also builds this checkout's CLI for `terragucci config identities --json`, as an operator runs it. `forge-check` likewise, on a release with `terragucci forge check` (from the release after 0.4.8): `TERRAGUCCI_SANDBOX_RELEASE=<version> just sandbox prove forge-check`, and `--break` for its BREAK, which runs a bundle built from this checkout instead of the release. Each phase starts from a reset sandbox whose main it sets up with `[skip ci]` commits, lets `init` of the release rewrite the pipeline, runs its claims, and resets the sandbox. The merge phase takes about 35 minutes and the pull-request and modules phases about 20 together; the reports phase runs two plans and the estate workflow.

| Phase | main gets | Claims |
|---|---|---|
| `merge` | `locks: plan`; a `policy` whose Rego denies a replacement, and holds the OIDC probe's input when it is set to `held-for-an-override`, with `override: [sandbox-signer]`; `oidc` with a plan and an apply role; `agent.comment` running `.agent/stand-in.sh`, whose push token is the secret `SANDBOX_AGENT_TOKEN` (the run's token, deleted by reset); `.chant/allowed_signers` listing this run's key as `sandbox-signer` and `sandbox-stranger`; `envs/dev/oidc`, a root whose `data "external"` program checks the job's OIDC token and writes what it found to `terragucci-report/oidc-<kind>.json`; and the `explain-refusal` job of the refused-wave guide for wave 4, its model step swapped for a stand-in | every claim from `affected` to `drift/issue` below, except the `pr-apply/tofu` and module ones |
| `pull-request` | `apply.when: pull-request`, first with `merge: manual`, then `merge: auto`, then `merge: auto` with `merge_token_env: SANDBOX_MERGE_TOKEN`; and `.github/workflows/sandbox-open.yml`, which opens the phase's pull requests as `github-actions[bot]`, so the account running prove may approve them | `lock/apply`, `pr-apply/stale`, `pr-apply/tofu`, `pr-apply/token` |
| `modules` | `modules.publish: git-tags` | `publish`, `rollout` |
| `reports` | `reports` in the bucket `tg-reports` of floci at `http://floci:4566`, prefix `sandbox`, first with keys in the repo secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, then with `reports.role` and `oidc` and no secret; `env` sending every STS request to `http://127.0.0.1:4599`; `.sandbox/stand-in.mjs`; and in the plan job init writes, floci as a service container, a step that starts the stand-ins and steps that keep the bucket's objects and what the recorder found as the `sandbox-stand-in` artifact | `report/keys`, `estate/job`, `report/oidc` |
| `audience` | `oidc` with a plan and an apply role and `audience` mapping `plan`, `apply` and `drift` to `terragucci-plan`, `terragucci-apply` and `terragucci-drift`; `envs/dev/oidc` with a program that checks the job's token, evaluates the trust of the two roles (`trust-plan.json` and `trust-apply.json`, each admitting its own audience for this repo) on it, and writes what it found to `terragucci-report/audience-<kind>.json` | `oidc/audience-stages` |
| `check-job`, `trust-policy` | the deployment environments `prod` and `dev`, each with a deployment branch rule letting `main` alone deploy (made through the API, deleted by reset); `oidc` with a plan and an apply role; `environments` `prod` (roots `envs/prod/oidc`) and `dev` (roots `envs/dev/oidc`), each with its own plan and apply role and `forge_environment` of its name; both roots with a program that checks the token of the root's role, evaluates on it the trust of the prod and dev apply roles (`trust-<env>-apply.json`, the `assume_role_policy` that `terragucci config identities --json` of this checkout prints for each), fails an apply job whose own role's trust refuses it, and writes what it found to `terragucci-report/envs-<job>--<env>.json` | `apply/check-job`, `identities/trust-policy` |
| `groups` | the deployment environments `prod` and `dev`, each with a deployment branch rule letting `main` alone deploy (made through the API, deleted by reset); `oidc` with a plan and an apply role; `environments` `prod` (roots `envs/prod/oidc`) and `dev` (roots `envs/dev/oidc`), each with its own plan and apply role and `forge_environment` of its name; both roots with a program that checks the token of the root's role, records `TERRAGUCCI_ROOT_ROLES`, evaluates the trust of the four roles (`trust-<env>-<plan\|apply>.json`: a plan role admits this repo's pull requests and `main`, an apply role this repo's environment of its name alone) on it, fails the job when its own role's trust refuses it, and writes what it found to `terragucci-report/groups-<job>--<env>.json` | `apply/groups` |
| `forge-check` | nothing on main and no workflow run: the deployment environment `prod` with a deployment branch rule letting `main` alone deploy (made through the API, deleted by reset), then with no rule; a config on this machine with `environments` `prod` (`forge_environment: prod`), which `forge check` of the release reads with the sandbox's token | `forge/check` |

| Claim | Steps | Holds when |
|---|---|---|
| `affected/tofu` | `change one-root` | the plan note's first line covers `envs/dev/orders` alone and `terragucci/plan` counts 1 root |
| `note/footer` | the same note | its last line is the taco footer, and the image answers 200 with a PNG |
| `tips/tofu` | the same note | the note counts as many tips as the run's `report.json` holds, each with a rule and an https page |
| `comment/plan` | `plan-comment one-root` | the comment's run finishes its `replan` job and the note was edited after the comment |
| `lock/comment` | `change orders-note` | one-root's `terragucci/lock` holds `envs/dev/orders`; orders-note, a second change to that root, fails it, and its reply names the root and pull request one-root |
| `agent/comment` | `/terragucci agent ...` twice on orders-note | the first pushes one commit on its head, which the reply links and `terragucci/plan` passes on; the second, which also edits the pipeline, is refused naming the file, and the branch stays |
| `policy/tofu` | `change replace` | `terragucci/plan` fails and the note names the denial |
| `oidc/job` | `change oidc`, `merge oidc` | in the pull request's plan job and main's apply job, the token verifies against GitHub's keys and names the repo, run, commit, event and `sts.amazonaws.com`; the plan job holds the plan role and the apply job the apply role |
| `comment/apply` | `/terragucci apply` on the merged oidc pull request, on one-root, and on the merged destroy while wave 4 waits | the first applies waves 1 to 4 from the merge commit and links the run; one-root is refused as not merged; the destroy's reply says wave 4 waits and gives `chant approve ... --sign` |
| `policy/override` | `change override`, `merge override`, `terragucci override` as `sandbox-stranger` then as `sandbox-signer`, each followed by a re-run | wave 1 is denied, still denied with "not listed" after the first override, and applies after the second; the wave's report names the override, its rules, reason and plan digest |
| `apply/serial` | `change module-bump`; merge it, and merge orders-note once its wave 1 is applying | none is cancelled, both runs pass, the older run's wave 1 starts first, each merge commit's newest `terragucci/apply` is a success, the older one's says it was superseded by a newer push and the newer one's says the tree applied; waves of the two runs may run side by side |
| `approval/gate` | `change destroy`, `merge destroy`, `approve --hold`, then the re-run of `note/approve-command` | wave 4 stops with its approve command, and the re-run after a sealed approval succeeds |
| `respond/explain-refusal` | `change refuse`, `merge refuse` | wave 4 is refused, since its last approval was for the destroy's plan and no run applied it, and the `explain-refusal` job passes and prints `envs/staging/payments` among the roots that moved |
| `note/approve-command` | `terragucci approve --dry-run`, then `terragucci approve`, in a clone; the re-run | the dry run prints the command and the ledger keeps its length; the approval names wave 4 with no digest given, and the re-run applies both destroys |
| `drift/issue` | `drift`, then two more drift runs, the file put back before the last | the issue the first opens is the only open one after the second, which updates it, and the third closes it with "No drift at" |
| `lock/apply` | two pull requests on `envs/dev/orders`; `/terragucci apply` on the first, then the second, `/terragucci unlock` on the first, apply on the second | the first applies, the second is refused naming the root and the first, the unlock releases it, and the second then applies |
| `pr-apply/stale` | a pull request on `envs/dev/payments`, then a commit to main, then `/terragucci apply` | the reply says it is not up to date with main, and the job applied nothing |
| `pr-apply/tofu` | `merge: auto`; a pull request on `envs/dev/search` and `/terragucci apply` | the reply says every wave applied from the head and the pull request merged, and it is merged |
| `pr-apply/token` | `merge: auto` with the merge token; a pull request on `envs/dev/email` and `/terragucci apply` | as `pr-apply/tofu`, merged by the token's user, and the merge commit has a push run on main |
| `modules/publish` | a `feat(service):` commit to main | the run's `publish` job passes and the sandbox has one tag, `modules/service/v<version>` |
| `rollout/tofu` | every root pinned to that tag with `[skip ci]`, a second `feat(service):` commit, then `terragucci rollout modules/service <version> --mode apply` in a clone | the pull request it opens changes files under `envs/dev/` alone, moving their pin to the new tag |
| `report/keys` | the keys in the repo secrets, `change one-root` | the plan job maps the secrets; the index at the top of the prefix lists the head, and its `report.json` is in the bucket |
| `estate/job` | the GitHub workflow of the see-every-project page, its role moved to floci's account, committed as `.github/workflows/estate.yml` with floci, the recorder and the keep steps added to its job and report-keys' bucket as the seed; `gh workflow run estate.yml` | the workflow maps no secret; the job passes; the recorder saw `configure-aws-credentials` take the page's role with a token that verifies against GitHub's keys and names the repo, run, commit, `workflow_dispatch` and `sts.amazonaws.com`; `estate.html` is in the bucket, `estate.json` shows the project with report-keys' plan, and the log has a presigned link |
| `report/oidc` | `reports.role` and `oidc`, the secrets deleted, `change one-root` | the pipeline maps no key; the recorder saw the plan job take `reports.role` with a token that verifies as for `estate/job`, for `pull_request`; the index lists the head, and its `report.json` is in the bucket |
| `oidc/audience-stages` | `change oidc`, `merge oidc` | the plan job's token verifies against GitHub's keys and carries `terragucci-plan` alone, which the plan role's trust admits and the apply role's refuses; the apply job's carries `terragucci-apply`, which only the apply role admits; neither job's probe, a child of the binary, holds `ACTIONS_ID_TOKEN_REQUEST_URL` or `ACTIONS_ID_TOKEN_REQUEST_TOKEN` |
| `apply/check-job` | `change environments`, `merge environments`; a commit to main that moves the prod apply job into the environment `dev`; `change environments`, `merge environments` | in the first run the prod apply job's log has its check naming the forge environment `prod` and `refs/heads/main`, and its probe ran; in the second the job fails, its log naming `forge environment: expected prod, found dev` and that it stops before any cloud credential is taken, and its probe wrote nothing |
| `identities/trust-policy` | `change environments`, `merge environments` | the prod apply job's token verifies against GitHub's keys and its subject is `repo:<owner>/<repo>:environment:prod`, which the prod apply role's trust from `config identities` admits; the dev apply job's token names the environment `dev`, which that trust refuses and the dev apply role's admits |
| `apply/groups` | `change groups`, `merge groups` | the prod group's apply job's token verifies against GitHub's keys and its subject is `repo:<owner>/<repo>:environment:prod`, which the prod apply role's trust admits and the dev one's refuses; the dev group's job's token names the environment `dev`, which the prod apply role's trust refuses; each job's `TERRAGUCCI_ROOT_ROLES` holds its own environment's apply role alone |
| `forge/check` | `forge check --json --no-roots` on this machine, twice | with `prod` deploying from `main` alone it exits 0 and its `environment` and `deployment-branches` rows match (`custom: main`); with the rule removed it exits 1 and the `deployment-branches` row is a mismatch expecting `deploys from main only` and finding `any branch: no deployment branch rule`. The token is the sandbox's admin token, so this run does not show that the command needs no write scope; the Forgejo and GitLab claims do |

No token is traded with AWS: the sandbox has no cloud account (the Forgejo claim `oidc/forgejo` does the trade). The report claims trade theirs with floci's STS, through the recorder, inside the job; floci takes any token, so the recorder's checks stand in for the trust a role's policy would check. One account drives the sandbox, so no claim comments as a non-writer or from a fork; those refusals are Forgejo claims. `--record docs-site/src/data/validation.json` writes each claim the run made as a `github.com` row, in place of that claim's last row and keeping its `break`, after the `github` rows.

`just sandbox prove --break` (or `BREAK=1`) runs the locking and report claims again, each on a sandbox whose property it proves is broken on purpose, as `BREAK=1` does for a smoke claim: the merge phase's `lock/comment`, `lock/comment-fmt` and `apply/serial`, the pull-request phase's `lock/apply` and `pr-apply/stale`, then the reports phase's `estate/job`, seeded by a plan with the keys, `report/keys` and `report/oidc`, from reset to reset. A claim that fails is the break `caught`, one that passes is `missed`, and so is one whose scenario could not be set up. With `--record FILE` each break goes into the `break` of its claim's `github.com` row, which the Locking and staleness page shows as proven once the claim also passes plain.

| Claim | Its BREAK |
|---|---|
| `lock/comment` | once one-root holds `envs/dev/orders`, `_locks/tf-apply.json` is deleted from `chant/lifecycle`, so orders-note takes the root instead of failing `terragucci/lock` |
| `lock/comment-fmt` | the fmt job's step that locks the pull request's new head is cut from the committed pipeline, so nothing answers the lock on the formatted head |
| `apply/serial` | each apply wave's stand-down for a newer push (the check at the top of the wave and the stage's `--stand-down`) is cut from the committed pipeline, so the older run applies after the newer push lands and its commit is not marked superseded |
| `lock/apply` | once the first pull request applied, `_locks/tf-apply.json` is deleted from `chant/lifecycle`, so the second applies instead of being refused |
| `pr-apply/stale` | main's `apply.requires` is `[approved, mergeable, checks]`, leaving out `undiverged`, so the head behind main applies |
| `report/keys` | the repo secrets are deleted, so the plan job maps them empty and writes nothing to the bucket |
| `report/oidc` | `oidc` is cut from main's `terragucci.yml`, so the plan job has no token to take `reports.role` with |
| `estate/job` | `id-token: write` is cut from the page's workflow, so `configure-aws-credentials` has no token for the role |
| `oidc/audience-stages` | the line that restarts a step without the token-request variables is cut from every step of the committed pipeline, so the binary and the probe keep them (run with `prove audience --break`) |
| `apply/check-job` | the commit that moves the prod apply job into `dev` also cuts its `terragucci check-job` line, so the job fetches its token and its probe runs in `dev` (run with `prove check-job --break`) |
| `identities/trust-policy` | the trust comes from a CLI bundle whose GitHub apply subject leaves out the forge environment and names the ref (`identities.ts`), so the prod apply role's trust refuses its own job (run with `prove trust-policy --break`) |
| `apply/groups` | `environment: prod` is cut from the prod group's apply job in the committed pipeline, so its token's subject names the ref and the prod apply role's trust refuses its own job (run with `prove groups --break`) |
| `forge/check` | forge check runs a bundle built from this tree whose deployment branch comparison takes a missing rule and any list of custom policies as the default branch alone, so the widened environment reports a match (run with `prove forge-check --break`) |

`just sandbox prove` runs on the newest published release, a phase at a time; a person runs it, and no workflow does. Each phase keeps `prove.json` and the logs; prove rewrites `prove.json` after every verdict, so a run stopped part way keeps the verdicts it reached. It needs `TERRAGUCCI_SANDBOX_TOKEN` (or `gh auth token`): a token from an admin of the sandbox, fine-grained on INTENTIUS/terragucci-sandbox with Administration, Contents, Workflows, Pull requests, Issues, Actions and Secrets read and write and Commit statuses read, or classic with `repo` and `workflow`.

`just sandbox capture` resets the sandbox, runs `change one-root`, records the plan note it posts, writes it as the step `github`, and resets the sandbox again. The note is its Markdown and GitHub's rendering of it (`gh api markdown`, gfm, in the sandbox's context). A page uses it as it uses a Forgejo step's: `<Recorded step="github" view="note" alt="..." optional />`.

The file is `docs-site/src/data/tutorial/github.json`, so `just tutorial-check` holds a page that shows them to the same rules as the Forgejo steps.

| Piece | How |
|---|---|
| Roots | `example/` with each AWS resource made a `terraform_data` whose `input` holds its arguments and whose `triggers_replace` holds the ones that replace it. A scenario is `example/changes/<s>.patch` applied to the example and converted the same way, so `example/` stays the only source. `float`, `drift` and `pin` have no plan-only form. |
| State | `local`, in each root's `terraform.tfstate`, committed. The only store a GitHub-hosted job reaches without an account is the repo. `main.tf` keeps its `s3` backend and `state_override.tf` replaces it, so `init` finds the same four waves as on the example. The runner's disk is gone after a job, so after a green apply the script applies the same tree in the pipeline's image and commits the state with `[skip ci]`. |
| Pipeline | `npx @intentius/terragucci@0.4.0 init` (`TERRAGUCCI_SANDBOX_RELEASE`), pinned by digest to the published images, which mark every checkout safe for git. `TERRAGUCCI_SANDBOX_SAFE_DIRECTORY=1` adds an `env` that does the same, for running the sandbox on 0.3.0, whose container jobs ran git as root in a checkout the runner's user owns. |
| Drift | `terraform_data` reads nothing back, so a refresh finds no drift in it. `drift` adds a `local_file` to staging orders, applies it into the state, and deletes the file on main with `[skip ci]`; the drift job's refresh then finds it gone. |
| Ruleset | `terragucci/plan required`, made by `up` and `capture` when missing: the default branch requires the `terragucci/plan` status. The docs show it in a picture taken by hand (`docs-site/src/assets/forge/github-required-*.png`). Repository admins bypass it, so the script's own pushes and merges to main go through. |
| Signer | an ed25519 key made by `up` and `reset` in the scratch directory, listed as `sandbox-signer` in `.chant/allowed_signers` on main by the first `merge`. Its private half never leaves the scratch directory. |
| Token | `TERRAGUCCI_SANDBOX_TOKEN`, else `gh auth token`, read at run time and handed to `gh` (`GH_TOKEN`) and to git (a credential helper in `GIT_CONFIG_*` that reads the variable) in the script's own environment. It is never written to a file, a git config or a log. |

Scratch files go in `TERRAGUCCI_SANDBOX_DIR` (default `$TMPDIR/terragucci-sandbox`): `signer`, `views/` (one JSON file per recorded view) and `logs/`.

GitHub shows a job's log only to a signed-in reader, so `prove` keeps the logs it reads in `logs/`.

The repo is public, so its Actions minutes on GitHub-hosted runners are free. A pull request costs two runs and a merge one run of seven jobs.

## The scale bench

`stack/scale/` runs the generated pipeline over a terralith carved into many roots across several repos, one control repo over them, and writes each run's record into `docs-site/src/data/scale.json`. It has its own compose project (`tgscale`): its own Forgejo on port 3410, floci on 4690, runner and job cache, so it runs beside the validation stack and touches nothing named `terragucci-*`. It calls no cloud. It needs Docker, Python 3, Go and `jq`.

```bash
just scale up                 # Forgejo, one runner, floci
just scale run 1 4            # terralith scales: 1 is 79 resources, 136 is 10,069
just scale record             # fold the runs into docs-site/src/data/scale.json
just scale down               # its containers, network and volumes
```

| Variable | Default | What it sets |
|---|---|---|
| `TGSCALE_RELEASE` | the newest on npm | the published release whose `reconcile` writes the pipelines and whose images the jobs run |
| `TGSCALE_BUILD=tree` | unset | runs this tree instead: its bundle reconciles, and one more commit on each pipeline pull request points the jobs at `tgscale-tofu:<commit>`, the release's tofu image with the tree's bundle in it; the commit is the newest one of `packages/terragucci`, so the run refuses uncommitted changes there |
| `TGSCALE_CAPACITY` | 3 | jobs the runner runs at once (set at `up`) |
| `TGSCALE_PARALLELISM` | 4 | `parallelism` in each repo's `terragucci.yml` |
| `TGSCALE_ROOTS_PER_REPO` | 100 | identity roots per repo |
| `TGSCALE_CHOUDOUFU_REF` | a pinned commit | the choudoufu commit `terralith-gen` is built from; `CHOUDOUFU_DIR` names a checkout, else the script clones one into `stack/scale/.state/` |
| `TGSCALE_PHASE_TIMEOUT` | 14400 | seconds a phase may take before the run fails |

`carve.py` splits the terralith and checks the carved roots declare exactly its resources. Each root gets `stack/scale/terraform.lock.hcl` as its lock file. `scale.sh` drives the phases (reconcile, create, plan, change) through Forgejo's API, fails the run on the first phase whose runs do not all succeed, and counts the resources in the state files. `summarize.py` writes the run's record to `stack/scale/.state/runs/scale-<resources>.json` and folds the records into the site's file, where a run replaces the one of its size. Job times come from each job log's first and last lines, since Forgejo's API leaves them empty.

The scale workflow (`scale/pipeline.ts`) runs the 10,069-resource point on a GitHub-hosted runner when a release is published, and opens a pull request with the record. Dispatch it by hand for another scale or release.

## Where a feature goes

terragucci and [plywood](https://intentius.io/plywood/) are CI products on chant's runtime, and they share chant CI features as far as they can. Extending chant CI is the default. A feature goes in the first of these homes that fits it:

1. chant CI core, when both products share it.
2. chant's terraform or pulumi lexicon, when the capability belongs to one engine. Cone plans and Atmos reads belong in the terraform lexicon, and so do drift parsing, plan shape and the apply.
3. terragucci, which holds its words and presets, its config defaults and init templates, and its docs.

A feature stays inside terragucci only for a reason that belongs to its Terraform and OpenTofu audience, and never for convenience. Approvals, gate decisions, overrides and the records of applies and runs go in the chant workspace ledger, never in terragucci's own writes. Before adding storage for a record, check whether the ledger already holds it.

The rule and the issues behind it are on chant's [CI products on chant](https://intentius.io/chant/concepts/ci-products/) page and in [chant#4530](https://github.com/INTENTIUS/chant/issues/4530) and [#1280](https://github.com/INTENTIUS/terragucci/issues/1280).

## Design notes

Designs waiting for review before any code live in `design/`, one file each. They are contributor material: the site does not describe them until the feature works.

| File | Covers |
|---|---|
| [design/estate-carving.md](design/estate-carving.md) | splitting a large root into smaller ones: survey, propose, verify and a person-run migration |

## The taco

The logo is a 51x31 pixel-art taco. `docs-site/public/brand/taco.svg` draws it with one square per art pixel; `docs-site/src/assets/brand/taco.svg` is the same file for Starlight's header logo. Show it at a whole multiple of 51x31 (the `Taco` component's `scale`) so every pixel stays square. `taco-small.png` is the 26x16 mark at twice that size, for inline use and the plan note's last line, which links it at `https://intentius.io/terragucci/brand/taco-small.png`: keep that path, since old notes point at it. The report, index and estate pages inline the 1x PNG from `packages/terragucci/src/report/taco.ts`. `docs-site/public/social-preview.png` is the image for the repository's social preview in GitHub's settings.
