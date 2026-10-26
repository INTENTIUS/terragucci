# The choudoufu compose demo's estate

The tree for the prompt-driven demo on choudoufu: `example-demo-compose`'s
three roots as choudoufu estates, `cc-network`, `cc-app` and `cc-edge`. Each
root's `live` block names its estate and one record store,
`demo-choudoufu-compose-records`, a bucket of this demo's own. There is no
backend and no state file: each resource has one record, written only if it is
unchanged since it was read, so nothing is ever left locked. `terragucci.yml`
turns on `waves.compose`.

```
network  <-  app  <-  edge
```

app reads network's recorded outputs through `data.terraform_estate_outputs`,
and edge reads app's.

The base is a running estate. network holds `aws_vpc.main`, `aws_subnet.subnet_a`
(10.0.1.0/24), the `http_proxy_port` terraform_data and the outputs `vpc_id` and
`subnet_a_id`. app holds `aws_security_group.web`, `aws_network_interface.web`
(in subnet a, read from network's outputs) and the `listener_port`
terraform_data, ten below the proxy port. edge holds `terraform_data.allowlist`
(input `["10.0.1.0/24"]`) and the `upstream` terraform_data. Every scenario's
pull request starts from it, so each of these draws as unchanged.

Every value that stands in for a setting is a `terraform_data` named for what it
is, kept as a record in the store and created in no cloud, so it applies at
once. The only resources that reach floci are the `aws_vpc`, the subnets, the
security group and the network interfaces, none of which boots anything. Each is
identified by its own id, assigned when it is created, never by attributes read
from another estate (choudoufu refused an `aws_route_table_association` for
that). No scenario destroys or replaces a resource, so `gate: on-destructive`
holds nothing for them.

Every scenario applies as one composed run through choudoufu's composed root:
`.chant-compose/` holds one `module` call per estate and nothing else, and
choudoufu plans and applies it once. Each resource's record goes to its own
estate in the one record store, and a read of another estate in the run
resolves inside the run, so an id the apply creates reaches the estate that
reads it. Each estate's role comes from the provider blocks in its own
directory.

## The scenarios

Each has `about.json` for older readers, `pull/` (the pull request) and
`ask.json`, the prompts and replies behold's pane plays
(`example-demo-compose/README.md` says how it reads). Every `light` address
names a resource that exists once the scenario's pull is applied. There is no
failure act; failures are a separate demo.

An ask's `pull-request` step is a list: the person's prompt with a reply and a
`diff` (at most 5 short lines), then a status beat. `{pull}` in any string of
`ask.json` is filled by `stack/demo.sh` with `#<number>` of the pull request;
other `{...}` tokens are behold's. The `diff` lines count as reply characters in
`ask_secs`.

- `choudoufu-compose-edit`: network's proxy port goes from 8080 to 8090 and it
  gains an `admin_port` of 9000. app adds an `admin_listener_port`, and edge an
  `admin_upstream`. The plan is 3 to add, 3 to change and 0 to destroy, and
  every value is known at plan.
- `choudoufu-compose-create`: one resource is added to the running estate.
  network adds `aws_subnet.subnet_b` (10.0.2.0/24) and outputs `subnet_b_id`
  (unknown at plan) and `subnet_b_cidr` (a local, known at plan). app adds
  `aws_network_interface.worker` in that subnet, reading `subnet_b_id` through
  its own data source so nothing else in app depends on it. edge's `allowlist`
  becomes `["10.0.1.0/24", "10.0.2.0/24"]`, known at plan. The plan is 2 to
  add, 1 to change and 0 to destroy. Exactly one value is known after apply:
  subnet b's id, at its source and in the worker's `subnet_id`.

## The base and the reset

The driver writes `applied` once the job that runs the composed apply
(`apply-wave-1`) has succeeded, not when waves 2 and 3 and `tips` end, which
have nothing to apply. The reset still waits for the whole run.

`stack/demo.sh` applies the base with choudoufu in the demo image, outside the
pipeline (`estates_apply`), and pushes it with `[skip ci]`. Each reset applies
the base tree again the same way, which deletes what the cycle added and puts
every tag back.

Every type here is one choudoufu marks in its create call. A Route 53 hosted
zone takes its tags only after it is created, and a record set takes none, so
neither can carry choudoufu's ownership marker and neither is used.
