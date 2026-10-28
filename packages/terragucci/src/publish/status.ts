/**
 * Deprecate, yank or restore one published module version
 * (terragucci#1298, bundle B of terragucci#1289).
 *
 * The change is a status record on the release ledger beside the version's
 * release record (chant#4596's `release-status.jsonl`), with who set it, when
 * and why, and the version to move to. Anyone who can publish may set one
 * (ruling C): there is no approval, and `restore` undoes either mark with
 * one more record. The version stays in the registry's `versions`, so a root
 * that pins it still runs `init`.
 *
 * After the record is pushed the release catalog under `catalog/` is written
 * again (./catalog.ts), so roots in other repos, which read the catalog, see
 * the mark: a deprecated pin gets a tip and a yanked one is refused by
 * `modules.require` (./require.ts).
 */
import { spawnSync } from "node:child_process";
import type { ResolvedSettings } from "../config";
import { ConfigError } from "../config";
import { chantReleaseCatalog, type ChantReleaseState, type ChantReleaseStatusRecord } from "../chant-next";
import { publishCatalog } from "./catalog";
import { findModules } from "./index";
import { actorOf, LEDGER_ENV, LIFECYCLE, readModuleLedger } from "./ledger";
import { registryStore, type RegistryStore } from "./registry";
import { parseSemver, formatSemver } from "./semver";

/** The words `terragucci modules` takes, and the status each sets. */
export const STATUS_WORDS = { deprecate: "deprecated", yank: "yanked", restore: "active" } as const satisfies Record<string, ChantReleaseState>;
export type StatusWord = keyof typeof STATUS_WORDS;

export interface StatusChange {
  word: StatusWord;
  /** The module's path, or the last segment of it. */
  module: string;
  version: string;
  /** Why; required to deprecate or yank. */
  reason?: string;
  /** The version to move to instead. */
  use?: string;
}

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  /** Where `modules.registry` is written, for tests. */
  registryStore?: RegistryStore;
  /** The time the record carries, for tests. */
  now?: () => Date;
}

export interface StatusResult {
  record: ChantReleaseStatusRecord;
  pushed: boolean;
  /** What happened to the catalog, or why it was left alone. */
  catalog?: string;
}

/** Set one version's status, push it, and write the catalog again. */
export async function setReleaseStatus(repo: string, settings: Pick<ResolvedSettings, "modules"> & { binary?: string; roots?: string[]; control?: ResolvedSettings["control"] }, change: StatusChange, opts: StatusOptions = {}): Promise<StatusResult> {
  const core = await chantReleaseCatalog();
  if (!core) throw new ConfigError(`terragucci modules ${change.word} writes a release status record (chant#4596), which the installed chant has no writer for; it needs a chant release that carries it`);
  const status = STATUS_WORDS[change.word];
  if (status !== "active" && !change.reason?.trim()) throw new ConfigError(`terragucci modules ${change.word} needs --reason <text>: the record says why, for everyone whose root pins the version`);
  const want = parseSemver(change.version);
  if (!want) throw new ConfigError(`${change.version} is not a version such as 1.4.0`);
  const version = formatSemver(want);
  const modules = findModules(repo, settings.modules?.path ?? "modules/*");
  const mod = modules.find((m) => m.rel === change.module.replace(/\/+$/, "")) ?? modules.find((m) => m.name === change.module);
  if (!mod) throw new ConfigError(`no module ${change.module} under ${settings.modules?.path ?? "modules/*"}`);

  const ledger = await readModuleLedger(repo);
  const releases = ledger.records.filter((r) => r.component === mod.rel && r.releaseVersion);
  const release = releases.find((r) => r.releaseVersion === version);
  if (!release) {
    const known = [...new Set(releases.map((r) => r.releaseVersion!))].sort();
    throw new ConfigError(`${mod.rel} ${version} has no release record on ${LIFECYCLE}${known.length ? `; its recorded versions are ${known.join(", ")}` : ", and no version of it is recorded yet: publish records each version"}`);
  }
  let replacement: string | undefined;
  if (change.use !== undefined) {
    const use = parseSemver(change.use);
    replacement = use ? formatSemver(use) : undefined;
    if (!replacement || !releases.some((r) => r.releaseVersion === replacement)) throw new ConfigError(`--use ${change.use} is not a recorded version of ${mod.rel}`);
    if (replacement === version) throw new ConfigError(`--use names ${version} itself; name the version to move to`);
  }

  const env = opts.env ?? process.env;
  const input: Omit<ChantReleaseStatusRecord, "version"> = {
    component: mod.rel,
    env: LEDGER_ENV,
    digest: release.digest,
    releaseVersion: version,
    status,
    ...(change.reason?.trim() ? { reason: change.reason.trim() } : {}),
    ...(replacement ? { replacement } : {}),
    actor: actorOf(env),
    timestamp: (opts.now?.() ?? new Date()).toISOString(),
  };
  const pushed = await pushStatus(repo, () => core.appendReleaseStatus(input, { cwd: repo }));

  let catalog: string | undefined;
  const reg = settings.modules?.registry;
  if (reg && reg.catalog !== "off") {
    const store = opts.registryStore ?? registryStore(repo, reg, env);
    const written = await publishCatalog(repo, reg, store, { modules, ...(settings.roots ? { roots: settings.roots } : {}), ...(settings.binary ? { binary: settings.binary } : {}), ...(settings.control ? { control: settings.control } : {}), env });
    catalog = written.detail;
  }
  return { record: pushed.record, pushed: pushed.pushed, ...(catalog ? { catalog } : {}) };
}

/** The local ledger branch's tip, or undefined. */
function branchTip(repo: string): string | undefined {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${LIFECYCLE}`], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Fetch, append with chant's writer, then push; a push another writer beat is retried on the new tip. */
async function pushStatus(repo: string, append: () => Promise<{ record: ChantReleaseStatusRecord }>): Promise<{ record: ChantReleaseStatusRecord; pushed: boolean }> {
  const chantGit = await import("@intentius/chant/lifecycle/git");
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await chantGit.fetchLifecycleStatus({ cwd: repo });
    const before = branchTip(repo);
    const { record } = await append();
    const push = await chantGit.pushLifecycleStatus({ cwd: repo });
    if (push.status === "pushed") return { record, pushed: true };
    if (push.status === "no-remote" || push.status === "not-recorded") return { record, pushed: false };
    last = push.stderr;
    // The branch goes back to the tip it had, so the next attempt writes on the remote's new one.
    if (before) spawnSync("git", ["-C", repo, "update-ref", `refs/heads/${LIFECYCLE}`, before]);
    else spawnSync("git", ["-C", repo, "update-ref", "-d", `refs/heads/${LIFECYCLE}`]);
    if (push.status !== "stale") break;
  }
  throw new ConfigError(`could not push the release status record to ${LIFECYCLE}; check that you may push to it${last ? `: ${last.split("\n")[0]}` : ""}`);
}

/** One line for a person: the version, its new status, and the catalog. */
export function describeStatus(r: StatusResult): string {
  const rec = r.record;
  const what = rec.status === "active" ? "restored" : rec.status;
  const lines = [`${rec.component} ${rec.releaseVersion}: ${what}${rec.reason ? ` (${rec.reason})` : ""}${rec.replacement ? `; move to ${rec.replacement}` : ""}, recorded on ${LIFECYCLE}${r.pushed ? "" : " in this checkout only"}`];
  if (r.catalog) lines.push(`catalog: ${r.catalog}`);
  return lines.join("\n");
}
