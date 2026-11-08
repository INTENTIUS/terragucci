// The esbuild options of the CLI bundle, shared by scripts/build-cli.mjs (the
// shipped bundle and the origin/main baseline) and stack/break-bundle.mjs (a
// smoke claim's BREAK bundle), so a BREAK bundle differs from the shipped one
// only by its cut.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chantExternal } from "./chant-external.mjs";
import { chantNext } from "./chant-next-plugin.mjs";

// The dashboards template (src/dashboards/rendered.json, terragucci#163) and
// chant's workspace schemas (declaration.schema.json alone is 67 KB as a JS
// literal, terragucci#1232) go into the bundle gzipped. Each is unpacked once,
// when its module is first evaluated.
const gzippedJson = {
  name: "gzipped-json",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]dashboards[\\/]rendered\.json$|[\\/]@intentius[\\/]chant[\\/]src[\\/]workspace[\\/][^\\/]+\.schema\.json$/ }, (args) => {
      const packed = gzipSync(JSON.stringify(JSON.parse(readFileSync(args.path, "utf8"))), { level: 9 }).toString("base64");
      return {
        loader: "js",
        contents: `import { gunzipSync } from "node:zlib";\nexport default JSON.parse(gunzipSync(Buffer.from(${JSON.stringify(packed)}, "base64")).toString("utf8"));\n`,
      };
    });
  },
};

/** The options for the bundle of the package at pkgDir; `plugins` run before the shipped ones. */
export const bundleOptions = (pkgDir, plugins = []) => ({
  entryPoints: [join(pkgDir, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@intentius/tsad-reference", "@cdktn/hcl2json", "typescript"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __terragucciRequire } from 'node:module';\nconst require = __terragucciRequire(import.meta.url);" },
  legalComments: "none",
  // Folds constants, drops dead branches and whitespace, and shortens names. The
  // linked source map ships beside the bundle: run with
  // `node --enable-source-maps` to read a stack trace against the sources.
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  keepNames: false,
  logLevel: "warning",
  // chant core the installed chant serves as compiled JS stays external
  // (scripts/chant-external.mjs); chant-next stands in for a subpath it lacks.
  plugins: [...plugins, chantExternal(pkgDir), chantNext, gzippedJson],
});
