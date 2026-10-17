/**
 * `terragucci guard`: a local guard that keeps a coding agent in a checkout
 * from applying a root the pipeline owns.
 *
 * It writes, under the checkout's git directory (`<git-dir>/terragucci/guard`,
 * so nothing of it is committed):
 * - `guard.mjs`, one Node script holding the rule, the repo and its roots;
 * - `bin/<binary>` for tofu, terraform, terragrunt and choudoufu, each a
 *   wrapper that runs the script, for the agent's shell to put ahead of the
 *   real binary on PATH. The wrapper refuses `apply`, `destroy`, `import`,
 *   `taint`, `untaint`, `force-unlock`, `state rm|mv|push|replace-provider`
 *   and `-auto-approve` in a root of the pipeline (for Terragrunt's `--all`
 *   and `run-all`, in a directory that holds one), and runs the next binary of
 *   that name on PATH for everything else;
 * - a PreToolUse hook in `.claude/settings.local.json`, the file Claude Code
 *   reads, which refuses the same commands in the agent's Bash tool, and the
 *   terragucci commands that approve, apply, override or merge anywhere
 *   (`stage tf-apply`, `approve`, `override`, `unlock-state`, `pr-merge`,
 *   `--mode apply`). The file is listed in `.git/info/exclude` unless git
 *   already ignores it.
 *
 * Each refusal names `propose` on `terragucci mcp --propose` as the way to get
 * the change applied: a pull request, planned by the pipeline, approved by a
 * person.
 *
 * The guard is a speed bump. An agent that calls the real binary by its path,
 * through a script, or with credentials of its own gets past it; the control
 * is a plan role that cannot write, per-environment state roles and approvals
 * bound to the plan digest. The roots are written into the script when the
 * guard is written, so it is written again after the roots change.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError, type ResolvedSettings } from "./config";
import { findRoots } from "./detect";
import { detectShape } from "./shape";
import { walkUnits } from "./terragrunt";

/** The binaries the guard wraps. */
export const GUARD_BINARIES = ["tofu", "terraform", "terragrunt", "choudoufu"] as const;

/** The file Claude Code reads a checkout's own hooks from, kept out of commits. */
export const CLAUDE_SETTINGS = ".claude/settings.local.json";

/** What the guard's script is given when it is written. */
export interface GuardConfig {
  /** The checkout's top directory. */
  repo: string;
  /** The pipeline's roots (Terragrunt units), absolute. */
  roots: string[];
  /** The wrappers' directory, which a wrapper skips when it looks for the real binary. */
  bin: string;
}

/**
 * The guard's script. Self-contained: it imports Node's modules only, and
 * reads its config from the JSON written into it.
 */
