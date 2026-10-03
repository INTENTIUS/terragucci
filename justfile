# terragucci. The kit's lifecycle Ops are not implemented yet; see the status page.

default:
    @just --list

# ── checks ─────────────────────────────────────────────────────────────────

[doc("Typecheck the declarations.")]
typecheck:
    npx tsc --noEmit -p tsconfig.json

[doc("Lint the declarations with chant.")]
lint:
    npx chant lint ci
    npx chant lint pages
    npx chant lint capture

[doc("Run the unit tests.")]
test:
    npx vitest run --passWithNoTests

[doc("Score the docs with the sentences prose linter.")]
lint-docs strictness="2" limit="8":
    node scripts/lint-docs.mjs {{strictness}} {{limit}}

[doc("Fail when a published tutorial page shows a claim that does not pass, or a capture that is missing or stale.")]
tutorial-check:
    node scripts/tutorial-check.mjs

[doc("Typecheck, lint, test, lint the docs and check the tutorial. What CI runs.")]
check: typecheck lint test lint-docs tutorial-check

# ── this repo's workflows ──────────────────────────────────────────────────

# One directory per workflow, because `chant build <dir>` writes one file.
[doc("Render the GitHub workflows from their TypeScript declarations.")]
ci:
    npx chant build ci -o .github/workflows/ci.yml --format yaml
    npx chant build pages -o .github/workflows/pages.yml --format yaml
    npx chant build capture -o .github/workflows/capture.yml --format yaml

[doc("Fail if any committed workflow has drifted from its declaration.")]
ci-check:
    #!/usr/bin/env bash
    # GitHub reads the YAML, so the rendered file is committed. This gate keeps
    # the TypeScript the source of truth: a hand edit to the YAML fails here.
    set -euo pipefail
    out="$(mktemp -t terragucci-ci-XXXX.yml)"
    trap 'rm -f "$out"' EXIT
    rc=0
    for pair in "ci:.github/workflows/ci.yml" "pages:.github/workflows/pages.yml" "capture:.github/workflows/capture.yml"; do
      src="${pair%%:*}"; committed="${pair#*:}"
      npx chant build "$src" -o "$out" --format yaml >/dev/null
      if diff -u "$committed" "$out"; then
        echo "  ✓ $committed matches $src/pipeline.ts"
      else
        echo "  $committed is not what $src/pipeline.ts renders. Run 'just ci' and commit the result."
        rc=1
      fi
    done
    exit $rc

# ── the published site ─────────────────────────────────────────────────────

[doc("Build the docs site, the same way CI does.")]
site:
    #!/usr/bin/env bash
    set -euo pipefail
    cd docs-site
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
    npm run build
    echo "  ✓ docs-site/dist built"

[doc("Serve the docs site locally with hot reload.")]
site-dev:
    cd docs-site && npm install && npm run dev

# ── local validation ───────────────────────────────────────────────────────
# A real forge, a real runner and floci on one Docker network; see
# stack/README.md. Each target skips with a message when Docker is not there.

[doc("Bring up a profile of the validation stack (aws, forgejo; the rest are declared, not validated).")]
stack-up profile="forgejo":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available, so the validation stack cannot start."; exit 0
    fi
    stack/bootstrap.sh {{profile}}

[doc("Remove every container, network and volume the validation stack started.")]
stack-down:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available, so there is no stack to remove."; exit 0
    fi
    stack/down.sh

[doc("Run one claim against a running profile. BREAK=1 breaks the property and must fail.")]
validate forge="forgejo" claim="apply":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available, so no claim can run."; exit 0
    fi
    stack/validate.sh {{forge}} {{claim}}

# ── the example and its smoke claims ───────────────────────────────────────
# example/ is the shop's 15 roots; stack/example.sh runs them on the forgejo
# profile against floci. stack/smoke.sh holds one claim per feature.

[doc("The example: up [--fresh], verify, change <scenario>, reset, down.")]
example cmd="up" *args:
    stack/example.sh {{cmd}} {{args}}

[doc("Run every smoke claim, or one. BREAK=1 breaks the property and the claim must print caught.")]
smoke claim="":
    stack/smoke.sh {{claim}}

[doc("Run every claim plain and under BREAK=1, and write the record the status page shows.")]
smoke-record:
    stack/smoke.sh --record docs-site/src/data/smoke.json

[doc("Run the tutorial's steps against the example and record their output and screenshots.")]
tutorial-capture:
    stack/tutorial-capture.sh

[doc("Rebuild example/changes/*.patch from the example as committed.")]
example-patches:
    python3 stack/example-patches.py
