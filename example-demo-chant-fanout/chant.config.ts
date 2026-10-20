// Fifteen CloudFormation stacks, each deployed on its own: one network, two
// clusters on it, and twelve apps on the clusters. Nothing here states the
// order they deploy in: chant reads dependsOn off the *.component.ts files and
// derives it from the change.
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
    { name: "cluster-a", src: "src/cluster-a" },
    { name: "cluster-b", src: "src/cluster-b" },
    { name: "app-01", src: "src/app-01" },
    { name: "app-02", src: "src/app-02" },
    { name: "app-03", src: "src/app-03" },
    { name: "app-04", src: "src/app-04" },
    { name: "app-05", src: "src/app-05" },
    { name: "app-06", src: "src/app-06" },
    { name: "app-07", src: "src/app-07" },
    { name: "app-08", src: "src/app-08" },
    { name: "app-09", src: "src/app-09" },
    { name: "app-10", src: "src/app-10" },
    { name: "app-11", src: "src/app-11" },
    { name: "app-12", src: "src/app-12" },
  ],

  // The project's identity, which the aws lexicon tags every resource with.
  ownership: { stack: "demo-chant-fanout", env: "demo" },
};
