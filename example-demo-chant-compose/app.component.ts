// app sits on network. It states the edge twice: dependsOn, which orders the
// run, and the inputs that fill the stack's parameters with network's outputs
// (src/app/params.ts declares them).
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const app: Component = {
  name: "app",
  archetype: "service",
  dependsOn: ["network"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app",
          template: "dist/app.template.json",
          inputs: {
            appVpcId: { stackOutput: { stack: "network", name: "VpcId" } },
            appSubnetAId: { stackOutput: { stack: "network", name: "SubnetAId" } },
            appHttpProxyPort: { stackOutput: { stack: "network", name: "HttpProxyPort" } },
          },
        },
      ],
    },
  ],
};
