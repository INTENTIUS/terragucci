---
title: Environment variables and credentials
description: Every variable terragucci reads, which job gets it, and how cloud roles are assumed.
---

The config names variables and never holds a value. Put secrets in your forge's secret store and expose them to the job that needs them.

## Forge tokens

| Variable | Used by | Needs |
|---|---|---|
| the run's own token (`github.token` on GitHub and Forgejo) | the generated plan and apply jobs | comment on pull requests, write commit statuses; the apply job also writes the [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle) branch |
| `GITLAB_TOKEN` | the generated jobs on GitLab | a project access token with the `api` scope, as a masked variable |
| `GITHUB_TOKEN`, `GITLAB_TOKEN`, `FORGEJO_TOKEN` | `reconcile`, `rollout` and `respond --mode apply`, by the project's forge | push branches and open pull requests in the projects they touch |
| `TG_TOKEN` | the comment, status and respond steps of a generated job | the job sets it from the run's own token or `GITLAB_TOKEN`; set it yourself to run those commands outside a pipeline |
| `GITEA_TOKEN` | nothing | the agent's job clears it with the other runner tokens, so it never reaches the agent |

`token_env` in the config names a different variable for a project. The token for `rollout`, `reconcile` and `respond` needs no merge or approval rights, and the commands never merge.

## Reports

Set these on the plan job when `reports.bucket` is set.

| Variable | Meaning |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | credentials that can write to the bucket |
| `AWS_SESSION_TOKEN` | for temporary credentials, when set |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` | a store that is not AWS; `reports.endpoint` takes precedence |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | the bucket's region; `AWS_REGION` first, then `AWS_DEFAULT_REGION`, then `us-east-1` |

## Secrets the config names

These names come from your config, and each defaults as shown. The variable holds a secret in your forge's store, and the generated job that needs it maps it in.

| Config key | Default name | Holds |
|---|---|---|
| `agent.comment.key_secret` | `ANTHROPIC_API_KEY` | the model's API key, given to the agent's step alone |
| `agent.token_env` | none, required | the token the agent's change is pushed with |
| `decide.token_env` | none, required for `jev` | the typed-decision service's bearer token |
| `telemetry.headers_secret` | none | the value of `OTEL_EXPORTER_OTLP_HEADERS` |
| `token_env` | by forge, see above | the forge token |

## Module publishing

The `publish` job is the only job given these. Set them as secrets on GitHub and Forgejo, and as protected, masked variables on GitLab.

| Variable | Meaning |
|---|---|
| `TERRAGUCCI_REGISTRY_USER` | the registry user |
| `TERRAGUCCI_REGISTRY_PASSWORD` | its password or token |
| `TERRAGUCCI_REGISTRY_INSECURE` | `1` for a registry without TLS |

Git tags are pushed to `origin` with the job's checkout, so they need no variable.

## Cloud roles over OIDC

Set `oidc` in your config and jobs trade the forge's identity token for cloud roles, so CI holds no long-lived keys.

```yaml
oidc:
  plan_role: arn:aws:iam::111122223333:role/terragucci-plan
  apply_role: arn:aws:iam::111122223333:role/terragucci-apply
  audience: sts.amazonaws.com
```

| Key | Meaning |
|---|---|
| `plan_role` | the read-only role the plan job assumes |
| `apply_role` | the write role, assumed only by the apply job on the default branch |
| `audience` | the AWS token's audience; `sts.amazonaws.com` when omitted |
| `gcp.workload_identity_provider` | the GCP workload identity pool provider's resource name, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `gcp.plan_service_account`, `gcp.apply_service_account` | the service accounts the plan and apply jobs impersonate |
| `gcp.token_url` | the STS endpoint that exchanges the token; `https://sts.googleapis.com/v1/token` when omitted, or a regional endpoint |
| `azure.audience` | the token's audience; `api://AzureADTokenExchange` when omitted, `api://AzureADTokenExchangeUSGov` for Azure US Government, `api://AzureADTokenExchangeChina` for Azure China |
| `azure.tenant_id`, `azure.subscription_id` | the Entra ID tenant and the subscription the jobs work in |
| `azure.plan_client_id`, `azure.apply_client_id` | the client IDs of the app registrations or managed identities the plan and apply jobs sign in as |

