### terragucci tf-plan: `4f1a9c0e2b7d`

3 instances: 3 groups, 1 destroy or replacement. [Full report](report.html)

1 to add, 2 to change, 1 to destroy across 1 root

<!-- terragucci:waves {"head":"4f1a9c0e2b7d8a1c3e5f7a9b0c2d4e6f8a1b3c5d","waves":[{"number":1,"digest":"jcs1-sha256:208d6ecbc6978c9acd4214d67128f9cb7257be6fac123a58dab879133f5a0f6c","waits":true}]} -->

**Destroys, replacements, refusals, imports and forgets (1):**

- [`app: aws_s3_bucket_acl.logs`](report.html#root-app) (replace, forced by `acl`)

| Wave | Roots | Digest of its changes | When it applies |
|---|---|---|---|
| 1 | 1 | `jcs1-sha256:208d6ecbc6978c9acd4214d67128f9cb7257be6fac123a58dab879133f5a0f6c` | waits for an approval: `terragucci approve wave-1 --plan jcs1-sha256:208d6ecbc6978c9acd4214d67128f9cb7257be6fac123a58dab879133f5a0f6c` |

#### [Group a3f78a4b3796](report.html#group-a3f78a4b3796): 1 instance of `aws_s3_bucket_acl.logs`, change, on every run

```
-/+ aws_s3_bucket_acl.logs: acl
```

Instances: `aws_s3_bucket_acl.logs`

#### [Group 7649c22a5535](report.html#group-7649c22a5535): 1 instance of `aws_sqs_queue.jobs`, change

```
~ aws_sqs_queue.jobs: visibility_timeout_seconds
```

Instances: `aws_sqs_queue.jobs`

#### [Group 843eb5cfc9a8](report.html#group-843eb5cfc9a8): 1 instance of `module.api.aws_lambda_function.this`, change, on every run

```
~ module.api.aws_lambda_function.this: source_code_hash
```

Instances: `module.api.aws_lambda_function.this`

<details><summary>Changes on every run (2)</summary>

| Resource | Attribute | Applied waves in a row |
|---|---|---|
| [`app`](report.html#root-app): `aws_s3_bucket_acl.logs` (replace) | `acl` | 3 |
| [`app`](report.html#root-app): `module.api.aws_lambda_function.this` | `source_code_hash` | 3 |

These changes are in every plan, whatever the pull request changes: an archive hash a build rebuilds each time (build the artifact reproducibly), a timestamp or a value set outside the config (`lifecycle { ignore_changes }`), or a value the provider normalises differently from the config (pin the provider version that normalises it).

</details>


<sub><img src="https://intentius.io/terragucci/brand/taco-small.png" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>
