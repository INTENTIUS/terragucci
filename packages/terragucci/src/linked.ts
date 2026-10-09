/**
 * Linked states for plain roots: a root that reads another root's state through
 * `terraform_remote_state` plans, in a pull request, on the outputs that
 * root's plan in the same run makes, not on the ones it last applied.
 *
 * The upstream's planned outputs come from ./planned-outputs.ts. For the
 * downstream's plan, every reference to
 * `data.terraform_remote_state.<name>` in the root's own files is rewritten
 * to a local that holds those outputs, each unknown part an expression the
 * binary cannot know at plan time (`timestamp()` is unknown until apply in
 * Terraform and OpenTofu alike). The files go back as they were once the plan
 * is made. That plan is for review: the apply wave plans again on the state
 * the upstream's wave applied.
 *
 * Not linked, so planned on the applied state: a block with count or
 * for_each, a reference from a child module, and a Terragrunt `dependency`
 * (Terragrunt reads a dependency's outputs from its state, and terragucci
 * never lets it plan on mock_outputs).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anyTrue, plannedRead, type PlannedOutput } from "./planned-outputs";
import type { ReportRead } from "./report/schema";

export { plannedOutputs, type PlannedOutput } from "./planned-outputs";

/** A known string as an HCL quoted string: JSON's escapes, and `${` and `%{` escaped so nothing in it is a template. */
function hclString(s: string): string {
  return JSON.stringify(s).replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** A planned value as an HCL expression, each unknown part `unknownRef`. */
export function hclValue(value: unknown, unknown: unknown, unknownRef: string): string {
  if (unknown === true) return unknownRef;
  if (Array.isArray(value) || Array.isArray(unknown)) {
    const v = Array.isArray(value) ? value : [];
    const u = Array.isArray(unknown) ? unknown : [];
    const n = Math.max(v.length, u.length);
    return `[${Array.from({ length: n }, (_, i) => hclValue(v[i], u[i], unknownRef)).join(", ")}]`;
  }
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
  if (isObj(value) || isObj(unknown)) {
    const v = isObj(value) ? value : {};
    const u = isObj(unknown) ? unknown : {};
    const keys = [...new Set([...Object.keys(v), ...Object.keys(u).filter((k) => anyTrue(u[k]))])].sort();
    return `{ ${keys.map((k) => `${hclString(k)} = ${hclValue(v[k], u[k], unknownRef)}`).join(", ")} }`;
  }
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return hclString(value);
  return JSON.stringify(value);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A reference to the block, not to one whose label starts with it. */
const refRe = (name: string, flags = "g"): RegExp => new RegExp(`\\bdata\\.terraform_remote_state\\.${escapeRe(name)}(?![\\w-])`, flags);

/** The outputs a root's files read from the block: their names, or undefined when it reads the whole object. */
export function outputsRead(texts: readonly string[], name: string): Set<string> | undefined {
  const re = new RegExp(`${refRe(name, "").source}(\\.outputs(?:\\.([A-Za-z_][\\w-]*)|\\[\\s*"([^"]+)"\\s*\\])?)?`, "g");
  const read = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      const out = m[2] ?? m[3];
      if (!out) return undefined;
      read.add(out);
    }
  }
  return read;
}

/** The root's own configuration files that hold references. JSON syntax is left alone. */
function configFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".tf") || n.endsWith(".tofu"))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

/** The file a linked plan adds to the root for as long as it plans. */
export const LINKED_FILE = "terragucci_linked.tf";
const UNKNOWN_LOCAL = "terragucci_unknown";
const localOf = (name: string): string => `terragucci_linked_${name}`;

/** One block of a root to plan on an upstream's planned outputs. */
export interface Link {
  /** The `terraform_remote_state` block's label. */
  name: string;
  upstream: string;
  outputs: Map<string, PlannedOutput>;
}

/** A root's files rewritten for a linked plan; `restore` puts them back. */
export interface Linked {
  reads: ReportRead[];
  /** Whether a value the root reads is known only once its upstream applies: the plan is provisional. */
  provisional: boolean;
  restore: () => void;
}

/**
 * Rewrite a root's references to each linked block so it plans on the
 * upstream's planned outputs. Throws, changing nothing, when the root already
 * has a file of the linked file's name.
 */
export function linkRoot(dir: string, links: readonly Link[]): Linked {
  const generated = join(dir, LINKED_FILE);
  if (existsSync(generated)) throw new Error(`${LINKED_FILE} is already in the root`);
  const files = configFiles(dir);
  const originals = new Map(files.map((f) => [f, readFileSync(f, "utf-8")]));
  const texts = [...originals.values()];
  const reads: ReportRead[] = [];
  let provisional = false;
  const locals: string[] = [`  ${UNKNOWN_LOCAL} = jsondecode(timestamp())`];
  for (const l of links) {
    const r = plannedRead(l.upstream, l.name, l.outputs, outputsRead(texts, l.name));
    if (r.unknown) provisional = true;
    reads.push(r);
    const fields = [...l.outputs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, o]) => {
      const expr = hclValue(o.value, o.unknown, `local.${UNKNOWN_LOCAL}`);
      return `${hclString(n)} = ${o.sensitive ? `sensitive(${expr})` : expr}`;
    });
    locals.push(`  ${localOf(l.name)} = { outputs = { ${fields.join(", ")} } }`);
  }
  const restore = (): void => {
    for (const [f, t] of originals) writeFileSync(f, t);
    rmSync(generated, { force: true });
  };
  try {
    for (const [f, t] of originals) {
      let next = t;
      for (const l of links) next = next.replace(refRe(l.name), `local.${localOf(l.name)}`);
      if (next !== t) writeFileSync(f, next);
    }
    writeFileSync(generated, `# Written by terragucci for a linked plan, and removed once it is made.\nlocals {\n${locals.join("\n")}\n}\n`);
  } catch (e) {
    restore();
    throw e;
  }
  return { reads, provisional, restore };
}
