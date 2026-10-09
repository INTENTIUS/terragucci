/**
 * `modules.require: attested`: tf-check and tf-plan refuse a root that pins a
 * release of a checked source unless the release verifies.
 *
 * The checked sources are this repo's own published modules, when
 * `modules.attest` is on (its git URL for `git-tags`, each `oci://` target),
 * and each publisher `modules.trusted` lists. A module call whose source is
 * none of them is not checked. For one that is, the pin must name one release
 * (a tag or a digest), and that release must verify as `verify-release`
 * verifies it: the bytes the tag names now are in a record of the publisher's
 * release ledger, from the tag's commit, and their signature, provenance and
 * SBOM verify against the publisher's public key.
 *
 * The setting and the keys are read from the base when there is one, as the
 * policy is, so a pull request cannot turn the check off or trust a key of
 * its own; a pull request may turn it on.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { KeyObject } from "node:crypto";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { isTerragruntFile, readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { ConfigError, resolveProject, resolveRepo, type ModulesSettings } from "../config";
import { loadHclParser } from "../rollout/parser";
import { configAtBase, type TrustedOptions } from "../report/policy";
import { pinFiles, pinVersion } from "../rollout/pins";
import { moduleTarAt } from "./archive";
import { attestKey } from "./attest";
import { fetchLedger, shown, type Ledger } from "./ledger";
import { Registry, parseOci, type Fetch } from "./oci";
import { AttestationError, publicKey, verifyRelease } from "./verify";

/** One publisher whose releases are checked. */
export interface CheckedSource {
  kind: "git" | "oci";
  /** The normalised git URL of the publishing repo, or the `oci://` prefix. */
  match: string;
  key: KeyObject;
  keyPath: string;
  /** Where the release ledger is read: `origin`, or a URL. */
  ledger: string;
  /** git: where the tags are fetched from, when not the source's own URL (`origin` for this repo). */
  tags?: string;
}

/** A git URL or oci:// address, compared without `git::`, credentials, `.git` or a trailing slash, its scheme and host in lower case. */
export function normalizeSource(url: string): string {
  return url
    .trim()
    .replace(/^git::/, "")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i, (m) => m.toLowerCase())
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/** A git module source split into the repo URL, the directory in it, and the rest. */
export function splitGitSource(source: string): { url: string; subdir: string } | undefined {
  const s = source.replace(/^git::/, "").split("?")[0]!;
  const scheme = s.indexOf("://");
  if (scheme < 0) return undefined;
  const at = s.indexOf("//", scheme + 3);
  return at < 0 ? { url: s, subdir: "" } : { url: s.slice(0, at), subdir: s.slice(at + 2).replace(/\/+$/, "") };
}

/** What `modules:` governs the check, and how its key files are read. */
export interface GoverningModules {
  modules?: ModulesSettings;
  /** Reads a repo file as the governing config sees it: at the base, or in the checkout. */
  read(path: string): string | undefined;
  from: "checkout" | "base";
}

/**
 * The `modules:` settings in force: the base's when it requires attested
 * releases (a pull request cannot drop the check or swap a key), else the
 * checkout's.
 */
export async function governingModules(repo: string, checkout: ModulesSettings | undefined, base: string | undefined, options: TrustedOptions = {}): Promise<GoverningModules> {
  const fromDisk = (path: string): string | undefined => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf-8") : undefined);
  if (base) {
    const at = await configAtBase(repo, base, options);
    if ("config" in at) {
      const settings = options.project ? resolveProject(at.config, options.project) : resolveRepo(at.config);
      if (settings.modules?.require === "attested") {
        return {
          modules: settings.modules,
          from: "base",
          read: (path) => {
            const r = spawnSync("git", ["-C", repo, "show", `${base}:./${path}`], { encoding: "utf-8" });
            return r.status === 0 ? r.stdout : undefined;
          },
        };
      }
    }
  }
  return { modules: checkout, read: fromDisk, from: "checkout" };
}

