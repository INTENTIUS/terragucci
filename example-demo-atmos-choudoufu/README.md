# The Atmos and choudoufu demo's tree

A stock Atmos repo: three components (`network`, `app`, `edge`) under
`components/terraform/`, one stack (`stacks/deploy/dev.yaml`) with `vars` per
component, and `!terraform.output` between them. app reads network's outputs
(`subnet_a_id`, `vpc_id`, `http_proxy_port`, and `subnet_b_id` in the create
act); edge reads app's `listener_port` and network's subnet ranges.
`settings.depends_on` orders them. Nothing here uses terragucci: a Forgejo
workflow (`.forgejo/workflows/atmos-choudoufu.yml`) runs the Atmos CLI.

## What differs from a plain Atmos repo

Two things, and no others in the Atmos configuration or the stack:

1. `components.terraform.command: choudoufu` in `atmos.yaml`.
2. A `live` block in each component's `terraform {}` block, naming its estate
   and the record store that holds its resources' records, in place of a state
   file.

Workspaces are on (Atmos selects `dev` for the stack, and choudoufu accepts it
and warns that the estate is the identity), `init -reconfigure` is Atmos's
default, and Atmos writes `backend.tf.json` from the stack's S3 backend section
(`auto_generate_backend_file: true`, which is a normal Atmos setting and not a
choudoufu one). choudoufu ignores that backend, and after each apply publishes
the component's outputs to it, so `!terraform.state` and `terraform_remote_state`
readers keep working.

Not part of the Atmos repo's own configuration: the workflow's report step
(`.forgejo/composed-plan.mjs`) joins the components' slices of the joint plan
into the one document chant's `terraform report` reads for behold.

## The workflow

- Pull request: `atmos terraform plan --affected --include-dependents`. That is
  one plan across the components the change reaches. choudoufu joins the
  per-component invocations (it finds them from the parent `atmos` process), so
  a value that exists only after apply, such as a new subnet's id, is carried
  into the component that reads it and shows as "known after apply".
- Merge: the workflow checks for an approving review from someone other than
  the author, then applies. Atmos refuses plan files with `--affected` and
  `--all`, so the apply cannot be one apply: it runs `atmos terraform apply`
  for network, then app, then edge, and each one reads the real outputs of the
  one before it. One plan across components, applied in order.

## The contrast

In a stock Atmos repo, `!terraform.output network subnet_b_id` reads network's
applied state. Before network has applied, app gets a default or a mock, or the
plan fails. Here app's plan carries the id as unknown.

## Limits

- The unknown is carried as a string, so only a string output can be unknown at
  plan (a number or a boolean cannot).
- `--affected` plans what Atmos names, so `--include-dependents` is needed for
  components that read a changed one.
- The apply is not all or nothing. If edge fails, network and app stay applied.
- behold draws the lines between roots from `data "terraform_estate_outputs"`
  blocks; `!terraform.output` is not read by chant's report yet, so the reports
  of this repo carry no `reads`.

## The scenarios

The base is a running estate that matches `example-demo-choudoufu-compose`.
network holds `aws_vpc.main`, `aws_subnet.subnet_a` (10.0.1.0/24) and the
`http_proxy_port` terraform_data. app holds `aws_security_group.web`,
`aws_network_interface.web` in subnet a and the `listener_port` terraform_data.
edge holds `terraform_data.allowlist` (`["10.0.1.0/24"]`) and the `upstream`
terraform_data.

Each scenario has `pull/` (the pull request's files, components and stack),
`ask.json` (the prompts and replies behold's pane plays) and `about.json`.
No scenario replaces or destroys anything.

- `atmos-choudoufu-edit`: network's `http_proxy_port` goes from 8080 to 8090
  and it gains `admin_port` 9000. app adds `admin_listener_port` and edge
  `admin_upstream`. 3 to add, 3 to change, 0 to destroy, every value known at
  plan.
- `atmos-choudoufu-create`: network adds `aws_subnet.subnet_b` (10.0.2.0/24)
  with outputs `subnet_b_id` and `subnet_b_cidr`. app adds
  `aws_network_interface.worker` in that subnet, reading `subnet_b_id`; edge's
  allowlist gains the new range. 2 to add, 1 to change, 0 to destroy. One value
  is unknown at plan: subnet b's id.

`stack/demo.sh` applies the base with `atmos terraform apply` in the demo image,
outside the workflow, and each reset applies it again.
