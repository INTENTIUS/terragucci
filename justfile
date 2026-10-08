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
    npx chant lint publish
    npx chant lint images
    npx chant lint capture
    npx chant lint nightly
    npx chant lint observability
    bash -n stack/smoke.sh
    node scripts/check-smoke.mjs

[doc("Run the unit tests.")]
test:
    npx vitest run --passWithNoTests

[doc("Score the docs with the sentences prose linter.")]
lint-docs strictness="2" limit="8":
    node scripts/lint-docs.mjs {{strictness}} {{limit}}
    node scripts/lint-config-docs.mjs

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
    npx chant build publish -o .github/workflows/publish.yml --format yaml
    just render-observability
    just render-images
    just render-front-door

[doc("Render the stack's collector and Prometheus configs from observability/, and the dashboards, rules and Grafana datasources, into stack/observability/.")]
render-observability:
    npx chant build observability --lexicon-output otel=stack/observability/collector.yaml --lexicon-output prometheus=stack/observability/prometheus.yml --format yaml
    npx tsx scripts/render-dashboards.ts
    @echo "  ✓ stack/observability/ rendered"

[doc("Render the reports front door's CloudFormation template from front-door/ into the site's downloads.")]
render-front-door:
    npx chant build front-door -o docs-site/public/reports-front-door.json --format json >/dev/null
    @echo "  ✓ docs-site/public/reports-front-door.json rendered"

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
    for pair in "ci:.github/workflows/ci.yml" "pages:.github/workflows/pages.yml" "capture:.github/workflows/capture.yml" "nightly:.github/workflows/nightly.yml" "image-ci:.github/workflows/images.yml" "publish:.github/workflows/publish.yml"; do
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
    pout="$out.prometheus"
    npx chant build observability --lexicon-output "otel=$out" --lexicon-output "prometheus=$pout" --format yaml >/dev/null
    if diff -u stack/observability/collector.yaml "$out"; then
      echo "  ✓ stack/observability/collector.yaml matches observability/collector.ts"
    else
      echo "  stack/observability/collector.yaml is not what observability/collector.ts renders. Run 'just ci' and commit the result."
      rc=1
    fi
    if diff -u stack/observability/prometheus.yml "$pout"; then
      echo "  ✓ stack/observability/prometheus.yml matches observability/prometheus.ts"
    else
      echo "  stack/observability/prometheus.yml is not what observability/prometheus.ts renders. Run 'just ci' and commit the result."
      rc=1
    fi
    # The reports front door's template, which the site offers for download.
    npx chant build front-door -o "$out" --format json >/dev/null
    if diff -u docs-site/public/reports-front-door.json "$out"; then
      echo "  ✓ docs-site/public/reports-front-door.json matches front-door/stack.ts"
    else
      echo "  docs-site/public/reports-front-door.json is not what front-door/stack.ts renders. Run 'just ci' and commit the result."
      rc=1
    fi
    # The dashboards, rules and Grafana datasources the stack's Grafana and Prometheus read.
    npx tsx scripts/render-dashboards.ts --check || rc=1
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

[doc("Serve the docs with hot reload and open them in the browser, at /terragucci/ as on Pages.")]
docs:
    cd docs-site && npm install && npm run dev -- --open

[doc("Build the docs the way CI does, then serve that build and open it: the site as Pages serves it.")]
docs-preview: site
    cd docs-site && npm run preview -- --open

# ── local validation ───────────────────────────────────────────────────────
# A real forge, a real runner and floci on one Docker network; see
# stack/README.md. Each target skips with a message when Docker is not there.

[doc("Bring up a profile of the validation stack (aws, forgejo, github, gitlab, fountain).")]
stack-up profile="forgejo":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available, so the validation stack cannot start."; exit 0
    fi
    stack/bootstrap.sh {{profile}}

[doc("Bring up the stack profiles a terragucci config needs: floci and its forges.")]
stack-for config:
    #!/usr/bin/env bash
    set -euo pipefail
    profiles="$(node_modules/.bin/terragucci profiles --config {{config}})"
    echo "{{config}} needs: $profiles"
    for p in $profiles; do
      case "$p" in
        aws) ;;
        forgejo|github|gitlab|fountain) stack/bootstrap.sh "$p" ;;
        *) echo "  no stack profile is called $p; skipping it" ;;
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
# profile against floci, stack/example-gitlab.sh on the gitlab profile.
# example-terragrunt/ is the same shop as 15 Terragrunt units, run by
# stack/example-terragrunt.sh. stack/smoke.sh holds one claim per feature.

[doc("Run every claim of one forge plain and under BREAK=1 on a running profile; fails when one is not as expected.")]
validate-forge forge:
    stack/validation.sh run {{forge}}

