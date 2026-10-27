// The esbuild plugin for the Terraform lexicon subpaths src/chant-next.ts loads on first use: chant 0.124.52 and
// earlier have none of them (terragucci#1278), and `registry` (chant#4565), core's `object-store` (chant#4554) and core's `components/check-hooks` (chant#4556) are newer than the 0.124.54 pin. One the installed chant lacks resolves to a module that
// throws when it is imported, so a bundle builds on either chant, and the CLI built on 0.124.52 applies in
// waves. scripts/cli-bundle.mjs (the shipped bundle) and test/pipeline.test.ts (the CLI its stand-in steps run)
// both take it from here.
const CHANT_NEXT = /^@intentius\/chant-lexicon-terraform\/(compose|compose\/run|compose\/root|compose\/estate|compose\/slice|state|plan-shape|registry)$|^@intentius\/chant\/(object-store|components\/check-hooks)$/;

export const chantNext = {
  name: "chant-next",
  setup(b) {
    b.onResolve({ filter: CHANT_NEXT }, async (args) => {
      if (args.pluginData?.chantNext) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { chantNext: true } });
      return r.errors.length === 0 ? undefined : { path: args.path, namespace: "chant-next-missing" };
    });
    b.onLoad({ filter: /.*/, namespace: "chant-next-missing" }, (args) => ({
      loader: "js",
      contents: `throw new Error(${JSON.stringify(`the installed chant has no ${args.path}`)});\n`,
    }));
  },
};
