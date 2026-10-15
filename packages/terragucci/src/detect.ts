/**
 * What terragucci reads from a repo when the config does not say: its roots,
 * the binary, the forge, and the order roots must apply in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { matchesUnitGlob } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { ConfigError, findConfig, forgeFromHost, type Binary, type ForgeName } from "./config";
import { atmosStateReads } from "./atmos";
import { literal, stateAddress, type Attr } from "./state-address";

const SKIP_DIRS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", ".terragucci"]);

function tfFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".tf") || n.endsWith(".tofu") || isJson(n))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

/** Terraform's JSON syntax, which CDK Terrain synthesizes (`cdk.tf.json`). */
const isJson = (name: string): boolean => name.endsWith(".tf.json") || name.endsWith(".tofu.json");

function dirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

const posix = (p: string): string => p.split("\\").join("/");

/**
 * A root is a directory whose Terraform files declare a backend (or a `cloud`
 * block, or choudoufu's `live` block) or configure a provider. A child module does neither, so a module
 * with its own `terraform { required_providers }` block is not a root.
 */
export function isRoot(dir: string): boolean {
  return rootReason(dir) !== undefined;
}

/** Why a directory is a root: the first thing in its Terraform files that makes it one. */
export function rootReason(dir: string): string | undefined {
  const files = tfFiles(dir);
  for (const f of files.filter(isJson)) {
    const reason = jsonRootReason(readFileSync(f, "utf-8"));
    if (reason) return reason;
  }
  const texts = files.filter((f) => !isJson(f)).map((f) => stripComments(readFileSync(f, "utf-8")));
  for (const text of texts) {
    const m = text.match(/\bbackend\s+"([^"]+)"\s*\{/);
    if (m) return `backend ${m[1]}`;
  }
  if (texts.some((t) => /^\s*cloud\s*\{/m.test(t))) return "cloud block";
  // choudoufu keeps an estate in a record store its `terraform { live { ... } }` block names, in place of a backend.
  if (texts.some(hasLiveBlock)) return "choudoufu live block";
  for (const text of texts) {
    const m = text.match(/^\s*provider\s+"([^"]+)"\s*\{/m);
    if (m) return `provider ${m[1]}`;
  }
  return undefined;
}

/** The same reasons, read from a file in Terraform's JSON syntax. */
function jsonRootReason(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  // A `terraform` block may be an object or, in Terraform's JSON syntax, a list of them.
  const terraform = obj(doc)?.terraform;
  const blocks = (Array.isArray(terraform) ? terraform : [terraform]).map(obj).filter((b): b is Record<string, unknown> => b !== undefined);
  for (const b of blocks) {
    const backend = Object.keys(obj(b.backend) ?? {})[0];
    if (backend) return `backend ${backend}`;
  }
  if (blocks.some((b) => b.cloud !== undefined)) return "cloud block";
  const provider = Object.keys(obj(obj(doc)?.provider) ?? {})[0];
  return provider ? `provider ${provider}` : undefined;
}

