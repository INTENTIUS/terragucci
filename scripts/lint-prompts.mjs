// The "Hand this to your agent" prompts, held to the PROMPTS rule: each names
// its own page's URL and carries the never-line in docs-site/src/prompts.ts
// word for word, so none can drop the review approval, `--mode apply`, the
// signers file or chant/lifecycle. Every tutorial, guide and getting-started
// page carries a prompt. A sentence that names the signers file or
// chant/lifecycle must forbid. The setup prompt has one source,
// docs-site/src/prompts.ts: README.md, the home page and the agents page carry it.
//   import { promptProblems } from "./lint-prompts.mjs"   (lint-docs.mjs runs it)
//   node scripts/lint-prompts.mjs                          (prints each page's prompt)
import { readFileSync } from "node:fs";
import { DOCS, docPage, pageName } from "./docs-pages.mjs";
import { SITE, neverLine, promptText, setupPrompt } from "../docs-site/src/prompts.ts";

/** A page's `prompt:` front matter: one line, or a `|` or `>` block. */
export function frontPrompt(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const lines = front.split("\n");
  const at = lines.findIndex((l) => /^prompt:/.test(l));
  if (at === -1) return undefined;
  const head = lines[at].slice("prompt:".length).trim();
  if (!/^[|>][+-]?$/.test(head)) return promptText(head.replace(/^(["'])(.*)\1$/, "$2"));
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.replace(/^ {2}/, ""));
  }
  const body = block.join("\n").trim();
  return promptText(head.startsWith(">") ? body.replace(/\n(?!\n)/g, " ") : body);
}

const url = (name) => (name === "index" ? `${SITE}/` : `${SITE}/${name.replace(/\/?index$/, "")}/`);
const sentences = (prompt) => prompt.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
const forbids = (s) => /\b(never|do not|don't)\b/i.test(s);
const flat = (text) => text.replace(/\s+/g, " ");

// The never-line's parts, each named when a prompt lacks it.
const NEVER_PARTS = [
  ["Never apply", "apply"],
  ["approve (a pull request review", "a pull request review"],
  ["`terragucci approve`", "`terragucci approve`"],
  ["`chant approve`", "`chant approve`"],
  ["use `--mode apply`", "`--mode apply`"],
  ["or merge;", "merge"],
  ["never touch `.chant/allowed_signers`", "the signers file"],
  ["`chant/lifecycle`.", "chant/lifecycle"],
];

// The pages that must carry a prompt: every task page.
export const taskPage = (name) => /^(tutorial|guides|getting-started)\//.test(name);

/** Problems with one prompt, the page it sits on named for the messages. */
export function checkPrompt(prompt, name, where) {
  const problems = [];
  if (!prompt.includes(url(name))) problems.push(`${where}: the prompt does not name its page, ${url(name)}`);
  if (!flat(prompt).includes(neverLine)) {
    const missing = NEVER_PARTS.filter(([text]) => !flat(prompt).includes(text)).map(([, part]) => part);
    const what = missing.length ? `misses ${missing.join(", ")}` : "words it differently";
    problems.push(`${where}: the prompt ${what}; end it with the never-line from docs-site/src/prompts.ts: "${neverLine}"`);
  }
  for (const s of sentences(prompt)) {
    if (/allowed_signers|chant\/lifecycle/.test(s) && !forbids(s)) problems.push(`${where}: "${s}" lets the agent near the signers file or chant/lifecycle; only people touch those`);
  }
  return problems;
}

export function promptProblems(files) {
  const problems = [];
  for (const file of files) {
    const name = pageName(file);
    if (!name) continue;
    const prompt = frontPrompt(readFileSync(file, "utf8"));
    if (prompt !== undefined) problems.push(...checkPrompt(prompt, name, file));
    else if (taskPage(name)) problems.push(`${file}: a task page with no \`prompt:\` front matter; add one that names ${url(name)} and ends with the never-line`);
  }
  if (!setupPrompt.includes(neverLine)) problems.push("docs-site/src/prompts.ts: the setup prompt does not carry neverLine");
  const readme = readFileSync("README.md", "utf8");
  if (!readme.includes("```text\n" + setupPrompt + "\n```")) problems.push("README.md: the setup prompt is not the one in docs-site/src/prompts.ts; copy it from there");
  if (frontPrompt(readFileSync(docPage("getting-started/agents"), "utf8")) !== setupPrompt) problems.push(`${docPage("getting-started/agents")}: carry the setup prompt with \`prompt: setup\``);
  if (!readFileSync("docs-site/src/components/Landing.astro", "utf8").includes("text={setupPrompt}")) problems.push("Landing.astro: render <AgentPrompt text={setupPrompt} />");
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((e) => walk(`${p}/${e}`)) : [p]);
  const files = walk(DOCS.slice(0, -1)).filter((f) => /\.mdx?$/.test(f));
  for (const file of files) {
    const prompt = frontPrompt(readFileSync(file, "utf8"));
    if (prompt !== undefined) console.log(`${pageName(file)}\n${prompt.replace(/^/gm, "  ")}\n`);
  }
  const problems = promptProblems(files);
  for (const p of problems) console.log(`FAIL prompt  ${p}`);
  process.exit(problems.length ? 1 : 0);
}