Plan runs the pull request's code, so it gets the read-only role. The config rejects one role for both. Forks get no plan job, so nothing reaches their pull requests.

GitHub jobs get the token through `id-token: write`, and GitLab jobs through `id_tokens`. Forgejo jobs set `enable-openid-connect: true` and ask the runner's token endpoint; Forgejo serves it from version 15, with Forgejo Runner 12.5 or later. The job writes the token to the file `AWS_WEB_IDENTITY_TOKEN_FILE` names and sets `AWS_ROLE_ARN`, so the AWS SDKs in the binary and its providers pick the role up. Your role's trust policy must accept the forge's issuer and your repo. [Credentials](/terragucci/reference/pipeline/#credentials) has the variables GCP and Azure get, and their setup.

| Forge | Issuer | Subject |
|---|---|---|
| GitHub | `https://token.actions.githubusercontent.com` | `repo:<owner>/<repo>:ref:refs/heads/<branch>`, or `repo:<owner>/<repo>:pull_request` |
| GitLab | your GitLab URL | `project_path:<group>/<project>:ref_type:branch:ref:<branch>` |
| Forgejo | your Forgejo URL followed by `/api/actions` | `repo:<owner>-<owner id>/<repo>-<repo id>:ref:refs/heads/<branch>`, or `repo:<owner>-<owner id>/<repo>-<repo id>:pull_request` |

Forgejo 16 puts the owner's and the repo's numeric IDs in the subject, for example `repo:shop-12/infra-345:pull_request`. A repo that had Actions enabled before Forgejo 16 keeps `repo:<owner>/<repo>` until Actions is turned off and on again for it. The repo's settings page and `GET /api/v1/repos/<owner>/<repo>` show both IDs.

A Forgejo older than 15, or a runner older than 12.5, serves no token: the token request fails and the job stops before it plans. Leave `oidc` unset on such a forge and give the runner static credentials as environment variables in its config.

