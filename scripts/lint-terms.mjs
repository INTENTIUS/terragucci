// The chant and fountain words a Terraform reader does not know. A docs page
// that uses one has to define it or link where it is defined: the glossary's
// entry, or the page or site that is that word's home.
//   import { termProblems } from "./lint-terms.mjs"
import { readFileSync } from "node:fs";

const GLOSSARY = "docs-site/src/content/docs/concepts/glossary.md";

// `re` finds a use; `links` are the hrefs (substrings) that count as defining
// it; `defines` are pages that explain the word in their own text.
export const TERMS = [
  {
    term: "chant",
    // Not chant/lifecycle, chant.workspace.json, .chant/ or @intentius/chant: those are their own entries or a package name.
    re: /(?<![\w./@-])chant(?![\w/-]|\.\w)/,
    links: ["/terragucci/concepts/glossary/#chant", "https://intentius.io/chant/"],
  },
  {
    term: "fountain",
    re: /(?<![\w./-])fountain(?![\w-]|\.\w)/i,
    links: ["/terragucci/concepts/glossary/#fountain", "https://github.com/managoat/fountain"],
  },
  {
    term: "steward",
    re: /\bstewards?\b/i,
    links: ["/terragucci/concepts/glossary/#steward"],
  },
  {
    term: "floci",
    re: /\bfloci\b/i,
    links: ["/terragucci/concepts/glossary/#floci"],
    defines: ["docs-site/src/content/docs/tutorial/index.mdx"],
  },
  {
    term: "choudoufu",
    re: /\bchoudoufu\b/i,
    links: ["/terragucci/concepts/glossary/#choudoufu", "https://github.com/INTENTIUS/choudoufu", "/terragucci/guides/use-a-binary/#choudoufu"],
    defines: ["docs-site/src/content/docs/guides/use-a-binary.md"],
  },
  {
    term: "chant/lifecycle",
    re: /chant\/lifecycle/,
    links: ["/terragucci/concepts/glossary/#chantlifecycle", "/terragucci/concepts/approvals-as-records/"],
    defines: ["docs-site/src/content/docs/concepts/approvals-as-records.md"],
  },
  {
    term: "chant.workspace.json",
    re: /chant\.workspace\.json/,
    links: ["/terragucci/concepts/glossary/#chantworkspacejson"],
  },
  {
    term: "identity.gates",
    re: /identity\.gates/,
    links: ["/terragucci/concepts/glossary/#identitygates"],
  },
];

/**
 * One line per page that uses a term it neither defines nor links. The
 * front matter is left out; a word in a page's title is defined in its body.
 */
export function termProblems(files) {
  const problems = [];
  for (const file of files) {
    if (file === GLOSSARY || !file.startsWith("docs-site/")) continue;
    const whole = readFileSync(file, "utf8");
    const front = /^---\n[\s\S]*?\n---\n/.exec(whole)?.[0] ?? "";
    const raw = whole.slice(front.length);
    // Component tags, a screenshot's alt text among them, are not prose.
    const text = file.endsWith(".mdx") ? raw.replace(/^(import .*|<[A-Z][^>]*\/>)$/gm, "") : raw;
    for (const t of TERMS) {
      const m = t.re.exec(text);
      if (!m || t.defines?.includes(file) || t.links.some((l) => text.includes(`](${l}`) || text.includes(`href="${l}`))) continue;
      const line = front.split("\n").length - 1 + text.slice(0, m.index).split("\n").length;
      problems.push(`${file}:${line}: "${t.term}" is neither defined nor linked on this page; link ${t.links[0]}`);
    }
  }
  return problems;
}
