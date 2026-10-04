/**
 * What terragucci reads from a repo when the config does not say: its roots,
 * the binary, the forge, and the order roots must apply in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { forgeFromHost, type Binary, type ForgeName } from "./config";

const SKIP_DIRS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", ".terragucci"]);

function tfFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".tf") || n.endsWith(".tofu"))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

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
 * block) or configure a provider. A child module does neither, so a module
 * with its own `terraform { required_providers }` block is not a root.
 */
export function isRoot(dir: string): boolean {
  return rootReason(dir) !== undefined;
}

/** Why a directory is a root: the first thing in its Terraform files that makes it one. */
export function rootReason(dir: string): string | undefined {
  const texts = tfFiles(dir).map((f) => stripComments(readFileSync(f, "utf-8")));
  for (const text of texts) {
    const m = text.match(/\bbackend\s+"([^"]+)"\s*\{/);
    if (m) return `backend ${m[1]}`;
  }
  if (texts.some((t) => /^\s*cloud\s*\{/m.test(t))) return "cloud block";
  for (const text of texts) {
    const m = text.match(/^\s*provider\s+"([^"]+)"\s*\{/m);
    if (m) return `provider ${m[1]}`;
  }
  return undefined;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
}

/** Glob match on `/`-separated paths: `*` within a segment, `**` across segments, `?` one character. */
export function globMatch(glob: string, path: string): boolean {
  const g = posix(glob).replace(/^\.\//, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(posix(path).replace(/\/+$/, ""));
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
  for (const r of roots) {
    for (const f of tfFiles(join(repo, r))) {
      const m = stripComments(readFileSync(f, "utf-8")).match(/required_version\s*=\s*"\s*=?\s*(\d+\.\d+\.\d+)\s*"/);
      if (m) seen.add(m[1]);
    }
  }
  return seen.size === 1 ? [...seen][0] : undefined;
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

interface StateRef {
  bucket?: string;
  key: string;
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

function stateOf(repo: string, root: string): { own?: StateRef; reads: StateRef[] } {
  let own: StateRef | undefined;
  const reads: StateRef[] = [];
  for (const f of tfFiles(join(repo, root))) {
    const text = stripComments(readFileSync(f, "utf-8"));
    for (const m of text.matchAll(/\bbackend\s+"[^"]+"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const key = attr(body, "key") ?? attr(body, "prefix");
      if (key) own = { bucket: attr(body, "bucket"), key };
    }
    for (const m of text.matchAll(/\bdata\s+"terraform_remote_state"\s+"[^"]+"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const key = attr(body, "key") ?? attr(body, "prefix");
      if (key) reads.push({ bucket: attr(body, "bucket"), key });
    }
  }
  return { own, reads };
}

/**
 * Roots in layers that can apply together: a root that reads another's state
 * through `terraform_remote_state` comes after it. A cycle is an error.
 */
export function applyLayers(repo: string, roots: string[]): string[][] {
  const states = new Map(roots.map((r) => [r, stateOf(repo, r)]));
  const deps = new Map<string, Set<string>>(roots.map((r) => [r, new Set()]));
  for (const [root, { reads }] of states) {
    for (const read of reads) {
      for (const [other, { own }] of states) {
        if (other === root || !own) continue;
        if (own.key === read.key && (!own.bucket || !read.bucket || own.bucket === read.bucket)) deps.get(root)!.add(other);
      }
    }
  }
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
