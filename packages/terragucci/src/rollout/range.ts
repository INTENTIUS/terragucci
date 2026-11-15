/**
 * The edits behind `terragucci pin modules` and `pin providers`: a module
 * call's `version`, or a `required_providers` entry's `version`, becomes an
 * exact version. chant's pin edit moves one exact pin to another and refuses
 * a constraint, which has no one version to move from; here the constraint as
 * written is the `from`. A call or entry with no `version` at all has the
 * placeholder `UNVERSIONED` as its `from`, and the edit adds the attribute.
 *
 * The edits keep the discipline of chant's: the HCL reader says which calls
 * and entries exist and what their values are, a scanner places the literal
 * (chant's for a module block's own attributes; the one here for the objects
 * inside `required_providers`, which chant's does not enter), the literal has
 * to read back as the value the reader gave, and the edited file has to parse
 * to the same tree with only the pinned values changed. Anything else writes
 * nothing, and the call is reported refused with why.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { escapeHcl, scanBlocks, unescapeHcl } from "@intentius/chant-lexicon-terraform/pin/scan";

/** The `from` of a call or entry that has no `version`. No constraint reads like it. */
export const UNVERSIONED = "(none)";

export interface RangeRequest {
  /** The module the call names, its source as `readModulePin` reads it. */
  module: string;
  /** The constraint as written in the call's `version`, or `UNVERSIONED`. */
  from: string;
  /** The exact version it becomes. */
  to: string;
}

export interface ProviderRequest {
  /** The provider's address, or its last two parts (`hashicorp/aws`). */
  provider: string;
  from: string;
  to: string;
}

export interface RangeEdit {
  content: string;
  calls: Array<{ call: string; outcome: "moved" | "refused"; reason?: string }>;
}

type Tree = Record<string, unknown>;
interface Splice {
  start: number;
  end: number;
  text: string;
}

/** The last two parts of a provider address, lowercased: `registry.opentofu.org/hashicorp/aws` is `hashicorp/aws`. */
export const providerKey = (address: string): string => address.split("/").slice(-2).join("/").toLowerCase();

