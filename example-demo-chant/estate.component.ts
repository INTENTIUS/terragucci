// The demo's three components, one Terraform root each. app reads network's
// port and edge reads app's URL (a stackOutput reference), so chant applies
// them in waves: network, then app, then edge.
//
// The file imports types only, and writes what phase() and stackOutput() would
// return as plain data, so a checkout with no node_modules evaluates it: behold
// draws the components from its view checkout of the demo repo.
import type { Component } from "@intentius/chant/components";

// A root's apply has no undo short of applying the previous configuration.
const NO_ROLLBACK = "a Terraform root rolls back by applying its previous configuration in a new pull request";

export const network: Component = {
  name: "network",
  dependsOn: [],
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "network", noRollback: NO_ROLLBACK }] }],
};

export const app: Component = {
  name: "app",
  dependsOn: ["network"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "terraform-apply",
          root: "app",
          vars: { network_port: { stackOutput: { stack: "network", name: "http_proxy_port" } } },
          noRollback: NO_ROLLBACK,
        },
      ],
    },
  ],
};

export const edge: Component = {
  name: "edge",
  dependsOn: ["app"],
  deploy: [
    {
      phase: "Apply",
      steps: [{ kind: "terraform-apply", root: "edge", vars: { app_url: { stackOutput: { stack: "app", name: "url" } } }, noRollback: NO_ROLLBACK }],
    },
  ],
};
