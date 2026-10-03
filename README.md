# terragucci

A lifecycle kit for Terraform, OpenTofu and choudoufu. It is planned to plan each pull request and to apply only after an approval tied to that plan, with drift checks on a schedule. Your forge's CI is the first planned place to run it, and a fountain steward is the second.

None of the stages exist yet. The [status page](https://intentius.io/terragucci/status/) tracks what does, and [chant#3341](https://github.com/INTENTIUS/chant/issues/3341) holds the design.

Start with [What terragucci is](https://intentius.io/terragucci/getting-started/overview/), then [Which binary you run](https://intentius.io/terragucci/getting-started/binaries/) and [Where it runs](https://intentius.io/terragucci/reference/runtimes/).

## Working on this repo

```bash
npm install
just check      # the same checks CI runs
just ci         # render the workflows from ci/ and pages/
just site-dev   # serve the docs locally
```

## Licence

The licence is Apache 2.0, in [LICENSE](./LICENSE).
