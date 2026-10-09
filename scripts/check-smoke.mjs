// Checks the smoke claim tables without Docker: every CLAIMS line in
// stack/smoke.sh, and every GITLAB_CLAIMS line in stack/smoke-gitlab.sh, is
// name|description|issue with no apostrophe (it would end the single-quoted
// string), and `smoke.sh --list` (with SMOKE_FORGE=gitlab for GitLab's), which
// really sources the scripts, reports the same names in the same order, each
// with a claim function and a group line unless it waits on an issue.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../stack/smoke.sh", import.meta.url));
const errors = [];

function check({ file, table, forge, fn, groups }) {
  const src = readFileSync(fileURLToPath(new URL(`../stack/${file}`, import.meta.url)), "utf8");
  const start = src.indexOf(`\n${table}='`);
  if (start < 0) throw new Error(`check-smoke: no ${table}=' in stack/${file}`);
  const body = src.slice(start + `\n${table}='`.length);
  const end = body.indexOf("'");
  const rows = body.slice(0, end).split("\n").filter((l) => l.trim() !== "");
  const rest = body.slice(end + 1).split("\n", 1)[0];
  const mine = [];
  if (rest.trim() !== "") mine.push(`text after the closing quote of ${table}: ${rest}`);

  const declared = [];
  for (const row of rows) {
    const f = row.split("|");
    if (f.length !== 3 || !/^[a-z][a-z0-9-]*$/.test(f[0]) || f[1].trim() === "") {
      mine.push(`${table} line is not name|description|issue: ${row.slice(0, 60)}`);
      continue;
    }
    if (/^\d*$/.test(f[2]) === false) mine.push(`${f[0]}: issue field is not a number: ${f[2]}`);
    declared.push({ name: f[0], issue: f[2] });
  }
  const dup = declared.map((d) => d.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) mine.push(`duplicate claims in ${table}: ${[...new Set(dup)].join(", ")}`);

  let out = "";
  try {
    out = execFileSync("bash", [script, "--list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SMOKE_FORGE: forge } });
  } catch (e) {
    mine.push(`SMOKE_FORGE=${forge} smoke.sh --list failed: ${String(e.stderr || e.message).trim().split("\n").slice(0, 3).join(" / ")}`);
  }
  const listed = out.split("\n").filter(Boolean).map((l) => {
    const [name, f, g] = l.split(" ");
    return { name, fn: f === "function=yes", grp: g === "group=yes" };
  });
  if (!mine.length) {
    const a = declared.map((d) => d.name).join(" ");
    const b = listed.map((d) => d.name).join(" ");
    if (a !== b) mine.push(`${forge}: --list names differ from ${table} (${declared.length} vs ${listed.length})`);
    for (const d of declared) {
      const l = listed.find((x) => x.name === d.name);
      if (!l || d.issue !== "") continue;
      if (!l.fn) mine.push(`${d.name}: no claim function (${fn}${d.name.replaceAll("-", "_")})`);
      if (!l.grp) mine.push(`${d.name}: no ${groups} line`);
    }
  }
  errors.push(...mine);
  return declared.length;
}

const forgejo = check({ file: "smoke.sh", table: "CLAIMS", forge: "forgejo", fn: "claim_", groups: "CLAIM_GROUPS" });
const gitlab = check({ file: "smoke-gitlab.sh", table: "GITLAB_CLAIMS", forge: "gitlab", fn: "gitlab_claim_", groups: "GITLAB_CLAIM_GROUPS" });

if (errors.length) {
  for (const e of errors) console.error(`check-smoke: ${e}`);
  process.exit(1);
}
console.log(`check-smoke: ${forgejo} claims and ${gitlab} GitLab claims ok`);
