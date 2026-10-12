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
 * to the modules they call), and in a Terragrunt unit its `terraform { source }`.
 * A provider a module uses with no `required_providers` entry is the one
 * `init` would install for it, `hashicorp/<name>`, and is checked as that. A
 * source no glob of its list matches refuses the root: it is not initialised,
 * planned or applied, and the refusal names the root, the block and the
 * source. A list that is not set checks nothing of its kind, and with no
 * `sources` key nothing here runs at all.
 *
 * A module source is matched as written, without its `?` query (a `ref`,
 * `version` or `tag` pins a release; it does not move where the code comes
 * from). A provider address is matched in lower case. An address written
 * without a host, `hashicorp/aws` or `acme/vpc/aws`, also matches a glob
 * that names registry.terraform.io or registry.opentofu.org, the hosts the
 * binaries read it from. `*` matches within one `/`-separated part and `**`
 * across parts.
 *
 * The lists are read at base, as `policy` is (./report/policy.ts): a pull
 * request's plan reads the target branch's config, a pull request applied
 * before it merges the base it names, and a wave after a merge the applied
 * commit's first parent, as `steps` are. So a change cannot widen the list its
 * own sources are checked against. A base with no `sources` key leaves the
 * checkout's in force, so a pull request may turn the check on; a base whose
 * config cannot be read fails the run when the checkout sets the key.
 *
 * Reading and normalising sources is generic Terraform work; chant#3924 asks
 * the terraform lexicon for it, and this file keeps only the list and the
 * refusal once it lands.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { ConfigError, resolveProject, resolveRepo, type SourcesSettings } from "./config";
import { configAtBase, type TrustedOptions } from "./report/policy";
import { loadHclParser } from "./rollout/parser";
import { baseCommit } from "./seal";

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

/** The forms a module source matches as: as written without its query, and its registry forms. */
export function moduleForms(source: string): string[] {
  const written = source.trim().split("?")[0]!;
  const out = [written];
  const tfr = /^tfr:\/\/([^/]*)\/(.+)$/.exec(written);
  if (tfr) {
    if (tfr[1]) out.push(`${tfr[1]}/${tfr[2]}`);
    else out.push(...DEFAULT_REGISTRIES.map((h) => `${h}/${tfr[2]}`));
  } else if (HOSTLESS_MODULE.test(written)) {
    out.push(...DEFAULT_REGISTRIES.map((h) => `${h}/${written}`));
  }
  return out;
}

/** The forms a provider address matches as: in lower case, and with a default registry's host when it is written without one. */
export function providerForms(address: string): string[] {
  const a = address.trim().toLowerCase();
  return a.split("/").length === 2 ? [a, ...DEFAULT_REGISTRIES.map((h) => `${h}/${a}`)] : [a];
}

/** Whether any glob of a list matches any form of a source. */
export function sourceAllowed(kind: UsedSource["kind"], source: string, list: readonly string[]): boolean {
  const forms = kind === "module" ? moduleForms(source) : providerForms(source);
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
    const declared = new Set<string>();
    const implied = new Map<string, { file: string; what: string }>();
    const calls: { file: string; block: string; source: string; terragrunt: boolean }[] = [];
    for (const name of moduleFiles(join(repo, dir), top)) {
      const file = dir === "." ? name : posix.join(dir, name);
      const text = readFileSync(join(repo, file), "utf-8");
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
            used.push({ kind: "provider", file, block: `${prefix}required_providers.${local}`, source });
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
      used.push({ kind: "provider", file: at.file, block: `${prefix}provider.${local}`, source: `hashicorp/${local}`, implied: at.what });
    }
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
  await walk(start, "", [start], true);
  return { used, unread };
}

/** Check one root's sources against the lists: what they refuse. */
export async function checkRootSources(repo: string, root: string, lists: SourcesSettings, parser: Hcl2Json): Promise<SourceRefusal[]> {
  const { used, unread } = await rootSources(repo, root, parser);
  const out: SourceRefusal[] = [];
  for (const u of used) {
    const list = u.kind === "module" ? lists.modules : lists.providers;
    if (list && !sourceAllowed(u.kind, u.source, list)) out.push({ ...u, list });
  }
  if (lists.modules) for (const u of unread) out.push({ kind: "module", ...u, list: lists.modules });
  return out;
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

/** What a stage checks each root with: the refusal lines, empty when the root passes. */
export type SourceChecker = (root: string, dir?: string) => Promise<string[]>;

/**
 * The check a stage runs on each root before its `init`, or undefined when no
 * `sources:` key is in force, so a repo without one reads nothing and runs
 * nothing here. `dir` is the checkout a root is read from, when not `repo`.
 * A missing HCL parser is a ConfigError, since no root can then be checked.
 */
export async function sourceChecker(
  repo: string,
  checkout: SourcesSettings | undefined,
  base: string | undefined,
  trust: TrustedOptions = {},
  options: { parser?: Hcl2Json; log?: (line: string) => void } = {},
): Promise<SourceChecker | undefined> {
  const governing = await governingSources(repo, checkout, base, trust);
  const lists = governing.sources;
  if (!lists || (!lists.modules && !lists.providers)) return undefined;
  options.log?.(`sources: each root's module and provider sources are checked before init, against the list in the config ${governing.from === "base" ? `at ${base}` : "of this checkout"}`);
  const parser = options.parser ?? (await loadHclParser("sources: reads each root's module and provider sources"));
  return async (root, dir) => sourceRefusalLines(root, await checkRootSources(dir ?? repo, root, lists, parser));
}
