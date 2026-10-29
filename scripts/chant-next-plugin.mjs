// The esbuild plugin for the Terraform lexicon subpaths src/chant-next.ts loads on first use: chant 0.124.52 and
// earlier have none of them (terragucci#1278), and `registry` (chant#4565), core's `object-store` (chant#4554), `components/check-hooks` (chant#4556) and `bucket-check` (chant#4558), and the lexicon's TF046 (chant#4561) and `module-catalog` (chant#4560), and core's `ci-product` and `ci-product-words` (chant#4550), and core's `ci-control` with the forge lexicons' `components/control-pipeline` (chant#4568), and core's `exit-codes`, `op/op-waves-capability` and `otlp` and the lexicon's `drift-rows` (terragucci#1282 part e), and core's `forge-check`, `notify-relay`, `ci-estate` and `policy-source` (terragucci#1282 part f), and core's `lifecycle/gated-request` and `lifecycle/resource-lock` with the lexicon's `state-ops` and `lock-rows` (chant#4551, #4552, #4618), were newer than the 0.124.54 pin; terragucci#1304 drops each entry once nothing loads it on first use. Core's `template-request` and the lexicon's `template` (chant#4651, #4652, for `terragucci request`) are newer than the 0.124.56 pin. One the installed chant lacks resolves to a module that
// throws when it is imported, so a bundle builds on either chant, and the CLI built on 0.124.52 applies in
// waves. The lexicon's `action-ops` (chant#4653, terragucci#1310) is newer than the 0.124.56 pin. scripts/cli-bundle.mjs (the shipped bundle) and test/pipeline.test.ts (the CLI its stand-in steps run)
// both take it from here.
const CHANT_NEXT = /^@intentius\/chant-lexicon-terraform\/(compose|compose\/run|compose\/root|compose\/estate|compose\/slice|state|plan-shape|registry|lint\/post-synth\/tf046|module-catalog|drift-rows|state-ops|lock-rows|template|action-ops)$|^@intentius\/chant\/(object-store|components\/check-hooks|bucket-check|ci-product|ci-product-words|ci-control|exit-codes|op\/op-waves-capability|otlp|lifecycle\/gated-request|lifecycle\/resource-lock|ci-agent|forge-check|notify-relay|ci-estate|policy-source|template-request)$|^@intentius\/chant-lexicon-(github|gitlab|forgejo)\/components\/control-pipeline$/;

// A subpath the pin has is imported only by parts whose own floor is newer
// than the pin: `op` (the stand-down, chant#4581). On a chant that serves it as TypeScript, bundling it brings
// chant's whole op barrel with its lint rules, codegen, CLI and a static
// import of the TypeScript compiler, about 1.1 MB, and those parts would still
// report missing. So when it resolves to a .ts file it takes the same stand-in
// as a missing subpath. A chant that serves
// it as compiled JS keeps it external (scripts/chant-external.mjs) and
// never reaches this.
const PIN_TS_ONLY_NEWER = /^@intentius\/chant\/op$/;

export const chantNext = {
  name: "chant-next",
  setup(b) {
    b.onResolve({ filter: CHANT_NEXT }, async (args) => {
      if (args.pluginData?.chantNext) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { chantNext: true } });
      return r.errors.length === 0 ? undefined : { path: args.path, namespace: "chant-next-missing" };
    });
    b.onResolve({ filter: PIN_TS_ONLY_NEWER }, async (args) => {
      if (args.pluginData?.chantNext || !/[\\/]packages[\\/]terragucci[\\/]src[\\/]chant-next\.ts$/.test(args.importer)) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { chantNext: true } });
      return r.errors.length === 0 && !/\.ts$/.test(r.path) ? undefined : { path: args.path, namespace: "chant-next-missing" };
    });
    b.onLoad({ filter: /.*/, namespace: "chant-next-missing" }, (args) => ({
      loader: "js",
      contents: `throw new Error(${JSON.stringify(`the installed chant has no ${args.path}`)});\n`,
    }));
  },
};
