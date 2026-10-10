/**
 * What terragucci reads from a repo when the config does not say: its roots,
 * the binary, the forge, and the order roots must apply in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { matchesUnitGlob } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { ConfigError, forgeFromHost, type Binary, type ForgeName } from "./config";
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

function blockBody(text: string, start: number): string {
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

/** An HCL block's attribute: its string, `null` when it is written as anything but a plain string, undefined when it is not written. */
const hclAttr =
  (body: string): Attr =>
  (name) => {
    const m = body.match(new RegExp(`(?<![\\w.-])${name}\\s*=(?!=)\\s*(.)`));
    if (!m) return undefined;
    if (m[1] !== '"') return null;
    const start = m.index! + m[0].length;
    let out = "";
    for (let i = start; i < body.length; i++) {
      if (body[i] === "\\") {
        out += body[++i] ?? "";
        continue;
      }
      if (body[i] === '"') return literal(out) ?? null;
      out += body[i];
    }
    return null;
  };

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
function jsonState(raw: string, root: string): RootStateCode & { declared: boolean } {
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
      const own = addressed(type, jsonAttr(firstOf(v)), root);
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
export function stateOf(repo: string, root: string): RootStateCode {
  const out: RootStateCode = { reads: [], unresolved: [] };
  let declared = false;
  const own = (o: { ref?: StateRef; why?: string }): void => {
    declared = true;
    if (o.ref) {
      out.own = o.ref;
      delete out.ownUnresolved;
    } else out.ownUnresolved = o.why;
  };
  for (const f of tfFiles(join(repo, root))) {
    if (isJson(f)) {
      const j = jsonState(readFileSync(f, "utf-8"), root);
      if (j.declared) own(j.own ? { ref: j.own } : { why: j.ownUnresolved });
      out.reads.push(...j.reads);
      out.unresolved.push(...j.unresolved);
      continue;
    }
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bbackend\s+"([^"]+)"\s*\{/g)) own(addressed(m[1], hclAttr(blockBody(text, m.index!)), root));
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
  return out;
}

/**
 * Each root's `terraform_remote_state` blocks that read another root's state:
 * the block's label, the root it reads, and whether the block repeats (count
 * or for_each), which a linked plan leaves on the applied state.
 */
export function remoteStateReads(repo: string, roots: string[]): Map<string, { name: string; upstream: string; repeated: boolean }[]> {
  const states = new Map(roots.map((r) => [r, stateOf(repo, r)]));
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
  const states = roots.map((r) => [r, stateOf(repo, r)] as const);
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
  const states = new Map(roots.map((r) => [r, withEstate(repo, r, stateOf(repo, r))]));
  const held = [...states.values()].flatMap((s) => (s.own ? [s.own] : []));
  const out = new Map<string, { state?: StateAddress; external: (StateAddress & { data: string })[] }>();
  for (const [root, { own, reads }] of states) {
    const external = reads
      .filter((r) => !held.some((o) => o !== own && sameState(o, r)))
      .map((r) => ({ data: r.name, ...(r.bucket !== undefined ? { bucket: r.bucket } : {}), key: r.key }));
    out.set(root, { ...(own ? { state: { ...(own.bucket !== undefined ? { bucket: own.bucket } : {}), key: own.key } } : {}), external });
  }
  return out;
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
