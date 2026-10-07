# Working on terragucci

```bash
npm install
just check      # what CI runs: typecheck, lint, tests, the docs' prose and the tutorial
just site-dev   # serve the docs locally
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

1. Set the version in `packages/terragucci/package.json`, merge to main, and push the tag `v<version>` on that commit. Image tags carry the package version (`imageTag` in `packages/terragucci/src/images.ts`).
2. The images workflow runs on the tag. Its publish job pushes the four images to GHCR and prints each reference with its digest.
3. Record those digests in `packages/terragucci/src/image-digests.json`, keyed by the references `npx tsx scripts/images.ts tags` prints, run `just ci` and `just example-patches` (`init` now pins by digest, so generated files change), and merge to main.
4. Run the publish workflow on main: `gh workflow run publish.yml --ref main` (its `ref` input defaults to main; pass `-f ref=<ref>` to publish another one).

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
| `images/images.ts` | `images/Dockerfile.*` |
| `workflows/shared.ts` | the pins they share |
| `observability/collector.ts`, `observability/prometheus.ts` | `stack/observability/collector.yaml` and `prometheus.yml` |
| `packages/terragucci/src/dashboards/index.ts` (through `scripts/render-dashboards.ts`) | `packages/terragucci/src/dashboards/rendered.json`, the template `init` fills, and `stack/observability/terragucci/`, the dashboards and rules the stack's Grafana and Prometheus load, rendered with the stack's reports address (`http://localhost:4580/terragucci-reports`, prefix `reports`) so the Runs and Estate links resolve in the `drill-down` claim, and `stack/observability/grafana-datasources.yaml` |

The dashboards and rules are rendered by `just ci`, not by `init`. `scripts/render-dashboards.ts` renders the declarations with a placeholder for each value `terragucci.yml` sets (the `dashboards:` settings, and the reports address, rendered once with it and once without) and writes the result to `rendered.json`; `init` fills the placeholders (`src/dashboards/template.ts`), and `just build-cli` puts the template into the bundle gzipped. So the bundle carries neither the grafana, prometheus and otel lexicons nor js-yaml or the lezer PromQL parser, and `just bundle-check` fails if any of them, or `src/dashboards/index.ts`, reaches it. Before it writes or checks anything, the script fills the template with several settings, odd YAML values among them, and fails unless each comes out byte for byte as the declarations render it. `just ci-check` fails when `rendered.json` is stale. After an edit to the declarations, run `just ci` and commit `rendered.json` with the stack's files.

## The site

`docs-site/` is Astro and Starlight, published at intentius.io/terragucci. `just site` builds it the way the pages workflow does. Its prose is scored with the [sentences](https://www.npmjs.com/package/sentences) linter by `just lint-docs`.

The site is for people using terragucci. It describes what works today and is true as written, links no issue tracker, and never says a feature is being built or planned.

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
