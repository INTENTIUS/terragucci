# The local validation stack

terragucci's pipelines are meant to be run before they ship, on a real forge with a real runner, against an AWS emulator, all on one Docker network. This directory is that stack. [terragucci#4](https://github.com/INTENTIUS/terragucci/issues/4) is the design and lists every claim it should eventually check.

The forgejo claims run a hand-written workflow (`fixtures/s3-bucket/.forgejo/workflows/tofu.yml`). The github and gitlab claims run the pipeline `terragucci init` writes for that forge into the same fixture, so they check the generated file. On every forge, the `tg-*` claims do the same for a Terragrunt repo (`fixtures/terragrunt-buckets`, two units with no `terragrunt.stack.hcl`) and the `cdf-*` claims for a choudoufu estate (`fixtures/choudoufu-estate`, one root with an `estate.chdf.hcl`).

## What runs today

| Profile | Services | State |
|---|---|---|
| `aws` | floci | validated: starts, answers S3 |
| `forgejo` | floci, Forgejo, forgejo-runner (docker executor) | validated: the `check` and `apply/tofu` claims pass; `check/terragrunt`, `apply/terragrunt`, `check/choudoufu` and `apply/choudoufu` wait for their first record |
| `github` | floci, a mock GitHub API, `act` on the host | validated: `check`, `apply` and `reconcile` pass; `check/terragrunt`, `apply/terragrunt`, `check/choudoufu` and `apply/choudoufu` wait for their first record |
| `gitlab` | floci, GitLab CE, gitlab-runner (docker executor) | validated: `check`, `apply` and `reconcile` pass; `check/terragrunt`, `apply/terragrunt`, `check/choudoufu`, `apply/choudoufu` and `approval/gate` wait for their first record |
| `fountain` | floci, fountain 0.21.0, Postgres, a fountain runner built for the steward | runs the example's apply on a steward (`just example up --fountain`); the `apply/steward` smoke claim checks it |
| `demo` | Postgres 18.6 (`demo-postgres`), app's database in the looping demo | started by `just demo up`; SQL Yodeler applies `example-demo/app/schema` to it from app's wave |
| `observability` | an OpenTelemetry collector, Prometheus, Tempo and Grafana with terragucci's dashboards (`stack/observability/`) | started by the `traces`, `metrics` and `dash-*` claims when it is not up; Grafana answers on `localhost:3310`; `stack/down.sh` removes it |
| `observability-lite` | the same collector and Prometheus, and a Tempo held to 384 MiB that keeps traces 24 hours; no Grafana | started by `stack/demo.sh up` for the demo's job metrics and traces; Prometheus answers on `localhost:9190` and Tempo on `127.0.0.1:3210`; `stack/down.sh` removes it |


- `github`: GitHub has no self-hostable edition. `mock-github/server.mjs` is a small stateful GitHub: it creates repos, serves their git over smart HTTP (`git http-backend`), opens, lists and merges pull requests, and stores issue comments. The runner is `act` on the host, which runs the repo's real workflow file with its job containers on the `terragucci` network. A push is a git push to the mock, and a run is `act push` on a fresh clone of the pushed commit with a push event for that branch, so `github.ref` and the default-branch condition behave as on GitHub. act checks out from the clone and fetches the workflow's other actions, `actions/upload-artifact` and (in a Terragrunt repo) `actions/cache`, from github.com, as a hosted runner does; the uploads go to act's own artifact server for the length of the run. `act` has to be installed (`brew install act`).
- `gitlab`: GitLab CE 17.11 and gitlab-runner 17.11 with the docker executor, taken from gitlab-warden's e2e stack. The GitLab image is linux/amd64 only, so on Apple silicon it runs under emulation and cold boot takes a few minutes. Speed does not matter here, and the runner and the job containers are native. `bootstrap.sh` runs `gitlab-boot.sh`, which mints a root token with `gitlab-rails runner`, creates an instance runner over `POST /api/v4/user/runners` and registers it with `--docker-network-mode terragucci`. The GitLab lab (below) is the same pair on a stack of its own.
- `fountain`: laid out after waterpark's `compose/`. `bootstrap.sh fountain` builds `terragucci-fountain-steward:local` (`fountain/Dockerfile`: the tofu CI image, the fountain 0.21.0 CLI and the chant terragucci pins, with its fountain lexicon), registers the admin account, mints an API key and starts `fountain runner` with it. A sandbox is a directory in that container and inherits its floci credentials. `steward.sh` does the rest for a repo: it declares the steward on fountain through `POST /api/apply` (an Environment whose setup makes the sandbox a checkout of the repo, an Agent on the `acp` runtime running `chant acp`, and a Teammate so its turns share one thread), stores the fountain key as the repo's `FOUNTAIN_TOKEN` secret, and rewrites a pushed tree so the pipeline's wave jobs become one `apply` job running `chant run tf-apply --on fountain` in the steward image, with a `tf-apply` Op that runs the same `terragucci stage tf-apply` waves on the steward. fountain points a turn's working directory at the sandbox itself, which is why the sandbox, not a subdirectory, is the checkout.

