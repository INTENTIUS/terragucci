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

A denial has no override. Responses, agents and comments cannot waive it; the code changes until the policy passes, or the policy changes in a pull request your reviewers approve. The plan job reads `policy` and its directory from the pull request's own checkout, so a CODEOWNERS rule or branch rule should guard both.

The images carry neither engine. If `conftest` is not on the path, terragucci downloads a pinned release once per job. It checks the download against a SHA-256 it ships with. A job without network access needs conftest installed beforehand, and `opa` is always installed beforehand. Drift runs and provisional Terragrunt previews skip the check.
