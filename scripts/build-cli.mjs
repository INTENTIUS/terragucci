// Builds @intentius/terragucci for release: the CLI as one bundled file with
// no runtime dependencies, and the config types for a terragucci.ts.
//   node scripts/build-cli.mjs
// chant is a build dependency only. The TypeScript folder that a .ts config
// needs, and the HCL parser a module rollout needs, stay external and optional.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/terragucci");
const dist = join(pkg, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// chant's YAML reader (@intentius/chant/yaml) imports js-yaml's default
// export, an object holding the whole library, so esbuild can drop none of
// it: 101 KB as the ES module. js-yaml's own minified build is the same code
// at 43 KB, so the bundle takes that one.
const require = createRequire(import.meta.url);
const minifiedYaml = {
  name: "minified-js-yaml",
  setup(b) {
    b.onResolve({ filter: /^js-yaml$/ }, () => ({ path: join(dirname(require.resolve("js-yaml")), "dist/js-yaml.min.js") }));
  },
};

await build({
  entryPoints: [join(pkg, "src/cli.ts")],
  outfile: join(dist, "terragucci.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@intentius/tsad-reference", "@cdktn/hcl2json", "typescript"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __terragucciRequire } from 'node:module';\nconst require = __terragucciRequire(import.meta.url);" },
  legalComments: "none",
  // Folds constants and drops dead branches; names and layout stay readable.
  minifySyntax: true,
  plugins: [minifiedYaml],
  logLevel: "warning",
});
chmodSync(join(dist, "terragucci.mjs"), 0o755);

// The report's JSON Schema, published so a reader can validate terragucci.report/v1.
copyFileSync(join(pkg, "src/report/report.schema.json"), join(dist, "report.schema.json"));

// The config types, for `import type { TerragucciConfig } from "@intentius/terragucci"`.
execFileSync(
  join(root, "node_modules/.bin/tsc"),
  [join(pkg, "src/config.ts"), "--declaration", "--emitDeclarationOnly", "--outDir", join(dist, "types"),
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { stdio: "inherit" },
);
renameSync(join(dist, "types/config.d.ts"), join(dist, "types.d.ts"));
rmSync(join(dist, "types"), { recursive: true, force: true });

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`  ✓ dist/terragucci.mjs ${kb(join(dist, "terragucci.mjs"))} KB, dist/types.d.ts ${kb(join(dist, "types.d.ts"))} KB`);
