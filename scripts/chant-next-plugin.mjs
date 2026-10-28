// The esbuild plugin for the Terraform lexicon subpaths src/chant-next.ts loads on first use: chant 0.124.52 and
// earlier have none of them (terragucci#1278), and `registry` (chant#4565), core's `object-store` (chant#4554), `components/check-hooks` (chant#4556), `terraform/credentials` (chant#4563) and `bucket-check` (chant#4558), and the lexicon's TF046 (chant#4561) and `module-catalog` (chant#4560), and core's `ci-product` and `ci-product-words` (chant#4550), and core's `ci-control` with the forge lexicons' `components/control-pipeline` (chant#4568), and core's `exit-codes`, `components/pr-env-ledger`, `op/op-waves-capability` and `otlp` and the lexicon's `drift-rows` (terragucci#1282 part e), and core's `lifecycle/release-catalog`, `lifecycle/release-catalog-site`, `lifecycle/release-status` and `lifecycle/release-changelog` (chant#4595-#4597, terragucci#1297), and core's `forge-check`, `notify-relay`, `ci-estate` and `policy-source` (terragucci#1282 part f), are newer than the 0.124.54 pin. One the installed chant lacks resolves to a module that
// throws when it is imported, so a bundle builds on either chant, and the CLI built on 0.124.52 applies in
// waves. scripts/cli-bundle.mjs (the shipped bundle) and test/pipeline.test.ts (the CLI its stand-in steps run)
// both take it from here.
const CHANT_NEXT = /^@intentius\/chant-lexicon-terraform\/(compose|compose\/run|compose\/root|compose\/estate|compose\/slice|state|plan-shape|registry|lint\/post-synth\/tf046|module-catalog|drift-rows)$|^@intentius\/chant\/(object-store|components\/check-hooks|terraform\/credentials|bucket-check|ci-product|ci-product-words|ci-control|exit-codes|components\/pr-env-ledger|op\/op-waves-capability|otlp|lifecycle\/release-catalog|lifecycle\/release-catalog-site|lifecycle\/release-status|lifecycle\/release-changelog|forge-check|notify-relay|ci-estate|policy-source)$|^@intentius\/chant-lexicon-(github|gitlab|forgejo)\/components\/control-pipeline$/;

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
