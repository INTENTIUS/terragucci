/**
 * `sources:` in terragucci.yml: the module sources and provider addresses a
 * root may use, checked before `init` downloads anything for it.
 *
 *   sources:
 *     modules: ["./**", "registry.example.com/acme/**"]
 *     providers: ["hashicorp/*", "registry.example.com/acme/*"]
 *
 * Before a root's `init`, every `module` block's `source` and every
 * `required_providers` entry of the root's own files is read, and so are
 * those of each local module it calls (`./` and `../` sources, followed down
 * to the modules they call), and in a Terragrunt unit its `terraform { source }`,
 * and for a unit an explicit stack generates from a remote source, the
 * `source` of its `unit` block in the `terragrunt.stack.hcl`.
 * A provider a module uses with no `required_providers` entry is the one
 * `init` would install for it, `hashicorp/<name>`, and is checked as that. A
 * source no glob of its list matches refuses the root: it is not initialised,
 * planned or applied, and the refusal names the root, the block and the
 * source. A list that is not set checks nothing of its kind, and with no
 * `sources` key nothing here runs at all.
 *
 * After `init` and before `plan`, the same lists are checked again against
 * what `init` fetched and installed: every remote module call in
 * `.terraform/modules/modules.json`, nested ones included, and every provider
 * in `.terraform.lock.hcl`, named by the module that uses it. A remote
 * module's own calls and providers are only known once `init` has fetched it.
 *
 * A module source is matched as written, without its `?` query (a `ref`,
 * `version` or `tag` pins a release; it does not move where the code comes
 * from). A provider address is matched in lower case. An address written
 * without a host, `hashicorp/aws` or `acme/vpc/aws`, also matches a glob
 * that names registry.terraform.io or registry.opentofu.org, the hosts the
 * binaries read it from, and one at either host also matches a glob without
 * a host (the lock file and modules.json always name the host). `*` matches
 * within one `/`-separated part and `**` across parts.
 *
 * The lists are read at base, as `policy` is (./report/policy.ts): a pull
 * request's plan reads the target branch's config, a pull request applied
 * before it merges the base it names, and a wave after a merge the applied
 * commit's first parent, as `steps` are. So a change cannot widen the list its
 * own sources are checked against. A base with no `sources` key leaves the
 * checkout's in force, so a pull request may turn the check on; a base whose
 * config cannot be read fails the run when the checkout sets the key.
 *
 * With `proxies`, a source written through an Artifactory remote repository
 * (`<host>/<repo>__<ns>/<name>/<system>`) or a Nexus proxy's host block label
 * also matches as the upstream source it stands for, so one glob such as
 * `registry.terraform.io/terraform-aws-modules/*` covers both. The proxy forms
 * are the terraform lexicon's (chant#4606).
 *
 * Reading and normalising sources is generic Terraform work: with a chant
 * that carries chant#3924, the terraform lexicon reads them (`usedSources`,
 * `lockedProviders`) and gives their forms (`moduleSourceForms`,
 * `providerAddressForms`), and this file keeps only the lists and the
 * refusals. Its own reader and forms stay as the fallback for a chant
 * without them, and the stack unit's source is terragucci's either way.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { dataDir } from "./backend";
import { ConfigError, resolveProject, resolveRepo, type SourceProxy, type SourcesSettings } from "./config";
import { chantRegistryProxies, chantSourceForms, chantSourceFormsNow, type ChantRegistryProxies, type ChantRegistryProxy } from "./chant-next";
import { configAtBase, type TrustedOptions } from "./report/policy";
import { loadHclParser } from "./rollout/parser";
import { baseCommit } from "./seal";
import { stackUnitSource } from "./tg-stacks";

/** The hosts a provider or registry module address written without one is read from. */
export const DEFAULT_REGISTRIES = ["registry.terraform.io", "registry.opentofu.org"] as const;

/** One module source or provider address a root uses. */
export interface UsedSource {
  kind: "module" | "provider";
  /** The file it is written in, relative to the repo. */
  file: string;
  /** The block that names it: `module.vpc`, `terraform` in a terragrunt.hcl, `required_providers.aws`, or `provider.aws` for an implied one; prefixed with the module calls that reach it. */
  block: string;
  /** The source or address as written (`hashicorp/<name>` for an implied provider). */
  source: string;
  /** For an implied provider: what implies it. */
  implied?: string;
}

