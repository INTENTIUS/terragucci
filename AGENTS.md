# For agents

Working in the INTENTIUS workspace, `../agents/shared.md` applies too. This file adds what is particular to terragucci.

- Local gate: `just check`. CI's `static` job runs `just check-unit` and `just lint-docs`; its three `test` jobs run `just test-shard <n>`. `diff-guard` runs by hand (`gh workflow run diff-guard.yml --ref <branch>`).
- Workflows are declared in `ci/` and `pages/`, with shared pins in `workflows/shared.ts`. Edit the TypeScript and run `just ci`; `just ci-check` fails on a hand edit.
- Binaries go through Git LFS; `just lfs-check` enforces it.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass and `just site` must build. No page mentions Temporal.
- Person-started recipes (exit 3 without a person typing `run`, via `stack/human-gate.sh`): `claims`, `claims-affected`, `binary-claims`, `gitlab-claims`, `smoke-record`, `validate`, `validate-forge`, `validation-record`, `tutorial-capture`, `capture`, `sandbox`, `gitlab-lab up`, `example-gitlab`, `scale`, `coverage-fill`, and the `stack/` scripts behind them. The override variable is `TG_HUMAN_RUN`; never set it. Claims are not part of making a change.
- The example lives in `example/`. An edit there needs `just example-patches`; `just tutorial-check` then lists the stale captures, and a person recaptures them.

Merging: no merge queue yet. Open the pull request with the local gate passing and stop; the orchestrator merges.
