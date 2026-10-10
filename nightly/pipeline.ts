/**
 * The validation claims that are too heavy for every push to main, run nightly.
 *
 * `just ci` renders this into .github/workflows/nightly.yml. GitLab CE is
 * several gigabytes and boots in minutes; a GitHub runner is amd64, which is
 * the image's own architecture, so nothing is emulated here.
 *
 * The sandbox job drives INTENTIUS/terragucci-sandbox on github.com with the
 * newest published release (`just sandbox prove`). This workflow's own token
 * reaches only this repo, so it needs TERRAGUCCI_SANDBOX_TOKEN, a token that
 * pushes to the sandbox and administers it.
 */

import {
  Workflow,
  Job,
  Step,
  Checkout,
  SetupNode,
} from "@intentius/chant-lexicon-github";
import {
  CHECKOUT,
  SETUP_NODE,
  NODE_VERSION,
  UPLOAD_ARTIFACT,
  installJust,
} from "../workflows/shared";

export const workflow = new Workflow({
  name: "nightly",
  on: {
    workflow_dispatch: {},
    schedule: [{ cron: "41 3 * * *" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "nightly", "cancel-in-progress": false },
});

// Docker Hub limits anonymous pulls per IP, and runners share IPs: pull
// through Google's Docker Hub mirror, which falls back to Docker Hub for an
// image it does not hold. The same step as ci/pipeline.ts's prelude.
const dockerMirror = () =>
  new Step({
    name: "Pull Docker Hub images through a mirror",
    run: [
      "conf=/etc/docker/daemon.json",
      '{ sudo cat "$conf" 2>/dev/null || echo \'{}\'; } | jq \'. + {"registry-mirrors": ["https://mirror.gcr.io"]}\' > "$RUNNER_TEMP/daemon.json"',
      'sudo cp "$RUNNER_TEMP/daemon.json" "$conf"',
      "sudo systemctl restart docker",
      "docker info --format '{{.RegistryConfig.Mirrors}}'",
    ].join("\n"),
  });

export const gitlab = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 90,
  steps: [
    Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
    SetupNode({
      nodeVersion: NODE_VERSION,
      cache: "npm",
      defaults: { step: { uses: SETUP_NODE } },
    }).step,
    installJust(),
    new Step({ name: "Install", run: "npm ci" }),
    dockerMirror(),
    // The daemon's mirror is not enough for GitLab: a run fell back to Docker
    // Hub with the mirror set and met its pull limit. Pull the profile's
    // Docker Hub images from the mirror by name and tag them, so compose finds
    // them present and pulls nothing from Docker Hub.
    new Step({
      name: "Pull the gitlab profile's Docker Hub images from the mirror",
      run: [
        `for img in $(docker compose -f stack/docker-compose.yml --profile gitlab config --images); do`,
        `  host="\${img%%/*}"`,
        `  if [ "$host" = "$img" ]; then ref="library/$img"; else ref="$img"; case "$host" in *.*|*:*|localhost) continue ;; esac; fi`,
        `  { docker pull -q "mirror.gcr.io/$ref" && docker tag "mirror.gcr.io/$ref" "$img"; } || echo "the mirror has no $img; compose pulls it"`,
        `done`,
      ].join("\n"),
    }),
    new Step({ name: "Start the gitlab profile", run: "just stack-up gitlab" }),
    new Step({
      name: "Run the gitlab claims",
      run: "just validate-forge gitlab",
    }),
    new Step({
      name: "Stop the stack",
      if: "always()",
      run: "just stack-down",
    }),
  ],
});

// The scratch directory holds the run's signer key, so only the verdicts and
// the logs are kept.
const SANDBOX_DIR = "/tmp/terragucci-sandbox";
const token = {
  TERRAGUCCI_SANDBOX_TOKEN: "${{ secrets.TERRAGUCCI_SANDBOX_TOKEN }}",
};