In a Terragrunt repo, roles can follow unit paths. See [The generated pipeline](/terragucci/reference/pipeline/#terragrunt).

## Agent integrations

`agent.token_env` names the variable that holds the agent's forge token. The token can comment and open pull requests, and the role is read-only. Naming the apply role there is an error. See [Responses to pipeline events](/terragucci/reference/responses/#where-it-runs).

## Traces and metrics

terragucci reads the standard OpenTelemetry variables, and `TRACEPARENT` to join a trace its caller started. [Traces and metrics](/terragucci/reference/observability/#turning-it-on) says what each does.

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's OTLP/HTTP base URL |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | one signal's full URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | headers sent with every request; `telemetry.headers_secret` maps a secret into it |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | headers for one signal, added to the shared ones |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `grpc` is refused, since terragucci sends OTLP over HTTP |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `none` turns one signal off |
| `OTEL_SDK_DISABLED` | `true` turns both off |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | the service name, `terragucci` by default, and extra resource attributes |
| `TRACEPARENT` | the parent span of the stage's trace |

## Other variables you can set

| Variable | Meaning |
|---|---|
| `TERRAGUCCI_TERRAGRUNT` | the `terragrunt` executable to run; `terragrunt` on the path by default |
| `TOFU_INSTALL_DIR` | where `terragucci install` puts the binary; `$RUNNER_TEMP/terragucci-bin`, or the system temp directory's `terragucci-bin`, when unset |
| `RUNNER_TEMP` | set by GitHub and Forgejo runners; the install directory's parent when `TOFU_INSTALL_DIR` is unset |
| `TF_CLI_ARGS`, `TF_CLI_ARGS_plan`, `TF_CLI_ARGS_apply` | the binary reads them itself. A `-lock-timeout` in any of them replaces terragucci's default of `-lock-timeout=5m` on plan and apply |
| `TG_LOCK_STALE` | seconds after which a Forgejo apply takes over a lock whose holder stopped renewing; 7200 by default |
| `TG_LOCK_POLL` | seconds between a waiting Forgejo apply's checks of the lock; 10 by default |
| `TG_BASE` | the ref a pull request's policy is read from, such as `origin/main`; set it to read the policy from another ref when you run `check` or `stage tf-apply` by hand. Otherwise the pull request's target branch is used |
| `TG_BRANCH` | the default branch's name; the generated jobs set it, and a push to any other branch reads its policy from `origin/<that branch>` |
| `TG_PR`, `TG_SHA`, `TG_HEAD` | the pull request number, the commit, and the pull request's head branch; the generated jobs set them, and the same commands take them from your environment when you run them by hand |
| `GITHUB_ACTOR`, `GITLAB_USER_LOGIN`, `USER` | read by `chant approve` on the approver's machine, in that order, to name the approver when `--actor` is not given; a waiting wave's log says so. The name must be a principal in `.chant/allowed_signers` for the seal to count |
| `env:` in the config | variables every job gets; values only, never secrets |

## Variables the forge provides

terragucci reads these from the job's environment to find the project, the run and the pull request. Every forge sets them in a job, and a local run needs none.

| Forge | Variables |
|---|---|
| GitHub and Forgejo | `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_RUN_ID`, `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `GITHUB_EVENT_PATH`, `GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT`, `GITHUB_PATH`; Forgejo also sets `FORGEJO_ACTIONS` and `GITEA_ACTIONS`, which tell the two apart |
| GitHub and Forgejo, for OIDC | `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_RUNTIME_TOKEN` |
| GitLab | `CI_PROJECT_PATH`, `CI_PROJECT_ID`, `CI_PROJECT_URL`, `CI_SERVER_URL`, `CI_SERVER_HOST`, `CI_API_V4_URL`, `CI_PIPELINE_ID`, `CI_PIPELINE_URL`, `CI_PIPELINE_SOURCE`, `CI_JOB_URL`, `CI_JOB_STATUS`, `CI_COMMIT_SHA`, `CI_COMMIT_BEFORE_SHA`, `CI_COMMIT_BRANCH`, `CI_DEFAULT_BRANCH`, `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_TITLE`, `CI_MERGE_REQUEST_DESCRIPTION`, `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`, `CI_MERGE_REQUEST_SOURCE_PROJECT_PATH`, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` |

## Variables the generated jobs set

The renderers write these into a job's steps. They are internal: nothing needs setting them by hand, and a value you set in `env:` for one of them is overwritten.

| Variable | Set for |
|---|---|
| `TG_FORGE`, `TG_TOKEN`, `TG_PR`, `TG_SHA`, `TG_HEAD`, `TG_BEFORE`, `TG_BRANCH`, `TG_BASE`, `TG_ROOT`, `TG_WAVE`, `TG_OUTCOME` | the forge helper and the steps that name a pull request, wave or root; `TG_OUTCOME` is the file that carries a job's one-line status |
| `TF_IN_AUTOMATION`, `TF_INPUT` | every job: `1` and `0` |
| `TG_NON_INTERACTIVE`, `TG_PARALLELISM`, `TG_TF_PATH`, `TG_DOWNLOAD_DIR`, `TG_PROVIDER_CACHE`, `TG_PROVIDER_CACHE_DIR`, `TG_AUTH_PROVIDER_CMD`, `TERRAGUCCI_REPO`, `TERRAGUCCI_PHASE`, `TERRAGUCCI_TG_ROLES` | Terragrunt repos: how Terragrunt runs the binary, where it caches, and the roles it assumes per unit; `TG_IAM_ASSUME_ROLE_WEB_IDENTITY_TOKEN` carries the web identity token, and terragucci never sets `TG_IAM_ASSUME_ROLE` |
| `TERRAGUCCI_OIDC`, `TERRAGUCCI_GCP_TOKEN_FILE`, `TERRAGUCCI_OIDC_GCP`, `TERRAGUCCI_OIDC_AZURE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `GOOGLE_APPLICATION_CREDENTIALS`, `ARM_USE_OIDC`, `ARM_OIDC_TOKEN_FILE_PATH`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_CLIENT_ID` | jobs with `oidc`: the token files and the identities the binary's providers read |
| `TG_AGENT_PROMPT`, `TG_AGENT_MAX_TURNS` | the agent comment's job: the prompt file and the turn limit |
| `TF_HTTP_ADDRESS`, `TF_PLUGIN_CACHE_DIR` | read from your own job environment: a GitLab-managed state address picks the lower default parallelism, and a shared plugin cache makes inits take turns |


