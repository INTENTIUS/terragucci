// The prompt-driven demos read as one set (terragucci#1269): a scenario's ask.json beside the choudoufu demo's
// (example-demo-choudoufu-compose) has the same moments in the same order, the same number of asks at each, and
// the same prompts word for word. Every other string on screen (opening, replies, statuses, actions, closing)
// matches too once the subject words (estates, stacks or roots, and the tool's name) are put as one word.
// Two things are left out, as ruled for epic:engine-ship round 2: tips, which only chant's demos have, and the
// replies in EXEMPT, which state a fact about the engine and so cannot match. Diffs and lights name each
// scenario's own resources and are left out too.
//
// Usage: node scripts/demo-asks.mjs <scenarios dir> [<scenarios dir> ...]
// Each dir holds <tool>-compose-edit and <tool>-compose-create; each is compared with the choudoufu demo's.
// Exits 1 when a moment, a prompt or any other compared string differs; prints the exempt differences either way.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The choudoufu demo's scenarios, the set the others match. */
export const REFERENCE = "example-demo-choudoufu-compose/scenarios";

/**
 * Strings that may differ from the choudoufu demo's because they state an engine fact, by where differences()
 * puts them, with the reason. The create act's "Did anything stay locked?" ask: choudoufu holds no lock and checks
 * its record store; CloudFormation locks each stack during its update, and chant takes each root's state lock.
 */
export const EXEMPT = {
  "chant-compose-create: applied[1].reply": "engine fact: how the engine locks during an apply",
  "chant-compose-create: applied[1].status": "engine fact: chant has no record store to check",
};

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

/** The strings an ask puts on screen besides its prompt, by field. Tips are chant-only, and diffs and lights name the scenario's own resources; all three are left out. */
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

/**
 * Compare every scenario under `dir` with the reference scenario of its act, under the repo at `root`.
 * `differences` holds what must still change; `exempt` holds the differences EXEMPT names.
 */
export function compareDir(dir, root = ".", exempt = EXEMPT) {
  const ref = join(root, REFERENCE);
  const refs = Object.fromEntries(readdirSync(ref).flatMap((n) => (act(n) && existsSync(join(ref, n, "ask.json")) ? [[act(n), join(ref, n, "ask.json")]] : [])));
  const found = { problems: [], differences: [], exempt: [] };
  for (const n of readdirSync(dir).sort()) {
    const file = join(dir, n, "ask.json");
    const r = refs[act(n) ?? ""];
    if (!r || !existsSync(file)) continue;
    const a = JSON.parse(readFileSync(r, "utf8"));
    const b = JSON.parse(readFileSync(file, "utf8"));
    found.problems.push(...problems(a, b, `${n}: `));
    for (const d of differences(a, b, `${n}: `)) (Object.hasOwn(exempt, d.where) ? found.exempt : found.differences).push(d);
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(new URL(".", import.meta.url).pathname, "..");
  let failed = false;
  for (const dir of process.argv.slice(2)) {
    const f = compareDir(dir, root);
    const bad = f.problems.length + f.differences.length;
    console.log(`${dir}: ${bad ? `${bad} problems` : "matches the choudoufu demo but for its subject"}`);
    for (const p of f.problems) console.log(`  PROBLEM ${p}`);
    for (const d of f.differences) console.log(`  DIFFERS ${d.where}\n    choudoufu: ${d.reference}\n    this:      ${d.other}`);
    for (const d of f.exempt) console.log(`  exempt  ${d.where} (${EXEMPT[d.where] ?? "named exemption"})\n    choudoufu: ${d.reference}\n    this:      ${d.other}`);
    failed ||= bad > 0;
  }
  process.exit(failed ? 1 : 0);
}