export function guardScript(c: GuardConfig): string {
  return `// Written by terragucci guard. Run terragucci guard again after the pipeline's roots change.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";

const CONFIG = ${JSON.stringify(c)};
const BINARIES = new Set(${JSON.stringify(GUARD_BINARIES)});
const DENY = new Set(["apply", "destroy", "import", "taint", "untaint", "force-unlock"]);
const STATE_DENY = new Set(["rm", "mv", "push", "replace-provider"]);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const REPO = real(CONFIG.repo);
const ROOTS = CONFIG.roots.map(real);

/** What a binary's command line would do that the guard refuses, and the root it would do it in; undefined to let it run. */
export function verdict(bin, args, cwd) {
  let dir = cwd;
  let all = false;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--?(?:chdir|working-dir|terragrunt-working-dir)=(.*)$/.exec(a);
    if (m) dir = resolve(cwd, m[1]);
    else if (/^--?(?:chdir|working-dir|terragrunt-working-dir)$/.test(a) && i + 1 < args.length) dir = resolve(cwd, args[++i]);
    else if (bin === "terragrunt" && (a === "--all" || a === "-a")) all = true;
    else if (a !== "--" && !a.startsWith("-")) words.push(a);
  }
  if (bin === "terragrunt") {
    if (words[0] === "run-all") { all = true; words.shift(); }
    else if (words[0] === "stack" && words[1] === "run") { all = true; words.splice(0, 2); }
    else if (words[0] === "run") words.shift();
  }
  const cmd = words[0];
  const auto = args.some((a) => /^--?(?:terragrunt-)?auto-approve(?:=.*)?$/.test(a));
  const what = DENY.has(cmd) ? cmd : cmd === "state" && STATE_DENY.has(words[1]) ? "state " + words[1] : auto ? "-auto-approve" : undefined;
  if (!what) return undefined;
  const at = real(dir);
  const hit = ROOTS.find((r) => r === at || (all && r.startsWith(at === sep ? at : at + sep)));
  return hit ? { what: bin + " " + what, where: relative(REPO, hit) || "." } : undefined;
}

/** The terragucci commands that approve, apply, override or merge: refused anywhere in the repo. */
const APPLYING_COMMANDS = [["stage", "tf-apply"], ["approve"], ["override"], ["unlock-state"], ["pr-merge"]];
export function terragucciVerdict(args) {
  const words = args.filter((a) => !a.startsWith("-"));
  for (const d of APPLYING_COMMANDS) if (d.every((w, i) => words[i] === w)) return { what: "terragucci " + d.join(" ") };
  const mode = args.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
  if (mode >= 0 && (args[mode] === "--mode=apply" || (args[mode] === "--mode" && args[mode + 1] === "apply"))) return { what: "terragucci " + (words[0] ?? "") + " --mode apply" };
  return undefined;
}

export function message(v) {
  const where = v.where === undefined ? "" : " in " + v.where + ", a root of this repo's pipeline";
  return "terragucci guard: " + v.what + " is refused" + where + ". Propose the change instead: commit it to a branch and call the propose tool of terragucci mcp --propose, which pushes the branch and opens a pull request. The pipeline plans it, and a person approves its apply. init, validate, fmt and plan still run here.";
}

/** A shell command line's words and operators, quotes taken off. Enough for a guard, not a shell. */
function lex(text) {
  const out = [];
  let cur = null;
  const end = () => {
    if (cur !== null) out.push({ word: cur });
    cur = null;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      cur = (cur ?? "") + (j < 0 ? text.slice(i + 1) : text.slice(i + 1, j));
      i = j < 0 ? text.length : j;
    } else if (c === '"') {
      let s = "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\\\" && i + 1 < text.length) i++;
        s += text[i];
      }
      cur = (cur ?? "") + s;
    } else if (c === "\\\\" && i + 1 < text.length) cur = (cur ?? "") + text[++i];
    else if (c === "$" && text[i + 1] === "(") {
      end();
      out.push({ op: "$(" });
      i++;
    } else if (";&|\\n()\`".includes(c)) {
      end();
      out.push({ op: c });
    } else if (/\\s/.test(c)) end();
    else cur = (cur ?? "") + c;
  }
  end();
  return out;
}

const WRAPPERS = new Set(["command", "exec", "env", "sudo", "time", "nohup", "nice", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The first refusal a shell command line earns, following \`cd\` from \`cwd\`. */
export function checkCommand(text, cwd, depth = 0) {
  if (depth > 3) return undefined;
  let dir = cwd;
  const segments = [[]];
  for (const t of lex(text)) {
    if (t.op) segments.push([]);
    else segments[segments.length - 1].push(t.word);
  }
  for (let seg of segments) {
    while (seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0]) || WRAPPERS.has(seg[0]))) seg = seg.slice(1);
    if (!seg.length) continue;
    const head = basename(seg[0]);
    if (head === "cd") {
      const to = seg[1] === undefined || seg[1] === "~" ? process.env.HOME ?? dir : seg[1].startsWith("~/") ? join(process.env.HOME ?? "", seg[1].slice(2)) : seg[1];
      if (to !== "-") dir = resolve(dir, to);
      continue;
    }
    if (SHELLS.has(head)) {
      const c = seg.indexOf("-c");
      if (c >= 0 && seg[c + 1] !== undefined) {
        const v = checkCommand(seg[c + 1], dir, depth + 1);
        if (v) return v;
      }
      continue;
    }
    let rest = seg;
    if (head === "npx" || head === "bunx" || head === "pnpx") {
      rest = rest.slice(1);
      while (rest.length && rest[0].startsWith("-")) rest = rest.slice(1);
      if (!rest.length) continue;
    }
    // npx names a package as @intentius/terragucci, with a version after an @.
    const name = basename(rest[0]).replace(/@.*$/, "");
    if (BINARIES.has(name)) {
      const v = verdict(name, rest.slice(1), dir);
      if (v) return v;
    } else if (name === "terragucci") {
      const at = real(dir);
      if (at === REPO || at.startsWith(REPO + sep)) {
        const v = terragucciVerdict(rest.slice(1));
        if (v) return v;
      }
    }
  }
  return undefined;
}

/** The next binary of this name on PATH, past the wrappers' own directory. */
function realBinary(bin) {
  const self = real(CONFIG.bin);
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d || real(d) === self) continue;
    const p = join(d, bin);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "wrap") {
  const [bin, ...args] = rest;
  const v = verdict(bin, args, process.cwd());
  if (v) {
    process.stderr.write(message(v) + "\\n");
    process.exit(3);
  }
  const exe = realBinary(bin);
  if (!exe) {
    process.stderr.write("terragucci guard: no " + bin + " on PATH besides the guard's own\\n");
    process.exit(127);
  }
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});
  const r = spawnSync(exe, args, { stdio: "inherit" });
  if (r.error) {
    process.stderr.write("terragucci guard: " + r.error.message + "\\n");
    process.exit(127);
  }
  if (r.signal) {
    process.removeAllListeners(r.signal);
    process.kill(process.pid, r.signal);
  }
  process.exit(r.status ?? 1);
} else if (mode === "hook") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }
  const command = event?.tool_input?.command;
  if (typeof command !== "string") process.exit(0);
  const v = checkCommand(command, typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd());
  if (v) {
    process.stderr.write(message(v) + "\\n");
    process.exit(2);
  }
  process.exit(0);
}
`;
}