[doc("Boot each forge in turn, run its claims plain and broken, and write the record the validation page shows.")]
validation-record *forges:
    stack/validation.sh record docs-site/src/data/validation.json {{forges}}

[doc("The example: up [--fresh], verify, change <scenario>, reset, down.")]
example *args="up":
    stack/example.sh {{args}}

[doc("The example on the stack's GitLab: up [--fresh], verify, change <scenario>, merge <scenario>, approve [wave-N], logs, reset, shot <url> <out.png> [light|dark], down.")]
example-gitlab *args="up":
    stack/example-gitlab.sh {{args}}

[doc("The Terragrunt example: up, verify, change <scenario>, reset.")]
example-terragrunt *args="up":
    stack/example-terragrunt.sh {{args}}

[doc("The GitHub sandbox (INTENTIUS/terragucci-sandbox), plan-only, no stack: up [--fresh], change <scenario>, merge <scenario>, approve [wave-N] [--hold], plan-comment [scenario], drift, capture, reset, shot <view>|all|list, minutes.")]
sandbox *args:
    stack/sandbox-github.sh {{args}}

[doc("Send a plan, a drift run and a waiting wave of the example to the observability profile, and print where the dashboards show them.")]
see-runs:
    stack/see-runs.sh

[doc("Run every smoke claim, or one. BREAK=1 breaks the property and the claim must print caught.")]
smoke claim="":
    stack/smoke.sh {{claim}}

[doc("Run every claim plain and under BREAK=1, and write the record the status page shows.")]
smoke-record:
    stack/smoke.sh --record docs-site/src/data/smoke.json

[doc("The real-AWS pilot: list, then delete, every bucket (with its objects), queue and table whose name starts with the run prefix. --list only lists; --all takes every tgsmoke- prefix.")]
smoke-aws-cleanup *args:
    stack/smoke-aws.sh cleanup {{args}}

[doc("The real-AWS pilot: a measured run's AWS requests by service and operation, from the provider's debug log (default: the last SMOKE_AWS_MEASURE=1 run).")]
smoke-aws-count *args:
    stack/smoke-aws.sh count {{args}}

[doc("Remove the stack's job cache volume (terragucci-job-cache: the OpenTofu binary and every provider version it fetched). The next stack-up makes it again. Stop the stack first: Docker refuses while a container mounts it.")]
job-cache-prune:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "SKIP: Docker is not available."; exit 0
    fi
    if ! docker volume inspect terragucci-job-cache >/dev/null 2>&1; then
      echo "terragucci-job-cache does not exist"; exit 0
    fi
    docker volume rm terragucci-job-cache
    echo "  ✓ terragucci-job-cache removed"

[doc("Run the tutorial's steps against the example and record their output and screenshots.")]
tutorial-capture:
    stack/tutorial-capture.sh

[doc("Capture tutorial steps on demand: `just capture <step>...`, `just capture --reuse <step>` on the running example, `just capture --list`.")]
capture *args:
    stack/tutorial-capture.sh {{args}}

[doc("Build the terragucci CLI into one bundled file, as a release does.")]
build-cli:
    node scripts/build-cli.mjs

[doc("Build the four CI images for one platform (default: this machine's) into the local Docker daemon.")]
images platform="":
    just build-cli
    npx tsx scripts/images.ts build {{ if platform == "" { "" } else { "--platform " + platform } }}

[doc("Run each CI image's tools and hold each image to its size budget in images/budget.json.")]
images-check platform="":
    npx tsx scripts/images.ts check {{ if platform == "" { "" } else { "--platform " + platform } }}

[doc("Build terragucci on a local chant: pack chant from <chant-dir> (default: a worktree at chant origin/main), install it with --no-save, rebuild the bundle and images. --reset goes back to the pin. CHANT_LOCAL_IMAGES=0 skips the images.")]
chant-local *args:
    scripts/chant-local.sh {{args}}

[doc("Build the opt-in decision service image, terragucci-decide (Laya on CPU), into the local Docker daemon. Not one of the CI images.")]
decide-image platform="":
    npx tsx scripts/images.ts build-decide {{ if platform == "" { "" } else { "--platform " + platform } }}

[doc("Rewrite images/decide/requirements.txt from the pins in DECIDE_IMAGE: resolve pip, torch (CPU) and laya for linux x86_64 and aarch64 with pip's dry-run report and keep every wheel's sha256. Needs python3 with pip and network access.")]
decide-requirements:
    npx tsx scripts/decide-requirements.ts

[doc("The decision service in the stack: up (builds the image if missing), ask (the three uses' questions, on CPU), down.")]
decide *args="up":
    stack/decide.sh {{args}}

[doc("Rebuild both examples' changes/*.patch from the examples as committed.")]
example-patches: build-cli
    python3 stack/example-patches.py
