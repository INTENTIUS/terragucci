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
    npx chant lint image-ci
    npx chant lint images
    npx chant lint capture
    npx chant lint nightly
    npx chant lint observability

[doc("Run the unit tests.")]
test:
    npx vitest run --passWithNoTests

[doc("Score the docs with the sentences prose linter.")]
lint-docs strictness="2" limit="8":
    node scripts/lint-docs.mjs {{strictness}} {{limit}}

[doc("Fail when a published tutorial page shows a claim that does not pass, or a capture that is missing or stale.")]
tutorial-check:
    node scripts/tutorial-check.mjs

[doc("Build the bundle and hold it to its shape: no dependencies, under budget, Node imports only.")]
bundle-check: build-cli
    node scripts/bundle-check.mjs

[doc("Typecheck, lint, test, lint the docs, check the tutorial and the bundle. What CI runs.")]
check: typecheck lint bundle-check test lint-docs tutorial-check

# ── this repo's workflows ──────────────────────────────────────────────────

# One directory per workflow, because `chant build <dir>` writes one file.
[doc("Render the GitHub workflows from their TypeScript declarations.")]
ci:
    npx chant build ci -o .github/workflows/ci.yml --format yaml
    npx chant build pages -o .github/workflows/pages.yml --format yaml
    npx chant build capture -o .github/workflows/capture.yml --format yaml
    npx chant build nightly -o .github/workflows/nightly.yml --format yaml
    npx chant build image-ci -o .github/workflows/images.yml --format yaml
    just render-observability
    just render-images

[doc("Render the stack's collector and Prometheus configs from observability/ into stack/observability/.")]
render-observability:
    npx chant build observability -o stack/observability/collector.yaml --format yaml
    npx tsx scripts/render-prometheus.ts > stack/observability/prometheus.yml
    @echo "  ✓ stack/observability/ rendered"

[doc("Render the CI images' Dockerfiles from images/images.ts into images/.")]
render-images:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$(mktemp -d -t terragucci-images-XXXX)"
    npx chant build images -o "$dir/compose.yml" --format yaml >/dev/null
    cp "$dir"/Dockerfile.* images/
    rm -rf "$dir"
    echo "  ✓ images/Dockerfile.* rendered"

[doc("Fail if any committed workflow, Dockerfile or stack config has drifted from its declaration.")]
ci-check:
    #!/usr/bin/env bash
    # GitHub reads the YAML, so the rendered file is committed. This gate keeps
    # the TypeScript the source of truth: a hand edit to the YAML fails here.
    set -euo pipefail
    out="$(mktemp -t terragucci-ci-XXXX.yml)"
    trap 'rm -f "$out"' EXIT
    rc=0
    for pair in "ci:.github/workflows/ci.yml" "pages:.github/workflows/pages.yml" "capture:.github/workflows/capture.yml" "nightly:.github/workflows/nightly.yml" "image-ci:.github/workflows/images.yml"; do
      src="${pair%%:*}"; committed="${pair#*:}"
      npx chant build "$src" -o "$out" --format yaml >/dev/null
      if diff -u "$committed" "$out"; then
        echo "  ✓ $committed matches $src/pipeline.ts"
      else
        echo "  $committed is not what $src/pipeline.ts renders. Run 'just ci' and commit the result."
        rc=1
      fi
    done
    # The Dockerfiles: the docker lexicon writes them beside its (empty) compose output.
    dir="$(mktemp -d -t terragucci-images-XXXX)"
    npx chant build images -o "$dir/compose.yml" --format yaml >/dev/null
    for f in "$dir"/Dockerfile.*; do
      name="$(basename "$f")"
      if diff -u "images/$name" "$f"; then
        echo "  ✓ images/$name matches images/images.ts"
      else
        echo "  images/$name is not what images/images.ts renders. Run 'just ci' and commit the result."
        rc=1
      fi
    done
    rm -rf "$dir"
    # The stack's collector and Prometheus configs, from observability/.
    npx chant build observability -o "$out" --format yaml >/dev/null
    if diff -u stack/observability/collector.yaml "$out"; then
      echo "  ✓ stack/observability/collector.yaml matches observability/collector.ts"
    else
      echo "  stack/observability/collector.yaml is not what observability/collector.ts renders. Run 'just ci' and commit the result."
      rc=1
    fi
    npx tsx scripts/render-prometheus.ts > "$out"
    if diff -u stack/observability/prometheus.yml "$out"; then
      echo "  ✓ stack/observability/prometheus.yml matches observability/prometheus.ts"
    else
      echo "  stack/observability/prometheus.yml is not what observability/prometheus.ts renders. Run 'just ci' and commit the result."
      rc=1
    fi
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

