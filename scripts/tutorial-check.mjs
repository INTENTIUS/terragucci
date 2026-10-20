// Keeps the tutorial and the guides honest. For every tutorial page and every
// guide that is not a draft:
//   - captures (<Captured step="…"> and <Recorded step="…" view="…">) appear on
//     tutorial pages only;
//   - a capture a tutorial page embeds without `optional` exists.
// Captures are taken by hand, when a page needs one, never as part of a change
// or a release. So an optional capture that was never taken, and a capture made
// from an older example/ (its source_hash does not match), are listed and do
// not fail the check; `--strict` fails on them.
// Draft pages and guides are skipped. Smoke claims hold no page back.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pages = join(root, "docs-site/src/content/docs/tutorial");
const data = join(root, "docs-site/src/data/tutorial");

// The same hash stack/tutorial-capture.sh writes: each file under example/,
// in byte order, as its path, a NUL, then its content. In the pipeline the
// image references are left out: a release moves them, and no capture shows
// them.
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === ".terraform") return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
function withoutImages(text) {
  return text
    .replace(/^# Every job runs in .*$/gm, "# Every job runs in the image")
    .replace(/ghcr\.io\/intentius\/terragucci-([a-z]+):[^\s"']+/g, "ghcr.io/intentius/terragucci-$1");
}
const hash = createHash("sha256");
for (const f of files(join(root, "example")).map((p) => relative(root, p)).sort()) {
  hash.update(f);
  hash.update("\0");
  hash.update(f.startsWith("example/.forgejo/") ? withoutImages(readFileSync(join(root, f), "utf8")) : readFileSync(join(root, f)));
}
const exampleHash = hash.digest("hex").slice(0, 16);
// `--hash` prints the example hash and stops: the capture scripts record it, so all three hash one way.
if (process.argv.includes("--hash")) {
  console.log(exampleHash);
  process.exit(0);
}

const strict = process.argv.includes("--strict");
const problems = [];
const stale = [];
const capture = (step) => {
  const file = join(data, `${step}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
// The github step is recorded on the sandbox on github.com, not on the stack.
const fix = (step) => (step === "github" ? "run just sandbox capture" : `run just capture ${step}`);

// The <Captured> and <Recorded> on one page. Only a tutorial page may hold them.
const pending = [];
function checkCaptures(label, text, tutorial) {
  const tags = [...text.matchAll(/<(Captured|Recorded)\s+step="([^"]+)"(?:\s+view="([^"]+)")?[^>]*>/g)];
  if (tags.length && !tutorial) { problems.push(`${label}: holds ${tags.length} capture(s); captures belong on tutorial pages only`); return; }
  for (const [tag, kind, step, view] of tags) {
    const what = kind === "Recorded" ? `view ${step} ${view}` : `capture ${step}`;
    const optional = /\soptional(\s|\/|>)/.test(tag);
    const c = capture(step);
    const missing = !c ? `no capture for step ${step}` : kind === "Recorded" && !c.views?.[view] ? `capture ${step} recorded no view ${view}` : "";
    if (missing) { (optional ? pending : problems).push(optional ? [step, `${label}: ${missing}; ${fix(step)}`] : `${label}: ${missing}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) stale.push([step, `${label}: ${what} was recorded from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`]);
  }
}

// A tutorial page, a guide, a concept or a standards page that is not a draft.
let checked = 0;
const guides = join(root, "docs-site/src/content/docs/guides");
const concepts = join(root, "docs-site/src/content/docs/concepts");
const standards = join(root, "docs-site/src/content/docs/standards");
function checkDir(dir, kind) {
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!/\.mdx?$/.test(name)) continue;
    const label = kind === "page" ? name : `${kind === "guide" ? "guides" : kind === "concept" ? "concepts" : "standards"}/${name}`;
    const text = readFileSync(join(dir, name), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (/^draft:\s*true\s*$/m.test(front)) {
      console.log(`draft ${label}`);
      continue;
    }
    checked++;
    checkCaptures(label, text, kind === "page");
    console.log(`ok    ${label}`);
  }
}
checkDir(pages, "page");
checkDir(guides, "guide");
checkDir(concepts, "concept");
checkDir(standards, "standards page");
// Every other page that embeds a capture or a recorded view.
const docs = join(root, "docs-site/src/content/docs");
for (const file of files(docs).filter((p) => p.endsWith(".mdx") && !p.startsWith(pages + "/") && !p.startsWith(guides + "/") && !p.startsWith(concepts + "/") && !p.startsWith(standards + "/")).sort()) {
  checkCaptures(relative(docs, file), readFileSync(file, "utf8"), false);
}
// Without --strict, one line names the stale steps; --strict fails on each page that shows one.
const steps = (list) => [...new Set(list.map(([step]) => step))].sort().join(", ");
if (strict) problems.push(...pending.map(([, p]) => p), ...stale.map(([, p]) => p));
else {
  if (pending.length) console.log(`not taken  optional captures, taken by hand when a page needs them (just capture <step>): ${steps(pending)}`);
  if (stale.length) console.log(`stale  captures from an older example/, refreshed by hand (just capture <step>, or just tutorial-capture): ${steps(stale)}`);
}
if (problems.length) {
  for (const p of new Set(problems)) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`tutorial: ${checked} published page(s) checked against example ${exampleHash}`);
