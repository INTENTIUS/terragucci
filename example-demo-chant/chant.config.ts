// The project's one lexicon and its three Terraform roots, run with OpenTofu.
// A .ts config, which behold reads as a chant project, with no imports, so a
// checkout with no node_modules evaluates it.
export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "tofu",
    roots: {
      network: { dir: "network" },
      app: { dir: "app" },
      edge: { dir: "edge" },
    },
  },
};
