/**
 * A module's interface: the variables and outputs its top-level `.tf` and
 * `.tf.json` files declare, read the way compose reads a root's declarations,
 * so publish needs no HCL parser. tf-publish compares it with the previous
 * release's and refuses a bump smaller than the change calls for.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { blankComments, hclAttributes } from "../compose";
import { blockBody } from "../detect";
import type { Bump } from "./semver";

export interface Variable {
  /** The type expression, whitespace collapsed; `any` when none is written. */
  type: string;
  /** A `default` is written, so a caller can leave the variable out. `default = null` counts. */
  optional: boolean;
  /** `nullable` is not turned off. */
  nullable: boolean;
}

export interface ModuleInterface {
  variables: Map<string, Variable>;
  outputs: Set<string>;
}

export interface InterfaceChange {
  /** What changed, such as `output "id" removed`. */
  change: string;
  bump: Bump;
}

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export const largerBump = (a: Bump, b: Bump): Bump => (RANK[a] >= RANK[b] ? a : b);
export const smallerThan = (a: Bump, b: Bump): boolean => RANK[a] < RANK[b];

const squash = (s: string): string => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();

/** The interface the files declare, by file name and text. Only `.tf` and `.tf.json` files count. */
export function readInterface(files: readonly { name: string; text: string }[]): ModuleInterface {
  const variables = new Map<string, Variable>();
  const outputs = new Set<string>();
  for (const { name, text } of files) {
    if (name.endsWith(".tf.json")) {
      let doc: { variable?: Record<string, unknown>; output?: Record<string, unknown> };
      try {
        doc = JSON.parse(text);
      } catch {
        continue;
      }
      for (const [v, raw] of Object.entries(doc.variable ?? {})) {
        const b = ((Array.isArray(raw) ? raw[0] : raw) ?? {}) as Record<string, unknown>;
        const type = typeof b.type === "string" ? squash(b.type.replace(/^\$\{(.*)\}$/s, "$1")) : "any";
        variables.set(v, { type, optional: "default" in b, nullable: b.nullable !== false });
      }
      for (const o of Object.keys(doc.output ?? {})) outputs.add(o);
    } else if (name.endsWith(".tf")) {
      const t = blankComments(text);
      for (const m of t.matchAll(/(^|\n)\s*variable\s+"([^"]+)"\s*\{/g)) {
        const body = blockBody(t, m.index! + m[0].length - 1);
        const attrs = hclAttributes(body.slice(1, -1));
        variables.set(m[2]!, { type: squash(attrs.get("type") ?? "any"), optional: attrs.has("default"), nullable: attrs.get("nullable") !== "false" });
      }
      for (const m of t.matchAll(/(^|\n)\s*output\s+"([^"]+)"\s*\{/g)) outputs.add(m[2]!);
    }
  }
  return { variables, outputs };
}

const isConfig = (name: string): boolean => name.endsWith(".tf") || name.endsWith(".tf.json");

/** The interface of the module checked out at `dir`. */
export function interfaceOf(dir: string): ModuleInterface {
  const names = readdirSync(dir).filter((n) => isConfig(n) && statSync(join(dir, n)).isFile()).sort();
  return readInterface(names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf-8") })));
}

/** The interface of the module at `rel` as the commit `ref` holds it; undefined when the commit has no such directory. */
export function interfaceAt(repo: string, ref: string, rel: string): ModuleInterface | undefined {
  const ls = spawnSync("git", ["-C", repo, "ls-tree", "-z", `${ref}:${rel}`], { encoding: "utf-8", maxBuffer: 1 << 30 });
  if (ls.status !== 0) return undefined;
  const files: { name: string; text: string }[] = [];
  for (const line of ls.stdout.split("\0").filter(Boolean)) {
    const m = /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    if (!m || m[1] !== "blob" || !isConfig(m[3]!)) continue;
    const blob = spawnSync("git", ["-C", repo, "cat-file", "blob", m[2]!], { encoding: "utf-8", maxBuffer: 1 << 30 });
    if (blob.status === 0) files.push({ name: m[3]!, text: blob.stdout });
  }
  return readInterface(files.sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/** Each change from `prev` to `next` that needs more than a patch, with the least bump it needs. */
export function interfaceChanges(prev: ModuleInterface, next: ModuleInterface): InterfaceChange[] {
  const out: InterfaceChange[] = [];
  for (const [name, was] of prev.variables) {
    const now = next.variables.get(name);
    if (!now) {
      out.push({ change: `variable "${name}" removed`, bump: "major" });
      continue;
    }
    if (was.optional && !now.optional) out.push({ change: `variable "${name}" lost its default`, bump: "major" });
    if (was.nullable && !now.nullable) out.push({ change: `variable "${name}" turned nullable off`, bump: "major" });
    if (was.type !== now.type && now.type !== "any") out.push({ change: `variable "${name}" changed type from ${was.type} to ${now.type}`, bump: "major" });
  }
  for (const [name, now] of next.variables) {
    if (prev.variables.has(name)) continue;
    out.push(now.optional ? { change: `variable "${name}" added with a default`, bump: "minor" } : { change: `variable "${name}" added with no default`, bump: "major" });
  }
  for (const name of prev.outputs) if (!next.outputs.has(name)) out.push({ change: `output "${name}" removed`, bump: "major" });
  for (const name of next.outputs) if (!prev.outputs.has(name)) out.push({ change: `output "${name}" added`, bump: "minor" });
  return out;
}

/** The least bump a set of interface changes needs: patch when there are none. */
export const interfaceBump = (changes: readonly InterfaceChange[]): Bump => changes.reduce<Bump>((b, c) => largerBump(b, c.bump), "patch");

/** The changes as one line, largest bump first. */
export const describeChanges = (changes: readonly InterfaceChange[]): string =>
  [...changes]
    .sort((a, b) => RANK[b.bump] - RANK[a.bump])
    .map((c) => `${c.change} (${c.bump})`)
    .join(", ");
