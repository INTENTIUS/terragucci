// Checks every BREAK cut the smoke claims make without running a claim: each
// `break_bundle <out> <file> <find> <replace>...` call in stack/smoke.sh,
// stack/smoke-gitlab.sh and stack/sandbox-github.sh names a file under packages/terragucci/src that holds
// its <find> exactly once, as stack/break-bundle.mjs requires when the claim
// runs. A refactor that moves the text fails here, instead of a BREAK run that
// fails to build its bundle and breaks nothing.
//
// The calls are read with a small shell word reader (single quotes, $'..',
// double quotes with their escapes, backslash-newline), and each call's words
// are then read again by bash itself, through a break_bundle that prints its
// arguments, so a call this reader gets wrong fails the check too.
//
//   node scripts/check-breaks.mjs [script...]   default: the two smoke scripts and the sandbox's
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = resolve(root, "packages/terragucci/src");

const ANSI = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

// The words of the command that starts at i, up to the first unquoted
// newline, ;, &, |, ) or comment. A word holding an expansion is dynamic.
export function readWords(text, i) {
  const words = [];
  let cur = null;
  const push = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const word = () => (cur ??= { value: "", dynamic: false });
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "\n") { i += 2; continue; }
    if (c === " " || c === "\t") { push(); i++; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === ")" || c === "<" || c === ">") break;
    if (c === "#" && !cur) break;
    if (c === "`" || (c === "$" && text[i + 1] === "(")) throw new Error("a command substitution in a break_bundle call");
    if (c === "\\") { word().value += text[i + 1]; i += 2; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error("an unclosed '");
      word().value += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      i += 2;
      const w = word();
      for (;;) {
        if (i >= text.length) throw new Error("an unclosed $'");
        const d = text[i];
        if (d === "'") { i++; break; }
        if (d !== "\\") { w.value += d; i++; continue; }
        const e = text[i + 1];
        let m;
        if (e in ANSI) { w.value += ANSI[e]; i += 2; }
        else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i + 1)))) { w.value += String.fromCharCode(parseInt(m[1], 16)); i += 1 + m[0].length; }
        else if ((m = /^u([0-9a-fA-F]{1,4})/.exec(text.slice(i + 1)))) { w.value += String.fromCharCode(parseInt(m[1], 16)); i += 1 + m[0].length; }
        else if ((m = /^[0-7]{1,3}/.exec(text.slice(i + 1)))) { w.value += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; }
        else { w.value += "\\" + e; i += 2; }
      }
      continue;
    }
    if (c === '"') {
      i++;
      const w = word();
      for (;;) {
        if (i >= text.length) throw new Error('an unclosed "');
        const d = text[i];
        if (d === '"') { i++; break; }
        if (d === "`" || (d === "$" && text[i + 1] === "(")) throw new Error("a command substitution in a break_bundle call");
        if (d === "\\" && text[i + 1] === "\n") { i += 2; continue; }
        if (d === "\\" && "$`\"\\".includes(text[i + 1])) { w.value += text[i + 1]; i += 2; continue; }
        if (d === "$" && /[A-Za-z_{0-9@*#?$!-]/.test(text[i + 1] ?? "")) w.dynamic = true;
        w.value += d;
        i++;
      }
      continue;
    }
    if (c === "$" && /[A-Za-z_{0-9@*#?$!-]/.test(text[i + 1] ?? "")) word().dynamic = true;
    word().value += c;
    i++;
  }
  push();
  return { words, end: i };
}

// Every break_bundle call in a script: its line, its words after the name,
// and the source of those words.
export function findCalls(text) {
  const calls = [];
  const re = /(^|[\s;&|(!])break_bundle(?=[ \t]|\\\n)/gm;
  let m;
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (/^\s*#/.test(text.slice(lineStart, at))) continue;
    const line = text.slice(0, at).split("\n").length;
    const start = at + "break_bundle".length;
    try {
      const { words, end } = readWords(text, start);
      calls.push({ line, words, source: text.slice(start, end) });
    } catch (e) {
      calls.push({ line, error: e.message });
    }
  }
  return calls;
}

// The words bash itself reads from a call's source, its expansions empty.
function bashWords(source) {
  const out = execFileSync("bash", ["--norc", "--noprofile", "-c", `break_bundle() { printf '%s\\0' "$@"; }; break_bundle ${source}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH },
  });
  return out.split("\0").slice(0, -1);
}

function checkScript(path) {
  const errors = [];
  const text = readFileSync(path, "utf8");
  const shown = path.startsWith(root) ? relative(root, path) : path;
  const where = (c) => `${shown}:${c.line}`;
  const calls = findCalls(text);
  let cuts = 0;
  for (const c of calls) {
    if (c.error) { errors.push(`${where(c)}: cannot read the call: ${c.error}`); continue; }
    const fromBash = bashWords(c.source);
    const mine = c.words.map((w) => (w.dynamic ? null : w.value));
    const agree = fromBash.length === mine.length && mine.every((v, k) => v === null || v === fromBash[k]);
    if (!agree) { errors.push(`${where(c)}: this reader and bash read the call differently`); continue; }
    const [, ...rest] = c.words;
    if (rest.length === 0 || rest.length % 3 !== 0) { errors.push(`${where(c)}: ${rest.length} words after <out>, not file find replace triples`); continue; }
    for (let k = 0; k < rest.length; k += 3) {
      const [file, find, replace] = rest.slice(k, k + 3);
      cuts++;
      if (file.dynamic || find.dynamic || replace.dynamic) { errors.push(`${where(c)}: cut ${k / 3 + 1} holds an expansion; write its file, find and replace literally`); continue; }
      const full = resolve(src, file.value);
      if (!existsSync(full)) { errors.push(`${where(c)}: ${file.value} is not under packages/terragucci/src`); continue; }
      const n = readFileSync(full, "utf8").split(find.value).length - 1;
      if (n !== 1) errors.push(`${where(c)}: ${file.value} holds ${JSON.stringify(find.value)} ${n} times, not once`);
      if (find.value === replace.value) errors.push(`${where(c)}: cut ${k / 3 + 1} replaces its find with itself`);
    }
  }
  return { errors, calls: calls.length, cuts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scripts = process.argv.slice(2);
  const paths = scripts.length ? scripts.map((s) => resolve(s)) : ["stack/smoke.sh", "stack/smoke-gitlab.sh", "stack/sandbox-github.sh"].map((s) => resolve(root, s));
  let errors = [], calls = 0, cuts = 0;
  for (const p of paths) {
    const r = checkScript(p);
    errors = errors.concat(r.errors);
    calls += r.calls;
    cuts += r.cuts;
  }
  if (errors.length) {
    for (const e of errors) console.error(`check-breaks: ${e}`);
    process.exit(1);
  }
  console.log(`check-breaks: ${calls} break_bundle calls, ${cuts} cuts, each find once in its file`);
}
