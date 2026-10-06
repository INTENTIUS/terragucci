// Checks stack/smoke.sh's claim table without Docker: every CLAIMS line is
// name|description|issue with no apostrophe (it would end the single-quoted
// string), and `smoke.sh --list`, which really sources the script, reports the
// same names in the same order, each with a claim function and a CLAIM_GROUPS
// line unless it waits on an issue.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../stack/smoke.sh", import.meta.url));
const src = readFileSync(script, "utf8");
const errors = [];

const start = src.indexOf("\nCLAIMS='");
if (start < 0) throw new Error("check-smoke: no CLAIMS=' in stack/smoke.sh");
const body = src.slice(start + "\nCLAIMS='".length);
const end = body.indexOf("'");
const rows = body.slice(0, end).split("\n").filter((l) => l.trim() !== "");
const rest = body.slice(end + 1).split("\n", 1)[0];
if (rest.trim() !== "") errors.push(`text after the closing quote of CLAIMS: ${rest}`);

const declared = [];
for (const row of rows) {
  const f = row.split("|");
  if (f.length !== 3 || !/^[a-z][a-z0-9-]*$/.test(f[0]) || f[1].trim() === "") {
    errors.push(`CLAIMS line is not name|description|issue: ${row.slice(0, 60)}`);
    continue;
  }
  if (/^\d*$/.test(f[2]) === false) errors.push(`${f[0]}: issue field is not a number: ${f[2]}`);
  declared.push({ name: f[0], issue: f[2] });
}
const dup = declared.map((d) => d.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dup.length) errors.push(`duplicate claims: ${[...new Set(dup)].join(", ")}`);

let out = "";
try {
  out = execFileSync("bash", [script, "--list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  errors.push(`smoke.sh --list failed: ${String(e.stderr || e.message).trim().split("\n").slice(0, 3).join(" / ")}`);
}
const listed = out.split("\n").filter(Boolean).map((l) => {
  const [name, fn, grp] = l.split(" ");
  return { name, fn: fn === "function=yes", grp: grp === "group=yes" };
});
if (!errors.length) {
  const a = declared.map((d) => d.name).join(" ");
  const b = listed.map((d) => d.name).join(" ");
  if (a !== b) errors.push(`--list names differ from CLAIMS (${declared.length} vs ${listed.length})`);
  for (const d of declared) {
    const l = listed.find((x) => x.name === d.name);
    if (!l || d.issue !== "") continue;
    if (!l.fn) errors.push(`${d.name}: no claim function (claim_${d.name.replaceAll("-", "_")})`);
    if (!l.grp) errors.push(`${d.name}: no CLAIM_GROUPS line`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`check-smoke: ${e}`);
  process.exit(1);
}
console.log(`check-smoke: ${declared.length} claims ok`);
