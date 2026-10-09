// The esbuild options of the CLI bundle, shared by scripts/build-cli.mjs (the
// shipped bundle and the origin/main baseline) and stack/break-bundle.mjs (a
// smoke claim's BREAK bundle), so a BREAK bundle differs from the shipped one
// only by its cut.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// The dashboards template (src/dashboards/rendered.json, terragucci#163) goes
// into the bundle gzipped: as a JS literal it is a fifth of the bundle, and
// only an init with `dashboards:` reads it.
const gzippedJson = {
  name: "gzipped-json",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]dashboards[\\/]rendered\.json$/ }, (args) => {
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
  plugins: [...plugins, gzippedJson],
});
