// The prompt-driven demos read as one set (terragucci#1269): a scenario's ask.json beside the choudoufu demo's
// (example-demo-choudoufu-compose) has the same moments in the same order, the same number of asks at each, and
// the same prompts word for word. Everything else on screen (opening, replies, statuses, closing, the about.json
// card) may name its own subject: estates, stacks or roots, and its own tool. differences() lists, once those
// subject words are put as one word, what still differs, so a reader can see it is only the subject.
//
// Usage: node scripts/demo-asks.mjs <scenarios dir> [<scenarios dir> ...]
// Each dir holds <tool>-compose-edit and <tool>-compose-create; each is compared with the choudoufu demo's.
// Exits 1 when a moment or a prompt differs; prints the remaining differences either way.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The choudoufu demo's scenarios, the set the others match. */
export const REFERENCE = "example-demo-choudoufu-compose/scenarios";

/** Words that name a demo's subject or tool, each put as one word before two strings are compared. */
const SUBJECT = [
  [/\b(estates|stacks|roots|states)\b/gi, "<units>"],
  [/\b(estate|stack|root|state)\b/gi, "<unit>"],
  [/\b(CloudFormation|Terraform|OpenTofu|choudoufu|chant|terragucci)\b/g, "<tool>"],
];

export const subjectless = (s) => SUBJECT.reduce((t, [re, to]) => t.replace(re, to), s);

/** A scenario's asks by moment: each moment's entries, a list even when the file gives one. */
function moments(ask) {
  const out = [];
  for (const [k, v] of Object.entries(ask)) {
    if (typeof v === "string") out.push({ moment: k, text: v, asks: [] });
    else out.push({ moment: k, asks: Array.isArray(v) ? v : [v] });
  }
  return out;
}

/** The strings an ask puts on screen besides its prompt, by field. Diffs and lights name the scenario's own resources and are left out. */
const shown = (a) => Object.fromEntries(["reply", "status", "action"].flatMap((f) => (typeof a?.[f] === "string" ? [[f, a[f]]] : [])));

/** What makes two scenarios not one set: a moment or a prompt that differs. Empty when they match. */
export function problems(ref, other, label = "") {
  const out = [];
  const a = moments(ref);
  const b = moments(other);
  const names = (m) => m.map((x) => x.moment).join(", ");
  if (names(a) !== names(b)) return [`${label}moments ${names(b)}, not ${names(a)}`];
  for (let i = 0; i < a.length; i++) {
    if (a[i].asks.length !== b[i].asks.length) out.push(`${label}${a[i].moment}: ${b[i].asks.length} asks, not ${a[i].asks.length}`);
    for (let j = 0; j < Math.min(a[i].asks.length, b[i].asks.length); j++) {
      const p = a[i].asks[j]?.prompt ?? null;
      const q = b[i].asks[j]?.prompt ?? null;
      if (p !== q) out.push(`${label}${a[i].moment}[${j}]: prompt ${JSON.stringify(q)}, not ${JSON.stringify(p)}`);
    }
  }
  return out;
}

/** Every other on-screen string that still differs once the subject words are one word: where, and both texts. */
export function differences(ref, other, label = "") {
  const out = [];
  const a = moments(ref);
  const b = moments(other);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].text !== undefined || b[i].text !== undefined) {
      if (subjectless(a[i].text ?? "") !== subjectless(b[i].text ?? "")) out.push({ where: `${label}${a[i].moment}`, reference: a[i].text ?? "", other: b[i].text ?? "" });
      continue;
    }
    for (let j = 0; j < Math.min(a[i].asks.length, b[i].asks.length); j++) {
      const x = shown(a[i].asks[j]);
      const y = shown(b[i].asks[j]);
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (subjectless(x[f] ?? "") !== subjectless(y[f] ?? "")) out.push({ where: `${label}${a[i].moment}[${j}].${f}`, reference: x[f] ?? "", other: y[f] ?? "" });
      }
    }
  }
  return out;
}

/** The act a scenario directory plays: `edit` or `create`, from its name. */
const act = (name) => name.match(/-(edit|create)$/)?.[1];

/** Compare every scenario under `dir` with the reference scenario of its act, under the repo at `root`. */
export function compareDir(dir, root = ".") {
  const ref = join(root, REFERENCE);
  const refs = Object.fromEntries(readdirSync(ref).flatMap((n) => (act(n) && existsSync(join(ref, n, "ask.json")) ? [[act(n), join(ref, n, "ask.json")]] : [])));
  const found = { problems: [], differences: [] };
  for (const n of readdirSync(dir).sort()) {
    const file = join(dir, n, "ask.json");
    const r = refs[act(n) ?? ""];
    if (!r || !existsSync(file)) continue;
    const a = JSON.parse(readFileSync(r, "utf8"));
    const b = JSON.parse(readFileSync(file, "utf8"));
    found.problems.push(...problems(a, b, `${n}: `));
    found.differences.push(...differences(a, b, `${n}: `));
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(new URL(".", import.meta.url).pathname, "..");
  let failed = false;
  for (const dir of process.argv.slice(2)) {
    const f = compareDir(dir, root);
    console.log(`${dir}: ${f.problems.length ? `${f.problems.length} problems` : "same moments and prompts as the choudoufu demo"}`);
    for (const p of f.problems) console.log(`  PROBLEM ${p}`);
    for (const d of f.differences) console.log(`  differs ${d.where}\n    choudoufu: ${d.reference}\n    this:      ${d.other}`);
    failed ||= f.problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
