/**
 * What terragucci reads from a repo when the config does not say: its roots,
 * the binary, the forge, and the order roots must apply in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { matchesUnitGlob } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { forgeFromHost, type Binary, type ForgeName } from "./config";

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
  if (roots.some((r) => readdirSync(join(repo, r)).some((n) => n.endsWith(".tofu")))) {
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

/** The state a root's backend block names, and the states its `terraform_remote_state` blocks read, as written in its code. */
export function stateOf(repo: string, root: string): { own?: StateRef; reads: RemoteRead[] } {
  let own: StateRef | undefined;
  const reads: RemoteRead[] = [];
  for (const f of tfFiles(join(repo, root))) {
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bbackend\s+"[^"]+"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const key = attr(body, "key") ?? attr(body, "prefix");
      if (key) own = { bucket: attr(body, "bucket"), key };
    }
    for (const m of text.matchAll(/\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const key = attr(body, "key") ?? attr(body, "prefix");
      if (key) reads.push({ name: m[1], bucket: attr(body, "bucket"), key, repeated: /^\s*(count|for_each)\s*=/m.test(body) });
    }
  }
  return { own, reads };
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

/** Where one state is, as a backend block or a `terraform_remote_state` block names it: its bucket, when it names one, and its key. */
export interface StateAddress {
  bucket?: string;
  key: string;
}

/**
 * Each root's own state, as its backend block names it, and its
 * `terraform_remote_state` reads of a state no root among `roots` holds: a
 * state another project's root may hold, which the estate page matches
 * across projects.
 */
export function rootStates(repo: string, roots: string[]): Map<string, { state?: StateAddress; external: (StateAddress & { data: string })[] }> {
  const states = new Map(roots.map((r) => [r, stateOf(repo, r)]));
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

/** Two addresses name one state: the same key, and the same bucket where both name one. */
export const sameState = (a: StateAddress, b: StateAddress): boolean => a.key === b.key && (!a.bucket || !b.bucket || a.bucket === b.bucket);

/** For each root, the roots whose state it reads through `terraform_remote_state`. */
export function rootDependencies(repo: string, roots: string[]): Map<string, Set<string>> {
  const reads = remoteStateReads(repo, roots);
  return new Map(roots.map((r) => [r, new Set(reads.get(r)!.map((x) => x.upstream))]));
}

/**
 * Roots in layers that can apply together: a root that reads another's state
 * through `terraform_remote_state` comes after it. A cycle is an error.
 */
export function applyLayers(repo: string, roots: string[]): string[][] {
  const deps = rootDependencies(repo, roots);
  const layers: string[][] = [];
  const done = new Set<string>();
  while (done.size < roots.length) {
    const layer = roots.filter((r) => !done.has(r) && [...deps.get(r)!].every((d) => done.has(d)));
    if (layer.length === 0) {
      const stuck = roots.filter((r) => !done.has(r));
      throw new Error(`these roots read each other's state in a cycle: ${stuck.join(", ")}`);
    }
    layer.forEach((r) => done.add(r));
    layers.push(layer);
  }
  return layers;
}
