/**
 * `terragucci import terragrunt-scale [.gruntwork]`: terragucci.yml from a
 * Terragrunt Scale (Gruntwork Pipelines) repo's `.gruntwork` HCL, by the
 * guide's Terragrunt Scale table (SCALE_TABLE in ./guide.ts).
 *
 * Pipelines reads every `.hcl` file in `.gruntwork/` and a `gruntwork.hcl`
 * beside a unit's `terragrunt.hcl`
 * (https://docs.gruntwork.io/2.0/reference/pipelines/configurations-as-code/).
 * An `environment` block's `filter.paths` picks units and its
 * `authentication.aws_oidc` names a plan and an apply role
 * (https://docs.gruntwork.io/2.0/reference/pipelines/configurations-as-code/api);
 * a unit's `gruntwork.hcl` `unit` block overrides them for that unit. The
 * roles become `terragrunt.credentials`, terragucci's roles by unit path in a
 * Terragrunt repo, so each environment keeps its own pair.
 *
 * A filter path covers the units under the directories it matches ("all
 * units located within the an-environment directory" for `an-environment/*`),
 * so `live/prod/*` becomes `live/prod/**` (unitGlobs). Pipelines refuses a unit that two
 * environments match, so their order does not matter; a unit's own block is
 * listed first, since the first glob a unit matches wins.
 *
 * Role ARNs may name an account of the `aws` block's `accounts.yml` by
 * reference (`aws.accounts.all.prod.id`); those are read. Any other
 * expression is named and left out: only Pipelines evaluates it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig, type ProjectSettings, type RolePair } from "../config";
import { globMatch } from "../detect";
import { detectTerragrunt, walkUnits } from "../terragrunt";
import { SCALE_URL } from "./guide";
import { isMap, Notes, type ImportNote } from "./notes";

// ── a small HCL reader ──────────────────────────────────────────────────────

/** An expression as written: what this import can read, and `raw` for anything else. */
export type Expr =
  | { t: "str"; parts: (string | Expr)[] }
  | { t: "lit"; v: number | boolean | null }
  | { t: "list"; items: Expr[] }
  | { t: "obj"; entries: [string, Expr][] }
  | { t: "ref"; path: string[] }
  | { t: "raw"; text: string };

export interface Block {
  type: string;
  labels: string[];
  attrs: Map<string, Expr>;
  blocks: Block[];
}

const IDENT = /[A-Za-z0-9_-]/;

