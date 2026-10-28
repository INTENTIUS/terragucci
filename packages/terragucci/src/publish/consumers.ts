/**
 * Who calls a published module, across a control repo (terragucci#1289's
 * consumers piece, on chant#4600).
 *
 * Each project keeps a `consumers.json` at its top: its roots' pinned
 * registry module calls, in chant's document shape (`consumersDocument`,
 * `@intentius/chant/ci-control`), each version named by the module's
 * registry address, so a publisher in another repo can match it.
 * `terragucci modules consumers` writes it from the terraform lexicon's scan
 * (`moduleConsumers`, chant#4599), and `--check` holds the file to the scan.
 *
 * A publishing repo with `control` reads the control repo's projects (its
 * checkout at `TERRAGUCCI_CONTROL_DIR`, else a shallow clone with
 * `TERRAGUCCI_CONTROL_READ_TOKEN`, as estate ownership reads them), reads
 * each project's `consumers.json` the same way, and joins them with chant's
 * `readControlConsumers`, so each version's catalog page lists its consumers
 * in every project. Without the control repo's token, or on a chant without
 * the join, the catalog lists this repo's own consumers only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { chantCiControl, chantRegistryCatalog, type ChantModuleConsumer } from "../chant-next";
import { CONTROL_READ_TOKEN_ENV, ConfigError, parseProjectKey, type ControlSettings } from "../config";
import { readEntriesAt } from "../control-records";
import { findRoots } from "../detect";

/** The file each project keeps its consumers in, at its top. */
export const PROJECT_CONSUMERS = "consumers.json";
/** The variable naming a checkout of the control repo (estate ownership reads it too). */
const CONTROL_DIR_ENV = "TERRAGUCCI_CONTROL_DIR";

/** One version's consumers, as chant's join takes and gives them (`CatalogConsumersInput`). */
export interface VersionConsumers {
  component: string;
  version?: string;
  digest?: string;
  consumers: { repo?: string; root: string; file?: string; address?: string }[];
}

const bare = (v: string): string => v.replace(/^v(?=\d)/, "");

/** The registry module calls with a pin, grouped by module address and version. */
export function consumersOf(calls: readonly ChantModuleConsumer[]): VersionConsumers[] {
  const by = new Map<string, VersionConsumers>();
  for (const c of calls) {
    if (c.pin === null) continue;
    const key = `${c.module}\0${bare(c.pin)}`;
    const entry = by.get(key) ?? { component: c.module, version: bare(c.pin), consumers: [] };
    entry.consumers.push({ root: c.root, file: c.file, address: c.address });
    by.set(key, entry);
  }
  return [...by.values()];
}

/** This repo's `consumers.json` text, from its roots (module directories left out), or undefined on a chant without the scan or the document. */
export async function projectConsumersDocument(repo: string, o: { roots?: string[]; skip?: string[]; parser?: Hcl2Json }): Promise<{ text: string; consumers: VersionConsumers[] } | undefined> {
  const tf = await chantRegistryCatalog();
  const control = await chantCiControl();
  const write = control as unknown as { consumersDocument?: (c: readonly VersionConsumers[]) => string } | undefined;
  if (!tf || typeof write?.consumersDocument !== "function") return undefined;
  const skip = o.skip ?? [];
  const roots = findRoots(repo, o.roots).filter((r) => !skip.some((m) => r === m || r.startsWith(`${m}/`)));
  const consumers = consumersOf(await tf.moduleConsumers(repo, roots, o.parser));
  return { text: write.consumersDocument(consumers), consumers };
}

/** Clones a repo, shallow; tests pass a fake. */
export type ShallowClone = (url: string, into: string) => void;
const gitClone: ShallowClone = (url, into) => void execFileSync("git", ["clone", "--quiet", "--depth", "1", url, into], { stdio: ["ignore", "ignore", "pipe"] });

/** Fetches the control repo's chant/lifecycle into a clone, where its entries may be. */
const fetchLifecycle = (dir: string): void => {
  try {
    execFileSync("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    // A control repo whose records are still files has no chant/lifecycle.
  }
};

/**
 * Every project's consumers the control repo lists, joined (chant#4600), or
 * undefined when there is no control repo to read, no token to read it with,
 * or no join in the installed chant. Problems name the project and never
 * the token.
 */
export async function controlConsumers(
  control: ControlSettings | undefined,
  env: NodeJS.ProcessEnv,
  clone: ShallowClone = gitClone,
): Promise<{ consumers: VersionConsumers[]; problems: string[]; missing: string[] } | undefined> {
  if (!control) return undefined;
  const chant = (await chantCiControl()) as unknown as
    | { readControlConsumers?: (entries: readonly unknown[], read: (project: string) => Promise<string | null>) => Promise<{ consumers: VersionConsumers[]; problems: string[]; missing: string[] }> }
    | undefined;
  if (typeof chant?.readControlConsumers !== "function") return undefined;
  const token = env[CONTROL_READ_TOKEN_ENV];
  const given = env[CONTROL_DIR_ENV];
  if (!given && !token) return undefined;
  const masked = (s: string) => (token ? s.replaceAll(token, "***") : s);
  const urlOf = (key: string) => {
    const pk = parseProjectKey(key);
    return `https://oauth2:${encodeURIComponent(token ?? "")}@${pk.host}/${pk.path}.git`;
  };
  const scratch: string[] = [];
  try {
    let dir = given;
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), "terragucci-control-"));
      scratch.push(dir);
      try {
        clone(urlOf(control.repo), dir);
      } catch (e) {
        throw new ConfigError(`could not read the control repo ${control.repo} for the catalog's consumers: ${masked(String((e as Error).message)).split("\n")[0]}`);
      }
      fetchLifecycle(dir);
    }
    const entries = await readEntriesAt(dir);
    return await chant.readControlConsumers(entries, async (project) => {
      if (!token) throw new Error(`${CONTROL_READ_TOKEN_ENV} is not set, so the project cannot be read`);
      const into = mkdtempSync(join(tmpdir(), "terragucci-consumers-"));
      scratch.push(into);
      try {
        clone(urlOf(project), into);
      } catch (e) {
        throw new Error(masked(String((e as Error).message)).split("\n")[0]);
      }
      const file = join(into, PROJECT_CONSUMERS);
      return existsSync(file) ? readFileSync(file, "utf-8") : null;
    });
  } finally {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  }
}
