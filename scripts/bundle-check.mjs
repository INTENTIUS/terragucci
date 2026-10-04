// Holds @intentius/terragucci to its shape (terragucci#18): no runtime
// dependencies, one bundled file under its size budget, and no imports but
// Node's own modules and the optional TypeScript folder.
//   node scripts/bundle-check.mjs     (after `just build-cli`)
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const BUDGET_BYTES = 300 * 1024;
const OPTIONAL = new Set(["@intentius/tsad-reference"]);

const pkgDir = join(import.meta.dirname, "../packages/terragucci");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
const bundle = join(pkgDir, "dist/terragucci.mjs");
const problems = [];

if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  problems.push(`package.json has runtime dependencies: ${Object.keys(pkg.dependencies).join(", ")}`);
}
const size = statSync(bundle).size;
if (size > BUDGET_BYTES) problems.push(`the bundle is ${Math.round(size / 1024)} KB, over its ${BUDGET_BYTES / 1024} KB budget`);

const text = readFileSync(bundle, "utf-8");
const specifiers = new Set();
for (const m of text.matchAll(/(?:^|[;\s])import\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm)) {
  specifiers.add(m[1] ?? m[2] ?? m[3]);
}
const builtin = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
for (const s of specifiers) {
  if (!builtin.has(s) && !OPTIONAL.has(s)) problems.push(`the bundle imports "${s}", which is not a Node module`);
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`  ✓ bundle ${Math.round(size / 1024)} KB of ${BUDGET_BYTES / 1024} KB, no dependencies, imports only ${[...specifiers].length} Node modules and the optional TypeScript folder`);