[doc("Bring up a profile of the validation stack (aws, forgejo, github, gitlab; fountain is declared, not validated).")]
stack-up profile="forgejo":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available, so the validation stack cannot start."; exit 0
    fi
    stack/bootstrap.sh {{profile}}

[doc("Bring up the stack profiles a terragucci config needs: floci, its forges, and fountain only if a project runs there.")]
stack-for config:
    #!/usr/bin/env bash
    set -euo pipefail
    profiles="$(node_modules/.bin/terragucci profiles --config {{config}})"
    echo "{{config}} needs: $profiles"
    for p in $profiles; do
      case "$p" in
        aws) ;;
        forgejo|github|gitlab) stack/bootstrap.sh "$p" ;;
        *) echo "  the $p profile is declared but not validated yet; skipping it (TERRAGUCCI_UNVALIDATED=1 stack/bootstrap.sh $p starts its containers)" ;;
      esac
    done
    case " $profiles " in *" forgejo "*|*" github "*|*" gitlab "*) ;; *) stack/bootstrap.sh aws ;; esac

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
# profile against floci. example-terragrunt/ is the same shop as 15 Terragrunt
# units, run by stack/example-terragrunt.sh. stack/smoke.sh holds one claim per feature.

[doc("Run every claim of one forge plain and under BREAK=1 on a running profile; fails when one is not as expected.")]
validate-forge forge:
    stack/validation.sh run {{forge}}

[doc("Boot each forge in turn, run its claims plain and broken, and write the record the validation page shows.")]
validation-record *forges:
    stack/validation.sh record docs-site/src/data/validation.json {{forges}}

[doc("The example: up [--fresh], verify, change <scenario>, reset, down.")]
example *args="up":
    stack/example.sh {{args}}

[doc("The Terragrunt example: up, verify, change <scenario>, reset.")]
example-terragrunt *args="up":
    stack/example-terragrunt.sh {{args}}

[doc("Run every smoke claim, or one. BREAK=1 breaks the property and the claim must print caught.")]
smoke claim="":
    stack/smoke.sh {{claim}}

[doc("Run every claim plain and under BREAK=1, and write the record the status page shows.")]
smoke-record:
    stack/smoke.sh --record docs-site/src/data/smoke.json

[doc("Run the tutorial's steps against the example and record their output and screenshots.")]
tutorial-capture:
    stack/tutorial-capture.sh

[doc("Build the terragucci CLI into one bundled file, as a release does.")]
build-cli:
    node scripts/build-cli.mjs

[doc("Build the three CI images for one platform (default: this machine's) into the local Docker daemon.")]
images platform="":
    just build-cli
    npx tsx scripts/images.ts build {{ if platform == "" { "" } else { "--platform " + platform } }}

[doc("Run each CI image's tools and hold each image to its size budget in images/budget.json.")]
images-check platform="":
    npx tsx scripts/images.ts check {{ if platform == "" { "" } else { "--platform " + platform } }}

[doc("Rebuild both examples' changes/*.patch from the examples as committed.")]
example-patches: build-cli
    python3 stack/example-patches.py