/** Whether a `terraform` block holds a `live` block directly. */
function hasLiveBlock(text: string): boolean {
  for (const m of text.matchAll(/^\s*terraform\s*\{/gm)) {
    let depth = 1;
    let line = "";
    for (let i = (m.index ?? 0) + m[0].length; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (c === "{") {
        if (depth === 1 && /^\s*live\s*$/.test(line)) return true;
        depth++;
      } else if (c === "}") depth--;
      line = c === "\n" ? "" : line + c;
    }
  }
  return false;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
}

/**
 * Glob match on `/`-separated paths: `*` within a segment, `**` across
 * segments, `?` one character. chant's unit glob, which reads the glob the
 * same way; the path is made `/`-separated here, without a trailing slash.
 */
export function globMatch(glob: string, path: string): boolean {
  return matchesUnitGlob(posix(path).replace(/\/+$/, ""), glob);
}

/**
 * The repo's roots, as paths relative to `repo`, sorted. With `globs`, a
 * directory counts when it matches a glob and holds Terraform files; without
 * them, every directory that is a root by `isRoot`.
 */
export function findRoots(repo: string, globs?: string[]): string[] {
  return findRootsWithReasons(repo, globs).map((r) => r.root);
}

export interface RootReason {
  root: string;
  reason: string;
}

/** `findRoots`, with why each directory counts: the backend, cloud block or provider found, or the glob matched. */
export function findRootsWithReasons(repo: string, globs?: string[]): RootReason[] {
  const out: RootReason[] = [];
  for (const d of dirs(repo)) {
    const rel = posix(relative(repo, d)) || ".";
    if (globs) {
      const g = globs.find((x) => globMatch(x, rel));
      if (g !== undefined && tfFiles(d).length > 0) out.push({ root: rel, reason: `matches roots glob ${g}` });
    } else {
      const reason = rootReason(d);
      if (reason) out.push({ root: rel, reason });
    }
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

export interface Detected<T> {
  value: T;
  reason: string;
}

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The binary: a version file, then `.tofu` files, then what is on the path, then tofu. */
export function detectBinary(repo: string, roots: string[]): Detected<Binary> {
  if (existsSync(join(repo, ".opentofu-version"))) return { value: "tofu", reason: ".opentofu-version" };
  if (existsSync(join(repo, ".terraform-version"))) return { value: "terraform", reason: ".terraform-version" };
  // A root not on disk yet (one a synth or atmos write makes) says nothing.
  if (roots.some((r) => existsSync(join(repo, r)) && readdirSync(join(repo, r)).some((n) => n.endsWith(".tofu")))) {
    return { value: "tofu", reason: ".tofu files" };
  }
  if (onPath("tofu")) return { value: "tofu", reason: "tofu on the path" };
  if (onPath("terraform")) return { value: "terraform", reason: "terraform on the path" };
  return { value: "tofu", reason: "the default" };
}

/** The binary's version when every root pins the same exact one (`= 1.13.1` or `1.13.1`). A range is not a pin. */
export function detectVersion(repo: string, roots: string[]): string | undefined {
  const seen = new Set<string>();
  for (const r of roots) for (const v of exactRequiredVersions(join(repo, r))) seen.add(v);
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** Every exact `required_version` (`= 1.13.1` or `1.13.1`) in one directory's Terraform files. */
export function exactRequiredVersions(dir: string): string[] {
  const out: string[] = [];
  for (const f of tfFiles(dir)) {
    const m = stripComments(readFileSync(f, "utf-8")).match(/required_version\s*=\s*"\s*=?\s*(\d+\.\d+\.\d+)\s*"/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The forge: a workflow directory already in the repo, then the `origin` remote's host. */
export function detectForge(repo: string): Detected<ForgeName> | undefined {
  if (existsSync(join(repo, ".forgejo", "workflows"))) return { value: "forgejo", reason: ".forgejo/workflows" };
  if (existsSync(join(repo, ".gitea", "workflows"))) return { value: "forgejo", reason: ".gitea/workflows" };
  if (existsSync(join(repo, ".gitlab-ci.yml"))) return { value: "gitlab", reason: ".gitlab-ci.yml" };
  let remote = "";
  try {
    remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* no git, or no origin */
  }
  const host = hostOfRemote(remote);
  const fromHost = host ? forgeFromHost(host) : undefined;
  if (fromHost) return { value: fromHost, reason: `the origin remote (${host})` };
  if (existsSync(join(repo, ".github", "workflows"))) return { value: "github", reason: ".github/workflows" };
  return undefined;
}

/** The host of a git remote URL, in https, ssh or scp form. */
export function hostOfRemote(remote: string): string | undefined {
  if (!remote) return undefined;
  const url = remote.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)/i);
  if (url) return url[1];
  const scp = remote.match(/^(?:[^@]+@)?([^:/]+):/);
  return scp ? scp[1] : undefined;
}

// ── order ────────────────────────────────────────────────────────────────────

export interface StateRef {
  bucket?: string;
  key: string;
}

/** A `terraform_remote_state` block: its label, the state it reads, and whether it repeats (count or for_each). */
interface RemoteRead extends StateRef {
  name: string;
  repeated: boolean;
}

/** What a root's code says about state: its own address and the addresses it reads, and each that the code does not say, with why. */
export interface RootStateCode {
  own?: StateRef;
  reads: RemoteRead[];
  /** Why its own state has no address: its backend's address is not all plain strings in the code. */
  ownUnresolved?: string;
  /** Its `terraform_remote_state` blocks whose address is not all plain strings in the code. */
  unresolved: { name: string; why: string }[];
}

/** The text of the block that starts at `start`: up to the brace that closes its first `{`. */
export function blockBody(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

function attr(body: string, name: string): string | undefined {
  return body.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];
}

/**
 * An HCL block's attribute: its string, `null` when it is written as anything
 * but a plain string, undefined when it is not written. With `subst`, a
 * template's interpolations are read whole (quotes inside them included) and
 * `subst` rewrites the string before it is judged plain.
 */
const hclAttr =
  (body: string, subst?: (s: string) => string): Attr =>
  (name) => {
    const m = body.match(new RegExp(`(?<![\\w.-])${name}\\s*=(?!=)\\s*(.)`));
    if (!m) return undefined;
    if (m[1] !== '"') return null;
    const start = m.index! + m[0].length;
    let out = "";
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      if (body[i] === "\\") {
        out += body[++i] ?? "";
        continue;
      }
      if (subst && body[i] === "$" && body[i + 1] === "{") depth++;
      else if (subst && depth > 0 && body[i] === "}") depth--;
      if (body[i] === '"' && depth === 0) return literal(subst ? subst(out) : out) ?? null;
      out += body[i];
    }
    return null;
  };

// ── addresses from the files that supply them ───────────────────────────────

/** Later layers over earlier ones, over `base`: the last layer that writes the attribute, else `base`. */
const overlaid =
  (base: Attr, layers: Attr[]): Attr =>
  (name) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = layers[i]!(name);
      if (v !== undefined) return v;
    }
    return base(name);
  };

/** Each `-backend-config` value in a command line: `-backend-config=<v>`, `--backend-config=<v>`, or the flag and then its value. */
export function backendConfigArgs(args: string): string[] {
  const words = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1]?.replace(/\\(.)/g, "$1") ?? m[2] ?? m[3]!);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^--?backend-config(?:=(.*))?$/.exec(words[i]!);
    if (!m) continue;
    const v = m[1] ?? words[++i];
    if (v !== undefined) out.push(v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
  }
  return out;
}

