# Terragrunt with choudoufu as its binary

A Terragrunt repo whose binary is choudoufu. There is no terragucci in it: a
Forgejo workflow (`.forgejo/workflows/terragrunt-choudoufu.yml`) runs
Terragrunt's own CLI, and `root.hcl` sets `terraform_binary = "choudoufu"`
(`TG_TF_PATH` does the same from the environment).

```
root.hcl                  terraform_binary = "choudoufu"
live/all/terragrunt.hcl   the one unit; source = "../../estates//composed"
estates/composed/main.tf  one module call per estate, and nothing else
estates/network|app|edge  each a choudoufu estate: its own live block, one record store
```

## How the single pass works

- The unit's `source` has a double slash, so Terragrunt copies all of `estates/`
  into its cache and runs in `composed/`. The calls `../network`, `../app` and
  `../edge` resolve there.
- choudoufu sees a root with no `live` block of its own whose local modules
  carry one, and runs it as a composed run: one plan, one apply, across the
  estates. Each resource's record goes to its own estate in
  `demo-terragrunt-choudoufu-records`, so a read of another estate's output
  resolves inside the run, including an id the apply creates.
- `terragrunt plan` on the pull request is that one plan. `terragrunt apply` on
  the merge is that one apply.

## Against `run --all` with dependency blocks

With one unit per estate, `terragrunt run --all plan` plans app on
`mock_outputs` until network applies (the mock is allowed for `plan` only), and
plans app again after network's apply. This repo has no `dependency` block and
no mock to go wrong: app reads network through `terraform_estate_outputs`, and a
value that exists only after apply shows as "known after apply" in the same plan.

## Moving an existing repo

- Keep `root.hcl` and its includes. Set the binary to choudoufu.
- Add a `live` block to each unit's module (an estate name and a record store),
  and drop its `remote_state` block: choudoufu refuses a backend beside a `live`
  block.
- A composed root's module calls take no arguments, so Terragrunt `inputs`
  (which reach a unit as `TF_VAR_*`) do not reach the estates. Each estate's
  inputs are its variables' defaults, reviewed in the pull request like any
  other change.

## Approval

A person's approving review of the pull request, then the merge. The apply job
asks Forgejo for the merged pull request's reviews and stops without one. The
apply plans again before it applies; it is not bound to the plan the review saw.

## The base

Every scenario starts from a running estate that matches
`example-demo-choudoufu-compose`. network holds `aws_vpc.main`,
`aws_subnet.subnet_a` (10.0.1.0/24) and the `http_proxy_port` terraform_data.
app holds `aws_security_group.web`, `aws_network_interface.web` in subnet a
and the `listener_port` terraform_data. edge holds `terraform_data.allowlist`
(`["10.0.1.0/24"]`) and the `upstream` terraform_data. Each estate keeps its
own `tgc-` name and the `test` keys in its provider block.

## Scenarios

- `terragrunt-choudoufu-edit`: network's proxy port goes from 8080 to 8090 and
  it gains an `admin_port`. app adds an `admin_listener_port` and edge an
  `admin_upstream`. 3 to add, 3 to change, 0 to destroy, every value known at
  plan.
- `terragrunt-choudoufu-create`: one resource is added to the running estate.
  network adds `aws_subnet.subnet_b` (10.0.2.0/24) and outputs `subnet_b_id`
  and `subnet_b_cidr`. app adds `aws_network_interface.worker` in that subnet,
  and edge's `allowlist` gains the new range. 2 to add, 1 to change, 0 to
  destroy. One value is unknown at plan: subnet b's id, at its source and in
  the worker's `subnet_id`. Nothing is replaced or destroyed in either act.

`stack/demo.sh` applies the base with choudoufu in each estate (`estates_apply`),
outside the workflow, and each reset applies it again, downstream first.
