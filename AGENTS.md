# For agents

The [status page](https://intentius.io/terragucci/status/) is authoritative over anything written in the present tense, this file included.

- `just check` is CI's check job. Run it before proposing a change.
- Workflows are declared in `ci/` and `pages/`. Edit the TypeScript and run `just ci`. Never edit `.github/workflows/*.yml` by hand; `just ci-check` fails on it.
- Pins shared by both workflows live in `workflows/shared.ts`.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass, and `just site` must build.
- The docs describe the target product, in the present tense. `docs-site/src/content/docs/status.md` is the only place that records what is built, and nothing else links to it except the sidebar. Design: chant#3341, debut: chant#3343.
- Commits carry no AI attribution lines.
