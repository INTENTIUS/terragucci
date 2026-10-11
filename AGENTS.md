# For agents

- `just check` is CI's check job. Run it before proposing a change: a pull request runs only `diff-guard` (`just diff-guard`), and ci.yml runs on main's pushes.
- A release tags the commit `just release-preflight <version>` names, the newest green one (`chant ci last-green`), never a hand-picked commit.
- Workflows are declared in `ci/` and `pages/`. Edit the TypeScript and run `just ci`. Never edit `.github/workflows/*.yml` by hand; `just ci-check` fails on it.
- Pins shared by both workflows live in `workflows/shared.ts`.
- The site is for customers. Notes about this repo stay out of it, and so do issue links and build details such as capture dates. Contributor material goes in CONTRIBUTING.md.
- Docs live in `docs-site/src/content/docs/`. `just lint-docs` must pass, and `just site` must build.
- Every page describes what works today and is true as written. Nothing a user reads (the site, `llms.txt`, a CLI message) says a feature is coming. A feature that does not work stays out of the docs and out of config validation until it does.
- The docs never mention Temporal.
- Agents run no test bench. The recipes `claims`, `claims-affected`, `binary-claims`, `gitlab-claims`, `smoke-record`, `validate`, `validate-forge`, `validation-record`, `tutorial-capture`, `capture`, `sandbox`, `gitlab-lab up`, `example-gitlab`, `scale` and `coverage-fill`, and the `stack/` scripts behind them, stop with exit 3 unless a person types `run` in their own terminal (`stack/human-gate.sh`). Do not set `TG_HUMAN_RUN` or write the grant file; there is no other way in.
- A person can grant runs instead with `just grant <claim>...` (or `capture`). An agent then runs exactly `just claims <the granted names>` or `just tutorial-capture`. Each claim gets the runs granted, 2 by default: one run, and one more after a fix. When a run fails twice or its runs are spent, stop and report the failing step and log line. A granted run stops itself after 5 minutes with nothing written, or when the grant expires, and says where it went quiet. `just grant --show` lists what is left.
- A change merges on CI and lint-docs. A new claim is written but not run; the pull request names it. If a run seems needed, stop and ask, naming the stack it would hold.
- The capture and scale workflows are disabled, and there is no nightly workflow. Only CI's checks run on their own; no claim runs in CI.
- For a person: `just claims-affected` runs the claims a change can affect and records their rows in `smoke.json`. `just coverage-fill` fills the validation page's gaps a source at a time. GitLab runs on its own lab: boot it with `just gitlab-lab up` only on a quiet host, and stop it with `just gitlab-lab down` when done.
- A new file under `packages/terragucci/src/` gets a line in `stack/claim-paths.txt` naming the claims it can affect.
- The example lives in `example/`. An edit there needs `just example-patches`. The tutorial's captures then go stale; `just tutorial-check` lists them and passes. A person recaptures by hand with `just tutorial-capture`.
- A tutorial page or a guide leaves `draft: true` only when every claim in its `claims:` passes in `docs-site/src/data/smoke.json`, and each claim runs the steps the page gives the reader. A guide carries a `claims:` line; `claims: []` says no recorded claim backs it.
- Commits carry no AI attribution lines.
