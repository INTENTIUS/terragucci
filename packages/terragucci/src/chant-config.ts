/**
 * chant.config.ts at a plain repo's root, as `terragucci init` writes it: every
 * root as a `terraform.roots` entry keyed by its path, so chant's
 * `terraform-apply` step names a root by that key (chant#4545). A wave job
 * runs on chant's step only when every root of its wave has an entry here.
 *
 * The file holds one JSON object after `export default`, so terragucci reads
 * it back without loading TypeScript. A chant.config.ts terragucci did not
 * write stays as it is; its roots are read the same way when its default
 * export is that JSON, and otherwise not at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CHANT_CONFIG = "chant.config.ts";

/** The first line of a chant.config.ts terragucci init wrote. */
export const CHANT_CONFIG_MARKER = "// Written by terragucci init: each root is a terraform.roots entry, so chant's terraform-apply step can plan and apply it.";

/** The text of chant.config.ts for `roots`, each its own key with its path as `dir`. */
export function chantConfigText(roots: readonly string[], binary?: string): string {
  const entries = Object.fromEntries([...new Set(roots)].sort().map((r) => [r, { dir: r === "" ? "." : r }]));
  const config = { terraform: { roots: entries, ...(binary ? { binary } : {}) } };
  return `${CHANT_CONFIG_MARKER}\n// Run terragucci init again after adding or moving a root.\nexport default ${JSON.stringify(config, null, 2)};\n`;
}

/** Whether `text` is a chant.config.ts terragucci init wrote. */
export const chantConfigWrittenByTerragucci = (text: string): boolean => text.startsWith(CHANT_CONFIG_MARKER);

/** The `terraform.roots` keys of chant.config.ts text whose default export is one JSON object; undefined when it is not. */
export function chantConfigRoots(text: string): Set<string> | undefined {
  const at = text.indexOf("export default ");
  if (at < 0) return undefined;
  const body = text.slice(at + "export default ".length).trim().replace(/;\s*$/, "");
  try {
    const roots = (JSON.parse(body) as { terraform?: { roots?: Record<string, unknown> } }).terraform?.roots;
    return roots && typeof roots === "object" ? new Set(Object.keys(roots)) : new Set();
  } catch {
    return undefined;
  }
}

/** The `terraform.binary` of chant.config.ts text whose default export is one JSON object; undefined when it names none or is not. */
export function chantConfigBinary(text: string): string | undefined {
  const at = text.indexOf("export default ");
  if (at < 0) return undefined;
  try {
    const binary = (JSON.parse(text.slice(at + "export default ".length).trim().replace(/;\s*$/, "")) as { terraform?: { binary?: unknown } }).terraform?.binary;
    return typeof binary === "string" && binary ? binary : undefined;
  } catch {
    return undefined;
  }
}

/** The roots and the binary chant.config.ts at `repo`'s root declares, or why they cannot be read. */
export function declaredTerraformConfig(repo: string): { roots: Set<string>; binary?: string } | { why: string } {
  const read = declaredTerraformRoots(repo);
  if ("why" in read) return read;
  const binary = chantConfigBinary(readFileSync(join(repo, CHANT_CONFIG), "utf-8"));
  return { ...read, ...(binary ? { binary } : {}) };
}

/** The roots chant.config.ts at `repo`'s root declares, or why none can be read. */
export function declaredTerraformRoots(repo: string): { roots: Set<string> } | { why: string } {
  const path = join(repo, CHANT_CONFIG);
  if (!existsSync(path)) return { why: `${CHANT_CONFIG} is missing; terragucci init writes it with every root` };
  const roots = chantConfigRoots(readFileSync(path, "utf-8"));
  return roots ? { roots } : { why: `${CHANT_CONFIG} is not one terragucci can read the roots of without loading it` };
}
