// Keeps the tutorial and the guides honest. For every tutorial page and every
// guide that is not a draft:
//   - every smoke claim it names in `claims:` passes in smoke.json;
//   - every <Captured step="…"> has a capture;
//   - every <Recorded step="…" view="…"> has that view in its step's capture.
// A capture made from an older example/ (its source_hash does not match) is
// stale. Captures are refreshed by hand, never as part of a change or a release,
// so a stale one is listed and does not fail the check; `--strict` fails on it.
// Draft pages and guides are skipped; they leave draft when their claims pass. Every
// other page of the site that embeds a capture or a recorded view is held to the
// same capture rules.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pages = join(root, "docs-site/src/content/docs/tutorial");
const data = join(root, "docs-site/src/data/tutorial");
const smoke = JSON.parse(readFileSync(join(root, "docs-site/src/data/smoke.json"), "utf8"));
// A page's claims are the OpenTofu rows on Forgejo; a Terraform or choudoufu row carries binary, and a
// GitLab row forge: "gitlab", which counts for a claim that runs on GitLab alone (no Forgejo row of its name).
const forgejoRows = smoke.claims.filter((c) => (c.forge ?? "forgejo") === "forgejo" && !c.binary);
const verdict = Object.fromEntries([
  ...smoke.claims.filter((c) => c.forge === "gitlab" && !forgejoRows.some((f) => f.claim === c.claim)).map((c) => [c.claim, c.verdict]),
  ...forgejoRows.map((c) => [c.claim, c.verdict]),
]);

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

// The <Captured> and <Recorded> on one page.
function checkCaptures(label, text) {
  for (const [, step] of text.matchAll(/<Captured\s+step="([^"]+)"/g)) {
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) stale.push([step, `${label}: capture ${step} was made from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`]);
  }
  for (const [, step, view] of text.matchAll(/<Recorded\s+step="([^"]+)"\s+view="([^"]+)"[^>]*>/g)) {
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}, so no view ${view}; ${fix(step)}`); continue; }
    if (!c.views?.[view]) { problems.push(`${label}: capture ${step} recorded no view ${view}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) stale.push([step, `${label}: view ${step} ${view} was recorded from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`]);
  }
}

// A tutorial page, a guide, a concept or a standards page. A published one names its smoke
// claims in `claims:`, and each must pass. A guide must carry the line:
// `claims: []` says that no recorded claim backs it.
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
    const line = front.match(/^claims:\s*\[(.*)\]\s*$/m);
    if (!line && kind === "guide") problems.push(`${label}: no claims: line; list the smoke claims that back it, or write claims: [] when none does`);
    const claims = (line?.[1] ?? "")
      .split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    for (const c of claims) {
      if (verdict[c] !== "pass") problems.push(`${label}: claim ${c} is ${verdict[c] ?? "unknown"}, so the ${kind} must stay a draft`);
    }
    checkCaptures(label, text);
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
  checkCaptures(relative(docs, file), readFileSync(file, "utf8"));
}
// Without --strict, one line names the stale steps; --strict fails on each page that shows one.
if (strict) problems.push(...stale.map(([, p]) => p));
else if (stale.length) console.log(`stale  captures from an older example/, refreshed by hand (just capture <step>, or just tutorial-capture): ${[...new Set(stale.map(([step]) => step))].sort().join(", ")}`);
if (problems.length) {
  for (const p of new Set(problems)) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`tutorial: ${checked} published page(s) checked against example ${exampleHash}`);