## The example and the smoke claims

`example/` is the shop's estate: 15 roots (dev, staging and prod, each a platform root and four services calling `modules/service`), applied to floci by the forgejo profile. It is the tutorial's example and the subject of every smoke claim ([terragucci#11](https://github.com/INTENTIUS/terragucci/issues/11)).

| Command | Does |
|---|---|
| `just example up [--fresh] [--fountain]` | boots the forgejo profile, pushes the example to `terragucci-admin/example` (public) and applies every root; `--fresh` wipes floci and the repo first; `--fountain` also boots the fountain profile and hands tf-apply to a steward (`steward.sh`) |
| `just example verify` | checks that every bucket, queue and table main declares is in floci |
| `just example change <scenario>` | opens a pull request with one of `example/changes/` (`drift` and `pin` act directly) |
| `just example merge <scenario>` | merges that scenario's pull request as the reader would, listing the reader's ssh key in `.chant/allowed_signers` first, and prints the approval a waiting wave asks for or the refusal a changed one gives |
| `just example approve [wave-N]` | approves the waiting wave as the reader, sealed with the reader's key (by default the wave the last run asked about) |
| `just example reset` | closes the pull requests, puts main back, applies again |
| `just demo up` | the looping demo behold shows, one forge repo per tool: pushes `example-demo/` (four roots of `terraform_data`: network, app, edge and other) to `terragucci-admin/demo`, and each other tool's tree to its own repo, applies each, and keeps each repo's base commit and each root's state as its base snapshot. It also builds `terragucci-demo-tofu:local` (`demo-yodel/Dockerfile`: the tofu CI image with SQL Yodeler 0.9.0 from its own image), which every job of `terragucci-admin/demo` runs in, and starts `demo-postgres`, where app's wave runs SQL Yodeler's migrations; database `demo_base` keeps the base, and each reset copies it back. The driver plays two Forgejo users: `demo-author` opens, merges and re-runs each change, and `demo-reviewer` only approves waves, with its own key, so every approval comes from someone who had no hand in the change |
| `just demo loop [--once] [scenario...]` | runs `stack/demo.sh`'s scenarios one after another (by default three, `b-waves`, then `failure`, then `tg-planned-outputs`, which runs on `terragucci-admin/demo-terragrunt`, pushed from `example-demo-terragrunt/`; name others, from `a-known`, `a-output`, `b-waves`, `failure`, `stale-plan`, `b-composed`, `tg-planned-outputs`, `chant-pr-loop`, `fan-out`, `fan-out-tofu`, `fan-out-choudoufu`, `compose-edit`, `compose-create` and `compose-fail`, as arguments or space-separated in `DEMO_SCENARIOS`; `chant-pr-loop` runs chant's own pull-request pipeline on `terragucci-admin/demo-chant`, pushed from `example-demo-chant/`, and its jobs run in `terragucci-demo-chant:local`, which `up` builds from the tofu image with the chant the tree pins (`stack/demo-chant.Dockerfile`); `fan-out-tofu` runs on `terragucci-admin/demo-fanout`, pushed from `example-demo-fanout/`, fifteen roots of SQS queues and DynamoDB tables whose jobs install hashicorp/aws from the demo image's mirror: cluster-a fails at apply, its six apps are blocked while cluster-b's apply, and a second pull request fixes it and applies the seven left; `compose-edit` and `compose-create` run in the default order after the others when named, and `compose-fail` only when named: they run on `terragucci-admin/demo-compose`, pushed from `example-demo-compose/`, three roots planned and applied as one composed run, where the person's approval is the reviewer's step and `compose-fail`'s load balancer fails its postcondition at apply before a one-line fix pull request applies what is left; `fan-out-choudoufu` runs the same cycle on `terragucci-admin/demo-choudoufu-fanout`, pushed from `example-demo-choudoufu-fanout/`, as choudoufu estates with no state files, and while the fix applies app-01 an operator applies to the same estate from outside the pipeline, and both land; `fan-out` runs the same loop on `terragucci-admin/demo-chant-fanout`, pushed from `example-demo-chant-fanout/` (chant's fan-out estate, fifteen CloudFormation stacks in floci), whose jobs run in `terragucci-demo-chant-fanout:local`, with chant's aws lexicon and AWS CLI v2 (`stack/demo-chant-fanout.Dockerfile`): cluster-a fails, its six apps are held while cluster-b's apply, and a second, approved pull request fixes it and applies the seven left; `chant-compose-edit` and `chant-compose-create` are the prompt-driven demo's two acts on chant's own pipeline, on `terragucci-admin/demo-chant-compose`, pushed from chant's `examples/demo-composed-stacks/` (not in this repo: `DEMO_CHANT_TREES` names a checkout of INTENTIUS/chant, or the driver clones it under `stack/.state/trees/` at `DEMO_CHANT_TREES_REF`, default `main`; the Terragrunt-on-choudoufu and Atmos-on-choudoufu trees come the same way from INTENTIUS/choudoufu, `DEMO_CHOUDOUFU_TREES` and `DEMO_CHOUDOUFU_TREES_REF`) (network, app and edge as three CloudFormation stacks in floci, each reading the one before through `stackOutput` parameters), whose jobs run in `terragucci-demo-chant-compose:local`: `stack/demo-chant-compose.Dockerfile` installs chant and its aws lexicon at `CHANT_VERSION` (0.124.54; 0.124.52 was the first release where one approval covers a re-plan that only fills a previewed unknown), or packs them from the commit `CHANT_COMPOSE_REF` names; the reviewer approves the plan's digest once and the apply's second plan, made after network applied, runs under it), switching to each scenario's repo, writing `demo.json` (with the scenario's `tool` and `repo`, and, for a scenario with an `ask.json`, its `ask` or `asks` per step and its `opening` and `closing`; a step with two beats holds 12 seconds longer per extra beat) to the reports bucket at every step, copying the last 30 pipeline runs of the loop's repos beside it under `runs/` (`scripts/demo-runs.ts`), and resetting out of band after each: each state written back to the snapshot, main forced back to the base commit, and each project's wave reports in the bucket past the newest 50 commits (`DEMO_REPORTS_KEEP`) deleted, with the runs they held dropped from the indexes, `changes.json`, `states.json`, the history and `audit.jsonl`'s report entries (`scripts/demo-reports.ts`). Each cycle starts by putting its repo's `chant/lifecycle` back to its base (up writes none, so the branch is deleted and the cycle's approvals make it again), and the reset drops the `audit.jsonl` ledger entries the branch no longer holds once they are older than the project's oldest kept report. A cycle that ends with its reset is published as its tool's latest under `cycles/<tool>/` (`scripts/demo-cycles.ts`) |
| `just smoke [claim]` | one line per claim: `SMOKE claim=… verdict=pass\|caught\|fail\|pending`; `BREAK=1` must print `caught` |
| `just smoke-record` | every claim plain and under `BREAK=1`, written to `docs-site/src/data/smoke.json` for the status page. Claims run several at a time (`SMOKE_JOBS`, default 6; `SMOKE_SERIAL=1` for one at a time), each holding the resources its line in `CLAIM_GROUPS` in `smoke.sh` names; each run's log is under `stack/.state/smoke-logs/` |
| `just tutorial-capture` | the tutorial's output, notes, logs and diffs as text, for steps whose claims pass, on the capture stack |
| `just capture <step>…` | one or more of those steps alone; `--list` names them, `--reuse` captures on the running example (CONTRIBUTING.md) |
| `just capture-stack-down` | removes the capture stack (see [The capture stack](#the-capture-stack)) |
| `just example-patches` | rebuilds `example/changes/*.patch` after an edit under `example/` |
| `just stack-for <config>` | starts only the profiles a terragucci config needs: floci, the forges it names, and fountain when a project runs there |

The roots are plain AWS code apart from path-style S3, which floci needs and AWS accepts. The example's pipeline is the one `npx terragucci init` writes; it names no endpoint, and every job runs in terragucci's tofu image. Before the images are published, `just example up` builds them into the local daemon (`just images`), where the runner uses them without pulling. The forgejo runner gives every job `AWS_ENDPOINT_URL=http://floci:4566` and test credentials, the way a CI runner in a real account carries that account's credentials, and `just example up` creates the state bucket before the first push. floci's network aliases include `000000000000.floci`, because the AWS provider reaches S3 Control at the account id in front of the endpoint's host.

Facts measured on floci that the example relies on: SQS `visibility_timeout_seconds` and `message_retention_seconds` are kept, so a re-plan after apply is clean; a DynamoDB hash-key change plans a replacement; the S3 backend with `use_lockfile` and `terraform_remote_state` both work; a queue deleted through the API plans as a create. Each new SQS queue takes about 25 seconds, because the provider waits for its attributes to settle, so the pipeline applies independent roots together.

## Claims

`just validate <forge> <claim>`. `BREAK=1` breaks the property the claim is about, and the claim must then fail.

| Claim | Holds when | `BREAK=1` does |
|---|---|---|
| `aws s3` | a bucket created on floci is found when asked from the host | asks for a bucket that was never created |
| `forgejo check` | a push of the fixture goes green, and a push of the fixture plus an unformatted file goes red with that file named in the job log | the push that should be clean carries the unformatted file |
| `forgejo apply` | with the bucket deleted from floci first, a push to `main` goes green and the bucket then exists when asked from the host | removes the `tofu apply` step, so the run is green and only the host check can catch it |
| `github check`, `gitlab check` | the same, with the pipeline `terragucci init` wrote | the same |
| `github apply`, `gitlab apply` | the same, with the generated pipeline | removes the generated `apply` job |
| `github reconcile`, `gitlab reconcile` | `terragucci reconcile --mode apply` on a control repo of two projects opens one pull (merge) request on the project with no pipeline and leaves the in-line project alone; the request's check goes green; merged, its pipeline applies both roots, network before app | runs `--mode dry-run`, which opens nothing |
| `tg-check` (forgejo, github, gitlab) | on the Terragrunt fixture, whose pipeline runs in the terragrunt image: a push goes green, and a push with an unformatted `live/one/owner.hcl` goes red with the file named | the push that should be clean carries `owner.hcl` |
| `tg-apply` (forgejo, github, gitlab) | on the Terragrunt fixture, with both units' buckets deleted from floci first, a push to `main` goes green and both buckets then exist | removes the generated apply jobs |
| `cdf-check` (forgejo, github, gitlab) | on the choudoufu fixture, whose pipeline runs in the choudoufu image: a push goes green, and a push adding `infra/ignored.tf`, a bucket whose lifecycle ignores its tags, goes red with a `refused: infra:` line naming it (live-check refuses ignoring the ownership markers) | the push that should be clean carries `ignored.tf` |
| `cdf-apply` (forgejo, github, gitlab) | on the choudoufu fixture, with the bucket deleted from floci first, a push to `main` goes green, the bucket then exists, and its tags carry `tofu-estate` | removes the generated apply jobs |
| `gitlab gate-wait` | with the gate at `always` and `GITLAB_TOKEN` set on the project, a push to `main` waits at wave 1: the pipeline ends failed, the wave's job ends with exit code 3 and prints `terragucci approve`, no status call answers 400, `terragucci/apply` is failed with the wave's command, and the bucket is absent | drops the `\|\| exit $?` after each job's heredoc, so the job ends with 1 |

The `tg-*` and `cdf-*` claims run in `terragucci-terragrunt` and `terragucci-choudoufu`, the images the generated pipeline names. `validation.sh run` (`just validate-forge`, what ci.yml runs) drops init's digest pins, so each runner (forgejo-runner, gitlab-runner, act) takes the images bootstrap built from the tree under the same tag. `validation.sh record` (`just validation-record`) keeps the pins (`TG_KEEP_DIGESTS=1`), and the runners pull the published images from GHCR: the record a release publishes is the proof on those. On Forgejo the same four claims run through `forge-forgejo.sh`, so they check the generated `.forgejo/workflows/terragucci.yml`, while Forgejo's own `check` and `apply` keep the hand-written workflow.

`validate.sh` finds the run by the pushed commit's sha (`GET /repos/{owner}/{repo}/actions/runs?head_sha=`), polls it every 3s up to `TERRAGUCCI_VALIDATE_TIMEOUT` (900s), and prints each job's log through `/actions/jobs/{id}/logs` when a run is not what it expected.

## In CI

A person boots a profile and runs `just validate-forge <forge>`, which runs each of that forge's claims plain and under `BREAK=1`. No claim runs in CI, the gitlab profile's included. A person runs `just validation-record`, which boots each forge in turn, runs the published images init pins, and rewrites `docs-site/src/data/validation.json`, the table on the validation page. Pass forge names to record only those: `just validation-record gitlab`. The workflows are declared in `ci/`.

## Running it

```bash
just stack-up forgejo              # stack/bootstrap.sh forgejo
just validate forgejo check
just validate forgejo apply
BREAK=1 just validate forgejo check   # must fail
just stack-down                    # stack/down.sh: down -v, every profile

just stack-up gitlab               # one profile at a time; GitLab is the heavy one
just validate gitlab reconcile
just stack-for terragucci.yml      # only the profiles a config names
```

`stack/validate-generated.sh` holds the github and gitlab claims, and forgejo's `tg-*` and `cdf-*`. Each forge supplies a small driver (`forge-github.sh`, `forge-gitlab.sh`, and `forge-forgejo.sh` for the claims it runs) with the same functions: reset a repo, push a tree, run the pipeline for a commit, open and merge a request. GitLab projects are kept between runs and reset (open merge requests closed, `main` reseeded and unprotected), because deleting one holds its name for a while. The mock's repos are deleted and created each time.

`bootstrap.sh` is safe to run again. It reuses the admin, replaces the API token, keeps a runner that is already online, and leaves the repo alone. It prints the env vars a run needs and writes them to `stack/.state/<profile>.env`, which `validate.sh` reads when they are not already set:

The github and gitlab profiles write `github.env` and `gitlab.env` the same way, with `TERRAGUCCI_GITHUB_*` (mock URL, token, user, repo) and `TERRAGUCCI_GITLAB_*`.

| Variable | Value |
|---|---|
| `TERRAGUCCI_FORGEJO_URL` | `http://localhost:3300` |
| `TERRAGUCCI_FORGEJO_TOKEN` | an admin token, minted each run |
| `TERRAGUCCI_FORGEJO_USER` | `terragucci-admin` |
| `TERRAGUCCI_FORGEJO_REPO` | `terragucci-admin/validate` |
| `TERRAGUCCI_FLOCI_URL` | `http://localhost:4580` |

Every `just` target here skips with a message when Docker is not available.

## Ports and names

Host ports are off the usual defaults so the stack can run beside another harness. Each one can be overridden.

| Service | Host | On the network | Override |
|---|---|---|---|
| Forgejo | 3300 | `http://forgejo:3000` | `TERRAGUCCI_FORGEJO_PORT` |
| floci | 4580 | `http://floci:4566` | `TERRAGUCCI_FLOCI_PORT` |
| mock GitHub | 8198 | `http://mock-github:8188` | `TERRAGUCCI_GITHUB_PORT` |
| GitLab | 8939 | `http://gitlab:8929` | `TERRAGUCCI_GITLAB_PORT` |
| fountain | 4010 | `http://fountain:4000` | `TERRAGUCCI_FOUNTAIN_PORT` |

The compose project is `terragucci`, the network is `terragucci`, and every container and volume name starts with `terragucci-`. `down.sh` removes those and nothing else.

### The capture stack

`TG_STACK=capture` selects a second instance from the same `docker-compose.yml` (`instance.sh`): compose project, network and name prefix `terragucci-capture`, state in `stack/.state-capture/`, and locks in the main checkout's `stack/.state-capture/locks`, apart from the claims' locks. `just tutorial-capture` and `just capture` run there, so a capture never holds the claims' `stack!` lock. Its host ports are the shared stack's plus 100:

| Service | Shared | Capture |
|---|---|---|
| Forgejo | 3300 | 3400 |
| floci | 4580 | 4680 |
| Grafana | 3310 | 3410 |
| Prometheus | 9190 | 9290 |
| Tempo | 3210 | 3420 |
| OTLP, collector health | 4328, 13143 | 4428, 13243 |
| registry | 5050 | 5150 |
| fountain | 4010 | 4110 |
| mock GitHub, GitLab | 8198, 8939 | 8298, 9039 |
| Azurite, GCS, decide | 10010, 4453, 8790 | 10110, 4553, 8890 |

Inside it the forge is still `http://forgejo:3000` and floci `http://floci:4566`, so the notes and pages a capture records read the same, and the capture writes `localhost:3400` in command output as `localhost:3300` (each port as its shared one). Both instances share the `terragucci-job-cache` volume. Any `just stack-up`, `just example` or `stack/smoke.sh` call takes `TG_STACK=capture` too; `just capture-stack-down` removes the capture stack and leaves the shared one alone.

## The GitLab lab

`gitlab/` is a second stack for the smoke claims on GitLab: GitLab CE, one gitlab-runner with the docker executor and floci, under the compose project `tglab`. It has its own network (`tglab`), volumes (`tglab-*`, the job cache among them) and ports, so it runs beside the validation stack and the scale bench, its claims never wait on a lock of theirs, and `down.sh` leaves it alone. The pins are the gitlab profile's, and both boot through `gitlab-boot.sh`: wait for GitLab to serve, mint the root token with `gitlab-rails runner`, register the runner on the stack's network with the stack's job cache, create `root/validate`.

| Service | Host | On the network | Override |
|---|---|---|---|
| GitLab | 8959 | `http://gitlab:8929` | `TGLAB_GITLAB_PORT` |
| floci | 4710 | `http://floci:4566` | `TGLAB_FLOCI_PORT` |

```bash
just gitlab-lab up                       # boot it; writes stack/gitlab/.state/gitlab.env
just gitlab-claims note-footer tips      # GitLab's claims, plain and under BREAK=1, rows into smoke.json
SMOKE_FORGE=gitlab stack/smoke.sh tips   # one run, for debugging; BREAK=1 as usual
just gitlab-lab status                   # its containers, their memory, its volumes
just gitlab-lab stop                     # stop it and keep GitLab's data
just gitlab-lab down                     # containers, job containers, network and volumes
```

Nothing starts the lab but `up`: a claim run on GitLab fails at once, saying so, when it is down. `up` refuses when the data volume has less than `TGLAB_MIN_FREE_GB` (40) free.

Measured on an Apple silicon Mac (18 cores, Docker given 20 GB), GitLab under emulation:

| | |
|---|---|
| cold `up`, from no volumes | 141 s (GitLab serves after about 120 s) |
| `up` after `stop` | 44 s |
| GitLab's memory | 3.4 GB idle after boot, 3.8 GB at the peak of boot, 4.4 GB after a claim run |
| floci and the runner | 0.3 GB and under 0.1 GB |
| images | 3.7 GB (GitLab CE) and 0.4 GB (the runner), pulled once |
| volumes | 0.4 GB after boot, 0.5 GB after a claim run |
| the four GitLab claims, plain and broken | about 5 minutes |

That is about 5 GB of memory while it runs. Keep it down while the validation stack runs a full claim pass or the scale bench runs, and bring it down when done.

`SMOKE_FORGE=gitlab` points `smoke.sh` at the claims in `smoke-gitlab.sh`: the table `GITLAB_CLAIMS`, the locks `GITLAB_CLAIM_GROUPS`, and a `gitlab_claim_<area>/<part>` per claim. Their locks and logs are under `stack/gitlab/.state/`. Their jobs run the lab's own image, `tglab-tofu:<bundle hash>`: the tofu CI image as the local daemon holds it, with this tree's bundle in it (`gitlab.sh image`). The pushed pipelines name it through `TG_TOFU_IMAGE`, so a run on the lab never rebuilds the shared `ghcr.io/intentius/*` tags. `validate-generated.sh` takes `TG_TOFU_IMAGE` the same way. Each run pushes a one-root repo with the pipeline `terragucci init --forge gitlab` writes to a new project named after the claim and the run (`smoke-tips-plain-<time>`), and its state to the lab's floci under the same name, so a claim's plain and `BREAK=1` runs go at once. The next run of a claim deletes the projects the last one left. A GitLab row in `smoke.json` carries `forge: "gitlab"` and replaces only the GitLab row of its claim; a row with no `forge` is Forgejo's. The validation page shows GitLab rows in a column of their own, and `tutorial-check` and `tutorial-capture` read only the Forgejo rows. `just claims-affected` picks Forgejo claims; run GitLab's by name.

## Networking rules

These came from choudoufu's GitLab run and hold here too.

1. A forge's public URL is its service name. Forgejo's `ROOT_URL` is `http://forgejo:3000/`, not localhost. Every URL a job is handed, including the clone URL and the API URL, comes from it, and inside a job container localhost is the job container. The host still reaches the same server on `localhost:3300`, because Forgejo serves any Host header.
2. The network is named, and the runner puts its job containers on it. forgejo-runner's config sets `container.network: terragucci`. Without it, jobs land on a fresh per-job network and reach neither `forgejo` nor `floci`.
3. Anything a job needs is addressed by service name: `http://floci:4566` for AWS, `http://forgejo:3000` for git and the API.

## Runner registration

`forgejo-runner register` and `create-runner-file` are both marked deprecated in forgejo-runner 13. `bootstrap.sh` creates the runner on the server with `POST /api/v1/admin/actions/runners`, which returns a uuid and a token, and writes them into the runner's config under `server.connections`. The runner container waits for that config before starting its daemon. The config also mounts the `terragucci-job-cache` volume at `/cache` in every job container, which holds the OpenTofu binary and the provider plugin cache, so the AWS provider downloads once per stack rather than once per job.

### OIDC tokens

Forgejo serves Actions OIDC tokens from version 15 and Forgejo Runner from 12.5, so the pinned pair serves them with no setting: Forgejo generates its signing key under `/data` on first use and publishes it at `http://forgejo:3000/api/actions/.well-known/openid-configuration`. A job gets `ACTIONS_ID_TOKEN_REQUEST_URL` only when it sets `enable-openid-connect: true`; Forgejo does not read `permissions: id-token: write`. The `oidc/forgejo` claim in `smoke.sh` checks it end to end: floci accepts a token from an issuer it does not host without checking it, so the claim's probe verifies the signature against Forgejo's keys itself before it trades the token with floci's STS.

### State lock waits

The `lock/wait-span` claim needs choudoufu, because OpenTofu sends no span for a lock wait. It builds a Linux binary from `CHOUDOUFU_REF` (default `origin/main`) of the checkout at `CHOUDOUFU_DIR` (default `~/Documents/checkouts/intentius/choudoufu`), read with `git archive` so the checkout is left alone, and keeps it under `.state/choudoufu/<commit>-<arch>/`. The host's Go cross-compiles it when there is one, and a `golang` container otherwise. `CHOUDOUFU_BIN` names a Linux build to use instead. The claim's state lives in the `terragucci-smoke-lock` bucket on floci, with `use_lockfile = true`; a second plan holds the lock while it waits at a variable prompt, and the claimed `tf-apply` wave plans with `-lock-timeout=150s` (through `TF_CLI_ARGS_plan`) so it waits rather than fails.

## Pins

| Piece | Pin |
|---|---|
| floci | `ghcr.io/lex00/floci@sha256:63d8f1ed5ef595d7356c6f76318f3d76bc31ce3250cdf2dd8d14bd4d59604b8d` (`b491869`, branch `fix/cfn-change-set-changes`, resolved 2026-10-18, amd64 and arm64: a role's permissions boundary on read, a change set's changes, and SNS tags) |
| Forgejo | `codeberg.org/forgejo/forgejo:16.0.5` |
| forgejo-runner | `data.forgejo.org/forgejo/runner:13.2.0` |
| job image | `public.ecr.aws/docker/library/node:22-bookworm` |
| OpenTofu | 1.13.1, in the fixture workflow's `TOFU_VERSION` |
| AWS provider | `hashicorp/aws` 6.67.0, with `.terraform.lock.hcl` for linux_arm64, linux_amd64 and darwin_arm64 |
| mock GitHub | `public.ecr.aws/docker/library/node:22-bookworm` running `mock-github/server.mjs` |
| act | 0.2.89 on the host |
| GitLab | `gitlab/gitlab-ce:17.11.0-ce.0`, `gitlab/gitlab-runner:v17.11.0`, in the gitlab profile and the lab |
| fountain | `ghcr.io/managoat/fountain:v0.21.0@sha256:c90f8ceb…` (amd64 and arm64), `public.ecr.aws/docker/library/postgres:16`, the fountain 0.21.0 CLI from its GitHub release in `terragucci-fountain-steward:local` |

Jobs fetch `actions/checkout@v4` from data.forgejo.org and OpenTofu from GitHub releases, so the forgejo profile needs network access. The github and gitlab pipelines run in terragucci's tofu image, built into the local daemon by `bootstrap.sh` when it is missing; they download the AWS provider on every run.
