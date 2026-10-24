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
port. `release` on network is a queue whose name changes with each cycle: a new
name replaces it, which `gate: on-destructive` holds for an approval.

Every scenario applies as one composed run through choudoufu's composed root:
`.terragucci-compose/` holds one `module` call per estate and nothing else, and
choudoufu plans and applies it once. Each resource's record goes to its own
estate in the one record store, and a read of another estate in the run
resolves inside the run, so an id the apply creates reaches the estate that
reads it. Each estate's role comes from the provider blocks in its own
directory.

## The scenarios

Each has `about.json` for older readers, `pull/` (the pull request, with
`@CYCLE@` filled in) and `ask.json`, the prompts and replies behold's pane
plays (`example-demo-compose/README.md` says how it reads). Every `light`
address names a resource that exists once the scenario's pull is applied.
There is no failure act; failures are a separate demo.

- `choudoufu-compose-edit`: network's proxy port goes from 8080 to 8090 and it
  gains an `admin_port` of 9000. app adds an `admin_listener`, and edge an
  `admin_upstream`.
- `choudoufu-compose-create`: network creates a `subnet_queue` and outputs
  `subnet_id`, its ARN, which exists only after apply. app puts a
  `security_group_queue`, `route_table_queue`, `instance_queue` and
  `dns_record_queue` in it, and
  edge's `dns_upstream` reads app's `dns_name`, which is built from the id.

## The base and the reset

`stack/demo.sh` applies the base with choudoufu in the demo image, outside the
pipeline (`estates_apply`), and pushes it with `[skip ci]`. Each reset applies
the base tree again the same way, which deletes what the cycle added and puts
every tag back.

The stand-ins are SQS queues, and the names say so. The emulator's capability
record (`live/floci-capabilities.json` in choudoufu) does not prove `aws_subnet`,
`aws_route_table` or `aws_instance` can be created, and it lists `aws_lb` and
Route 53 hosted zones as unimplemented, so no resource here is named as a type
it is not.
