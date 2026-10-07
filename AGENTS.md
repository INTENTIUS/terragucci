# For agents

- `just check` is CI's check job. Run it before proposing a change.
- Workflows are declared in `ci/` and `pages/`. Edit the TypeScript and run `just ci`. Never edit `.github/workflows/*.yml` by hand; `just ci-check` fails on it.
- Pins shared by both workflows live in `workflows/shared.ts`.
- The site is for customers. Issue links, notes about this repo and build details (capture dates, commits, tool versions) stay out of it. Contributor material goes in CONTRIBUTING.md.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass, and `just site` must build.
- Every page describes what works today, in the present tense, and is true as written. No page, prompt, `llms.txt` line, CLI message or generated file says a feature is being built, planned, in development or not built yet. A feature that does not work is left out of the docs and out of config validation until it does.
- The docs never mention Temporal.
- The example lives in `example/`. An edit there needs `just example-patches` and then `just tutorial-capture`, which needs Docker. Without them `just tutorial-check` fails on stale captures.
- A tutorial page or a guide leaves `draft: true` only when every claim in its `claims:` passes in `docs-site/src/data/smoke.json`, and each claim runs the steps the page gives the reader. A guide carries a `claims:` line; `claims: []` says no recorded claim backs it.
- Commits carry no AI attribution lines.
