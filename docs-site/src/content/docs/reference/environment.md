---
title: Environment variables and credentials
description: Every variable terragucci reads, which job gets it, and how cloud roles are assumed.
---

The config names variables and never holds a value. Put secrets in your forge's secret store and expose them to the job that needs them.

## Forge tokens

| Variable | Used by | Needs |
|---|---|---|
| the run's own token (`github.token` on GitHub and Forgejo) | the generated plan and apply jobs | comment on pull requests, write commit statuses; the apply job also writes the `chant/lifecycle` branch |
| `GITLAB_TOKEN` | the generated jobs on GitLab | a project access token with the `api` scope, as a masked variable |
| `GITHUB_TOKEN`, `GITLAB_TOKEN`, `FORGEJO_TOKEN` | `reconcile` and `rollout`, by the project's forge | push branches and open pull requests in the projects they touch |

`token_env` in the config names a different variable for a project. The token for `rollout` and `reconcile` needs no merge or approval rights, and the commands never merge.

## Reports

Set these on the plan job when `reports.bucket` is set.

| Variable | Meaning |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | credentials that can write to the bucket |
| `AWS_SESSION_TOKEN` | for temporary credentials, when set |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` | a store that is not AWS; `reports.endpoint` takes precedence |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | the bucket's region; `us-east-1` when neither is set |

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

terragucci reads the standard `OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME` and `OTEL_SDK_DISABLED` variables, and `TRACEPARENT`. [Traces and metrics](/terragucci/reference/observability/#turning-it-on) lists them.

## Other variables

| Variable | Meaning |
|---|---|
| `TERRAGUCCI_TERRAGRUNT` | the `terragrunt` executable to run; `terragrunt` on the path by default |
| `env:` in the config | variables every job gets; values only, never secrets |
