// Builds @intentius/terragucci for release: the CLI as one bundled file with
// no runtime dependencies, and the config types for a terragucci.ts.
//   node scripts/build-cli.mjs
// chant is a build dependency only. The TypeScript folder that a .ts config
// needs, and the HCL parser a module rollout needs, stay external and optional.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/terragucci");
const dist = join(pkg, "dist");
mkdirSync(dist, { recursive: true });
// Everything is built in a private stage inside dist and renamed into place at
// the end, so a build that runs while another one does never leaves a reader
// with a missing or half-written dist/terragucci.mjs. Renames within one
// directory are atomic; the last build to finish wins whole.
const stage = mkdtempSync(join(dist, ".stage-"));
// A build that fails (esbuild, tsc, a signal) must not leave the stage behind:
// it would ship in `npm pack`. After the renames the stage is already gone and
// the force makes this a no-op.
const cleanStage = () => rmSync(stage, { recursive: true, force: true });
process.on("exit", cleanStage);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));

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
  plugins: [gzippedJson],
});

const result = await build({
  ...options(pkg),
  outfile: join(stage, "terragucci.mjs"),
  sourcemap: "linked",
  // bundle-check reads this to refuse a denied input (terragucci#87).
  metafile: true,
});
// Kept out of dist so it does not ship in the tarball.
const metaDir = join(root, "node_modules/.cache/terragucci");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));
chmodSync(join(stage, "terragucci.mjs"), 0o755);

// The JSON Schemas of what terragucci writes, published so a reader can validate
// terragucci.report/v1, terragucci.report-index/v1, terragucci.estate/v1, terragucci.audit/v1, terragucci.inventory/v1, terragucci.changes/v1 and terragucci.history/v1.
for (const f of ["report.schema.json", "report-index.schema.json", "estate.schema.json", "audit.schema.json", "inventory.schema.json", "changes.schema.json", "history.schema.json", "dora.schema.json", "run.schema.json"]) {
  copyFileSync(join(pkg, "src/report", f), join(stage, f));
}
// The generic webhook's event, terragucci.notify/v1, for a receiver to validate.
copyFileSync(join(pkg, "src/notify.schema.json"), join(stage, "notify.schema.json"));

// The config types, for `import type { TerragucciConfig } from "@intentius/terragucci"`.
execFileSync(
  join(root, "node_modules/.bin/tsc"),
  [join(pkg, "src/config.ts"), "--declaration", "--emitDeclarationOnly", "--outDir", join(stage, "types"),
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { stdio: "inherit" },
);
renameSync(join(stage, "types/config.d.ts"), join(stage, "types.d.ts"));
rmSync(join(stage, "types"), { recursive: true, force: true });
// The map goes first and the bundle last, so a bundle that is there has its map.
for (const f of readdirSync(stage).sort((a, b) => Number(a === "terragucci.mjs") - Number(b === "terragucci.mjs"))) {
  renameSync(join(stage, f), join(dist, f));
}
rmSync(stage, { recursive: true, force: true });

// Size report: raw and gzipped, the change against origin/main, the ten largest
// inputs. It informs and never fails; bundle-check holds the ceiling.
const outBytes = readFileSync(join(dist, "terragucci.mjs"));
const raw = outBytes.length;
const gz = gzipSync(outBytes).length;
const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`  bundle ${fmt(raw)} raw, ${fmt(gz)} gzipped`);
// Both builds resolve chant from this node_modules, so the baseline is the
// origin/main sources on the chant build installed here. Say which, because it
// is not always the pin: chant-local installs a local build, and a bundle that
// differs from one built on the pin by a few KB is that, not the sources.
const chantBuild = (() => {
  try {
    const p = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant/package.json"), "utf8"));
    return `chant ${p.version}${p.chantLocal ? " (local build)" : ""}`;
  } catch { return "chant (not installed)"; }
})();
try {
  const baseSha = execFileSync("git", ["rev-parse", "--short", "origin/main"], { cwd: root, stdio: "pipe" }).toString().trim();
  const tmp = mkdtempSync(join(tmpdir(), "terragucci-base-"));
  execFileSync("sh", ["-c", `git archive origin/main packages scripts | tar -x -C "${tmp}"`], { cwd: root, stdio: "pipe" });
  symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"));
  const base = await build({ ...options(join(tmp, "packages/terragucci")), write: false, outfile: join(tmp, "base.mjs") });
  const baseRaw = base.outputFiles[0].contents;
  const sign = (n) => `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
  console.log(`  vs origin/main ${sign(raw - baseRaw.length)} raw, ${sign(gz - gzipSync(baseRaw).length)} gzipped (origin/main ${baseSha} is ${fmt(baseRaw.length)} raw; both built with ${chantBuild})`);
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
