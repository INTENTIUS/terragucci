# The local validation stack

terragucci's pipelines are meant to be run before they ship, on a real forge with a real runner, against an AWS emulator, all on one Docker network. This directory is that stack. [terragucci#4](https://github.com/INTENTIUS/terragucci/issues/4) is the design and lists every claim it should eventually check.

The forgejo claims run a hand-written workflow (`fixtures/s3-bucket/.forgejo/workflows/tofu.yml`). The github and gitlab claims run the pipeline `terragucci init` writes for that forge into the same fixture, so they check the generated file.

## What runs today

| Profile | Services | State |
|---|---|---|
| `aws` | floci | validated: starts, answers S3 |
| `forgejo` | floci, Forgejo, forgejo-runner (docker executor) | validated: the `check` and `apply` claims pass |
| `github` | floci, a mock GitHub API, `act` on the host | validated: `check`, `apply` and `reconcile` pass |
| `gitlab` | floci, GitLab CE, gitlab-runner (docker executor) | validated: `check`, `apply` and `reconcile` pass |
| `fountain` | floci, fountain, Postgres, waterpark's sandbox runner | declared, not yet validated |
| `observability` | an OpenTelemetry collector and Prometheus (`stack/observability/`) | started by the `traces` and `metrics` claims when it is not up; `stack/down.sh` removes it |

Declared means the services are in `docker-compose.yml`, readable, with comments on what they still need. `bootstrap.sh` refuses `fountain` unless `TERRAGUCCI_UNVALIDATED=1`, and then only starts its containers. No claim runs on it.

- `github`: GitHub has no self-hostable edition. `mock-github/server.mjs` is a small stateful GitHub: it creates repos, serves their git over smart HTTP (`git http-backend`), opens, lists and merges pull requests, and stores issue comments. The runner is `act` on the host, which runs the repo's real workflow file with its job containers on the `terragucci` network. A push is a git push to the mock, and a run is `act push` on a fresh clone of the pushed commit with a push event for that branch, so `github.ref` and the default-branch condition behave as on GitHub. `act` has to be installed (`brew install act`).
- `gitlab`: GitLab CE 17.11 and gitlab-runner 17.11 with the docker executor, taken from gitlab-warden's e2e stack. The GitLab image is linux/amd64 only, so on Apple silicon it runs under emulation and cold boot takes a few minutes. Speed does not matter here, and the runner and the job containers are native. `bootstrap.sh` mints a root token with `gitlab-rails runner`, creates an instance runner over `POST /api/v4/user/runners` and registers it with `--docker-network-mode terragucci`.
- `fountain`: copied from waterpark's `compose/`. The runner needs an API key that exists only after an account is registered.

## The example and the smoke claims