/**
 * The `-backend-config` arguments every root's init takes: those in
 * `TF_CLI_ARGS` and then `TF_CLI_ARGS_init` of terragucci.yml's `env`, which
 * every job runs with. A config that cannot be read, or one in TypeScript,
 * names none.
 */
export function initBackendConfigs(repo: string): string[] {
  let env: unknown;
  try {
    const path = findConfig(repo);
    if (!path || path.endsWith(".ts")) return [];
    const text = readFileSync(path, "utf-8");
    const raw = path.endsWith(".json") ? JSON.parse(text) : text.trim() === "" ? {} : parseYAMLDocument(text);
    env = objectOf(raw)?.env;
  } catch {
    return [];
  }
  const e = objectOf(env) ?? {};
  return [e.TF_CLI_ARGS, e.TF_CLI_ARGS_init].flatMap((v) => (typeof v === "string" ? backendConfigArgs(v) : []));
}

/** The files beside a root that hold backend settings by convention: `backend.hcl`, `backend.tfvars` and `*.tfbackend`. */
function conventionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n === "backend.hcl" || n === "backend.tfvars" || n.endsWith(".tfbackend"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The backend settings a root's init takes besides its backend block, from
 * its `-backend-config` arguments: each `key=value`, and each file, read as
 * HCL key/value pairs and resolved against the root's directory, where init
 * runs. `files` names each file read, relative to the repo; `missing`, each
 * that is not there.
 */
function backendConfigLayers(repo: string, root: string, args: string[]): { layers: Attr[]; files: string[]; missing: string[] } {
  const out: { layers: Attr[]; files: string[]; missing: string[] } = { layers: [], files: [], missing: [] };
  const dir = join(repo, root);
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq >= 0) {
      // Terraform reads a value with `=` in it as one setting, not a file.
      const key = a.slice(0, eq).trim();
      const value = a.slice(eq + 1);
      out.layers.push((name) => (name === key ? (literal(value) ?? null) : undefined));
      continue;
    }
    const abs = isAbsolute(a) ? a : resolve(dir, a);
    const rel = posix(relative(repo, abs)) || ".";
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      out.missing.push(rel);
      continue;
    }
    out.files.push(rel);
    out.layers.push(hclAttr(stripComments(readFileSync(abs, "utf-8"))));
  }
  return out;
}

/** Terragrunt's unit file. */
const UNIT_FILE = "terragrunt.hcl";

/** The file an include's `path` names, from the unit's directory: `find_in_parent_folders`, `get_repo_root()` and a path, or a plain path. */
function includedFile(repo: string, unitDir: string, path: string): string | undefined {
  const find = /^"?\$?\{?\s*find_in_parent_folders\(\s*(?:"([^"]+)")?\s*\)\s*\}?"?$/.exec(path);
  if (find) {
    const name = find[1] ?? UNIT_FILE;
    const top = resolve(repo);
    for (let d = dirname(resolve(unitDir)); ; d = dirname(d)) {
      if (existsSync(join(d, name))) return join(d, name);
      if (d === top || dirname(d) === d) return undefined;
    }
  }
  const fromRoot = /^"\$\{\s*get_repo_root\(\s*\)\s*\}\/([^"$]+)"$/.exec(path);
  if (fromRoot) return join(repo, fromRoot[1]!);
  const plain = /^"([^"$]+)"$/.exec(path);
  return plain ? resolve(unitDir, plain[1]!) : undefined;
}

/**
 * A Terragrunt unit's state, from the `remote_state` block that configures
 * its backend: the unit's own `terragrunt.hcl`, else the first file it
 * includes that declares one. `path_relative_to_include()` in its config is
 * the unit's path from the included file's directory. Undefined when the
 * directory has no `terragrunt.hcl`, or no file it reads declares
 * `remote_state`.
 */
