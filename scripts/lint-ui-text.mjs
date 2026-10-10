// Scores the prose the home page's components and the rooms data carry, which
// lint-docs.mjs does not read: each quoted string of four words or more that is
// not a link label, and each text node of an .astro template, one per paragraph.
//   node scripts/lint-ui-text.mjs [strictness 1-3] [max score per file]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintDocument } from "sentences/lint/run";

const strictness = Number(process.argv[2] ?? 2);
const limit = Number(process.argv[3] ?? 8);
const files = ["Landing.astro", "DoorPicker.astro", "Room.astro", "Limits.astro"].map((f) => join("docs-site/src/components", f)).concat("docs-site/src/data/rooms.ts");

// A string with at least four words reads as prose; shorter ones are labels and keys.
const prose = (s) => s.split(/\s+/).length >= 4 && /[a-z]/.test(s) && !/^[./#@$]|https?:|=>|\$\{/.test(s);
function strings(text) {
  const out = [];
  for (const m of text.matchAll(/(label: )?(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g)) {
    if (m[1]) continue;
    const s = (m[2] ?? m[3]).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (prose(s)) out.push(s);
  }
  // Template text: what sits between tags, outside the frontmatter, scripts and styles.
  const body = text.replace(/^---[\s\S]*?\n---/, "").replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  for (const m of body.matchAll(/>([^<>{}]+)</g)) {
    const s = m[1].replace(/\s+/g, " ").trim();
    if (prose(s)) out.push(s);
  }
  return [...new Set(out)];
}

let failed = false;
for (const file of files) {
  const found = strings(readFileSync(file, "utf8"));
  if (!found.length) continue;
  // "CI does this:" is the ruled positioning line, blanked as lint-docs.mjs blanks it.
  const text = found.map((s) => (/[.:;!?]$/.test(s) ? s : `${s}.`)).join("\n\n").replace(/^CI does this: (\w)/gm, (m, c) => c.toUpperCase());
  const report = lintDocument(text, { markdown: true, strictness });
  const score = report.score.total;
  const over = score > limit;
  failed ||= over;
  console.log(`${over ? "FAIL" : "ok  "} ${score.toFixed(1).padStart(5)}  ${file}`);
  if (over || process.env.VERBOSE) {
    for (const f of report.findings) console.log(`       [${f.ruleId}/${f.severity}] ${f.message}: "${text.slice(f.span.start, f.span.end).slice(0, 90)}"`);
  }
}
process.exit(failed ? 1 : 0);
