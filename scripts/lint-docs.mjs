// Scores the repo's prose with the `sentences` linter, as knr-ops-kit does.
//   node scripts/lint-docs.mjs [strictness 1-3] [max score per file]
// Exits 1 when any file scores above the limit. VERBOSE=1 prints every finding.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintDocument } from "sentences/lint/run";

const strictness = Number(process.argv[2] ?? 2);
const limit = Number(process.argv[3] ?? 8);
const roots = ["README.md", "AGENTS.md", "packages/terragucci/README.md", "docs-site/src/content/docs"];

function collect(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((entry) => collect(join(path, entry)))
    .filter((f) => /\.mdx?$/.test(f));
}

// The reference pages list things the code defines. Each list is read from the code and held to
// its page, so a rule, a metric, a dashboard or a schema field added without its docs fails here.
const read = (path) => readFileSync(path, "utf8");
const problems = [];
const missing = (what, expected, found, page) => {
  for (const name of expected) if (!found.has(name)) problems.push(`${page}: ${what} ${name} is in the code and not on the page`);
  for (const name of found) if (!expected.has(name)) problems.push(`${page}: ${what} ${name} is on the page and not in the code`);
};
const DOCS = "docs-site/src/content/docs/";

// Tips: chant's rules in CODE_RULES and terragucci's own rule ids.
{
  const src = read("packages/terragucci/src/tips/index.ts");
  const codeBlock = src.slice(src.indexOf("export const CODE_RULES"), src.indexOf("};", src.indexOf("export const CODE_RULES")));
  const page = read(DOCS + "reference/tips.mdx");
  missing("code rule", new Set(codeBlock.match(/\bTF\d{3}(?=:)/g)), new Set([...page.matchAll(/^\| \[(TF\d{3})\]/gm)].map((m) => m[1])), "tips.mdx");
  missing("rollout rule", new Set(src.match(/"terragucci-[a-z-]+"/g).map((m) => m.slice(1, -1))), new Set([...page.matchAll(/^### (terragucci-[a-z-]+)$/gm)].map((m) => m[1])), "tips.mdx");
}

// Metrics: the names in dashboards/names.ts against the metrics table.
{
  const names = read("packages/terragucci/src/dashboards/names.ts");
  const page = read(DOCS + "reference/observability.mdx");
  const table = page.slice(page.indexOf("| Metric | Labels"), page.indexOf("\n\n", page.indexOf("| Metric | Labels")));
  missing("metric", new Set(names.match(/"terragucci_[a-z_]+"/g).map((m) => m.slice(1, -1))), new Set(table.match(/`terragucci_[a-z_]+`/g).map((m) => m.slice(1, -1))), "observability.mdx");
}

// Dashboards: the files the renderer writes against every "<number> dashboards" in the docs.
{
  const rendered = JSON.parse(read("packages/terragucci/src/dashboards/rendered.json"));
  const count = new Set(rendered.files.map((f) => f.path).filter((p) => /^grafana\/dashboards\/.+\.json$/.test(p))).size;
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
  for (const file of ["README.md", "packages/terragucci/README.md", ...collect(DOCS.slice(0, -1))]) {
    for (const m of read(file).matchAll(/\b(\w+) (?:Grafana )?dashboards\b/gi)) {
      const n = words.indexOf(m[1].toLowerCase()) + 1;
      if (n > 0 && n !== count) problems.push(`${file}: says ${m[1]} dashboards and the renderer writes ${count}`);
    }
  }
}

// Report schema: every top-level field and run field of report.schema.json is on report-schema.md.
{
  const schema = JSON.parse(read("packages/terragucci/src/report/report.schema.json"));
  const page = read(DOCS + "reference/report-schema.md");
  const named = (name) => new RegExp("`(?:run\\.)?" + name + "(?:\\[\\])?[`.,]|`[a-z_.]*, `(?:run\\.)?" + name + "(?:\\[\\])?`").test(page) || page.includes("`" + name + "`");
  const inRunRow = new Set(["project", "commit", "base", "stage", "binary", "runtime", "started", "finished", "job_url"]);
  for (const name of Object.keys(schema.properties)) if (!named(name)) problems.push(`report-schema.md: top-level field ${name} is in report.schema.json and not on the page`);
  for (const name of Object.keys(schema.properties.run.properties)) {
    if (!inRunRow.has(name) && !page.includes("`run." + name + "`") && !page.includes("`" + name + "`")) problems.push(`report-schema.md: run.${name} is in report.schema.json and not on the page`);
  }
}

for (const p of problems) console.log(`FAIL  ${p}`);

const files = roots.flatMap(collect);
let failed = problems.length > 0;
for (const file of files) {
  // MDX import lines and component tags are code, not prose; blank them so
  // line numbers still match the file.
  const raw = readFileSync(file, "utf8");
  const text = file.endsWith(".mdx")
    ? raw.replace(/^(import .*|<[A-Z][^>]*\/>)$/gm, "")
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
