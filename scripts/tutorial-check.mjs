// Keeps the tutorial and the guides honest. For every tutorial page and every
// guide that is not a draft:
//   - every smoke claim it names in `claims:` passes in smoke.json;
//   - every <Captured step="…"> has a capture, made from the example as it is
//     now (its source_hash matches example/);
//   - every <Shot step="…" view="…"> has its light and dark screenshot, each
//     the one its step's capture recorded (the hash in <step>.json), from a
//     capture of the example as it is now.
// Draft pages and guides are skipped; they leave draft when their claims pass. Every
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
// A page's claims are the OpenTofu rows on Forgejo; a GitLab row carries forge: "gitlab", and a Terraform or choudoufu row binary.
const verdict = Object.fromEntries(smoke.claims.filter((c) => (c.forge ?? "forgejo") === "forgejo" && !c.binary).map((c) => [c.claim, c.verdict]));

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

const problems = [];
const shaOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
const capture = (step) => {
  const file = join(data, `${step}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
// The github step is shot on the sandbox on github.com, not on the stack.
const fix = (step) => (step === "github" ? "run just sandbox capture" : `run just capture ${step}`);

// The <Captured> and <Shot> on one page.
function checkCaptures(label, text) {
  for (const [, step] of text.matchAll(/<Captured\s+step="([^"]+)"/g)) {
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) problems.push(`${label}: capture ${step} was made from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`);
  }
  for (const [tag, step, view] of text.matchAll(/<Shot\s+step="([^"]+)"\s+view="([^"]+)"[^>]*>/g)) {
    // An optional shot (as the Shot component reads it) may be missing until its step is captured.
    const optional = /\soptional(\s|\/|>)/.test(tag);
    const c = capture(step);
    if (!c) { problems.push(`${label}: no capture for step ${step}, so no screenshot ${step}-${view}; ${fix(step)}`); continue; }
    if (c.source_hash !== exampleHash) problems.push(`${label}: screenshot ${step}-${view} was taken from example ${c.source_hash}, but example/ is now ${exampleHash}; ${fix(step)}`);
    for (const theme of ["light", "dark"]) {
      const png = join(shots, `${step}-${view}-${theme}.png`);
      const want = c.shots?.[`${view}-${theme}`];
      if (!existsSync(png)) { if (!optional) problems.push(`${label}: no screenshot ${step}-${view}-${theme}.png; ${fix(step)}`); }
      else if (!want) problems.push(`${label}: capture ${step} records no screenshot ${view}-${theme}; ${fix(step)}`);
      else if (shaOf(png) !== want) problems.push(`${label}: ${step}-${view}-${theme}.png is not the screenshot capture ${step} took; ${fix(step)}`);
    }
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
// Every other page that embeds a capture or a screenshot.
const docs = join(root, "docs-site/src/content/docs");
for (const file of files(docs).filter((p) => p.endsWith(".mdx") && !p.startsWith(pages + "/") && !p.startsWith(guides + "/") && !p.startsWith(concepts + "/") && !p.startsWith(standards + "/")).sort()) {
  checkCaptures(relative(docs, file), readFileSync(file, "utf8"));
}
if (problems.length) {
  for (const p of new Set(problems)) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`tutorial: ${checked} published page(s) checked against example ${exampleHash}`);
