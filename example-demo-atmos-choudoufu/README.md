# The Atmos and choudoufu demo's tree

A plain Atmos repo with choudoufu as its Terraform binary. Nothing here uses
terragucci: a Forgejo workflow (`.forgejo/workflows/atmos-choudoufu.yml`) runs
the Atmos CLI. A pull request runs `atmos terraform plan estates -s dev`, and
a merge runs `atmos terraform apply estates -s dev -auto-approve` once the
merged pull request has an approving review from someone other than its author.

```
components/terraform/estates   the one Atmos component: module calls only
components/terraform/network   an estate (its own live block, estate ac-network)
components/terraform/app       an estate (ac-app), reads network
components/terraform/edge      an estate (ac-edge), reads app
```

`atmos.yaml` sets `components.terraform.command: choudoufu`. The `estates`
component's source is choudoufu's composed root: one `module` call per estate
directory. Each estate keeps its own `live` block and its own records in
`demo-atmos-choudoufu-records`, with no state file and no backend. choudoufu
plans and applies the three as one run, and `data "terraform_estate_outputs"`
inside the run resolves from the other module's outputs, so a subnet id that
exists only after apply reaches app and edge in the same apply.

## What Atmos hands the component

- Workspace: Atmos selects a workspace named for the stack. A composed run
  allows only `default`, so the stack sets `metadata.terraform_workspace: default`.
- Varfile: Atmos writes the stack's vars to a varfile. A module call takes no
  arguments, so the vars reach the root's variables (`stage`) and never the
  estates. An estate's inputs are its own variables' defaults.
- Backend: the stack sets none. A `backend.tf.json` Atmos generated would be
  ignored under live markers, with a warning.

## The contrast

With one Atmos component per estate, app would set
`subnet_id: !terraform.output network subnet_id`. Atmos runs `output` on
network's applied state, so before network applies, app plans on a guess.
Ordered deployments apply network first, but app's plan was still made
without the id.

## The scenarios

The base is a running estate that matches `example-demo-choudoufu-compose`.
network holds `aws_vpc.main`, `aws_subnet.subnet_a` (10.0.1.0/24) and the
`http_proxy_port` terraform_data. app holds `aws_security_group.web`,
`aws_network_interface.web` in subnet a and the `listener_port` terraform_data.
edge holds `terraform_data.allowlist` (`["10.0.1.0/24"]`) and the `upstream`
terraform_data.

`atmos-choudoufu-edit` and `atmos-choudoufu-create` are the two acts of
`example-demo-choudoufu-compose`, on the same resources. Each has `pull/` (the
pull request's files), `ask.json` (the prompts and replies behold's pane plays)
and `about.json`. No scenario replaces or destroys anything.

- `atmos-choudoufu-edit`: network's proxy port goes from 8080 to 8090 and it
  gains an `admin_port`. app adds an `admin_listener_port` and edge an
  `admin_upstream`. 3 to add, 3 to change, 0 to destroy, every value known at
  plan.
- `atmos-choudoufu-create`: network adds `aws_subnet.subnet_b` (10.0.2.0/24)
  and outputs `subnet_b_id` and `subnet_b_cidr`. app adds
  `aws_network_interface.worker` in that subnet, and edge's `allowlist` gains
  the new range. 2 to add, 1 to change, 0 to destroy. One value is unknown at
  plan: subnet b's id, at its source and in the worker's `subnet_id`.

`stack/demo.sh` applies the base with choudoufu in the demo image, outside the
workflow (`estates_apply`), and each reset applies it again.