/** The sources `require: attested` checks. Throws AttestationError when a key cannot be read. */
export function checkedSources(repo: string, governing: GoverningModules): CheckedSource[] {
  const m = governing.modules;
  if (m?.require !== "attested") return [];
  const key = (path: string, whose: string): KeyObject => {
    const pem = governing.read(path);
    if (!pem) throw new AttestationError(`${whose} public key ${path} is not in the repo${governing.from === "base" ? " at the base" : ""}`);
    return publicKey(pem, path);
  };
  const out: CheckedSource[] = [];
  const own = attestKey(m.attest);
  if (own) {
    const targets = m.publish === undefined ? [] : Array.isArray(m.publish) ? m.publish : [m.publish];
    const k = key(own, "this repo's");
    for (const t of targets) {
      if (t === "git-tags") {
        const origin = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8" });
        if (origin.status === 0 && origin.stdout.trim()) out.push({ kind: "git", match: normalizeSource(origin.stdout.trim()), key: k, keyPath: own, ledger: "origin", tags: "origin" });
      } else {
        out.push({ kind: "oci", match: normalizeSource(t), key: k, keyPath: own, ledger: "origin" });
      }
    }
  }
  for (const t of m.trusted ?? []) {
    out.push({ kind: t.source.startsWith("oci://") ? "oci" : "git", match: normalizeSource(t.source), key: key(t.key, `the trusted source ${shown(t.source)}'s`), keyPath: t.key, ledger: t.ledger });
  }
  return out;
}

/** One module call a root makes. */
export interface RootCall {
  file: string;
  /** `module.<name>`, or `terraform` in a terragrunt.hcl. */
  call: string;
  source: string;
  version?: string;
}

/** Every module call in a root's `.tf` files and its terragrunt.hcl. */
export async function rootCalls(repo: string, root: string, parser: Hcl2Json): Promise<RootCall[]> {
  const out: RootCall[] = [];
  for (const file of pinFiles(repo, root)) {
    const tree = (await parser.parse(file, readFileSync(join(repo, file), "utf-8"))) as Record<string, unknown>;
    const bodies: Array<[string, Record<string, unknown>]> = [];
    if (isTerragruntFile(file)) for (const b of (tree.terraform as Record<string, unknown>[] | undefined) ?? []) bodies.push(["terraform", b]);
    else for (const [name, list] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) for (const b of list) bodies.push([`module.${name}`, b]);
    for (const [call, b] of bodies) {
      if (typeof b.source === "string") out.push({ file, call, source: b.source, ...(typeof b.version === "string" ? { version: b.version } : {}) });
    }
  }
  return out;
}

/** One call `require` refused, with what it pins and why. */
export interface PinRefusal {
  file: string;
  call: string;
  /** The source without its pin. */
  module: string;
  version: string;
  why: string;
}

export interface PinCheck {
  refused: PinRefusal[];
  /** The calls that verified, as `<call> <module> <version>`. */
  verified: string[];
}

export interface RequireOptions {
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  /** Ledgers already read in this run, by where they were read. */
  ledgers?: Map<string, Ledger | undefined>;
}