/** Parse HCL text into its top-level body; throws on text that is not HCL. */
export function parseHcl(text: string): Block {
  let i = 0;
  const fail = (what: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new Error(`line ${line}: ${what}`);
  };
  const space = (newlines: boolean): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) i++;
      else if (c === "#" || (c === "/" && text[i + 1] === "/")) while (i < text.length && text[i] !== "\n") i++;
      else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 2;
      } else break;
    }
  };
  const ident = (): string => {
    const start = i;
    while (i < text.length && IDENT.test(text[i])) i++;
    if (i === start) fail(`expected a name, found ${JSON.stringify(text[i] ?? "the end")}`);
    return text.slice(start, i);
  };
  /** The text of a balanced span from an opening bracket, quotes skipped. */
  const balanced = (): string => {
    const start = i;
    let depth = 0;
    for (let quoted = false; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && --depth === 0) {
        i++;
        break;
      }
    }
    return text.slice(start, i);
  };
  const string = (): Expr => {
    i++; // the opening quote
    const parts: (string | Expr)[] = [];
    let lit = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const n = text[i + 1];
        lit += n === "n" ? "\n" : n === "t" ? "\t" : n;
        i += 2;
      } else if (text[i] === "$" && text[i + 1] === "{") {
        if (lit) parts.push(lit);
        lit = "";
        i++;
        const inner = balanced();
        parts.push(exprOf(inner.slice(1, -1)));
      } else lit += text[i++];
    }
    if (text[i] !== '"') fail("a string has no closing quote");
    i++;
    if (lit || !parts.length) parts.push(lit);
    return { t: "str", parts };
  };
  const primary = (): Expr => {
    space(false);
    const c = text[i];
    if (c === '"') return string();
    if (c === "[") {
      i++;
      const items: Expr[] = [];
      for (;;) {
        space(true);
        if (text[i] === "]") {
          i++;
          return { t: "list", items };
        }
        items.push(expr());
        space(true);
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("expected , or ] in a list");
      }
    }
    if (c === "{") {
      i++;
      const entries: [string, Expr][] = [];
      for (;;) {
        space(true);
        if (text[i] === "}") {
          i++;
          return { t: "obj", entries };
        }
        const key = text[i] === '"' ? partsText(string()) ?? fail("a map key is not a plain string") : ident();
        space(false);
        if (text[i] !== "=" && text[i] !== ":") fail("expected = in a map");
        i++;
        entries.push([key, expr()]);
        space(false);
        if (text[i] === ",") i++;
      }
    }
    if (c !== undefined && /[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(text.slice(i))!;
      i += m[0].length;
      return { t: "lit", v: Number(m[0]) };
    }
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      const start = i;
      const name = ident();
      if (name === "true" || name === "false") return { t: "lit", v: name === "true" };
      if (name === "null") return { t: "lit", v: null };
      if (text[i] === "(") {
        balanced();
        return { t: "raw", text: text.slice(start, i) };
      }
      const path = [name];
      for (;;) {
        if (text[i] === "." && /[A-Za-z_]/.test(text[i + 1] ?? "")) {
          i++;
          path.push(ident());
        } else if (text[i] === "[" && text[i + 1] === '"') {
          i++;
          const k = partsText(string());
          if (k === undefined || text[i] !== "]") return { t: "raw", text: text.slice(start, (i = skipExpr(start))) };
          i++;
          path.push(k);
        } else break;
      }
      return { t: "ref", path };
    }
    return fail(`expected a value, found ${JSON.stringify(c ?? "the end")}`);
  };
  /** The end of an expression from `start`: the end of the line or of the enclosing bracket, at depth 0. */
  const skipExpr = (start: number): number => {
    let j = start;
    let depth = 0;
    for (let quoted = false; j < text.length; j++) {
      const c = text[j];
      if (quoted) {
        if (c === "\\") j++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if ((c === "\n" || c === ",") && depth === 0) break;
    }
    return j;
  };
  /** One expression; an operator, a conditional or a for after a value makes it raw. */
  const expr = (): Expr => {
    space(false);
    const start = i;
    const e = primary();
    space(false);
    const next = text[i];
    if (next === undefined || next === "\n" || next === "," || next === "]" || next === "}" || next === ")") return e;
    i = skipExpr(start);
    return { t: "raw", text: text.slice(start, i).trim() };
  };
  function exprOf(inner: string): Expr {
    try {
      const b = parseHcl(`x = ${inner}\n`);
      return b.attrs.get("x") ?? { t: "raw", text: inner };
    } catch {
      return { t: "raw", text: inner };
    }
  }
  const body = (top: boolean): Block => {
    const out: Block = { type: "", labels: [], attrs: new Map(), blocks: [] };
    for (;;) {
      space(true);
      if (i >= text.length) {
        if (!top) fail("a block has no closing }");
        return out;
      }
      if (text[i] === "}") {
        if (top) fail("a } closes no block");
        i++;
        return out;
      }
      const name = ident();
      space(false);
      if (text[i] === "=") {
        i++;
        out.attrs.set(name, expr());
        continue;
      }
      const labels: string[] = [];
      while (text[i] !== "{") {
        if (text[i] === '"') labels.push(partsText(string()) ?? fail("a block label is not a plain string"));
        else labels.push(ident());
        space(false);
      }
      i++;
      const b = body(false);
      out.blocks.push({ ...b, type: name, labels });
    }
  };
  return body(true);
}

/** A string with no interpolation, as its text. */
function partsText(e: Expr): string | undefined {
  return e.t === "str" && e.parts.every((p) => typeof p === "string") ? e.parts.join("") : undefined;
}

/** An expression as HCL text, for a note. */
function show(e: Expr): string {
  switch (e.t) {
    case "str":
      return `"${e.parts.map((p) => (typeof p === "string" ? p : `\${${show(p)}}`)).join("")}"`;
    case "lit":
      return String(e.v);
    case "list":
      return `[${e.items.map(show).join(", ")}]`;
    case "obj":
      return `{ ${e.entries.map(([k, v]) => `${k} = ${show(v)}`).join(", ")} }`;
    case "ref":
      return e.path.join(".");
    case "raw":
      return e.text;
  }
}

// ── the conversion ──────────────────────────────────────────────────────────

/** Where Pipelines reads its config: the `.gruntwork` directory. */
export const GRUNTWORK_DIR = ".gruntwork";

