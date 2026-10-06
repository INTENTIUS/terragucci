/**
 * Publishes @intentius/terragucci to npm with trusted publishing: npm trusts
 * this workflow's OIDC token, so no NPM_TOKEN exists, and the package carries
 * a provenance statement naming the run that built it.
 *
 * `just ci` renders this into .github/workflows/publish.yml. npm's trusted
 * publisher is configured for that filename, so the file keeps its name.
 *
 * It runs on a `v*` tag and by hand (a ref, main by default). It skips a
 * version npm already has, and refuses a version whose CI images are not all
 * recorded by digest in packages/terragucci/src/image-digests.json, so a
 * bundle never ships that pins its images by tag alone. On a tag, the images
 * workflow pushes the images at the same time, so the digests are usually
 * recorded later and this run refuses; the release then dispatches it on main
 * once the digests are committed. CONTRIBUTING.md has the order.
 */

import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, NPM_VERSION, NPM_TRUSTED_PUBLISHING_MIN, installJust } from "../workflows/shared";

const PACKAGE = "@intentius/terragucci";

export const workflow = new Workflow({
  name: "publish",
  on: {
    push: { tags: ["v*"] },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "The branch, tag or commit to publish from",
          required: true,
          default: "main",
          type: "string",
        },
      },
    },
  },
  // id-token: write lets the job ask GitHub for the OIDC token npm trusts.
  permissions: { contents: "read", "id-token": "write" },
  concurrency: { group: "publish", "cancel-in-progress": false },
});

export const publish = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 20,
  steps: [
    // No npm cache: a release builds from what npm ci resolves now, not from a cache another run wrote.
    Checkout({ ref: "${{ inputs.ref || github.ref }}", defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({ nodeVersion: NODE_VERSION, registryUrl: "https://registry.npmjs.org", defaults: { step: { uses: SETUP_NODE } } }).step,
    new Step({
      name: `Use npm ${NPM_TRUSTED_PUBLISHING_MIN} or later, which trusted publishing needs`,
      run: [
        "set -eu",
        'have="$(npm --version)"',
        `if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then`,
        `  echo "npm $have is older than ${NPM_TRUSTED_PUBLISHING_MIN}; installing npm ${NPM_VERSION}"`,
        `  npm install -g npm@${NPM_VERSION}`,
        "fi",
        "npm --version",
      ].join("\n"),
    }),
    new Step({ name: "Install dependencies", run: "npm ci" }),
    installJust(),
    new Step({ name: "Build the bundle", run: "just build-cli" }),
    new Step({ name: "Hold the bundle to its shape", run: "just bundle-check" }),
    new Step({
      name: "Skip a version npm already has",
      id: "version",
      run: [
        "set -eu",
        "version=\"$(node -p 'require(\"./packages/terragucci/package.json\").version')\"",
        'echo "version=$version" >> "$GITHUB_OUTPUT"',
        // A tag names the version it releases.
        'if [ "$GITHUB_EVENT_NAME" = push ] && [ "$GITHUB_REF_NAME" != "v$version" ]; then',
        '  echo "::error::tag $GITHUB_REF_NAME does not match packages/terragucci/package.json version $version"',
        "  exit 1",
        "fi",
        // npm view prints the version when npm has it, and fails with E404 when
        // it has not (or has no such package yet); any other failure stops here.
        `if out="$(npm view "${PACKAGE}@$version" version 2>&1)"; then`,
        '  if [ -n "$out" ]; then',
        `    echo "::notice::${PACKAGE}@$version is already on npm; nothing to publish"`,
        '    echo "skip=true" >> "$GITHUB_OUTPUT"',
        "    exit 0",
        "  fi",
        'elif ! printf "%s" "$out" | grep -q E404; then',
        '  echo "$out"',
        "  exit 1",
        "fi",
        `echo "${PACKAGE}@$version is not on npm yet"`,
        'echo "skip=false" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    }),
    new Step({
      name: "Refuse a bundle whose images are not pinned by digest",
      if: "steps.version.outputs.skip != 'true'",
      run: [
        "set -eu",
        // The four references this version's bundle names, from the same code the images workflow pushes.
        'refs="$(npx tsx scripts/images.ts tags)"',
        "missing=0",
        "while read -r name ref; do",
        "  digest=\"$(node -e 'const t = require(\"./packages/terragucci/src/image-digests.json\"); process.stdout.write(t[process.argv[1]] ?? \"\")' \"$ref\")\"",
        '  if ! printf "%s" "$digest" | grep -Eq "^sha256:[0-9a-f]{64}$"; then',
        '    echo "::error::$ref has no digest in packages/terragucci/src/image-digests.json"',
        "    missing=1",
        '  elif ! grep -q "$digest" packages/terragucci/dist/terragucci.mjs; then',
        '    echo "::error::the bundle does not carry the digest of $ref"',
        "    missing=1",
        "  else",
        '    echo "$name $ref@$digest"',
        "  fi",
        'done <<< "$refs"',
        'if [ "$missing" -ne 0 ]; then',
        '  echo "Record each image\'s digest (the images workflow prints them), merge that to main, and publish from main."',
        "  exit 1",
        "fi",
      ].join("\n"),
    }),
    new Step({
      name: "Publish with provenance",
      if: "steps.version.outputs.skip != 'true'",
      "working-directory": "packages/terragucci",
      run: "npm publish --provenance --access public",
    }),
  ],
});
