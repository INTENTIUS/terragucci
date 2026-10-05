// Builds @intentius/terragucci for release: the CLI as one bundled file with
// no runtime dependencies, and the config types for a terragucci.ts.
//   node scripts/build-cli.mjs
// chant is a build dependency only. The TypeScript folder that a .ts config
// needs, and the HCL parser a module rollout needs, stay external and optional.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/terragucci");
const dist = join(pkg, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// One set of options for the shipped bundle and for the origin/main baseline.
const options = (pkgDir) => ({
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
});

const result = await build({
  ...options(pkg),
  outfile: join(dist, "terragucci.mjs"),
  sourcemap: "linked",
  // bundle-check reads this to refuse a denied input (terragucci#87).
  metafile: true,
});
// Kept out of dist so it does not ship in the tarball.
const metaDir = join(root, "node_modules/.cache/terragucci");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));
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

// Size report: raw and gzipped, the change against origin/main, the ten largest
// inputs. It informs and never fails; bundle-check holds the ceiling.
const outBytes = readFileSync(join(dist, "terragucci.mjs"));
const raw = outBytes.length;
const gz = gzipSync(outBytes).length;
const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`  bundle ${fmt(raw)} raw, ${fmt(gz)} gzipped`);
try {
  const tmp = mkdtempSync(join(tmpdir(), "terragucci-base-"));
  execFileSync("sh", ["-c", `git archive origin/main packages scripts | tar -x -C "${tmp}"`], { cwd: root, stdio: "pipe" });
  symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"));
  const base = await build({ ...options(join(tmp, "packages/terragucci")), write: false, outfile: join(tmp, "base.mjs") });
  const baseRaw = base.outputFiles[0].contents;
  const sign = (n) => `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
  console.log(`  vs origin/main ${sign(raw - baseRaw.length)} raw, ${sign(gz - gzipSync(baseRaw).length)} gzipped (origin/main is ${fmt(baseRaw.length)} raw)`);
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.log(`  vs origin/main: not measured (${String(e.message).split("\n")[0]})`);
}
const largest = Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith("terragucci.mjs"))].inputs)
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 10);
console.log("  ten largest inputs (bytes in the bundle):");
for (const [name, v] of largest) console.log(`    ${String(v.bytesInOutput).padStart(8)}  ${name.replace(/^(\.\.\/)+.*?node_modules\//, "")}`);

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`  ✓ dist/terragucci.mjs ${kb(join(dist, "terragucci.mjs"))} KB, dist/types.d.ts ${kb(join(dist, "types.d.ts"))} KB`);
