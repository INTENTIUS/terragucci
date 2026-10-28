/**
 * The release catalog beside a bucket registry (terragucci#1297, bundle B of
 * terragucci#1289): `catalog/index.html`, a page per module and per version,
 * `catalog/index.json` for the search box and `terragucci modules`, and a
 * `consumers.json` per module.
 *
 * The versions come from the release ledger only (ruling A): every publish
 * records its release with its version (./ledger.ts), and the status records
 * `terragucci modules deprecate | yank | restore` write sit beside them. The
 * registry's own `versions` and `release.json` are never read here.
 *
 * chant builds and renders the catalog (`lifecycle/release-catalog`,
 * chant#4595), and the terraform lexicon reads each version's docs, its
 * changelog's commits and the roots that call it (chant#4597, #4598, #4599).
 * terragucci decides where the files go and how terraform-docs is found: on
 * the PATH, run on a scratch copy of the module at the release's commit and
 * printing to stdout, so the module's own README is never written.
 *
 * A version already in the catalog keeps the docs and changelog it was
 * written with, and a file whose bytes are already in the store is not
 * written again, so a rerun with nothing new writes nothing. Every key is
 * under `catalog/`, clear of `_headers` and `providers/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { ConfigError, type ControlSettings, type RegistrySettings } from "../config";
import { controlConsumers } from "./consumers";
import { findRoots } from "../detect";
import {
  chantRegistryCatalog,
  chantReleaseCatalog,
  type ChantCatalogVersion,
  type ChantModuleConsumer,
  type ChantReleaseCatalogDoc,
  type ChantReleaseStatusRecord,
  type ChantTerraformDocsRunner,
} from "../chant-next";
import { moduleTarAt, tarEntries } from "./archive";
import { tryGit, hasCommit } from "./git";
import { attestDir, ATTEST_FILES, readModuleLedger, type VersionedReleaseRecord } from "./ledger";
import { keyFor, registryAddress, tarballName, type RegistryStore } from "./registry";
import { compareSemver, parseSemver } from "./semver";

/** Where the catalog sits under the registry's root. */
export const CATALOG_DIR = "catalog";
/** Each module's call list, beside its catalog page. */
export const CONSUMERS_FILE = "consumers.json";

export interface CatalogModule {
  name: string;
  rel: string;
}

export interface CatalogOptions {
  modules: CatalogModule[];
  /** `roots` from the settings; every root findRoots sees when unset. */
  roots?: string[];
  binary?: string;
  /** `modules.attest`'s key path, when releases are attested. */
  attestKey?: string;
  dryRun?: boolean;
  parser?: Hcl2Json;
  /** Runs terraform-docs; {@link terraformDocsRunner} by default. */
  terraformDocs?: ChantTerraformDocsRunner;
  /** `control`: the consumers of every project the control repo lists are joined in (./consumers.ts, chant#4600). */
  control?: ControlSettings;
  /** Where the control repo's read token and checkout are named. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CatalogResult {
  status: "published" | "unchanged" | "skipped";
  detail: string;
  /** The keys written, for tests. */
  written?: string[];
}

/** The catalog's key for a path under it. */
export const catalogKey = (reg: Pick<RegistrySettings, "prefix">, path: string): string => keyFor(reg, `${CATALOG_DIR}/${path}`);

/**
 * terraform-docs from the PATH, run in `dir` with the module's own config
 * and `--output-file ""`, so it prints the markdown instead of writing or
 * injecting it into a file. Null when no binary is installed.
 */
export function terraformDocsRunner(): ChantTerraformDocsRunner {
  return async ({ dir, config }) => {
    const r = spawnSync("terraform-docs", ["--config", config, "--output-file", "", "."], { cwd: dir, encoding: "utf-8", maxBuffer: 1 << 26 });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || `terraform-docs exited ${r.status}`);
    return r.stdout;
  };
}

/** The module's files at `commit`, in a scratch directory the caller removes; undefined when the checkout lacks the commit. */
function moduleAt(repo: string, commit: string, rel: string): string | undefined {
  if (!hasCommit(repo, commit)) return undefined;
  const tar = moduleTarAt(repo, commit, rel);
  if (!tar) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "terragucci-catalog-"));
  for (const e of tarEntries(tar)) {
    mkdirSync(dirname(join(dir, e.path)), { recursive: true });
    writeFileSync(join(dir, e.path), e.data);
  }
  return dir;
}

/** The commits between two releases that touched the module, oldest first, each with its full message. */
function commitsBetween(repo: string, from: string | undefined, to: string, rel: string): { sha: string; message: string }[] | undefined {
  if (!hasCommit(repo, to) || (from && !hasCommit(repo, from))) return undefined;
  const out = tryGit(repo, ["log", "--reverse", "--format=%H%x1f%B%x1e", from ? `${from}..${to}` : to, "--", rel]);
  if (out === undefined) return undefined;
  return out
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, ...rest] = c.split("\x1f");
      return { sha: sha.trim(), message: rest.join("\x1f").trim() };
    });
}

