# <img src="docs-site/public/brand/taco-small.png" width="26" height="16" alt=""> Working on terragucci

```bash
npm install
just check      # what CI's check job runs: typecheck, lint, tests, the docs' prose and the tutorial
just docs       # serve the docs locally with hot reload and open them
just docs-preview  # build the docs as CI does and open that build
```

## The package

`packages/terragucci` is `@intentius/terragucci`, the `terragucci` command. `just build-cli` bundles it into one file, `dist/terragucci.mjs`, with no runtime dependencies; chant is a build dependency of this repo only. `just bundle-check`, part of `just check`, fails if the package gains a dependency, the bundle imports anything but Node's modules and the two optional packages (the TypeScript folder that a `terragucci.ts` config needs, and the HCL parser), or the build's esbuild metafile lists an input from the TypeScript compiler, chant's lint rules, codegen or CLI, a lexicon's entry point, lint rules or codegen, or the dashboards' renderers (below). The size is not budgeted: 1 MB is an accident ceiling, and every `just build-cli` prints the raw and gzipped size, the change against origin/main and the ten largest inputs without failing on growth. The origin/main baseline is built from the origin/main sources on the chant installed in node_modules, and the line names that chant build (a `chant-local` install adds several KB over the pin, so compare sizes only on one chant build). The build writes into a private stage and renames the files into dist at the end, so builds that overlap leave a whole bundle. `npm pack` in that directory builds the tarball. The publish workflow puts it on npm; see [Releasing](#releasing).

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

Each image's system git config marks every directory safe (`safe.directory = *`), because a job often runs as another user than the one who owns its checkout: on github.com a container job is root and the runner's user owns the workspace. `just images-check` runs git both ways round in each image, root in a checkout uid 1001 owns and uid 1001 in one root owns, including a fetch from a local remote, and the smoke claim `foreign-checkout` plans the example as root on a checkout uid 1001 owns. Both test the images built from this tree, so run `just images` first.

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

A release puts the CI images on GHCR and then `@intentius/terragucci` on npm. The npm package must name the images by digest, and the digests exist only after the images are pushed, so the order is fixed:

1. Set the version in `packages/terragucci/package.json` and merge to main. Once a commit at that version passes CI, `just release-preflight <version>` names it (`chant ci last-green`, never a hand-picked commit) and prints the `git tag v<version> <sha> && git push origin v<version>` to run. Image tags carry the package version (`imageTag` in `packages/terragucci/src/images.ts`).
2. The images workflow runs on the tag. Its publish job pushes the four images to GHCR and prints each reference with its digest.
3. Record those digests in `packages/terragucci/src/image-digests.json`, keyed by the references `npx tsx scripts/images.ts tags` prints, run `just ci` and `just example-patches` (`init` now pins by digest, so generated files change), and merge to main.
4. Run the publish workflow on main: `gh workflow run publish.yml --ref main` (its `ref` input defaults to main; pass `-f ref=<ref>` to publish another one).

`scripts/release-preflight.sh` fetches main and the `ci/` tags, and refuses a commit with no `ci/green/<sha>`, one with `ci/revoked/<sha>`, and one whose package is at another version. The tags are a convenience: when main has no green commit (the tick has not run, or every recent commit changed a workflow and `CI_GREEN_TOKEN` is missing) it says so, and `TERRAGUCCI_RELEASE_SKIP_GREEN=1 just release-preflight <version> [<commit>]` releases main, or the commit given, without the check.

The tag starts the publish workflow too. At that point the digests are not recorded yet, so that run refuses and the step 4 dispatch publishes. A tag pushed after its digests are already on main publishes directly.

