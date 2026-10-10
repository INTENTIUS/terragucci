// What is left to fill on the validation page, and how: every grid cell that is
// not proven (from docs-site/src/data/coverage.ts, the code the grids render
// with), every claim a claim table defines that has no recorded row, and every
// recorded capture that still prints a command terragucci no longer prints.
// It reads files only and runs nothing; `just coverage-fill` runs the fills.
//   npx tsx scripts/coverage-gaps.ts [--json]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gaps } from "../docs-site/src/data/coverage";

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The lines of a single-quoted shell table NAME='...'. */
function table(file: string, name: string): string[] {
  const src = read(file);
  const start = src.indexOf(`\n${name}='`);
  if (start < 0) return [];
  const body = src.slice(start + name.length + 3);
  return body.slice(0, body.indexOf("'")).split("\n").filter((l) => l.trim() !== "");
}

type Rec = { claim: string; forge?: string; binary?: string; verdict: string };
const smoke = (JSON.parse(read("docs-site/src/data/smoke.json")) as { claims: Rec[] }).claims;
const validation = (JSON.parse(read("docs-site/src/data/validation.json")) as { claims: (Rec & { forge: string })[] }).claims;

// A claim defined in a table with no row from the recorder that runs it.
type Unrecorded = { claim: string; where: string; fill: string };
const unrecorded: Unrecorded[] = [];
const forgejo = new Set(smoke.filter((r) => !r.forge && !r.binary).map((r) => r.claim));
for (const l of table("stack/smoke.sh", "CLAIMS")) {
  const n = l.split("|")[0]!;
  if (!forgejo.has(n)) unrecorded.push({ claim: n, where: "CLAIMS in stack/smoke.sh", fill: `just claims ${n}` });
}
const gitlab = new Set(smoke.filter((r) => r.forge === "gitlab").map((r) => r.claim));
for (const l of table("stack/smoke-gitlab.sh", "GITLAB_CLAIMS")) {
  const n = l.split("|")[0]!;
  if (!gitlab.has(n)) unrecorded.push({ claim: n, where: "GITLAB_CLAIMS in stack/smoke-gitlab.sh", fill: `just gitlab-claims '${n}'` });
}
const byForge = (f: string) => new Set(validation.filter((r) => r.forge === f).map((r) => r.claim));
for (const l of table("stack/validation.sh", "CLAIMS")) {
  const [f, n] = l.split("|");
  if (!byForge(f!).has(n!)) unrecorded.push({ claim: `${f}/${n}`, where: "CLAIMS in stack/validation.sh", fill: `just validation-record ${f}` });
}
const githubCom = byForge("github.com");
for (const l of table("stack/sandbox-github.sh", "PROVE_CLAIMS")) {
  const n = l.split("|")[1]!;
  if (!githubCom.has(n)) unrecorded.push({ claim: `github.com/${n}`, where: "PROVE_CLAIMS in stack/sandbox-github.sh", fill: "just sandbox prove --record docs-site/src/data/validation.json" });
}
const pending = [...smoke, ...validation].filter((r) => r.verdict === "pending").map((r) => r.claim);

// A capture that quotes a command readers no longer run: recorded before the
// product changed what it prints. Each source has its own capture command.
const STALE = [/\bchant approve\b/];
const CAPTURED_BY: Record<string, string> = {
  github: "just sandbox capture (the github.com sandbox)",
  gitlab: "stack/example-gitlab.sh capture (the GitLab lab)",
};
type Stale = { file: string; quotes: string; fill: string };
const stale: Stale[] = [];
const dir = "docs-site/src/data/tutorial";
for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".json")).sort()) {
  const text = read(`${dir}/${f}`);
  const hit = STALE.map((re) => re.exec(text)?.[0]).find(Boolean);
  if (!hit) continue;
  const step = f.replace(/\.json$/, "");
  stale.push({ file: `${dir}/${f}`, quotes: hit, fill: CAPTURED_BY[step] ?? `just capture ${step}` });
}

const cells = gaps();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ cells, unrecorded, pending, stale }, null, 2));
  process.exit(0);
}

console.log(`Grid cells not proven: ${cells.length}`);
const byFill = new Map<string, typeof cells>();
for (const g of cells) byFill.set(g.fill.replace(/'[^']*'/, "<names>"), [...(byFill.get(g.fill.replace(/'[^']*'/, "<names>")) ?? []), g]);
for (const [fill, list] of byFill) {
  console.log(`\n  ${fill}`);
  for (const g of list) {
    const names = g.claims.length ? `: ${g.claims.slice(0, 6).join(", ")}${g.claims.length > 6 ? `, and ${g.claims.length - 6} more` : ""}` : "";
    console.log(`    ${g.column} x ${g.area} (${g.state})${names}`);
  }
}
console.log(`\nClaims defined with no recorded row: ${unrecorded.length}`);
for (const u of unrecorded) console.log(`  ${u.claim}  (${u.where})  ->  ${u.fill}`);
if (pending.length) console.log(`\nPending rows: ${pending.join(", ")}`);
console.log(`\nCaptures that quote a command terragucci no longer prints: ${stale.length}`);
for (const s of stale) console.log(`  ${s.file} quotes "${s.quotes}"  ->  ${s.fill}`);