`example/` is the shop's estate: 15 roots (dev, staging and prod, each a platform root and four services calling `modules/service`), applied to floci by the forgejo profile. It is the tutorial's example and the subject of every smoke claim ([terragucci#11](https://github.com/INTENTIUS/terragucci/issues/11)).

| Command | Does |
|---|---|
| `just example up [--fresh]` | boots the forgejo profile, pushes the example to `terragucci-admin/example` (public) and applies every root; `--fresh` wipes floci and the repo first |
| `just example verify` | checks that every bucket, queue and table main declares is in floci |
| `just example change <scenario>` | opens a pull request with one of `example/changes/` (`drift` and `pin` act directly) |
| `just example merge <scenario>` | merges that scenario's pull request as the reader would, listing the reader's ssh key in `.chant/allowed_signers` first, and prints the approval a waiting wave asks for or the refusal a changed one gives |
| `just example approve [wave-N]` | approves the waiting wave as the reader, sealed with the reader's key (by default the wave the last run asked about) |
| `just example reset` | closes the pull requests, puts main back, applies again |
| `just smoke [claim]` | one line per claim: `SMOKE claim=… verdict=pass\|caught\|fail\|pending`; `BREAK=1` must print `caught` |
| `just smoke-record` | every claim plain and under `BREAK=1`, written to `docs-site/src/data/smoke.json` for the status page |
| `just tutorial-capture` | the tutorial's output and screenshots, for steps whose claims pass |
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

`validate.sh` finds the run by the pushed commit's sha (`GET /repos/{owner}/{repo}/actions/runs?head_sha=`), polls it every 3s up to `TERRAGUCCI_VALIDATE_TIMEOUT` (900s), and prints each job's log through `/actions/jobs/{id}/logs` when a run is not what it expected.

## In CI

Every pull request boots the aws, forgejo and github profiles in separate jobs and runs `just validate-forge <forge>`, which runs each of that forge's claims plain and under `BREAK=1`. The gitlab profile runs nightly on an amd64 runner (`.github/workflows/nightly.yml`). The weekly capture workflow runs `just validation-record`, which boots each forge in turn and rewrites `docs-site/src/data/validation.json`, the table on the validation page. Pass forge names to record only those: `just validation-record gitlab`. The workflows are declared in `ci/`, `nightly/` and `capture/`.

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

`stack/validate-generated.sh` holds the github and gitlab claims. Each forge supplies a small driver (`forge-github.sh`, `forge-gitlab.sh`) with the same functions: reset a repo, push a tree, run the pipeline for a commit, open and merge a request. GitLab projects are kept between runs and reset (open merge requests closed, `main` reseeded and unprotected), because deleting one holds its name for a while. The mock's repos are deleted and created each time.

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

## Networking rules

These came from choudoufu's GitLab run and hold here too.

1. A forge's public URL is its service name. Forgejo's `ROOT_URL` is `http://forgejo:3000/`, not localhost. Every URL a job is handed, including the clone URL and the API URL, comes from it, and inside a job container localhost is the job container. The host still reaches the same server on `localhost:3300`, because Forgejo serves any Host header.
2. The network is named, and the runner puts its job containers on it. forgejo-runner's config sets `container.network: terragucci`. Without it, jobs land on a fresh per-job network and reach neither `forgejo` nor `floci`.
3. Anything a job needs is addressed by service name: `http://floci:4566` for AWS, `http://forgejo:3000` for git and the API.

## Runner registration

`forgejo-runner register` and `create-runner-file` are both marked deprecated in forgejo-runner 13. `bootstrap.sh` creates the runner on the server with `POST /api/v1/admin/actions/runners`, which returns a uuid and a token, and writes them into the runner's config under `server.connections`. The runner container waits for that config before starting its daemon. The config also mounts the `terragucci-job-cache` volume at `/cache` in every job container, which holds the OpenTofu binary and the provider plugin cache, so the AWS provider downloads once per stack rather than once per job.

## Pins

| Piece | Pin |
|---|---|
| floci | `ghcr.io/lex00/floci@sha256:b08cd3d507429fae9201b85cca58dcb5e6708bca3bde37eaface7b7fb1419813` (`iam-boundary`, resolved 2026-10-03, amd64 and arm64) |
| Forgejo | `codeberg.org/forgejo/forgejo:16.0.5` |
| forgejo-runner | `data.forgejo.org/forgejo/runner:13.2.0` |
| job image | `node:22-bookworm` |
| OpenTofu | 1.13.1, in the fixture workflow's `TOFU_VERSION` |
| AWS provider | `hashicorp/aws` 6.67.0, with `.terraform.lock.hcl` for linux_arm64, linux_amd64 and darwin_arm64 |
| mock GitHub | `node:22-bookworm` running `mock-github/server.mjs` |
| act | 0.2.89 on the host |
| GitLab | `gitlab/gitlab-ce:17.11.0-ce.0`, `gitlab/gitlab-runner:v17.11.0` |
| fountain (declared) | `ghcr.io/binarybourbon/fountain:sha-7f8d16af…`, `postgres:16`, `ghcr.io/intentius/waterpark-runner:latest` |

Jobs fetch `actions/checkout@v4` from data.forgejo.org and OpenTofu from GitHub releases, so the forgejo profile needs network access. The github and gitlab pipelines run in terragucci's tofu image, built into the local daemon by `bootstrap.sh` when it is missing; they download the AWS provider on every run.