The publish workflow (`publish/pipeline.ts`, rendered to `.github/workflows/publish.yml`) builds the bundle, runs `just bundle-check`, and then:

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
| `capture/pipeline.ts` | `.github/workflows/capture.yml` |
| `image-ci/pipeline.ts` | `.github/workflows/images.yml` |
| `publish/pipeline.ts` | `.github/workflows/publish.yml` |
| `nightly/pipeline.ts` | `.github/workflows/nightly.yml` |
| `ci-red/pipeline.ts` | `.github/workflows/ci-red.yml` |
| `diff-guard/pipeline.ts` | `.github/workflows/diff-guard.yml` |
| `images/images.ts` | `images/Dockerfile.*` |
| `front-door/stack.ts` (the `ReportsFrontDoor` composite in `front-door/front-door.ts`, with the edge code `front-door/edge.cjs` minified into it) | `docs-site/public/reports-front-door.json`, the CloudFormation template the Keep reports in S3 guide deploys; `test/front-door.test.ts` runs that inlined code |
| `workflows/shared.ts` | the pins they share |
| `observability/collector.ts`, `observability/prometheus.ts` | `stack/observability/collector.yaml` and `prometheus.yml` |
| `packages/terragucci/src/dashboards/index.ts` (through `scripts/render-dashboards.ts`) | `packages/terragucci/src/dashboards/rendered.json`, the template `init` fills, and `stack/observability/terragucci/`, the dashboards and rules the stack's Grafana and Prometheus load, rendered with the stack's reports address (`http://localhost:4580/terragucci-reports`, prefix `reports`) so the Runs and Estate links resolve in the `drill-down` claim, and `stack/observability/grafana-datasources.yaml` |

The dashboards and rules are rendered by `just ci`, not by `init`. `scripts/render-dashboards.ts` renders the declarations with a placeholder for each value `terragucci.yml` sets (the `dashboards:` settings, and the reports address, rendered once with it and once without) and writes the result to `rendered.json`; `init` fills the placeholders (`src/dashboards/template.ts`), and `just build-cli` puts the template into the bundle gzipped. So the bundle carries neither the grafana, prometheus and otel lexicons nor js-yaml or the lezer PromQL parser, and `just bundle-check` fails if any of them, or `src/dashboards/index.ts`, reaches it. Before it writes or checks anything, the script fills the template with several settings, odd YAML values among them, and fails unless each comes out byte for byte as the declarations render it. `just ci-check` fails when `rendered.json` is stale. After an edit to the declarations, run `just ci` and commit `rendered.json` with the stack's files.

## CI on main, and the one pull request check

A pull request runs one check, `diff-guard`, which takes seconds. The test suite and the validation stack (`ci.yml`: `check`, `validate-aws`, `validate-forgejo`, `validate-github`) run on each push to main, so many merges can land without waiting for a run each. A branch runs them by hand: `gh workflow run ci.yml --ref <branch>`.

| Workflow | Runs | What it does |
|---|---|---|
| `diff-guard.yml` | every pull request to main | `scripts/diff-guard.sh origin/main <head>`: fails when the squash would undo a commit main already has |
| `ci.yml` | each push to main, and by hand | `just check` and each stack profile's claims, plain and under `BREAK=1` |
| `chant-ci-green.yml` | when `ci.yml` completes on main, and every 15 minutes | `chant ci tick`: tags each commit that passed every `ci.green` phase `ci/green/<sha>`, and a green commit that later fails `ci/revoked/<sha>` |
| `ci-red.yml` | hourly | `scripts/ci-red`: opens one issue, "main is red", when main has had no green commit for `TERRAGUCCI_RED_HOURS` (6) hours or a green commit is revoked, and closes it once main is green again |
| `nightly.yml` | nightly | the GitLab claims, too heavy for every push |

main's runs of `ci.yml` are never cancelled. GitHub keeps one run going and one waiting per concurrency group, so in a burst of merges the first and the newest are tested and the commits between them get no tag. A run by hand on a branch cancels that branch's run in progress.

### diff-guard

