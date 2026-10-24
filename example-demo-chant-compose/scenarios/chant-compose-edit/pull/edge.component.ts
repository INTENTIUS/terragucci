// edge sits on app: it routes to the port app listens on.
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const edge: Component = {
  name: "edge",
  archetype: "service",
  dependsOn: ["app"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "edge",
          template: "dist/edge.template.json",
          inputs: {
            edgeListenerPort: { stackOutput: { stack: "app", name: "ListenerPort" } },
            edgeAdminListenerPort: { stackOutput: { stack: "app", name: "AdminListenerPort" } },
          },
        },
      ],
    },
  ],
};