/**
 * A filter path as unit globs: the units it matches and the units under each
 * directory it matches. `live/prod/*` is `live/prod/**`; `live/prod` is
 * `live/prod` and `live/prod/**`, since `/**` needs a directory below.
 */
export function unitGlobs(path: string): string[] | undefined {
  const parts = path.trim().split("/").filter((p) => p !== "" && p !== ".");
  if (path.trim().startsWith("/") || parts.includes("..")) return undefined;
  if (!parts.length) return ["**"];
  const last = parts[parts.length - 1];
  const p = parts.join("/");
  if (last === "**") return [p];
  if (last === "*") return [`${p}*`];
  return [p, `${p}/**`];
}

export interface ScaleFile {
  /** The file's path from the repo root. */
  path: string;
  text: string;
}

export interface ScaleInput {
  /** The `.gruntwork/*.hcl` files, by path from the repo root. */
  global: ScaleFile[];
  /** Each unit's `gruntwork.hcl`, by the unit's path. */
  units: { unit: string; file: ScaleFile }[];
  /** Read a file the `aws` block names, by path from the repo root; undefined when it is not there. */
  read: (path: string) => string | undefined;
  /** The `.gruntwork` directory's path from the repo root. */
  dir?: string;
  /** The repo's units; each glob that matches none is named. */
  unitPaths?: string[];
}

export interface ScaleConverted {
  settings: ProjectSettings;
  notes: ImportNote[];
  /** Globs that match no unit. */
  missing: string[];
}

const TOP_BLOCKS = new Set(["environment", "aws", "repository", "annotation"]);
const OIDC_BLOCK_KEYS = new Set(["account_id", "plan_iam_role_arn", "apply_iam_role_arn", "region", "session_duration"]);
const BINARIES: Record<string, "tofu" | "terraform"> = { opentofu: "tofu", terraform: "terraform" };

