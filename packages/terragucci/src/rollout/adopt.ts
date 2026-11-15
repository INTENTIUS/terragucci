/**
 * The rollout behind `terragucci modules adopt`: every call of a local module
 * moves, root by root and wave by wave, to the pinned source the module is
 * published at.
 *
 * A call is at `from` while its `source` is the module's directory as a
 * relative path, and at `to` once it names the published source at the
 * version. The rollout's `from` for such a run is the placeholder
 * `LOCAL_FROM`. The edit is `adoptLocal` (./range.ts), which writes the
 * source literal, re-reads the file and refuses unless only that changed.
 * Once a root is at `to`, an ordinary `terragucci rollout <dir> <version>`
 * moves it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { pinFiles, pinVersion } from "./pins";
import { adoptLocal, isLocalSource, localTarget, type AdoptRequest } from "./range";

/** The `from` of a rollout that adopts a local module. No version reads like it. */
export const LOCAL_FROM = "(local)";

export type AdoptKind = "git" | "oci" | "registry";

/** Where a local module is published, and how a call names that. */
export interface AdoptTarget {
  /** The module's directory, relative to the repository root. */
  dir: string;
  kind: AdoptKind;
  /** The published source without its pin: `git::<url>//<dir>`, `oci://<host>/<repo>`, or a registry's `<host>/<namespace>/<name>/<system>`. */
  module: string;
}

/** The `source` (and, for a registry, the `version`) a call gets at a version. */
export function adoptRequest(target: AdoptTarget, version: string): AdoptRequest {
  if (target.kind === "git") return { dir: target.dir, source: `${target.module}?ref=${target.dir}/v${version}` };
  if (target.kind === "oci") return { dir: target.dir, source: `${target.module}?tag=${version}` };
  return { dir: target.dir, source: target.module, version };
}

/** The source as a call reads it at a version, for a table and a pull request. */
export function pinnedSource(target: AdoptTarget, version: string): string {
  const r = adoptRequest(target, version);
  return r.version ? `${r.source} (version = "${r.version}")` : r.source;
}

export interface AdoptFound {
  file: string;
  call: string;
  /** The call's source is still the local path. */
  local: boolean;
  /** At the published source: the version its pin carries. */
  version?: string;
  /** The call's pin cannot be read, and why. */
  unreadable?: string;
}

/** Every call in one root's `.tf` files that is the local module or the published source. */
export async function adoptCalls(repo: string, root: string, target: AdoptTarget, parser: Hcl2Json): Promise<AdoptFound[]> {
  const out: AdoptFound[] = [];
  for (const file of pinFiles(repo, root).filter((f) => f.endsWith(".tf"))) {
    const tree = (await parser.parse(file, readFileSync(join(repo, file), "utf-8"))) as Record<string, unknown>;
    for (const [name, bodies] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
      for (const body of bodies) {
        if (typeof body.source !== "string") continue;
        const call = `module.${name}`;
        if (isLocalSource(body.source)) {
          if (localTarget(file, body.source) === target.dir) out.push({ file, call, local: true });
          continue;
        }
        const pin = readModulePin(body.source, typeof body.version === "string" ? body.version : undefined);
        if (pin.module.toLowerCase() !== target.module.toLowerCase()) continue;
        out.push(pin.pin === null ? { file, call, local: false, unreadable: pin.unpinned ?? "no pin to read" } : { file, call, local: false, version: pinVersion(pin.pin) });
      }
    }
  }
  return out;
}

/** The edit of one root: each file with a local call of the module, with the call moved. Or why a call cannot move. */
export async function moveAdopted(repo: string, root: string, target: AdoptTarget, to: string, parser: Hcl2Json): Promise<{ edits: Map<string, string> } | { refused: string }> {
  const edits = new Map<string, string>();
  const request = adoptRequest(target, to);
  for (const file of new Set((await adoptCalls(repo, root, target, parser)).filter((c) => c.local).map((c) => c.file))) {
    const result = await adoptLocal(readFileSync(join(repo, file), "utf-8"), file, request, parser);
    const refused = result.calls.find((c) => c.outcome === "refused");
    if (refused) return { refused: `${file} ${refused.call}: ${refused.reason}` };
    edits.set(file, result.content);
  }
  return { edits };
}
