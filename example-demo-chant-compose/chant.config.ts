// Three CloudFormation stacks, each deployed on its own: network, app on it,
// and edge on app. Nothing here states the order they deploy in: chant reads
// dependsOn off the *.component.ts files and derives it from the change.
//
// A .ts config with no imports, which behold reads as a chant project, so a
// checkout with no node_modules evaluates it.
export default {
  // The aws lexicon builds the templates and brings the cfn-deploy step.
  lexicons: ["aws"],

  // demo: the stack's floci, as the jobs and the driver reach it on the
  // stack's network. AWS_ENDPOINT_URL names the same address in each job.
  environments: [{ name: "demo", endpoint: "http://floci:4566" }],

  // One entry per stack, with the directory it is built from. A pull
  // request's change is measured stack by stack against this list.
  stacks: [
    { name: "network", src: "src/network" },
    { name: "app", src: "src/app" },
    { name: "edge", src: "src/edge" },
  ],

  // The project's identity, which the aws lexicon tags every resource with.
  ownership: { stack: "demo-chant-compose", env: "demo" },
};
