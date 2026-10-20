// The twelve apps: app-01 to app-06 on cluster-a, app-07 to app-12 on
// cluster-b. One file, so the split between the clusters is visible at a
// glance; each app still has its own source directory, since a stack is a
// build root. Each names its cluster twice: in dependsOn, which orders the run,
// and in the stackOutput that fills the TableName its log group is named from.
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const app01: Component = {
  name: "app-01",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-01",
          template: "dist/app-01.template.json",
          inputs: { app01TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app02: Component = {
  name: "app-02",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-02",
          template: "dist/app-02.template.json",
          inputs: { app02TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app03: Component = {
  name: "app-03",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-03",
          template: "dist/app-03.template.json",
          inputs: { app03TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app04: Component = {
  name: "app-04",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-04",
          template: "dist/app-04.template.json",
          inputs: { app04TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app05: Component = {
  name: "app-05",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-05",
          template: "dist/app-05.template.json",
          inputs: { app05TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app06: Component = {
  name: "app-06",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-06",
          template: "dist/app-06.template.json",
          inputs: { app06TableName: { stackOutput: { stack: "cluster-a", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app07: Component = {
  name: "app-07",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-07",
          template: "dist/app-07.template.json",
          inputs: { app07TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app08: Component = {
  name: "app-08",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-08",
          template: "dist/app-08.template.json",
          inputs: { app08TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app09: Component = {
  name: "app-09",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-09",
          template: "dist/app-09.template.json",
          inputs: { app09TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app10: Component = {
  name: "app-10",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-10",
          template: "dist/app-10.template.json",
          inputs: { app10TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app11: Component = {
  name: "app-11",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-11",
          template: "dist/app-11.template.json",
          inputs: { app11TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};

export const app12: Component = {
  name: "app-12",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "cfn-deploy",
          stack: "app-12",
          template: "dist/app-12.template.json",
          inputs: { app12TableName: { stackOutput: { stack: "cluster-b", name: "TableName" } } },
        },
      ],
    },
  ],
};
