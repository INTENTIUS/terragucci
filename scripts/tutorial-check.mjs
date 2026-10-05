// Keeps the tutorial honest. For every tutorial page that is not a draft:
//   - every smoke claim it names in `claims:` passes in smoke.json;
//   - every <Captured step="…"> has a capture, made from the example as it is
//     now (its source_hash matches example/);
//   - every <Shot step="…" view="…"> has its light and dark screenshot, each
//     the one its step's capture recorded (the hash in <step>.json), from a
//     capture of the example as it is now.
// Draft pages are skipped; they leave draft when their claims pass. Every
// other page of the site that embeds a capture or a screenshot is held to the
// same capture rules.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pages = join(root, "docs-site/src/content/docs/tutorial");
const data = join(root, "docs-site/src/data/tutorial");
const shots = join(root, "docs-site/src/assets/tutorial");
const smoke = JSON.parse(readFileSync(join(root, "docs-site/src/data/smoke.json"), "utf8"));
const verdict = Object.fromEntries(smoke.claims.map((c) => [c.claim, c.verdict]));

// The same hash stack/tutorial-capture.sh writes: each file under example/,
// in byte order, as its path, a NUL, then its content.
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === ".terraform") return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const hash = createHash("sha256");
for (const f of files(join(root, "example")).map((p) => relative(root, p)).sort()) {
  hash.update(f);
  hash.update("\0");
  hash.update(readFileSync(join(root, f)));
}
const exampleHash = hash.digest("hex").slice(0, 16);

const problems = [];
const shaOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
const capture = (step) => {
  const file = join(data, `${step}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
const fix = (step) => `run just capture ${step}`;

// The <Captured> and <Shot> on one page.
function checkCaptures(label, text) {
  for (const [, step] of text.matchAll(/<Captured\s+step="([^"]+)"/g)) {
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) problems.push(`${label}: capture ${step} was made from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`);
  }
  for (const [, step, view] of text.matchAll(/<Shot\s+step="([^"]+)"\s+view="([^"]+)"/g)) {
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}, so no screenshot ${step}-${view}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) problems.push(`${label}: screenshot ${step}-${view} was taken from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`);
    for (const theme of ["light", "dark"]) {
      const png = join(shots, `${step}-${view}-${theme}.png`);
      const want = c.shots?.[`${view}-${theme}`];
      if (!existsSync(png)) problems.push(`${label}: no screenshot ${step}-${view}-${theme}.png; ${fix(step)}`);
      else if (!want) problems.push(`${label}: capture ${step} records no screenshot ${view}-${theme}; ${fix(step)}`);
      else if (shaOf(png) !== want) problems.push(`${label}: ${step}-${view}-${theme}.png is not the screenshot capture ${step} took; ${fix(step)}`);
    }
  }
}

let checked = 0;
for (const name of existsSync(pages) ? readdirSync(pages).sort() : []) {
  if (!/\.mdx?$/.test(name)) continue;
  const text = readFileSync(join(pages, name), "utf8");
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  if (/^draft:\s*true\s*$/m.test(front)) {
    console.log(`draft ${name}`);
    continue;
  }
  checked++;
  const claims = (front.match(/^claims:\s*\[(.*)\]\s*$/m)?.[1] ?? "")
    .split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
  for (const c of claims) {
    if (verdict[c] !== "pass") problems.push(`${name}: claim ${c} is ${verdict[c] ?? "unknown"}, so the page must stay a draft`);
  }
  checkCaptures(name, text);
  console.log(`ok    ${name}`);
}
// Every other page that embeds a capture or a screenshot.
const docs = join(root, "docs-site/src/content/docs");
for (const file of files(docs).filter((p) => p.endsWith(".mdx") && !p.startsWith(pages + "/")).sort()) {
  checkCaptures(relative(docs, file), readFileSync(file, "utf8"));
}
if (problems.length) {
  for (const p of new Set(problems)) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`tutorial: ${checked} published page(s) checked against example ${exampleHash}`);
