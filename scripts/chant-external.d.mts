// Types for scripts/chant-external.mjs, which scripts/cli-bundle.mjs runs with plain node.
import type { Plugin } from "esbuild";
export declare const chantExternal: (pkgDir: string) => Plugin;