/** Turn a Terragrunt Scale repo's Pipelines HCL into terragucci settings and a note per setting. */
export function convertTerragruntScale(input: ScaleInput): ScaleConverted {
  const notes = new Notes(SCALE_URL);
  const dir = input.dir ?? GRUNTWORK_DIR;
  const parsed: { file: string; body: Block }[] = [];
  for (const f of input.global) {
    try {
      parsed.push({ file: f.path, body: parseHcl(f.text) });
    } catch (e) {
      throw new ConfigError(`${f.path} is not HCL this import reads: ${(e as Error).message}`);
    }
  }

  // The aws block's accounts, by block label, then account name.
  const accounts = new Map<string, Record<string, unknown>>();
  for (const { file, body } of parsed) {
    for (const aws of body.blocks.filter((b) => b.type === "aws")) {
      for (const acc of aws.blocks) {
        const at = `${file}: aws.accounts.${acc.labels[0] ?? ""}`;
        if (acc.type !== "accounts" || acc.labels.length !== 1) {
          notes.unknown(`${file}: aws.${acc.type}`);
          continue;
        }
        const p = acc.attrs.get("path");
        const path = p && partsText(p);
        if (path === undefined) {
          notes.scale("unmapped", `${at}.path`, "Accounts", "its path is not a plain string, so the accounts it names are not read");
          continue;
        }
        // The docs give the path from the repo root and, in one example, from .gruntwork; the first file found is read.
        const tried = [join(".", path), join(dir, path)].map((x) => x.split("\\").join("/"));
        const found = tried.map((x) => ({ x, text: x.startsWith("..") ? undefined : input.read(x) })).find((r) => r.text !== undefined);
        if (!found) {
          notes.scale("unmapped", `${at}.path`, "Accounts", `${path} is not in the repo, so the roles that name its accounts are not read`);
          continue;
        }
        let doc: unknown;
        try {
          doc = parseYAML(found.text!);
        } catch (e) {
          throw new ConfigError(`${found.x} is not YAML: ${(e as Error).message}`);
        }
        if (!isMap(doc)) throw new ConfigError(`${found.x} is not a map of accounts`);
        accounts.set(acc.labels[0], doc);
        notes.scale("default", at, "Accounts", `read ${found.x}`);
      }
    }
  }

  /** An expression as a string, with account references read; undefined when only Pipelines can evaluate it. */
  const value = (e: Expr | undefined): string | undefined => {
    if (!e) return undefined;
    if (e.t === "str") {
      const out = e.parts.map((p) => (typeof p === "string" ? p : value(p)));
      return out.every((p) => p !== undefined) ? out.join("") : undefined;
    }
    if (e.t === "ref" && e.path.length === 5 && e.path[0] === "aws" && e.path[1] === "accounts") {
      const entry = accounts.get(e.path[2])?.[e.path[3]];
      const v = isMap(entry) ? entry[e.path[4]] : undefined;
      return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    }
    return undefined;
  };

  /** An authentication block as a role pair, with a note; undefined when it writes none. */
  const rolesOf = (auth: Block | undefined, at: string): RolePair | "none" | undefined => {
    if (!auth) {
      notes.scale("unmapped", at, "Roles", "it has no authentication block");
      return undefined;
    }
    for (const k of auth.attrs.keys()) notes.unknown(`${at}.authentication.${k}`);
    if (!auth.blocks.length) {
      notes.scale("default", `${at}.authentication`, "No authentication");
      return "none";
    }
    let pair: RolePair | undefined;
    for (const b of auth.blocks) {
      const key = `${at}.authentication.${b.type}`;
      if (b.type === "azure_oidc" || b.type === "gcp_oidc" || b.type === "custom") {
        notes.scale("unmapped", key, "Other clouds");
        continue;
      }
      if (b.type !== "aws_oidc") {
        notes.unknown(key);
        continue;
      }
      for (const k of b.attrs.keys()) if (!OIDC_BLOCK_KEYS.has(k)) notes.unknown(`${key}.${k}`);
      const plan = value(b.attrs.get("plan_iam_role_arn"));
      const apply = value(b.attrs.get("apply_iam_role_arn"));
      const unread = (["plan_iam_role_arn", "apply_iam_role_arn"] as const).filter((k) => value(b.attrs.get(k)) === undefined);
      if (unread.length) {
        const shown = unread.map((k) => `${k} = ${b.attrs.has(k) ? show(b.attrs.get(k)!) : "(unset)"}`).join("; ");
        notes.scale("unmapped", key, "Roles", `${shown}: only Pipelines can evaluate it, so set this pair in terragrunt.credentials by hand`);
        continue;
      }
      if (plan === apply) {
        notes.scale("unmapped", key, "Roles", `plan and apply are both ${plan}; plan runs pull-request code, so give it a read-only role of its own and add the pair by hand`);
        continue;
      }
      pair = { plan: plan!, apply: apply! };
    }
    return pair;
  };

  const credentials: [string, RolePair][] = [];
  const add = (globs: string[], pair: RolePair, key: string): void => {
    const taken: string[] = [];
    for (const glob of globs) {
      const had = credentials.find(([g]) => g === glob);
      if (had && (had[1].plan !== pair.plan || had[1].apply !== pair.apply)) {
        notes.scale("unmapped", `${key}: ${glob}`, "Roles", `${glob} already takes ${had[1].plan} and ${had[1].apply}`);
        continue;
      }
      if (!had) credentials.push([glob, pair]);
      taken.push(glob);
    }
    if (taken.length) notes.scale("mapped", key, "Roles", `terragrunt.credentials ${taken.map((g) => `"${g}"`).join(", ")}: plan ${pair.plan}, apply ${pair.apply}`);
  };

  // Each unit's own block first: the first glob a unit matches wins.
  for (const { unit, file } of [...input.units].sort((a, b) => a.unit.localeCompare(b.unit))) {
    let body: Block;
    try {
      body = parseHcl(file.text);
    } catch (e) {
      throw new ConfigError(`${file.path} is not HCL this import reads: ${(e as Error).message}`);
    }
    for (const k of body.attrs.keys()) notes.unknown(`${file.path}: ${k}`);
    for (const b of body.blocks) {
      if (b.type !== "unit") {
        notes.unknown(`${file.path}: ${b.type}`);
        continue;
      }
      const at = `${file.path}: unit`;
      const auth = b.blocks.find((x) => x.type === "authentication");
      for (const x of b.blocks) if (x.type !== "authentication") notes.unknown(`${at}.${x.type}`);
      // An empty block turns the environment's roles off for this unit, which no glob can say.
      if (auth && !auth.blocks.length && !auth.attrs.size) {
        notes.scale("unmapped", `${at}.authentication`, "No authentication", `${unit} still takes the roles of the environment it is in, if any`);
        continue;
      }
      const pair = rolesOf(auth, at);
      if (pair && pair !== "none") add([unit], pair, `${at}.authentication.aws_oidc`);
    }
  }

  let binary: "tofu" | "terraform" | undefined;
  for (const { file, body } of parsed) {
    for (const k of body.attrs.keys()) notes.unknown(`${file}: ${k}`);
    for (const b of body.blocks) {
      if (!TOP_BLOCKS.has(b.type)) {
        notes.unknown(`${file}: ${b.type}`);
        continue;
      }
      if (b.type === "environment") {
        const at = `${file}: environment.${b.labels[0] ?? ""}`;
        const filter = b.blocks.find((x) => x.type === "filter");
        const paths = filter?.attrs.get("paths");
        const globs: string[] = [];
        if (paths?.t === "list") {
          for (const p of paths.items) {
            const text = partsText(p);
            const glob = text === undefined ? undefined : unitGlobs(text);
            if (glob === undefined) notes.scale("unmapped", `${at}.filter.paths`, "Roles", `${show(p)} is not a path inside the repo`);
            else globs.push(...glob);
          }
        } else notes.scale("unmapped", `${at}.filter`, "Roles", "it has no filter.paths list");
        const pair = rolesOf(b.blocks.find((x) => x.type === "authentication"), at);
        if (pair && pair !== "none" && globs.length) add(globs, pair, `${at}.authentication.aws_oidc`);
      } else if (b.type === "repository") {
        for (const [k, v] of b.attrs) {
          const at = `${file}: repository.${k}`;
          const bin = k === "tf_binary" ? BINARIES[partsText(v) ?? ""] : undefined;
          if (bin) {
            binary = bin;
            notes.scale("mapped", at, "Binary", `binary: ${bin}`);
          } else if (k === "tf_binary") notes.scale("unmapped", at, "Binary", `${show(v)} is not opentofu or terraform`);
          else notes.scale("unmapped", at, "Other settings");
        }
        for (const x of b.blocks) notes.scale("unmapped", `${file}: repository.${x.type}${x.labels.length ? `.${x.labels[0]}` : ""}`, "Other settings");
      } else if (b.type === "annotation") notes.scale("unmapped", `${file}: annotation.${b.labels[0] ?? ""}`, "Other settings");
    }
  }

  notes.own("when it applies", "default", "Pipelines plans on the pull request and applies after merge", "apply.when: merge, terragucci's default");
  const s: ProjectSettings = {};
  if (binary) s.binary = binary;
  if (credentials.length) s.terragrunt = { credentials: Object.fromEntries(credentials) };
  validateConfig(s, "terragucci.yml");
  const missing = input.unitPaths ? credentials.map(([g]) => g).filter((g) => !input.unitPaths!.some((u) => globMatch(g, u))) : [];
  return { settings: s, notes: notes.list, missing };
}

