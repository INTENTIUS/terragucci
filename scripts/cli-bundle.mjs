// The esbuild options of the CLI bundle, shared by scripts/build-cli.mjs (the
// shipped bundle and the origin/main baseline) and stack/break-bundle.mjs (a
// smoke claim's BREAK bundle), so a BREAK bundle differs from the shipped one
// only by its cut.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

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

// The MCP SDK's server imports Ajv to validate what it asks a client to fill
// in (elicitation). `terragucci mcp` asks for nothing, so the SDK's validator
// module resolves to src/mcp-validator.ts, which refuses any schema, and Ajv
// stays out of the bundle (terragucci#657).
const noAjv = (pkgDir) => ({
  name: "mcp-no-ajv",
  setup(b) {
    b.onResolve({ filter: /[\\/]validation[\\/]ajv-provider\.js$/ }, (args) =>
      /[\\/]@modelcontextprotocol[\\/]sdk[\\/]/.test(args.importer) ? { path: join(pkgDir, "src/mcp-validator.ts") } : undefined);
  },
});

// The MCP SDK and zod are 140 KB of the bundle, and only `terragucci mcp`
// runs them (terragucci#1232). src/mcp-sdk.ts is their one way in: here it is
// replaced by a module holding them built on their own, minified and gzipped,
// which `loadMcpSdk` imports from a data: URL on its first call. The inner
// build may import Node's own modules only, since a data: URL module resolves
// nothing else. Its inputs are kept in `innerInputs` for the metafile
// bundle-check reads.
export const innerInputs = {};
const lazyMcpSdk = (pkgDir) => ({
  name: "lazy-mcp-sdk",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]mcp-sdk\.ts$/ }, async (args) => {
      const inner = await build({
        stdin: {
          contents: [
            'export { Server } from "@modelcontextprotocol/sdk/server/index.js";',
            'export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
            'export { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";',
          ].join("\n"),
          resolveDir: pkgDir,
          sourcefile: "mcp-sdk-inner.js",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        legalComments: "none",
        minify: true,
        logLevel: "warning",
        write: false,
        metafile: true,
        plugins: [noAjv(pkgDir)],
      });
      const code = inner.outputFiles[0].contents;
      const builtin = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
      const outside = inner.metafile.outputs[Object.keys(inner.metafile.outputs)[0]].imports.filter((i) => !builtin.has(i.path)).map((i) => i.path);
      if (outside.length) throw new Error(`the MCP SDK's inner build imports ${outside.join(", ")}, which a data: URL module cannot resolve`);
      Object.assign(innerInputs, inner.metafile.inputs);
      const packed = gzipSync(code, { level: 9 }).toString("base64");
      return {
        loader: "js",
        resolveDir: pkgDir,
        watchFiles: Object.keys(inner.metafile.inputs),
        contents: [
          'import { gunzipSync } from "node:zlib";',
          "let sdk;",
          `export const loadMcpSdk = () => (sdk ??= import("data:text/javascript;base64," + gunzipSync(Buffer.from(${JSON.stringify(packed)}, "base64")).toString("base64")));`,
        ].join("\n"),
      };
    });
  },
});

// The Terraform lexicon subpaths src/chant-next.ts loads on first use: chant 0.124.52, the newest published, has
// none of them (terragucci#1278). One the installed chant lacks resolves to a module that throws when it is
// imported, so the bundle builds on either chant, and the CLI built on the published one applies in waves.
const CHANT_NEXT = /^@intentius\/chant-lexicon-terraform\/(compose|compose\/run|compose\/root|compose\/estate|compose\/slice|state|plan-shape)$/;
const chantNext = {
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
  plugins: [...plugins, chantNext, gzippedJson, lazyMcpSdk(pkgDir), noAjv(pkgDir)],
});
