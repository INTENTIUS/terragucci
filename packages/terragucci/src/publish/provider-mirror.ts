/**
 * `modules.registry.providers: mirror`: the publish job also serves every
 * provider the repo's lock files pin as a provider network mirror, under
 * `<prefix>/providers/` in the registry's bucket or dir, so readers install
 * providers from the registry's host (chant#4564).
 *
 * The build and upload are chant's terraform lexicon's (`/registry`:
 * `buildMirror`, `uploadMirror`, `mirrorUrl`, `mirrorCliConfig`). terragucci
 * holds the wording and one record beside the mirror, the digest of what it
 * covers, so a publish whose lock files did not change mirrors nothing again.
 * On a chant without them the step says so and publishes nothing for it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chantRegistry } from "../chant-next";
import type { RegistrySettings } from "../config";
import { lockEntries, lockFiles } from "../image-recipe";
import { sha256 } from "./archive";
import { keyFor, type RegistryStore } from "./registry";

/** The record of what the mirror covers, beside it. */
export const MIRROR_RECORD = "providers/terragucci-mirror.json";
/** Platforms the mirror holds. */
export const MIRROR_PLATFORMS = ["linux_amd64"];

/** Runs the binary for `providers mirror`; a test passes its own. */
export type ProviderMirrorRun = (bin: string, args: string[], cwd: string) => { status: number | null; output: string };

export interface ProviderMirrorRow {
  status: "published" | "unchanged" | "skipped";
  detail: string;
}

/** The part of chant's `/registry` the step calls (chant#4564). */
interface ChantMirror {
  buildMirror(repo: string, out: string, options?: { binary?: string; platforms?: string[]; run?: ProviderMirrorRun }): { providers: string[]; locks: string[]; platforms: string[] };
  uploadMirror(store: Pick<RegistryStore, "put" | "read">, dir: string, options?: { prefix?: string }): Promise<{ put: string[]; kept: string[] }>;
  mirrorUrl(registryUrl: string, prefix?: string): string;
  mirrorCliConfig(url: string, addresses: string[]): string;
}

export async function publishProviderMirror(
  repo: string,
  reg: RegistrySettings,
  store: RegistryStore,
  opts: { binary?: string; dryRun?: boolean; run?: ProviderMirrorRun } = {},
): Promise<ProviderMirrorRow> {
  const entries = lockEntries(repo, lockFiles(repo));
  if (entries.length === 0) return { status: "skipped", detail: "no lock file in the repo pins a provider, so there is nothing to mirror" };
  const digest = sha256(JSON.stringify({ platforms: MIRROR_PLATFORMS, providers: [...new Set(entries.map((e) => `${e.address} ${e.version}`))].sort() }));
  const recordKey = keyFor(reg, MIRROR_RECORD);
  const held = (await store.read(recordKey)).body;
  let heldDigest: string | undefined;
  try {
    heldDigest = held ? (JSON.parse(held) as { digest?: string }).digest : undefined;
  } catch {
    heldDigest = undefined;
  }
  if (heldDigest === digest) return { status: "unchanged", detail: "the mirror already holds every provider the lock files pin" };
  if (opts.dryRun) return { status: "published", detail: `dry run: would mirror the providers of ${entries.length} lock file entries for ${MIRROR_PLATFORMS.join(", ")}` };
  const lexicon = (await chantRegistry()) as (Partial<ChantMirror> & object) | undefined;
  if (!lexicon || !(["buildMirror", "uploadMirror", "mirrorUrl", "mirrorCliConfig"] as const).every((n) => typeof lexicon[n] === "function")) {
    return { status: "skipped", detail: "the installed chant has no provider mirror builder, so no mirror was written" };
  }
  const chant = lexicon as ChantMirror;
  const out = mkdtempSync(join(tmpdir(), "terragucci-provider-mirror-"));
  try {
    const binary = opts.binary === "terraform" ? "terraform" : "tofu";
    const built = chant.buildMirror(repo, out, { binary, platforms: MIRROR_PLATFORMS, ...(opts.run ? { run: opts.run } : {}) });
    const prefix = (reg.prefix ?? "").replace(/^\/+|\/+$/g, "") || undefined;
    await chant.uploadMirror(store, out, prefix ? { prefix } : {});
    await store.put(recordKey, `${JSON.stringify({ digest, providers: built.providers, platforms: built.platforms }, null, 2)}\n`, "application/json");
    const url = chant.mirrorUrl(reg.url, prefix);
    return {
      status: "published",
      detail: `${built.providers.length} provider versions from ${built.locks.length} lock files at ${url}; each reader's CLI config takes:\n${chant.mirrorCliConfig(url, built.providers)}`,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
