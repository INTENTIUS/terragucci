# @intentius/terragucci

The whole Terraform and Terragrunt lifecycle, handled. terragucci writes your repo's pipeline for GitHub, GitLab or Forgejo. Most repos need no config file at all.

```bash
npm i -D @intentius/terragucci
npx terragucci init
```

`init` reads the repo to decide what the pipeline needs, then writes it and reports what it found:

```
found 15 roots in 2 layers, tofu 1.13.1 (.opentofu-version), forge github (the origin remote (github.com))
wrote .github/workflows/terragucci.yml
no terragucci.yml needed (defaults fit)
```

A root is a directory whose Terraform files declare a backend or configure a provider. A root that reads another's state with `terraform_remote_state` applies after it. Running `init` again changes nothing unless the repo changed.

## Commands

| Command | Does |
|---|---|
| `terragucci init` | sets one repo up; `--forge` and `--binary` override detection, `--dry-run` writes nothing |
| `terragucci reconcile --config <file>` | from a control repo, previews every project's pipeline; `--mode apply` opens a pull request in each project that changes |
| `terragucci plan` | plans this repo's roots in apply order; `--root <glob>` narrows it |

| Exit code | Means |
|---|---|
| 0 | done |
| 1 | a project or root failed |
| 2 | a usage or config error |

## Config

Most repos need no `terragucci.yml`. When yours does, it holds only what detection got wrong:

```yaml
binary: tofu
env:
  AWS_REGION: eu-west-1
```

A control repo lists many repos instead, and opens a pull request in each:

```yaml
defaults:
  binary: tofu
projects:
  github.com/acme/infra: {}
  gitlab.example.com/platform/network:
    binary: terraform
```

The file can also be `terragucci.ts`, typed with `TerragucciConfig`. terragucci folds it to data without running it, and refuses a config that reads the environment.

Docs: https://intentius.io/terragucci/