function applySplices(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

async function verify(parser: Hcl2Json, file: string, content: string, expected: Tree): Promise<void> {
  const reread = (await parser.parse(file, content)) as Tree;
  if (JSON.stringify(reread) !== JSON.stringify(expected)) throw new Error(`${file}: the pin edit would change more than the pin, so nothing was written`);
}

/**
 * The splice that adds `version = "<to>"` on its own line after the attribute
 * whose string literal ends at `literalEnd` (the index of its closing quote),
 * or why it cannot be placed: that line has to hold nothing but the attribute.
 */
function addAfter(text: string, literalEnd: number, to: string): Splice | string {
  const eol = text.indexOf("\n", literalEnd);
  const lineEnd = eol < 0 ? text.length : eol;
  if (!/^\s*,?\s*(#.*|\/\/.*)?$/.test(text.slice(literalEnd + 1, lineEnd))) return "its source shares a line with other text, so there is no line to add the version beside";
  const lineStart = text.lastIndexOf("\n", literalEnd) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  return { start: lineEnd, end: lineEnd, text: `\n${indent}version = "${escapeHcl(to)}"` };
}

// ── module calls ─────────────────────────────────────────────────────────────

/** Whether a call with no `version` is one a registry resolves: not a git, OCI or local source, which carry their pin in the address. */
export function isUnversionedRegistry(source: string, version: string | undefined): boolean {
  if (version !== undefined) return false;
  const pin = readModulePin(source);
  return pin.pin === null && pin.at === "source" && /no version argument/.test(pin.unpinned ?? "");
}

/** Move every call of `request.module` whose `version` reads `request.from` to `request.to`, in one `.tf` file. */
export async function pinRange(text: string, file: string, request: RangeRequest, parser: Hcl2Json): Promise<RangeEdit> {
  const tree = (await parser.parse(file, text)) as Tree;
  const expected = structuredClone(tree);
  const blocks = scanBlocks(text, file);
  const modules = (tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  const expectedModules = (expected.module as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  const calls: RangeEdit["calls"] = [];
  const splices: Splice[] = [];

  for (const [name, bodies] of Object.entries(modules)) {
    const scanned = blocks.filter((b) => b.type === "module" && b.labels.length === 1 && b.labels[0] === name);
    bodies.forEach((body, k) => {
      if (typeof body.source !== "string") return;
      const version = typeof body.version === "string" ? body.version : undefined;
      const unversioned = request.from === UNVERSIONED;
      if (unversioned ? !isUnversionedRegistry(body.source, version) || body.version !== undefined : version !== request.from) return;
      if (readModulePin(body.source, version).module !== request.module) return;
      const call = `module.${name}`;
      const attr = (n: string) => scanned[k]?.attributes.find((a) => a.name === n)?.literal;
      if (unversioned) {
        const source = attr("source");
        if (!source || unescapeHcl(source.raw) !== body.source) return void calls.push({ call, outcome: "refused", reason: "source is not a plain string literal, so there is no line to add the version beside" });
        const splice = addAfter(text, source.end, request.to);
        if (typeof splice === "string") return void calls.push({ call, outcome: "refused", reason: splice });
        splices.push(splice);
      } else {
        const literal = attr("version");
        if (!literal || unescapeHcl(literal.raw) !== body.version) return void calls.push({ call, outcome: "refused", reason: "version is not a plain string literal, so there is no one place to write the pin" });
        splices.push({ start: literal.start, end: literal.end, text: escapeHcl(request.to) });
      }
      expectedModules[name]![k]!.version = request.to;
      calls.push({ call, outcome: "moved" });
    });
  }

  const content = applySplices(text, splices);
  if (splices.length > 0) await verify(parser, file, content, expected);
  return { content, calls };
}

// ── required_providers ───────────────────────────────────────────────────────

/** `text` with comments, heredocs and the inside of strings blanked to filler of the same length, so a search of it finds code only and its offsets are the text's. */
function mask(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const skipString = (i: number): number => {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') {
      if (text[j] === "\\") j += 2;
      else if ((text[j] === "$" || text[j] === "%") && text[j + 1] === "{" && text[j - 1] !== text[j]) {
        let depth = 1;
        j += 2;
        while (j < text.length && depth > 0) {
          if (text[j] === '"') j = skipString(j);
          else {
            depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
            j++;
          }
        }
      } else j++;
    }
    return j;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? text.length : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? text.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"') {
      const end = skipString(i);
      for (let k = i + 1; k < end; k++) if (out[k] !== "\n") out[k] = "x";
      i = end + 1;
    } else if (c === "<" && text[i + 1] === "<") {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(text.slice(i));
      if (!m) {
        i++;
        continue;
      }
      let j = i + m[0].length;
      for (;;) {
        const e = text.indexOf("\n", j);
        const line = text.slice(j, e < 0 ? text.length : e);
        if (line.trim() === m[1] || e < 0) {
          j = e < 0 ? text.length : e;
          break;
        }
        j = e + 1;
      }
      blank(i + m[0].length, j);
      i = j;
    } else i++;
  }
  return out.join("");
}

/** The index of the bracket that closes the one at `open` in masked text. */
function closer(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if ("{[(".includes(masked[k]!)) depth++;
    else if ("}])".includes(masked[k]!)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

interface Literal {
  start: number;
  end: number;
  raw: string;
}

interface Located {
  name: string;
  /** The entry is `name = "<constraint>"`: the legacy form, whose one string is the version. */
  legacy?: Literal;
  version?: Literal;
  source?: Literal;
}

/** The entries of every `required_providers` block in a file, in file order, with where each one's `source` and `version` literals sit. */
function locate(text: string): Located[] {
  const masked = mask(text);
  const out: Located[] = [];
  const literalAt = (q: number): Literal | undefined => {
    const end = masked.indexOf('"', q + 1);
    if (end < 0) return undefined;
    const raw = text.slice(q + 1, end);
    // A string with an interpolation is an expression, not a version to overwrite.
    return /(?<![$%])[$%]\{/.test(raw) ? undefined : { start: q + 1, end, raw };
  };
  /** The attributes at the top of the object (or block body) whose `{` is at `open`: name to the index of its value. */
  const attributes = (open: number, close: number): Map<string, number> => {
    const found = new Map<string, number>();
    const head = /([A-Za-z_][\w-]*)[ \t]*=[ \t]*/y;
    let k = open + 1;
    while (k < close) {
      if (/[\s,]/.test(masked[k]!)) {
        k++;
        continue;
      }
      head.lastIndex = k;
      const m = head.exec(masked);
      if (m && m.index < close) {
        found.set(m[1]!, k + m[0].length);
        k += m[0].length;
      }
      // Skip the value (or an unreadable statement) to the next newline or comma outside brackets.
      let depth = 0;
      while (k < close && !(depth === 0 && (masked[k] === "\n" || masked[k] === ","))) {
        if ("{[(".includes(masked[k]!)) depth++;
        else if ("}])".includes(masked[k]!)) depth--;
        k++;
      }
    }
    return found;
  };
  for (const m of masked.matchAll(/\brequired_providers\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closer(masked, open);
    if (close < 0) continue;
    for (const [name, at] of attributes(open, close)) {
      if (masked[at] === '"') out.push({ name, legacy: literalAt(at) });
      else if (masked[at] === "{") {
        const end = closer(masked, at);
        if (end < 0) continue;
        const inner = attributes(at, end);
        const string = (key: string) => (inner.has(key) && masked[inner.get(key)!] === '"' ? literalAt(inner.get(key)!) : undefined);
        out.push({ name, version: string("version"), source: string("source") });
      }
    }
  }
  return out;
}

/** One `required_providers` entry as the reader gave it, with how to set its version. */
interface Entry {
  name: string;
  key: string;
  version?: string;
  object: boolean;
  set: (v: string) => void;
}

function entriesOfTree(tree: Tree): Entry[] {
  const out: Entry[] = [];
  for (const t of (tree.terraform as Record<string, unknown>[] | undefined) ?? []) {
    for (const rp of (t.required_providers as Record<string, unknown>[] | undefined) ?? []) {
      for (const [name, value] of Object.entries(rp)) {
        if (typeof value === "string") out.push({ name, key: `hashicorp/${name}`, version: value, object: false, set: (v) => void (rp[name] = v) });
        else if (value && typeof value === "object") {
          const o = value as Record<string, unknown>;
          out.push({ name, key: typeof o.source === "string" ? providerKey(o.source) : `hashicorp/${name}`, ...(typeof o.version === "string" ? { version: o.version } : {}), object: true, set: (v) => void (o.version = v) });
        }
      }
    }
  }
  return out;
}

/** The `required_providers` entries of the provider in a root's `.tf` files, with the version each declares. */
export async function providerEntries(repo: string, root: string, provider: string | undefined, parser: Hcl2Json): Promise<Array<{ file: string; name: string; provider: string; version?: string }>> {
  const dir = join(repo, root);
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; name: string; provider: string; version?: string }> = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tf")).sort()) {
    const file = root === "." ? f : posix.join(root, f);
    const tree = (await parser.parse(file, readFileSync(join(dir, f), "utf-8"))) as Tree;
    for (const e of entriesOfTree(tree)) if (provider === undefined || e.key === providerKey(provider)) out.push({ file, name: e.name, provider: e.key, ...(e.version !== undefined ? { version: e.version } : {}) });
  }
  return out;
}

/** Move every `required_providers` entry of `request.provider` whose `version` reads `request.from` to `request.to`, in one `.tf` file. */
export async function pinProviderRange(text: string, file: string, request: ProviderRequest, parser: Hcl2Json): Promise<RangeEdit> {
  const tree = (await parser.parse(file, text)) as Tree;
  const expected = structuredClone(tree);
  const entries = entriesOfTree(tree);
  const expectedEntries = entriesOfTree(expected);
  const located = locate(text);
  const calls: RangeEdit["calls"] = [];
  const splices: Splice[] = [];
  const want = providerKey(request.provider);
  const unversioned = request.from === UNVERSIONED;
  const seen = new Map<string, number>();

  entries.forEach((e, index) => {
    // The scanner and the reader list a name's entries in the same order: pair the nth of each.
    const n = seen.get(e.name) ?? 0;
    seen.set(e.name, n + 1);
    if (e.key !== want || (unversioned ? e.version !== undefined : e.version !== request.from)) return;
    const call = `provider.${e.name}`;
    const place = located.filter((l) => l.name === e.name)[n];
    const refuse = (reason: string) => void calls.push({ call, outcome: "refused", reason });
    if (!place) return refuse("the entry is not where the scanner can place it, so nothing was written");
    if (unversioned) {
      if (!e.object) return;
    }
    if (unversioned) {
      const source = place.source;
      if (!source) return refuse("the entry has no source line to add the version beside");
      const splice = addAfter(text, source.end, request.to);
      if (typeof splice === "string") return refuse(splice);
      splices.push(splice);
    } else {
      const literal = e.object ? place.version : place.legacy;
      if (!literal || unescapeHcl(literal.raw) !== e.version) return refuse("version is not a plain string literal, so there is no one place to write the pin");
      splices.push({ start: literal.start, end: literal.end, text: escapeHcl(request.to) });
    }
    expectedEntries[index]!.set(request.to);
    calls.push({ call, outcome: "moved" });
  });

  const content = applySplices(text, splices);
  if (splices.length > 0) await verify(parser, file, content, expected);
  return { content, calls };
}
