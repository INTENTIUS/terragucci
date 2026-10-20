/**
 * The `resource` blocks a platform's admin code declares, read from the
 * repo's `.tf` files without the HCL parser: `import spacelift` reads
 * `spacelift_*` resources and `import env0` reads `env0_*` ones. An
 * attribute comes back as what it is written as: a string, a bool, a number,
 * a list, a reference (`spacelift_stack.app.id`), a `file("...")` call, or,
 * for anything else, its expression text. Strings that interpolate keep their
 * `${...}` text, so a caller can tell they are not literal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type HclValue = string | boolean | number | HclValue[] | { ref: string } | { file: string } | { expr: string };

export interface HclBody {
  attrs: Record<string, HclValue>;
  blocks: { type: string; labels: string[]; body: HclBody }[];
}

export interface HclResource {
  type: string;
  name: string;
  /** The file it is in, relative to the repo. */
  file: string;
  body: HclBody;
}

const SKIP = new Set(["node_modules", ".git", ".terraform", ".terragrunt-cache", ".terragucci"]);

class Reader {
  i = 0;
  constructor(readonly s: string) {}

  /** Spaces, comments and, unless `inline`, newlines. */
  ws(inline = false): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r" || (!inline && c === "\n")) this.i++;
      else if (c === "#" || (c === "/" && s[this.i + 1] === "/")) while (this.i < s.length && s[this.i] !== "\n") this.i++;
      else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else break;
    }
  }

  ident(): string {
    const m = /^[A-Za-z_][\w-]*/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }

  /** A quoted string from its opening quote, escapes read, `${...}` kept as written. */
  str(): string {
    const s = this.s;
    let out = "";
    this.i++;
    while (this.i < s.length && s[this.i] !== '"') {
      if (s[this.i] === "\\") {
        const n = s[this.i + 1];
        out += n === "n" ? "\n" : n === "t" ? "\t" : (n ?? "");
        this.i += 2;
      } else if (s[this.i] === "$" && s[this.i + 1] === "{") {
        const start = this.i;
        this.skipBalanced("{", "}", this.i + 1);
        out += s.slice(start, this.i);
      } else out += s[this.i++];
    }
    this.i++;
    return out;
  }

  /** Past the bracket that closes the one at `at`, strings minded. */
  skipBalanced(open: string, close: string, at: number): void {
    let depth = 0;
    this.i = at;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"') {
        this.str();
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        this.i++;
        return;
      }
      this.i++;
    }
  }

  heredoc(): string {
    const m = /^<<(-?)([A-Za-z_]\w*)[^\n]*\n/.exec(this.s.slice(this.i));
    if (!m) return this.raw();
    this.i += m[0].length;
    const lines: string[] = [];
    while (this.i < this.s.length) {
      const end = this.s.indexOf("\n", this.i);
      const line = this.s.slice(this.i, end < 0 ? this.s.length : end);
      this.i = end < 0 ? this.s.length : end + 1;
      if (line.trim() === m[2]) break;
      lines.push(line);
    }
    if (m[1]) {
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
      return lines.map((l) => l.slice(indent)).join("\n") + "\n";
    }
    return lines.join("\n") + "\n";
  }

  /** An expression's text up to a newline, comma or closing bracket at its own depth. */
  raw(): string {
    const s = this.s;
    const start = this.i;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        this.str();
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === "\n" || c === ",")) break;
      this.i++;
    }
    return s.slice(start, this.i).trim();
  }

  value(): HclValue {
    this.ws(true);
    const c = this.s[this.i];
    if (c === '"') {
      const start = this.i;
      const v = this.str();
      // A string that goes on as an expression ("a" == x) is the expression.
      this.ws(true);
      const next = this.s[this.i];
      if (next !== undefined && !"\n,]})#/".includes(next)) {
        this.i = start;
        return { expr: this.raw() };
      }
      return v;
    }
    if (c === "[") {
      this.i++;
      const out: HclValue[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === "]" || this.i >= this.s.length) {
          this.i++;
          return out;
        }
        out.push(this.value());
        this.ws();
        if (this.s[this.i] === ",") this.i++;
      }
    }
    if (c === "{") {
      const start = this.i;
      this.skipBalanced("{", "}", this.i);
      return { expr: this.s.slice(start, this.i) };
    }
    if (c === "<" && this.s[this.i + 1] === "<") return this.heredoc();
    const text = this.raw();
    if (text === "true" || text === "false") return text === "true";
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (/^[A-Za-z_][\w-]*(\.[\w-]+)+$/.test(text)) return { ref: text };
    const file = /^file\(\s*"([^"]*)"\s*\)$/.exec(text);
    if (file) return { file: file[1] };
    return { expr: text };
  }

  /** A body's attributes and blocks, up to its closing brace or the end of the file. */
  body(): HclBody {
    const out: HclBody = { attrs: {}, blocks: [] };
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return out;
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const name = this.ident();
      if (!name) {
        // Not something this reader follows: skip the line.
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
        continue;
      }
      this.ws(true);
      if (this.s[this.i] === "=" && this.s[this.i + 1] !== "=") {
        this.i++;
        out.attrs[name] = this.value();
        continue;
      }
      const labels: string[] = [];
      while (this.s[this.i] === '"' || /[A-Za-z_]/.test(this.s[this.i] ?? "")) {
        labels.push(this.s[this.i] === '"' ? this.str() : this.ident());
        this.ws(true);
      }
      if (this.s[this.i] === "{") {
        this.i++;
        out.blocks.push({ type: name, labels, body: this.body() });
      }
    }
  }
}

/** A file's top-level body. */
export function parseHcl(text: string): HclBody {
  return new Reader(text).body();
}

/** Every `.tf` file in the repo, skipping dot directories and modules' caches. */
function tfFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith(".")) continue;
      const abs = join(dir, n);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (n.endsWith(".tf") || n.endsWith(".tofu")) out.push(abs);
    }
  };
  walk(repo);
  return out;
}

/** The repo's `resource` blocks whose type starts with `prefix`, in file order. */
export function resourcesOf(repo: string, prefix: string): HclResource[] {
  const out: HclResource[] = [];
  for (const f of tfFiles(repo)) {
    const text = readFileSync(f, "utf-8");
    if (!text.includes(`"${prefix}`)) continue;
    for (const b of parseHcl(text).blocks) {
      if (b.type === "resource" && b.labels.length === 2 && b.labels[0].startsWith(prefix)) out.push({ type: b.labels[0], name: b.labels[1], file: relative(repo, f), body: b.body });
    }
  }
  return out;
}

/** A plain string, not an interpolation. */
export function literalString(v: HclValue | undefined): string | undefined {
  return typeof v === "string" && !v.includes("${") ? v : undefined;
}

/** A list of plain strings; undefined when it is anything else. */
export function stringList(v: HclValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(literalString);
  return out.every((x): x is string => x !== undefined) ? out : undefined;
}

/** The resource a reference such as `spacelift_stack.app.id` names, as `spacelift_stack.app`. */
export function refTo(v: HclValue | undefined): string | undefined {
  if (!v || typeof v !== "object" || !("ref" in v)) return undefined;
  const parts = v.ref.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : undefined;
}

/** An attribute as the text a note quotes. */
export function shown(v: HclValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.map(shown).join(", ")}]`;
  if ("ref" in v) return v.ref;
  if ("file" in v) return `file("${v.file}")`;
  return v.expr;
}
