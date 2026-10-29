// Ruling for ci-products (2026-10-27): terragucci imports the installed,
// pinned @intentius/chant at run time instead of bundling it (terragucci#1281,
// chant#4591). An import of chant core stays external when the installed chant
// serves it as compiled JS under Node's `import` condition, which chant#4591
// gives every core subpath. A subpath the installed chant serves only as
// TypeScript (the 0.124.54 pin has an `import` condition on notify,
// notify-verify and runner-start alone) is bundled as before, because plain
// Node does not load TypeScript from node_modules.
//
// The lexicons stay in the bundle: the package's one runtime dependency is
// @intentius/chant, and a bundled lexicon's own imports of chant core go
// through this plugin too, so the bin runs one copy of core, the installed one.
//
// A core subpath the installed chant does not export at all resolves to
// nothing here and goes on to scripts/chant-next-plugin.mjs, which stands in a
// module that throws.
//
// Used by scripts/cli-bundle.mjs and scripts/bundle-check.mjs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CORE = /^@intentius\/chant(\/.*)?$/;
const CONDITIONS = ["import", "node", "default"];

/** The target `conditions` pick from one exports value, in key order, as Node reads it. */
function pick(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pick(v);
      if (t !== undefined) return t;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (CONDITIONS.includes(key)) return pick(v);
    }
  }
  return undefined;
}

/** The file `subpath` of the package at `pkgDir` names under Node's ESM conditions, or undefined. */
function exportsTarget(pkgDir, subpath) {
  const map = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).exports;
  if (!map || typeof map !== "object") return undefined;
  if (subpath in map) {
    const t = pick(map[subpath]);
    return t === undefined ? undefined : join(pkgDir, t);
  }
  // Node's pattern match: the longest prefix before a single `*` wins.
  let best;
  for (const key of Object.keys(map)) {
    const at = key.indexOf("*");
    if (at < 0 || key.indexOf("*", at + 1) >= 0) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length) continue;
    if (best && prefix.length <= best.prefix.length) continue;
    best = { prefix, star: subpath.slice(prefix.length, subpath.length - suffix.length), value: map[key] };
  }
  if (!best) return undefined;
  const t = pick(best.value);
  return t === undefined ? undefined : join(pkgDir, t.split("*").join(best.star));
}

/**
 * The compiled file Node would load for the chant core `specifier` imported
 * from a file in `fromDir`, or undefined when the installed chant does not
 * export it, exports only TypeScript for it, or is not installed.
 */
export function chantRuntimeTarget(specifier, fromDir) {
  const m = CORE.exec(specifier);
  if (!m) return undefined;
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules/@intentius/chant");
    if (existsSync(join(pkgDir, "package.json"))) {
      const file = exportsTarget(pkgDir, m[1] ? `.${m[1]}` : ".");
      return file && /\.m?js$/.test(file) && existsSync(file) ? file : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Whether the chant installed for the package at `pkgDir` serves its root as compiled JS (chant#4591 and later). */
export const chantServesCompiled = (pkgDir) => chantRuntimeTarget("@intentius/chant", pkgDir) !== undefined;

/**
 * The esbuild plugin: a chant core import that resolves, from the package at
 * `pkgDir` (where the bin runs), to compiled JS is left external. Everything
 * else goes on to the next plugin (chant-next's stand-ins) and esbuild.
 */
export const chantExternal = (pkgDir) => ({
  name: "chant-external",
  setup(b) {
    b.onResolve({ filter: CORE }, (args) => (chantRuntimeTarget(args.path, pkgDir) ? { path: args.path, external: true } : undefined));
  },
});
