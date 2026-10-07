// The docs pages as the lint scripts read them.
//   import { DOCS, docPage, prose } from "./docs-pages.mjs"
import { existsSync } from "node:fs";

export const DOCS = "docs-site/src/content/docs/";

/**
 * A page named without its extension, "reference/config", as the file that
 * holds it: the .md or the .mdx. A page can move between the two without the
 * scripts that name it changing.
 */
export function docPage(name) {
  for (const ext of [".md", ".mdx"]) if (existsSync(DOCS + name + ext)) return DOCS + name + ext;
  throw new Error(`no page ${DOCS}${name}.md or .mdx`);
}

/** A page file's name without its extension, "reference/config", or undefined outside the docs. */
export function pageName(file) {
  return file.startsWith(DOCS) ? file.slice(DOCS.length).replace(/\.mdx?$/, "") : undefined;
}

/**
 * MDX import lines and component tag lines (<Tabs syncKey="forge">,
 * <TabItem label="GitHub">, </Steps>, <Shot ... />) are code, not prose: blank
 * them so line numbers still match the file.
 */
export function prose(text) {
  return text.replace(/^(import .*|[ \t]*<\/?[A-Z][^>]*\/?>[ \t]*)$/gm, "");
}
