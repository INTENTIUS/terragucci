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
and edge reads app's. The base: network's `http_proxy_port` is 8080, app's
listener is ten below it, and edge's upstream URL is built from app's listener
port. network also holds an `aws_vpc`.

Every value that stands in for a setting is a `terraform_data` named for what it
is (`http_proxy_port` with `input = 8080`, `listener_port`, `upstream`), kept
as a record in the store and created in no cloud, so it applies at once. The
outputs read its `input`, which is known at plan. The only resources that reach
floci are network's `aws_vpc` and `aws_subnet` and the four app puts in the
subnet, none of which boots anything. No scenario destroys or replaces a
resource, so `gate: on-destructive` holds nothing for them.

Every scenario applies as one composed run through choudoufu's composed root:
`.terragucci-compose/` holds one `module` call per estate and nothing else, and
choudoufu plans and applies it once. Each resource's record goes to its own
estate in the one record store, and a read of another estate in the run
resolves inside the run, so an id the apply creates reaches the estate that
reads it. Each estate's role comes from the provider blocks in its own
directory.

## The scenarios

Each has `about.json` for older readers, `pull/` (the pull request) and `ask.json`, the prompts and replies behold's pane
plays (`example-demo-compose/README.md` says how it reads). Every `light`
address names a resource that exists once the scenario's pull is applied.
There is no failure act; failures are a separate demo.

- `choudoufu-compose-edit`: network's proxy port goes from 8080 to 8090 and it
  gains an `admin_port` of 9000. app adds an `admin_listener_port`, and edge an
  `admin_upstream`. The plan is 3 to add, 3 to change and 0 to destroy.
- `choudoufu-compose-create`: network creates an `aws_subnet` named `subnet` in
  that VPC and outputs `subnet_id`, which exists only after apply. app puts an
  `aws_security_group`, `aws_route_table`, `aws_network_interface` and
  `aws_route_table_association` in it, and edge's `dns_upstream` reads app's
  `dns_name`, which is built from the id. The plan is 6 to add, 0 to change and
  0 to destroy.

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