/** One source the lists refuse. */
export interface SourceRefusal extends UsedSource {
  /** The globs it was checked against. */
  list: string[];
  /** Set when the source could not be checked at all. */
  why?: string;
}

/** A glob as a regular expression: `**` across parts, `*` within one, everything else literal. */
export function sourceGlob(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A hostless registry module address: `<namespace>/<name>/<system>`, optionally with a `//<subdir>`. */
const HOSTLESS_MODULE = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*(\/\/.*)?$/;

/** An address at a default registry, as the lock file and modules.json write it: the address without its host, else undefined. */
function atDefaultRegistry(address: string): string | undefined {
  const host = DEFAULT_REGISTRIES.find((h) => address.toLowerCase().startsWith(`${h}/`));
  return host ? address.slice(host.length + 1) : undefined;
}

/** The forms a module source matches as: as written without its query, and its registry forms. chant's (chant#3924) once loaded. */
export function moduleForms(source: string): string[] {
  const lib = chantSourceFormsNow();
  if (lib) return lib.moduleSourceForms(source);
  const written = source.trim().split("?")[0]!;
  const out = [written];
  const tfr = /^tfr:\/\/([^/]*)\/(.+)$/.exec(written);
  if (tfr) {
    if (tfr[1]) out.push(`${tfr[1]}/${tfr[2]}`);
    else out.push(...DEFAULT_REGISTRIES.map((h) => `${h}/${tfr[2]}`));
  } else if (HOSTLESS_MODULE.test(written)) {
    out.push(...DEFAULT_REGISTRIES.map((h) => `${h}/${written}`));
  } else {
    const hostless = atDefaultRegistry(written);
    if (hostless && HOSTLESS_MODULE.test(hostless)) out.push(hostless, ...DEFAULT_REGISTRIES.map((h) => `${h}/${hostless}`).filter((f) => f !== written));
  }
  return out;
}

/** The forms a provider address matches as: in lower case, and with a default registry's host when it is written without one. */
export function providerForms(address: string): string[] {
  const lib = chantSourceFormsNow();
  if (lib) return lib.providerAddressForms(address);
  const a = address.trim().toLowerCase();
  if (a.split("/").length === 2) return [a, ...DEFAULT_REGISTRIES.map((h) => `${h}/${a}`)];
  const hostless = atDefaultRegistry(a);
  return hostless && hostless.split("/").length === 2 ? [a, hostless, ...DEFAULT_REGISTRIES.map((h) => `${h}/${hostless}`).filter((f) => f !== a)] : [a];
}

/** The upstream a source written through a proxy stands for, or undefined (./sources.ts proxyUpstream). */
export type ThroughProxy = (kind: UsedSource["kind"], source: string) => string | undefined;

/** Whether any glob of a list matches any form of a source, or of the upstream source a proxy stands it in for. */
export function sourceAllowed(kind: UsedSource["kind"], source: string, list: readonly string[], through?: ThroughProxy): boolean {
  const upstream = through?.(kind, source);
  const forms = [source, ...(upstream ? [upstream] : [])].flatMap((s) => (kind === "module" ? moduleForms(s) : providerForms(s)));
  return list.some((g) => {
    const re = sourceGlob(kind === "provider" ? g.toLowerCase() : g);
    return forms.some((f) => re.test(f));
  });
}

/** A local module source: `./` or `../`, as Terraform and Terragrunt read one. */
const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

type Tree = Record<string, unknown>;

/** A block list as hcl2json writes it (an array) or a `.tf.json` file may (one object). */
const bodies = (v: unknown): Tree[] => (Array.isArray(v) ? (v as Tree[]) : v && typeof v === "object" ? [v as Tree] : []);

/** The files of one module directory that terragucci reads sources from. */
function moduleFiles(dir: string, terragrunt: boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf") || f.endsWith(".tofu") || f.endsWith(".tf.json") || f.endsWith(".tofu.json") || (terragrunt && f === "terragrunt.hcl"))
    .sort();
}

/** The local name of the provider a resource, data or ephemeral block uses: its `provider` argument's, else its type's prefix. */
function providerOf(type: string, body: Tree): string {
  const ref = typeof body.provider === "string" ? /^(?:\$\{)?([A-Za-z][A-Za-z0-9_-]*)/.exec(body.provider) : null;
  return ref ? ref[1]! : type.split("_")[0]!;
}

/** What one module directory names: the providers it uses and the modules it calls. */
interface DirSources {
  providers: UsedSource[];
  calls: { file: string; block: string; source: string; terragrunt: boolean }[];
}

/**
 * The providers one module directory uses and the modules it calls, read from
 * its files. `abs` is the directory on disk; `shown` is how its files are
 * named, relative to the repo. A terragrunt.hcl is read only when `top`.
 */
async function dirSources(abs: string, shown: string, prefix: string, top: boolean, parser: Hcl2Json): Promise<DirSources> {
  const providers: UsedSource[] = [];
  const calls: DirSources["calls"] = [];
  const declared = new Set<string>();
  const implied = new Map<string, { file: string; what: string }>();
  for (const name of moduleFiles(abs, top)) {
    const file = shown === "." ? name : posix.join(shown, name);
    const text = readFileSync(join(abs, name), "utf-8");
    let tree: Tree;
    try {
      tree = (name.endsWith(".json") ? JSON.parse(text) : await parser.parse(file, text)) as Tree;
    } catch (e) {
      throw new ConfigError(`sources: ${file} could not be read (${(e as Error).message.split("\n")[0]}), so its module and provider sources cannot be checked`);
    }
    if (name === "terragrunt.hcl") {
      for (const b of bodies(tree.terraform)) if (typeof b.source === "string") calls.push({ file, block: `${prefix}terraform`, source: b.source, terragrunt: true });
      continue;
    }
    for (const [call, list] of Object.entries((tree.module as Tree | undefined) ?? {})) {
      for (const b of bodies(list)) if (typeof b.source === "string") calls.push({ file, block: `${prefix}module.${call}`, source: b.source, terragrunt: false });
    }
    for (const t of bodies(tree.terraform)) {
      for (const req of bodies(t.required_providers)) {
        for (const [local, v] of Object.entries(req)) {
          declared.add(local);
          const source = v && typeof v === "object" && typeof (v as Tree).source === "string" ? ((v as Tree).source as string) : `hashicorp/${local}`;
          providers.push({ kind: "provider", file, block: `${prefix}required_providers.${local}`, source });
        }
      }
    }
    for (const local of Object.keys((tree.provider as Tree | undefined) ?? {})) if (!implied.has(local)) implied.set(local, { file, what: `provider "${local}"` });
    for (const kind of ["resource", "data", "ephemeral"]) {
      for (const [type, named] of Object.entries((tree[kind] as Tree | undefined) ?? {})) {
        for (const [name, list] of Object.entries((named as Tree) ?? {})) {
          for (const b of bodies(list)) {
            const local = providerOf(type, b);
            if (!implied.has(local)) implied.set(local, { file, what: `${kind} "${type}" "${name}"` });
          }
        }
      }
    }
  }
  for (const [local, at] of implied) {
    // terraform_data and terraform_remote_state are the binary's own provider, never downloaded.
    if (declared.has(local) || local === "terraform") continue;
    providers.push({ kind: "provider", file: at.file, block: `${prefix}provider.${local}`, source: `hashicorp/${local}`, implied: at.what });
  }
  return { providers, calls };
}

/**
 * Every module source and provider address a root uses before its `init`
 * downloads anything: its own files, and down each local module call. A
 * local module that cannot be read (outside the repo, or missing) is named
 * with `why`, since what it calls cannot be checked.
 */
export async function rootSources(repo: string, root: string, parser: Hcl2Json): Promise<{ used: UsedSource[]; unread: { file: string; block: string; source: string; why: string }[] }> {
  const used: UsedSource[] = [];
  const unread: { file: string; block: string; source: string; why: string }[] = [];
  const walk = async (dir: string, prefix: string, chain: string[], top: boolean): Promise<void> => {
    const { providers, calls } = await dirSources(join(repo, dir), dir, prefix, top, parser);
    used.push(...providers);
    for (const c of calls) {
      used.push({ kind: "module", file: c.file, block: c.block, source: c.source });
      if (!isLocal(c.source)) continue;
      // A Terragrunt source's `//` marks the directory it copies; the module is the path with it read as one `/`.
      const path = c.source.split("?")[0]!.replace(/\/\/+/g, "/");
      const next = posix.normalize(posix.join(dir, path)).replace(/\/+$/, "") || ".";
      if (next === ".." || next.startsWith("../")) {
        unread.push({ file: c.file, block: c.block, source: c.source, why: "it is outside the repo, so the sources it uses cannot be read" });
        continue;
      }
      if (moduleFiles(join(repo, next), false).length === 0) {
        if (!existsSync(join(repo, next))) unread.push({ file: c.file, block: c.block, source: c.source, why: `${next} does not exist, so the sources it uses cannot be read` });
        continue;
      }
      if (chain.includes(next)) continue;
      await walk(next, `${c.block} > `, [...chain, next], false);
    }
  };
  const start = posix.normalize(root).replace(/\/+$/, "") || ".";
  // A unit an explicit stack generates from a remote source: the stack file's unit block names it.
  const stacked = await stackUnitSource(repo, start, parser);
  if (stacked) used.push({ kind: "module", file: stacked.file, block: `unit.${stacked.name}`, source: stacked.source });
  // The terraform lexicon reads the rest (chant#3924); terragucci's own walk is the fallback.
  const lib = await chantSourceForms();
  if (lib) {
    const read = await lib.usedSources(join(repo, start), { project: repo, parser });
    for (const u of read.used) used.push({ kind: u.kind, file: u.file, block: u.block, source: u.source, ...(u.implied ? { implied: u.implied } : {}) });
    unread.push(...read.unread);
    return { used, unread };
  }
  await walk(start, "", [start], true);
  return { used, unread };
}

/** The sources the lists refuse: each one of a kind whose list is set and whose globs match none of its forms. */
function refusals(used: readonly UsedSource[], lists: SourcesSettings, through?: ThroughProxy): SourceRefusal[] {
  const out: SourceRefusal[] = [];
  for (const u of used) {
    const list = u.kind === "module" ? lists.modules : lists.providers;
    if (list && !sourceAllowed(u.kind, u.source, list, through)) out.push({ ...u, list });
  }
  return out;
}

/** `sources.proxies` as the terraform lexicon's proxy entries (chant#4606), or none on a chant without them. */
export async function registryProxies(proxies: readonly SourceProxy[] | undefined): Promise<{ lib: ChantRegistryProxies; list: ChantRegistryProxy[] } | undefined> {
  if (!proxies?.length) return undefined;
  const lib = await chantRegistryProxies();
  if (!lib) return undefined;
  const list = proxies.map((p) =>
    p.artifactory ? lib.artifactoryProxy(p.artifactory, p.repo, p.upstream) : lib.nexusProxy({ url: p.nexus!, repo: p.repo, ...(p.upstream ? { upstream: p.upstream } : {}), ...(p.host ? { host: p.host } : {}) }),
  );
  return { lib, list };
}

/**
 * How `sources.proxies` stands a source in for its upstream: a module source
 * or provider address written through an Artifactory or Nexus proxy matches
 * the lists as the upstream source too. Without chant's proxies (chant#4606)
 * a source is matched as written only.
 */
export async function proxyUpstream(proxies: readonly SourceProxy[] | undefined): Promise<ThroughProxy | undefined> {
  const p = await registryProxies(proxies);
  if (!p) return undefined;
  return (kind, source) => (kind === "module" ? p.lib.moduleThroughProxy(source, p.list) : p.lib.providerThroughProxy(source, p.list))?.upstream;
}

/** Check one root's sources against the lists: what they refuse. */
export async function checkRootSources(repo: string, root: string, lists: SourcesSettings, parser: Hcl2Json): Promise<SourceRefusal[]> {
  const { used, unread } = await rootSources(repo, root, parser);
  await chantSourceForms();
  const out = refusals(used, lists, await proxyUpstream(lists.proxies));
  if (lists.modules) for (const u of unread) out.push({ kind: "module", ...u, list: lists.modules });
  return out;
}

/** One module `init` recorded in modules.json: its dotted key (`""` for the root), its source and its directory, relative to the root. */
interface RecordedModule {
  Key?: unknown;
  Source?: unknown;
  Dir?: unknown;
}

/** A dotted modules.json key as the blocks that reach it: `a.b` is `module.a > module.b`. */
const keyBlock = (key: string): string =>
  key
    .split(".")
    .map((k) => `module.${k}`)
    .join(" > ");

/** A provider address as the lock file and a module both name it: lower case, without a default registry's host. */
const providerKey = (address: string): string => {
  const a = address.trim().toLowerCase();
  return atDefaultRegistry(a) ?? a;
};

/**
 * What a root's `init` fetched and installed: each remote module call
 * `modules.json` records, nested ones included, named by the module path that
 * reaches it, and each provider in `.terraform.lock.hcl`, named by every
 * module that uses it (by the lock file when none does). A call is matched as
 * written in the module that makes it, as before `init`; the address
 * modules.json records (`github.com/x/y` becomes `git::https://github.com/x/y.git`)
 * stands in only when that file cannot be read. A local call is part of the
 * module that makes it, so it is not named again. `env` gives `TF_DATA_DIR`
 * when one is set.
 */
export async function lockedSources(repo: string, root: string, parser: Hcl2Json, env: NodeJS.ProcessEnv = {}): Promise<UsedSource[]> {
  const rootDir = join(repo, posix.normalize(root).replace(/\/+$/, "") || ".");
  const shownOf = (abs: string): string => relative(repo, abs).split(sep).join("/") || ".";
  const manifest = join(dataDir(rootDir, env), "modules", "modules.json");
  let modules: RecordedModule[] = [];
  if (existsSync(manifest)) {
    try {
      const doc = JSON.parse(readFileSync(manifest, "utf-8")) as { Modules?: unknown };
      if (Array.isArray(doc.Modules)) modules = doc.Modules as RecordedModule[];
    } catch (e) {
      throw new ConfigError(`sources: ${shownOf(manifest)} could not be read (${(e as Error).message.split("\n")[0]}), so the modules init fetched cannot be checked`);
    }
  }
  const lockFile = join(rootDir, ".terraform.lock.hcl");
  const lockText = existsSync(lockFile) ? readFileSync(lockFile, "utf-8") : "";
  const forms = await chantSourceForms();
  const locked = forms ? forms.lockedProviders(lockText) : [...lockText.matchAll(/^provider\s+"([^"]+)"/gm)].map((m) => m[1]!);
  // The root and every module init recorded, read from their files: the calls each makes, and the providers each uses.
  const calls = new Map<string, { file: string; source: string }>();
  const users = new Map<string, UsedSource[]>();
  const dirs: { key: string; dir: string }[] = [{ key: "", dir: rootDir }];
  for (const m of modules) {
    if (typeof m.Key !== "string" || m.Key === "" || typeof m.Dir !== "string") continue;
    dirs.push({ key: m.Key, dir: isAbsolute(m.Dir) ? m.Dir : join(rootDir, m.Dir) });
  }
  if (modules.length > 0 || locked.length > 0) {
    for (const d of dirs) {
      let read: DirSources;
      try {
        read = await dirSources(d.dir, shownOf(d.dir), d.key ? `${keyBlock(d.key)} > ` : "", false, parser);
      } catch {
        // A module that cannot be read names no call and no user; what it calls and locks is still checked, as modules.json and the lock file name it.
        continue;
      }
      for (const c of read.calls) calls.set(c.block, { file: c.file, source: c.source });
      for (const p of read.providers) users.set(providerKey(p.source), [...(users.get(providerKey(p.source)) ?? []), p]);
    }
  }
  const used: UsedSource[] = [];
  for (const m of modules) {
    if (typeof m.Key !== "string" || m.Key === "" || typeof m.Source !== "string") continue;
    const block = keyBlock(m.Key);
    const written = calls.get(block);
    const source = written?.source ?? m.Source;
    if (isLocal(source) || isLocal(m.Source)) continue;
    used.push({ kind: "module", file: written?.file ?? shownOf(manifest), block, source });
  }
  for (const address of locked) {
    const by = users.get(providerKey(address)) ?? [];
    if (by.length === 0) used.push({ kind: "provider", file: shownOf(lockFile), block: "lock file", source: address });
    for (const u of by) used.push({ ...u, source: address });
  }
  return used;
}

/** Check what one root's `init` fetched and installed against the lists: what they refuse. */
export async function checkLockedSources(repo: string, root: string, lists: SourcesSettings, parser: Hcl2Json, env: NodeJS.ProcessEnv = {}): Promise<SourceRefusal[]> {
  const used = await lockedSources(repo, root, parser, env);
  await chantSourceForms();
  return refusals(used, lists, await proxyUpstream(lists.proxies));
}

/** One line per refusal, naming the root, the block, the file, the source and the list it was checked against. */
export function sourceRefusalLines(root: string, refused: readonly SourceRefusal[]): string[] {
  return refused.map((r) => {
    const what = r.kind === "module" ? `module source ${r.source}` : `provider ${r.source}${r.implied ? ` (implied by ${r.implied}, with no required_providers entry)` : ""}`;
    const why = r.why ? `: ${r.why}` : `, which no entry of sources.${r.kind}s matches`;
    return `refused: ${root}: ${r.block} (${r.file}) uses ${what}${why} (sources.${r.kind}s: ${r.list.join(", ")})`;
  });
}

/** The `sources:` key in force, and where it was read. */
export interface GoverningSources {
  sources?: SourcesSettings;
  from: "checkout" | "base";
}

/**
 * The `sources:` key a run checks with. Without a base, the checkout's. With
 * one, the base's when it has the key; a base without it leaves the
 * checkout's, so a pull request may turn the check on. A base whose config
 * cannot be read throws when the checkout sets the key, and checks nothing
 * when it does not.
 */
export async function governingSources(repo: string, checkout: SourcesSettings | undefined, base: string | undefined, trust: TrustedOptions = {}): Promise<GoverningSources> {
  const own: GoverningSources = { ...(checkout ? { sources: checkout } : {}), from: "checkout" };
  if (!base) return own;
  const read = await configAtBase(repo, base, trust);
  let why: string;
  if ("error" in read) why = read.error;
  else {
    try {
      const atBase = (trust.project ? resolveProject(read.config, trust.project) : resolveRepo(read.config)).sources;
      return atBase ? { sources: atBase, from: "base" } : own;
    } catch (e) {
      why = (e as Error).message;
    }
  }
  if (!checkout) return own;
  throw new ConfigError(`sources is read from the config at ${base}, and it could not be read (${why}), so no root's sources can be checked`);
}

/**
 * The base a tf-apply wave reads `sources:` at: the one it was given, else
 * the applied commit's first parent. A commit with no parent has no earlier
 * list to keep, so it reads its own.
 */
export function waveSourcesBase(repo: string, given: string | undefined): string | undefined {
  if (given) return given;
  try {
    return baseCommit(repo);
  } catch {
    return undefined;
  }
}

/** A directory's real path, or the path as given when it has none. */
function realPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** What a stage checks each root with: the refusal lines, empty when the root passes. */
export interface SourceChecker {
  /** Before `init`: the root's own files and the local modules it calls. `dir` is the checkout it is read from, when not `repo`. */
  before(root: string, dir?: string): Promise<string[]>;
  /** After `init`, before `plan`: the modules `init` fetched and the providers it locked. `env` gives `TF_DATA_DIR` when set. */
  afterInit(root: string, dir?: string, env?: NodeJS.ProcessEnv): Promise<string[]>;
  /**
   * After `init`, before `plan`, for a Terragrunt unit: the same check in the
   * working directory Terragrunt inited it in (`workDir`, absolute, often
   * under `.terragrunt-cache`), its lines naming the unit.
   */
  unitAfterInit(unit: string, workDir: string, env?: NodeJS.ProcessEnv): Promise<string[]>;
}

/**
 * The checks a stage runs on each root, or undefined when no `sources:` key
 * is in force, so a repo without one reads nothing and runs nothing here.
 * `afterInit: false` is for a job that never plans (tf-check), whose log then
 * names only the check before init. A missing HCL parser is a ConfigError,
 * since no root can then be checked.
 */
export async function sourceChecker(
  repo: string,
  checkout: SourcesSettings | undefined,
  base: string | undefined,
  trust: TrustedOptions = {},
  options: { parser?: Hcl2Json; log?: (line: string) => void; afterInit?: boolean } = {},
): Promise<SourceChecker | undefined> {
  const governing = await governingSources(repo, checkout, base, trust);
  const lists = governing.sources;
  if (!lists || (!lists.modules && !lists.providers)) return undefined;
  const when = options.afterInit === false ? "before init" : "before init, and what init fetched and locked before plan,";
  options.log?.(`sources: each root's module and provider sources are checked ${when} against the list in the config ${governing.from === "base" ? `at ${base}` : "of this checkout"}`);
  const parser = options.parser ?? (await loadHclParser("sources: reads each root's module and provider sources"));
  return {
    before: async (root, dir) => sourceRefusalLines(root, await checkRootSources(dir ?? repo, root, lists, parser)),
    afterInit: async (root, dir, env) => sourceRefusalLines(root, await checkLockedSources(dir ?? repo, root, lists, parser, env)),
    unitAfterInit: async (unit, workDir, env) => {
      // The working directory as a path from the repo, so each file the lines name reads from the repo's root.
      const from = realPath(repo);
      return sourceRefusalLines(unit, await checkLockedSources(from, relative(from, realPath(workDir)).split(sep).join("/") || ".", lists, parser, env));
    },
  };
}