A rebase that keeps a stale copy of a file puts back the lines that a commit merged meanwhile changed, and the squash then reverts that commit without saying so (#465 reverted #464 this way). For each file the pull request changes, `scripts/diff-guard.sh` takes the commits among the merge base's last 20 first parents (`DIFF_GUARD_DEPTH`) that changed it, and fails when one of their changes would apply to the pull request's tree and not to the merge base's: the pull request holds the lines as they were before that commit. It names the file and the commit. Rebase again and keep main's copy. A pull request that reverts on purpose gets the label `revert`, which lets it through with the findings printed. Run it before pushing:

```bash
just diff-guard             # origin/main against HEAD
```

### Green commits

`chant.workspace.json` declares `ci.green` for main over the four `ci.yml` jobs, with a 24-hour window. `chant.config.ts` sets `rootOnly`, since the declaration has no members and `chant build` and `chant lint` keep building this project alone. `chant-ci-green.yml` is written by chant, not declared here: after changing `ci.green` or a job name in `ci.yml`, regenerate it with `npx chant ci workflow --token-secret CI_GREEN_TOKEN`.

```bash
git fetch origin --tags
npx chant ci last-green                        # the newest commit on main that passed
npx chant ci tick --dry-run                    # what a tick would tag; needs GITHUB_REPOSITORY and GH_TOKEN, never CI_GREEN_TOKEN
```

The tick pushes its tags with the repository secret `CI_GREEN_TOKEN`, a fine-grained personal access token for this repository with Contents and Workflows read and write. GitHub refuses the Actions token a new ref to a commit that changes `.github/workflows/`, so without the secret such a commit gets no green tag, and the tick reports it. Nothing else needs the secret: CI, `diff-guard`, `ci-red` and every local run work without it. `chant ci workflow` writes the checkout with `token: ${{ secrets.CI_GREEN_TOKEN }}` and no fallback, so until the secret exists the tick's checkout fails and no commit is tagged; releases then go through `TERRAGUCCI_RELEASE_SKIP_GREEN=1` (below).

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes what works today and is true as written, links no issue tracker, and never says a feature is being built or planned.

## The example, the checks and the tutorial

`stack/README.md` covers the local stack, `just example`, `just smoke` and `just tutorial-capture`.

To prove a change on the stack, run `just claims-affected` (or `just claims <name>...`). `stack/claims-affected.sh` picks the claims from the change since `origin/main` and prints why it picked each one:

| Changed | Claims picked |
|---|---|
| a claim's row, group line or function in `stack/smoke.sh` | that claim |
| a helper function in `stack/smoke.sh` | the claims that call it |
| any other line of `stack/smoke.sh` | every claim |
| a docs page | the claims its `claims:` line newly lists |
| anything else | the claims `stack/claim-paths.txt` names for its path, none when no line names it |

The picked claims run plain and under `BREAK=1`, six at a time with the locks `CLAIM_GROUPS` gives them, and their rows replace theirs in `smoke.json`. A run whose log stops growing for `SMOKE_STALL_MIN` minutes (10) is stopped and fails as stalled, with its last lines and the stack's job containers printed. The full `just smoke-record` and `just tutorial-capture` run for a release. The capture workflow refreshes the tutorial's output and screenshots weekly and opens a pull request when they change.

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
| `fresh` | boot | starts the stack from nothing, as the step itself does |
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

### The example on GitLab

`just example-gitlab` runs the same 15 roots on the stack's GitLab CE profile, applied to floci by GitLab CI, for GitLab screenshots. It is `stack/example-gitlab.sh`, which shares `stack/lib.sh` with the Forgejo example (`LIB_FORGE=gitlab`) and takes its merge request helpers from `stack/forge-gitlab.sh`.

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
```

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

#### GitLab screenshots

```bash
just example-gitlab shot /root/example/-/merge_requests/1 note-light.png light --scroll 'li.note' --match 'terragucci tf-plan' --fit 1
just example-gitlab shot /root/example/-/merge_requests/1 note-dark.png dark --scroll 'li.note' --match 'terragucci tf-plan' --fit 1
```

`shot` takes a GitLab path or URL, the PNG to write, `light` or `dark`, and any further `stack/shot.mjs` flags (`--height`, `--scroll`, `--match`, `--fit`). GitLab's color mode is a setting of the signed-in user and ignores the browser's `prefers-color-scheme`. So `shot` signs in as root (the session is kept in `stack/.state/gitlab-cookies`), sets the color mode and the syntax theme to light or dark through the preferences form, and hands the session to `shot.mjs --cookie`. Before the picture, `shot.mjs` waits for a GitLab page's spinners and skeletons to go.

`GITLAB_HIDE` is the hide list, like the tutorial's `FORGEJO_HIDE`: the left sidebar and its toggle, broadcast messages and the instance's alert banners (the "add an SSH key" one), callouts and feature highlights. `GITLAB_STYLE` gives the content the sidebar's width. Both are defaults in `stack/example-gitlab.sh` and can be overridden from the environment. Gravatar is off on the stack, so avatars are GitLab's initials.

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

The docs' GitHub screenshots come from [INTENTIUS/terragucci-sandbox](https://github.com/INTENTIUS/terragucci-sandbox), a public repo on github.com run by `stack/sandbox-github.sh`. It needs no stack, no cloud account and no secret in the repo. It needs `gh`, `jq`, Python 3, Docker (for the roots' state and the screenshots) and `npm ci` (for chant).

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
just sandbox shot list             # the pages the steps recorded
just sandbox shot all              # each one logged out, light and dark
just sandbox reset                 # close the pull requests and issues, delete the branches, main back to its first commit
just sandbox minutes 2026-10-07T00:00:00Z   # Actions run time since then
just sandbox capture               # all of the docs' GitHub views, from reset to reset
just sandbox prove                 # the github.com claims, from reset to reset; --record FILE writes their rows
```

`just sandbox prove` resets the sandbox and commits to main, with `[skip ci]`, what its claims need: `locks: plan`, a `policy` whose Rego denies a replacement, `oidc` with a plan and an apply role, and `envs/dev/oidc`, a root whose `data "external"` program checks the job's OIDC token and writes what it found to `terragucci-report/oidc-<plan|apply>.json`, which the job keeps in its report artifact. `init` of the release then rewrites the pipeline. Then it runs the claims and resets again. It takes about 15 minutes.

| Claim | Steps | Holds when |
|---|---|---|
| `affected` | `change one-root` | the plan note's first line covers `envs/dev/orders` alone and `terragucci/plan` counts 1 root |
| `comment-plan` | `plan-comment one-root` | the comment's run finishes its `replan` job and the note was edited after the comment |
| `pr-lock` | `change orders-note` | one-root's `terragucci/lock` holds `envs/dev/orders`; orders-note, a second change to that root, fails it, and its reply names the root and pull request one-root |
| `policy` | `change replace` | `terragucci/plan` fails and the note names the denial |
| `oidc` | `change oidc`, `merge oidc` | in the pull request's plan job and main's apply job, the token verifies against GitHub's keys and names the repo, run, commit, event and `sts.amazonaws.com`; the plan job holds the plan role and the apply job the apply role |
| `gate-wait` | `change destroy`, `merge destroy`, `approve` | wave 4 stops with its approve command, and the re-run after a sealed `chant approve` succeeds |

No claim runs broken on purpose, and no token is traded with STS: the sandbox has no cloud account (the Forgejo claim `forgejo-oidc` does the trade). `--record docs-site/src/data/validation.json` writes the rows as forge `github.com`, after the `github` rows. The nightly workflow (`nightly/pipeline.ts`, job `sandbox`) runs `just sandbox prove` on the newest published release and `just sandbox reset` after it, and keeps `prove.json` and the logs as the `sandbox-prove` artifact. It needs the repo secret `TERRAGUCCI_SANDBOX_TOKEN`: a token from an admin of the sandbox, fine-grained on INTENTIUS/terragucci-sandbox with Administration, Contents, Workflows, Pull requests, Issues and Actions read and write and Commit statuses read, or classic with `repo` and `workflow`. Without it the job stops at its first step and says so.

`just sandbox capture` resets the sandbox, runs `change one-root`, `plan-comment one-root`, `change unformatted`, `change destroy`, `merge destroy` and `drift`, shoots each view right after its step, writes them as the step `github`, and resets the sandbox again. It takes about 15 minutes. A page uses them as it uses a Forgejo step's: `<Shot step="github" view="note" alt="..." />`, and `<Captured step="github" />` for the commands and the lines of the two job logs a logged-out reader cannot open.

| View | Page | Shows |
|---|---|---|
| `note` | the one-root pull request | the plan note |
| `reply` | the same pull request | the note the `/terragucci plan` comment re-planned, and the comment |
| `check` | the run of the unformatted branch's push | the failed check job and its annotation |
| `drift` | the drift issue | the issue the drift job opened for staging orders |
| `waiting` | the run of the destroy's merge | wave 4 stopped, waiting for its approval |
| `required` | the ruleset on main | `terragucci/plan` as a required status check |

The `drift` view needs a release whose drift job can keep its issue on github.com: 0.3.1 asks github.com for `type=issues`, which it refuses with a 422, so on 0.3.1 `capture` says so, leaves the view out and keeps the one committed, if any.

The files are `docs-site/src/data/tutorial/github.json` and `docs-site/src/assets/tutorial/github-<view>-<light|dark>.png`, so `just tutorial-check` holds a page that shows them to the same rules as the Forgejo steps.

| Piece | How |
|---|---|
| Roots | `example/` with each AWS resource made a `terraform_data` whose `input` holds its arguments and whose `triggers_replace` holds the ones that replace it. A scenario is `example/changes/<s>.patch` applied to the example and converted the same way, so `example/` stays the only source. `float`, `drift` and `pin` have no plan-only form. |
| State | `local`, in each root's `terraform.tfstate`, committed. The only store a GitHub-hosted job reaches without an account is the repo. `main.tf` keeps its `s3` backend and `state_override.tf` replaces it, so `init` finds the same four waves as on the example. The runner's disk is gone after a job, so after a green apply the script applies the same tree in the pipeline's image and commits the state with `[skip ci]`. |
| Pipeline | `npx @intentius/terragucci@0.4.0 init` (`TERRAGUCCI_SANDBOX_RELEASE`), pinned by digest to the published images, which mark every checkout safe for git. `TERRAGUCCI_SANDBOX_SAFE_DIRECTORY=1` adds an `env` that does the same, for running the sandbox on 0.3.0, whose container jobs ran git as root in a checkout the runner's user owns. |
| Drift | `terraform_data` reads nothing back, so a refresh finds no drift in it. `drift` adds a `local_file` to staging orders, applies it into the state, and deletes the file on main with `[skip ci]`; the drift job's refresh then finds it gone. |
| Ruleset | `terragucci/plan required`, made by `up` and `capture` when missing: the default branch requires the `terragucci/plan` status. It is a ruleset, not a classic protection rule, because a logged-out reader can open a ruleset. Repository admins bypass it, so the script's own pushes and merges to main go through. |
| Signer | an ed25519 key made by `up` and `reset` in the scratch directory, listed as `sandbox-signer` in `.chant/allowed_signers` on main by the first `merge`. Its private half never leaves the scratch directory. |
| Token | `TERRAGUCCI_SANDBOX_TOKEN`, else `gh auth token`, read at run time and handed to `gh` (`GH_TOKEN`) and to git (a credential helper in `GIT_CONFIG_*` that reads the variable) in the script's own environment. It is never written to a file, a git config or a log. |
| Screenshots | `stack/shot.mjs` in `mcr.microsoft.com/playwright` (`TERRAGUCCI_SHOT_IMAGE`) with a fresh profile, so the page is the one a logged-out reader sees, in `prefers-color-scheme` light and dark. |

Scratch files go in `TERRAGUCCI_SANDBOX_DIR` (default `$TMPDIR/terragucci-sandbox`): `signer`, `views/` (one file per recorded page), `logs/` and `shots/<view>-<light|dark>.png`.

GitHub shows a job's log only to a signed-in reader. A logged-out job page lists the job's steps, with the failed one marked, and "Sign in to view logs". So a job's log is saved as text, from `gh run view --log`, beside the picture: `logs/waiting.log`, `logs/refused.log` and `logs/applied.log`. A pull request's merge box is also hidden when logged out; the `checks` view is the pull request's Checks tab. The comment re-plan posts no reply of its own: it edits the plan note, so the `reply` view is the note above the `/terragucci plan` comment.

The repo is public, so its Actions minutes on GitHub-hosted runners are free. A pull request costs two runs and a merge one run of seven jobs.

## Design notes

Designs waiting for review before any code live in `design/`, one file each. They are contributor material: the site does not describe them until the feature works.

| File | Covers |
|---|---|
| [design/estate-carving.md](design/estate-carving.md) | splitting a large root into smaller ones: survey, propose, verify and a person-run migration |

## The taco

The logo is a 51x31 pixel-art taco. `docs-site/public/brand/taco.svg` draws it with one square per art pixel; `docs-site/src/assets/brand/taco.svg` is the same file for Starlight's header logo. Show it at a whole multiple of 51x31 (the `Taco` component's `scale`) so every pixel stays square. `taco-small.png` is the 26x16 mark at twice that size, for inline use and the plan note's last line, which links it at `https://intentius.io/terragucci/brand/taco-small.png`: keep that path, since old notes point at it. The report, index and estate pages inline the 1x PNG from `packages/terragucci/src/report/taco.ts`. `docs-site/public/social-preview.png` is the image for the repository's social preview in GitHub's settings.
