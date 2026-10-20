// The two clusters, both on network. Each states the edge twice: dependsOn,
// which orders the run, and the inputs that fill the stack's parameters with
// network's outputs (src/cluster-*/params.ts declares them).
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const clusterA: Component = {
  name: "cluster-a",
  archetype: "infra",
  dependsOn: ["network"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "cluster-a",
          template: "dist/cluster-a.template.json",
          inputs: {
            clusterATopicArn: { stackOutput: { stack: "network", name: "TopicArn" } },
            clusterAQueueUrl: { stackOutput: { stack: "network", name: "QueueUrl" } },
          },
        },
      ],
    },
  ],
};

export const clusterB: Component = {
  name: "cluster-b",
  archetype: "infra",
  dependsOn: ["network"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "cluster-b",
          template: "dist/cluster-b.template.json",
          inputs: {
            clusterBTopicArn: { stackOutput: { stack: "network", name: "TopicArn" } },
            clusterBQueueUrl: { stackOutput: { stack: "network", name: "QueueUrl" } },
          },
        },
      ],
    },
  ],
};
