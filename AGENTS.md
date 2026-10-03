# For agents

The [status page](https://intentius.io/terragucci/status/) is authoritative over anything written in the present tense, this file included.

- `just check` is CI's check job. Run it before proposing a change.
- Workflows are declared in `ci/` and `pages/`. Edit the TypeScript and run `just ci`. Never edit `.github/workflows/*.yml` by hand; `just ci-check` fails on it.
- Pins shared by both workflows live in `workflows/shared.ts`.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass, and `just site` must build.
- The kit's lifecycle Ops are not implemented. The design is chant#3341; do not describe planned stages as available.
- Commits carry no AI attribution lines.
