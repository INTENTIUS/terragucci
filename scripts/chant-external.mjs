// Ruling for ci-products (2026-10-27): terragucci imports the installed,
// pinned @intentius/chant at run time instead of bundling it (terragucci#1281,
// chant#4591). An import of chant core stays external when the installed chant
// serves it as compiled JS under Node's `import` condition, which chant's
// `chantRuntimeTarget` (@intentius/chant/bundle-check, chant issue 4787)
// answers.
//
// The lexicons stay in the bundle: the package's one runtime dependency is
// @intentius/chant, and a bundled lexicon's own imports of chant core go
// through this plugin too, so the bin runs one copy of core, the installed one.
// chant's own `chantExternalPlugin` leaves every @intentius/chant* import
// external, lexicons too, so this plugin keeps to core.
//
// A core subpath the installed chant does not export at all resolves to
// nothing here and goes on to scripts/chant-next-plugin.mjs, which stands in a
// module that throws.
//
// Used by scripts/cli-bundle.mjs.
import { chantRuntimeTarget } from "@intentius/chant/bundle-check";

const CORE = /^@intentius\/chant(\/.*)?$/;

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
