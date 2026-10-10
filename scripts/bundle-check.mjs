// Holds @intentius/terragucci to its shape (terragucci#18, #87, #163): no runtime
// dependencies, no imports but Node's own modules and the two optional packages,
// no input from a path that would drag lint rules, codegen, the TypeScript
// compiler or the dashboards' renderers into the bundle, and a 1.25 MB accident
// ceiling on its size. The ceiling was 1 MB until `terragucci mcp` brought the
// MCP SDK and zod in, about 150 KB (terragucci#657).
//   node scripts/bundle-check.mjs     (after `just build-cli`)
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const CEILING_BYTES = 1280 * 1024;
const OPTIONAL = new Set(["@intentius/tsad-reference", "@cdktn/hcl2json"]);

// Matched against each metafile input with everything up to the last
// node_modules/ removed. The terraform lexicon's post-synth rules (lint/post-synth)
// are on purpose: terragucci runs them. Its lint/rules, codegen, entry point and
// plugin are not.
const DENIED = [
  [/^typescript\//, "the TypeScript compiler"],
  [/^@intentius\/chant\/src\/lint\//, "chant lint rules"],
  [/^@intentius\/chant\/src\/codegen\//, "chant codegen"],
  [/^@intentius\/chant\/src\/cli\//, "the chant CLI"],
  [/^@intentius\/chant-lexicon-[^/]+\/src\/(index|plugin)\.ts$/, "a lexicon entry point"],
  [/^@intentius\/chant-lexicon-[^/]+\/src\/lint\/rules\//, "lexicon lint rules"],
  [/^@intentius\/chant-lexicon-[^/]+\/src\/codegen\//, "lexicon codegen"],
  // The dashboards and rules are rendered when the bundle is built; init fills
  // the result (src/dashboards/template.ts). Their lexicons, the YAML dumper
  // and the PromQL parser stay out of the bundle (terragucci#163).
  [/^@intentius\/chant-lexicon-(grafana|prometheus|otel)\//, "a dashboards lexicon"],
  [/^js-yaml\//, "js-yaml"],
  [/^@lezer\/|^@prometheus-io\//, "the PromQL parser"],
  [/(^|\/)packages\/terragucci\/src\/dashboards\/index\.ts$/, "the dashboards' declarations"],
  // The MCP SDK's JSON Schema validator: terragucci mcp asks a client for no
  // input, and scripts/cli-bundle.mjs swaps the validator for one that refuses.
  [/^ajv(-formats)?\//, "Ajv"],
];

const root = join(import.meta.dirname, "..");
const pkgDir = join(root, "packages/terragucci");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
const bundle = join(pkgDir, "dist/terragucci.mjs");
const problems = [];

if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  problems.push(`package.json has runtime dependencies: ${Object.keys(pkg.dependencies).join(", ")}`);
}
const size = statSync(bundle).size;
if (size > CEILING_BYTES) problems.push(`the bundle is ${Math.round(size / 1024)} KB, over the ${CEILING_BYTES / 1024} KB accident ceiling`);

let inputs = [];
try {
  inputs = Object.keys(JSON.parse(readFileSync(join(root, "node_modules/.cache/terragucci/metafile.json"), "utf-8")).inputs);
} catch {
  problems.push("no build metafile; run `node scripts/build-cli.mjs` first");
}
const hits = new Map();
for (const input of inputs) {
  const rel = input.replace(/^.*node_modules\//, "");
  for (const [re, what] of DENIED) {
    if (re.test(rel)) hits.set(what, [...(hits.get(what) ?? []), rel]);
  }
}
for (const [what, list] of hits) {
  const shown = list.slice(0, 3).join(", ");
  problems.push(`the bundle includes ${what} (${list.length} inputs): ${shown}${list.length > 3 ? `, and ${list.length - 3} more` : ""}`);
}

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
console.log(`  ✓ bundle ${Math.round(size / 1024)} KB (ceiling ${CEILING_BYTES / 1024} KB), no dependencies, no denied inputs among ${inputs.length}, imports only ${[...specifiers].length} Node modules and the optional TypeScript folder and HCL parser`);
