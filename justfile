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

[doc("Run the unit tests.")]
test:
    npx vitest run --passWithNoTests

[doc("Score the docs with the sentences prose linter.")]
lint-docs strictness="2" limit="8":
    node scripts/lint-docs.mjs {{strictness}} {{limit}}

[doc("Typecheck, lint, test and lint the docs. What CI runs.")]
check: typecheck lint test lint-docs

# ── this repo's workflows ──────────────────────────────────────────────────

# One directory per workflow, because `chant build <dir>` writes one file.
[doc("Render the GitHub workflows from their TypeScript declarations.")]
ci:
    npx chant build ci -o .github/workflows/ci.yml --format yaml
    npx chant build pages -o .github/workflows/pages.yml --format yaml

[doc("Fail if any committed workflow has drifted from its declaration.")]
ci-check:
    #!/usr/bin/env bash
    # GitHub reads the YAML, so the rendered file is committed. This gate keeps
    # the TypeScript the source of truth: a hand edit to the YAML fails here.
    set -euo pipefail
    out="$(mktemp -t terragucci-ci-XXXX.yml)"
    trap 'rm -f "$out"' EXIT
    rc=0
    for pair in "ci:.github/workflows/ci.yml" "pages:.github/workflows/pages.yml"; do
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