function fetchTag(repo: string, remote: string, tag: string): string | undefined {
  const local = `refs/terragucci/pins/${createHash("sha256").update(`${remote}\n${tag}`).digest("hex").slice(0, 16)}`;
  const f = spawnSync("git", ["-C", repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head", remote, `+refs/tags/${tag}:${local}`], { encoding: "utf-8" });
  if (f.status !== 0) return undefined;
  const c = spawnSync("git", ["-C", repo, "rev-list", "-n", "1", local], { encoding: "utf-8" });
  return c.status === 0 ? c.stdout.trim() : undefined;
}

/** Check every call of one root against the checked sources. */
export async function checkRootPins(repo: string, root: string, sources: CheckedSource[], parser: Hcl2Json, options: RequireOptions = {}): Promise<PinCheck> {
  const env = options.env ?? process.env;
  const ledgers = options.ledgers ?? new Map<string, Ledger | undefined>();
  const out: PinCheck = { refused: [], verified: [] };
  if (sources.length === 0) return out;
  const ledgerAt = (where: string): Ledger | undefined => {
    if (!ledgers.has(where)) ledgers.set(where, fetchLedger(repo, where));
    return ledgers.get(where);
  };
  for (const c of await rootCalls(repo, root, parser)) {
    const pin = readModulePin(c.source, c.version);
    const base = pin.module.split("?")[0]!;
    let source: CheckedSource | undefined;
    let module = "";
    let git: { url: string; subdir: string } | undefined;
    if (base.startsWith("oci://")) {
      const n = normalizeSource(base);
      source = sources.find((s) => s.kind === "oci" && n.startsWith(`${s.match}/`));
      module = posix.basename(n);
    } else {
      git = splitGitSource(base);
      if (git) {
        source = sources.find((s) => s.kind === "git" && normalizeSource(git!.url) === s.match);
        module = git.subdir;
      }
    }
    if (!source) continue;
    const refuse = (version: string, why: string): void => void out.refused.push({ file: c.file, call: c.call, module: pin.module, version, why });
    if (pin.pin === null) {
      refuse("no version", `it pins no release (${pin.unpinned ?? "no pin"}), and modules.require: attested checks one`);
      continue;
    }
    let ledger: Ledger | undefined;
    try {
      ledger = ledgerAt(source.ledger);
    } catch (e) {
      refuse(pin.pin, (e as Error).message);
      continue;
    }
    if (!ledger) {
      refuse(pin.pin, `${shown(source.ledger)} has no chant/lifecycle branch, so no release is recorded`);
      continue;
    }
    try {
      if (git) {
        if (!module) throw new AttestationError("the source names no module directory (//<path>)");
        const commit = fetchTag(repo, source.tags ?? git.url, pin.pin);
        if (!commit) throw new AttestationError(`${pin.pin} is not a tag of ${shown(git.url)}`);
        const bytes = moduleTarAt(repo, commit, module);
        if (!bytes) throw new AttestationError(`the tag ${pin.pin} holds no ${module}`);
        verifyRelease({ module, version: pinVersion(pin.pin), bytes, commit }, ledger, source.key);
      } else {
        const { host, repo: path } = parseOci(base.replace(/\/+$/, ""));
        const registry = new Registry(host, {
          fetch: options.fetch,
          scheme: /^(1|true|yes)$/i.test(env.TERRAGUCCI_REGISTRY_INSECURE ?? "") ? "http" : "https",
          user: env.TERRAGUCCI_REGISTRY_USER,
          password: env.TERRAGUCCI_REGISTRY_PASSWORD,
        });
        const bytes = await registry.manifestBytes(path, pin.pin);
        if (!bytes) throw new AttestationError(`${host}/${path} has no ${pin.pin}`);
        verifyRelease({ module, version: pin.pin, bytes, byName: true }, ledger, source.key);
      }
      out.verified.push(`${c.call} ${pin.module} ${pin.pin}`);
    } catch (e) {
      if (!(e instanceof AttestationError) && !(e instanceof Error && e.name === "OciError")) throw e;
      refuse(pin.pin, e.message);
    }
  }
  return out;
}

/** One line per refusal, naming the root, the call, the module, the version and why. */
export function refusalLines(root: string, refused: PinRefusal[]): string[] {
  return refused.map((r) => `refused: ${root}: ${r.call} (${r.file}) pins ${r.module} at ${r.version}, which modules.require: attested refuses: ${r.why}`);
}

/**
 * The check a stage runs on each root, or undefined when `modules.require`
 * checks nothing here. Reads the governing settings and keys once; a key that
 * cannot be read, or a missing HCL parser, is a ConfigError, since no root can
 * then be checked.
 */
export async function pinChecker(
  repo: string,
  checkout: ModulesSettings | undefined,
  base: string | undefined,
  trust: TrustedOptions = {},
  options: RequireOptions & { parser?: Hcl2Json } = {},
): Promise<((root: string) => Promise<{ refused: string[]; verified: string[] }>) | undefined> {
  const governing = await governingModules(repo, checkout, base, trust);
  let sources: CheckedSource[];
  try {
    sources = checkedSources(repo, governing);
  } catch (e) {
    if (e instanceof AttestationError) throw new ConfigError(`modules.require: attested cannot check any root: ${e.message}`);
    throw e;
  }
  if (sources.length === 0) return undefined;
  const parser = options.parser ?? (await loadHclParser("modules.require: attested reads each root's module pins"));
  const ledgers = options.ledgers ?? new Map<string, Ledger | undefined>();
  return async (root) => {
    const r = await checkRootPins(repo, root, sources, parser, { ...options, ledgers });
    return { refused: refusalLines(root, r.refused), verified: r.verified };
  };
}
