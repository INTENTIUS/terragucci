// Holds @intentius/terragucci to its shape (terragucci#18, #87, #163): one runtime
// dependency, @intentius/chant at the pinned version, no imports but Node's own modules and the two optional packages,
// no input from a path that would drag lint rules, codegen, the TypeScript
// compiler or the dashboards' renderers into the bundle, and a 2.25 MB accident
// ceiling on its size. The ceiling was 1 MB until `terragucci mcp` brought the
// MCP SDK and zod in, about 150 KB (terragucci#657), 1.25 MB until the
// bundle's own code (query, schema, estate moves, GitLab state) passed it, and
// 1.5 MB until environments (terragucci#945) passed that. It was 2.5 MB for
// one release while chant's pr-env-run pulled in its config loader; chant
// 0.124.46 bundles it in about 32 KB (INTENTIUS/chant#4364).
// It was 2 MB until the ci-products units (terragucci#1282 to #1305) passed it
// with chant core external: 2088 KB on chant's integration build, of which
// terragucci's own code is 1729 KB and the terraform lexicon 313 KB.
//
// Since terragucci#1281 the bundle imports chant core from the installed,
// pinned @intentius/chant wherever that chant serves compiled JS
// (scripts/chant-external.mjs, chant#4591), so an import of
// @intentius/chant or a subpath of it is allowed when the installed chant's
// exports map resolves it, under Node's `import` condition, to a compiled file.
// A chant that predates chant#4591 (the 0.124.54 pin) serves TypeScript, so
// its core is bundled: then the ceiling, and the denied inputs only chant core
// brings (its codegen, js-yaml, Ajv), are reported and wait for the pin bump.
// CI runs this check (`just check-unit`).
//   node scripts/bundle-check.mjs     (after `just build-cli`)
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { chantRuntimeTarget, chantServesCompiled } from "./chant-external.mjs";

const CEILING_BYTES = 2304 * 1024;
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
const waiting = [];
// chant#4591 and later: chant core is external, and the whole check applies.
const chantExternal = chantServesCompiled(pkgDir);
// The denied inputs that only a bundled chant core brings in.
const CHANT_CORE_ONLY = new Set(["chant codegen", "js-yaml", "Ajv", "chant lint rules", "the chant CLI"]);

// One runtime dependency: @intentius/chant, whose bin `terragucci approve`
// runs to record an approval, so installing terragucci is enough. It is pinned
// to the exact version the root installs, which is the chant the bundle is
// built with. The bundle imports chant core from it and no other package.
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const chantPin = rootPkg.dependencies?.["@intentius/chant"] ?? rootPkg.devDependencies?.["@intentius/chant"];
const extra = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== "@intentius/chant");
if (extra.length) problems.push(`package.json has runtime dependencies besides @intentius/chant: ${extra.join(", ")}`);
const chantDep = pkg.dependencies?.["@intentius/chant"];
if (chantDep === undefined) problems.push("package.json does not depend on @intentius/chant, which terragucci approve runs");
else if (chantDep !== chantPin) problems.push(`package.json pins @intentius/chant ${chantDep}, not ${chantPin}, the version the root installs and the bundle is built with`);
if (pkg.devDependencies?.["@intentius/chant"]) problems.push("package.json names @intentius/chant in devDependencies too; it belongs in dependencies alone");
const size = statSync(bundle).size;
if (size > CEILING_BYTES) (chantExternal ? problems : waiting).push(`the bundle is ${Math.round(size / 1024)} KB, over the ${CEILING_BYTES / 1024} KB accident ceiling`);

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
  (chantExternal || !CHANT_CORE_ONLY.has(what) ? problems : waiting).push(`the bundle includes ${what} (${list.length} inputs): ${shown}${list.length > 3 ? `, and ${list.length - 3} more` : ""}`);
}

const text = readFileSync(bundle, "utf-8");
const specifiers = new Set();
for (const m of text.matchAll(/(?:^|[;\s])import\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm)) {
  // Minified code holds strings the pattern also matches; a specifier has no
  // spaces, commas, quotes or template braces.
  const s = m[1] ?? m[2] ?? m[3];
  if (/^[\w@][\w@./:-]*$/.test(s)) specifiers.add(s);
}
const builtin = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const chantImports = [];
for (const s of specifiers) {
  if (builtin.has(s) || OPTIONAL.has(s)) continue;
  if (/^@intentius\/chant(\/|$)/.test(s)) {
    if (chantRuntimeTarget(s, pkgDir)) chantImports.push(s);
    else problems.push(`the bundle imports "${s}", which the installed chant's exports do not serve as compiled JS under the import condition`);
    continue;
  }
  problems.push(`the bundle imports "${s}", which is neither a Node module nor @intentius/chant`);
}

const installed = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant/package.json"), "utf-8")).version;
for (const w of waiting) console.log(`WAIT  ${w} (chant ${installed} bundles its TypeScript core; this applies once the pin serves compiled JS, chant#4591)`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`  ✓ bundle ${Math.round(size / 1024)} KB (ceiling ${CEILING_BYTES / 1024} KB${chantExternal ? "" : ", waiting"}), one dependency (@intentius/chant ${chantDep}), ${chantExternal ? "no" : "no other"} denied inputs among ${inputs.length}, imports ${chantImports.length} chant core subpaths that chant ${installed} serves as compiled JS, Node modules and the optional TypeScript folder and HCL parser`);
