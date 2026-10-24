# The compose demo's estate

The tree for the prompt-driven demo: three plain roots of `terraform_data`,
each with its own state in floci (`demo-terraform-state`, an s3 backend with
`use_lockfile`), and `waves.compose: true` in `terragucci.yml`.

```
network  <-  app  <-  edge
```

app reads network through `terraform_remote_state`, and edge reads app. The
base: network outputs `http_proxy_port` (8080), app's `listener` is ten below
it, and edge's `upstream` URL is built from app's listener port. `release` on
network is a marker: a new value replaces it, which `gate: on-destructive`
holds for an approval.

Every scenario applies as one composed run: one plan, one approval, one apply,
and each state written with what applied to it. A run that reads a value
unknown at plan time waits for an approval under this gate, and so does the
first scenario, through the `release` replacement.

## The scenarios

Each has `about.json` for older readers, `pull/` (the pull request, with
`@CYCLE@` filled in) and `ask.json`, the prompts and replies behold's pane
plays. `ask.json` maps a step name to one `ask` object, or to a list of them
for a step with two beats. A string `opening` or `closing` is for `demo.json`'s
top-level fields. Every `light` address names a resource that exists once the
scenario's pull is applied.

- `compose-edit`: network's proxy port goes from 8080 to 8090 and it gains an
  `admin_port` of 9000. app adds an `admin_listener` ten below it, and edge an
  `admin_upstream`. Every value is known at plan time.
- `compose-create`: network creates a `subnet` and outputs `subnet_id`, which
  exists only after apply. app puts a `security_group`, `route_table`,
  `instance` and `dns_record` in it, and edge's `dns_upstream` reads app's
  `dns_name`, which is built from the id. All three roots change.
- `compose-fail` (optional): app adds a `load_balancer` whose `postcondition`
  holds its address to the subnet's range. The address is wrong, and the check
  runs only at apply, after the load balancer is created, so edge is not
  applied. Nothing is rolled back. `fix/` is the one-line pull request that
  moves the address into range.

`compose-fail` needs the subnet and app's resources in place first, so
`scenarios/compose-fail/base/` holds the three roots as `compose-create` leaves
them. The driver applies it to main before the pull request opens, and the
reset forces main back to the plain base.