/**
 * One job per phase of prove, each from a reset sandbox: merge, then
 * pull-request, then modules. Each has its own timeout, so a slow phase (jobs
 * on the sandbox queue behind the organization's other runs) no longer starves
 * the phases after it, and each keeps its own verdicts. A phase runs after the
 * one before it whatever that one's result, since they share the sandbox.
 */
const sandboxSteps = (phase: "merge" | "pull-request" | "modules") => [
  new Step({
    name: "Check the sandbox token",
    env: token,
    run: [
      `if [ -z "$TERRAGUCCI_SANDBOX_TOKEN" ]; then`,
      `  echo "::error::The repo secret TERRAGUCCI_SANDBOX_TOKEN is not set. Add a token that can push to INTENTIUS/terragucci-sandbox and administer it: a fine-grained token on that repo with Administration, Contents, Workflows, Pull requests, Issues, Actions and Secrets read and write and Commit statuses read, or a classic token with repo and workflow, from an admin of the repo."`,
      `  exit 1`,
      `fi`,
    ].join("\n"),
  }),
  Checkout({ defaults: { step: { uses: CHECKOUT } } }).step,
  SetupNode({
    nodeVersion: NODE_VERSION,
    cache: "npm",
    defaults: { step: { uses: SETUP_NODE } },
  }).step,
  installJust(),
  new Step({ name: "Install", run: "npm ci" }),
  dockerMirror(),
  new Step({
    name: "Use the newest published release",
    run: `echo "TERRAGUCCI_SANDBOX_RELEASE=$(npm view @intentius/terragucci version)" >> "$GITHUB_ENV"`,
  }),
  new Step({
    name: `Prove the ${phase} phase on the sandbox`,
    env: token,
    run: `just sandbox prove ${phase}`,
  }),
  // prove.json is rewritten after each verdict, so a job cut short by its
  // timeout still lists the verdicts it reached.
  new Step({
    name: "List the verdicts",
    if: "always()",
    run: [
      `f="${SANDBOX_DIR}/prove.json"`,
      `[ -f "$f" ] || exit 0`,
      `{ echo "Release $(jq -r .release "$f"), phase ${phase}"; echo; echo "| Claim | Result |"; echo "|---|---|"; jq -r '.claims[] | "| \\(.claim) | \\(.verdict) |"' "$f"; } >> "$GITHUB_STEP_SUMMARY"`,
    ].join("\n"),
  }),
  new Step({
    name: "Reset the sandbox",
    if: "always()",
    env: token,
    run: `[ -z "$TERRAGUCCI_SANDBOX_TOKEN" ] || just sandbox reset`,
  }),
  new Step({
    name: "Keep the verdicts and logs",
    if: "always()",
    uses: UPLOAD_ARTIFACT,
    with: {
      name: `sandbox-prove-${phase}`,
      path: `${SANDBOX_DIR}/prove.json\n${SANDBOX_DIR}/logs/`,
      "if-no-files-found": "ignore",
      "retention-days": 30,
    },
  }),
];

// The merge phase drives the most runs (about fifteen claims, each a merge
// or a comment and its run); with the runners busy it took three hours.
export const sandbox = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 240,
  // One sandbox, so one job drives it at a time.
  concurrency: { group: "terragucci-sandbox", "cancel-in-progress": false },
  env: { TERRAGUCCI_SANDBOX_DIR: SANDBOX_DIR },
  steps: sandboxSteps("merge"),
});

export const sandboxPullRequest = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 90,
  needs: "sandbox",
  if: "always()",
  concurrency: { group: "terragucci-sandbox", "cancel-in-progress": false },
  env: { TERRAGUCCI_SANDBOX_DIR: SANDBOX_DIR },
  steps: sandboxSteps("pull-request"),
});

export const sandboxModules = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 60,
  needs: "sandbox-pull-request",
  if: "always()",
  concurrency: { group: "terragucci-sandbox", "cancel-in-progress": false },
  env: { TERRAGUCCI_SANDBOX_DIR: SANDBOX_DIR },
  steps: sandboxSteps("modules"),
});
