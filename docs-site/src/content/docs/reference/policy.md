---
title: Policy
description: Opt-in policy checks that run conftest or OPA over each plan and fail tf-plan on a denial.
---

Add `policy` to `terragucci.yml` to turn policy checks on; without it nothing runs. `tf-plan` then passes the plan JSON of each planned root to your Rego and fails the root when it denies.

```yaml
policy:
  engine: conftest
  path: policy
```

| Key | Default | Meaning |
|---|---|---|
| `engine` | `conftest` | `conftest` or `opa` |
| `path` | `policy` | the directory of Rego files, inside the repo |
| `namespace` | every namespace for conftest, `main` for opa | the Rego package whose `deny` rules count |

A policy is Rego that denies with a message:

```rego
package main

import rego.v1

deny contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_s3_bucket_public_access_block"
  rc.change.after.block_public_acls == false
  msg := sprintf("%s must block public ACLs", [rc.address])
}
```

`input` is the unredacted output of `show -json` for one root. A denied root fails, the job exits 1, and the report names each message under that root. conftest warnings are advice and fail nothing. A policy that cannot run also fails the root. So does an engine that is not installed, or Rego that does not compile.

A denial has no override. Responses, agents and comments cannot waive it; the code changes until the policy passes, or the policy changes in a pull request your reviewers approve and merge.

A pull request cannot edit the policy to allow itself. When a plan runs for a pull request, terragucci reads the `policy` key from `terragucci.yml` and the policy directory from the base branch, into a temporary directory, and checks the plan against that copy. The pull request's own edits to either take effect once the pull request is merged. If the base has no `policy` key, the pull request's own policy applies, since there is nothing to waive. If the base has the key but the directory is missing there, or the base cannot be read, every planned root fails. A `terragucci.ts` config is not evaluated at the base: its `policy` settings come from the checkout, and the directory still comes from the base.

The base branch is the pull request's target. terragucci finds it from the environment the forge sets: `GITHUB_BASE_REF` on GitHub Actions and Forgejo Actions, and `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` on GitLab merge request pipelines, read as `origin/<branch>`. `TG_BASE` names a ref directly and wins over both. The job's checkout needs that ref fetched, as affected-root selection already does.

`tf-apply` runs the same check on each wave's plans, after planning and before the gate, and refuses a wave with a denial: the wave applies nothing and records no approval to wait for. The apply job runs from the default branch, so its checkout is the policy from main. Set `TG_BASE` to read the policy from another ref.

The images carry neither engine. When the engine you set is not on the path, terragucci downloads a pinned release once per job, conftest 0.71.0 as its Linux archive or OPA 1.21.1 as its static Linux binary, and refuses any download that differs from the SHA-256 shipped with terragucci (taken from the release's own checksums). A job without network access needs the engine installed beforehand, and drift runs and provisional Terragrunt previews skip the check.