/** A wrapper on PATH: the guard's script for one binary, run with the Node that wrote it, or the one on PATH. */
export function wrapperScript(node: string, script: string, bin: string): string {
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh
# Written by terragucci guard: refuses what would apply a root of this repo's pipeline, and runs the next ${bin} on PATH for the rest.
NODE=${q(node)}
[ -x "$NODE" ] || NODE=node
exec "$NODE" ${q(script)} wrap ${bin} "$@"
`;
}

/** The pipeline's roots as the guard counts them: Terragrunt's units in a Terragrunt repo, the roots everywhere else. */
export function guardRoots(repo: string, settings: ResolvedSettings): string[] {
  const shape = detectShape(repo, settings);
  return shape.kind === "terragrunt" ? walkUnits(repo, settings.terragrunt?.exclude).map((u) => u.path) : findRoots(repo, settings.roots);
}

export interface GuardOptions {
  /** The checkout's top directory. */
  repo: string;
  settings: ResolvedSettings;
  /** Where to write the guard, in place of `<git-dir>/terragucci/guard`. */
  dir?: string;
  /** The Node the wrappers and the hook run. Default: this one. */
  node?: string;
  /** Leave Claude Code's settings alone. */
  noHook?: boolean;
}

export interface GuardResult {
  dir: string;
  bin: string;
  script: string;
  roots: string[];
  /** The settings file the hook was written to, when it was. */
  hook?: string;
  /** The line the agent's shell runs to put the wrappers ahead of the binaries. */
  path: string;
}

function gitOut(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new ConfigError(`terragucci guard runs in a git checkout (git ${args.join(" ")}: ${(r.stderr || "").trim()})`);
  return r.stdout.trim();
}

/** The hook's command, as Claude Code runs it. */
const hookCommand = (node: string, script: string): string => `"${node}" "${script}" hook`;

/** Add the guard's PreToolUse hook to a Claude Code settings file, in place of an earlier one; everything else in the file is kept. */
export function withHook(text: string | undefined, command: string, at: string): string {
  let doc: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new ConfigError(`${at} is not JSON (${(e as Error).message}); fix it, or run terragucci guard --no-hook`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError(`${at} is not a JSON object`);
  }
  const hooks = (doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  const ours = (e: unknown): boolean => JSON.stringify(e).includes("terragucci/guard/guard.mjs") || JSON.stringify(e).includes(JSON.stringify(command).slice(1, -1));
  const kept = pre.filter((e) => !ours(e));
  doc.hooks = { ...hooks, PreToolUse: [...kept, { matcher: "Bash", hooks: [{ type: "command", command }] }] };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Write the guard: the script, the wrappers, and the hook. */
export function writeGuard(o: GuardOptions): GuardResult {
  const repo = resolve(o.repo);
  const gitDir = gitOut(repo, ["rev-parse", "--absolute-git-dir"]);
  const dir = o.dir ? resolve(repo, o.dir) : join(gitDir, "terragucci", "guard");
  const bin = join(dir, "bin");
  const script = join(dir, "guard.mjs");
  const node = o.node ?? process.execPath;
  const roots = guardRoots(repo, o.settings);
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, guardScript({ repo, roots: roots.map((r) => join(repo, r)), bin }));
  for (const b of GUARD_BINARIES) {
    const p = join(bin, b);
    writeFileSync(p, wrapperScript(node, script, b));
    chmodSync(p, 0o755);
  }
  let hook: string | undefined;
  if (!o.noHook) {
    hook = join(repo, CLAUDE_SETTINGS);
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, withHook(existsSync(hook) ? readFileSync(hook, "utf-8") : undefined, hookCommand(node, script), CLAUDE_SETTINGS));
    // The hook names paths on this machine: keep the file out of commits unless git already ignores it.
    if (spawnSync("git", ["-C", repo, "check-ignore", "-q", CLAUDE_SETTINGS]).status !== 0) {
      const common = gitOut(repo, ["rev-parse", "--git-common-dir"]);
      const exclude = join(isAbsolute(common) ? common : resolve(repo, common), "info", "exclude");
      mkdirSync(dirname(exclude), { recursive: true });
      const now = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
      writeFileSync(exclude, `${now}${now === "" || now.endsWith("\n") ? "" : "\n"}/${CLAUDE_SETTINGS}\n`);
    }
  }
  return { dir, bin, script, roots, ...(hook ? { hook } : {}), path: `export PATH="${bin}:$PATH"` };
}

/** What `terragucci guard` prints. */
export function describeGuard(r: GuardResult): string {
  return [
    `terragucci guard: wrote ${GUARD_BINARIES.join(", ")} wrappers to ${r.bin}, guarding ${r.roots.length} root${r.roots.length === 1 ? "" : "s"}.`,
    `In the agent's shell, put them ahead of the binaries:`,
    `  ${r.path}`,
    r.hook ? `Claude Code's hook is in ${r.hook}: it refuses the same commands in the agent's Bash tool.` : `No hook was written (--no-hook).`,
    `The guard is a speed bump, not the control: the agent's credentials are. Run terragucci guard again after the roots change.`,
  ].join("\n");
}
