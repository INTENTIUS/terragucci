/**
 * Drift codified. A refresh-only plan says what changed outside Terraform.
 * Where a drifted attribute is a literal in the root's own resource block,
 * the live value is written there, so the code says what the cloud has. Drift
 * reached through a variable, a module or an expression is listed with its
 * reason and left for a person or, when a project opts in, an agent.
 *
 * Unmanaged resources become import blocks, and their config comes from the
 * binary itself: `plan -generate-config-out`, or `terraform query` when the
 * root has a `.tfquery.hcl` file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { ConfigError } from "../config";

export interface Drifted {
  address: string;
  /** What changed outside: `update` or `delete`. */
  action: string;
  /** Top-level attributes whose live value differs from the state's, with both values. */
  attributes: { path: string; before: unknown; live: unknown; /** The plan marks the value sensitive; it never leaves the run. */ sensitive?: boolean }[];
  /** The object's real name or id, as the cloud knows it (the audit log is searched by it). */
  ref?: string;
  module?: string;
  index?: string | number;
  type: string;
  name: string;
}

export interface Codified {
  root: string;
  address: string;
  path: string;
  file: string;
  from: string;
  to: string;
}

export interface Left {
  root: string;
  address: string;
  path?: string;
  reason: string;
}

interface DriftEntry {
  address: string;
  module_address?: string;
  mode?: string;
  type: string;
  name: string;
  index?: string | number;
  change: { actions: string[]; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; before_sensitive?: unknown; after_sensitive?: unknown };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The managed resources a refresh-only plan's JSON says drifted. */
export function driftOf(plan: unknown): Drifted[] {
  const entries = ((plan as { resource_drift?: DriftEntry[] })?.resource_drift ?? []).filter((e) => e.mode !== "data");
  return entries.map((e) => {
    const before = e.change.before ?? {};
    const after = e.change.after ?? {};
    const action = e.change.actions.includes("delete") ? "delete" : "update";
    const marked = (k: string): boolean => {
      const m = (e.change.before_sensitive as Record<string, unknown> | undefined)?.[k] ?? (e.change.after_sensitive as Record<string, unknown> | undefined)?.[k];
      return m !== undefined && m !== false && !(typeof m === "object" && m !== null && Object.keys(m).length === 0);
    };
    const attributes =
      action === "delete"
        ? []
        : [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .sort()
            .filter((k) => !same(before[k], after[k]))
            .map((path) => ({ path, before: before[path], live: after[path], ...(marked(path) ? { sensitive: true } : {}) }));
    const ref = ["name", "id", "function_name", "bucket"].map((k) => after[k] ?? before[k]).find((v) => typeof v === "string" && v !== "") as string | undefined;
    return { address: e.address, action, attributes, type: e.type, name: e.name, ...(ref ? { ref } : {}), ...(e.module_address ? { module: e.module_address } : {}), ...(e.index !== undefined ? { index: e.index } : {}) };
  });
}

/** The value an HCL literal holds, or undefined when the text is not a literal. */
export function literal(text: string): { value: unknown } | undefined {
  const t = text.trim().replace(/\s*(#|\/\/).*$/, "");
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  if (t === "true" || t === "false") return { value: t === "true" };
  if (/^"(?:[^"\\$%]|\\.|\$(?!\{)|%(?!\{))*"$/.test(t)) {
    try {
      return { value: JSON.parse(t) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A value as an HCL literal, or undefined for a list, map or null. */
export function hcl(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value).replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
  return undefined;
}

function tfFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tf") || f.endsWith(".tofu")).sort() : [];
}

/** The line range of `resource "type" "name"` in a file's lines, body only. */
function block(lines: string[], type: string, name: string): [number, number] | undefined {
  const head = new RegExp(`^\\s*resource\\s+"${type}"\\s+"${name}"\\s*\\{`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, "")) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
    if (depth === 0) return [start, i];
  }
  return undefined;
}

/**
 * Write each live value where the drifted attribute is a literal in the
 * root's own resource block. `files` maps a root-relative file name to its
 * text and is edited in place; the result names what was written and what
 * was left, with why.
 */
export function codify(root: string, rootDir: string, drifted: Drifted[], files = new Map<string, string>()): { codified: Codified[]; left: Left[]; files: Map<string, string> } {
  const codified: Codified[] = [];
  const left: Left[] = [];
  const read = (f: string) => files.get(f) ?? readFileSync(join(rootDir, f), "utf-8");
  for (const d of drifted) {
    const leave = (reason: string, path?: string) => left.push({ root, address: d.address, ...(path ? { path } : {}), reason });
    if (d.action === "delete") {
      leave("deleted outside Terraform; the next apply makes it again, or remove it from the code if that was the intent");
      continue;
    }
    if (d.module) {
      leave(`reached through ${d.module}; the value is set in a module`);
      continue;
    }
    if (d.index !== undefined) {
      leave("an instance of count or for_each; one literal sets every instance");
      continue;
    }
    const file = tfFiles(rootDir).find((f) => block(read(f).split("\n"), d.type, d.name));
    if (!file) {
      leave("its resource block is not in the root's files");
      continue;
    }
    const lines = read(file).split("\n");
    const [start, end] = block(lines, d.type, d.name)!;
    for (const a of d.attributes) {
      let depth = 0;
      let at = -1;
      for (let i = start + 1; i < end && at < 0; i++) {
        if (depth === 0 && new RegExp(`^\\s*${a.path}\\s*=`).test(lines[i]!)) at = i;
        for (const ch of lines[i]!.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, "")) {
          if (ch === "{" || ch === "[" || ch === "(") depth++;
          if (ch === "}" || ch === "]" || ch === ")") depth--;
        }
      }
      if (at < 0) {
        leave("not set in the root's block; it comes from a default or the provider", a.path);
        continue;
      }
      const m = /^(\s*\S+\s*=\s*)(.*?)(\s*(?:#.*|\/\/.*)?)$/.exec(lines[at]!)!;
      const lit = literal(m[2]!);
      if (!lit) {
        leave(`set from an expression (${m[2]!.trim()})`, a.path);
        continue;
      }
      if (!same(lit.value, a.before)) {
        leave("the root's value is not the one last applied, so the code moved too", a.path);
        continue;
      }
      const to = hcl(a.live);
      if (to === undefined) {
        leave("its live value is a list, a map or null", a.path);
        continue;
      }
      lines[at] = `${m[1]}${to}${m[3]}`;
      codified.push({ root, address: d.address, path: a.path, file: posix.join(root, file), from: m[2]!.trim(), to });
    }
    const text = lines.join("\n");
    if (text !== read(file)) files.set(file, text);
  }
  return { codified, left, files };
}

/** Import blocks for resources that exist but are not in the state. */
export function importBlocks(imports: { address: string; id: string }[]): string {
  return imports.map((i) => `import {\n  to = ${i.address}\n  id = ${JSON.stringify(i.id)}\n}\n`).join("\n");
}

/** `address=id` as given on the command line. */
export function parseImport(text: string): { address: string; id: string } {
  const at = text.indexOf("=");
  const address = text.slice(0, at).trim();
  if (at < 1 || !/^[\w.[\]"-]+$/.test(address)) throw new ConfigError(`--import takes <address>=<id>, such as aws_sqs_queue.extra=https://sqs.../extra; got ${JSON.stringify(text)}`);
  return { address, id: text.slice(at + 1) };
}

/** Whether a root carries a `terraform query` file. */
export const hasQuery = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".tfquery.hcl"));
