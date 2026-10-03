// Scores the repo's prose with the `sentences` linter, as knr-ops-kit does.
//   node scripts/lint-docs.mjs [strictness 1-3] [max score per file]
// Exits 1 when any file scores above the limit. VERBOSE=1 prints every finding.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintDocument } from "sentences/lint/run";

const strictness = Number(process.argv[2] ?? 2);
const limit = Number(process.argv[3] ?? 8);
const roots = ["README.md", "AGENTS.md", "docs-site/src/content/docs"];

function collect(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((entry) => collect(join(path, entry)))
    .filter((f) => /\.mdx?$/.test(f));
}

const files = roots.flatMap(collect);
let failed = false;
for (const file of files) {
  // MDX import lines and component tags are code, not prose; blank them so
  // line numbers still match the file.
  const raw = readFileSync(file, "utf8");
  const text = file.endsWith(".mdx")
    ? raw.replace(/^(import .*|<[A-Z]\w* *\/>)$/gm, "")
    : raw;
  const report = lintDocument(text, { markdown: true, strictness });
  const score = report.score.total;
  const over = score > limit;
  failed ||= over;
  console.log(`${over ? "FAIL" : "ok  "} ${score.toFixed(1).padStart(5)}  ${file}`);
  if (over || process.env.VERBOSE) {
    for (const f of report.findings) {
      const line = text.slice(0, f.span.start).split("\n").length;
      console.log(`       L${line} [${f.ruleId}/${f.severity}] ${f.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