const bare = (v: string): string => v.replace(/^v(?=\d)/, "");

/**
 * Build the catalog from the ledger and write the files that changed. A dry
 * run reads nothing and writes nothing.
 */
export async function publishCatalog(repo: string, reg: RegistrySettings, store: RegistryStore, o: CatalogOptions): Promise<CatalogResult> {
  const core = await chantReleaseCatalog();
  const tf = await chantRegistryCatalog();
  if (!core || !tf) return { status: "skipped", detail: "the installed chant has no release catalog (chant#4595); a chant release that carries it writes one under catalog/" };
  if (o.dryRun) return { status: "published", detail: `dry run: would write the release catalog under ${CATALOG_DIR}/ from the ledger` };

  const ledger = await readModuleLedger(repo, core.RELEASE_STATUS_FILE);
  const byRel = new Map(o.modules.map((m) => [m.rel, m]));
  const releases = ledger.records.filter((r) => byRel.has(r.component));
  if (releases.length === 0) return { status: "unchanged", detail: "the ledger holds no release of these modules yet" };
  const statuses: ChantReleaseStatusRecord[] = core.parseReleaseStatus(ledger.status).records.filter((s) => byRel.has(s.component));

  // What an earlier run wrote: a version there keeps its docs and changelog.
  const indexKey = catalogKey(reg, "index.json");
  const before = new Map<string, ChantCatalogVersion>();
  const held = (await store.read(indexKey)).body;
  if (held) {
    try {
      for (const c of core.parseReleaseCatalog(held).components) for (const v of c.versions) before.set(`${c.name}\0${v.version ?? v.digest}`, v);
    } catch {
      // A catalog this chant cannot read is written again from the ledger.
    }
  }

  const notes: string[] = [];
  const runner = o.terraformDocs ?? terraformDocsRunner();
  const fields: { component: string; version?: string; digest?: string; engine: string; fields: Record<string, unknown> }[] = [];
  const changelogs: { component: string; version?: string; digest?: string; entries: unknown[]; bump?: string }[] = [];
  const attestations: { component: string; digest: string; state: string; verify?: string }[] = [];

  // One entry per version: the first record of it, as the catalog keys it.
  const versions = new Map<string, VersionedReleaseRecord>();
  for (const r of [...releases].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))) {
    const key = `${r.component}\0${r.releaseVersion ?? r.digest}`;
    if (!versions.has(key)) versions.set(key, r);
  }
  for (const mod of o.modules) {
    const addr = registryAddress(reg, mod.rel);
    fields.push({ component: mod.rel, engine: "terraform", fields: { address: addr.source } });
    const own = [...versions.values()]
      .filter((r) => r.component === mod.rel)
      .sort((a, b) => {
        const va = a.releaseVersion ? parseSemver(a.releaseVersion) : undefined;
        const vb = b.releaseVersion ? parseSemver(b.releaseVersion) : undefined;
        return va && vb ? compareSemver(va, vb) : a.timestamp < b.timestamp ? -1 : 1;
      });
    own.forEach((r, i) => {
      const at = r.releaseVersion ? { version: r.releaseVersion } : { digest: r.digest };
      const kept = before.get(`${mod.rel}\0${r.releaseVersion ?? r.digest}`);
      if (kept?.fields.terraform) {
        fields.push({ component: mod.rel, ...at, engine: "terraform", fields: kept.fields.terraform });
        changelogs.push({ component: mod.rel, ...at, entries: kept.changelog.entries, ...(kept.changelog.bump ? { bump: kept.changelog.bump } : {}) });
        return;
      }
      const commits = commitsBetween(repo, own[i - 1]?.gitSha, r.gitSha, mod.rel);
      if (commits) {
        const log = core.releaseChangelog(commits);
        changelogs.push({ component: mod.rel, ...at, entries: log.entries, bump: log.bump });
      }
    });
    for (const r of own) {
      if (before.get(`${mod.rel}\0${r.releaseVersion ?? r.digest}`)?.fields.terraform) continue;
      const at = r.releaseVersion ? { version: r.releaseVersion } : { digest: r.digest };
      const dir = moduleAt(repo, r.gitSha, mod.rel);
      if (!dir) {
        notes.push(`${mod.rel} ${r.releaseVersion ?? r.digest}: this checkout lacks ${r.gitSha.slice(0, 8)}, so its page has no docs`);
        continue;
      }
      try {
        const docs = await tf.moduleDocs(dir, { ...(o.parser ? { parser: o.parser } : {}), terraformDocs: runner, ...(o.binary ? { binary: o.binary } : {}) });
        if (docs.note) notes.push(`${mod.rel} ${r.releaseVersion ?? ""}: ${docs.note}`.replace(/ :/, ":"));
        fields.push({ component: mod.rel, ...at, engine: "terraform", fields: tf.terraformCatalogFields(docs, addr.source) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  if (o.attestKey) {
    const prefix = ledger.prefix;
    for (const r of versions.values()) {
      const bundle = tryGit(repo, ["cat-file", "-e", `refs/heads/chant/lifecycle:${prefix}${attestDir(r.digest)}/${ATTEST_FILES.signature}`]);
      if (bundle === undefined) continue;
      const v = r.releaseVersion;
      const addr = registryAddress(reg, r.component);
      const tarball = v && (reg.download ?? "tarball") === "tarball" ? `${reg.url.replace(/\/+$/, "")}/${addr.path}/${v}/${tarballName(addr, v)}` : undefined;
      const verify = tarball
        ? `git show origin/chant/lifecycle:${prefix}${attestDir(r.digest)}/${ATTEST_FILES.signature} > signature.bundle && curl -sfL ${tarball} | gunzip > module.tar && cosign verify-blob --key ${o.attestKey} --bundle signature.bundle --insecure-ignore-tlog=true module.tar`
        : `terragucci verify-release ${r.component} ${v ?? r.digest}`;
      attestations.push({ component: r.component, digest: r.digest, state: "signed", verify });
    }
  }

  // Who calls each module, from this repo's roots: the source files, never a plan.
  let calls: ChantModuleConsumer[] = [];
  const moduleDirs = o.modules.map((m) => m.rel);
  const roots = findRoots(repo, o.roots).filter((root) => !moduleDirs.some((m) => root === m || root.startsWith(`${m}/`)));
  try {
    calls = await tf.moduleConsumers(repo, roots, o.parser);
  } catch (e) {
    notes.push(`consumers left out: ${(e as Error).message.split("\n", 1)[0]}`);
  }
  const consumers: { component: string; version: string; consumers: unknown[] }[] = [];
  const callsOf = new Map<string, ChantModuleConsumer[]>();
  for (const mod of o.modules) {
    const source = tf.normalizeModuleSource(registryAddress(reg, mod.rel).source);
    const mine = calls.filter((c) => c.module === source);
    callsOf.set(mod.rel, mine);
    for (const r of versions.values()) {
      if (r.component !== mod.rel || !r.releaseVersion) continue;
      const on = mine.filter((c) => c.pin !== null && bare(c.pin) === bare(r.releaseVersion!));
      if (on.length) consumers.push({ component: mod.rel, version: r.releaseVersion, consumers: on.map((c) => ({ root: c.root, file: c.file, address: c.address })) });
    }
  }

  // Across a control repo: each project's consumers.json, joined by chant (chant#4600), on the versions this repo publishes.
  if (o.control) {
    try {
      const joined = await controlConsumers(o.control, o.env ?? process.env);
      if (joined) {
        const byAddress = new Map(o.modules.map((m) => [tf.normalizeModuleSource(registryAddress(reg, m.rel).source), m.rel]));
        for (const j of joined.consumers) {
          const rel = byAddress.get(j.component);
          if (rel && j.version && versions.has(`${rel}\0${j.version}`)) consumers.push({ component: rel, version: j.version, consumers: j.consumers });
        }
        if (joined.problems.length) notes.push(`consumers: ${joined.problems.join("; ")}`);
      }
    } catch (e) {
      notes.push(`consumers across the control repo left out: ${(e as Error).message.split("\n", 1)[0]}`);
    }
  }

  // The newest time on the ledger, so the same ledger gives the same bytes.
  const generatedAt = [...releases.map((r) => r.timestamp), ...statuses.map((s) => s.timestamp)].sort().at(-1)!;
  const catalog: ChantReleaseCatalogDoc = core.buildReleaseCatalog(
    { releases, statuses: core.catalogStatusInputs(statuses), changelogs, consumers, attestations, fields },
    { generatedAt },
  );
  const files = core.renderCatalogSite(catalog, tf.terraformCatalogSections(), { title: `${new URL(reg.url).host} modules` }).map((f) => ({ path: f.path, contentType: f.contentType, text: new TextDecoder().decode(f.bytes) }));
  for (const mod of o.modules) {
    if (!catalog.components.some((c) => c.name === mod.rel)) continue;
    const list = (callsOf.get(mod.rel) ?? []).map((c) => ({ root: c.root, file: c.file, address: c.address, kind: c.kind, source: c.source, pin: c.pin }));
    files.push({ path: `${core.componentPath(mod.rel)}/${CONSUMERS_FILE}`, contentType: "application/json", text: `${JSON.stringify({ module: mod.rel, source: registryAddress(reg, mod.rel).source, consumers: list }, null, 2)}\n` });
  }

  const written: string[] = [];
  // The index last, so a reader never finds it naming a page not yet written.
  for (const f of [...files.filter((f) => f.path !== "index.json"), ...files.filter((f) => f.path === "index.json")]) {
    const key = catalogKey(reg, f.path);
    if ((await store.read(key)).body === f.text) continue;
    await store.put(key, f.text, f.contentType);
    written.push(key);
  }
  const said = notes.length ? `; ${notes.join("; ")}` : "";
  if (written.length === 0) return { status: "unchanged", detail: `the release catalog under ${CATALOG_DIR}/ matches the ledger${said}`, written };
  return { status: "published", detail: `wrote ${written.length} of ${files.length} files of the release catalog under ${CATALOG_DIR}/${said}`, written };
}

/** Where `terragucci modules` reads a catalog: another registry's URL, or this repo's `modules.registry`. */
export interface CatalogSource {
  registry?: string;
  settings?: RegistrySettings;
  repo?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Read a registry's catalog for `terragucci modules`. A registry in a repo
 * directory is read from the directory; any other through its URL with the
 * token Terraform would send (`TF_TOKEN_<host>` or a credentials block), so
 * a registry behind `auth: token` answers (terragucci#1289 ruling B).
 */
export async function readCatalog(src: CatalogSource): Promise<ChantReleaseCatalogDoc> {
  const core = await chantReleaseCatalog();
  const tf = await chantRegistryCatalog();
  if (!core || !tf) throw new ConfigError("the installed chant has no release catalog reader (chant#4595, chant#4599); terragucci modules needs a chant release that carries it");
  const reg = src.settings;
  if (!src.registry && reg?.dir !== undefined && src.repo) {
    const file = join(src.repo, reg.dir, catalogKey(reg, "index.json"));
    if (!existsSync(file)) throw new ConfigError(`${relative(src.repo, file)} is not written yet; terragucci publish writes it`);
    return core.parseReleaseCatalog(readFileSync(file, "utf-8"));
  }
  const url = src.registry ?? reg?.url;
  if (!url) throw new ConfigError("terragucci modules reads the catalog of modules.registry, which is not set; or name one with --registry <url>");
  // The bucket's prefix is served as the host's root, so the URL alone finds the catalog.
  const base = url;
  const catalog = await tf.readRegistryCatalog(base, src.fetch ? { fetch: src.fetch } : {});
  if (!catalog) throw new ConfigError(`${base.replace(/\/+$/, "")} has no catalog/index.json; terragucci publish writes it`);
  return catalog;
}

/** The component `name` names: its path, its last segment or its registry address. */
export function findComponent(catalog: ChantReleaseCatalogDoc, name: string): ChantReleaseCatalogDoc["components"][number] | undefined {
  const want = name.replace(/\/+$/, "");
  return (
    catalog.components.find((c) => c.name === want) ??
    catalog.components.find((c) => (c.fields.terraform as { address?: string } | undefined)?.address === want) ??
    catalog.components.find((c) => c.name.split("/").pop() === want)
  );
}

/** One line per module: its path, address, newest active version and how many versions are marked. */
export function describeCatalog(catalog: ChantReleaseCatalogDoc): string {
  if (catalog.components.length === 0) return "the catalog lists no modules";
  return catalog.components
    .map((c) => {
      const address = (c.fields.terraform as { address?: string } | undefined)?.address;
      const marked = (state: string) => c.versions.filter((v) => v.status.state === state).length;
      const counts = [`${c.versions.length} version${c.versions.length === 1 ? "" : "s"}`, ...(["deprecated", "yanked"] as const).filter((s) => marked(s) > 0).map((s) => `${marked(s)} ${s}`)];
      return `${c.name}${address ? `  ${address}` : ""}  latest ${c.latest ?? "none active"}  (${counts.join(", ")})`;
    })
    .join("\n");
}

/** A module's versions, newest first, with status, time, commit, consumers and attestation. */
export function describeComponent(c: ChantReleaseCatalogDoc["components"][number]): string {
  const address = (c.fields.terraform as { address?: string } | undefined)?.address;
  const lines = [`${c.name}${address ? ` (${address})` : ""}, latest ${c.latest ?? "none active"}`];
  for (const v of c.versions) {
    const why = v.status.state === "active" ? "" : `${v.status.reason ? `: ${v.status.reason}` : ""}${v.status.replacement ? `; move to ${v.status.replacement}` : ""}`;
    const used = v.consumers.length ? `, ${v.consumers.length} consumer${v.consumers.length === 1 ? "" : "s"}` : "";
    lines.push(`  ${v.version ?? v.digest}  ${v.status.state}${why}  ${v.time.slice(0, 10)}  ${v.commit.slice(0, 12)}  ${v.attestation.state}${used}`);
  }
  return lines.join("\n");
}
