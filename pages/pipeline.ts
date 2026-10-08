/**
 * The published site, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/pages.yml, and `just ci-check`
 * gates it the same way as ci.yml. It is its own build root because
 * `chant build <dir>` writes one file per directory.
 *
 * docs-site/ is Astro and Starlight, published at intentius.io/terragucci, the
 * same stack and URL shape as fountain-ops and loomster. CI builds it with
 * `just site`, the command a person runs to preview it.
 */

import { Workflow, Job, Step, SetupNode } from "@intentius/chant-lexicon-github";
import { CHECKOUT, SETUP_NODE, NODE_VERSION, installJust } from "../workflows/shared";

/** These three run with Pages and OIDC scopes, so they are pinned by SHA too. */
const CONFIGURE_PAGES = "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d"; // v6.0.0
const UPLOAD_ARTIFACT = "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9"; // v5.0.0
const DEPLOY_PAGES = "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346"; // v5.0.1

export const workflow = new Workflow({
  name: "pages",
  on: {
    push: { branches: ["main"] },
    workflow_dispatch: {},
  },
  // Read-only by default; the write scopes live on the deploy job alone.
  permissions: { contents: "read" },
  // One publish at a time, never cancelled midway.
  concurrency: { group: "pages", "cancel-in-progress": false },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  permissions: { contents: "read", pages: "read" },
  steps: [
    // The site's videos are in Git LFS; the build needs the files, not their pointers.
    new Step({ name: "Checkout", uses: CHECKOUT, with: { lfs: true } }),
    SetupNode({ nodeVersion: NODE_VERSION, cache: "npm", defaults: { step: { uses: SETUP_NODE } } }).step,
    new Step({ name: "Configure Pages", uses: CONFIGURE_PAGES }),
    installJust(),
    new Step({ name: "Build the site", run: "just site" }),
    new Step({
      name: "Upload the artifact",
      uses: UPLOAD_ARTIFACT,
      with: { path: "docs-site/dist" },
    }),
  ],
});

export const deploy = new Job({
  needs: "build",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  // The only job that publishes.
  permissions: { contents: "read", pages: "write", "id-token": "write" },
  environment: { name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}" },
  steps: [
    new Step({
      id: "deployment",
      name: "Deploy to GitHub Pages",
      uses: DEPLOY_PAGES,
    }),
  ],
});