/** Read a repo's `.gruntwork` directory (or `dir`) and each unit's `gruntwork.hcl`, and convert them. */
export function readTerragruntScale(repo: string, dir = GRUNTWORK_DIR): ScaleConverted & { from: string } {
  const abs = resolve(repo, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ConfigError(`import terragrunt-scale reads the ${dir} directory, and there is none in ${repo}`);
  const rel = relative(repo, abs).split("\\").join("/") || ".";
  const hcl = readdirSync(abs).filter((n) => n.endsWith(".hcl")).sort();
  if (!hcl.length) {
    const legacy = existsSync(join(abs, "config.yml")) || existsSync(join(abs, "config.yaml"));
    throw new ConfigError(
      legacy
        ? `${rel} holds the legacy config.yml, which names no roles; Pipelines' HCL configuration does (environment blocks), or set terragrunt.credentials by hand`
        : `${rel} holds no .hcl files`,
    );
  }
  if (!detectTerragrunt(repo)) throw new ConfigError(`${repo} has no root.hcl, terragrunt.hcl or terragrunt.stack.hcl; import terragrunt-scale writes roles by unit, for a Terragrunt repo`);
  const units = walkUnits(repo).map((u) => u.path);
  const read = (p: string): string | undefined => {
    const f = join(repo, p);
    return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf-8") : undefined;
  };
  const converted = convertTerragruntScale({
    dir: rel,
    global: hcl.map((n) => ({ path: `${rel}/${n}`, text: readFileSync(join(abs, n), "utf-8") })),
    units: units.filter((u) => existsSync(join(repo, u, "gruntwork.hcl"))).map((u) => ({ unit: u, file: { path: `${u}/gruntwork.hcl`, text: readFileSync(join(repo, u, "gruntwork.hcl"), "utf-8") } })),
    read,
    unitPaths: units,
  });
  return { ...converted, from: rel };
}
