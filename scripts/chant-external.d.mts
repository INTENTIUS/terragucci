// Types for scripts/chant-external.mjs, which scripts/cli-bundle.mjs and scripts/bundle-check.mjs run with plain node.
import type { Plugin } from "esbuild";
export declare function chantRuntimeTarget(specifier: string, fromDir: string): string | undefined;
export declare const chantServesCompiled: (pkgDir: string) => boolean;
export declare const chantExternal: (pkgDir: string) => Plugin;
