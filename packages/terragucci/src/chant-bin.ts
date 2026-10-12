/**
 * The chant bin terragucci runs to record what chant records: an approval
 * (./approve.ts), a decision point's question and answer (./point-gate.ts,
 * ./relay.ts). It imports nothing of terragucci's, so the wave's own module
 * can use it without loading the commands.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The chant bin of the @intentius/chant package installed with terragucci:
 * found from terragucci's own file upward, then from `from` upward, through
 * each node_modules/@intentius/chant/package.json and its `bin.chant`. The
 * package exports no ./package.json, so it is read from disk, not resolved.
 * Undefined when neither place has it.
 */
export function installedChant(from: string[] = [dirname(fileURLToPath(import.meta.url))]): string | undefined {
  for (const start of from) {
    for (let dir = resolve(start); ; ) {
      const manifest = join(dir, "node_modules", "@intentius", "chant", "package.json");
      if (existsSync(manifest)) {
        try {
          const bin = (JSON.parse(readFileSync(manifest, "utf-8")) as { bin?: string | Record<string, string> }).bin;
          const rel = typeof bin === "string" ? bin : bin?.chant;
          if (rel && existsSync(resolve(dirname(manifest), rel))) return resolve(dirname(manifest), rel);
        } catch {
          // An unreadable manifest: look further up.
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

/** The chant executable approve runs: `o.chant`, else the installed package's bin, else `chant` on the path. */
export function chantCommand(repo: string, o: { chant?: string } = {}): string {
  return o.chant ?? installedChant([dirname(fileURLToPath(import.meta.url)), repo]) ?? "chant";
}