export function terragruntRemoteState(repo: string, unit: string): { ref?: StateRef; why?: string } | undefined {
  const dir = join(repo, unit);
  const own = join(dir, UNIT_FILE);
  if (!existsSync(own)) return undefined;
  const text = stripComments(readFileSync(own, "utf-8"));
  const includes: { name: string; file: string }[] = [];
  for (const m of text.matchAll(/^\s*include(?:\s+"([^"]*)")?\s*\{/gm)) {
    const path = /(?:^|[{\s])path\s*=\s*(.+?)\s*$/m.exec(blockBody(text, m.index!).replace(/^[^{]*\{/, "").replace(/\}$/, ""))?.[1];
    const file = path ? includedFile(repo, dir, path) : undefined;
    if (file && existsSync(file)) includes.push({ name: m[1] ?? "", file });
  }
  const sources = [{ file: own, text, include: includes[0] }, ...includes.map((i) => ({ file: i.file, text: stripComments(readFileSync(i.file, "utf-8")), include: i }))];
  for (const src of sources) {
    const m = /^\s*remote_state\s*=?\s*\{/m.exec(src.text);
    if (!m) continue;
    const where = posix(relative(repo, src.file));
    const body = blockBody(src.text, m.index!);
    // The unit's path from the directory of the include named, or of the include in play when none is named.
    const relTo = (name: string | undefined): string | undefined => {
      const inc = name === undefined ? src.include : includes.find((i) => i.name === name);
      if (!inc) return name === undefined ? "." : undefined;
      return posix(relative(dirname(inc.file), dir)) || ".";
    };
    const subst = (s: string): string => s.replace(/\$\{\s*path_relative_to_include\(\s*(?:"([^"]*)")?\s*\)\s*\}/g, (all, name: string | undefined) => relTo(name) ?? all);
    const type = hclAttr(body)("backend");
    if (type === null || type === undefined) return { why: `the Terragrunt remote_state block in ${where} names its backend with an expression, not a plain string` };
    const config = /\bconfig\s*=\s*\{/.exec(body);
    if (!config) return { why: `the Terragrunt remote_state block in ${where} takes its config from an expression, not an object` };
    const a = addressed(type, hclAttr(blockBody(body, config.index!).replace(/^[^{]*\{/, ""), subst), unit);
    return a.ref ? { ref: a.ref } : { why: `the Terragrunt remote_state block in ${where}: ${a.why}` };
  }
  return undefined;
}

const objectOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** A block in Terraform's JSON syntax: an object, or a list of objects whose first is taken. */
const firstOf = (v: unknown): Record<string, unknown> | undefined => objectOf(Array.isArray(v) ? v[0] : v);
/** A JSON block's attribute, or its `workspaces` block's. */
const jsonAttr =
  (b: Record<string, unknown> | undefined): Attr =>
  (name) => {
    const v = b?.[name] ?? firstOf(b?.workspaces)?.[name];
    return literal(v);
  };

/** One state the code names: its address, or why it has none. */
function addressed(type: string | null | undefined, get: Attr, root: string): { ref?: StateRef; why?: string } {
  if (type === null) return { why: "its backend is an expression, not a plain string" };
  const a = stateAddress(type ?? "local", get, root);
  return "unresolved" in a ? { why: a.unresolved } : { ref: a };
}

/**
 * The backend and the `terraform_remote_state` blocks of a file in Terraform's
 * JSON syntax, as CDK Terrain writes them: `terraform.backend.<type>` (or
 * `terraform.cloud`) and `data.terraform_remote_state.<name>.config`, each a
 * block or a list of them.
 */
function jsonState(
  raw: string,
  root: string,
  backend: (type: string, get: Attr) => { ref?: StateRef; why?: string } = (type, get) => addressed(type, get, root),
): RootStateCode & { declared: boolean } {
  let doc: unknown;
  const out: RootStateCode & { declared: boolean } = { reads: [], unresolved: [], declared: false };
  try {
    doc = JSON.parse(raw);
  } catch {
    return out;
  }
  const top = objectOf(doc);
  for (const t of Array.isArray(top?.terraform) ? top.terraform : [top?.terraform]) {
    const backends: [string, unknown][] = Object.entries(objectOf(objectOf(t)?.backend) ?? {});
    if (objectOf(t)?.cloud !== undefined) backends.push(["cloud", objectOf(t)!.cloud]);
    for (const [type, v] of backends) {
      // A cloud block takes no -backend-config.
      const own = type === "cloud" ? addressed(type, jsonAttr(firstOf(v)), root) : backend(type, jsonAttr(firstOf(v)));
      out.declared = true;
      if (own.ref) {
        out.own = own.ref;
        delete out.ownUnresolved;
      } else out.ownUnresolved = own.why;
    }
  }
  for (const d of Array.isArray(top?.data) ? top.data : [top?.data]) {
    const blocks = objectOf(objectOf(d)?.terraform_remote_state) ?? {};
    for (const [name, v] of Object.entries(blocks)) {
      const b = firstOf(v);
      const config = objectOf(b?.config);
      const read = config === undefined && b?.config !== undefined ? { why: "its config is an expression, not an object" } : addressed(literal(b?.backend), jsonAttr(config), root);
      if (read.ref) out.reads.push({ name, ...read.ref, repeated: b?.count !== undefined || b?.for_each !== undefined });
      else out.unresolved.push({ name, why: read.why! });
    }
  }
  return out;
}

/**
 * The state a root's backend block (or `cloud` block) names, and the states
 * its `terraform_remote_state` blocks read, as written in its code (HCL, or
 * Terraform's JSON syntax), each through ./state-address.ts. A root that
 * declares no backend keeps its state in `terraform.tfstate` beside its code.
 */
export function stateOf(repo: string, root: string, initArgs: string[] = initBackendConfigs(repo)): RootStateCode {
  const out: RootStateCode = { reads: [], unresolved: [] };
  let declared = false;
  const own = (o: { ref?: StateRef; why?: string }): void => {
    declared = true;
    if (o.ref) {
      out.own = o.ref;
      delete out.ownUnresolved;
    } else out.ownUnresolved = o.why;
  };
  // A backend block's settings, with the -backend-config the root's init takes over them, as init merges them.
  const supplied = initArgs.length ? backendConfigLayers(repo, root, initArgs) : undefined;
  const backend = (type: string, get: Attr): { ref?: StateRef; why?: string } => {
    const a = addressed(type, supplied ? overlaid(get, supplied.layers) : get, root);
    if (a.ref) return a;
    // Name the files tried, and the ones beside the root that init is not given.
    const one = (list: string[], singular: string, plural: string): string => (list.length === 1 ? singular : plural);
    const read = supplied?.files ?? [];
    const missing = supplied?.missing ?? [];
    const beside = conventionFiles(join(repo, root))
      .map((n) => posix(root === "." ? n : `${root}/${n}`))
      .filter((b) => !read.includes(b));
    const notes = [
      ...(read.length ? [`the -backend-config ${one(read, "file", "files")} ${read.join(", ")} from terragucci.yml's env ${one(read, "does", "do")} not supply it either`] : []),
      ...(missing.length ? [`terragucci.yml's env names -backend-config ${missing.join(", ")}, which ${one(missing, "is", "are")} not in the repo`] : []),
      ...(beside.length ? [`${beside.join(", ")} ${one(beside, "is", "are")} beside it, but no -backend-config in terragucci.yml's env names ${one(beside, "it", "them")}`] : []),
    ];
    return notes.length ? { why: `${a.why}; ${notes.join("; ")}` } : a;
  };
  for (const f of tfFiles(join(repo, root))) {
    if (isJson(f)) {
      const j = jsonState(readFileSync(f, "utf-8"), root, backend);
      if (j.declared) own(j.own ? { ref: j.own } : { why: j.ownUnresolved });
      out.reads.push(...j.reads);
      out.unresolved.push(...j.unresolved);
      continue;
    }
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bbackend\s+"([^"]+)"\s*\{/g)) own(backend(m[1], hclAttr(blockBody(text, m.index!))));
    for (const m of text.matchAll(/^\s*cloud\s*\{/gm)) own(addressed("cloud", hclAttr(blockBody(text, m.index!)), root));
    for (const m of text.matchAll(/\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const get = hclAttr(body);
      const read = addressed(get("backend"), get, root);
      if (read.ref) out.reads.push({ name: m[1], ...read.ref, repeated: /^\s*(count|for_each)\s*=/m.test(body) });
      else out.unresolved.push({ name: m[1], why: read.why! });
    }
  }
  if (!declared) own(addressed("local", () => undefined, root));
  // A Terragrunt unit's remote_state configures the backend init runs with, over its blocks: it writes the backend file, or passes its config as -backend-config.
  const tg = terragruntRemoteState(repo, root);
  if (tg?.ref) own(tg);
  else if (tg?.why) {
    delete out.own;
    out.ownUnresolved = tg.why;
  }
  return out;
}

/**
 * Each root's `terraform_remote_state` blocks that read another root's state:
 * the block's label, the root it reads, and whether the block repeats (count
 * or for_each), which a linked plan leaves on the applied state.
 */
export function remoteStateReads(repo: string, roots: string[]): Map<string, { name: string; upstream: string; repeated: boolean }[]> {
  const args = initBackendConfigs(repo);
  const states = new Map(roots.map((r) => [r, stateOf(repo, r, args)]));
  const out = new Map<string, { name: string; upstream: string; repeated: boolean }[]>(roots.map((r) => [r, []]));
  for (const [root, { reads }] of states) {
    for (const read of reads) {
      for (const [other, { own }] of states) {
        if (other === root || !own) continue;
        if (own.key === read.key && (!own.bucket || !read.bucket || own.bucket === read.bucket)) out.get(root)!.push({ name: read.name, upstream: other, repeated: read.repeated });
      }
    }
  }
  return out;
}

/**
 * The states the roots' code does not address: each `terraform_remote_state`
 * block whose address is not all plain strings, and, when any root reads
 * state that way, each root whose own backend's address is not. No edge can
 * line either up with the root at the other end.
 */
export function unaddressedStates(repo: string, roots: string[]): { root: string; own?: string; reads: { name: string; why: string }[] }[] {
  const args = initBackendConfigs(repo);
  const states = roots.map((r) => [r, stateOf(repo, r, args)] as const);
  const anyReads = states.some(([, s]) => s.reads.length > 0 || s.unresolved.length > 0);
  return states
    .map(([root, s]) => ({ root, ...(anyReads && s.ownUnresolved ? { own: s.ownUnresolved } : {}), reads: s.unresolved }))
    .filter((x) => x.own !== undefined || x.reads.length > 0);
}

/** config check's warnings for the states the roots' code does not address. */
export function addressWarnings(repo: string, roots: string[]): string[] {
  return unaddressedStates(repo, roots).flatMap((u) => [
    ...(u.own ? [`state: ${u.root} keeps its state where the code does not say (${u.own}), so a root that reads it through terraform_remote_state is not ordered after it`] : []),
    ...u.reads.map((r) => `state: ${u.root} reads state through terraform_remote_state "${r.name}" where the code does not say (${r.why}), so it is not ordered after the root that writes it`),
  ]);
}

/** Where one state is, as a backend block or a `terraform_remote_state` block names it: its bucket, when it names one, and its key. */
export interface StateAddress {
  bucket?: string;
  key: string;
}

/** Where choudoufu keeps an estate's records in its record store: the state of a root whose `live` block owns it. */
export const estateRecords = (estate: string): string => `tofu-records/${estate}`;

/**
 * A root's state as stateOf reads it, and under choudoufu its estate: the
 * records of the estate its `live` block owns as its own state (over the
 * `terraform.tfstate` a root with no backend block would keep), and each
 * `terraform_estate_outputs` read as a read of that estate's records.
 */
function withEstate(repo: string, root: string, s: { own?: StateRef; reads: RemoteRead[] }): { own?: StateRef; reads: RemoteRead[] } {
  const dir = join(repo, root);
  const { estate } = estateOf(dir);
  const reads = [...s.reads];
  for (const f of tfFiles(dir)) {
    if (isJson(f)) continue;
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bdata\s+"terraform_estate_outputs"\s+"([^"]+)"\s*\{/g)) {
      const e = attr(blockBody(text, m.index!), "estate");
      if (e) reads.push({ name: m[1]!, key: estateRecords(e), repeated: false });
    }
  }
  const implicit = addressed("local", () => undefined, root).ref;
  const own = estate && (!s.own || (implicit && sameState(s.own, implicit))) ? { key: estateRecords(estate) } : s.own;
  return { own, reads };
}

/**
 * Each root's own state, as its backend block names it (under choudoufu, the
 * records of the estate it owns), and its
 * `terraform_remote_state` reads of a state no root among `roots` holds: a
 * state another project's root may hold, which the estate page matches
 * across projects.
 */
export function rootStates(repo: string, roots: string[]): Map<string, { state?: StateAddress; external: (StateAddress & { data: string })[] }> {
  const args = initBackendConfigs(repo);
  const states = new Map(roots.map((r) => [r, withEstate(repo, r, stateOf(repo, r, args))]));
  const held = [...states.values()].flatMap((s) => (s.own ? [s.own] : []));
  const out = new Map<string, { state?: StateAddress; external: (StateAddress & { data: string })[] }>();
  for (const [root, { own, reads }] of states) {
    const external = reads
      .filter((r) => !held.some((o) => o !== own && sameState(o, r)))
      .map((r) => ({ data: r.name, ...(r.bucket !== undefined ? { bucket: r.bucket } : {}), key: r.key }));
    out.set(root, { ...(own ? { state: addressOf(own) } : {}), external });
  }
  return out;
}

const addressOf = (s: StateRef): StateAddress => ({ ...(s.bucket !== undefined ? { bucket: s.bucket } : {}), key: s.key });

/**
 * Each Terragrunt unit's own state, from the `remote_state` block it reads
 * (terragruntRemoteState), for the estate page to match a read from another
 * project. A unit whose remote_state is not all plain strings, or that has
 * none, holds no state here.
 */
export function unitStates(repo: string, units: string[]): Map<string, { state?: StateAddress; external: (StateAddress & { data: string })[] }> {
  return new Map(
    units.map((u) => {
      const ref = terragruntRemoteState(repo, u)?.ref;
      return [u, { ...(ref ? { state: addressOf(ref) } : {}), external: [] }];
    }),
  );
}

/**
 * The backend a root's code declares: its type and the attributes written as
 * plain strings, from its `.tf` files or Terraform's JSON syntax. `cloud` for
 * a `cloud` block. Undefined when the root declares neither. Backend blocks
 * take no expressions, so a string is all an attribute can be.
 */
export function backendBlock(dir: string): { type: string; attrs: Record<string, string> } | { cloud: true } | undefined {
  for (const f of tfFiles(dir)) {
    const raw = readFileSync(f, "utf-8");
    if (isJson(f)) {
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        continue;
      }
      const terraform = (doc as Record<string, unknown> | null)?.terraform;
      for (const b of (Array.isArray(terraform) ? terraform : [terraform]) as Record<string, unknown>[]) {
        if (!b || typeof b !== "object") continue;
        if (b.cloud !== undefined) return { cloud: true };
        const backends = b.backend && typeof b.backend === "object" ? (b.backend as Record<string, unknown>) : {};
        const type = Object.keys(backends)[0];
        if (!type) continue;
        const body = (Array.isArray(backends[type]) ? (backends[type] as unknown[])[0] : backends[type]) as Record<string, unknown> | undefined;
        const attrs = Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        return { type, attrs };
      }
      continue;
    }
    const text = stripComments(raw);
    const m = text.match(/\bbackend\s+"([^"]+)"\s*\{/);
    if (m) {
      const body = blockBody(text, m.index!);
      const attrs: Record<string, string> = {};
      for (const a of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gm)) attrs[a[1]] = a[2];
      return { type: m[1], attrs };
    }
    if (/^\s*cloud\s*\{/m.test(text)) return { cloud: true };
  }
  return undefined;
}

/** Two addresses name one state: the same key, and the same bucket where both name one. */
export const sameState = (a: StateAddress, b: StateAddress): boolean => a.key === b.key && (!a.bucket || !b.bucket || a.bucket === b.bucket);

/**
 * A choudoufu root's estate, from the `live` block in its `terraform` block
 * or the `estate` of its `estate.chdf.hcl`, and the estates whose recorded
 * outputs it reads through `data "terraform_estate_outputs"`.
 */
export function estateOf(dir: string): { estate?: string; reads: string[] } {
  let estate: string | undefined;
  const reads: string[] = [];
  const sidecar = join(dir, "estate.chdf.hcl");
  if (existsSync(sidecar)) estate = attr(stripComments(readFileSync(sidecar, "utf-8")), "estate");
  for (const f of tfFiles(dir)) {
    if (isJson(f)) continue;
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const t of text.matchAll(/^\s*terraform\s*\{/gm)) {
      const body = blockBody(text, t.index!);
      const live = body.match(/\blive\s*\{/);
      if (live && !estate) estate = attr(blockBody(body, live.index!), "estate");
    }
    for (const m of text.matchAll(/\bdata\s+"terraform_estate_outputs"\s+"[^"]+"\s*\{/g)) {
      const e = attr(blockBody(text, m.index!), "estate");
      if (e) reads.push(e);
    }
  }
  return { estate, reads };
}

/** The text of a root's choudoufu `live` block, comments stripped: its `estate.chdf.hcl` sidecar, else the block in its `terraform` block. */
export function liveBody(dir: string): string | undefined {
  const sidecar = join(dir, "estate.chdf.hcl");
  if (existsSync(sidecar)) return stripComments(readFileSync(sidecar, "utf-8"));
  for (const f of tfFiles(dir)) {
    if (isJson(f)) continue;
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const t of text.matchAll(/^\s*terraform\s*\{/gm)) {
      const body = blockBody(text, t.index!);
      const live = body.match(/\blive\s*\{/);
      if (live) return blockBody(body, live.index!);
    }
  }
  return undefined;
}

/** Each `data "terraform_estate_outputs"` block of a root: its label and the estate whose outputs it reads. */
export function estateOutputReads(dir: string): { name: string; estate: string }[] {
  const out: { name: string; estate: string }[] = [];
  for (const f of tfFiles(dir)) {
    if (isJson(f)) continue;
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bdata\s+"terraform_estate_outputs"\s+"([^"]+)"\s*\{/g)) {
      const e = attr(blockBody(text, m.index!), "estate");
      if (e) out.push({ name: m[1], estate: e });
    }
  }
  return out;
}

/**
 * A module's `locals` blocks, as written in its directory: each local's name
 * and the text of its value, for a reader that follows references through
 * them (plan JSON names a reference to a local but not what the local holds).
 */
export function localsText(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of tfFiles(dir)) {
    const raw = readFileSync(f, "utf-8");
    if (isJson(f)) {
      try {
        const doc = JSON.parse(raw) as { locals?: unknown };
        for (const block of Array.isArray(doc.locals) ? doc.locals : [doc.locals]) {
          for (const [name, v] of Object.entries(objectOf(block) ?? {})) out.set(name, JSON.stringify(v));
        }
      } catch {
        // Not JSON: nothing to read.
      }
      continue;
    }
    const text = stripComments(raw);
    for (const m of text.matchAll(/^\s*locals\s*\{/gm)) {
      const body = blockBody(text, m.index!);
      const inner = body.slice(body.indexOf("{") + 1, -1);
      // Each attribute at the block's own depth starts a local; its value runs to the next one.
      let depth = 0;
      let name: string | undefined;
      let value: string[] = [];
      for (const line of inner.split("\n")) {
        const at = depth === 0 ? /^\s*([A-Za-z_][\w-]*)\s*=(?!=)/.exec(line) : null;
        if (at) {
          if (name) out.set(name, value.join("\n"));
          name = at[1];
          value = [line.slice(at[0].length)];
        } else value.push(line);
        for (const c of line.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
          if (c === "{" || c === "[" || c === "(") depth++;
          else if (c === "}" || c === "]" || c === ")") depth--;
        }
      }
      if (name) out.set(name, value.join("\n"));
    }
  }
  return out;
}

/** The roots that keep their resources under choudoufu's live resource markers: a `live` block in a `terraform` block, or an `estate.chdf.hcl`. */
export function liveRoots(repo: string, roots: string[]): string[] {
  return roots.filter((r) => {
    const dir = join(repo, r);
    if (existsSync(join(dir, "estate.chdf.hcl"))) return true;
    return tfFiles(dir).some((f) => {
      if (isJson(f)) return false;
      const text = stripComments(readFileSync(f, "utf-8"));
      return [...text.matchAll(/^\s*terraform\s*\{/gm)].some((t) => /\blive\s*\{/.test(blockBody(text, t.index!)));
    });
  });
}

/**
 * For each root, the roots whose state it reads: through
 * `terraform_remote_state`, for an Atmos instance through the
 * `!terraform.state` reads its stacks set (./atmos.ts), and under choudoufu
 * the roots whose estate's outputs it reads through `terraform_estate_outputs`
 * (unless `estates` is false, for a caller that reasons about state files alone).
 */
export function rootDependencies(repo: string, roots: string[], { estates: withEstates = true }: { estates?: boolean } = {}): Map<string, Set<string>> {
  const reads = remoteStateReads(repo, roots);
  const atmos = atmosStateReads(repo, roots);
  const estates = new Map(roots.map((r) => [r, withEstates ? estateOf(join(repo, r)) : { reads: [] as string[] }]));
  const owner = new Map<string, string>();
  for (const [r, e] of estates) if ("estate" in e && e.estate) owner.set(e.estate, r);
  return new Map(
    roots.map((r) => {
      const deps = new Set([...reads.get(r)!.map((x) => x.upstream), ...(atmos.get(r) ?? [])]);
      for (const e of estates.get(r)!.reads) {
        const up = owner.get(e);
        if (up && up !== r) deps.add(up);
      }
      return [r, deps];
    }),
  );
}

/** `waves.after`: for a root or glob, the roots or globs it applies after. */
export type WavesAfter = Record<string, readonly string[]>;

/**
 * The order `waves.after` gives: for each root, the roots it names as
 * upstreams, its globs matched against `roots`. A key or an upstream that
 * matches no root is a config error naming it, and so is a root named after
 * itself. Only roots with an upstream are in the map.
 */
export function explicitOrder(after: WavesAfter | undefined, roots: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!after) return out;
  const match = (g: string): string[] => roots.filter((r) => r === posix(g).replace(/\/+$/, "") || globMatch(g, r));
  const unknown: string[] = [];
  const selfs: string[] = [];
  for (const [key, ups] of Object.entries(after)) {
    const downs = match(key);
    if (downs.length === 0) unknown.push(key);
    for (const g of ups) {
      const found = match(g);
      if (found.length === 0) {
        if (!unknown.includes(g)) unknown.push(g);
        continue;
      }
      for (const d of downs) {
        for (const u of found) {
          // A glob can match the root it orders, which skips it; a root named after itself by name on both sides is an error.
          if (u === d) {
            if (posix(key) === d && posix(g) === d && !selfs.includes(d)) selfs.push(d);
            continue;
          }
          if (!out.has(d)) out.set(d, new Set());
          out.get(d)!.add(u);
        }
      }
    }
  }
  if (unknown.length) throw new ConfigError(`waves.after names ${unknown.map((u) => JSON.stringify(u)).join(", ")}, which ${unknown.length === 1 ? "matches" : "match"} no root; the roots are ${[...roots].sort().join(", ")}`);
  if (selfs.length) throw new ConfigError(`waves.after puts ${selfs.join(", ")} after ${selfs.length === 1 ? "itself" : "themselves"}`);
  return out;
}

/** Every root each root must follow: the roots whose state it reads, and the ones `waves.after` puts before it. */
export function rootOrder(repo: string, roots: string[], after?: WavesAfter): Map<string, Set<string>> {
  const deps = rootDependencies(repo, roots);
  for (const [r, ups] of explicitOrder(after, roots)) for (const u of ups) deps.get(r)!.add(u);
  return deps;
}

/**
 * Roots in layers that can apply together: a root that reads another's state
 * through `terraform_remote_state`, or that `waves.after` puts after another,
 * comes after it. A cycle is an error naming the roots it holds.
 */
export function applyLayers(repo: string, roots: string[], after?: WavesAfter): string[][] {
  const explicit = explicitOrder(after, roots);
  const deps = rootOrder(repo, roots, after);
  const layers: string[][] = [];
  const done = new Set<string>();
  while (done.size < roots.length) {
    const layer = roots.filter((r) => !done.has(r) && [...deps.get(r)!].every((d) => done.has(d)));
    if (layer.length === 0) {
      const stuck = roots.filter((r) => !done.has(r));
      const cycle = cycleOf(deps, stuck);
      if (cycle.some((r, i) => explicit.get(r)?.has(cycle[(i + 1) % cycle.length]))) {
        throw new ConfigError(`waves.after puts these roots in a cycle: ${[...cycle, cycle[0]].join(" after ")}`);
      }
      throw new Error(`these roots read each other's state in a cycle: ${stuck.join(", ")}`);
    }
    layer.forEach((r) => done.add(r));
    layers.push(layer);
  }
  return layers;
}

/** One cycle among `stuck`, each root followed by one it must come after. */
function cycleOf(deps: Map<string, Set<string>>, stuck: string[]): string[] {
  const left = new Set(stuck);
  const path: string[] = [];
  let at = stuck[0];
  while (!path.includes(at)) {
    path.push(at);
    at = [...deps.get(at)!].find((d) => left.has(d))!;
  }
  return path.slice(path.indexOf(at));
}
