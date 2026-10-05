// Keeps the tutorial honest. For every tutorial page that is not a draft:
//   - every smoke claim it names in `claims:` passes in smoke.json;
//   - every <Captured step="…"> has a capture, made from the example as it is
//     now (its source_hash matches example/);
//   - every <Shot step="…" view="…"> has both its light and dark screenshot.
// Draft pages are skipped; they leave draft when their claims pass.
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
  for (const [, step] of text.matchAll(/<Captured\s+step="([^"]+)"/g)) {
    const file = join(data, `${step}.json`);
    if (!existsSync(file)) { problems.push(`${name}: no capture for step ${step}`); continue; }
    const got = JSON.parse(readFileSync(file, "utf8")).source_hash;
    if (got !== exampleHash) problems.push(`${name}: capture ${step} was made from example ${got}, but example/ is now ${exampleHash}; run just tutorial-capture`);
  }
  for (const [, step, view] of text.matchAll(/<Shot\s+step="([^"]+)"\s+view="([^"]+)"/g)) {
    for (const theme of ["light", "dark"]) {
      if (!existsSync(join(shots, `${step}-${view}-${theme}.png`))) problems.push(`${name}: no screenshot ${step}-${view}-${theme}.png`);
    }
  }
  console.log(`ok    ${name}`);
}
// Guides that embed a capture are held to the same rule: the capture exists
// and was made from the example as it is now.
const guides = join(root, "docs-site/src/content/docs/guides");
for (const name of existsSync(guides) ? readdirSync(guides).sort() : []) {
  if (!name.endsWith(".mdx")) continue;
  const text = readFileSync(join(guides, name), "utf8");
  for (const [, step] of text.matchAll(/<Captured\s+step="([^"]+)"/g)) {
    const file = join(data, `${step}.json`);
    if (!existsSync(file)) { problems.push(`guides/${name}: no capture for step ${step}; run just tutorial-capture`); continue; }
    const got = JSON.parse(readFileSync(file, "utf8")).source_hash;
    if (got !== exampleHash) problems.push(`guides/${name}: capture ${step} was made from example ${got}, but example/ is now ${exampleHash}; run just tutorial-capture`);
  }
}
if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`tutorial: ${checked} published page(s) checked against example ${exampleHash}`);
