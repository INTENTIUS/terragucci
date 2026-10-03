# For agents

The [status page](https://intentius.io/terragucci/status/) is authoritative over anything written in the present tense, this file included.

- `just check` is CI's check job. Run it before proposing a change.
- Workflows are declared in `ci/` and `pages/`. Edit the TypeScript and run `just ci`. Never edit `.github/workflows/*.yml` by hand; `just ci-check` fails on it.
- Pins shared by both workflows live in `workflows/shared.ts`.
- The site is for customers. Issue links, notes about this repo and build details (capture dates, commits, tool versions) stay out of it. Contributor material goes in CONTRIBUTING.md.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass, and `just site` must build.
- The docs describe the target product, in the present tense. `docs-site/src/content/docs/status.md` is the only place that records what is built, and nothing else links to it except the sidebar. Design: chant#3341, debut: chant#3343.
- The example lives in `example/`. An edit there needs `just example-patches` and then `just tutorial-capture`, which needs Docker. Without them `just tutorial-check` fails on stale captures.
- A tutorial page leaves `draft: true` only when every claim in its `claims:` passes in `docs-site/src/data/smoke.json`.
- Commits carry no AI attribution lines.
