// Scores the repo's prose with the `sentences` linter, as knr-ops-kit does.
//   node scripts/lint-docs.mjs [strictness 1-3] [max score per file]
// Exits 1 when any file scores above the limit. VERBOSE=1 prints every finding.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintDocument } from "sentences/lint/run";
import { termProblems } from "./lint-terms.mjs";
import { promptProblems } from "./lint-prompts.mjs";
import { DOCS, docPage, prose } from "./docs-pages.mjs";

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

// Tips: chant's rules in CODE_RULES and terragucci's own rule ids.
{
  const src = read("packages/terragucci/src/tips/index.ts");
  const codeBlock = src.slice(src.indexOf("export const CODE_RULES"), src.indexOf("};", src.indexOf("export const CODE_RULES")));
  const file = docPage("reference/tips");
  const page = read(file);
  missing("code rule", new Set(codeBlock.match(/\bTF\d{3}(?=:)/g)), new Set([...page.matchAll(/^\| \[(TF\d{3})\]/gm)].map((m) => m[1])), file);
  missing("rollout rule", new Set(src.match(/"terragucci-[a-z-]+"/g).map((m) => m.slice(1, -1))), new Set([...page.matchAll(/^### (terragucci-[a-z-]+)$/gm)].map((m) => m[1])), file);
}

// Metrics: the names in dashboards/names.ts against the metrics table.
{
  const names = read("packages/terragucci/src/dashboards/names.ts");
  const file = docPage("reference/observability");
  const page = read(file);
  const table = page.slice(page.indexOf("| Metric | Labels"), page.indexOf("\n\n", page.indexOf("| Metric | Labels")));
  missing("metric", new Set(names.match(/"terragucci_[a-z_]+"/g).map((m) => m.slice(1, -1))), new Set(table.match(/`terragucci_[a-z_]+`/g).map((m) => m.slice(1, -1))), file);
}

// Dashboards: the files the renderer writes against every "<number> dashboards" in the docs.
// The docs are written in American English: a British spelling is a finding.
{
  const british = { licence: "license", behaviour: "behavior", colour: "color", favour: "favor", organisation: "organization", catalogue: "catalog", centre: "center", honour: "honor", defence: "defense" };
  const re = new RegExp(`\\b(${Object.keys(british).join("|")})(s|d)?\\b`, "gi");
  for (const file of ["README.md", "AGENTS.md", "packages/terragucci/README.md", ...collect(DOCS.slice(0, -1))]) {
    for (const m of read(file).matchAll(re)) problems.push(`${file}: "${m[0]}" is British spelling; write "${british[m[1].toLowerCase()]}${m[2] ?? ""}"`);
  }
}

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
  const file = docPage("reference/report-schema");
  const page = read(file);
  const named = (name) => new RegExp("`(?:run\\.)?" + name + "(?:\\[\\])?[`.,]|`[a-z_.]*, `(?:run\\.)?" + name + "(?:\\[\\])?`").test(page) || page.includes("`" + name + "`");
  const inRunRow = new Set(["project", "commit", "base", "stage", "binary", "runtime", "started", "finished", "job_url"]);
  for (const name of Object.keys(schema.properties)) if (!named(name)) problems.push(`${file}: top-level field ${name} is in report.schema.json and not on the page`);
  for (const name of Object.keys(schema.properties.run.properties)) {
    if (!inRunRow.has(name) && !page.includes("`run." + name + "`") && !page.includes("`" + name + "`")) problems.push(`${file}: run.${name} is in report.schema.json and not on the page`);
  }
}

// The reader contracts: every index row field and every top-level estate field is on report-schema.md,
// every audit entry field on audit-trail.mdx, and each schema file the package ships on reports-bucket.mdx.
{
  const schema = (name) => JSON.parse(read(`packages/terragucci/src/report/${name}`));
  const on = (page, name) => page.includes("`" + name + "`") || page.includes("`" + name + "[]`");
  const fields = [
    ["reference/report-schema", "report-index.schema.json", (s) => s.$defs.row.properties],
    ["reference/report-schema", "estate.schema.json", (s) => s.properties],
    ["reference/audit-trail", "audit.schema.json", (s) => s.properties],
  ];
  for (const [name, file, props] of fields) {
    const page = docPage(name);
    const text = read(page);
    for (const field of Object.keys(props(schema(file)))) if (!on(text, field)) problems.push(`${page}: ${field} is in ${file} and not on the page`);
  }
  const bucketPage = docPage("reference/reports-bucket");
  const layout = read(bucketPage);
  for (const file of readdirSync("packages/terragucci/src/report").filter((f) => f.endsWith(".schema.json"))) {
    if (!layout.includes("`dist/" + file + "`")) problems.push(`${bucketPage}: the package ships dist/${file} and the page does not name it`);
  }
}

// Every page is true as written: no roadmap words, and no mention of Temporal. Held over the site's
// source, the READMEs and the package's source, whose messages reach a user's terminal.
{
  const ROADMAP = /being built|not built|in development|planned after|roadmap|coming soon|temporal/i;
  const walk = (path) => (statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((e) => walk(join(path, e))) : [path]);
  for (const file of ["docs-site/src", "README.md", "packages/terragucci/src", "packages/terragucci/README.md"].flatMap(walk)) {
    if (!/\.(mdx?|astro|ts|mjs|js|json|css)$/.test(file)) continue;
    read(file).split("\n").forEach((line, i) => {
      const m = ROADMAP.exec(line);
      if (m) problems.push(`${file}:${i + 1}: "${m[0]}"; say what is true now, and never name Temporal`);
    });
  }
}

// A reader approves with `terragucci approve`, which runs chant itself. Prose that tells a reader to
// run `chant approve` sends them to a second install; only the upgrade note on the what's-new page
// names it. Recorded tool output (docs-site/src/data) quotes what a run printed and is not prose.
{
  const walk = (path) => (statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((e) => walk(join(path, e))) : [path]);
  for (const file of ["README.md", ...walk("docs-site/src/content"), ...walk("docs-site/src/components")]) {
    if (!/\.(mdx?|astro)$/.test(file) || file.endsWith("reference/whats-new.mdx")) continue;
    read(file).split("\n").forEach((line, i) => {
      if (/chant approve/.test(line)) problems.push(`${file}:${i + 1}: "chant approve"; a reader runs \`terragucci approve\``);
    });
  }
}

for (const p of problems) console.log(`FAIL  ${p}`);

const files = roots.flatMap(collect);
let failed = problems.length > 0;
for (const file of files) {
  // MDX import lines and component tag lines are code, not prose.
  // "CI does this:" is the positioning line the README, getting started and the landing page lead
  // with, by ruling. The linter reads it as a colon reveal; blank that exact phrase (same length, so
  // line numbers hold) and lint the sentence after it.
  const text = prose(readFileSync(file, "utf8")).replace(/^CI does this: (\w)/gm, (m, c) => " ".repeat(m.length - 1) + c.toUpperCase());
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
// A page title and a heading are short noun phrases: "Prerequisites", not "Before you start"; "Report storage", not
// "Where reports are kept". A heading that opens with a question word or ends with "?" fails.
for (const problem of headingProblems(files)) {
  failed = true;
  console.log(`FAIL heading  ${problem}`);
}
// A chant or fountain word on a page that neither defines nor links it.
for (const problem of termProblems(files)) {
  failed = true;
  console.log(`FAIL term  ${problem}`);
}
// Each page prompt ("Optional: hand this page to your coding agent") names its page and forbids apply, approve and merge.
for (const problem of promptProblems(files)) {
  failed = true;
  console.log(`FAIL prompt  ${problem}`);
}
process.exit(failed ? 1 : 0);

function headingProblems(paths) {
  const out = [];
  for (const file of paths) {
    let fence = false;
    const text = readFileSync(file, "utf8");
    const title = /^---\n(?:[\s\S]*?\n)?title: *(["']?)(.+?)\1 *\n[\s\S]*?\n---/.exec(text)?.[2];
    if (title && (/^(what|how|why|when|where|who)\b/i.test(title) || title.endsWith("?"))) {
      out.push(`${file}: title "${title}"; name the page with a short noun phrase, not a question or a what/how/why/when/where/who clause`);
    }
    text.split("\n").forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (m && (/^(what|how|why|when|where|who)\b/i.test(m[1]) || m[1].endsWith("?"))) {
        out.push(`${file}:${i + 1}: "${m[1]}"; name the section with a short noun phrase, not a question or a what/how/why/when/where/who clause`);
      }
    });
  }
  return out;
}
