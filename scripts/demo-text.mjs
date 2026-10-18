// The text stack/demo.sh puts in the kiosk's top pane (behold's web/kiosk.js), held to length budgets so the
// header stays a few lines on a TV: the intro and its delivery line, each scenario's card, its title and short name, every step line
// and every next action. A step line is measured with its placeholders filled by sample values as long as the
// real ones (a terraform_data id is 36 characters, a short sha 8). Used by scripts/lint-docs.mjs and
// test/demo-text.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const BUDGETS = { problem: 220, delivery: 120, changes: 120, watch: 220, shows: 120, title: 60, name: 24, step: 200, action: 60 };

const ID = "4b6e2c1a-9f3d-4e8b-a1c7-2d5f8e0b3c69";

// Each placeholder a label in demo.sh uses, with a value as long as a real run's. A label with a placeholder
// missing here is a problem, so a new one gets a sample before it ships.
export const SAMPLES = {
  $PULL: "1113",
  $WAVE: "2",
  $CYCLE: "503",
  "${COMMIT:0:8}": "bb98f38f",
  "${base:0:8}": "4f0c2a9e",
  $COST_STUB: "Its cost line uses made-up prices",
  $COMPOSED: "network, app and edge",
  $values: "network 9090, app 9080, edge http://app:9080",
  "$(applied_values)": "network 9090, app 9080, edge http://app:9080",
  "$(roots_words)": "network, app, edge and other",
  "$(state_id network subnet)": ID,
  "$(state_input network http_proxy_port)": "9090",
  "$(state_input app listener_port)": "9080",
  "$(state_input edge upstream)": "http://app:9080",
  "$(state_input app instance)": `instance in ${ID}`,
  "$(state_input live/ledger this)": "demo-ledger-records",
  "$(tg_value ledger)": "demo-ledger-records",
  "$(tg_mock)": "mock-bucket",
  // chant's plan digest as the chant scenario shows it: its first 20 characters.
  $PLAN_DIGEST: "jcs1-sha256:3e43a1b2",
  "$(state_input app health_check)": "http://app:9080/healthz",
  $was: "applying",
  $reason: "the plan run of pull request 1113 ended failure (http://localhost:3000/admin/demo/actions/runs/2509)",
};

const PLACEHOLDER = /\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
// A string that is empty, one variable, or a call of the functions read above: what it holds is checked where it is
// written.
const elsewhere = (raw) => raw === "" || /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|\{[^}]*\}|\((?:say|waiting_label|base_label)\b[^)]*\))$/.test(raw);

/** The text a label renders, its placeholders filled; unknown lists the placeholders with no sample. */
export function fill(raw) {
  const unknown = [];
  const text = raw
    .replace(PLACEHOLDER, (p) => {
      if (p in SAMPLES) return SAMPLES[p];
      unknown.push(p);
      return p;
    })
    .replace(/\\(["\\$`])/g, "$1");
  return { text, unknown };
}

// The body of a shell function, from its "name() {" line to the "}" that closes it at the start of a line.
function body(src, name) {
  const start = src.search(new RegExp(`^${name}\\(\\) \\{`, "m"));
  if (start < 0) return { text: "", line: 0 };
  const end = src.indexOf("\n}\n", start);
  return { text: src.slice(start, end < 0 ? undefined : end), line: src.slice(0, start).split("\n").length };
}

/**
 * Every string demo.sh writes to the top pane: { kind, where, raw }, kind one of title, name, step, action.
 * Labels made by a function (say, waiting_label, base_label) are read from the function; a call that passes one
 * of those, or a variable, is not read again.
 */
export function demoStrings(src) {
  const out = [];
  const echoes = (name, kind) => {
    const b = body(src, name);
    let key = "";
    b.text.split("\n").forEach((line, i) => {
      // The case pattern a line's echo answers: on its own line, or the nearest one above it.
      key = /^\s*([^\s()$=]+)\)/.exec(line)?.[1] ?? key;
      for (const m of line.matchAll(new RegExp(`echo ${QUOTED}`, "g"))) {
        if (m[1] === "$1") continue;
        out.push({ kind, where: `${name}${key ? ` ${key}` : ""} (demo.sh:${b.line + i})`, raw: m[1] });
      }
    });
  };
  echoes("scenario_title", "title");
  echoes("scenario_name", "name");
  echoes("say", "step");
  echoes("waiting_label", "step");
  echoes("base_label", "step");
  const lineOf = (index) => src.slice(0, index).split("\n").length;
  // demo_write and demo_hold calls: step, label, [next action], [at]. A literal label is a step line, and a literal
  // or bare-word next action is an action.
  const arg = String.raw`(${QUOTED}|[^\s"\\]+)`;
  const call = new RegExp(String.raw`^\s*demo_(?:write|hold) ${arg}\s+${arg}(?:\s+(?:\\\n\s*)?${arg})?`, "gm");
  for (const m of src.matchAll(call)) {
    const where = `demo.sh:${lineOf(m.index)}`;
    const label = m[4];
    if (label !== undefined && !elsewhere(label)) out.push({ kind: "step", where, raw: label });
    const action = m[6] ?? m[5];
    if (action !== undefined && !action.startsWith("$")) out.push({ kind: "action", where, raw: m[6] ?? action });
  }
  for (const m of src.matchAll(new RegExp(`LAST_LABEL=${QUOTED}`, "g"))) if (!elsewhere(m[1])) out.push({ kind: "step", where: `demo.sh:${lineOf(m.index)}`, raw: m[1] });
  // The stalled step's label, written by demo_stalled itself.
  for (const m of src.matchAll(new RegExp(`--arg text ${QUOTED}`, "g"))) if (!elsewhere(m[1])) out.push({ kind: "step", where: `demo.sh:${lineOf(m.index)}`, raw: m[1] });
  return out;
}

/** Problems with demo.sh's strings: over budget, or a placeholder with no sample. */
export function demoProblems(src, file = "stack/demo.sh") {
  const problems = [];
  for (const s of demoStrings(src)) {
    const { text, unknown } = fill(s.raw);
    for (const p of unknown) problems.push(`${file}: ${s.kind} at ${s.where} uses ${p}, which has no sample in scripts/demo-text.mjs`);
    if (text.length > BUDGETS[s.kind]) problems.push(`${file}: ${s.kind} at ${s.where} is ${text.length} characters, over its budget of ${BUDGETS[s.kind]}: "${text}"`);
  }
  return problems;
}

/** Problems with the cards' lengths: intro.json's problem and delivery, and changes, watch and shows in each about.json. */
export function cardProblems(root = ".") {
  const problems = [];
  const check = (file, field, text) => {
    if (typeof text === "string" && text.length > BUDGETS[field]) problems.push(`${file}: ${field} is ${text.length} characters, over its budget of ${BUDGETS[field]}`);
  };
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      return undefined; // lint-docs says what is wrong with a file that does not parse
    }
  };
  const intro = read("example-demo/scenarios/intro.json");
  check("example-demo/scenarios/intro.json", "problem", intro?.problem);
  check("example-demo/scenarios/intro.json", "delivery", intro?.delivery);
  for (const dir of ["example-demo/scenarios", "example-demo-terragrunt/scenarios", "example-demo-chant/scenarios", "example-demo-chant-fanout/scenarios"]) {
    for (const d of readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${dir}/${d.name}/about.json`;
      const about = read(file);
      for (const field of ["changes", "watch", "shows"]) check(file, field, about?.[field]);
    }
  }
  return problems;
}
